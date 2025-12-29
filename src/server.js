/**
 * 智能大模型转发网关 - Entry Point
 */
const express = require('express');
const cors = require('cors');
const { parseArgs } = require('node:util'); // Node.js 内置参数解析
const path = require('path');
const config = require('./config'); // 引入配置对象
// 注意：db 和 routes 需要在配置更新后引入/使用，或者它们内部引用的是 config 的 getter
// 由于我们修改了 config.js 使用 getter，所以这里可以先引入
const db = require('./utils/db');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');

// === 1. 定义命令行参数 ===
const options = {
    port: { type: 'string', short: 'p' },
    host: { type: 'string', short: 'h' },
    'config-dir': { type: 'string', short: 'c' },
    'log-dir': { type: 'string', short: 'l' },
    cors: { type: 'boolean', default: true }, // 默认为 true
    help: { type: 'boolean' }
};

// Help 文本
const printHelp = () => {
    console.log(`
LLM Gateway Service
Usage: node src/server.js [options]

Options:
  -p, --port <number>      Port to listen on (Default: 3000)
  -h, --host <address>     IP address to bind (Default: 127.0.0.1)
  -c, --config-dir <path>  Directory for config files (data/)
  -l, --log-dir <path>     Directory for logs (data/logs/)
  --no-cors                Disable CORS support (Default: CORS enabled)
  --help                   Show this help message

Examples:
  node src/server.js --port 8080
  node src/server.js --host 0.0.0.0 --no-cors
  node src/server.js -c /etc/llm-gateway -l /var/log/llm-gateway
`);
};

// === 2. 解析参数 ===
try {
    const { values } = parseArgs({ options, strict: true, allowPositionals: false });

    // 如果请求帮助
    if (values.help) {
        printHelp();
        process.exit(0);
    }

    // 更新配置
    config.update({
        port: values.port,
        host: values.host,
        cors: values.cors,
        configDir: values['config-dir'],
        logDir: values['log-dir']
    });

} catch (err) {
    // 参数错误（如未知的 flag）
    console.error(`Error: ${err.message}`);
    printHelp();
    process.exit(1);
}

// === 3. 初始化服务 ===
const app = express();

// === 1. [新增] 全局请求计时日志 (放在最前面) ===
app.use((req, res, next) => {
    req.startTime = Date.now();
    req.requestId = Math.random().toString(36).substring(7); // 简单生成个ID方便追踪

    console.log(`[${new Date().toISOString()}] [REQ:${req.requestId}] -> ${req.method} ${req.url}`);

    // 监听响应结束事件
    res.on('finish', () => {
        const duration = Date.now() - req.startTime;
        const color = res.statusCode >= 500 ? '\x1b[31m' : (res.statusCode >= 400 ? '\x1b[33m' : '\x1b[32m');
        const reset = '\x1b[0m';

        console.log(`[${new Date().toISOString()}] [REQ:${req.requestId}] <- ${color}${res.statusCode}${reset} (${duration}ms)`);

        // 如果耗时超过 500ms，打印警告
        if (duration > 500) {
            console.warn(`[WARN] [REQ:${req.requestId}] Slow request detected!`);
        }
    });

    next();
});

// 初始化数据库/目录 (此时 config 已经是更新后的路径)
try {
    db.init();
} catch (e) {
    console.error("Critical Error: Failed to initialize data directories.", e.message);
    process.exit(1);
}

// 中间件
if (config.ENABLE_CORS) {
    app.use(cors());
    console.log('[Init] CORS Enabled');
} else {
    console.log('[Init] CORS Disabled');
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// 路由挂载
app.use('/v1', apiRoutes);
app.use('/admin/api', adminRoutes);

// 错误兜底
// 2. [新增] 专门的 503/500 全局错误处理中间件 (放在 app.listen 之前，所有路由之后)
app.use((err, req, res, next) => {
    console.error('[Global Error]', err);

    // 强制写入 CORS 头，防止浏览器报 "Missing Allow Origin" 掩盖真实错误
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");

    // 如果是并发限制或超时导致的
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Request entity too large' });
    }

    res.status(503).json({
        error: 'Service Unavailable',
        details: err.message
    });
});

// 3. [建议] 增加未捕获异常处理 (防止进程直接崩溃导致 Nginx 报 502/503)
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    // 生产环境通常建议重启，但作为简单网关可以先记录不退出
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});

// === 4. 启动监听 ===
// 使用配置中的 HOST 和 PORT
app.listen(config.PORT, config.HOST, () => {
    console.log(`\n>>> Gateway running on http://${config.HOST}:${config.PORT}`);
    console.log(`>>> Admin UI: http://${config.HOST}:${config.PORT}/admin.html`);
    console.log(`>>> Data Dir: ${config.DIRS.DATA}`);
    console.log(`>>> Logs Dir: ${config.DIRS.LOGS}`);
});
