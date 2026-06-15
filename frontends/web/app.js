/* ═══════════════════════════════════════════════════
   GenericAgent · UI (uses GA_API layer for all backend I/O)
   ═══════════════════════════════════════════════════ */
(() => {
  // FIX: ws referenced by context-panel code but never declared (causes ReferenceError that crashes the whole IIFE → all pet settings break). Declare as null so references are safe (WS context-panel features disabled until proper WS hookup exists).
  var ws = null;
  // Safe storage wrapper - won't throw if storage is blocked (Edge Tracking Prevention etc.)
  const _storage = {
    get(k, fallback = null) { try { const v = localStorage.getItem(k); return v !== null ? v : fallback; } catch(e) { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch(e) {} },
    del(k) { try { localStorage.removeItem(k); } catch(e) {} }
  };

  const API = window.GA_API;
  const $ = (id) => document.getElementById(id);

  // Elements
  const messagesEl = $('messages');
  const inputEl = $('input');
  const attachmentsEl = $('attachments');
  const sendBtn = $('btn-send');
  const fileInput = $('file-input');
  const imageInput = $('image-input');
  const statusDot = $('status-dot');
  const statusText = $('status-text');
  const statusTurn = $('status-turn');
  const statusExp = $('status-exp');
  const statusPref = $('status-pref');
  const statusErr = $('status-err');
  const statusTools = $('status-tools');
  const headerMemory = $('header-memory');
  const headerMemCount = $('header-mem-count');
  const modeBtns = document.querySelectorAll('.mode-btn');
  const llmNameEl = $('llm-name');
  const llmSelector = $('llm-selector');
  const llmDropdown = $('llm-dropdown');
  const dragOverlay = $('drag-overlay');
  const sessionsListEl = $('sessions-list');
  const idleValueEl = $('idle-value');
  const autonomousToggle = $('autonomous-toggle');
  const autonomousHintText = $('autonomous-hint-text');
  const modalOverlay = $('modal-overlay');
  const modalBody = $('modal-body');
  const modalTitle = $('modal-title');
  const modalSubtitle = $('modal-subtitle');
  const modalIcon = $('modal-icon');

  // Configure marked (with XSS protection)
  const _origMarkedRenderer = new marked.Renderer();
  // Sanitize href to prevent javascript: protocol XSS
  _origMarkedRenderer.link = function(href, title, text) {
    const proto = (href || '').trim().toLowerCase();
    if (proto.startsWith('javascript:') || proto.startsWith('data:') || proto.startsWith('vbscript:')) {
      return escapeHTML(text);
    }
    return marked.Renderer.prototype.link.call(this, href, title, text);
  };
  marked.setOptions({
    breaks: true, gfm: true,
    renderer: _origMarkedRenderer,
    highlight: (code, lang) => {
      if (lang && hljs.getLanguage(lang)) {
        try { return hljs.highlight(code, { language: lang }).value; } catch {}
      }
      try { return hljs.highlightAuto(code).value; } catch { return code; }
    },
  });

  // Upload limits (frontend guard)
  const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB
  const MAX_FILE_SIZE = 50 * 1024 * 1024;  // 50 MB

  // State
  const state = {
    tab: 'chat',
    currentMode: 'chat',
    running: false,
    attachments: [],
    sessionQuery: '',
    llms: [],
    currentLLM: '',
    lastReplyTime: 0,
    autonomousEnabled: false,
    pendingAssistant: null,
    viewingSessionPath: null,   // path of session being viewed (read-only)
    savedActiveHTML: null,      // saved innerHTML of active conversation
    skills: { tools: [], sops: [] },
    currentSessionPath: null,
  };

  /* ═════ WebSocket send helper ═════ */
  function wsSend(msg) { API.send(msg.type, msg.payload); }

  /* ═════ WebSocket wiring via API layer ═════ */
  API.connect({
    onopen: async () => {
      setStatus('就绪', false);
      const s = await API.getStatus().catch(() => null);
      if (s) updateStatus(s);
      refreshSessions();
    },
    onclose: () => setStatus('连接断开，3秒后重连...', false, true),
    on_status: (m) => {
      try {
        updateStatus(m.payload);
        // Bridge to 3D viz: map running state to viz status enum
        const p = m.payload || {};
        const vizStatus = p.running ? 'working' : 'idle';
        window.dispatchEvent(new CustomEvent('agent-state', { detail: { status: vizStatus } }));
      } catch(e) { console.error('[WS on_status]', e); }
    },
    on_stream: (m) => {
      try {
        if (state.viewingSessionPath) returnToActive();
        const full = (m && m.full) || '';
        appendAssistantStream(full);
        // Bridge: detect tool calls in stream for 3D viz
        const toolMatch = full.match(/\[([A-Za-z_]+)\]/g);
        if (toolMatch) {
          window.dispatchEvent(new CustomEvent('agent-state', { detail: { type: 'tool-call', tools: toolMatch.map(t => t.replace(/[\[\]]/g, '')) } }));
        }
      } catch(e) { console.error('[WS on_stream]', e); }
    },
    on_done: (m) => {
      try {
        // T1.5.2: 提取experience标记
        if (m && m.has_experience) { state.lastHasExperience = true; state.lastExperienceIds = m.experience_ids || []; }
        finalizeAssistant(m && m.payload); setRunning(false); refreshSessions();
        // Bridge to 3D viz
        window.dispatchEvent(new CustomEvent('agent-state', { detail: { status: 'done' } }));
      } catch(e) { console.error('[WS on_done]', e); setRunning(false); }
    },
    on_info: (m) => showToast((m && m.payload) || '', 'info'),
    on_error: (m) => { showToast((m && m.payload) || '未知错误', 'error'); setRunning(false); },
    on_experience: (m) => { if (statusExp) { statusExp.classList.add('has-data'); statusExp.title = `经验: ${m.payload?.summary || '已提取'}`; } state.lastHasExperience = true; if (m.payload?.id) { if (!state.lastExperienceIds) state.lastExperienceIds = []; state.lastExperienceIds.push(m.payload.id); } },
    on_preference: (m) => { if (statusPref) { statusPref.classList.add('has-data'); statusPref.title = `偏好: ${m.payload?.key || '已学习'}`; } },
    on_error_recovery: (m) => { if (statusErr) { statusErr.classList.add('visible'); statusErr.title = `恢复: ${m.payload?.strategy || '已激活'}`; } },
    on_capability_report_result: (m) => _renderCapCards(m.payload),
    on_memory_stats: (m) => {
      const p = m.payload || {};
      if (statusExp) { statusExp.textContent = `🧠${p.experience_count || 0}`; statusExp.title = `经验: ${p.experience_count || 0}条`; if (p.experience_count > 0) statusExp.classList.add('has-data'); }
      if (statusPref) { statusPref.textContent = `⚙️${p.preference_count || 0}`; statusPref.title = `偏好: ${p.preference_count || 0}条`; if (p.preference_count > 0) statusPref.classList.add('has-data'); }
      // T1.5.1: 同步更新Header记忆指示器
      if (headerMemCount) {
        const exp = p.experience_count || 0;
        const pref = p.preference_count || 0;
        headerMemCount.textContent = `${exp + pref}`;
        if (headerMemory) headerMemory.classList.toggle('has-data', exp + pref > 0);
      }
    },
    on_auto_user: (m) => {
      if (state.viewingSessionPath) returnToActive();
      // Autonomous task fired (idle-monitor or manual). Show a user bubble + prep assistant area.
      addUserMessage(m.payload || '🤖 (自主触发)', [], []);
      addAssistantPlaceholder();
      setRunning(true);
      showToast('🤖 自主行动已触发', 'info');
      // Bridge to 3D viz
      window.dispatchEvent(new CustomEvent('agent-state', { detail: { status: 'working' } }));
    },
    // ── T3 WS handlers: SOP suggestion / SOP stats / MCP recommend ──
    on_sop_suggestion: (m) => {
      const p = m.payload || {};
      showToast(`💡 SOP建议: ${p.pattern || ''} (${p.count || 0}次)`, 'info');
    },
    on_sop_stats: (m) => {
      const p = m.payload || {};
      if (statusExp) {
        statusExp.title = `SOP统计: ${p.total || 0}个, 成功率${p.success_rate || 0}%`;
      }
    },
    on_mcp_recommend: (m) => {
      const p = m.payload || {};
      showToast(`🔌 MCP推荐: ${p.tool_name || ''} - ${p.reason || ''}`, 'info');
    },
    // ── T4.1: Execution preview approval ──
    on_execution_preview: (m) => {
      const p = m.payload || {};
      showPreviewPanel(p);
    },
    // ── Execution step → notify 3D pet ──
    on_execution_step: (m) => {
      // Notify pet about tool execution
      if (window.__petNotify && m.payload) {
        const p = m.payload;
        const icons = { running: '⏳', success: '✅', error: '❌' };
        const txt = `${icons[p.status]||'⚪'} ${p.tool||'?'}`;
        window.__petNotify(txt);
      }
    },
  });

  /* ═════ Status ═════ */
  function setStatus(text, running, error = false) {
    statusText.textContent = text;
    statusDot.classList.remove('running', 'error');
    if (running) statusDot.classList.add('running');
    if (error) statusDot.classList.add('error');
  }
  function updateStatus(p) {
    state.llms = p.llms || [];
    state.currentLLM = p.llm || '';
    state.lastReplyTime = p.last_reply_time || 0;
    state.autonomousEnabled = !!p.autonomous_enabled;
    llmNameEl.textContent = p.llm || '未配置';
    renderLLMDropdown();
    setRunning(!!p.running);
    autonomousToggle.checked = state.autonomousEnabled;
    document.body.classList.toggle('autonomous-on', state.autonomousEnabled);
    if (autonomousHintText) autonomousHintText.textContent = state.autonomousEnabled ? '30分钟空闲后自动触发' : '已停止';
  }
  function setRunning(r) {
    state.running = r;
    const icSend = sendBtn.querySelector('.send-ic-send');
    const icStop = sendBtn.querySelector('.send-ic-stop');
    if (r) {
      setStatus('运行中...', true);
      sendBtn.classList.add('stopping');
      sendBtn.title = '停止 (Esc)';
      if (icSend) icSend.classList.add('hidden');
      if (icStop) icStop.classList.remove('hidden');
    } else {
      setStatus('就绪', false);
      sendBtn.classList.remove('stopping');
      sendBtn.title = '发送 (Enter)';
      if (icSend) icSend.classList.remove('hidden');
      if (icStop) icStop.classList.add('hidden');
      if (typeof _showSuggestions === 'function') _showSuggestions();
    }
  }
  setInterval(() => {
    if (!state.lastReplyTime) { idleValueEl.textContent = '—'; return; }
    const s = Math.max(0, Math.floor(Date.now() / 1000) - state.lastReplyTime);
    idleValueEl.textContent = formatDuration(s);
  }, 1000);

  function formatDuration(s) {
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    return Math.floor(s / 3600) + 'h' + Math.floor((s % 3600) / 60) + 'm';
  }

  /* ═════ LLM dropdown ═════ */
  function renderLLMDropdown() {
    llmDropdown.innerHTML = state.llms.map(l =>
      `<div class="llm-option ${l.current ? 'current' : ''}" data-idx="${l.idx}">
        <span><span class="idx">${l.idx}</span>${escapeHTML(l.name)}</span>
        ${l.current ? '<span style="color:#4ade80">●</span>' : ''}
      </div>`).join('');
    llmDropdown.querySelectorAll('.llm-option').forEach(el => {
      el.addEventListener('click', () => {
        API.send('next_llm', parseInt(el.dataset.idx, 10));
        llmDropdown.classList.remove('open');
        llmDropdown.classList.add('hidden');
      });
    });
  }
  llmSelector.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !llmDropdown.classList.contains('open');
    llmDropdown.classList.toggle('open', willOpen);
    llmDropdown.classList.toggle('hidden', !willOpen);
  });
  document.addEventListener('click', () => {
    llmDropdown.classList.remove('open');
    llmDropdown.classList.add('hidden');
  });

  /* ═════ Tabs ═════ */
  // Top tab bar buttons (.tab-btn) + bottom action buttons ([data-tab])
  document.querySelectorAll('#sidebar .tab-btn, #sidebar [data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.body.classList.remove('sidebar-collapsed');
      switchTab(btn.dataset.tab);
    });
  });

  function switchTab(tab) {
    state.tab = tab;
    try {
      // Sync sidebar nav buttons
      document.querySelectorAll('#sidebar .tab-btn, #sidebar [data-tab]').forEach(b =>
        b.classList.toggle('active', b.dataset.tab === tab));
      // Sync collapsed rail buttons
      document.querySelectorAll('#sidebar-rail [data-tab]').forEach(b =>
        b.classList.toggle('active', b.dataset.tab === tab));
      // Toggle right-side views (safe: skip if element missing)
      const views = { 'view-chat': 'chat', 'view-skills': 'skills', 'view-settings': 'settings', 'view-tasks': 'tasks', 'view-mcp': 'mcp', 'view-3d': 'viz' };
      for (const [id, t] of Object.entries(views)) {
        const el = $(id);
        if (!el) continue;
        el.classList.toggle('hidden', tab !== t);
        if (id === 'view-chat') el.classList.toggle('flex', tab === t);
      }
      if (tab === 'viz') loadVizPanel();
      if (tab === 'skills') loadSkills();
      if (tab === 'settings') { loadConfig(); if (!window._petSettingsInited) { window._petSettingsInited = true; setTimeout(initPetSettings, 200); } }
      if (tab === 'tasks') initTasksView();
      if (tab === 'mcp') loadMCPPanel();
    } catch(e) { console.error('[switchTab]', tab, e); }
  }
  switchTab('chat');

  // Welcome-screen inline link to Skills
  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-tab-link]');
    if (link) { e.preventDefault(); switchTab(link.dataset.tabLink); }
  });

  /* ═════ Sessions ═════ */
  async function refreshSessions() {
    try {
      const q = state.sessionQuery || '';
      const sessions = await API.listSessions(q);
      renderSessions(sessions);
    } catch (e) {
      sessionsListEl.innerHTML = `<div class="text-frost-400 text-xs p-2 text-center">加载失败</div>`;
    }
  }
  function renderSessions(sessions) {
    if (!sessions || sessions.length === 0) {
      const msg = state.sessionQuery ? '未找到匹配的对话' : '暂无历史';
      sessionsListEl.innerHTML = `<div class="text-frost-400 text-xs p-2 text-center">${msg}</div>`;
      return;
    }
    const shown = sessions.slice(0, 10);
    sessionsListEl.innerHTML = shown.map(s => {
      const title = s.title || (s.preview || '(无预览)').replace(/\n/g, ' ');
      const displayTitle = escapeHTML(title.slice(0, 50));
      const rel = relTime(s.mtime);
      const active = state.currentSessionPath === s.path ? 'active' : '';
      const hint = s.title ? escapeAttr(s.preview || '') : escapeAttr(title);
      return `<div class="session-item ${active}" data-path="${escapeAttr(s.path)}" title="${hint}">
        <div class="session-row">
          <span class="session-title">${displayTitle}</span>
          <span class="session-time">${rel}</span>
        </div>
        <div class="session-actions">
          <button class="session-action-btn" data-act="rename" title="重命名">
            <i data-lucide="pencil" class="w-3 h-3"></i>
          </button>
          <button class="session-action-btn session-action-danger" data-act="delete" title="删除">
            <i data-lucide="trash-2" class="w-3 h-3"></i>
          </button>
        </div>
      </div>`;
    }).join('');
    lucide.createIcons();
    sessionsListEl.querySelectorAll('.session-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.session-actions')) return;
        viewSession(el.dataset.path);
      });
      const renameBtn = el.querySelector('[data-act="rename"]');
      const deleteBtn = el.querySelector('[data-act="delete"]');
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const currentTitle = el.querySelector('.session-title').textContent.trim();
        const input = prompt('重命名对话（留空恢复默认）', currentTitle);
        if (input === null) return;
        API.renameSession(el.dataset.path, input.trim())
          .then(() => { refreshSessions(); showToast('✅ 已更新标题', 'success'); })
          .catch(err => showToast('重命名失败: ' + err.message, 'error'));
      });
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm('确认删除此对话历史？（不可恢复）')) return;
        API.deleteSession(el.dataset.path)
          .then(() => { refreshSessions(); showToast('🗑 已删除', 'success'); })
          .catch(err => showToast('删除失败: ' + err.message, 'error'));
      });
    });
  }

  async function viewSession(path) {
    // Switch to chat tab if not already there
    if (state.tab !== 'chat') switchTab('chat');
    // Directly restore the session instead of read-only viewing
    restoreAndShow(path);
  }

  function returnToActive() {
    state.viewingSessionPath = null;
    if (state.savedActiveHTML !== null) {
      messagesEl.innerHTML = state.savedActiveHTML;
      state.savedActiveHTML = null;
    } else {
      clearMessages('');
    }
    const titleEl = $('conversation-title');
    if (titleEl) titleEl.textContent = '新对话';
  }

  async function restoreAndShow(path) {
    try {
      const r = await API.restoreSession(path);
      // 不设置 currentSessionPath = path：restore后新对话写入pid日志文件，
      // 而非restore的快照文件；保持null让侧边栏正确高亮活跃session
      state.currentSessionPath = null;
      state.viewingSessionPath = null;
      state.savedActiveHTML = null;
      // Derive title from the first user message (fallback: filename)
      const firstUser = (r.history || []).find(m => m.role === 'user');
      const preview = firstUser ? String(firstUser.content || '').slice(0, 48) : '';
      const fname = path.split(/[\\/]/).pop().replace(/\.(json|txt)$/i, '');
      const title = preview || fname || '会话恢复';
      const titleEl = $('conversation-title');
      if (titleEl) titleEl.textContent = title;
      renderSessionHistory(r.history || []);
      refreshSessions();
    } catch (e) {
      showToast('恢复失败: ' + e.message, 'error');
    }
  }

  function renderSessionHistory(messages) {
    clearMessages('');
    if (!messages.length) {
      messagesEl.innerHTML = `<div class="welcome flex flex-col items-center justify-center h-[60%] text-frost-400 text-sm">会话历史为空</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    for (const m of messages) {
      const parts = m.parts || [];
      if (m.role === 'user') {
        // Only render user bubble if there's actual user_text.
        // tool_result / system meta is rendered as a subtle "tool output" strip instead.
        const userTexts = parts.filter(p => p.type === 'user_text');
        const toolResults = parts.filter(p => p.type === 'tool_result');
        if (userTexts.length) {
          frag.appendChild(buildUserFromParts(userTexts));
        }
        if (toolResults.length) {
          frag.appendChild(buildToolResults(toolResults));
        }
      } else {
        frag.appendChild(buildAssistantFromParts(parts));
      }
    }
    messagesEl.appendChild(frag);
    lucide.createIcons();
    scrollToBottom();
  }

  /* ─ Build user bubble from parts (user_text only) ─ */
  function buildUserFromParts(parts) {
    const el = document.createElement('div');
    el.className = 'msg msg-user';
    const body = parts.map(p => renderMarkdown(p.content)).join('');
    el.innerHTML = `
      <div class="msg-body">
        <div class="msg-content">${body}</div>
      </div>`;
    return el;
  }

  /* ─ Build a tool-result strip (collapsed by default) ─
     Wrapped as msg-like element with empty avatar gutter so it aligns
     visually with the assistant's body column. */
  function buildToolResults(parts) {
    const el = document.createElement('div');
    el.className = 'msg msg-tool-output';
    const count = parts.length;
    const bodies = parts.map(p => {
      const isJSON = /^[\s\n]*[\{\[]/.test(p.content);
      const lang = isJSON ? 'json' : 'text';
      return `<pre class="tool-result-pre"><code class="language-${lang}">${escapeHTML(p.content)}</code></pre>`;
    }).join('');
    el.innerHTML = `
      <div class="msg-avatar-spacer"></div>
      <div class="msg-body">
        <div class="tool-result-strip">
          <button class="tool-result-header" type="button">
            <i data-lucide="terminal" class="w-3.5 h-3.5"></i>
            <span class="flex-1 text-left">工具返回 · ${count}</span>
            <i data-lucide="chevron-down" class="caret w-4 h-4"></i>
          </button>
          <div class="tool-result-body">${bodies}</div>
        </div>
      </div>`;
    el.querySelector('.tool-result-header').addEventListener('click', () =>
      el.querySelector('.tool-result-strip').classList.toggle('open'));
    setTimeout(() => el.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b)), 0);
    return el;
  }

  /* ─ Build assistant message from parts (thinking/text/tool_use) ─ */
  function buildAssistantFromParts(parts) {
    const el = document.createElement('div');
    el.className = 'msg msg-assistant';
    // Group consecutive tool_use parts into foldable rounds
    const groups = [];
    let toolGroup = [];
    for (const p of parts) {
      if (p.type === 'tool_use') {
        toolGroup.push(p);
      } else {
        if (toolGroup.length) { groups.push({ kind: 'tools', parts: toolGroup }); toolGroup = []; }
        groups.push({ kind: 'single', part: p });
      }
    }
    if (toolGroup.length) groups.push({ kind: 'tools', parts: toolGroup });

    const bodyHTML = groups.map(g => {
      if (g.kind === 'single') return renderPart(g.part);
      // Foldable tool-call round (collapsed by default)
      const count = g.parts.length;
      const names = g.parts.map(p => p.name || '?');
      const inner = g.parts.map(p => renderPart(p)).join('');
      return `<div class="part part-tool-round">
        <button class="part-header" type="button">
          <span class="part-icon"><i data-lucide="wrench" class="w-3.5 h-3.5"></i></span>
          <span class="part-label">工具调用 · ${count}</span>
          <span class="tool-names">${names.map(n => escapeHTML(n)).join(', ')}</span>
          <i data-lucide="chevron-down" class="caret w-4 h-4"></i>
        </button>
        <div class="part-body">${inner}</div>
      </div>`;
    }).join('');

    el.innerHTML = `
      <div class="msg-avatar">AI</div>
      <div class="msg-body">
        <div class="msg-header"><span class="msg-role">ASSISTANT</span></div>
        <div class="msg-content">${bodyHTML}</div>
      </div>`;
    // wire up collapsibles
    el.querySelectorAll('.part-thinking, .part-tool-round').forEach(p => {
      const header = p.querySelector('.part-header');
      if (header) header.addEventListener('click', () => p.classList.toggle('open'));
    });
    setTimeout(() => el.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b)), 0);
    return el;
  }

  function renderPart(p, idx) {
    if (p.type === 'thinking') {
      const preview = (p.content || '').replace(/\s+/g, ' ').slice(0, 80);
      return `<div class="part part-thinking">
        <button class="part-header" type="button">
          <span class="part-icon">💭</span>
          <span class="part-label">思考</span>
          <span class="part-preview">${escapeHTML(preview)}${p.content.length > 80 ? '…' : ''}</span>
          <i data-lucide="chevron-down" class="caret w-4 h-4"></i>
        </button>
        <div class="part-body">${renderMarkdown(p.content)}</div>
      </div>`;
    }
    if (p.type === 'tool_use') {
      let inp;
      try { inp = JSON.stringify(p.input || {}, null, 2); } catch { inp = String(p.input); }
      return `<div class="part part-tool-use">
        <button class="part-header" type="button">
          <span class="part-icon"><i data-lucide="wrench" class="w-3.5 h-3.5"></i></span>
          <span class="part-label">工具调用</span>
          <span class="tool-name">${escapeHTML(p.name)}</span>
          <i data-lucide="chevron-down" class="caret w-4 h-4"></i>
        </button>
        <div class="part-body"><pre><code class="language-json">${escapeHTML(inp)}</code></pre></div>
      </div>`;
    }
    // default: plain text (summary / answer)
    return `<div class="part part-text">${renderMarkdown(p.content)}</div>`;
  }

  function relTime(ts) {
    const d = Math.floor(Date.now() / 1000) - ts;
    if (d < 60) return d + '秒前';
    if (d < 3600) return Math.floor(d / 60) + '分前';
    if (d < 86400) return Math.floor(d / 3600) + '小时前';
    return Math.floor(d / 86400) + '天前';
  }

  const _btnRefreshSessions = $('btn-refresh-sessions');
  if (_btnRefreshSessions) _btnRefreshSessions.addEventListener('click', refreshSessions);

  // Session search — debounced
  let _searchTimer = null;
  $('session-search').addEventListener('input', (e) => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => {
      state.sessionQuery = e.target.value.trim();
      refreshSessions();
    }, 280);
  });

  /* ═════ Actions ═════ */
  document.querySelectorAll('[data-action]').forEach(el => {
    el.addEventListener('click', () => {
      const action = el.dataset.action;
      if (action === 'next_llm') API.send('next_llm', -1);
      else if (action === 'abort') API.send('abort');
      else API.send('action', { name: action });
    });
  });
  autonomousToggle.addEventListener('change', () => {
    API.send('action', { name: 'autonomous_toggle' });
  });

  /* ═══ T1.5.4 Mode Switch ═══ */
  modeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (!mode || mode === state.currentMode) return;
      state.currentMode = mode;
      modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
      API.send('mode_change', { mode });
    });
  });

  /* ═════ New chat ═════ */
  $('btn-new-chat').addEventListener('click', newChat);
  $('rail-new-chat').addEventListener('click', newChat);
  function newChat() {
    if (!confirm('开启新对话？当前上下文将被清空。')) return;
    API.send('reset');
    state.currentSessionPath = null;
    const titleEl = $('conversation-title');
    if (titleEl) titleEl.textContent = '新对话';
    clearMessages();
    refreshSessions();
  }
  function clearMessages(html) {
    messagesEl.innerHTML = html !== undefined ? html : `<div class="welcome flex flex-col items-center justify-center min-h-[70%] text-center gap-3 select-none">
      <div class="relative mb-4">
        <div class="absolute inset-0 rounded-[28px] bg-gradient-to-br from-brand-400 via-accent-violet to-accent-pink blur-2xl opacity-40 animate-pulse-slow"></div>
        <div class="relative w-20 h-20 rounded-[24px] bg-gradient-to-br from-brand-400 via-accent-violet to-accent-pink flex items-center justify-center text-white animate-float shadow-pop">
          <i data-lucide="sparkles" class="w-10 h-10"></i>
        </div>
      </div>
      <div class="text-[34px] font-semibold tracking-tight leading-tight bg-gradient-to-br from-white via-frost-50 to-frost-200 bg-clip-text text-transparent">Hello, GenericAgent</div>
      <div class="text-frost-300 text-[14px] max-w-md">新对话已开启 · 输入任务开始</div>
    </div>`;
    lucide.createIcons();
  }

  /* ═════ Sidebar collapse ═════ */
  $('sidebar-collapse')?.addEventListener('click', () => document.body.classList.add('sidebar-collapsed'));
  $('sidebar-collapse-2')?.addEventListener('click', () => document.body.classList.add('sidebar-collapsed'));
  $('sidebar-collapse-3')?.addEventListener('click', () => document.body.classList.add('sidebar-collapsed'));
  $('sidebar-expand')?.addEventListener('click', () => document.body.classList.remove('sidebar-collapsed'));

  /* ═════ Actions drawer toggle ═════ */
  const actionsToggle = $('actions-toggle');
  const actionsDrawer = $('actions-drawer');
  if (actionsToggle && actionsDrawer) {
    actionsToggle.addEventListener('click', () => {
      actionsDrawer.classList.toggle('hidden');
      const label = actionsToggle.querySelector('span');
      if (label) label.textContent = actionsDrawer.classList.contains('hidden') ? '操作' : '收起';
    });
  }

  /* ═════ Messages ═════ */
  function clearWelcome() { const w = messagesEl.querySelector('.welcome'); if (w) w.remove(); }

  function buildUserMessage(text, images, files) {
    const el = document.createElement('div');
    el.className = 'msg msg-user';
    const imgsHTML = (images || []).map(i => `<img src="${escapeAttr(i.data_url)}" alt="${escapeHTML(i.name)}" />`).join('');
    const filesHTML = (files || []).map(p => `<span class="f-pill" title="${escapeAttr(p)}">${escapeHTML(shortPath(p))}</span>`).join('');
    el.innerHTML = `
      <div class="msg-avatar">你</div>
      <div class="msg-body">
        <div class="msg-header"><span class="msg-role">USER</span><span>${nowStr()}</span></div>
        <div class="msg-content">${renderMarkdown(text || '')}</div>
        ${imgsHTML ? `<div class="attached-imgs">${imgsHTML}</div>` : ''}
        ${filesHTML ? `<div class="attached-files">${filesHTML}</div>` : ''}
      </div>`;
    return el;
  }

  function buildAssistantMessage(content) {
    const el = document.createElement('div');
    el.className = 'msg msg-assistant';
    el.innerHTML = `
      <div class="msg-avatar">AI</div>
      <div class="msg-body">
        <div class="msg-header"><span class="msg-role">ASSISTANT</span><span>${nowStr()}</span></div>
        <div class="msg-content">${renderSegments(foldTurns(content))}</div>
      </div>`;
    attachTurnHandlers(el);
    return el;
  }

  function addUserMessage(text, images, files) {
    clearWelcome();
    messagesEl.appendChild(buildUserMessage(text, images, files));
    scrollToBottom();
  }

  function addAssistantPlaceholder() {
    clearWelcome();
    const el = document.createElement('div');
    el.className = 'msg msg-assistant';
    el.innerHTML = `
      <div class="msg-avatar">AI</div>
      <div class="msg-body">
        <div class="msg-header"><span class="msg-role">${escapeHTML(state.currentLLM)}</span><span>${nowStr()}</span></div>
        <div class="msg-content streaming"></div>
      </div>`;
    messagesEl.appendChild(el);
    state.pendingAssistant = el.querySelector('.msg-content');
    scrollToBottom();
    return state.pendingAssistant;
  }

  function appendAssistantStream(fullText) {
    if (!state.pendingAssistant) addAssistantPlaceholder();
    const segs = foldTurns(fullText);
    state.pendingAssistant.innerHTML = renderSegments(segs) + '<span class="cursor-blink"></span>';
    attachTurnHandlers(state.pendingAssistant);
    scrollToBottomIfNearBottom();
  }

  function finalizeAssistant(fullText) {
    if (!state.pendingAssistant) addAssistantPlaceholder();
    const segs = foldTurns(fullText);
    state.pendingAssistant.innerHTML = renderSegments(segs);
    attachTurnHandlers(state.pendingAssistant);
    // T1.5.2: 记忆badge
    if (state.lastHasExperience) {
      const badge = document.createElement('span');
      badge.className = 'mem-badge';
      badge.textContent = '📎 记忆';
      badge.title = (state.lastExperienceIds || []).join(', ');
      state.pendingAssistant.parentElement.appendChild(badge);
      state.lastHasExperience = false;
      state.lastExperienceIds = [];
    }
    state.pendingAssistant.classList.remove('streaming');
    // T4.4.1: Micro-interaction animations
    try {
      const msgEl = state.pendingAssistant.closest('.msg') || state.pendingAssistant.parentElement;
      if (msgEl) {
        msgEl.classList.add('anim-msg-fade-in');
        msgEl.addEventListener('animationend', () => msgEl.classList.remove('anim-msg-fade-in'), { once: true });
      }
    } catch(_e2) {}
    state.pendingAssistant = null;
    scrollToBottom();
  }

  function foldTurns(text) {
    const re = /(\*{0,2}LLM Running \(Turn \d+\) \.\.\.\*{0,2})/g;
    const parts = (text || '').split(re);
    if (parts.length < 4) return [{ kind: 'text', content: text || '' }];
    const segments = [];
    if (parts[0].trim()) segments.push({ kind: 'text', content: parts[0] });
    const turns = [];
    for (let i = 1; i < parts.length; i += 2)
      turns.push({ marker: parts[i], content: parts[i + 1] || '' });
    turns.forEach((t, idx) => {
      if (idx < turns.length - 1) {
        const cleaned = t.content.replace(/```[\s\S]*?```/g, '').replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
        const m = cleaned.match(/<summary>\s*((?:(?!<summary>)[\s\S])*?)\s*<\/summary>/);
        let title;
        if (m) {
          title = m[1].trim().split('\n')[0];
        } else {
          // fallback: first non-empty line of visible text (skip headers/xml)
          const firstLine = cleaned.split('\n').map(l => l.trim())
            .find(l => l.length > 8 && !l.startsWith('<') && !l.startsWith('#') && !l.startsWith('```'));
          title = firstLine || t.marker.replace(/\*/g, '');
        }
        if (title.length > 60) title = title.slice(0, 60) + '...';
        segments.push({ kind: 'fold', title, content: t.content });
      } else {
        segments.push({ kind: 'text', content: t.marker + t.content });
      }
    });
    return segments;
  }

  function renderSegments(segs) {
    return segs.map((s, i) => {
      if (s.kind === 'fold') {
        return `<div class="turn-fold" data-idx="${i}">
          <div class="turn-header"><svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg><span class="turn-title">${escapeHTML(s.title)}</span></div>
          <div class="turn-body">${renderMarkdown(s.content)}</div>
        </div>`;
      }
      return `<div class="seg-text">${renderMarkdown(s.content)}</div>`;
    }).join('');
  }

  function attachTurnHandlers(root) {
    root.querySelectorAll('.turn-fold').forEach(el => {
      const header = el.querySelector('.turn-header');
      if (!header || header._bound) return;
      header._bound = true;
      header.addEventListener('click', () => el.classList.toggle('open'));
    });
  }

  function renderMarkdown(text) {
    if (!text) return '';
    const t = text
      .replace(/<thinking>([\s\S]*?)<\/thinking>/g, (_, c) => `\n\n<div class="thinking-block">💭 ${escapeHTML(c.trim())}</div>\n\n`)
      .replace(/<summary>([\s\S]*?)<\/summary>/g, (_, c) => `\n\n<div class="summary-block">${escapeHTML(c.trim())}</div>\n\n`);
    try { return typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(marked.parse(t)) : marked.parse(t); }
    catch { return escapeHTML(t).replace(/\n/g, '<br>'); }
  }

  /* ═════ Input ═════ */
  function autoResize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 220) + 'px';
  }
  inputEl.addEventListener('input', autoResize);

  // ── Slash-command popup menu ──
  let _slashMenu = null;
  let _slashCmds = null;
  let _slashIdx = -1;
  let _slashFiltered = [];

  function _ensureSlashMenu() {
    if (_slashMenu) return _slashMenu;
    _slashMenu = document.createElement('div');
    _slashMenu.id = 'slash-menu';
    _slashMenu.className = 'absolute bottom-full left-0 mb-1 w-80 max-h-64 overflow-y-auto bg-ink-800 border border-ink-600 rounded-lg shadow-xl z-50 hidden';
    _slashMenu.style.cssText = 'scrollbar-width:thin;scrollbar-color:#475569 transparent;';
    const inputBox = inputEl.closest('#input-box') || inputEl.parentElement;
    inputBox.style.position = 'relative';
    inputBox.appendChild(_slashMenu);
    return _slashMenu;
  }

  async function _loadSlashCmds() {
    if (_slashCmds) return _slashCmds;
    try { _slashCmds = await API.fetchSlashCommands(); }
    catch { _slashCmds = {}; }
    return _slashCmds;
  }

  function _showSlashMenu(filter = '') {
    const menu = _ensureSlashMenu();
    const lower = filter.toLowerCase();
    _slashFiltered = Object.entries(_slashCmds || {})
      .filter(([k]) => k.includes(lower))
      .sort((a, b) => a[0].localeCompare(b[0]));
    if (_slashFiltered.length === 0) { _hideSlashMenu(); return; }
    _slashIdx = -1;
    menu.innerHTML = _slashFiltered.map(([name, info], i) =>
      '<div class="slash-item flex items-center gap-2 px-3 py-2 cursor-pointer text-sm text-frost-200 hover:bg-ink-700 transition-colors" data-cmd="' + name + '" data-idx="' + i + '">' +
        '<span class="text-accent-amber font-mono font-semibold">/' + name + '</span>' +
        '<span class="text-frost-400 text-xs truncate">' + (info.brief || '') + '</span>' +
      '</div>'
    ).join('');
    menu.querySelectorAll('.slash-item').forEach(el => {
      el.addEventListener('mousedown', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        _selectSlashCmd(el.dataset.cmd);
      });
    });
    menu.classList.remove('hidden');
  }

  function _hideSlashMenu() {
    if (_slashMenu) _slashMenu.classList.add('hidden');
    _slashIdx = -1;
  }

  function _highlightSlashItem(idx) {
    if (!_slashMenu) return;
    const items = _slashMenu.querySelectorAll('.slash-item');
    items.forEach((el, i) => {
      el.classList.toggle('bg-ink-700', i === idx);
      el.classList.toggle('ring-1', i === idx);
      el.classList.toggle('ring-accent-amber/40', i === idx);
    });
    items[idx]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function _selectSlashCmd(cmdName) {
    _hideSlashMenu();
    const val = inputEl.value;
    const slashPos = val.lastIndexOf('/');
    if (slashPos >= 0) {
      inputEl.value = val.substring(0, slashPos) + '/' + cmdName + ' ';
      inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
    }
    inputEl.focus();
    autoResize();
  }

  // Detect "/" typing for slash menu
  inputEl.addEventListener('input', async () => {
    const val = inputEl.value;
    const cursorPos = inputEl.selectionStart;
    const textBeforeCursor = val.substring(0, cursorPos);
    const slashMatch = textBeforeCursor.match(/(?:^|\s)(\/(\S*))$/);
    if (slashMatch) {
      await _loadSlashCmds();
      _showSlashMenu(slashMatch[2]);
    } else {
      _hideSlashMenu();
    }
  });

  inputEl.addEventListener('keydown', (e) => {
    // Slash menu navigation
    if (_slashMenu && !_slashMenu.classList.contains('hidden')) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        _slashIdx = Math.min(_slashIdx + 1, _slashFiltered.length - 1);
        _highlightSlashItem(_slashIdx);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        _slashIdx = Math.max(_slashIdx - 1, 0);
        _highlightSlashItem(_slashIdx);
        return;
      }
      if (e.key === 'Enter' && _slashIdx >= 0) {
        e.preventDefault();
        _selectSlashCmd(_slashFiltered[_slashIdx][0]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        _hideSlashMenu();
        return;
      }
      if (e.key === 'Tab' && _slashIdx >= 0) {
        e.preventDefault();
        _selectSlashCmd(_slashFiltered[_slashIdx][0]);
        return;
      }
    }
    // Normal Enter -> send
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      sendTask();
    }
    if (e.key === 'Escape' && state.running) { e.preventDefault(); API.send('abort'); }
  });

  // Close menu on click outside
  document.addEventListener('click', (e) => {
    if (_slashMenu && !_slashMenu.contains(e.target) && e.target !== inputEl) {
      _hideSlashMenu();
    }
  });
  sendBtn.addEventListener('click', () => {
    if (state.running) { API.send('abort'); }
    else { sendTask(); }
  });

  // Quick suggestion cards — fill input, show hint, focus
  const _sendHintEl = document.createElement('div');
  _sendHintEl.className = 'send-hint';
  _sendHintEl.innerHTML = '按 <kbd class="kbd">Enter</kbd> 发送 · <kbd class="kbd">Esc</kbd> 取消';
  _sendHintEl.style.cssText = 'display:none;text-align:center;margin-top:6px;color:rgba(148,163,184,0.7);font-size:12px;animation:fadeIn 0.3s ease';
  const _suggestGrid = document.querySelector('.grid.grid-cols-2.gap-2\\.5');
  if (_suggestGrid) _suggestGrid.parentNode.insertBefore(_sendHintEl, _suggestGrid.nextSibling);

  document.querySelectorAll('.quick-suggest').forEach(btn => {
    btn.addEventListener('click', () => {
      const prompt = btn.dataset.prompt;
      if (prompt) {
        // Visual feedback — pulse the clicked card
        btn.style.transform = 'scale(0.96)';
        setTimeout(() => { btn.style.transform = ''; }, 150);
        inputEl.value = prompt;
        autoResize();
        inputEl.focus();
        _sendHintEl.style.display = 'block';
      }
    });
  });

  // Hide send hint on input change or task send
  inputEl.addEventListener('input', () => { _sendHintEl.style.display = 'none'; });
  const _origSendTask = sendTask;
  // Fade out suggestion cards when task starts
  function _fadeSuggestions() {
    if (_suggestGrid) {
      _suggestGrid.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
      _suggestGrid.style.opacity = '0';
      _suggestGrid.style.transform = 'translateY(-10px)';
      _sendHintEl.style.display = 'none';
    }
  }
  function _showSuggestions() {
    if (_suggestGrid) {
      _suggestGrid.style.opacity = '1';
      _suggestGrid.style.transform = 'translateY(0)';
    }
  }

  function sendTask() {
    if (state.viewingSessionPath) returnToActive();
    const text = inputEl.value.trim();
    const imgs = state.attachments.filter(a => a.kind === 'image');
    const files = state.attachments.filter(a => a.kind === 'file');
    if (!text && imgs.length === 0 && files.length === 0) return;
    if (state.running) { showToast('请先停止当前任务', 'error'); return; }
    addUserMessage(text, imgs, files.map(f => f.path || f.name));
    API.send('task', {
      text,
      images: imgs.map(i => ({ name: i.name, data_url: i.data_url })),
      files: files.map(f => f.path).filter(Boolean),
    });
    inputEl.value = ''; autoResize();
    state.attachments = []; renderAttachments();
    setRunning(true);
    addAssistantPlaceholder();
    _fadeSuggestions();
  }

  /* ═════ Attachments ═════ */
  const btnGenTodo = document.getElementById('btn-generate-todo');
  if (btnGenTodo) {
    btnGenTodo.addEventListener('click', () => {
      if (state.running) { showToast('请先停止当前任务', 'error'); return; }
      inputEl.value = '按照自主行动的规划部分，充分分析我的情况，给我生成一批TODO，务必让我感兴趣';
      sendTask();
    });
  }
  function renderAttachments() {
    attachmentsEl.innerHTML = state.attachments.map((a, i) => {
      if (a.kind === 'image') {
        return `<div class="attach-item image relative w-14 h-14 p-0.5 rounded-lg bg-ink-700 border border-ink-600">
          <img src="${escapeAttr(a.data_url)}" alt="${escapeHTML(a.name)}" class="w-full h-full object-cover rounded-md" />
          <span class="absolute -top-1.5 -right-1.5 w-4 h-4 bg-ink-600 border border-ink-500 rounded-full text-frost-100 text-xs flex items-center justify-center cursor-pointer hover:text-accent-rose hover:border-accent-rose" data-idx="${i}">×</span></div>`;
      }
      return `<div class="attach-item relative px-2.5 py-1 bg-ink-700 border border-ink-600 rounded-full text-[11.5px] text-frost-100 flex items-center gap-1.5 max-w-[220px]">
        <span class="font-mono text-[11px] truncate" title="${escapeAttr(a.path || a.name)}">📄 ${escapeHTML(a.name)}</span>
        <span class="remove absolute -top-1.5 -right-1.5 w-4 h-4 bg-ink-600 border border-ink-500 rounded-full text-frost-100 text-xs flex items-center justify-center cursor-pointer hover:text-accent-rose hover:border-accent-rose" data-idx="${i}">×</span></div>`;
    }).join('');
    attachmentsEl.querySelectorAll('[data-idx]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        state.attachments.splice(parseInt(el.dataset.idx, 10), 1);
        renderAttachments();
      });
    });
  }

  $('btn-attach-file').addEventListener('click', () => fileInput.click());
  $('btn-attach-image').addEventListener('click', () => imageInput.click());

  fileInput.addEventListener('change', async () => {
    for (const f of fileInput.files) await addFileAttachment(f);
    fileInput.value = '';
  });
  imageInput.addEventListener('change', async () => {
    for (const f of imageInput.files) await addImageAttachment(f);
    imageInput.value = '';
  });

  async function addImageAttachment(file) {
    if (!file.type.startsWith('image/')) return;
    if (file.size > MAX_IMAGE_SIZE) { showToast(`图片过大（上限 ${(MAX_IMAGE_SIZE/1024/1024).toFixed(0)}MB）`, 'error'); return; }
    const data_url = await readAsDataURL(file);
    state.attachments.push({ kind: 'image', name: file.name || 'pasted.png', data_url });
    renderAttachments();
  }
  async function addFileAttachment(file) {
    if (file.size > MAX_FILE_SIZE) { showToast(`文件过大（上限 ${(MAX_FILE_SIZE/1024/1024).toFixed(0)}MB）`, 'error'); return; }
    try {
      const j = await API.uploadFile(file);
      if (j.path) {
        state.attachments.push({ kind: 'file', name: file.name, path: j.path });
        renderAttachments();
      } else showToast('上传失败', 'error');
    } catch (e) { showToast('上传失败: ' + e.message, 'error'); }
  }
  function readAsDataURL(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result); r.onerror = rej;
      r.readAsDataURL(file);
    });
  }

  /* ═════ Paste / Drag ═════ */
  document.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) { await addImageAttachment(file); e.preventDefault(); }
      }
    }
  });
  let dragCounter = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    dragCounter++;
    dragOverlay.classList.add('active');
  });
  window.addEventListener('dragleave', () => {
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) dragOverlay.classList.remove('active');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0; dragOverlay.classList.remove('active');
    const files = e.dataTransfer?.files || [];
    for (const f of files) {
      if (f.type.startsWith('image/')) await addImageAttachment(f);
      else await addFileAttachment(f);
    }
  });

  /* ═════ Image lightbox ═════ */
  document.addEventListener('click', (e) => {
    const img = e.target.closest('.msg-user .attached-imgs img');
    if (img) openImageLightbox(img.src);
  });
  function openImageLightbox(src) {
    const lb = document.createElement('div');
    lb.className = 'fixed inset-0 z-[1000] bg-ink-950/85 flex items-center justify-center p-10 cursor-zoom-out animate-fade-in';
    lb.innerHTML = `<img src="${escapeAttr(src)}" class="max-w-full max-h-full rounded-lg shadow-pop" />`;
    lb.addEventListener('click', () => lb.remove());
    document.body.appendChild(lb);
  }

  /* ═════ Skills Page ═════ */
  async function loadSkills() {
    try {
      const data = await API.listSkills();
      state.skills = data;
      renderSkills();
    } catch (e) {
      showToast('加载能力失败: ' + e.message, 'error');
    }
  }

  function renderSkills(filter = '') {
    if (!state.skills) return;
    const { tools = [], sops = [] } = state.skills;
    const f = filter.trim().toLowerCase();
    const matches = (s) => !f || (s.title || '').toLowerCase().includes(f) ||
      (s.name || '').toLowerCase().includes(f) || (s.brief || '').toLowerCase().includes(f);

    const fTools = tools.filter(matches);
    const fSops = sops.filter(matches);

    const toolsCountEl = $('tools-count');
    if (toolsCountEl) toolsCountEl.textContent = `${fTools.length}`;
    const sopsCountEl = $('sops-count');
    if (sopsCountEl) sopsCountEl.textContent = `${fSops.length}`;
    const toolsGrid = $('tools-grid');
    if (toolsGrid) toolsGrid.innerHTML = fTools.map(skillCardHTML).join('') ||
      `<div class="col-span-full text-frost-400 text-sm text-center py-4">无匹配工具</div>`;
    const localGrid = $('sops-grid');
    if (localGrid) {
      localGrid.innerHTML = fSops.map(skillCardHTML).join('') ||
        `<div class="col-span-full text-frost-400 text-sm text-center py-4">无匹配SOP</div>`;
    }
    // Update SOP count badge
    const countBadge = $('sop-tab-count');
    if (countBadge) countBadge.textContent = `${fSops.length}`;

    // Category sidebar
    const cats = [
      { key: 'all', label: '全部', count: tools.length + sops.length },
      { key: 'tool', label: '工具', count: tools.length },
      { key: 'sop', label: 'SOP', count: sops.length },
    ];
    const catsEl = $('skills-categories');
    if (catsEl) catsEl.innerHTML = cats.map(c =>
      `<div class="skill-cat" data-cat="${c.key}"><span>${c.label}</span><span class="count">${c.count}</span></div>`
    ).join('');
    const statsEl = $('skills-stats');
    if (statsEl) statsEl.innerHTML = `
      <div>工具数量：<span class="text-frost-50 font-mono">${tools.length}</span></div>
      <div>SOP 数量：<span class="text-frost-50 font-mono">${sops.length}</span></div>
      <div class="text-frost-400 text-[10.5px] pt-1">点击卡片查看详情</div>`;

    document.querySelectorAll('[data-skill-id]').forEach(el => {
      el.addEventListener('click', () => openSkillDetail(el.dataset.skillId, el.dataset.skillCategory));
    });
    lucide.createIcons();
  }

  function skillCardHTML(s) {
    const tagCls = s.category === 'tool' ? 'tool' : 'sop';
    const tagText = s.category === 'tool' ? 'TOOL' : 'SOP';
    return `<div class="skill-card" data-skill-id="${escapeAttr(s.id)}" data-skill-category="${s.category}">
      <div class="skill-card-header">
        <div class="skill-card-icon">${escapeHTML(s.icon || '📦')}</div>
        <div class="min-w-0 flex-1">
          <div class="skill-card-title">${escapeHTML(s.title || s.name)}</div>
          <div class="skill-card-name">${escapeHTML(s.name)}</div>
        </div>
      </div>
      <div class="skill-card-brief">${escapeHTML(s.brief || '(无描述)')}</div>
      ${s.use_count > 0 ? `<div class="skill-card-usage"><span class="usage-label">使用 ${s.use_count} 次</span><div class="usage-bar"><div class="usage-bar-fill" style="width:${Math.min(100, s.use_count * 10)}%"></div></div></div>` : ''}
      ${s.auto_distilled ? '<div class="skill-card-auto-badge" title="任务复盘中自动沉淀">✨ 自动沉淀</div>' : ''}
      <div class="skill-card-footer">
        <span class="skill-card-tag ${tagCls}">${tagText}</span>
        <div class="flex items-center gap-2">
          ${s.category === 'sop' ? `<button class="upload-to-sophub-btn flex items-center gap-1 px-2 py-0.5 rounded-lg bg-accent-violet/10 hover:bg-accent-violet/25 text-accent-violet text-[11px] transition" data-sop-name="${escapeAttr(s.name)}" data-sop-title="${escapeAttr(s.title || s.name)}" title="上传到社区"><i data-lucide="upload-cloud" class="w-3 h-3"></i>上传</button>` : ''}
          <span class="cta flex items-center gap-1">查看详情 <span>→</span></span>
        </div>
      </div>
    </div>`;
  }

  async function openSkillDetail(id, category) {
    if (category === 'tool') {
      const tool = state.skills.tools.find(t => t.id === id);
      if (!tool) return;
      modalIcon.textContent = tool.icon || '🛠️';
      modalTitle.textContent = tool.title || tool.name;
      modalSubtitle.textContent = `工具 · ${tool.name}`;
      const schemaJSON = JSON.stringify(tool.schema || {}, null, 2);
      modalBody.innerHTML = `<div class="msg-content">
        <h3>描述</h3><p>${escapeHTML(tool.brief || '(无)')}</p>
        <h3>参数 Schema</h3>
        <pre><code class="language-json">${escapeHTML(schemaJSON)}</code></pre>
      </div>`;
      modalBody.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
      modalOverlay.dataset.skillUse = JSON.stringify({ category, name: tool.name });
    } else {
      try {
        const sopItem = state.skills.sops.find(s => s.id === id);
        const r = await API.getSop(id);
        modalIcon.textContent = sopItem?.icon || '📘';
        modalTitle.textContent = sopItem?.title || id;
        modalSubtitle.textContent = `SOP · ${id}`;
        modalBody.innerHTML = `<div class="msg-content">${renderMarkdown(r.content || '')}</div>`;
        modalBody.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
        modalOverlay.dataset.skillUse = JSON.stringify({ category, name: id });
      } catch (e) {
        showToast('加载失败: ' + e.message, 'error');
        return;
      }
    }
    modalOverlay.classList.add('open');
    lucide.createIcons();
  }

  function openModal() { modalOverlay.classList.add('open'); lucide.createIcons(); }
  function closeModal() { modalOverlay.classList.remove('open'); }
  $('modal-close').addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalOverlay.classList.contains('open')) closeModal();
  });
  $('modal-use').addEventListener('click', () => {
    const raw = modalOverlay.dataset.skillUse;
    if (!raw) return;
    const { category, name } = JSON.parse(raw);
    let prompt = '';
    if (category === 'tool') prompt = `请使用工具 ${name} 完成以下任务：`;
    else prompt = `请按照 SOP 《${name}》 执行：`;
    closeModal();
    switchTab('chat');
    inputEl.value = prompt;
    autoResize();
    inputEl.focus();
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  });

  $('skill-search').addEventListener('input', (e) => renderSkills(e.target.value));

  /* ═════ SOP tabs: Local + Community ═════ */
  const sophubState = { page: 1, totalPages: 1, lastQ: '', localSopNames: [] };

  async function loadLocalSopNames() {
    try {
      const data = await API.listSkills();
      const list = Array.isArray(data) ? data : (data.sops || []);
      // Store both name and title for fuzzy matching
      sophubState.localSopNames = list.map(s => ({
        name: (s.name || '').toLowerCase().replace(/\.md$|\.py$/, ''),
        title: (s.title || '').toLowerCase()
      })).filter(s => s.name || s.title);
    } catch (e) { /* ignore */ }
  }

  function switchSopTab(tab) {
    const localBtn = $('sop-tab-local');
    const commBtn = $('sop-tab-community');
    const localPanel = $('sop-local-panel');
    const commPanel = $('sop-community-panel');
    if (tab === 'local') {
      localBtn.classList.add('active');
      commBtn.classList.remove('active');
      localPanel.classList.remove('hidden');
      commPanel.classList.add('hidden');
    } else {
      localBtn.classList.remove('active');
      commBtn.classList.add('active');
      localPanel.classList.add('hidden');
      commPanel.classList.remove('hidden');
      // Auto-search community on first tab open
      if (!sophubState.lastQ) sophubSearch('', 1);
    }
  }

  // ── Community SOP card renderer (reused) ──────────────────────────
  function renderSophubCard(item) {
    const sopId = item.sop_id || item.id || '';
    const stars = item.stars || 0;
    const downloads = item.downloads || 0;
    const author = item.agent_name || item.author || '匿名';
    const isLocal = sophubState.localSopNames && sophubState.localSopNames.length > 0 && sophubState.localSopNames.some(n => {
      const t = (item.title || '').toLowerCase();
      return t.includes(n.title) || n.title.includes(t) ||
        t.replace(/[_\s-]/g, '').includes(n.name.replace(/[_\s-]/g, '')) ||
        n.name.replace(/[_\s-]/g, '').includes(t.replace(/[_\s-]/g, ''));
    });
    const localBadge = isLocal ? '<span class="px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 text-[10px] ml-1">本地已有</span>' : '';
    const dlBtn = isLocal
      ? '<button disabled class="px-2 py-1 rounded-md bg-ink-700 text-frost-500 text-xs cursor-not-allowed"><i data-lucide="check" class="w-3 h-3 inline"></i> 已有</button>'
      : `<button class="px-2 py-1 rounded-md bg-accent-violet/20 hover:bg-accent-violet/40 text-accent-violet text-xs transition" onclick="event.stopPropagation(); downloadSophub('${sopId}', '${escapeAttr(item.title || '')}')"><i data-lucide="download" class="w-3 h-3 inline"></i> 下载</button>`;
    return `<div class="p-4 rounded-xl bg-ink-800/60 border border-white/8 hover:border-accent-violet/40 cursor-pointer transition group" onclick="openSophubDetail('${sopId}')">
      <div class="flex items-start justify-between mb-2">
        <span class="text-xl">${item.file_type === 'python' ? '🐍' : '📘'}</span>
        <span class="text-xs text-frost-400 flex items-center gap-1"><i data-lucide="star" class="w-3 h-3 text-accent-amber"></i>${stars} <i data-lucide="download" class="w-3 h-3 ml-1"></i>${downloads}</span>
      </div>
      <h4 class="text-frost-50 font-medium text-sm mb-1 truncate">${escapeHTML(item.title || item.name)}${localBadge}</h4>
      <p class="text-frost-400 text-xs mb-2 line-clamp-2">${escapeHTML(item.brief || item.description || '(无描述)')}</p>
      <div class="flex items-center justify-between">
        <span class="text-xs text-frost-500">by ${escapeHTML(author)}</span>
        ${dlBtn}
      </div>
    </div>`;
  }

  function renderSophubResults(data) {
    const el = $('sophub-results');
    if (!data || !data.items || data.items.length === 0) {
      el.innerHTML = '<div class="col-span-full text-frost-400 text-sm text-center py-8">没有找到匹配的 SOP</div>';
      return;
    }
    el.innerHTML = data.items.map(renderSophubCard).join('');
    lucide.createIcons();
    sophubState.totalPages = data.total_pages || 1;
    renderSophubPagination(data.current_page || 1);
  }

  function renderSophubPagination(current) {
    const pg = $('sophub-pagination');
    const total = sophubState.totalPages;
    if (total <= 1) { pg.innerHTML = ''; return; }
    const btns = [];
    if (current > 1) btns.push(`<button onclick="sophubGo(${current - 1})" class="px-3 py-1.5 rounded-lg bg-ink-700 hover:bg-ink-600 text-frost-100 text-sm transition">‹ 上一页</button>`);
    btns.push(`<span class="px-3 py-1.5 text-frost-400 text-sm">第 ${current} / ${total} 页</span>`);
    if (current < total) btns.push(`<button onclick="sophubGo(${current + 1})" class="px-3 py-1.5 rounded-lg bg-ink-700 hover:bg-ink-600 text-frost-100 text-sm transition">下一页 ›</button>`);
    pg.innerHTML = btns.join('');
  }

  async function sophubSearch(q, page = 1) {
    const tip = $('sophub-tip');
    try {
      if (tip) tip.textContent = '正在搜索...';
      await loadLocalSopNames();
      const data = await API.sophubSearch(q, page, 24);
      if (tip) tip.textContent = `共 ${data.total || 0} 个结果`;
      renderSophubResults(data);
    } catch (e) {
      if (tip) tip.textContent = '⚠️ ' + (e.message || '搜索失败，请检查 API Key 配置');
      $('sophub-results').innerHTML = '';
    }
  }

  function sophubGo(page) { sophubSearch(sophubState.lastQ, page); }

  async function openSophubDetail(id) {
    try {
      const data = await API.sophubSop(id);
      modalIcon.textContent = data.icon || '📘';
      modalTitle.textContent = data.title || id;
      modalSubtitle.textContent = `社区 SOP · by ${data.agent_name || '匿名'}`;
      const schema = data.parameters ? `<h3>参数 Schema</h3><pre><code>${escapeHTML(JSON.stringify(data.parameters, null, 2))}</code></pre>` : '';
      const tags = (data.tags || []).length ? `<div class="flex flex-wrap gap-1 mb-4">${data.tags.map(t => `<span class="px-2 py-0.5 rounded-full bg-accent-violet/15 text-accent-violet text-xs">${escapeHTML(t)}</span>`).join('')}</div>` : '';
      modalBody.innerHTML = `
        ${tags}
        <h3>描述</h3><p>${escapeHTML(data.brief || data.description || '(无)')}</p>
        ${schema}
        <h3>内容</h3><pre><code class="language-markdown">${escapeHTML(data.content || '')}</code></pre>`;
      modalBody.querySelectorAll('pre code').forEach(b => { if (window.hljs) hljs.highlightElement(b); });
      modalOverlay.dataset.skillUse = JSON.stringify({ category: 'sophub', name: data.title });
      openModal();
    } catch (e) {
      showToast('加载 SOP 详情失败: ' + e.message);
    }
  }

  async function downloadSophub(id, name) {
    try {
      showToast('正在下载...');
      const blob = await API.sophubDownload(id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name + '.md';
      a.click();
      URL.revokeObjectURL(url);
      showToast('下载完成', 'success');
    } catch (e) {
      showToast('下载失败: ' + e.message);
    }
  }

  // ── Upload local SOP to community ──────────────────────────────
  async function uploadLocalSop(sopName, sopTitle) {
    try {
      const data = await API.listSkills();
      const sop = data.sops.find(s => s.name === sopName);
      if (!sop) { showToast('未找到本地 SOP: ' + sopName); return; }
      const html = `<div class="space-y-4">
        <div>
          <label class="block text-frost-200 text-sm mb-1.5">SOP 标题</label>
          <input id="su-title" type="text" value="${escapeAttr(sopTitle)}" class="w-full px-4 py-2.5 bg-ink-900 border border-white/10 rounded-xl text-sm text-frost-50 outline-none focus:border-accent-violet transition" />
        </div>
        <div>
          <label class="block text-frost-200 text-sm mb-1.5">类型</label>
          <select id="su-type" class="w-full px-4 py-2.5 bg-ink-900 border border-white/10 rounded-xl text-sm text-frost-50 outline-none focus:border-accent-violet transition">
            <option value="markdown">Markdown (.md)</option>
            <option value="python">Python (.py)</option>
          </select>
        </div>
        <div>
          <label class="block text-frost-200 text-sm mb-1.5">SOP 内容</label>
          <textarea id="su-content" rows="14" placeholder="粘贴 SOP 内容..." class="w-full px-4 py-2.5 bg-ink-900 border border-white/10 rounded-xl text-sm text-frost-50 outline-none focus:border-accent-violet transition font-mono resize-y"></textarea>
        </div>
        <button id="su-submit" class="w-full py-2.5 rounded-xl bg-accent-violet hover:bg-accent-violet/80 text-white text-sm font-medium transition"><i data-lucide="upload-cloud" class="w-4 h-4 inline mr-1"></i>上传到社区</button>
      </div>`;
      modalIcon.textContent = '📤';
      modalTitle.textContent = '上传 SOP 到社区';
      modalSubtitle.textContent = '上传后其他人可以搜索和使用';
      modalBody.innerHTML = html;
      modalBody.querySelectorAll('#su-submit').forEach(b => {
        b.addEventListener('click', async () => {
          const title = $('su-title').value.trim();
          const content = $('su-content').value.trim();
          const ft = $('su-type').value;
          if (!title || !content) { showToast('请填写标题和内容'); return; }
          b.disabled = true; b.textContent = '上传中...';
          try {
            const r = await API.sophubUpload(title, content, ft);
            showToast('上传成功！SOP ID: ' + r.sop_id, 'success');
            closeModal();
          } catch (e) { showToast('上传失败: ' + e.message); b.disabled = false; b.innerHTML = '<i data-lucide="upload-cloud" class="w-4 h-4 inline mr-1"></i>上传到社区'; lucide.createIcons(); }
        });
      });
      openModal();
    } catch (e) {
      showToast('读取本地 SOP 失败: ' + e.message);
    }
  }

  // ── Community SOP upload modal (blank) ───────────────────────────
  async function openSophubUpload() {
    const html = `<div class="space-y-4">
      <div>
        <label class="block text-frost-200 text-sm mb-1.5">SOP 标题</label>
        <input id="su-title" type="text" placeholder="给 SOP 起个名字..." class="w-full px-4 py-2.5 bg-ink-900 border border-white/10 rounded-xl text-sm text-frost-50 outline-none focus:border-accent-violet transition" />
      </div>
      <div>
        <label class="block text-frost-200 text-sm mb-1.5">类型</label>
        <select id="su-type" class="w-full px-4 py-2.5 bg-ink-900 border border-white/10 rounded-xl text-sm text-frost-50 outline-none focus:border-accent-violet transition">
          <option value="markdown">Markdown (.md)</option>
          <option value="python">Python (.py)</option>
        </select>
      </div>
      <div>
        <label class="block text-frost-200 text-sm mb-1.5">SOP 内容</label>
        <textarea id="su-content" rows="14" placeholder="粘贴 SOP 内容..." class="w-full px-4 py-2.5 bg-ink-900 border border-white/10 rounded-xl text-sm text-frost-50 outline-none focus:border-accent-violet transition font-mono resize-y"></textarea>
      </div>
      <button id="su-submit" class="w-full py-2.5 rounded-xl bg-accent-violet hover:bg-accent-violet/80 text-white text-sm font-medium transition"><i data-lucide="upload-cloud" class="w-4 h-4 inline mr-1"></i>上传到社区</button>
    </div>`;
    modalIcon.textContent = '📤';
    modalTitle.textContent = '上传 SOP 到社区';
    modalSubtitle.textContent = '上传后其他人可以搜索和使用';
    modalBody.innerHTML = html;
    modalBody.querySelectorAll('#su-submit').forEach(b => {
      b.addEventListener('click', async () => {
        const title = $('su-title').value.trim();
        const content = $('su-content').value.trim();
        const ft = $('su-type').value;
        if (!title || !content) { showToast('请填写标题和内容'); return; }
        b.disabled = true; b.textContent = '上传中...';
        try {
          const r = await API.sophubUpload(title, content, ft);
          showToast('上传成功！SOP ID: ' + r.sop_id, 'success');
          closeModal();
        } catch (e) { showToast('上传失败: ' + e.message); b.disabled = false; b.innerHTML = '<i data-lucide="upload-cloud" class="w-4 h-4 inline mr-1"></i>上传到社区'; lucide.createIcons(); }
      });
    });
    openModal();
  }

  // ── Event listeners ─────────────────────────────────────────────
  $('sop-tab-local')?.addEventListener('click', () => switchSopTab('local'));
  $('sop-tab-community')?.addEventListener('click', () => switchSopTab('community'));
  $('sophub-search-btn')?.addEventListener('click', () => {
    sophubState.lastQ = $('sophub-search-input')?.value.trim() || '';
    sophubState.page = 1;
    sophubSearch(sophubState.lastQ, 1);
  });
  $('sophub-search-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') $('sophub-search-btn')?.click(); });
  $('btn-upload-sop')?.addEventListener('click', openSophubUpload);

  // Delegate: upload local SOP to community (dynamic button in skill cards)
  document.addEventListener('click', e => {
    const btn = e.target.closest('.upload-to-sophub-btn');
    if (btn) { e.stopPropagation(); uploadLocalSop(btn.dataset.sopName, btn.dataset.sopTitle); }
  });

  /* ═════ Helpers ═════ */
  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function escapeAttr(s) { return escapeHTML(s).replace(/`/g, '&#96;'); }
  function nowStr() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function shortPath(p) {
    if (!p) return '';
    const parts = p.replace(/\\/g, '/').split('/');
    return parts.length <= 2 ? p : '.../' + parts.slice(-2).join('/');
  }
  function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
  function scrollToBottomIfNearBottom() {
    const gap = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    if (gap < 120) scrollToBottom();
  }
  function showToast(text, kind = 'info') {
    const t = document.createElement('div');
    const cls = kind === 'error' ? ' error toast-error' : kind === 'success' ? ' success toast-success' : ' toast-info';
    t.className = 'info-toast' + cls;
    // Structure: icon (::before) + text + progress bar (::after)
    t.textContent = text;
    // T4.4.1: error toast shake animation
    if (kind === 'error') {
      t.classList.add('anim-shake-error');
    } else if (kind === 'success') {
      t.classList.add('anim-bounce-check');
    }
    document.body.appendChild(t);
    setTimeout(() => {
      t.classList.add('removing');
      setTimeout(() => t.remove(), 260);
    }, 4000);
  }

  /* ═════ Theme toggle (light/dark) ═════ */
  function applyTheme(theme) {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    const isLight = theme === 'light';
    // Sync .theme-light class on body so both selector patterns work
    document.body.classList.toggle('theme-light', isLight);
    // Switch highlight.js theme CSS to match (light=github浅色, dark=github-dark-dimmed)
    const hljsLink = document.getElementById('hljs-theme');
    if (hljsLink) {
      hljsLink.href = isLight
        ? '/static/vendor/github.min.css'
        : '/static/vendor/github-dark-dimmed.min.css';
    }
    document.querySelectorAll('.theme-icon-dark')
      .forEach(el => el.classList.toggle('hidden', isLight));
    document.querySelectorAll('.theme-icon-light')
      .forEach(el => el.classList.toggle('hidden', !isLight));
    const tog = $('theme-toggle');
    if (tog) tog.checked = isLight;
  }
  const savedTheme = _storage.get('ga-theme', 'dark');
  applyTheme(savedTheme);
  // Bind theme-toggle (checkbox in settings panel, if exists)
  const themeToggle = $('theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('change', (e) => {
      const next = e.target.checked ? 'light' : 'dark';
      _storage.set('ga-theme', next);
      applyTheme(next);
    });
  }
  // Bind theme-toggle-rail (icon button in icon rail)
  const themeToggleRail = $('theme-toggle-rail');
  if (themeToggleRail) {
    themeToggleRail.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      _storage.set('ga-theme', next);
      applyTheme(next);
    });
  }

  /* ── 🅰️-4: Button Ripple Effect (delegated) ── */
  document.addEventListener('click', e => {
    const btn = e.target.closest('#btn-send, #btn-new-chat, .mode-btn, .skill-cat');
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    btn.style.setProperty('--ripple-x', x + 'px');
    btn.style.setProperty('--ripple-y', y + 'px');
    btn.classList.remove('ripple');
    // Force reflow to restart animation
    void btn.offsetWidth;
    btn.classList.add('ripple');
    setTimeout(() => btn.classList.remove('ripple'), 500);
  });

  /* ═════ Settings / Config ═════ */
  const _cfgState = { sessions: [], mixin: null, editIdx: -1 };

  async function loadConfig() {
    try {
      const d = await API.getLLMConfig();
      _cfgState.sessions = d.sessions || [];
      _cfgState.mixin    = d.mixin   || null;
      renderSettingsSessions();
      renderMixinFields();
      $('settings-readonly-warn').classList.toggle('hidden', !d.readonly);
    } catch(e) { showToast('加载配置失败: ' + e.message, 'error'); }
  }

  const _TYPE_BADGE = {
    native_claude: { label: 'NativeClaude', cls: 'bg-accent-violet/20 text-accent-violet' },
    native_oai:    { label: 'NativeOAI',    cls: 'bg-brand-400/20 text-brand-400' },
    claude:        { label: 'Claude (旧)',   cls: 'bg-white/10 text-frost-300' },
    oai:           { label: 'OAI (旧)',      cls: 'bg-white/10 text-frost-300' },
  };

  function renderSettingsSessions() {
    const el = $('settings-sessions');
    if (!_cfgState.sessions.length) {
      el.innerHTML = `<div class="text-frost-400 text-[13px] text-center py-6">暂无配置，点击“添加”创建</div>`;
      return;
    }
    el.innerHTML = _cfgState.sessions.map((s, i) => {
      const b = _TYPE_BADGE[s._type] || { label: s._type, cls: 'bg-white/10 text-frost-300' };
      const name  = escapeHTML(s.name  || s.model || '—');
      const model = escapeHTML(s.model || '—');
      const base  = escapeHTML((s.apibase || '').replace(/https?:\/\//, ''));
      const keyPrev = s.apikey ? s.apikey.slice(0,8) + '···' : '(未设置)';
      return `<div class="settings-card flex items-center gap-4">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1">
            <span class="text-[11px] font-mono px-2 py-0.5 rounded-full ${b.cls}">${b.label}</span>
            <span class="font-medium text-frost-100 truncate">${name}</span>
          </div>
          <div class="text-[12px] text-frost-400 font-mono truncate">${model}</div>
          <div class="text-[11.5px] text-frost-500 truncate mt-0.5">${base} &nbsp;·&nbsp; ${escapeHTML(keyPrev)}</div>
        </div>
        <div class="flex gap-1.5 shrink-0">
          <button class="cfg-act-btn" data-act="edit" data-idx="${i}" title="编辑">
            <i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
          <button class="cfg-act-btn cfg-act-danger" data-act="del" data-idx="${i}" title="删除">
            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
        </div>
      </div>`;
    }).join('');
    lucide.createIcons();
    el.querySelectorAll('[data-act]').forEach(btn => {
      const idx = parseInt(btn.dataset.idx, 10);
      if (btn.dataset.act === 'edit') btn.addEventListener('click', () => openSessionEditor(idx));
      if (btn.dataset.act === 'del')  btn.addEventListener('click', () => {
        if (!confirm(`确认删除这个 LLM 配置？`)) return;
        _cfgState.sessions.splice(idx, 1);
        renderSettingsSessions();
      });
    });
  }

  // Mixin fields
  const mixinEnableEl = $('mixin-enable');
  const mixinFieldsEl = $('mixin-fields');
  mixinEnableEl.addEventListener('change', () =>
    mixinFieldsEl.classList.toggle('hidden', !mixinEnableEl.checked));

  function renderMixinFields() {
    const m = _cfgState.mixin;
    const enabled = !!(m && m.llm_nos && m.llm_nos.length);
    mixinEnableEl.checked = enabled;
    mixinFieldsEl.classList.toggle('hidden', !enabled);
    if (m) {
      $('mixin-llm-nos').value     = (m.llm_nos || []).join(', ');
      $('mixin-max-retries').value = m.max_retries ?? 10;
      $('mixin-base-delay').value  = m.base_delay  ?? 0.5;
    }
  }

  // Session editor modal
  const editorOverlay = $('session-editor-overlay');
  function openSessionEditor(idx) {
    _cfgState.editIdx = idx;
    const isNew = idx === -1;
    $('session-editor-title').textContent = isNew ? '添加 LLM 配置' : '编辑 LLM 配置';
    const s = isNew ? {} : _cfgState.sessions[idx];
    // Populate type
    const t = s._type || 'native_claude';
    document.querySelector(`input[name="cfg-type"][value="${t}"]`).checked = true;
    updateEditorTypeVisibility(t);
    // Basic
    $('cfg-apikey').value  = s.apikey  || '';
    $('cfg-apibase').value = s.apibase || '';
    $('cfg-model').value   = s.model   || '';
    $('cfg-name').value    = s.name    || '';
    // Advanced
    $('cfg-proxy').value            = s.proxy            || '';
    $('cfg-context-win').value      = s.context_win      || '';
    $('cfg-max-retries').value      = s.max_retries      || '';
    $('cfg-connect-timeout').value  = s.connect_timeout  || '';
    $('cfg-read-timeout').value     = s.read_timeout     || '';
    $('cfg-temperature').value      = s.temperature      || '';
    $('cfg-max-tokens').value       = s.max_tokens       || '';
    $('cfg-reasoning-effort').value = s.reasoning_effort || '';
    $('cfg-thinking-type').value    = s.thinking_type    || '';
    $('cfg-thinking-budget').value  = s.thinking_budget_tokens || '';
    $('cfg-user-agent').value       = s.user_agent       || '';
    $('cfg-fake-cc').checked        = !!s.fake_cc_system_prompt;
    $('cfg-api-mode').value         = s.api_mode         || '';
    // Reset advanced section + model fetch state
    $('cfg-advanced-fields').classList.add('hidden');
    $('cfg-adv-caret').style.transform = '';
    $('cfg-model-list').innerHTML = '';
    $('cfg-fetch-hint').className = 'hidden text-[11px] mt-1';
    $('cfg-fetch-label').textContent = '获取模型列表';
    // Show modal
    editorOverlay.classList.remove('hidden');
    editorOverlay.classList.add('flex');
    lucide.createIcons();
  }
  function closeSessionEditor() {
    editorOverlay.classList.add('hidden');
    editorOverlay.classList.remove('flex');
  }
  function updateEditorTypeVisibility(t) {
    const isClaude = t === 'native_claude' || t === 'claude';
    const isOai    = t === 'native_oai'    || t === 'oai';
    document.querySelectorAll('.cfg-claude-only').forEach(el =>
      el.classList.toggle('hidden', !isClaude));
    document.querySelectorAll('.cfg-oai-only').forEach(el =>
      el.classList.toggle('hidden', !isOai));
  }
  document.querySelectorAll('input[name="cfg-type"]').forEach(r =>
    r.addEventListener('change', () => updateEditorTypeVisibility(r.value)));
  $('cfg-advanced-toggle').addEventListener('click', () => {
    const f = $('cfg-advanced-fields');
    const open = f.classList.toggle('hidden');
    $('cfg-adv-caret').style.transform = open ? '' : 'rotate(90deg)';
  });
  // Fetch models list
  $('cfg-fetch-models').addEventListener('click', async () => {
    const apikey  = $('cfg-apikey').value.trim();
    const apibase = $('cfg-apibase').value.trim();
    const proxy   = $('cfg-proxy') ? $('cfg-proxy').value.trim() : '';
    if (!apikey || !apibase) { showToast('请先填写 API Key 和 API Base', 'error'); return; }
    const btn   = $('cfg-fetch-models');
    const icon  = $('cfg-fetch-icon');
    const label = $('cfg-fetch-label');
    const hint  = $('cfg-fetch-hint');
    btn.disabled = true;
    icon.style.animation = 'spin 1s linear infinite';
    label.textContent = '获取中…';
    hint.className = 'hidden text-[11px] mt-1';
    try {
      const r = await API.listModels(apikey, apibase, proxy);
      const dl = $('cfg-model-list');
      dl.innerHTML = r.models.map(m => `<option value="${escapeHTML(m)}">`).join('');
      hint.textContent = `✓ 获取到 ${r.count} 个模型（点击输入框可选择）`;
      hint.className = 'text-[11px] mt-1 text-green-400';
    } catch(e) {
      hint.textContent = '✗ ' + (e.message || '获取失败');
      hint.className = 'text-[11px] mt-1 text-rose-400';
    } finally {
      btn.disabled = false;
      icon.style.animation = '';
      label.textContent = '获取模型列表';
    }
  });

  $('session-editor-close').addEventListener('click',  closeSessionEditor);
  $('session-editor-cancel').addEventListener('click', closeSessionEditor);
  editorOverlay.addEventListener('click', (e) => { if (e.target === editorOverlay) closeSessionEditor(); });
  $('session-editor-save').addEventListener('click', () => {
    const t       = document.querySelector('input[name="cfg-type"]:checked').value;
    const apikey  = $('cfg-apikey').value.trim();
    const apibase = $('cfg-apibase').value.trim();
    const model   = $('cfg-model').value.trim();
    if (!apikey || !apibase || !model) { showToast('API Key / Base / Model 不能为空', 'error'); return; }
    function num(id) { const v = $(id).value; return v ? parseFloat(v) : undefined; }
    function str(id) { const v = $(id).value.trim(); return v || undefined; }
    const s = {
      _key:  (_cfgState.editIdx >= 0 ? _cfgState.sessions[_cfgState.editIdx]._key : '') || '',
      _type: t, apikey, apibase, model,
      name:              str('cfg-name'),
      proxy:             str('cfg-proxy'),
      context_win:       num('cfg-context-win'),
      max_retries:       num('cfg-max-retries'),
      connect_timeout:   num('cfg-connect-timeout'),
      read_timeout:      num('cfg-read-timeout'),
      temperature:       num('cfg-temperature'),
      max_tokens:        num('cfg-max-tokens'),
      reasoning_effort:  str('cfg-reasoning-effort'),
      thinking_type:     str('cfg-thinking-type'),
      thinking_budget_tokens: num('cfg-thinking-budget'),
      user_agent:        str('cfg-user-agent'),
      fake_cc_system_prompt: $('cfg-fake-cc').checked || undefined,
      api_mode:          str('cfg-api-mode'),
    };
    // Strip undefined
    Object.keys(s).forEach(k => s[k] === undefined && delete s[k]);
    if (_cfgState.editIdx >= 0) _cfgState.sessions[_cfgState.editIdx] = s;
    else _cfgState.sessions.push(s);
    renderSettingsSessions();
    closeSessionEditor();
  });

  $('btn-add-session').addEventListener('click', () => openSessionEditor(-1));

  $('btn-save-config').addEventListener('click', async () => {
    const mixin = mixinEnableEl.checked ? {
      _key: (_cfgState.mixin && _cfgState.mixin._key) || 'mixin_config',
      llm_nos: $('mixin-llm-nos').value.split(',').map(s => s.trim()).filter(Boolean),
      max_retries: parseFloat($('mixin-max-retries').value) || 10,
      base_delay:  parseFloat($('mixin-base-delay').value)  || 0.5,
    } : null;
    try {
      await API.saveLLMConfig({ sessions: _cfgState.sessions, mixin });
      showToast('✅ 配置已保存到 mykey.json', 'success');
    } catch(e) { showToast('保存失败: ' + e.message, 'error'); }
  });

  $('btn-reload-config').addEventListener('click', async () => {
    try {
      const r = await API.reloadLLMConfig();
      showToast(`✅ 热重载完成，共 ${r.count} 个 LLM 会话`, 'success');
    } catch(e) { showToast('热重载失败: ' + e.message, 'error'); }
  });

  $('btn-backup-mykey-py').addEventListener('click', async () => {
    try {
      const r = await API.backupMykeyPy();
      showToast(`已重命名为 ${r.bak}`, 'success');
      $('settings-readonly-warn').classList.add('hidden');
    } catch(e) { showToast('操作失败: ' + e.message, 'error'); }
  });

  /* ═════ Tasks View (Scheduler / Goal / Hive) ═════ */
  let _tasksInited = false;
  function initTasksView() {
    if (!_tasksInited) {
      _tasksInited = true;
      // Sub-tab switching
      ['scheduler','goal','hive'].forEach(id => {
        $('task-tab-' + id).addEventListener('click', () => {
          document.querySelectorAll('#view-tasks .sop-tab-btn').forEach(b => b.classList.toggle('active', b.id === 'task-tab-' + id));
          ['scheduler','goal','hive'].forEach(p => $('task-panel-' + p).classList.toggle('hidden', p !== id));
        });
      });
      // Scheduler buttons
      $('btn-scheduler-add').addEventListener('click', () => _schedulerEdit(null));
      $('btn-scheduler-log').addEventListener('click', () => {
        const el = $('scheduler-log-content');
        el.classList.toggle('hidden');
        if (!el.classList.contains('hidden')) _loadSchedulerLog();
      });
      // Goal buttons
      $('btn-goal-new').addEventListener('click', () => {
        $('goal-form').classList.remove('hidden');
      });
      $('btn-goal-cancel').addEventListener('click', () => $('goal-form').classList.add('hidden'));
      $('btn-goal-create').addEventListener('click', _goalCreate);
      $('btn-goal-stop').addEventListener('click', _goalStop);
      // Hive buttons
      $('btn-hive-new').addEventListener('click', () => $('hive-form').classList.toggle('hidden'));
      $('btn-hive-cancel').addEventListener('click', () => $('hive-form').classList.add('hidden'));
      $('btn-hive-create').addEventListener('click', _hiveCreate);
    }
    _loadSchedulerTasks();
    _loadGoalState();
    _loadHiveSessions();
  }

  // ── Scheduler helpers ──
  async function _loadSchedulerTasks() {
    try {
      const data = await API.schedulerTasks();
      const tasks = data.tasks || [];
      $('scheduler-count').textContent = tasks.length;
      const el = $('scheduler-list');
      if (!tasks.length) { el.innerHTML = '<div class="text-frost-300 text-[12.5px] p-4 text-center">暂无定时任务</div>'; return; }
      el.innerHTML = tasks.map(t => {
        const enabled = t.enabled !== false;
        const nextRun = t.next_run || '—';
        return `<div class="settings-card p-4 flex items-center justify-between gap-3">
          <div class="min-w-0 flex-1">
            <div class="text-[13px] text-frost-100 font-medium truncate">${_esc(t.name || t.id)}</div>
            <div class="text-[11px] text-frost-400 mt-0.5">Cron: ${_esc(t.cron || '?')} · 下次: ${_esc(nextRun)}</div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <label class="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" ${enabled ? 'checked' : ''} data-task-id="${_esc(t.id)}" class="sr-only peer sched-toggle">
              <div class="w-9 h-[18px] bg-white/10 peer-checked:bg-brand-500 rounded-full transition"></div>
            </label>
            <button class="p-1 rounded hover:bg-white/10 text-frost-300 sched-edit" data-task-id="${_esc(t.id)}"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
            <button class="p-1 rounded hover:bg-white/10 text-red-300 sched-del" data-task-id="${_esc(t.id)}"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
          </div>
        </div>`;
      }).join('');
      lucide.createIcons();
      // Bind events
      el.querySelectorAll('.sched-toggle').forEach(cb => cb.addEventListener('change', async e => {
        try { await API.schedulerUpdate(e.target.dataset.taskId, { enabled: e.target.checked }); } catch(e) { showToast(e.message, 'error'); }
      }));
      el.querySelectorAll('.sched-edit').forEach(b => b.addEventListener('click', () => _schedulerEdit(b.dataset.taskId)));
      el.querySelectorAll('.sched-del').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('确认删除此任务?')) return;
        try { await API.schedulerDelete(b.dataset.taskId); _loadSchedulerTasks(); } catch(e) { showToast(e.message, 'error'); }
      }));
    } catch(e) { $('scheduler-list').innerHTML = `<div class="text-red-300 text-[12.5px] p-4">加载失败: ${e.message}</div>`; }
  }

  async function _loadSchedulerLog() {
    try {
      const data = await API.schedulerLog();
      $('scheduler-log-content').textContent = data.log || '(空)';
    } catch(e) { $('scheduler-log-content').textContent = '加载失败: ' + e.message; }
  }

  function _schedulerEdit(taskId) {
    // Simple prompt-based edit for now
    const name = prompt(taskId ? '修改任务名称(留空不改):' : '任务名称:');
    if (!name && !taskId) return;
    const cron = prompt('Cron表达式 (如 "*/30 * * * *"):');
    if (!cron) return;
    const prompt_text = prompt('执行提示词:');
    if (!prompt_text) return;
    const body = { name: name || undefined, cron, prompt: prompt_text, enabled: true };
    if (taskId) { API.schedulerUpdate(taskId, body).then(() => _loadSchedulerTasks()).catch(e => showToast(e.message, 'error')); }
    else { API.schedulerCreate(body).then(() => _loadSchedulerTasks()).catch(e => showToast(e.message, 'error')); }
  }

  // ── Goal helpers ──
  async function _loadGoalState() {
    try {
      const data = await API.goalState();
      const s = data.state;
      if (!s || !s.objective) {
        $('goal-status').innerHTML = '<div class="text-frost-300 text-[12.5px] p-4 text-center">暂无活跃目标</div>';
        $('btn-goal-stop').classList.add('hidden');
        return;
      }
      $('btn-goal-stop').classList.toggle('hidden', s.status !== 'running');
      const pct = s.progress || 0;
      const turns = s.current_turn || 0;
      const maxT = s.max_turns || '?';
      const budget = s.time_budget || '?';
      const elapsed = s.elapsed_hours ? s.elapsed_hours.toFixed(2) + 'h' : '—';
      $('goal-status').innerHTML = `
        <div class="flex items-center justify-between mb-3">
          <div class="text-[13.5px] text-frost-50 font-medium">${_esc(s.objective)}</div>
          <span class="text-[11px] px-2 py-0.5 rounded-full ${s.status === 'running' ? 'bg-brand-500/20 text-brand-300' : 'bg-white/10 text-frost-300'}">${_esc(s.status || 'idle')}</span>
        </div>
        <div class="w-full h-2 bg-white/10 rounded-full overflow-hidden mb-2">
          <div class="h-full bg-gradient-to-r from-brand-400 to-accent-violet rounded-full transition-all" style="width:${Math.min(pct,100)}%"></div>
        </div>
        <div class="flex items-center gap-4 text-[11px] text-frost-400">
          <span>进度 ${pct}%</span>
          <span>轮次 ${turns}/${maxT}</span>
          <span>预算 ${budget}h</span>
          <span>已用 ${elapsed}</span>
        </div>
        ${s.current_step ? `<div class="mt-3 p-3 bg-ink-900/60 rounded-lg text-[11.5px] text-frost-300 border border-white/5"><span class="text-frost-500">当前步骤:</span> ${_esc(s.current_step)}</div>` : ''}
      `;
    } catch(e) { $('goal-status').innerHTML = `<div class="text-red-300 text-[12.5px]">加载失败: ${e.message}</div>`; }
  }

  async function _goalCreate() {
    const objective = $('goal-objective').value.trim();
    if (!objective) { showToast('请输入目标描述', 'error'); return; }
    try {
      await API.goalStart({
        objective,
        time_budget: parseFloat($('goal-budget').value) || 1,
        max_turns: parseInt($('goal-max-turns').value) || 200,
        done_prompt: $('goal-done-prompt').value.trim() || undefined,
      });
      $('goal-form').classList.add('hidden');
      showToast('目标已启动');
      _loadGoalState();
    } catch(e) { showToast('启动失败: ' + e.message, 'error'); }
  }

  async function _goalStop() {
    if (!confirm('确认停止当前目标?')) return;
    try { await API.goalStop(); showToast('目标已停止'); _loadGoalState(); } catch(e) { showToast(e.message, 'error'); }
  }

  // ── Hive helpers ──
  async function _loadHiveSessions() {
    try {
      const data = await API.hiveSessions();
      const sessions = data.sessions || [];
      const el = $('hive-list');
      if (!sessions.length) { el.innerHTML = '<div class="text-frost-300 text-[12.5px] p-4 text-center">暂无 Hive 集群</div>'; return; }
      el.innerHTML = sessions.map(s => {
        const status = s.status || 'unknown';
        const statusColor = status === 'running' ? 'text-green-400' : status === 'stopped' ? 'text-red-400' : 'text-frost-400';
        const statusDot = status === 'running' ? 'bg-green-400' : status === 'stopped' ? 'bg-red-400' : 'bg-frost-400';
        const workerCount = s.worker_count || 0;
        const isRunning = status === 'running';
        return `<div class="settings-card p-4" data-hive="${_esc(s.name)}">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <div class="w-2 h-2 rounded-full ${statusDot} ${isRunning ? 'animate-pulse' : ''}"></div>
              <span class="text-[13px] text-frost-100 font-medium">${_esc(s.name)}</span>
              <span class="text-[11px] ${statusColor} px-1.5 py-0.5 rounded bg-white/5">${status}</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-[11px] text-frost-400">${workerCount} workers</span>
              ${isRunning
                ? `<button class="hive-stop-btn p-1.5 rounded-lg hover:bg-red-500/20 text-red-300 text-[11px] transition" data-hive="${_esc(s.name)}"><i data-lucide="square" class="w-3 h-3"></i></button>`
                : ''}
              <button class="hive-delete-btn p-1.5 rounded-lg hover:bg-red-500/20 text-red-400 text-[11px] transition" data-hive="${_esc(s.name)}" title="删除集群"><i data-lucide="trash-2" class="w-3 h-3"></i></button>
            </div>
          </div>
          <div class="hive-workers-${_esc(s.name)} space-y-1.5">
            ${(s.workers || []).map((w, i) => {
              const wStatus = w.status || 'unknown';
              const wColor = wStatus === 'running' ? 'text-green-300' : wStatus === 'idle' ? 'text-yellow-300' : 'text-frost-400';
              return `<div class="flex items-center justify-between px-3 py-1.5 bg-ink-900/60 rounded-lg border border-white/5">
                <div class="flex items-center gap-2">
                  <div class="w-1.5 h-1.5 rounded-full ${wStatus === 'running' ? 'bg-green-400' : wStatus === 'idle' ? 'bg-yellow-400' : 'bg-frost-400'}"></div>
                  <span class="text-[11.5px] text-frost-200">${_esc(w.role || 'worker-'+i)}</span>
                </div>
                <div class="flex items-center gap-2">
                  <span class="text-[10.5px] ${wColor}">${wStatus}</span>
                  ${w.pid ? `<span class="text-[10px] text-frost-500">PID:${w.pid}</span>` : ''}
                  <button class="hive-log-btn p-0.5 rounded hover:bg-white/10 text-frost-400" data-hive="${_esc(s.name)}" data-role="${_esc(w.role || 'worker_'+i)}"><i data-lucide="scroll-text" class="w-3 h-3"></i></button>
                </div>
              </div>`;
            }).join('')}
          </div>
          <div id="hive-log-${_esc(s.name)}" class="hidden mt-2 p-2 bg-ink-900 rounded-lg border border-white/5 max-h-[160px] overflow-y-auto">
            <pre class="text-[10.5px] text-frost-300 font-mono whitespace-pre-wrap"></pre>
          </div>
        </div>`;
      }).join('');
      lucide.createIcons();
      // Bind stop buttons
      el.querySelectorAll('.hive-stop-btn').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('确认停止集群 ' + b.dataset.hive + '?')) return;
        b.disabled = true;
        try { await API.hiveStop(b.dataset.hive); showToast('集群已停止'); _loadHiveSessions(); _updateVizHive(); } catch(e) { showToast('停止失败: ' + e.message, 'error'); }
      }));
      // Bind log buttons
      el.querySelectorAll('.hive-log-btn').forEach(b => b.addEventListener('click', async () => {
        const logEl = document.getElementById('hive-log-' + b.dataset.hive);
        if (!logEl) return;
        logEl.classList.toggle('hidden');
        if (!logEl.classList.contains('hidden')) {
          try {
            const ld = await API.hiveLog(b.dataset.hive, b.dataset.role, 50);
            logEl.querySelector('pre').textContent = ld.log || '(无日志)';
          } catch(e) { logEl.querySelector('pre').textContent = '日志加载失败: ' + e.message; }
        }
      }));
      // Bind delete buttons
      el.querySelectorAll('.hive-delete-btn').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('确认删除集群 ' + b.dataset.hive + '? 这将清理所有相关文件。')) return;
        b.disabled = true;
        try { await API.hiveDelete(b.dataset.hive); showToast('集群已删除'); _loadHiveSessions(); _updateVizHive(); } catch(e) { showToast('删除失败: ' + e.message, 'error'); }
      }));
    } catch(e) { $('hive-list').innerHTML = `<div class="text-red-300 text-[12.5px] p-4">加载失败: ${e.message}</div>`; }
  }

  async function _hiveCreate() {
    const name = $('hive-name').value.trim();
    if (!name) { showToast('请输入集群名称', 'error'); return; }
    const objective = $('hive-objective').value.trim();
    const workers = parseInt($('hive-workers').value) || 3;
    const btn = $('btn-hive-create');
    btn.disabled = true; btn.textContent = '启动中...';
    try {
      const data = await API.hiveCreate({ name, objective, workers });
      if (data.ok) {
        showToast(`集群 ${name} 已启动 (${data.workers || workers} workers)`, 'success');
        $('hive-form').classList.add('hidden');
        $('hive-name').value = '';
        $('hive-objective').value = '';
        _loadHiveSessions();
        _updateVizHive();
      } else {
        showToast('创建失败: ' + (data.error || '未知错误'), 'error');
      }
    } catch(e) { showToast('创建失败: ' + e.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = '启动集群'; }
  }

  /* ═══ Hive 3D 联动 ═══ */
  async function _updateVizHive() {
    try {
      const { getViz } = await import('./three-viz/index.js');
      const viz = getViz();
      if (!viz) return;
      const data = await API.hiveSessions();
      const sessions = data.sessions || [];
      const running = sessions.filter(s => s.status === 'running');
      running.forEach(hive => {
        (hive.workers || []).forEach((w, i) => {
          viz.updateWorkerState({ id: i, status: w.status || 'idle', name: w.role || 'worker-'+i });
        });
      });
      // Clear stopped hives
      if (!running.length) {
        for (let i = 0; i < 5; i++) viz.updateWorkerState({ id: i, status: 'offline' });
      }
    } catch(e) { /* viz not loaded yet, ignore */ }
  }

  function _esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }

  /* ═════ 3D Visualization Panel ═════ */
  let _vizLoaded = false;
  async function loadVizPanel() {
    if (_vizLoaded) return;
    const loadingEl = $('viz-loading');
    try {
      if (loadingEl) loadingEl.classList.remove('hidden');
      // Dynamic import of the 3D viz module
      const { initViz, getViz } = await import('./three-viz/index.js');
      await initViz('viz-canvas-container');
      _vizLoaded = true;
      if (loadingEl) loadingEl.classList.add('hidden');
      // Scene switch buttons
      const townBtn = $('viz-scene-town');
      const officeBtn = $('viz-scene-office');
      const resetBtn = $('viz-reset-cam');
      if (townBtn) townBtn.addEventListener('click', () => {
        const viz = getViz();
        if (viz) viz.switchScene('town');
        townBtn.classList.add('bg-brand-500/30');
        if (officeBtn) officeBtn.classList.remove('bg-brand-500/30');
      });
      if (officeBtn) officeBtn.addEventListener('click', () => {
        const viz = getViz();
        if (viz) viz.switchScene('office');
        officeBtn.classList.add('bg-brand-500/30');
        if (townBtn) townBtn.classList.remove('bg-brand-500/30');
      });
      if (resetBtn) resetBtn.addEventListener('click', () => {
        const viz = getViz();
        if (viz) viz.resetCamera();
      });
      // Default: town scene active
      if (townBtn) townBtn.classList.add('bg-brand-500/30');
    } catch(e) {
      console.error('[3D] loadVizPanel error:', e);
      if (loadingEl) loadingEl.innerHTML = `<div class="text-red-400 text-sm">3D加载失败: ${e.message}</div>`;
    }
  }

  /* ═════ MCP Panel ═════ */
  async function loadMCPPanel() {
    const listEl = $('mcp-servers-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="text-frost-400 text-[11.5px] p-3 text-center">加载中...</div>';
    try {
      const _res = await API.mcpServers();
      const servers = Array.isArray(_res) ? _res : (_res && _res.servers || []);
      if (!servers || servers.length === 0) {
        listEl.innerHTML = '<div class="text-frost-400 text-[11.5px] p-3 text-center">暂无MCP服务器</div>';
        return;
      }
      // T2.5.3: Enhanced MCP Hub rendering with status dot + tool tags
      listEl.innerHTML = servers.map(s => {
        const statusCls = s.connected ? 'online' : 'offline';
        const statusText = s.connected ? '已连接' : '未连接';
        const toolTags = (s.tools || []).slice(0, 8).map(t =>
          `<span class="mcp-tool-tag" title="${_esc(t.description || '')}">${_esc(t.name)}</span>`
        ).join('');
        const moreCount = Math.max(0, (s.tools || []).length - 8);
        return `
          <div class="mcp-server-row">
            <span class="mcp-status-dot ${statusCls}"></span>
            <div class="mcp-server-info">
              <div class="mcp-server-name">${_esc(s.name)} <span style="font-size:11px;font-weight:400;color:#94a3b8">${statusText}</span></div>
              <div class="mcp-server-meta">
                <span>${_esc(s.type || 'http')}</span>
                <span>${(s.tools || []).length}个工具</span>
              </div>
              <div style="margin-top:4px">${toolTags}${moreCount ? `<span class="mcp-tool-tag" style="background:rgba(255,255,255,0.06);color:#94a3b8">+${moreCount} more</span>` : ''}</div>
            </div>
            <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
              <label class="relative inline-flex items-center cursor-pointer" title="${s.enabled ? '禁用' : '启用'}">
                <input type="checkbox" class="mcp-toggle sr-only" data-server="${_esc(s.name)}" ${s.enabled ? 'checked' : ''}>
                <div class="toggle-track w-8 h-[18px] rounded-full transition-colors relative ${s.enabled ? 'bg-brand-500' : 'bg-white/15'}">
                  <div class="toggle-thumb absolute top-[2px] ${s.enabled ? 'left-[18px]' : 'left-[2px]'} w-[14px] h-[14px] bg-white rounded-full transition-all shadow"></div>
                </div>
              </label>
              <button class="mcp-test-btn p-1 rounded text-frost-500 hover:text-frost-50 hover:bg-white/8 transition" data-server="${_esc(s.name)}" title="测试">
                <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
              </button>
              <button class="mcp-del-btn p-1 rounded text-frost-500 hover:text-red-400 hover:bg-white/8 transition" data-server="${_esc(s.name)}" title="删除">
                <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>
          </div>`;
      }).join('');

      // Bind delete buttons
      listEl.querySelectorAll('.mcp-del-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm(`确认删除服务器 "${btn.dataset.server}"？`)) return;
          try {
            await API.mcpDelete(btn.dataset.server);
            showToast('✅ 已删除', 'success');
            loadMCPPanel();
          } catch (e) { showToast('删除失败: ' + e.message, 'error'); }
        });
      });
      // Bind test buttons
      listEl.querySelectorAll('.mcp-test-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const svrName = btn.dataset.server;
          showToast(`🔌 测试 ${svrName} 连通性...`, 'info');
          btn.disabled = true;
          try {
            const r = await API.mcpTest(svrName);
            if (r.ok) {
              const res = r.result || {};
              const toolCount = res.tool_count ?? (res.tools?.length ?? '?');
              const toolList = (res.tools || []).slice(0, 5).join(', ');
              const moreInfo = toolCount > 5 ? ` 等${toolCount}个` : '';
              showToast(`✅ ${svrName} 连接成功 (${toolCount}个工具: ${toolList}${moreInfo})`, 'success');
            } else {
              showToast(`❌ ${svrName} ${r.error || '连接失败'}`, 'error');
            }
          } catch (e) { showToast(`❌ 测试失败: ${e.message}`, 'error'); }
          finally { btn.disabled = false; }
        });
      });
      // Bind toggle switches
      listEl.querySelectorAll('.mcp-toggle').forEach(chk => {
        chk.addEventListener('change', async () => {
          const name = chk.dataset.server;
          try {
            const r = await API.mcpToggle(name);
            showToast(r.enabled ? '✅ 已启用' : '⏸ 已禁用', 'success');
            loadMCPPanel();
          } catch (e) { showToast('切换失败: ' + e.message, 'error'); loadMCPPanel(); }
        });
      });
    } catch (e) {
      listEl.innerHTML = `<div class="text-frost-400 text-[11.5px] p-3 text-center">加载失败: ${_esc(e.message)}</div>`;
    }
  }

  // MCP refresh & add buttons
  $('mcp-refresh')?.addEventListener('click', () => loadMCPPanel());
  
  // MCP Add Form: toggle and submit
  const mcpAddForm = $('mcp-add-form');
  const mcpAddBtn = $('btn-add-mcp-server');
  const mcpAddConfirm = $('mcp-add-confirm');
  const mcpAddCancel = $('mcp-add-cancel');

  if (mcpAddBtn && mcpAddForm) {
    mcpAddBtn.addEventListener('click', () => {
      mcpAddForm.classList.toggle('hidden');
      if (!mcpAddForm.classList.contains('hidden')) {
        $('mcp-add-name')?.focus();
        mcpAddBtn.innerHTML = '<i data-lucide="x" class="w-4 h-4"></i> 取消添加';
        lucide.createIcons();
      } else {
        mcpAddBtn.innerHTML = '<i data-lucide="plus" class="w-4 h-4"></i> 添加 MCP 服务器';
        lucide.createIcons();
      }
    });
  }
  if (mcpAddCancel) {
    mcpAddCancel.addEventListener('click', () => {
      if (mcpAddForm) mcpAddForm.classList.add('hidden');
      if (mcpAddBtn) {
        mcpAddBtn.innerHTML = '<i data-lucide="plus" class="w-4 h-4"></i> 添加 MCP 服务器';
        lucide.createIcons();
      }
    });
  }
  if (mcpAddConfirm) {
    mcpAddConfirm.addEventListener('click', () => {
      const name = $('mcp-add-name')?.value?.trim();
      const url = $('mcp-add-url')?.value?.trim();
      const transport = $('mcp-add-transport')?.value || 'http';
      const headersStr = $('mcp-add-headers')?.value?.trim();
      if (!name) { showToast('请输入服务器名称', 'error'); return; }
      if (!url) { showToast('请输入服务器URL', 'error'); return; }
      let hdr = {};
      try { hdr = headersStr ? JSON.parse(headersStr) : {}; } catch { showToast('Headers JSON格式错误', 'error'); return; }
      mcpAddConfirm.disabled = true;
      mcpAddConfirm.textContent = '添加中...';
      API.mcpAdd(name, url, transport, hdr)
        .then(() => {
          showToast('✅ 已添加: ' + name, 'success');
          loadMCPPanel();
          // Reset form
          if (mcpAddForm) mcpAddForm.classList.add('hidden');
          if (mcpAddBtn) {
            mcpAddBtn.innerHTML = '<i data-lucide="plus" class="w-4 h-4"></i> 添加 MCP 服务器';
            lucide.createIcons();
          }
          ['mcp-add-name','mcp-add-url','mcp-add-headers','mcp-add-desc'].forEach(id => {
            const el = $(id); if (el) el.value = '';
          });
        })
        .catch(e => showToast('添加失败: ' + e.message, 'error'))
        .finally(() => { mcpAddConfirm.disabled = false; mcpAddConfirm.textContent = '确认添加'; });
    });
  }
  $('sidebar-collapse-mcp')?.addEventListener('click', () => {
    document.body.classList.add('sidebar-collapsed');
  });

  /* ═════ Sidebar Resize ═════ */
  const resizeHandle = $('sidebar-resize-handle');
  const sidebarPanel = $('sidebar');
  if (resizeHandle && sidebarPanel) {
    let resizing = false, startX = 0, startW = 0;
    resizeHandle.addEventListener('mousedown', (e) => {
      resizing = true;
      startX = e.clientX;
      startW = sidebarPanel.offsetWidth;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const dx = e.clientX - startX;
      const newW = Math.max(180, Math.min(480, startW + dx));
      sidebarPanel.style.width = newW + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!resizing) return;
      resizing = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  /* ═════ T2.4 Context Panel ═════ */
  const ctxPanel = $('context-panel');
  const ctxCloseBtn = $('ctx-panel-close');
  const ctxExpSearch = $('ctx-exp-search');
  const ctxExpSearchBtn = $('ctx-exp-search-btn');
  const ctxExpResults = $('ctx-exp-results');
  const ctxMemStats = { l1: $('ctx-l1-count'), l2: $('ctx-l2-count'), l3: $('ctx-l3-count') };
  const ctxActiveMemories = $('ctx-active-memories');
  const ctxPrefTags = $('ctx-pref-tags');

  // Toggle Context Panel
  function toggleContextPanel(forceState) {
    if (!ctxPanel) return;
    const isExpanded = ctxPanel.classList.contains('expanded');
    const shouldExpand = forceState !== undefined ? forceState : !isExpanded;
    if (shouldExpand) {
      ctxPanel.classList.remove('hidden');
      requestAnimationFrame(() => ctxPanel.classList.add('expanded'));
    } else {
      ctxPanel.classList.remove('expanded');
      setTimeout(() => ctxPanel.classList.add('hidden'), 300);
    }
    // Re-create icons for the panel
    setTimeout(() => lucide.createIcons(), 50);
  }

  if (ctxCloseBtn) ctxCloseBtn.addEventListener('click', () => toggleContextPanel(false));

  // Keyboard shortcut: Ctrl+/ to toggle
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === '/') {
      e.preventDefault();
      toggleContextPanel();
    }
  });

  // Expose toggle for status-bar button (T1.5 mem badge click)
  window.toggleContextPanel = toggleContextPanel;

  // ── Memory Stats ──
  function updateMemoryStats(data) {
    if (!data) return;
    if (ctxMemStats.l1 && data.l1 !== undefined) ctxMemStats.l1.textContent = data.l1;
    if (ctxMemStats.l2 && data.l2 !== undefined) ctxMemStats.l2.textContent = data.l2;
    if (ctxMemStats.l3 && data.l3 !== undefined) ctxMemStats.l3.textContent = data.l3;
  }

  // ── Active Memories (T4.4.3: virtual scroll / pagination) ──
  const _memPage = { items: [], page: 1, pageSize: 20 };
  function renderActiveMemories(memories) {
    if (!ctxActiveMemories) return;
    if (!memories || memories.length === 0) {
      ctxActiveMemories.innerHTML = '<div class="text-[10px] text-white/25 text-center py-1">暂无激活的记忆</div>';
      return;
    }
    _memPage.items = memories;
    _memPage.page = 1;
    _renderMemPage();
  }
  function _renderMemPage() {
    const { items, page, pageSize } = _memPage;
    const end = Math.min(page * pageSize, items.length);
    const slice = items.slice(0, end);
    ctxActiveMemories.innerHTML = slice.map(m => {
      const icon = m.type === 'sop' ? '📋' : m.type === 'fact' ? '💡' : '📌';
      const color = m.type === 'sop' ? 'bg-amber-500/20 text-amber-400' : m.type === 'fact' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-brand-500/20 text-brand-400';
      return `<div class="ctx-mem-card" title="${escHtml(m.text)}">
        <span class="ctx-mem-icon ${color}">${icon}</span>
        <span class="ctx-mem-text">${escHtml(m.text)}</span>
      </div>`;
    }).join('');
    if (end < items.length) {
      const remaining = items.length - end;
      ctxActiveMemories.insertAdjacentHTML('beforeend',
        `<button class="ctx-mem-loadmore text-[10px] text-brand-400 hover:text-brand-300 py-1 w-full text-center cursor-pointer bg-transparent border border-dashed border-white/10 rounded mt-1">加载更多 (${remaining}条)</button>`);
      ctxActiveMemories.querySelector('.ctx-mem-loadmore')?.addEventListener('click', () => {
        _memPage.page++;
        _renderMemPage();
      });
    }
  }

  // ── Experience Search ──
  function searchExperience(query) {
    if (!query || !query.trim()) return;
    ctxExpResults.innerHTML = '<div class="text-[10px] text-white/30 text-center py-3">搜索中...</div>';
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'experience_query', query: query.trim() }));
    } else {
      ctxExpResults.innerHTML = '<div class="text-[10px] text-red-400/60 text-center py-3">WebSocket未连接</div>';
    }
  }

  if (ctxExpSearchBtn) ctxExpSearchBtn.addEventListener('click', () => searchExperience(ctxExpSearch.value));
  if (ctxExpSearch) ctxExpSearch.addEventListener('keydown', (e) => { if (e.key === 'Enter') searchExperience(ctxExpSearch.value); });

  function renderExperienceResults(results) {
    if (!ctxExpResults) return;
    if (!results || results.length === 0) {
      ctxExpResults.innerHTML = '<div class="text-[10px] text-white/25 text-center py-3">未找到相关经验</div>';
      return;
    }
    ctxExpResults.innerHTML = results.map(r => {
      const pct = Math.round((r.relevance || 0) * 100);
      const date = r.timestamp ? new Date(r.timestamp).toLocaleDateString('zh-CN') : '';
      return `<div class="ctx-exp-card" data-exp-id="${escHtml(r.id || '')}" title="点击注入到对话">
        <div class="ctx-exp-summary">${escHtml(r.summary || '')}</div>
        <div class="ctx-exp-meta">
          ${r.category ? `<span>${escHtml(r.category)}</span>` : ''}
          ${date ? `<span>${date}</span>` : ''}
          <span>相关度 ${pct}%</span>
        </div>
        <div class="ctx-exp-relevance"><div class="ctx-exp-relevance-bar" style="width:${pct}%"></div></div>
      </div>`;
    }).join('');
    // Click to inject
    ctxExpResults.querySelectorAll('.ctx-exp-card').forEach(card => {
      card.addEventListener('click', () => {
        const summary = card.querySelector('.ctx-exp-summary')?.textContent || '';
        if (inputEl) {
          inputEl.value = `[参考经验] ${summary}\n\n`;
          inputEl.focus();
          inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
    });
  }

  // ── Preference Tags ──
  function renderPrefTags(prefs) {
    if (!ctxPrefTags) return;
    if (!prefs || prefs.length === 0) {
      ctxPrefTags.innerHTML = '<div class="text-[10px] text-white/25 py-1">暂无学习到的偏好</div>';
      return;
    }
    ctxPrefTags.innerHTML = prefs.map(p => {
      return `<span class="ctx-pref-tag" data-pref-key="${escHtml(p.key || '')}">
        ${escHtml(p.key)}: ${escHtml(p.value)}
        <span class="ctx-pref-remove" data-pref="${escHtml(p.key)}" title="删除偏好">&times;</span>
      </span>`;
    }).join('');
    // Remove preference on click
    ctxPrefTags.querySelectorAll('.ctx-pref-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = btn.dataset.pref;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'preference_remove', key }));
        }
      });
    });
  }

  // ── Handle WS messages for Context Panel ──
  const _origWsOnMsg = (typeof ws !== 'undefined' && ws) ? ws.onmessage : null;
  function contextPanelWsHandler(event) {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'memory_stats') updateMemoryStats(data.payload);
      else if (data.type === 'memory_activated') renderActiveMemories(data.payload);
      else if (data.type === 'experience_result') renderExperienceResults(data.payload);
      else if (data.type === 'preferences_update') renderPrefTags(data.payload);
      else if (data.type === 'review_suggestion') showReviewModal(data.payload);
    } catch(e) {}
  }
  // Hook into WS onmessage chain
  window._contextPanelWsHandler = contextPanelWsHandler;
  if (ws) {
    const _prev = ws.onmessage;
    ws.onmessage = function(evt) {
      contextPanelWsHandler(evt);  // T2: context panel gets first look
      if (_prev) _prev.call(ws, evt);  // then original handler (wsHandlers dispatch)
    };
  }

  // Request initial data when panel opens
  function requestContextData() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'memory_stats_request' }));
      ws.send(JSON.stringify({ type: 'preferences_request' }));
    }
  }

  // Patch toggle to also request data
  const _origToggle = toggleContextPanel;
  window.toggleContextPanel = function(forceState) {
    const wasExpanded = ctxPanel?.classList.contains('expanded');
    _origToggle(forceState);
    const nowExpanded = ctxPanel?.classList.contains('expanded');
    if (nowExpanded && !wasExpanded) requestContextData();
  };

  /* ═════ T2.5.4: Review Suggestion Modal ═════ */
  function showReviewModal(data) {
    // Ensure modal container exists
    let modal = document.getElementById('review-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'review-modal';
      modal.className = 'review-modal';
      document.body.appendChild(modal);
    }
    const p = data || {};
    const timeline = (p.timeline || []).map(t =>
      `<div class="review-timeline-item">
        <span class="review-timeline-dot ${t.success ? 'success' : 'fail'}"></span>
        <span class="review-timeline-text">${escapeHTML(t.task || '...')}</span>
        <span class="review-timeline-time">${escapeHTML(t.time || '')}</span>
      </div>`
    ).join('');

    const tools = (p.tools_used || []).map(t =>
      `<span class="review-tool-tag">${escapeHTML(t)}</span>`
    ).join('');

    const diffColor = p.difficulty === '复杂' ? '#ef4444' : p.difficulty === '中等' ? '#fbbf24' : '#4ade80';

    modal.innerHTML = `
      <div class="review-backdrop"></div>
      <div class="review-content">
        <div class="review-header">
          <span class="review-icon">✨</span>
          <h3>任务复盘</h3>
          <span class="review-time">${escapeHTML(p.timestamp || '')}</span>
        </div>
        <div class="review-summary">${escapeHTML(p.task_summary || '任务已完成')}</div>
        <div class="review-difficulty"><span style="color:${diffColor}">●</span> ${escapeHTML(p.difficulty || '中等')}难度</div>
        ${tools ? `<div class="review-section"><div class="review-section-title">使用工具</div><div class="review-tools">${tools}</div></div>` : ''}
        ${p.key_insight ? `<div class="review-section"><div class="review-section-title">关键洞察</div><div class="review-insight-text">${escapeHTML(p.key_insight)}</div></div>` : ''}
        ${timeline ? `<div class="review-section"><div class="review-section-title">近期任务时间线</div><div class="review-timeline">${timeline}</div></div>` : ''}
        <button class="review-close-btn" id="review-close-btn">关闭复盘</button>
      </div>`;
    modal.style.display = 'flex';

    // Close handlers
    const close = () => { modal.style.display = 'none'; };
    modal.querySelector('.review-backdrop').onclick = close;
    modal.querySelector('#review-close-btn').onclick = close;
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
  }

  /* ═════ T3.4.3: 快捷键体系 ═════ */
  function initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      const ctrl = e.ctrlKey || e.metaKey;

      // Ctrl+N: 新建会话
      if (ctrl && e.key === 'n') {
        e.preventDefault();
        const newBtn = document.getElementById('new-session-btn');
        if (newBtn) newBtn.click();
      }

      // Ctrl+K: 搜索经验(聚焦输入框)
      if (ctrl && e.key === 'k') {
        e.preventDefault();
        if (inputEl) inputEl.focus();
        // 如果有搜索面板则切换
        const searchPanel = document.getElementById('experience-search');
        if (searchPanel) searchPanel.style.display = searchPanel.style.display === 'none' ? 'block' : 'none';
      }

      // Ctrl+L: 切换右侧面板
      if (ctrl && e.key === 'l') {
        e.preventDefault();
        const toggle = document.getElementById('panel-toggle');
        if (toggle) toggle.click();
        // fallback: 直接toggle panel
        const panel = document.getElementById('context-panel') || document.querySelector('.right-panel');
        if (panel) panel.classList.toggle('panel-hidden');
      }

      // Esc: 停止当前生成
      if (e.key === 'Escape' && !e.ctrlKey) {
        const stopBtn = document.getElementById('stop-btn');
        if (stopBtn && stopBtn.style.display !== 'none') stopBtn.click();
      }
    });
  }

  /* ═════ T3.4.4: 响应式断点 ═════ */
  function initResponsive() {
    const mql1280 = window.matchMedia('(min-width: 1280px)');
    const mql768 = window.matchMedia('(min-width: 768px)');

    function applyLayout() {
      const root = document.documentElement;
      if (mql1280.matches) {
        root.setAttribute('data-layout', 'three-col');
      } else if (mql768.matches) {
        root.setAttribute('data-layout', 'two-col');
      } else {
        root.setAttribute('data-layout', 'single-col');
      }
    }

    mql1280.addEventListener('change', applyLayout);
    mql768.addEventListener('change', applyLayout);
    applyLayout();
  }

  /* ═════ Boot ═════ */
  lucide.createIcons();
  autoResize();
  inputEl.focus();
  // Fetch sessions immediately via HTTP (doesn't depend on WS connecting)
  refreshSessions();

  // ── T3.4: Init keyboard shortcuts + responsive layout ──
  initKeyboardShortcuts();
  initResponsive();

  // ── Expose sophub functions to global scope for onclick ──
  window.openSophubDetail = openSophubDetail;
  window.downloadSophub = downloadSophub;
  window.sophubGo = sophubGo;
  window.sophubSearch = sophubSearch;

  // ── T4.1: Execution Preview Panel ──
  function showPreviewPanel(preview) {
    // Remove existing panel if any
    const old = document.getElementById('preview-panel');
    if (old) old.remove();

    const panel = document.createElement('div');
    panel.id = 'preview-panel';
    panel.className = 'preview-panel';
    const steps = (preview.steps || []).map((s, i) =>
      `<div class="preview-step"><span class="step-num">${i + 1}</span><span class="step-text">${escHtml(s)}</span></div>`
    ).join('');
    const riskColor = { low: '#4ade80', medium: '#fbbf24', high: '#f87171' }[preview.risk_level] || '#94a3b8';

    panel.innerHTML = `
      <div class="preview-header">
        <span class="preview-icon">🔍</span> 自主行为预览
        <button class="preview-close" onclick="this.closest('#preview-panel').remove()">✕</button>
      </div>
      <div class="preview-body">
        <div class="preview-meta">
          <span class="risk-badge" style="background:${riskColor}">风险: ${preview.risk_level || '未知'}</span>
          <span class="impact-badge">影响: ${preview.impact || '未知'}</span>
        </div>
        <div class="preview-steps">${steps || '<div class="preview-step">无详细步骤</div>'}</div>
      </div>
      <div class="preview-actions">
        <button class="btn-approve" onclick="window._previewRespond(true)">✅ 批准执行</button>
        <button class="btn-reject" onclick="window._previewRespond(false)">❌ 拒绝</button>
      </div>`;
    document.body.appendChild(panel);
    // Store preview id for response
    panel.dataset.previewId = preview.id || '';
  }

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  window._previewRespond = function(approved) {
    const panel = document.getElementById('preview-panel');
    if (!panel) return;
    const pid = panel.dataset.previewId;
    wsSend({ type: 'preview_response', payload: { id: pid, approved } });
    panel.innerHTML = approved
      ? '<div class="preview-result approved">✅ 已批准，正在执行...</div>'
      : '<div class="preview-result rejected">❌ 已拒绝</div>';
    setTimeout(() => panel.remove(), approved ? 1500 : 800);
  };

  // ── T4.2.5: Trust Level Selector ──
  function initTrustLevel() {
    const saved = _storage.get('ga_trust_level');
    if (saved !== null) {
      wsSend({ type: 'set_trust_level', payload: { level: parseInt(saved) } });
    }
    // Add trust indicator to status bar
    const bar = document.getElementById('status-bar');
    if (bar && !document.getElementById('trust-indicator')) {
      const ti = document.createElement('span');
      ti.id = 'trust-indicator';
      ti.className = 'trust-indicator';
      ti.innerHTML = `🔒 <select id="trust-select" onchange="window._setTrust(this.value)">
        <option value="0">L0 完全信任</option>
        <option value="1">L1 预览提示</option>
        <option value="2">L2 需批准</option>
        <option value="3">L3 只读</option>
      </select>`;
      bar.appendChild(ti);
      if (saved !== null) document.getElementById('trust-select').value = saved;
    }
  }
  window._setTrust = function(level) {
    _storage.set('ga_trust_level', level);
    wsSend({ type: 'set_trust_level', payload: { level: parseInt(level) } });
  };
  initTrustLevel();

  // ── Execution Timeline removed — replaced by 3D Desktop Pet (pet3d.js) ──

  // ── T4.3.4: Capability Report ──
  function _renderCapCards(report) {
    const container = document.getElementById('capability-report-cards');
    if (!container || !report) return;
    container.classList.remove('hidden');
    const sections = [
      { key: 'tools', label: '🔧 工具', icon: 'wrench', color: 'brand' },
      { key: 'mcp_servers', label: '🌐 MCP 服务', icon: 'globe', color: 'accent-violet' },
      { key: 'sops', label: '📖 SOP', icon: 'book-open', color: 'accent-pink' },
      { key: 'devices', label: '📱 设备', icon: 'smartphone', color: 'emerald' },
      { key: 'memory_layers', label: '🧠 记忆层', icon: 'brain', color: 'amber' },
    ];
    let html = '';
    for (const s of sections) {
      const items = report[s.key] || [];
      if (!items.length && s.key !== 'memory_layers') continue;
      const count = s.key === 'memory_layers' ? (report.memory_layers_count || 0) : items.length;
      html += `<div class="rounded-xl bg-white/4 border border-white/8 p-4">
        <div class="flex items-center justify-between mb-2">
          <span class="text-[13px] font-semibold text-frost-100">${s.label}</span>
          <span class="text-[11px] px-2 py-0.5 rounded-full bg-${s.color}-400/15 text-${s.color}-300">${count}</span>
        </div>
        <div class="flex flex-wrap gap-1.5">${items.map(i =>
          `<span class="text-[11px] px-2 py-0.5 rounded-md bg-white/6 text-frost-300">${typeof i === 'string' ? i : i.name || i.title || JSON.stringify(i)}</span>`
        ).join('')}</div>
      </div>`;
    }
    container.innerHTML = html || '<p class="text-frost-400 text-[12px]">暂无能力数据</p>';
  }

  // Button click
  document.getElementById('btn-capability-report')?.addEventListener('click', function() {
    this.disabled = true;
    this.innerHTML = '<span class="animate-spin inline-block w-4 h-4 border-2 border-frost-300 border-t-transparent rounded-full"></span> 扫描中...';
    wsSend({ type: 'capability_report' });
    setTimeout(() => {
      this.disabled = false;
      this.innerHTML = '<i data-lucide="scan" class="w-4 h-4"></i>扫描当前能力';
      if (window.lucide) lucide.createIcons();
    }, 2000);
  });

  // ══════════════════════════════════════════════
  //  🐾 Pet Settings — init / load / live preview
  // ══════════════════════════════════════════════
  const PET_STORAGE_KEY = 'ga_pet_config';

  function loadPetConfig() {
    try {
      const raw = _storage.get(PET_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch(e) { return null; }
  }

  function savePetConfig(cfg) {
    _storage.set(PET_STORAGE_KEY, JSON.stringify(cfg));
  }

  function getPetDefaults() {
    return { enabled: true, mode: '3d', type: 'cat', liveModel: 'shizuku', size: 160, interactHover: true, interactClick: true, interactNotify: true, name: '' };
  }

  // Apply saved config on load (wait for pet3d.js to register APIs)
  function applySavedPetConfig() {
    const cfg = loadPetConfig();
    if (!cfg) return;
    // Wait until pet3d.js is ready
    const tryApply = () => {
      if (typeof window.__petApplyConfig === 'function') {
        window.__petApplyConfig(cfg);
        if (window.__petSetFlags) {
          window.__petSetFlags({ hover: cfg.interactHover, click: cfg.interactClick, notify: cfg.interactNotify });
        }
        // Sync selector buttons in settings panel
        const sel = document.querySelector(`.pet-pick-btn[data-pet="${cfg.type}"]`);
        if (sel) { sel.classList.add('active'); }
      } else {
        setTimeout(tryApply, 300);
      }
    };
    tryApply();
  }

  // Init pet settings panel events (called when settings tab is shown)
  function initPetSettings() {
    const cfg = loadPetConfig() || getPetDefaults();
    const el = (id) => document.getElementById(id);

    // Enabled toggle
    const toggleEl = el('pet-enabled');
    if (toggleEl) {
      toggleEl.checked = cfg.enabled;
      toggleEl.addEventListener('change', () => {
        cfg.enabled = toggleEl.checked;
        savePetConfig(cfg);
        if (window.__petApplyConfig) window.__petApplyConfig(cfg);
      });
    }

    // Type selector buttons
    document.querySelectorAll('.pet-pick-btn[data-pet]').forEach(btn => {
      // Highlight active
      if (btn.dataset.pet === cfg.type) btn.classList.add('active');
      btn.addEventListener('click', () => {
        document.querySelectorAll('.pet-pick-btn[data-pet]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        cfg.type = btn.dataset.pet;
        cfg.mode = '3d';            // 选 3D 动物自动切到 3d 模式
        savePetConfig(cfg);
        if (window.__petSwitch) window.__petSwitch(cfg.type);
      });
    });

    // ── Live2D model selector buttons (Shizuku / Haru) ──
    document.querySelectorAll('.pet-pick-btn[data-live]').forEach(btn => {
      if (btn.dataset.live === cfg.liveModel) btn.classList.add('active');
      btn.addEventListener('click', () => {
        document.querySelectorAll('.pet-pick-btn[data-live]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        cfg.liveModel = btn.dataset.live;
        cfg.mode = 'live2d';        // 选动漫模型自动切到 live2d 模式
        savePetConfig(cfg);
        // 切换 mode / 模型需要重载页面让加载器选对模块
        setTimeout(() => location.reload(), 200);
      });
    });

    // ── Mode toggle: 3D animals ↔ Live2D anime ──
    const modeToggle = el('pet-mode-toggle');
    if (modeToggle) {
      modeToggle.checked = (cfg.mode === 'live2d');
      modeToggle.addEventListener('change', () => {
        cfg.mode = modeToggle.checked ? 'live2d' : '3d';
        savePetConfig(cfg);
        setTimeout(() => location.reload(), 200);
      });
    }

    // Size slider
    const sizeSlider = el('pet-size');
    const sizeLabel = el('pet-size-label');
    if (sizeSlider) {
      sizeSlider.value = cfg.size;
      if (sizeLabel) sizeLabel.textContent = cfg.size + 'px';
      sizeSlider.addEventListener('input', () => {
        cfg.size = parseInt(sizeSlider.value);
        if (sizeLabel) sizeLabel.textContent = cfg.size + 'px';
        savePetConfig(cfg);
        if (window.__petApplyConfig) window.__petApplyConfig(cfg);
      });
    }

    // Interaction toggles
    const toggles = [
      { id: 'pet-interact-hover', key: 'interactHover', flag: 'hover' },
      { id: 'pet-interact-click', key: 'interactClick', flag: 'click' },
      { id: 'pet-interact-notify', key: 'interactNotify', flag: 'notify' },
    ];
    toggles.forEach(({ id, key, flag }) => {
      const tEl = el(id);
      if (tEl) {
        tEl.checked = cfg[key];
        tEl.addEventListener('change', () => {
          cfg[key] = tEl.checked;
          savePetConfig(cfg);
          if (window.__petSetFlags) window.__petSetFlags({ [flag]: tEl.checked });
        });
      }
    });

    // Pet name
    const nameInput = el('pet-name');
    if (nameInput) {
      nameInput.value = cfg.name || '';
      nameInput.addEventListener('input', () => {
        cfg.name = nameInput.value.trim();
        savePetConfig(cfg);
        if (window.__petApplyConfig) window.__petApplyConfig(cfg);
      });
    }
  }

  // Apply saved pet config on load
  applySavedPetConfig();

})();
