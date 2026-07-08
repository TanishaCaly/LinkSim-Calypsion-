import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactFlow, {
  addEdge, Background, Controls, MiniMap,
  useNodesState, useEdgesState,
  type Connection, type Edge, type Node,
  type NodeTypes,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Save, Plus, Trash2, Settings, Eye, Edit3, Play, ChevronLeft, ChevronRight, Box, Layout } from 'lucide-react'
import { scenariosApi } from '@/api/scenarios'
import { useAppStore } from '@/store/useAppStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import Scene from '@/canvas3d/Scene'
import { buildScene3D } from '@/canvas3d/layout'
import { nodeTypes, defaultEdgeTypes } from './StationNode'
import type { StationNodeData, ScenarioCreate, StationConfig } from '@/types'

// ─── Colour helpers ───────────────────────────────────────────────────────────

function utilColor(u: number) {
  if (u >= 85) return '#ef4444'
  if (u >= 70) return '#f59e0b'
  if (u >= 40) return '#22c55e'
  return '#94a3b8'
}

// ─── Property editor ─────────────────────────────────────────────────────────

function PropertyEditor({
  node, onChange, onDelete, onSaveStation, onAddParallel,
}: {
  node: Node<StationNodeData>
  onChange: (id: string, data: Partial<StationNodeData>) => void
  onDelete: (id: string) => void
  onSaveStation: () => void
  onAddParallel: (id: string) => void
}) {
  const fields = [
    { key: 'label',     label: 'Name',            type: 'text'   },
    { key: 'cycleTime', label: 'Cycle Time (min)', type: 'number' },
    { key: 'operators', label: 'Operators',        type: 'number' },
  ]

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 bg-blue-50 border-b border-blue-100">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center">
            <Settings className="h-3.5 w-3.5 text-white" />
          </div>
          <div>
            <p className="text-xs font-bold text-blue-900 leading-none">{node.data.label}</p>
            <p className="text-[10px] text-blue-400 mt-0.5">Station properties</p>
          </div>
        </div>
        <button
          onClick={() => onDelete(node.id)}
          className="w-6 h-6 flex items-center justify-center rounded-lg text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="p-4 space-y-3">
        {fields.map(({ key, label, type }) => (
          <div key={key}>
            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
              {label}
            </label>
            <Input
              type={type}
              value={String(node.data[key as keyof StationNodeData])}
              onChange={(e) => {
                const raw = e.target.value
                if (type === 'number') {
                  // FIX: guard against NaN from an empty field or a partial
                  // value like "12." — previously this would write NaN into
                  // node data and render the literal string "NaN" in the input.
                  if (raw === '') return
                  const parsed = Number(raw)
                  if (Number.isNaN(parsed)) return
                  onChange(node.id, { [key]: parsed })
                } else {
                  onChange(node.id, { [key]: raw })
                }
              }}
              className="h-8 text-sm rounded-lg border-gray-200 bg-gray-50 focus:bg-white [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
            />
          </div>
        ))}

        <div>
          <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
            Parallel Machines
          </label>
          <button
            onClick={() => onAddParallel(node.id)}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[11px] font-semibold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg border border-indigo-100 transition-colors"
          >
            <Plus className="w-3 h-3" /> Add parallel machine
          </button>
        </div>
      </div>

      <div className="px-4 pb-4">
        <button
          onClick={onSaveStation}
          className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition-colors"
        >
          Save
        </button>
      </div>
    </div>
  )
}

// ─── Build mode palette ───────────────────────────────────────────────────────

const PALETTE_ITEMS = [
  { label: 'Station',    description: 'Processing station', color: 'bg-teal-50 text-teal-500 border-teal-400' },
  { label: 'Assembly',   description: 'Assembly station',   color: 'bg-green-50 text-green-500 border-green-400' },
  { label: 'Inspection', description: 'QA station',         color: 'bg-purple-50 text-purple-500 border-purple-400' },
  { label: 'Packaging',  description: 'Pack & dispatch',    color: 'bg-orange-50 text-orange-500 border-orange-400' },
]

// ─── Build mode graph builder ─────────────────────────────────────────────────

