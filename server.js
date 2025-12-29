/**
 * 智能大模型转发网关 - Server.js
 */
const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const {HttpsProxyAgent} = require('https-proxy-agent');
const auth = require('basic-auth');
const {v4: uuidv4} = require('uuid');
const cors = require('cors');

const app = express();
const PORT = 3000;

// === 配置与常量 ===
const DATA_DIR = path.join(__dirname, 'data');
const FILES = {
    PROVIDERS: path.join(DATA_DIR, 'providers.json'),
    GROUPS: path.join(DATA_DIR, 'groups.json'),
    KEYS: path.join(DATA_DIR, 'keys.json'),
    STATS: path.join(DATA_DIR, 'stats.json'), // 失败计数与Token统计
    LOGS_DIR: path.join(DATA_DIR, 'logs')
};

// 后台管理账号密码 (建议修改)
const ADMIN_USER = 'admin';
const ADMIN_PASS = '123456';

// === 初始化 ===
fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(FILES.LOGS_DIR);
[FILES.PROVIDERS, FILES.GROUPS, FILES.KEYS, FILES.STATS].forEach(f => {
    if (!fs.existsSync(f)) fs.writeJsonSync(f, {});
});

app.use(cors());
app.use(express.json({limit: '10mb'}));
app.use(express.static('public'));

// === 动态权重管理器 ===
// 用于跟踪最近的错误并计算动态权重
const errorTracker = {
    // 存储格式: { providerName: [{ timestamp, status }, ...] }
    errors: {},

    // 错误时间窗口（毫秒）：1分钟
    WINDOW_MS: 60 * 1000,

    // 429和5xx错误的权重惩罚系数
    PENALTY_429: 5,   // 429错误惩罚倍数
    PENALTY_5XX: 3,   // 5xx错误惩罚倍数

    // 记录错误
    recordError(providerName, status) {
        const now = Date.now();
        if (!this.errors[providerName]) {
            this.errors[providerName] = [];
        }

        // 只记录429和5xx错误
        if (status === 429 || (status >= 500 && status < 600)) {
            this.errors[providerName].push({timestamp: now, status});
            this.cleanup(providerName); // 清理过期错误
        }
    },

    // 清理过期的错误记录
    cleanup(providerName) {
        const now = Date.now();
        if (this.errors[providerName]) {
            this.errors[providerName] = this.errors[providerName].filter(
                err => now - err.timestamp < this.WINDOW_MS
            );
        }
    },

    // 获取提供者的动态权重（基础权重除以惩罚系数）
    // 返回值：权重值，越小优先级越低
    getWeight(providerName, baseWeight = 100) {
        this.cleanup(providerName);

        const recentErrors = this.errors[providerName] || [];
        if (recentErrors.length === 0) return baseWeight;

        let penalty = 1;

        for (const err of recentErrors) {
            if (err.status === 429) {
                penalty *= this.PENALTY_429;
            } else if (err.status >= 500 && err.status < 600) {
                penalty *= this.PENALTY_5XX;
            }
        }

        // 权重 = 基础权重 / 惩罚系数
        // 错误越多，权重越低
        return baseWeight / penalty;
    },

    // 获取错误统计信息（用于监控）
    getStats(providerName) {
        this.cleanup(providerName);
        const errors = this.errors[providerName] || [];
        return {
            recentErrors: errors.length,
            windowMs: this.WINDOW_MS,
            lastError: errors.length > 0 ? errors[errors.length - 1] : null
        };
    }
};

