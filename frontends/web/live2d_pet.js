// live2d_pet.js — Live2D Anime Pet (Shizuku / Haru) with pixi-live2d-display
// Mirrors pet3d.js window API: __petNotify / __petSwitch / __petGetConfig / __petApplyConfig / __petSetFlags
// Uses a SEPARATE canvas (#pet-canvas-l2d) so it doesn't conflict with Three.js (#pet-canvas)
(() => {
  'use strict';

  // ── State ──
  let app = null;          // PIXI.Application
  let model = null;        // Live2DModel instance
  let currentModel = 'shizuku';
  let petCustomName = '';
  let bubbleEl = null;
  let bubbleTimer = null;
  let destroyed = false;
  // ── 互动增强状态 ──
  let idleTimer = null;           // 随机闲聊计时器
  let lastInteractTs = Date.now(); // 最后互动时间
  let dragInfo = null;            // 拖拽信息
  let followBound = false;        // 鼠标跟随是否已绑定

  const MODELS = {
    shizuku: { label: '雫 Shizuku', url: './static/live2d/models/shizuku/shizuku.model.json', cubism: 2 },
    haru:    { label: '春 Haru',    url: './static/live2d/models/haru/haru_greeter_t03.model3.json', cubism: 4 },
    siluokayi: { label: '丝罗卡伊', url: './static/live2d/models/siluokayi/model.model.json', cubism: 2 },
    yiselin: { label: '伊瑟琳', url: './static/live2d/models/yiselin/model.json', cubism: 2 },
    kp31:    { label: 'KP31',  url: './static/live2d/models/kp31/model.json', cubism: 2 },
  };

  // ── 话术库（多场景随机句子）──
  const PHRASES = {
    greet:  ['你好呀~ 我是{name}！', '终于等到你啦~', '嗨！今天也要元气满满哦！', '欢迎回来，{name}陪你~'],
    click:  ['嘿嘿，痒痒的~', '再点我一下嘛！', '干嘛戳我啦 (>///<)', '你戳到我啦！', '嗯？叫我吗？', '点我我就给你卖萌！'],
    head:   ['呀！不要摸头啦~', '头都要被摸秃了！', '嘿嘿...其实挺舒服的', '再摸我就生气了哦！', '呜哇~好害羞'],
    idle:   ['在想什么呢？', '...好无聊啊，陪我聊聊天嘛', '咦？你还在吗？', '要不要休息一下？', '我盯着你很久了哦~', '发呆中... (´-ω-`)', '突然好想吃零食'],
    switch: ['我来啦！是{name}哦~', '切换成功！多关照~', '闪亮登场✨'],
    drag:   ['哇！别突然拉我！', '我们去哪里呀？', '头晕晕的... (>_<)', '放我下来嘛~'],
    dbl:    ['哇！被吓到了！', '双击暴击！', '诶诶诶？！', '心跳加速了...'],
  };
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)].replace(/\{name\}/g, () => petCustomName || MODELS[currentModel]?.label || '我'); }

  // ── Ensure the Live2D libs are loaded (non-module, global) ──
  const LIB_BASE = './static/live2d/lib/';
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[data-l2d="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.dataset.l2d = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  async function loadLibs(cubismVersion) {
    // 1. PIXI core first
    await loadScript(LIB_BASE + 'pixi.min.js');
    // 2. Cubism runtime BEFORE pixi-live2d-display (it checks for runtime on load)
    //    - Cubism 2: live2d.min.js  |  Cubism 4: live2dcubismcore.min.js
    if (cubismVersion === 2) {
      await loadScript(LIB_BASE + 'live2d.min.js');
    } else {
      await loadScript(LIB_BASE + 'live2dcubismcore.min.js');
    }
    // 3. pixi-live2d-display LAST (needs both PIXI + runtime present)
    //    Use version-specific bundle: cubism2 only loads Cubism2 models,
    //    cubism4 only loads Cubism3/4 models. (Full UMD bundle has registration
    //    issues with pixi v6.5.x, resulting in missing Live2DModel.)
    const bundle = cubismVersion === 2 ? 'cubism2.min.js' : 'cubism4.min.js';
    await loadScript(LIB_BASE + bundle);
  }

  // ── Bubble (speech) ──
  // 动态定位：用模型几何参数精确计算头顶在画布中的 Y，把气泡放头顶正上方。
  function positionBubbleAtHead() {
    if (!bubbleEl) return;
    let topPx = 4; // 默认回退
    if (app && model) {
      try {
        const sh = app.screen.height;          // 画布高 (340)
        // 模型视觉高度 = scale 后的 pixel 高度。pixi-live2d-display 的 model.height 已含 scale。
        const visH = model.height || (model.internalModel ? model.internalModel.height : 0) || sh;
        // anchor(0.5,1)：脚在画布底 (y=sh)，头顶在 y = sh - visH。
        // 但 0.92 缩放留了顶部空白，实际头部更低一点。取头顶上方一点点。
        const headTopY = sh - visH;
        const bubbleH = bubbleEl.offsetHeight || 34;
        topPx = headTopY - bubbleH - 16;       // 往上再抬 10px（含尖角高度）
        if (topPx < 0) topPx = 0;              // 不超出顶部
      } catch (e) { topPx = 4; }
    }
    bubbleEl.style.top = topPx + 'px';
  }
  function showBubble(text) {
    ensureBubble();
    bubbleEl.textContent = text;
    bubbleEl.style.opacity = '1';
    positionBubbleAtHead();
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => {
      bubbleEl.style.opacity = '0';
    }, 3000);
  }

  function ensureBubble() {
    if (bubbleEl && bubbleEl.isConnected) return bubbleEl;
    bubbleEl = document.createElement('div');
    bubbleEl.className = 'pet-bubble';
    const container = document.getElementById('pet-container');
    if (container) container.insertBefore(bubbleEl, container.firstChild);
    return bubbleEl;
  }

  // ── Resize model to fit canvas ──
  function fitModel() {
    if (!model || !app) return;
    // pixi-live2d-display: model.width/height change with scale, causing
    // unstable feedback. Use the internal original layout size instead.
    let mW = 0, mH = 0;
    try {
      const internal = model.internalModel;
      mW = internal.width;
      mH = internal.height;
    } catch (e) {}
    if (!mW || !mH) { mW = model.width / model.scale.x; mH = model.height / model.scale.y; }
    // Fit the whole model into canvas, keep a small margin.
    const scale = Math.min(app.screen.width / mW, app.screen.height / mH) * 0.95;
    model.scale.set(scale);
    // Center horizontally, anchor at bottom so feet touch canvas bottom.
    model.anchor.set(0.5, 1);
    model.x = app.screen.width / 2;
    model.y = app.screen.height;
  }

  // ── Load / Switch model ──
  async function loadModel(name) {
    if (!MODELS[name]) name = 'shizuku';
    currentModel = name;
    const cfg = MODELS[name];
    try {
      await loadLibs(cfg.cubism);
      // pixi-live2d-display UMD 注册 PIXI.Live2DModel (及 PIXI.live2d.Live2DModel 别名)
      // Create app once
      if (!app) {
        const canvas = document.getElementById('pet-canvas-l2d');
        if (!canvas) { throw new Error('找不到 #pet-canvas-l2d 画布'); }
        canvas.style.display = 'block';
        // 隐藏 3D 画布 (如存在)
        const c3d = document.getElementById('pet-canvas');
        if (c3d) c3d.style.display = 'none';
        const cw = canvas.width || 340;
        const ch = canvas.height || 340;
        app = new PIXI.Application({
          view: canvas,
          autoStart: true,
          backgroundAlpha: 0,
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          width: cw, height: ch,
        });
        window.addEventListener('resize', fitModel);
      }
      // Remove old model
      if (model) { app.stage.removeChild(model); model.destroy({ children: true, texture: true, baseTexture: true }); model = null; }

      // Load new model (兼容两种引用方式)
      const Live2DModel = (PIXI.live2d && PIXI.live2d.Live2DModel) || PIXI.Live2DModel;
      model = await Live2DModel.from(cfg.url);
      app.stage.addChild(model);

      // ── Interactions ──
      // Click → random motion + sound
      model.on('hit', (hitAreas) => {
        triggerInteraction(hitAreas);
      });
      // Simple click anywhere on model
      model.interactive = true;
      model.buttonMode = true;
      let lastTap = 0;
      model.on('pointertap', () => {
        const now = Date.now();
        if (now - lastTap < 350) {
          // 双击：随机表情 + 惊讶台词
          playRandomExpression();
          showBubble(pick(PHRASES.dbl));
          playMotion('shake');
          lastTap = 0;
        } else {
          lastTap = now;
          const motions = ['tap', 'idle', 'flick', 'shake'];
          playMotion(motions[Math.floor(Math.random() * motions.length)]);
          if (Math.random() < 0.5) showBubble(pick(PHRASES.click));
        }
        lastInteractTs = Date.now();
      });

      fitModel();
      // 绑定鼠标跟随 / 拖拽 / 闲聊（仅一次）
      setupMouseFollow();
      setupDrag();
      setupIdleChat();
      showBubble(pick(PHRASES.greet));
    } catch (err) {
      console.error('[Live2D] loadModel failed:', err);
      // 诊断模式：显示完整错误（含 name/message/stack 摘要），便于无 DevTools 环境排查
      const full = '[' + (err && err.name ? err.name : 'Error') + '] ' +
                   (err && err.message ? err.message : String(err));
      // 追加 stack 末尾几行（通常含抛出位置）
      let stackTail = '';
      if (err && err.stack) {
        const lines = String(err.stack).split('\n').filter(l => l.trim());
        stackTail = '\n' + lines.slice(1, 4).join('\n');
      }
      showErr(full + stackTail, true);  // 第二参数=true 表示持续显示不自动消失
    }
  }

  function playMotion(group) {
    if (!model) return;
    try {
      // Cubism 2.1: motion groups like 'idle','tapBody','flickHead'
      // Cubism 4: may use group indices
      if (model.motion) {
        model.motion(group);
      } else if (model.internalModel && model.internalModel.motionManager) {
        model.internalModel.motionManager.startRandomMotion(group);
      }
    } catch (e) { /* ignore */ }
  }

  // 随机切换表情
  function playRandomExpression() {
    if (!model || !model.internalModel) return;
    try {
      const mgr = model.internalModel.motionManager;
      if (mgr && mgr.expressionManager && mgr.expressionManager.resetExpression) {
        // Cubism4: expressions
        const exps = mgr.expressionManager ? (model.internalModel.settings.expressions || []) : [];
        if (exps.length) {
          const e = exps[Math.floor(Math.random() * exps.length)];
          model.expression(e.Index !== undefined ? e.Index : e.Name);
          return;
        }
      }
      // 退化：随机改一个表情参数
      if (model.expression) { model.expression(Math.floor(Math.random() * 5)); }
    } catch (e) { /* ignore */ }
  }

  function triggerInteraction(hitAreas) {
    // hitAreas is array of hit area names
    if (!hitAreas || !hitAreas.length) return;
    lastInteractTs = Date.now();
    const area = hitAreas[0];
    if (area === 'head' || area === 'Head') {
      playMotion('flick');
      showBubble(pick(PHRASES.head));
    } else {
      playMotion('tap');
      showBubble(pick(PHRASES.click));
    }
  }

  // ── 鼠标跟随：眼/头转向指针 ──
  function setupMouseFollow() {
    if (followBound) return;
    followBound = true;
    const canvas = document.getElementById('pet-canvas-l2d');
    if (!canvas) return;
    let raf = 0;
    const onMove = (e) => {
      if (!model) return;
      const rect = canvas.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;   // -1..1
      const ny = ((e.clientY - rect.top) / rect.height) * 2 - 1;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        try {
          if (model.internalModel && model.internalModel.coreModel) {
            const c = model.internalModel.coreModel;
            // 参数 ID Cubism4: ParamAngleX/Y, EyeBallX/Y; Cubism2: PARAM_EYE_BALL_X
            const setParam = (ids, val) => { for (const id of ids) { if (c.getParameterValueById) c.setParameterValueById(id, val); } };
            setParam(['ParamAngleX', 'PARAM_ANGLE_X', 'PARAM_BODY_ANGLE_X'], nx * 18);
            setParam(['ParamAngleY', 'PARAM_ANGLE_Y', 'PARAM_BODY_ANGLE_Y'], -ny * 18);
            setParam(['ParamEyeBallX', 'PARAM_EYE_BALL_X'], nx * 0.8);
            setParam(['ParamEyeBallY', 'PARAM_EYE_BALL_Y'], -ny * 0.8);
          }
        } catch (_) { /* ignore */ }
      });
    };
    canvas.addEventListener('pointermove', onMove);
  }

  // ── 拖拽宠物容器 ──
  function setupDrag() {
    const container = document.getElementById('pet-container');
    const canvas = document.getElementById('pet-canvas-l2d');
    if (!container || !canvas) return;
    canvas.style.cursor = 'grab';
    const onDown = (e) => {
      // 避免与点击冲突：仅在按住时移动
      dragInfo = { sx: e.clientX, sy: e.clientY, ox: container.offsetLeft, oy: container.offsetTop, moved: false };
      canvas.style.cursor = 'grabbing';
    };
    const onMove = (e) => {
      if (!dragInfo) return;
      const dx = e.clientX - dragInfo.sx, dy = e.clientY - dragInfo.sy;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragInfo.moved = true;
      container.style.left = (dragInfo.ox + dx) + 'px';
      container.style.top = (dragInfo.oy + dy) + 'px';
      container.style.right = 'auto'; container.style.bottom = 'auto';
    };
    const onUp = () => {
      if (dragInfo && dragInfo.moved) { lastInteractTs = Date.now(); showBubble(pick(PHRASES.drag)); }
      dragInfo = null;
      if (canvas) canvas.style.cursor = 'grab';
    };
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // ── 随机闲聊 ──
  function setupIdleChat() {
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = setInterval(() => {
      if (destroyed) { clearInterval(idleTimer); return; }
      const idle = Date.now() - lastInteractTs;
      // 超过 40 秒无互动，40% 概率冒泡
      if (idle > 40000 && Math.random() < 0.4 && model) {
        showBubble(pick(PHRASES.idle));
        lastInteractTs = Date.now() - 20000; // 推迟下次
      }
    }, 15000);
  }

  function showErr(msg) {
    const c = document.getElementById('pet-container');
    if (c) {
      c.style.background = 'rgba(255,80,80,0.9)';
      c.style.color = '#fff';
      c.style.fontSize = '11px';
      c.style.padding = '6px';
      c.style.width = '220px';
      c.style.borderRadius = '6px';
      c.textContent = '🌸Live2D加载失败: ' + String(msg).slice(0, 200);
    }
  }

  // ── Main init (exported) ──
  async function initLive2DPet(initialModel = 'shizuku') {
    try {
      ensureBubble();
      await loadModel(initialModel);
      registerGlobalAPI();
    } catch (err) {
      console.error('[Live2D] init failed:', err);
      showErr(err && err.message ? err.message : String(err));
    }
  }

  function registerGlobalAPI() {
    window.__petNotify = (text) => showBubble(text);
    window.__petSwitch = (type) => {
      if (MODELS[type]) {
        loadModel(type);
        showBubble(`切换为${MODELS[type].label}！`);
      }
    };
    window.__petGetConfig = () => ({
      enabled: !document.getElementById('pet-container')?.classList.contains('pet-hidden'),
      type: currentModel,
      mode: 'live2d',
      size: parseInt(document.getElementById('pet-container')?.style.width || '200'),
      interactHover: true,
      interactClick: true,
      interactNotify: true,
      name: petCustomName,
    });
    window.__petApplyConfig = (cfg) => {
      // app.js 保存模型名在 cfg.liveModel（不是 cfg.type），需兼容两个字段
      const modelName = cfg.liveModel || cfg.type;
      if (modelName && MODELS[modelName] && modelName !== currentModel) {
        loadModel(modelName);
      }
      const container = document.getElementById('pet-container');
      const canvas = document.getElementById('pet-canvas-l2d');
      if (container && cfg.size) {
        container.style.width = cfg.size + 'px';
        container.style.height = cfg.size + 'px';
      }
      if (canvas && cfg.size) {
        canvas.style.width = cfg.size + 'px';
        canvas.style.height = cfg.size + 'px';
      }
      if (cfg.enabled === false) {
        if (container) container.classList.add('pet-hidden');
      } else {
        if (container) container.classList.remove('pet-hidden');
      }
      if (cfg.name) petCustomName = cfg.name;
    };
    window.__petFlags = { hover: true, click: true, notify: true };
    window.__petSetFlags = (flags) => { Object.assign(window.__petFlags, flags); };
  }

  // Expose for dynamic import
  window.initLive2DPet = initLive2DPet;
  window.LIVE2D_MODELS = MODELS;
})();
