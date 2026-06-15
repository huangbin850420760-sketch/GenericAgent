/* ═══════════════════════════════════════════════════
   API Layer · Decouples UI from backend implementation
   ═══════════════════════════════════════════════════
   Exposes `window.GA_API`:
     REST:
       - getConfig()               → { ws_port }
       - getStatus()               → { llm, llms, running, last_reply_time, autonomous_enabled }
       - listSessions()            → [{id,path,mtime,preview,rounds}]
       - getSessionHistory(path)   → [{role,content}]
       - restoreSession(path)      → { message, ok, history: [...] }
       - listSkills()              → { tools: [...], sops: [...] }
       - getSop(name)              → { name, content }
       - uploadFile(file)          → { path, name }
     WS (realtime):
       - connect(handlers)         → opens WS, dispatches messages via handlers
       - send(type, payload)       → sends a typed message
   All requests are self-describing; changing backend internals should only
   require updating this file. UI code should never reach into backend state.
   ═══════════════════════════════════════════════════ */
(() => {
  const BASE = '';  // same origin
  let ws = null;
  let wsHandlers = {};
  let wsReconnectTimer = null;
  let wsReconnectCount = 0;
  const WS_MAX_RECONNECT = 20;        // cap at 20 retries (~60s)
  const WS_RECONNECT_BASE_MS = 3000;  // base delay with exponential backoff

  async function _getJSON(path) {
    const r = await fetch(BASE + path);
    if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
    return r.json();
  }
  async function _postJSON(path, body) {
    const r = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`POST ${path}: ${r.status} ${text}`);
    }
    return r.json();
  }

  async function getConfig() { return _getJSON('/api/config'); }
  async function getStatus() { return _getJSON('/api/status'); }
  async function listSessions(q) {
    const qs = q ? ('?q=' + encodeURIComponent(q)) : '';
    return _getJSON('/api/sessions' + qs);
  }
  async function getSessionHistory(path) {
    const r = await _getJSON('/api/session/history?path=' + encodeURIComponent(path));
    return r.messages || [];
  }
  async function restoreSession(path) { return _postJSON('/api/session/restore', { path }); }
  async function renameSession(path, title) { return _postJSON('/api/session/rename', { path, title }); }
  async function deleteSession(path) { return _postJSON('/api/session/delete', { path }); }
  async function listSkills() { return _getJSON('/api/skills'); }
  async function getSop(name) {
    const r = await _getJSON('/api/skills/sop?name=' + encodeURIComponent(name));
    return r;
  }
  async function uploadFile(file) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const r = await fetch(BASE + '/api/upload', { method: 'POST', body: fd });
    if (!r.ok) throw new Error('upload failed: ' + r.status);
    return r.json();
  }

  /* ── WebSocket layer ── */
  function _scheduleReconnect(handlers) {
    if (wsReconnectCount >= WS_MAX_RECONNECT) {
      console.warn('[WS] Max reconnect attempts reached (' + WS_MAX_RECONNECT + '). Giving up.');
      wsHandlers.onmaxreconnect && wsHandlers.onmaxreconnect();
      return;
    }
    wsReconnectCount++;
    const delay = Math.min(WS_RECONNECT_BASE_MS * Math.pow(1.5, wsReconnectCount - 1), 30000);
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(() => connect(handlers), delay);
  }
  async function connect(handlers) {
    wsHandlers = handlers || {};
    // Close existing connection to prevent leaks
    if (ws) {
      try { ws.onclose = null; ws.close(); } catch(_) {}
      ws = null;
    }
    try {
      const cfg = await getConfig();
      const wsUrl = `ws://${location.hostname}:${cfg.ws_port}`;
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        wsReconnectCount = 0; // reset on successful connect
        wsHandlers.onopen && wsHandlers.onopen();
      };
      ws.onclose = () => {
        wsHandlers.onclose && wsHandlers.onclose();
        _scheduleReconnect(wsHandlers);
      };
      ws.onerror = (e) => { wsHandlers.onerror && wsHandlers.onerror(e); };
      ws.onmessage = (evt) => {
        let msg;
        try { msg = JSON.parse(evt.data); } catch { return; }
        const t = msg.type;
        const fn = wsHandlers['on_' + t] || wsHandlers.onmessage;
        if (fn) fn(msg);
      };
    } catch (e) {
      wsHandlers.onerror && wsHandlers.onerror(e);
      _scheduleReconnect(wsHandlers);
    }
  }
  async function getLLMConfig() { return _getJSON('/api/llm-config'); }
  async function saveLLMConfig(data) { return _postJSON('/api/llm-config', data); }
  async function reloadLLMConfig() { return _postJSON('/api/llm-config/reload', {}); }
  async function backupMykeyPy() { return _postJSON('/api/llm-config/backup-py', {}); }
  async function listModels(apikey, apibase, proxy) {
    return _postJSON('/api/llm-config/list-models', { apikey, apibase, proxy });
  }

  function send(type, payload) {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type, payload }));
    return true;
  }
  function ready() { return ws && ws.readyState === 1; }

  // Sophub (community SOP hub)
  async function sophubSearch(q, page = 1, pageSize = 24) { return _getJSON(`/api/sophub/search?q=${encodeURIComponent(q)}&page=${page}&page_size=${pageSize}`); }
  async function sophubSop(id) { return _getJSON(`/api/sophub/sop/${id}`); }
  async function sophubDownload(id) {
    const r = await fetch(`/api/sophub/download/${id}`);
    if (!r.ok) throw new Error((await r.json()).error || 'download failed');
    return r.blob();
  }
  async function sophubUpload(title, content, fileType = 'markdown') {
    return _postJSON('/api/sophub/upload', { title, content, file_type: fileType });
  }
  async function sophubMe() { return _getJSON('/api/sophub/me'); }

  async function fetchSlashCommands() {
    const r = await fetch('/api/slash-commands');
    if (!r.ok) throw new Error('Failed to fetch slash commands');
    const data = await r.json();
    return data.commands;
  }

  // ── Scheduler ──
  async function schedulerTasks() { return _getJSON('/api/scheduler/tasks'); }
  async function schedulerCreate(task) { return _postJSON('/api/scheduler/tasks', task); }
  async function schedulerUpdate(name, task) {
    const r = await fetch(BASE + '/api/scheduler/tasks/' + encodeURIComponent(name), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(task),
    });
    if (!r.ok) throw new Error('PUT scheduler task: ' + r.status);
    return r.json();
  }
  async function schedulerDelete(name) {
    const r = await fetch(BASE + '/api/scheduler/tasks/' + encodeURIComponent(name), { method: 'DELETE' });
    if (!r.ok) throw new Error('DELETE scheduler task: ' + r.status);
    return r.json();
  }
  async function schedulerDone() { return _getJSON('/api/scheduler/reports'); }
  async function schedulerDoneRead(fname) { return _getJSON('/api/scheduler/report/' + encodeURIComponent(fname)); }
  async function schedulerLog() { return _getJSON('/api/scheduler/log'); }

  // ── Goal ──
  async function goalState() { return _getJSON('/api/goal/state'); }
  async function goalStart(opts) { return _postJSON('/api/goal/start', opts); }
  async function goalStop() { return _postJSON('/api/goal/stop', {}); }

  // ── Hive ──
  async function hiveSessions() { return _getJSON('/api/hive/sessions'); }
  async function hiveCreate(opts) { return _postJSON('/api/hive/create', opts); }
  async function hiveStatus(name) { return _getJSON('/api/hive/' + encodeURIComponent(name) + '/status'); }
  async function hiveStop(name) { return _postJSON('/api/hive/' + encodeURIComponent(name) + '/stop', {}); }
  async function hiveLog(name, role, lines) { return _getJSON('/api/hive/' + encodeURIComponent(name) + '/log/' + encodeURIComponent(role) + (lines ? '?lines=' + lines : '')); }
  async function hiveDelete(name) { const r = await fetch('/api/hive/' + encodeURIComponent(name), { method: 'DELETE' }); if (!r.ok) throw new Error('Delete failed: ' + r.status); return r.json(); }

  // ── MCP ──
  async function mcpServers() { return _getJSON('/api/mcp/servers'); }
  async function mcpAdd(name, url, type, headers) {
    const r = await fetch(BASE + '/api/mcp/servers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, config: { type: type || 'http', url, headers: headers || {} } }),
    });
    if (!r.ok) throw new Error('Add MCP server: ' + r.status);
    return r.json();
  }
  async function mcpDelete(name) {
    const r = await fetch(BASE + '/api/mcp/servers/' + encodeURIComponent(name), { method: 'DELETE' });
    if (!r.ok) throw new Error('Delete MCP server: ' + r.status);
    return r.json();
  }
  async function mcpToggle(name) { return _postJSON('/api/mcp/servers/' + encodeURIComponent(name) + '/toggle', {}); }
  async function mcpTest(server, tool, arguments) { return _postJSON('/api/mcp/test', { server, tool, arguments: arguments || {} }); }

  window.GA_API = {
    getConfig, getStatus,
    listSessions, getSessionHistory, restoreSession, renameSession, deleteSession,
    listSkills, getSop,
    uploadFile,
    getLLMConfig, saveLLMConfig, reloadLLMConfig, backupMykeyPy, listModels,
    connect, send, ready,
    sophubSearch, sophubSop, sophubDownload, sophubUpload, sophubMe,
    fetchSlashCommands,
    schedulerTasks, schedulerCreate, schedulerUpdate, schedulerDelete,
    schedulerDone, schedulerDoneRead, schedulerLog,
    goalState, goalStart, goalStop,
    hiveSessions, hiveCreate, hiveStatus, hiveStop, hiveLog, hiveDelete,
    mcpServers, mcpAdd, mcpDelete, mcpToggle, mcpTest,
  };
})();
