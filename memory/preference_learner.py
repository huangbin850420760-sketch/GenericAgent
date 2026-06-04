"""
Preference Learner - 用户偏好自动学习器
T1.3 偏好学习：从会话交互中自动提取用户偏好，持久化到preferences.json
设计原则：通过_turn_end_hooks注册，零侵入
"""
import os, json, re, hashlib
from datetime import datetime

# ── 配置 ──
_PREF_FILE = 'preferences.json'
_MAX_PREFERENCES = 100

# ── 偏好模式（正则匹配用户明确的偏好表达） ──
_PREFERENCE_PATTERNS = [
    # 否定性偏好 (?:[，。！？,\s]|$) 作为词边界
    (r'(?:不要|别|禁止|不用|避免|切勿|千万不要)\s*用\s*["\']?([\w\u4e00-\u9fff./\\\-]+)(?:[，。！？,\s]|$)', 'avoid_tool', 0.9),
    (r'(?:不要|别|不喜欢|讨厌)\s*(?:用|使用|看到)\s*["\']?([\w\u4e00-\u9fff./\\\-]+)(?:[，。！？,\s]|$)', 'dislike', 0.85),
    (r'(?:不要|别)\s*(?:给|在)\s*我\s*(?:用|显示)\s*["\']?([\w\u4e00-\u9fff./\\\-]+)(?:[，。！？,\s]|$)', 'dislike', 0.85),
    # 肯定性偏好
    (r'(?:我喜欢|爱用|偏好|prefer|喜欢)\s*(?:用|使用)?\s*["\']?([\w\u4e00-\u9fff./\\\-]+)(?:[，。！？,\s]|$)', 'prefer', 0.85),
    (r'(?:以后|下次|总是|always)\s*(?:都)?\s*(?:用|使用|给)\s*["\']?([\w\u4e00-\u9fff./\\\-]+)(?:[，。！？,\s]|$)', 'always_use', 0.9),
    # 风格偏好
    (r'(?:简洁|详细|简短|verbose|terse|concise)\s*(?:一点|些|地)?\s*(?:回答|输出|写)', 'style', 0.8),
    (r'(?:用|使用)(中文|英文|Python|TypeScript)\s*(?:回答|写|输出)', 'language', 0.9),
    # 格式偏好
    (r'(?:不要|别)\s*(?:加|显示|输出)\s*(?:注释|comment)', 'no_comments', 0.8),
    (r'(?:加上|显示|包含)\s*(?:注释|comment|说明)', 'with_comments', 0.8),
    (r'(?:输出|打印|显示)\s*(?:格式|format)\s*(?:用|为|是)\s*["\']?([\w\u4e00-\u9fff./\\\-]+)(?:[，。！？,\s]|$)', 'format', 0.8),
]

# ── 从Agent行为推断偏好 ──
_TOOL_FEEDBACK_PATTERNS = [
    # 工具失败后用户的反馈模式
    (r'(?:换|改用|试试)\s*(\w+)\s*(?:吧|吧|看看)', 'tool_switch', 0.7),
    (r'(?:这个|那个)\s*(?:好|行|可以|不错)', 'positive_feedback', 0.6),
    (r'(?:这个|这)\s*(?:不行|不好|不对|错)', 'negative_feedback', 0.7),
]


def _extract_preferences_from_text(text):
    """
    从文本中提取偏好
    返回 list of {key, value, pattern_type, confidence}
    """
    prefs = []
    text_lower = text.lower()
    
    for pattern, pref_type, confidence in _PREFERENCE_PATTERNS:
        matches = re.finditer(pattern, text_lower)
        for m in matches:
            value = m.group(1).strip(' "\'。，,.')
            if value and len(value) < 50:  # 防止匹配到过长文本
                prefs.append({
                    'key': f'{pref_type}:{value}',
                    'value': value,
                    'pattern_type': pref_type,
                    'confidence': confidence,
                })
    
    return prefs


def _detect_tool_preferences(history_info):
    """
    从工具使用历史中推断隐式偏好
    例如：用户多次拒绝某工具的结果 → 偏好避免该工具
    """
    prefs = []
    
    # 统计最近20条中工具调用和失败的关联
    recent = history_info[-20:]
    
    # 检测连续失败的工具
    fail_tools = []
    for i, line in enumerate(recent):
        if any(kw in line for kw in ['❌', '失败', 'error', 'Error']):
            # 找前面最近一次工具调用
            for j in range(i-1, max(i-5, -1), -1):
                m = re.search(r'调用工具(\w+)', recent[j])
                if m:
                    fail_tools.append(m.group(1))
                    break
    
    # 同一工具失败2次以上 → 偏好避免
    from collections import Counter
    tool_fail_counts = Counter(fail_tools)
    for tool, count in tool_fail_counts.items():
        if count >= 2:
            prefs.append({
                'key': f'avoid_tool:{tool}',
                'value': tool,
                'pattern_type': 'auto_avoid',
                'confidence': min(0.5 + count * 0.1, 0.9),
            })
    
    return prefs


