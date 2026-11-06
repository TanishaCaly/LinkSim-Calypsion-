import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { simulationsApi } from '@/api/simulations'
import type { SimConfigOverride } from '@/api/simulations'
import { scenariosApi } from '@/api/scenarios'
import { useAppStore } from '@/store/useAppStore'
import type { RunProgress } from '@/components/run/SimDialogs'
import type { RunDetail, SimConfig } from '@/types'

/**
 * Everything about running a simulation for the open scenario, in one place so
 * the Analysis page and the Workspace run bar behave identically: the run
 * settings (and saving them onto the scenario), starting a run, its live
 * progress over the event stream, Stop, Reset, and which run is on screen.
 * Moved here unchanged from RunDashboard.
 */
export function useRunSimulation() {
  const { activeScenario, activeRun, setActiveRun, setActiveScenario, showToast, justReset, setJustReset } = useAppStore()
  const [displayRun, setDisplayRun] = useState<RunDetail | null>(activeRun)
  const [simCfg, setSimCfg] = useState<SimConfigOverride>({ SIM_TIME: 10080, num_replications: 1 })

  // Load whatever shift hours/working-days/breaks/names were last saved on
  // THIS scenario (e.g. from a previous Simulation Config session), instead
  // of always starting from the bare SIM_TIME/num_replications default —
  // otherwise reopening Simulation Config for a scenario with custom shift
  // names would show the generic "Shift 1/2/3" until re-typed.
  useEffect(() => {
    if (!activeScenario) return
    setSimCfg(cfg => ({ ...(activeScenario.simulation_config as unknown as SimConfigOverride ?? {}), ...cfg, SIM_TIME: cfg.SIM_TIME, num_replications: cfg.num_replications }))
  }, [activeScenario?.id])

  // Persist shift hours/working-days/breaks/names (and anything else in
  // Simulation Config) onto the scenario record itself, not just this
  // session's next-run override — so a rename made here is visible
  // everywhere the name is shown, including the Canvas Build panel, and
  // survives a reload/navigation instead of vanishing after one run.
  const persistSimConfig = async (next: SimConfigOverride) => {
    setSimCfg(next)
    if (!activeScenario) return
    try {
      const updated = await scenariosApi.update(activeScenario.id, {
        simulation_config: { ...(activeScenario.simulation_config ?? {}), ...next } as Partial<SimConfig>,
      })
      setActiveScenario(updated)
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to save simulation config', 'error')
    }
  }

  // Whenever the active scenario changes, load THAT scenario's own latest run
  // (or clear the display entirely if it has none) — otherwise the previously
  // viewed scenario's run stays on screen after switching scenarios.
  //
  // Skipped while justReset is set: this effect also re-fires on every fresh
  // mount of this page (not just on an actual scenario switch), since
  // activeScenario?.id is unchanged but the component itself is new — e.g.
  // navigating to View Flow and back to /run. Without this guard, Reset's
  // cleared KPIs would silently get re-populated a few seconds later once
  // this effect's fetch of "the scenario's latest run" resolved, since Reset
  // doesn't delete anything server-side — it only clears local state.
  useEffect(() => {
    if (justReset) return
    if (!activeScenario) { setDisplayRun(null); setActiveRun(null); return }
    let cancelled = false
    simulationsApi.listRuns(activeScenario.id).then((runs) => {
      if (cancelled) return
      if (runs.length === 0) { setDisplayRun(null); setActiveRun(null); return }
      // listRuns only returns lightweight KPI fields (no station_stats/result)
      // — fetch the full detail for the latest run so the dashboard shows
      // complete KPIs, station utilization, and timeline immediately.
      simulationsApi.getRun(runs[0].id).then((detail) => {
        if (cancelled) return
        setDisplayRun(detail)
        setActiveRun(detail)
      })
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScenario?.id, justReset])

  const [progress, setProgress] = useState<RunProgress | null>(null)
  const esRef = useRef<EventSource | null>(null)
  // The run currently being streamed — the Stop button needs this id to
  // call stopRun(), and there's no other single place holding "the run
  // that's actively in progress right now" (activeRun/displayRun can also
  // point at a past, already-finished run selected from history).
  const runningRunIdRef = useRef<number | null>(null)
  // Bumped on every Reset click. In-flight async callbacks from a run that
  // was triggered before Reset (the SSE "done" handler, its onerror poll
  // retry, and the mutation's safety-net setTimeout below) capture the
  // token at schedule time and skip their setDisplayRun/setActiveRun calls
  // if it's gone stale — otherwise Reset only clears state for a moment
  // before one of these delayed callbacks quietly repopulates it (KPIs
  // looked reset, but View Flow's run overlay came back once the run's
  // "done" event or safety-net poll landed after the click).
  const resetTokenRef = useRef(0)

  const stopStream = () => {
    if (esRef.current) { esRef.current.close(); esRef.current = null }
  }

  const startStream = (runId: number) => {
    stopStream()
    runningRunIdRef.current = runId
    const token = resetTokenRef.current
    const url = simulationsApi.streamUrl(runId)
    const es = new EventSource(url)
    esRef.current = es

    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data)
        if (evt.type === 'progress') {
          if (token !== resetTokenRef.current) return
          setProgress({ pct: evt.pct, msg: evt.msg, simTimeNow: evt.sim_time_now, simTimeTotal: evt.sim_time_total })
        } else if (evt.type === 'done' || evt.type === 'error') {
          runningRunIdRef.current = null
          if (token !== resetTokenRef.current) { stopStream(); return }
          setProgress(null)
          stopStream()
          // Fetch final run detail
          simulationsApi.getRun(runId).then((detail) => {
            if (token !== resetTokenRef.current) return
            setDisplayRun(detail)
            setActiveRun(detail)
            showToast(
              detail.status === 'completed'
                ? `Run #${runId} completed — ${detail.completed_jobs} jobs`
                : `Run #${runId} failed`,
              detail.status === 'completed' ? 'success' : 'error'
            )
          })
        }
      } catch { /* ignore */ }
    }

    es.onerror = () => {
      // SSE closed or server gone; fallback: poll once
      stopStream()
      if (token !== resetTokenRef.current) return
      simulationsApi.getRun(runId).then((detail) => {
        if (token !== resetTokenRef.current) return
        // Whatever the run's actual status, the live stream is gone — never
        // leave the "Queued…" banner stuck on screen after this point. A
        // fast-completing run can finish (and its progress_store entry get
        // cleaned up) before the EventSource even finishes connecting, so
        // "running" here just means "poll again shortly", not "keep waiting".
        setProgress(null)
        setDisplayRun(detail)
        setActiveRun(detail)
        if (detail.status === 'running') {
          setTimeout(() => startStream(runId), 500)
        }
      })
    }
  }

  const triggerMutation = useMutation({
    // Accepts an explicit config override so callers that just updated
    // simCfg (e.g. "Apply & Run" in the Simulation Timer) can pass the new
    // value directly, instead of racing React's async state update by
    // reading simCfg from closure right after calling its setter.
    mutationFn: (overrideCfg?: SimConfigOverride) => simulationsApi.triggerRun(activeScenario!.id, overrideCfg ?? simCfg),
    onSuccess: (data) => {
      showToast('Simulation started')
      setProgress({ pct: 0, msg: 'Queued…' })
      setJustReset(false)
      startStream(data.id)
      const token = resetTokenRef.current
      // Safety net: a small/fast scenario can finish (and its progress_store
      // entry get cleaned up) before the EventSource even finishes
      // connecting, so the "done" SSE event is never seen and the banner
      // gets stuck at "Queued…" forever. Back this up with a direct poll —
      // if the run is already done by the time this fires, clear the
      // banner and show the result even if SSE missed it.
      setTimeout(() => {
        if (token !== resetTokenRef.current) return
        simulationsApi.getRun(data.id).then((detail) => {
          if (token !== resetTokenRef.current) return
          if (detail.status !== 'running' && detail.status !== 'pending') {
            stopStream()
            setProgress(null)
            setDisplayRun(detail)
            setActiveRun(detail)
          }
        })
      }, 1500)
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  })

  const stopMutation = useMutation({
    mutationFn: (runId: number) => simulationsApi.stopRun(runId),
    onSuccess: () => showToast('Stop requested — finishing current step…'),
    onError: (err: Error) => showToast(err.message, 'error'),
  })

  useEffect(() => { return stopStream }, [])

  /** Start a run (optionally with a settings override that was just edited). */
  const start = (overrideCfg?: SimConfigOverride) => triggerMutation.mutate(overrideCfg)

  /** Ask the engine to stop the run that is streaming (or the one on screen). */
  const stop = () => {
    const runId = runningRunIdRef.current ?? displayRun?.id
    if (runId != null) stopMutation.mutate(runId)
  }

  /** Clear the run — KPIs go to 0 and View Flow opens a blank Build canvas. */
  const reset = () => {
    resetTokenRef.current += 1
    stopStream()
    setProgress(null)
    setDisplayRun(null)
    setActiveRun(null)
    setJustReset(true)
    setSimCfg({ SIM_TIME: 10080, num_replications: 1 })
    showToast('Reset — showing no run')
  }

  /**
   * Switch to a different run (e.g. an older completed one). Never leaves a
   * previous run's "Queued…" banner or stream connection alive on screen.
   */
  const showRun = (r: RunDetail) => {
    stopStream()
    setProgress(null)
    setDisplayRun(r)
    setActiveRun(r)
    setJustReset(false)
  }

  return {
    displayRun,
    simCfg,
    setSimCfg,
    persistSimConfig,
    progress,
    isRunning: !!progress || triggerMutation.isPending,
    start,
    stop,
    canStop: !(runningRunIdRef.current == null && displayRun?.id == null),
    stopPending: stopMutation.isPending,
    reset,
    showRun,
    stopStream,
  }
}
