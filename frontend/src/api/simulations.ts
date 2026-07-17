import api from './client'
import type { RunResponse, RunDetail } from '../types'

export interface SimConfigOverride {
  SIM_TIME?: number
  WARMUP_TIME?: number
  SHIFT_DURATION?: number
  num_replications?: number
  [key: string]: unknown
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

  listRuns: (scenarioId: number) =>
    api.get<RunDetail[]>(`/simulations/${scenarioId}/runs`).then(r => r.data),

  streamUrl: (runId: number) =>
    `/api/simulations/${runId}/stream`,
}
