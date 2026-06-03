/* ═══════════════════════════════════════════════════════════════
   GA Codex Frontend - Core Application Logic
   ═══════════════════════════════════════════════════════════════ */

// ── Global State ──
const State = {
  config: null,          // { ws_port, model, ... }
  sessions: [],          // session list
  currentSession: null,  // active session path
  messages: [],          // current conversation messages
  ws: null,              // WebSocket instance
  streaming: false,      // currently streaming response
  theme: localStorage.getItem('codex-theme') || 'dark',
  sidebarOpen: true,
  settingsOpen: false,
  currentView: 'chat',   // chat | skills | mcp | scheduler
  attachedFiles: [],
  skills: [],
  mcpServers: [],
  schedulerTasks: [],
};

// ── Initialization ──
document.addEventListener('DOMContentLoaded', async () => {
  applyTheme(State.theme);
  try {
    await loadConfig();
    await Promise.all([
      loadSessions(),
      loadSkills(),
      loadMcpServers(),
      loadSchedulerTasks(),
    ]);
    connectWebSocket();
  } catch (e) {
    console.error('Init failed:', e);
    showToast('初始化失败: ' + e.message, 'error');
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', handleGlobalKeydown);
});

// ── Config ──
async function loadConfig() {
  State.config = await GA_API.getConfig();
  const modelEl = document.getElementById('current-model');
  if (modelEl && State.config.model) {
    modelEl.textContent = State.config.model;
  }
  // Update status periodically
  setInterval(updateStatus, 10000);
}

async function updateStatus() {
  try {
    const status = await GA_API.getStatus();
    // Could show status indicator somewhere
  } catch (e) { /* ignore */ }
}

// ── Theme ──
function applyTheme(theme) {
  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  // Update theme cards active state
  document.querySelectorAll('.theme-card').forEach(c => {
    c.classList.toggle('active', c.dataset.themeValue === theme);
  });
  State.theme = theme;
  localStorage.setItem('codex-theme', theme);
}

function setTheme(theme) {
  applyTheme(theme);
}

// ── Sidebar ──
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  State.sidebarOpen = !State.sidebarOpen;
  sidebar.classList.toggle('collapsed', !State.sidebarOpen);
}

// ── Sessions ──
async function loadSessions() {
  try {
    State.sessions = await GA_API.listSessions();
    renderSessionList();
  } catch (e) {
    console.error('Load sessions failed:', e);
  }
}

function renderSessionList(filter = '') {
  const container = document.getElementById('session-list');
  let sessions = State.sessions;
  if (filter) {
    const q = filter.toLowerCase();
    sessions = sessions.filter(s =>
      (s.title || s.path || '').toLowerCase().includes(q)
    );
  }

  if (sessions.length === 0) {
    container.innerHTML = `<div class="session-item" style="justify-content:center;color:var(--text-tertiary);font-size:12px;cursor:default;">${filter ? '无匹配结果' : '暂无对话'}</div>`;
    return;
  }

  container.innerHTML = sessions.map(s => {
    const isActive = s.path === State.currentSession;
    const dotClass = s.running ? 'running' : (s.error ? 'error' : 'idle');
    const title = s.title || s.path?.split(/[\\/]/).pop() || '未命名';
    const time = s.mtime ? formatTime(s.mtime) : '';
    return `
      <div class="session-item ${isActive ? 'active' : ''}" onclick="openSession('${escapeAttr(s.path)}')" title="${escapeAttr(s.path)}">
        <span class="session-dot ${dotClass}"></span>
        <span class="session-title">${escapeHtml(title)}</span>
        <span class="session-time">${time}</span>
      </div>`;
  }).join('');
}

function handleSearch(query) {
  renderSessionList(query);
}

async function newChat() {
  State.currentSession = null;
  State.messages = [];
  renderMessages();
  document.getElementById('empty-state').classList.remove('hidden');
  document.getElementById('messages').classList.add('hidden');
  // Deselect all sessions
  document.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
  document.getElementById('user-input').focus();
}

