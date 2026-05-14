"""Cursor-style Web UI backend for GenericAgent.

- HTTP (bottle): serves static assets (HTML/CSS/JS)
- WebSocket (simple-websocket-server): bidirectional streaming chat
- Bridges to agentmain.GeneraticAgent via put_task(...)
"""
import os, sys, json, threading, time, base64, queue as Q, traceback, argparse, socket, re
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

if sys.stdout is None: sys.stdout = open(os.devnull, "w")
elif hasattr(sys.stdout, 'reconfigure'):
    try: sys.stdout.reconfigure(errors='replace')
    except Exception: pass
if sys.stderr is None: sys.stderr = open(os.devnull, "w")
elif hasattr(sys.stderr, 'reconfigure'):
    try: sys.stderr.reconfigure(errors='replace')
    except Exception: pass

import bottle
from bottle import Bottle, static_file, request, response, HTTPResponse
from simple_websocket_server import WebSocketServer, WebSocket

from agentmain import GeneraticAgent
from continue_cmd import (handle_frontend_command, install as _install_continue,
                          reset_conversation, list_sessions, restore as restore_session,
                          _pairs as _cc_pairs, _parse_native_history)
import subprocess, glob, ast
from urllib.request import urlopen, Request
from urllib.parse import quote, urlencode
import urllib.error

WEB_DIR = os.path.join(HERE, 'web')

# ───────── Agent init ─────────
_install_continue(GeneraticAgent)
agent = GeneraticAgent()
if agent.llmclient is None:
    print("[webapp] ERROR: no usable LLM backend found. Please configure mykey.py")
    sys.exit(1)
threading.Thread(target=agent.run, daemon=True).start()
print(f"[webapp] Agent initialized, LLM: {agent.get_llm_name()}")

# ───────── Global UI state ─────────
STATE = {
    'last_reply_time': int(time.time()),
    'autonomous_enabled': False,
    'pet_proc': None,
}


def _pump_queue(ws, dq):
    """Forward display_queue items to the WebSocket client."""
    last_len = 0
    try:
        while True:
            try: item = dq.get(timeout=600)
            except Q.Empty:
                _send(ws, {'type': 'ping'})
                continue
            if 'next' in item:
                full = item['next']
                if len(full) >= last_len:
                    delta = full[last_len:]
                    last_len = len(full)
                else:  # reset
                    delta = full
                    last_len = len(full)
                _send(ws, {'type': 'stream', 'delta': delta, 'full': full})
            if 'done' in item:
                STATE['last_reply_time'] = int(time.time())
                _send(ws, {'type': 'done', 'payload': item['done']})
                _send_status(ws)
                return
    except Exception as e:
        try: _send(ws, {'type': 'error', 'payload': f'pump error: {e}'})
        except Exception: pass


def _send(ws, obj):
    try:
        ws.send_message(json.dumps(obj, ensure_ascii=False))
    except Exception:
        pass


def _send_status(ws):
    try:
        llms = [{'idx': i, 'name': n, 'current': c} for i, n, c in agent.list_llms()]
        _send(ws, {'type': 'status', 'payload': {
            'llm': agent.get_llm_name(),
            'llms': llms,
            'running': agent.is_running,
            'last_reply_time': STATE['last_reply_time'],
            'autonomous_enabled': STATE['autonomous_enabled'],
        }})
    except Exception as e:
        print(f'[webapp] status error: {e}')


def _broadcast_status():
    for ws in list(WS_CONNS):
        _send_status(ws)


WS_CONNS = set()

# Protocol version this backend speaks (see GenericCode docs/protocol.md).
_PROTO_VERSION = 1
_SERVER_FEATURES = [
    'edit_file', 'open_file', 'run_terminal', 'show_diff', 'context_push', 'diff_preview',
    'tool_approval',
]

def _git_sha():
    try:
        out = subprocess.check_output(['git', 'rev-parse', '--short=7', 'HEAD'],
                                      cwd=ROOT, stderr=subprocess.DEVNULL, timeout=2)
        return out.decode().strip() or 'unknown'
    except Exception:
        return 'unknown'


# ───────── IDE bridge wiring ─────────
# Route messages from ide_bridge.request()/notify() to WS connections tagged
# as 'genericcode-ext' during the hello handshake. Returns the number of
# IDE receivers the message was forwarded to.
import ide_bridge  # noqa: E402  — local module, circular-safe

def _send_to_ide(msg):
    sent = 0
    for ws in list(WS_CONNS):
        if getattr(ws, '_client_tag', '') == 'genericcode-ext':
            _send(ws, msg)
            sent += 1
    return sent

ide_bridge.register(_send_to_ide)


