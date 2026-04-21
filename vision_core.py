import json, re, time, requests, base64, uuid
from pathlib import Path
from io import BytesIO
from datetime import datetime
import threading
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
except ImportError: pass

# ─── Config Loading ───────────────────────────────────────────────────────────

def _load_mykeys():
    try:
        import mykey
        return {k: v for k, v in vars(mykey).items() if not k.startswith('_')}
    except ImportError:
        return {}

def _get_vision_conf(key='native_claude_config'):
    """Load vision config from mykey or mykey.json"""
    mykeys = _load_mykeys()
    if key in mykeys:
        conf = mykeys[key]
        if isinstance(conf, dict) and 'apikey' in conf:
            return conf
    # fallback: mykey.json
    json_path = Path(__file__).parent / 'mykey.json'
    if json_path.exists():
        with open(json_path, encoding='utf-8') as f:
            data = json.load(f)
        for k in [key, 'nativeClaudeConfig', 'native_claude_config']:
            if k in data and isinstance(data[k], dict):
                return data[k]
    raise RuntimeError(f"vision_core: 未找到配置 {key}")

# ─── Image Encoding ─────────────────────────────────────────────────────────────

def encode_image(img_source):
    """str/Path/bytes/PIL.Image/stream → base64 str"""
    if hasattr(img_source, 'read'):
        data = img_source.read()
    elif isinstance(img_source, (str, os.PathLike)):
        with open(img_source, 'rb') as f:
            data = f.read()
    elif isinstance(img_source, bytes):
        data = img_source
    elif hasattr(img_source, 'convert'):  # PIL.Image
        buf = BytesIO()
        img_source.save(buf, format='JPEG')
        data = buf.getvalue()
    else:
        raise ValueError(f"Unsupported image source: {type(img_source)}")
    return base64.b64encode(data).decode('utf-8')

def get_image_media_type(img_source):
    """Guess MIME type from source"""
    cls_name = img_source.__class__.__name__
    if cls_name == 'Image' or (hasattr(img_source, 'convert') and hasattr(img_source, 'size')):
        fmt = getattr(img_source, 'format', None) or 'JPEG'
        if fmt: fmt = fmt.upper()
        return {'JPEG': 'image/jpeg', 'JPG': 'image/jpeg', 'PNG': 'image/png',
                'GIF': 'image/gif', 'WEBP': 'image/webp'}.get(fmt, 'image/jpeg')
    if isinstance(img_source, (str, os.PathLike)):
        ext = Path(img_source).suffix.lower()
        return {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
                '.gif': 'image/gif', '.webp': 'image/webp'}.get(ext, 'image/jpeg')
    return 'image/jpeg'

# ─── SSE Parsing ───────────────────────────────────────────────────────────────

def _parse_vision_sse(resp_iter):
    """Parse Claude vision SSE stream → content blocks"""
    content_text, blocks = '', []
    for line in resp_iter:
        if isinstance(line, bytes):
            line = line.decode('utf-8', errors='replace')
        if not line or line.strip() == '':
            continue
        if line.startswith('data:'):
            data_str = line[5:].strip()
            if data_str == '[DONE]':
                break
            try:
                evt = json.loads(data_str)
            except:
                continue
            typ = evt.get('type', '')
            # OpenAI/chunk format: choices[0].delta.content
            if 'choices' in evt:
                delta = (evt.get('choices') or [{}])[0].get('delta', {})
                content = delta.get('content', '')
                if content:
                    content_text += content
            # Anthropic format
            elif typ == 'content_block_start':
                block = evt.get('content_block', {})
                if block.get('type') == 'thinking':
                    blocks.append({'type': 'thinking', 'thinking': ''})
            elif typ == 'content_block_delta':
                delta = evt.get('delta', {})
                dtyp = delta.get('type', '')
                if dtyp == 'thinking_delta':
                    text = delta.get('thinking', '')
                    content_text += text
                    if blocks and blocks[-1]['type'] == 'thinking':
                        blocks[-1]['thinking'] += text
                elif dtyp == 'text_delta':
                    text = delta.get('text', '')
                    content_text += text
            elif typ == 'content_block_end':
                pass
            elif typ == 'message_delta':
                pass
    if content_text:
        blocks.append({'type': 'text', 'text': content_text})
    return blocks

