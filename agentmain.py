import os, sys, threading, queue, time, json, re, random, locale
os.environ.setdefault('GA_LANG', 'zh' if any(k in (locale.getlocale()[0] or '').lower() for k in ('zh', 'chinese')) else 'en')
if sys.stdout is None: sys.stdout = open(os.devnull, "w")
elif hasattr(sys.stdout, 'reconfigure'): sys.stdout.reconfigure(errors='replace')
if sys.stderr is None: sys.stderr = open(os.devnull, "w")
elif hasattr(sys.stderr, 'reconfigure'): sys.stderr.reconfigure(errors='replace')
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from llmcore import reload_mykeys, ToolClient, MixinSession, NativeToolClient, NativeClaudeSession, NativeOAISession, resolve_client
from agent_loop import agent_runner_loop
try:
    from plugins.hooks import discover_and_load; discover_and_load()
except Exception: pass
from ga import GenericAgentHandler, smart_format, get_global_memory, format_error, consume_file

script_dir = os.path.dirname(os.path.abspath(__file__))
def load_tool_schema(suffix=''):
    global TOOLS_SCHEMA
    TS = open(os.path.join(script_dir, f'assets/tools_schema{suffix}.json'), 'r', encoding='utf-8').read()
    TOOLS_SCHEMA = json.loads(TS if os.name == 'nt' else TS.replace('powershell', 'bash'))
load_tool_schema()

def init_mcp_tools():
    """Initialize MCP connections and inject MCP tools into TOOLS_SCHEMA."""
    global TOOLS_SCHEMA
    try:
        import mcp_client as _mcp
        _mcp.init_global_manager(os.path.join(script_dir, 'config', 'mcp_servers.json'))
        mgr = _mcp.get_global_manager()
        if mgr and mgr.clients:
            mcp_tools = mgr.get_flat_tools()
            # Add mcp_tool dispatch function to schema
            mcp_dispatch = {
                "type": "function",
                "function": {
                    "name": "mcp_tool",
                    "description": "调用MCP(Model Context Protocol)外部工具。通过MCP协议连接外部服务器调用其工具能力，如网络搜索、网页阅读、代码仓库分析等。",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "server": {"type": "string", "description": "MCP服务器名称"},
                            "tool": {"type": "string", "description": "要调用的工具名称"},
                            "arguments": {"type": "object", "description": "工具参数"}
                        },
                        "required": ["server", "tool", "arguments"]
                    }
                }
            }
            # Prevent duplicate injection
            if not any(t['function']['name'] == 'mcp_tool' for t in TOOLS_SCHEMA):
                TOOLS_SCHEMA = TOOLS_SCHEMA + [mcp_dispatch]
            print(f'[MCP] Initialized {len(mgr.clients)} servers, {len(mcp_tools)} tools injected')
    except Exception as e:
        print(f'[MCP] Init failed (non-fatal): {e}')
try:
    init_mcp_tools()
except Exception:
    pass

lang_suffix = '_en' if os.environ.get('GA_LANG', '') == 'en' else ''
mem_dir = os.path.join(script_dir, 'memory')
if not os.path.exists(mem_dir): os.makedirs(mem_dir)
mem_txt = os.path.join(mem_dir, 'global_mem.txt')
if not os.path.exists(mem_txt): open(mem_txt, 'w', encoding='utf-8').write('# [Global Memory - L2]\n')
mem_insight = os.path.join(mem_dir, 'global_mem_insight.txt')
if not os.path.exists(mem_insight):
    t = os.path.join(script_dir, f'assets/global_mem_insight_template{lang_suffix}.txt')
    open(mem_insight, 'w', encoding='utf-8').write(open(t, encoding='utf-8').read() if os.path.exists(t) else '')
cdp_cfg = os.path.join(script_dir, 'assets/tmwd_cdp_bridge/config.js')
if not os.path.exists(cdp_cfg):
    try:
        os.makedirs(os.path.dirname(cdp_cfg), exist_ok=True)
        open(cdp_cfg, 'w', encoding='utf-8').write(f"const TID = '__ljq_{hex(random.randint(0, 99999999))[2:8]}';")
    except Exception as e: print(f'[WARN] CDP config init failed: {e} — advanced web features (tmwebdriver) will be unavailable.')

