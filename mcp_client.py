"""
MCP (Model Context Protocol) Client for GenericAgent
Supports both HTTP and Stdio transports.
"""
import json, os, subprocess, threading, time, logging, atexit
from typing import Any, Optional

log = logging.getLogger('mcp')

# ── JSON-RPC helpers ──────────────────────────────────────────────
_rpc_id = 0
def _next_id():
    global _rpc_id; _rpc_id += 1; return _rpc_id

def _rpc_request(method, params=None):
    req = {"jsonrpc": "2.0", "id": _next_id(), "method": method}
    if params: req["params"] = params
    return req

# ── Transport layer ──────────────────────────────────────────────
class StdioTransport:
    """Communicate with MCP server via stdin/stdout subprocess."""
    def __init__(self, command, args=None, env=None, cwd=None):
        self.command = command
        self.args = args or []
        self.env = {**os.environ, **(env or {})}
        self.cwd = cwd
        self.proc = None
        self._lock = threading.Lock()
        self._reader_thread = None
        self._responses = {}  # id → result
        self._events = {}     # id → threading.Event
        self._buf = b''

    def start(self):
        cmd = [self.command] + self.args
        self.proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=self.env, cwd=self.cwd,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        )
        self._reader_thread = threading.Thread(target=self._read_loop, daemon=True)
        self._reader_thread.start()
        atexit.register(self.close)
        log.info(f"StdioTransport started: {self.command} {' '.join(self.args)}")

    def _read_loop(self):
        while self.proc and self.proc.poll() is None:
            try:
                # MCP stdio uses newline-delimited JSON or Content-Length header
                line = self.proc.stdout.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                # Handle Content-Length header
                if line.startswith(b'Content-Length:'):
                    length = int(line.split(b':')[1].strip())
                    self.proc.stdout.readline()  # empty line separator
                    body = self.proc.stdout.read(length)
                    self._handle_message(body)
                else:
                    self._handle_message(line)
            except Exception as e:
                log.error(f"StdioTransport read error: {e}")
                break

    def _handle_message(self, raw):
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            log.warning(f"Non-JSON from MCP server: {raw[:200]}")
            return
        rid = msg.get('id')
        if rid is not None:
            self._responses[rid] = msg
            evt = self._events.get(rid)
            if evt: evt.set()

    def send(self, request, timeout=30):
        rid = request['id']
        evt = threading.Event()
        self._events[rid] = evt
        self._responses.pop(rid, None)
        body = json.dumps(request)
        with self._lock:
            # Send both Content-Length header format AND newline-delimited JSON
            # to ensure compatibility with all MCP stdio servers
            encoded = body.encode('utf-8')
            header = f'Content-Length: {len(encoded)}\r\n\r\n'
            self.proc.stdin.write(header.encode() + encoded + '\n'.encode())
            self.proc.stdin.flush()
        if not evt.wait(timeout):
            self._events.pop(rid, None)
            raise TimeoutError(f"MCP request {rid} timed out after {timeout}s")
        resp = self._responses.pop(rid, None)
        self._events.pop(rid, None)
        if resp is None:
            raise RuntimeError(f"No response for MCP request {rid}")
        if 'error' in resp:
            raise RuntimeError(f"MCP error: {resp['error']}")
        return resp.get('result')

    def close(self):
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.stdin.close()
                self.proc.terminate()
                self.proc.wait(timeout=5)
            except Exception:
                try: self.proc.kill()
                except: pass
        self.proc = None

    @property
    def alive(self):
        return self.proc is not None and self.proc.poll() is None


class HTTPTransport:
    """Communicate with MCP server via Streamable HTTP (SSE response).
    
    BigModel MCP uses Streamable HTTP transport:
    - POST JSON-RPC → SSE response (text/event-stream)
    - Mcp-Session-Id header must be tracked and sent back
    - URL ends with /mcp for Streamable HTTP endpoint
    """
    def __init__(self, url, headers=None):
        # Auto-append /mcp if not present (Streamable HTTP endpoint)
        if not url.rstrip('/').endswith('/mcp'):
            url = url.rstrip('/') + '/mcp'
        self.url = url
        self.base_headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            **(headers or {})
        }
        self._session_id = None  # Mcp-Session-Id from server

    def start(self):
        log.info(f"HTTPTransport ready: {self.url}")

    def send(self, request, timeout=30):
        import requests as req_lib
        headers = {**self.base_headers}
        if self._session_id:
            headers['Mcp-Session-Id'] = self._session_id
        payload = json.dumps(request)
        resp = req_lib.post(self.url, data=payload, headers=headers, timeout=timeout)
        # Capture session id from response
        sid = resp.headers.get('Mcp-Session-Id')
        if sid:
            self._session_id = sid
        if resp.status_code != 200:
            raise RuntimeError(f"MCP HTTP {resp.status_code}: {resp.text[:500]}")
        # Notifications (no id) may return empty body
        if 'id' not in request:
            return None
        # Handle SSE or plain JSON
        ct = resp.headers.get('Content-Type', '')
        if 'text/event-stream' in ct:
            return self._parse_sse(resp.text)
        body = resp.json()
        if 'error' in body:
            raise RuntimeError(f"MCP error: {body['error']}")
        return body.get('result')

    def _parse_sse(self, text):
        """Parse SSE response - find the JSON-RPC result."""
        for block in text.split('\n\n'):
            data_line = None
            for line in block.split('\n'):
                if line.startswith('data:'):
                    data_line = line[5:].strip()
            if data_line:
                try:
                    msg = json.loads(data_line)
                    if 'error' in msg:
                        raise RuntimeError(f"MCP error: {msg['error']}")
                    return msg.get('result')
                except json.JSONDecodeError:
                    continue
        raise RuntimeError(f"Could not parse SSE response: {text[:300]}")

    def close(self):
        self._session_id = None

    @property
    def alive(self):
        return True