# ─── Base Vision Session ───────────────────────────────────────────────────────

class VisionSession:
    """Vision API session with config, history, streaming."""
    def __init__(self, cfg=None):
        cfg = cfg or _get_vision_conf()
        self._cfg = cfg
        self.api_key = cfg['apikey']
        self.api_base = cfg.get('apibase', '').rstrip('/')
        self.model = cfg.get('model', 'claude-sonnet-4-7')
        self.max_tokens = cfg.get('max_tokens', 8192)
        self.temperature = cfg.get('temperature', 1)
        self.timeout = cfg.get('timeout', (10, 120))
        proxy = cfg.get('proxy')
        self.proxies = {'http': proxy, 'https': proxy} if proxy else None
        self.history = []
        self.lock = threading.Lock()
        self.name = f"vision/{self.model}"

    def raw_call(self, messages, stream=True):
        raise NotImplementedError

    def call(self, image_source, prompt='描述这张图片', stream=False):
        encoded = encode_image(image_source)
        media_type = get_image_media_type(image_source)
        msg = {
            'role': 'user',
            'content': [
                {'type': 'text', 'text': prompt},
                {'type': 'image', 'source': {'type': 'base64', 'media_type': media_type, 'data': encoded}}
            ]
        }
        if stream:
            return self._stream_call([msg])
        return ''.join(list(self._stream_call([msg])))

    def _stream_call(self, messages):
        gen = self.raw_call(messages, stream=True)
        for chunk in gen:
            if chunk: yield chunk

    def reset(self):
        with self.lock:
            self.history.clear()

# ─── Native Claude Vision Session ─────────────────────────────────────────────

class NativeVisionSession(VisionSession):
    """Claude direct vision API via /v1/messages (SSE streaming)"""
    def raw_call(self, messages, stream=True):
        headers = {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'claude-code-20250219,prompt-caching-scope-2026-01-05',
        }
        if self.api_key.startswith('sk-ant-'):
            headers['x-api-key'] = self.api_key
        else:
            headers['Authorization'] = f"Bearer {self.api_key}"

        payload = {
            'model': self.model,
            'max_tokens': self.max_tokens,
            'messages': messages,
            'stream': stream,
        }
        if self.temperature != 1:
            payload['temperature'] = self.temperature

        api_url = f"{self.api_base}/v1/messages"
        if '/anthropic' not in api_url:
            api_url = api_url.replace('/v1/messages', '/anthropic/v1/messages')
        # But if api_base already has /v1/chat/completions (non-Anthropic backend), use it as-is
        if '/v1/chat/completions' in self.api_base:
            api_url = f"{self.api_base}/chat/completions"

        try:
            with requests.post(api_url, headers=headers, json=payload,
                               proxies=self.proxies, stream=stream,
                               timeout=self.timeout) as r:
                if r.status_code != 200:
                    err = r.content.decode('utf-8', errors='replace')[:500]
                    yield f"Error: HTTP {r.status_code}: {err}"
                    return
                blocks = list(_parse_vision_sse(r.iter_lines()))
                for b in blocks:
                    if b.get('type') == 'text':
                        yield b['text']
                    elif b.get('type') == 'thinking':
                        pass
                return blocks
        except Exception as e:
            yield f"Error: {e}"
            return []

# ─── GPT Vision Session ───────────────────────────────────────────────────────