class ChatWS(WebSocket):
    # Per-connection metadata set on handshake. IDE-only messages (edit_file,
    # run_terminal, ...) will only be routed to connections whose client tag
    # was registered as 'genericcode-ext' in M2.
    _client_tag = ''
    _client_proto = 0
    _client_features = ()

    def handle(self):
        try:
            msg = json.loads(self.data)
        except Exception:
            return
        t = msg.get('type')
        try:
            if t == 'hello':
                p = msg.get('payload') or {}
                self._client_tag = str(p.get('client', ''))
                self._client_proto = int(p.get('proto', 0) or 0)
                self._client_features = tuple(p.get('features') or [])
                negotiated = [f for f in _SERVER_FEATURES if f in self._client_features]
                _send(self, {'type': 'hello_ack', 'payload': {
                    'server':   'genericagent',
                    'version':  _git_sha(),
                    'proto':    min(_PROTO_VERSION, self._client_proto or _PROTO_VERSION),
                    'features': negotiated,
                    'llm':      agent.get_llm_name(),
                }})
                print(f'[webapp] handshake: client={self._client_tag!r} '
                      f'proto={self._client_proto} features={negotiated}')
            elif t == 'task':
                payload = msg.get('payload') or {}
                text = (payload.get('text') or '').strip()
                images = payload.get('images') or []  # [{name, data_url}]
                files = payload.get('files') or []    # [absolute_path]
                if files:
                    text = (text + '\n\n' if text else '') + '\n'.join(f'[FILE] {p}' for p in files)
                if not text and not images:
                    return
                dq = agent.put_task(text or '(image)', source='webapp', images=images)
                threading.Thread(target=_pump_queue, args=(self, dq), daemon=True).start()
            elif t == 'abort':
                agent.abort()
                _broadcast({'type': 'info', 'payload': '⏹ 已停止'})
                # Force UI reset on all clients (auto-tasks don't always emit a 'done')
                _broadcast({'type': 'done', 'payload': '(aborted)'})
                _broadcast_status()
            elif t == 'next_llm':
                n = msg.get('payload', -1)
                try: agent.next_llm(int(n))
                except Exception: agent.next_llm(-1)
                _send_status(self)
            elif t == 'status':
                _send_status(self)
            elif t == 'reset':
                msg_txt = reset_conversation(agent)
                _send(self, {'type': 'info', 'payload': msg_txt})
                _send_status(self)
            elif t == 'cmd':
                # pass slash-commands through as a task (agent._handle_slash_cmd)
                cmd = (msg.get('payload') or '').strip()
                if cmd:
                    dq = agent.put_task(cmd, source='webapp')
                    threading.Thread(target=_pump_queue, args=(self, dq), daemon=True).start()
            elif t == 'action':
                _do_action(self, msg.get('payload') or {})
            elif t == 'apply_edit_result':
                # Response to a previous edit_file request — deliver to waiter.
                ide_bridge.deliver_response(msg.get('id', ''), msg.get('payload') or {})
            elif t == 'tool_approval_response':
                # Response to a previous tool_approval_request — deliver to waiter.
                ide_bridge.deliver_response(msg.get('id', ''), msg.get('payload') or {})
            elif t == 'set_bypass':
                # Toggle the global permission-bypass flag.
                try:
                    import permissions as _perm
                    enabled = bool((msg.get('payload') or {}).get('enabled'))
                    _perm.set_bypass(enabled)
                    _send(self, {'type': 'info',
                                 'payload': '⚠️ Bypass 已开启：所有工具将免审批' if enabled
                                            else '✅ Bypass 已关闭：风险动作恢复审批'})
                except Exception as e:
                    _send(self, {'type': 'error', 'payload': f'set_bypass: {e}'})
            elif t == 'context':
                # IDE pushed editor state (active file, selection, open files, root).
                ide_bridge.set_context(msg.get('payload') or {})
        except Exception as e:
            traceback.print_exc()
            _send(self, {'type': 'error', 'payload': f'{type(e).__name__}: {e}'})

    def connected(self):
        WS_CONNS.add(self)
        print(f'[webapp] WS connected: {self.address}')
        _send_status(self)

    def handle_close(self):
        WS_CONNS.discard(self)
        print(f'[webapp] WS closed: {self.address}')


def _do_action(ws, payload):
    """Handle sidebar action buttons."""
    name = payload.get('name', '')
    if name == 'reinject_tools':
        try:
            agent.llmclient.last_tools = ''
            hist_path = os.path.join(ROOT, 'assets', 'tool_usable_history.json')
            with open(hist_path, 'r', encoding='utf-8') as f:
                tool_hist = json.load(f)
            agent.llmclient.backend.history.extend(tool_hist)
            _send(ws, {'type': 'info', 'payload': f'🔧 已重新注入 {len(tool_hist)} 条工具示范'})
        except Exception as e:
            _send(ws, {'type': 'error', 'payload': f'注入失败: {e}'})
    elif name == 'desktop_pet':
        try:
            kwargs = {'creationflags': 0x08000000} if sys.platform == 'win32' else {}
            pet_script = os.path.join(HERE, 'desktop_pet_v2.pyw')
            if not os.path.exists(pet_script):
                pet_script = os.path.join(HERE, 'desktop_pet.pyw')
            STATE['pet_proc'] = subprocess.Popen([sys.executable, pet_script], **kwargs)
            def _pet_req(q):
                def _do():
                    try: urlopen(f'http://127.0.0.1:41983/?{q}', timeout=2)
                    except Exception: pass
                threading.Thread(target=_do, daemon=True).start()
            agent._pet_req = _pet_req
            _send(ws, {'type': 'info', 'payload': '🐱 桌面宠物已启动'})
        except Exception as e:
            _send(ws, {'type': 'error', 'payload': f'桌宠启动失败: {e}'})
    elif name == 'idle_trigger':
        STATE['last_reply_time'] = int(time.time()) - 1800
        _broadcast_status()
        # Fire autonomous task immediately, regardless of the enabled-toggle
        _trigger_autonomous('manual')
    elif name == 'autonomous_toggle':
        STATE['autonomous_enabled'] = not STATE['autonomous_enabled']
        enabled = STATE['autonomous_enabled']
        _send(ws, {'type': 'info', 'payload': '✅ 已允许自主行动' if enabled else '⏸ 已禁止自主行动'})
        _broadcast_status()
    elif name == 'list_sessions':
        try:
            sessions = list_sessions(exclude_pid=os.getpid())[:20]
            data = [{
                'path': p, 'mtime': int(mt), 'preview': prev or '(无预览)', 'rounds': n
            } for p, mt, prev, n in sessions]
            _send(ws, {'type': 'sessions', 'payload': data})
        except Exception as e:
            _send(ws, {'type': 'error', 'payload': f'列出历史失败: {e}'})
    elif name == 'restore_session':
        path = payload.get('path', '')
        if not path or not os.path.isfile(path):
            _send(ws, {'type': 'error', 'payload': '会话文件不存在'})
            return
        try:
            reset_conversation(agent, message=None)
            msg_txt, _ = restore_session(agent, path)
            _send(ws, {'type': 'info', 'payload': msg_txt})
            _broadcast_status()
        except Exception as e:
            _send(ws, {'type': 'error', 'payload': f'恢复失败: {e}'})


