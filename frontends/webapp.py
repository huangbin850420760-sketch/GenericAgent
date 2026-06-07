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
from slash_cmds import (build_update_prompt, build_autorun_prompt,
                        build_morphling_prompt, build_goal_prompt,
                        build_hive_prompt)

WEB_DIR = os.path.join(HERE, 'web')  # default; overridden by --frontend codex

# ───────── Slash-command registry ─────────
_SLASH_CMDS = {
    'update':   {'brief': '🔄 更新上游分支代码',    'builder': 'update'},
    'morphling':{'brief': '🧬 吞噬/蒸馏外部项目',   'builder': 'morphling'},
    'hive':     {'brief': '🐝 多Worker集群协作 → 任务面板', 'builder': 'hive'},
    'scheduler':{'brief': '⏰ 计划任务管理 → 任务面板',     'builder': None},
}

_SLASH_BUILDERS = {
    'update':    build_update_prompt,
    'morphling': build_morphling_prompt,
    'hive':      build_hive_prompt,
}


def _build_upstream_update_prompt(args_text: str = "") -> str:
    """Generate a prompt that asks the agent to update from upstream branch."""
    return (
        "请执行上游分支代码更新操作，步骤如下：\n"
        "1. 先提交本地所有未提交的更改（git add -A && git commit）\n"
        "2. 执行 git fetch upstream 获取上游最新代码\n"
        "3. 执行 git merge upstream/main 合并上游代码到当前分支\n"
        "4. 如果有冲突，分析冲突内容并尝试自动解决（本地自定义文件优先保留）\n"
        "5. 合并完成后给出更新摘要：新增/修改/删除了哪些文件\n"
        "注意：不要 push 到 upstream（上游是只读的），只 merge 到本地。\n"
        f"{args_text}"
    )


def _resolve_slash_cmd(text):
    """If *text* starts with /<cmd>, resolve to the prompt-builder output.
    Returns resolved text or None (meaning: passthrough as-is)."""
    if not text or not text.startswith('/'):
        return None
    first_token = text.split(None, 1)[0].lstrip('/')
    if first_token not in _SLASH_CMDS:
        return None                       # unknown → treat as normal text
    args_text = text.split(None, 1)[1] if ' ' in text else ''
    # /update → custom upstream-merge flow
    if first_token == 'update':
        return _build_upstream_update_prompt(args_text)
    builder = _SLASH_BUILDERS.get(first_token)
    if builder:
        return builder(args_text)
    return None  # /scheduler etc. → no prompt replacement

# ───────── Agent init ─────────
_install_continue(GeneraticAgent)
agent = GeneraticAgent()
if agent.llmclient is None:
    print("[webapp] ERROR: no usable LLM backend found. Please configure mykey.py")
    sys.exit(1)
threading.Thread(target=agent.run, daemon=True).start()
print(f"[webapp] Agent initialized, LLM: {agent.get_llm_name()}")

# ── T4.2.1: Register turn_end_hook to push execution_step via WS ──
_step_counter = [0]
_last_step_time = [0.0]

def _execution_step_hook(locals_dict):
    """Push execution_step WS messages on each tool call completion.
    Collects all tool_calls first, then broadcasts once (throttled per batch)."""
    try:
        tool_calls = locals_dict.get('tool_calls') or []
        tool_results = locals_dict.get('tool_results') or []
        if not tool_calls:
            return
        now = time.time()
        duration = round(now - _last_step_time[0], 3) if _last_step_time[0] > 0 else None
        _last_step_time[0] = now
        for idx, tc in enumerate(tool_calls):
            _step_counter[0] += 1
            tool_name = getattr(tc, 'name', '') if hasattr(tc, 'name') else tc.get('tool_name', '')
            tool_args = getattr(tc, 'args', {}) if hasattr(tc, 'args') else tc.get('args', {})
            tr = tool_results[idx] if idx < len(tool_results) else None
            status = 'success'
            result_summary = ''
            if tr is not None:
                if isinstance(tr, dict):
                    is_error = tr.get('is_error', False) or tr.get('status') == 'error'
                    result_summary = str(tr.get('content', ''))[:200]
                    status = 'error' if is_error else 'success'
                else:
                    result_summary = str(tr)[:200]
            payload = {
                'step': _step_counter[0],
                'tool': tool_name,
                'status': status,
                'args_summary': str({k: (str(v)[:50]+'...' if len(str(v))>50 else v) for k,v in tool_args.items()})[:300],
                'result_summary': result_summary,
                'timestamp': int(now * 1000),
            }
            if duration is not None:
                payload['duration'] = duration
            _broadcast({'type': 'execution_step', 'payload': payload})
    except Exception as e:
        print(f'[webapp] execution_step_hook error: {e}')

if not hasattr(agent, '_turn_end_hooks'):
    agent._turn_end_hooks = {}
