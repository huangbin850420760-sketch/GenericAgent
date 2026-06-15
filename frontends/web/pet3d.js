// pet3d.js — 3D Desktop Pet (Penguin / Cat / Dog) with Three.js
// Realistic style, mouse interaction, speech bubbles
import * as THREE from 'three';

// ── Pet State ──
let scene, camera, renderer, petGroup, clock;
let currentPet = 'cat'; // 'cat' | 'dog' | 'penguin'
let mouseNorm = { x: 0, y: 0 };
let blinkTimer = 0, isBlinking = false;
let tailPhase = 0, breathePhase = 0;
let idleAction = null, idleTimer = 0;
let bubbleEl = null, bubbleTimeout = null;
let petCanvas = null;
let petCustomName = '';

const PET_TYPES = {
  cat:     { label: '🐱 猫猫',  color: 0xf5a623, darkColor: 0xd4891a, bellyColor: 0xfff3e0, noseColor: 0xff8a80, earInner: 0xffb7b2 },
  dog:     { label: '🐶 狗狗',  color: 0xd4a574, darkColor: 0xb8895a, bellyColor: 0xfff8ee, noseColor: 0x4a3728, earInner: 0xc99a6b },
  penguin: { label: '🐧 企鹅',  color: 0x2c3e50, darkColor: 0x1a252f, bellyColor: 0xfafafa, noseColor: 0xff8f00, earInner: 0xff8f00 },
  rabbit:  { label: '🐰 兔兔',  color: 0xf5f5f5, darkColor: 0xe0e0e0, bellyColor: 0xffffff, noseColor: 0xff80ab, earInner: 0xffc1d9 },
  hamster: { label: '🐹 仓鼠',  color: 0xf0c674, darkColor: 0xd4a850, bellyColor: 0xfff8dc, noseColor: 0xff8a80, earInner: 0xffd9a0 },
  fox:     { label: '🦊 狐狸',  color: 0xff7043, darkColor: 0xd84315, bellyColor: 0xfff3e0, noseColor: 0x3e2723, earInner: 0x2e0000 },
  panda:   { label: '🐼 熊猫',  color: 0xfafafa, darkColor: 0x212121, bellyColor: 0xffffff, noseColor: 0x212121, earInner: 0x212121 },
};

// ── Init ──
export function initPet() {
  const container = document.getElementById('pet-container');
  if (!container) return;

  petCanvas = document.getElementById('pet-canvas');
  if (!petCanvas) return;

  clock = new THREE.Clock();
  scene = new THREE.Scene();
  scene.background = null; // transparent

  camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(0, 0.8, 4.5);
  camera.lookAt(0, 0.3, 0);

  renderer = new THREE.WebGLRenderer({ canvas: petCanvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(160, 160);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;

  // Lights — realistic studio lighting
  const ambient = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambient);

  const keyLight = new THREE.DirectionalLight(0xfff5ee, 1.8);
  keyLight.position.set(3, 5, 4);
  keyLight.castShadow = false;
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xddeeff, 0.6);
  fillLight.position.set(-3, 2, 2);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xffeedd, 0.4);
  rimLight.position.set(0, 2, -3);
  scene.add(rimLight);

  // Build pet
  buildPet(currentPet);

  // Mouse interaction
  container.addEventListener('mousemove', onPetMouseMove);
  container.addEventListener('click', onPetClick);
  container.addEventListener('mouseenter', () => showBubble(randomGreeting()));
  container.addEventListener('mouseleave', () => hideBubble());

  // Pet selector buttons
  document.querySelectorAll('.pet-type-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const type = btn.dataset.type;
      if (type && PET_TYPES[type]) {
        currentPet = type;
        buildPet(type);
        showBubble(`切换为${PET_TYPES[type].label}！`);
      }
    });
  });

  // Register global API for app.js to call
  window.__petNotify = (text) => showBubble(text);
  window.__petSwitch = (type) => {
    if (PET_TYPES[type]) { currentPet = type; buildPet(type); showBubble(`切换为${PET_TYPES[type].label}！`); }
  };

  // ── Config API for settings panel ──
  window.__petGetConfig = () => ({
    enabled: !document.getElementById('pet-container')?.classList.contains('pet-hidden'),
    type: currentPet,
    size: parseInt(document.getElementById('pet-container')?.style.width || '160'),
    interactHover: true,   // defaults, real values come from localStorage via app.js
    interactClick: true,
    interactNotify: true,
    name: '',
  });

  window.__petApplyConfig = (cfg) => {
    // Type
    if (cfg.type && PET_TYPES[cfg.type] && cfg.type !== currentPet) {
      currentPet = cfg.type;
      buildPet(cfg.type);
    }
    // Size
    const container = document.getElementById('pet-container');
    if (container && cfg.size) {
      container.style.width = cfg.size + 'px';
      container.style.height = cfg.size + 'px';
    }
    // Enable / Disable
    if (cfg.enabled === false) {
      if (container) container.classList.add('pet-hidden');
    } else {
      if (container) container.classList.remove('pet-hidden');
    }
    // Custom name → use in bubble greetings
    if (cfg.name) petCustomName = cfg.name;
  };

  // interact flags (read by event handlers)
  window.__petFlags = { hover: true, click: true, notify: true };
  window.__petSetFlags = (flags) => { Object.assign(window.__petFlags, flags); };

  animate();
}

function buildPet(type) {
  if (petGroup) scene.remove(petGroup);
  petGroup = new THREE.Group();
  const cfg = PET_TYPES[type];

  if (type === 'cat') buildCat(cfg);
  else if (type === 'dog') buildDog(cfg);
  else if (type === 'penguin') buildPenguin(cfg);
  else if (type === 'rabbit') buildRabbit(cfg);
  else if (type === 'hamster') buildHamster(cfg);
  else if (type === 'fox') buildFox(cfg);
  else if (type === 'panda') buildPanda(cfg);

  petGroup.position.y = -0.3;
  scene.add(petGroup);

  // ★ 阶段一增强：切换宠物时重建专属环境
  try { buildEnvironment(type); } catch (e) { /* env system optional */ }
  // 重置动作引擎
  activeAction = null;
}

// ── Material helpers ──
function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color, roughness: opts.roughness ?? 0.7, metalness: opts.metalness ?? 0.05, ...opts
  });
}
function sphere(r, ws, hs) { return new THREE.SphereGeometry(Math.max(0.001, r), ws || 24, hs || 24); }