async function openSession(path) {
  try {
    const data = await GA_API.loadSession(path);
    State.currentSession = path;
    State.messages = data.messages || [];
    renderMessages();
    renderSessionList(); // update active state
    document.getElementById('empty-state').classList.add('hidden');
    document.getElementById('messages').classList.remove('hidden');
  } catch (e) {
    showToast('打开会话失败: ' + e.message, 'error');
  }
}

// ── Messages Rendering ──
function renderMessages() {
  const container = document.getElementById('messages');
  if (State.messages.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = State.messages.map((msg, i) => {
    const role = msg.role || 'user';
    const avatar = role === 'user' ? 'U' : 'GA';
    const content = renderMarkdown(msg.content || '');
    const isStreaming = State.streaming && i === State.messages.length - 1 && role === 'assistant';
    return `
      <div class="message ${role}">
        <div class="message-avatar">${avatar}</div>
        <div class="message-body">
          <div class="message-role">${role === 'user' ? '你' : 'GA Codex'}</div>
          <div class="message-content markdown-content ${isStreaming ? 'streaming-cursor' : ''}">${content}</div>
        </div>
      </div>`;
  }).join('');

  // Auto-scroll to bottom
  const chatContainer = document.getElementById('chat-container');
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function appendStreamChunk(text) {
  if (State.messages.length === 0) return;
  const lastMsg = State.messages[State.messages.length - 1];
  if (lastMsg.role === 'assistant') {
    lastMsg.content += text;
  }
  // Update last message content only (efficient)
  const msgElements = document.querySelectorAll('#messages .message');
  if (msgElements.length > 0) {
    const lastEl = msgElements[msgElements.length - 1];
    const contentEl = lastEl.querySelector('.message-content');
    if (contentEl) {
      contentEl.innerHTML = renderMarkdown(lastMsg.content);
      // Keep streaming cursor
      if (State.streaming) contentEl.classList.add('streaming-cursor');
    }
  }
  // Auto-scroll
  const chatContainer = document.getElementById('chat-container');
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

// ── Sending Messages ──
async function sendMessage() {
  const input = document.getElementById('user-input');
  const text = input.value.trim();
  if (!text || State.streaming) return;

  // Check for slash commands
  if (text.startsWith('/')) {
    await handleSlashCommand(text);
    input.value = '';
    autoResize(input);
    return;
  }

  // Show messages area
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('messages').classList.remove('hidden');

  // Add user message
  State.messages.push({ role: 'user', content: text });

  // Prepare assistant placeholder
  State.messages.push({ role: 'assistant', content: '' });
  renderMessages();

  // Clear input
  input.value = '';
  autoResize(input);

  // Build request
  const files = State.attachedFiles.map(f => f.path).filter(Boolean);
  const permission = document.getElementById('permission-select').value;

  State.streaming = true;
  updateSendButton();

  try {
    await GA_API.sendPrompt(text, {
      files,
      permission,
      session_path: State.currentSession,
    });
  } catch (e) {
    showToast('发送失败: ' + e.message, 'error');
    State.streaming = false;
    updateSendButton();
  }
}

function updateSendButton() {
  const btn = document.getElementById('send-btn');
  if (State.streaming) {
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner"></div>';
  } else {
    btn.disabled = false;
    btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
  }
}

// ── Slash Commands ──
async function handleSlashCommand(cmd) {
  const parts = cmd.slice(1).split(/\s+/);
  const command = parts[0].toLowerCase();

  // Add as user message
  State.messages.push({ role: 'user', content: cmd });
  let response = '';

  switch (command) {
    case 'skills':
      response = await handleSlashSkills();
      break;
    case 'mcp':
      response = await handleSlashMcp(parts.slice(1));
      break;
    case 'status':
      response = await handleSlashStatus();
      break;
    case 'clear':
      State.messages = [];
      renderMessages();
      return;
    case 'help':
      response = handleSlashHelp();
      break;
    default:
      // Try GA slash commands API
      try {
        const cmds = await GA_API.fetchSlashCommands();
        const match = cmds.find(c => c.name === command);
        if (match) {
          response = `执行命令 /${command}...（功能对接中）`;
        } else {
          response = `未知命令: /${command}\n输入 /help 查看可用命令`;
        }
      } catch (e) {
        response = `未知命令: /${command}\n输入 /help 查看可用命令`;
      }
  }

  if (response) {
    State.messages.push({ role: 'assistant', content: response });
    renderMessages();
  }
}

async function handleSlashSkills() {
  try {
    const skills = await GA_API.listSkills();
    State.skills = skills;
    if (!skills || skills.length === 0) return '暂无已安装的技能';
    return '## 已安装技能\n\n' + skills.map(s =>
      `- **${s.name || s}**: ${s.description || '无描述'}`
    ).join('\n');
  } catch (e) {
    return '加载技能列表失败';
  }
}

async function handleSlashMcp(args) {
  try {
    const servers = await GA_API.mcpServers();
    State.mcpServers = servers;
    if (!servers || servers.length === 0) return '暂无MCP服务器配置';
    return '## MCP 服务器\n\n' + servers.map(s =>
      `- **${s.name}**: ${s.url || s.command || ''} ${s.enabled ? '✅' : '❌'}`
    ).join('\n');
  } catch (e) {
    return '加载MCP服务器失败';
  }
}

async function handleSlashStatus() {
  try {
    const status = await GA_API.getStatus();
    return '## 系统状态\n\n```json\n' + JSON.stringify(status, null, 2) + '\n```';
  } catch (e) {
    return '获取状态失败';
  }
}

function handleSlashHelp() {
  return `## 可用命令

- \`/skills\` - 查看已安装技能
- \`/mcp\` - 查看MCP服务器状态
- \`/status\` - 查看系统状态
- \`/clear\` - 清空当前对话
- \`/help\` - 显示帮助信息`;
}

// ── WebSocket ──
function connectWebSocket() {
  if (!State.config || !State.config.ws_port) {
    console.warn('No WS port configured');
    return;
  }

  const wsUrl = `ws://${window.location.hostname}:${State.config.ws_port}/ws`;
  console.log('Connecting WS:', wsUrl);

  State.ws = new WebSocket(wsUrl);

  State.ws.onopen = () => {
    console.log('WS connected');
  };

  State.ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWsMessage(data);
    } catch (e) {
      console.error('WS parse error:', e);
    }
  };

  State.ws.onclose = () => {
    console.log('WS closed, reconnecting in 3s...');
    setTimeout(connectWebSocket, 3000);
  };

  State.ws.onerror = (e) => {
    console.error('WS error:', e);
  };
}

function handleWsMessage(data) {
  const type = data.type;
  const payload = data.payload || data;

  switch (type) {
    case 'stream_chunk':
      appendStreamChunk(payload.text || payload.content || '');
      break;

    case 'stream_end':
      State.streaming = false;
      updateSendButton();
      // Remove streaming cursor
      document.querySelectorAll('.streaming-cursor').forEach(el =>
        el.classList.remove('streaming-cursor')
      );
      // Save session path if new
      if (payload.session_path && !State.currentSession) {
        State.currentSession = payload.session_path;
        loadSessions(); // refresh sidebar
      }
      break;

    case 'stream_error':
      State.streaming = false;
      updateSendButton();
      showToast('响应错误: ' + (payload.error || '未知错误'), 'error');
      // Remove streaming cursor, show error
      document.querySelectorAll('.streaming-cursor').forEach(el => {
        el.classList.remove('streaming-cursor');
        el.innerHTML += `\n\n> ⚠️ 错误: ${escapeHtml(payload.error || '未知错误')}`;
      });
      break;

    case 'status_update':
      // Could update status indicators
      break;

    case 'session_update':
      loadSessions(); // refresh session list
      break;

    default:
      console.log('Unknown WS message type:', type, data);
  }
}

// ── File Attachments ──
async function handleFileSelect(fileList) {
  for (const file of fileList) {
    try {
      const result = await GA_API.uploadFile(file);
      State.attachedFiles.push({
        name: file.name,
        path: result.path || result.filename,
        size: file.size,
      });
    } catch (e) {
      showToast('上传失败: ' + file.name, 'error');
    }
  }
  renderFilePreview();
  // Reset file input
  document.getElementById('file-input').value = '';
}

function renderFilePreview() {
  const container = document.getElementById('file-preview');
  if (State.attachedFiles.length === 0) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');
  container.innerHTML = State.attachedFiles.map((f, i) => `
    <div class="file-chip">
      <span>📎 ${escapeHtml(f.name)}</span>
      <span class="remove-file" onclick="removeFile(${i})">✕</span>
    </div>
  `).join('');
}

function removeFile(index) {
  State.attachedFiles.splice(index, 1);
  renderFilePreview();
}

// ── Input Handling ──
function handleInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
}