// === 数据层辅助函数 ===
const db = {
    read: (file) => fs.readJsonSync(file, {throws: false}) || {},
    write: (file, data) => fs.writeJsonSync(file, data, {spaces: 2}),
    getFailureCount: (providerName) => {
        const stats = db.read(FILES.STATS);
        return stats[providerName]?.failures || 0;
    },
    incFailure: (providerName) => {
        const stats = db.read(FILES.STATS);
        if (!stats[providerName]) stats[providerName] = {failures: 0, tokens: 0};
        stats[providerName].failures += 1;
        db.write(FILES.STATS, stats);
    },


    // 记录详细审计日志 (已修复循环引用问题)
    // 记录详细审计日志 (已修复 Socket 循环引用问题)
    logRequest: async (accessKeyName, providerName, req, resData, status, error = null, actualHeaders = null, responseHeaders = null) => {
        const dateStr = new Date().toISOString().split('T')[0];
        const logFile = path.join(FILES.LOGS_DIR, `${dateStr}.log`);

        // 辅助函数：安全处理数据，防止 Stream/Socket 对象导致序列化崩溃
        const sanitizeData = (data) => {
            if (!data) return data;
            // 检查是否为流对象 (Stream/IncomingMessage)
            if (typeof data === 'object' && (typeof data.pipe === 'function' || data.socket)) {
                return '[Stream/Socket Data]';
            }
            return data;
        };

        const logEntry = {
            id: uuidv4(),
            timestamp: new Date().toISOString(),
            keyName: accessKeyName,
            provider: providerName,
            status: status,
            request: {
                method: req.method,
                path: req.path,
                // 优先使用实际发送的请求头
                headers: actualHeaders ? {...actualHeaders} : {...req.headers},
                // 确保 body 也经过清洗（虽然 express.json 已解析，但为了保险）
                body: sanitizeData(req.body)
            },
            response: {
                // 关键修复：清洗响应数据，防止 Stream 对象进入 JSON.stringify
                data: sanitizeData(resData),
                error: error ? error.message : null,
                headers: responseHeaders || {}
            }
        };

        try {
            const logLine = JSON.stringify(logEntry) + '\n';
            await fs.appendFile(logFile, logLine);
        } catch (err) {
            // 降级处理：如果仍然失败，记录简略信息，防止整个服务崩溃
            console.error("日志序列化严重错误:", err.message);
            const fallbackLog = JSON.stringify({
                id: logEntry.id,
                timestamp: logEntry.timestamp,
                error: "Log serialization failed due to circular reference"
            }) + '\n';
            await fs.appendFile(logFile, fallbackLog).catch(() => {
            });
        }
    }

};

// === 中间件 ===

// 1. Basic Auth (用于后台管理)
const adminAuth = (req, res, next) => {
    const user = auth(req);
    if (!user || user.name !== ADMIN_USER || user.pass !== ADMIN_PASS) {
        res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
        return res.status(401).send('Access denied');
    }
    next();
};

// 2. Bearer Token Auth (用于接口调用)
const apiKeyAuth = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({error: 'Missing Bearer Token'});
    }
    const token = authHeader.split(' ')[1];
    const keys = db.read(FILES.KEYS);
    // 简单遍历查找
    const validKey = Object.values(keys).find(k => k.key === token);

    if (!validKey) {
        return res.status(401).json({error: 'Invalid Access Key'});
    }
    req.accessKeyName = validKey.name; // 记录Key名称用于审计
    req.accessKeyToken = token;
    next();
};


// ... (之前的引入保持不变) ...

// === 辅助：日志读取 ===
// 读取当天日志的最后 N 行
const getRecentLogs = async (limit = 100) => {
    const dateStr = new Date().toISOString().split('T')[0];
    const logFile = path.join(FILES.LOGS_DIR, `${dateStr}.log`);
    if (!fs.existsSync(logFile)) return [];

    try {
        const content = await fs.readFile(logFile, 'utf-8');
        // 分割行，过滤空行，解析JSON，倒序
        const lines = content.trim().split('\n');
        const logs = [];
        for (let i = lines.length - 1; i >= 0 && logs.length < limit; i--) {
            try {
                if (lines[i]) logs.push(JSON.parse(lines[i]));
            } catch (e) {
            }
        }
        return logs;
    } catch (e) {
        return [];
    }
};


// ... (中间代码不变) ...