// ════════════════════════════════════════════
//  CAT — realistic orange tabby
// ════════════════════════════════════════════
function buildCat(cfg) {
  // Body
  const bodyGeo = new THREE.SphereGeometry(0.55, 32, 32);
  bodyGeo.scale(1, 0.9, 0.85);
  const body = new THREE.Mesh(bodyGeo, mat(cfg.color, { roughness: 0.6 }));
  body.position.set(0, 0.1, 0);
  petGroup.add(body);

  // Belly
  const bellyGeo = new THREE.SphereGeometry(0.4, 24, 24);
  bellyGeo.scale(0.8, 0.75, 0.6);
  const belly = new THREE.Mesh(bellyGeo, mat(cfg.bellyColor, { roughness: 0.5 }));
  belly.position.set(0, 0.05, 0.2);
  petGroup.add(belly);

  // Head
  const head = new THREE.Mesh(sphere(0.4), mat(cfg.color, { roughness: 0.55 }));
  head.position.set(0, 0.62, 0.05);
  head.name = 'head';
  petGroup.add(head);

  // Cheeks
  [-1, 1].forEach(side => {
    const cheek = new THREE.Mesh(sphere(0.22, 16, 16), mat(cfg.bellyColor, { roughness: 0.5 }));
    cheek.position.set(side * 0.18, 0.53, 0.28);
    cheek.scale.set(1, 0.8, 0.6);
    petGroup.add(cheek);
  });

  // Ears (triangular via ConeGeometry)
  [-1, 1].forEach(side => {
    const earGeo = new THREE.ConeGeometry(0.12, 0.25, 4);
    const ear = new THREE.Mesh(earGeo, mat(cfg.color));
    ear.position.set(side * 0.22, 0.98, 0.02);
    ear.rotation.z = side * -0.15;
    petGroup.add(ear);

    // Inner ear
    const innerGeo = new THREE.ConeGeometry(0.07, 0.15, 4);
    const inner = new THREE.Mesh(innerGeo, mat(cfg.earInner));
    inner.position.set(side * 0.22, 0.96, 0.06);
    inner.rotation.z = side * -0.15;
    petGroup.add(inner);
  });

  // Eyes
  [-1, 1].forEach(side => {
    // White
    const eyeWhite = new THREE.Mesh(sphere(0.09, 16, 16), mat(0xffffff));
    eyeWhite.position.set(side * 0.13, 0.68, 0.35);
    petGroup.add(eyeWhite);

    // Iris
    const iris = new THREE.Mesh(sphere(0.06, 16, 16), mat(0x4a7c59));
    iris.position.set(side * 0.13, 0.68, 0.40);
    iris.name = 'eye_' + side;
    petGroup.add(iris);

    // Pupil (vertical slit)
    const pupilGeo = new THREE.SphereGeometry(0.035, 12, 12);
    pupilGeo.scale(0.5, 1, 1);
    const pupil = new THREE.Mesh(pupilGeo, mat(0x111111));
    pupil.position.set(side * 0.13, 0.68, 0.43);
    pupil.name = 'pupil_' + side;
    petGroup.add(pupil);
  });

  // Nose
  const noseGeo = new THREE.SphereGeometry(0.035, 12, 12);
  noseGeo.scale(1, 0.7, 0.8);
  const nose = new THREE.Mesh(noseGeo, mat(cfg.noseColor));
  nose.position.set(0, 0.58, 0.42);
  petGroup.add(nose);

  // Mouth (small curve via torus)
  const mouthGeo = new THREE.TorusGeometry(0.04, 0.008, 8, 12, Math.PI);
  const mouth = new THREE.Mesh(mouthGeo, mat(0x8d6e63));
  mouth.position.set(0, 0.54, 0.40);
  mouth.rotation.x = Math.PI;
  petGroup.add(mouth);

  // Whiskers
  [-1, 1].forEach(side => {
    for (let i = -1; i <= 1; i++) {
      const points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(side * 0.25, i * 0.03, -0.05)];
      const wGeo = new THREE.BufferGeometry().setFromPoints(points);
      const whisker = new THREE.Line(wGeo, new THREE.LineBasicMaterial({ color: 0x8d6e63, linewidth: 1 }));
      whisker.position.set(side * 0.08, 0.56 + i * 0.03, 0.38);
      petGroup.add(whisker);
    }
  });

  // Tail (curved via CylinderGeometry segments)
  const tailGroup = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const seg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04 - i * 0.005, 0.05 - i * 0.005, 0.2, 8),
      mat(cfg.color)
    );
    seg.position.set(i * 0.08, 0.1 + i * 0.12, -0.3 - i * 0.05);
    seg.rotation.z = -0.3 + i * 0.25;
    tailGroup.add(seg);
  }
  tailGroup.name = 'tail';
  petGroup.add(tailGroup);

  // Paws (front)
  [-1, 1].forEach(side => {
    const paw = new THREE.Mesh(sphere(0.1, 16, 16), mat(cfg.color));
    paw.position.set(side * 0.28, -0.35, 0.2);
    paw.scale.set(1, 0.6, 0.8);
    petGroup.add(paw);
  });
  // Paws (back/sitting)
  [-1, 1].forEach(side => {
    const paw = new THREE.Mesh(sphere(0.12, 16, 16), mat(cfg.color));
    paw.position.set(side * 0.32, -0.38, -0.05);
    paw.scale.set(1, 0.5, 0.9);
    petGroup.add(paw);
  });

  // Stripes (darker color marks on forehead)
  for (let i = -1; i <= 1; i++) {
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.12, 0.02),
      mat(cfg.darkColor)
    );
    stripe.position.set(i * 0.08, 0.82, 0.37);
    petGroup.add(stripe);
  }
}

