"""
Experience Extractor - 会话级情境记忆自动提取器
T1.1 经验提取器：从会话历史中自动提取关键经验，写入experience.json
设计原则：纯增量、零侵入、通过_turn_end_hooks注册
"""
import os, json, re, hashlib
from datetime import datetime
from collections import Counter

# ── 配置 ──
_EXPERIENCE_DIR = 'temp'  # 相对于script_dir
_EXPERIENCE_FILE = 'experience.json'
_MAX_EXPERIENCES = 200  # 单会话最大经验条数
_SUMMARY_KEYWORDS = ['成功', '完成', '失败', '发现', '解决', '修复', '搞定', '确认', '验证', 'error', 'fix', 'done', 'success', 'found']

# ── 工具分类映射 ──
_TOOL_CATEGORIES = {
    'file_read': '文件操作', 'file_patch': '文件操作', 'file_write': '文件操作',
    'code_run': '代码执行', 'web_scan': 'Web浏览', 'web_execute_js': 'Web浏览',
    'ask_user': '用户交互', 'update_working_checkpoint': '记忆管理',
    'start_long_term_update': '记忆管理',
}

def _classify_task_type(history_info):
    """从历史中推断任务类型"""
    text = ' '.join(history_info[-20:]).lower()
    scores = {
        '代码开发': sum(1 for k in ['代码', '函数', '实现', '编码', 'code', 'develop', '写一个', '新建文件', '修改文件'] if k in text),
        '调试修复': sum(1 for k in ['错误', '报错', '异常', '修复', 'error', 'fix', 'bug', 'debug', 'traceback'] if k in text),
        'Web操作': sum(1 for k in ['网页', '浏览器', '点击', 'url', 'web', 'scan', '页面'] if k in text),
        '文件管理': sum(1 for k in ['文件', '读取', '写入', 'file', '目录', 'folder'] if k in text),
        '分析研究': sum(1 for k in ['分析', '调研', '研究', '对比', '总结', 'review', '分析报告'] if k in text),
        '系统运维': sum(1 for k in ['进程', '服务', '部署', '安装', '配置', 'deploy', 'install'] if k in text),
    }
    if not any(scores.values()): return '通用任务'
    return max(scores, key=scores.get)

def _extract_tool_patterns(history_info):
    """从历史中提取工具使用模式（工具组合序列）"""
    tool_seq = []
    for line in history_info:
        m = re.search(r'调用工具(\w+)', line)
        if m: tool_seq.append(m.group(1))
    
    if len(tool_seq) < 2: return tool_seq
    
    # 提取常见的2-gram工具组合
    bigrams = [f"{tool_seq[i]}→{tool_seq[i+1]}" for i in range(len(tool_seq)-1)]
    return bigrams[-5:]  # 最近5个组合模式

def _extract_experience(summary, history_info, turn):
    """
    核心方法：从当前轮次提取经验
    返回 experience dict 或 None（不值得记录时返回None）
    
    Args:
        summary: 当前轮摘要（str，或list时自动join）
        history_info: 完整历史信息列表
        turn: 当前轮次号
    """
    # 类型安全：summary可能是list
    if isinstance(summary, (list, tuple)):
        summary = ' | '.join(str(s) for s in summary)
    summary = str(summary) if summary is not None else ''
    
    # 类型安全：history_info
    if not isinstance(history_info, list):
        history_info = list(history_info) if history_info else []
    
    # 判断是否值得记录：summary含关键词
    summary_lower = summary.lower()
    has_keyword = any(kw in summary_lower for kw in _SUMMARY_KEYWORDS)
    if not has_keyword and turn % 10 != 0:  # 非关键词但每10轮也记录一次
        return None
    
    # 提取工具使用
    tools_used = []
    for line in history_info[-10:]:
        m = re.search(r'调用工具(\w+)', line)
        if m and m.group(1) not in tools_used:
            tools_used.append(m.group(1))
    
    # 如果没有任何工具使用且不是直接回答，跳过
    if not tools_used and '直接回答' in summary:
        return None
    
    # 构建经验条目
    task_type = _classify_task_type(history_info)
    tool_patterns = _extract_tool_patterns(history_info)
    
    # 判断成功/失败
    success_indicators = ['成功', '完成', '搞定', '✅', 'success', 'done', '确认', '验证']
    fail_indicators = ['失败', '错误', '异常', '❌', 'error', 'fail', 'timeout']
    summary_text = summary
    is_success = any(kw in summary_text for kw in success_indicators)
    is_failure = any(kw in summary_text for kw in fail_indicators)
    
    # 生成唯一ID
    id_str = f"{task_type}:{summary_text}:{turn}"
    exp_id = hashlib.md5(id_str.encode()).hexdigest()[:12]
    
    experience = {
        'id': exp_id,
        'summary': summary_text[:200],
        'task_type': task_type,
        'tools_used': tools_used,
        'tool_patterns': tool_patterns,
        'success': is_success and not is_failure,
        'key_insight': _extract_key_insight(summary_text, is_success, is_failure),
        'turn': turn,
        'created_at': datetime.now().isoformat(timespec='seconds'),
    }
    
    return experience

