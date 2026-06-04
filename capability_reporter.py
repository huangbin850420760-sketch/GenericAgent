"""
T4.3.1: Capability Reporter - Scans and reports GA's available capabilities.
Called at startup and on-demand via WS command.
Returns structured report: tools, MCP, SOPs, devices, memory layers.
"""
import os
import json
import glob

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def scan_tools():
    """Scan built-in tools from tools_schema.json."""
    suffix = '_en' if os.environ.get('GA_LANG', '') == 'en' else ''
    schema_path = os.path.join(_SCRIPT_DIR, f'assets/tools_schema{suffix}.json')
    tools = []
    try:
        with open(schema_path, 'r', encoding='utf-8') as f:
            schema = json.load(f)
        for t in schema:
            fn = t.get('function', {})
            tools.append({
                'name': fn.get('name', ''),
                'description': (fn.get('description', '') or '')[:80],
            })
    except Exception as e:
        tools.append({'name': 'error', 'description': str(e)})
    return tools


def scan_mcp():
    """Scan connected MCP servers and their tools."""
    result = {'servers': [], 'tools_count': 0, 'tool_names': []}
    try:
        from mcp_client import MCPClientManager
        config_path = os.path.join(_SCRIPT_DIR, 'config/mcp_servers.json')
        if os.path.exists(config_path):
            with open(config_path, 'r', encoding='utf-8') as f:
                cfg = json.load(f)
            result['servers'] = list(cfg.get('mcpServers', {}).keys())
        # Try to get live tools from existing manager
        try:
            from agentmain import _mcp_mgr
            mgr = _mcp_mgr
            if mgr:
                flat = mgr.get_flat_tools()
                result['tools_count'] = len(flat)
                result['tool_names'] = [t.get('name', '') for t in flat[:50]]
        except ImportError:
            pass
    except Exception as e:
        result['error'] = str(e)
    return result


def scan_sops():
    """Scan available SOP files in memory directory."""
    sops = []
    mem_dir = os.path.join(_SCRIPT_DIR, 'memory')
    if os.path.isdir(mem_dir):
        for f in sorted(glob.glob(os.path.join(mem_dir, '*.md')) + 
                       glob.glob(os.path.join(mem_dir, '*.py'))):
            name = os.path.basename(f)
            size = os.path.getsize(f)
            sops.append({'name': name, 'size': size})
    return sops


def scan_devices():
    """Scan connected devices (ADB)."""
    devices = []
    try:
        import subprocess
        r = subprocess.run(['adb', 'devices'], capture_output=True, text=True, timeout=5)
        if r.returncode == 0:
            for line in r.stdout.strip().split('\n')[1:]:
                if '\tdevice' in line:
                    devices.append({'id': line.split('\t')[0], 'type': 'android'})
    except Exception:
        pass
    return devices


def scan_memory():
    """Scan memory layers and their sizes."""
    layers = []
    # L0: META-SOP
    meta = os.path.join(_SCRIPT_DIR, 'memory/memory_management_sop.md')
    if os.path.exists(meta):
        layers.append({'layer': 'L0', 'name': 'META-SOP', 'size': os.path.getsize(meta)})
    # L1: Insight
    insight = os.path.join(_SCRIPT_DIR, 'memory/global_mem_insight.txt')
    if os.path.exists(insight):
        layers.append({'layer': 'L1', 'name': 'Insight', 'size': os.path.getsize(insight)})
    # L2: Global Memory
    gm = os.path.join(_SCRIPT_DIR, 'memory/global_mem.txt')
    if os.path.exists(gm):
        layers.append({'layer': 'L2', 'name': 'Global Memory', 'size': os.path.getsize(gm)})
    # L3: SOPs
    mem_dir = os.path.join(_SCRIPT_DIR, 'memory')
    sop_files = glob.glob(os.path.join(mem_dir, '*.md')) + glob.glob(os.path.join(mem_dir, '*.py'))
    sop_size = sum(os.path.getsize(f) for f in sop_files) if sop_files else 0
    layers.append({'layer': 'L3', 'name': 'SOPs', 'count': len(sop_files), 'size': sop_size})
    # L4: Raw sessions
    l4_dir = os.path.join(mem_dir, 'L4_raw_sessions')
    if os.path.isdir(l4_dir):
        l4_files = glob.glob(os.path.join(l4_dir, '*'))
        layers.append({'layer': 'L4', 'name': 'Raw Sessions', 'count': len(l4_files)})
    return layers


def get_capability_report():
    """Generate full capability report."""
    tools = scan_tools()
    mcp = scan_mcp()
    sops = scan_sops()
    devices = scan_devices()
    memory = scan_memory()
    
    # Summary for system prompt injection
    summary = (
        f"[My Capabilities] "
        f"Tools: {len(tools)} built-in | "
        f"MCP: {mcp['tools_count']} tools across {len(mcp['servers'])} servers | "
        f"SOPs: {len(sops)} files | "
        f"Devices: {len(devices)} connected | "
        f"Memory: {len(memory)} layers"
    )
    
    return {
        'tools': tools,
        'tools_count': len(tools),
        'mcp': mcp,
        'sops': sops,
        'sops_count': len(sops),
        'devices': devices,
        'devices_count': len(devices),
        'memory_layers': memory,
        'memory_layers_count': len(memory),
        'summary': summary,
    }


def get_capability_summary_text():
    """Return one-line capability summary for system prompt."""
    return get_capability_report()['summary']


if __name__ == '__main__':
    import json
    report = get_capability_report()
    print(json.dumps(report, indent=2, ensure_ascii=False))