agent._turn_end_hooks['execution_step'] = _execution_step_hook

# ───────── Global UI state ─────────
STATE = {
    'last_reply_time': int(time.time()),
    'autonomous_enabled': False,
    'pet_proc': None,
}
# T4.3.5: Load persisted trust level on startup
try:
    _tc_path = os.path.join(script_dir, 'memory', 'trust_config.json')
    if os.path.isfile(_tc_path):
        with open(_tc_path, 'r', encoding='utf-8') as _tf:
            STATE['trust_level'] = json.load(_tf).get('trust_level', 0)
except Exception:
    pass


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
            if 'ws_type' in item:
                # Pass-through typed WS messages from hooks (experience/preference/error_recovery)
                msg = {'type': item['ws_type']}
                if 'payload' in item: msg['payload'] = item['payload']
                _send(ws, msg)
                continue
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
                # T1.4.5: 推送memory_stats给前端Status Bar
                try:
                    import glob as _glob
                    _mem_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'memory')
                    _stats = {
                        'sop_count': len(_glob.glob(os.path.join(_mem_dir, '*.md'))),
                        'module_count': len(_glob.glob(os.path.join(_mem_dir, '*.py'))),
                        'experience_count': 0,
                        'preference_count': 0,
                    }
                    # Count experiences
                    _exp_file = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'temp', 'experience.json')
                    if os.path.exists(_exp_file):
                        import json as _json
                        with open(_exp_file, 'r', encoding='utf-8') as _ef:
                            _edata = _json.load(_ef)
                            _stats['experience_count'] = len(_edata) if isinstance(_edata, list) else sum(len(v) for v in _edata.values()) if isinstance(_edata, dict) else 0
                    # Count preferences
                    _pref_file = os.path.join(_mem_dir, 'preferences.json')
                    if os.path.exists(_pref_file):
                        import json as _json
                        with open(_pref_file, 'r', encoding='utf-8') as _pf:
                            _pdata = _json.load(_pf)
                            _stats['preference_count'] = len(_pdata.get('preferences', [])) if isinstance(_pdata, dict) else 0
                    _send(self, {'type': 'memory_stats', 'payload': _stats})
                except Exception:
                    pass  # memory_stats推送失败不影响handshake
            elif t == 'task':
                payload = msg.get('payload') or {}
                text = (payload.get('text') or '').strip()
                images = payload.get('images') or []  # [{name, data_url}]
                files = payload.get('files') or []    # [absolute_path]
                if files:
                    text = (text + '\n\n' if text else '') + '\n'.join(f'[FILE] {p}' for p in files)
                if not text and not images:
                    return
                # ── slash-command interception ──
                text = _resolve_slash_cmd(text) or text
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
            # ── T4.1: Preview approval response ──
            elif t == 'preview_response':
                payload = msg.get('payload') or {}
                pid = payload.get('id', '')
                approved = bool(payload.get('approved', False))
                with _preview_lock:
                    info = _preview_state.get(pid)
                    if info:
                        info['approved'] = approved
                        info['event'].set()
                    else:
                        _send(self, {'type': 'error', 'payload': f'预览ID {pid} 不存在或已过期'})
            # ── T4.1: Set trust level (L0 full trust → L3 readonly) ──
            elif t == 'set_trust_level':
                level = int((msg.get('payload') or {}).get('level', 0))
                level = max(0, min(3, level))
                STATE['trust_level'] = level
                # T4.3.5: Persist trust level to file
                try:
                    _tc_path = os.path.join(script_dir, 'memory', 'trust_config.json')
                    with open(_tc_path, 'w', encoding='utf-8') as _tf:
                        json.dump({'trust_level': level}, _tf)
                except Exception: pass
                _broadcast_status()
                _send(self, {'type': 'info', 'payload': f'🔒 信任等级已设为 L{level}'})
            elif t == 'context':
                # IDE pushed editor state (active file, selection, open files, root).
                ide_bridge.set_context(msg.get('payload') or {})
            # ── T2.4.5: Context Panel queries ──
            elif t == 'experience_query':
                _handle_experience_query(self, msg.get('payload') or {})
            elif t == 'context_data':
                _handle_context_data(self)
            # ── T2.5.4: Review suggestion (task completion review popup) ──
            elif t == 'review_suggestion':
                _handle_review_suggestion(self, msg.get('payload') or {})
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


# ═══════════ T2.4.5: Context Panel query handlers ═══════════

def _handle_experience_query(ws, payload):
    """Search experience index and return results to Context Panel."""
    query = (payload.get('query') or '').strip()
    if not query:
        _send(ws, {'type': 'experience_results', 'payload': []})
        return
    try:
        import sys, os
        _ga_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        if _ga_root not in sys.path:
            sys.path.insert(0, _ga_root)
        from memory.experience_index import ExperienceIndex
        idx = ExperienceIndex()
        results = idx.search(query, top_k=5)
        _send(ws, {'type': 'experience_results', 'payload': results})
    except Exception as e:
        _send(ws, {'type': 'experience_results', 'payload': [], 'error': str(e)})


