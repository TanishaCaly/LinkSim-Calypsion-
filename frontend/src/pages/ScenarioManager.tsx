import { useMemo, useState, useRef } from 'react'
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Plus, Upload, Trash2, FileText, X, Save, PlusCircle, Search } from 'lucide-react'
import { scenariosApi } from '@/api/scenarios'
import { useAppStore } from '@/store/useAppStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import ScenarioCard, { STATUS_LABEL } from '@/components/scenarios/ScenarioCard'
import { fetchScenarioSummary, type CardStatus } from '@/lib/scenarioSummary'
import { cn } from '@/lib/utils'
import type { Scenario, ScenarioListItem } from '@/types'

// ─── Upload dialog ────────────────────────────────────────────────────────────

type UploadMode = 'single' | 'flat' | 'csv'

function stemName(file: File | null): string {
  if (!file) return ''
  return file.name.replace(/\.[^.]+$/, '')
}

/**
 * Estimated steady-state availability (%) for a station, via
 * availability = MTBF / (MTBF + MTTR) — the PDF's own core formula.
 * Display-only — doesn't change which shifts the station actually runs on
 * (that's the separate shifts_per_day field, edited in the Canvas station
 * panel), just estimates how much of its scheduled time it's likely to be
 * up given random breakdowns.
 *
 * Prefers the station's stored `MTBF` (minutes, uncapped) when present —
 * this is what onCommit below writes, and what backend/engine/machine.py
 * now reads directly (see sim_core.py's _init_resources). Falls back to
 * the legacy `1440/Failure rate` estimate for scenarios saved before the
 * MTBF field existed, so old data still displays something sensible.
 * `Failure rate` is a 0-1 DAILY probability (machine.py enforces
 * 0<=rate<=1), so that fallback can only express MTBF >= 1440 minutes —
 * it undershoots reliability for faster-failing machines, which is exactly
 * why new edits are written as MTBF instead (see availabilityPctToMtbf).
 */
function estimateAvailabilityPct(
  failureRate: number | undefined,
  repairTime: number | undefined,
  mtbf: number | undefined,
): number {
  const mttr = repairTime ?? 0
  let mtbfValue: number
  if (mtbf != null && mtbf > 0) {
    mtbfValue = mtbf
  } else {
    const rate = failureRate ?? 0
    if (rate <= 0) return 100
    mtbfValue = 1440 / rate
  }
  if (mttr <= 0) return 100
  return (mtbfValue / (mtbfValue + mttr)) * 100
}

/**
 * Inverse of estimateAvailabilityPct: given a target availability % and the
 * station's current MTTR, solves for MTBF (minutes) directly —
 *   MTBF = (A / (1 - A)) * MTTR
 * the PDF's section 1/4 formula, exactly, with no artificial ceiling.
 *
 * This REPLACES the old availabilityPctToFailureRate, which instead solved
 * for a 0-1 "Failure rate" and had to clamp at rate=1 (MTBF=1440 min floor)
 * for almost any realistic input — e.g. the PDF's own 90%/MTTR=2 example
 * needs MTBF=18 min, 80x below that floor, so it silently produced a
 * station 80x more reliable than requested. Writing MTBF as a plain float
 * instead has no such ceiling.
 */
function availabilityPctToMtbf(pct: number, repairTime: number | undefined): number {
  const mttr = repairTime ?? 0
  const clamped = Math.max(0.0001, Math.min(99.9999, pct))
  if (mttr <= 0) return 0
  const availability = clamped / 100
  return (availability / (1 - availability)) * mttr
}

/**
 * The Station Availability (%) cell binds straight to
 * estimateAvailabilityPct(Failure rate, Repair Time, MTBF) recomputed on
 * every render — so typing a new value round-trips through
 * availabilityPctToMtbf and back through estimateAvailabilityPct, which
 * doesn't perfectly invert (floating point) and drifts the displayed
 * number away from what was typed. Worse, clearing the field to type a
 * fresh value saw "" and had nowhere to go but snap back to the recomputed
 * number, making it look like the digit couldn't be deleted. This keeps
 * its own local text draft while typing — committing (and inverting to
 * MTBF) only once the value looks like a real number — and only re-syncs
 * from the computed % when the station actually changes underneath it,
 * not on every recompute of this same value.
 */
function AvailabilityPctField({
  value, onCommit, stationKey,
}: { value: number; onCommit: (pct: number) => void; stationKey: string }) {
  const [draft, setDraft] = useState(String(value))
  const lastKey = useRef(stationKey)

  if (lastKey.current !== stationKey) {
    lastKey.current = stationKey
    if (draft !== String(value)) setDraft(String(value))
  }

  return (
    <Input
      type="number"
      min={0}
      max={100}
      step={0.01}
      value={draft}
      onFocus={(e) => e.target.select()}
      onChange={(e) => {
        const raw = e.target.value
        setDraft(raw)
        if (raw === '') return
        const parsed = Number(raw)
        if (Number.isNaN(parsed)) return
        onCommit(parsed)
      }}
      onBlur={() => {
        if (draft === '' || Number.isNaN(Number(draft))) setDraft(String(value))
      }}
      title="Editable — writes back to this station's MTBF (holding MTTR fixed)"
      className="h-8 text-sm w-24 pr-5"
    />
  )
}