# ───────── Autonomous trigger (manual + idle) ─────────
AUTO_PROMPT = "[AUTO]🤖 用户已经离开超过30分钟，作为自主智能体，请阅读自动化sop，执行自动任务。"
_auto_lock = threading.Lock()
_last_auto_trigger = 0


def _broadcast(msg):
    for ws in list(WS_CONNS):
        _send(ws, msg)


def _pump_queue_broadcast(dq):
    """Pump an agent output queue to ALL connected clients (autonomous tasks)."""
    last_len = 0
    try:
        while True:
            try: item = dq.get(timeout=600)
            except Q.Empty: break
            if 'next' in item:
                full = item['next']
                if len(full) >= last_len:
                    delta = full[last_len:]
                else:
                    delta = full  # stream reset
                last_len = len(full)
                _broadcast({'type': 'stream', 'delta': delta, 'full': full})
            if 'done' in item:
                STATE['last_reply_time'] = int(time.time())
                _broadcast({'type': 'done', 'payload': item['done']})
                return
    except Exception as e:
        print(f'[webapp] auto pump error: {e}')
        _broadcast({'type': 'error', 'payload': f'pump error: {e}'})


def _trigger_autonomous(source='auto'):
    """Broadcast a synthetic user message + pump the resulting stream to all clients."""
    global _last_auto_trigger
    with _auto_lock:
        if agent.is_running:
            _broadcast({'type': 'info', 'payload': 'Agent 正在运行，跳过自主触发'})
            return
        _last_auto_trigger = time.time()
    try:
        print(f'[webapp] triggering autonomous task ({source})')
        # 1) Show the synthetic user message in every client
        _broadcast({'type': 'auto_user', 'payload': AUTO_PROMPT})
        # 2) Actually dispatch it and pump stream back to everyone
        dq = agent.put_task(AUTO_PROMPT, source=f'webapp_{source}')
        threading.Thread(target=_pump_queue_broadcast, args=(dq,), daemon=True).start()
        STATE['last_reply_time'] = int(time.time())
        _broadcast_status()
    except Exception as e:
        print(f'[webapp] trigger autonomous error: {e}')
        _broadcast({'type': 'error', 'payload': f'自主触发失败: {e}'})


def _idle_monitor():
    while True:
        time.sleep(10)
        if not STATE['autonomous_enabled']: continue
        now = time.time()
        if now - _last_auto_trigger < 120: continue
        if now - STATE['last_reply_time'] > 1800:
            _trigger_autonomous('idle')


threading.Thread(target=_idle_monitor, daemon=True).start()


# ───────── Session history extraction for UI display ─────────
_SYS_META_MARKERS = (
    '\n### [WORKING MEMORY]', '\n[WORKING MEMORY]',
    '\n[DANGER]', '\n[SYSTEM TIPS]', '\n[SYSTEM]',
)

def _split_user_from_sys(txt):
    """Separate a text block into (user_message, system_meta).
    System meta (WORKING MEMORY / DANGER / SYSTEM TIPS) trails the real user content."""
    if not txt: return '', ''
    cut = len(txt)
    for m in _SYS_META_MARKERS:
        i = txt.find(m)
        if i >= 0 and i < cut: cut = i
    return txt[:cut].strip(), txt[cut:].strip()


def _extract_session_messages(path):
    """Parse a model_responses file into structured UI messages.
    Each message: {role, parts:[{type, ...}]} where type is one of:
      user:       user_text | tool_result
      assistant:  thinking | text | tool_use
    """
    try:
        with open(path, encoding='utf-8', errors='replace') as fh:
            content = fh.read()
    except Exception:
        return []
    pairs = _cc_pairs(content)
    out = []
    for prompt_body, resp_body in pairs:
        # ───── USER side ─────
        user_parts = []
        try:
            msg = json.loads(prompt_body)
            c = msg.get('content') if isinstance(msg, dict) else None
            if isinstance(c, str):
                clean, _ = _split_user_from_sys(c)
                if clean: user_parts.append({'type': 'user_text', 'content': clean})
            elif isinstance(c, list):
                for blk in c:
                    if not isinstance(blk, dict): continue
                    t = blk.get('type')
                    if t == 'text':
                        clean, _ = _split_user_from_sys(blk.get('text', ''))
                        if clean: user_parts.append({'type': 'user_text', 'content': clean})
                    elif t == 'tool_result':
                        tc = blk.get('content', '')
                        if isinstance(tc, list):
                            tc = '\n'.join(b.get('text', '') for b in tc if isinstance(b, dict))
                        tc = str(tc).strip()
                        if tc:
                            user_parts.append({
                                'type': 'tool_result',
                                'tool_use_id': blk.get('tool_use_id', ''),
                                'content': tc,
                            })
        except Exception:
            raw = prompt_body.strip()
            if raw: user_parts.append({'type': 'user_text', 'content': raw[:2000]})
        if user_parts:
            out.append({'role': 'user', 'parts': user_parts})

        # ───── ASSISTANT side ─────
        asst_parts = []
        try:
            blocks = ast.literal_eval(resp_body)
            if isinstance(blocks, list):
                for blk in blocks:
                    if not isinstance(blk, dict): continue
                    t = blk.get('type')
                    if t == 'thinking':
                        tx = (blk.get('thinking') or '').strip()
                        if tx: asst_parts.append({'type': 'thinking', 'content': tx})
                    elif t == 'text':
                        tx = (blk.get('text') or '').strip()
                        if tx: asst_parts.append({'type': 'text', 'content': tx})
                    elif t == 'tool_use':
                        asst_parts.append({
                            'type': 'tool_use',
                            'name': blk.get('name', '?'),
                            'input': blk.get('input', {}),
                            'id': blk.get('id', ''),
                        })
        except Exception:
            raw = resp_body.strip()
            if raw: asst_parts.append({'type': 'text', 'content': raw[:2000]})
        if asst_parts:
            out.append({'role': 'assistant', 'parts': asst_parts})
    return out