// ════════════════════════════════════════════
//  DOG — realistic golden retriever
// ════════════════════════════════════════════
function buildDog(cfg) {
  // Body
  const bodyGeo = new THREE.SphereGeometry(0.55, 32, 32);
  bodyGeo.scale(1, 0.85, 0.8);
  const body = new THREE.Mesh(bodyGeo, mat(cfg.color, { roughness: 0.65 }));
  body.position.set(0, 0.05, 0);
  petGroup.add(body);

  // Belly
  const bellyGeo = new THREE.SphereGeometry(0.38, 24, 24);
  bellyGeo.scale(0.8, 0.7, 0.6);
  const belly = new THREE.Mesh(bellyGeo, mat(cfg.bellyColor, { roughness: 0.5 }));
  belly.position.set(0, 0.0, 0.18);
  petGroup.add(belly);

  // Head
  const headGeo = new THREE.SphereGeometry(0.38, 32, 32);
  headGeo.scale(1, 0.95, 0.9);
  const head = new THREE.Mesh(headGeo, mat(cfg.color));
  head.position.set(0, 0.6, 0.08);
  head.name = 'head';
  petGroup.add(head);

  // Snout
  const snoutGeo = new THREE.SphereGeometry(0.18, 24, 24);
  snoutGeo.scale(0.9, 0.7, 1.1);
  const snout = new THREE.Mesh(snoutGeo, mat(cfg.bellyColor));
  snout.position.set(0, 0.52, 0.35);
  petGroup.add(snout);

  // Floppy ears
  [-1, 1].forEach(side => {
    const earGeo = new THREE.SphereGeometry(0.15, 16, 16);
    earGeo.scale(0.5, 1.2, 0.3);
    const ear = new THREE.Mesh(earGeo, mat(cfg.darkColor, { roughness: 0.75 }));
    ear.position.set(side * 0.3, 0.58, 0.0);
    ear.rotation.z = side * 0.5;
    ear.name = 'ear_' + side;
    petGroup.add(ear);
  });

  // Eyes
  [-1, 1].forEach(side => {
    const eyeWhite = new THREE.Mesh(sphere(0.08, 16, 16), mat(0xffffff));
    eyeWhite.position.set(side * 0.14, 0.68, 0.32);
    petGroup.add(eyeWhite);

    const iris = new THREE.Mesh(sphere(0.055, 16, 16), mat(0x5d4037));
    iris.position.set(side * 0.14, 0.68, 0.37);
    iris.name = 'eye_' + side;
    petGroup.add(iris);

    const pupil = new THREE.Mesh(sphere(0.03, 12, 12), mat(0x111111));
    pupil.position.set(side * 0.14, 0.68, 0.40);
    pupil.name = 'pupil_' + side;
    petGroup.add(pupil);
  });

  // Nose
  const noseGeo = new THREE.SphereGeometry(0.045, 16, 16);
  noseGeo.scale(1, 0.8, 1);
  const nose = new THREE.Mesh(noseGeo, mat(cfg.noseColor, { roughness: 0.3, metalness: 0.2 }));
  nose.position.set(0, 0.55, 0.48);
  petGroup.add(nose);

  // Tongue (sometimes visible)
  const tongueGeo = new THREE.SphereGeometry(0.05, 12, 12);
  tongueGeo.scale(0.7, 0.3, 1);
  const tongue = new THREE.Mesh(tongueGeo, mat(0xff6b6b, { roughness: 0.4 }));
  tongue.position.set(0.02, 0.47, 0.42);
  tongue.name = 'tongue';
  petGroup.add(tongue);

  // Mouth
  const mouthGeo = new THREE.TorusGeometry(0.06, 0.01, 8, 16, Math.PI);
  const mouth = new THREE.Mesh(mouthGeo, mat(0x5d4037));
  mouth.position.set(0, 0.50, 0.38);
  mouth.rotation.x = Math.PI;
  petGroup.add(mouth);

  // Tail (bushy, curled up)
  const tailGroup = new THREE.Group();
  for (let i = 0; i < 6; i++) {
    const r = 0.06 - i * 0.005;
    const seg = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(0.01, r), 12, 12),
      mat(cfg.color, { roughness: 0.7 })
    );
    const angle = i * 0.5;
    seg.position.set(Math.sin(angle) * 0.1, 0.15 + i * 0.1, -0.35 - Math.cos(angle) * 0.1);
    tailGroup.add(seg);
  }
  tailGroup.name = 'tail';
  petGroup.add(tailGroup);

  // Paws
  [-1, 1].forEach(side => {
    const paw = new THREE.Mesh(sphere(0.1, 16, 16), mat(cfg.color));
    paw.position.set(side * 0.3, -0.35, 0.18);
    paw.scale.set(1, 0.55, 0.85);
    petGroup.add(paw);
  });
  [-1, 1].forEach(side => {
    const paw = new THREE.Mesh(sphere(0.12, 16, 16), mat(cfg.color));
    paw.position.set(side * 0.34, -0.37, -0.05);
    paw.scale.set(1, 0.5, 0.9);
    petGroup.add(paw);
  });

  // Eyebrows (subtle ridges)
  [-1, 1].forEach(side => {
    const brow = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.02, 0.02),
      mat(cfg.darkColor)
    );
    brow.position.set(side * 0.14, 0.76, 0.32);
    brow.rotation.z = side * -0.15;
    petGroup.add(brow);
  });
}

// ════════════════════════════════════════════
//  PENGUIN — realistic emperor penguin
// ════════════════════════════════════════════
function buildPenguin(cfg) {
  // Body (elongated egg shape)
  const bodyGeo = new THREE.SphereGeometry(0.5, 32, 32);
  bodyGeo.scale(0.85, 1.15, 0.75);
  const body = new THREE.Mesh(bodyGeo, mat(cfg.color, { roughness: 0.3, metalness: 0.1 }));
  body.position.set(0, 0.05, 0);
  petGroup.add(body);

  // White belly
  const bellyGeo = new THREE.SphereGeometry(0.38, 32, 32);
  bellyGeo.scale(0.7, 1.05, 0.55);
  const belly = new THREE.Mesh(bellyGeo, mat(cfg.bellyColor, { roughness: 0.25 }));
  belly.position.set(0, 0.08, 0.18);
  petGroup.add(belly);

  // Yellow chest patches (emperor penguin)
  [-1, 1].forEach(side => {
    const patchGeo = new THREE.SphereGeometry(0.12, 16, 16);
    patchGeo.scale(0.6, 1.2, 0.3);
    const patch = new THREE.Mesh(patchGeo, mat(0xffc107, { roughness: 0.4 }));
    patch.position.set(side * 0.18, 0.25, 0.3);
    petGroup.add(patch);
  });

  // Head
  const head = new THREE.Mesh(sphere(0.32), mat(cfg.color, { roughness: 0.3 }));
  head.position.set(0, 0.65, 0.02);
  head.name = 'head';
  petGroup.add(head);

  // White face patches
  [-1, 1].forEach(side => {
    const facePatch = new THREE.Mesh(sphere(0.14, 16, 16), mat(0xfff8e1));
    facePatch.position.set(side * 0.12, 0.65, 0.22);
    facePatch.scale.set(1, 0.9, 0.5);
    petGroup.add(facePatch);
  });

  // Eyes
  [-1, 1].forEach(side => {
    const eyeWhite = new THREE.Mesh(sphere(0.055, 16, 16), mat(0xffffff));
    eyeWhite.position.set(side * 0.1, 0.72, 0.28);
    petGroup.add(eyeWhite);

    const iris = new THREE.Mesh(sphere(0.035, 12, 12), mat(0x263238));
    iris.position.set(side * 0.1, 0.72, 0.32);
    iris.name = 'eye_' + side;
    petGroup.add(iris);
  });

  // Beak
  const beakGeo = new THREE.ConeGeometry(0.04, 0.12, 8);
  const beak = new THREE.Mesh(beakGeo, mat(cfg.noseColor, { roughness: 0.4 }));
  beak.position.set(0, 0.62, 0.33);
  beak.rotation.x = Math.PI / 2;
  petGroup.add(beak);

  // Wings/flippers
  [-1, 1].forEach(side => {
    const flipperGeo = new THREE.SphereGeometry(0.12, 16, 16);
    flipperGeo.scale(0.3, 1.3, 0.2);
    const flipper = new THREE.Mesh(flipperGeo, mat(cfg.color, { roughness: 0.35 }));
    flipper.position.set(side * 0.48, 0.05, 0);
    flipper.rotation.z = side * 0.2;
    flipper.name = 'flipper_' + side;
    petGroup.add(flipper);
  });

  // Feet
  [-1, 1].forEach(side => {
    const footGeo = new THREE.SphereGeometry(0.08, 12, 12);
    footGeo.scale(1.2, 0.3, 1.4);
    const foot = new THREE.Mesh(footGeo, mat(cfg.noseColor, { roughness: 0.5 }));
    foot.position.set(side * 0.15, -0.5, 0.15);
    petGroup.add(foot);
  });

  // Yellow crown patches (emperor)
  [-1, 1].forEach(side => {
    const crown = new THREE.Mesh(sphere(0.08, 12, 12), mat(0xffc107, { roughness: 0.4 }));
    crown.position.set(side * 0.1, 0.92, 0.0);
    crown.scale.set(1, 0.6, 0.6);
    petGroup.add(crown);
  });
}