# ── MCP Client ───────────────────────────────────────────────────
class MCPClient:
    """Single MCP server connection."""
    def __init__(self, name, config):
        self.name = name
        self.config = config
        self.transport = None
        self.tools = []  # list of raw MCP tool definitions
        self._initialized = False

    def connect(self):
        """Start transport and perform MCP handshake."""
        stype = self.config.get('type', 'http')
        if stype == 'stdio':
            self.transport = StdioTransport(
                command=self.config.get('command', ''),
                args=self.config.get('args', []),
                env=self.config.get('env'),
                cwd=self.config.get('cwd')
            )
        else:  # http
            self.transport = HTTPTransport(
                url=self.config.get('url', ''),
                headers=self.config.get('headers')
            )
        self.transport.start()
        # MCP handshake: initialize (stdio needs longer timeout for npx cold start)
        init_timeout = 120 if isinstance(self.transport, StdioTransport) else 30
        result = self.transport.send(_rpc_request('initialize', {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "GenericAgent", "version": "1.0.0"}
        }), timeout=init_timeout)
        # Send initialized notification
        try:
            self.transport.send(_rpc_request('notifications/initialized'), timeout=10)
        except Exception:
            pass  # notifications may not get a response
        self._initialized = True
        log.info(f"MCP client '{self.name}' initialized: {result}")

    def discover_tools(self, timeout=None):
        """Call tools/list to get available tools."""
        if not self._initialized:
            self.connect()
        if timeout is None:
            timeout = 120 if isinstance(self.transport, StdioTransport) else 30
        result = self.transport.send(_rpc_request('tools/list', {}), timeout=timeout)
        self.tools = result.get('tools', []) if isinstance(result, dict) else []
        log.info(f"MCP '{self.name}' discovered {len(self.tools)} tools")
        return self.tools

    def call_tool(self, tool_name, arguments=None):
        """Call a specific tool on this MCP server."""
        if not self._initialized:
            self.connect()
        call_timeout = 120 if isinstance(self.transport, StdioTransport) else 30
        result = self.transport.send(_rpc_request('tools/call', {
            "name": tool_name,
            "arguments": arguments or {}
        }), timeout=call_timeout)
        # MCP returns content array
        if isinstance(result, dict) and 'content' in result:
            contents = result['content']
            texts = [c.get('text', '') for c in contents if c.get('type') == 'text']
            return '\n'.join(texts) if texts else json.dumps(contents, ensure_ascii=False)
        return json.dumps(result, ensure_ascii=False) if isinstance(result, dict) else str(result)

    def close(self):
        if self.transport:
            self.transport.close()

    @property
    def status(self):
        return {
            'name': self.name,
            'type': self.config.get('type', 'http'),
            'alive': self.transport.alive if self.transport else False,
            'tools_count': len(self.tools),
            'initialized': self._initialized
        }