_VISION_MODEL_PATTERNS = (
    'gpt-4o', 'gpt-4.1', 'gpt-4-vision', 'gpt-5',
    'claude-3', 'claude-opus', 'claude-sonnet', 'claude-haiku',
    'gemini', 'qwen-vl', 'qwen2-vl', 'qwen2.5-vl', 'internvl', 'llava',
    'glm-4v', 'glm-4.1v', 'minicpm-v', 'yi-vl', 'cogvlm',
    'pixtral', 'molmo', 'step-1v', 'step-1o',
    'abab6.5-vision', 'abab7-vision', 'minimax-m2-vision',
    'vision', 'vl-',
)

def _save_images_to_disk(images):
    """Persist inline `data:image/*;base64,...` uploads into temp/uploads/ and
    return a list of absolute paths in the same order as *images*.
    Entries that provide an already-saved `path` / `url` file path pass through
    unchanged.  Malformed entries are skipped silently.
    """
    import base64
    up_dir = os.path.join(script_dir, 'temp', 'uploads')
    os.makedirs(up_dir, exist_ok=True)
    out = []
    for i, img in enumerate(images or []):
        if not isinstance(img, dict): continue
        # already-saved file path takes priority (sent via /api/upload earlier)
        p = img.get('path')
        if p and os.path.isabs(p) and os.path.isfile(p):
            out.append(os.path.abspath(p)); continue
        url = img.get('data_url') or img.get('url') or ''
        m = re.match(r'^data:(image/[a-zA-Z0-9.+-]+);base64,(.+)$', url, re.DOTALL)
        if not m: continue
        mime, b64 = m.group(1), m.group(2)
        ext = {'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
               'image/webp': '.webp', 'image/bmp': '.bmp'}.get(mime, '.png')
        safe_name = re.sub(r'[^\w.\-]', '_', img.get('name') or f'paste_{i}')
        if not safe_name.lower().endswith(ext): safe_name += ext
        dest = os.path.join(up_dir, f'{int(time.time()*1000)}_{i}_{safe_name}')
        try:
            with open(dest, 'wb') as f: f.write(base64.b64decode(b64))
            out.append(os.path.abspath(dest))
        except Exception as e:
            print(f'[webapp] save image #{i} failed: {e}')
    return out


def _model_supports_vision(client):
    """True iff the backend model is known to accept image inputs.
    Priority: explicit `vision` cfg flag → keyword match on model name."""
    if client is None: return False
    backend = getattr(client, 'backend', client)
    flag = getattr(backend, 'vision', None)
    if flag is not None: return bool(flag)
    mn = str(getattr(backend, 'model', '') or getattr(backend, 'name', '')).lower()
    return any(p in mn for p in _VISION_MODEL_PATTERNS)


def get_system_prompt():
    with open(os.path.join(script_dir, f'assets/sys_prompt{lang_suffix}.txt'), 'r', encoding='utf-8') as f: prompt = f.read()
    prompt += f"\nToday: {time.strftime('%Y-%m-%d %a')}\n"
    prompt += get_global_memory()
    # Inject MCP tool descriptions if available
    try:
        from mcp_client import get_global_manager
        mgr = get_global_manager()
        if mgr:
            flat = mgr.get_flat_tools()
            if flat:
                lines = ["\n[MCP Tools] 以下MCP工具可通过 mcp_tool 调用："]
                for t in flat:
                    fn = t.get('function', {})
                    name = fn.get('name', '')
                    desc = fn.get('description', '')[:120]
                    params = list(fn.get('parameters', {}).get('properties', {}).keys())
                    lines.append(f"- {name}({', '.join(params)}): {desc}")
                prompt += '\n'.join(lines) + '\n'
    except Exception:
        pass
    return prompt