# ───────── Skills discovery (SOPs + tools) ─────────
def _discover_skills():
    """Discover SOPs and tools as skill cards."""
    sops = []
    sop_dir = os.path.join(ROOT, 'memory')
    for p in sorted(glob.glob(os.path.join(sop_dir, '*_sop.md')) +
                    glob.glob(os.path.join(sop_dir, 'subagent.md'))):
        try:
            with open(p, encoding='utf-8', errors='replace') as f:
                txt = f.read(4000)
            name = os.path.basename(p)
            # title = first non-empty heading or filename
            title = name.replace('.md', '').replace('_', ' ').title()
            for line in txt.splitlines()[:5]:
                if line.startswith('#'):
                    title = line.lstrip('# ').strip() or title
                    break
            # brief: first paragraph after heading
            brief = ''
            lines = [l.strip() for l in txt.splitlines() if l.strip() and not l.startswith('#')]
            if lines: brief = lines[0][:160]
            sops.append({
                'id': name,
                'name': name,
                'title': title,
                'brief': brief,
                'size': os.path.getsize(p),
                'category': 'sop',
                'icon': _sop_icon(name),
            })
        except Exception as e:
            print(f'[skills] skip {p}: {e}')

    tools = []
    try:
        schema_path = os.path.join(ROOT, 'assets', 'tools_schema.json')
        with open(schema_path, encoding='utf-8') as f:
            schema = json.load(f)
        for t in schema:
            fn = t.get('function', {})
            tools.append({
                'id': 'tool:' + fn.get('name', ''),
                'name': fn.get('name', ''),
                'title': fn.get('name', ''),
                'brief': (fn.get('description') or '')[:200],
                'category': 'tool',
                'icon': '🛠️',
                'schema': fn.get('parameters', {}),
            })
    except Exception as e:
        print(f'[skills] tools load error: {e}')

    return {'sops': sops, 'tools': tools}


def _sop_icon(name):
    n = name.lower()
    if 'memory' in n: return '🧠'
    if 'web' in n or 'tmwebdriver' in n: return '🌐'
    if 'plan' in n: return '📋'
    if 'autonomous' in n: return '🤖'
    if 'schedul' in n: return '⏰'
    if 'vision' in n or 'ocr' in n: return '👁️'
    if 'verify' in n: return '✅'
    if 'github' in n: return '🐙'
    if 'ljq' in n: return '🎮'
    if 'procmem' in n or 'scanner' in n: return '🔍'
    if 'subagent' in n: return '🧬'
    return '📘'


def _read_sop(name):
    """Read SOP file by name safely."""
    safe = os.path.basename(name)
    if not safe.endswith('.md'): return None
    p = os.path.join(ROOT, 'memory', safe)
    if not os.path.isfile(p): return None
    try:
        with open(p, encoding='utf-8', errors='replace') as f:
            return f.read()
    except Exception:
        return None


# ───────── HTTP routes ─────────
app = Bottle()


@app.route('/')
def _index():
    return static_file('index.html', root=WEB_DIR)


@app.route('/static/<filename:path>')
def _static(filename):
    return static_file(filename, root=WEB_DIR)


@app.route('/api/upload', method='POST')
def _upload():
    """Receive file via multipart; return absolute path (saved to temp/uploads/)."""
    f = request.files.get('file')
    if not f:
        response.status = 400
        return {'error': 'no file'}
    up_dir = os.path.join(ROOT, 'temp', 'uploads')
    os.makedirs(up_dir, exist_ok=True)
    safe_name = os.path.basename(f.filename) or f'upload_{int(time.time())}'
    dest = os.path.join(up_dir, f'{int(time.time()*1000)}_{safe_name}')
    f.save(dest, overwrite=True)
    response.content_type = 'application/json'
    return json.dumps({'path': dest, 'name': safe_name})


@app.route('/api/config')
def _config():
    response.content_type = 'application/json'
    ws_port = int(os.environ.get('WEBAPP_WS_PORT', '18521'))
    return json.dumps({'ws_port': ws_port})


# ───────── REST API (decoupled from WS) ─────────
def _json(obj, status=200):
    response.status = status
    response.content_type = 'application/json'
    return json.dumps(obj, ensure_ascii=False)


# ─── Custom session titles (persisted sidecar) ───
_TITLES_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            'temp', 'model_responses', 'session_titles.json')

def _load_titles():
    try:
        with open(_TITLES_FILE, 'r', encoding='utf-8') as f:
            return json.load(f) or {}
    except Exception:
        return {}

def _save_titles(titles):
    try:
        os.makedirs(os.path.dirname(_TITLES_FILE), exist_ok=True)
        with open(_TITLES_FILE, 'w', encoding='utf-8') as f:
            json.dump(titles, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f'[webapp] save titles error: {e}')


@app.route('/api/sessions')
def _api_sessions():
    try:
        sessions = list_sessions(exclude_pid=os.getpid())[:100]
        titles = _load_titles()
        q = (request.query.get('q') or '').strip().lower()
        out = []
        for p, mt, prev, n in sessions:
            basename = os.path.basename(p)
            title = titles.get(basename, '')
            preview = (prev or '').strip() or '(无预览)'
            # Client-side search also possible, but do server filter for perf with many sessions
            if q and q not in title.lower() and q not in preview.lower():
                continue
            out.append({
                'id': p, 'path': p, 'mtime': int(mt),
                'title': title, 'preview': preview, 'rounds': n,
            })
        return _json(out)
    except Exception as e:
        return _json({'error': str(e)}, 500)


@app.route('/api/session/rename', method='POST')
def _api_session_rename():
    try:
        body = json.loads(request.body.read() or b'{}')
    except Exception:
        body = {}
    path = body.get('path', '')
    title = (body.get('title') or '').strip()
    if not path or not os.path.isfile(path):
        return _json({'error': 'session not found'}, 404)
    titles = _load_titles()
    basename = os.path.basename(path)
    if title:
        titles[basename] = title[:200]
    else:
        titles.pop(basename, None)
    _save_titles(titles)
    return _json({'ok': True, 'title': titles.get(basename, '')})


