/**
 * OfficeScene — 低多边形办公室场景
 * 俯视/等角视图，办公桌映射为Agent任务状态
 * 包含：地板、墙壁、办公桌、显示器、文件柜、植物
 */
import * as THREE from 'three';

const P = {
  floor: 0xd7ccc8, carpet: 0x8d6e63,
  wall: 0xf5f0e8, wallAccent: 0xe8e0d4,
  desk: 0xbcaaa4, deskTop: 0xd7ccc8,
  monitor: 0x263238, screen: 0x81d4fa, screenLit: 0x6366f1,
  chair: 0x546e7a, chairCushion: 0x78909c,
  plant: 0x4caf50, pot: 0x8d6e63,
  cabinet: 0xa1887f, cabinetDraw: 0x8d6e63,
  agent: 0x6366f1, skin: 0xfdd9b5,
  lamp: 0xfff8e1,
};

const _m = {};
function mt(c, o = {}) {
  const k = `${c}_${JSON.stringify(o)}`;
  if (_m[k]) return _m[k];
  const m = new THREE.MeshStandardMaterial({
    color: c, roughness: o.r ?? 0.7, metalness: o.m ?? 0.05,
    flatShading: true, ...o,
  });
  _m[k] = m; return m;
}

const _g = {};
function geo(t, ...a) {
  const k = `${t}_${a.join('_')}`;
  if (_g[k]) return _g[k];
  let g;
  if (t === 'box') g = new THREE.BoxGeometry(...a);
  else if (t === 'cyl') g = new THREE.CylinderGeometry(...a);
  else if (t === 'sphere') g = new THREE.SphereGeometry(...a);
  else if (t === 'plane') g = new THREE.PlaneGeometry(...a);
  else throw new Error('geo:' + t);
  _g[k] = g; return g;
}

function mk(gType, gArgs, material, o = {}) {
  const m = new THREE.Mesh(geo(gType, ...gArgs), material);
  if (o.p) m.position.set(...o.p);
  if (o.r) m.rotation.set(...o.r);
  if (o.s) m.scale.set(...o.s);
  if (o.cs !== undefined) m.castShadow = o.cs;
  if (o.rs !== undefined) m.receiveShadow = o.rs;
  if (o.n) m.name = o.n;
  return m;
}

