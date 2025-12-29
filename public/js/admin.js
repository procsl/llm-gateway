const { createApp, ref, onMounted, computed, nextTick } = Vue;
const API_BASE = '/admin/api';

createApp({
    setup() {
        // === 基础状态 ===
        const currentTab = ref('providers');
        const providers = ref({});
        const groups = ref({});
        const keys = ref({});
        const stats = ref({});
        const logs = ref([]);
        const weightStatus = ref({});

        // === 日志列表状态 ===
        const logState = ref({
            offset: 0,
            limit: 20,
            hasMore: true,
            loading: false,
            showScrollTop: false,
            keyword: '',
            filterError: false
        });
        const logContainer = ref(null);

        // === 详情弹窗状态 (Trace) ===
        const logModal = ref({
            show: false,
            trace: null,
            activeAttemptIndex: -1,
            showMerged: true,
        });

        // === UI 折叠状态 ===
        const activeUI = ref({
            reqHeaders: false,
            reqBody: true,
            resHeaders: false,
            resBody: true,
            error: true
        });

        // === 确认弹窗 ===
        const showClearLogsModal = ref(false);
        const showClearWeightsModal = ref(false);

        // === 表单数据 ===
        const pForm = ref({ name:'', type:'openai', endpoint:'', key:'', proxy:'', realModel:'' });
        const fetchedModels = ref([]);
        const manualModelsInput = ref('');
        const gForm = ref({ name:'', type:'openai', providers:[] });
        const kForm = ref({ name:'', key:'' });
        const isEditing = ref(false);
        const isEditingGroup = ref(false);

        const tabs = [
            { id: 'providers', label: '提供者' },
            { id: 'groups', label: '转发组' },
            { id: 'keys', label: '凭证 (Key)' },
            { id: 'logs', label: '全链路追踪' },
            { id: 'stats', label: '监控' },
        ];

        // === API 交互 ===
        const fetchData = async () => {
            providers.value = await (await fetch(`${API_BASE}/providers`)).json();
            groups.value = await (await fetch(`${API_BASE}/groups`)).json();
            keys.value = await (await fetch(`${API_BASE}/keys`)).json();
        };

        const switchTab = async (tab) => {
            currentTab.value = tab;
            if(tab === 'stats') {
                stats.value = await (await fetch(`${API_BASE}/stats`)).json();
                weightStatus.value = await (await fetch(`${API_BASE}/weight-status`)).json();
            }
            if(tab === 'logs') loadLogs();
        };

        // === 日志核心逻辑 ===
        const refreshLogs = async () => {
            if (logState.value.loading) return;
            logState.value.loading = true;
            try {
                const params = new URLSearchParams({ limit: logState.value.limit.toString(), refresh: 'true' });
                if (logState.value.keyword) params.append('keyword', logState.value.keyword);
                if (logState.value.filterError) params.append('filterError', 'true');

                const response = await fetch(`${API_BASE}/logs?${params}`);
                const data = await response.json();
                logs.value = Array.isArray(data) ? data : data.logs || [];
                logState.value.offset = logs.value.length;
                logState.value.hasMore = logs.value.length >= logState.value.limit;
                if (logContainer.value) logContainer.value.scrollTop = 0;
            } catch (error) { console.error('Error:', error); } finally { logState.value.loading = false; }
        };

        const loadMoreLogs = async () => {
            if (logState.value.loading || !logState.value.hasMore) return;
            logState.value.loading = true;
            try {
                const params = new URLSearchParams({ offset: logState.value.offset.toString(), limit: logState.value.limit.toString() });
                if (logState.value.keyword) params.append('keyword', logState.value.keyword);
                if (logState.value.filterError) params.append('filterError', 'true');

                const response = await fetch(`${API_BASE}/logs?${params}`);
                const data = await response.json();
                if (data.logs?.length) { logs.value = [...logs.value, ...data.logs]; logState.value.offset += data.logs.length; }
                logState.value.hasMore = data.hasMore;
            } catch (error) { console.error('Error:', error); } finally { logState.value.loading = false; }
        };
        
        const loadLogs = () => refreshLogs();
        const applyFilters = async () => { logState.value.offset = 0; logs.value = []; logState.value.hasMore = true; await refreshLogs(); };
        const clearFilters = () => { logState.value.keyword = ''; logState.value.filterError = false; applyFilters(); };
        const toggleErrorFilter = () => { logState.value.filterError = !logState.value.filterError; applyFilters(); };

        // === 详情页逻辑 ===
        const showLogDetail = (log) => {
            logModal.value.trace = log;
            if (log.attempts && log.attempts.length > 0) {
                logModal.value.activeAttemptIndex = log.attempts.length - 1;
            } else {
                logModal.value.activeAttemptIndex = -1;
            }
            logModal.value.showMerged = true;
            logModal.value.show = true;
            resetUIState();
        };

        const switchAttempt = (index) => {
            logModal.value.activeAttemptIndex = index;
            resetUIState();
        };

        const resetUIState = () => {
            activeUI.value = { reqHeaders: false, reqBody: true, resHeaders: false, resBody: true, error: true };
        };

        const activeContext = computed(() => {
            const trace = logModal.value.trace;
            if (!trace) return null;
            const idx = logModal.value.activeAttemptIndex;

            if (idx === -1) {
                const errorInfo = trace.finalResponse?.error || trace.attempts?.find(a => a.status >= 400)?.error;
                return {
                    type: 'summary', provider: 'Gateway Summary', request: trace.clientRequest, response: trace.finalResponse,
                    status: trace.status, error: errorInfo, headers: trace.clientRequest?.headers,
                    resHeaders: trace.attempts?.length > 0 ? trace.attempts[trace.attempts.length-1].responseHeaders : null
                };
            } else {
                const attempt = trace.attempts[idx];
                return {
                    type: 'attempt', provider: attempt.provider,
                    request: { headers: attempt.requestHeaders, body: trace.clientRequest?.body },
                    response: attempt.responseBody, status: attempt.status, error: attempt.error,
                    headers: attempt.requestHeaders, resHeaders: attempt.responseHeaders, duration: attempt.duration, weight: attempt.weight
                };
            }
        });

        // === SSE Logic ===
        const mergeSSEToJSON = (sseData) => {
            if (!sseData || typeof sseData !== 'string') return sseData;
            const lines = sseData.split(/\r?\n/);
            let fullContent = "", role = "assistant", model = "", isAnthropic = false, reasoningContent = "";
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const jsonStr = trimmed.substring(5).trim();
                if (jsonStr === '[DONE]') continue;
                try {
                    const obj = JSON.parse(jsonStr);
                    if (obj.choices && obj.choices[0]) {
                        const delta = obj.choices[0].delta;
                        if (delta.content) fullContent += delta.content;
                        if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
                        if (delta.role) role = delta.role;
                        if (obj.model) model = obj.model;
                    } else if (obj.type) {
                        isAnthropic = true;
                        if (obj.type === 'message_start' && obj.message) model = obj.message.model;
                        else if (obj.type === 'content_block_delta' && obj.delta?.text) fullContent += obj.delta.text;
                    }
                } catch (e) { }
            }
            if (isAnthropic) {
                return JSON.stringify({ id: "merged-sse-preview", type: "message", role: "assistant", model: model, content: [{ type: "text", text: fullContent }] }, null, 2);
            } else {
                const result = { id: "merged-sse-preview", object: "chat.completion", model: model, choices: [{ message: { role: role, content: fullContent }, finish_reason: "stop" }] };
                if(reasoningContent) result.choices[0].message.reasoning_content = reasoningContent;
                return JSON.stringify(result, null, 2);
            }
        };

        const getDisplayContent = (content) => {
            if (!content) return '';
            if (typeof content === 'object') return JSON.stringify(content, null, 2);
            if (typeof content === 'string') {
                if (logModal.value.showMerged && content.includes('data:')) {
                    const merged = mergeSSEToJSON(content);
                    try { return JSON.stringify(JSON.parse(merged), null, 2); } catch (e) { return merged; }
                }
                try { return JSON.stringify(JSON.parse(content), null, 2); } catch (e) { return content; }
            }
            return String(content);
        };

        const highlightJSON = (str) => {
            if (!str) return '';
            if (window.hljs) return hljs.highlight(str, { language: 'json' }).value;
            return str;
        };

        const formatTime = (iso) => {
            if (!iso) return 'N/A';
            return new Date(iso).toLocaleString('zh-CN', { hour12: false });
        };

        const copyToClipboard = (text) => {
            if(!text) return;
            navigator.clipboard.writeText(text).then(() => alert('✅ 已复制到剪贴板'));
        };

        const handleScroll = () => {
            if (!logContainer.value) return;
            const { scrollTop, scrollHeight, clientHeight } = logContainer.value;
            logState.value.showScrollTop = scrollTop > 300;
            if (scrollHeight - scrollTop - clientHeight < 100) loadMoreLogs();
        };
        const scrollToTop = () => logContainer.value?.scrollTo({ top: 0, behavior: 'smooth' });

        // === CRUD ===
        const saveProvider = async () => { if(!pForm.value.name) return alert('名称必填'); await fetch(`${API_BASE}/providers`, { method: 'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(pForm.value)}); resetPForm(); fetchData(); };
        const resetPForm = () => { pForm.value={name:'',type:'openai',endpoint:'',key:'',proxy:'',realModel:''}; isEditing.value=false; fetchedModels.value=[]; manualModelsInput.value=''; };
        const editProvider = (p) => { pForm.value={...p}; isEditing.value=true; window.scrollTo({top:0,behavior:'smooth'}); };
        const copyProvider = (p) => { pForm.value={...p, name:`${p.name}_copy`}; isEditing.value=false; window.scrollTo({top:0,behavior:'smooth'}); };
        const deleteItem = async (t, id) => { if(confirm('确认删除?')) { await fetch(`${API_BASE}/${t}/${id}`, {method:'DELETE'}); fetchData(); }};
        const saveGroup = async () => { if(!gForm.value.name || gForm.value.providers.length===0) return alert('信息不完整'); await fetch(`${API_BASE}/groups`, { method: 'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(gForm.value)}); resetGForm(); fetchData(); };
        const resetGForm = () => { gForm.value={name:'',type:'openai',providers:[]}; isEditingGroup.value=false; };
        const editGroup = (g) => { gForm.value=JSON.parse(JSON.stringify(g)); isEditingGroup.value=true; window.scrollTo({top:0,behavior:'smooth'}); };
        const toggleProvider = (n) => { const i=gForm.value.providers.indexOf(n); if(i>-1) gForm.value.providers.splice(i,1); else gForm.value.providers.push(n); };
        const saveKey = async () => { if(!kForm.value.key) kForm.value.key='sk-'+Math.random().toString(36).substr(2,9); await fetch(`${API_BASE}/keys`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(kForm.value)}); kForm.value={name:'',key:''}; fetchData(); };
        const tryFetchModels = async () => {
            if(!pForm.value.endpoint || !pForm.value.key) return alert('需Endpoint和Key');
            try {
                const r = await fetch(`${API_BASE}/fetch-models`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(pForm.value) });
                const d = await r.json();
                if(d.error) throw new Error(d.error);
                fetchedModels.value = d.data || [];
                alert(`✅ 拉取成功！共${d.data.length}个模型`);
            } catch(e) { alert('❌ 拉取失败: '+e.message); }
        };
        const parseManualModels = () => {
            if (!manualModelsInput.value.trim()) { fetchedModels.value = []; return; }
            const models = manualModelsInput.value.split(',').map(m => m.trim()).filter(m => m.length > 0).map(m => ({ id: m }));
            fetchedModels.value = models;
            if (models.length === 1) pForm.value.realModel = models[0].id;
        };
        const confirmClearLogs = () => showClearLogsModal.value = true;
        const confirmClearWeights = () => showClearWeightsModal.value = true;
        const clearLogs = async (type) => { try { const res = await (await fetch(`${API_BASE}/${type==='today'?'logs-clear':'logs-clear-all'}`, { method: 'POST' })).json(); if (res.success) { alert('✅ 已清除'); logs.value = []; logState.value.offset = 0; } else alert('❌ ' + res.message); } catch (e) { alert('Error: '+e.message); } showClearLogsModal.value = false; };
        const clearWeights = async () => { try { const res = await (await fetch(`${API_BASE}/weight-clear-all`, { method: 'POST' })).json(); if(res.success) { alert('✅ 已清除'); if(currentTab.value==='stats') switchTab('stats'); } } catch(e){} showClearWeightsModal.value = false; };

        onMounted(fetchData);

        return {
            tabs, currentTab, switchTab, providers, groups, keys, stats, logs, logModal, weightStatus,
            pForm, gForm, kForm, isEditing, isEditingGroup, fetchedModels, manualModelsInput,
            logState, logContainer, showClearLogsModal, showClearWeightsModal, 
            activeContext, activeUI, switchAttempt,
            saveProvider, resetPForm, editProvider, copyProvider, deleteItem, saveGroup, resetGForm, editGroup, toggleProvider, saveKey,
            tryFetchModels, parseManualModels, loadLogs, refreshLogs, showLogDetail, formatTime, 
            getDisplayContent, highlightJSON, copyToClipboard, handleScroll, scrollToTop, applyFilters, clearFilters, toggleErrorFilter,
            confirmClearLogs, confirmClearWeights, clearLogs, clearWeights
        };
    }
}).mount('#app');
