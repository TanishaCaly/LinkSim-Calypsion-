"""
WorkerPool — the Worker Controller's dispatch brain.

A Worker Controller does not do work itself: it maintains a pool of Workers,
tracks which are free/busy/off-shift, assigns one to a Workplace's request
(honouring its Assignment Strategy and travel time), queues or rejects a
request when no Worker can be freed, and releases the Worker back to the
pool when the job finishes. This is a genuinely different mechanism from
the older shift1/shift2/shift3 operator-assignment model (a single named
operator string statically tied to one station, gated purely by a
per-attempt Availability % roll — see SimulationUtils.operator_available):
here at most one Workplace can hold a given Worker at a time, and requests
from multiple Workplaces sharing a Controller genuinely contend for the
same pool.

Kept as its own module (not folded into machine.py) since a WorkerToken is a
plain data holder passed through a FilterStore, not a SimPy Resource itself.
"""
import logging
import random
import simpy
from datetime import datetime
from typing import Optional

logger = logging.getLogger("linksim.engine")


class WorkerToken:
    """One Worker's state as it's passed through a FilterStore. `last_workplace`
    is what makes reassignment "sticky" — a Worker staying at the same
    Workplace two jobs in a row pays no Travel Time the second time."""

    def __init__(self, name: str, availability: float, travel_time: float):
        self.name = name
        self.availability = availability
        self.travel_time = travel_time
        self.last_workplace: Optional[str] = None


class PoolRejected(Exception):
    """Raised by WorkerPool.acquire when the request is turned away outright
    (Queue Policy = reject and the queue is already at Max Queue Size) rather
    than being made to wait — a genuinely new terminal outcome for a job, on
    top of the existing Completed/In Progress (horizon-cut) ones."""