def _extract_key_insight(summary, is_success, is_failure):
    """从摘要中提炼关键洞察"""
    if is_success:
        # 尝试提取"用什么方法成功"的模式
        patterns = [
            r'通过(.{3,30?})(成功|完成|搞定)',
            r'使用(.{3,30})(实现|解决)',
            r'用(.{3,20})修复',
        ]
        for p in patterns:
            m = re.search(p, summary)
            if m: return f"成功方法: {m.group(1)}"
        return "成功完成"
    elif is_failure:
        return f"需要关注: {summary[:60]}"
    return summary[:60]

def _save_experience(experience, task_dir, script_dir):
    """
    保存经验到experience.json
    策略：追加模式，保留最新MAX条，去重(by id)
    
    Args:
        experience: 经验dict
        task_dir: 任务目录名(temp下的子目录)
        script_dir: GA根目录
    """
    if not experience: return False
    
    # 确定文件路径
    if task_dir:
        exp_path = os.path.join(script_dir, _EXPERIENCE_DIR, task_dir, _EXPERIENCE_FILE)
    else:
        exp_path = os.path.join(script_dir, _EXPERIENCE_DIR, _EXPERIENCE_FILE)
    
    # 读取已有经验
    experiences = []
    if os.path.exists(exp_path):
        try:
            with open(exp_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                if isinstance(data, dict) and 'experiences' in data:
                    experiences = data['experiences']
                elif isinstance(data, list):
                    experiences = data
        except (json.JSONDecodeError, IOError):
            experiences = []
    
    # 去重：如果同id已存在则更新
    existing_ids = {e.get('id') for e in experiences}
    if experience['id'] in existing_ids:
        experiences = [e for e in experiences if e.get('id') != experience['id']]
    
    # 追加新经验
    experiences.append(experience)
    
    # 保留最新的MAX条
    if len(experiences) > _MAX_EXPERIENCES:
        experiences = experiences[-_MAX_EXPERIENCES:]
    
    # 写入文件
    os.makedirs(os.path.dirname(exp_path), exist_ok=True)
    output = {
        'version': '1.0',
        'task_dir': task_dir,
        'total': len(experiences),
        'last_updated': datetime.now().isoformat(timespec='seconds'),
        'experiences': experiences
    }
    
    with open(exp_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    
    # Phase 2 (T2.1.5): 增量更新跨会话经验索引
    try:
        from memory.experience_index import add_experience as _idx_add
        _idx_add(experience, script_dir=script_dir)
    except Exception:
        pass
    
    return True

def _get_recent_experiences(script_dir, task_dir=None, limit=5):
    """
    获取最近的经验（供get_system_prompt注入用）
    返回格式化的经验摘要字符串
    """
    if task_dir:
        exp_path = os.path.join(script_dir, _EXPERIENCE_DIR, task_dir, _EXPERIENCE_FILE)
    else:
        exp_path = os.path.join(script_dir, _EXPERIENCE_DIR, _EXPERIENCE_FILE)
    
    if not os.path.exists(exp_path): return ""
    
    try:
        with open(exp_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        experiences = data.get('experiences', []) if isinstance(data, dict) else data
        if not experiences: return ""
        
        # 取最近的成功经验
        recent = [e for e in experiences[-limit:] if e.get('success', True)]
        if not recent: recent = experiences[-limit:]
        
        lines = ["[Recent Experience]"]
        for exp in recent:
            tools_str = ', '.join(exp.get('tools_used', []))
            lines.append(f"  - [{exp.get('task_type','?')}] {exp.get('summary','')[:80]} (tools: {tools_str})")
        
        return '\n'.join(lines)
    except Exception:
        return ""


# ── Hook注册函数（供agentmain.py调用）──
def create_experience_hook(agent):
    """
    创建经验提取hook，注册到agent._turn_end_hooks
    在agentmain.py中调用: 
        from memory.experience_extractor import create_experience_hook
        create_experience_hook(agent)
    """
    script_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    
    def _hook(locals_dict):
        """turn_end_callback中调用的hook"""
        try:
            summary = locals_dict.get('summary', '')
            self_ref = locals_dict.get('self')
            turn = locals_dict.get('turn', 0)
            
            if not self_ref or not summary: return
            
            history_info = getattr(self_ref, 'history_info', [])
            
            # 提取经验
            experience = _extract_experience(summary, history_info, turn)
            if not experience: return
            
            # 确定task_dir
            parent = getattr(self_ref, 'parent', None)
            task_dir_name = ''
            if parent:
                td = getattr(parent, 'task_dir', '')
                if td:
                    task_dir_name = os.path.basename(td)
            
            # 保存
            _save_experience(experience, task_dir_name, script_dir)

            # WS广播：通知前端Status Bar更新
            try:
                dq = getattr(parent, '_current_display_queue', None) if parent else None
                if dq:
                    dq.put({
                        'ws_type': 'experience',
                        'payload': {
                            'id': experience['id'],
                            'summary': experience['summary'][:80],
                            'task_type': experience['task_type'],
                            'success': experience['success'],
                            'turn': turn
                        }
                    })
            except Exception:
                pass  # WS广播失败不影响主流程
            
        except Exception as e:
            # 经验提取不应影响主流程，静默失败
            try: print(f'[ExperienceExtractor] Warning: {e}')
            except: pass
    
    # 注册hook
    if not hasattr(agent, '_turn_end_hooks'):
        agent._turn_end_hooks = {}
    agent._turn_end_hooks['experience_extractor'] = _hook
    
    return _hook