def _handle_context_data(ws):
    """Gather full context data for the Context Panel."""
    import glob as _glob
    _ga_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    _mem_dir = os.path.join(_ga_root, 'memory')
    _data = {
        'memory_stats': {
            'sop_count': len(_glob.glob(os.path.join(_mem_dir, '*.md'))),
            'module_count': len(_glob.glob(os.path.join(_mem_dir, '*.py'))),
            'experience_count': 0,
            'preference_count': 0,
        },
        'active_memories': [],
        'preferences': [],
    }
    # Count experiences
    _exp_file = os.path.join(_ga_root, 'temp', 'experience.json')
    if os.path.exists(_exp_file):
        try:
            with open(_exp_file, 'r', encoding='utf-8') as f:
                _edata = json.load(f)
                _data['memory_stats']['experience_count'] = len(_edata) if isinstance(_edata, list) else sum(len(v) for v in _edata.values()) if isinstance(_edata, dict) else 0
                # Include latest 3 experiences as active memories
                exps = _edata if isinstance(_edata, list) else list(_edata.values())[:3] if isinstance(_edata, dict) else []
                for exp in exps[:3]:
                    if isinstance(exp, dict):
                        _data['active_memories'].append({
                            'title': exp.get('title', exp.get('task', '经验')),
                            'summary': exp.get('summary', exp.get('key_learnings', ''))[:120],
                            'category': exp.get('category', 'general'),
                        })
        except Exception:
            pass
    # Count preferences
    _pref_file = os.path.join(_mem_dir, 'preferences.json')
    if os.path.exists(_pref_file):
        try:
            with open(_pref_file, 'r', encoding='utf-8') as f:
                _pdata = json.load(f)
                prefs = _pdata.get('preferences', []) if isinstance(_pdata, dict) else []
                _data['memory_stats']['preference_count'] = len(prefs)
                for p in prefs[:10]:
                    if isinstance(p, dict):
                        _data['preferences'].append({
                            'key': p.get('key', p.get('name', '')),
                            'value': str(p.get('value', p.get('content', '')))[:80],
                        })
        except Exception:
            pass
    _send(ws, {'type': 'context_data', 'payload': _data})


# ═══════════ T2.5.4: Review Suggestion handler ═══════════

def _handle_review_suggestion(ws, payload):
    """Generate a task review suggestion and send to frontend as popup.
    
    Called when agent detects task completion signal. Gathers:
    - task_summary: what was done
    - tools_used: tool chain from conversation
    - key_insight: one-line takeaway
    - difficulty: simple/medium/complex
    - suggestion: distilled skill suggestion (if any)
    """
    import glob as _glob
    _ga_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    
    # Extract recent conversation context
    task_summary = payload.get('task_summary', '任务完成')
    tools_used = payload.get('tools_used', [])
    key_insight = payload.get('key_insight', '')
    difficulty = payload.get('difficulty', '中等')
    
    # Build timeline from recent experience
    timeline = []
    exp_file = os.path.join(ROOT, 'experience.json')
    if os.path.exists(exp_file):
        try:
            with open(exp_file, 'r', encoding='utf-8') as f:
                exps = json.load(f)
            if isinstance(exps, list):
                for exp in exps[-5:]:  # Last 5 experiences
                    if isinstance(exp, dict):
                        timeline.append({
                            'task': exp.get('task', exp.get('summary', ''))[:60],
                            'time': exp.get('created_at', ''),
                            'success': exp.get('success', True),
                        })
        except Exception:
            pass
    
    # Build review data
    review = {
        'task_summary': task_summary[:120],
        'tools_used': tools_used[:8],
        'key_insight': key_insight[:200],
        'difficulty': difficulty,
        'timeline': timeline,
        'timestamp': time.strftime('%Y-%m-%d %H:%M'),
    }
    
    _send(ws, {'type': 'review_suggestion', 'payload': review})


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
    # ── T4.3.3+T4.3.4b: Capability report ──
    elif name == 'capability_report':
        print(f'[webapp] DEBUG: capability_report action received, payload={payload}', flush=True)
        try:
            if ROOT not in sys.path:
                sys.path.insert(0, ROOT)
            from capability_reporter import get_capability_report
            report = get_capability_report()
            print(f'[webapp] DEBUG: report keys={list(report.keys()) if isinstance(report, dict) else type(report)}', flush=True)
            _send(ws, {'type': 'capability_report_result', 'payload': report})
            print(f'[webapp] DEBUG: capability_report_result sent!', flush=True)
        except Exception as e:
            import traceback; traceback.print_exc()
            _send(ws, {'type': 'error', 'payload': f'能力报告生成失败: {e}'})
    else:
        if name:
            print(f'[webapp] DEBUG: unknown action name={name!r}', flush=True)


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
            if 'ws_type' in item:
                # Pass-through typed WS messages from hooks (experience/preference/error_recovery)
                msg = {'type': item['ws_type']}
                if 'payload' in item: msg['payload'] = item['payload']
                _broadcast(msg)
                continue
            if 'done' in item:
                STATE['last_reply_time'] = int(time.time())
                _broadcast({'type': 'done', 'payload': item['done']})
                return
    except Exception as e:
        print(f'[webapp] auto pump error: {e}')
        _broadcast({'type': 'error', 'payload': f'pump error: {e}'})