function useSuggestion(text) {
  const input = document.getElementById('user-input');
  input.value = text;
  autoResize(input);
  input.focus();
}

// ── View Switching ──
function switchView(view) {
  State.currentView = view;
  // Update nav
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === view);
  });

  // For now, all views use chat container with different content
  // Skills/MCP/Scheduler views inject content into chat area
  switch (view) {
    case 'chat':
      renderMessages();
      break;
    case 'skills':
      renderSkillsView();
      break;
    case 'mcp':
      renderMcpView();
      break;
    case 'scheduler':
      renderSchedulerView();
      break;
  }
}

async function renderSkillsView() {
  const chatContainer = document.getElementById('chat-container');
  document.getElementById('empty-state').classList.add('hidden');
  const messages = document.getElementById('messages');
  messages.classList.remove('hidden');

  try {
    if (State.skills.length === 0) {
      State.skills = await GA_API.listSkills() || [];
    }
    document.getElementById('skills-count').textContent = State.skills.length;

    const skillsHtml = State.skills.map(s => {
      const name = s.name || s;
      const desc = s.description || '';
      return `<div class="suggestion-card" onclick="useSuggestion('使用技能 ${escapeAttr(name)}')">
        <div class="card-title">${escapeHtml(name)}</div>
        <div class="card-desc">${escapeHtml(desc) || '无描述'}</div>
      </div>`;
    }).join('');

    messages.innerHTML = `
      <div class="message assistant">
        <div class="message-avatar">⭐</div>
        <div class="message-body">
          <div class="message-role">技能列表</div>
          <div class="message-content">
            <h3>已安装技能 (${State.skills.length})</h3>
            <div class="suggestion-cards" style="max-width:100%;margin-top:12px">
              ${skillsHtml || '<p style="color:var(--text-tertiary)">暂无技能</p>'}
            </div>
          </div>
        </div>
      </div>`;
  } catch (e) {
    messages.innerHTML = `<p style="padding:20px;color:var(--text-secondary)">加载技能失败</p>`;
  }
}

