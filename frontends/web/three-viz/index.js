/**
 * Agent Digital Town — 3D可视化入口
 * Three.js低多边形小镇/办公室，映射Agent工作状态
 * 精致渲染：PBR材质 + 软阴影 + ACES色调映射 + 抗锯齿
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TownScene } from './town-scene.js';
import { OfficeScene } from './office-scene.js';
import { StateMapper } from './state-mapper.js';

class AgentViz {
  constructor(container) {
    this.container = container;
    this.scenes = {};
    this.activeScene = null;
    this.stateMapper = null;
    this.clock = new THREE.Clock();
    this.running = false;
    this.pixelRatio = Math.min(window.devicePixelRatio, 2);

    this._initRenderer();
    this._initCamera();
    this._initControls();
    this._initLighting();
    this._initScenes();
    this._initStateMapper();
    this._onResize = this._onResize.bind(this);
    // ResizeObserver: 监听container自身尺寸变化（比window resize更精确，侧边栏布局必需）
    this._resizeObserver = new ResizeObserver(() => this._onResize());
    this._resizeObserver.observe(this.container);
  }

  /* ═══ Renderer — 精致渲染配置 ═══ */
  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.borderRadius = '12px';
  }

  /* ═══ Camera ═══ */
  _initCamera() {
    const aspect = this.container.clientWidth / this.container.clientHeight;
    this.camera = new THREE.PerspectiveCamera(50, aspect, 0.5, 200);
    this.camera.position.set(18, 14, 18);
    this.camera.lookAt(0, 0, 0);
  }

  /* ═══ Controls ═══ */
  _initControls() {
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 50;
    this.controls.maxPolarAngle = Math.PI / 2.15;
    this.controls.minPolarAngle = 0.2;
    this.controls.target.set(0, 1, 0);
    this.controls.enablePan = true;
    this.controls.panSpeed = 0.8;
    this.controls.rotateSpeed = 0.6;
    this.controls.update();
  }

  /* ═══ Lighting — 三点光照 + 半球光 ═══ */
  _initLighting() {
    this._lightGroup = new THREE.Group();
    this._lightGroup.name = '__global_lights__';

    // 主光(太阳) — 暖色
    const sun = new THREE.DirectionalLight(0xffeedd, 1.8);
    sun.position.set(15, 25, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 80;
    sun.shadow.camera.left = -25;
    sun.shadow.camera.right = 25;
    sun.shadow.camera.top = 25;
    sun.shadow.camera.bottom = -25;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    sun.name = 'sun';

    // 补光(天空) — 冷色
    const fill = new THREE.DirectionalLight(0x8fb5e0, 0.6);
    fill.position.set(-10, 12, -8);
    fill.name = 'fill';

    // 半球光
    const hemi = new THREE.HemisphereLight(0xa8c4e0, 0x8b7355, 0.4);
    hemi.name = 'hemisphere';

    this._lightGroup.add(sun, fill, hemi);
  }

  /* ═══ Scenes ═══ */
  _initScenes() {
    this.scenes.town = new TownScene(this.renderer);
    this.scenes.office = new OfficeScene(this.renderer);
    this._activeSceneName = 'town';
    this.activeScene = this.scenes.town;
    this._attachScene('town');
  }

  _attachScene(name) {
    const scene = this.scenes[name].scene;
    if (this._lightGroup.parent) this._lightGroup.parent.remove(this._lightGroup);
    scene.add(this._lightGroup);
  }

  /* ═══ State Mapper ═══ */
  _initStateMapper() {
    this.stateMapper = new StateMapper(this.scenes.town, this.scenes.office);
  }

  /* ═══ 场景切换（带相机过渡） ═══ */
  switchScene(name) {
    if (name === this._activeSceneName) return;
    this._activeSceneName = name;
    this.activeScene = this.scenes[name];
    this._attachScene(name);
    const camPos = name === 'town'
      ? { pos: new THREE.Vector3(18, 14, 18), target: new THREE.Vector3(0, 1, 0) }
      : { pos: new THREE.Vector3(0, 12, 16), target: new THREE.Vector3(0, 2, 0) };
    this._animateCamera(camPos.pos, camPos.target, 1200);
  }

  _animateCamera(targetPos, targetLookAt, duration) {
    const startPos = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
    const startTime = performance.now();
    const step = (now) => {
      const t = Math.min((now - startTime) / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(startPos, targetPos, ease);
      this.controls.target.lerpVectors(startTarget, targetLookAt, ease);
      this.controls.update();
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ═══ 外部状态接口 ═══ */
  updateAgentState(s) { this.stateMapper.onAgentState(s); }
  updateExecutionStep(s) { this.stateMapper.onExecutionStep(s); }
  updateMemoryStats(s) { this.stateMapper.onMemoryStats(s); }
  updateWorkerState(s) { this.stateMapper.onWorkerState(s); }
  updateToolCall(t) { this.stateMapper.onToolCall(t); }

  /* ═══ 渲染循环 ═══ */
  start() {
    if (this.running) return;
    this.running = true;
    this._animate();
  }
  stop() { this.running = false; }

  _animate() {
    if (!this.running) return;
    requestAnimationFrame(() => this._animate());
    const dt = this.clock.getDelta();
    const elapsed = this.clock.getElapsedTime();
    this.controls.update();
    this.activeScene.update(dt, elapsed);
    this.renderer.render(this.activeScene.scene, this.camera);
  }

  _onResize() {
    if (!this.container.clientWidth) return;
    this.camera.aspect = this.container.clientWidth / this.container.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
  }

  dispose() {
    this.stop();
    if (this._resizeObserver) this._resizeObserver.disconnect();
    window.removeEventListener('resize', this._onResize);
    this.controls.dispose();
    this.renderer.dispose();
    Object.values(this.scenes).forEach(s => s.dispose());
    this.renderer.domElement.parentNode?.removeChild(this.renderer.domElement);
  }
}

/* ═══ 全局单例接口 ═══ */
let _instance = null;

export function initViz(containerId) {
  const container = document.getElementById(containerId);
  if (!container) { console.error('[3D] container not found:', containerId); return null; }
  if (_instance) _instance.dispose();
  _instance = new AgentViz(container);
  _instance.start();
  return _instance;
}

export function getViz() { return _instance; }

window.__agentViz = { initViz, getViz };
