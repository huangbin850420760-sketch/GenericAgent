"""Live2D Desktop Pet — 桌面透明窗口版
用 pywebview 创建无边框+透明+置顶窗口，内嵌 HTTP 服务提供 /static/ 路由，
零修改复用 web/live2d_pet.js + web/live2d/ 全部渲染资源。
退出：Alt+F4 / 右键菜单 / 托盘（如有）
"""
import os, sys, threading, json
import webview
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(HERE, 'web')          # web/ 目录（含 live2d/, live2d_pet.js）
HTTP_PORT = 51984                            # 桌面宠物专用端口（不与 webapp 冲突）
MODEL = 'shizuku'                            # 默认模型：shizuku/haru/siluokayi/yiselin/kp31

# ── 1. 内嵌静态 HTTP 服务（提供 /static/ 虚拟路由，映射到 web/ 真实目录）──
class _Handler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'   # keep-alive，减少 pywebview 反复建连
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB_DIR, **kw)
    def log_message(self, *a): pass
    def end_headers(self):
        # keep-alive 必须有 Content-Length（_serve_desktop_html 已设；静态文件父类已设）
        super().end_headers()
    def do_GET(self):
        path = urlparse(self.path).path
        # /static/xxx → web/xxx （live2d_pet.js 用 ./static/ 前缀加载库和模型）
        if path.startswith('/static/'):
            self.path = path[len('/static/'):]
        # 根路径 → 返回内联桌面 HTML
        elif path in ('/', '/index.html', '/desktop.html'):
            return self._serve_desktop_html()
        super().do_GET()
    def _serve_desktop_html(self):
        html = DESKTOP_HTML.replace('__MODEL__', MODEL)
        body = html.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get('Content-Length', 0))
        payload = self.rfile.read(length) if length else b''
        if path == '/_status':
            # 把 JS 上报的渲染状态写到文件，供 Python 侧诊断
            try:
                with open(os.path.join(os.path.dirname(HERE), 'temp', 'live2d_status.json'), 'wb') as f:
                    f.write(payload)
            except Exception:
                pass
            body = b'{"ok":true}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.send_header('Content-Length', '0')
            self.end_headers()

def _start_http():
    srv = ThreadingHTTPServer(('127.0.0.1', HTTP_PORT), _Handler)
    srv.daemon_threads = True      # 子线程随主进程退出，防止僵尸 CLOSE_WAIT
    srv.serve_forever()

