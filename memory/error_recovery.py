"""
Error Recovery Strategy - 错误恢复策略自动注入器
T1.4 错误恢复：从历史错误经验中生成策略，注入system_prompt
设计原则：基于experience.json中的错误模式，生成上下文感知的恢复提示
"""
import os, json, re
from datetime import datetime
from collections import Counter

_ERROR_PATTERNS = {
    # 文件操作错误
    r'FileNotFoundError|文件不存在|No such file': {
        'strategy': '文件操作前先检查os.path.exists()，使用try/except包裹',
        'category': 'file_op',
    },
    # 权限错误
    r'PermissionError|权限|Access denied|access denied': {
        'strategy': '遇到权限问题时，尝试以管理员权限运行或更换目标路径',
        'category': 'permission',
    },
    # 编码错误
    r'UnicodeDecodeError|UnicodeEncodeError|编码|encoding|codec': {
        'strategy': '文件读写始终指定encoding="utf-8"，遇到异常用errors="replace"降级',
        'category': 'encoding',
    },
    # 网络错误
    r'ConnectionError|Timeout|timeout|连接|网络|Network': {
        'strategy': '网络请求使用retry机制(最多3次)，设置合理timeout(30s)',
        'category': 'network',
    },
    # JSON解析错误
    r'JSONDecodeError|json.*decode|解析.*失败': {
        'strategy': '解析JSON前先检查文件非空，使用try/except并回退到默认值',
        'category': 'json_parse',
    },
    # 进程错误
    r'ProcessLookupError|进程.*不存在|PID': {
        'strategy': '操作进程前先psutil.pid_exists()确认，避免kill不存在的进程',
        'category': 'process',
    },
    # Web错误
    r'WebDriverException|selenium|driver.*null|浏览器.*未初始化': {
        'strategy': '使用web工具前先检查driver状态，None时重新初始化',
        'category': 'web',
    },
    # COM错误
    r'CO_E_NOTINITIALIZED|CoInitialize|COM': {
        'strategy': 'ctypes COM操作前必须先ole32.CoInitializeEx',
        'category': 'com',
    },
}

# 最近N条错误记录用于分析
_RECENT_ERROR_WINDOW = 50


def _load_experiences(script_dir):
    """加载经验文件中的错误记录"""
    exp_path = os.path.join(script_dir, 'temp', 'experience.json')
    if not os.path.exists(exp_path):
        return []
    try:
        with open(exp_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        # 只取失败的记录
        return [e for e in data.get('experiences', []) if e.get('success') is False]
    except (json.JSONDecodeError, IOError):
        return []


def _analyze_error_patterns(error_experiences):
    """
    分析错误经验，返回高频错误模式及对应策略
    Returns: list of {pattern, count, strategy, category}
    """
    category_errors = Counter()
    recent_errors = []
    
    for exp in error_experiences[-_RECENT_ERROR_WINDOW:]:
        error_msg = exp.get('error', '') or exp.get('summary', '')
        if not error_msg:
            continue
        recent_errors.append(error_msg)
        
        # 匹配错误模式
        for pattern, info in _ERROR_PATTERNS.items():
            if re.search(pattern, error_msg, re.IGNORECASE):
                category_errors[info['category']] += 1
    
    # 只返回出现>=2次的模式
    strategies = []
    seen = set()
    for category, count in category_errors.most_common(5):
        if count >= 2:
            for info in _ERROR_PATTERNS.values():
                if info['category'] == category and category not in seen:
                    strategies.append({
                        'category': category,
                        'count': count,
                        'strategy': info['strategy'],
                    })
                    seen.add(category)
    
    return strategies


def _build_error_recovery_prompt(script_dir):
    """
    构建错误恢复策略提示，供get_system_prompt调用
    Returns: str (空字符串或策略文本)
    """
    errors = _load_experiences(script_dir)
    if not errors:
        return ""
    
    strategies = _analyze_error_patterns(errors)
    if not strategies:
        return ""
    
    lines = ["\n[Error Recovery Strategy] 基于历史错误经验的注意事项："]
    for s in strategies[:5]:
        lines.append(f"  - [{s['category']}] ({s['count']}次历史错误) → {s['strategy']}")
    
    return '\n'.join(lines) + '\n'


def inject_error_recovery(prompt, script_dir):
    """
    注入错误恢复策略到prompt中
    供turn_end_callback调用
    """
    recovery_text = _build_error_recovery_prompt(script_dir)
    if recovery_text:
        prompt += recovery_text
    return prompt


def record_error(tool_name, error_msg, script_dir):
    """
    T1.3.2: 记录工具调用错误到experience.json
    在turn_end_callback中检测到tool_result含错误时调用
    """
    if not error_msg or not tool_name:
        return
    # 检查是否匹配已知错误模式
    matched = False
    for pattern, info in _ERROR_PATTERNS.items():
        if re.search(pattern, error_msg, re.IGNORECASE):
            matched = True
            break
    if not matched:
        return  # 只记录已知模式的错误
    
    exp_path = os.path.join(script_dir, 'temp', 'experience.json')
    try:
        data = {'experiences': []}
        if os.path.exists(exp_path):
            with open(exp_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
        
        # 添加错误记录
        data.setdefault('experiences', []).append({
            'type': 'error_recovery',
            'tool': tool_name,
            'error': error_msg[:200],
            'category': info.get('category', 'unknown'),
            'strategy': info.get('strategy', ''),
            'success': False,
            'timestamp': datetime.now().isoformat(),
        })
        
        # 只保留最近100条
        if len(data['experiences']) > 100:
            data['experiences'] = data['experiences'][-100:]
        
        with open(exp_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except (json.JSONDecodeError, IOError) as e:
        print(f'[error_recovery] record_error failed: {e}')