def _load_preferences(script_dir):
    """加载已有偏好文件"""
    pref_path = os.path.join(script_dir, 'temp', _PREF_FILE)
    if not os.path.exists(pref_path):
        return {'version': '1.0', 'preferences': []}
    try:
        with open(pref_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {'version': '1.0', 'preferences': []}


def _save_preferences(data, script_dir):
    """保存偏好到文件"""
    pref_path = os.path.join(script_dir, 'temp', _PREF_FILE)
    os.makedirs(os.path.dirname(pref_path), exist_ok=True)
    data['last_updated'] = datetime.now().isoformat(timespec='seconds')
    with open(pref_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _merge_preferences(existing_prefs, new_prefs):
    """
    合并新旧偏好：同key更新confidence和timestamp
    返回 (merged_list, new_count)
    """
    existing_map = {p['key']: p for p in existing_prefs}
    new_count = 0
    
    for np in new_prefs:
        key = np['key']
        if key in existing_map:
            # 更新已有偏好：boost confidence
            ep = existing_map[key]
            ep['confidence'] = min(ep.get('confidence', 0.5) + 0.05, 1.0)
            ep['updated_at'] = datetime.now().isoformat(timespec='seconds')
            ep['hit_count'] = ep.get('hit_count', 1) + 1
        else:
            # 新偏好
            np['created_at'] = datetime.now().isoformat(timespec='seconds')
            np['updated_at'] = np['created_at']
            np['hit_count'] = 1
            existing_prefs.append(np)
            new_count += 1
    
    # 按confidence排序，保留top MAX
    existing_prefs.sort(key=lambda p: p.get('confidence', 0), reverse=True)
    if len(existing_prefs) > _MAX_PREFERENCES:
        existing_prefs = existing_prefs[:_MAX_PREFERENCES]
    
    return existing_prefs, new_count


def _format_preferences_for_prompt(script_dir):
    """
    格式化偏好注入system_prompt
    供get_system_prompt调用
    """
    data = _load_preferences(script_dir)
    prefs = data.get('preferences', [])
    if not prefs: return ""
    
    # 只取高confidence的偏好
    high_conf = [p for p in prefs if p.get('confidence', 0) >= 0.7]
    if not high_conf: return ""
    
    lines = ["[User Preferences]"]
    for p in high_conf[:10]:  # 最多注入10条
        pt = p.get('pattern_type', '')
        val = p.get('value', '')
        conf = p.get('confidence', 0)
        if pt in ('avoid_tool', 'dislike', 'auto_avoid'):
            lines.append(f"  - ⛔ 避免使用 {val} (置信度:{conf:.0%})")
        elif pt in ('prefer', 'always_use'):
            lines.append(f"  - ✅ 偏好使用 {val} (置信度:{conf:.0%})")
        elif pt == 'style':
            lines.append(f"  - 📝 风格偏好: {val} (置信度:{conf:.0%})")
        elif pt == 'language':
            lines.append(f"  - 🌐 语言偏好: {val} (置信度:{conf:.0%})")
        else:
            lines.append(f"  - {pt}: {val} (置信度:{conf:.0%})")
    
    return '\n'.join(lines)


def create_preference_hook(agent):
    """
    创建偏好学习hook，注册到agent._turn_end_hooks
    """
    script_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    
    def _hook(locals_dict):
        """turn_end_callback中调用"""
        try:
            self_ref = locals_dict.get('self')
            if not self_ref: return
            
            history_info = getattr(self_ref, 'history_info', [])
            if not history_info: return
            
            # 从最近用户消息中提取偏好
            new_prefs = []
            
            # 扫描最近3条历史中的用户消息
            for line in history_info[-3:]:
                if line.startswith('[USER]'):
                    extracted = _extract_preferences_from_text(line)
                    new_prefs.extend(extracted)
            
            # 从工具失败模式推断
            implicit_prefs = _detect_tool_preferences(history_info)
            new_prefs.extend(implicit_prefs)
            
            if not new_prefs: return
            
            # 合并保存
            data = _load_preferences(script_dir)
            merged, new_count = _merge_preferences(data.get('preferences', []), new_prefs)
            data['preferences'] = merged
            
            if new_count > 0:
                _save_preferences(data, script_dir)

                # WS广播：通知前端Status Bar更新
                try:
                    parent = getattr(self_ref, 'parent', None)
                    dq = getattr(parent, '_current_display_queue', None) if parent else None
                    if dq:
                        dq.put({
                            'ws_type': 'preference',
                            'payload': {
                                'new_count': new_count,
                                'total': len(merged),
                                'latest': [p.get('key', '') for p in new_prefs[:3]]
                            }
                        })
                except Exception:
                    pass  # WS广播失败不影响主流程
                
        except Exception as e:
            try: print(f'[PreferenceLearner] Warning: {e}')
            except: pass
    
    if not hasattr(agent, '_turn_end_hooks'):
        agent._turn_end_hooks = {}
    agent._turn_end_hooks['preference_learner'] = _hook
    
    return _hook