# ── 2. 桌面专用 HTML（精简，只渲染宠物，背景透明）──
DESKTOP_HTML = r'''<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:100%; height:100%; overflow:hidden; background:transparent; }
  body {
    /* -webkit-app-region: drag;  ← 不用，live2d_pet.js 自己实现拖拽 */
    user-select:none; -webkit-user-select:none;
    font-family: "Microsoft YaHei", sans-serif;
  }
  #pet-container {
    position:absolute; left:0; top:0; width:100%; height:100%;
    /* 让容器可接收指针事件，但窗口其余区域穿透 */
    cursor:grab;
  }
  #pet-canvas-l2d { display:block; }
  /* 错误显示（无 DevTools 环境用） */
  #pet-err {
    position:fixed; left:8px; top:8px; right:8px; padding:10px;
    background:rgba(220,40,40,0.92); color:#fff; border-radius:8px;
    font-size:13px; display:none; white-space:pre-wrap; z-index:9999;
  }
</style></head>
<body>
  <div id="pet-container">
    <canvas id="pet-canvas-l2d" width="340" height="420" style="width:100%;height:100%;will-change:transform;"></canvas>
  </div>
  <div id="pet-err"></div>

  <!-- 复用主项目的 live2d_pet.js（非模块，注册 window.initLive2DPet） -->
  <script src="/static/live2d_pet.js?v=2026061207"></script>
  <script>
    function _report(st){
      st.ts = Date.now();
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/_status', true);
        xhr.send(JSON.stringify(st));
      } catch(_) {}
    }
    window.addEventListener('error', function(e){
      var msg = '[JS Error] ' + (e.message||'') + (e.filename?(' @'+e.filename.split('/').pop()+':'+e.lineno):'') + (e.error&&e.error.stack?('\n'+e.error.stack):'');
      var el=document.getElementById('pet-err');
      el.style.display='block'; el.textContent=msg;
      _report({kind:'error', msg: msg.slice(0,1500)});
    });
    window.addEventListener('unhandledrejection', function(e){
      var r = e.reason;
      var msg = '[Promise] ' + (r&&(r.stack||r.message||r));
      var el=document.getElementById('pet-err');
      el.style.display='block'; el.textContent=msg;
      _report({kind:'rejection', msg: String(msg).slice(0,1500)});
    });
    window.addEventListener('load', function(){
      // 确保 live2d_pet.js 已注册 initLive2DPet
      function boot(){
        if (typeof window.initLive2DPet === 'function') {
          window.initLive2DPet('__MODEL__');
          console.log('[Live2D Desktop] booted with model=__MODEL__');
        } else {
          setTimeout(boot, 100);  // 等脚本加载
        }
      }
      boot();
      // 状态上报：3秒后把渲染状态POST到本地状态端点(写文件供Python侧诊断)
      setTimeout(function(){
        var st = {
          ts: Date.now(),
          hasPixi: typeof PIXI !== 'undefined',
          hasInit: typeof window.initLive2DPet === 'function',
          canvasW: (document.getElementById('pet-canvas-l2d')||{}).width,
          pet: window.live2dPet ? Object.keys(window.live2dPet) : null,
          errVisible: (document.getElementById('pet-err')||{}).style ? document.getElementById('pet-err').style.display : 'n/a'
        };
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/_status', true);
        xhr.send(JSON.stringify(st));
      }, 3000);
      // 8秒再报一次(模型加载较慢)
      setTimeout(function(){
        var st = {
          ts: Date.now(), late: true,
          hasPixi: typeof PIXI !== 'undefined',
          pet: window.live2dPet ? Object.keys(window.live2dPet) : null,
          errText: (document.getElementById('pet-err')||{}).textContent || ''
        };
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/_status', true);
        xhr.send(JSON.stringify(st));
      }, 8000);
    });
  </script>
</body></html>'''

# ── 3. pywebview 桌面透明窗口 ──
class Api:
    """JS↔Python 桥（预留：远程通知/退出/换模型）"""
    def notify(self, msg):
        # 前端可调用 pywebview.api.notify('xxx') → 转发到 live2d_pet.js 的 __petNotify
        webview.windows[0].evaluate_js(
            "if(window.__petNotify){window.__petNotify(" + json.dumps(msg) + ")}")
        return True
    def quit(self):
        for w in webview.windows: w.destroy()
        return True
    def switchModel(self, name):
        webview.windows[0].evaluate_js(
            "if(window.__petSwitch){window.__petSwitch(" + json.dumps(name) + ")}")
        return True