class GenericAgent:
    def __init__(self):
        os.makedirs(os.path.join(script_dir, 'temp'), exist_ok=True)
        self.lock = threading.Lock()
        self.task_dir = None
        self.history = []; self.handler = None; 
        self.task_queue = queue.Queue() 
        self.is_running = False; self.stop_sig = False
        self.llm_no = 0;  self.inc_out = False; self.verbose = True
        self.peer_hint = True
        self.force_non_stream = False
        self.log_path = os.path.join(script_dir, f'temp/model_responses/model_responses_{int(time.time()*1e6)%1000000:06d}.txt')
        self.load_llm_sessions()

    def load_llm_sessions(self):
        mykeys, changed = reload_mykeys()
        if not changed and hasattr(self, 'llmclients'): return
        try: oldhistory = self.llmclient.backend.history
        except: oldhistory = None
        llm_sessions = []
        for k, cfg in mykeys.items():
            if not any(x in k for x in ['api', 'config', 'cookie']): continue
            try:
                if 'mixin' in k: llm_sessions += [{'mixin_cfg': cfg}]
                elif c := resolve_client(k): llm_sessions += [c]
            except: pass
        for i, s in enumerate(llm_sessions):
            if isinstance(s, dict) and 'mixin_cfg' in s:
                try:
                    mixin = MixinSession(llm_sessions, s['mixin_cfg'])
                    if isinstance(mixin._sessions[0], (NativeClaudeSession, NativeOAISession)): llm_sessions[i] = NativeToolClient(mixin)
                    else: llm_sessions[i] = ToolClient(mixin)
                except Exception as e: print(f'\n\n\n[ERROR] Failed to init MixinSession with cfg {s["mixin_cfg"]}: {e}!!!\n\n')
        self.llmclients = llm_sessions
        self.llmclient = self.llmclients[self.llm_no%len(self.llmclients)]
        if oldhistory: self.llmclient.backend.history = oldhistory
    
    def next_llm(self, n=-1):
        self.load_llm_sessions()
        self.llm_no = ((self.llm_no + 1) if n < 0 else n) % len(self.llmclients)
        lastc = self.llmclient
        self.llmclient = self.llmclients[self.llm_no]
        try: self.llmclient.backend.history = lastc.backend.history
        except: raise Exception('[ERROR] BAD Mixin config: Check your mykey.py')
        self.llmclient.last_tools = ''
        name = self.get_llm_name(model=True)
        if 'glm' in name or 'minimax' in name or 'kimi' in name: load_tool_schema('_cn')
        else: load_tool_schema()
    def list_llms(self): 
        self.load_llm_sessions()
        return [(i, self.get_llm_name(b), i == self.llm_no) for i, b in enumerate(self.llmclients)]
    def get_llm_name(self, b=None, model=False):
        b = self.llmclient if b is None else b
        if isinstance(b, dict): return 'BADCONFIG_MIXIN'
        if model: return b.backend.model.lower()
        return f"{type(b.backend).__name__}/{b.backend.name}"

    def abort(self):
        if not self.is_running: return
        print('Abort current task...')
        self.is_running = False   # Immediately visible to status broadcast; finally-block sets it again (idempotent)
        self.stop_sig = True
        if self.handler is not None: self.handler.code_stop_signal.append(1)

    def _interruptible(self, gen):
        """Run *gen* in a daemon thread; yield its items while polling stop_sig every 250 ms.
        This lets abort() interrupt an LLM that hasn't emitted its first token yet."""
        import queue as _Q
        q = _Q.Queue()
        def _produce():
            try:
                for item in gen:
                    q.put(('chunk', item))
                    if self.stop_sig: break
            except Exception as e:
                q.put(('err', e))
            finally:
                q.put(('done', None))
        threading.Thread(target=_produce, daemon=True).start()
        while True:
            try:
                tag, val = q.get(timeout=0.25)
            except _Q.Empty:
                if self.stop_sig: return
                continue
            if tag == 'done': return
            if tag == 'err': raise val
            yield val
            if self.stop_sig: return
            
    def put_task(self, query, source="user", images=None):
        display_queue = queue.Queue()
        self.task_queue.put({"query": query, "source": source, "images": images or [], "output": display_queue})
        return display_queue

    # i know it is dangerous, but raw_query is dangerous enough it doesn't enlarge
    def _handle_slash_cmd(self, raw_query, display_queue):
        if not raw_query.startswith('/'): return raw_query
        if _sm := re.match(r'/session\.(\w+)=(.*)', raw_query.strip()):
            k, v = _sm.group(1), _sm.group(2)
            vfile = os.path.join(script_dir, 'temp', v)
            if os.path.isfile(vfile): v = open(vfile, encoding='utf-8').read().strip()
            try: v = json.loads(v)  # cover number parsing
            except (json.JSONDecodeError, ValueError): pass
            setattr(self.llmclient.backend, k, v)
            display_queue.put({'done': smart_format(f"✅ session.{k} = {repr(v)}", max_str_len=500), 'source': 'system'})
            return None
        if raw_query.strip() == '/resume':
            return r'帮我看看最近有哪些会话可以恢复。读model_responses/目录，按修改时间取最近10个文件，从每个文件里找最后一个<history>...</history>块，用一句话总结每个会话在聊什么，列表给我选。注意读文件后要把字面的\n替换成真换行才能正确匹配。'
        return raw_query

    def run(self):
        while True:
            task = self.task_queue.get()
            raw_query, source, images, display_queue = task["query"], task["source"], task.get("images") or [], task["output"]
            raw_query = self._handle_slash_cmd(raw_query, display_queue)
            if raw_query is None:
                self.task_queue.task_done(); continue
            self.is_running = True
            if len(raw_query) > 1500:
                task_file = os.path.join(script_dir, 'temp', f'user_prompt_{int(time.time())}.md')
                with open(task_file, 'w', encoding='utf-8') as f: f.write(raw_query)
                raw_query = f'Long user prompt saved to {task_file}. Read and execute.'
            rquery = smart_format(raw_query.replace('\n', ' '), max_str_len=200)
            self.history.append(f"[USER]: {rquery}")
            
            sys_prompt = get_system_prompt() + getattr(self.llmclient.backend, 'extra_sys_prompt', '')
            if self.peer_hint: sys_prompt += f"\n[Peer] 用户提及其他会话/后台任务状态时: temp/model_responses/ (只找近期修改的文件尾部)\n"
            handler = GenericAgentHandler(self, self.history, os.path.join(script_dir, 'temp'))
            if self.handler and 'key_info' in self.handler.working: 
                ki = re.sub(r'\n\[SYSTEM\] 此为.*?工作记忆[。\n]*', '', self.handler.working['key_info'])  # 去旧
                handler.working['key_info'] = ki
                handler.working['passed_sessions'] = ps = self.handler.working.get('passed_sessions', 0) + 1
                if ps > 0: handler.working['key_info'] += f'\n[SYSTEM] 此为 {ps} 个对话前设置的key_info，若已在新任务，先更新或清除工作记忆。\n'
            self.handler = handler
            self.llmclient.log_path = self.log_path
            if self.force_non_stream:
                self.llmclient.backend.stream = False
                self.llmclient.backend.read_timeout = max(self.llmclient.backend.read_timeout, 1200)
            user_input = raw_query
            if source == 'feishu' and len(self.history) > 1:
                user_input = handler._get_anchor_prompt() + f"\n\n### 用户当前消息\n{raw_query}"
            if 'gpt' in self.get_llm_name(model=True): handler._done_hooks.append('请确定任务是否完成，如果完成请给出信息完整的简报回答，如未完成需要继续工具调用直到完成任务，确实需要问用户应使用ask_user工具')
            # build multimodal initial content when images are attached
            initial_content = None
            if images:
                if _model_supports_vision(self.llmclient):
                    initial_content = [{"type": "text", "text": user_input}]
                    for img in images:
                        if not isinstance(img, dict): continue
                        url = img.get('data_url') or img.get('url')
                        if url: initial_content.append({"type": "image_url", "image_url": {"url": url}})
                else:
                    saved_paths = _save_images_to_disk(images)
                    mname = self.get_llm_name(model=True)
                    if saved_paths:
                        paths_md = '\n'.join(f'  {i+1}. `{p}`' for i, p in enumerate(saved_paths))
                        note = (f'\n\n[SYSTEM] 当前模型 `{mname}` 不支持原生图像识别，'
                                f'用户本轮附带的 {len(saved_paths)} 张图片已保存到以下路径：\n'
                                f'{paths_md}\n'
                                '如需识别图片内容，**只能**使用 OCR 工具（如 rapidocr）读取**上述确切路径**，'
                                '禁止扫描其他目录或读取任何未在上述列表中的文件。'
                                '如果 OCR 无法满足需求，请提示用户切换到支持视觉的模型（如 gpt-4o/claude-3.5/qwen-vl）。')
                    else:
                        note = (f'\n\n[SYSTEM] 当前模型 `{mname}` 不支持图像识别，'
                                f'且 {len(images)} 张附图保存失败，已丢弃。请提示用户切换视觉模型或改用 OCR。')
                    user_input = user_input + note
            gen = self._interruptible(agent_runner_loop(
                                self.llmclient, sys_prompt, user_input,
                                handler, TOOLS_SCHEMA, max_turns=80, verbose=self.verbose,
                                initial_user_content=initial_content, yield_info=True))
            try:
                full_resp = ""; last_pos = 0
                for chunk in gen:
                    if consume_file(self.task_dir, '_stop'): self.abort() 
                    if self.stop_sig: break
                    if isinstance(chunk, dict): continue  # yield_info dict, skip
                    full_resp += chunk
                    if len(full_resp) - last_pos > 50 or 'LLM Running' in chunk:
                        display_queue.put({'next': full_resp[last_pos:] if self.inc_out else full_resp, 'source': source})
                        last_pos = len(full_resp)
                if self.inc_out and last_pos < len(full_resp): display_queue.put({'next': full_resp[last_pos:], 'source': source})
                if '</summary>' in full_resp: full_resp = full_resp.replace('</summary>', '</summary>\n\n')
                if '</file_content>' in full_resp: full_resp = re.sub(r'<file_content>\s*(.*?)\s*</file_content>', r'\n````\n<file_content>\n\1\n</file_content>\n````', full_resp, flags=re.DOTALL)                
                display_queue.put({'done': full_resp, 'source': source})
                self.history = handler.history_info
            except Exception as e:
                print(f"Backend Error: {format_error(e)}")
                display_queue.put({'done': full_resp + f'\n```\n{format_error(e)}\n```', 'source': source})
            finally:
                if self.stop_sig: print('User aborted the task.')
                self.is_running = self.stop_sig = False
                self.task_queue.task_done()
                if self.handler is not None: self.handler.code_stop_signal.append(1)