// ════════════════════════════════════════════
//  ★ RABBIT — 长耳朵兔子
// ════════════════════════════════════════════
function buildRabbit(cfg) {
  // Body
  const body = new THREE.Mesh(sphere(0.38, 24, 24), mat(cfg.color, { roughness: 0.6 }));
  body.scale.set(1, 1.05, 1.1);
  body.position.set(0, 0.3, 0);
  petGroup.add(body);

  // Belly
  const belly = new THREE.Mesh(sphere(0.26), mat(cfg.bellyColor, { roughness: 0.7 }));
  belly.scale.set(1, 1, 0.6);
  belly.position.set(0, 0.26, 0.18);
  petGroup.add(belly);

  // ★ Long ears (signature)
  [-1, 1].forEach(side => {
    const ear = new THREE.Mesh(sphere(0.08, 16, 16), mat(cfg.color, { roughness: 0.6 }));
    ear.scale.set(0.6, 2.8, 0.6);
    ear.position.set(side * 0.18, 0.98, 0);
    ear.rotation.z = side * 0.12;
    ear.name = `ear_${side}`;
    petGroup.add(ear);
    // Inner ear
    const inner = new THREE.Mesh(sphere(0.05, 12, 12), mat(cfg.earInner, { roughness: 0.7 }));
    inner.scale.set(0.5, 2.6, 0.5);
    inner.position.set(side * 0.18, 0.98, 0.04);
    inner.rotation.z = side * 0.12;
    petGroup.add(inner);
  });

  // Head
  const head = new THREE.Mesh(sphere(0.3), mat(cfg.color, { roughness: 0.6 }));
  head.position.set(0, 0.66, 0.06);
  head.name = 'head';
  petGroup.add(head);

  // Eyes
  [-1, 1].forEach(side => {
    const eyeWhite = new THREE.Mesh(sphere(0.09, 16, 16), mat(0xffffff));
    eyeWhite.position.set(side * 0.12, 0.7, 0.28);
    petGroup.add(eyeWhite);
    const pupil = new THREE.Mesh(sphere(0.055, 14, 14), mat(0x1a1a2e));
    pupil.position.set(side * 0.12, 0.7, 0.34);
    pupil.name = `pupil_${side}`;
    petGroup.add(pupil);
    // shine
    const shine = new THREE.Mesh(sphere(0.02, 8, 8), mat(0xffffff, { roughness: 0.1 }));
    shine.position.set(side * 0.135, 0.72, 0.38);
    petGroup.add(shine);
  });

  // Nose
  const nose = new THREE.Mesh(sphere(0.04, 12, 12), mat(cfg.noseColor, { roughness: 0.4 }));
  nose.position.set(0, 0.6, 0.36);
  petGroup.add(nose);

  // Fluffy tail
  const tail = new THREE.Mesh(sphere(0.13, 16, 16), mat(cfg.bellyColor, { roughness: 0.9 }));
  tail.scale.set(1, 1, 1.1);
  tail.position.set(0, 0.38, -0.38);
  tail.name = 'tail';
  petGroup.add(tail);

  // Legs
  [-1, 1].forEach(side => {
    [-0.3, 0.3].forEach(front => {
      const leg = new THREE.Mesh(sphere(0.1, 12, 12), mat(cfg.color, { roughness: 0.6 }));
      leg.scale.set(0.8, 1.4, 0.8);
      leg.position.set(side * 0.18, -0.12, front * 0.18);
      petGroup.add(leg);
    });
  });
}

// ════════════════════════════════════════════
//  ★ HAMSTER — 圆滚滚小仓鼠
// ════════════════════════════════════════════
function buildHamster(cfg) {
  // Round body (chunky)
  const body = new THREE.Mesh(sphere(0.42, 24, 24), mat(cfg.color, { roughness: 0.75 }));
  body.scale.set(1.1, 1, 1.15);
  body.position.set(0, 0.25, 0);
  petGroup.add(body);

  // Belly stripe
  const belly = new THREE.Mesh(sphere(0.3), mat(cfg.bellyColor, { roughness: 0.8 }));
  belly.scale.set(1, 1, 0.5);
  belly.position.set(0, 0.22, 0.22);
  petGroup.add(belly);

  // Tiny round ears
  [-1, 1].forEach(side => {
    const ear = new THREE.Mesh(sphere(0.1, 14, 14), mat(cfg.color, { roughness: 0.75 }));
    ear.scale.set(0.5, 0.5, 0.4);
    ear.position.set(side * 0.22, 0.62, 0.02);
    ear.name = `ear_${side}`;
    petGroup.add(ear);
    const inner = new THREE.Mesh(sphere(0.06, 10, 10), mat(cfg.earInner, { roughness: 0.8 }));
    inner.scale.set(0.4, 0.4, 0.3);
    inner.position.set(side * 0.22, 0.62, 0.08);
    petGroup.add(inner);
  });

  // Head (merged with body, small)
  const head = new THREE.Mesh(sphere(0.26), mat(cfg.color, { roughness: 0.75 }));
  head.position.set(0, 0.52, 0.12);
  head.name = 'head';
  petGroup.add(head);

  // Big cute eyes
  [-1, 1].forEach(side => {
    const eye = new THREE.Mesh(sphere(0.07, 16, 16), mat(0x1a1a2e, { roughness: 0.3 }));
    eye.position.set(side * 0.11, 0.56, 0.32);
    eye.name = `pupil_${side}`;
    petGroup.add(eye);
    const shine = new THREE.Mesh(sphere(0.025, 8, 8), mat(0xffffff, { roughness: 0.1 }));
    shine.position.set(side * 0.125, 0.585, 0.38);
    petGroup.add(shine);
  });

  // Pink nose
  const nose = new THREE.Mesh(sphere(0.035, 12, 12), mat(cfg.noseColor, { roughness: 0.4 }));
  nose.position.set(0, 0.46, 0.38);
  petGroup.add(nose);

  // Tiny stub tail
  const tail = new THREE.Mesh(sphere(0.05, 10, 10), mat(cfg.color, { roughness: 0.8 }));
  tail.position.set(0, 0.3, -0.42);
  tail.name = 'tail';
  petGroup.add(tail);

  // Tiny paws
  [-1, 1].forEach(side => {
    [-0.25, 0.25].forEach(front => {
      const paw = new THREE.Mesh(sphere(0.07, 10, 10), mat(cfg.bellyColor, { roughness: 0.8 }));
      paw.scale.set(1, 0.6, 1);
      paw.position.set(side * 0.2, -0.1, front * 0.2);
      petGroup.add(paw);
    });
  });
}