class GPTVisionSession(VisionSession):
    """OpenAI GPT-4o vision API via /chat/completions"""
    def raw_call(self, messages, stream=True):
        headers = {
            'Authorization': f"Bearer {self.api_key}",
            'Content-Type': 'application/json',
        }
        api_url = f"{self.api_base}/v1/chat/completions"
        if '/v1' not in api_url:
            api_url = api_url.replace('/chat/completions', '/v1/chat/completions')

        oai_msgs = []
        for msg in messages:
            role = msg.get('role', 'user')
            content = msg.get('content', [])
            if not isinstance(content, list):
                content = [{'type': 'text', 'text': str(content)}]
            oai_content = []
            for part in content:
                if part.get('type') == 'text':
                    oai_content.append({'type': 'text', 'text': part['text']})
                elif part.get('type') == 'image':
                    src = part.get('source', {})
                    if src.get('type') == 'base64':
                        mt = src.get('media_type', 'image/jpeg')
                        oai_content.append({'type': 'image_url', 'image_url': {'url': f"data:{mt};base64,{src.get('data', '')}"}})
            oai_msgs.append({'role': role, 'content': oai_content})

        # Non-streaming path: use stream=False to get full response
        if not stream:
            headers = {
                'Content-Type': 'application/json',
                'Authorization': f"Bearer {self.api_key}"
            }
            api_url = f"{self.api_base}/v1/chat/completions"
            if '/v1' not in api_url:
                api_url = api_url.replace('/chat/completions', '/v1/chat/completions')

            payload = {
                'model': self.model,
                'messages': oai_msgs,
                'max_tokens': self.max_tokens,
                'stream': False,
            }
            if self.temperature != 1:
                payload['temperature'] = self.temperature

            with requests.post(api_url, headers=headers, json=payload,
                               proxies=self.proxies, timeout=self.timeout) as r:
                if r.status_code != 200:
                    err = r.content.decode('utf-8', errors='replace')[:500]
                    yield f"Error: HTTP {r.status_code}: {err}"
                    return
                data = r.json()
                content = (data.get('choices') or [{}])[0].get('message', {}).get('content', '')
                if content:
                    yield content
                return

        payload = {
            'model': self.model,
            'messages': oai_msgs,
            'max_tokens': self.max_tokens,
            'stream': stream,
        }
        if self.temperature != 1:
            payload['temperature'] = self.temperature

        try:
            with requests.post(api_url, headers=headers, json=payload,
                               proxies=self.proxies, stream=stream,
                               timeout=self.timeout) as r:
                if r.status_code != 200:
                    err = r.content.decode('utf-8', errors='replace')[:500]
                    yield f"Error: HTTP {r.status_code}: {err}"
                    return
                if stream:
                    for line in r.iter_lines():
                        if isinstance(line, bytes):
                            line = line.decode('utf-8', errors='replace')
                        line = line.strip()
                        if not line:
                            continue
                        # SSE format: "data: {...}"
                        if line.startswith('data:'):
                            data_str = line[5:].strip()
                            if data_str == '[DONE]':
                                break
                            try:
                                evt = json.loads(data_str)
                                delta = (evt.get('choices') or [{}])[0].get('delta', {})
                                if delta.get('content'):
                                    yield delta['content']
                            except:
                                continue
                        else:
                            # Non-SSE JSON response (plain JSON, e.g. minimax)
                            try:
                                evt = json.loads(line)
                                content = (evt.get('choices') or [{}])[0].get('message', {}).get('content', '')
                                if content:
                                    yield content
                            except:
                                continue
                else:
                    data = r.json()
                    yield data.get('choices', [{}])[0].get('message', {}).get('content', '')
                return []
        except Exception as e:
            yield f"Error: {e}"
            return []

# ─── Factory ───────────────────────────────────────────────────────────────────

BACKENDS = {
    'claude': NativeVisionSession,
    'gpt': GPTVisionSession,
}

def create_vision_session(backend=None, cfg=None):
    backend = (backend or 'claude').lower()
    cls = BACKENDS.get(backend)
    if not cls:
        raise ValueError(f"Unknown vision backend: {backend}. Available: {list(BACKENDS.keys())}")
    return cls(cfg or _get_vision_conf())

# ─── Quick API ─────────────────────────────────────────────────────────────────

_default_session = None

def vision_call(image_source, prompt='描述这张图片', backend=None, stream=False, session=None):
    if session is None:
        global _default_session
        if _default_session is None:
            _default_session = create_vision_session(backend)
        session = _default_session
    return session.call(image_source, prompt, stream=stream)

def reset_session():
    global _default_session
    if _default_session:
        _default_session.reset()
    _default_session = None

# ─── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("用法: python vision_core.py <图片路径> [prompt] [backend]")
        sys.exit(1)
    img_path = sys.argv[1]
    prompt = sys.argv[2] if len(sys.argv) > 2 else '描述这张图片'
    backend = sys.argv[3] if len(sys.argv) > 3 else None
    result = vision_call(img_path, prompt, backend, stream=False)
    print(result)