async function renderMcpView() {
  const messages = document.getElementById('messages');
  document.getElementById('empty-state').classList.add('hidden');
  messages.classList.remove('hidden');

  try {
    if (State.mcpServers.length === 0) {
      State.mcpServers = await GA_API.mcpServers() || [];
    }

    const serversHtml = State.mcpServers.map(s => `
      <div class="setting-row">
        <div>
          <div class="setting-label">
            <span class="status-dot ${s.enabled ? 'connected' : 'disconnected'}"></span>
            ${escapeHtml(s.name)}
          </div>
          <div class="setting-desc">${escapeHtml(s.url || s.command || '')}</div>
        </div>
        <button onclick="toggleMcpServer('${escapeAttr(s.name)}')" style="padding:4px 12px;border-radius:var(--radius-sm);border:1px solid var(--border);background:${s.enabled ? 'var(--accent-light)' : 'transparent'};color:${s.enabled ? 'var(--accent)' : 'var(--text-secondary)'};cursor:pointer;font-size:12px">
          ${s.enabled ? '已启用' : '已禁用'}
        </button>
      </div>`).join('');

    messages.innerHTML = `
      <div class="message assistant">
        <div class="message-avatar">🔌</div>
        <div class="message-body">
          <div class="message-role">MCP 服务器</div>
          <div class="message-content">
            <h3>已配置服务器 (${State.mcpServers.length})</h3>
            <div style="margin-top:12px">${serversHtml || '<p style="color:var(--text-tertiary)">暂无服务器</p>'}</div>
          </div>
        </div>
      </div>`;
  } catch (e) {
    messages.innerHTML = `<p style="padding:20px;color:var(--text-secondary)">加载MCP服务器失败</p>`;
  }
}

