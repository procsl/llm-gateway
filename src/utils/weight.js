// === 动态权重管理器 ===
const errorTracker = {
    errors: {},
    WINDOW_MS: 60 * 1000,
    PENALTY_429: 5,
    PENALTY_5XX: 3,

    recordError(providerName, status) {
        const now = Date.now();
        if (!this.errors[providerName]) {
            this.errors[providerName] = [];
        }
        if (status === 429 || (status >= 500 && status < 600)) {
            this.errors[providerName].push({ timestamp: now, status });
            this.cleanup(providerName);
        }
    },

    cleanup(providerName) {
        const now = Date.now();
        if (this.errors[providerName]) {
            this.errors[providerName] = this.errors[providerName].filter(
                err => now - err.timestamp < this.WINDOW_MS
            );
        }
    },

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
        return baseWeight / penalty;
    },

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

module.exports = errorTracker;