# ── T4.1: Preview approval state ──
_preview_lock = threading.Lock()
_preview_state = {}   # {id: {prompt, event(threading.Event), approved(bool)}}

def _trigger_autonomous(source='auto'):
    """Broadcast a synthetic user message + pump the resulting stream to all clients.
    T4.1: With trust_level >= 2, send execution_preview for approval first."""
    global _last_auto_trigger
    with _auto_lock:
        if agent.is_running:
            _broadcast({'type': 'info', 'payload': 'Agent 正在运行，跳过自主触发'})
            return
        _last_auto_trigger = time.time()
    try:
        print(f'[webapp] triggering autonomous task ({source})')
        # T4.1: Check trust level for preview approval
        trust_level = int(STATE.get('trust_level', 0))
        if trust_level >= 2:
            import uuid
            preview_id = str(uuid.uuid4())[:8]
            approval_event = threading.Event()
            with _preview_lock:
                _preview_state[preview_id] = {
                    'prompt': AUTO_PROMPT, 'event': approval_event, 'approved': False
                }
            # Send preview to all clients for approval
            _broadcast({'type': 'execution_preview', 'payload': {
                'id': preview_id,
                'steps': [{'desc': AUTO_PROMPT[:200], 'tool': 'agent'}],
                'risk_level': 'low' if trust_level < 3 else 'medium',
                'impact': f'自主触发({source})',
                'source': source,
            }})
            # Wait for approval (timeout 60s)
            if not approval_event.wait(timeout=60):
                with _preview_lock:
                    _preview_state.pop(preview_id, None)
                _broadcast({'type': 'info', 'payload': '⏱ 预览批准超时，已取消'})
                return
            with _preview_lock:
                info = _preview_state.pop(preview_id, {})
                if not info.get('approved'):
                    _broadcast({'type': 'info', 'payload': '🚫 用户已拒绝执行'})
                    return
        # Execute the task
        _broadcast({'type': 'auto_user', 'payload': AUTO_PROMPT})
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

    def _parse_prompt_parts(body):
        """Extract user_text and tool_result parts from a Prompt body."""
        parts = []
        is_tool_result = False
        try:
            msg = json.loads(body)
            c = msg.get('content') if isinstance(msg, dict) else None
            if isinstance(c, str):
                clean, _ = _split_user_from_sys(c)
                if clean: parts.append({'type': 'user_text', 'content': clean})
            elif isinstance(c, list):
                for blk in c:
                    if not isinstance(blk, dict): continue
                    t = blk.get('type')
                    if t == 'text':
                        clean, _ = _split_user_from_sys(blk.get('text', ''))
                        if clean: parts.append({'type': 'user_text', 'content': clean})
                    elif t == 'tool_result':
                        is_tool_result = True
                        tc = blk.get('content', '')
                        if isinstance(tc, list):
                            tc = '\n'.join(b.get('text', '') for b in tc if isinstance(b, dict))
                        tc = str(tc).strip()
                        if tc:
                            parts.append({
                                'type': 'tool_result',
                                'tool_use_id': blk.get('tool_use_id', ''),
                                'content': tc,
                            })
        except Exception:
            raw = body.strip()
            if raw: parts.append({'type': 'user_text', 'content': raw[:2000]})
        return parts, is_tool_result

    def _parse_response_parts(body):
        """Extract thinking/text/tool_use parts from a Response body."""
        parts = []
        try:
            blocks = ast.literal_eval(body)
            if isinstance(blocks, list):
                for blk in blocks:
                    if not isinstance(blk, dict): continue
                    t = blk.get('type')
                    if t == 'thinking':
                        tx = (blk.get('thinking') or '').strip()
                        if tx: parts.append({'type': 'thinking', 'content': tx})
                    elif t == 'text':
                        tx = (blk.get('text') or '').strip()
                        if tx: parts.append({'type': 'text', 'content': tx})
                    elif t == 'tool_use':
                        parts.append({
                            'type': 'tool_use',
                            'name': blk.get('name', '?'),
                            'input': blk.get('input', {}),
                            'id': blk.get('id', ''),
                        })
        except Exception:
            raw = body.strip()
            if raw: parts.append({'type': 'text', 'content': raw[:2000]})
        return parts

    for prompt_body, resp_body in pairs:
        user_parts, is_tool_result = _parse_prompt_parts(prompt_body)
        asst_parts = _parse_response_parts(resp_body)

        if is_tool_result:
            # ── Continuation round: merge into previous assistant bubble ──
            # tool_result goes into previous user message (or skip if none)
            if user_parts and out:
                # Find last user message to append tool_result
                for i in range(len(out) - 1, -1, -1):
                    if out[i]['role'] == 'user':
                        out[i]['parts'].extend(user_parts)
                        break
            # Assistant parts merge into previous assistant message
            if asst_parts and out:
                for i in range(len(out) - 1, -1, -1):
                    if out[i]['role'] == 'assistant':
                        out[i]['parts'].extend(asst_parts)
                        break
        else:
            # ── New user turn: create fresh user + assistant messages ──
            if user_parts:
                out.append({'role': 'user', 'parts': user_parts})
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

    # ── T2.5.2: Scan auto_skills (distilled from task reviews) ──
    auto_dir = os.path.join(sop_dir, 'auto_skills')
    if os.path.isdir(auto_dir):
        for p in sorted(glob.glob(os.path.join(auto_dir, '*.md'))):
            try:
                with open(p, encoding='utf-8', errors='replace') as f:
                    txt = f.read(4000)
                name = os.path.basename(p)
                title = name.replace('.md', '').replace('_', ' ').title()
                for line in txt.splitlines()[:5]:
                    if line.startswith('#'):
                        title = line.lstrip('# ').strip() or title
                        break
                brief = ''
                content_lines = [l.strip() for l in txt.splitlines() if l.strip() and not l.startswith('#')]
                if content_lines: brief = content_lines[0][:160]
                sops.append({
                    'id': 'auto:' + name,
                    'name': name,
                    'title': '✨ ' + title,
                    'brief': brief,
                    'size': os.path.getsize(p),
                    'category': 'auto_skill',
                    'icon': '⭐',
                    'auto': True,
                })
            except Exception:
                pass

    # ── T2.5.2: Add usage counts from experience index ──
    try:
        idx_path = os.path.join(sop_dir, 'experience_index.json')
        usage_map = {}
        if os.path.isfile(idx_path):
            idx_data = json.loads(open(idx_path, encoding='utf-8').read())
            # Count tool mentions across all index entries
            for kw, entries in idx_data.get('inverted', idx_data).items():
                for entry in (entries if isinstance(entries, list) else []):
                    # Count tools referenced
                    tools = entry.get('tools_used', []) if isinstance(entry, dict) else []
                    for t in tools:
                        usage_map[t] = usage_map.get(t, 0) + 1
        for s in sops:
            s['use_count'] = usage_map.get(s.get('name', ''), 0)
        for t in tools:
            t['use_count'] = usage_map.get(t.get('name', ''), 0)
    except Exception:
        for s in sops:
            s.setdefault('use_count', 0)
        for t in tools:
            t.setdefault('use_count', 0)

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