export function UploadDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
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
    queryClient.invalidateQueries({ queryKey: ['scenarios-count'] })
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

  /** Station rows flattened to an array (not a Record) so the NAME itself is
   * editable text like any other cell, including while typing a brand-new
   * station name that doesn't match any key yet. */
  interface StationRow { name: string; cfg: Record<string, any> }
  const [stationRows, setStationRows] = useState<StationRow[]>(() =>
    Object.entries(scenario.stations_data ?? {}).map(([name, cfg]) => ({ name, cfg: { ...cfg } }))
  )

  // ── Process Flow editing ──────────────────────────────────────────────────
  // Flattened one row per (variant, step).
  interface FlowStepRow {
    variant: string
    operation: string
    resource: string
    duration: number
    // Consecutive rows of one variant with the same branch number are a
    // split: each job visits only one of them (set on the Canvas).
    branch?: number
  }
  const flattenProcessFlow = (pf: Record<string, any>): FlowStepRow[] => {
    const rows: FlowStepRow[] = []
    for (const [variant, steps] of Object.entries(pf ?? {})) {
      for (const step of steps as any[]) {
        // Scenarios saved while the Exit Controller existed may still hold a
        // {mode, options, ...} resource — show its first station, matching
        // what the engine now runs for it (sim_core._resolve_step_resource).
        const resource = step.resource && typeof step.resource === 'object'
          ? (step.resource.options?.[0] ?? '')
          : (step.resource ?? '')
        rows.push({
          variant,
          operation: step.operation,
          resource,
          duration: step.duration,
          ...(step.branch !== undefined ? { branch: step.branch } : {}),
        })
      }
    }
    return rows
  }
  const [flowRows, setFlowRows] = useState<FlowStepRow[]>(() => flattenProcessFlow(scenario.processflow_data))
  // Process time a station starts with when it is added to the route — the
  // same as a new box on the Canvas: 30 min for a station, its transport
  // time for a conveyor, nothing for a junction/buffer.
  const newStepTime = (name: string): number => {
    const cfg = stationRows.find((s) => s.name === name)?.cfg ?? {}
    const type = cfg['Station Type']
    if (type === 'Conveyor') {
      const length = cfg['Conveyor Length'] ?? 0
      const speed = cfg['Conveyor Speed'] ?? 0
      return length > 0 && speed > 0 ? length / speed : 0
    }
    if (['Connector', 'Buffer', 'Worker', 'Worker Controller', 'Workplace', 'Source', 'Drain'].includes(type)) return 0
    return 30
  }
  // Stations that don't take part in a job's route (pool wiring, Start/End).
  const isRouteStationCfg = (cfg: Record<string, any>) =>
    !['Worker', 'Worker Controller', 'Workplace', 'Source', 'Drain'].includes(cfg['Station Type'])
  // Put a station at the end of every product's route (before End), with
  // newStepTime — so it shows in Process Flow and on the Canvas.
  const appendStationToEveryRoute = (name: string) => {
    const station = name.trim()
    if (!station) return
    setFlowRows((rows) => {
      const variants = Array.from(new Set(rows.map((r) => r.variant).filter((v) => v.trim())))
      let out = [...rows]
      for (const variant of variants) {
        if (out.some((r) => r.variant === variant && r.resource === station)) continue
        const lastIdx = out.map((r) => r.variant).lastIndexOf(variant)
        // An older flow may end with its End (Drain) step: go before it.
        const last = out[lastIdx]
        const beforeEnd = stationRows.find((s) => s.name === last.resource)?.cfg['Station Type'] === 'Drain'
        const at = beforeEnd ? lastIdx : lastIdx + 1
        out = [...out.slice(0, at), { variant, operation: station, resource: station, duration: newStepTime(station) }, ...out.slice(at)]
      }
      return out
    })
    setSharedRoute((route) => (route.includes(station) ? route : [...route.filter((s) => s.trim()), station]))
    setFlowDirty(true)
  }
  // The parallel group a stop's stations all belong to, if they do (a
  // machine's group is in its Stations tab settings).
  const stopParallelGroup = (names: string[]): string | undefined => {
    const groups = new Set(names.map((n) => stationRows.find((s) => s.name === n)?.cfg['Parallel Group'] || ''))
    const [only] = groups
    return groups.size === 1 && only ? only : undefined
  }
  const [flowDirty, setFlowDirty] = useState(false)
  const [flowSaved, setFlowSaved] = useState(false)

  const saveFlowMutation = useMutation({
    mutationFn: (rows: FlowStepRow[]) => {
      const data: Record<string, any[]> = {}
      for (const r of rows) {
        if (!r.variant.trim() || !r.operation.trim()) continue
        if (!data[r.variant.trim()]) data[r.variant.trim()] = []
        data[r.variant.trim()].push({
          operation: r.operation.trim(), resource: r.resource, duration: r.duration,
          ...(r.branch !== undefined ? { branch: r.branch } : {}),
        })
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

  // Splits: consecutive rows of one variant sharing a branch number. For
  // each row in a split, its place in it ("path 2 of 3"); and each variant's
  // route with splits in brackets — Station 1 → [ Station 2 | Station 3 ] → End.
  // When every station of one such stop is a machine of the same parallel
  // group, the stop is that group (one waiting line, each machine with its
  // own settings) — shown as Station 2 ( Station 2 #1 | Station 2 #2 ).
  const flowSplitPlace: Record<number, { pos: number; count: number; group?: string }> = {}
  const flowRouteByVariant = new Map<string, string[]>()
  for (let i = 0; i < flowRows.length; ) {
    const r = flowRows[i]
    let j = i + 1
    if (r.branch !== undefined) {
      while (j < flowRows.length && flowRows[j].variant === r.variant && flowRows[j].branch === r.branch) j++
    }
    const group = flowRows.slice(i, j)
    const parallelGroup = group.length > 1 ? stopParallelGroup(group.map((g) => g.resource)) : undefined
    if (group.length > 1) group.forEach((_, k) => { flowSplitPlace[i + k] = { pos: k + 1, count: group.length, group: parallelGroup } })
    if (!flowRouteByVariant.has(r.variant)) flowRouteByVariant.set(r.variant, [])
    flowRouteByVariant.get(r.variant)!.push(
      group.length <= 1 ? r.resource
        : parallelGroup ? `${parallelGroup} ( ${group.map((g) => g.resource).join(' | ')} )`
          : `[ ${group.map((g) => g.resource).join(' | ')} ]`,
    )
    i = j
  }
  const flowHasSplit = Object.keys(flowSplitPlace).length > 0
  const flowHasRealSplit = Object.values(flowSplitPlace).some((p) => !p.group)
  const flowHasGroup = Object.values(flowSplitPlace).some((p) => p.group)

  const updateFlowRow = (i: number, patch: Partial<FlowStepRow>) => {
    setFlowRows((rows) => rows.map((r, ri) => (ri === i ? { ...r, ...patch } : r)))
    setFlowDirty(true)
  }
  const addFlowRow = () => {
    setFlowRows((rows) => [...rows, { variant: '', operation: '', resource: '', duration: 0 }])
    setFlowDirty(true)
  }
  const deleteFlowRow = (i: number) => {
    setFlowRows((rows) => rows.filter((_, ri) => ri !== i))
    setFlowDirty(true)
  }

  // ── Process Flow: Grid mode ───────────────────────────────────────────────
  // Alternate view for the common case where many variants share the exact
  // same station route and only differ in Process Time — lets the user fill
  // in a Variant x Station grid instead of re-typing the route per variant.
  // Reads/writes the same flowRows state as the detailed table (see
  // saveFlowMutation above); a variant only appears here if its station
  // sequence exactly matches sharedRoute, in order — anything else stays
  // detailed-table-only.
  const [flowViewMode, setFlowViewMode] = useState<'grid' | 'detailed'>('detailed')
  // The longest variant's route — its stations, plus which of them are a
  // split (station -> branch number; a station appears once per route).
  const initialRoute = (() => {
    const byVariant = new Map<string, FlowStepRow[]>()
    for (const r of flowRows) {
      if (!byVariant.has(r.variant)) byVariant.set(r.variant, [])
      byVariant.get(r.variant)!.push(r)
    }
    let best: FlowStepRow[] = []
    for (const seq of byVariant.values()) {
      if (seq.length > best.length) best = seq
    }
    return best
  })()
  const [sharedRoute, setSharedRoute] = useState<string[]>(() => initialRoute.map((r) => r.resource))
  // Stations of the shared route that belong to a split (set on the Canvas):
  // each job goes to only one station of the same branch number.
  const [routeBranch, setRouteBranch] = useState<Record<string, number>>(() =>
    Object.fromEntries(initialRoute.filter((r) => r.branch !== undefined).map((r) => [r.resource, r.branch!])))
  // Which route slots are showing the free-text "new station" input instead
  // of the existing-stations dropdown — set when the user picks "+ New
  // station..." for that slot.
  const [routeStationFreeText, setRouteStationFreeText] = useState<Set<number>>(new Set())

  interface GridRow { variant: string; times: Record<string, number> }

  function variantMatchesRoute(rows: FlowStepRow[], route: string[]): boolean {
    if (rows.length !== route.length) return false
    // Same stations in the same order, and the same splits.
    return rows.every((r, idx) => r.resource === route[idx] && r.branch === routeBranch[route[idx]])
  }

  const { gridRows, excludedVariants } = (() => {
    const byVariant = new Map<string, FlowStepRow[]>()
    for (const r of flowRows) {
      if (!r.variant.trim()) continue
      if (!byVariant.has(r.variant)) byVariant.set(r.variant, [])
      byVariant.get(r.variant)!.push(r)
    }
    const grid: GridRow[] = []
    const excluded: string[] = []
    for (const [variant, rows] of byVariant) {
      if (sharedRoute.length > 0 && variantMatchesRoute(rows, sharedRoute)) {
        const times: Record<string, number> = {}
        rows.forEach((r) => { times[r.resource] = r.duration })
        grid.push({ variant, times })
      } else {
        excluded.push(variant)
      }
    }
    return { gridRows: grid, excludedVariants: excluded }
  })()

  /** Replace a variant's rows (if any) with a fresh set built from the shared
   * route + grid times, leaving every other variant's rows — and this
   * variant's original position in the list — untouched, so editing a cell
   * doesn't reshuffle the grid's row order. */
  // `route` defaults to the shared route — a caller that has just changed it
  // passes the new one, since sharedRoute here is still the old value until
  // React re-renders (using it dropped a station added to the route).
  const applyGridRow = (variant: string, times: Record<string, number>, route: string[] = sharedRoute) => {
    setFlowRows((rows) => {
      const newRows: FlowStepRow[] = route.map((station) => ({
        variant,
        operation: station,
        resource: station,
        duration: times[station] ?? 0,
        ...(routeBranch[station] !== undefined ? { branch: routeBranch[station] } : {}),
      }))
      const firstIdx = rows.findIndex((r) => r.variant === variant)
      if (firstIdx === -1) return [...rows, ...newRows]
      const others = rows.filter((r) => r.variant !== variant)
      const insertAt = rows.slice(0, firstIdx).filter((r) => r.variant !== variant).length
      return [...others.slice(0, insertAt), ...newRows, ...others.slice(insertAt)]
    })
    setFlowDirty(true)
  }

  const updateGridCell = (variant: string, station: string, value: number) => {
    const existing = gridRows.find((g) => g.variant === variant)
    const times = { ...(existing?.times ?? {}), [station]: value }
    applyGridRow(variant, times)
  }

  const addGridVariant = () => {
    let n = 1
    let name = `variant${n}`
    const existingNames = new Set(flowRows.map((r) => r.variant))
    while (existingNames.has(name)) { n += 1; name = `variant${n}` }
    const times: Record<string, number> = {}
    sharedRoute.forEach((s) => { times[s] = 0 })
    applyGridRow(name, times)
  }

  const renameGridVariant = (oldName: string, newName: string) => {
    if (oldName === newName) return
    setFlowRows((rows) => rows.map((r) => (r.variant === oldName ? { ...r, variant: newName } : r)))
    setFlowDirty(true)
    // Quantities tab keeps its own variant list (variant_quantities is a
    // separate scenario field from processflow_data) — without this, renaming
    // a variant here would silently orphan its quantity/interval row under
    // the old name instead of following the rename.
    setQuantityRows((rows) => rows.map((r) => (r.variant === oldName ? { ...r, variant: newName } : r)))
    setQuantitiesDirty(true)
  }

  const deleteGridVariant = (variant: string) => {
    setFlowRows((rows) => rows.filter((r) => r.variant !== variant))
    setFlowDirty(true)
  }

  const addRouteStation = () => {
    setSharedRoute((route) => [...route, ''])
    setFlowDirty(true)
  }
  // Grid mode lets you type a brand-new station name directly into the route.
  // Without this, that name would only ever live in processflow_data — the
  // Stations tab (and thus the engine, which reads stations_data for
  // capacity/failure/repair config) would never know the station exists.
  const ensureStationExists = (name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    setStationRows((rows) => {
      if (rows.some((r) => r.name === trimmed)) return rows
      return [...rows, {
        name: trimmed, cfg: {
          capacity: 1, shifts_per_day: 1, operator_per_station: 1,
          'Failure rate': 0, 'Repair Time': 10, 'Setup time': 0,
          'Buffer Capacity': 0, 'Buffer Unlimited': true,
          'Buffer Discipline': 'FIFO', 'PM Schedule': 'Monthly',
          'Rework Probability (%)': 0, 'Material Shortage Probability (%)': 0,
        },
      }]
    })
    setStationsDirty(true)
  }
  // Appending a station to the shared route makes every variant that used to
  // match the (shorter) route fall out of Grid mode, since variantMatchesRoute
  // requires an exact length/order match — those variants would silently
  // vanish from the grid instead of gaining the new station. Extend each of
  // them to include the new station (0 min, same as a brand-new grid variant)
  // so they stay visible, matching the "extend, don't shrink" precedent used
  // for variant1/variant2 earlier.
  // Takes the route explicitly (rather than reading the sharedRoute closure)
  // because callers invoke this right after setSharedRoute — React batches
  // that update, so sharedRoute in the closure is still the OLD value at the
  // point this runs. Reading it directly here silently used stale data and
  // skipped variants that should have been extended.
  const extendExistingVariantsToStation = (updatedRoute: string[], newStation: string) => {
    const priorRoute = updatedRoute.filter((s) => s.trim() && s !== newStation)
    const byVariant = new Map<string, FlowStepRow[]>()
    for (const r of flowRows) {
      if (!r.variant.trim()) continue
      if (!byVariant.has(r.variant)) byVariant.set(r.variant, [])
      byVariant.get(r.variant)!.push(r)
    }
    for (const [variant, rows] of byVariant) {
      if (!variantMatchesRoute(rows, priorRoute)) continue
      const times: Record<string, number> = {}
      rows.forEach((r) => { times[r.resource] = r.duration })
      times[newStation] = newStepTime(newStation)
      applyGridRow(variant, times, updatedRoute.filter((s) => s.trim()))
    }
  }
  const updateRouteStation = (idx: number, value: string) => {
    // A station replaced inside a split keeps that place in the split.
    const old = sharedRoute[idx]
    if (old !== value && routeBranch[old] !== undefined) {
      setRouteBranch((b) => {
        const { [old]: branch, ...rest } = b
        return value ? { ...rest, [value]: branch } : rest
      })
    }
    setSharedRoute((route) => route.map((s, i) => (i === idx ? value : s)))
    setFlowDirty(true)
  }
  const removeRouteStation = (idx: number) => {
    const removed = sharedRoute[idx]?.trim()
    setSharedRoute((route) => route.filter((_, i) => i !== idx))
    setFlowDirty(true)
    if (!removed) return
    setRouteBranch((b) => {
      const { [removed]: _gone, ...rest } = b
      return rest
    })
    // Removing a station from the shared route means "this station is gone
    // from the process" — cascade the deletion everywhere it's referenced
    // (every variant's flow rows, Grid or Detailed, plus the Stations tab
    // entry itself), not just the route display. Otherwise Detailed mode and
    // the Stations tab would silently keep stale references to a station the
    // user just removed here.
    setFlowRows((rows) => rows.filter((r) => r.resource !== removed))
    setStationRows((rows) => rows.filter((r) => r.name !== removed))
    setStationsDirty(true)
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
    const oldName = quantityRows[i]?.variant
    setQuantityRows((rows) => rows.map((r, ri) => (ri === i ? { ...r, ...patch } : r)))
    setQuantitiesDirty(true)
    // Mirrors renameGridVariant's Process Flow -> Quantities sync (see there):
    // Quantities and Process Flow each keep their own independent variant
    // list, so a rename on either side has to be pushed into the other or
    // they silently drift apart under the same variant's two different names.
    if (patch.variant !== undefined && oldName && patch.variant !== oldName) {
      setFlowRows((rows) => rows.map((r) => (r.variant === oldName ? { ...r, variant: patch.variant! } : r)))
      setFlowDirty(true)
    }
  }
  const addQuantityRow = () => {
    setQuantityRows((rows) => [...rows, { variant: '', quantity: 0, interval: null }])
    setQuantitiesDirty(true)
  }
  const deleteQuantityRow = (i: number) => {
    setQuantityRows((rows) => rows.filter((_, ri) => ri !== i))
    setQuantitiesDirty(true)
  }

  const [stationsDirty, setStationsDirty] = useState(false)
  const [stationsSaved, setStationsSaved] = useState(false)

  // Live lookup used by the Setup Matrix datalist + other display code below —
  // reflects in-progress edits, not just the last-saved scenario.stations_data.
  const stations = Object.fromEntries(stationRows.map((r) => [r.name, r.cfg]))
  // A Conveyor is not a station: its row in Stations/Process Flow stays in
  // route order but is blank and locked; its own properties are edited in
  // the Conveyors table instead.
  const isConveyorCfg = (cfg: Record<string, any> | null | undefined) => cfg?.['Station Type'] === 'Conveyor'
  // Speed (m/min); an older conveyor saved with Length + Transport Time
  // instead gets it as Length / Transport Time.
  const conveyorSpeedOf = (cfg: Record<string, any>): number | undefined =>
    cfg['Conveyor Speed'] ?? ((cfg['Conveyor Length'] ?? 0) > 0 && (cfg['Transport Time'] ?? 0) > 0
      ? cfg['Conveyor Length'] / cfg['Transport Time']
      : undefined)
  // Transport Time (min) = Length / Speed; undefined until both are > 0.
  const conveyorTransportOf = (cfg: Record<string, any>): number | undefined => {
    const length = cfg['Conveyor Length'] ?? 0
    const speed = conveyorSpeedOf(cfg) ?? 0
    return length > 0 && speed > 0 ? length / speed : undefined
  }
  const conveyorCapacityInvalid = stationRows.some((r) => isConveyorCfg(r.cfg)
    && ((r.cfg['Conveyor Capacity'] ?? 1) < 1 || conveyorTransportOf(r.cfg) === undefined))
  const lockedBlank = <Input disabled value="" className="h-8 text-sm w-20 disabled:bg-gray-50" />

  const saveStationsMutation = useMutation({
    mutationFn: (rows: StationRow[]) => {
      const data: Record<string, any> = {}
      for (const r of rows) {
        if (!r.name.trim()) continue
        data[r.name.trim()] = r.cfg
      }
      // The Canvas drawing follows renamed stations.
      const renames = pendingRenames.current
      const layout = scenario.canvas_layout && Object.keys(renames).length > 0
        ? {
            ...scenario.canvas_layout,
            boxes: scenario.canvas_layout.boxes.map((b) => (renames[b.name] ? { ...b, name: renames[b.name] } : b)),
          }
        : undefined
      return scenariosApi.update(scenario.id, { stations_data: data, ...(layout ? { canvas_layout: layout } : {}) })
    },
    onSuccess: () => {
      pendingRenames.current = {}
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
  // Mirrors ensureStationExists' Process Flow -> Stations direction (see
  // there): a station added on the Stations tab should show up as a route
  // option in Process Flow's Grid mode too, not just live in stations_data
  // with no way to route jobs through it without manually retyping the name.
  // Fires on blur (final, committed name), not per keystroke, for the same
  // reason ensureStationExists does.
  // A brand-new station goes at the end of every product's route (before
  // End) — Process Flow and the Canvas both draw the line from the route.
  const addStationToRoute = (name: string, cfg: Record<string, any>) => {
    if (!isRouteStationCfg(cfg)) return
    appendStationToEveryRoute(name)
  }
  const addStationRow = () => {
    setStationRows((rows) => [...rows, {
      name: '', cfg: {
        capacity: 1, shifts_per_day: 1, operator_per_station: 1,
        'Failure rate': 0, 'Repair Time': 10, 'Setup time': 0,
        'Buffer Capacity': 0, 'Buffer Unlimited': true,
        'Buffer Discipline': 'FIFO', 'PM Schedule': 'Monthly',
        'Rework Probability (%)': 0, 'Material Shortage Probability (%)': 0,
      },
    }])
    setStationsDirty(true)
  }
  // Deleting a station removes it everywhere: the route of every product
  // (so Process Flow and the Canvas), the Grid route, and the Setup Matrix.
  const deleteStationRow = (i: number) => {
    const name = stationRows[i]?.name.trim()
    setStationRows((rows) => rows.filter((_, ri) => ri !== i))
    setStationsDirty(true)
    if (!name) return
    if (flowRows.some((r) => r.resource === name)) {
      setFlowRows((rows) => rows.filter((r) => r.resource !== name))
      setFlowDirty(true)
    }
    if (sharedRoute.includes(name)) {
      setSharedRoute((route) => route.filter((s) => s !== name))
      setFlowDirty(true)
    }
    setRouteBranch((b) => {
      if (b[name] === undefined) return b
      const { [name]: _gone, ...rest } = b
      return rest
    })
    if (matrixRows.some((r) => r.station === name)) {
      setMatrixRows((rows) => rows.filter((r) => r.station !== name))
      setMatrixDirty(true)
    }
  }

  // Renaming a station renames it everywhere it is used, so the route still
  // finds it: Process Flow rows, the Grid route, other stations' Exit
  // Controller entries and Worker Controller link, and the Setup Matrix.
  const nameAtFocus = useRef<string | null>(null)
  // Renames not saved yet (first name -> current), so the saved Canvas
  // drawing's box keeps its place and id under the new name.
  const pendingRenames = useRef<Record<string, string>>({})
  const renameStationEverywhere = (oldName: string, newName: string) => {
    for (const [from, to] of Object.entries(pendingRenames.current)) {
      if (to === oldName) pendingRenames.current[from] = newName
    }
    if (!Object.values(pendingRenames.current).includes(newName)) pendingRenames.current[oldName] = newName
    setFlowRows((rows) => rows.map((r) => (r.resource !== oldName ? r : {
      ...r,
      resource: newName,
      operation: r.operation === oldName ? newName : r.operation === `${oldName}_op` ? `${newName}_op` : r.operation,
    })))
    setSharedRoute((route) => route.map((s) => (s === oldName ? newName : s)))
    setRouteBranch((b) => {
      if (b[oldName] === undefined) return b
      const { [oldName]: branch, ...rest } = b
      return { ...rest, [newName]: branch }
    })
    const renameKey = (obj: unknown) => (obj && typeof obj === 'object' && oldName in obj
      ? Object.fromEntries(Object.entries(obj).map(([k, v]) => [k === oldName ? newName : k, v]))
      : obj)
    setStationRows((rows) => rows.map((r) => ({
      ...r,
      cfg: {
        ...r.cfg,
        ...(r.cfg['Exit Priorities'] ? { 'Exit Priorities': renameKey(r.cfg['Exit Priorities']) } : {}),
        ...(r.cfg['Exit Percentages'] ? { 'Exit Percentages': renameKey(r.cfg['Exit Percentages']) } : {}),
        ...(r.cfg['Worker Controller'] === oldName ? { 'Worker Controller': newName } : {}),
      },
    })))
    if (matrixRows.some((r) => r.station === oldName)) {
      setMatrixRows((rows) => rows.map((r) => (r.station === oldName ? { ...r, station: newName } : r)))
      setMatrixDirty(true)
    }
    setFlowDirty(true)
  }

  // Add a machine to a station's parallel group (the station starts one if
  // it isn't in a group yet). The new machine is a copy of this one — same
  // settings, and in Process Flow the same time for every variant — saved
  // as a station of its own, so any of it can then be changed.
  const isMachineCfg = (cfg: Record<string, any>) =>
    !['Conveyor', 'Connector', 'Buffer', 'Worker', 'Worker Controller', 'Workplace', 'Source', 'Drain'].includes(cfg['Station Type'])
  const addMachineToGroup = (i: number) => {
    const src = stationRows[i]
    const srcName = src.name.trim()
    if (!srcName) return
    const group: string = src.cfg['Parallel Group'] || srcName
    const members = new Set(stationRows.filter((r) => r.cfg['Parallel Group'] === group).map((r) => r.name))
    members.add(srcName)
    const taken = new Set(stationRows.map((r) => r.name))
    let k = members.size + 1
    while (taken.has(`${group} #${k}`)) k += 1
    const newName = `${group} #${k}`
    setStationRows((rows) => [
      ...rows.map((r, ri) => (ri === i ? { ...r, cfg: { ...r.cfg, 'Parallel Group': group } } : r)),
      { name: newName, cfg: { ...src.cfg, 'Parallel Group': group } },
    ])
    setStationsDirty(true)

    // A group's machines are one stop: consecutive rows sharing a branch
    // number, like a split. The new machine's row goes right after the
    // group's last machine, in every variant that visits the group.
    const newBranch = Math.max(0, ...flowRows.map((r) => r.branch ?? 0)) + 1
    setFlowRows((rows) => {
      const out: FlowStepRow[] = []
      rows.forEach((r, idx) => {
        out.push(r.resource === srcName && r.branch === undefined ? { ...r, branch: newBranch } : r)
        const next = rows[idx + 1]
        const lastOfStop = members.has(r.resource)
          && !(next && next.variant === r.variant && members.has(next.resource) && next.branch === r.branch)
        if (!lastOfStop) return
        const from = rows.find((x) => x.variant === r.variant && x.resource === srcName) ?? r
        out.push({
          variant: r.variant,
          operation: from.operation === srcName ? newName : from.operation === `${srcName}_op` ? `${newName}_op` : newName,
          resource: newName,
          duration: from.duration,
          branch: from.branch ?? newBranch,
        })
      })
      return out
    })
    if (sharedRoute.some((s) => members.has(s))) {
      const branch = routeBranch[srcName] ?? newBranch
      setSharedRoute((route) => {
        const last = Math.max(...route.map((s, ri) => (members.has(s) ? ri : -1)))
        return [...route.slice(0, last + 1), newName, ...route.slice(last + 1)]
      })
      setRouteBranch((b) => ({ ...b, [srcName]: branch, [newName]: branch }))
    }
    setFlowDirty(true)
  }

  // Stations tab order: a group's machines are listed together, where its
  // first machine is.
  const stationOrder = (() => {
    const out: number[] = []
    const done = new Set<number>()
    stationRows.forEach((r, i) => {
      if (done.has(i)) return
      const g = r.cfg['Parallel Group']
      const ids = g ? stationRows.flatMap((x, xi) => (x.cfg['Parallel Group'] === g ? [xi] : [])) : [i]
      for (const x of ids) { done.add(x); out.push(x) }
    })
    return out
  })()

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

  // Every tab's "Save changes" button saves ALL dirty tabs, not just its own —
  // so switching tabs before saving never silently drops edits.
  const anyDirty = stationsDirty || matrixDirty || flowDirty || operatorsDirty || quantitiesDirty
  const anySaving = saveStationsMutation.isPending || saveMatrixMutation.isPending
    || saveFlowMutation.isPending || saveOperatorsMutation.isPending || saveQuantitiesMutation.isPending
  const saveAllDirty = () => {
    if (stationsDirty) saveStationsMutation.mutate(stationRows)
    if (matrixDirty) saveMatrixMutation.mutate(matrixRows)
    if (flowDirty) saveFlowMutation.mutate(flowRows)
    if (operatorsDirty) saveOperatorsMutation.mutate(operatorRows)
    if (quantitiesDirty) saveQuantitiesMutation.mutate(quantityRows)
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
                {Object.values(stations).filter((c: any) => c['Station Type'] !== 'Source' && c['Station Type'] !== 'Drain').length} stations · {Object.keys(scenario.processflow_data ?? {}).length} variants · {Object.keys(operators).length} operators
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
                  {['Station', 'Capacity', 'Shifts/Day', 'Operators', 'Buffer Quantity', 'Unlimited Buffer', 'Buffer Order', 'PM Schedule', 'Rework %', 'Material Shortage %', ''].map(h => (
                    <th key={h} className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-widest pb-3 pr-4 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stationOrder.map((i, pos) => {
                  const row = stationRows[i]
                  const cfg = row.cfg
                  // Start (Source) and End (Drain) are pure routing markers
                  // Canvas writes into stations_data so the process flow has
                  // somewhere to begin/end — they take no capacity, no
                  // process time, and aren't a real station a user would
                  // configure, so they're hidden here. Index i is kept as
                  // the row's real position in stationRows (not
                  // re-numbered), since updateStationField/updateStationName
                  // /delete below all address rows by that index.
                  if (cfg['Station Type'] === 'Source' || cfg['Station Type'] === 'Drain') return null
                  const num = (field: string) => (
                    <Input
                      type="number"
                      value={cfg[field] ?? 0}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => updateStationField(i, field, Number(e.target.value))}
                      className="h-8 text-sm w-20"
                    />
                  )
                  return (
                    <tr key={i} className={`border-b border-gray-50 ${pos % 2 === 0 ? '' : 'bg-gray-50/50'}`}>
                      <td className="py-1.5 pr-4">
                        <Input
                          value={row.name}
                          onChange={(e) => updateStationName(i, e.target.value)}
                          onFocus={() => { nameAtFocus.current = row.name }}
                          onBlur={(e) => {
                            const oldName = nameAtFocus.current?.trim()
                            const newName = e.target.value.trim()
                            nameAtFocus.current = null
                            // A rename (not a brand-new station): follow it everywhere.
                            if (oldName && newName && oldName !== newName
                              && !stationRows.some((r, ri) => ri !== i && r.name.trim() === newName)) {
                              renameStationEverywhere(oldName, newName)
                              return
                            }
                            // A brand-new station (its name typed for the first time).
                            if (!oldName && newName) addStationToRoute(newName, cfg)
                          }}
                          placeholder="Station name"
                          className="h-8 text-sm w-36 font-medium"
                        />
                        {cfg['Parallel Group'] && (
                          <p className="text-[10px] text-cyan-700 mt-1 whitespace-nowrap">
                            Machine of group {cfg['Parallel Group']}
                          </p>
                        )}
                        {isMachineCfg(cfg) && row.name.trim() && (
                          <button
                            onClick={() => addMachineToGroup(i)}
                            className="flex items-center gap-1 text-[10px] font-medium text-blue-600 hover:text-blue-700 mt-1 whitespace-nowrap"
                          >
                            <PlusCircle className="h-3 w-3" />
                            Add machine
                          </button>
                        )}
                      </td>
                      {isConveyorCfg(cfg) ? (
                        // 9 locked blank cells: Capacity … Material Shortage %.
                        Array.from({ length: 9 }, (_, c) => (
                          <td key={c} className="py-1.5 pr-4">{lockedBlank}</td>
                        ))
                      ) : (<>
                      <td className="py-1.5 pr-4">{num('capacity')}</td>
                      <td className="py-1.5 pr-4">{num('shifts_per_day')}</td>
                      <td className="py-1.5 pr-4">{num('operator_per_station')}</td>
                      <td className="py-1.5 pr-4">
                        <Input
                          type="number"
                          disabled={!!cfg['Buffer Unlimited']}
                          value={cfg['Buffer Capacity'] ?? 0}
                          onFocus={(e) => e.target.select()}
                          onChange={(e) => updateStationField(i, 'Buffer Capacity', Number(e.target.value))}
                          className="h-8 text-sm w-20 disabled:bg-gray-50 disabled:text-gray-400"
                        />
                      </td>
                      <td className="py-1.5 pr-4 text-center">
                        {/* Buffer Capacity=0 now means literally zero room
                            (strict lockstep) to match Failure Rate/Repair
                            Time's plain-number convention. "Unlimited" needs
                            its own explicit flag instead of overloading 0 —
                            see backend Buffer Capacity gate in sim_core.py. */}
                        <input
                          type="checkbox"
                          checked={!!cfg['Buffer Unlimited']}
                          onChange={(e) => updateStationField(i, 'Buffer Unlimited', e.target.checked)}
                          className="h-4 w-4"
                        />
                      </td>
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
                      </>)}
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
                {stationRows.every((r) => r.cfg['Station Type'] === 'Source' || r.cfg['Station Type'] === 'Drain') && (
                  <tr>
                    <td colSpan={11} className="py-6 text-center text-gray-400 text-sm">
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
                {(stationsSaved || matrixSaved || flowSaved || operatorsSaved || quantitiesSaved) && <span className="text-xs text-green-600 font-medium">Saved</span>}
                <Button
                  size="sm"
                  disabled={!anyDirty || anySaving || conveyorCapacityInvalid}
                  onClick={saveAllDirty}
                  className="bg-blue-600 hover:bg-blue-700"
                >
                  <Save className="h-3.5 w-3.5 mr-1.5" />
                  {anySaving ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            </div>

              {/* Conveyors — a conveyor is not a station, so its own properties
                  live here (its Stations row above is blank and locked).
                  Saved with the Stations tab, on the same stations_data entry
                  the Canvas writes. */}
              <div className="mt-8 pt-6 border-t border-gray-100">
                <h3 className="text-sm font-bold text-gray-700 mb-1">Conveyors</h3>
                <p className="text-xs text-gray-400 mb-4">
                  Belts that move jobs between stations. Capacity is how many jobs the belt holds at once.
                </p>
                <div className="overflow-x-auto [color-scheme:light]">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        {['Conveyor', 'Length (m)', 'Speed (m/min)', 'Transport Time (min)', 'Breadth (m)', 'Height (m)', 'Capacity', 'Shifts/Day'].map(h => (
                          <th key={h} className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-widest pb-3 pr-4 whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {stationRows.map((row, i) => {
                        if (!isConveyorCfg(row.cfg)) return null
                        const speed = conveyorSpeedOf(row.cfg)
                        const transport = conveyorTransportOf(row.cfg)
                        const num = (field: string, fallback = 0, value?: number) => (
                          <Input
                            type="number"
                            value={value ?? row.cfg[field] ?? fallback}
                            onFocus={(e) => e.target.select()}
                            onChange={(e) => {
                              // An older conveyor saved with Length + Transport
                              // Time: fix its Speed first (Length / Transport
                              // Time), so the time is then Length / Speed.
                              if (row.cfg['Conveyor Speed'] === undefined && speed !== undefined && field !== 'Conveyor Speed') {
                                updateStationField(i, 'Conveyor Speed', speed)
                              }
                              if (row.cfg['Transport Time'] !== undefined) {
                                updateStationField(i, 'Transport Time', undefined)
                              }
                              updateStationField(i, field, Number(e.target.value))
                            }}
                            className="h-8 text-sm w-20"
                          />
                        )
                        return (
                          <tr key={i} className="border-b border-gray-50">
                            <td className="py-1.5 pr-4 font-medium text-gray-800 whitespace-nowrap">{row.name}</td>
                            <td className="py-1.5 pr-4">{num('Conveyor Length')}</td>
                            <td className="py-1.5 pr-4">{num('Conveyor Speed', 0, speed)}</td>
                            <td className="py-1.5 pr-4">
                              <Input disabled value={transport !== undefined ? String(Math.round(transport * 10000) / 10000) : '—'} className="h-8 text-sm w-20 disabled:bg-gray-50" />
                            </td>
                            <td className="py-1.5 pr-4">{num('Conveyor Width')}</td>
                            <td className="py-1.5 pr-4">{num('Conveyor Height')}</td>
                            <td className="py-1.5 pr-4">{num('Conveyor Capacity', 1)}</td>
                            <td className="py-1.5 pr-4">{num('shifts_per_day')}</td>
                          </tr>
                        )
                      })}
                      {!stationRows.some((r) => isConveyorCfg(r.cfg)) && (
                        <tr>
                          <td colSpan={8} className="py-6 text-center text-gray-400 text-sm">
                            No conveyors in this scenario — add one on the Canvas.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {conveyorCapacityInvalid && (
                  <p className="text-xs text-amber-600 mt-2">
                    Conveyor length and speed must be more than 0 and capacity 1 or more — the scenario can't be saved until they are.
                  </p>
                )}
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
                            onFocus={(e) => e.target.select()}
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
                    {(stationsSaved || matrixSaved || flowSaved || operatorsSaved || quantitiesSaved) && <span className="text-xs text-green-600 font-medium">Saved</span>}
                    <Button
                      size="sm"
                      disabled={!anyDirty || anySaving || conveyorCapacityInvalid}
                      onClick={saveAllDirty}
                      className="bg-blue-600 hover:bg-blue-700"
                    >
                      <Save className="h-3.5 w-3.5 mr-1.5" />
                      {anySaving ? 'Saving…' : 'Save changes'}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Process Flow tab */}
          {tab === 'processflow' && (
            <div>
              {/* Stations in the list that no product's route uses — the
                  engine and the Canvas only ever see the route. */}
              {stationRows
                .filter((r) => r.name.trim() && isRouteStationCfg(r.cfg) && !flowRows.some((f) => f.resource === r.name.trim()))
                .map((r) => (
                  <div key={r.name} className="flex items-center justify-between gap-3 mb-2 text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                    <span><span className="font-semibold">{r.name}</span> is in the station list but not on the route.</span>
                    <button
                      onClick={() => appendStationToEveryRoute(r.name)}
                      className="flex items-center gap-1 font-semibold text-blue-600 hover:text-blue-700 whitespace-nowrap"
                    >
                      <PlusCircle className="h-3.5 w-3.5" />
                      Add to end of route
                    </button>
                  </div>
                ))}
              <div className="flex items-center gap-1 mb-4 bg-gray-100 rounded-lg p-1 w-fit">
                <button
                  onClick={() => setFlowViewMode('grid')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${flowViewMode === 'grid' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  Grid mode
                </button>
                <button
                  onClick={() => setFlowViewMode('detailed')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${flowViewMode === 'detailed' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  Detailed mode
                </button>
              </div>

              {flowViewMode === 'grid' && (
                <div className="mb-6">
                  <p className="text-xs text-gray-400 mb-2">
                    Define the shared route once, then just fill in Process Time per variant. Only variants that follow this exact route (same stations, same order, same splits) show up here.
                    {Object.keys(routeBranch).length > 0 && ' [ A | B ] = a split: each job goes to only one of them, picked by the Exit Controller of the station before. Group ( A | B ) = machines of one parallel group, each with its own time.'}
                  </p>
                  <div className="flex items-center gap-2 flex-wrap mb-4">
                    {sharedRoute.map((station, idx) => {
                      const isKnownStation = stationRows.some((r) => r.name === station)
                      const showFreeText = routeStationFreeText.has(idx) || (station.trim() !== '' && !isKnownStation)
                      // A split's stations are drawn as [ A | B | C ].
                      const branch = routeBranch[station]
                      const sameSplitAsPrev = branch !== undefined && idx > 0 && routeBranch[sharedRoute[idx - 1]] === branch
                      const sameSplitAsNext = branch !== undefined && idx + 1 < sharedRoute.length && routeBranch[sharedRoute[idx + 1]] === branch
                      // A stop whose stations are all machines of one parallel group.
                      const routeGroup = branch !== undefined
                        ? stopParallelGroup(sharedRoute.filter((s) => routeBranch[s] === branch))
                        : undefined
                      return (
                        <div key={idx} className="flex items-center gap-1">
                          {idx > 0 && (
                            <span className="text-gray-300 text-sm">{sameSplitAsPrev ? '|' : '→'}</span>
                          )}
                          {routeGroup && !sameSplitAsPrev && <span className="text-xs font-semibold text-cyan-700">{routeGroup}</span>}
                          {branch !== undefined && !sameSplitAsPrev && <span className="text-blue-500 text-lg leading-none">{routeGroup ? '(' : '['}</span>}
                          {showFreeText ? (
                            <Input
                              value={station}
                              onChange={(e) => updateRouteStation(idx, e.target.value)}
                              onBlur={(e) => {
                                ensureStationExists(e.target.value)
                                const trimmed = e.target.value.trim()
                                if (trimmed) {
                                  const updatedRoute = sharedRoute.map((s, i) => (i === idx ? trimmed : s))
                                  extendExistingVariantsToStation(updatedRoute, trimmed)
                                }
                              }}
                              placeholder="Station name"
                              className="h-8 text-sm w-32"
                              autoFocus
                            />
                          ) : (
                            <select
                              value={station}
                              onChange={(e) => {
                                if (e.target.value === '__new__') {
                                  setRouteStationFreeText((set) => new Set(set).add(idx))
                                  updateRouteStation(idx, '')
                                  return
                                }
                                updateRouteStation(idx, e.target.value)
                                if (e.target.value) {
                                  const updatedRoute = sharedRoute.map((s, i) => (i === idx ? e.target.value : s))
                                  extendExistingVariantsToStation(updatedRoute, e.target.value)
                                }
                              }}
                              className="h-8 text-sm text-gray-800 bg-white border border-gray-200 rounded-md px-1.5 w-32"
                            >
                              <option value="">Select station</option>
                              {stationRows
                                .filter((r) => r.cfg['Station Type'] !== 'Source' && r.cfg['Station Type'] !== 'Drain')
                                .map((r) => (
                                  <option key={r.name} value={r.name}>{r.name}</option>
                                ))}
                              <option value="__new__">+ New station...</option>
                            </select>
                          )}
                          <button
                            onClick={() => removeRouteStation(idx)}
                            className="text-gray-300 hover:text-red-500"
                            aria-label="Remove station from route"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                          {branch !== undefined && !sameSplitAsNext && <span className="text-blue-500 text-lg leading-none">{routeGroup ? ')' : ']'}</span>}
                        </div>
                      )
                    })}
                    <button
                      onClick={addRouteStation}
                      className="flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"
                    >
                      <PlusCircle className="h-3.5 w-3.5" />
                      Add station to route
                    </button>
                  </div>

                  {sharedRoute.length > 0 && sharedRoute.every((s) => s.trim()) && (
                    <div className="overflow-x-auto [color-scheme:light]">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-gray-100">
                            <th className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-widest pb-3 pr-4">Variant</th>
                            {sharedRoute.map((station) => (
                              <th key={station} className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-widest pb-3 pr-4 whitespace-nowrap align-bottom">
                                {routeBranch[station] !== undefined && (() => {
                                  const g = stopParallelGroup(sharedRoute.filter((s) => routeBranch[s] === routeBranch[station]))
                                  return g
                                    ? <span className="block text-cyan-700 normal-case tracking-normal font-semibold">{g} · machine</span>
                                    : <span className="block text-blue-500 normal-case tracking-normal font-semibold">Split path</span>
                                })()}
                                {station} (min)
                              </th>
                            ))}
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {gridRows.map((g, gIdx) => (
                            <tr key={gIdx} className="border-b border-gray-50">
                              <td className="py-1.5 pr-4">
                                <Input
                                  value={g.variant}
                                  onChange={(e) => renameGridVariant(g.variant, e.target.value)}
                                  className="h-8 text-sm w-28 font-medium"
                                />
                              </td>
                              {sharedRoute.map((station) => isConveyorCfg(stations[station]) ? (
                                <td key={station} className="py-1.5 pr-4">{lockedBlank}</td>
                              ) : (
                                <td key={station} className="py-1.5 pr-4">
                                  <Input
                                    type="number"
                                    value={g.times[station] ?? 0}
                                    onFocus={(e) => e.target.select()}
                                    onChange={(e) => updateGridCell(g.variant, station, Number(e.target.value))}
                                    className="h-8 text-sm w-24"
                                  />
                                </td>
                              ))}
                              <td className="py-1.5 pr-4">
                                <button
                                  onClick={() => deleteGridVariant(g.variant)}
                                  className="text-gray-300 hover:text-red-500"
                                  aria-label="Delete variant"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </td>
                            </tr>
                          ))}
                          {gridRows.length === 0 && (
                            <tr>
                              <td colSpan={sharedRoute.length + 2} className="py-6 text-center text-gray-400 text-sm">
                                No variants use this route yet — add one below.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                      <button
                        onClick={addGridVariant}
                        className="flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700 mt-3"
                      >
                        <PlusCircle className="h-4 w-4" />
                        Add variant
                      </button>
                    </div>
                  )}

                  {excludedVariants.length > 0 && (
                    <p className="text-xs text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mt-4">
                      {excludedVariants.length} variant{excludedVariants.length > 1 ? 's' : ''} use{excludedVariants.length > 1 ? '' : 's'} a custom route ({excludedVariants.join(', ')}) — edit {excludedVariants.length > 1 ? 'them' : 'it'} in Detailed mode.
                    </p>
                  )}
                </div>
              )}

              {flowViewMode === 'detailed' && flowHasSplit && (
                // Route with its splits: [ A | B ] means each job goes to
                // only one of them, picked by the Exit Controller.
                <div className="mb-4 space-y-1">
                  {[...flowRouteByVariant].map(([variant, route]) => (
                    <p key={variant} className="text-xs text-gray-600">
                      <span className="font-semibold text-gray-800">{variant || 'Variant'}:</span>{' '}
                      {route.join(' → ')}
                    </p>
                  ))}
                  {flowHasRealSplit && (
                    <p className="text-[10px] text-gray-400">
                      [ A | B ] = each job goes to only one of them, picked by the Exit Controller of the station before.
                    </p>
                  )}
                  {flowHasGroup && (
                    <p className="text-[10px] text-gray-400">
                      Group ( A | B ) = machines of one parallel group: one shared waiting line, each job goes to one machine. Each machine has its own row below, with its own time and settings.
                    </p>
                  )}
                </div>
              )}

              {flowViewMode === 'detailed' && (
              <div className="overflow-x-auto [color-scheme:light] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-track]:bg-gray-50 [&::-webkit-scrollbar-thumb]:bg-blue-200 [&::-webkit-scrollbar-thumb]:rounded-full">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      {['Variant', 'Operation', 'Station / Resource', 'Process Time (min)', 'Enable Failures', 'Station Availability (%)', 'Setup Time', 'MTTR', 'Failure Policy', ''].map(h => (
                        <th key={h} className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-widest pb-3 pr-4 whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {flowRows.map((row, i) => {
                      // Station Availability (shifts_per_day) / Repair Time /
                      // Setup Time are per-STATION properties (one physical
                      // machine, shared across every variant that passes
                      // through it) — editing them here writes through to the
                      // matching row in stationRows, the same underlying data
                      // the Stations tab saves, rather than storing a
                      // separate per-flow-step copy.
                      const stationIdx = stationRows.findIndex((s) => s.name === row.resource)
                      const stationCfg = stationIdx >= 0 ? stationRows[stationIdx].cfg : null
                      const stationNum = (field: string) => (
                        <Input
                          type="number"
                          disabled={stationIdx < 0}
                          value={stationCfg ? (stationCfg[field] ?? 0) : ''}
                          placeholder={stationIdx < 0 ? '—' : undefined}
                          onChange={(e) => updateStationField(stationIdx, field, Number(e.target.value))}
                          className="h-8 text-sm w-20 disabled:bg-gray-50 disabled:text-gray-400"
                        />
                      )
                      return (
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
                            onChange={(e) => updateFlowRow(i, { resource: e.target.value })}
                            placeholder="Station"
                            className="h-8 text-sm w-32"
                          />
                          {flowSplitPlace[i] && (flowSplitPlace[i].group ? (
                            <p className="text-[10px] text-cyan-700 mt-1 whitespace-nowrap">
                              {flowSplitPlace[i].group} · machine {flowSplitPlace[i].pos} of {flowSplitPlace[i].count}
                            </p>
                          ) : (
                            <p className="text-[10px] text-blue-600 mt-1 whitespace-nowrap">
                              Split · path {flowSplitPlace[i].pos} of {flowSplitPlace[i].count}
                            </p>
                          ))}
                        </td>
                        {isConveyorCfg(stationCfg) ? (
                          // Process Time … Failure Policy: 6 locked blank cells.
                          Array.from({ length: 6 }, (_, c) => (
                            <td key={c} className="py-1.5 pr-4">{lockedBlank}</td>
                          ))
                        ) : (<>
                        <td className="py-1.5 pr-4">
                          <Input
                            type="number"
                            value={row.duration}
                            onChange={(e) => updateFlowRow(i, { duration: Number(e.target.value) })}
                            className="h-8 text-sm w-24"
                          />
                        </td>
                        <td className="py-1.5 pr-4 text-center">
                          {/* PDF section 13's panel: an explicit on/off switch
                              for this station's whole failure/PM simulation —
                              passed straight to the engine as "Enable
                              Failures" (sim_core.py's _init_resources).
                              Absent/unset defaults to true (failures on),
                              unchanged behavior for every existing scenario —
                              only an explicit uncheck here disables it. */}
                          <input
                            type="checkbox"
                            disabled={stationIdx < 0}
                            checked={stationCfg ? stationCfg['Enable Failures'] !== false : true}
                            onChange={(e) => updateStationField(stationIdx, 'Enable Failures', e.target.checked)}
                            className="h-4 w-4"
                          />
                        </td>
                        <td className="py-1.5 pr-4">
                          {stationCfg && stationCfg['Enable Failures'] !== false ? (
                            <div className="relative w-24">
                              <AvailabilityPctField
                                stationKey={row.resource}
                                value={Math.round(estimateAvailabilityPct(stationCfg['Failure rate'], stationCfg['Repair Time'], stationCfg['MTBF']) * 100) / 100}
                                onCommit={(pct) => updateStationField(
                                  stationIdx,
                                  'MTBF',
                                  availabilityPctToMtbf(pct, stationCfg['Repair Time']),
                                )}
                              />
                              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">%</span>
                            </div>
                          ) : (
                            <span className="text-gray-300 text-xs">—</span>
                          )}
                        </td>
                        <td className="py-1.5 pr-4">{stationNum('Setup time')}</td>
                        <td className="py-1.5 pr-4">
                          {/* Changing MTTR alone must NOT silently distort the
                              Availability % already set — MTBF is a frozen
                              value computed at the moment Availability % was
                              last typed (see availabilityPctToMtbf below), so
                              naively only updating Repair Time here would
                              leave that stale MTBF paired with a new MTTR,
                              silently changing the displayed Availability %
                              with no indication anything shifted (e.g. typing
                              85%+MTTR=2 saves MTBF=11.33; later changing MTTR
                              to 1 alone would silently show ~91.9%, not 85%).
                              Re-deriving MTBF from the CURRENTLY DISPLAYED
                              Availability % whenever MTTR changes keeps that
                              % fixed — the PDF's own "Availability+MTTR is
                              the stable pair" model — treating MTTR edits as
                              "same reliability, different repair time"
                              instead of "same breakdown timing, new %". */}
                          <Input
                            type="number"
                            disabled={stationIdx < 0 || (stationCfg ? stationCfg['Enable Failures'] === false : false)}
                            value={stationCfg ? (stationCfg['Repair Time'] ?? 0) : ''}
                            placeholder={stationIdx < 0 ? '—' : undefined}
                            onFocus={(e) => e.target.select()}
                            onChange={(e) => {
                              const newMttr = Number(e.target.value)
                              if (stationCfg && stationCfg['MTBF'] != null && (stationCfg['MTBF'] as number) > 0) {
                                const currentPct = estimateAvailabilityPct(
                                  stationCfg['Failure rate'], stationCfg['Repair Time'], stationCfg['MTBF'],
                                )
                                updateStationField(stationIdx, 'MTBF', availabilityPctToMtbf(currentPct, newMttr))
                              }
                              updateStationField(stationIdx, 'Repair Time', newMttr)
                            }}
                            className="h-8 text-sm w-20 disabled:bg-gray-50 disabled:text-gray-400"
                          />
                        </td>
                        <td className="py-1.5 pr-4">
                          {/* What happens to a part still in progress when this
                              station's machine fails mid-operation — passed
                              straight to the engine as "Failure Policy"
                              (backend/engine/machine.py's FailurePolicy enum).
                              Unset/omitted defaults to Resume, same as today. */}
                          <select
                            disabled={stationIdx < 0 || (stationCfg ? stationCfg['Enable Failures'] === false : false)}
                            value={stationCfg ? (stationCfg['Failure Policy'] || 'resume') : 'resume'}
                            onChange={(e) => updateStationField(stationIdx, 'Failure Policy', e.target.value)}
                            className="h-8 text-sm text-gray-800 bg-white border border-gray-200 rounded-md px-1.5 disabled:bg-gray-50 disabled:text-gray-400"
                            title="What happens to a part already in progress when this machine fails"
                          >
                            <option value="resume">Resume</option>
                            <option value="restart">Restart</option>
                            <option value="scrap">Scrap</option>
                          </select>
                        </td>
                        </>)}
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
                      )
                    })}
                    {flowRows.length === 0 && (
                      <tr>
                        <td colSpan={10} className="py-6 text-center text-gray-400 text-sm">
                          No process flow steps yet — add one below.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              )}

              <div className="flex items-center justify-between mt-4">
                {flowViewMode === 'detailed' ? (
                  <button
                    onClick={addFlowRow}
                    className="flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700"
                  >
                    <PlusCircle className="h-4 w-4" />
                    Add step
                  </button>
                ) : <span />}
                <div className="flex items-center gap-3">
                  {(stationsSaved || matrixSaved || flowSaved || operatorsSaved || quantitiesSaved) && <span className="text-xs text-green-600 font-medium">Saved</span>}
                  <Button
                    size="sm"
                    disabled={!anyDirty || anySaving || conveyorCapacityInvalid}
                    onClick={saveAllDirty}
                    className="bg-blue-600 hover:bg-blue-700"
                  >
                    <Save className="h-3.5 w-3.5 mr-1.5" />
                    {anySaving ? 'Saving…' : 'Save changes'}
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
                          onFocus={(e) => e.target.select()}
                          onChange={(e) => updateOperatorRow(i, { skillRating: Number(e.target.value) })}
                          className="h-8 text-sm w-24"
                        />
                      </td>
                      <td className="py-1.5 pr-4">
                        <Input
                          type="number"
                          value={row.availability}
                          onFocus={(e) => e.target.select()}
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
                  {(stationsSaved || matrixSaved || flowSaved || operatorsSaved || quantitiesSaved) && <span className="text-xs text-green-600 font-medium">Saved</span>}
                  <Button
                    size="sm"
                    disabled={!anyDirty || anySaving || conveyorCapacityInvalid}
                    onClick={saveAllDirty}
                    className="bg-blue-600 hover:bg-blue-700"
                  >
                    <Save className="h-3.5 w-3.5 mr-1.5" />
                    {anySaving ? 'Saving…' : 'Save changes'}
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
                          onFocus={(e) => e.target.select()}
                          onChange={(e) => updateQuantityRow(i, { quantity: Number(e.target.value) })}
                          className="h-8 text-sm w-24"
                        />
                      </td>
                      <td className="py-1.5 pr-4">
                        <Input
                          type="number"
                          value={row.interval ?? ''}
                          placeholder="—"
                          onFocus={(e) => e.target.select()}
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
                  {(stationsSaved || matrixSaved || flowSaved || operatorsSaved || quantitiesSaved) && <span className="text-xs text-green-600 font-medium">Saved</span>}
                  <Button
                    size="sm"
                    disabled={!anyDirty || anySaving || conveyorCapacityInvalid}
                    onClick={saveAllDirty}
                    className="bg-blue-600 hover:bg-blue-700"
                  >
                    <Save className="h-3.5 w-3.5 mr-1.5" />
                    {anySaving ? 'Saving…' : 'Save changes'}
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

// ─── Page ─────────────────────────────────────────────────────────────────────

type StatusFilter = 'all' | CardStatus
const FILTERS: StatusFilter[] = ['all', 'completed', 'running', 'stopped', 'failed', 'none']

export default function ScenarioManager() {
  const [uploadOpen, setUploadOpen] = useState(false)
  const [viewScenario, setViewScenario] = useState<Scenario | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ScenarioListItem | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<StatusFilter>('all')
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { setActiveScenario, setActiveRun, showToast, setJustReset } = useAppStore()

  const handleViewFile = async (id: number) => {
    try {
      const full = await scenariosApi.get(id)
      setViewScenario(full)
    } catch {
      showToast('Could not load scenario data', 'error')
    }
  }

  const PAGE_SIZE = 50
  const [page, setPage] = useState(1)

  const { data: scenarios = [], isLoading } = useQuery({
    queryKey: ['scenarios', page],
    queryFn: () => scenariosApi.list(0, page * PAGE_SIZE),
  })

  const { data: totalCount = 0 } = useQuery({
    queryKey: ['scenarios-count'],
    queryFn: scenariosApi.count,
  })

  const hasMore = scenarios.length < totalCount

  // Search runs on what is loaded; the status chips and card details come
  // from each scenario's summary (counts + newest run), fetched once and cached.
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = scenarios.filter((s) => !q || s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q))
    return [...list].sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at))
  }, [scenarios, search])

  const summaries = useQueries({
    queries: searched.map((s) => ({
      queryKey: ['scenario-summary', s.id, s.updated_at],
      queryFn: () => fetchScenarioSummary(s.id),
      staleTime: 60_000,
    })),
  })
  const summaryOf = new Map(searched.map((s, i) => [s.id, summaries[i]?.data]))
  const counts: Record<StatusFilter, number> = { all: searched.length, completed: 0, running: 0, stopped: 0, failed: 0, none: 0 }
  summaryOf.forEach((sm) => { if (sm) counts[sm.status] += 1 })
  const shown = filter === 'all' ? searched : searched.filter((s) => summaryOf.get(s.id)?.status === filter)

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['scenarios'] })
    queryClient.invalidateQueries({ queryKey: ['scenarios-count'] })
    queryClient.invalidateQueries({ queryKey: ['scenario-summary'] })
  }

  const deleteMutation = useMutation({
    mutationFn: (id: number) => scenariosApi.delete(id),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: ['scenario-summary', id] })
      refresh()
      setDeleteTarget(null)
      showToast('Scenario deleted')
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  })

  const handleSelect = async (id: number) => {
    const full = await scenariosApi.get(id)
    setActiveScenario(full)
    setJustReset(false)
    navigate('/run')
  }

  return (
    <div className="min-h-full p-7">
      <div className="mx-auto max-w-[1280px]">

        {/* Header */}
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-ls-ink">Scenarios</h1>
            <p className="mt-0.5 text-[12.5px] text-ls-mute">
              {totalCount} scenario{totalCount !== 1 ? 's' : ''} saved
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ls-mute" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search scenarios…"
                className="h-[38px] w-56 pl-9"
              />
            </div>
            <Button variant="outline" onClick={() => setUploadOpen(true)} className="h-[38px]">
              <Upload className="h-4 w-4" />
              Import
            </Button>
            <Button
              onClick={() => { setActiveScenario(null); setActiveRun(null); setJustReset(false); navigate('/canvas') }}
              className="h-[38px]"
            >
              <Plus className="h-4 w-4" />
              New canvas
            </Button>
          </div>
        </div>

        {/* Status filter chips (counts cover what is loaded) */}
        {scenarios.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  'h-8 rounded-full px-3.5 text-[12.5px] font-semibold shadow-sm transition-colors',
                  filter === f ? 'bg-ls-dark text-ls-card' : 'bg-ls-card text-ls-ink2 hover:bg-ls-soft'
                )}
              >
                {f === 'all' ? 'All' : STATUS_LABEL[f]} · {counts[f]}
              </button>
            ))}
          </div>
        )}

        {/* Grid */}
        {isLoading ? (
          <div className="py-16 text-center text-ls-mute">Loading…</div>
        ) : scenarios.length === 0 ? (
          <div className="rounded-2xl bg-ls-card py-24 text-center shadow-md">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-ls-accent-soft">
              <FileText className="h-8 w-8 text-ls-accent" />
            </div>
            <p className="text-lg font-semibold text-ls-ink">No scenarios yet</p>
            <p className="mb-6 mt-1 text-sm text-ls-mute">
              Import a YAML/XLSX file or build one on the visual canvas.
            </p>
            <Button onClick={() => setUploadOpen(true)}>
              <Upload className="h-4 w-4" />
              Import scenario
            </Button>
          </div>
        ) : shown.length === 0 ? (
          <div className="rounded-2xl bg-ls-card py-16 text-center text-sm text-ls-mute shadow-md">
            No scenarios match{search ? ` “${search}”` : ''}{filter !== 'all' ? ` with status “${STATUS_LABEL[filter]}”` : ''}.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(270px,1fr))] gap-[18px]">
              {shown.map((s) => (
                <ScenarioCard
                  key={s.id}
                  scenario={s}
                  summary={summaryOf.get(s.id)}
                  onOpen={() => handleSelect(s.id)}
                  onView={() => handleViewFile(s.id)}
                  onDelete={() => setDeleteTarget(s)}
                />
              ))}
            </div>
            {hasMore && (
              <div className="mt-6 flex justify-center">
                <Button variant="outline" onClick={() => setPage((p) => p + 1)}>
                  Load more ({totalCount - scenarios.length} remaining)
                </Button>
              </div>
            )}
          </>
        )}

      </div>
      <UploadDialog open={uploadOpen} onClose={() => setUploadOpen(false)} />

      <Dialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) setDeleteTarget(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete scenario?</DialogTitle>
            <DialogDescription>
              “{deleteTarget?.name}” and its runs will be removed. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>

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