@app.route('/api/session/delete', method='POST')
def _api_session_delete():
    try:
        body = json.loads(request.body.read() or b'{}')
    except Exception:
        body = {}
    path = body.get('path', '')
    if not path or not os.path.isfile(path):
        return _json({'error': 'session not found'}, 404)
    # Refuse to delete the currently-active session file
    try:
        active = getattr(agent.llmclient.backend, 'model_responses_path', '') or ''
    except Exception:
        active = ''
    if active and os.path.abspath(path) == os.path.abspath(active):
        return _json({'error': '不能删除当前活动会话'}, 400)
    try:
        os.remove(path)
        titles = _load_titles()
        titles.pop(os.path.basename(path), None)
        _save_titles(titles)
        return _json({'ok': True})
    except Exception as e:
        return _json({'error': str(e)}, 500)


@app.route('/api/session/history')
def _api_session_history():
    path = request.query.get('path', '')
    if not path or not os.path.isfile(path):
        return _json({'error': 'session not found'}, 404)
    return _json({'messages': _extract_session_messages(path)})


@app.route('/api/session/restore', method='POST')
def _api_session_restore():
    try:
        body = json.loads(request.body.read() or b'{}')
    except Exception:
        body = {}
    path = body.get('path', '')
    if not path or not os.path.isfile(path):
        return _json({'error': 'session not found'}, 404)
    try:
        reset_conversation(agent, message=None)
        msg_txt, ok = restore_session(agent, path)
        messages = _extract_session_messages(path)
        _broadcast_status()
        return _json({'message': msg_txt, 'ok': bool(ok), 'history': messages})
    except Exception as e:
        return _json({'error': str(e)}, 500)


@app.route('/api/skills')
def _api_skills():
    try:
        return _json(_discover_skills())
    except Exception as e:
        return _json({'error': str(e)}, 500)


@app.route('/api/skills/sop')
def _api_sop():
    name = request.query.get('name', '')
    content = _read_sop(name)
    if content is None:
        return _json({'error': 'sop not found'}, 404)
    return _json({'name': name, 'content': content})


# ───────── Sophub (community SOP hub) ─────────
_SOPHUB_BASE = 'https://fudankw.cn/sophub'

def _sophub_headers():
    try:
        from keychain import keys
        return {'Authorization': f'Bearer {keys.sophub_api_key.use()}'}
    except Exception:
        return {}

def _sophub_req(method, path, body=None, as_json=True, timeout=15):
    import ssl
    url = f'{_SOPHUB_BASE}{path}'
    headers = {'Content-Type': 'application/json', **_sophub_headers()}
    try:
        if body and as_json:
            data = json.dumps(body, ensure_ascii=False).encode()
        elif body:
            data = body
        else:
            data = None
        req = Request(url, data=data, headers=headers, method=method)
        ctx = ssl.create_default_context()
        with urlopen(req, timeout=timeout, context=ctx) as r:
            raw = r.read()
            if as_json:
                return json.loads(raw.decode())
            return raw
    except urllib.error.HTTPError as e:
        try:
            err_body = e.read().decode(errors='replace') if e.fp else ''
            err = json.loads(err_body) if err_body.strip().startswith('{') else {}
        except Exception:
            err = {'raw': err_body[:200]}
        return {'error': err.get('message', f'HTTP {e.code}'), '_status': e.code}
    except Exception as e:
        return {'error': f'{type(e).__name__}: {e}'}


def _sophub_clean_md(text, maxlen=200):
    """Strip markdown syntax from preview text."""
    import re
    # Remove image syntax ![alt](url)
    text = re.sub(r'!\[.*?\]\(.*?\)', '', text)
    # Remove link syntax [text](url), keep text
    text = re.sub(r'\[([^\]]*)\]\(.*?\)', r'\1', text)
    # Remove headings # and blockquotes >
    text = re.sub(r'^#{1,6}\s*', '', text, flags=re.MULTILINE)
    text = re.sub(r'^>\s*', '', text, flags=re.MULTILINE)
    # Remove bold/italic markers
    text = re.sub(r'\*{1,3}([^*]+)\*{1,3}', r'\1', text)
    text = re.sub(r'_{1,3}([^_]+)_{1,3}', r'\1', text)
    # Remove code blocks
    text = re.sub(r'```[\s\S]*?```', '', text)
    text = re.sub(r'`([^`]+)`', r'\1', text)
    # Collapse whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    return text[:maxlen]

def _sophub_map_item(item):
    """Map upstream sophub API fields to frontend-expected fields."""
    stats = item.get('stats') or {}
    raw_preview = item.get('preview', '') or ''
    clean_brief = _sophub_clean_md(raw_preview, 200)
    return {
        **item,
        'sop_id': item.get('id', ''),
        'brief': clean_brief,
        'description': clean_brief,
        'stars': stats.get('stars_avg', 0),
        'downloads': stats.get('downloads', 0),
        'views': stats.get('views', 0),
        'author': item.get('author_name_snapshot', '匿名'),
        'agent_name': item.get('author_name_snapshot', '匿名'),
        'file_type': item.get('file_type', 'markdown'),
    }


@app.route('/api/sophub/search')
def _sophub_search():
    q = request.query.get('q', '')
    page = int(request.query.get('page', 1))
    ps = int(request.query.get('page_size', 24))
    params = urlencode({'q': q, 'page': page, 'page_size': ps})
    result = _sophub_req('GET', f'/api/sops?{params}')
    if isinstance(result, dict) and 'error' in result:
        return _json(result, result.get('_status', 502))
    # Map items and add current_page for frontend pagination
    items = result.get('items', [])
    result['items'] = [_sophub_map_item(it) for it in items]
    result['current_page'] = result.get('page', page)
    return _json(result)


