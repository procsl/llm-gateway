const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { v4: uuidv4 } = require('uuid');
const { adminAuth } = require('../middlewares/auth');
const db = require('../utils/db');
const errorTracker = require('../utils/weight');
const { FILES, DIRS } = require('../config');

const router = express.Router();
router.use(adminAuth);

// === CRUD (Providers, Groups, Keys) ===
const createCrud = (route, file, idField = 'id') => {
    router.get(route, (req, res) => res.json(db.read(file)));
    router.post(route, (req, res) => {
        const data = db.read(file);
        const id = req.body[idField] || (idField === 'id' ? uuidv4() : req.body.name);
        if (!id) return res.status(400).json({ error: 'ID/Name required' });
        data[id] = { ...req.body, [idField]: id }; // 确保包含ID
        db.write(file, data);
        res.json({ success: true });
    });
    router.delete(`${route}/:id`, (req, res) => {
        const data = db.read(file);
        delete data[req.params.id];
        db.write(file, data);
        res.json({ success: true });
    });
};

createCrud('/providers', FILES.PROVIDERS, 'name');
createCrud('/groups', FILES.GROUPS, 'name');
createCrud('/keys', FILES.KEYS, 'id');

// === 统计与权重 ===
router.get('/stats', (req, res) => res.json(db.read(FILES.STATS)));

router.get('/weight-status', (req, res) => {
    const providersData = db.read(FILES.PROVIDERS);
    const stats = db.read(FILES.STATS);
    const status = {};
    Object.keys(providersData).forEach(pName => {
        const errStats = errorTracker.getStats(pName);
        const baseWeight = 100;
        const currentWeight = errorTracker.getWeight(pName, baseWeight);
        status[pName] = {
            baseWeight,
            currentWeight,
            weightRatio: (currentWeight / baseWeight).toFixed(2),
            recentErrors: errStats.recentErrors,
            lastError: errStats.lastError,
            totalFailures: stats[pName]?.failures || 0,
            windowMs: errStats.windowMs
        };
    });
    res.json(status);
});

router.post('/weight-reset/:providerName', (req, res) => {
    const pName = req.params.providerName;
    if (errorTracker.errors[pName]) delete errorTracker.errors[pName];
    res.json({ success: true, message: `Reset weight for ${pName}` });
});

router.post('/weight-clear-all', (req, res) => {
    errorTracker.errors = {};
    res.json({ success: true, message: 'Cleared all weight records' });
});

// === 日志管理 ===
router.post('/logs-clear', (req, res) => {
    try {
        const dateStr = new Date().toISOString().split('T')[0];
        const logFile = path.join(DIRS.LOGS, `${dateStr}.log`);
        if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/logs-clear-all', (req, res) => {
    try {
        const files = fs.readdirSync(DIRS.LOGS);
        files.forEach(f => f.endsWith('.log') && fs.unlinkSync(path.join(DIRS.LOGS, f)));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 复杂日志查询
router.get('/logs', async (req, res) => {
    const dateStr = new Date().toISOString().split('T')[0];
    const logFile = path.join(DIRS.LOGS, `${dateStr}.log`);
    if (!fs.existsSync(logFile)) return res.json([]);

    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 10;
    const refresh = req.query.refresh === 'true';
    const keyword = req.query.keyword || '';
    const filterError = req.query.filterError === 'true';

    try {
        const content = await fs.readFile(logFile, 'utf-8');
        let allLogs = [];
        content.trim().split('\n').forEach(line => {
            try { if(line) allLogs.push(JSON.parse(line)); } catch(e){}
        });

        if (keyword || filterError) {
            const lowerKey = keyword.toLowerCase();
            allLogs = allLogs.filter(log => {
                if (filterError && log.status >= 200 && log.status < 300) return false;
                if (keyword) {
                    const fields = [
                        log.keyName, log.provider, log.request?.body?.model, log.request?.path,
                        log.response?.error, log.response?.data, log.status
                    ];
                    const text = fields.map(f => typeof f === 'object' ? JSON.stringify(f) : String(f || '')).join(' ').toLowerCase();
                    return text.includes(lowerKey);
                }
                return true;
            });
        }

        if (refresh) return res.json(allLogs.slice(Math.max(0, allLogs.length - limit)).reverse());

        const total = allLogs.length;
        const startIndex = Math.max(0, total - offset - limit);
        const result = allLogs.slice(startIndex, total - offset).reverse();

        res.json({ logs: result, hasMore: startIndex > 0, total, loaded: result.length, filtered: !!(keyword || filterError) });
    } catch (e) { res.status(500).json({ error: 'Log read failed' }); }
});

// === 辅助工具 ===
router.post("/fetch-models", async (req, res) => {
    const { endpoint, key, proxy } = req.body;
    try {
        const config = { headers: { "Authorization": `Bearer ${key}` }, timeout: 10000 };
        if (proxy) config.httpsAgent = new HttpsProxyAgent(proxy);
        const url = new URL(endpoint);
        const resp = await axios.get(`${url.origin}/v1/models`, config);
        
        // 标准化逻辑
        let data = resp.data.data || resp.data;
        if (!Array.isArray(data)) {
            if (typeof data === 'object') data = Object.keys(data).map(k => ({ id: k }));
            else data = [];
        }
        
        res.json({
            object: "list",
            data: data.map(m => ({
                id: m.id || m.name || m,
                object: "model",
                created: Date.now(),
                owned_by: m.owned_by || "unknown"
            }))
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
