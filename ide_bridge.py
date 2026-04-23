"""IDE bridge — synchronous request / async notify to a connected IDE client.

This module is the decoupling seam between agent tools (ga.py, etc.) and the
frontend transport (webapp.py's WebSocket).  Tools call `request(...)` /
`notify(...)` here; the transport layer wires itself in by calling
`register(send_fn)` once at startup.

This avoids a circular import (ga.py ← agentmain.py ← webapp.py) while still
allowing ga.py to consult IDE state via a stable API.

Protocol contract: see GenericCode/docs/protocol.md (proto v1).
"""
from __future__ import annotations

import os
import queue
import threading
import time
import uuid
from typing import Any, Callable, Optional


# A send function: accepts a full protocol envelope {type, id?, payload}.
# Returns the number of IDE-tagged clients the message was forwarded to.
SendFn = Callable[[dict], int]

_send_fn: Optional[SendFn] = None
_pending: dict[str, queue.Queue] = {}
_lock = threading.Lock()
_ctx_lock = threading.Lock()
_context: dict[str, Any] = {}
_context_ts: float = 0.0


def register(send_fn: SendFn) -> None:
    """Called once by the transport layer (webapp.py) at startup."""
    global _send_fn
    _send_fn = send_fn


def is_ide_mode() -> bool:
    """True iff the backend was spawned by the IDE (extension sets
    GA_IDE_MODE=1 in the child environment). Agents use this to decide
    whether to prefer IDE actions over direct side-effects."""
    return os.environ.get('GA_IDE_MODE') == '1'


def is_connected() -> bool:
    """True iff the transport is wired AND at least one IDE client is currently
    connected. We don't track connection count here; transport returns the
    number of receivers on each send, so callers should inspect that."""
    return _send_fn is not None


def request(msg: dict, timeout: float = 60.0) -> Optional[dict]:
    """Send *msg* to the IDE and block waiting for a matching-`id` response.

    Returns the response payload dict, or None if:
      * we're not in IDE mode,
      * no transport is registered,
      * no IDE client is connected (send returned 0),
      * the timeout elapsed with no response.

    Callers are expected to fall back to non-IDE behaviour when None is
    returned.  This is the load-bearing invariant that keeps the code correct
    in every deployment (CLI, webapp-only, Feishu bot, IDE).
    """
    if not is_ide_mode() or _send_fn is None:
        return None
    mid = msg.get('id') or str(uuid.uuid4())
    msg['id'] = mid
    q: queue.Queue = queue.Queue(1)
    with _lock:
        _pending[mid] = q
    try:
        try:
            sent = _send_fn(msg)
        except Exception as e:
            print(f'[ide_bridge] send failed: {e}')
            return None
        if not sent:
            return None
        try:
            return q.get(timeout=timeout)
        except queue.Empty:
            return None
    finally:
        with _lock:
            _pending.pop(mid, None)


def notify(msg: dict) -> int:
    """Fire-and-forget message to the IDE. Returns receiver count (0 if not
    in IDE mode / not connected)."""
    if not is_ide_mode() or _send_fn is None:
        return 0
    try:
        return _send_fn(msg) or 0
    except Exception as e:
        print(f'[ide_bridge] notify failed: {e}')
        return 0


def deliver_response(mid: str, payload: dict) -> bool:
    """Transport layer calls this when a response arrives on the WS.
    Returns True if there was a matching pending request."""
    if not mid:
        return False
    with _lock:
        q = _pending.get(mid)
    if not q:
        return False
    try:
        q.put_nowait(payload)
        return True
    except Exception:
        return False


def set_context(ctx: dict) -> None:
    """Cache the latest editor-side context pushed by the IDE. Tools may
    consult this via `get_context()` to implement @current-like semantics."""
    global _context_ts
    with _ctx_lock:
        _context.clear()
        _context.update(ctx or {})
        _context_ts = time.time()


def get_context() -> dict:
    """Return a shallow copy of the most recently pushed IDE context."""
    with _ctx_lock:
        return dict(_context)


def context_age_seconds() -> float:
    """Seconds since the last context push (math.inf if none)."""
    if not _context_ts:
        return float('inf')
    return time.time() - _context_ts