@app.route('/api/slash-commands')
def _slash_commands():
    """Return available slash commands for Web UI autocomplete menu."""
    return {'commands': _SLASH_CMDS}


# ═══════════ Scheduler / Goal / Hive API ═══════════
_SCHE_DIR = os.path.join(ROOT, 'sche_tasks')
_SCHE_DONE = os.path.join(_SCHE_DIR, 'done')
_GOAL_FILE = os.path.join(ROOT, 'temp', 'goal_state.json')
_HIVE_BASE = os.path.join(ROOT, 'temp')

def _json_files(directory):
    """List *.json files in directory, return list of (stem, full_path)."""
    if not os.path.isdir(directory):
        return []
    return [(f[:-5], os.path.join(directory, f))
            for f in sorted(os.listdir(directory)) if f.endswith('.json')]

# ── Scheduler ──
@app.route('/api/scheduler/tasks')
def _sche_tasks():
    tasks = []
    for name, path in _json_files(_SCHE_DIR):
        try:
            d = json.loads(open(path, encoding='utf-8').read())
            d['name'] = name
            # check if done today
            done_marker = os.path.join(_SCHE_DONE, f'{time.strftime("%Y-%m-%d")}_{name}.md')
            d['done_today'] = os.path.isfile(done_marker)
            tasks.append(d)
        except Exception:
            tasks.append({'name': name, '_error': True})
    return {'tasks': tasks}