// ════════════════════════════════════════════
//  ★ FOX — 橙红小狐狸
// ════════════════════════════════════════════
function buildFox(cfg) {
  // Body
  const body = new THREE.Mesh(sphere(0.34, 24, 24), mat(cfg.color, { roughness: 0.55 }));
  body.scale.set(1, 0.9, 1.2);
  body.position.set(0, 0.3, 0);
  petGroup.add(body);

  // White belly
  const belly = new THREE.Mesh(sphere(0.24), mat(cfg.bellyColor, { roughness: 0.7 }));
  belly.scale.set(1, 1, 0.6);
  belly.position.set(0, 0.26, 0.16);
  petGroup.add(belly);

  // Pointed ears (cone)
  [-1, 1].forEach(side => {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.3, 6), mat(cfg.color, { roughness: 0.55 }));
    ear.position.set(side * 0.2, 0.92, 0);
    ear.rotation.z = side * -0.2;
    ear.name = `ear_${side}`;
    petGroup.add(ear);
    const inner = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.18, 6), mat(cfg.earInner, { roughness: 0.7 }));
    inner.position.set(side * 0.2, 0.9, 0.04);
    inner.rotation.z = side * -0.2;
    petGroup.add(inner);
  });

  // Head
  const head = new THREE.Mesh(sphere(0.28), mat(cfg.color, { roughness: 0.55 }));
  head.position.set(0, 0.62, 0.08);
  head.name = 'head';
  petGroup.add(head);

  // Pointed snout
  const snout = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.22, 8), mat(cfg.bellyColor, { roughness: 0.6 }));
  snout.position.set(0, 0.56, 0.34);
  snout.rotation.x = Math.PI / 2;
  petGroup.add(snout);

  // Eyes
  [-1, 1].forEach(side => {
    const eye = new THREE.Mesh(sphere(0.05, 14, 14), mat(0x1a1a2e, { roughness: 0.3 }));
    eye.position.set(side * 0.11, 0.68, 0.26);
    eye.name = `pupil_${side}`;
    petGroup.add(eye);
    const shine = new THREE.Mesh(sphere(0.018, 8, 8), mat(0xffffff, { roughness: 0.1 }));
    shine.position.set(side * 0.122, 0.7, 0.3);
    petGroup.add(shine);
  });

  // Nose
  const nose = new THREE.Mesh(sphere(0.035, 12, 12), mat(cfg.noseColor, { roughness: 0.3 }));
  nose.position.set(0, 0.56, 0.45);
  petGroup.add(nose);

  // Big bushy tail
  const tail = new THREE.Mesh(sphere(0.16, 16, 16), mat(cfg.color, { roughness: 0.7 }));
  tail.scale.set(0.9, 0.9, 1.6);
  tail.position.set(0, 0.4, -0.42);
  tail.rotation.x = 0.4;
  tail.name = 'tail';
  petGroup.add(tail);
  // White tail tip
  const tip = new THREE.Mesh(sphere(0.1, 14, 14), mat(cfg.bellyColor, { roughness: 0.8 }));
  tip.scale.set(0.9, 0.9, 1.2);
  tip.position.set(0, 0.44, -0.6);
  tip.rotation.x = 0.4;
  petGroup.add(tip);

  // Legs
  [-1, 1].forEach(side => {
    [-0.28, 0.28].forEach(front => {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.06, 0.18, 10), mat(cfg.darkColor, { roughness: 0.6 }));
      leg.position.set(side * 0.17, -0.06, front * 0.2);
      petGroup.add(leg);
    });
  });
}

// ════════════════════════════════════════════
//  ★ PANDA — 黑白大熊猫
// ════════════════════════════════════════════
function buildPanda(cfg) {
  // White body
  const body = new THREE.Mesh(sphere(0.4, 24, 24), mat(cfg.color, { roughness: 0.7 }));
  body.scale.set(1.1, 1, 1.1);
  body.position.set(0, 0.3, 0);
  petGroup.add(body);

  // Black belly patch (front)
  const frontPatch = new THREE.Mesh(sphere(0.28, 20, 20), mat(cfg.darkColor, { roughness: 0.7 }));
  frontPatch.scale.set(1, 1.1, 0.5);
  frontPatch.position.set(0, 0.18, 0.18);
  petGroup.add(frontPatch);

  // Black legs/arms
  [-1, 1].forEach(side => {
    const arm = new THREE.Mesh(sphere(0.14, 16, 16), mat(cfg.darkColor, { roughness: 0.7 }));
    arm.scale.set(0.8, 1.3, 0.8);
    arm.position.set(side * 0.32, 0.22, 0.05);
    petGroup.add(arm);
    // Back legs
    const leg = new THREE.Mesh(sphere(0.16, 16, 16), mat(cfg.darkColor, { roughness: 0.7 }));
    leg.scale.set(1, 1.1, 1);
    leg.position.set(side * 0.2, -0.08, -0.1);
    petGroup.add(leg);
  });

  // Round black ears
  [-1, 1].forEach(side => {
    const ear = new THREE.Mesh(sphere(0.11, 16, 16), mat(cfg.darkColor, { roughness: 0.7 }));
    ear.scale.set(1, 1, 0.7);
    ear.position.set(side * 0.2, 0.82, 0);
    ear.name = `ear_${side}`;
    petGroup.add(ear);
  });

  // Big white head
  const head = new THREE.Mesh(sphere(0.34), mat(cfg.color, { roughness: 0.7 }));
  head.position.set(0, 0.66, 0.06);
  head.name = 'head';
  petGroup.add(head);

  // Black eye patches (signature)
  [-1, 1].forEach(side => {
    const patch = new THREE.Mesh(sphere(0.1, 16, 16), mat(cfg.darkColor, { roughness: 0.6 }));
    patch.scale.set(0.7, 1.3, 0.6);
    patch.position.set(side * 0.13, 0.7, 0.24);
    patch.rotation.z = side * 0.3;
    petGroup.add(patch);
    // Eyes inside
    const eye = new THREE.Mesh(sphere(0.045, 14, 14), mat(0x1a1a2e, { roughness: 0.3 }));
    eye.position.set(side * 0.13, 0.7, 0.3);
    eye.name = `pupil_${side}`;
    petGroup.add(eye);
    const shine = new THREE.Mesh(sphere(0.018, 8, 8), mat(0xffffff, { roughness: 0.1 }));
    shine.position.set(side * 0.14, 0.72, 0.33);
    petGroup.add(shine);
  });

  // Black nose
  const nose = new THREE.Mesh(sphere(0.05, 12, 12), mat(cfg.noseColor, { roughness: 0.3 }));
  nose.position.set(0, 0.58, 0.34);
  petGroup.add(nose);
}

