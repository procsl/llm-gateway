const express = require('express');
const { apiKeyAuth } = require('../middlewares/auth');
const handleForwarding = require('../services/forwarder');
const db = require('../utils/db');
const { FILES } = require('../config');

const router = express.Router();

// OpenAI 协议入口
router.post('/chat/completions', apiKeyAuth, (req, res) => {
    handleForwarding(req, res, 'openai');
});

// Anthropic 协议入口
router.post('/messages', apiKeyAuth, (req, res) => {
    handleForwarding(req, res, 'anthropic');
});

// 获取模型列表
router.get('/models', apiKeyAuth, (req, res) => {
    const groups = db.read(FILES.GROUPS);
    const models = Object.values(groups).map(g => ({
        id: g.name,
        object: "model",
        created: Date.now(),
        owned_by: "gateway"
    }));
    res.json({ object: "list", data: models });
});

module.exports = router;
