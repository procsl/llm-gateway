const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { v4: uuidv4 } = require('uuid');
const db = require('../utils/db');
const errorTracker = require('../utils/weight');
const { FILES } = require('../config');

// 辅助：流转字符串 (用于读取错误流)
async function streamToString(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
}

async function handleForwarding(req, res, type) {
    const startTime = Date.now();
    const traceId = uuidv4();
    const requestModel = req.body.model;
    
    // 初始化 Trace 对象
    const trace = {
        id: traceId,
        timestamp: new Date().toISOString(),
        keyName: req.accessKeyName || 'Anonymous',
        clientRequest: {
            method: req.method,
            path: req.path,
            headers: req.headers, 
            body: req.body
        },
        route: { targetModel: requestModel, group: null, candidates: [] },
        attempts: [],
        finalResponse: null, // 将存储实际响应数据
        status: 0,
        totalDuration: 0
    };

    const groups = db.read(FILES.GROUPS);
    const group = Object.values(groups).find(g => g.name === requestModel);

    // 路由错误处理
    if (!group) {
        trace.status = 404;
        trace.finalResponse = { error: `Model group '${requestModel}' not found` };
        db.logRequest(trace.keyName, 'System', req, trace.finalResponse, 404, null, req.headers, null, trace);
        return res.status(404).json(trace.finalResponse);
    }
    
    trace.route.group = group.name;
    if (group.type !== type) {
        trace.status = 400;
        trace.finalResponse = { error: `Protocol mismatch.` };
        db.logRequest(trace.keyName, 'System', req, trace.finalResponse, 400, null, req.headers, null, trace);
        return res.status(400).json(trace.finalResponse);
    }

    const providersData = db.read(FILES.PROVIDERS);
    let candidates = group.providers
        .map(pName => providersData[pName])
        .filter(p => p !== undefined);

    // 权重排序
    candidates = candidates.map(p => {
        const index = group.providers.indexOf(p.name);
        const baseWeight = 1000 - index * 100;
        const currentWeight = errorTracker.getWeight(p.name, baseWeight);
        return { ...p, _calcWeight: currentWeight, _baseWeight: baseWeight };
    });
    candidates.sort((a, b) => b._calcWeight - a._calcWeight);
    
    trace.route.candidates = candidates.map(c => ({
        name: c.name,
        weight: c._calcWeight.toFixed(1)
    }));

    // Header 清洗 (用于发给 Provider)
    const unsafeHeaders = ['host', 'content-length', 'connection', 'transfer-encoding', 'authorization', 'x-api-key', 'anthropic-version'];
    const clientHeaders = {};
    Object.keys(req.headers).forEach(key => {
        if (!unsafeHeaders.includes(key.toLowerCase())) clientHeaders[key] = req.headers[key];
    });

    let lastError = null;

    // 链路循环
    for (const provider of candidates) {
        const attemptStart = Date.now();
        
        // 构造请求头
        const requestHeaders = { ...clientHeaders, 'Content-Type': 'application/json' };
        if (type === 'anthropic') {
            requestHeaders['x-api-key'] = provider.key;
            requestHeaders['Authorization'] = `Bearer ${provider.key}`;
            requestHeaders['anthropic-version'] = '2023-06-01';
        } else {
            requestHeaders['Authorization'] = `Bearer ${provider.key}`;
        }

        const attemptLog = {
            provider: provider.name,
            weight: provider._calcWeight,
            requestHeaders: requestHeaders,
            responseHeaders: null,
            status: 0,
            error: null,
            duration: 0,
            isStreaming: !!req.body.stream,
            responseBody: null
        };

        try {
            console.log(`[Trace:${traceId.slice(0,8)}] ${requestModel} -> ${provider.name}`);

            const config = {
                method: 'POST',
                url: provider.endpoint,
                headers: requestHeaders,
                data: { ...req.body, model: provider.realModel || requestModel },
                responseType: req.body.stream ? 'stream' : 'json',
                timeout: 60000 
            };
            if (provider.proxy) config.httpsAgent = new HttpsProxyAgent(provider.proxy);

            const response = await axios(config);
            
            // --- 成功逻辑 ---
            attemptLog.status = response.status;
            attemptLog.responseHeaders = response.headers;

            // 转发响应头
            const unsafeResHeaders = [
		    'content-length',
		    'transfer-encoding',
		    'connection',
		    // [新增] 过滤掉上游的 CORS 头，使用我们网关自己的 cors() 中间件配置
		    'access-control-allow-origin',
		    'access-control-allow-methods',
		    'access-control-allow-headers'
	    ];

		Object.keys(response.headers).forEach(key => {
			if(!unsafeResHeaders.includes(key.toLowerCase())) {
				res.setHeader(key, response.headers[key]);
			}
		});

            if (req.body.stream) {
                // === 流式响应处理 ===
                let fullStreamData = "";
                
                response.data.on('data', (chunk) => {
                    const chunkStr = chunk.toString();
                    fullStreamData += chunkStr;
                    res.write(chunk); // 实时转发
                });
                
                response.data.on('end', () => {
                    res.end();
                    
                    // 记录尝试日志
                    attemptLog.duration = Date.now() - attemptStart;
                    attemptLog.responseBody = fullStreamData; // 存储完整原始流数据
                    
                    // 更新 Trace
                    trace.attempts.push(attemptLog);
                    trace.status = response.status;
                    
                    // === 关键修改：存储实际数据，而不是占位符 ===
                    trace.finalResponse = fullStreamData; 
                    
                    trace.totalDuration = Date.now() - startTime;
                    
                    // 写入数据库
                    db.logRequest(trace.keyName, provider.name, req, fullStreamData, trace.status, null, requestHeaders, response.headers, trace);
                });
                
                response.data.on('error', (err) => {
                    res.end(); 
                    attemptLog.duration = Date.now() - attemptStart;
                    attemptLog.error = `Stream Error: ${err.message}`;
                    attemptLog.status = 500;
                    
                    // 即使出错，也保存已收集的部分数据
                    trace.finalResponse = fullStreamData;
                    
                    trace.attempts.push(attemptLog);
                    db.logRequest(trace.keyName, provider.name, req, fullStreamData, 500, err, requestHeaders, response.headers, trace);
                });
                return; // 退出循环

            } else {
                // === 普通 JSON 响应处理 ===
                res.status(response.status).json(response.data);
                
                attemptLog.duration = Date.now() - attemptStart;
                attemptLog.responseBody = response.data;
                
                trace.attempts.push(attemptLog);
                trace.status = response.status;
                trace.finalResponse = response.data; // 存储实际 JSON 对象
                trace.totalDuration = Date.now() - startTime;
                
                db.logRequest(trace.keyName, provider.name, req, response.data, trace.status, null, requestHeaders, response.headers, trace);
                return; // 退出循环
            }

        } catch (error) {
            // --- 失败逻辑 ---
            attemptLog.duration = Date.now() - attemptStart;
            attemptLog.status = error.response ? error.response.status : (error.code || 0);
            attemptLog.responseHeaders = error.response ? error.response.headers : { error: "No Response Headers" }; 

            let errBody = error.message;
            if (error.response && error.response.data) {
                if (typeof error.response.data.pipe === 'function') {
                    try { errBody = await streamToString(error.response.data); try{errBody=JSON.parse(errBody)}catch(e){} } 
                    catch (readErr) { errBody = `[Stream Read Error] ${readErr.message}`; }
                } else {
                    errBody = error.response.data;
                }
            }
            attemptLog.error = errBody;

            console.error(`[Fail] ${provider.name}: ${error.message}`);
            db.incFailure(provider.name);
            
            if (attemptLog.status === 429 || (attemptLog.status >= 500 && attemptLog.status < 600)) {
                errorTracker.recordError(provider.name, attemptLog.status);
            }

            trace.attempts.push(attemptLog);
            lastError = error;
        }
    }

    // 全部失败
    trace.status = 502;
    trace.finalResponse = { error: 'All providers failed', last_error: lastError ? lastError.message : 'No providers' };
    trace.totalDuration = Date.now() - startTime;
    db.logRequest(trace.keyName, 'All Failed', req, trace.finalResponse, 502, lastError, req.headers, null, trace);

    res.status(502).json(trace.finalResponse);
}

module.exports = handleForwarding;