// === 核心逻辑：转发处理器 (重构版) ===
async function handleForwarding(req, res, type) {
    const requestModel = req.body.model;
    const groups = db.read(FILES.GROUPS);

    // 1. 匹配转发组
    const group = Object.values(groups).find(g => g.name === requestModel);
    if (!group) return res.status(404).json({error: `Model group '${requestModel}' not found`});
    if (group.type !== type) return res.status(400).json({error: `Protocol mismatch.`});

    const providersData = db.read(FILES.PROVIDERS);
    let candidates = group.providers
        .map(pName => providersData[pName])
        .filter(p => p !== undefined);

    // 排序：配置顺序优先，错误降权
    // 基础权重基于配置顺序：第一个=1000, 第二个=900, 第三个=800, ...
    // 有错误时权重会降低，但配置顺序的影响更大
    candidates.sort((a, b) => {
        // 获取配置顺序索引
        const indexA = group.providers.indexOf(a.name);
        const indexB = group.providers.indexOf(b.name);

        // 基础权重：配置顺序影响很大（1000, 900, 800...）
        const baseWeightA = 1000 - indexA * 100;
        const baseWeightB = 1000 - indexB * 100;

        // 获取动态权重（基于错误）
        const weightA = errorTracker.getWeight(a.name, baseWeightA);
        const weightB = errorTracker.getWeight(b.name, baseWeightB);

        // 按动态权重排序，权重高的优先
        return weightB - weightA;
    });

    // 记录排序后的候选列表（用于调试）
    if (candidates.length > 1) {
        console.log('[Weight] Provider order (config priority + error penalty):');
        candidates.forEach((p, idx) => {
            const configIndex = group.providers.indexOf(p.name);
            const baseWeight = 1000 - configIndex * 100;
            const weight = errorTracker.getWeight(p.name, baseWeight);
            const stats = errorTracker.getStats(p.name);
            console.log(`  ${idx + 1}. ${p.name}: weight=${weight.toFixed(2)} (base=${baseWeight}), configIndex=${configIndex}, recentErrors=${stats.recentErrors}`);
        });
    }

    let lastError = null;

    // --- Header 处理逻辑 ---
    // 定义必须剔除的敏感/自动 Header
    const unsafeHeaders = [
        'host', 'content-length', 'connection', 'transfer-encoding',
        'authorization', 'x-api-key', 'anthropic-version'
    ];

    // 提取并清洗客户端透传的 Header
    const clientHeaders = {};
    Object.keys(req.headers).forEach(key => {
        if (!unsafeHeaders.includes(key.toLowerCase())) {
            clientHeaders[key] = req.headers[key];
        }
    });

    // 3. 循环尝试 (Failover)
    for (const provider of candidates) {
        // 合并 Header (移到循环外层，让 catch 块也能访问)
        const requestHeaders = {
            ...clientHeaders, // 透传客户端 Header (如 User-Agent, Accept 等)
            'Content-Type': 'application/json'
        };

        // 注入认证 Key (重写)
        if (type === 'anthropic') {
            requestHeaders['x-api-key'] = provider.key;
            requestHeaders['Authorization'] = `Bearer ${provider.key}`;
            requestHeaders['authorization'] = `Bearer ${provider.key}`;
            requestHeaders['anthropic-version'] = '2023-06-01';
        } else {
            requestHeaders['Authorization'] = `Bearer ${provider.key}`;
        }

        try {
            console.log(`[Forwarding] ${requestModel} -> ${provider.name}`);

            const config = {
                method: 'POST',
                url: provider.endpoint,
                headers: requestHeaders,
                data: {...req.body, model: provider.realModel || requestModel},
                responseType: req.body.stream ? 'stream' : 'json',
                // 关键修改：移除 validateStatus，让 4xx/5xx 都抛出异常进入 catch
                // 只有 2xx 才视为成功
                timeout: 60000 // 设置 60s 超时防止挂死
            };

            if (provider.proxy) config.httpsAgent = new HttpsProxyAgent(provider.proxy);

            const response = await axios(config);

            // --- 成功处理 ---

            // 复制响应头给客户端 (排除部分)
            const unsafeResHeaders = ['content-length', 'transfer-encoding', 'connection'];
            Object.keys(response.headers).forEach(key => {
                if (!unsafeResHeaders.includes(key.toLowerCase())) {
                    res.setHeader(key, response.headers[key]);
                }
            });

            // --- 关键：流式响应拦截逻辑 ---
            if (req.body.stream) {
                let fullStreamData = ""; // 用于存储完整的流响应内容

                // 监听数据块
                response.data.on('data', (chunk) => {
                    fullStreamData += chunk.toString(); // 捕获数据
                    res.write(chunk); // 实时转发给客户端
                });

                // 监听流结束
                response.data.on('end', () => {
                    // 只有在流完全结束后，才记录日志
                    // 传递实际发送的请求头 requestHeaders 和响应头
                    db.logRequest(req.accessKeyName, provider.name, req, fullStreamData, response.status, null, requestHeaders, response.headers);
                    res.end();
                });

                // 监听流错误
                response.data.on('error', (err) => {
                    db.logRequest(req.accessKeyName, provider.name, req, fullStreamData, 500, err, requestHeaders, response.headers);
                    res.end();
                });

            } else {
                // 非流式响应处理
                db.logRequest(req.accessKeyName, provider.name, req, response.data, response.status, null, requestHeaders, response.headers);
                res.status(response.status).json(response.data);
            }
            return; // 成功退出

        } catch (error) {
            console.error(`[Fail] ${provider.name}: ${error.message}`);

            const errStatus = error.response ? error.response.status : 0;

            // === 关键修复开始 ===
            // 如果 responseType 是 stream，error.response.data 是一个 Stream 对象，不能直接序列化
            let errBody = error.message;
            if (error.response && error.response.data) {
                // 如果是流对象，替换为提示文本
                if (typeof error.response.data.pipe === 'function') {
                    errBody = "[Stream Error Response]";
                    // 提示: 如果想读取流中的具体错误信息，需要用 data.on('data') 收集，但这里为了稳定性直接截断
                } else {
                    errBody = error.response.data;
                }
            }
            // === 关键修复结束 ===

            const errHeaders = error.response ? error.response.headers : null;

            // 记录日志时传入处理过的 errBody
            db.logRequest(req.accessKeyName, provider.name, req, errBody, errStatus, error, requestHeaders, errHeaders);

            db.incFailure(provider.name);

            // 记录错误到动态权重系统
            if (errStatus === 429 || (errStatus >= 500 && errStatus < 600)) {
                errorTracker.recordError(provider.name, errStatus);
                console.log(`[Weight] ${provider.name} recorded error ${errStatus}, current weight: ${errorTracker.getWeight(provider.name, 100).toFixed(2)}`);
            }

            lastError = error;
            // 继续下一个循环
        }
    }

    // 全部失败
    res.status(502).json({
        error: 'All providers failed',
        last_error: lastError ? lastError.message : 'No providers'
    });
}