async function renderSchedulerView() {
  const messages = document.getElementById('messages');
  document.getElementById('empty-state').classList.add('hidden');
  messages.classList.remove('hidden');

  try {
    State.schedulerTasks = await GA_API.schedulerTasks() || [];

    const tasksHtml = State.schedulerTasks.map(t => `
      <div class="suggestion-card">
        <div class="card-title">${escapeHtml(t.name || t.task_name)}</div>
        <div class="card-desc">${escapeHtml(t.schedule || t.cron || '')} · ${t.enabled ? '✅ 启用' : '❌ 禁用'}</div>
      </div>`).join('');

    messages.innerHTML = `
      <div class="message assistant">
        <div class="message-avatar">⏰</div>
        <div class="message-body">
          <div class="message-role">调度任务</div>
          <div class="message-content">
            <h3>调度任务 (${State.schedulerTasks.length})</h3>
            <div class="suggestion-cards" style="max-width:100%;margin-top:12px">
              ${tasksHtml || '<p style="color:var(--text-tertiary)">暂无调度任务</p>'}
            </div>
          </div>
        </div>
      </div>`;
  } catch (e) {
    messages.innerHTML = `<p style="padding:20px;color:var(--text-secondary)">加载调度任务失败</p>`;
  }
}

// ── Settings Panel ──
function toggleSettings() {
  const overlay = document.getElementById('settings-overlay');
  State.settingsOpen = !State.settingsOpen;
  overlay.classList.toggle('visible', State.settingsOpen);
  if (State.settingsOpen) {
    loadSettingsData();
  }
}

function switchSettingsSection(section) {
  document.querySelectorAll('.settings-nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.section === section);
  });
  document.querySelectorAll('.settings-section').forEach(el => {
    el.classList.toggle('hidden', el.id !== `settings-${section}`);
  });
}

async function loadSettingsData() {
  // Load model config
  try {
    const config = await GA_API.getLLMConfig();
    renderModelConfig(config);
  } catch (e) { /* ignore */ }

  // Load MCP servers
  try {
    State.mcpServers = await GA_API.mcpServers() || [];
    renderMcpSettings();
  } catch (e) { /* ignore */ }

  // Load scheduler
  try {
    State.schedulerTasks = await GA_API.schedulerTasks() || [];
    renderSchedulerSettings();
  } catch (e) { /* ignore */ }
}

function renderModelConfig(config) {
  const container = document.getElementById('model-config-content');
  if (!config) { container.innerHTML = '<p>无法加载配置</p>'; return; }

  const models = config.models || config.available_models || [];
  const current = config.current || config.model || '';

  container.innerHTML = `
    <div class="setting-row">
      <div class="setting-label">当前模型</div>
      <strong style="color:var(--accent)">${escapeHtml(current)}</strong>
    </div>
    ${models.length > 0 ? `
    <div style="margin-top:12px">
      <div class="setting-label" style="margin-bottom:8px">可用模型</div>
      ${models.map(m => `<div class="setting-row"><div class="setting-desc">${escapeHtml(typeof m === 'string' ? m : m.name)}</div></div>`).join('')}
    </div>` : ''}
    <div style="margin-top:16px">
      <button onclick="reloadModelConfig()" style="padding:8px 16px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);cursor:pointer;font-size:13px">🔄 重新加载配置</button>
    </div>`;
}