// ── Animation Loop ──
function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const t = clock.getElapsedTime();

  if (!petGroup) return;

  // Breathing
  breathePhase += dt * 2;
  const breathe = Math.sin(breathePhase) * 0.015;
  petGroup.scale.set(1, 1 + breathe, 1);

  // Tail wag (cat/dog) or flipper wave (penguin)
  const tail = petGroup.getObjectByName('tail');
  if (tail) {
    tailPhase += dt * 4;
    tail.rotation.y = Math.sin(tailPhase) * 0.3;
    tail.rotation.x = Math.sin(tailPhase * 0.7) * 0.1;
  }
  [-1, 1].forEach(side => {
    const flipper = petGroup.getObjectByName('flipper_' + side);
    if (flipper) {
      flipper.rotation.z = side * (0.2 + Math.sin(t * 1.5) * 0.1);
      flipper.rotation.x = Math.sin(t * 1.2 + side) * 0.08;
    }
  });

  // Dog ear flop
  [-1, 1].forEach(side => {
    const ear = petGroup.getObjectByName('ear_' + side);
    if (ear) {
      ear.rotation.z = side * (0.5 + Math.sin(t * 2 + side) * 0.08);
    }
  });

  // Eye tracking (follow mouse)
  [-1, 1].forEach(side => {
    const eye = petGroup.getObjectByName('eye_' + side);
    const pupil = petGroup.getObjectByName('pupil_' + side);
    if (eye && pupil) {
      const offsetX = mouseNorm.x * 0.02;
      const offsetY = mouseNorm.y * 0.015;
      eye.position.x = (side === -1 ? -0.13 : 0.13) + offsetX;
      eye.position.y = 0.68 + offsetY;
      pupil.position.x = (side === -1 ? -0.13 : 0.13) + offsetX * 1.5;
      pupil.position.y = 0.68 + offsetY * 1.5;
    }
  });

  // Head slight tilt toward mouse
  const head = petGroup.getObjectByName('head');
  if (head) {
    head.rotation.y = mouseNorm.x * 0.15;
    head.rotation.x = -mouseNorm.y * 0.1;
  }

  // Blinking
  blinkTimer += dt;
  if (blinkTimer > 3 + Math.random() * 2) {
    isBlinking = true;
    blinkTimer = 0;
    setTimeout(() => { isBlinking = false; }, 150);
  }
  [-1, 1].forEach(side => {
    const eye = petGroup.getObjectByName('eye_' + side);
    if (eye) eye.scale.y = isBlinking ? 0.1 : 1;
  });

  // Dog tongue pant
  const tongue = petGroup.getObjectByName('tongue');
  if (tongue) {
    tongue.scale.y = 0.3 + Math.sin(t * 3) * 0.1;
  }

  // Idle behaviors
  idleTimer += dt;
  if (idleTimer > 8 + Math.random() * 10) {
    idleTimer = 0;
    triggerIdleAction();
  }

  // ★ 阶段一增强：动作引擎 + 环境粒子更新
  try { updateActiveAction(dt, t); } catch (e) { /* optional */ }
  try { updateEnvironment(t, dt); } catch (e) { /* optional */ }

  renderer.render(scene, camera);
}

// ── Mouse Interaction ──
function onPetMouseMove(e) {
  const rect = e.currentTarget.getBoundingClientRect();
  mouseNorm.x = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
  mouseNorm.y = -((e.clientY - rect.top) / rect.height - 0.5) * 2;
}

function onPetClick(e) {
  e.stopPropagation();
  // Happy reaction
  const msgs = [
    '喵~ ❤️', '汪！好开心~', '嘎嘎！', '摸摸我~', '好舒服呀~',
    '再摸摸嘛~', '你是最好的主人！', '嘻嘻~', '今天也要加油哦！',
    '饿了吗？我也饿了~', '让我陪你工作吧~'
  ];
  showBubble(msgs[Math.floor(Math.random() * msgs.length)]);

  // Bounce animation
  if (petGroup) {
    const origY = petGroup.position.y;
    let frame = 0;
    const bounce = () => {
      frame++;
      petGroup.position.y = origY + Math.sin(frame * 0.3) * 0.08 * Math.max(0, 1 - frame / 20);
      petGroup.rotation.y = Math.sin(frame * 0.15) * 0.1;
      if (frame < 20) requestAnimationFrame(bounce);
      else { petGroup.position.y = origY; petGroup.rotation.y = 0; }
    };
    bounce();
  }
}

function triggerIdleAction() {
  // ★ 阶段一增强：改用新动作引擎，随机触发丰富动作
  if (!petGroup) return;
  // 如果动作引擎可用且当前无动作，随机启动一个
  if (typeof ACTION_NAMES !== 'undefined' && typeof startAction === 'function' && !activeAction) {
    const name = ACTION_NAMES[Math.floor(Math.random() * ACTION_NAMES.length)];
    startAction(name);
    return;
  }
  // 兜底：气泡
  showBubble(randomIdleMsg());
}

function randomIdleMsg() {
  const msgs = [
    '好无聊呀~', '什么时候下班？', '要不要休息一下？', '我在看着你哦~',
    '加油！你很棒的！', '今天天气不错呢~', '有点困了...', '嗯？你叫我吗？',
    '我来守护你的代码！', '记得喝水哦~', '摸摸我嘛~', '需要我帮忙吗？'
  ];
  return msgs[Math.floor(Math.random() * msgs.length)];
}

function randomGreeting() {
  const msgs = ['你好呀~', '嘿嘿~', '主人来啦！', '嗯哼？', '终于注意到我了~'];
  return msgs[Math.floor(Math.random() * msgs.length)];
}

// ── Speech Bubble ──
function showBubble(text) {
  const container = document.getElementById('pet-container');
  if (!container) return;

  if (bubbleEl) bubbleEl.remove();
  clearTimeout(bubbleTimeout);

  bubbleEl = document.createElement('div');
  bubbleEl.className = 'pet-bubble';
  bubbleEl.textContent = text;
  container.appendChild(bubbleEl);

  // Fade in
  requestAnimationFrame(() => bubbleEl.classList.add('show'));

  bubbleTimeout = setTimeout(() => {
    if (bubbleEl) {
      bubbleEl.classList.remove('show');
      setTimeout(() => { if (bubbleEl) bubbleEl.remove(); }, 300);
    }
  }, 3500);
}

function hideBubble() {
  if (bubbleEl) {
    bubbleEl.classList.remove('show');
    setTimeout(() => { if (bubbleEl) bubbleEl.remove(); }, 200);
  }
}

// ── Auto-init removed: now triggered by index.html dynamic loader to avoid
//    double-init race. Kept as no-op for safety if loaded standalone. ──
// (index.html calls initPet() explicitly after dynamic import)

// ════════════════════════════════════════════════════════════
//  ★ 阶段一增强：动作引擎 + 道具系统 + 环境效果 + 新宠物种类
// ════════════════════════════════════════════════════════════

// ── 动作引擎状态机 ──
// 当前执行中的动画动作（null=空闲，由idle系统触发）
let activeAction = null; // { name, startTime, duration, update(t, dt), onEnd }
let envGroup = null;     // 环境 group（雪花/草地/胡萝卜等）
let envParticles = [];   // 环境粒子（用于动画）
let propGroup = null;    // 当前道具 group

