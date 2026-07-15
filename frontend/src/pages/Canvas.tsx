import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactFlow, {
  addEdge, Background, Controls, MiniMap,
  useNodesState, useEdgesState,
  type Connection, type Edge, type Node, type NodeTypes, type ReactFlowInstance,
  Handle, Position, MarkerType,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Save, Plus, Trash2, Settings, Eye, Edit3, Play, ChevronLeft, ChevronRight } from 'lucide-react'
import { scenariosApi } from '@/api/scenarios'
import { useAppStore } from '@/store/useAppStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { StationNodeData, ScenarioCreate, StationConfig } from '@/types'

// ─── Colour helpers ───────────────────────────────────────────────────────────

function utilColor(u: number) {
  if (u >= 85) return '#ef4444'
  if (u >= 70) return '#f59e0b'
  if (u >= 40) return '#22c55e'
  return '#94a3b8'
}

function utilBorder(u: number) {
  if (u >= 85) return '#ef4444'
  if (u >= 70) return '#f59e0b'
  if (u >= 40) return '#22c55e'
  return '#d1d5db'
}

// ─── VIEW MODE node ───────────────────────────────────────────────────────────

interface FlowNodeData {
  label: string       // operation name
  resource: string    // station name
  duration: number
  capacity?: number   // number of parallel machines
  machineIndex?: number   // 1-based index when split into parallel boxes
  machineCount?: number   // total parallel machines for this station
  utilization?: number
  jobs?: number
}

