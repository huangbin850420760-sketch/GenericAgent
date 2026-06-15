/**
 * StateMapper — 将Agent状态数据映射到3D场景变化
 * 监听CustomEvent，驱动TownScene和OfficeScene的状态更新
 */
export class StateMapper {
  constructor(townScene, officeScene) {
    this.town = townScene;
    this.office = officeScene;
    this.currentState = 'idle';
    this._setupListeners();
  }

  /* ═══ 事件监听 ═══ */
  _setupListeners() {
    // Agent主状态变化: idle|thinking|working|error|done
    document.addEventListener('agent-state', (e) => this.onAgentState(e.detail));
    // 执行步骤变化
    document.addEventListener('execution-step', (e) => this.onExecutionStep(e.detail));
    // 记忆统计变化
    document.addEventListener('memory-stats', (e) => this.onMemoryStats(e.detail));
    // Worker状态变化
    document.addEventListener('worker-state', (e) => this.onWorkerState(e.detail));
    // 工具调用
    document.addEventListener('tool-call', (e) => this.onToolCall(e.detail));
  }

  /* ═══ Agent主状态映射 ═══ */
  onAgentState(state) {
    if (!state || !state.status) return;
    this.currentState = state.status;
    const s = state.status;

    // ─── 小镇场景映射 ───
    if (this.town) {
      // 住宅状态灯颜色
      const lightColors = {
        idle: 0x6366f1,      // 紫色（品牌色）
        thinking: 0xffc107,   // 琥珀色（思考中）
        working: 0x42a5f5,    // 蓝色（工作中）
        error: 0xef5350,      // 红色（错误）
        done: 0x66bb6a,       // 绿色（完成）
      };
      this.town.setHouseLight(lightColors[s] || 0x6366f1);

      // 思考泡泡
      this.town.showThought(s === 'thinking');

      // Agent小人位置
      const positions = {
        idle: [-6, 1],        // 住宅门口
        thinking: [-6, 7],    // 公园长椅旁
        working: [6, -1],     // 办公楼前
        error: [-6, -1],      // 回家
        done: [0, 0],         // 十字路口中央
      };
      const [tx, tz] = positions[s] || [-6, 1];
      this.town.setAgentTarget(tx, tz);

      // 窗户亮灯 — 工作中时住宅窗户亮灯
      this.town.setWindowLight('agentHouse', 0, s === 'working' || s === 'thinking');
      this.town.setWindowLight('agentHouse', 1, s === 'working' || s === 'thinking');
    }

    // ─── 办公室场景映射 ───
    if (this.office) {
      this.office.setScreenContent('main', 0, s);
    }
  }

  /* ═══ 执行步骤映射 ═══ */
  onExecutionStep(step) {
    if (!step) return;
    // 步骤进度 → Agent小人移动到对应建筑
    const stepToBuilding = {
      'plan': [-6, -8],       // 图书馆（规划阶段）
      'think': [-6, 7],       // 公园（思考阶段）
      'execute': [6, -1],     // 办公楼（执行阶段）
      'tool': [6, 7],         // 工具铺（工具调用）
      'verify': [-6, -8],     // 图书馆（验证阶段）
      'report': [0, 0],       // 十字路口（汇报）
    };
    const pos = stepToBuilding[step.step] || stepToBuilding[step.type];
    if (pos && this.town) {
      this.town.setAgentTarget(pos[0], pos[1]);
    }
  }

  /* ═══ 记忆统计映射 ═══ */
  onMemoryStats(stats) {
    if (!stats) return;
    // 记忆条目数 → 图书馆窗户亮度
    if (this.town && this.town.buildings.library?.glowLight) {
      const intensity = Math.min(0.3 + (stats.totalEntries || 0) * 0.01, 1.5);
      this.town.buildings.library.glowLight.intensity = intensity;
    }
  }

  /* ═══ Worker状态映射 ═══ */
  onWorkerState(state) {
    if (!state) return;
    // Worker状态 → 办公楼窗户 + 办公桌屏幕
    const { id, status } = state;
    const idx = parseInt(id) || 0;

    if (this.town) {
      // 办公楼窗户（3层×3列，Worker映射到对应位置）
      const floor = Math.floor(idx / 3);
      const col = idx % 3;
      const winIdx = floor * 3 + col;
      this.town.setWindowLight('workerOffice', winIdx, status === 'working');
    }
    if (this.office && idx < 4) {
      const deskName = `w${idx + 1}`;
      this.office.setScreenContent(deskName, 0, status);
    }
  }

  /* ═══ 工具调用映射 ═══ */
  onToolCall(tool) {
    if (!tool) return;
    // 工具调用 → Agent小人移动到工具铺
    if (this.town) {
      this.town.setAgentTarget(6, 7);
    }
  }

  /* ═══ 清理 ═══ */
  dispose() {
    // CustomEvent监听随document生命周期自动清理
  }
}