function buildEditableGraph(
  processflow: Record<string, { operation: string; resource: string; duration: number }[]>,
  variant: string,
  stationsData: Record<string, StationConfig>,
): { nodes: Node<StationNodeData>[]; edges: Edge[] } {
  const steps = processflow[variant] ?? []
  const COL_GAP = 220
  const ROW_GAP = 120
  const BASE_Y = 100

  const nodes: Node<StationNodeData>[] = []
  const stepNodeIds: string[][] = []

  steps.forEach((step, i) => {
    const cfg = stationsData[step.resource]
    const capacity = cfg?.capacity ?? 1
    const ids: string[] = []
    const stackHeight = (capacity - 1) * ROW_GAP
    for (let m = 0; m < capacity; m++) {
      const id = `st_${i}_${step.resource}_m${m}`
      ids.push(id)
      nodes.push({
        id,
        type: 'station',
        position: { x: i * COL_GAP + 40, y: BASE_Y - stackHeight / 2 + m * ROW_GAP },
        data: {
          label: capacity > 1 ? `${step.resource} #${m + 1}` : step.resource,
          capacity,
          cycleTime: step.duration,
          operators: cfg?.operator_per_station ?? 1,
        },
      })
    }
    stepNodeIds.push(ids)
  })

  const edges: Edge[] = []
  for (let i = 0; i < stepNodeIds.length - 1; i++) {
    for (const src of stepNodeIds[i]) {
      for (const tgt of stepNodeIds[i + 1]) {
        edges.push({ id: `e_${src}__${tgt}`, source: src, target: tgt })
      }
    }
  }

  return { nodes, edges }
}