GeneraticAgent = GenericAgent    

if __name__ == '__main__':
    import argparse
    from datetime import datetime
    parser = argparse.ArgumentParser()
    parser.add_argument('--task', metavar='IODIR', help='一次性任务模式(文件IO)')
    parser.add_argument('--reflect', metavar='SCRIPT', help='反射模式：加载监控脚本，check()触发时发任务')
    parser.add_argument('--input', help='prompt')
    parser.add_argument('--llm_no', type=int, default=0)
    parser.add_argument('--verbose', action='store_true')
    parser.add_argument('--nobg', action='store_true')
    args, _unknown = parser.parse_known_args()
    _reflect_args = dict(zip([k.lstrip('-') for k in _unknown[::2]], _unknown[1::2])) if _unknown else {}

    if args.task and not args.nobg:
        import subprocess, platform
        cmd = [sys.executable, os.path.abspath(__file__)] + [a for a in sys.argv[1:]] + ['--nobg']
        d = os.path.join(script_dir, f'temp/{args.task}'); os.makedirs(d, exist_ok=True)
        p = subprocess.Popen(cmd, cwd=script_dir,
            creationflags=0x08000000 if platform.system() == 'Windows' else 0,
            stdout=open(os.path.join(d, 'stdout.log'), 'w', encoding='utf-8'),
            stderr=open(os.path.join(d, 'stderr.log'), 'w', encoding='utf-8'))
        print('PID:', p.pid); sys.exit(0)

    agent = GeneraticAgent()
    agent.next_llm(args.llm_no)
    agent.verbose = args.verbose
    threading.Thread(target=agent.run, daemon=True).start()

    if args.task:
        agent.peer_hint = False
        agent.force_non_stream = True
        agent.task_dir = d = os.path.join(script_dir, f'temp/{args.task}'); nround = ''
        infile = os.path.join(d, 'input.txt')
        if args.input:
            os.makedirs(d, exist_ok=True)
            import glob; [os.remove(f) for f in glob.glob(os.path.join(d, 'output*.txt'))]
            with open(infile, 'w', encoding='utf-8') as f: f.write(args.input)
        if (fh := consume_file(d, '_history.json')): agent.llmclient.backend.history = json.loads(fh)
        with open(infile, encoding='utf-8') as f: raw = f.read()
        while True:
            dq = agent.put_task(raw, source='task')
            while 'done' not in (item := dq.get(timeout=1200)): 
                if 'next' in item and random.random() < 0.95:  # 概率写一次中间结果
                    with open(f'{d}/output{nround}.txt', 'w', encoding='utf-8') as f: f.write(item.get('next', ''))
            with open(f'{d}/output{nround}.txt', 'w', encoding='utf-8') as f: f.write(item['done'] + '\n\n[ROUND END]\n')
            consume_file(d, '_stop')  # 已经成功停下来了，避免打断下次reply
            for _ in range(300):  # 等reply.txt，10分钟超时
                time.sleep(2)
                if (raw := consume_file(d, 'reply.txt')): break
            else: break
            nround = nround + 1 if isinstance(nround, int) else 1
    elif args.reflect:
        agent.peer_hint = False
        agent.force_non_stream = True
        import importlib.util
        spec = importlib.util.spec_from_file_location('reflect_script', args.reflect)
        mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        if hasattr(mod, 'init'): mod.init(_reflect_args)
        _mt = os.path.getmtime(args.reflect)
        print(f'[Reflect] loaded {args.reflect}' + (f' args={_reflect_args}' if _reflect_args else ''))
        while True:
            if os.path.getmtime(args.reflect) != _mt:
                try:
                    spec.loader.exec_module(mod); _mt = os.path.getmtime(args.reflect)
                    if hasattr(mod, 'init'): mod.init(_reflect_args)
                    print('[Reflect] reloaded')
                except Exception as e: print(f'[Reflect] reload error: {e}')
            try: task = mod.check()
            except Exception as e: 
                print(f'[Reflect] check() error: {e}'); task = None
            if task and task == '/exit': break
            if not task:
                time.sleep(getattr(mod, 'INTERVAL', 5)); continue
            print(f'[Reflect] triggered: {task[:80]}')
            dq = agent.put_task(task, source='reflect')
            try:
                while 'done' not in (item := dq.get(timeout=1200)): pass
                result = item['done']
                print(result)
            except Exception as e:
                if getattr(mod, 'ONCE', False): raise
                print(f'[Reflect] drain error: {e}'); result = f'[ERROR] {e}'
            log_dir = os.path.join(script_dir, 'temp/reflect_logs'); os.makedirs(log_dir, exist_ok=True)
            script_name = os.path.splitext(os.path.basename(args.reflect))[0]
            open(os.path.join(log_dir, f'{script_name}_{datetime.now():%Y-%m-%d}.log'), 'a', encoding='utf-8').write(f'[{datetime.now():%m-%d %H:%M}]\n{result}\n\n')
            if (on_done := getattr(mod, 'on_done', None)):
                try: on_done(result)
                except Exception as e: print(f'[Reflect] on_done error: {e}')
            if getattr(mod, 'ONCE', False): print('[Reflect] ONCE=True, exiting.'); break
    else:
        try: import readline
        except Exception: pass
        agent.inc_out = True
        while True:
            q = input('> ').strip()
            if not q: continue
            try:
                dq = agent.put_task(q, source='user')
                while True:
                    item = dq.get()
                    if 'next' in item: print(item['next'], end='', flush=True)
                    if 'done' in item: print(); break
            except KeyboardInterrupt:
                agent.abort()
                print('\n[Interrupted]')
