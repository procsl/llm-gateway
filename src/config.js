/**
 * src/config.js
 * 配置中心 - 支持动态更新
 */
const path = require('path');

// 内部状态，存储默认值
const state = {
    PORT: 3000,
    HOST: '127.0.0.1',
    ENABLE_CORS: true,
    ADMIN_USER: 'admin',
    ADMIN_PASS: '123456',
    
    // 默认路径：基于项目根目录的 data 文件夹
    // 假设本文件在 src/ 下，根目录是 src/..
    DATA_DIR: path.resolve(__dirname, '..', 'data'),
    LOGS_DIR: path.resolve(__dirname, '..', 'data', 'logs')
};

module.exports = {
    // === 基础配置 (Getters) ===
    get PORT() { return state.PORT; },
    get HOST() { return state.HOST; },
    get ENABLE_CORS() { return state.ENABLE_CORS; },
    get ADMIN_USER() { return state.ADMIN_USER; },
    get ADMIN_PASS() { return state.ADMIN_PASS; },

    // === 目录配置 ===
    get DIRS() {
        return {
            get DATA() { return state.DATA_DIR; },
            get LOGS() { return state.LOGS_DIR; }
        };
    },
    
    // === 文件路径 (动态计算) ===
    get FILES() {
        return {
            get PROVIDERS() { return path.join(state.DATA_DIR, 'providers.json'); },
            get GROUPS() { return path.join(state.DATA_DIR, 'groups.json'); },
            get KEYS() { return path.join(state.DATA_DIR, 'keys.json'); },
            get STATS() { return path.join(state.DATA_DIR, 'stats.json'); },
        };
    },

    // === 更新配置的方法 ===
    update: (options) => {
        if (options.port) state.PORT = parseInt(options.port, 10);
        if (options.host) state.HOST = options.host;
        
        // 处理 CORS (cli 传递的是字符串 'true'/'false' 或者 boolean)
        if (options.cors !== undefined) {
            state.ENABLE_CORS = String(options.cors) !== 'false';
        }

        // 处理目录
        if (options.configDir) {
            state.DATA_DIR = path.resolve(options.configDir);
            // 如果用户指定了配置目录但没指定日志目录，默认日志放在配置目录下
            if (!options.logDir) {
                state.LOGS_DIR = path.join(state.DATA_DIR, 'logs');
            }
        }

        if (options.logDir) {
            state.LOGS_DIR = path.resolve(options.logDir);
        }
    }
};
