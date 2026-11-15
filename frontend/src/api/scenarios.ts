import api from './client'
import type { Scenario, ScenarioCreate, ScenarioListItem, UploadResponse } from '../types'
import { NEW_SCENARIO_CALENDAR } from './simulations'

export const scenariosApi = {
  list: (skip = 0, limit = 50) =>
    api.get<ScenarioListItem[]>('/scenarios/', { params: { skip, limit } }).then(r => r.data),

  count: () => api.get<{ count: number }>('/scenarios/count').then(r => r.data.count),

  get: (id: number) => api.get<Scenario>(`/scenarios/${id}`).then(r => r.data),

  create: (payload: ScenarioCreate) =>
    api.post<Scenario>('/scenarios/', payload).then(r => r.data),

  update: (id: number, payload: Partial<ScenarioCreate>) =>
    api.patch<Scenario>(`/scenarios/${id}`, payload).then(r => r.data),

  delete: (id: number) => api.delete(`/scenarios/${id}`),

  /** Do the process-flow steps name real stations? (checks the saved scenario) */
  validate: (id: number) =>
    api.get<{ issue_count: number; issues: { variant: string; operation?: string; resource: string; resolved_to: string | null; type: 'case_mismatch' | 'missing' }[] }>(`/scenarios/${id}/validate`).then(r => r.data),

  /** Parse a .yaml or .xlsx file — returns parsed data only, does NOT save */
  parseFile: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return api
      .post<UploadResponse>('/upload/scenario', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then(r => r.data)
  },

  /** Parse a flat routing CSV — returns parsed data only, does NOT save */
  parseFlatCsv: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return api
      .post<UploadResponse>('/upload/flat-csv', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then(r => r.data)
  },

  /** Parse 4 separate CSV files — returns parsed data only, does NOT save */
  parseCsvBundle: (files: {
    stations: File
    operators: File
    processflow: File
    quantities: File
  }) => {
    const form = new FormData()
    // Field names must match FastAPI parameter names (no _file suffix)
    form.append('stations', files.stations)
    form.append('operators', files.operators)
    form.append('processflow', files.processflow)
    form.append('quantities', files.quantities)
    return api
      .post<UploadResponse>('/upload/csv-bundle', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then(r => r.data)
  },

  /**
   * Full import: parse file then save as a named scenario (with raw file stored).
   */
  importFile: async (file: File, name: string): Promise<Scenario> => {
    const [parsed, fileBytes] = await Promise.all([
      scenariosApi.parseFile(file),
      file.arrayBuffer().then(b => Array.from(new Uint8Array(b))),
    ])
    return scenariosApi.create({
      name,
      stations_data: parsed.stations,
      processflow_data: parsed.processflow,
      variant_quantities: parsed.variant_quantities,
      variant_intervals: parsed.variant_intervals ?? {},
      setup_matrix: parsed.setup_matrix ?? {},
      operators_data: parsed.operators,
      simulation_config: { ...NEW_SCENARIO_CALENDAR, ...(parsed.simulation_config ?? {}) },
      source_filename: file.name,
      source_file: fileBytes,
    } as any)
  },

  importFlatCsv: async (file: File, name: string): Promise<Scenario> => {
    const [parsed, fileBytes] = await Promise.all([
      scenariosApi.parseFlatCsv(file),
      file.arrayBuffer().then(b => Array.from(new Uint8Array(b))),
    ])
    return scenariosApi.create({
      name,
      stations_data: parsed.stations,
      processflow_data: parsed.processflow,
      variant_quantities: parsed.variant_quantities,
      variant_intervals: parsed.variant_intervals ?? {},
      setup_matrix: parsed.setup_matrix ?? {},
      operators_data: parsed.operators,
      simulation_config: { ...NEW_SCENARIO_CALENDAR, ...(parsed.simulation_config ?? {}) },
      source_filename: file.name,
      source_file: fileBytes,
    } as any)
  },

  importCsvBundle: async (
    files: { stations: File; operators: File; processflow: File; quantities: File },
    name: string,
  ): Promise<Scenario> => {
    const parsed = await scenariosApi.parseCsvBundle(files)
    // bundle: zip all 4 files into a single JSON blob for storage
    const readBytes = (f: File) => f.arrayBuffer().then(b => Array.from(new Uint8Array(b)))
    const [sb, ob, pb, qb] = await Promise.all([
      readBytes(files.stations), readBytes(files.operators),
      readBytes(files.processflow), readBytes(files.quantities),
    ])
    const bundleJson = JSON.stringify({
      stations: { name: files.stations.name, data: sb },
      operators: { name: files.operators.name, data: ob },
      processflow: { name: files.processflow.name, data: pb },
      quantities: { name: files.quantities.name, data: qb },
    })
    const bundleBytes = Array.from(new TextEncoder().encode(bundleJson))
    return scenariosApi.create({
      name,
      stations_data: parsed.stations,
      processflow_data: parsed.processflow,
      variant_quantities: parsed.variant_quantities,
      operators_data: parsed.operators,
      simulation_config: { ...NEW_SCENARIO_CALENDAR, ...(parsed.simulation_config ?? {}) },
      source_filename: `${name}_bundle.json`,
      source_file: bundleBytes,
    } as any)
  },

  /** Download the original source file for a scenario */
  downloadFile: (id: number) =>
    api.get(`/scenarios/${id}/file`, { responseType: 'blob' }).then(r => r.data as Blob),

  /** Check if a scenario has a source file stored */
  hasFile: (id: number) =>
    api.get(`/scenarios/${id}/file`, { responseType: 'blob' })
      .then(() => true)
      .catch(() => false),
}
