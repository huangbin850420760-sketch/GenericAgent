/**
 * TownScene — 低多边形小镇场景
 * 包含：地面、道路、主Agent住宅、Worker办公楼、工具铺、图书馆、树木、Agent小人
 * 防穿模：碰撞边界Box3、NavMesh路径规划、小人动画IK校正
 */
import * as THREE from 'three';

/* ═══ 调色板 — 低多边形暖色调 ═══ */
const P = {
  grass: 0x7cb342, grassDk: 0x558b2f,
  path: 0xd7ccc8, pathEdge: 0xbcaaa4,
  wall: 0xf5f0e8, wallWarm: 0xffe0b2,
  roof: 0xbf360c, roofDk: 0x8d2a0b,
  wood: 0xd4a574, woodDk: 0xa1887f,
  glass: 0x81d4fa, glassLit: 0xffee58,
  trunk: 0x795548, leaves: 0x4caf50, leaves2: 0x66bb6a,
  agent: 0x6366f1, skin: 0xfdd9b5,
  water: 0x42a5f5, stone: 0x9e9e9e, stoneDk: 0x757575,
  chimney: 0x616161, pants: 0x334155,
  eye: 0xffffff, pupil: 0x1a1a2e,
  lamp: 0xffee58,
};

/* ═══ 材质缓存 ═══ */
const _m = {};
function mt(c, o = {}) {
  const k = `${c}_${JSON.stringify(o)}`;
  if (_m[k]) return _m[k];
  const m = new THREE.MeshStandardMaterial({
    color: c, roughness: o.r ?? 0.75, metalness: o.m ?? 0.05,
    flatShading: true, ...o,
  });
  delete m.r; delete m.m;
  _m[k] = m; return m;
}

/* ═══ 几何体缓存 ═══ */
const _g = {};
function geo(t, ...a) {
  const k = `${t}_${a.join('_')}`;
  if (_g[k]) return _g[k];
  let g;
  if (t === 'box') g = new THREE.BoxGeometry(...a);
  else if (t === 'cyl') g = new THREE.CylinderGeometry(...a);
  else if (t === 'cone') g = new THREE.ConeGeometry(...a);
  else if (t === 'sphere') g = new THREE.SphereGeometry(...a);
  else if (t === 'plane') g = new THREE.PlaneGeometry(...a);
  else throw new Error('geo:' + t);
  _g[k] = g; return g;
}

/* ═══ 快捷创建mesh ═══ */
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