export class OfficeScene {
  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xe8e0d4);
    this.scene.fog = new THREE.FogExp2(0xe8e0d4, 0.025);

    this.desks = {};      // { name: { group, screens:[] } }
    this.agents = {};     // { name: group }

    this._buildFloor();
    this._buildWalls();
    this._buildMainDesk();
    this._buildWorkerDesks();
    this._buildCabinets();
    this._buildDecorations();
    this._buildAgents();
  }

  /* ─── 地板 ─── */
  _buildFloor() {
    // 木地板
    this.scene.add(mk('plane', [20, 16], mt(P.floor, {r:0.8}), {
      r: [-Math.PI/2, 0, 0], rs: true, n: 'office-floor'
    }));
    // 地毯（中央区域）
    this.scene.add(mk('plane', [8, 6], mt(P.carpet, {r:0.95}), {
      p: [0, 0.005, 0], r: [-Math.PI/2, 0, 0], rs: true, n: 'carpet'
    }));
  }

  /* ─── 墙壁 ─── */
  _buildWalls() {
    const wm = mt(P.wall, {r:0.85});
    const am = mt(P.wallAccent, {r:0.8});
    // 后墙
    this.scene.add(mk('box', [20, 4, 0.2], wm, {p:[0,2,-8], cs:true, rs:true}));
    // 左墙
    this.scene.add(mk('box', [0.2, 4, 16], wm, {p:[-10,2,0], cs:true, rs:true}));
    // 右墙
    this.scene.add(mk('box', [0.2, 4, 16], wm, {p:[10,2,0], cs:true, rs:true}));
    // 前墙（带大窗户的矮墙）
    this.scene.add(mk('box', [20, 1.5, 0.2], wm, {p:[0,0.75,8], cs:true}));
    // 踢脚线
    this.scene.add(mk('box', [20, 0.12, 0.05], am, {p:[0,0.06,-7.88]}));
    this.scene.add(mk('box', [0.05, 0.12, 16], am, {p:[-9.88,0.06,0]}));
    this.scene.add(mk('box', [0.05, 0.12, 16], am, {p:[9.88,0.06,0]}));
  }

  /* ─── 主Agent办公桌（中央） ─── */
  _buildMainDesk() {
    const g = new THREE.Group(); g.name = 'main-desk'; g.position.set(0, 0, -2);
    const dm = mt(P.desk), dtm = mt(P.deskTop, {r:0.6});

    // 桌面
    g.add(mk('box', [3, 0.1, 1.5], dtm, {p:[0,0.95,0], cs:true, rs:true, n:'main-desktop'}));
    // 桌腿
    [[-1.3,0.45,-0.6],[1.3,0.45,-0.6],[-1.3,0.45,0.6],[1.3,0.45,0.6]].forEach(p =>
      g.add(mk('box',[0.08,0.9,0.08],dm,{p}))
    );
    // 侧面板
    g.add(mk('box',[0.06,0.4,1.4],dm,{p:[-1.3,0.7,0]}));

    // 显示器
    const monGroup = new THREE.Group(); monGroup.position.set(0, 1.0, -0.3);
    // 底座
    monGroup.add(mk('box',[0.4,0.03,0.25],mt(P.monitor),{p:[0,0.02,0]}));
    monGroup.add(mk('cyl',[0.06,0.06,0.3,8],mt(P.monitor),{p:[0,0.18,0]}));
    // 屏幕
    const screenMat = mt(P.screen, {r:0.1, m:0.2, emissive:new THREE.Color(P.screen), emissiveIntensity:0.3});
    const screen = mk('box', [1.2, 0.75, 0.05], screenMat, {p:[0,0.7,0], n:'main-screen'});
    monGroup.add(screen);
    // 屏幕边框
    monGroup.add(mk('box',[1.3,0.85,0.03],mt(P.monitor),{p:[0,0.7,-0.02]}));
    g.add(monGroup);

    // 键盘
    g.add(mk('box',[0.6,0.03,0.25],mt(P.monitor,{r:0.4}),{p:[0,1.0,0.4],n:'keyboard'}));
    // 鼠标
    g.add(mk('box',[0.12,0.03,0.18],mt(P.monitor,{r:0.4}),{p:[0.5,1.0,0.4],n:'mouse'}));

    this.scene.add(g);
    this.desks.main = { group:g, screens:[screen] };
  }

  /* ─── Worker办公桌 ─── */
  _buildWorkerDesks() {
    const positions = [
      { name:'w1', pos:[-5, 0, -4], rot:0 },
      { name:'w2', pos:[5, 0, -4], rot:0 },
      { name:'w3', pos:[-5, 0, 3], rot:Math.PI },
      { name:'w4', pos:[5, 0, 3], rot:Math.PI },
    ];
    positions.forEach(({name, pos, rot}) => {
      const g = new THREE.Group(); g.name = `desk-${name}`;
      g.position.set(...pos); g.rotation.y = rot;
      const dtm = mt(P.deskTop, {r:0.6});
      // 桌面
      g.add(mk('box',[2,0.1,1.2],dtm,{p:[0,0.9,0],cs:true,rs:true}));
      // 桌腿
      [[-0.85,0.42,-0.5],[0.85,0.42,-0.5],[-0.85,0.42,0.5],[0.85,0.42,0.5]].forEach(p =>
        g.add(mk('box',[0.06,0.84,0.06],mt(P.desk),{p}))
      );
      // 显示器
      const sm = mt(P.screen,{r:0.1,m:0.2,emissive:new THREE.Color(P.screen),emissiveIntensity:0.2});
      const scr = mk('box',[0.9,0.55,0.04],sm,{p:[0,1.35,-0.2],n:`screen-${name}`});
      g.add(scr);
      g.add(mk('box',[1.0,0.65,0.02],mt(P.monitor),{p:[0,1.35,-0.22]}));
      g.add(mk('cyl',[0.04,0.04,0.2,6],mt(P.monitor),{p:[0,1.05,-0.1]}));
      g.add(mk('box',[0.3,0.02,0.2],mt(P.monitor),{p:[0,0.95,-0.05]}));

      this.scene.add(g);
      this.desks[name] = { group:g, screens:[scr] };
    });
  }

  /* ─── 文件柜 ─── */
  _buildCabinets() {
    const cm = mt(P.cabinet), cdm = mt(P.cabinetDraw);
    // 左侧文件柜
    for (let i = 0; i < 3; i++) {
      const cab = mk('box', [0.8, 1.2, 0.5], cm, {
        p: [-9.2, 0.6 + i * 1.25, -5], cs: true, n: `cabinet-l-${i}`
      });
      this.scene.add(cab);
      // 抽屉把手
      this.scene.add(mk('box', [0.4, 0.04, 0.06], cdm, {p:[-9.2, 0.6+i*1.25+0.3, -4.73]}));
      this.scene.add(mk('box', [0.4, 0.04, 0.06], cdm, {p:[-9.2, 0.6+i*1.25+0.8, -4.73]}));
    }
  }

  /* ─── 装饰 ─── */
  _buildDecorations() {
    // 植物
    [[-8, -2], [8, -2], [-8, 5], [8, 5]].forEach(([x, z]) => {
      const pg = new THREE.Group(); pg.position.set(x, 0, z);
      pg.add(mk('cyl', [0.25, 0.2, 0.4, 8], mt(P.pot), {p:[0,0.2,0]}));
      pg.add(mk('sphere', [0.4, 6, 5], mt(P.plant), {p:[0,0.7,0], cs:true}));
      pg.add(mk('sphere', [0.3, 5, 4], mt(0x66bb6a), {p:[0.15,0.9,0.1], cs:true}));
      this.scene.add(pg);
    });

    // 天花板灯
    for (let x = -6; x <= 6; x += 4) {
      for (let z = -4; z <= 4; z += 4) {
        const lg = new THREE.Group(); lg.position.set(x, 3.9, z);
        lg.add(mk('box', [0.6, 0.05, 0.3], mt(0xffffff), {p:[0,0,0], n:'light-panel'}));
        const pl = new THREE.PointLight(0xfff8e1, 0.4, 5);
        pl.position.set(0, -0.1, 0);
        lg.add(pl);
        this.scene.add(lg);
      }
    }
  }

  /* ─── Agent小人（桌面版） ─── */
  _buildAgents() {
    // 主Agent椅子
    const chair = this._mkChair(); chair.position.set(0, 0, -0.5); chair.name = 'main-chair';
    this.scene.add(chair);
    // Worker椅子
    Object.entries(this.desks).forEach(([name, desk]) => {
      if (name === 'main') return;
      const ch = this._mkChair();
      ch.position.set(desk.group.position.x, 0, desk.group.position.z + (desk.group.rotation.y === 0 ? 1.2 : -1.2));
      ch.name = `chair-${name}`;
      this.scene.add(ch);
    });
  }

  _mkChair() {
    const g = new THREE.Group();
    const cm = mt(P.chair), ccm = mt(P.chairCushion, {r:0.9});
    // 底座
    g.add(mk('cyl', [0.35, 0.35, 0.05, 12], cm, {p:[0,0.6,0]}));
    // 坐垫
    g.add(mk('box', [0.5, 0.1, 0.5], ccm, {p:[0,0.65,0]}));
    // 椅背
    g.add(mk('box', [0.5, 0.6, 0.06], ccm, {p:[0,1.0,-0.22]}));
    // 支柱
    g.add(mk('cyl', [0.04, 0.04, 0.55, 6], cm, {p:[0,0.3,0]}));
    // 滚轮底座
    g.add(mk('box', [0.5, 0.04, 0.5], cm, {p:[0,0.02,0]}));
    return g;
  }

  /* ═══ 状态更新接口 ═══ */

  setScreenContent(deskName, screenIdx, state) {
    const d = this.desks[deskName];
    if (!d || !d.screens[screenIdx]) return;
    const s = d.screens[screenIdx];
    const colors = { idle: P.screen, working: P.screenLit, error: 0xef5350, done: 0x66bb6a };
    const c = colors[state] || P.screen;
    s.material.emissive.set(c);
    s.material.emissiveIntensity = state === 'idle' ? 0.2 : 0.6;
  }

  /* ═══ 每帧更新 ═══ */
  update(dt, elapsed) {
    // 屏幕闪烁效果
    Object.values(this.desks).forEach(d => {
      d.screens.forEach(s => {
        if (s.material.emissiveIntensity > 0.3) {
          s.material.emissiveIntensity += Math.sin(elapsed * 5 + s.id * 1.7) * 0.002;
        }
      });
    });
  }

  dispose() {
    this.scene.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
        else obj.material.dispose();
      }
    });
  }
}