@app.route('/api/sophub/sop/<sop_id>')
def _sophub_sop(sop_id):
    result = _sophub_req('GET', f'/api/sops/{sop_id}')
    if isinstance(result, dict) and 'error' in result:
        return _json(result, result.get('_status', 502))
    return _json(_sophub_map_item(result))


@app.route('/api/sophub/download/<sop_id>')
def _sophub_download(sop_id):
    result = _sophub_req('GET', f'/api/sops/{sop_id}/download', as_json=False)
    if isinstance(result, dict) and 'error' in result:
        return _json(result, result.get('_status', 502))
    return HTTPResponse(result, Status='200 OK',
                         HeaderDict={'Content-Type': 'application/octet-stream',
                                     'Content-Disposition': f'attachment; filename=sop_{sop_id}.md'})


@app.route('/api/sophub/upload', method='POST')
def _sophub_upload():
    try:
        body = json.loads(request.body.read())
    except Exception:
        return _json({'error': 'invalid JSON body'}, 400)
    title = body.get('title', '')
    content = body.get('content', '')
    file_type = body.get('file_type', 'markdown')
    if not title or not content:
        return _json({'error': 'title and content required'}, 400)
    result = _sophub_req('POST', '/api/sops', body={'title': title, 'content': content, 'file_type': file_type})
    if isinstance(result, dict) and 'error' in result:
        return _json(result, result.get('_status', 502))
    return _json(result)


@app.route('/api/sophub/me')
def _sophub_me():
    result = _sophub_req('GET', '/api/me')
    if isinstance(result, dict) and 'error' in result:
        return _json(result, result.get('_status', 401))
    return _json(result)


@app.route('/api/ide-selftest', method='POST')
def _api_ide_selftest():
    """Dev-only endpoint used by test/m2-smoke.js to drive ide_bridge from
    the server side without going through the LLM. Gated by GA_IDE_MODE=1.

    Body: {"type": <proto-type>, "payload": {...}}

    Behaviour:
      - Request-style types (edit_file/show_diff) → ide_bridge.request(),
        returns {"response": <payload>} or {"response": null} on timeout.
      - Notify-style types (run_terminal/open_file) → ide_bridge.notify(),
        returns {"receivers": <n>}.
    """
    if os.environ.get('GA_IDE_MODE') != '1':
        return _json({'error': 'ide-selftest only available when GA_IDE_MODE=1'}, 403)
    try:
        body = json.loads(request.body.read() or b'{}')
    except Exception as e:
        return _json({'error': f'bad json: {e}'}, 400)
    t = body.get('type')
    if not t:
        return _json({'error': 'missing type'}, 400)
    REQUEST_TYPES = {'edit_file', 'show_diff'}
    if t in REQUEST_TYPES:
        resp = ide_bridge.request(body, timeout=10)
        return _json({'response': resp})
    else:
        n = ide_bridge.notify(body)
        return _json({'receivers': n})


@app.route('/api/status')
def _api_status():
    try:
        llms = [{'idx': i, 'name': n, 'current': c} for i, n, c in agent.list_llms()]
        return _json({
            'llm': agent.get_llm_name(),
            'llms': llms,
            'running': agent.is_running,
            'last_reply_time': STATE['last_reply_time'],
            'autonomous_enabled': STATE['autonomous_enabled'],
        })
    except Exception as e:
        return _json({'error': str(e)}, 500)


# ─── Config management ───────────────────────────────────────────────────────
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_MYKEY_JSON = os.path.join(_ROOT, 'mykey.json')
_MYKEY_PY   = os.path.join(_ROOT, 'mykey.py')

def _cfg_type(key):
    k = key.lower()
    if 'mixin' in k: return 'mixin'
    if 'native' in k and 'claude' in k: return 'native_claude'
    if 'native' in k and 'oai'   in k: return 'native_oai'
    if 'claude' in k: return 'claude'
    if 'oai'    in k: return 'oai'
    return 'unknown'

@app.route('/api/llm-config')
def _api_config_get():
    try:
        from llmcore import _load_mykeys
        mk = _load_mykeys()
        sessions, mixin = [], None
        for k, v in mk.items():
            if not isinstance(v, dict): continue
            if not any(x in k for x in ['api', 'config', 'cookie']): continue
            t = _cfg_type(k)
            if t == 'mixin':
                mixin = {'_key': k, **v}
            elif t != 'unknown':
                sessions.append({'_key': k, '_type': t, **v})
        return _json({'sessions': sessions, 'mixin': mixin,
                      'readonly': os.path.isfile(_MYKEY_PY)})
    except Exception as e:
        return _json({'error': str(e)}, 500)


@app.route('/api/llm-config', method='POST')
def _api_config_save():
    try:
        body = json.loads(request.body.read() or b'{}')
    except Exception:
        return _json({'error': 'invalid JSON'}, 400)
    sessions   = body.get('sessions', [])
    mixin_data = body.get('mixin')
    _prefix = {'native_claude': 'native_claude_config', 'native_oai': 'native_oai_config',
                'claude': 'claude_api', 'oai': 'oai_api'}
    out, used = {}, set()
    for s in sessions:
        key = (s.get('_key') or '').strip()
        t   = s.get('_type', 'native_oai')
        if not key:
            base = _prefix.get(t, 'config')
            n = 1
            while f'{base}_{n}' in used: n += 1
            key = f'{base}_{n}'
        used.add(key)
        out[key] = {k: v for k, v in s.items()
                    if not k.startswith('_') and v not in (None, '')}
    if mixin_data and mixin_data.get('llm_nos'):
        mkey = (mixin_data.get('_key') or 'mixin_config')
        out[mkey] = {k: v for k, v in mixin_data.items()
                     if not k.startswith('_') and v not in (None, '')}
    try:
        with open(_MYKEY_JSON, 'w', encoding='utf-8') as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        return _json({'ok': True})
    except Exception as e:
        return _json({'error': str(e)}, 500)


