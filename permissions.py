"""Permission / safety gate for risky tool calls.

The agent calls `request_approval(tool_name, args, preview)` BEFORE executing a
risky tool. The IDE shows an approval card; the user can Approve, Reject, or
toggle "Bypass mode" (auto-approve everything for this session).

Risk levels
-----------
- ``safe``     : read-only, idempotent. Never gated. (file_read, web_scan, ...)
- ``caution``  : mutates user files but already shows a diff (file_write,
                  file_patch). Gated unless bypass is on.
- ``danger``   : arbitrary code/shell execution (code_run). Always gated unless
                  bypass is on.

Bypass mode
-----------
Frontend can flip a per-session flag via the ``set_bypass`` WS message. Backend
also reads a process-start env var ``GA_PERMISSION_BYPASS=1`` for headless / CI.

Fallbacks
---------
If the IDE is not connected (CLI / web-only), permission gating is skipped — the
agent runs as before. This preserves backward compatibility.
"""
from __future__ import annotations

import os
import threading
from typing import Any

import ide_bridge


# Per-process bypass state. Mutated by webapp.py on `set_bypass` WS messages.
_bypass_lock = threading.Lock()
_bypass: bool = os.environ.get('GA_PERMISSION_BYPASS', '') == '1'


RISK_SAFE = 'safe'
RISK_CAUTION = 'caution'
RISK_DANGER = 'danger'


# Static map: tool_name → risk level. Tools not listed default to 'caution'.
_RISK_TABLE: dict[str, str] = {
    # Read-only / inert
    'file_read': RISK_SAFE,
    'web_scan': RISK_SAFE,
    'ask_user': RISK_SAFE,
    'no_tool': RISK_SAFE,
    'update_working_checkpoint': RISK_SAFE,
    'start_long_term_update': RISK_SAFE,
    # Mutates files but user sees diff
    'file_write': RISK_CAUTION,
    'file_patch': RISK_CAUTION,
    'web_execute_js': RISK_CAUTION,
    # Arbitrary code execution
    'code_run': RISK_DANGER,
}


def set_bypass(enabled: bool) -> None:
    """Toggle bypass mode. Called by webapp.py on ``set_bypass`` WS message."""
    global _bypass
    with _bypass_lock:
        _bypass = bool(enabled)


def get_bypass() -> bool:
    with _bypass_lock:
        return _bypass


def risk_of(tool_name: str) -> str:
    return _RISK_TABLE.get(tool_name, RISK_CAUTION)


def request_approval(tool_name: str, args: dict[str, Any], preview: str = '',
                     timeout: float = 300.0) -> tuple[bool, str]:
    """Block until user approves / rejects.

    Returns ``(approved, reason)``. ``reason`` is a human-readable rejection
    message (empty when approved).

    Skips gating when:
      * bypass mode is on (returns ``(True, 'bypass')``)
      * tool is risk_safe
      * IDE is not connected (returns ``(True, 'no-ide')`` — preserves CLI behavior)
    """
    risk = risk_of(tool_name)
    if risk == RISK_SAFE:
        return True, 'safe'
    if get_bypass():
        return True, 'bypass'
    if not ide_bridge.is_ide_mode() or not ide_bridge.is_connected():
        return True, 'no-ide'

    # Truncate preview for UI sanity (full args still go through, but we cap
    # the human-readable preview).
    preview_text = (preview or _default_preview(tool_name, args))[:4000]

    resp = ide_bridge.request({
        'type': 'tool_approval_request',
        'payload': {
            'tool': tool_name,
            'risk': risk,
            'args': _sanitize_args(args),
            'preview': preview_text,
        },
    }, timeout=timeout)

    if resp is None:
        # No client / timeout. Fail closed for danger, fail open for caution.
        if risk == RISK_DANGER:
            return False, '审批超时或前端未响应（danger 默认拒绝）'
        return True, 'no-response-fallback'
    if resp.get('approved'):
        if resp.get('bypass_session'):
            set_bypass(True)
        return True, resp.get('reason') or 'approved'
    return False, resp.get('reason') or '用户拒绝执行'


def _default_preview(tool_name: str, args: dict[str, Any]) -> str:
    """Build a default human-readable preview of the action."""
    if tool_name == 'code_run':
        code = args.get('code') or args.get('script') or ''
        ctype = args.get('type') or 'python'
        cwd = args.get('cwd') or ''
        head = f'[{ctype}]' + (f' cwd={cwd}' if cwd else '')
        return head + '\n' + (code[:2000] if isinstance(code, str) else str(code))
    if tool_name == 'file_patch':
        return f"path: {args.get('path')}\n--- old ---\n{(args.get('old_content') or '')[:1500]}\n+++ new +++\n{(args.get('new_content') or '')[:1500]}"
    if tool_name == 'web_execute_js':
        return f"script:\n{(args.get('script') or '')[:2000]}"
    # Generic fallback
    import json as _json
    try:
        return _json.dumps(args, ensure_ascii=False, indent=2)[:2000]
    except Exception:
        return str(args)[:2000]


def _sanitize_args(args: dict[str, Any]) -> dict[str, Any]:
    """Strip internal-only keys so frontend doesn't see them."""
    return {k: v for k, v in args.items() if not k.startswith('_')}
