import api from './client'
import type { InsightsResponse } from '../types'

export const insightsApi = {
  get: (runId: number) =>
    api.get<InsightsResponse>(`/insights/${runId}`).then(r => r.data),
}