@app.route('/api/llm-config/list-models', method='POST')
def _api_config_list_models():
    try:
        body = json.loads(request.body.read() or b'{}')
    except Exception:
        return _json({'error': 'invalid JSON'}, 400)
    apikey  = (body.get('apikey')  or '').strip()
    apibase = (body.get('apibase') or '').strip()
    proxy   = (body.get('proxy')   or '').strip()
    if not apikey or not apibase:
        return _json({'error': 'apikey / apibase required'}, 400)
    # Normalize base → strip trailing /chat/completions, ensure /v1
    base = apibase.rstrip('/')
    for suffix in ('/chat/completions', '/messages'):
        if base.endswith(suffix): base = base[:-len(suffix)]
    if not re.search(r'/v\d+$', base): base = base + '/v1'
    url = base + '/models'
    # Auth: Claude sk-ant-* uses x-api-key; others Bearer
    headers = {'User-Agent': 'GenericAgent/config'}
    if apikey.startswith('sk-ant-'):
        headers['x-api-key'] = apikey
        headers['anthropic-version'] = '2023-06-01'
    else:
        headers['Authorization'] = 'Bearer ' + apikey
    try:
        import urllib.request, urllib.error, ssl
        req = urllib.request.Request(url, headers=headers)
        opener = (urllib.request.build_opener(urllib.request.ProxyHandler({'http': proxy, 'https': proxy}))
                  if proxy else urllib.request.build_opener())
        with opener.open(req, timeout=15) as resp:
            data = json.loads(resp.read().decode('utf-8', 'replace'))
    except urllib.error.HTTPError as e:
        return _json({'error': f'HTTP {e.code}: {e.reason}', 'url': url}, 502)
    except Exception as e:
        return _json({'error': str(e), 'url': url}, 502)
    # Extract model ids (OpenAI-style: {data:[{id:...}]}; Anthropic: {data:[{id:...}]}; some relays flat list)
    ids = []
    if isinstance(data, dict) and isinstance(data.get('data'), list):
        for m in data['data']:
            if isinstance(m, dict):
                mid = m.get('id') or m.get('model') or m.get('name')
                if mid: ids.append(mid)
            elif isinstance(m, str): ids.append(m)
    elif isinstance(data, list):
        for m in data:
            if isinstance(m, dict):
                mid = m.get('id') or m.get('model') or m.get('name')
                if mid: ids.append(mid)
            elif isinstance(m, str): ids.append(m)
    return _json({'models': sorted(set(ids)), 'url': url, 'count': len(ids)})


@app.route('/api/llm-config/reload', method='POST')
def _api_config_reload():
    if agent.is_running:
        return _json({'error': '请先停止当前任务'}, 400)
    try:
        import sys, llmcore as _lc
        _lc.__dict__.pop('mykeys', None); _lc.__dict__.pop('proxies', None)
        sys.modules.pop('mykey', None)
        mk = _lc._load_mykeys()
        from llmcore import (LLMSession, ToolClient, ClaudeSession, MixinSession,
                             NativeToolClient, NativeClaudeSession, NativeOAISession)
        ll = []
        for k, cfg in mk.items():
            if not any(x in k for x in ['api', 'config', 'cookie']): continue
            try:
                if   'native' in k and 'claude' in k: ll += [NativeToolClient(NativeClaudeSession(cfg=cfg))]
                elif 'native' in k and 'oai'   in k: ll += [NativeToolClient(NativeOAISession(cfg=cfg))]
                elif 'claude' in k: ll += [ToolClient(ClaudeSession(cfg=cfg))]
                elif 'oai'    in k: ll += [ToolClient(LLMSession(cfg=cfg))]
                elif 'mixin'  in k: ll += [{'mixin_cfg': cfg}]
            except Exception as e:
                print(f'[reload] skip {k}: {e}')
        for i, s in enumerate(ll):
            if isinstance(s, dict) and 'mixin_cfg' in s:
                try:
                    mx = MixinSession(ll, s['mixin_cfg'])
                    ll[i] = (NativeToolClient(mx)
                             if isinstance(mx._sessions[0], (NativeClaudeSession, NativeOAISession))
                             else ToolClient(mx))
                except Exception as e:
                    print(f'[reload] mixin: {e}')
        ll = [x for x in ll if not isinstance(x, dict)]
        if not ll:
            return _json({'error': '没有找到有效的 LLM 配置'}, 400)
        agent.llmclients = ll; agent.llm_no = 0; agent.llmclient = ll[0]
        _broadcast_status()
        return _json({'ok': True, 'count': len(ll)})
    except Exception as e:
        return _json({'error': str(e)}, 500)


@app.route('/api/llm-config/backup-py', method='POST')
def _api_config_backup_py():
    if not os.path.isfile(_MYKEY_PY):
        return _json({'error': 'mykey.py not found'}, 404)
    bak = _MYKEY_PY + '.bak'
    try:
        os.replace(_MYKEY_PY, bak)   # os.replace overwrites on Windows (unlike os.rename)
        return _json({'ok': True, 'bak': bak})
    except Exception as e:
        return _json({'error': str(e)}, 500)


# ── Inline code completion ────────────────────────────────────────────────
# Stateless single-shot endpoint for editor ghost-text. Bypasses the agent loop
# (no tools, no history) and directly hits an OAI-compatible chat-completion
# endpoint chosen from mykey.json. Tuned for low latency and small max_tokens.
_COMPLETION_SYSTEM = (
    "You are an inline code completion engine embedded in an IDE. "
    "Given the prefix and suffix of a source file, output ONLY the text that "
    "should be inserted at the cursor (between prefix and suffix). "
    "Rules:\n"
    "- No explanation, no markdown fences, no language identifiers.\n"
    "- Output the completion as-is, ready to insert verbatim.\n"
    "- Prefer short, focused completions (1-10 lines). Stop at a natural boundary.\n"
    "- If unsure, output an empty string.\n"
    "- Do NOT repeat the prefix or suffix."
)