def main():
    # 解析命令行参数（可选模型名）
    global MODEL
    if len(sys.argv) > 1 and sys.argv[1] in ('shizuku','haru','siluokayi','yiselin','kp31'):
        MODEL = sys.argv[1]

    # 启动内嵌 HTTP
    threading.Thread(target=_start_http, daemon=True).start()
    url = f'http://127.0.0.1:{HTTP_PORT}/'

    # 创建透明置顶无边框窗口（浮在桌面）
    win = webview.create_window(
        title='Live2D Pet',
        url=url,
        width=340, height=420,
        x=100, y=None,            # 起始位置（y=None=垂直居中）
        resizable=False,
        frameless=True,           # 无边框
        easy_drag=False,          # 关闭系统拖拽（live2d_pet.js 自己实现拖拽）
        transparent=True,         # 透明背景 ← 关键
        on_top=True,              # 置顶
    )

    # ── 启动后探针：通过 evaluate_js 主动查询 JS 内部真实状态（不依赖 DOM 事件）──
    LOG = os.path.join(os.path.dirname(HERE), 'temp', 'live2d_probe.log')
    def _probe():
        import time as _t
        _t.sleep(10)   # 等模型加载
        for delay in (0, 5, 10):
            _t.sleep(delay)
            try:
                js = ("(function(){"
                      "var r={};"
                      "r.hasPixi=(typeof PIXI!=='undefined');"
                      "r.hasInit=(typeof window.initLive2DPet==='function');"
                      "r.hasL2M_global=(typeof Live2DModel!=='undefined');"
                      "r.hasL2M_PIXI=PIXI?!!PIXI.Live2DModel:false;"
                      "r.hasL2M_l2d=(PIXI&&PIXI.live2d)?!!PIXI.live2d.Live2DModel:false;"
                      "r.PIXIkeys=PIXI?Object.keys(PIXI).filter(function(k){return /live|model|cubism/i.test(k);}).join(','):'noPIXI';"
                      "r.scriptTags=Array.prototype.map.call(document.querySelectorAll('script'),function(s){return s.src;}).join('||');"
                      "r.l2dPetKeys=window.live2dPet?Object.keys(window.live2dPet).join(','):'null';"
                      "r.errEl=document.getElementById('pet-err')?document.getElementById('pet-err').outerHTML.slice(0,200):'none';"
                      "r.curModel=(window.live2dPet&&window.live2dPet.getModel)?String(window.live2dPet.getModel()):'n/a';"
                      "r.canvas=!!document.getElementById('pet-canvas-l2d');"
                      "var c=document.getElementById('pet-canvas-l2d');"
                      "r.canvasSize=c?(c.width+'x'+c.height):'none';"
                      "try{r.gl=c?!!c.getContext('webgl2')||!!c.getContext('webgl'):'nocanvas';}catch(e){r.gl='err:'+e.message;}"
                      "r.live2dPet=window.live2dPet?(Object.keys(window.live2dPet)):'null';"
                      "r.errVisible=document.getElementById('pet-err')?document.getElementById('pet-err').style.display:'na';"
                      "r.errText=document.getElementById('pet-err')?document.getElementById('pet-err').textContent:'';"
                      "r.scriptTags=Array.from(document.scripts).map(function(s){return s.src||'inline';});"
                      "r.manualInit='pending';"
                      "try{Promise.resolve(window.initLive2DPet?window.initLive2DPet():'nofn').then(function(v){r.manualInit='resolved:'+(v===undefined?'undef':typeof v);},function(e){r.manualInit='rejected:'+(e&&e.stack?e.stack:(String(e))).slice(0,300);});}catch(e){r.manualInit='syncErr:'+(e&&e.stack?e.stack:String(e)).slice(0,300);}"
                      "setTimeout(function(){var s=document.getElementById('pet-err');var st2={};st2.errVisible=s?s.style.display:'none';st2.errText=s?s.textContent:'';st2.live2dPet=window.live2dPet?'ok':'null';st2.manualInit=r.manualInit;var x=new XMLHttpRequest();x.open('POST','/_status',true);x.send(JSON.stringify(st2));},4000);"
                      "return JSON.stringify(r);})()")
                result = win.evaluate_js(js)
                with open(LOG, 'a', encoding='utf-8') as f:
                    f.write(f'[probe delay={delay}] {result}\n')
            except Exception as e:
                with open(LOG, 'a', encoding='utf-8') as f:
                    f.write(f'[probe delay={delay}] EXC {e}\n')
    threading.Thread(target=_probe, daemon=True).start()

    # constitution#11: private_mode=False 确保 localStorage/cookie 可用
    webview.start(private_mode=False, debug=False)

if __name__ == '__main__':
    main()