function renderMcpSettings() {
  const container = document.getElementById('mcp-server-list');
  if (State.mcpServers.length === 0) {
    container.innerHTML = '<p style="color:var(--text-secondary);font-size:13px">暂无MCP服务器</p>';
    return;
  }

  container.innerHTML = State.mcpServers.map(s => `
    <div class="setting-row">
      <div>
        <div class="setting-label">
          <span class="status-dot ${s.enabled ? 'connected' : 'disconnected'}"></span>
          ${escapeHtml(s.name)}
        </div>
        <div class="setting-desc">${escapeHtml(s.url || s.command || '')}</div>
      </div>
      <div style="display:flex;gap:4px">
        <button onclick="toggleMcpServerInSettings('${escapeAttr(s.name)}')" style="padding:4px 8px;border-radius:var(--radius-sm);border:1px solid var(--border);background:transparent;color:var(--text-secondary);cursor:pointer;font-size:11px">
          ${s.enabled ? '禁用' : '启用'}
        </button>
        <button onclick="deleteMcpServer('${escapeAttr(s.name)}')" style="padding:4px 8px;border-radius:var(--radius-sm);border:1px solid var(--danger);background:transparent;color:var(--danger);cursor:pointer;font-size:11px">
          删除
        </button>
      </div>
    </div>
  `).join('');
}

function renderSchedulerSettings() {
  const container = document.getElementById('scheduler-task-list');
  if (State.schedulerTasks.length === 0) {
    container.innerHTML = '<p style="color:var(--text-secondary);font-size:13px">暂无调度任务</p>';
    return;
  }

  container.innerHTML = State.schedulerTasks.map(t => `
    <div class="setting-row">
      <div>
        <div class="setting-label">${escapeHtml(t.name || t.task_name)}</div>
        <div class="setting-desc">${escapeHtml(t.schedule || t.cron || '')} · ${t.enabled !== false ? '✅' : '❌'}</div>
      </div>
    </div>
  `).join('');
}

// MCP Server actions
async function toggleMcpServer(name) {
  try {
    await GA_API.mcpToggle(name);
    await loadMcpServers();
    if (State.currentView === 'mcp') renderMcpView();
  } catch (e) {
    showToast('操作失败: ' + e.message, 'error');
  }
}

async function toggleMcpServerInSettings(name) {
  await toggleMcpServer(name);
  renderMcpSettings();
}

async function deleteMcpServer(name) {
  if (!confirm(`确定删除 MCP 服务器 "${name}"？`)) return;
  try {
    await GA_API.mcpDelete(name);
    await loadMcpServers();
    renderMcpSettings();
    showToast('已删除: ' + name, 'success');
  } catch (e) {
    showToast('删除失败: ' + e.message, 'error');
  }
}

async function addMcpServer() {
  const name = document.getElementById('mcp-add-name').value.trim();
  const url = document.getElementById('mcp-add-url').value.trim();
  const type = document.getElementById('mcp-add-type').value;
  if (!name || !url) { showToast('请填写名称和URL', 'error'); return; }

  try {
    await GA_API.mcpAdd({ name, url, type });
    document.getElementById('mcp-add-name').value = '';
    document.getElementById('mcp-add-url').value = '';
    await loadMcpServers();
    renderMcpSettings();
    showToast('已添加: ' + name, 'success');
  } catch (e) {
    showToast('添加失败: ' + e.message, 'error');
  }
}

async function reloadModelConfig() {
  try {
    await GA_API.reloadLLMConfig();
    showToast('配置已重新加载', 'success');
    loadSettingsData();
  } catch (e) {
    showToast('重新加载失败: ' + e.message, 'error');
  }
}