function baseStationName(label: string): string {
  return label.replace(/\s+#\d+$/, '')
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Canvas() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { activeScenario, activeRun, setActiveScenario, showToast } = useAppStore()
  const isDark = useAppStore(s => s.theme) === 'dark'

  const [mode, setMode] = useState<'view' | 'build'>(activeScenario ? 'view' : 'build')
  const [viewMode, setViewMode] = useState<'3d' | '2d'>('3d')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [selectedVariant, setSelectedVariant] = useState<string>('')

  // Build mode state
  const [nodes, setNodes, onNodesChange] = useNodesState<StationNodeData>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [selectedNode, setSelectedNode] = useState<Node<StationNodeData> | null>(null)
  const [scenarioName, setScenarioName] = useState('')

  // FIX: was a module-level `let nodeCounter = 0`, which persists across
  // component mounts/unmounts and scenario switches within the same page
  // session (and can double-increment under React strict-mode double
  // invocation). A ref scopes the counter to this component instance.
  const nodeCounterRef = useRef(0)
  const nextNodeId = () => {
    nodeCounterRef.current += 1
    return nodeCounterRef.current
  }

  // View mode: derive 3D scene from scenario
  const variants = useMemo(
    () => Object.keys(activeScenario?.processflow_data ?? {}),
    [activeScenario]
  )

  useEffect(() => {
    if (variants.length && !selectedVariant) setSelectedVariant(variants[0])
  }, [variants, selectedVariant])

  const scene3D = useMemo(() => {
    if (!activeScenario || !selectedVariant) return { machines: [], operators: [], connections: [] }
    return buildScene3D(
      activeScenario.processflow_data,
      selectedVariant,
      activeScenario.stations_data,
      activeScenario.operators_data,
      activeRun?.station_stats ?? [],
    )
  }, [activeScenario, selectedVariant, activeRun])

  const completionLog = useMemo(() =>
    (activeRun?.result as Record<string, unknown> | null)?.completion_log as Record<string, unknown[]> | undefined,
    [activeRun]
  )

  const viewGraphData = useMemo(() => {
    if (!activeScenario || !selectedVariant) return { nodes: [], edges: [] }
    return buildEditableGraph(
      activeScenario.processflow_data,
      selectedVariant,
      activeScenario.stations_data
    )
  }, [activeScenario, selectedVariant])

  const stepCount = useMemo(() => {
    if (!activeScenario || !selectedVariant) return 0
    return (activeScenario.processflow_data[selectedVariant] ?? []).length
  }, [activeScenario, selectedVariant])

  // Build mode: populate from scenario on first switch
  useEffect(() => {
    if (mode !== 'build' || !activeScenario || !selectedVariant) return
    if (nodes.length > 0) return
    const { nodes: editNodes, edges: editEdges } = buildEditableGraph(
      activeScenario.processflow_data, selectedVariant, activeScenario.stations_data
    )
    if (editNodes.length === 0) return
    setNodes(editNodes)
    setEdges(editEdges)
    setScenarioName(activeScenario.name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, activeScenario, selectedVariant])

  // Build mode handlers
  const onConnect = useCallback(
    (params: Connection | Edge) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  )

  const addNode = (label: string) => {
    const id = nextNodeId()
    setNodes((nds) => {
      const rightmostX = nds.length > 0 ? Math.max(...nds.map((n) => n.position.x)) : 40
      const avgY = nds.length > 0 ? nds.reduce((sum, n) => sum + n.position.y, 0) / nds.length : 160
      return [
        ...nds,
        {
          id: `station_${id}`,
          type: 'station',
          position: { x: nds.length > 0 ? rightmostX + 220 : 80, y: avgY },
          data: { label, capacity: 1, cycleTime: 30, operators: 1 },
        },
      ]
    })
  }

  const updateNode = (id: string, patch: Partial<StationNodeData>) => {
    setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)))
    if (selectedNode?.id === id) setSelectedNode((p) => p ? { ...p, data: { ...p.data, ...patch } } : null)
  }

  const deleteNode = (id: string) => {
    setNodes((nds) => nds.filter((n) => n.id !== id))
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id))
    setSelectedNode(null)
  }

  const addParallelMachine = (id: string) => {
    const newIdNum = nextNodeId()
    const newId = `station_${newIdNum}`

    setNodes((nds) => {
      const source = nds.find((n) => n.id === id)
      if (!source) return nds
      const base = baseStationName(source.data.label)
      const siblings = nds.filter((n) => baseStationName(n.data.label) === base)
      const nextIndex = siblings.length + 1

      const renamed = nds.map((n) => {
        if (baseStationName(n.data.label) !== base) return n
        const idx = siblings.indexOf(n) + 1
        return { ...n, data: { ...n.data, label: `${base} #${idx}` } }
      })

      const stackOffset = 170
      const boxWidth = 180
      const boxHeight = 150

      const sameColumn = renamed.filter(
        (n) => n.id !== id && Math.abs(n.position.x - source.position.x) < boxWidth
      )
      let candidateY = source.position.y + stackOffset
      let collided = true
      while (collided) {
        collided = sameColumn.some((n) => Math.abs(n.position.y - candidateY) < boxHeight)
        if (collided) candidateY += stackOffset
      }

      const newNode: Node<StationNodeData> = {
        id: newId,
        type: 'station',
        position: { x: source.position.x, y: candidateY },
        data: { ...source.data, label: `${base} #${nextIndex}` },
      }
      return [...renamed, newNode]
    })

    setEdges((eds) => {
      const incoming = eds.filter((e) => e.target === id)
      const outgoing = eds.filter((e) => e.source === id)
      const newEdges: Edge[] = [
        ...incoming.map((e) => ({ ...e, id: `e_${e.source}__${newId}`, target: newId })),
        ...outgoing.map((e) => ({ ...e, id: `e_${newId}__${e.target}`, source: newId })),
      ]
      return [...eds, ...newEdges]
    })
    showToast('Parallel machine added')
  }

  const saveMutation = useMutation({
    mutationFn: () => {
      const stationsData: ScenarioCreate['stations_data'] = {}
      const capacityCount: Record<string, number> = {}
      nodes.forEach((n) => {
        const base = baseStationName(n.data.label)
        capacityCount[base] = (capacityCount[base] ?? 0) + 1
      })
      nodes.forEach((n) => {
        const base = baseStationName(n.data.label)
        stationsData[base] = {
          capacity: capacityCount[base], shifts_per_day: 1,
          operator_per_station: n.data.operators,
          'Failure rate': 0, 'Repair Time': 10, 'PM Schedule': 'Monthly',
          'Material Shortage Probability (%)': 0, 'Rework Probability (%)': 0,
          shift1: 'Op1', shift2: '', shift3: '', STATION_DOWNTIME: 0,
        }
      })

      const hasIncoming = new Set(edges.map((e) => e.target))
      const entryNodes = nodes.filter((n) => !hasIncoming.has(n.id))
      const steps: { operation: string; resource: string; duration: number }[] = []
      const seenStations = new Set<string>()
      let frontier = entryNodes
      const visitedNodeIds = new Set<string>()
      while (frontier.length > 0) {
        const next: Node<StationNodeData>[] = []
        for (const n of frontier) {
          if (visitedNodeIds.has(n.id)) continue
          visitedNodeIds.add(n.id)
          const base = baseStationName(n.data.label)
          if (!seenStations.has(base)) {
            seenStations.add(base)
            steps.push({ operation: `${base}_op`, resource: base, duration: n.data.cycleTime })
          }
          const outgoing = edges.filter((e) => e.source === n.id)
          for (const e of outgoing) {
            const tgt = nodes.find((nn) => nn.id === e.target)
            if (tgt) next.push(tgt)
          }
        }
        frontier = next
      }

      const variant = entryNodes.length > 0
        ? `product_${baseStationName(entryNodes[0].data.label)}`.toLowerCase()
        : 'product'
      const processflow: ScenarioCreate['processflow_data'] = { [variant]: steps }
      const variantQty: Record<string, number> = { [variant]: 200 }
      return scenariosApi.create({
        name: scenarioName, stations_data: stationsData, processflow_data: processflow,
        variant_quantities: variantQty,
        operators_data: { Op1: { 'Skill Rating': 3, 'Availability (%)': 100 } },
        simulation_config: {
          SIM_TIME: 480, SHIFT_DURATION: 480,
          SHIFT_1_START: 6, SHIFT_1_END: 14, SHIFT_2_START: 14, SHIFT_2_END: 22,
          SHIFT_3_START: 22, SHIFT_3_END: 6, STATION_DOWNTIME: 0, ACTIVE_PROCESSING_TIME: 480,
        },
      })
    },
    onSuccess: (scenario) => {
      queryClient.invalidateQueries({ queryKey: ['scenarios'] })
      setActiveScenario(scenario)
      showToast(`"${scenario.name}" saved`)
      navigate('/run')
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  })

  const handleSave = () => {
    if (!scenarioName.trim()) {
      showToast('Please enter a scenario name before saving', 'error')
      return
    }
    if (nodes.length === 0) {
      showToast('Add at least one station before saving', 'error')
      return
    }
    if (edges.length === 0) {
      showToast('Connect your stations before saving (drag from one box to the next)', 'error')
      return
    }
    saveMutation.mutate()
  }

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className={`relative border-r border-gray-100 bg-white flex flex-col shadow-sm transition-all duration-300 ${sidebarCollapsed ? 'w-10' : 'w-56'}`}>
        <button
          onClick={() => setSidebarCollapsed(c => !c)}
          className="absolute -right-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-white border border-gray-200 shadow-sm flex items-center justify-center hover:bg-gray-50 transition-colors z-10"
          title={sidebarCollapsed ? 'Expand panel' : 'Collapse panel'}
        >
          {sidebarCollapsed
            ? <ChevronRight className="h-3 w-3 text-gray-500" />
            : <ChevronLeft className="h-3 w-3 text-gray-500" />
          }
        </button>

        {!sidebarCollapsed && <>{/* Mode toggle */}
        <div className="px-4 pt-4 pb-3 border-b border-gray-100">
          <div className="flex rounded-xl border border-gray-200 overflow-hidden">
            <button
              onClick={() => setMode('view')}
              disabled={!activeScenario}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold transition-all ${
                mode === 'view' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-50'
              } disabled:opacity-40`}
            >
              <Eye className="h-3 w-3" /> View
            </button>
            <button
              onClick={() => setMode('build')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold transition-all ${
                mode === 'build' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-50'
              }`}
            >
              <Edit3 className="h-3 w-3" /> Build
            </button>
          </div>
        </div>

        {mode === 'view' ? (
          <div className="flex-1 p-4 space-y-4 overflow-auto">
            {activeScenario ? (
              <>
                <div>
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Scenario</p>
                  <p className="text-sm font-semibold text-gray-800 truncate">{activeScenario.name}</p>
                </div>

                <div>
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Variant</p>
                  <div className="space-y-1.5">
                    {variants.map((v) => (
                      <button
                        key={v}
                        onClick={() => setSelectedVariant(v)}
                        className={`w-full text-left px-3 py-2 rounded-xl text-xs font-medium transition-all border ${
                          selectedVariant === v
                            ? 'bg-blue-50 text-blue-700 border-blue-200'
                            : 'text-gray-600 hover:bg-gray-50 border-gray-100'
                        }`}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">View</p>
                  <div className="flex rounded-xl border border-gray-200 overflow-hidden">
                    <button
                      onClick={() => setViewMode('3d')}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold transition-all ${
                        viewMode === '3d' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-50'
                      }`}
                    >
                      <Box className="h-3 w-3" /> 3D
                    </button>
                    <button
                      onClick={() => setViewMode('2d')}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold transition-all ${
                        viewMode === '2d' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-50'
                      }`}
                    >
                      <Layout className="h-3 w-3" /> 2D
                    </button>
                  </div>
                </div>

                {activeRun?.status === 'completed' && (
                  <div className="pt-3 border-t border-gray-100">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Util. Overlay</p>
                    <div className="space-y-1.5">
                      {[
                        { color: '#94a3b8', label: '< 40% — Idle' },
                        { color: '#22c55e', label: '40–69% — Healthy' },
                        { color: '#f59e0b', label: '70–84% — High load' },
                        { color: '#ef4444', label: '≥ 85% — Bottleneck' },
                      ].map(({ color, label }) => (
                        <div key={label} className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full" style={{ background: color }} />
                          <span className="text-[11px] text-gray-500">{label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="pt-3 border-t border-gray-100">
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Operator Skill</p>
                  <div className="space-y-1.5">
                    {[
                      { color: '#3b82f6', label: '5 — Expert' },
                      { color: '#22c55e', label: '4 — High' },
                      { color: '#f59e0b', label: '3 — Medium' },
                      { color: '#f97316', label: '2 — Low' },
                      { color: '#ef4444', label: '1 — Beginner' },
                    ].map(({ color, label }) => (
                      <div key={label} className="flex items-center gap-2">
                        <div className="w-2 h-3 rounded-sm" style={{ background: color }} />
                        <span className="text-[11px] text-gray-500">{label}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="pt-3 border-t border-gray-100">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-400">{stepCount} steps</span>
                    {activeRun?.status === 'completed' && (
                      <span className="text-[10px] font-semibold text-blue-500 bg-blue-50 px-2 py-0.5 rounded-full">
                        Run #{activeRun.id} overlaid
                      </span>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <p className="text-xs text-gray-400 mt-2">No scenario loaded. Go to Scenarios and open one first.</p>
            )}
          </div>
        ) : (
          <div className="flex-1 p-4 overflow-auto">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Object Palette</p>
            <p className="text-[10px] text-gray-400 mb-3">Click to add to canvas</p>
            <div className="space-y-2">
              {PALETTE_ITEMS.map((item) => {
                const [bgColor, textColor, borderColor] = item.color.split(' ')
                return (
                  <button
                    key={item.label}
                    onClick={() => addNode(item.label)}
                    className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl border border-l-4 border-gray-100 hover:shadow-sm text-left transition-all group ${borderColor}`}
                  >
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${bgColor}`}>
                      <Plus className={`h-3.5 w-3.5 ${textColor}`} />
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-gray-800">{item.label}</div>
                      <div className="text-[10px] text-gray-400 mt-0.5">{item.description}</div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )}
        </>}
      </aside>

      {/* Canvas */}
      <div className="flex-1 flex flex-col">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 bg-white shadow-sm">
          {mode === 'view' ? (
            <>
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-gray-900">{activeScenario?.name ?? 'No scenario'}</span>
                {selectedVariant && (
                  <span className="text-xs font-medium text-blue-600 bg-blue-50 border border-blue-100 px-2.5 py-0.5 rounded-full">
                    {selectedVariant}
                  </span>
                )}
                <span className="text-xs text-gray-400">{stepCount} operations</span>
              </div>
              <div className="flex items-center gap-2">
                {activeRun?.status === 'completed' && (
                  <span className="text-xs font-semibold text-green-700 bg-green-50 border border-green-200 px-3 py-1 rounded-full">
                    Run #{activeRun.id} overlaid
                  </span>
                )}
                <Button onClick={() => navigate('/run')} className="bg-blue-600 hover:bg-blue-700 rounded-full px-4 shadow-sm">
                  <Play className="h-3.5 w-3.5 mr-1.5" />
                  Go to Results
                </Button>
              </div>
            </>
          ) : (
            <>
              <Input
                value={scenarioName}
                onChange={(e) => setScenarioName(e.target.value)}
                placeholder="Enter scenario name…"
                className="w-56 h-8 text-sm font-medium rounded-lg"
              />
              <span className="text-xs text-gray-400">{nodes.length} stations · {edges.length} connections</span>
              <Button
                disabled={saveMutation.isPending}
                onClick={handleSave}
                className="bg-blue-600 hover:bg-blue-700 rounded-full px-4 shadow-sm"
              >
                <Save className="h-3.5 w-3.5 mr-1.5" />
                {saveMutation.isPending ? 'Saving…' : 'Save Scenario'}
              </Button>
            </>
          )}
        </div>

        {/* Flow + property panel */}
        <div className="flex-1 flex min-h-0">
          <div className="flex-1 min-h-0">
            {mode === 'view' ? (
              viewMode === '3d' ? (
                scene3D.machines.length > 0 ? (
                  <Scene
                    machines={scene3D.machines}
                    operators={scene3D.operators}
                    connections={scene3D.connections}
                    stepLabels={scene3D.stepLabels}
                    stationsData={activeScenario!.stations_data}
                    operatorsData={activeScenario!.operators_data}
                    isDark={isDark}
                    completionLog={completionLog}
                  />
                ) : (
                  <div className="flex items-center justify-center h-full text-gray-400">
                    <div className="text-center">
                      <Eye className="h-12 w-12 text-gray-200 mx-auto mb-3" />
                      <p className="text-sm font-medium text-gray-500">
                        {activeScenario ? 'Select a variant to view the process flow' : 'No scenario loaded'}
                      </p>
                    </div>
                  </div>
                )
              ) : (
                viewGraphData.nodes.length > 0 ? (
                  <ReactFlow
                    nodes={viewGraphData.nodes}
                    edges={viewGraphData.edges}
                    nodeTypes={nodeTypes}
                    edgeTypes={defaultEdgeTypes}
                    nodesDraggable={false}
                    nodesConnectable={false}
                    elementsSelectable={false}
                    panOnDrag
                    onInit={(instance) => instance.fitView({ padding: 0.2 })}
                    proOptions={{ hideAttribution: true }}
                  >
                    <Background color={isDark ? '#334155' : undefined} />
                    <Controls />
                    <MiniMap nodeColor="#3b82f6" maskColor={isDark ? 'rgba(15,23,42,0.7)' : 'rgba(240,244,255,0.7)'} />
                  </ReactFlow>
                ) : (
                  <div className="flex items-center justify-center h-full text-gray-400">
                    <div className="text-center">
                      <Layout className="h-12 w-12 text-gray-200 mx-auto mb-3" />
                      <p className="text-sm font-medium text-gray-500">
                        {activeScenario ? 'Select a variant to view the process flow' : 'No scenario loaded'}
                      </p>
                    </div>
                  </div>
                )
              )
            ) : (
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                nodeTypes={nodeTypes}
                edgeTypes={defaultEdgeTypes}
                onNodeClick={(_, node) => setSelectedNode(node as Node<StationNodeData>)}
                onPaneClick={() => setSelectedNode(null)}
                nodesDraggable
                elementsSelectable
                panOnDrag
                selectionOnDrag={false}
                onInit={(instance) => instance.fitView({ padding: 0.2 })}
              >
                <Background color={isDark ? '#334155' : undefined} />
                <Controls />
                <MiniMap nodeColor="#3b82f6" maskColor={isDark ? 'rgba(15,23,42,0.7)' : 'rgba(240,244,255,0.7)'} />
              </ReactFlow>
            )}
          </div>

          {mode === 'build' && selectedNode && (
            <div className="w-56 border-l border-gray-200 bg-white p-3 overflow-y-auto">
              <PropertyEditor
                node={selectedNode}
                onChange={updateNode}
                onDelete={deleteNode}
                onSaveStation={() => { setSelectedNode(null); showToast('Station saved') }}
                onAddParallel={addParallelMachine}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}