@app.route('/api/scheduler/tasks', method='POST')
def _sche_create():
    d = request.json
    name = d.get('name', '').strip()
    if not name:
        response.status = 400; return {'error': 'name required'}
    os.makedirs(_SCHE_DIR, exist_ok=True)
    safe = re.sub(r'[^\w\-]', '_', name)
    path = os.path.join(_SCHE_DIR, f'{safe}.json')
    obj = {k: d[k] for k in ('schedule', 'repeat', 'enabled', 'prompt', 'max_delay_hours') if k in d}
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    return {'ok': True, 'name': safe}

@app.route('/api/scheduler/tasks/<name>', method='PUT')
def _sche_update(name):
    path = os.path.join(_SCHE_DIR, f'{name}.json')
    if not os.path.isfile(path):
        response.status = 404; return {'error': 'not found'}
    d = request.json
    obj = {k: d[k] for k in ('schedule', 'repeat', 'enabled', 'prompt', 'max_delay_hours') if k in d}
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    return {'ok': True}

@app.route('/api/scheduler/tasks/<name>', method='DELETE')
def _sche_delete(name):
    path = os.path.join(_SCHE_DIR, f'{name}.json')
    if os.path.isfile(path):
        os.remove(path)
        return {'ok': True}
    response.status = 404; return {'error': 'not found'}

# T4.1.5: Scheduler run with preview approval
@app.route('/api/scheduler/run/<name>')
def _sche_run(name):
    """Trigger a scheduler task with preview approval flow."""
    path = os.path.join(_SCHE_DIR, f'{name}.json')
    if not os.path.isfile(path):
        response.status = 404; return {'error': 'not found'}
    d = json.loads(open(path, encoding='utf-8').read())
    prompt = d.get('prompt', '').strip()
    if not prompt:
        return {'error': 'task has no prompt'}
    # Check trust level for preview requirement
    trust = _load_trust()
    if trust < 3:
        # Build preview and broadcast for approval
        import uuid
        pid = str(uuid.uuid4())[:8]
        event = threading.Event()
        with _preview_lock:
            _preview_state[pid] = {'prompt': prompt, 'event': event, 'approved': False}
        _broadcast({'type': 'execution_preview', 'payload': {
            'id': pid, 'steps': [{'step': 1, 'tool': 'scheduler', 'action': prompt[:200]}],
            'risk_level': 'medium', 'source': f'scheduler:{name}',
            'impact': f'将执行定时任务「{name}」'
        }})
        # Wait up to 120s for approval
        if not event.wait(timeout=120):
            with _preview_lock: _preview_state.pop(pid, None)
            return {'error': 'preview timeout'}
        with _preview_lock: info = _preview_state.pop(pid, None)
        if not info or not info.get('approved'):
            return {'error': 'rejected by user'}
    # Execute the task
    dq = agent.put_task(prompt, source=f'webapp_scheduler:{name}')
    threading.Thread(target=_pump_queue_broadcast, args=(dq,), daemon=True).start()
    return {'ok': True, 'name': name}

@app.route('/api/scheduler/reports')
def _sche_done():
    os.makedirs(_SCHE_DONE, exist_ok=True)
    reports = []
    for f in sorted(os.listdir(_SCHE_DONE), reverse=True):
        if f.endswith('.md'):
            fp = os.path.join(_SCHE_DONE, f)
            size = os.path.getsize(fp)
            reports.append({'file': f, 'size': size, 'time': os.path.getmtime(fp)})
    return {'reports': reports[:50]}

@app.route('/api/scheduler/report/<fname>')
def _sche_done_read(fname):
    fp = os.path.join(_SCHE_DONE, fname)
    if not os.path.isfile(fp):
        response.status = 404; return {'error': 'not found'}
    with open(fp, encoding='utf-8') as f:
        return {'content': f.read()}

@app.route('/api/scheduler/log')
def _sche_log():
    log_path = os.path.join(_SCHE_DIR, 'scheduler.log')
    if not os.path.isfile(log_path):
        return {'log': ''}
    with open(log_path, encoding='utf-8', errors='replace') as f:
        lines = f.readlines()
    return {'log': ''.join(lines[-100:])}

# ── Goal ──
@app.route('/api/goal/state')
def _goal_state():
    if not os.path.isfile(_GOAL_FILE):
        return {'state': None}
    try:
        d = json.loads(open(_GOAL_FILE, encoding='utf-8').read())
        return {'state': d}
    except Exception:
        return {'state': None}