def _detect_proto(apibase: str) -> str:
    """Return 'anthropic' or 'oai' based on apibase URL."""
    b = (apibase or '').lower()
    if 'api.anthropic.com' in b or '/anthropic' in b:
        return 'anthropic'
    return 'oai'


def _pick_completion_cfg():
    """Pick the cheapest LLM config for completion. Supports both OAI-compatible
    and Anthropic-Messages protocols. Prefer keys containing 'mini' / 'flash' /
    'turbo' / 'fast' / 'haiku' / 'air'; fall back to any usable config."""
    try:
        from llmcore import _load_mykeys
        mk = _load_mykeys()
    except Exception:
        return None
    candidates = []
    for k, v in mk.items():
        if not isinstance(v, dict): continue
        if 'apikey' not in v or 'apibase' not in v: continue
        candidates.append((k, v))
    if not candidates:
        return None
    cheap = [c for c in candidates if any(t in (c[1].get('model') or '').lower()
                                          for t in ('mini', 'flash', 'turbo', 'fast', 'haiku', 'air'))]
    return (cheap or candidates)[0][1]


@app.route('/api/complete', method='POST')
def _api_complete():
    try:
        body = json.loads(request.body.read() or b'{}')
    except Exception:
        return _json({'error': 'invalid JSON'}, 400)
    prefix = (body.get('prefix') or '')[-3000:]
    suffix = (body.get('suffix') or '')[:1000]
    lang   = (body.get('lang')   or '').strip()
    max_toks = max(8, min(200, int(body.get('max_tokens') or 80)))
    if not prefix and not suffix:
        return _json({'completion': ''})
    cfg = _pick_completion_cfg()
    if not cfg:
        return _json({'error': 'no LLM configured (need apikey+apibase in mykey.json)'}, 400)
    model = cfg.get('model') or 'gpt-4o-mini'
    base  = (cfg.get('apibase') or '').rstrip('/')
    if not re.search(r'/v\d+(/|$)', base):
        base = base + '/v1'
    proto = _detect_proto(cfg.get('apibase') or '')
    user_msg = f"<lang>{lang}</lang>\n<prefix>\n{prefix}\n</prefix>\n<suffix>\n{suffix}\n</suffix>\n\nCompletion:"
    try:
        import requests as _req
        if proto == 'anthropic':
            url = base + '/messages'
            headers = {
                'Content-Type': 'application/json',
                'x-api-key': cfg['apikey'],
                'anthropic-version': '2023-06-01',
            }
            payload = {
                'model': model,
                'system': _COMPLETION_SYSTEM,
                'messages': [{'role': 'user', 'content': user_msg}],
                'max_tokens': max_toks,
                'temperature': 0.2,
                'stream': False,
            }
            r = _req.post(url, headers=headers, json=payload, timeout=(5, 25),
                          proxies=cfg.get('proxies'))
            if r.status_code != 200:
                return _json({'error': f'HTTP {r.status_code}: {r.text[:200]}'}, 502)
            data = r.json()
            blocks = data.get('content') or []
            text = ''
            for b in blocks:
                if isinstance(b, dict) and b.get('type') == 'text':
                    text += b.get('text') or ''
        else:
            url = base + '/chat/completions'
            headers = {'Content-Type': 'application/json',
                       'Authorization': 'Bearer ' + cfg['apikey']}
            payload = {
                'model': model,
                'messages': [{'role': 'system', 'content': _COMPLETION_SYSTEM},
                             {'role': 'user',   'content': user_msg}],
                'max_tokens': max_toks,
                'temperature': 0.2,
                'stream': False,
            }
            r = _req.post(url, headers=headers, json=payload, timeout=(5, 25),
                          proxies=cfg.get('proxies'))
            if r.status_code != 200:
                return _json({'error': f'HTTP {r.status_code}: {r.text[:200]}'}, 502)
            data = r.json()
            text = (data.get('choices') or [{}])[0].get('message', {}).get('content', '') or ''
        # Defensive cleanup: strip markdown fences if model still emits them.
        text = re.sub(r'^```[\w-]*\n?', '', text)
        text = re.sub(r'\n?```\s*$', '', text)
        return _json({'completion': text, 'model': model, 'proto': proto})
    except Exception as e:
        return _json({'error': str(e)}, 502)


def find_free_port(start=18520, tries=50):
    for p in range(start, start + tries):
        try:
            s = socket.socket(); s.bind(('127.0.0.1', p)); s.close(); return p
        except OSError: continue
    raise RuntimeError('no free port')


class _ThreadedWSGIServer(bottle.ServerAdapter):
    """Multi-threaded stdlib WSGI server. Avoids head-of-line blocking when one
    request (e.g. /api/complete waiting on LLM) holds the server. No external
    deps."""
    def run(self, handler):  # noqa: D401
        from wsgiref.simple_server import make_server, WSGIServer
        from socketserver import ThreadingMixIn

        class ThreadingWSGIServer(ThreadingMixIn, WSGIServer):
            daemon_threads = True

        srv = make_server(self.host, self.port, handler,
                          server_class=ThreadingWSGIServer)
        srv.serve_forever()


def run_server(http_port, ws_port):
    os.environ['WEBAPP_WS_PORT'] = str(ws_port)
    ws_server = WebSocketServer('127.0.0.1', ws_port, ChatWS)
    threading.Thread(target=ws_server.serve_forever, daemon=True).start()
    print(f'[webapp] WS on ws://127.0.0.1:{ws_port}')
    print(f'[webapp] HTTP on http://127.0.0.1:{http_port}')
    bottle.run(app, host='127.0.0.1', port=http_port, quiet=True, debug=False,
               server=_ThreadedWSGIServer)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--http-port', type=int, default=0, help='0 = auto pick')
    ap.add_argument('--ws-port', type=int, default=0, help='0 = auto pick')
    args = ap.parse_args()
    http_port = args.http_port or find_free_port(18520)
    ws_port = args.ws_port or find_free_port(http_port + 1)
    run_server(http_port, ws_port)