// ── 动作工厂：每个动作返回一个 {name, duration, update(t)} 对象 ──
// t ∈ [0,1] 表示动作进度
function createAction(type) {
  const ACT = {
    // 1. 来回走动
    walk: {
      name: 'walk', duration: 3.0,
      msg: ['溜达溜达~', '走走更健康！', '哒哒哒~', '出去逛逛~'],
      update(t) {
        const baseX = 0;
        petGroup.position.x = baseX + Math.sin(t * Math.PI * 2) * 0.45;
        // 面朝行走方向
        const dir = Math.cos(t * Math.PI * 2);
        petGroup.rotation.y = dir > 0 ? -0.3 : 0.3;
        // 走路上下颠 + 前后腿摆
        petGroup.position.y = -0.3 + Math.abs(Math.sin(t * Math.PI * 8)) * 0.06;
      },
    },
    // 2. 原地跳跃
    jump: {
      name: 'jump', duration: 1.6,
      msg: ['看我跳！', '蹦蹦跳~', '飞起来啦！', '一蹦三尺高~'],
      update(t) {
        const hop = Math.sin(t * Math.PI);
        petGroup.position.y = -0.3 + hop * hop * 0.5;
        petGroup.rotation.x = Math.sin(t * Math.PI) * 0.15;
      },
    },
    // 3. 摇摆（搞怪，避免整圈翻滚导致穿模）
    roll: {
      name: 'roll', duration: 1.8,
      msg: ['转圈圈~', '咕噜咕噜~', '头晕了...嘿嘿', '看我扭一扭！'],
      update(t) {
        // 左右摇摆 + 旋转，幅度受限，不超出 canvas 边界
        petGroup.rotation.y = Math.sin(t * Math.PI * 2) * 0.6;
        petGroup.rotation.z = Math.sin(t * Math.PI * 2) * 0.25;
        petGroup.position.x = Math.sin(t * Math.PI * 2) * 0.18;
      },
    },
    // 4. 伸懒腰
    stretch: {
      name: 'stretch', duration: 2.0,
      msg: ['伸个懒腰~', '啊——好舒服', '骨头都酥了~', '该活动活动了'],
      update(t) {
        const s = Math.sin(t * Math.PI);
        petGroup.scale.set(1 + s * 0.2, 1 - s * 0.15, 1 + s * 0.1);
        petGroup.position.y = -0.3 - s * 0.05;
      },
    },
    // 5. 打哈欠
    yawn: {
      name: 'yawn', duration: 2.2,
      msg: ['哈——欠~', '好困呀...', '打个大哈欠', '困死我了zzZ'],
      update(t) {
        const s = Math.sin(t * Math.PI);
        petGroup.rotation.x = s * 0.2;
        // 强制闭眼
        const eye = petGroup.getObjectByName('eye_-1');
        if (eye) eye.scale.y = 1 - s * 0.9;
        const eye2 = petGroup.getObjectByName('eye_1');
        if (eye2) eye2.scale.y = 1 - s * 0.9;
      },
    },
    // 6. 左右摇摆（搞怪/高兴）
    wiggle: {
      name: 'wiggle', duration: 1.8,
      msg: ['摇摇摆摆~', '好开心呀！', '蹦迪时间到！', '一起摇摆！'],
      update(t) {
        petGroup.rotation.y = Math.sin(t * Math.PI * 4) * 0.4;
        petGroup.position.x = Math.sin(t * Math.PI * 2) * 0.15;
      },
    },
    // 7. 玩道具（呼出道具+互动）
    playProp: {
      name: 'playProp', duration: 3.0,
      msg: ['我的玩具！', '玩一会儿~', '这个好玩！', '嘿嘿抓到啦'],
      start() { showProp(); },
      update(t) {
        // 道具在面前弹跳，宠物转头追
        if (propGroup) {
          propGroup.position.set(Math.sin(t * Math.PI * 3) * 0.3, 0.2 + Math.abs(Math.sin(t * Math.PI * 6)) * 0.2, 0.5);
          propGroup.rotation.y += 0.1;
        }
        petGroup.rotation.y = Math.sin(t * Math.PI * 3) * 0.2;
      },
      end() { hideProp(); },
    },
  };
  return ACT[type] ? { ...ACT[type] } : null;
}

const ACTION_NAMES = ['walk', 'jump', 'roll', 'stretch', 'yawn', 'wiggle', 'playProp'];

function startAction(type) {
  if (activeAction) return;
  const a = createAction(type);
  if (!a) return;
  activeAction = a;
  activeAction.startTime = clock.getElapsedTime();
  if (activeAction.start) activeAction.start();
  if (activeAction.msg) showBubble(activeAction.msg[Math.floor(Math.random() * activeAction.msg.length)]);
}

function updateActiveAction(dt) {
  if (!activeAction || !petGroup || !clock) return;
  const elapsed = clock.getElapsedTime() - activeAction.startTime;
  const t = Math.min(1, elapsed / activeAction.duration);
  // 保存基准值供 update 使用（动画结束后恢复）
  activeAction.update(t);
  if (t >= 1) {
    // 恢复变换
    petGroup.position.set(0, -0.3, 0);
    petGroup.rotation.set(0, 0, 0);
    petGroup.scale.set(1, 1, 1);
    if (activeAction.end) activeAction.end();
    activeAction = null;
  }
}

// ── 道具系统：每种宠物有专属道具 ──
const PET_PROPS = {
  cat: 'yarn', dog: 'bone', penguin: 'fish',
  rabbit: 'carrot', hamster: 'seed', fox: 'ball', panda: 'bamboo',
};

function showProp() {
  hideProp();
  const kind = PET_PROPS[currentPet] || 'ball';
  propGroup = new THREE.Group();
  const propMat = mat(0xff6b6b, { roughness: 0.5 });
  if (kind === 'yarn') {
    // 毛线球
    const ball = new THREE.Mesh(sphere(0.18, 16, 16), mat(0xe91e63, { roughness: 0.9 }));
    propGroup.add(ball);
    // 缠绕线
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.01, 8, 24), mat(0xad1457));
      ring.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      propGroup.add(ring);
    }
  } else if (kind === 'bone') {
    const m = mat(0xf5f5dc, { roughness: 0.6 });
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.3, 8), m);
    bar.rotation.z = Math.PI / 2;
    propGroup.add(bar);
    [-0.15, 0.15].forEach(x => {
      [1, -1].forEach(y => {
        const knob = new THREE.Mesh(sphere(0.06, 12, 12), m);
        knob.position.set(x, y * 0.05, 0);
        propGroup.add(knob);
      });
    });
  } else if (kind === 'fish') {
    const m = mat(0x607d8b, { roughness: 0.4, metalness: 0.3 });
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.3, 8), m);
    body.rotation.z = Math.PI / 2;
    propGroup.add(body);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.12, 6), m);
    tail.position.x = 0.2; tail.rotation.z = -Math.PI / 2;
    propGroup.add(tail);
  } else if (kind === 'carrot') {
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.28, 8), mat(0xff6f00));
    propGroup.add(body);
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.12, 5), mat(0x4caf50));
    leaf.position.y = 0.18;
    propGroup.add(leaf);
  } else if (kind === 'seed') {
    for (let i = 0; i < 4; i++) {
      const seed = new THREE.Mesh(sphere(0.04, 8, 8), mat(0x8d6e63));
      seed.position.set((Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.1, 0);
      propGroup.add(seed);
    }
  } else if (kind === 'bamboo') {
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.4, 8), mat(0x689f38, { roughness: 0.7 }));
    propGroup.add(stalk);
    for (let i = -1; i <= 1; i++) {
      const node = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.012, 8, 16), mat(0x558b2f));
      node.position.y = i * 0.12; node.rotation.x = Math.PI / 2;
      propGroup.add(node);
    }
  } else { // ball
    const ball = new THREE.Mesh(sphere(0.15, 16, 16), mat(0xff5722, { roughness: 0.4 }));
    propGroup.add(ball);
    const patch = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.12), mat(0xffffff));
    patch.position.set(0, 0, 0.15);
    propGroup.add(patch);
  }
  propGroup.position.set(0.3, 0.2, 0.5);
  scene.add(propGroup);
}