// === 公开 API 路由 ===

// OpenAI 协议入口
app.post('/v1/chat/completions', apiKeyAuth, (req, res) => {
    handleForwarding(req, res, 'openai');
});

// Anthropic 协议入口
app.post('/v1/messages', apiKeyAuth, (req, res) => {
    handleForwarding(req, res, 'anthropic');
});

// 获取模型列表 (返回组名)
app.get('/v1/models', apiKeyAuth, (req, res) => {
    const groups = db.read(FILES.GROUPS);
    const models = Object.values(groups).map(g => ({
        id: g.name,
        object: "model",
        created: Date.now(),
        owned_by: "gateway"
    }));
    res.json({object: "list", data: models});
});


// === 管理 API (RESTful) ===
const adminRouter = express.Router();
adminRouter.use(adminAuth);

// 提供者管理
adminRouter.get('/providers', (req, res) => res.json(db.read(FILES.PROVIDERS)));
adminRouter.post('/providers', (req, res) => {
    const data = db.read(FILES.PROVIDERS);
    const id = req.body.name; // 使用名称作为ID
    if (!id) return res.status(400).json({error: 'Name is required'});
    data[id] = req.body;
    db.write(FILES.PROVIDERS, data);
    res.json({success: true});
});
adminRouter.delete('/providers/:id', (req, res) => {
    const data = db.read(FILES.PROVIDERS);
    delete data[req.params.id];
    db.write(FILES.PROVIDERS, data);
    res.json({success: true});
});

// 转发组管理
adminRouter.get('/groups', (req, res) => res.json(db.read(FILES.GROUPS)));
adminRouter.post('/groups', (req, res) => {
    const data = db.read(FILES.GROUPS);
    const id = req.body.name;
    // 简单校验
    if (!id) return res.status(400).json({error: 'Group name required'});
    data[id] = req.body;
    db.write(FILES.GROUPS, data);
    res.json({success: true});
});
adminRouter.delete('/groups/:id', (req, res) => {
    const data = db.read(FILES.GROUPS);
    delete data[req.params.id];
    db.write(FILES.GROUPS, data);
    res.json({success: true});
});

// Access Key 管理
adminRouter.get('/keys', (req, res) => res.json(db.read(FILES.KEYS)));
adminRouter.post('/keys', (req, res) => {
    const data = db.read(FILES.KEYS);
    const id = req.body.id || uuidv4();
    data[id] = {...req.body, id};
    db.write(FILES.KEYS, data);
    res.json({success: true});
});
adminRouter.delete('/keys/:id', (req, res) => {
    const data = db.read(FILES.KEYS);
    delete data[req.params.id];
    db.write(FILES.KEYS, data);
    res.json({success: true});
});

