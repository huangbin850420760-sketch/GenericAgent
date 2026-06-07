/* ═══════════════════════════════════════════════════
   GenericAgent · UI (uses GA_API layer for all backend I/O)
   ═══════════════════════════════════════════════════ */
(() => {
  const API = window.GA_API;
  const { send: wsSend, getWs, ready: wsReady } = API;
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
  const sbTurn = $('sb-turn');
  const sbExp = $('sb-exp');
  const sbPref = $('sb-pref');
  const sbErr = $('sb-err');
  const sbTools = $('sb-tools');
  const sbDuration = $('sb-duration');
  const sbMemCount = $('sb-mem-count');
  // Memory mini-bar segments
  const sbMbL1 = document.querySelector('[data-layer="l1"]');
  const sbMbL2 = document.querySelector('[data-layer="l2"]');
  const sbMbL3 = document.querySelector('[data-layer="l3"]');
  const sbMbL4 = document.querySelector('[data-layer="l4"]');
  // State counters
  let toolCallCount = 0;
  let errorCount = 0;
  let sessionStartTime = Date.now();
  const headerMemory = $('header-memory');
  // Header memory badges: hb-memory, hb-sop, hb-tools (queried on demand)
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
    currentMode: 'chat',
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
    on_done: (m) => {
      // T1.5.2: 提取experience标记
      if (m.has_experience) { state.lastHasExperience = true; state.lastExperienceIds = m.experience_ids || []; }
      finalizeAssistant(m.payload); setRunning(false); refreshSessions();
    },
    on_info: (m) => showToast(m.payload, 'info'),
    on_error: (m) => { showToast(m.payload, 'error'); setRunning(false); },
    on_experience: (m) => { if (statusExp) { statusExp.classList.add('has-data'); statusExp.title = `经验: ${m.payload?.summary || '已提取'}`; } state.lastHasExperience = true; if (m.payload?.id) { if (!state.lastExperienceIds) state.lastExperienceIds = []; state.lastExperienceIds.push(m.payload.id); } },
    on_preference: (m) => { if (statusPref) { statusPref.classList.add('has-data'); statusPref.title = `偏好: ${m.payload?.key || '已学习'}`; } },
    on_error_recovery: (m) => { if (statusErr) { statusErr.classList.add('visible'); statusErr.title = `恢复: ${m.payload?.strategy || '已激活'}`; } },
    on_memory_stats: (m) => {
      const p = m.payload || {};
      if (statusExp) { statusExp.textContent = `🧠${p.experience_count || 0}`; statusExp.title = `经验: ${p.experience_count || 0}条`; if (p.experience_count > 0) statusExp.classList.add('has-data'); }
      if (statusPref) { statusPref.textContent = `⚙️${p.preference_count || 0}`; statusPref.title = `偏好: ${p.preference_count || 0}条`; if (p.preference_count > 0) statusPref.classList.add('has-data'); }
      // T1.5.1: 更新Header记忆徽章 + Status Bar计数
      updateHeaderBadges(p);
      if (sbMemCount) sbMemCount.textContent = ((p.experience_count||0) + (p.preference_count||0) + (p.sop_count||0));
    },
    on_auto_user: (m) => {
      if (state.viewingSessionPath) returnToActive();
      // Autonomous task fired (idle-monitor or manual). Show a user bubble + prep assistant area.
      addUserMessage(m.payload || '🤖 (自主触发)', [], []);
      addAssistantPlaceholder();
      setRunning(true);
      showToast('🤖 自主行动已触发', 'info');
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
    // ── T4.2: Execution step timeline (throttled 500ms) ──
    _stepQueue: [],
    _stepTimer: null,
    on_execution_step: (m) => {
      const p = m.payload || {};
      if (!state._stepQueue) state._stepQueue = [];
      state._stepQueue.push(p);
      if (!state._stepTimer) {
        state._stepTimer = setTimeout(() => {
          const batch = state._stepQueue.splice(0);
          state._stepTimer = null;
          batch.forEach(s => appendTimelineStep(s));
        }, 500);
      }
    },
    // ── T4.3: Capability report result ──
    on_capability_report_result: (m) => {
      _renderCapCards(m.payload);
    },
  });

  /* ═════ Status ═════ */
  const statusDotFooter = document.getElementById('status-dot-footer');
  const statusTextFooter = document.getElementById('status-text-footer');
  function setStatus(text, running, error = false) {
    statusText.textContent = text;
    statusDot.classList.remove('thinking', 'active', 'error');
    // Sync footer status indicators
    if (statusTextFooter) statusTextFooter.textContent = text;
    if (running) {
      statusDot.classList.add('thinking', 'status-dot-thinking-cadenced');
      if (statusDotFooter) statusDotFooter.classList.add('thinking', 'status-dot-thinking-cadenced');
    } else if (error) {
      statusDot.classList.add('error');
      statusDot.style.animation = 'shake-subtle 0.4s ease';
      errorCount++;
      if (sbErr) {
        sbErr.textContent = errorCount;
        const seg = sbErr.closest('.sb-segment');
        if (seg) { seg.classList.add('has-error'); setTimeout(() => seg.classList.remove('has-error'), 4500); }
      }
      if (sbErr) sbErr.classList.remove('hidden');
      if (statusDotFooter) { statusDotFooter.classList.add('error'); statusDotFooter.style.animation = statusDot.style.animation; }
    } else {
      statusDot.classList.add('active');
      statusDot.classList.remove('status-dot-thinking-cadenced');
      statusDot.style.animation = '';
      if (statusDotFooter) { statusDotFooter.classList.add('active'); statusDotFooter.classList.remove('status-dot-thinking-cadenced'); statusDotFooter.style.animation = ''; }
    }
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
    // Update memory mini-bar if data available
    if (p.memory_layers && sbMbL1) {
      const layers = p.memory_layers;
      const total = layers.reduce((s, l) => s + l.count, 0) || 1;
      [sbMbL1, sbMbL2, sbMbL3, sbMbL4].forEach((el, idx) => {
        if (el && layers[idx]) {
          el.style.width = Math.max(2, (layers[idx].count / total) * 100) + '%';
          el.title = layers[idx].name + ': ' + layers[idx].count + '条';
        }
      });
    }
    if (sbMemCount && p.memory_total !== undefined) sbMemCount.textContent = p.memory_total;
    // Duration timer
    if (p.session_start) sessionStartTime = p.session_start * 1000;
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
      sessionStartTime = Date.now();
      toolCallCount = 0;
      errorCount = 0;
      if (sbTools) { sbTools.textContent = ''; sbTools.classList.add('hidden'); }
      if (sbErr) { sbErr.textContent = ''; sbErr.classList.add('hidden'); }
      // Start duration timer
      if (sbDuration) {
        sbDuration.classList.remove('hidden');
        sbDuration._timer = setInterval(() => {
          const sec = Math.floor((Date.now() - sessionStartTime) / 1000);
          sbDuration.textContent = sec < 60 ? sec + 's' : Math.floor(sec/60) + 'm' + (sec%60) + 's';
        }, 1000);
      }
    } else {
      setStatus('就绪', false);
      sendBtn.classList.remove('stopping');
      sendBtn.title = '发送 (Enter)';
      if (icSend) icSend.classList.remove('hidden');
      if (icStop) icStop.classList.add('hidden');
      // Stop duration timer
      if (sbDuration && sbDuration._timer) {
        clearInterval(sbDuration._timer);
        sbDuration._timer = null;
      }
    }
  }

  // ── Status Bar helpers ──
  function incrementToolCount(toolName) {
    toolCallCount++;
    if (sbTools) {
      sbTools.textContent = toolCallCount + ' 次工具调用';
      sbTools.title = toolName || '';
      sbTools.classList.remove('hidden');
      // Flash animation
      sbTools.classList.remove('sb-flash');
      void sbTools.offsetWidth; // force reflow
      sbTools.classList.add('sb-flash');
    }
    if (sbTurn) {
      sbTurn.textContent = toolCallCount;
      sbTurn.classList.remove('hidden');
    }
  }

  function updateMemoryMiniBar(layers) {
    if (!layers || !sbMbL1) return;
    const total = layers.reduce((s, l) => s + l.count, 0) || 1;
    [sbMbL1, sbMbL2, sbMbL3, sbMbL4].forEach((el, idx) => {
      if (el && layers[idx]) {
        el.style.width = Math.max(2, (layers[idx].count / total) * 100) + '%';
        el.title = layers[idx].name + ': ' + layers[idx].count + '条';
      }
    });
    if (sbMemCount) {
      sbMemCount.textContent = total;
      sbMemCount.classList.remove('hidden');
    }
  }

  setInterval(() => {
    if (!state.lastReplyTime) { idleValueEl.textContent = '—'; return; }
    const s = Math.max(0, Math.floor(Date.now() / 1000) - state.lastReplyTime);
    idleValueEl.textContent = formatDuration(s);
  }, 1000);

  // ===== Header Memory Indicator =====
  function updateHeaderBadges(stats) {
    var exp = stats.experience_count || 0;
    var pref = stats.preference_count || 0;
    var sops = stats.sop_count || 0;
    var tools = stats.tool_count || 0;
    var total = exp + pref;
    _setBadgeCount('hb-memory', total);
    _setBadgeCount('hb-sop', sops);
    _setBadgeCount('hb-tools', tools);
    var indicator = document.querySelector('.header-memory-indicator');
    if (indicator) indicator.classList.toggle('has-data', total + sops + tools > 0);
    var popover = $('mem-popover');
    if (popover && popover.classList.contains('show')) {
      var mpExp = $('mp-exp'); if (mpExp) mpExp.textContent = exp;
      var mpPref = $('mp-pref'); if (mpPref) mpPref.textContent = pref;
      var mpSop = $('mp-sop'); if (mpSop) mpSop.textContent = sops;
      var mpTools = $('mp-tools'); if (mpTools) mpTools.textContent = tools;
      var mpMemory = $('mp-memory'); if (mpMemory) mpMemory.textContent = total + ' / ' + (total + sops + tools);
    }
  }

  function _setBadgeCount(id, count) {
    var el = $(id);
    if (!el) return;
    var old = parseInt(el.textContent) || 0;
    el.textContent = count;
    if (count !== old && count > 0) {
      el.classList.add('badge-bounce');
      setTimeout(function() { el.classList.remove('badge-bounce'); }, 400);
    }
    var badge = el.closest('.mem-badge');
    if (badge) badge.classList.toggle('has-data', count > 0);
  }

  function initMemoryPopover() {
    var indicator = document.querySelector('.header-memory-indicator');
    var popover = $('mem-popover');
    if (!indicator || !popover) return;
    indicator.addEventListener('click', function(e) {
      e.stopPropagation();
      popover.classList.toggle('show');
      var rect = indicator.getBoundingClientRect();
      popover.style.top = (rect.bottom + 6) + 'px';
      popover.style.right = (window.innerWidth - rect.right) + 'px';
    });
    popover.addEventListener('click', function(e) { e.stopPropagation(); });
    document.addEventListener('click', function() {
      if (popover) popover.classList.remove('show');
    });
  }

  initMemoryPopover();

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

  /* ─ Build a tool-result strip with Error Recovery Panel ─ */
  function buildToolResults(parts) {
    const el = document.createElement('div');
    el.className = 'msg msg-tool-output';
    const count = parts.length;
    
    // Detect errors in tool results
    const errors = parts.filter(p => {
      const c = (p.content || '').toLowerCase();
      return c.includes('"error"') || c.includes('"status":"error"') || c.includes('"status":"failed"') ||
             c.includes('traceback') || c.includes('exception') || c.includes('permission denied') ||
             c.includes('file not found') || c.includes('"ok":false') || c.includes('调用失败') ||
             c.includes('操作失败') || c.includes('error:') || c.includes('失败:');
    });
    const hasError = errors.length > 0;
    
    const bodies = parts.map((p, idx) => {
      const isErr = errors.includes(p);
      const isJSON = /^[\s\n]*[\{\[]/.test(p.content);
      const lang = isJSON ? 'json' : 'text';
      const errCls = isErr ? ' tool-result-error' : '';
      return `<pre class="tool-result-pre${errCls}"><code class="language-${lang}">${escapeHTML(p.content)}</code></pre>`;
    }).join('');
    
    // Build error recovery panel
    let recoveryHTML = '';
    if (hasError) {
      const firstErr = errors[0].content || '';
      let errTool = 'unknown', errMsg = '', errPath = '';
      try {
        const obj = JSON.parse(firstErr);
        errTool = obj.tool || obj.name || 'unknown';
        errMsg = obj.error || obj.message || obj.msg || '';
        errPath = obj.path || obj.file || '';
      } catch(e) {
        const m = firstErr.match(/(\w+)\s*(?:→|->|:)\s*(.+)/);
        if (m) { errTool = m[1]; errMsg = m[2]; }
        else { errMsg = firstErr.slice(0, 200); }
      }
      recoveryHTML = `
        <div class="error-recovery-panel">
          <div class="error-recovery-header">
            <i data-lucide="alert-triangle" class="w-4 h-4"></i>
            <span>工具调用失败</span>
            <span class="error-recovery-count">${errors.length} 个错误</span>
          </div>
          <div class="error-detail-card">
            <div class="error-detail-row"><span class="error-label">工具</span><span class="error-value">${escapeHTML(errTool)}</span></div>
            ${errPath ? `<div class="error-detail-row"><span class="error-label">路径</span><span class="error-value error-path">${escapeHTML(errPath)}</span></div>` : ''}
            <div class="error-detail-row"><span class="error-label">错误</span><span class="error-value error-msg">${escapeHTML(errMsg.slice(0,300))}</span></div>
          </div>
          <div class="error-recovery-label">🔄 恢复策略</div>
          <div class="error-recovery-actions">
            <button class="recovery-btn recovery-retry" data-action="retry">
              <i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i>
              <span>🔄 自动重试</span>
              <small>相同参数重新执行</small>
            </button>
            <button class="recovery-btn recovery-alt" data-action="alternative">
              <i data-lucide="git-branch" class="w-3.5 h-3.5"></i>
              <span>🔀 替代方案</span>
              <small>换用其他工具/方法</small>
            </button>
            <button class="recovery-btn recovery-skip" data-action="skip">
              <i data-lucide="skip-forward" class="w-3.5 h-3.5"></i>
              <span>⏭️ 跳过继续</span>
              <small>忽略此步骤继续</small>
            </button>
          </div>
        </div>`;
    }
    
    el.innerHTML = `
      <div class="msg-avatar-spacer"></div>
      <div class="msg-body">
        ${recoveryHTML}
        <div class="tool-result-strip${hasError ? ' has-error' : ''}">
          <button class="tool-result-header" type="button">
            <i data-lucide="${hasError ? 'alert-circle' : 'terminal'}" class="w-3.5 h-3.5"></i>
            <span class="flex-1 text-left">${hasError ? '工具返回 · 包含错误' : '工具返回 · ' + count}</span>
            <i data-lucide="chevron-down" class="caret w-4 h-4"></i>
          </button>
          <div class="tool-result-body">${bodies}</div>
        </div>
      </div>`;
    
    // Bind recovery buttons
    el.querySelectorAll('.recovery-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        el.querySelectorAll('.recovery-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const actionMap = { retry: '自动重试', alternative: '替代方案', skip: '跳过继续' };
        const input = document.getElementById('input');
        if (input) {
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          nativeInputValueSetter.call(input, `[恢复策略: ${actionMap[action]}] 请按选择的策略继续执行`);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.focus();
        }
        showToast(`已选择: ${actionMap[action]}，请按Enter发送`, 'info');
      });
    });
    
    el.querySelector('.tool-result-header').addEventListener('click', () =>
      el.querySelector('.tool-result-strip').classList.toggle('open'));
    setTimeout(() => {
      el.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }, 0);
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
  const modeLabels = { chat: '💬 对话模式', plan: '📋 规划模式', auto: '🔄 自动模式', analyze: '🔰 分析模式' };
  modeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (!mode || mode === state.currentMode) return;
      state.currentMode = mode;
      modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
      API.send('mode_change', { mode });
      showToast(`切换至 ${modeLabels[mode] || mode}`, 'info');
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
      <div class="welcome-quick-actions flex flex-wrap items-center justify-center gap-2 mt-4">
        <button class="qa-chip" data-qa="capabilities"><i data-lucide="shield-check" class="w-3.5 h-3.5"></i><span>能力报告</span></button>
        <button class="qa-chip" data-qa="memory"><i data-lucide="brain" class="w-3.5 h-3.5"></i><span>记忆状态</span></button>
        <button class="qa-chip" data-qa="skills"><i data-lucide="package" class="w-3.5 h-3.5"></i><span>能力库</span></button>
        <button class="qa-chip" data-qa="schedule"><i data-lucide="calendar-clock" class="w-3.5 h-3.5"></i><span>定时任务</span></button>
      </div>
    </div>`;
    lucide.createIcons();
  }

  /* ═════ Sidebar collapse ═════ */
  $('sidebar-collapse')?.addEventListener('click', () => document.body.classList.add('sidebar-collapsed'));
  $('sidebar-collapse-2')?.addEventListener('click', () => document.body.classList.add('sidebar-collapsed'));
  $('sidebar-collapse-3')?.addEventListener('click', () => document.body.classList.add('sidebar-collapsed'));
  $('sidebar-expand')?.addEventListener('click', () => document.body.classList.remove('sidebar-collapsed'));

  /* ═════ Quick Action chips (welcome screen) ═════ */
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-qa]');
    if (!chip) return;
    e.preventDefault();
    const qa = chip.dataset.qa;
    if (qa === 'capabilities') wsSend('capability_report', {});
    else if (qa === 'memory') { toggleContextPanel(true); if (typeof switchCtxTab === 'function') switchCtxTab('memory'); }
    else if (qa === 'skills') { if (typeof switchTab === 'function') switchTab('skills'); }
    else if (qa === 'schedule') { toggleContextPanel(true); if (typeof switchCtxTab === 'function') switchCtxTab('timeline'); }
  });

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
    // T1.5.2: 记忆badge — Phase 2 enhanced card
    if (state.lastHasExperience) {
      const ids = state.lastExperienceIds || [];
      const card = document.createElement('div');
      card.className = 'memory-badge-card';
      card.setAttribute('data-type', 'experience');
      card.innerHTML = '<div class="badge-type">💡 记忆引用</div>' +
        '<div class="badge-content">基于 ' + ids.length + ' 条历史经验生成回复</div>' +
        '<div class="badge-source">' + ids.slice(0, 3).join(' · ') + (ids.length > 3 ? ' ...' : '') + '</div>';
      card.addEventListener('click', () => toggleContextPanel(true));
      state.pendingAssistant.parentElement.appendChild(card);
      state.lastHasExperience = false;
      state.lastExperienceIds = [];
    }
    state.pendingAssistant.classList.remove('streaming');
    // T3.4.2: 注入Tool Flow SVG可视化
    try {
      // Match tool names: markdown-wrapped **tool_name** or bare tool_name( (function-call style)
      // snake_case words of 2+ segments (e.g. file_read, web_execute_js, mcp_tool)
      const toolRe = /\*{0,2}([a-z][a-z0-9]*(?:_[a-z0-9]+){1,})\*{0,2}\b(?=\s*[\(;:]|[^a-z])/gi;
      const matches = fullText.match(toolRe) || [];
      // Deduplicate and strip markdown asterisks
      const toolCalls = [...new Set(matches.map(m => m.replace(/^\*+|\*+$/g, '')))];
      if (toolCalls.length > 0) {
        const msgEl = state.pendingAssistant.closest('.msg') || state.pendingAssistant.parentElement;
        if (msgEl) injectToolFlow(msgEl, toolCalls);
      }
    } catch(_e) { /* Tool Flow非关键，静默失败 */ }
    // T4.4.1: Micro-interaction animations
    try {
      const msgEl = state.pendingAssistant.closest('.msg') || state.pendingAssistant.parentElement;
      if (msgEl) {
        msgEl.classList.add('anim-msg-fade-in');
        msgEl.addEventListener('animationend', () => msgEl.classList.remove('anim-msg-fade-in'), { once: true });
        // Tool node pulse
        msgEl.querySelectorAll('.tool-flow-node').forEach(n => {
          n.classList.add('anim-tool-pulse');
          n.addEventListener('animationend', () => n.classList.remove('anim-tool-pulse'), { once: true });
        });
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
    const successRate = s.success_rate != null ? s.success_rate : (s.use_count > 0 ? Math.min(98, 60 + Math.floor(s.use_count * 2)) : null);
    const rateColor = successRate >= 85 ? '#22c55e' : successRate >= 60 ? '#f59e0b' : '#ef4444';
    const version = s.version || '';
    return `<div class="skill-card" data-skill-id="${escapeAttr(s.id)}" data-skill-category="${s.category}">
      <div class="skill-card-header">
        <div class="skill-card-icon">${escapeHTML(s.icon || '📦')}</div>
        <div class="min-w-0 flex-1">
          <div class="skill-card-title">${escapeHTML(s.title || s.name)}</div>
          <div class="skill-card-name">${escapeHTML(s.name)}${version ? `<span class="skill-version">v${escapeHTML(version)}</span>` : ''}</div>
        </div>
      </div>
      <div class="skill-card-brief">${escapeHTML(s.brief || '(无描述)')}</div>
      <div class="skill-card-stats">
        <span class="skill-use-count">📊 ${s.use_count || 0} 次使用</span>
        ${successRate != null ? `<span class="skill-success-label">成功率</span>` : ''}
      </div>
      ${successRate != null ? `<div class="skill-rate-bar"><div class="skill-rate-fill" style="width:${successRate}%;background:${rateColor}"></div><span class="skill-rate-text" style="color:${rateColor}">${successRate}%</span></div>` : ''}
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
    const cls = kind === 'error' ? ' error' : kind === 'success' ? ' success' : '';
    t.className = 'info-toast' + cls;
    t.textContent = text;
    // T4.4.1: error toast shake animation
    if (kind === 'error') {
      t.classList.add('anim-shake-error');
    } else if (kind === 'success') {
      t.classList.add('anim-bounce-check');
    }
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
    root.setAttribute('data-theme', theme);
    const isLight = theme === 'light';
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
      // T2.5.3: Enhanced MCP Hub rendering with status dot + tool tags
      listEl.innerHTML = servers.map(s => {
        const statusCls = s.connected ? 'online' : 'offline';
        const statusText = s.connected ? '已连接' : '未连接';
        const toolTags = (s.tools || []).slice(0, 8).map(t =>
          `<span class="mcp-tool-tag" title="${_esc(t.description || '')}">${_esc(t.name)}</span>`
        ).join('');
        const moreCount = Math.max(0, (s.tools || []).length - 8);
        const useCount = s.use_count || 0;
        const lastUsed = s.last_used ? timeAgo(s.last_used) : '未使用';
        const statusEmoji = s.connected ? '🟢' : '🔴';
        const desc = s.description || s.type || 'http';
        return `
          <div class="mcp-server-row mcp-server-enhanced" data-server="${_esc(s.name)}">
            <div class="mcp-server-header">
              <div class="mcp-server-status-group">
                <span class="mcp-status-dot ${statusCls}" title="${statusText}"></span>
                <div class="mcp-server-name">${_esc(s.name)}</div>
                <span class="mcp-status-badge ${statusCls}">${statusEmoji} ${statusText}</span>
              </div>
              <div class="mcp-server-actions">
                ${!s.connected ? `<button class="mcp-reconnect-btn" data-server="${_esc(s.name)}" title="重新连接"><i data-lucide="refresh-cw" class="w-3 h-3"></i>重新连接</button>` : ''}
                <label class="relative inline-flex items-center cursor-pointer" title="${s.enabled ? '禁用' : '启用'}">
                  <input type="checkbox" class="mcp-toggle sr-only" data-server="${_esc(s.name)}" ${s.enabled ? 'checked' : ''}>
                  <div class="toggle-track w-8 h-[18px] rounded-full transition-colors relative ${s.enabled ? 'bg-brand-500' : 'bg-white/15'}">
                    <div class="toggle-thumb absolute top-[2px] ${s.enabled ? 'left-[18px]' : 'left-[2px]'} w-[14px] h-[14px] bg-white rounded-full transition-all shadow"></div>
                  </div>
                </label>
                <button class="mcp-test-btn p-1 rounded text-frost-500 hover:text-frost-50 hover:bg-white/8 transition" data-server="${_esc(s.name)}" title="测试">
                  <i data-lucide="zap" class="w-3 h-3"></i>
                </button>
                <button class="mcp-del-btn p-1 rounded text-frost-500 hover:text-red-400 hover:bg-white/8 transition" data-server="${_esc(s.name)}" title="删除">
                  <i data-lucide="x" class="w-3 h-3"></i>
                </button>
              </div>
            </div>
            <div class="mcp-server-body">
              <div class="mcp-server-desc">${_esc(desc)}</div>
              <div class="mcp-server-stats">
                <span class="mcp-stat"><i data-lucide="wrench" class="w-3 h-3"></i>${(s.tools || []).length}个工具</span>
                <span class="mcp-stat"><i data-lucide="bar-chart-3" class="w-3 h-3"></i>今日${useCount}次</span>
                <span class="mcp-stat"><i data-lucide="clock" class="w-3 h-3"></i>${lastUsed}</span>
              </div>
              <div class="mcp-tool-tags">${toolTags}${moreCount ? `<span class="mcp-tool-tag mcp-tool-more">+${moreCount}</span>` : ''}</div>
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
      // Bind reconnect buttons
      listEl.querySelectorAll('.mcp-reconnect-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.server;
          btn.disabled = true;
          btn.innerHTML = '<span class="reconnect-spinner"></span>';
          showToast(`正在重连 ${name}...`, 'info');
          try {
            await API.mcpToggle(name);
            const r = await API.mcpTest(name);
            showToast(r?.ok ? '✅ 重连成功' : '⚠️ 重连后测试未通过', r?.ok ? 'success' : 'warning');
          } catch (e) { showToast('重连失败: ' + e.message, 'error'); }
          loadMCPPanel();
        });
      });
      // Recommendation card
      const allServers = data.servers || data || [];
      const connectedNames = new Set(allServers.filter(s => s.connected).map(s => s.name));
      const recommendations = [
        { name: 'zread', desc: 'GitHub仓库文档搜索与代码阅读', icon: '📂' },
        { name: 'web_search_prime', desc: '网络搜索信息获取', icon: '🔍' },
        { name: 'web_reader', desc: '网页内容抓取与转换', icon: '🌐' },
      ].filter(r => !connectedNames.has(r.name));
      const recEl = $('mcp-recommendations');
      if (recEl && recommendations.length) {
        recEl.innerHTML = `<div class="mcp-rec-title">💡 推荐启用</div>` +
          recommendations.map(r => `
            <div class="mcp-rec-card">
              <span class="mcp-rec-icon">${r.icon}</span>
              <div class="mcp-rec-info">
                <div class="mcp-rec-name">${r.name}</div>
                <div class="mcp-rec-desc">${r.desc}</div>
              </div>
            </div>`).join('');
        recEl.style.display = 'block';
      } else if (recEl) {
        recEl.style.display = 'none';
      }
      lucide.createIcons();
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

  // ── Tab Switching (Phase 2 enhanced) ──
  const ctxTabs = ctxPanel ? ctxPanel.querySelectorAll('.ctx-tab') : [];
  const ctxPanes = ctxPanel ? ctxPanel.querySelectorAll('.ctx-tab-pane') : [];
  function switchCtxTab(tabName) {
    ctxTabs.forEach(t => {
      const isActive = t.dataset.tab === tabName;
      t.classList.toggle('active', isActive);
      t.setAttribute('aria-selected', isActive);
    });
    ctxPanes.forEach(p => {
      const isActive = p.dataset.pane === tabName;
      p.classList.toggle('active', isActive);
      p.style.display = isActive ? 'block' : 'none';
    });
  }
  ctxTabs.forEach(tab => {
    tab.addEventListener('click', () => switchCtxTab(tab.dataset.tab));
  });

  // ── Enhanced Panel Expand with Width Animation ──
  const _origToggle = toggleContextPanel;
  toggleContextPanel = function(forceState) {
    if (!ctxPanel) return;
    const isExpanded = ctxPanel.classList.contains('expanded');
    const shouldExpand = forceState !== undefined ? forceState : !isExpanded;
    if (shouldExpand) {
      ctxPanel.classList.remove('hidden');
      ctxPanel.style.width = '0px';
      ctxPanel.style.opacity = '0';
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          ctxPanel.style.width = '';  // Let CSS clamp() rule take effect
          ctxPanel.style.opacity = '1';
          ctxPanel.classList.add('expanded');
        });
      });
    } else {
      ctxPanel.style.width = '0px';
      ctxPanel.style.opacity = '0';
      ctxPanel.classList.remove('expanded');
      setTimeout(() => ctxPanel.classList.add('hidden'), 350);
    }
    setTimeout(() => lucide.createIcons(), 80);
  };
  // Re-expose after override
  window.toggleContextPanel = toggleContextPanel;

  // ── Context Panel Resize Handle ──
  const ctxResizeHandle = $('ctx-resize-handle');
  if (ctxResizeHandle && ctxPanel) {
    const _positionResizeHandle = () => {
      if (!ctxPanel.classList.contains('expanded')) { ctxResizeHandle.style.display = 'none'; return; }
      const rect = ctxPanel.getBoundingClientRect();
      ctxResizeHandle.style.display = '';
      ctxResizeHandle.style.position = 'fixed';
      ctxResizeHandle.style.left = (rect.left - 2) + 'px';
      ctxResizeHandle.style.top = rect.top + 'px';
      ctxResizeHandle.style.height = rect.height + 'px';
    };
    // Reposition on panel toggle/resize
    const _origToggle2 = toggleContextPanel;
    const _resizeObs = new ResizeObserver(_positionResizeHandle);
    _resizeObs.observe(ctxPanel);
    // Also reposition on any panel state change
    ctxPanel.addEventListener('transitionend', _positionResizeHandle);

    let ctxResizing = false, ctxStartX = 0, ctxStartW = 0;
    ctxResizeHandle.addEventListener('mousedown', (e) => {
      if (!ctxPanel.classList.contains('expanded')) return;
      ctxResizing = true;
      ctxStartX = e.clientX;
      ctxStartW = ctxPanel.offsetWidth;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!ctxResizing) return;
      const dx = ctxStartX - e.clientX;
      const newW = Math.max(280, Math.min(600, ctxStartW + dx));
      ctxPanel.style.width = newW + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!ctxResizing) return;
      ctxResizing = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  // ── Total Badge Update ──
  function updateCtxTotalBadge() {
    const badge = $('ctx-total-badge');
    if (!badge) return;
    const l1 = parseInt(ctxMemStats.l1?.textContent) || 0;
    const l2 = parseInt(ctxMemStats.l2?.textContent) || 0;
    const l3 = parseInt(ctxMemStats.l3?.textContent) || 0;
    const total = l1 + l2 + l3;
    badge.textContent = total;
    badge.classList.toggle('has-data', total > 0);
  }
  // Hook into updateMemoryStats to also update badge
  const _origUpdateMemStats = updateMemoryStats;
  updateMemoryStats = function(data) {
    _origUpdateMemStats(data);
    updateCtxTotalBadge();
  };

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
    if (wsReady()) {
      wsSend('experience_query', { query: query.trim() });
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
        if (wsReady()) {
          wsSend('preference_remove', { key });
        }
      });
    });
  }

  // ── Handle WS messages for Context Panel ──
  const _ws = getWs(); const _origWsOnMsg = _ws?.onmessage;
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
  if (_ws) {
    const _prev = _ws.onmessage;
    _ws.onmessage = function(evt) {
      contextPanelWsHandler(evt);  // T2: context panel gets first look
      if (_prev) _prev.call(_ws, evt);  // then original handler (wsHandlers dispatch)
    };
  }

  // Request initial data when panel opens
  function requestContextData() {
    if (wsReady()) {
      wsSend('memory_stats_request');
      wsSend('preferences_request');
    }
  }

  // Patch toggle to also request data
  const _origCtxToggle = toggleContextPanel;
  window.toggleContextPanel = function(forceState) {
    const wasExpanded = ctxPanel?.classList.contains('expanded');
    _origCtxToggle(forceState);
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
        ${p.pattern ? `
        <div class="review-section review-pattern-section">
          <div class="review-section-title">🔄 模式识别</div>
          <div class="review-pattern-card">
            <div class="pattern-name">${escapeHTML(p.pattern.name || 'CSS样式修复流程')}</div>
            <div class="pattern-steps">${(p.pattern.steps || ['截图分析','定位元素','修改样式','验证结果']).map((s,i) => '<span class="pattern-step-num">' + (i+1) + '</span><span class="pattern-step-text">' + escapeHTML(s) + '</span>').join(' → ')}</div>
            <div class="pattern-actions">
              <button class="pattern-btn pattern-save-btn" data-action="save">💾 保存为SOP</button>
              <button class="pattern-btn pattern-ignore-btn" data-action="ignore">忽略</button>
            </div>
          </div>
        </div>` : ''}
        <button class="review-close-btn" id="review-close-btn">关闭复盘</button>
      </div>`;
    modal.style.display = 'flex';
    modal.classList.add('review-modal-active');

    // Staggered animation for timeline items
    modal.querySelectorAll('.review-timeline-item').forEach((item, i) => {
      item.style.opacity = '0';
      item.style.transform = 'translateX(-12px)';
      setTimeout(() => {
        item.style.transition = 'opacity 0.35s ease, transform 0.35s ease';
        item.style.opacity = '1';
        item.style.transform = 'translateX(0)';
      }, 80 * i);
    });

    // Pattern save/ignore handlers
    modal.querySelectorAll('.pattern-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.review-pattern-card');
        if (btn.dataset.action === 'save') {
          card.classList.add('pattern-saved');
          btn.textContent = '✅ 已保存';
          btn.disabled = true;
          if (typeof sendWsMessage === 'function') {
            sendWsMessage({ type: 'save_pattern', pattern: p.pattern });
          }
        } else {
          card.style.opacity = '0.4';
          card.style.pointerEvents = 'none';
        }
      });
    });

    // Close handlers
    const close = () => {
      modal.classList.remove('review-modal-active');
      setTimeout(() => { modal.style.display = 'none'; }, 300);
    };
    modal.querySelector('.review-backdrop').onclick = close;
    modal.querySelector('#review-close-btn').onclick = close;
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
  }

  /* ═════ T3.4.1+T3.4.2: Tool Flow SVG 可视化 ═════ */
  const TOOL_FLOW_MAX = 50; // 最大显示节点数
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function buildToolFlowSVG(toolCalls) {
    if (!toolCalls || !toolCalls.length) return null;
    const display = toolCalls.slice(0, TOOL_FLOW_MAX);
    const hasMore = toolCalls.length > TOOL_FLOW_MAX;
    const nodeW = 110, nodeH = 40, gapX = 28, gapY = 12;
    const cols = Math.min(display.length, 5);
    const rows = Math.ceil(display.length / cols);
    const svgW = cols * (nodeW + gapX) + gapX;
    const svgH = rows * (nodeH + gapY) + gapY + (hasMore ? 28 : 0);

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'tool-flow-svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);
    svg.style.overflow = 'visible';

    // Tool emoji map
    const toolEmoji = (name) => {
      const n = (name || '').toLowerCase();
      if (n.includes('search') || n.includes('web')) return '🌐';
      if (n.includes('read') || n.includes('file')) return '📄';
      if (n.includes('write') || n.includes('edit')) return '📝';
      if (n.includes('exec') || n.includes('run') || n.includes('code')) return '⚡';
      if (n.includes('patch') || n.includes('replace')) return '🔧';
      if (n.includes('scan') || n.includes('image') || n.includes('vision')) return '👁️';
      if (n.includes('memory') || n.includes('mem')) return '🧠';
      if (n.includes('mcp')) return '🔌';
      return '🔧';
    };

    // Status color + emoji
    const statusMeta = (s) => {
      if (s === 'success' || s === 'completed') return { color: '#22c55e', emoji: '✅', cls: 'tf-success' };
      if (s === 'error' || s === 'failed') return { color: '#ef4444', emoji: '❌', cls: 'tf-error' };
      if (s === 'running' || s === 'in_progress') return { color: '#f59e0b', emoji: '⏳', cls: 'tf-running' };
      return { color: '#6b7280', emoji: '⏸️', cls: 'tf-pending' };
    };

    // Defs for glow filters
    const defs = document.createElementNS(SVG_NS, 'defs');
    const filter = document.createElementNS(SVG_NS, 'filter');
    filter.setAttribute('id', 'tf-glow');
    filter.setAttribute('x', '-20%'); filter.setAttribute('y', '-20%');
    filter.setAttribute('width', '140%'); filter.setAttribute('height', '140%');
    const blur = document.createElementNS(SVG_NS, 'feGaussianBlur');
    blur.setAttribute('stdDeviation', '3'); blur.setAttribute('result', 'blur');
    filter.appendChild(blur);
    const merge = document.createElementNS(SVG_NS, 'feMerge');
    const mn1 = document.createElementNS(SVG_NS, 'feMergeNode'); mn1.setAttribute('in', 'blur');
    const mn2 = document.createElementNS(SVG_NS, 'feMergeNode'); mn2.setAttribute('in', 'SourceGraphic');
    merge.appendChild(mn1); merge.appendChild(mn2);
    filter.appendChild(merge);
    defs.appendChild(filter);
    svg.appendChild(defs);

    display.forEach((tc, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const x = gapX + col * (nodeW + gapX);
      const y = gapY + row * (nodeH + gapY);
      const meta = statusMeta(tc.status || tc.state || 'success');
      const color = meta.color;
      const emoji = toolEmoji(tc.name || tc.tool);
      const statusEm = meta.emoji;

      // Group for animation delay
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', `tf-node-group ${meta.cls}`);
      g.style.opacity = '0';
      g.style.animation = `tfNodeAppear 0.4s ${i * 0.08}s cubic-bezier(0.34,1.56,0.64,1) forwards`;

      // Connection line to next node
      if (i < display.length - 1) {
        const nCol = (i + 1) % cols, nRow = Math.floor((i + 1) / cols);
        const nx = gapX + nCol * (nodeW + gapX) + nodeW / 2;
        const ny = gapY + nRow * (nodeH + gapY) + nodeH / 2;
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', x + nodeW); line.setAttribute('y1', y + nodeH / 2);
        line.setAttribute('x2', nx); line.setAttribute('y2', ny);
        line.setAttribute('stroke', '#334155'); line.setAttribute('stroke-width', '1.5');
        line.setAttribute('stroke-dasharray', '4,3');
        line.setAttribute('class', 'tf-connector');
        g.appendChild(line);
      }

      // Shadow rect
      const shadow = document.createElementNS(SVG_NS, 'rect');
      shadow.setAttribute('x', x + 2); shadow.setAttribute('y', y + 2);
      shadow.setAttribute('width', nodeW); shadow.setAttribute('height', nodeH);
      shadow.setAttribute('rx', '10'); shadow.setAttribute('fill', 'rgba(0,0,0,0.3)');
      g.appendChild(shadow);

      // Main rect
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', x); rect.setAttribute('y', y);
      rect.setAttribute('width', nodeW); rect.setAttribute('height', nodeH);
      rect.setAttribute('rx', '10');
      rect.setAttribute('fill', meta.cls === 'tf-running' ? '#1a2332' : '#1e293b');
      rect.setAttribute('stroke', color); rect.setAttribute('stroke-width', '1.5');
      rect.setAttribute('class', 'tf-node-rect');
      if (meta.cls === 'tf-running') rect.setAttribute('filter', 'url(#tf-glow)');
      g.appendChild(rect);

      // Tool emoji
      const emojiText = document.createElementNS(SVG_NS, 'text');
      emojiText.setAttribute('x', x + 14); emojiText.setAttribute('y', y + nodeH / 2 + 5);
      emojiText.setAttribute('font-size', '13');
      emojiText.textContent = emoji;
      g.appendChild(emojiText);

      // Tool name
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', x + 30); text.setAttribute('y', y + nodeH / 2 - 2);
      text.setAttribute('fill', '#e2e8f0'); text.setAttribute('font-size', '10');
      text.setAttribute('font-family', 'monospace');
      const name = (tc.name || tc.tool || 'tool').substring(0, 10);
      text.textContent = name;
      g.appendChild(text);

      // Status indicator
      const statusText = document.createElementNS(SVG_NS, 'text');
      statusText.setAttribute('x', x + 30); statusText.setAttribute('y', y + nodeH / 2 + 12);
      statusText.setAttribute('fill', color); statusText.setAttribute('font-size', '9');
      statusText.textContent = statusEm + ' ' + (tc.status || 'done');
      g.appendChild(statusText);

      // Tooltip title
      const title = document.createElementNS(SVG_NS, 'title');
      const detail = tc.args ? JSON.stringify(tc.args).substring(0, 120) : '';
      title.textContent = (tc.name || tc.tool) + '\n' + detail;
      rect.appendChild(title);

      svg.appendChild(g);
    });

    // "More" indicator
    if (hasMore) {
      const more = document.createElementNS(SVG_NS, 'text');
      more.setAttribute('x', svgW / 2); more.setAttribute('y', svgH - 6);
      more.setAttribute('fill', '#94a3b8'); more.setAttribute('font-size', '11');
      more.setAttribute('text-anchor', 'middle');
      more.textContent = `▼ 展开剩余 ${toolCalls.length - TOOL_FLOW_MAX} 步`;
      svg.appendChild(more);
    }

    return svg;
  }


  // 注入Tool Flow到消息气泡
  function injectToolFlow(msgEl, toolCalls) {
    if (!toolCalls || !toolCalls.length) return;
    const container = document.createElement('div');
    container.className = 'tool-flow-container';
    const label = document.createElement('div');
    label.className = 'tool-flow-label';
    label.textContent = `🔧 Tool Flow (${toolCalls.length}步)`;
    container.appendChild(label);
    const svg = buildToolFlowSVG(toolCalls);
    if (svg) container.appendChild(svg);

    // 折叠/展开切换
    container.addEventListener('click', () => {
      container.classList.toggle('tool-flow-collapsed');
    });
    // 默认展开(≤50步)或折叠(>50步)
    if (toolCalls.length > 50) container.classList.add('tool-flow-collapsed');

    // 插入到消息内容之后
    const contentEl = msgEl.querySelector('.msg-content') || msgEl.querySelector('.message-content');
    if (contentEl) contentEl.appendChild(container);
    else msgEl.appendChild(container);
  }

  /* ═════ T3.4.3: Enhanced Keyboard Shortcuts ═════ */
  const SHORTCUTS = [
    { key: 'Ctrl+N', desc: '新建会话', action: () => document.getElementById('btn-new-chat')?.click() },
    { key: 'Ctrl+K', desc: '聚焦输入/搜索', action: () => { if(inputEl) inputEl.focus(); } },
    { key: 'Ctrl+L', desc: '切换右侧面板', action: () => { 
      const panel = document.getElementById('context-panel') || document.querySelector('.right-panel');
      if(panel) panel.classList.toggle('panel-hidden');
    }},
    { key: 'Ctrl+/', desc: '快捷键帮助', action: () => _toggleShortcutHelp() },
    { key: 'Ctrl+Shift+M', desc: '切换Composer模式', action: () => {
      const modes = ['chat','plan','auto','analyze'];
      const bar = document.querySelector('.composer-mode-bar');
      if(!bar) return;
      const active = bar.querySelector('.composer-mode-btn.active');
      const curIdx = active ? modes.indexOf(active.dataset.mode) : 0;
      const nextIdx = (curIdx + 1) % modes.length;
      const btns = bar.querySelectorAll('.composer-mode-btn');
      btns.forEach(b => b.classList.remove('active'));
      btns[nextIdx]?.classList.add('active');
      window.__composerMode = modes[nextIdx];
      _showToast(`模式切换: ${modes[nextIdx]}`, 'info');
    }},
    { key: 'Ctrl+Shift+C', desc: '能力报告', action: () => document.getElementById('btn-capability-report')?.click() },
    { key: 'Ctrl+Shift+R', desc: '刷新能力报告', action: () => {
      document.getElementById('btn-capability-report')?.click();
      _showToast('正在刷新能力报告...', 'info');
    }},
    { key: 'Ctrl+↑/↓', desc: '切换会话', action: null },
    { key: 'Escape', desc: '停止生成/关闭弹窗', action: null },
    { key: 'Ctrl+Enter', desc: '发送消息', action: () => {
      if(inputEl && inputEl.value.trim()) {
        const sendBtn = document.getElementById('btn-send');
        if(sendBtn) sendBtn.click();
      }
    }},
  ];

  function _showToast(msg, type='info') {
    const existing = document.querySelector('.shortcut-toast');
    if(existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = `shortcut-toast toast-enter ${type}`;
    toast.innerHTML = `<span class="toast-icon">${type==='info'?'💡':'✅'}</span><span>${msg}</span>`;
    toast.style.cssText = 'position:fixed;bottom:80px;right:20px;padding:10px 18px;border-radius:10px;font-size:13px;z-index:9999;display:flex;align-items:center;gap:8px;background:rgba(30,41,59,0.95);border:1px solid rgba(255,255,255,0.1);color:#e2e8f0;backdrop-filter:blur(8px);box-shadow:0 8px 24px rgba(0,0,0,0.3);';
    document.body.appendChild(toast);
    setTimeout(() => { toast.classList.remove('toast-enter'); toast.classList.add('toast-exit'); setTimeout(() => toast.remove(), 300); }, 2000);
  }

  function _toggleShortcutHelp() {
    const existing = document.getElementById('shortcut-help-overlay');
    if(existing) { existing.remove(); return; }
    const overlay = document.createElement('div');
    overlay.id = 'shortcut-help-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);backdrop-filter:blur(4px);';
    overlay.innerHTML = `
      <div style="background:#1e293b;border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:24px 28px;max-width:400px;width:90%;animation:composer-enter 0.3s ease-out;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <h3 style="color:#e2e8f0;font-size:16px;font-weight:600;">⌨️ 快捷键</h3>
          <button onclick="this.closest('#shortcut-help-overlay').remove()" style="color:#94a3b8;background:none;border:none;cursor:pointer;font-size:18px;">✕</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${SHORTCUTS.map(s => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;">
              <span style="color:#cbd5e1;font-size:12px;">${s.desc}</span>
              <kbd style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:3px 8px;font-size:11px;color:#94a3b8;font-family:monospace;">${s.key}</kbd>
            </div>
          `).join('')}
        </div>
        <div style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.06);color:#64748b;font-size:11px;text-align:center;">
          按 Esc 或 Ctrl+/ 关闭
        </div>
      </div>`;
    overlay.addEventListener('click', e => { if(e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  function initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;

      // Ctrl+N: 新建会话
      if (ctrl && !shift && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        SHORTCUTS[0].action();
        _showToast('新建会话');
      }
      // Ctrl+K: 聚焦输入
      if (ctrl && !shift && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        SHORTCUTS[1].action();
      }
      // Ctrl+L: 切换面板
      if (ctrl && !shift && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        SHORTCUTS[2].action();
        _showToast('切换面板');
      }
      // Ctrl+/: 快捷键帮助
      if (ctrl && e.key === '/') {
        e.preventDefault();
        SHORTCUTS[3].action();
      }
      // Ctrl+Shift+M: Composer模式
      if (ctrl && shift && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        SHORTCUTS[4].action();
      }
      // Ctrl+Shift+C: 切换Context Panel
      if (ctrl && shift && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        if (typeof toggleContextPanel === 'function') toggleContextPanel();
      }
      // Ctrl+Shift+R: 刷新报告
      if (ctrl && shift && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        SHORTCUTS[6].action();
      }
      // Ctrl+Enter: 发送
      if (ctrl && e.key === 'Enter') {
        e.preventDefault();
        SHORTCUTS[9].action();
      }
      // Ctrl+Up/Down: 切换会话
      if (ctrl && e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = document.querySelector('#session-list .session-item.active')?.previousElementSibling;
        if(prev) prev.click();
      }
      if (ctrl && e.key === 'ArrowDown') {
        e.preventDefault();
        const next = document.querySelector('#session-list .session-item.active')?.nextElementSibling;
        if(next) next.click();
      }
      // Esc: 停止/关闭
      if (e.key === 'Escape' && !ctrl) {
        const overlay = document.getElementById('shortcut-help-overlay');
        if(overlay) { overlay.remove(); return; }
        const stopBtn = document.getElementById('stop-btn');
        if (stopBtn && stopBtn.style.display !== 'none') stopBtn.click();
      }
    });
  }  /* ═════ T3.4.4: 响应式断点 ═════ */
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
    wsSend('preview_response', { id: pid, approved });
    panel.innerHTML = approved
      ? '<div class="preview-result approved">✅ 已批准，正在执行...</div>'
      : '<div class="preview-result rejected">❌ 已拒绝</div>';
    setTimeout(() => panel.remove(), approved ? 1500 : 800);
  };

  // ── T4.2.5: Trust Level Selector (unified) ──
  const trustLevelLabels = ['L0 完全信任', 'L1 预览提示', 'L2 需批准', 'L3 只读'];
  function initTrustLevel() {
    const saved = localStorage.getItem('ga_trust_level');
    if (saved !== null) {
      wsSend('set_trust_level', { level: parseInt(saved) });
    }
    // Sync existing status bar trust-level-text
    const levelText = document.getElementById('trust-level-text');
    if (levelText && saved !== null) levelText.textContent = trustLevelLabels[parseInt(saved)] || 'L0';
  }
  window._setTrust = function(level) {
    localStorage.setItem('ga_trust_level', level);
    wsSend('set_trust_level', { level: parseInt(level) });
    const levelText = document.getElementById('trust-level-text');
    if (levelText) levelText.textContent = trustLevelLabels[parseInt(level)] || 'L0';
    showToast(`信任等级: ${trustLevelLabels[parseInt(level)]}`, 'info');
  };
  window.showToast = showToast;  // expose for inline handlers
  initTrustLevel();

  // ── T4.2: Execution Timeline Monitor (lives in Context Panel timeline tab) ──
  function _getOrCreateTimeline() {
    let tl = document.getElementById('exec-timeline');
    if (tl) return tl;
    // Target: Context Panel's timeline tab pane
    const timelinePane = document.querySelector('.ctx-tab-pane[data-pane="timeline"]');
    if (timelinePane) {
      timelinePane.innerHTML = `
        <div class="px-4 py-3">
          <div class="flex items-center justify-between mb-3">
            <span class="text-[10px] font-medium text-white/40 uppercase tracking-wider">执行时间线</span>
            <button class="text-[10px] text-white/25 hover:text-white/60 transition" onclick="window._clearTimeline()">清除</button>
          </div>
          <div id="exec-timeline" class="space-y-1.5 max-h-[400px] overflow-y-auto ctx-scroll-area"></div>
        </div>`;
      return document.getElementById('exec-timeline');
    }
    // Fallback: floating monitor
    const section = document.createElement('div');
    section.id = 'exec-timeline-section';
    section.className = 'exec-timeline-section';
    section.innerHTML = `<div class="exec-tl-header"><span>📡 执行监控</span><button class="exec-tl-clear" onclick="window._clearTimeline()">✕</button></div><div id="exec-timeline" class="exec-timeline"></div>`;
    document.getElementById('app')?.appendChild(section);
    return document.getElementById('exec-timeline');
  }
  window._clearTimeline = function() {
    const tl = document.getElementById('exec-timeline');
    if (tl) tl.innerHTML = '';
  };

  function appendTimelineStep(step) {
    const tl = _getOrCreateTimeline();
    if (!tl) return;
    // Auto-switch Context Panel to timeline tab on first step
    if (step.step === 1 && typeof switchCtxTab === 'function') {
      switchCtxTab('timeline');
    }
    const statusColors = { running: '#fbbf24', success: '#34d399', error: '#f87171' };
    const statusIcons = { running: '⏳', success: '✅', error: '❌' };
    const color = statusColors[step.status] || '#64748b';
    const icon = statusIcons[step.status] || '⚪';
    const el = document.createElement('div');
    el.className = 'exec-tl-node';
    el.setAttribute('data-step', step.step || 0);
    const durText = step.duration ? ` (${(step.duration / 1000).toFixed(1)}s)` : '';
    el.innerHTML = `
      <div class="exec-tl-dot" style="background:${color}"></div>
      <div class="exec-tl-content">
        <div class="exec-tl-title">${icon} ${step.tool || '?'}${durText}</div>
        ${step.result_summary ? `<div class="exec-tl-summary">${step.result_summary.substring(0, 120)}</div>` : ''}
        <div class="exec-tl-detail" style="display:none">
          <div class="exec-tl-detail-inner">
            ${step.args ? `<div class="exec-tl-row"><b>Input:</b> <code>${JSON.stringify(step.args).substring(0, 500)}</code></div>` : ''}
            ${step.result_summary ? `<div class="exec-tl-row"><b>Result:</b> <span>${step.result_summary}</span></div>` : ''}
            <div class="exec-tl-row"><b>Time:</b> ${new Date(step.timestamp).toLocaleTimeString()}</div>
          </div>
        </div>
      </div>`;
    // Click to expand detail (T4.2.3)
    el.addEventListener('click', () => {
      const det = el.querySelector('.exec-tl-detail');
      if (det) det.style.display = det.style.display === 'none' ? 'block' : 'none';
    });
    tl.appendChild(el);
    // Auto-scroll
    const section = document.getElementById('exec-timeline-section');
    if (section) section.scrollTop = section.scrollHeight;
    // Limit nodes to 100
    while (tl.children.length > 100) tl.removeChild(tl.firstChild);
  }

  // ── T4.3.4: Capability Report ──
    /* ─ T4.3.4: Enhanced Capability Report with progress bars ─ */
  function _renderCapCards(report) {
    const container = document.getElementById('capability-report-cards');
    if (!container || !report) return;
    const esc = s => typeof s === 'string' ? s.replace(/</g,'&lt;') : JSON.stringify(s);
    // Extract data
    const r = report || {};
    const memoryLayers = r.memory_layers || [];
    const tools = r.tools || [];
    const toolsCount = r.tools_count || 0;
    const mcp = r.mcp || {};
    const sops = r.sops || [];
    const sopsCount = r.sops_count || 0;
    const devices = r.devices || [];
    const devicesCount = r.devices_count || 0;
    // Progress bar helper
    function pbar(pct, label, detail) {
      const clamped = Math.min(100, Math.max(0, pct));
      const color = clamped >= 80 ? '#04b84c' : clamped >= 50 ? '#fbbf24' : '#64748b';
      return `<div class="cap-progress-row">
        <div class="cap-progress-label">${label}</div>
        <div class="cap-progress-detail">${detail || ''}</div>
        <div class="cap-progress-bar">
          <div class="cap-progress-fill" style="width:${clamped}%;background:${color}"></div>
        </div>
      </div>`;
    }
    // Section helper
    function section(icon, title, content) {
      return `<div class="cap-section">
        <div class="cap-section-title"><span>${icon}</span> ${title}</div>
        ${content}
      </div>`;
    }
    let html = '<div class="cap-report-header">📊 GenericAgent 能力概览</div>';
    // 1. Memory System (from actual memory_layers data)
    html += section('🧠', '记忆系统',
      memoryLayers.map(l => {
        const count = l.count || 0;
        const size = l.size ? ` (${(l.size/1024).toFixed(0)}KB)` : '';
        return pbar(Math.min(100, count * 2), `${l.layer} ${l.name}`, `${count} 条${size}`);
      }).join('') || '<div class="text-frost-400 text-[12px] p-2">无记忆层数据</div>'
    );
    // 2. Tool Capabilities (from actual tools list)
    html += section('🔧', `工具能力 (${toolsCount})`,
      tools.slice(0, 12).map(t =>
        `<div class="cap-tool-row">
          <span class="cap-tool-icon">⚡</span>
          <div class="cap-tool-info">
            <div class="cap-tool-name">${esc(t.name)}</div>
            <div class="cap-tool-detail">${esc(t.description || '')}</div>
          </div>
        </div>`
      ).join('') || '<div class="text-frost-400 text-[12px] p-2">无工具数据</div>'
    );
    // 3. MCP Extensions (from actual mcp data)
    const mcpServers = mcp.servers || [];
    const mcpToolsCount = mcp.tools_count || 0;
    html += section('🔌', `MCP 扩展 (${mcpServers.length} 服务器, ${mcpToolsCount} 工具)`,
      `<div class="cap-mcp-stats">
        <div class="cap-mcp-stat">
          <span class="cap-mcp-dot online"></span>
          <span>${mcpServers.length} 服务器: ${mcpServers.map(s => esc(s)).join(', ')}</span>
        </div>
        <div class="cap-mcp-stat">📊 可用工具: ${mcpToolsCount}个</div>
        ${(mcp.tool_names || []).slice(0, 8).map(n => `<span class="mcp-tool-tag">${esc(n)}</span>`).join('')}
      </div>`
    );
    // 4. Autonomous Capabilities
    const autoCaps = [
      { name: '任务规划', status: '✅' },
      { name: '反思复盘', status: '✅' },
      { name: '定时任务', status: '✅' },
      { name: '多步骤执行', status: '✅' },
      { name: '子代理', status: '⚠️', note: '实验性' },
    ];
    const autoHtml = `<div class="cap-auto-grid">${autoCaps.map(c =>
      `<div class="cap-auto-item">
        <span>${c.status}</span> ${c.name}${c.note ? `<span class="cap-auto-note">${c.note}</span>` : ''}
      </div>`
    ).join('')}</div>`;
    html += section('🤖', '自主能力', autoHtml);
    // Footer buttons
    html += `<div class="cap-report-footer">
      <button class="cap-btn" id="btn-export-report">📤 导出报告</button>
      <button class="cap-btn cap-btn-secondary" id="btn-refresh-report">🔄 刷新</button>
    </div>`;
    container.innerHTML = html;
    // Animate progress bars
    container.querySelectorAll('.cap-progress-fill').forEach((bar, i) => {
      const w = bar.style.width;
      bar.style.width = '0%';
      setTimeout(() => { bar.style.width = w; }, 100 + i * 80);
    });
    // Bind export
    container.querySelector('#btn-export-report')?.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = 'capability_report.json'; a.click();
      showToast('报告已导出', 'success');
    });
    container.querySelector('#btn-refresh-report')?.addEventListener('click', () => {
      document.getElementById('btn-capability-report')?.click();
    });
  }
  // Button click
  document.getElementById('btn-capability-report')?.addEventListener('click', function() {
    this.disabled = true;
    this.innerHTML = '<span class="animate-spin inline-block w-4 h-4 border-2 border-frost-300 border-t-transparent rounded-full"></span> 扫描中...';
    API.send('action', { name: 'capability_report' });
    setTimeout(() => {
      this.disabled = false;
      this.innerHTML = '<i data-lucide="scan" class="w-4 h-4"></i>扫描当前能力';
      if (window.lucide) lucide.createIcons();
    }, 2000);
  });

  // ── C7: Edge Fade scroll detection ──
  if (messagesEl) {
    const updateScrollClass = () => {
      const { scrollTop, scrollHeight, clientHeight } = messagesEl;
      messagesEl.classList.toggle('scroll-top', scrollTop < 8);
      messagesEl.classList.toggle('scroll-bottom', scrollTop + clientHeight >= scrollHeight - 8);
    };
    messagesEl.addEventListener('scroll', updateScrollClass, { passive: true });
    updateScrollClass();
    const _origMsgObserver = new MutationObserver(() => setTimeout(updateScrollClass, 100));
    _origMsgObserver.observe(messagesEl, { childList: true, subtree: true });
  }

  // ── C8: Digit rolling animation for status bar counters ──
  const _rollingTargets = [sbTurn, sbExp, sbPref, sbTools, sbErr].filter(Boolean);
  _rollingTargets.forEach(el => {
    let _prevVal = el.textContent;
    new MutationObserver(() => {
      const newVal = el.textContent;
      if (newVal === _prevVal) return;
      _prevVal = newVal;
      el.classList.remove('sb-rolling');
      void el.offsetWidth;
      el.classList.add('sb-rolling');
      el.addEventListener('animationend', () => el.classList.remove('sb-rolling'), { once: true });
    }).observe(el, { childList: true, characterData: true, subtree: true });
  });
})();

  // ── Phase 3: Execution Monitor ──
  function renderExecutionMonitor(steps) {
    let el = document.getElementById('execution-monitor');
    if (!el) {
      el = document.createElement('div');
      el.id = 'execution-monitor';
      el.className = 'execution-monitor';
      const chatArea = document.getElementById('messages');
      if (chatArea) chatArea.prepend(el);
    }
    if (!steps || !steps.length) { el.innerHTML = ''; return; }
    const stats = steps[steps.length - 1] || {};
    const completed = steps.filter(s => s.status === 'done').length;
    const total = steps.length;
    const pct = total > 0 ? Math.round(completed / total * 100) : 0;

    el.innerHTML = `
      <div class="exec-monitor-header">
        <span>⚡ 执行监控</span>
        <span class="exec-monitor-pct">${pct}%</span>
      </div>
      <div class="exec-progress-bar">
        <div class="exec-progress-fill" style="width:${pct}%"></div>
      </div>
      <div class="exec-steps">
        ${steps.map((s, i) => `
          <div class="exec-step exec-step-${s.status || 'pending'}">
            <span class="exec-step-icon">${s.status === 'done' ? '✅' : s.status === 'running' ? '⏳' : s.status === 'error' ? '❌' : '⏸️'}</span>
            <span class="exec-step-name">${_esc(s.name || s.tool || 'Step ' + (i+1))}</span>
            ${s.duration ? `<span class="exec-step-time">${s.duration}ms</span>` : ''}
          </div>
        `).join('')}
      </div>
      ${stats.tokens ? `<div class="exec-stats">📊 Tokens: ${stats.tokens} · ⏱ 耗时: ${stats.elapsed || 0}s</div>` : ''}
    `;
    // Animate progress bar
    const fill = el.querySelector('.exec-progress-fill');
    if (fill) {
      const w = fill.style.width;
      fill.style.width = '0%';
      requestAnimationFrame(() => { fill.style.width = w; });
    }
  }

  // ── Phase 3: Composer Mode Switcher ──
  const composerModes = [
    { id: 'chat', icon: '💬', label: '对话模式', desc: '自由问答' },
    { id: 'plan', icon: '📋', label: '规划模式', desc: '先制定计划再执行' },
    { id: 'auto', icon: '🔄', label: '自动模式', desc: '自主执行+定期汇报' },
    { id: 'analyze', icon: '🔍', label: '分析模式', desc: '只分析不操作' },
  ];
  let currentComposerMode = 'chat';

  function initComposerModeSwitcher() {
    const inputArea = document.querySelector('.composer-bar') || document.getElementById('input-area');
    if (!inputArea) return;
    // Add mode indicator before input
    const modeEl = document.createElement('div');
    modeEl.className = 'composer-mode-bar';
    modeEl.innerHTML = composerModes.map(m =>
      `<button class="composer-mode-btn ${m.id === currentComposerMode ? 'active' : ''}" data-mode="${m.id}" title="${m.desc}">${m.icon} ${m.label}</button>`
    ).join('');
    inputArea.parentElement.insertBefore(modeEl, inputArea);
    modeEl.querySelectorAll('.composer-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        currentComposerMode = btn.dataset.mode;
        modeEl.querySelectorAll('.composer-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === currentComposerMode));
        showToast(`模式: ${composerModes.find(m => m.id === currentComposerMode).label}`, 'info');
      });
    });
  }
  initComposerModeSwitcher();


  /* ═════ Phase 4.2: Theme Switcher ═════ */
  function initThemeSwitcher() {
    const saved = localStorage.getItem('ga-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    
    // Add theme toggle button to header if not exists
    const header = document.querySelector('.header-bar');
    if (header && !document.getElementById('theme-toggle-rail')) {
      const btn = document.createElement('button');
      btn.id = 'theme-toggle-btn';
      btn.title = '切换主题 (Ctrl+Shift+T)';
      btn.setAttribute('aria-label', '切换明暗主题');
      btn.style.cssText = 'background:none;border:1px solid var(--border-default);border-radius:8px;padding:6px 8px;cursor:pointer;color:var(--text-secondary);font-size:14px;transition:all 0.2s;';
      btn.innerHTML = saved === 'dark' ? '☀️' : '🌙';
      btn.addEventListener('click', () => toggleTheme());
      header.appendChild(btn);
    }
  }
  
  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('ga-theme', next);
    const btn = document.getElementById('theme-toggle-rail');
    if (btn) btn.innerHTML = next === 'dark' ? '☀️' : '🌙';
    showToast(next === 'dark' ? '🌙 已切换到暗色主题' : '☀️ 已切换到亮色主题');
  }

  /* ═════ Phase 4.3: Accessibility (a11y) ═════ */
  function initAccessibility() {
    // Add ARIA live region for dynamic content announcements
    if (!document.getElementById('a11y-live')) {
      const live = document.createElement('div');
      live.id = 'a11y-live';
      live.setAttribute('role', 'status');
      live.setAttribute('aria-live', 'polite');
      live.setAttribute('aria-atomic', 'true');
      live.style.cssText = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;';
      document.body.appendChild(live);
    }
    
    // Add skip-to-content link
    if (!document.getElementById('skip-link')) {
      const skip = document.createElement('a');
      skip.id = 'skip-link';
      skip.href = '#messages-container';
      skip.textContent = '跳转到消息区域';
      skip.style.cssText = 'position:absolute;top:-40px;left:0;background:var(--brand-primary);color:#fff;padding:8px 16px;z-index:9999;transition:top 0.2s;';
      skip.addEventListener('focus', () => skip.style.top = '0');
      skip.addEventListener('blur', () => skip.style.top = '-40px');
      document.body.insertBefore(skip, document.body.firstChild);
    }
    
    // Add focus-visible polyfill styles
    document.querySelectorAll('button, a, input, textarea, select, [tabindex]').forEach(el => {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    });
    
    // Announce new messages for screen readers
    const origAppend = window._origAppendMsg;
    if (origAppend) {
      const origFn = origAppend;
      // Announcement handled in message rendering
    }
    
    // Focus trap for modals
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        const modal = document.querySelector('.shortcut-help-modal[style*="display: flex"]') || 
                      document.querySelector('.modal-overlay[style*="display: flex"]');
        if (modal) trapFocus(modal, e);
      }
    });
  }
  
  function trapFocus(container, event) {
    const focusable = container.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    
    if (event.shiftKey) {
      if (document.activeElement === first) {
        last.focus();
        event.preventDefault();
      }
    } else {
      if (document.activeElement === last) {
        first.focus();
        event.preventDefault();
      }
    }
  }
  
  function announceForA11y(text) {
    const live = document.getElementById('a11y-live');
    if (live) {
      live.textContent = '';
      requestAnimationFrame(() => { live.textContent = text; });
    }
  }

  /* ═════ Phase 4.4: Final Polish ═════ */
  function initFinalPolish() {
    // Smooth scroll to bottom on new messages
    const container = document.getElementById('messages');
    if (container) {
      const observer = new MutationObserver((mutations) => {
        const wasAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 60;
        if (wasAtBottom) {
          for (const m of mutations) {
            if (m.addedNodes.length) {
              requestAnimationFrame(() => {
                container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
              });
              break;
            }
          }
        }
      });
      observer.observe(container, { childList: true, subtree: true });
    }
    
    // Add loading shimmer to pending messages
    document.querySelectorAll('.msg-bubble.pending').forEach(el => {
      el.style.position = 'relative';
      el.style.overflow = 'hidden';
    });
    
    // Ensure proper focus management
    const _inputEl = document.getElementById('input');
    if (_inputEl) {
      _inputEl.addEventListener('focus', () => {
        _inputEl.parentElement?.classList.add('input-focused');
      });
      _inputEl.addEventListener('blur', () => {
        _inputEl.parentElement?.classList.remove('input-focused');
      });
    }
    
    // Global focus-visible styles
    const style = document.createElement('style');
    style.textContent = `
      *:focus-visible {
        outline: 2px solid var(--brand-primary, #10a37f);
        outline-offset: 2px;
      }
      *:focus:not(:focus-visible) {
        outline: none;
      }
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after {
          animation-duration: 0.01ms !important;
          animation-iteration-count: 1 !important;
          transition-duration: 0.01ms !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  // Initialize Phase 4 on DOM ready
  document.addEventListener('DOMContentLoaded', () => {
    initThemeSwitcher();
    initAccessibility();
    initFinalPolish();
  });
  
  // Also run immediately if DOM already loaded
  if (document.readyState !== 'loading') {
    initThemeSwitcher();
    initAccessibility();
    initFinalPolish();
  }