function hideProp() {
  if (propGroup) {
    scene.remove(propGroup);
    propGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    propGroup = null;
  }
}

// ── 环境系统：每种宠物配专属环境 + 粒子 ──
const PET_ENVS = {
  cat:     { type: 'rug',    label: '温馨地毯' },
  dog:     { type: 'grass',  label: '阳光草地' },
  penguin: { type: 'ice',    label: '冰原雪地' },
  rabbit:  { type: 'meadow', label: '胡萝卜田' },
  hamster: { type: 'sawdust',label: '木屑窝' },
  fox:     { type: 'forest', label: '森林空地' },
  panda:   { type: 'bamboo', label: '竹林' },
};

function buildEnvironment(type) {
  clearEnvironment();
  envGroup = new THREE.Group();
  envParticles = [];
  const env = PET_ENVS[type] || PET_ENVS.cat;

  if (env.type === 'rug') {
    // 圆形地毯
    const rug = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.05, 32), mat(0xb71c1c, { roughness: 0.95 }));
    rug.position.y = -0.62; envGroup.add(rug);
    const rug2 = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.051, 32), mat(0xd32f2f, { roughness: 0.95 }));
    rug2.position.y = -0.62; envGroup.add(rug2);
  } else if (env.type === 'grass') {
    const grass = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 0.05, 32), mat(0x7cb342, { roughness: 0.9 }));
    grass.position.y = -0.62; envGroup.add(grass);
    // 几朵小花
    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * Math.PI * 2, r = 0.7;
      const flower = new THREE.Mesh(sphere(0.05, 8, 8), mat([0xffeb3b, 0xe91e63, 0xffffff, 0xff5722][i % 4]));
      flower.position.set(Math.cos(ang) * r, -0.5, Math.sin(ang) * r);
      envGroup.add(flower);
    }
  } else if (env.type === 'ice') {
    const ice = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 0.05, 32), mat(0xe0f7fa, { roughness: 0.2, metalness: 0.3 }));
    ice.position.y = -0.62; envGroup.add(ice);
    // 冰块
    for (let i = 0; i < 3; i++) {
      const block = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.2, 0.25), mat(0xb3e5fc, { transparent: true, opacity: 0.7, roughness: 0.2 }));
      block.position.set((Math.random() - 0.5) * 1.2, -0.45, (Math.random() - 0.5) * 0.8);
      envGroup.add(block);
    }
  } else if (env.type === 'meadow') {
    const soil = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 0.05, 32), mat(0x6d4c41, { roughness: 0.95 }));
    soil.position.y = -0.62; envGroup.add(soil);
    // 胡萝卜苗
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2, r = 0.75;
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.2, 5), mat(0x4caf50));
      leaf.position.set(Math.cos(ang) * r, -0.45, Math.sin(ang) * r);
      envGroup.add(leaf);
    }
  } else if (env.type === 'sawdust') {
    const bed = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 0.08, 32), mat(0xd7ccc8, { roughness: 1 }));
    bed.position.y = -0.6; envGroup.add(bed);
  } else if (env.type === 'forest') {
    const ground = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 0.05, 32), mat(0x558b2f, { roughness: 0.9 }));
    ground.position.y = -0.62; envGroup.add(ground);
    // 树
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2, r = 0.85;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.4, 6), mat(0x5d4037));
      trunk.position.set(Math.cos(ang) * r, -0.35, Math.sin(ang) * r);
      const crown = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.5, 8), mat(0x2e7d32));
      crown.position.set(Math.cos(ang) * r, -0.05, Math.sin(ang) * r);
      envGroup.add(trunk, crown);
    }
  } else if (env.type === 'bamboo') {
    const ground = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 0.05, 32), mat(0x8d6e63, { roughness: 0.9 }));
    ground.position.y = -0.62; envGroup.add(ground);
    // 竹子
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2, r = 0.8;
      const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.8, 6), mat(0x689f38));
      stalk.position.set(Math.cos(ang) * r, -0.15, Math.sin(ang) * r);
      envGroup.add(stalk);
    }
  }

  // ── 环境粒子（雪花/泡泡/落叶/花瓣）──
  let particleColor = 0xffffff, particleCount = 30;
  if (env.type === 'ice') { particleColor = 0xffffff; particleCount = 40; }
  else if (env.type === 'grass' || env.type === 'meadow') { particleColor = 0xffc107; particleCount = 15; }
  else if (env.type === 'forest' || env.type === 'bamboo') { particleColor = 0x8bc34a; particleCount = 20; }
  else particleCount = 10;

  if (particleCount > 0) {
    const pGeo = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const speeds = [];
    for (let i = 0; i < particleCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 3;
      positions[i * 3 + 1] = Math.random() * 2;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 3;
      speeds.push({ vy: -0.2 - Math.random() * 0.3, vx: (Math.random() - 0.5) * 0.2, sway: Math.random() * 6 });
    }
    pGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const pMat = new THREE.PointsMaterial({ color: particleColor, size: 0.06, transparent: true, opacity: 0.8 });
    const points = new THREE.Points(pGeo, pMat);
    envGroup.add(points);
    envParticles.push({ points, speeds, positions });
  }

  scene.add(envGroup);
}

function clearEnvironment() {
  if (envGroup) {
    scene.remove(envGroup);
    envGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    envGroup = null;
    envParticles = [];
  }
}

function updateEnvironment(t, dt) {
  envParticles.forEach(p => {
    const pos = p.points.geometry.attributes.position.array;
    for (let i = 0; i < p.speeds.length; i++) {
      pos[i * 3] += (p.speeds[i].vx + Math.sin(t * p.speeds[i].sway + i) * 0.01) * dt;
      pos[i * 3 + 1] += p.speeds[i].vy * dt;
      if (pos[i * 3 + 1] < -0.6) { pos[i * 3 + 1] = 2; pos[i * 3] = (Math.random() - 0.5) * 3; }
    }
    p.points.geometry.attributes.position.needsUpdate = true;
  });
}
