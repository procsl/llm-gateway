const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { FILES, DIRS } = require('../config');

// 初始化目录和文件
const initDB = () => {
    fs.ensureDirSync(DIRS.DATA);
    fs.ensureDirSync(DIRS.LOGS);
    [FILES.PROVIDERS, FILES.GROUPS, FILES.KEYS, FILES.STATS].forEach(f => {
        if (!fs.existsSync(f)) fs.writeJsonSync(f, {});
    });
};

const db = {
    init: initDB,
    read: (file) => fs.readJsonSync(file, { throws: false }) || {}, // 读配置可以保持同步(通常只在启动或低频时读)

    // [修改] 改为异步写入，且不等待结果(Fire and forget)或是简单的异步
	 // [修改] 带耗时统计的异步写入
    write: async (file, data) => {
        const start = Date.now();
        const fileName = path.basename(file);
        try {
            await fs.writeJson(file, data, { spaces: 2 });
            const duration = Date.now() - start;
            if (duration > 100) {
                console.log(`[IO Warn] Write ${fileName} took ${duration}ms`);
            }
        } catch (e) {
            console.error(`[IO Error] Write ${fileName} failed:`, e.message);
        }
    },

    getFailureCount: (providerName) => {
        const stats = db.read(FILES.STATS);
        return stats[providerName]?.failures || 0;
    },

    // [修改] 异步增加失败计数
    incFailure: async (providerName) => {
        // 注意：高并发下这里存在竞态条件，但对于日志统计系统可以接受
	try {
            const stats = (await fs.readJson(FILES.STATS, { throws: false })) || {};
            if (!stats[providerName]) stats[providerName] = { failures: 0, tokens: 0 };
            stats[providerName].failures += 1;
            await db.write(FILES.STATS, stats); // 使用上面的带log的write
        } catch (e) {
            console.error('[DB Error] IncFailure:', e.message);
        }
    },

    // [修改] 异步日志记录 (这是性能瓶颈最大的地方)
    logRequest: async (accessKeyName, providerName, req, resData, status, error = null, actualHeaders = null, responseHeaders = null, fullTrace = null) => {
        const dateStr = new Date().toISOString().split('T')[0];
        const logFile = path.join(DIRS.LOGS, `${dateStr}.log`);

        // 数据清洗逻辑保持不变...
        const sanitizeData = (data) => {
            if (!data) return data;
            if (typeof data === 'object' && (typeof data.pipe === 'function' || data.socket)) {
                return '[Stream/Socket Data]';
            }
            return data;
        };

        let logEntry;
        if (fullTrace) {
            logEntry = { ...fullTrace };
            if (logEntry.attempts) {
                logEntry.attempts = logEntry.attempts.map(att => ({
                    ...att,
                    responseBody: sanitizeData(att.responseBody),
                    error: sanitizeData(att.error)
                }));
            }
            logEntry.clientRequest.body = sanitizeData(logEntry.clientRequest.body);
            logEntry.finalResponse = sanitizeData(logEntry.finalResponse);
            logEntry.provider = providerName;
        } else {
             // ... 兼容旧代码 ...
             logEntry = { id: uuidv4(), /*...*/ };
        }

        // 使用异步追加，不阻塞事件循环
	 try {
            // 注意：如果 logEntry 很大，JSON.stringify 也是耗时的
            const logLine = JSON.stringify(logEntry) + '\n';
            
            await fs.appendFile(logFile, logLine);
            
            const duration = Date.now() - start;
            if (duration > 50) {
                console.log(`[IO Warn] Log append took ${duration}ms (Size: ${(logLine.length/1024).toFixed(2)}KB)`);
            }
        } catch (err) {
            console.error("[IO Error] Log serialization/write failed:", err.message);
        }
    }
};

module.exports = db;
