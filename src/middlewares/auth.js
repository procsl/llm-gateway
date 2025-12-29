const auth = require('basic-auth');
const db = require('../utils/db');
const { FILES, ADMIN_USER, ADMIN_PASS } = require('../config');

// Basic Auth (后台管理)
const adminAuth = (req, res, next) => {
    const user = auth(req);
    if (!user || user.name !== ADMIN_USER || user.pass !== ADMIN_PASS) {
        res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
        return res.status(401).send('Access denied');
    }
    next();
};

// Bearer Token Auth (接口调用)
const apiKeyAuth = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing Bearer Token' });
    }
    const token = authHeader.split(' ')[1];
    const keys = db.read(FILES.KEYS);
    
    const validKey = Object.values(keys).find(k => k.key === token);

    if (!validKey) {
        return res.status(401).json({ error: 'Invalid Access Key' });
    }
    req.accessKeyName = validKey.name; 
    req.accessKeyToken = token;
    next();
};

module.exports = { adminAuth, apiKeyAuth };