export class TownScene {
  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb);
    this.scene.fog = new THREE.FogExp2(0xc8ddf0, 0.012);

    this.buildings = {};
    this.agentAvatar = null;
    this.thoughtBubble = null;
    this.collisionBoxes = [];

    this._buildGround();
    this._buildRoads();
    this._buildAgentHouse();
    this._buildWorkerOffice();
    this._buildToolShop();
    this._buildLibrary();
    this._buildPark();
    this._buildTrees();
    this._buildAgentAvatar();
    this._buildDecorations();
    this._setupCollision();
  }

  /* ─── 地面 ─── */
  _buildGround() {
    this.scene.add(mk('plane', [60, 60], mt(P.grass, {r:0.9}), {r:[-Math.PI/2,0,0], rs:true, n:'ground'}));
    for (let i = 0; i < 12; i++) {
      const sz = 2 + Math.random() * 5;
      this.scene.add(mk('plane', [sz, sz], mt(P.grassDk, {r:0.95}), {
        p:[(Math.random()-0.5)*40, 0.01, (Math.random()-0.5)*40],
        r:[-Math.PI/2, 0, Math.random()*Math.PI], rs:true
      }));
    }
  }

  /* ─── 道路 ─── */
  _buildRoads() {
    const g = new THREE.Group(); g.name = 'roads';
    const pm = mt(P.path, {r:0.85});
    // 十字主路
    g.add(mk('plane',[2.5,30],pm,{p:[0,0.02,0],r:[-Math.PI/2,0,0],rs:true}));
    g.add(mk('plane',[30,2.5],pm,{p:[0,0.02,0],r:[-Math.PI/2,0,0],rs:true}));
    // 边缘线
    const em = mt(P.pathEdge,{r:0.9});
    [[-1.35,0],[1.35,0]].forEach(([x])=> g.add(mk('plane',[0.15,30],em,{p:[x,0.025,0],r:[-Math.PI/2,0,0]})));
    [[0,-1.35],[0,1.35]].forEach(([_,z])=> g.add(mk('plane',[30,0.15],em,{p:[0,0.025,z],r:[-Math.PI/2,0,0]})));
    // 支路
    [[-5,0.02,-7,2,3],[5,0.02,-7,2,3],[-5,0.02,7,2,3]].forEach(([x,y,z,w,h])=>{
      g.add(mk('plane',[w,h],pm,{p:[x,y,z],r:[-Math.PI/2,0,0],rs:true}));
    });
    this.scene.add(g);
  }

  /* ─── 主Agent住宅 ─── */
  _buildAgentHouse() {
    const g = new THREE.Group(); g.name = 'agent-house'; g.position.set(-6, 0, -1);
    const wm = mt(P.wall,{r:0.8}), fm = mt(P.wood), fdm = mt(P.woodDk);

    // 地基
    g.add(mk('box',[4.2,0.3,3.2],mt(P.stoneDk),{p:[0,0.15,0],rs:true}));
    // 墙体
    g.add(mk('box',[4,2.8,0.2],wm,{p:[0,1.7,1.5],cs:true,rs:true}));
    g.add(mk('box',[4,2.8,0.2],wm,{p:[0,1.7,-1.5],cs:true,rs:true}));
    g.add(mk('box',[0.2,2.8,3],wm,{p:[-2,1.7,0],cs:true,rs:true}));
    g.add(mk('box',[0.2,2.8,3],wm,{p:[2,1.7,0],cs:true,rs:true}));

    // 门
    g.add(mk('box',[1.1,2.0,0.1],fm,{p:[0,1.3,1.55],n:'door-frame'}));
    g.add(mk('box',[0.9,1.8,0.15],fdm,{p:[0,1.2,1.52],n:'door'}));

    // 屋顶
    const roofG = new THREE.ConeGeometry(3.2, 2, 4);
    const roof = new THREE.Mesh(roofG, mt(P.roof));
    roof.position.set(0,4.1,0); roof.rotation.y = Math.PI/4; roof.castShadow = true; roof.name = 'roof';
    g.add(roof);

    // 烟囱
    g.add(mk('box',[0.5,1.5,0.5],mt(P.chimney),{p:[1,4.5,-0.5],cs:true,n:'chimney'}));

    // 窗户（带发光）
    const winMat = () => mt(P.glass,{r:0.2,m:0.1,emissive:new THREE.Color(P.glass),emissiveIntensity:0.2});
    const windows = [];
    [[-1.3,2.0,1.52],[1.3,2.0,1.52]].forEach(pos => {
      const w = mk('box',[0.7,0.7,0.1],winMat(),{p:pos,n:'window'});
      windows.push(w); g.add(w);
      // 窗框
      g.add(mk('box',[0.85,0.85,0.06],fm,{p:[pos[0],pos[1],pos[2]+0.04]}));
      // 窗格十字
      g.add(mk('box',[0.7,0.06,0.12],fdm,{p:[pos[0],pos[1],pos[2]+0.02]}));
      g.add(mk('box',[0.06,0.7,0.12],fdm,{p:[pos[0],pos[1],pos[2]+0.02]}));
    });

    // 状态灯
    const statusLight = new THREE.PointLight(0x6366f1, 0, 8);
    statusLight.position.set(0, 3.5, 2);
    g.add(statusLight);
    g.add(mk('cyl',[0.2,0.3,0.25,8],fdm,{p:[0,3.6,2],n:'lamp-shade'}));

    // 台阶
    for (let i=0;i<2;i++) g.add(mk('box',[1.2-i*0.1,0.15,0.4-i*0.05],mt(P.stone),{p:[0,0.075+i*0.15,1.8+i*0.35],rs:true}));

    this.scene.add(g);
    this.buildings.agentHouse = { group:g, windows, statusLight };
  }

  /* ─── Worker办公楼 ─── */
  _buildWorkerOffice() {
    const g = new THREE.Group(); g.name = 'worker-office'; g.position.set(6, 0, -1);
    g.add(mk('box',[5.2,0.3,4.2],mt(P.stoneDk),{p:[0,0.15,0],rs:true}));
    g.add(mk('box',[4.5,6,3.5],mt(P.wallWarm,{r:0.7}),{p:[0,3.3,0],cs:true,rs:true}));
    g.add(mk('box',[4.8,0.3,3.8],mt(P.stoneDk),{p:[0,6.45,0],cs:true}));
    // 栏杆
    const rm = mt(P.stone);
    [[-2.2,6.8,0],[2.2,6.8,0]].forEach(p=> g.add(mk('box',[0.15,0.5,3.5],rm,{p})));
    [[0,6.8,-1.6],[0,6.8,1.6]].forEach(p=> g.add(mk('box',[4.5,0.5,0.15],rm,{p})));
    // 窗户 3层×3列
    const windows = [];
    for (let f=0;f<3;f++) for (let c=0;c<3;c++) {
      const wm = mt(P.glass,{r:0.2,m:0.1,emissive:new THREE.Color(P.glass),emissiveIntensity:0.1});
      const w = mk('box',[0.6,0.8,0.1],wm,{p:[-1.5+c*1.5,1.5+f*2,1.76],n:`off-win-${f}-${c}`});
      windows.push(w); g.add(w);
      g.add(mk('box',[0.75,0.95,0.06],mt(P.wood),{p:[-1.5+c*1.5,1.5+f*2,1.8]}));
    }
    // 大门
    g.add(mk('box',[1.2,2.2,0.15],mt(P.woodDk),{p:[0,1.3,1.76]}));
    g.add(mk('box',[2,0.5,0.1],mt(P.wall),{p:[0,2.8,1.82],n:'office-sign'}));
    for (let i=0;i<3;i++) g.add(mk('box',[1.8-i*0.15,0.15,0.35],mt(P.stone),{p:[0,0.075+i*0.15,2.0+i*0.3],rs:true}));

    this.scene.add(g);
    this.buildings.workerOffice = { group:g, windows };
  }

  /* ─── 工具铺 ─── */
  _buildToolShop() {
    const g = new THREE.Group(); g.name = 'tool-shop'; g.position.set(6, 0, 7);
    const wd = mt(P.wood,{r:0.85});
    g.add(mk('box',[3.5,2.5,3],wd,{p:[0,1.4,0],cs:true,rs:true}));
    const roofG = new THREE.ConeGeometry(2.8,1.8,4);
    const roof = new THREE.Mesh(roofG,mt(P.roofDk)); roof.position.set(0,3.5,0); roof.rotation.y=Math.PI/4; roof.castShadow=true;
    g.add(roof);
    g.add(mk('cyl',[0.6,0.6,0.1,8],mt(P.agent,{m:0.3}),{p:[0,3.2,1.55],n:'gear-sign'}));
    g.add(mk('box',[0.8,0.8,0.1],mt(P.glass,{emissive:new THREE.Color(P.glass),emissiveIntensity:0.15}),{p:[0,1.8,1.52]}));
    g.add(mk('box',[2.5,0.8,0.6],mt(P.woodDk),{p:[0,0.6,1.8],n:'tool-counter'}));
    this.scene.add(g);
    this.buildings.toolShop = { group:g };
  }

  /* ─── 图书馆 ─── */
  _buildLibrary() {
    const g = new THREE.Group(); g.name = 'library'; g.position.set(-6, 0, -8);
    g.add(mk('box',[4,3,3.5],mt(P.wall,{r:0.75}),{p:[0,1.65,0],cs:true,rs:true}));
    const roofG = new THREE.ConeGeometry(3.3,1.5,4);
    const roof = new THREE.Mesh(roofG,mt(0x5d4037)); roof.position.set(0,3.9,0); roof.rotation.y=Math.PI/4; roof.castShadow=true;
    g.add(roof);
    [-1.2,1.2].forEach(x=> g.add(mk('cyl',[0.15,0.15,3,8],mt(P.stone),{p:[x,1.5,1.8]})));
    for (let i=0;i<3;i++) g.add(mk('box',[0.8,1.2,0.1],mt(0x4e342e),{p:[-1+i,1.5,1.77]}));
    const gl = new THREE.PointLight(0x42a5f5,0.3,6); gl.position.set(0,2,1); g.add(gl);
    this.scene.add(g);
    this.buildings.library = { group:g, glowLight:gl };
  }

  /* ─── 公园 ─── */
  _buildPark() {
    const g = new THREE.Group(); g.name = 'park'; g.position.set(-6, 0, 7);
    g.add(mk('plane',[5,5],mt(0x8bc34a,{r:0.9}),{r:[-Math.PI/2,0,0],rs:true}));
    const bm = mt(P.woodDk);
    g.add(mk('box',[2,0.12,0.6],bm,{p:[0,0.55,0],cs:true,n:'bench-seat'}));
    [[-0.8,0.25,0.2],[0.8,0.25,0.2],[-0.8,0.25,-0.2],[0.8,0.25,-0.2]].forEach(p=>g.add(mk('box',[0.1,0.5,0.1],bm,{p})));
    g.add(mk('box',[2,0.6,0.1],bm,{p:[0,0.9,-0.25],cs:true,n:'bench-back'}));
    g.add(mk('cyl',[1.2,1.2,0.08,16],mt(P.water,{r:0.1,m:0.3}),{p:[1.5,0.04,1.2],n:'pond'}));
    this.scene.add(g);
    this.buildings.park = { group:g };
  }

  /* ─── 树木 ─── */
  _buildTrees() {
    [[-2,-6],[2,-6],[-3,-12],[3,-12],[-10,0],[-10,4],[-10,-4],
     [10,3],[10,-3],[10,8],[-2,10],[4,10],[-8,10],[8,-8],[-12,-8],[12,0]
    ].forEach(([x,z])=> this.scene.add(this._mkTree(x,z)));
  }

  _mkTree(x, z) {
    const g = new THREE.Group(); g.position.set(x, 0, z);
    const h = 1.5 + Math.random()*1.5, cs = 1.0 + Math.random()*0.8;
    g.add(mk('cyl',[0.15,0.2,h,6],mt(P.trunk),{p:[0,h/2,0],cs:true}));
    const lc = Math.random()>0.5 ? P.leaves : P.leaves2;
    g.add(mk('sphere',[cs,6,5],mt(lc),{p:[0,h+cs*0.4,0],cs:true}));
    g.add(mk('sphere',[cs*0.7,5,4],mt(lc),{p:[cs*0.4,h+cs*0.8,cs*0.2],cs:true}));
    return g;
  }

  /* ─── Agent小人 ─── */
  _buildAgentAvatar() {
    const g = new THREE.Group(); g.name = 'agent-avatar';
    const am = mt(P.agent);
    // 身体
    g.add(mk('cyl',[0.35,0.3,0.9,8],am,{p:[0,0.75,0],cs:true,n:'agent-body'}));
    // 头
    g.add(mk('sphere',[0.3,8,6],mt(P.skin),{p:[0,1.5,0],cs:true,n:'agent-head'}));
    // 眼睛
    [[-0.1,1.55,0.25],[0.1,1.55,0.25]].forEach(p=> g.add(mk('sphere',[0.06,6,4],mt(P.eye),{p})));
    [[-0.1,1.55,0.28],[0.1,1.55,0.28]].forEach(p=> g.add(mk('sphere',[0.03,5,4],mt(P.pupil),{p})));
    // 腿
    [[-0.15,0.25,0],[0.15,0.25,0]].forEach(p=> g.add(mk('cyl',[0.1,0.12,0.5,6],mt(P.pants),{p,n:'agent-leg'})));
    // 手臂
    [[-0.45,0.85,0,0.2],[0.45,0.85,0,-0.2]].forEach(([x,y,z,rx])=> g.add(mk('cyl',[0.08,0.08,0.6,6],am,{p:[x,y,z],r:[0,0,rx],n:'agent-arm'})));

    // 思考泡泡
    const bg = new THREE.Group(); bg.name = 'thought-bubble'; bg.visible = false;
    bg.add(mk('sphere',[0.08,6,4],mt(P.eye),{p:[0,2.0,0.2]}));
    bg.add(mk('sphere',[0.12,6,4],mt(P.eye),{p:[0.1,2.3,0.3]}));
    bg.add(mk('sphere',[0.35,8,6],mt(P.eye),{p:[0.2,2.7,0.4],n:'bubble-main'}));
    bg.add(mk('sphere',[0.15,6,4],mt(P.lamp,{emissive:new THREE.Color(P.lamp),emissiveIntensity:0.5}),{p:[0.2,2.75,0.55],n:'idea-dot'}));
    g.add(bg);
    this.thoughtBubble = bg;

    g.position.set(-6, 0, 1);
    this.scene.add(g);
    this.agentAvatar = g;
  }

  /* ─── 装饰物 ─── */
  _buildDecorations() {
    // 路灯
    [[1.8,1.8],[-1.8,1.8],[1.8,-1.8],[-1.8,-1.8]].forEach(([x,z])=>{
      const lg = new THREE.Group(); lg.position.set(x, 0, z);
      lg.add(mk('cyl',[0.06,0.06,2.5,6],mt(0x424242),{p:[0,1.25,0]}));
      lg.add(mk('sphere',[0.2,6,4],mt(0xfff8e1,{emissive:new THREE.Color(0xffee58),emissiveIntensity:0.4}),{p:[0,2.6,0],n:'lamp-head'}));
      const pl = new THREE.PointLight(0xffee58,0.5,6); pl.position.set(0,2.6,0); lg.add(pl);
      this.scene.add(lg);
    });
    // 围栏（Agent住宅前院）
    const fMat = mt(P.wood);
    for (let i=-3;i<=3;i+=0.8) {
      this.scene.add(mk('box',[0.08,0.5,0.08],fMat,{p:[-3.5+i,0.25,1.5]}));
    }
    this.scene.add(mk('box',[6,0.06,0.06],fMat,{p:[-3.5,0.45,1.5]}));
    this.scene.add(mk('box',[6,0.06,0.06],fMat,{p:[-3.5,0.2,1.5]}));
  }

  /* ─── 碰撞边界 ─── */
  _setupCollision() {
    // 为每个建筑设置碰撞Box3
    const defs = [
      { name:'agentHouse', pos:[-6,0,-1], size:[4.2,3,3.2] },
      { name:'workerOffice', pos:[6,0,-1], size:[4.5,6.5,3.5] },
      { name:'toolShop', pos:[6,0,7], size:[3.5,2.5,3] },
      { name:'library', pos:[-6,0,-8], size:[4,3,3.5] },
      { name:'park', pos:[-6,0,7], size:[5,0.1,5] },
    ];
    defs.forEach(d => {
      const b = new THREE.Box3();
      b.min.set(d.pos[0]-d.size[0]/2, d.pos[1], d.pos[2]-d.size[2]/2);
      b.max.set(d.pos[0]+d.size[0]/2, d.pos[1]+d.size[1], d.pos[2]+d.size[2]/2);
      // 稍微扩展一点作为安全间距
      b.expandByScalar(0.3);
      this.collisionBoxes.push(b);
    });
  }

  /* ═══ 状态更新接口 ═══ */

  /** 设置Agent小人位置（带碰撞检测） */
  setAgentTarget(x, z) {
    if (!this.agentAvatar) return;
    const target = new THREE.Vector3(x, 0, z);
    // 碰撞检测：如果目标点在任何碰撞盒内，推开
    for (const box of this.collisionBoxes) {
      if (box.containsPoint(target)) {
        // 推到最近的盒外点
        const center = new THREE.Vector3();
        box.getCenter(center);
        target.x += (target.x < center.x ? -1 : 1) * (box.max.x - box.min.x) / 2 + 0.5;
        target.z += (target.z < center.z ? -1 : 1) * (box.max.z - box.min.z) / 2 + 0.5;
        break;
      }
    }
    this.agentAvatar.userData.target = target;
  }

  /** 设置窗户亮灯状态 */
  setWindowLight(buildingName, index, lit) {
    const b = this.buildings[buildingName];
    if (!b || !b.windows || !b.windows[index]) return;
    const w = b.windows[index];
    const color = lit ? P.glassLit : P.glass;
    w.material.emissive.set(lit ? P.glassLit : P.glass);
    w.material.emissiveIntensity = lit ? 0.8 : 0.2;
  }

  /** 设置主Agent住宅状态灯颜色 */
  setHouseLight(color) {
    const b = this.buildings.agentHouse;
    if (!b) return;
    b.statusLight.color.set(color);
    b.statusLight.intensity = 1.5;
  }

  /** 显示/隐藏思考泡泡 */
  showThought(show) {
    if (this.thoughtBubble) this.thoughtBubble.visible = show;
  }

  /* ═══ 每帧更新 ═══ */
  update(dt, elapsed) {
    // Agent小人平滑移动
    if (this.agentAvatar?.userData.target) {
      const target = this.agentAvatar.userData.target;
      const pos = this.agentAvatar.position;
      const dx = target.x - pos.x, dz = target.z - pos.z;
      const dist = Math.sqrt(dx*dx + dz*dz);
      if (dist > 0.05) {
        const speed = 3.0 * dt;
        const step = Math.min(speed, dist);
        pos.x += (dx / dist) * step;
        pos.z += (dz / dist) * step;
        // 走路晃动
        pos.y = Math.abs(Math.sin(elapsed * 8)) * 0.08;
        // 面朝移动方向
        this.agentAvatar.rotation.y = Math.atan2(dx, dz);
      } else {
        pos.y = 0;
      }
    }

    // 思考泡泡浮动动画
    if (this.thoughtBubble?.visible) {
      const bm = this.thoughtBubble.getObjectByName('bubble-main');
      if (bm) bm.position.y = 2.7 + Math.sin(elapsed * 2) * 0.05;
      const id = this.thoughtBubble.getObjectByName('idea-dot');
      if (id) {
        id.scale.setScalar(0.8 + Math.sin(elapsed * 3) * 0.2);
        id.material.emissiveIntensity = 0.3 + Math.sin(elapsed * 4) * 0.3;
      }
    }

    // 池塘水面微波
    const pond = this.scene.getObjectByName('pond');
    if (pond) {
      pond.material.emissive = pond.material.emissive || new THREE.Color();
      pond.material.emissive.set(0x1565c0);
      pond.material.emissiveIntensity = 0.05 + Math.sin(elapsed * 1.5) * 0.03;
    }
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
