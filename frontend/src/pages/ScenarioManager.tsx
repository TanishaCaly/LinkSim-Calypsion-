import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Plus, Upload, Trash2, Play, FileText, Clock, Eye, X, Save, PlusCircle } from 'lucide-react'
import { scenariosApi } from '@/api/scenarios'
import { useAppStore } from '@/store/useAppStore'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { formatDate } from '@/lib/utils'
import type { Scenario, ScenarioListItem } from '@/types'

// ─── Upload dialog ────────────────────────────────────────────────────────────

type UploadMode = 'single' | 'flat' | 'csv'

function stemName(file: File | null): string {
  if (!file) return ''
  return file.name.replace(/\.[^.]+$/, '')
}

function formatStepResource(resource: unknown): string {
  if (typeof resource === 'string') return resource
  if (resource && typeof resource === 'object') {
    const r = resource as { mode?: string; options?: string[] }
    const options = r.options?.join(' / ') ?? ''
    return `${options} (${r.mode ?? 'routing'})`
  }
  return ''
}

function UploadDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<UploadMode>('single')

  // single / flat mode
  const [singleFile, setSingleFile] = useState<File | null>(null)
  const [singleName, setSingleName] = useState('')

  // flat CSV mode
  const [flatFile, setFlatFile] = useState<File | null>(null)
  const [flatName, setFlatName] = useState('')

  // csv bundle mode
  const [csvFiles, setCsvFiles] = useState<Record<string, File | null>>({
    stations: null, operators: null, processflow: null, quantities: null,
  })
  const [csvName, setCsvName] = useState('')

  const queryClient = useQueryClient()
  const { showToast } = useAppStore()

  const onImported = (name: string) => {
    queryClient.invalidateQueries({ queryKey: ['scenarios'] })
    showToast(`Scenario "${name}" imported`)
    onClose()
  }

  const singleMutation = useMutation({
    mutationFn: ({ file, name }: { file: File; name: string }) =>
      scenariosApi.importFile(file, name),
    onSuccess: (_, { name }) => onImported(name),
    onError: (err: Error) => showToast(err.message, 'error'),
  })

  const flatMutation = useMutation({
    mutationFn: ({ file, name }: { file: File; name: string }) =>
      scenariosApi.importFlatCsv(file, name),
    onSuccess: (_, { name }) => onImported(name),
    onError: (err: Error) => showToast(err.message, 'error'),
  })

  const csvMutation = useMutation({
    mutationFn: ({ files, name }: {
      files: { stations: File; operators: File; processflow: File; quantities: File }
      name: string
    }) => scenariosApi.importCsvBundle(files, name),
    onSuccess: (_, { name }) => onImported(name),
    onError: (err: Error) => showToast(err.message, 'error'),
  })

  const csvReady =
    csvFiles.stations && csvFiles.operators && csvFiles.processflow && csvFiles.quantities

  const isPending = singleMutation.isPending || flatMutation.isPending || csvMutation.isPending

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Import Scenario</DialogTitle>
          <DialogDescription>
            Upload a YAML/XLSX file, a flat routing CSV, or a bundle of 4 CSV files.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2 mb-4">
          <Button
            variant={mode === 'single' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setMode('single')}
          >
            YAML / XLSX
          </Button>
          <Button
            variant={mode === 'flat' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setMode('flat')}
          >
            Flat CSV
          </Button>
          <Button
            variant={mode === 'csv' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setMode('csv')}
          >
            4 CSV files
          </Button>
        </div>

        {mode === 'single' && (
          <div className="space-y-3">
            <div>
              <Label>Scenario file (.yaml or .xlsx)</Label>
              <Input
                type="file"
                accept=".yaml,.yml,.xlsx"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null
                  setSingleFile(f)
                  if (f) setSingleName(stemName(f))
                }}
              />
            </div>
            <div>
              <Label>Scenario name</Label>
              <Input
                value={singleName}
                onChange={(e) => setSingleName(e.target.value)}
                placeholder="My factory"
              />
            </div>
            <Button
              className="w-full"
              disabled={!singleFile || !singleName.trim() || isPending}
              onClick={() =>
                singleFile && singleMutation.mutate({ file: singleFile, name: singleName.trim() })
              }
            >
              {singleMutation.isPending ? 'Importing…' : 'Import'}
            </Button>
          </div>
        )}

        {mode === 'flat' && (
          <div className="space-y-3">
            <div>
              <Label>Routing CSV (Part_Name / Machine / Cycle_Time…)</Label>
              <Input
                type="file"
                accept=".csv"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null
                  setFlatFile(f)
                  if (f) setFlatName(stemName(f))
                }}
              />
            </div>
            <div>
              <Label>Scenario name</Label>
              <Input
                value={flatName}
                onChange={(e) => setFlatName(e.target.value)}
                placeholder="My factory"
              />
            </div>
            <Button
              className="w-full"
              disabled={!flatFile || !flatName.trim() || isPending}
              onClick={() =>
                flatFile && flatMutation.mutate({ file: flatFile, name: flatName.trim() })
              }
            >
              {flatMutation.isPending ? 'Importing…' : 'Import'}
            </Button>
          </div>
        )}

        {mode === 'csv' && (
          <div className="space-y-3">
            <div>
              <Label>Scenario name</Label>
              <Input
                value={csvName}
                onChange={(e) => setCsvName(e.target.value)}
                placeholder="My factory"
              />
            </div>
            {(['stations', 'operators', 'processflow', 'quantities'] as const).map((k) => (
              <div key={k}>
                <Label className="capitalize">{k} CSV</Label>
                <Input
                  type="file"
                  accept=".csv"
                  onChange={(e) =>
                    setCsvFiles((f) => ({ ...f, [k]: e.target.files?.[0] ?? null }))
                  }
                />
              </div>
            ))}
            <Button
              className="w-full"
              disabled={!csvReady || !csvName.trim() || isPending}
              onClick={() =>
                csvReady &&
                csvMutation.mutate({
                  files: {
                    stations: csvFiles.stations!,
                    operators: csvFiles.operators!,
                    processflow: csvFiles.processflow!,
                    quantities: csvFiles.quantities!,
                  },
                  name: csvName.trim() || 'CSV Import',
                })
              }
            >
              {csvMutation.isPending ? 'Importing…' : 'Import'}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ─── Scenario view modal ──────────────────────────────────────────────────────

type ViewTab = 'stations' | 'processflow' | 'operators' | 'quantities'

/** A setup-matrix row flattened for editing: one row per (station, from, to). */
interface SetupMatrixRow {
  station: string
  from: string
  to: string
  setupTime: number
}

function flattenSetupMatrix(matrix: Record<string, Record<string, number>>): SetupMatrixRow[] {
  const rows: SetupMatrixRow[] = []
  for (const [station, pairs] of Object.entries(matrix ?? {})) {
    for (const [key, setupTime] of Object.entries(pairs)) {
      const [from, to] = key.split('|')
      rows.push({ station, from: from ?? '', to: to ?? '', setupTime })
    }
  }
  return rows
}

function unflattenSetupMatrix(rows: SetupMatrixRow[]): Record<string, Record<string, number>> {
  const matrix: Record<string, Record<string, number>> = {}
  for (const r of rows) {
    if (!r.station.trim() || !r.from.trim() || !r.to.trim()) continue
    if (!matrix[r.station]) matrix[r.station] = {}
    matrix[r.station][`${r.from.trim().toLowerCase()}|${r.to.trim().toLowerCase()}`] = r.setupTime
  }
  return matrix
}

function ScenarioViewModal({ scenario, onClose }: { scenario: Scenario; onClose: () => void }) {
  const [tab, setTab] = useState<ViewTab>('stations')
  const queryClient = useQueryClient()

  const tabs: { key: ViewTab; label: string }[] = [
    { key: 'stations',    label: 'Stations' },
    { key: 'processflow', label: 'Process Flow' },
    { key: 'operators',   label: 'Operators' },
    { key: 'quantities',  label: 'Quantities' },
  ]

  // ── Process Flow editing ──────────────────────────────────────────────────
  // Flattened one row per (variant, step). `routing` holds a structured
  // config (mirrors the engine's {mode, options, weights?/rules?/default?}
  // shape from _resolve_step_resource) for a branching step; it's null for a
  // plain single-destination step, where `resource` is just the station name.
  interface RoutingCond { variantType: string; resource: string }
  interface FlowRouting {
    mode: 'round_robin' | 'percentage' | 'condition' | 'shortest_queue'
    options: string[]
    weights: Record<string, number>
    rules: RoutingCond[]
    default: string
  }
  interface FlowStepRow {
    variant: string
    operation: string
    resource: string
    routing: FlowRouting | null
    duration: number
  }
  const flattenProcessFlow = (pf: Record<string, any>): FlowStepRow[] => {
    const rows: FlowStepRow[] = []
    for (const [variant, steps] of Object.entries(pf ?? {})) {
      for (const step of steps as any[]) {
        const isRouting = step.resource && typeof step.resource === 'object'
        let routing: FlowRouting | null = null
        if (isRouting) {
          const r = step.resource
          const weights: Record<string, number> = {}
          ;(r.options ?? []).forEach((opt: string, oi: number) => { weights[opt] = r.weights?.[oi] ?? 1 })
          const rules: RoutingCond[] = (r.rules ?? []).map((rule: any) => {
            const match = /variant_type==['"]([^'"]*)['"]/.exec(rule.if ?? '')
            return { variantType: match?.[1] ?? '', resource: rule.resource }
          })
          routing = { mode: r.mode ?? 'round_robin', options: r.options ?? [], weights, rules, default: r.default ?? (r.options?.[0] ?? '') }
        }
        rows.push({
          variant,
          operation: step.operation,
          resource: isRouting ? '' : (step.resource ?? ''),
          routing,
          duration: step.duration,
        })
      }
    }
    return rows
  }
  const [flowRows, setFlowRows] = useState<FlowStepRow[]>(() => flattenProcessFlow(scenario.processflow_data))
  const [flowDirty, setFlowDirty] = useState(false)
  const [flowSaved, setFlowSaved] = useState(false)

  const saveFlowMutation = useMutation({
    mutationFn: (rows: FlowStepRow[]) => {
      const data: Record<string, any[]> = {}
      for (const r of rows) {
        if (!r.variant.trim() || !r.operation.trim()) continue
        if (!data[r.variant.trim()]) data[r.variant.trim()] = []
        let resource: any = r.resource
        if (r.routing) {
          const options = r.routing.options.filter((o) => o.trim())
          resource = { mode: r.routing.mode, options }
          if (r.routing.mode === 'percentage') {
            resource.weights = options.map((o) => r.routing!.weights[o] ?? 1)
          } else if (r.routing.mode === 'condition') {
            resource.rules = r.routing.rules
              .filter((rule) => rule.variantType.trim())
              .map((rule) => ({ if: `variant_type=='${rule.variantType.trim()}'`, resource: rule.resource }))
            resource.default = r.routing.default || options[0]
          }
        }
        data[r.variant.trim()].push({ operation: r.operation.trim(), resource, duration: r.duration })
      }
      return scenariosApi.update(scenario.id, { processflow_data: data })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scenarios'] })
      setFlowDirty(false)
      setFlowSaved(true)
      setTimeout(() => setFlowSaved(false), 2000)
    },
  })

  const updateFlowRow = (i: number, patch: Partial<FlowStepRow>) => {
    setFlowRows((rows) => rows.map((r, ri) => (ri === i ? { ...r, ...patch } : r)))
    setFlowDirty(true)
  }
  const updateFlowRouting = (i: number, patch: Partial<FlowRouting>) => {
    setFlowRows((rows) => rows.map((r, ri) => (ri === i && r.routing ? { ...r, routing: { ...r.routing, ...patch } } : r)))
    setFlowDirty(true)
  }
  const addFlowRow = () => {
    setFlowRows((rows) => [...rows, { variant: '', operation: '', resource: '', routing: null, duration: 0 }])
    setFlowDirty(true)
  }
  const deleteFlowRow = (i: number) => {
    setFlowRows((rows) => rows.filter((_, ri) => ri !== i))
    setFlowDirty(true)
  }
  const toggleFlowRoutingMode = (i: number, enable: boolean) => {
    setFlowRows((rows) => rows.map((r, ri) => {
      if (ri !== i) return r
      return { ...r, routing: enable ? (r.routing ?? { mode: 'percentage', options: ['', ''], weights: {}, rules: [], default: '' }) : null }
    }))
    setFlowDirty(true)
  }
  const addFlowRoutingOption = (i: number) => {
    setFlowRows((rows) => rows.map((r, ri) => (ri === i && r.routing ? { ...r, routing: { ...r.routing, options: [...r.routing.options, ''] } } : r)))
    setFlowDirty(true)
  }
  const updateFlowRoutingOption = (i: number, oi: number, value: string) => {
    setFlowRows((rows) => rows.map((r, ri) => {
      if (ri !== i || !r.routing) return r
      const options = r.routing.options.map((o, idx) => (idx === oi ? value : o))
      return { ...r, routing: { ...r.routing, options } }
    }))
    setFlowDirty(true)
  }
  const deleteFlowRoutingOption = (i: number, oi: number) => {
    setFlowRows((rows) => rows.map((r, ri) => {
      if (ri !== i || !r.routing) return r
      const options = r.routing.options.filter((_, idx) => idx !== oi)
      return { ...r, routing: { ...r.routing, options } }
    }))
    setFlowDirty(true)
  }

  // ── Operators editing ─────────────────────────────────────────────────────
  interface OperatorRow { name: string; skillRating: number; availability: number }
  const [operatorRows, setOperatorRows] = useState<OperatorRow[]>(() =>
    Object.entries(scenario.operators_data ?? {}).map(([name, cfg]: [string, any]) => ({
      name, skillRating: cfg['Skill Rating'] ?? 1, availability: cfg['Availability (%)'] ?? 100,
    }))
  )
  const [operatorsDirty, setOperatorsDirty] = useState(false)
  const [operatorsSaved, setOperatorsSaved] = useState(false)
  const operators = Object.fromEntries(operatorRows.map((r) => [r.name, { 'Skill Rating': r.skillRating, 'Availability (%)': r.availability }]))

  const saveOperatorsMutation = useMutation({
    mutationFn: (rows: OperatorRow[]) => {
      const data: Record<string, any> = {}
      for (const r of rows) {
        if (!r.name.trim()) continue
        data[r.name.trim()] = { 'Skill Rating': r.skillRating, 'Availability (%)': r.availability }
      }
      return scenariosApi.update(scenario.id, { operators_data: data })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scenarios'] })
      setOperatorsDirty(false)
      setOperatorsSaved(true)
      setTimeout(() => setOperatorsSaved(false), 2000)
    },
  })
  const updateOperatorRow = (i: number, patch: Partial<OperatorRow>) => {
    setOperatorRows((rows) => rows.map((r, ri) => (ri === i ? { ...r, ...patch } : r)))
    setOperatorsDirty(true)
  }
  const addOperatorRow = () => {
    setOperatorRows((rows) => [...rows, { name: '', skillRating: 1, availability: 100 }])
    setOperatorsDirty(true)
  }
  const deleteOperatorRow = (i: number) => {
    setOperatorRows((rows) => rows.filter((_, ri) => ri !== i))
    setOperatorsDirty(true)
  }

  // ── Quantities editing ─────────────────────────────────────────────────────
  interface QuantityRow { variant: string; quantity: number; interval: number | null }
  const [quantityRows, setQuantityRows] = useState<QuantityRow[]>(() =>
    Object.entries(scenario.variant_quantities ?? {}).map(([variant, qty]) => ({
      variant, quantity: qty, interval: scenario.variant_intervals?.[variant] ?? null,
    }))
  )
  const [quantitiesDirty, setQuantitiesDirty] = useState(false)
  const [quantitiesSaved, setQuantitiesSaved] = useState(false)
  const quantities = Object.fromEntries(quantityRows.map((r) => [r.variant, r.quantity]))

  const saveQuantitiesMutation = useMutation({
    mutationFn: (rows: QuantityRow[]) => {
      const qtyData: Record<string, number> = {}
      const intervalData: Record<string, number> = {}
      for (const r of rows) {
        if (!r.variant.trim()) continue
        qtyData[r.variant.trim()] = r.quantity
        if (r.interval != null && r.interval > 0) intervalData[r.variant.trim()] = r.interval
      }
      return scenariosApi.update(scenario.id, { variant_quantities: qtyData, variant_intervals: intervalData })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scenarios'] })
      setQuantitiesDirty(false)
      setQuantitiesSaved(true)
      setTimeout(() => setQuantitiesSaved(false), 2000)
    },
  })
  const updateQuantityRow = (i: number, patch: Partial<QuantityRow>) => {
    setQuantityRows((rows) => rows.map((r, ri) => (ri === i ? { ...r, ...patch } : r)))
    setQuantitiesDirty(true)
  }
  const addQuantityRow = () => {
    setQuantityRows((rows) => [...rows, { variant: '', quantity: 0, interval: null }])
    setQuantitiesDirty(true)
  }
  const deleteQuantityRow = (i: number) => {
    setQuantityRows((rows) => rows.filter((_, ri) => ri !== i))
    setQuantitiesDirty(true)
  }

  /** Station rows flattened to an array (not a Record) so the NAME itself is
   * editable text like any other cell, including while typing a brand-new
   * station name that doesn't match any key yet. */
  interface StationRow { name: string; cfg: Record<string, any> }
  const [stationRows, setStationRows] = useState<StationRow[]>(() =>
    Object.entries(scenario.stations_data ?? {}).map(([name, cfg]) => ({ name, cfg: { ...cfg } }))
  )
  const [stationsDirty, setStationsDirty] = useState(false)
  const [stationsSaved, setStationsSaved] = useState(false)

  // Live lookup used by the Setup Matrix datalist + other display code below —
  // reflects in-progress edits, not just the last-saved scenario.stations_data.
  const stations = Object.fromEntries(stationRows.map((r) => [r.name, r.cfg]))

  const saveStationsMutation = useMutation({
    mutationFn: (rows: StationRow[]) => {
      const data: Record<string, any> = {}
      for (const r of rows) {
        if (!r.name.trim()) continue
        data[r.name.trim()] = r.cfg
      }
      return scenariosApi.update(scenario.id, { stations_data: data })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scenarios'] })
      setStationsDirty(false)
      setStationsSaved(true)
      setTimeout(() => setStationsSaved(false), 2000)
    },
  })

  const updateStationField = (i: number, field: string, value: any) => {
    setStationRows((rows) => rows.map((r, ri) => (ri === i ? { ...r, cfg: { ...r.cfg, [field]: value } } : r)))
    setStationsDirty(true)
  }
  const updateStationName = (i: number, name: string) => {
    setStationRows((rows) => rows.map((r, ri) => (ri === i ? { ...r, name } : r)))
    setStationsDirty(true)
  }
  const addStationRow = () => {
    setStationRows((rows) => [...rows, {
      name: '', cfg: {
        capacity: 1, shifts_per_day: 1, operator_per_station: 1,
        'Failure rate': 0, 'Repair Time': 10, 'Setup time': 0,
        'Buffer Capacity': 0, 'Buffer Width': 0, 'Buffer Depth': 0, 'Buffer Height': 0,
        'Buffer Discipline': 'FIFO', 'PM Schedule': 'Monthly',
        'Rework Probability (%)': 0, 'Material Shortage Probability (%)': 0,
      },
    }])
    setStationsDirty(true)
  }
  const deleteStationRow = (i: number) => {
    setStationRows((rows) => rows.filter((_, ri) => ri !== i))
    setStationsDirty(true)
  }

  const [matrixRows, setMatrixRows] = useState<SetupMatrixRow[]>(() => flattenSetupMatrix(scenario.setup_matrix ?? {}))
  const [matrixDirty, setMatrixDirty] = useState(false)
  const [matrixSaved, setMatrixSaved] = useState(false)

  const saveMatrixMutation = useMutation({
    mutationFn: (rows: SetupMatrixRow[]) =>
      scenariosApi.update(scenario.id, { setup_matrix: unflattenSetupMatrix(rows) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scenarios'] })
      setMatrixDirty(false)
      setMatrixSaved(true)
      setTimeout(() => setMatrixSaved(false), 2000)
    },
  })

  const updateRow = (i: number, patch: Partial<SetupMatrixRow>) => {
    setMatrixRows((rows) => rows.map((r, ri) => (ri === i ? { ...r, ...patch } : r)))
    setMatrixDirty(true)
  }
  const addRow = () => {
    setMatrixRows((rows) => [...rows, { station: '', from: '', to: '', setupTime: 0 }])
    setMatrixDirty(true)
  }
  const deleteRow = (i: number) => {
    setMatrixRows((rows) => rows.filter((_, ri) => ri !== i))
    setMatrixDirty(true)
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-[900px] max-h-[85vh] flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-indigo-50">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-blue-100 flex items-center justify-center">
              <FileText className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <h2 className="text-base font-bold text-gray-900">{scenario.name}</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                {Object.keys(stations).length} stations · {Object.keys(scenario.processflow_data ?? {}).length} variants · {Object.keys(operators).length} operators
              </p>
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100 px-6 bg-white">
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                tab === t.key
                  ? 'border-blue-600 text-blue-700'
                  : 'border-transparent text-gray-400 hover:text-gray-600'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6 [color-scheme:light] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-gray-50 [&::-webkit-scrollbar-thumb]:bg-blue-200 [&::-webkit-scrollbar-thumb]:rounded-full">

          {/* Stations tab */}
          {tab === 'stations' && (
            <div>
            <div className="overflow-x-auto [color-scheme:light] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-track]:bg-gray-50 [&::-webkit-scrollbar-thumb]:bg-blue-200 [&::-webkit-scrollbar-thumb]:rounded-full">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  {['Station', 'Capacity', 'Shifts/Day', 'Operators', 'Failure Rate', 'Repair Time', 'Setup Time', 'Buffer Cap.', 'Buffer W', 'Buffer D', 'Buffer H', 'Buffer Order', 'PM Schedule', 'Rework %', 'Material Shortage %', ''].map(h => (
                    <th key={h} className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-widest pb-3 pr-4 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stationRows.map((row, i) => {
                  const cfg = row.cfg
                  const num = (field: string) => (
                    <Input
                      type="number"
                      value={cfg[field] ?? 0}
                      onChange={(e) => updateStationField(i, field, Number(e.target.value))}
                      className="h-8 text-sm w-20"
                    />
                  )
                  return (
                    <tr key={i} className={`border-b border-gray-50 ${i % 2 === 0 ? '' : 'bg-gray-50/50'}`}>
                      <td className="py-1.5 pr-4">
                        <Input
                          value={row.name}
                          onChange={(e) => updateStationName(i, e.target.value)}
                          placeholder="Station name"
                          className="h-8 text-sm w-36 font-medium"
                        />
                      </td>
                      <td className="py-1.5 pr-4">{num('capacity')}</td>
                      <td className="py-1.5 pr-4">{num('shifts_per_day')}</td>
                      <td className="py-1.5 pr-4">{num('operator_per_station')}</td>
                      <td className="py-1.5 pr-4">{num('Failure rate')}</td>
                      <td className="py-1.5 pr-4">{num('Repair Time')}</td>
                      <td className="py-1.5 pr-4">{num('Setup time')}</td>
                      <td className="py-1.5 pr-4">{num('Buffer Capacity')}</td>
                      <td className="py-1.5 pr-4">{num('Buffer Width')}</td>
                      <td className="py-1.5 pr-4">{num('Buffer Depth')}</td>
                      <td className="py-1.5 pr-4">{num('Buffer Height')}</td>
                      <td className="py-1.5 pr-4">
                        <select
                          value={cfg['Buffer Discipline'] || 'FIFO'}
                          onChange={(e) => updateStationField(i, 'Buffer Discipline', e.target.value)}
                          className="h-8 text-sm text-gray-800 bg-white border border-gray-200 rounded-md px-1.5"
                        >
                          <option value="FIFO">FIFO</option>
                          <option value="LIFO">LIFO</option>
                        </select>
                      </td>
                      <td className="py-1.5 pr-4">
                        <select
                          value={cfg['PM Schedule'] || 'Monthly'}
                          onChange={(e) => updateStationField(i, 'PM Schedule', e.target.value)}
                          className="h-8 text-sm text-gray-800 bg-white border border-gray-200 rounded-md px-1.5"
                        >
                          <option value="Weekly">Weekly</option>
                          <option value="Bi-Weekly">Bi-Weekly</option>
                          <option value="Monthly">Monthly</option>
                        </select>
                      </td>
                      <td className="py-1.5 pr-4">{num('Rework Probability (%)')}</td>
                      <td className="py-1.5 pr-4">{num('Material Shortage Probability (%)')}</td>
                      <td className="py-1.5 pr-4">
                        <button
                          onClick={() => deleteStationRow(i)}
                          className="text-gray-300 hover:text-red-500 transition-colors"
                          aria-label="Delete station"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  )
                })}
                {stationRows.length === 0 && (
                  <tr>
                    <td colSpan={16} className="py-6 text-center text-gray-400 text-sm">
                      No stations yet — add one below.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            </div>

            <div className="flex items-center justify-between mt-4">
              <button
                onClick={addStationRow}
                className="flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700"
              >
                <PlusCircle className="h-4 w-4" />
                Add station
              </button>
              <div className="flex items-center gap-3">
                {stationsSaved && <span className="text-xs text-green-600 font-medium">Saved</span>}
                <Button
                  size="sm"
                  disabled={!stationsDirty || saveStationsMutation.isPending}
                  onClick={() => saveStationsMutation.mutate(stationRows)}
                  className="bg-blue-600 hover:bg-blue-700"
                >
                  <Save className="h-3.5 w-3.5 mr-1.5" />
                  {saveStationsMutation.isPending ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            </div>

              {/* Setup Matrix editor — lives directly below Stations, since it's
                  per-station changeover data, not a separate top-level concept. */}
              <div className="mt-8 pt-6 border-t border-gray-100">
                <h3 className="text-sm font-bold text-gray-700 mb-1">Setup Matrix</h3>
                <p className="text-xs text-gray-400 mb-4">
                  Per-product-pair changeover time. A station/pair not listed here falls back to that
                  station's flat <span className="font-medium text-gray-500">Setup time</span> above.
                </p>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      {['Station', 'From', 'To', 'Setup Time (min)', ''].map(h => (
                        <th key={h} className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-widest pb-3 pr-4">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {matrixRows.map((row, i) => (
                      <tr key={i} className={`border-b border-gray-50 ${i % 2 === 0 ? '' : 'bg-gray-50/50'}`}>
                        <td className="py-1.5 pr-4">
                          <Input
                            value={row.station}
                            onChange={(e) => updateRow(i, { station: e.target.value })}
                            placeholder="Station"
                            className="h-8 text-sm"
                            list="setup-matrix-stations"
                          />
                        </td>
                        <td className="py-1.5 pr-4">
                          <Input
                            value={row.from}
                            onChange={(e) => updateRow(i, { from: e.target.value })}
                            placeholder="From variant"
                            className="h-8 text-sm"
                          />
                        </td>
                        <td className="py-1.5 pr-4">
                          <Input
                            value={row.to}
                            onChange={(e) => updateRow(i, { to: e.target.value })}
                            placeholder="To variant"
                            className="h-8 text-sm"
                          />
                        </td>
                        <td className="py-1.5 pr-4">
                          <Input
                            type="number"
                            value={row.setupTime}
                            onChange={(e) => updateRow(i, { setupTime: Number(e.target.value) })}
                            className="h-8 text-sm w-28"
                          />
                        </td>
                        <td className="py-1.5 pr-4">
                          <button
                            onClick={() => deleteRow(i)}
                            className="text-gray-300 hover:text-red-500 transition-colors"
                            aria-label="Delete row"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                    {matrixRows.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-6 text-center text-gray-400 text-sm">
                          No setup matrix rows yet — add one below, or import a "Setup Matrix" sheet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
                <datalist id="setup-matrix-stations">
                  {Object.keys(stations).map((s) => <option key={s} value={s} />)}
                </datalist>

                <div className="flex items-center justify-between mt-4">
                  <button
                    onClick={addRow}
                    className="flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700"
                  >
                    <PlusCircle className="h-4 w-4" />
                    Add row
                  </button>
                  <div className="flex items-center gap-3">
                    {matrixSaved && <span className="text-xs text-green-600 font-medium">Saved</span>}
                    <Button
                      size="sm"
                      disabled={!matrixDirty || saveMatrixMutation.isPending}
                      onClick={() => saveMatrixMutation.mutate(matrixRows)}
                      className="bg-blue-600 hover:bg-blue-700"
                    >
                      <Save className="h-3.5 w-3.5 mr-1.5" />
                      {saveMatrixMutation.isPending ? 'Saving…' : 'Save changes'}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Process Flow tab */}
          {tab === 'processflow' && (
            <div>
              <div className="overflow-x-auto [color-scheme:light] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-track]:bg-gray-50 [&::-webkit-scrollbar-thumb]:bg-blue-200 [&::-webkit-scrollbar-thumb]:rounded-full">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      {['Variant', 'Operation', 'Station / Resource', 'Exit Controller (branching)', 'Duration (min)', ''].map(h => (
                        <th key={h} className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-widest pb-3 pr-4 whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {flowRows.map((row, i) => (
                      <tr key={i} className={`border-b border-gray-50 align-top ${i % 2 === 0 ? '' : 'bg-gray-50/50'}`}>
                        <td className="py-1.5 pr-4">
                          <Input
                            value={row.variant}
                            onChange={(e) => updateFlowRow(i, { variant: e.target.value })}
                            placeholder="Variant"
                            className="h-8 text-sm w-28"
                          />
                        </td>
                        <td className="py-1.5 pr-4">
                          <Input
                            value={row.operation}
                            onChange={(e) => updateFlowRow(i, { operation: e.target.value })}
                            placeholder="Operation"
                            className="h-8 text-sm w-32"
                          />
                        </td>
                        <td className="py-1.5 pr-4">
                          <Input
                            value={row.resource}
                            disabled={row.routing != null}
                            onChange={(e) => updateFlowRow(i, { resource: e.target.value })}
                            placeholder="Station"
                            className="h-8 text-sm w-32 disabled:bg-gray-50 disabled:text-gray-400"
                          />
                          <label className="flex items-center gap-1.5 mt-1 text-[11px] text-gray-400">
                            <input
                              type="checkbox"
                              checked={row.routing != null}
                              onChange={(e) => toggleFlowRoutingMode(i, e.target.checked)}
                            />
                            Branching
                          </label>
                        </td>
                        <td className="py-1.5 pr-4">
                          {row.routing ? (
                            <div className="w-72 bg-gray-50 border border-gray-200 rounded-lg p-2.5 space-y-2">
                              <select
                                value={row.routing.mode}
                                onChange={(e) => updateFlowRouting(i, { mode: e.target.value as FlowRouting['mode'] })}
                                className="w-full h-7 text-xs text-gray-800 bg-white border border-gray-200 rounded-md px-1.5"
                              >
                                <option value="round_robin">Round-robin</option>
                                <option value="percentage">Percentage split</option>
                                <option value="condition">Condition (by variant)</option>
                                <option value="shortest_queue">Shortest queue</option>
                              </select>

                              <div className="space-y-1">
                                {row.routing.options.map((opt, oi) => (
                                  <div key={oi} className="flex items-center gap-1.5">
                                    <Input
                                      value={opt}
                                      onChange={(e) => updateFlowRoutingOption(i, oi, e.target.value)}
                                      placeholder="Station name"
                                      className="h-7 text-xs flex-1"
                                    />
                                    {row.routing!.mode === 'percentage' && (
                                      <Input
                                        type="number"
                                        value={row.routing!.weights[opt] ?? ''}
                                        onChange={(e) => updateFlowRouting(i, { weights: { ...row.routing!.weights, [opt]: Number(e.target.value) } })}
                                        placeholder="%"
                                        className="h-7 w-16 text-xs"
                                      />
                                    )}
                                    {row.routing!.mode === 'condition' && (
                                      <Input
                                        value={row.routing!.rules.find((r) => r.resource === opt)?.variantType ?? ''}
                                        onChange={(e) => {
                                          const others = row.routing!.rules.filter((r) => r.resource !== opt)
                                          const value = e.target.value.trim()
                                          updateFlowRouting(i, { rules: value ? [...others, { variantType: value, resource: opt }] : others })
                                        }}
                                        placeholder="Variant"
                                        className="h-7 w-20 text-xs"
                                      />
                                    )}
                                    <button
                                      onClick={() => deleteFlowRoutingOption(i, oi)}
                                      className="text-gray-300 hover:text-red-500 shrink-0"
                                      aria-label="Remove option"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  </div>
                                ))}
                              </div>
                              <button
                                onClick={() => addFlowRoutingOption(i)}
                                className="text-[11px] font-medium text-blue-600 hover:text-blue-700"
                              >
                                + Add option
                              </button>

                              {row.routing.mode === 'condition' && (
                                <div>
                                  <label className="text-[10px] text-gray-400 uppercase tracking-wide">Default (no match)</label>
                                  <select
                                    value={row.routing.default}
                                    onChange={(e) => updateFlowRouting(i, { default: e.target.value })}
                                    className="w-full h-7 text-xs text-gray-800 bg-white border border-gray-200 rounded-md px-1.5 mt-1"
                                  >
                                    {row.routing.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                                  </select>
                                </div>
                              )}
                              {row.routing.mode === 'shortest_queue' && (
                                <p className="text-[10px] text-gray-400">Sends each job to whichever option currently has the least work waiting.</p>
                              )}
                              {row.routing.mode === 'round_robin' && (
                                <p className="text-[10px] text-gray-400">Cycles through the options in order.</p>
                              )}
                            </div>
                          ) : (
                            <span className="text-gray-300 text-xs">—</span>
                          )}
                        </td>
                        <td className="py-1.5 pr-4">
                          <Input
                            type="number"
                            value={row.duration}
                            onChange={(e) => updateFlowRow(i, { duration: Number(e.target.value) })}
                            className="h-8 text-sm w-24"
                          />
                        </td>
                        <td className="py-1.5 pr-4">
                          <button
                            onClick={() => deleteFlowRow(i)}
                            className="text-gray-300 hover:text-red-500 transition-colors"
                            aria-label="Delete step"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                    {flowRows.length === 0 && (
                      <tr>
                        <td colSpan={6} className="py-6 text-center text-gray-400 text-sm">
                          No process flow steps yet — add one below.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between mt-4">
                <button
                  onClick={addFlowRow}
                  className="flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700"
                >
                  <PlusCircle className="h-4 w-4" />
                  Add step
                </button>
                <div className="flex items-center gap-3">
                  {flowSaved && <span className="text-xs text-green-600 font-medium">Saved</span>}
                  <Button
                    size="sm"
                    disabled={!flowDirty || saveFlowMutation.isPending}
                    onClick={() => saveFlowMutation.mutate(flowRows)}
                    className="bg-blue-600 hover:bg-blue-700"
                  >
                    <Save className="h-3.5 w-3.5 mr-1.5" />
                    {saveFlowMutation.isPending ? 'Saving…' : 'Save changes'}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Operators tab */}
          {tab === 'operators' && (
            <div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    {['Operator', 'Skill Rating', 'Availability (%)', ''].map(h => (
                      <th key={h} className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-widest pb-3 pr-4">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {operatorRows.map((row, i) => (
                    <tr key={i} className={`border-b border-gray-50 ${i % 2 === 0 ? '' : 'bg-gray-50/50'}`}>
                      <td className="py-1.5 pr-4">
                        <Input
                          value={row.name}
                          onChange={(e) => updateOperatorRow(i, { name: e.target.value })}
                          placeholder="Operator"
                          className="h-8 text-sm w-32"
                        />
                      </td>
                      <td className="py-1.5 pr-4">
                        <Input
                          type="number"
                          value={row.skillRating}
                          onChange={(e) => updateOperatorRow(i, { skillRating: Number(e.target.value) })}
                          className="h-8 text-sm w-24"
                        />
                      </td>
                      <td className="py-1.5 pr-4">
                        <Input
                          type="number"
                          value={row.availability}
                          onChange={(e) => updateOperatorRow(i, { availability: Number(e.target.value) })}
                          className="h-8 text-sm w-24"
                        />
                      </td>
                      <td className="py-1.5 pr-4">
                        <button
                          onClick={() => deleteOperatorRow(i)}
                          className="text-gray-300 hover:text-red-500 transition-colors"
                          aria-label="Delete operator"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {operatorRows.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-6 text-center text-gray-400 text-sm">
                        No operators yet — add one below.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>

              <div className="flex items-center justify-between mt-4">
                <button
                  onClick={addOperatorRow}
                  className="flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700"
                >
                  <PlusCircle className="h-4 w-4" />
                  Add operator
                </button>
                <div className="flex items-center gap-3">
                  {operatorsSaved && <span className="text-xs text-green-600 font-medium">Saved</span>}
                  <Button
                    size="sm"
                    disabled={!operatorsDirty || saveOperatorsMutation.isPending}
                    onClick={() => saveOperatorsMutation.mutate(operatorRows)}
                    className="bg-blue-600 hover:bg-blue-700"
                  >
                    <Save className="h-3.5 w-3.5 mr-1.5" />
                    {saveOperatorsMutation.isPending ? 'Saving…' : 'Save changes'}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Quantities tab */}
          {tab === 'quantities' && (
            <div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    {['Variant / Part', 'Quantity', 'Interval (min)', ''].map(h => (
                      <th key={h} className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-widest pb-3 pr-4">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {quantityRows.map((row, i) => (
                    <tr key={i} className={`border-b border-gray-50 ${i % 2 === 0 ? '' : 'bg-gray-50/50'}`}>
                      <td className="py-1.5 pr-4">
                        <Input
                          value={row.variant}
                          onChange={(e) => updateQuantityRow(i, { variant: e.target.value })}
                          placeholder="Variant"
                          className="h-8 text-sm w-36"
                        />
                      </td>
                      <td className="py-1.5 pr-4">
                        <Input
                          type="number"
                          value={row.quantity}
                          onChange={(e) => updateQuantityRow(i, { quantity: Number(e.target.value) })}
                          className="h-8 text-sm w-24"
                        />
                      </td>
                      <td className="py-1.5 pr-4">
                        <Input
                          type="number"
                          value={row.interval ?? ''}
                          placeholder="—"
                          onChange={(e) => updateQuantityRow(i, { interval: e.target.value === '' ? null : Number(e.target.value) })}
                          className="h-8 text-sm w-24"
                        />
                      </td>
                      <td className="py-1.5 pr-4">
                        <button
                          onClick={() => deleteQuantityRow(i)}
                          className="text-gray-300 hover:text-red-500 transition-colors"
                          aria-label="Delete variant"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {quantityRows.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-6 text-center text-gray-400 text-sm">
                        No variants yet — add one below.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>

              <div className="flex items-center justify-between mt-4">
                <button
                  onClick={addQuantityRow}
                  className="flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700"
                >
                  <PlusCircle className="h-4 w-4" />
                  Add variant
                </button>
                <div className="flex items-center gap-3">
                  {quantitiesSaved && <span className="text-xs text-green-600 font-medium">Saved</span>}
                  <Button
                    size="sm"
                    disabled={!quantitiesDirty || saveQuantitiesMutation.isPending}
                    onClick={() => saveQuantitiesMutation.mutate(quantityRows)}
                    className="bg-blue-600 hover:bg-blue-700"
                  >
                    <Save className="h-3.5 w-3.5 mr-1.5" />
                    {saveQuantitiesMutation.isPending ? 'Saving…' : 'Save changes'}
                  </Button>
                </div>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}

// ─── Scenario card ────────────────────────────────────────────────────────────

function ScenarioCard({
  scenario,
  onSelect,
  onDelete,
  onViewFile,
}: {
  scenario: ScenarioListItem
  onSelect: () => void
  onDelete: () => void
  onViewFile: () => void
}) {
  return (
    <div
      onClick={onSelect}
      className="group relative bg-white rounded-2xl shadow-sm hover:shadow-lg transition-all duration-200 cursor-pointer border border-gray-100 hover:border-blue-200 overflow-hidden"
    >
      {/* Top gradient stripe */}
      <div className="h-1 w-full bg-gradient-to-r from-blue-500 via-blue-400 to-indigo-400" />

      <div className="p-5">
        {/* Header row */}
        <div className="flex items-start justify-between gap-2 mb-4">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-bold text-gray-900 truncate group-hover:text-blue-700 transition-colors">
              {scenario.name}
            </h3>
            {scenario.description && (
              <p className="text-xs text-gray-400 mt-0.5 truncate">{scenario.description}</p>
            )}
          </div>
          <span className="flex items-center gap-1 text-xs font-medium text-blue-600 bg-blue-50 px-2 py-1 rounded-full shrink-0">
            <FileText className="h-3 w-3" />
            Scenario
          </span>
        </div>

        {/* Footer row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs text-gray-400">
            <Clock className="h-3 w-3 shrink-0" />
            <div className="flex flex-col leading-tight">
              <span>{new Date(scenario.updated_at).toLocaleDateString()}</span>
              <span className="text-[10px] text-gray-300">{new Date(scenario.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          </div>
          <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={onViewFile}
              className="p-1.5 rounded-lg text-gray-300 hover:text-blue-500 hover:bg-blue-50 transition-colors"
              title="View source file"
            >
              <Eye className="h-4 w-4" />
            </button>
            <Button
              size="sm"
              onClick={onSelect}
              className="bg-blue-600 hover:bg-blue-700 text-white shadow-sm"
            >
              <Play className="h-3 w-3 mr-1" />
              Open
            </Button>
            <button
              onClick={onDelete}
              className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ScenarioManager() {
  const [uploadOpen, setUploadOpen] = useState(false)
  const [viewScenario, setViewScenario] = useState<Scenario | null>(null)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { setActiveScenario, setActiveRun, showToast } = useAppStore()

  const handleViewFile = async (id: number) => {
    try {
      const full = await scenariosApi.get(id)
      setViewScenario(full)
    } catch {
      showToast('Could not load scenario data', 'error')
    }
  }

  const { data: scenarios = [], isLoading } = useQuery({
    queryKey: ['scenarios'],
    queryFn: scenariosApi.list,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => scenariosApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scenarios'] })
      showToast('Scenario deleted')
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  })

  const handleSelect = async (id: number) => {
    const full = await scenariosApi.get(id)
    setActiveScenario(full)
    navigate('/run')
  }

  return (
    <div className="min-h-full bg-gradient-to-br from-white via-blue-50/30 to-indigo-50/40 p-8">
      <div className="max-w-5xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Scenarios</h1>
            <p className="text-sm text-gray-400 mt-0.5">
              {scenarios.length} scenario{scenarios.length !== 1 ? 's' : ''} saved
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => setUploadOpen(true)}
              className="border-gray-300 text-gray-600 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50 transition-all rounded-full px-5"
            >
              <Upload className="h-4 w-4 mr-2" />
              Import
            </Button>
            <Button
              onClick={() => { setActiveScenario(null); setActiveRun(null); navigate('/canvas') }}
              className="bg-blue-600 hover:bg-blue-700 text-white shadow-md hover:shadow-blue-200 hover:shadow-lg transition-all rounded-full px-5"
            >
              <Plus className="h-4 w-4 mr-2" />
              New Canvas
            </Button>
          </div>
        </div>

        {/* Grid */}
        {isLoading ? (
          <div className="text-center py-16 text-gray-400">Loading…</div>
        ) : scenarios.length === 0 ? (
          <div className="text-center py-24 rounded-2xl bg-white/70 border border-blue-100 shadow-sm">
            <div className="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <FileText className="h-8 w-8 text-blue-400" />
            </div>
            <p className="text-gray-700 font-semibold text-lg">No scenarios yet</p>
            <p className="text-sm text-gray-400 mt-1 mb-6">
              Import a YAML/XLSX file or build one on the visual canvas.
            </p>
            <Button
              onClick={() => setUploadOpen(true)}
              className="bg-blue-600 hover:bg-blue-700 shadow-sm"
            >
              <Upload className="h-4 w-4 mr-2" />
              Import scenario
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {scenarios.map((s) => (
              <ScenarioCard
                key={s.id}
                scenario={s}
                onSelect={() => handleSelect(s.id)}
                onDelete={() => deleteMutation.mutate(s.id)}
                onViewFile={() => handleViewFile(s.id)}
              />
            ))}
          </div>
        )}

      </div>
      <UploadDialog open={uploadOpen} onClose={() => setUploadOpen(false)} />
      {viewScenario && (
        // key forces a fresh mount (and fresh useState initializers) whenever
        // the scenario's data actually changed — e.g. reopening the same
        // scenario after editing it — instead of React reusing the same
        // component instance and showing stale in-memory rows.
        <ScenarioViewModal
          key={`${viewScenario.id}-${viewScenario.updated_at}`}
          scenario={viewScenario}
          onClose={() => setViewScenario(null)}
        />
      )}
    </div>
  )
}