@app.route('/api/goal/start', method='POST')
def _goal_start():
    d = request.json
    objective = d.get('objective', '').strip()
    if not objective:
        response.status = 400; return {'error': 'objective required'}
    budget = int(d.get('budget_seconds', 10800))
    max_turns = int(d.get('max_turns', 200))
    import time as _t
    state = {
        'objective': objective,
        'budget_seconds': budget,
        'start_time': _t.time(),
        'turns_used': 0,
        'max_turns': max_turns,
        'status': 'running',
        'done_prompt': d.get('done_prompt', '')
    }
    os.makedirs(os.path.dirname(_GOAL_FILE), exist_ok=True)
    with open(_GOAL_FILE, 'w', encoding='utf-8') as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    cmd = f'set GOAL_STATE=temp\\goal_state.json && start /b python agentmain.py --reflect reflect/goal_mode.py'
    return {'ok': True, 'command': cmd}

@app.route('/api/goal/stop', method='POST')
def _goal_stop():
    if not os.path.isfile(_GOAL_FILE):
        response.status = 404; return {'error': 'no active goal'}
    d = json.loads(open(_GOAL_FILE, encoding='utf-8').read())
    d['status'] = 'stopped'
    with open(_GOAL_FILE, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
    return {'ok': True}

# ── Hive ──
@app.route('/api/hive/sessions')
def _hive_sessions():
    sessions = []
    temp_dir = _HIVE_BASE
    if not os.path.isdir(temp_dir):
        return {'sessions': []}
    for d in sorted(os.listdir(temp_dir)):
        if d.startswith('hive_'):
            full = os.path.join(temp_dir, d)
            if os.path.isdir(full):
                # check for goal_state.json inside
                gs = os.path.join(full, 'goal_state.json')
                state = None
                if os.path.isfile(gs):
                    try:
                        state = json.loads(open(gs, encoding='utf-8').read())
                    except Exception:
                        pass
                sessions.append({'name': d, 'state': state})
    return {'sessions': sessions}

@app.route('/api/hive/create', method='POST')
def _hive_create():
    d = request.json
    objective = d.get('objective', '').strip()
    if not objective:
        response.status = 400; return {'error': 'objective required'}
    short = re.sub(r'[^\w]', '_', objective[:20]).strip('_')
    hive_dir = os.path.join(_HIVE_BASE, f'hive_{short}')
    os.makedirs(hive_dir, exist_ok=True)
    workers = int(d.get('workers', 3))
    budget = int(d.get('budget_seconds', 14400))
    import time as _t
    state = {
        'objective': objective,
        'budget_seconds': budget,
        'start_time': _t.time(),
        'turns_used': 0,
        'max_turns': 300,
        'status': 'running',
        'done_prompt': d.get('done_prompt', '')
    }
    gs_path = os.path.join(hive_dir, 'goal_state.json')
    with open(gs_path, 'w', encoding='utf-8') as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    port = d.get('port', 18600)
    key = d.get('key', short)
    cmds = {
        'bbs': f'start /b python assets/agent_bbs.py --cwd temp/hive_{short} --port {port} --key {key}',
        'master': f'set GOAL_STATE=temp/hive_{short}/goal_state.json && start /b python agentmain.py --reflect reflect/goal_mode.py',
        'worker': f'start /b python agentmain.py --reflect reflect/agent_team_worker.py --base_url http://127.0.0.1:{port} --board_key {key} --name hive-worker-N'
    }
    return {'ok': True, 'dir': f'temp/hive_{short}', 'workers': workers, 'commands': cmds}

@app.route('/api/hive/<name>/status')
def _hive_status(name):
    gs = os.path.join(_HIVE_BASE, name, 'goal_state.json')
    if not os.path.isfile(gs):
        response.status = 404; return {'error': 'not found'}
    try:
        return {'state': json.loads(open(gs, encoding='utf-8').read())}
    except Exception:
        return {'state': None}


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
    # T3.2.1: SOP使用统计追踪
    try:
        from sop_tracker import record_sop_usage
        record_sop_usage(name, success=True, script_dir=ROOT)
    except Exception: pass
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


# ═══════════ MCP Management API ═══════════
_MCP_CFG = os.path.join(ROOT, 'config', 'mcp_servers.json')

def _get_mcp_mgr():
    """Get the global MCPManager instance."""
    try:
        from mcp_client import get_global_manager
        return get_global_manager()
    except Exception:
        return None

@app.route('/api/mcp/servers')
def _mcp_servers():
    """List all MCP servers with status and tools."""
    try:
        cfg = {}
        if os.path.isfile(_MCP_CFG):
            try: cfg = json.loads(open(_MCP_CFG, encoding='utf-8').read())
            except Exception: pass
        mgr = _get_mcp_mgr()
        servers = []
        for name, info in cfg.get('mcpServers', {}).items():
            stype = info.get('type', 'stdio')
            entry = {'name': name, 'type': stype}
            if stype == 'streamable-http':
                entry['url'] = info.get('url', '')
            if mgr and name in mgr.clients:
                client = mgr.clients[name]
                entry['connected'] = True
                entry['enabled'] = name not in mgr.disabled
                def _tool_info(t):
                    if isinstance(t, dict):
                        return {'name': t.get('name', ''), 'description': (t.get('description') or '')[:100]}
                    return {'name': t.name, 'description': (t.description or '')[:100]}
                entry['tools'] = [_tool_info(t) for t in client.tools]
            else:
                entry['connected'] = False
                entry['enabled'] = info.get('enabled', True)
                entry['tools'] = []
            servers.append(entry)
        return _json({'servers': servers})
    except Exception as e:
        import traceback; traceback.print_exc()
        return _json({'error': str(e)}, 500)

@app.route('/api/mcp/servers/<name>/reload', method='POST')
def _mcp_reload(name):
    """Reload a specific MCP server connection."""
    mgr = _get_mcp_mgr()
    if not mgr:
        response.status = 503; return {'error': 'MCP manager not initialized'}
    try:
        cfg = json.loads(open(_MCP_CFG, encoding='utf-8').read())
        servers = cfg.get('mcpServers', {})
        if name not in servers:
            response.status = 404; return {'error': f'Server {name} not found in config'}
        if name in mgr.clients:
            mgr.clients[name].close()
            del mgr.clients[name]
        mgr.add_server(name, servers[name])
        mgr.clients[name].connect()
        mgr.clients[name].discover_tools()
        mgr._rebuild_index()
        return {'ok': True, 'tools': len(mgr.clients[name].tools)}
    except Exception as e:
        response.status = 500; return {'error': str(e)}

@app.route('/api/mcp/servers/<name>', method='DELETE')
def _mcp_delete(name):
    """Remove an MCP server from config and disconnect."""
    mgr = _get_mcp_mgr()
    if mgr and name in mgr.clients:
        mgr.clients[name].close()
        del mgr.clients[name]
        mgr._rebuild_index()
    cfg = {}
    if os.path.isfile(_MCP_CFG):
        cfg = json.loads(open(_MCP_CFG, encoding='utf-8').read())
    if name in cfg.get('mcpServers', {}):
        del cfg['mcpServers'][name]
        with open(_MCP_CFG, 'w', encoding='utf-8') as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    return {'ok': True}

@app.route('/api/mcp/servers/<name>/toggle', method='POST')
def _mcp_toggle(name):
    """Toggle enabled/disabled state of an MCP server."""
    mgr = _get_mcp_mgr()
    if not mgr:
        response.status = 503; return {'error': 'MCP manager not initialized'}
    try:
        enabled = mgr.toggle_server(name)
        return {'ok': True, 'enabled': enabled}
    except ValueError as e:
        response.status = 404; return {'error': str(e)}
    except Exception as e:
        response.status = 500; return {'error': str(e)}

@app.route('/api/mcp/servers', method='POST')
def _mcp_create():
    """Add a new MCP server to config."""
    d = request.json
    name = d.get('name', '').strip()
    if not name:
        response.status = 400; return {'error': 'name required'}
    cfg = {}
    if os.path.isfile(_MCP_CFG):
        cfg = json.loads(open(_MCP_CFG, encoding='utf-8').read())
    cfg.setdefault('mcpServers', {})[name] = d.get('config', {})
    os.makedirs(os.path.dirname(_MCP_CFG), exist_ok=True)
    with open(_MCP_CFG, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    return {'ok': True, 'name': name}

@app.route('/api/mcp/test', method='POST')
def _mcp_test():
    """Test call an MCP tool."""
    d = request.json
    server = d.get('server', '')
    tool = d.get('tool', '')
    arguments = d.get('arguments', {})
    if not server or not tool:
        response.status = 400; return {'error': 'server and tool required'}
    mgr = _get_mcp_mgr()
    if not mgr:
        response.status = 503; return {'error': 'MCP manager not initialized'}
    try:
        result = mgr.call_tool(server, tool, arguments)
        return {'ok': True, 'result': result}
    except Exception as e:
        return {'ok': False, 'error': str(e)}

@app.route('/api/mcp/reload', method='POST')
def _mcp_reload_all():
    """Reload all MCP servers from config."""
    try:
        from agentmain import init_mcp_tools
        mgr = _get_mcp_mgr()
        if mgr:
            mgr.close_all()
        init_mcp_tools()
        return {'ok': True}
    except Exception as e:
        response.status = 500; return {'error': str(e)}


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
    ap.add_argument('--frontend', default='web', choices=['web', 'codex'],
                    help='Frontend to serve: web (default) or codex')
    args = ap.parse_args()
    # ── Override WEB_DIR for codex frontend ──
    if args.frontend == 'codex':
        WEB_DIR = os.path.join(HERE, 'codex')
        print(f'[webapp] Using codex frontend: {WEB_DIR}')
    http_port = args.http_port or find_free_port(18520)
    ws_port = args.ws_port or find_free_port(http_port + 1)
    run_server(http_port, ws_port)
