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
    on_stream: (m) => appendAssistantStream(m.full),
    on_done: (m) => { finalizeAssistant(m.payload); setRunning(false); refreshSessions(); },
    on_info: (m) => showToast(m.payload, 'info'),
    on_error: (m) => { showToast(m.payload, 'error'); setRunning(false); },
    on_auto_user: (m) => {
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
    autonomousHintText.textContent = state.autonomousEnabled ? '30分钟空闲后自动触发' : '已停止';
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
  document.querySelectorAll('#nav-tabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  $('rail-skills')?.addEventListener('click', () => {
    document.body.classList.remove('sidebar-collapsed');
    switchTab('skills');
  });

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('#nav-tabs .tab-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === tab));
    $('sidebar-chat').classList.toggle('hidden', tab !== 'chat');
    $('sidebar-chat').classList.toggle('flex', tab === 'chat');
    $('sidebar-skills').classList.toggle('hidden', tab !== 'skills');
    $('sidebar-skills').classList.toggle('flex', tab === 'skills');
    $('sidebar-settings').classList.toggle('hidden', tab !== 'settings');
    $('sidebar-settings').classList.toggle('flex', tab === 'settings');
    $('view-chat').classList.toggle('hidden', tab !== 'chat');
    $('view-chat').classList.toggle('flex', tab === 'chat');
    $('view-skills').classList.toggle('hidden', tab !== 'skills');
    $('view-settings').classList.toggle('hidden', tab !== 'settings');
    if (tab === 'skills') loadSkills();
    if (tab === 'settings') loadConfig();
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
    sessionsListEl.innerHTML = sessions.map(s => {
      const title = s.title || (s.preview || '(无预览)').replace(/\n/g, ' ');
      const displayTitle = escapeHTML(title.slice(0, 80));
      const rel = relTime(s.mtime);
      const active = state.currentSessionPath === s.path ? 'active' : '';
      const hint = s.title ? escapeAttr(s.preview || '') : escapeAttr(title);
      return `<div class="session-item ${active}" data-path="${escapeAttr(s.path)}" title="${hint}">
        <div class="session-title">${displayTitle}</div>
        <div class="session-meta">
          <span>${rel}</span>
          <span class="rounds">${s.rounds}轮</span>
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
        restoreAndShow(el.dataset.path);
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

  async function restoreAndShow(path) {
    if (!confirm('恢复此会话？当前上下文将被清空。')) return;
    try {
      const r = await API.restoreSession(path);
      state.currentSessionPath = path;
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
    const bodyHTML = parts.map((p, i) => renderPart(p, i)).join('');
    el.innerHTML = `
      <div class="msg-avatar">AI</div>
      <div class="msg-body">
        <div class="msg-header"><span class="msg-role">ASSISTANT</span></div>
        <div class="msg-content">${bodyHTML}</div>
      </div>`;
    // wire up collapsibles
    el.querySelectorAll('.part-thinking, .part-tool-use').forEach(p => {
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
      return `<div class="part part-tool-use open">
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

  $('btn-refresh-sessions').addEventListener('click', refreshSessions);

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
  $('sidebar-collapse').addEventListener('click', () => document.body.classList.add('sidebar-collapsed'));
  $('sidebar-expand').addEventListener('click', () => document.body.classList.remove('sidebar-collapsed'));

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
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      sendTask();
    }
    if (e.key === 'Escape' && state.running) { e.preventDefault(); API.send('abort'); }
  });
  sendBtn.addEventListener('click', () => {
    if (state.running) { API.send('abort'); }
    else { sendTask(); }
  });

  function sendTask() {
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
    $('sops-grid').innerHTML = fSops.map(skillCardHTML).join('') ||
      `<div class="col-span-full text-frost-400 text-sm text-center py-4">无匹配SOP</div>`;

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
        <span class="cta flex items-center gap-1">查看详情 <span>→</span></span>
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
  const themeToggle = $('theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('change', (e) => {
      const next = e.target.checked ? 'light' : 'dark';
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

  /* ═════ Boot ═════ */
  lucide.createIcons();
  autoResize();
  inputEl.focus();
  // Fetch sessions immediately via HTTP (doesn't depend on WS connecting)
  refreshSessions();
})();