# ── MCP Manager ──────────────────────────────────────────────────
class MCPManager:
    """Manages multiple MCP server connections."""
    def __init__(self):
        self.clients = {}  # name → MCPClient
        self._tools_index = {}  # "server_name/tool_name" → (client, tool_def)
        self._config_path = None
        self.disabled = set()  # disabled server names

    def load_config(self, path):
        """Load MCP servers from a JSON config file."""
        self._config_path = path
        if not os.path.isfile(path):
            log.warning(f"MCP config not found: {path}")
            return
        with open(path, 'r', encoding='utf-8') as f:
            cfg = json.load(f)
        servers = cfg.get('mcpServers', cfg)
        for name, server_cfg in servers.items():
            self.add_server(name, server_cfg)

    def save_config(self):
        """Save current config to file."""
        if not self._config_path:
            return
        cfg = {'mcpServers': {}}
        for name, client in self.clients.items():
            cfg['mcpServers'][name] = client.config
        os.makedirs(os.path.dirname(self._config_path), exist_ok=True)
        with open(self._config_path, 'w', encoding='utf-8') as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)

    def add_server(self, name, config):
        """Add and optionally connect to an MCP server."""
        if name in self.clients:
            self.remove_server(name)
        client = MCPClient(name, config)
        self.clients[name] = client
        try:
            client.connect()
            client.discover_tools()
            self._rebuild_index()
            log.info(f"Added MCP server '{name}' with {len(client.tools)} tools")
        except Exception as e:
            log.error(f"Failed to connect MCP server '{name}': {e}")

    def call_tool(self, server_name, tool_name, arguments=None):
        """Call a tool on a specific server. Returns result string."""
        if server_name not in self.clients:
            raise ValueError(f"MCP server '{server_name}' not found")
        if server_name in self.disabled:
            raise ValueError(f"MCP server '{server_name}' is disabled")
        client = self.clients[server_name]
        return client.call_tool(tool_name, arguments)

    def remove_server(self, name):
        """Remove and disconnect an MCP server."""
        client = self.clients.pop(name, None)
        if client:
            client.close()
        self.disabled.discard(name)
        self._rebuild_index()

    def toggle_server(self, name):
        """Toggle enabled/disabled state. Returns new state (True=enabled)."""
        if name not in self.clients:
            raise ValueError(f"MCP server '{name}' not found")
        if name in self.disabled:
            self.disabled.discard(name)
            self._rebuild_index()
            return True  # now enabled
        else:
            self.disabled.add(name)
            self._rebuild_index()
            return False  # now disabled

    def call(self, server_name, tool_name, arguments=None):
        """Call a tool on a specific MCP server."""
        client = self.clients.get(server_name)
        if not client:
            raise ValueError(f"MCP server '{server_name}' not found")
        return client.call_tool(tool_name, arguments)

    def call_by_key(self, key, arguments=None):
        """Call a tool by its full key (server_name/tool_name)."""
        entry = self._tools_index.get(key)
        if not entry:
            raise ValueError(f"MCP tool '{key}' not found")
        client, _ = entry
        return client.call_tool(key.split('/', 1)[1], arguments)

    def _rebuild_index(self):
        self._tools_index.clear()
        for name, client in self.clients.items():
            for tool in client.tools:
                tname = tool.get('name', '')
                self._tools_index[f"{name}/{tname}"] = (client, tool)

    def get_flat_tools(self):
        """Return MCP tools in OpenAI function-calling format (excludes disabled)."""
        schemas = []
        for name, client in self.clients.items():
            if name in self.disabled:
                continue
            for tool in client.tools:
                schema = self._mcp_to_openai(name, tool)
                schemas.append(schema)
        return schemas

    def get_flat_tools_dict(self):
        """Return {tool_name: (server_name, tool_def)} for quick lookup (excludes disabled)."""
        result = {}
        for name, client in self.clients.items():
            if name in self.disabled:
                continue
            for tool in client.tools:
                tname = tool.get('name', '')
                result[f"mcp_{name}_{tname}"] = (name, tname, tool)
        return result

    @staticmethod
    def _mcp_to_openai(server_name, mcp_tool):
        """Convert MCP tool definition to OpenAI function format."""
        tname = mcp_tool.get('name', 'unknown')
        desc = mcp_tool.get('description', '')
        input_schema = mcp_tool.get('inputSchema', {'type': 'object', 'properties': {}})
        return {
            "type": "function",
            "function": {
                "name": f"mcp_{server_name}_{tname}",
                "description": f"[MCP:{server_name}] {desc}",
                "parameters": input_schema
            }
        }

    def list_servers(self):
        """Return status of all servers including enabled state."""
        return {
            name: {
                'status': client.status,
                'enabled': name not in self.disabled,
                'tools_count': len(client.tools),
                'url': client.config.get('url', '')
            }
            for name, client in self.clients.items()
        }

    def get_server_tools(self, server_name):
        """Return tools for a specific server."""
        client = self.clients.get(server_name)
        return client.tools if client else []

    def reload(self):
        """Reconnect all servers."""
        for name, client in list(self.clients.items()):
            try:
                client.close()
                client.connect()
                client.discover_tools()
            except Exception as e:
                log.error(f"Reload failed for '{name}': {e}")
        self._rebuild_index()

    def close_all(self):
        for client in self.clients.values():
            client.close()
        self.clients.clear()
        self._tools_index.clear()

# ── Global singleton ──────────────────────────────
_global_manager: Optional['MCPManager'] = None

def init_global_manager(config_path: str) -> MCPManager:
    """Initialize the global MCPManager from a config file."""
    global _global_manager
    mgr = MCPManager()
    with open(config_path, 'r', encoding='utf-8') as f:
        cfg = json.load(f)
    for name, server_cfg in cfg.get('mcpServers', {}).items():
        try:
            mgr.add_server(name, server_cfg)
            log.info(f"MCP server '{name}' added from config")
        except Exception as e:
            log.error(f"Failed to add MCP server '{name}': {e}")
    _global_manager = mgr
    return mgr

def get_global_manager() -> Optional['MCPManager']:
    """Get the global MCPManager singleton."""
    return _global_manager
