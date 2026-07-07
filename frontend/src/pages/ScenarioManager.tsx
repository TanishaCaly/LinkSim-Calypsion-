import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Plus, Upload, Trash2, Play, FileText, Clock, Eye, X } from 'lucide-react'
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

function ScenarioViewModal({ scenario, onClose }: { scenario: Scenario; onClose: () => void }) {
  const [tab, setTab] = useState<ViewTab>('stations')

  const tabs: { key: ViewTab; label: string }[] = [
    { key: 'stations',    label: 'Stations' },
    { key: 'processflow', label: 'Process Flow' },
    { key: 'operators',   label: 'Operators' },
    { key: 'quantities',  label: 'Quantities' },
  ]

  const stations   = scenario.stations_data   ?? {}
  const processflow = scenario.processflow_data ?? {}
  const operators  = scenario.operators_data   ?? {}
  const quantities = scenario.variant_quantities ?? {}

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
                {Object.keys(stations).length} stations · {Object.keys(processflow).length} variants · {Object.keys(operators).length} operators
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
        <div className="flex-1 overflow-auto p-6 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-gray-50 [&::-webkit-scrollbar-thumb]:bg-blue-200 [&::-webkit-scrollbar-thumb]:rounded-full">

          {/* Stations tab */}
          {tab === 'stations' && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  {['Station', 'Capacity', 'Shifts/Day', 'Operators', 'Failure Rate', 'Repair Time', 'PM Schedule', 'Rework %', 'Material Shortage %'].map(h => (
                    <th key={h} className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-widest pb-3 pr-4">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(stations).map(([name, cfg]: [string, any], i) => (
                  <tr key={name} className={`border-b border-gray-50 ${i % 2 === 0 ? '' : 'bg-gray-50/50'}`}>
                    <td className="py-2.5 pr-4 font-medium text-gray-800">{name}</td>
                    <td className="py-2.5 pr-4 text-gray-600">{cfg.capacity ?? '—'}</td>
                    <td className="py-2.5 pr-4 text-gray-600">{cfg.shifts_per_day ?? '—'}</td>
                    <td className="py-2.5 pr-4 text-gray-600">{cfg.operator_per_station ?? '—'}</td>
                    <td className="py-2.5 pr-4 text-gray-600">{cfg['Failure rate'] ?? '—'}</td>
                    <td className="py-2.5 pr-4 text-gray-600">{cfg['Repair Time'] ?? '—'}</td>
                    <td className="py-2.5 pr-4 text-gray-600">{cfg['PM Schedule'] ?? '—'}</td>
                    <td className="py-2.5 pr-4 text-gray-600">{cfg['Rework Probability (%)'] ?? '—'}</td>
                    <td className="py-2.5 pr-4 text-gray-600">{cfg['Material Shortage Probability (%)'] ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Process Flow tab */}
          {tab === 'processflow' && (
            <div className="space-y-6">
              {Object.entries(processflow).map(([variant, steps]: [string, any]) => (
                <div key={variant}>
                  <h3 className="text-sm font-bold text-gray-700 mb-2 flex items-center gap-2">
                    <span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full text-xs border border-blue-100">{variant}</span>
                    <span className="text-xs text-gray-400 font-normal">{steps.length} steps</span>
                  </h3>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        {['Step', 'Operation', 'Station / Resource', 'Duration (min)'].map(h => (
                          <th key={h} className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-widest pb-2 pr-4">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {steps.map((step: any, i: number) => (
                        <tr key={i} className={`border-b border-gray-50 ${i % 2 === 0 ? '' : 'bg-gray-50/50'}`}>
                          <td className="py-2 pr-4 text-gray-400 tabular-nums">{i + 1}</td>
                          <td className="py-2 pr-4 font-medium text-gray-800">{step.operation}</td>
                          <td className="py-2 pr-4 text-gray-600">{step.resource}</td>
                          <td className="py-2 pr-4 text-gray-600">{step.duration}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}

          {/* Operators tab */}
          {tab === 'operators' && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  {['Operator', 'Skill Rating', 'Availability (%)'].map(h => (
                    <th key={h} className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-widest pb-3 pr-4">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(operators).map(([name, cfg]: [string, any], i) => (
                  <tr key={name} className={`border-b border-gray-50 ${i % 2 === 0 ? '' : 'bg-gray-50/50'}`}>
                    <td className="py-2.5 pr-4 font-medium text-gray-800">{name}</td>
                    <td className="py-2.5 pr-4 text-gray-600">{cfg['Skill Rating'] ?? '—'}</td>
                    <td className="py-2.5 pr-4 text-gray-600">{cfg['Availability (%)'] ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Quantities tab */}
          {tab === 'quantities' && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  {['Variant / Part', 'Quantity'].map(h => (
                    <th key={h} className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-widest pb-3 pr-4">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(quantities).map(([variant, qty]: [string, any], i) => (
                  <tr key={variant} className={`border-b border-gray-50 ${i % 2 === 0 ? '' : 'bg-gray-50/50'}`}>
                    <td className="py-2.5 pr-4 font-medium text-gray-800">{variant}</td>
                    <td className="py-2.5 pr-4 text-gray-600">{qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
        <ScenarioViewModal scenario={viewScenario} onClose={() => setViewScenario(null)} />
      )}
    </div>
  )
}