// 统计信息
adminRouter.get('/stats', (req, res) => {
    res.json(db.read(FILES.STATS));
});

// 动态权重状态（新增）
adminRouter.get('/weight-status', (req, res) => {
    const providersData = db.read(FILES.PROVIDERS);
    const stats = db.read(FILES.STATS);

    const status = {};
    Object.keys(providersData).forEach(providerName => {
        const errorStats = errorTracker.getStats(providerName);
        const baseWeight = 100;
        const currentWeight = errorTracker.getWeight(providerName, baseWeight);

        status[providerName] = {
            baseWeight,
            currentWeight,
            weightRatio: (currentWeight / baseWeight).toFixed(2),
            recentErrors: errorStats.recentErrors,
            lastError: errorStats.lastError,
            totalFailures: stats[providerName]?.failures || 0,
            windowMs: errorStats.windowMs
        };
    });

    res.json(status);
});

// 清除指定提供者的错误记录（用于测试或手动恢复）
adminRouter.post('/weight-reset/:providerName', (req, res) => {
    const providerName = req.params.providerName;
    if (errorTracker.errors[providerName]) {
        delete errorTracker.errors[providerName];
        console.log(`[Weight] Reset errors for ${providerName}`);
        res.json({success: true, message: `Reset weight for ${providerName}`});
    } else {
        res.json({success: false, message: `No errors found for ${providerName}`});
    }
});

// 清除所有权重错误记录
adminRouter.post('/weight-clear-all', (req, res) => {
    errorTracker.errors = {};
    console.log('[Weight] Cleared all error records');
    res.json({success: true, message: 'Cleared all weight error records'});
});

// 清除日志文件
adminRouter.post('/logs-clear', (req, res) => {
    try {
        const dateStr = new Date().toISOString().split('T')[0];
        const logFile = path.join(FILES.LOGS_DIR, `${dateStr}.log`);

        if (fs.existsSync(logFile)) {
            fs.unlinkSync(logFile);
            console.log(`[Logs] Cleared today's log file: ${dateStr}.log`);
            res.json({success: true, message: `Cleared today's logs`});
        } else {
            res.json({success: false, message: 'No log file found for today'});
        }
    } catch (error) {
        console.error('[Logs] Error clearing logs:', error);
        res.status(500).json({success: false, error: error.message});
    }
});

// 清除所有日志文件
adminRouter.post('/logs-clear-all', (req, res) => {
    try {
        const files = fs.readdirSync(FILES.LOGS_DIR);
        let clearedCount = 0;

        files.forEach(file => {
            if (file.endsWith('.log')) {
                fs.unlinkSync(path.join(FILES.LOGS_DIR, file));
                clearedCount++;
            }
        });

        console.log(`[Logs] Cleared ${clearedCount} log files`);
        res.json({success: true, message: `Cleared ${clearedCount} log files`});
    } catch (error) {
        console.error('[Logs] Error clearing all logs:', error);
        res.status(500).json({success: false, error: error.message});
    }
});

// 辅助：从提供者拉取模型列表 (直接域名拼接URL)
adminRouter.post("/fetch-models", async (req, res) => {
    const {endpoint, key, proxy} = req.body;

    try {
        const config = {
            headers: {"Authorization": `Bearer ${key}`},
            timeout: 10000
        };
        if (proxy) config.httpsAgent = new HttpsProxyAgent(proxy);

        // 解析endpoint，提取协议+域名，然后拼接 /v1/models
        const url = new URL(endpoint);
        const modelsEndpoint = `${url.origin}/v1/models`;

        console.log("[FetchModels] Calling:", modelsEndpoint);
        const resp = await axios.get(modelsEndpoint, config);

        // 标准化响应格式
        let normalizedData;
        if (resp.data.data && Array.isArray(resp.data.data)) {
            normalizedData = resp.data;
        } else if (Array.isArray(resp.data)) {
            normalizedData = {
                object: "list",
                data: resp.data.map(m => ({
                    id: m.id || m.name || m,
                    object: "model",
                    created: Date.now(),
                    owned_by: m.owned_by || "unknown"
                }))
            };
        } else {
            normalizedData = {
                object: "list",
                data: Object.keys(resp.data).map(key => ({
                    id: key,
                    object: "model",
                    created: Date.now(),
                    owned_by: "unknown"
                }))
            };
        }

        res.json(normalizedData);

    } catch (e) {
        console.error("[FetchModels] Error:", e.message);

        let errorMessage = e.message;
        if (e.response) {
            errorMessage = `HTTP ${e.response.status}: ${e.response.statusText}`;
            if (e.response.data) {
                errorMessage += ` - ${JSON.stringify(e.response.data)}`;
            }
        } else if (e.code === 'ECONNABORTED') {
            errorMessage = "请求超时，请检查网络或代理设置";
        }

        res.status(500).json({error: errorMessage});
    }
});


