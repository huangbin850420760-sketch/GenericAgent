/* ═══════════════════════════════════════════════════
   GenericAgent · UI (uses GA_API layer for all backend I/O)
   ═══════════════════════════════════════════════════ */
(() => {
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

  // Configure marked
  marked.setOptions({
    breaks: true, gfm: true,
    highlight: (code, lang) => {
      if (lang && hljs.getLanguage(lang)) {
        try { return hljs.highlight(code, { language: lang }).value; } catch {}
      }
      try { return hljs.highlightAuto(code).value; } catch { return code; }
    },
  });

  // State
  const state = {
    tab: 'chat',
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

  /* ═════ WebSocket wiring via API layer ═════ */
  API.connect({
    onopen: async () => {
      setStatus('就绪', false);
      const s = await API.getStatus().catch(() => null);
      if (s) updateStatus(s);
      refreshSessions();
    },
    onclose: () => setStatus('连接断开，3秒后重连...', false, true),
    on_status: (m) => updateStatus(m.payload),
    on_stream: (m) => {
      if (state.viewingSessionPath) returnToActive();
      appendAssistantStream(m.full);
    },
    on_done: (m) => { finalizeAssistant(m.payload); setRunning(false); refreshSessions(); },
    on_info: (m) => showToast(m.payload, 'info'),
    on_error: (m) => { showToast(m.payload, 'error'); setRunning(false); },
    on_auto_user: (m) => {
      if (state.viewingSessionPath) returnToActive();
      // Autonomous task fired (idle-monitor or manual). Show a user bubble + prep assistant area.
      addUserMessage(m.payload || '🤖 (自主触发)', [], []);
      addAssistantPlaceholder();
      setRunning(true);
      showToast('🤖 自主行动已触发', 'info');
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
      });
    });
  }
  llmSelector.addEventListener('click', (e) => { e.stopPropagation(); llmDropdown.classList.toggle('open'); });
  document.addEventListener('click', () => llmDropdown.classList.remove('open'));

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
    // Sync sidebar nav buttons
    document.querySelectorAll('#sidebar .tab-btn, #sidebar [data-tab]').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === tab));
    // Sync collapsed rail buttons
    document.querySelectorAll('#sidebar-rail [data-tab]').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === tab));
    // Toggle right-side views only
    $('view-chat').classList.toggle('hidden', tab !== 'chat');
    $('view-chat').classList.toggle('flex', tab === 'chat');
    $('view-skills').classList.toggle('hidden', tab !== 'skills');
    $('view-settings').classList.toggle('hidden', tab !== 'settings');
    $('view-tasks').classList.toggle('hidden', tab !== 'tasks');
    $('view-mcp').classList.toggle('hidden', tab !== 'mcp');
    if (tab === 'skills') loadSkills();
    if (tab === 'settings') loadConfig();
    if (tab === 'tasks') initTasksView();
    if (tab === 'mcp') loadMCPPanel();
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
    // If already viewing another session or same, save nothing (already saved)
    if (!state.viewingSessionPath) {
      // Save current active conversation HTML before switching
      state.savedActiveHTML = messagesEl.innerHTML;
    }
    state.viewingSessionPath = path;
    try {
      const r = await API.getSessionHistory(path);
      const messages = r.messages || [];
      // Derive title
      const firstUser = messages.find(m => m.role === 'user');
      const preview = firstUser
        ? String((firstUser.parts || []).filter(p => p.type === 'user_text').map(p => p.content).join(' ') || '').slice(0, 48)
        : '';
      const fname = path.split(/[\\/]/).pop().replace(/\.(json|txt)$/i, '');
      const title = preview || fname || '历史会话';
      const titleEl = $('conversation-title');
      if (titleEl) titleEl.textContent = '📖 ' + title;
      renderSessionHistory(messages);
      // Insert action bar at top of messages
      const bar = document.createElement('div');
      bar.id = 'session-view-bar';
      bar.className = 'flex items-center gap-2 p-3 mb-2 bg-accent-violet/10 border border-accent-violet/20 rounded-xl text-sm';
      bar.innerHTML = `
        <span class="text-frost-300 flex-1">📖 只读查看历史会话</span>
        <button id="btn-return-active" class="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-frost-200 transition">← 返回当前对话</button>
        <button id="btn-restore-session" class="px-3 py-1.5 rounded-lg bg-accent-violet hover:bg-accent-violet/80 text-white transition">恢复此会话</button>
      `;
      messagesEl.prepend(bar);
      $('btn-return-active').addEventListener('click', returnToActive);
      $('btn-restore-session').addEventListener('click', () => restoreAndShow(path));
    } catch (e) {
      showToast('加载历史失败: ' + e.message, 'error');
    }
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
    if (!confirm('恢复此会话？当前上下文将被清空。')) return;
    try {
      const r = await API.restoreSession(path);
      state.currentSessionPath = path;
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
    state.pendingAssistant.classList.remove('streaming');
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
    try { return marked.parse(t); }
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
    items[idx]?.scrollIntoView({ block: 'nearest' });
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
  }

  /* ═════ Attachments ═════ */
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
    const data_url = await readAsDataURL(file);
    state.attachments.push({ kind: 'image', name: file.name || 'pasted.png', data_url });
    renderAttachments();
  }
  async function addFileAttachment(file) {
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
    const { tools, sops } = state.skills;
    const f = filter.trim().toLowerCase();
    const matches = (s) => !f || (s.title || '').toLowerCase().includes(f) ||
      (s.name || '').toLowerCase().includes(f) || (s.brief || '').toLowerCase().includes(f);

    const fTools = tools.filter(matches);
    const fSops = sops.filter(matches);

    $('tools-count').textContent = `${fTools.length}`;
    $('sops-count').textContent = `${fSops.length}`;
    $('tools-grid').innerHTML = fTools.map(skillCardHTML).join('') ||
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
    $('skills-categories').innerHTML = cats.map(c =>
      `<div class="skill-cat" data-cat="${c.key}"><span>${c.label}</span><span class="count">${c.count}</span></div>`
    ).join('');
    $('skills-stats').innerHTML = `
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
    const cls = kind === 'error' ? ' error' : kind === 'success' ? ' success' : '';
    t.className = 'info-toast' + cls;
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity 0.3s, transform 0.3s';
      t.style.opacity = '0'; t.style.transform = 'translateX(10px)';
      setTimeout(() => t.remove(), 300);
    }, 3500);
  }

  /* ═════ Theme toggle (light/dark) ═════ */
  function applyTheme(theme) {
    const root = document.documentElement;
    const isLight = theme === 'light';
    root.classList.toggle('theme-light', isLight);
    root.classList.toggle('theme-dark', !isLight);
    document.querySelectorAll('.theme-icon-dark')
      .forEach(el => el.classList.toggle('hidden', isLight));
    document.querySelectorAll('.theme-icon-light')
      .forEach(el => el.classList.toggle('hidden', !isLight));
    const tog = $('theme-toggle');
    if (tog) tog.checked = isLight;
  }
  const savedTheme = localStorage.getItem('ga-theme') || 'dark';
  applyTheme(savedTheme);
  // Bind theme-toggle (checkbox in settings panel, if exists)
  const themeToggle = $('theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('change', (e) => {
      const next = e.target.checked ? 'light' : 'dark';
      localStorage.setItem('ga-theme', next);
      applyTheme(next);
    });
  }
  // Bind theme-toggle-rail (icon button in icon rail)
  const themeToggleRail = $('theme-toggle-rail');
  if (themeToggleRail) {
    themeToggleRail.addEventListener('click', () => {
      const current = document.documentElement.classList.contains('theme-light') ? 'light' : 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      localStorage.setItem('ga-theme', next);
      applyTheme(next);
    });
  }

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
        return `<div class="settings-card p-4">
          <div class="flex items-center justify-between mb-2">
            <div class="text-[13px] text-frost-100 font-medium">${_esc(s.name)}</div>
            <span class="text-[11px] text-frost-400">${s.workers || 0} workers</span>
          </div>
          ${s.commands ? `<pre class="text-[11px] text-brand-300 bg-ink-900 p-2 rounded-lg font-mono whitespace-pre-wrap border border-white/5 max-h-[120px] overflow-y-auto">${_esc(s.commands)}</pre>` : ''}
        </div>`;
      }).join('');
    } catch(e) { $('hive-list').innerHTML = `<div class="text-red-300 text-[12.5px] p-4">加载失败: ${e.message}</div>`; }
  }

  async function _hiveCreate() {
    const name = $('hive-name').value.trim();
    if (!name) { showToast('请输入集群名称', 'error'); return; }
    const objective = $('hive-objective').value.trim();
    const workers = parseInt($('hive-workers').value) || 3;
    try {
      const data = await API.hiveCreate({ name, objective, workers });
      if (data.commands) {
        $('hive-commands').classList.remove('hidden');
        $('hive-commands-text').textContent = data.commands.join('\n\n');
        showToast('启动命令已生成，请复制到终端执行');
      }
      _loadHiveSessions();
    } catch(e) { showToast('创建失败: ' + e.message, 'error'); }
  }

  function _esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }

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
      listEl.innerHTML = servers.map(s => {
        const statusColor = s.connected ? '#4ade80' : '#ef4444';
        const statusText = s.connected ? '已连接' : '未连接';
        const toolsHtml = (s.tools || []).map(t =>
          `<div class="text-[10.5px] text-frost-300 py-0.5 px-2 rounded bg-white/5 truncate" title="${_esc(t.description || '')}">
            <span class="text-accent-violet">⬡</span> ${_esc(t.name)}
          </div>`
        ).join('');
        return `
          <div class="mcp-server-card bg-white/[0.03] border border-white/[0.06] rounded-xl p-3 space-y-2">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2 min-w-0">
                <span class="w-2 h-2 rounded-full shrink-0" style="background:${statusColor}"></span>
                <span class="text-[12px] font-medium text-frost-100 truncate">${_esc(s.name)}</span>
              </div>
              <div class="flex items-center gap-1">
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
            </div>
            <div class="text-[10.5px] text-frost-500">${_esc(s.type || 'http')} · ${statusText} · ${(s.tools || []).length}个工具</div>
            <div class="space-y-1">${toolsHtml || '<div class="text-[10.5px] text-frost-500">无工具</div>'}</div>
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
          showToast('测试连接中...', 'info');
          try {
            const r = await API.mcpTest(btn.dataset.server);
            showToast(r.ok ? '✅ 连接成功' : '❌ 连接失败', r.ok ? 'success' : 'error');
            loadMCPPanel();
          } catch (e) { showToast('测试失败: ' + e.message, 'error'); }
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

  /* ═════ Boot ═════ */
  lucide.createIcons();
  autoResize();
  inputEl.focus();
  // Fetch sessions immediately via HTTP (doesn't depend on WS connecting)
  refreshSessions();

  // ── Expose sophub functions to global scope for onclick ──
  window.openSophubDetail = openSophubDetail;
  window.downloadSophub = downloadSophub;
  window.sophubGo = sophubGo;
  window.sophubSearch = sophubSearch;
})();