class WorkerPool:
    """
    One Worker Controller's dispatch pool. Wraps a simpy.FilterStore holding
    WorkerToken objects; every token also gets its own background process
    that models Availability % as random unavailability WHILE IDLE IN THE
    POOL. `checked_out` tracks which tokens are currently out at a Workplace
    (as opposed to just sitting in the store) so the unavailability process
    never tries to pull back a token that's actually busy working.

    strategy: "first_available" (default) lets SimPy's FilterStore hand back
    whichever qualifying Worker is free first; "round_robin" instead cycles
    through workers in a fixed order, skipping any not currently in the
    store, so dispatch load spreads evenly rather than favouring whichever
    Worker happens to free up fastest.
    """

    def __init__(
        self,
        env: simpy.Environment,
        name: str,
        workers: list[WorkerToken],
        strategy: str = "first_available",
        queue_policy: str = "queue",
        max_queue_size: Optional[int] = None,
        shift_start: Optional[float] = None,
        shift_end: Optional[float] = None,
        allow_overtime: bool = True,
        enabled: bool = True,
        use_travel_time: bool = True,
    ):
        self.env = env
        self.name = name
        self.store = simpy.FilterStore(env, capacity=max(1, len(workers)))
        self.workers = workers
        self.checked_out: set = set()
        self.strategy = strategy
        self.queue_policy = queue_policy
        self.max_queue_size = max_queue_size
        self.shift_start = shift_start
        self.shift_end = shift_end
        # V1 scope: allow_overtime is stored/reported but does not yet
        # interrupt a Worker mid-job at shift end — a Worker already
        # dispatched always finishes its current job regardless of this
        # flag. It only documents intent for now; Shift Start/End gates NEW
        # dispatch (see _on_shift), which is where the real effect is.
        self.allow_overtime = allow_overtime
        self.enabled = enabled
        self.use_travel_time = use_travel_time
        self._round_robin_cursor = 0

        # Stats (see get_stats) — wait_times/completed_jobs/rejected_jobs are
        # updated live by acquire()/release() and the caller; queue_length is
        # read directly at report time (len(self._queue)).
        self._queue: list = []
        self.wait_times: list[float] = []
        self.completed_jobs = 0
        self.rejected_jobs = 0

        for w in workers:
            self.store.items.append(w)
            if w.availability < 100:
                env.process(self._run_unavailability(w))

    # ------------------------------------------------------------------
    # Shift / enabled gating
    # ------------------------------------------------------------------

    def _on_shift(self) -> bool:
        """True if the Controller itself is currently allowed to dispatch —
        disabled, or outside its own optional shift window, means no Worker
        is dispatchable right now regardless of the pool's contents."""
        if not self.enabled:
            return False
        if self.shift_start is None or self.shift_end is None:
            return True
        hour = (self.env.now / 60.0) % 24.0
        if self.shift_start <= self.shift_end:
            return self.shift_start <= hour < self.shift_end
        return hour >= self.shift_start or hour < self.shift_end  # overnight window

    def _run_unavailability(self, worker: WorkerToken):
        """
        While `worker` is sitting free in the pool, it periodically goes
        briefly unavailable (removed from the store) at a rate implied by its
        Availability % — the lower the availability, the more often it's
        pulled away.
        """
        CHECK_INTERVAL = 60.0
        while True:
            yield self.env.timeout(CHECK_INTERVAL)
            if worker in self.checked_out:
                continue  # busy at a Workplace right now — not this process's concern
            if random.uniform(0, 100) <= worker.availability:
                continue
            yield self.store.get(lambda w: w is worker)
            away_for = random.uniform(10, 60)
            yield self.env.timeout(away_for)
            yield self.store.put(worker)

    # ------------------------------------------------------------------
    # Dispatch
    # ------------------------------------------------------------------

    def acquire(self, resource_name: str):
        """
        A generator step (`yield from` this): returns a WorkerToken assigned
        to `resource_name`, already removed from the store and marked
        checked-out — the caller must release() it back when the job at that
        Workplace finishes.

        Raises PoolRejected immediately (no waiting at all) if Queue Policy
        is "reject" and the Controller's queue is already at Max Queue Size
        — the caller is responsible for treating that as a lost job. Every
        other case waits (queues) until a Worker is free AND the Controller
        is on-shift, exactly like a plain FIFO/round-robin dispatch queue.
        """
        if self.queue_policy == "reject" and self.max_queue_size is not None and len(self._queue) >= self.max_queue_size:
            self.rejected_jobs += 1
            logger.info(
                "[worker_rejected] controller=%s resource=%s sim_t=%.2f real=%s queue_full=%d/%s",
                self.name, resource_name, self.env.now, datetime.now().isoformat(timespec="seconds"),
                len(self._queue), self.max_queue_size,
            )
            raise PoolRejected(f"Worker Controller '{self.name}' queue is full")

        request_id = object()
        self._queue.append(request_id)
        wait_start = self.env.now
        try:
            while True:
                if not self._on_shift():
                    # Off-shift is just another reason nothing is dispatchable
                    # right now — wait the same as an empty pool, checked
                    # again on a short timer rather than blocking on the
                    # store (which off-shift alone doesn't change).
                    yield self.env.timeout(10)
                    continue
                token = yield from self._acquire_one()
                break
        finally:
            self._queue.remove(request_id)
        wait_time = self.env.now - wait_start
        self.wait_times.append(wait_time)
        self.checked_out.add(token)
        logger.info(
            "[worker_dispatched] controller=%s worker=%s resource=%s sim_t=%.2f real=%s waited=%.2f",
            self.name, token.name, resource_name, self.env.now,
            datetime.now().isoformat(timespec="seconds"), wait_time,
        )
        return token

    def _acquire_one(self):
        if self.strategy == "round_robin" and self.workers:
            # Pick the target SYNCHRONOUSLY by inspecting store.items (a
            # plain list SimPy stores expose directly): FilterStore.get()
            # itself always returns the FIRST item in that list matching its
            # filter, so a single filter can't express "prefer whichever
            # rotation slot comes first" — checking store.items ourselves
            # and issuing exactly one get() for a confirmed-present token
            # avoids racing multiple get()/cancel() calls against each other
            # when several processes attempt this in the same instant.
            n = len(self.workers)
            for i in range(n):
                idx = (self._round_robin_cursor + i) % n
                candidate = self.workers[idx]
                if candidate in self.store.items:
                    self._round_robin_cursor = (idx + 1) % n
                    return (yield self.store.get(lambda w: w is candidate))
            # No rotation candidate is free right now — wait for the store
            # to change at all, then re-scan from scratch (do NOT consume
            # the item that triggered this: peek via a zero-effect get/put
            # round-trip so it stays available for whoever should actually
            # get it, including a rescan by this very call).
            woken = yield self.store.get(lambda w: True)
            yield self.store.put(woken)
            return (yield from self._acquire_one())
        token = yield self.store.get(lambda w: True)
        return token

    def release(self, token: WorkerToken, resource_name: str):
        """Return `token` to the pool, remembering where it was last used
        (so the NEXT acquirer pays Travel Time only if reassigned elsewhere),
        and count this as one more completed job dispatched by this pool."""
        token.last_workplace = resource_name
        self.checked_out.discard(token)
        self.completed_jobs += 1
        logger.info(
            "[worker_released] controller=%s worker=%s resource=%s sim_t=%.2f real=%s",
            self.name, token.name, resource_name, self.env.now,
            datetime.now().isoformat(timespec="seconds"),
        )
        yield self.store.put(token)

    def travel_time_for(self, token: WorkerToken, resource_name: str) -> float:
        """Minutes to charge for this dispatch — 0 if the Controller has
        travel time disabled, the Worker never left this Workplace, or this
        is its first ever assignment."""
        if not self.use_travel_time:
            return 0.0
        if token.last_workplace in (None, resource_name):
            return 0.0
        return token.travel_time

    # ------------------------------------------------------------------
    # Reporting
    # ------------------------------------------------------------------

    def get_stats(self) -> dict:
        busy = len(self.checked_out)
        total = len(self.workers)
        return {
            "workers_busy": busy,
            "workers_idle": max(0, total - busy),
            "queue_length": len(self._queue),
            "jobs_completed": self.completed_jobs,
            "jobs_rejected": self.rejected_jobs,
            "avg_wait_time": (sum(self.wait_times) / len(self.wait_times)) if self.wait_times else 0.0,
            "worker_utilization": (busy / total * 100.0) if total else 0.0,
        }