// ... (其他 API 路由) ...

// === 新增：获取日志接口（支持分页 + 关键词过滤）===
adminRouter.get('/logs', async (req, res) => {
    const dateStr = new Date().toISOString().split('T')[0];
    const logFile = path.join(FILES.LOGS_DIR, `${dateStr}.log`);

    if (!fs.existsSync(logFile)) return res.json([]);

    // 解析查询参数
    const offset = parseInt(req.query.offset) || 0;      // 跳过前面多少条
    const limit = parseInt(req.query.limit) || 10;       // 每次加载多少条
    const refresh = req.query.refresh === 'true';        // 是否刷新（重新加载最新）
    const keyword = req.query.keyword || '';             // 关键词过滤
    const filterError = req.query.filterError === 'true'; // 只显示错误

    try {
        const content = await fs.readFile(logFile, 'utf-8');
        const lines = content.trim().split('\n').filter(line => line.trim());

        // 解析所有日志
        let allLogs = [];
        for (const line of lines) {
            try {
                allLogs.push(JSON.parse(line));
            } catch (e) {
                // 跳过解析失败的行
            }
        }

        // 应用过滤器
        if (keyword || filterError) {
            const lowerKeyword = keyword.toLowerCase();

            allLogs = allLogs.filter(log => {
                // 错误过滤
                if (filterError && log.status >= 200 && log.status < 300) {
                    return false;
                }

                // 关键词过滤（搜索多个字段）
                if (keyword) {
                    const searchFields = [
                        log.keyName || '',
                        log.provider || '',
                        log.request?.body?.model || '',
                        log.request?.path || '',
                        log.response?.error || '',
                        log.response?.data || '',
                        log.status?.toString() || ''
                    ];

                    // 如果是对象，转换为字符串搜索
                    const searchableText = searchFields
                        .map(field => {
                            if (typeof field === 'object') {
                                try {
                                    return JSON.stringify(field).toLowerCase();
                                } catch (e) {
                                    return '';
                                }
                            }
                            return String(field).toLowerCase();
                        })
                        .join(' ');

                    return searchableText.includes(lowerKeyword);
                }

                return true;
            });
        }

        // 日志是按时间顺序追加的，最新的在最后
        // 如果是刷新模式，从最后开始取 limit 条，并倒序返回（最新的在前）
        if (refresh) {
            const start = Math.max(0, allLogs.length - limit);
            const result = allLogs.slice(start).reverse();
            return res.json(result);
        }

        // 普通模式：分页加载（从指定位置开始取 limit 条）
        // 需要倒序处理：用户看到的应该是最新的在前
        // 所以我们要从倒数位置开始计算
        const total = allLogs.length;
        const startIndex = Math.max(0, total - offset - limit);
        const endIndex = total - offset;

        const paginatedLogs = allLogs.slice(startIndex, endIndex);

        // 倒序返回，最新的在前
        const result = paginatedLogs.reverse();

        res.json({
            logs: result,
            hasMore: startIndex > 0,  // 还有更多数据
            total: total,
            loaded: result.length,
            filtered: !!(keyword || filterError)  // 是否应用了过滤
        });
    } catch (e) {
        console.error('读取日志失败:', e);
        res.status(500).json({error: '读取日志失败'});
    }
});

// ... (确保最后 app.listen 还在) ...

app.use('/admin/api', adminRouter);

// 启动
app.listen(PORT, () => {
    console.log(`Gateway running on http://localhost:${PORT}`);
    console.log(`Admin UI: http://localhost:${PORT}/admin.html`);
});

