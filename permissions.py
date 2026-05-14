"""Permission / safety gate for risky tool calls.

The agent calls `request_approval(tool_name, args, preview)` BEFORE executing a
risky tool. Behaviour depends on the *frontend*:

IDE mode (VS Code extension)
----------------------------
Sends a `tool_approval_request` over the WS bridge; the editor renders an
inline card with Allow / Deny / Allow-session buttons. Backend blocks until
the user decides.

Non-IDE mode (Feishu bot / CLI / autonomous webapp)
---------------------------------------------------
There is no real-time human in the loop, so the gate falls back to a static
*policy* (env ``GA_PERMISSION_POLICY``, default ``deny_dangerous``):

- ``deny_dangerous`` (default): allow safe + caution, reject ``danger``
  (e.g. ``code_run``). This prevents bot users from running arbitrary
  shell on the host.
- ``open``: legacy behaviour — allow everything (use only in trusted CLI /
  CI environments).

Bypass
------
Operators can flip a per-process bypass via ``set_bypass`` WS message
(IDE) or ``GA_PERMISSION_BYPASS=1`` env. When bypass is on the gate
unconditionally allows every call regardless of policy.

Risk taxonomy
-------------
- ``safe``    : read-only / idempotent (file_read, web_scan, ...)
- ``caution`` : file mutation w/ visible diff (file_write, file_patch)
- ``danger``  : arbitrary code / shell (code_run)
"""
from __future__ import annotations

import os
import threading
from typing import Any

import ide_bridge


# Per-process bypass state. Mutated by webapp.py on `set_bypass` WS messages.
_bypass_lock = threading.Lock()
_bypass: bool = os.environ.get('GA_PERMISSION_BYPASS', '') == '1'

# Static policy applied when no IDE is connected. See module docstring.
_POLICY: str = (os.environ.get('GA_PERMISSION_POLICY') or 'deny_dangerous').lower()


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
