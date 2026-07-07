"""
Thread-safe per-run progress event store.

The simulation engine runs in a BackgroundTask thread and pushes events here.
The SSE endpoint (async) reads events by offset without blocking.
"""
import threading
from typing import Any, Dict, List

_store: Dict[int, List[Dict[str, Any]]] = {}
_locks: Dict[int, threading.Lock] = {}


def init(run_id: int) -> None:
    """Call before starting a run to initialise its event buffer."""
    _store[run_id] = []
    _locks[run_id] = threading.Lock()


def push(run_id: int, event: Dict[str, Any]) -> None:
    """Append an event dict from the simulation thread."""
    lock = _locks.get(run_id)
    if lock is None:
        return
    with lock:
        _store[run_id].append(event)


def get(run_id: int, offset: int = 0) -> List[Dict[str, Any]]:
    """Return all events after *offset* (non-blocking snapshot)."""
    lock = _locks.get(run_id)
    if lock is None:
        return []
    with lock:
        return list(_store[run_id][offset:])


def cleanup(run_id: int) -> None:
    """Free memory after the SSE client disconnects."""
    _store.pop(run_id, None)
    _locks.pop(run_id, None)