function FlowNode({ data, selected }: { data: FlowNodeData; selected: boolean }) {
  const u = data.utilization ?? 0
  const hasUtil = data.utilization !== undefined
  const border = selected ? '#3b82f6' : utilBorder(u)
  const topColor = utilColor(u)

  return (
    <div
      style={{ borderColor: border }}
      className="bg-white rounded-2xl border-2 min-w-[160px] shadow-md overflow-hidden"
    >
      <Handle type="target" position={Position.Left} style={{ background: '#94a3b8', width: 8, height: 8 }} />

      {/* Top colour stripe */}
      <div style={{ height: 4, background: topColor }} />

      <div className="px-4 py-3">
        {/* Operation name */}
        <div className="text-xs font-bold text-gray-900 truncate">{data.label}</div>
        {/* Station name + parallel-machine badge */}
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-[11px] text-gray-400 truncate">{data.resource}</span>
          {data.machineCount && data.machineCount > 1 && (
            <span
              className="text-[9px] font-bold px-1.5 py-0.5 rounded-md bg-indigo-100 text-indigo-700 shrink-0"
              title={`Parallel machine ${data.machineIndex} of ${data.machineCount}`}
            >
              ∥ parallel
            </span>
          )}
        </div>

        {/* Divider */}
        <div className="border-t border-gray-100 my-2" />

        {/* Duration + util */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-gray-400 font-medium">{data.duration} min</span>
          {hasUtil && (
            <span
              className="text-[10px] font-bold px-2 py-0.5 rounded-full"
              style={{ color: topColor, background: topColor + '20' }}
            >
              {u.toFixed(0)}%
            </span>
          )}
        </div>

        {/* Util progress bar */}
        {hasUtil && (
          <div className="mt-2 h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${Math.min(u, 100)}%`, background: topColor }}
            />
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Right} style={{ background: '#94a3b8', width: 8, height: 8 }} />
    </div>
  )
}

// ─── BUILD MODE node ──────────────────────────────────────────────────────────

function StationNode({ data, selected }: { data: StationNodeData; selected: boolean }) {
  return (
    <div className={`px-4 py-3 bg-white rounded-lg border-2 min-w-[140px] shadow-sm transition-colors ${selected ? 'border-blue-500' : 'border-gray-200'}`}>
      <Handle type="target" position={Position.Left} className="!bg-blue-400" />
      <div className="flex items-center gap-2 mb-1">
        <div className="w-2 h-2 rounded-full bg-blue-500" />
        <span className="text-sm font-semibold text-gray-900">{data.label}</span>
      </div>
      <div className="text-xs text-gray-400 space-y-0.5">
        <div>Capacity: {data.capacity}</div>
        <div>Cycle time: {data.cycleTime}m</div>
        <div>Operators: {data.operators}</div>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-blue-400" />
    </div>
  )
}

// ─── Entry / Exit endpoint node (View mode) ──────────────────────────────────

function EndpointNode({ data }: { data: { label: string; kind: 'entry' | 'exit' } }) {
  const isEntry = data.kind === 'entry'
  return (
    <div
      className="px-4 py-3 rounded-full border-2 shadow-md min-w-[120px] text-center"
      style={{
        borderColor: isEntry ? '#16a34a' : '#dc2626',
        background: isEntry ? '#f0fdf4' : '#fef2f2',
        position: 'relative',
        zIndex: 1000,
      }}
    >
      {!isEntry && <Handle type="target" position={Position.Left} style={{ background: '#dc2626', width: 8, height: 8 }} />}
      <div className="text-xs font-bold" style={{ color: isEntry ? '#16a34a' : '#dc2626' }}>
        {data.label}
      </div>
      {isEntry && <Handle type="source" position={Position.Right} style={{ background: '#16a34a', width: 8, height: 8 }} />}
    </div>
  )
}

const nodeTypes: NodeTypes = { station: StationNode, flow: FlowNode, endpoint: EndpointNode }

// ─── Property editor ─────────────────────────────────────────────────────────

function PropertyEditor({
  node, nodes, edges, onChange, onDelete, onSaveStation, onAddParallel,
}: {
  node: Node<StationNodeData>
  nodes: Node<StationNodeData>[]
  edges: Edge[]
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

  // Distinct destination STATIONS (base name, so parallel-machine boxes of the
  // same station don't count as separate branches) this node's edges lead to.
  // More than one distinct destination = this station needs an "Exit
  // controller type" (routing) to decide which one a finished job goes to.
  const destinationBases = Array.from(new Set(
    edges
      .filter((e) => e.source === node.id)
      .map((e) => nodes.find((n) => n.id === e.target))
      .filter((n): n is Node<StationNodeData> => !!n)
      .map((n) => baseStationName(n.data.label))
  ))
  const hasBranch = destinationBases.length > 1

  const routingMode = node.data.routingMode ?? 'round_robin'
  const routingWeights = node.data.routingWeights ?? {}
  const routingRules = node.data.routingRules ?? []
  const routingDefault = node.data.routingDefault ?? destinationBases[0]

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      {/* Header */}
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

      {/* Fields */}
      <div className="p-4 space-y-3">
        {fields.map(({ key, label, type }) => (
          <div key={key}>
            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
              {label}
            </label>
            <Input
              type={type}
              value={String(node.data[key as keyof StationNodeData])}
              onChange={(e) => onChange(node.id, { [key]: type === 'number' ? Number(e.target.value) : e.target.value })}
              className="h-8 text-sm rounded-lg border-gray-200 bg-gray-50 focus:bg-white [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
            />
          </div>
        ))}

        {/* Parallel machines — capacity is derived from the number of "Name #N"
            boxes for this station, so it's controlled here instead of a raw field. */}
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

        {/* Exit controller / routing — only shown once this station has more
            than one distinct next-station connected (a branch). Decides
            which downstream station a finished job goes to. */}
        {hasBranch && (
          <div className="pt-3 border-t border-gray-100">
            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
              Exit Controller ({destinationBases.length} paths)
            </label>
            <select
              value={routingMode}
              onChange={(e) => onChange(node.id, { routingMode: e.target.value as StationNodeData['routingMode'] })}
              className="w-full h-8 text-xs rounded-lg border border-gray-200 bg-gray-50 focus:bg-white px-2 mb-2"
            >
              <option value="round_robin">Round-robin</option>
              <option value="percentage">Percentage split</option>
              <option value="condition">Condition (by variant)</option>
              <option value="shortest_queue">Shortest queue</option>
            </select>

            {routingMode === 'percentage' && (
              <div className="space-y-1.5">
                {destinationBases.map((dest) => (
                  <div key={dest} className="flex items-center gap-2">
                    <span className="text-[11px] text-gray-500 flex-1 truncate">{dest}</span>
                    <Input
                      type="number"
                      value={String(routingWeights[dest] ?? '')}
                      onChange={(e) => onChange(node.id, {
                        routingWeights: { ...routingWeights, [dest]: Number(e.target.value) },
                      })}
                      placeholder="%"
                      className="h-7 w-16 text-xs rounded-lg border-gray-200 bg-gray-50 focus:bg-white"
                    />
                  </div>
                ))}
              </div>
            )}

            {routingMode === 'condition' && (
              <div className="space-y-2">
                {destinationBases.map((dest) => (
                  <div key={dest} className="flex items-center gap-2">
                    <Input
                      value={routingRules.find((r) => r.resource === dest)?.variantType ?? ''}
                      onChange={(e) => {
                        const others = routingRules.filter((r) => r.resource !== dest)
                        const value = e.target.value.trim()
                        onChange(node.id, {
                          routingRules: value ? [...others, { variantType: value, resource: dest }] : others,
                        })
                      }}
                      placeholder="Variant name…"
                      className="h-7 text-xs rounded-lg border-gray-200 bg-gray-50 focus:bg-white flex-1"
                    />
                    <span className="text-[10px] text-gray-400 shrink-0">→ {dest}</span>
                  </div>
                ))}
                <div>
                  <label className="text-[9px] text-gray-400 uppercase tracking-wide">Default (no match)</label>
                  <select
                    value={routingDefault}
                    onChange={(e) => onChange(node.id, { routingDefault: e.target.value })}
                    className="w-full h-7 text-xs rounded-lg border border-gray-200 bg-gray-50 focus:bg-white px-2 mt-1"
                  >
                    {destinationBases.map((dest) => <option key={dest} value={dest}>{dest}</option>)}
                  </select>
                </div>
              </div>
            )}

            {routingMode === 'shortest_queue' && (
              <p className="text-[10px] text-gray-400">Sends each job to whichever of the {destinationBases.length} paths currently has the least work waiting — no extra setup needed.</p>
            )}
            {routingMode === 'round_robin' && (
              <p className="text-[10px] text-gray-400">Cycles through the {destinationBases.length} paths in order — no extra setup needed.</p>
            )}
          </div>
        )}
      </div>

      {/* Save station button — applies the station's values and closes the panel.
          (Delete is available via the trash icon in the header.) */}
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

let nodeCounter = 0

// A step's `resource` is either a plain station name, or a routing dict
// ({mode, options, weights?/rules?}) for a branching "Exit Controller" step
// (see backend/engine/sim_core.py's _resolve_step_resource). Canvas only
// ever needs the list of real station names it can point at — never the
// raw dict, which must never be used as a string/object key or rendered
// directly (React throws trying to render a plain object as a child).
function stepResourceOptions(resource: string | { options?: string[] }): string[] {
  if (typeof resource === 'string') return [resource]
  return resource?.options ?? []
}

// ─── Flow builder from scenario ───────────────────────────────────────────────

function buildFlowGraph(
  processflow: Record<string, { operation: string; resource: string | { mode: string; options: string[] }; duration: number }[]>,
  variant: string,
  stationStats: Record<string, { utilization: number; jobs: number }>,
  stationsData: Record<string, { capacity?: number }> = {},
): { nodes: Node<FlowNodeData>[]; edges: Edge[] } {
  const steps = processflow[variant] ?? []
  const COL_GAP = 220
  const ROW_GAP = 120     // vertical spacing between parallel machines

  const nodes: Node<FlowNodeData>[] = []
  // stepNodeIds[i] = list of node ids in column i (one per parallel machine,
  // AND/OR one per branch option for an Exit Controller step)
  const stepNodeIds: string[][] = []

  steps.forEach((step, i) => {
    const options = stepResourceOptions(step.resource)
    const isBranch = options.length > 1
    const ids: string[] = []

    // Each branch option gets its own row-group; within a group, capacity>1
    // still fans out into stacked parallel-machine boxes as before.
    const groupCapacities = options.map((opt) => stationsData[opt]?.capacity ?? 1)
    const totalRows = groupCapacities.reduce((a, b) => a + b, 0)
    const BASE_Y = 100
    const stackHeight = (totalRows - 1) * ROW_GAP
    let rowCursor = 0

    options.forEach((resourceName, oi) => {
      const stat = stationStats[resourceName]
      const capacity = groupCapacities[oi]
      for (let m = 0; m < capacity; m++) {
        const id = `step_${i}_o${oi}_m${m}`
        ids.push(id)
        const label = isBranch
          ? (capacity > 1 ? `${resourceName} #${m + 1}` : resourceName)
          : (capacity > 1 ? `${step.operation} #${m + 1}` : step.operation)
        nodes.push({
          id,
          type: 'flow',
          position: { x: i * COL_GAP + 40, y: BASE_Y - stackHeight / 2 + rowCursor * ROW_GAP },
          data: {
            label,
            resource: capacity > 1 ? `${resourceName} #${m + 1}` : resourceName,
            duration: step.duration,
            capacity,
            machineIndex: capacity > 1 ? m + 1 : undefined,
            machineCount: capacity > 1 ? capacity : undefined,
            // per-machine util isn't available; show the station's overall util on each
            utilization: stat?.utilization,
            jobs: stat?.jobs,
          },
        })
        rowCursor += 1
      }
    })
    stepNodeIds.push(ids)
  })

  // Edges: fully connect every node in column i to every node in column i+1
  // (so a parallel station shows a fan-out / fan-in branch)
  const edges: Edge[] = []
  for (let i = 0; i < stepNodeIds.length - 1; i++) {
    for (const src of stepNodeIds[i]) {
      for (const tgt of stepNodeIds[i + 1]) {
        edges.push({
          id: `e_${src}__${tgt}`,
          source: src,
          target: tgt,
          type: 'smoothstep',
          animated: false,
          markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8' },
          style: { stroke: '#d1d5db', strokeWidth: 2 },
        })
      }
    }
  }

  // Synthetic Entry / Exit endpoint nodes — purely visual, mark where jobs
  // enter and leave the system. Entry feeds every first-column station;
  // every last-column station feeds Exit.
  if (stepNodeIds.length > 0) {
    const firstCol = stepNodeIds[0]
    const lastCol = stepNodeIds[stepNodeIds.length - 1]
    const firstColYs = firstCol.map((id) => nodes.find((n) => n.id === id)!.position.y)
    const lastColYs = lastCol.map((id) => nodes.find((n) => n.id === id)!.position.y)
    const entryY = firstColYs.reduce((a, b) => a + b, 0) / firstColYs.length
    const exitY = lastColYs.reduce((a, b) => a + b, 0) / lastColYs.length

    nodes.push({
      id: 'entry',
      type: 'endpoint',
      position: { x: -160, y: entryY },
      data: { label: 'Entry', kind: 'entry' },
    })
    nodes.push({
      id: 'exit',
      type: 'endpoint',
      position: { x: stepNodeIds.length * COL_GAP + 40, y: exitY },
      data: { label: 'Exit', kind: 'exit' },
    })

    for (const tgt of firstCol) {
      edges.push({
        id: `e_entry__${tgt}`,
        source: 'entry',
        target: tgt,
        type: 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed, color: '#16a34a' },
        style: { stroke: '#86efac', strokeWidth: 2 },
      })
    }
    for (const src of lastCol) {
      edges.push({
        id: `e_${src}__exit`,
        source: src,
        target: 'exit',
        type: 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed, color: '#dc2626' },
        style: { stroke: '#fca5a5', strokeWidth: 2 },
      })
    }
  }

  return { nodes, edges }
}

/** Convert a saved scenario's process flow into editable Build-mode nodes —
 *  mirrors View exactly: a station with capacity=2 is fanned out into 2 separate
 *  editable boxes (same layout/positions as buildFlowGraph), each fully editable.
 *  A step whose `resource` is a routing dict (Exit Controller branch) is fanned
 *  out into one node per option, and the routing config is restored onto the
 *  PRECEDING step's node(s) — that's where PropertyEditor reads/writes it from,
 *  since it's keyed off "this node's outgoing edges reach >1 destination". */
function buildEditableGraph(
  processflow: Record<string, { operation: string; resource: string | { mode: string; options: string[]; weights?: number[]; rules?: { if: string; resource: string }[]; default?: string }; duration: number }[]>,
  variant: string,
  stationsData: Record<string, StationConfig>,
): { nodes: Node<StationNodeData>[]; edges: Edge[] } {
  const steps = processflow[variant] ?? []
  const COL_GAP = 220
  const ROW_GAP = 120

  const nodes: Node<StationNodeData>[] = []
  const stepNodeIds: string[][] = []

  steps.forEach((step, i) => {
    const options = stepResourceOptions(step.resource)
    const isBranch = options.length > 1
    const groupCapacities = options.map((opt) => stationsData[opt]?.capacity ?? 1)
    const totalRows = groupCapacities.reduce((a, b) => a + b, 0)
    const BASE_Y = 100
    const stackHeight = (totalRows - 1) * ROW_GAP
    let rowCursor = 0
    const ids: string[] = []

    options.forEach((resourceName, oi) => {
      const cfg = stationsData[resourceName]
      const capacity = groupCapacities[oi]
      for (let m = 0; m < capacity; m++) {
        const id = `st_${i}_o${oi}_${resourceName}_m${m}`
        ids.push(id)
        nodes.push({
          id,
          type: 'station',
          position: { x: i * COL_GAP + 40, y: BASE_Y - stackHeight / 2 + rowCursor * ROW_GAP },
          data: {
            label: capacity > 1 ? `${resourceName} #${m + 1}` : resourceName,
            capacity,
            cycleTime: step.duration,
            operators: cfg?.operator_per_station ?? 1,
          },
        })
        rowCursor += 1
      }
    })
    stepNodeIds.push(ids)

    // Restore the routing config onto the PRECEDING step's node(s) — for a
    // branch at step i, it's step i-1's boxes whose outgoing edges fan out
    // to >1 destination, which is what PropertyEditor keys off.
    if (isBranch && typeof step.resource === 'object' && i > 0) {
      const routing = step.resource
      const routingWeights: Record<string, number> = {}
      if (routing.weights) {
        options.forEach((opt, oi) => { routingWeights[opt] = routing.weights![oi] ?? 1 })
      }
      const routingRules = (routing.rules ?? []).map((r) => {
        const match = /variant_type==['"]([^'"]*)['"]/.exec(r.if)
        return { variantType: match?.[1] ?? '', resource: r.resource }
      })
      for (const prevId of stepNodeIds[i - 1]) {
        const prevNode = nodes.find((n) => n.id === prevId)
        if (prevNode) {
          prevNode.data.routingMode = routing.mode as StationNodeData['routingMode']
          prevNode.data.routingWeights = routingWeights
          prevNode.data.routingRules = routingRules
          prevNode.data.routingDefault = routing.default
        }
      }
    }
  })

  // Fan every box in column i into every box in column i+1 (same as View)
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

/** Strip a trailing " #N" suffix used to label parallel-machine boxes, e.g. "Stitching #2" -> "Stitching" */
function baseStationName(label: string): string {
  return label.replace(/\s+#\d+$/, '')
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Canvas() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { activeScenario, activeRun, setActiveScenario, showToast } = useAppStore()
  const isDark = useAppStore(s => s.theme) === 'dark'

  // Memoized so React Flow always sees the same object reference across renders/HMR —
  // an unstable nodeTypes reference makes React Flow re-init internally on every
  // render, which breaks node dragging (clicks fall through to the pane instead).
  const stableNodeTypes = useMemo(() => nodeTypes, [])
  const stableEdgeTypes = useMemo(() => ({}), [])

  // Mode: 'view' shows scenario flow; 'build' is free-canvas builder
  const [mode, setMode] = useState<'view' | 'build'>(activeScenario ? 'view' : 'build')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [selectedVariant, setSelectedVariant] = useState<string>('')

  // Build mode state
  const [nodes, setNodes, onNodesChange] = useNodesState<StationNodeData>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [selectedNode, setSelectedNode] = useState<Node<StationNodeData> | null>(null)
  const [scenarioName, setScenarioName] = useState('')

  // View mode: derive graph from scenario
  const variants = useMemo(
    () => Object.keys(activeScenario?.processflow_data ?? {}),
    [activeScenario]
  )

  useEffect(() => {
    if (variants.length && !selectedVariant) setSelectedVariant(variants[0])
  }, [variants, selectedVariant])

  const stationStats = useMemo(() => {
    const out: Record<string, { utilization: number; jobs: number }> = {}
    for (const s of (activeRun?.station_stats ?? [])) {
      out[s.station_name] = { utilization: s.station_utilization, jobs: s.completed_jobs }
    }
    return out
  }, [activeRun])

  const { nodes: viewNodesBase, edges: viewEdges } = useMemo(() => {
    if (!activeScenario || !selectedVariant) return { nodes: [], edges: [] }
    return buildFlowGraph(activeScenario.processflow_data, selectedVariant, stationStats, activeScenario.stations_data)
  }, [activeScenario, selectedVariant, stationStats])

  // Only the Entry/Exit endpoint nodes are draggable/clickable in View mode —
  // regular flow nodes stay locked since they reflect the real process flow,
  // not something a user should be able to rearrange. Dragged positions are
  // tracked separately so switching variants/re-deriving viewNodesBase doesn't
  // wipe them out unnecessarily (keyed by node id, reset when variant changes).
  const [endpointPositions, setEndpointPositions] = useState<Record<string, { x: number; y: number }>>({})
  const [selectedEndpoint, setSelectedEndpoint] = useState<'entry' | 'exit' | null>(null)
  // Regular station ("flow") nodes are still non-draggable, but they ARE
  // clickable — clicking one opens a right panel with that station's stats.
  const [selectedFlowNodeId, setSelectedFlowNodeId] = useState<string | null>(null)

  useEffect(() => { setEndpointPositions({}); setSelectedEndpoint(null); setSelectedFlowNodeId(null) }, [selectedVariant])

  const viewNodes = useMemo(() => {
    return viewNodesBase.map((n) => {
      if (n.type !== 'endpoint') return { ...n, draggable: false, selectable: true }
      const overridePos = endpointPositions[n.id]
      return {
        ...n,
        position: overridePos ?? n.position,
        draggable: true,
        selectable: true,
      }
    })
  }, [viewNodesBase, endpointPositions])

  const selectedFlowNode = useMemo(
    () => viewNodes.find((n) => n.id === selectedFlowNodeId && n.type === 'flow') as Node<FlowNodeData> | undefined,
    [viewNodes, selectedFlowNodeId]
  )

  // Per-station completion-log breakdown (job_id + status) for the clicked
  // station, from the active run — same completion_log source as the Exit
  // panel's per-variant calc, just filtered to a single station.
  const selectedFlowNodeJobs = useMemo(() => {
    if (!selectedFlowNode || activeRun?.status !== 'completed') return []
    const log = (activeRun.result?.['completion_log'] as Record<string, { job_id?: string; status?: string; duration?: number }[]> | undefined) ?? {}
    return log[selectedFlowNode.data.resource] ?? []
  }, [selectedFlowNode, activeRun])

  // Opening/closing the right-hand panel resizes the flow container, but
  // ReactFlow's `fitView` prop only runs once on mount — without re-fitting,
  // the graph appears to have scrolled out of view once the panel toggles.
  const [viewFlowInstance, setViewFlowInstance] = useState<ReactFlowInstance | null>(null)
  const viewPanelOpen = selectedEndpoint !== null || selectedFlowNodeId !== null
  useEffect(() => {
    if (!viewFlowInstance) return
    const id = requestAnimationFrame(() => viewFlowInstance.fitView({ padding: 0.2 }))
    return () => cancelAnimationFrame(id)
  }, [viewFlowInstance, viewPanelOpen])

  // ── Entry panel: read-only per-variant Quantity/Interval display — editing
  // happens in Build mode instead. Re-seeded whenever the underlying scenario
  // data actually changes (not on every render) via the id/updated_at.
  interface EntryRow { variant: string; quantity: number; interval: number | null }
  const [entryRows, setEntryRows] = useState<EntryRow[]>([])
  const entrySeedKey = activeScenario ? `${activeScenario.id}-${activeScenario.updated_at}` : ''
  useEffect(() => {
    if (!activeScenario) return
    setEntryRows(
      Object.entries(activeScenario.variant_quantities ?? {}).map(([variant, qty]) => ({
        variant, quantity: qty, interval: activeScenario.variant_intervals?.[variant] ?? null,
      }))
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entrySeedKey])

  const entryCount = useMemo(() => entryRows.reduce((a, r) => a + (r.quantity || 0), 0), [entryRows])

  // ── Exit panel: per-station completed-job breakdown from the active run,
  // plus overall completed/in-progress/still-waiting split.
  const exitCount = activeRun?.status === 'completed' ? (activeRun.completed_jobs ?? 0) : 0
  const exitInProgress = activeRun?.in_progress_jobs ?? 0
  const exitStillWaiting = Math.max(0, entryCount - exitCount - exitInProgress)
  const exitPct = entryCount > 0 ? Math.round((exitCount / entryCount) * 100) : 0
  const exitPerStation = useMemo(
    () => [...(activeRun?.station_stats ?? [])]
      .sort((a, b) => b.completed_jobs - a.completed_jobs),
    [activeRun]
  )

  // Per-variant exit counts: a job "exits" once it completes the LAST step
  // of its own variant's process flow. Job IDs are formatted as
  // "<AlnumVariantName><id>" (see backend _format_job_id), so we match the
  // completion_log entries at that variant's final station(s) whose job_id
  // starts with the variant's alnum-stripped name, same convention the
  // engine itself uses to build the id.
  const exitPerVariant = useMemo(() => {
    if (!activeScenario || activeRun?.status !== 'completed') return []
    const log = (activeRun.result?.['completion_log'] as Record<string, { job_id?: string; status?: string }[]> | undefined) ?? {}
    return Object.entries(activeScenario.processflow_data ?? {}).map(([variant, steps]) => {
      const lastStep = steps[steps.length - 1]
      const finalStations = lastStep ? stepResourceOptions(lastStep.resource) : []
      const alnumPrefix = variant.replace(/[^a-zA-Z0-9]/g, '')
      let completed = 0
      for (const station of finalStations) {
        for (const e of log[station] ?? []) {
          if (e.job_id?.startsWith(alnumPrefix) && (e.status ?? 'Completed') === 'Completed') completed++
        }
      }
      const total = activeScenario.variant_quantities?.[variant] ?? 0
      return { variant, completed, total }
    })
  }, [activeScenario, activeRun])

  // When switching into Build mode with a scenario loaded, populate the canvas
  // with editable boxes for that scenario (only if Build is currently empty —
  // so we never clobber in-progress manual edits).
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

  // Edge (connection line) labeling — purely a visual note on the arrow
  // (e.g. "Pass" / "Fail" / "70%"), no effect on simulation behaviour.
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const updateEdgeLabel = (id: string, label: string) => {
    setEdges((eds) => eds.map((e) => (e.id === id ? { ...e, label } : e)))
  }

  const addNode = (label: string) => {
    nodeCounter++
    setNodes((nds) => {
      // Place the new box just to the right of the current rightmost node
      // (and vertically centered among existing nodes), instead of drifting
      // off screen as more nodes accumulate.
      const rightmostX = nds.length > 0 ? Math.max(...nds.map((n) => n.position.x)) : 40
      const avgY = nds.length > 0 ? nds.reduce((sum, n) => sum + n.position.y, 0) / nds.length : 160
      return [
        ...nds,
        {
          id: `station_${nodeCounter}`,
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

  /** Add another parallel machine for this station: duplicates the box, renames
   *  both to "Name #1" / "Name #2" (etc.), and wires the copy to the same
   *  predecessors/successors so it stays a proper parallel branch. */
  const addParallelMachine = (id: string) => {
    nodeCounter++
    setNodes((nds) => {
      const source = nds.find((n) => n.id === id)
      if (!source) return nds
      const base = baseStationName(source.data.label)
      const siblings = nds.filter((n) => baseStationName(n.data.label) === base)
      const nextIndex = siblings.length + 1

      // Ensure existing siblings (including the source) are labeled "#1", "#2", ...
      const renamed = nds.map((n) => {
        if (baseStationName(n.data.label) !== base) return n
        const idx = siblings.indexOf(n) + 1
        return { ...n, data: { ...n.data, label: `${base} #${idx}` } }
      })

      const newId = `station_${nodeCounter}`
      const stackOffset = 170   // vertical gap between stacked parallel-machine boxes
      const boxWidth = 180      // approx box width used for collision checks
      const boxHeight = 150     // approx box height used for collision checks

      // Find a Y below the source that doesn't overlap any existing box at a
      // similar X (so newly-added parallel machines never land on top of an
      // unrelated node group that happens to occupy that space).
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

    // Wire the new box to the same predecessors/successors as the source box
    setEdges((eds) => {
      const incoming = eds.filter((e) => e.target === id)
      const outgoing = eds.filter((e) => e.source === id)
      const newEdges: Edge[] = [
        ...incoming.map((e) => ({ ...e, id: `e_${e.source}__station_${nodeCounter}`, target: `station_${nodeCounter}` })),
        ...outgoing.map((e) => ({ ...e, id: `e_station_${nodeCounter}__${e.target}`, source: `station_${nodeCounter}` })),
      ]
      return [...eds, ...newEdges]
    })
    showToast('Parallel machine added')
  }

  const saveMutation = useMutation({
    mutationFn: () => {
      // Boxes sharing a base name (e.g. "Stitching #1" / "Stitching #2") represent
      // parallel machines of the SAME station — merge them into one station whose
      // capacity is the count of boxes sharing that name.
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

      // Walk the graph (which may branch/merge for parallel stations, AND may
      // branch for routing — "Exit controller type") into a single linear
      // list of steps, one per distinct base station name, in flow order.
      // A routing branch (one station with 2+ distinct next-stations, one of
      // which has a routingMode set) becomes ONE step whose `resource` is a
      // routing dict instead of a plain station name — the engine picks the
      // actual destination per job at run time. Only a simple "fan out, then
      // reconverge" shape is supported: after emitting the routing step, the
      // walk continues from just ONE of the branches (any one — they're
      // assumed to reconverge onto the same downstream stations).
      const hasIncoming = new Set(edges.map((e) => e.target))
      const entryNodes = nodes.filter((n) => !hasIncoming.has(n.id))
      const steps: ScenarioCreate['processflow_data'][string] = []
      const seenStations = new Set<string>()
      let frontier = entryNodes
      const visitedNodeIds = new Set<string>()
      while (frontier.length > 0) {
        const next: Node<StationNodeData>[] = []
        for (const n of frontier) {
          if (visitedNodeIds.has(n.id)) continue
          visitedNodeIds.add(n.id)
          const base = baseStationName(n.data.label)
          if (seenStations.has(base)) continue
          seenStations.add(base)

          const outgoing = edges.filter((e) => e.source === n.id)
          const destNodes = outgoing
            .map((e) => nodes.find((nn) => nn.id === e.target))
            .filter((nn): nn is Node<StationNodeData> => !!nn)
          const destBases = Array.from(new Set(destNodes.map((d) => baseStationName(d.data.label))))

          if (destBases.length > 1 && n.data.routingMode) {
            // Routing step: resource becomes a dict, not a plain string.
            const mode = n.data.routingMode
            const weights = n.data.routingWeights ?? {}
            const rules = n.data.routingRules ?? []
            steps.push({
              operation: `${base}_op`,
              duration: n.data.cycleTime,
              resource: {
                mode,
                options: destBases,
                ...(mode === 'percentage' ? { weights: destBases.map((d) => weights[d] ?? 1) } : {}),
                ...(mode === 'condition' ? {
                  rules: rules.map((r) => ({ if: `variant_type=='${r.variantType}'`, resource: r.resource })),
                  default: n.data.routingDefault ?? destBases[0],
                } : {}),
              },
            })
            // Continue the walk from only ONE branch (fan-out/reconverge —
            // both paths are assumed to lead back to the same downstream
            // stations, so following any single one is equivalent).
            const oneDest = destNodes.find((d) => baseStationName(d.data.label) === destBases[0])
            if (oneDest) next.push(oneDest)
          } else {
            steps.push({ operation: `${base}_op`, resource: base, duration: n.data.cycleTime })
            for (const d of destNodes) next.push(d)
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

  // Validate before saving so users get a clear, friendly message instead of a raw API error
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
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className={`relative border-r border-gray-100 bg-white flex flex-col shadow-sm transition-all duration-300 ${sidebarCollapsed ? 'w-10' : 'w-56'}`}>
        {/* Collapse toggle */}
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
                {/* Scenario name */}
                <div>
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Scenario</p>
                  <p className="text-sm font-semibold text-gray-800 truncate">{activeScenario.name}</p>
                </div>

                {/* Variant selector */}
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

                {/* Util overlay legend */}
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

                {/* Steps + run info */}
                <div className="pt-3 border-t border-gray-100">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-400">{viewNodes.length} steps</span>
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
      <div className="flex-1 flex flex-col min-h-0">
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
                <span className="text-xs text-gray-400">{viewNodes.length} operations</span>
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
          <div className="flex-1" style={{ height: '100%' }}>
            {mode === 'view' ? (
              viewNodes.length > 0 ? (
                <ReactFlow
                  nodes={viewNodes}
                  edges={viewEdges}
                  nodeTypes={stableNodeTypes}
                  edgeTypes={stableEdgeTypes}
                  fitView
                  fitViewOptions={{ padding: 0.2 }}
                  nodesConnectable={false}
                  zoomOnDoubleClick={false}
                  onInit={setViewFlowInstance}
                  onNodeDragStop={(_, node) => {
                    if (node.type !== 'endpoint') return
                    setEndpointPositions((p) => ({ ...p, [node.id]: node.position }))
                  }}
                  onNodeClick={(_, node) => {
                    if (node.type === 'endpoint') {
                      setSelectedEndpoint(node.id as 'entry' | 'exit')
                      setSelectedFlowNodeId(null)
                    } else if (node.type === 'flow') {
                      setSelectedFlowNodeId(node.id)
                      setSelectedEndpoint(null)
                    }
                  }}
                  onPaneClick={() => { setSelectedEndpoint(null); setSelectedFlowNodeId(null) }}
                >
                  <Background color={isDark ? '#334155' : '#e5e7eb'} gap={20} />
                  <Controls showInteractive={false} />
                  <MiniMap nodeColor={(n) => utilColor((n.data as FlowNodeData).utilization ?? 0)} maskColor={isDark ? 'rgba(15,23,42,0.7)' : 'rgba(240,244,255,0.7)'} />
                </ReactFlow>
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
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                nodeTypes={stableNodeTypes}
                onNodeClick={(_, node) => { setSelectedNode(node as Node<StationNodeData>); setSelectedEdgeId(null) }}
                onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); setSelectedNode(null) }}
                onPaneClick={() => { setSelectedNode(null); setSelectedEdgeId(null) }}
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

          {/* Entry / Exit endpoint panel (View mode) */}
          {mode === 'view' && selectedEndpoint === 'entry' && (
            <div className="w-72 border-l border-gray-200 bg-white p-4 overflow-y-auto">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-bold text-green-700 uppercase tracking-widest">Entry Station</p>
                <button
                  onClick={() => setSelectedEndpoint(null)}
                  className="w-6 h-6 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-50 transition-colors"
                >
                  ✕
                </button>
              </div>
              <p className="text-3xl font-bold text-gray-900">{entryCount}</p>
              <p className="text-[11px] text-gray-500 mb-4">jobs entered the system (all variants)</p>

              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Per-variant arrivals</p>
              <div className="space-y-2 mb-3">
                {entryRows.map((row, i) => (
                  <div key={i} className="border border-gray-100 rounded-lg p-2">
                    <p className="text-xs font-semibold text-gray-800 truncate mb-1.5">{row.variant || '(unnamed)'}</p>
                    <div className="flex items-center gap-4">
                      <div>
                        <p className="text-[9px] text-gray-400">Quantity</p>
                        <p className="text-sm font-semibold text-gray-800">{row.quantity}</p>
                      </div>
                      <div>
                        <p className="text-[9px] text-gray-400">Interval (min)</p>
                        <p className="text-sm font-semibold text-gray-800">{row.interval ?? 'all at once'}</p>
                      </div>
                    </div>
                  </div>
                ))}
                {entryRows.length === 0 && (
                  <p className="text-[11px] text-gray-400">No variants defined for this scenario.</p>
                )}
              </div>
              <p className="text-[10px] text-gray-400 mt-2">
                To change job counts/intervals, switch to Build mode.
              </p>
            </div>
          )}

          {mode === 'view' && selectedEndpoint === 'exit' && (
            <div className="w-72 border-l border-gray-200 bg-white p-4 overflow-y-auto">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-bold text-red-700 uppercase tracking-widest">Exit Station</p>
                <button
                  onClick={() => setSelectedEndpoint(null)}
                  className="w-6 h-6 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-50 transition-colors"
                >
                  ✕
                </button>
              </div>
              <p className="text-3xl font-bold text-gray-900">{exitCount}</p>
              <p className="text-[11px] text-gray-500 mb-1">jobs exited (completed)</p>

              {!activeRun && (
                <p className="text-[11px] text-gray-400 mt-3">Run a simulation to see exit data.</p>
              )}

              {activeRun && activeRun.status !== 'completed' && (
                <p className="text-[11px] text-gray-400 mt-3">Run #{activeRun.id} is {activeRun.status}…</p>
              )}

              {activeRun?.status === 'completed' && (
                <>
                  <div className="grid grid-cols-3 gap-2 my-3">
                    <div className="bg-green-50 border border-green-100 rounded-lg p-2 text-center">
                      <p className="text-sm font-bold text-green-700">{exitCount}</p>
                      <p className="text-[9px] text-gray-500">Completed</p>
                    </div>
                    <div className="bg-amber-50 border border-amber-100 rounded-lg p-2 text-center">
                      <p className="text-sm font-bold text-amber-700">{exitInProgress}</p>
                      <p className="text-[9px] text-gray-500">In progress</p>
                    </div>
                    <div className="bg-gray-50 border border-gray-100 rounded-lg p-2 text-center">
                      <p className="text-sm font-bold text-gray-600">{exitStillWaiting}</p>
                      <p className="text-[9px] text-gray-500">Still waiting</p>
                    </div>
                  </div>
                  <div className="mb-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] text-gray-400">Completion rate</span>
                      <span className="text-[10px] font-bold text-gray-700">{exitPct}%</span>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-green-500" style={{ width: `${Math.min(exitPct, 100)}%` }} />
                    </div>
                  </div>

                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Completed jobs by station</p>
                  <div className="space-y-1.5 mb-4">
                    {exitPerStation.map((s) => (
                      <div key={s.station_name} className="flex items-center justify-between text-xs">
                        <span className="text-gray-600 truncate">{s.station_name}</span>
                        <span className="font-semibold text-gray-800">{s.completed_jobs}</span>
                      </div>
                    ))}
                    {exitPerStation.length === 0 && (
                      <p className="text-[11px] text-gray-400">No station data available.</p>
                    )}
                  </div>

                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Per-variant exits</p>
                  <div className="space-y-2">
                    {exitPerVariant.map((v) => {
                      const pct = v.total > 0 ? Math.round((v.completed / v.total) * 100) : 0
                      return (
                        <div key={v.variant} className="border border-gray-100 rounded-lg p-2">
                          <div className="flex items-center justify-between mb-1">
                            <p className="text-xs font-semibold text-gray-800 truncate">{v.variant}</p>
                            <p className="text-xs font-semibold text-gray-700">{v.completed} / {v.total}</p>
                          </div>
                          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                            <div className="h-full rounded-full bg-red-400" style={{ width: `${Math.min(pct, 100)}%` }} />
                          </div>
                        </div>
                      )
                    })}
                    {exitPerVariant.length === 0 && (
                      <p className="text-[11px] text-gray-400">No variant data available.</p>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Station panel (View mode) — clicking a regular process-flow box */}
          {mode === 'view' && selectedFlowNode && (
            <div className="w-72 border-l border-gray-200 bg-white p-4 overflow-y-auto">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-bold text-indigo-700 uppercase tracking-widest">Station</p>
                <button
                  onClick={() => setSelectedFlowNodeId(null)}
                  className="w-6 h-6 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-50 transition-colors"
                >
                  ✕
                </button>
              </div>
              <p className="text-lg font-bold text-gray-900 truncate">{selectedFlowNode.data.label}</p>
              <p className="text-[11px] text-gray-500 mb-4">{selectedFlowNode.data.resource}</p>

              <div className="grid grid-cols-2 gap-2 mb-3">
                <div className="bg-gray-50 border border-gray-100 rounded-lg p-2 text-center">
                  <p className="text-sm font-bold text-gray-800">{selectedFlowNode.data.duration} min</p>
                  <p className="text-[9px] text-gray-500">Cycle time</p>
                </div>
                <div className="bg-gray-50 border border-gray-100 rounded-lg p-2 text-center">
                  <p className="text-sm font-bold text-gray-800">{selectedFlowNode.data.machineCount ?? 1}</p>
                  <p className="text-[9px] text-gray-500">Parallel machines</p>
                </div>
              </div>

              {selectedFlowNode.data.utilization !== undefined ? (
                <div className="mb-4">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-gray-400">Utilization</span>
                    <span
                      className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                      style={{ color: utilColor(selectedFlowNode.data.utilization), background: utilColor(selectedFlowNode.data.utilization) + '20' }}
                    >
                      {selectedFlowNode.data.utilization.toFixed(0)}%
                    </span>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${Math.min(selectedFlowNode.data.utilization, 100)}%`, background: utilColor(selectedFlowNode.data.utilization) }}
                    />
                  </div>
                </div>
              ) : (
                <p className="text-[11px] text-gray-400 mb-4">Run a simulation to see utilization data.</p>
              )}

              {activeRun?.status === 'completed' && (
                <>
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">
                    Jobs processed ({selectedFlowNodeJobs.length})
                  </p>
                  <div className="space-y-1.5">
                    {selectedFlowNodeJobs.slice(0, 50).map((j, i) => (
                      <div key={i} className="flex items-center justify-between text-xs border border-gray-100 rounded-lg px-2 py-1.5">
                        <span className="text-gray-600 truncate">{j.job_id ?? '—'}</span>
                        <span
                          className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 ml-2 ${
                            j.status === 'Completed' ? 'bg-green-50 text-green-700'
                            : j.status === 'In Progress' ? 'bg-amber-50 text-amber-700'
                            : 'bg-gray-50 text-gray-500'
                          }`}
                        >
                          {j.status ?? 'Completed'}
                        </span>
                      </div>
                    ))}
                    {selectedFlowNodeJobs.length === 0 && (
                      <p className="text-[11px] text-gray-400">No jobs recorded at this station.</p>
                    )}
                    {selectedFlowNodeJobs.length > 50 && (
                      <p className="text-[10px] text-gray-400 mt-1">Showing first 50 of {selectedFlowNodeJobs.length}. See Job Trace for the full list.</p>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Build mode property panel */}
          {mode === 'build' && selectedNode && (
            <div className="w-56 border-l border-gray-200 bg-white p-3 overflow-y-auto">
              <PropertyEditor
                node={selectedNode}
                nodes={nodes}
                edges={edges}
                onChange={updateNode}
                onDelete={deleteNode}
                onSaveStation={() => { setSelectedNode(null); showToast('Station saved') }}
                onAddParallel={addParallelMachine}
              />
            </div>
          )}

          {/* Edge label editor — purely a visual note on the connection line
              (e.g. "Pass" / "Fail" / "70%"), no effect on simulation logic. */}
          {mode === 'build' && selectedEdgeId && (
            <div className="w-56 border-l border-gray-200 bg-white p-3 overflow-y-auto">
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 bg-blue-50 border-b border-blue-100">
                  <div>
                    <p className="text-xs font-bold text-blue-900 leading-none">Connection</p>
                    <p className="text-[10px] text-blue-400 mt-0.5">Label this arrow</p>
                  </div>
                  <button
                    onClick={() => setSelectedEdgeId(null)}
                    className="w-6 h-6 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-50 transition-colors"
                  >
                    ✕
                  </button>
                </div>
                <div className="p-4 space-y-3">
                  <div>
                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                      Label
                    </label>
                    <Input
                      value={String(edges.find((e) => e.id === selectedEdgeId)?.label ?? '')}
                      onChange={(e) => updateEdgeLabel(selectedEdgeId, e.target.value)}
                      placeholder="e.g. Pass, Fail, 70%…"
                      className="h-8 text-sm rounded-lg border-gray-200 bg-gray-50 focus:bg-white"
                      autoFocus
                    />
                  </div>
                </div>
                <div className="px-4 pb-4">
                  <button
                    onClick={() => setSelectedEdgeId(null)}
                    className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition-colors"
                  >
                    Done
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

