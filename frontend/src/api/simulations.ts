import api, { getToken } from './client'
import type { RunResponse, RunDetail } from '../types'

export interface SimConfigOverride {
  SIM_TIME?: number
  WARMUP_TIME?: number
  SHIFT_DURATION?: number
  num_replications?: number
  // ISO datetime string (e.g. "2026-07-25T06:00:00") — the real calendar
  // date/time the simulation clock starts at. Anchors WORKING_DAYS_n
  // weekday logic to actual calendar weekdays. Set via the Simulation
  // Timer button; falls back to the engine's default when unset.
  SIMULATION_START_DATE?: string
  // Purely cosmetic display names (e.g. "Morning" instead of "Shift 1"),
  // sent through as inert extra keys — the engine still keys everything by
  // shift number (SHIFT_1_START, WORKING_DAYS_1, BREAKS_1, ...) underneath.
  SHIFT_1_NAME?: string
  SHIFT_2_NAME?: string
  SHIFT_3_NAME?: string
  // PDF section 13's reliability panel: undefined/omitted = "Auto" (every
  // run's failure/repair timing is genuinely random, today's existing
  // behavior). An explicit integer makes a run's random draws (failure
  // timing, repair timing, etc. — see backend/engine/sim_core.py's run())
  // reproducible across repeated runs of the same scenario.
  RANDOM_SEED?: number
  [key: string]: unknown
}

/** Simulation time a run starts with: 8 hours (minutes). */
export const DEFAULT_SIM_TIME = 480

/** Every day of the week (Monday=0 ... Sunday=6, as the engine counts). */
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]

/** Saved into every NEW scenario (Workspace save or file import, unless the
 * file sets them): each shift works every day, with no break. Older
 * scenarios without these keys keep the engine's old defaults (Mon-Fri for
 * Shift 1/2, a 30-min break per shift), so their results don't change. */
export const NEW_SCENARIO_CALENDAR: SimConfigOverride = {
  WORKING_DAYS_1: ALL_DAYS, WORKING_DAYS_2: ALL_DAYS, WORKING_DAYS_3: ALL_DAYS,
  BREAKS_1: [], BREAKS_2: [], BREAKS_3: [],
}

export const simulationsApi = {
  triggerRun: (scenarioId: number, overrides: SimConfigOverride = {}) => {
    const { num_replications = 1, ...sim_config_override } = overrides
    return api
      .post<RunResponse>(`/simulations/${scenarioId}/run`, {
        num_replications,
        sim_config_override,
      })
      .then(r => r.data)
  },

  getRun: (runId: number) =>
    api.get<RunDetail>(`/simulations/runs/${runId}`).then(r => r.data),

  stopRun: (runId: number) =>
    api.post(`/simulations/${runId}/stop`).then(r => r.data),

  listRuns: (scenarioId: number) =>
    api.get<RunDetail[]>(`/simulations/${scenarioId}/runs`).then(r => r.data),

  // The browser's live-progress connection (EventSource) can't send the
  // sign-in header, so the session token goes in the address instead.
  streamUrl: (runId: number) =>
    `/api/simulations/${runId}/stream?token=${encodeURIComponent(getToken() ?? '')}`,
}