// Sophub
async function searchSophub() {
  const query = document.getElementById('sophub-search-input').value.trim();
  if (!query) return;

  const resultsEl = document.getElementById('sophub-results');
  resultsEl.innerHTML = '<div class="spinner" style="margin:20px auto"></div>';

  try {
    const results = await GA_API.sophubSearch(query);
    const items = results.items || results || [];
    if (items.length === 0) {
      resultsEl.innerHTML = '<p style="color:var(--text-secondary)">无搜索结果</p>';
      return;
    }
    resultsEl.innerHTML = items.map(s => `
      <div class="suggestion-card" onclick="downloadSop('${escapeAttr(s.id || s.sop_id)}')">
        <div class="card-title">${escapeHtml(s.name || s.title)}</div>
        <div class="card-desc">${escapeHtml(s.description || '')}</div>
      </div>`).join('');
  } catch (e) {
    resultsEl.innerHTML = '<p style="color:var(--danger)">搜索失败</p>';
  }
}

async function downloadSop(sopId) {
  try {
    await GA_API.sophubDownload(sopId);
    showToast('SOP 已下载', 'success');
    await loadSkills();
  } catch (e) {
    showToast('下载失败: ' + e.message, 'error');
  }
}

// ── Compact Mode ──
function toggleCompact(enabled) {
  document.body.style.fontSize = enabled ? '13px' : '14px';
  localStorage.setItem('codex-compact', enabled);
}

// ── Model Selector Dropdown ──
function toggleModelDropdown() {
  // TODO: Implement model dropdown menu
  showToast('模型切换功能开发中', 'info');
}

// ── Keyboard Shortcuts ──
function handleGlobalKeydown(e) {
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && e.shiftKey && e.key === 'N') {
    e.preventDefault();
    newChat();
  } else if (ctrl && e.key === 'b') {
    e.preventDefault();
    toggleSidebar();
  } else if (ctrl && e.key === ',') {
    e.preventDefault();
    toggleSettings();
  } else if (ctrl && e.key === 'k') {
    e.preventDefault();
    document.getElementById('search-input').focus();
  } else if (e.key === 'Escape') {
    if (State.settingsOpen) toggleSettings();
  }
}

// ── Toast Notifications ──
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ── Data Loaders ──
async function loadSkills() {
  try {
    State.skills = await GA_API.listSkills() || [];
    document.getElementById('skills-count').textContent = State.skills.length;
  } catch (e) { /* ignore */ }
}

async function loadMcpServers() {
  try {
    State.mcpServers = await GA_API.mcpServers() || [];
  } catch (e) { /* ignore */ }
}

async function loadSchedulerTasks() {
  try {
    State.schedulerTasks = await GA_API.schedulerTasks() || [];
  } catch (e) { /* ignore */ }
}

// ── Markdown Rendering (lightweight) ──
function renderMarkdown(text) {
  if (!text) return '';

  let html = escapeHtml(text);

  // Code blocks ```...```
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`;
  });

  // Inline code `...`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold **...**
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic *...*
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>');
  // Collapse consecutive uls
  html = html.replace(/<\/ul>\s*<ul>/g, '');

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  // Paragraphs (double newline)
  html = html.replace(/\n\n/g, '</p><p>');

  // Single newlines -> <br>
  html = html.replace(/\n/g, '<br>');

  // Wrap in paragraph
  html = '<p>' + html + '</p>';

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');
  html = html.replace(/<p>\s*(<h[1-3]>)/g, '$1');
  html = html.replace(/(<\/h[1-3]>)\s*<\/p>/g, '$1');
  html = html.replace(/<p>\s*(<pre>)/g, '$1');
  html = html.replace(/(<\/pre>)\s*<\/p>/g, '$1');
  html = html.replace(/<p>\s*(<ul>)/g, '$1');
  html = html.replace(/(<\/ul>)\s*<\/p>/g, '$1');
  html = html.replace(/<p>\s*(<blockquote>)/g, '$1');
  html = html.replace(/(<\/blockquote>)\s*<\/p>/g, '$1');

  return html;
}

// ── Utility Functions ──
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(text) {
  return (text || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatTime(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
    if (diff < 604800000) return Math.floor(diff / 86400000) + '天前';
    return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  } catch (e) {
    return '';
  }
}
