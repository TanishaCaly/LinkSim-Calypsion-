import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactFlow, {
  addEdge, Background, Controls, MiniMap,
  useNodesState, useEdgesState,
  type Connection, type Edge, type Node, type NodeTypes, type ReactFlowInstance,
  Handle, Position, MarkerType,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  Save, Plus, Trash2, Settings, Eye, Edit3, Play, ChevronLeft, ChevronRight, Box, Layout as LayoutIcon, X,
} from 'lucide-react'
import { scenariosApi } from '@/api/scenarios'
import { useAppStore } from '@/store/useAppStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import Scene from '@/canvas3d/Scene'
import { buildScene3D } from '@/canvas3d/layout'
import type { StationNodeData, ScenarioCreate, StationConfig } from '@/types'

// ─── Detailed Object Palette icons ───────────────────────────────────────────
//
// Closely mirrors the reference render set: a boxy machine housing with a
// glass front over a colored part, a status-light stub on top, and a small
// control panel with red/green indicator dots + a drawer handle along the
// bottom — shared across every "machine" type (Station, Parallel Station,
// Assembly, Dismantle, Inspection, Packaging), differentiated by the shape
// inside the glass (a stamped block, a claw, a drill bit, a magnifier, a
// tape line). Robot, Conveyor, Buffer, Connector and Movable Part are
// distinct enough in the reference to get their own bespoke shape entirely
// rather than reusing the housing. `color` (a hex from STATION_TYPE_HEX)
// only tints the accent part inside the glass — the housing itself stays a
// neutral light gray/teal to match the reference across all types.
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16)
  const r = Math.max(0, Math.min(255, (n >> 16) + amount))
  const g = Math.max(0, Math.min(255, ((n >> 8) & 0xff) + amount))
  const b = Math.max(0, Math.min(255, (n & 0xff) + amount))
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`
}

const HOUSING = '#e2e8f0'
const HOUSING_SHADE = '#cbd5e1'
const GLASS = '#334155'
const GLASS_FLOOR = '#475569'
const CONVEYOR_DARK = '#27303f'
const CONVEYOR_ROLLER = '#94a3b8'

/** Roller-conveyor legs flanking a machine housing, or standalone. */
function ConveyorSide({ x }: { x: number }) {
  return (
    <g transform={`translate(${x},0)`}>
      <rect x="0" y="34" width="16" height="12" rx="2" fill={CONVEYOR_DARK} />
      {[2, 5.5, 9, 12.5].map((rx) => (
        <rect key={rx} x={rx} y="36" width="2" height="8" rx="1" fill={CONVEYOR_ROLLER} />
      ))}
      <rect x="2" y="46" width="3" height="8" fill="#94a3b8" />
      <rect x="11" y="46" width="3" height="8" fill="#94a3b8" />
    </g>
  )
}

/** The status-light stub on top of every machine housing (green=Source cue by default, tinted per type). */
function StatusLight({ color }: { color: string }) {
  return (
    <g>
      <rect x="27" y="2" width="10" height="6" rx="2" fill="#1e293b" />
      <ellipse cx="32" cy="3" rx="5" ry="2.5" fill={color} />
    </g>
  )
}

/** Shared housing: body, glass window, floor, control panel with two indicator dots + a drawer handle. */
function MachineHousing({ children, statusColor }: { children?: React.ReactNode; statusColor: string }) {
  return (
    <g>
      <ConveyorSide x={0} />
      <ConveyorSide x={32} />
      <StatusLight color={statusColor} />
      {/* Housing body */}
      <rect x="12" y="8" width="40" height="46" rx="3" fill={HOUSING} />
      <rect x="12" y="8" width="40" height="46" rx="3" fill="none" stroke={HOUSING_SHADE} strokeWidth="1" />
      {/* Glass window */}
      <rect x="17" y="14" width="30" height="24" rx="1.5" fill={GLASS} />
      <rect x="17" y="32" width="30" height="6" fill={GLASS_FLOOR} />
      {children}
      {/* Control panel */}
      <circle cx="20" cy="47" r="2" fill="#4ade80" />
      <circle cx="27" cy="47" r="2" fill="#f87171" />
      <rect x="38" y="44.5" width="8" height="5" rx="1" fill="#f59e0b" />
    </g>
  )
}

function IsoIcon({ type, color }: { type: string; color: string }) {
  return (
    <svg viewBox="0 0 64 64" width="100%" height="100%" className="shrink-0">
      {ISO_ICON_BODY[type] ? ISO_ICON_BODY[type](color) : <MachineHousing statusColor={color} />}
    </svg>
  )
}

const ISO_ICON_BODY: Record<string, (color: string) => React.ReactNode> = {
  Source: (color) => (
    <MachineHousing statusColor="#4ade80">
      {/* stamped block sitting on the glass floor */}
      <rect x="25" y="24" width="14" height="9" rx="1.5" fill={color} />
      <rect x="25" y="24" width="14" height="3" rx="1" fill={shade(color, 40)} />
    </MachineHousing>
  ),
  Drain: (color) => (
    <MachineHousing statusColor="#f87171">
      <rect x="25" y="24" width="14" height="9" rx="1.5" fill={color} />
      <rect x="25" y="24" width="14" height="3" rx="1" fill={shade(color, 40)} />
    </MachineHousing>
  ),
  Station: (color) => (
    <MachineHousing statusColor={color}>
      {/* a stubby press/stamp tool over the block */}
      <rect x="30" y="16" width="4" height="8" fill="#64748b" />
      <polygon points="26,24 38,24 35,30 29,30" fill={shade(color, -10)} />
      <rect x="27" y="30" width="10" height="6" rx="1" fill={color} />
    </MachineHousing>
  ),
  'Parallel Station': (color) => (
    <g>
      <g transform="translate(-13,0) scale(0.85)"><MachineHousing statusColor={color}>
        <rect x="30" y="16" width="4" height="8" fill="#64748b" />
        <polygon points="26,24 38,24 35,30 29,30" fill={shade(color, -10)} />
        <rect x="27" y="30" width="10" height="6" rx="1" fill={color} />
      </MachineHousing></g>
      <g transform="translate(13,0) scale(0.85)"><MachineHousing statusColor={color}>
        <rect x="30" y="16" width="4" height="8" fill="#64748b" />
        <polygon points="26,24 38,24 35,30 29,30" fill={shade(color, -10)} />
        <rect x="27" y="30" width="10" height="6" rx="1" fill={color} />
      </MachineHousing></g>
    </g>
  ),
  Assembly: (color) => (
    <MachineHousing statusColor={color}>
      {/* small claw/gripper arm over the block */}
      <rect x="30" y="16" width="3" height="6" fill="#64748b" />
      <path d="M27 22 Q32 20 37 22 L35 26 Q32 24.5 29 26 Z" fill="#94a3b8" />
      <rect x="27" y="28" width="10" height="6" rx="1" fill={color} />
      <rect x="27" y="28" width="10" height="2" fill={shade(color, 40)} />
    </MachineHousing>
  ),
  Dismantle: (color) => (
    <MachineHousing statusColor={color}>
      {/* a drill/press bit, thinner than Station's stamp, splitting the block */}
      <rect x="31" y="15" width="2" height="10" fill="#64748b" />
      <polygon points="29,25 35,25 32,30" fill="#94a3b8" />
      <rect x="27" y="30" width="4.5" height="6" rx="1" fill={color} />
      <rect x="32.5" y="30" width="4.5" height="6" rx="1" fill={shade(color, -25)} />
    </MachineHousing>
  ),
  Inspection: (color) => (
    <MachineHousing statusColor={color}>
      <rect x="26" y="24" width="12" height="8" rx="1.5" fill={color} />
      <circle cx="35" cy="21" r="4" fill="none" stroke="#e2e8f0" strokeWidth="1.6" />
      <line x1="37.8" y1="23.8" x2="40" y2="26" stroke="#e2e8f0" strokeWidth="1.8" strokeLinecap="round" />
    </MachineHousing>
  ),
  Packaging: (color) => (
    <MachineHousing statusColor={color}>
      <rect x="25" y="23" width="14" height="10" rx="1.5" fill={color} />
      <line x1="32" y1="23" x2="32" y2="33" stroke="#e2e8f0" strokeWidth="1.2" />
      <line x1="25" y1="27" x2="39" y2="27" stroke="#e2e8f0" strokeWidth="1.2" />
    </MachineHousing>
  ),
  Robot: (color) => (
    <g>
      <rect x="20" y="46" width="24" height="8" rx="2" fill="#1e293b" />
      <rect x="36" y="40" width="10" height="8" rx="1.5" fill="#334155" />
      <circle cx="39" cy="44" r="1.6" fill="#4ade80" />
      <circle cx="43" cy="44" r="1.6" fill="#f87171" />
      <circle cx="26" cy="44" r="6" fill={shade(color, -20)} />
      <rect x="23" y="26" width="6" height="20" rx="3" fill={color} />
      <circle cx="26" cy="26" r="4.5" fill={shade(color, -20)} />
      <rect x="24" y="10" width="5" height="18" rx="2.5" fill={color} transform="rotate(-25 26 26)" />
      <circle cx="34" cy="14" r="4" fill={shade(color, -20)} />
      <rect x="32" y="7" width="14" height="5" rx="2.5" fill={shade(color, 15)} transform="rotate(20 34 14)" />
      <g transform="rotate(20 34 14) translate(44,10)">
        <path d="M0 2 L5 0 L5 2 L2 4 Z" fill="#64748b" />
        <path d="M0 6 L5 8 L5 6 L2 4 Z" fill="#94a3b8" />
      </g>
    </g>
  ),
  Buffer: (color) => (
    <g>
      <rect x="8" y="10" width="6" height="44" fill="#334155" />
      <rect x="50" y="10" width="6" height="44" fill="#334155" />
      {[16, 28, 40].map((y, i) => (
        <g key={y}>
          <rect x="12" y={y} width="40" height="6" rx="1" fill={shade('#64748b', i * 8 - 8)} />
          {[16, 24, 32, 40].map((rx) => (
            <rect key={rx} x={rx} y={y + 1} width="1.4" height="4" fill="#94a3b8" />
          ))}
        </g>
      ))}
      <rect x="24" y="30" width="12" height="9" rx="1.5" fill={color} />
      <rect x="24" y="30" width="12" height="3" fill={shade(color, 40)} />
    </g>
  ),
  Conveyor: (color) => (
    <g>
      <rect x="6" y="30" width="52" height="12" rx="3" fill={CONVEYOR_DARK} />
      {[10, 15, 20, 25, 30, 35, 40, 45, 50].map((rx) => (
        <rect key={rx} x={rx} y="32.5" width="2.2" height="7" rx="1" fill={CONVEYOR_ROLLER} />
      ))}
      <rect x="10" y="42" width="4" height="10" fill="#94a3b8" />
      <rect x="50" y="42" width="4" height="10" fill="#94a3b8" />
      <rect x="26" y="24" width="12" height="7" rx="1.5" fill={color} opacity="0.85" />
    </g>
  ),
  Connector: (color) => (
    <g>
      <ConveyorSide x={0} />
      <ConveyorSide x={32} />
      <rect x="12" y="30" width="40" height="14" rx="2" fill="#f1f5f9" />
      <rect x="12" y="30" width="40" height="14" rx="2" fill="none" stroke="#cbd5e1" strokeWidth="1" />
      <circle cx="22" cy="37" r="2.6" fill="#4ade80" />
      <circle cx="42" cy="37" r="2.6" fill="#f87171" />
      <rect x="30" y="34" width="4" height="6" rx="1" fill={color} />
    </g>
  ),
  'Movable Part': (color) => (
    <g>
      <rect x="14" y="46" width="36" height="6" rx="1.5" fill="#334155" />
      <rect x="20" y="40" width="24" height="8" rx="1.5" fill="#1e293b" />
      <polygon points="32,14 46,22 32,30 18,22" fill={shade(color, 35)} />
      <polygon points="18,22 32,30 32,42 18,34" fill={shade(color, -15)} />
      <polygon points="46,22 32,30 32,42 46,34" fill={color} />
    </g>
  ),
}

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => h)

function fmtHour(h: number): string {
  const hh = Math.floor(h) % 24
  const period = hh < 12 ? 'am' : 'pm'
  const display = hh % 12 === 0 ? 12 : hh % 12
  return `${display}${period}`
}

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
  stationType?: string
}

function FlowNode({ data, selected }: { data: FlowNodeData; selected: boolean }) {
  const u = data.utilization ?? 0
  const hasUtil = data.utilization !== undefined
  const border = selected ? '#3b82f6' : utilBorder(u)
  const topColor = utilColor(u)
  // Station type gets its own labeled header band (below), kept fully
  // separate from utilization health (which owns the border/thin
  // stripe/progress-bar colors) — a named band reads unambiguously
  // regardless of how similar two type colors might look as a small swatch.
  // baseStationName strips a " #2" parallel-machine suffix before inferring,
  // since that suffix isn't part of the station's name.
  const inferredType = inferStationType(baseStationName(data.resource), data.stationType)
  const typeHex = STATION_TYPE_HEX[inferredType] || DEFAULT_STATION_HEX

  return (
    <div className="flex flex-col items-center px-1 py-1 group" style={{ width: 140 }}>
      <Handle type="target" position={Position.Left} style={{ background: '#94a3b8', width: 8, height: 8 }} />

      {/* Icon + name + utilization % only — duration, the operation/station
          name split, the parallel badge, and the progress bar were cut for
          being too much crammed into one card; those details are still
          available via the station's click-through panel. Selection ring
          doubles as the utilization health indicator (colored by topColor). */}
      <div
        className="w-28 h-28 rounded-xl transition-shadow"
        style={{ boxShadow: selected ? `0 0 0 3px ${border}` : `0 0 0 2px ${border}` }}
      >
        <IsoIcon type={inferredType} color={typeHex} />
      </div>

      <div className="text-xs font-bold text-gray-900 truncate max-w-full mt-1 bg-white/80 px-1.5 rounded">
        {data.resource}
      </div>
      {hasUtil && (
        <span
          className="text-[10px] font-bold px-2 py-0.5 rounded-full mt-0.5"
          style={{ color: topColor, background: topColor + '20' }}
        >
          {u.toFixed(0)}%
        </span>
      )}

      <Handle type="source" position={Position.Right} style={{ background: '#94a3b8', width: 8, height: 8 }} />
    </div>
  )
}

// ─── BUILD MODE node ──────────────────────────────────────────────────────────

// Station-type color coding — matches the shop-floor convention the user
// specified (Station=green, Buffer/Queue=brown, Assembly=pink), with
// Inspection/Packaging kept as they were (purple/orange). "Buffer" is a
// queue/buffer-like station (name contains "Queue"), not a real Object
// Palette item — inferred purely from naming, same as the others below.
// Falls back to green (plain Station) for legacy nodes with no stationType
// set and no recognizable keyword.
const STATION_TYPE_COLORS: Record<string, { border: string; dot: string; handle: string }> = {
  Source:           { border: 'border-sky-400',    dot: 'bg-sky-500',    handle: '!bg-sky-400' },
  Station:          { border: 'border-green-400',  dot: 'bg-green-500',  handle: '!bg-green-400' },
  'Parallel Station': { border: 'border-cyan-400', dot: 'bg-cyan-500',   handle: '!bg-cyan-400' },
  Buffer:           { border: 'border-amber-700',  dot: 'bg-amber-700',  handle: '!bg-amber-700' },
  Assembly:         { border: 'border-pink-400',   dot: 'bg-pink-500',   handle: '!bg-pink-400' },
  Dismantle:        { border: 'border-lime-500',   dot: 'bg-lime-600',   handle: '!bg-lime-500' },
  Inspection:       { border: 'border-purple-400', dot: 'bg-purple-500', handle: '!bg-purple-400' },
  Packaging:        { border: 'border-orange-400', dot: 'bg-orange-500', handle: '!bg-orange-400' },
  Conveyor:         { border: 'border-yellow-500', dot: 'bg-yellow-500', handle: '!bg-yellow-500' },
  Robot:            { border: 'border-indigo-400', dot: 'bg-indigo-500', handle: '!bg-indigo-400' },
  Connector:        { border: 'border-slate-400',  dot: 'bg-slate-500',  handle: '!bg-slate-400' },
  'Movable Part':   { border: 'border-rose-400',   dot: 'bg-rose-500',   handle: '!bg-rose-400' },
  Drain:            { border: 'border-red-400',    dot: 'bg-red-500',   handle: '!bg-red-400' },
}
const DEFAULT_STATION_COLOR = STATION_TYPE_COLORS.Station

// Same station-type color coding as hex values, for contexts that can't use
// Tailwind classes directly (e.g. React Flow's MiniMap nodeColor prop).
const STATION_TYPE_HEX: Record<string, string> = {
  Source: '#0ea5e9', Station: '#22c55e', 'Parallel Station': '#06b6d4', Buffer: '#b45309',
  Assembly: '#ec4899', Dismantle: '#65a30d', Inspection: '#a855f7', Packaging: '#fb923c',
  Conveyor: '#eab308', Robot: '#6366f1', Connector: '#64748b', 'Movable Part': '#f43f5e', Drain: '#ef4444',
}
const DEFAULT_STATION_HEX = STATION_TYPE_HEX.Station

/**
 * Infer a station's palette type for color-coding when stationType isn't
 * set — which is EVERY station in a scenario imported from Excel/YAML,
 * since 'Station Type' is a Canvas-only concept never written by the
 * parsers. Falls back to keyword-matching the station's name, the same
 * pattern already used for isAssembly below, extended to Buffer/Inspection/
 * Packaging too. Defaults to 'Station' (the common case — a plain
 * processing station) when no special keyword matches, rather than an
 * "unknown" color, since that's what almost every unmatched name actually is.
 */
function inferStationType(label: string, stationType?: string): string {
  if (stationType) return stationType
  const name = label.toLowerCase()
  if (name.startsWith('assembly')) return 'Assembly'
  if (/dismantle|disassembl/.test(name)) return 'Dismantle'
  if (/queue|buffer/.test(name)) return 'Buffer'
  // Inspection is NOT guessed from the name (VT/RT/QA-named stations, common
  // in imported scenarios, used to be auto-labeled "Inspection" here) — an
  // inspection station has no different simulation behaviour from a plain
  // Station, so guessing it from naming just added a cosmetic label with no
  // real meaning behind it. It's still a real Object Palette item: a station
  // explicitly built with it keeps its "Station Type": "Inspection" tag
  // (handled by the `if (stationType) return stationType` line above) —
  // only the naming-based GUESS for untagged/imported stations is removed.
  if (/(pack|dispatch)/.test(name)) return 'Packaging'
  if (/conveyor|convey/.test(name)) return 'Conveyor'
  if (/\brobot/.test(name)) return 'Robot'
  if (/^source|entry/.test(name)) return 'Source'
  if (/^drain|^exit/.test(name)) return 'Drain'
  return 'Station'
}

// Tecnomatix's own toolbox uses ONE consistent 3D-block body for every
// material-flow object (Station, Buffer, Assembly, Robot, ...) — objects are
// told apart by a small icon/pictogram badge in the corner, not by different
// silhouettes. This matches that: every type shares the same beveled block
// shape (a lighter "lid" strip along the top gives it a slight 3D read,
// echoing the reference screenshot's blue boxes), and the corner badge +
// type-specific summary line is what actually differentiates them.
function StationNode({ data, selected }: { data: StationNodeData; selected: boolean }) {
  const inferredType = inferStationType(data.label, data.stationType)
  const colors = (inferredType && STATION_TYPE_COLORS[inferredType]) || DEFAULT_STATION_COLOR

  return (
    <div className="flex flex-col items-center px-1 py-1 group">
      <Handle type="target" position={Position.Left} className={colors.handle} />
      {/* Just the icon artwork + name — no card/rectangle around it. The
          selection ring sits behind the icon rather than boxing it in, so
          the icon's own silhouette (housing, robot arm, belt, ...) stays
          the only visible shape. */}
      <div
        className={`w-32 h-32 rounded-xl transition-shadow ${selected ? 'ring-2 ring-blue-500 ring-offset-2' : 'group-hover:ring-2 group-hover:ring-blue-200 group-hover:ring-offset-2'}`}
      >
        <IsoIcon type={inferredType} color={(inferredType && STATION_TYPE_HEX[inferredType]) || DEFAULT_STATION_HEX} />
      </div>
      <span className="text-sm font-semibold text-gray-800 truncate max-w-[150px] mt-1 bg-white/80 px-1.5 rounded">
        {data.label}
      </span>
      <Handle type="source" position={Position.Right} className={colors.handle} />
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

// A plain number input bound straight to node.data re-derives its displayed
// value from `String(node.data[key])` on every render — so the moment a user
// clears the field to type a new value, onChange saw "" and bailed out (to
// avoid writing NaN), but the input then immediately snapped back to the old
// number since the underlying data never changed. This keeps its own local
// text draft so the field can sit empty while typing, only writing a parsed
// number back once it's valid, and re-syncing from node.data when a
// genuinely different node is selected.
function NumericField({ value, onCommit, className }: { value: number; onCommit: (n: number) => void; className?: string }) {
  const [draft, setDraft] = useState(String(value))

  useEffect(() => { setDraft(String(value)) }, [value])

  return (
    <Input
      type="number"
      value={draft}
      onChange={(e) => {
        const raw = e.target.value
        setDraft(raw)
        if (raw === '') return
        const parsed = Number(raw)
        if (Number.isNaN(parsed)) return
        onCommit(parsed)
      }}
      onBlur={() => {
        // Left empty or mid-typing an invalid value when focus leaves —
        // fall back to the last committed value instead of leaving it blank.
        if (draft === '' || Number.isNaN(Number(draft))) setDraft(String(value))
      }}
      className={className}
    />
  )
}

// ─── Property editor ─────────────────────────────────────────────────────────

function PropertyEditor({
  node, nodes, edges, onChange, onDelete, onSaveStation, onAddParallel, numShifts, shiftNames,
  globalWorkingDays, globalShiftHours, globalBreaks,
}: {
  node: Node<StationNodeData>
  nodes: Node<StationNodeData>[]
  edges: Edge[]
  onChange: (id: string, data: Partial<StationNodeData>) => void
  onDelete: (id: string) => void
  onSaveStation: () => void
  onAddParallel: (id: string) => void
  numShifts: number
  shiftNames: Record<number, string | undefined>
  globalWorkingDays: Record<number, number[]>
  globalShiftHours: Record<number, { start: number; end: number }>
  globalBreaks: Record<number, { start: number; duration: number }[]>
}) {
  const nodeType = inferStationType(node.data.label, node.data.stationType)
  // A Connector is a routing junction, a Conveyor is transport, and a
  // Source/Drain is just where jobs enter/leave the line — none of these are
  // a machine, so the machine fields below (capacity, cycle time, operators,
  // shifts, parallel machines) don't apply to them (the engine ignores those
  // fields for Connector/Conveyor; Source/Drain have no real engine semantics
  // at all yet — see sim_core.py's Station Type handling). Showing them
  // anyway would invite settings that do nothing.
  const isConnector = nodeType === 'Connector'
  const isConveyor = nodeType === 'Conveyor'
  const isBookend = nodeType === 'Source' || nodeType === 'Drain'

  const fields = (isConnector || isBookend)
    ? [{ key: 'label', label: 'Name', type: 'text' }]
    : isConveyor
      ? [
          { key: 'label',         label: 'Name',                type: 'text'   },
          { key: 'transportTime', label: 'Transport Time (min)', type: 'number' },
        ]
      : [
          { key: 'label',     label: 'Name',            type: 'text'   },
          { key: 'cycleTime', label: 'Cycle Time (min)', type: 'number' },
          { key: 'operators', label: 'Operators',        type: 'number' },
        ]

  // "Assembly Count" only makes sense on stations built from the Assembly
  // palette item. Keyed off stationType (set once at creation, restored from
  // the saved scenario) rather than the label, so renaming the station in
  // the Name field doesn't hide this field. Falls back to a label check for
  // scenarios saved before stationType existed (no persisted type to read).
  const isAssembly = node.data.stationType
    ? node.data.stationType === 'Assembly'
    : baseStationName(node.data.label).startsWith('Assembly')

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

  // Distinct upstream STATIONS feeding this node — the "Assembly type/table"
  // rows for an Assembly station: one row per incoming station, with a
  // quantity-needed field. Mirrors destinationBases but walks edges backward.
  const sourceBases = Array.from(new Set(
    edges
      .filter((e) => e.target === node.id)
      .map((e) => nodes.find((n) => n.id === e.source))
      .filter((n): n is Node<StationNodeData> => !!n)
      .map((n) => baseStationName(n.data.label))
  ))
  const assemblyInputs = node.data.assemblyInputs ?? {}

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
            {type === 'number' ? (
              <NumericField
                // Fields that only exist on some station types (e.g. a
                // Conveyor's transportTime) are undefined on a freshly added
                // node — Number(undefined) is NaN, which would render an empty
                // uneditable box, so fall back to 0.
                value={Number(node.data[key as keyof StationNodeData] ?? 0)}
                onCommit={(n) => onChange(node.id, { [key]: n })}
                className="h-8 text-sm rounded-lg border-gray-200 bg-gray-50 focus:bg-white [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
              />
            ) : (
              <Input
                type={type}
                value={String(node.data[key as keyof StationNodeData])}
                onChange={(e) => onChange(node.id, { [key]: e.target.value })}
                className="h-8 text-sm rounded-lg border-gray-200 bg-gray-50 focus:bg-white [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
              />
            )}
          </div>
        ))}

        {/* Shift availability — any combination of the day's shifts (1, 2, 3)
            this station actually runs on, e.g. shift 2+3 while skipping
            shift 1. Feeds shifts_per_day, which the engine reads directly
            when deciding if the station is active. Names shown come from
            the scenario's simulation_config (SHIFT_n_NAME) — renamed from
            Simulation Config's Shift Calendar, not editable here. Not shown
            for Connector/Source/Drain — none of them are ever "off shift"
            in a way that means anything. */}
        {!isConnector && !isBookend && (
        <div>
          <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
            Shift Available
          </label>
          <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${numShifts}, 1fr)` }}>
            {Array.from({ length: numShifts }, (_, i) => i + 1).map((shiftNum) => {
              const selected = node.data.shiftsPerDay ?? [1]
              const active = selected.includes(shiftNum)
              const label = shiftNames[shiftNum]?.trim() || `Shift ${shiftNum}`
              return (
                <button
                  key={shiftNum}
                  type="button"
                  title={label}
                  onClick={() => {
                    const next = active
                      ? selected.filter((n) => n !== shiftNum)
                      : [...selected, shiftNum]
                    onChange(node.id, { shiftsPerDay: next.sort() })
                  }}
                  className={`h-8 rounded-lg text-xs font-semibold transition-colors select-none truncate px-1 ${
                    active
                      ? 'bg-green-400 text-white hover:brightness-95'
                      : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                  }`}
                >
                  {label}
                </button>
              )
            })}
          </div>
          {(node.data.shiftsPerDay ?? [1]).length === 0 && (
            <p className="text-[10px] text-amber-500 mt-1">No shift selected — station will never be active.</p>
          )}
        </div>
        )}

        {/* Per-station working-days calendar — one MON-SUN row per shift this
            station actually runs (from Shift Available above). Defaults to
            the scenario's global Shift Calendar for that shift number until
            toggled, at which point this station's own pattern is saved
            (workingDaysByShift) and the engine's build_station_shift_config
            overrides that shift's WORKING_DAYS_n for this station only —
            other stations still using the shift's global calendar are
            unaffected. Hidden for Connector/Source/Drain, same as above. */}
        {!isConnector && !isBookend && (node.data.shiftsPerDay ?? [1]).length > 0 && (
          <div>
            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
              Working Days
            </label>
            <div className="space-y-2">
              {(node.data.shiftsPerDay ?? [1]).map((shiftNum) => {
                const label = shiftNames[shiftNum]?.trim() || `Shift ${shiftNum}`
                const days = node.data.workingDaysByShift?.[shiftNum] ?? globalWorkingDays[shiftNum] ?? [0, 1, 2, 3, 4]
                const isCustom = node.data.workingDaysByShift?.[shiftNum] !== undefined
                return (
                  <div key={shiftNum}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] font-semibold text-gray-500 truncate">{label}</span>
                      {isCustom && (
                        <button
                          type="button"
                          className="text-[9px] text-blue-500 hover:text-blue-700"
                          title="Revert to this scenario's global Shift Calendar for this shift"
                          onClick={() => {
                            const next = { ...(node.data.workingDaysByShift ?? {}) }
                            delete next[shiftNum]
                            onChange(node.id, { workingDaysByShift: next })
                          }}
                        >
                          Reset
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-7 gap-1">
                      {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, dayIdx) => {
                        const active = days.includes(dayIdx)
                        return (
                          <button
                            key={dayIdx}
                            type="button"
                            title={['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][dayIdx]}
                            onClick={() => {
                              const nextDays = (active ? days.filter((n) => n !== dayIdx) : [...days, dayIdx]).sort()
                              onChange(node.id, {
                                workingDaysByShift: { ...(node.data.workingDaysByShift ?? {}), [shiftNum]: nextDays },
                              })
                            }}
                            className={`h-6 rounded text-[10px] font-bold transition-colors ${
                              active
                                ? 'bg-blue-400 text-white hover:brightness-95'
                                : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                            }`}
                          >
                            {d}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Per-station shift hours + breaks — same override-or-fall-back
            pattern as Working Days above: a station starts on the
            scenario's global hours/breaks for each shift it runs, and only
            diverges once actually edited here. Persisted as shift{n} (an
            "HH:MM-HH:MM" window string, parsed by the engine's
            parse_shift_window) and breaks{n} on stations_data. */}
        {!isConnector && !isBookend && (node.data.shiftsPerDay ?? [1]).length > 0 && (
          <div>
            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
              Shift Hours &amp; Breaks
            </label>
            <div className="space-y-3">
              {(node.data.shiftsPerDay ?? [1]).map((shiftNum) => {
                const label = shiftNames[shiftNum]?.trim() || `Shift ${shiftNum}`
                const hours = node.data.shiftHoursByShift?.[shiftNum] ?? globalShiftHours[shiftNum] ?? { start: 8, end: 16 }
                const hoursCustom = node.data.shiftHoursByShift?.[shiftNum] !== undefined
                const breaks = node.data.breaksByShift?.[shiftNum] ?? globalBreaks[shiftNum] ?? []
                const breaksCustom = node.data.breaksByShift?.[shiftNum] !== undefined

                const setHours = (patch: Partial<{ start: number; end: number }>) => {
                  onChange(node.id, {
                    shiftHoursByShift: { ...(node.data.shiftHoursByShift ?? {}), [shiftNum]: { ...hours, ...patch } },
                  })
                }
                const setBreaks = (next: { start: number; duration: number }[]) => {
                  onChange(node.id, { breaksByShift: { ...(node.data.breaksByShift ?? {}), [shiftNum]: next } })
                }

                return (
                  <div key={shiftNum} className="rounded-lg border border-gray-100 p-2">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[10px] font-semibold text-gray-500 truncate">{label}</span>
                      {(hoursCustom || breaksCustom) && (
                        <button
                          type="button"
                          className="text-[9px] text-blue-500 hover:text-blue-700"
                          title="Revert hours and breaks to this scenario's global Simulation Config for this shift"
                          onClick={() => {
                            const nextHours = { ...(node.data.shiftHoursByShift ?? {}) }
                            delete nextHours[shiftNum]
                            const nextBreaks = { ...(node.data.breaksByShift ?? {}) }
                            delete nextBreaks[shiftNum]
                            onChange(node.id, { shiftHoursByShift: nextHours, breaksByShift: nextBreaks })
                          }}
                        >
                          Reset
                        </button>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 mb-2">
                      <select
                        value={hours.start}
                        onChange={(e) => setHours({ start: Number(e.target.value) })}
                        className="h-7 text-xs text-gray-800 bg-gray-50 border border-gray-200 rounded-md px-1 flex-1 min-w-0"
                      >
                        {HOUR_OPTIONS.map((h) => <option key={h} value={h}>{fmtHour(h)}</option>)}
                      </select>
                      <span className="text-[10px] text-gray-400 shrink-0">–</span>
                      <select
                        value={hours.end}
                        onChange={(e) => setHours({ end: Number(e.target.value) })}
                        className="h-7 text-xs text-gray-800 bg-gray-50 border border-gray-200 rounded-md px-1 flex-1 min-w-0"
                      >
                        {HOUR_OPTIONS.map((h) => <option key={h} value={h}>{fmtHour(h)}</option>)}
                      </select>
                    </div>

                    <div className="space-y-1.5">
                      {breaks.map((bw, bi) => (
                        <div key={bi} className="rounded border border-gray-100 p-1.5 space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] font-semibold text-gray-400 uppercase tracking-wide">Break starts</span>
                            <button
                              type="button"
                              onClick={() => setBreaks(breaks.filter((_, i) => i !== bi))}
                              className="text-gray-300 hover:text-red-500 transition-colors shrink-0"
                              aria-label="Remove break"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                          <select
                            value={bw.start}
                            onChange={(e) => {
                              const next = [...breaks]
                              next[bi] = { ...bw, start: Number(e.target.value) }
                              setBreaks(next)
                            }}
                            className="h-6 text-[10px] text-gray-700 bg-gray-50 border border-gray-200 rounded px-1 w-full"
                          >
                            {HOUR_OPTIONS.map((h) => <option key={h} value={h}>{fmtHour(h)}</option>)}
                          </select>
                          <div className="flex items-center gap-1">
                            <NumericField
                              value={bw.duration}
                              onCommit={(n) => {
                                const next = [...breaks]
                                next[bi] = { ...bw, duration: n }
                                setBreaks(next)
                              }}
                              className="h-6 text-[10px] flex-1 min-w-0 rounded border-gray-200 bg-gray-50 px-1 [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
                            />
                            <span className="text-[9px] text-gray-400 shrink-0">min</span>
                          </div>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => setBreaks([...breaks, { start: 12, duration: 30 }])}
                        className="text-[10px] font-semibold text-blue-600 hover:text-blue-700"
                      >
                        + Add break
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Assembly count — only relevant on stations built from the
            Assembly palette item: how many input sub-parts combine into
            one assembled unit. Config-only for now; not yet read by the
            simulation engine. */}
        {isAssembly && (
          <div>
            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
              Number of Assemblies
            </label>
            <NumericField
              value={node.data.assemblyCount ?? 1}
              onCommit={(n) => onChange(node.id, { assemblyCount: n })}
              className="h-8 text-sm rounded-lg border-gray-200 bg-gray-50 focus:bg-white [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
            />
            <p className="text-[10px] text-gray-400 mt-1">Sub-parts required to produce one assembled unit.</p>
          </div>
        )}

        {/* Assembly type/table — quantity of each upstream station's output
            needed per assembled unit. One row per station actually connected
            into this node on the canvas; config-only, same as Assembly Count. */}
        {isAssembly && (
          <div>
            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
              Assembly Table
            </label>
            {sourceBases.length > 0 ? (
              <div className="space-y-1.5">
                {sourceBases.map((src) => (
                  <div key={src} className="flex items-center gap-2">
                    <span className="text-[11px] text-gray-500 flex-1 truncate">{src}</span>
                    <NumericField
                      value={assemblyInputs[src] ?? 1}
                      onCommit={(n) => onChange(node.id, { assemblyInputs: { ...assemblyInputs, [src]: n } })}
                      className="h-7 w-16 text-xs rounded-lg border-gray-200 bg-gray-50 focus:bg-white"
                    />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[10px] text-gray-400">Connect one or more stations into this one to list them here.</p>
            )}
          </div>
        )}

        {/* Parallel machines — capacity is derived from the number of "Name #N"
            boxes for this station, so it's controlled here instead of a raw
            field. Not meaningful for Connector/Source/Drain — there is only
            ever exactly one of each in a line. */}
        {!isConnector && !isBookend && (
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
        )}

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

// Each item pairs a color with a distinct ICON (not color alone) — with 13
// types, several colors sit close together (teal/cyan, green/lime,
// amber/yellow) and would be hard to tell apart at a glance in a compact
// palette list, so the icon shape is the primary differentiator and color
// is the secondary one.
const PALETTE_ITEMS = [
  { label: 'Source',           description: 'Job entry point',    color: 'bg-sky-50 text-sky-500 border-sky-400' },
  { label: 'Station',          description: 'Processing station', color: 'bg-teal-50 text-teal-500 border-teal-400' },
  { label: 'Parallel Station', description: 'Multi-lane station', color: 'bg-cyan-50 text-cyan-500 border-cyan-400' },
  { label: 'Assembly',         description: 'Assembly station',   color: 'bg-green-50 text-green-500 border-green-400' },
  { label: 'Dismantle',        description: 'Disassembly station', color: 'bg-lime-50 text-lime-600 border-lime-400' },
  { label: 'Inspection',       description: 'QA station',         color: 'bg-purple-50 text-purple-500 border-purple-400' },
  { label: 'Packaging',        description: 'Pack & dispatch',    color: 'bg-orange-50 text-orange-500 border-orange-400' },
  { label: 'Buffer',           description: 'Queue / buffer',     color: 'bg-amber-50 text-amber-700 border-amber-700' },
  { label: 'Conveyor',         description: 'Material transport', color: 'bg-yellow-50 text-yellow-600 border-yellow-500' },
  { label: 'Robot',            description: 'Robotic handler',    color: 'bg-indigo-50 text-indigo-500 border-indigo-400' },
  { label: 'Connector',        description: 'Routing junction',   color: 'bg-slate-100 text-slate-500 border-slate-400' },
  { label: 'Movable Part',     description: 'Part / WIP token',   color: 'bg-rose-50 text-rose-500 border-rose-400' },
  { label: 'Drain',            description: 'Job exit point',     color: 'bg-red-50 text-red-500 border-red-400' },
]

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
  stationsData: Record<string, { capacity?: number; 'Station Type'?: string }> = {},
): { nodes: Node<FlowNodeData>[]; edges: Edge[] } {
  const steps = processflow[variant] ?? []
  // FlowNode is now icon-first (112px icon + name/resource/duration/util rows
  // beneath it, ~200px tall overall) rather than the old compact text card —
  // ROW_GAP needs real room to keep stacked parallel-machine icons from
  // overlapping, same fix already applied to Build mode's layout.
  const COL_GAP = 260
  const ROW_GAP = 170     // vertical spacing between parallel machines

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
            stationType: stationsData[resourceName]?.['Station Type'],
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
  // StationNode (Build mode) renders a 128px icon + label, not the old
  // compact card these gaps were tuned for — 140/160 stacked parallel
  // machines almost directly on top of each other once the icon grew that
  // much larger. Both gaps now clear the icon's actual footprint (128px
  // tall/wide) with real breathing room instead of overlapping.
  const COL_GAP = 200
  const ROW_GAP = 190

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
            stationType: cfg?.['Station Type'],
            capacity,
            cycleTime: step.duration,
            operators: cfg?.operator_per_station ?? 1,
            shiftsPerDay: normalizeShiftsPerDay(cfg?.shifts_per_day),
            transportTime: cfg?.['Transport Time'],
            assemblyCount: cfg?.['Assembly Count'],
            assemblyInputs: cfg?.['Assembly Inputs'],
            workingDaysByShift: extractWorkingDaysByShift(cfg),
            shiftHoursByShift: extractShiftHoursByShift(cfg),
            breaksByShift: extractBreaksByShift(cfg),
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

// Column/row spacing matching buildEditableGraph's own layout, needed again
// here since ensureSourceAndDrain positions its inserted boxes relative to it.
const EDITABLE_COL_GAP = 200

/**
 * Ensures a Build-mode graph starts with a Source and ends with a Drain —
 * the Tecnomatix convention every line should follow (see Object Palette).
 * Purely a layout/graph nicety: a Source/Drain has no special simulation
 * behaviour today (same generic station fields as everything else), so this
 * only runs when loading a scenario that doesn't already have them, never
 * overriding one the user placed deliberately.
 *
 * Entry = nodes with no incoming edge; Exit = nodes with no outgoing edge.
 * Insert only when NONE of the current entry/exit nodes are already typed
 * Source/Drain — a graph that already starts/ends correctly is left alone.
 */
function ensureSourceAndDrain(
  nodes: Node<StationNodeData>[],
  edges: Edge[],
  nextId: () => number,
): { nodes: Node<StationNodeData>[]; edges: Edge[] } {
  if (nodes.length === 0) return { nodes, edges }

  const hasIncoming = new Set(edges.map((e) => e.target))
  const hasOutgoing = new Set(edges.map((e) => e.source))
  const entryNodes = nodes.filter((n) => !hasIncoming.has(n.id))
  const exitNodes = nodes.filter((n) => !hasOutgoing.has(n.id))
  const isType = (n: Node<StationNodeData>, type: string) =>
    inferStationType(n.data.label, n.data.stationType) === type

  const needsSource = !entryNodes.some((n) => isType(n, 'Source'))
  const needsDrain = !exitNodes.some((n) => isType(n, 'Drain'))
  if (!needsSource && !needsDrain) return { nodes, edges }

  const nextNodes = [...nodes]
  const nextEdges = [...edges]
  const minX = Math.min(...nodes.map((n) => n.position.x))
  const maxX = Math.max(...nodes.map((n) => n.position.x))
  const avgY = nodes.reduce((sum, n) => sum + n.position.y, 0) / nodes.length

  if (needsSource) {
    const id = `station_${nextId()}`
    nextNodes.push({
      id, type: 'station',
      position: { x: minX - EDITABLE_COL_GAP, y: avgY },
      data: { label: 'Source', stationType: 'Source', capacity: 1, cycleTime: 0, operators: 0, shiftsPerDay: [1] },
    })
    for (const n of entryNodes) nextEdges.push({ id: `e_${id}__${n.id}`, source: id, target: n.id })
  }
  if (needsDrain) {
    const id = `station_${nextId()}`
    nextNodes.push({
      id, type: 'station',
      position: { x: maxX + EDITABLE_COL_GAP, y: avgY },
      data: { label: 'Drain', stationType: 'Drain', capacity: 1, cycleTime: 0, operators: 0, shiftsPerDay: [1] },
    })
    for (const n of exitNodes) nextEdges.push({ id: `e_${n.id}__${id}`, source: n.id, target: id })
  }

  return { nodes: nextNodes, edges: nextEdges }
}

/** Strip a trailing " #N" suffix used to label parallel-machine boxes, e.g. "Stitching #2" -> "Stitching" */
function baseStationName(label: string): string {
  return label.replace(/\s+#\d+$/, '')
}

/**
 * Normalize a station's `shifts_per_day` into an explicit list of active
 * shift numbers. Accepts the legacy count form (a plain number N meaning
 * "shifts 1..N", e.g. 2 -> [1, 2]) or an already-explicit list (e.g. [2, 3]
 * — not capped at 3, since a scenario can define more shifts via "+ Add
 * shift" in Simulation Config).
 */
function normalizeShiftsPerDay(value: number | number[] | undefined): number[] {
  if (Array.isArray(value)) return value.filter((n) => Number.isInteger(n) && n >= 1)
  const n = value ?? 1
  return Array.from({ length: Math.max(0, n) }, (_, i) => i + 1)
}

/**
 * Collect a saved station's per-shift working-days overrides
 * (workingDays1, workingDays2, ...) back into the { shiftNum: days[] } shape
 * StationNodeData.workingDaysByShift uses, so reopening a saved scenario in
 * Build mode restores exactly what was toggled — not just the global
 * default every station starts from before any override is made.
 */
function extractWorkingDaysByShift(cfg: StationConfig | undefined): Record<number, number[]> | undefined {
  if (!cfg) return undefined
  const out: Record<number, number[]> = {}
  for (const key of Object.keys(cfg)) {
    const match = /^workingDays(\d+)$/.exec(key)
    if (!match) continue
    const days = cfg[key]
    if (Array.isArray(days)) out[Number(match[1])] = days as number[]
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Collect a saved station's per-shift hour-window overrides (shift1,
 * shift2, ... parsed as "HH:MM-HH:MM") back into the
 * { shiftNum: {start, end} } shape StationNodeData.shiftHoursByShift uses.
 * A value that ISN'T a valid window string (e.g. a real operator name, or
 * blank) is simply not a station-level hour override — silently skipped
 * rather than restored as garbage.
 */
function extractShiftHoursByShift(cfg: StationConfig | undefined): Record<number, { start: number; end: number }> | undefined {
  if (!cfg) return undefined
  const out: Record<number, { start: number; end: number }> = {}
  for (const key of Object.keys(cfg)) {
    const match = /^shift(\d+)$/.exec(key)
    if (!match) continue
    const raw = cfg[key]
    if (typeof raw !== 'string') continue
    const windowMatch = /^(\d{1,2}):\d{2}-(\d{1,2}):\d{2}$/.exec(raw.trim())
    if (!windowMatch) continue
    out[Number(match[1])] = { start: Number(windowMatch[1]), end: Number(windowMatch[2]) }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Collect a saved station's per-shift break overrides (breaks1, breaks2,
 * ...) back into the { shiftNum: BreakWindow[] } shape
 * StationNodeData.breaksByShift uses.
 */
function extractBreaksByShift(cfg: StationConfig | undefined): Record<number, { start: number; duration: number }[]> | undefined {
  if (!cfg) return undefined
  const out: Record<number, { start: number; duration: number }[]> = {}
  for (const key of Object.keys(cfg)) {
    const match = /^breaks(\d+)$/.exec(key)
    if (!match) continue
    const breaks = cfg[key]
    if (Array.isArray(breaks)) out[Number(match[1])] = breaks as { start: number; duration: number }[]
  }
  return Object.keys(out).length > 0 ? out : undefined
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Canvas() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { activeScenario, activeRun, setActiveScenario, showToast, setJustReset } = useAppStore()
  const isDark = useAppStore(s => s.theme) === 'dark'

  // Memoized so React Flow always sees the same object reference across renders/HMR —
  // an unstable nodeTypes reference makes React Flow re-init internally on every
  // render, which breaks node dragging (clicks fall through to the pane instead).
  const stableNodeTypes = useMemo(() => nodeTypes, [])
  const stableEdgeTypes = useMemo(() => ({}), [])

  // Mode: 'view' shows scenario flow; 'build' is free-canvas builder
  const [mode, setMode] = useState<'view' | 'build'>(activeScenario ? 'view' : 'build')

  // Within View mode: '2d' is the existing ReactFlow diagram, '3d' is the new Scene
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

  // Build-mode canvas instance — needed to convert a drag-and-drop's screen
  // (clientX/clientY) coordinates into flow-space coordinates, so a palette
  // item dropped on the canvas lands exactly under the cursor instead of at
  // an auto-computed "rightmost + offset" spot.
  const [buildFlowInstance, setBuildFlowInstance] = useState<ReactFlowInstance | null>(null)

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

  // 3D Scene data — used when viewMode === '3d' inside View mode (see render below)
  const scene3D = useMemo(() => {
    if (!activeScenario || !selectedVariant) return { machines: [], operators: [], connections: [], stepLabels: [] }
    return buildScene3D(
      activeScenario.processflow_data,
      selectedVariant,
      activeScenario.stations_data,
      activeScenario.operators_data,
      activeRun?.station_stats ?? [],
    )
  }, [activeScenario, selectedVariant, activeRun])

  // Raw completion log passed straight through to the 3D Scene (it does its own
  // per-station filtering); the 2D view instead uses selectedFlowNodeJobs above,
  // which is already filtered to the clicked station.
  const completionLog = useMemo(() =>
    (activeRun?.result as Record<string, unknown> | null)?.completion_log as Record<string, unknown[]> | undefined,
    [activeRun]
  )

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
    // Every line should start with a Source and end with a Drain (Tecnomatix
    // convention) — added automatically for scenarios saved before this
    // existed, or imported from Excel/YAML, which never have them.
    const { nodes: finalNodes, edges: finalEdges } = ensureSourceAndDrain(editNodes, editEdges, nextNodeId)
    setNodes(finalNodes)
    setEdges(finalEdges)
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

  // `dropPosition` (already in flow coordinates) places the new node exactly
  // there — used when a palette item is dragged onto the canvas, Tecomatix-
  // style. Omitted for a plain click on the palette item, which keeps the
  // old auto-placement (rightmost node + offset) as a one-click fallback.
  const addNode = (label: string, dropPosition?: { x: number; y: number }) => {
    const id = nextNodeId()
    setNodes((nds) => {
      const rightmostX = nds.length > 0 ? Math.max(...nds.map((n) => n.position.x)) : 40
      const avgY = nds.length > 0 ? nds.reduce((sum, n) => sum + n.position.y, 0) / nds.length : 160
      const position = dropPosition ?? { x: nds.length > 0 ? rightmostX + 220 : 80, y: avgY }
      // Non-machine types start with values that match how the engine treats
      // them: a Connector never processes (0 cycle time, no operator) and a
      // Conveyor moves rather than works (transport time, no operator).
      const data: StationNodeData =
        label === 'Connector'
          ? { label, stationType: label, capacity: 1, cycleTime: 0, operators: 0, shiftsPerDay: [1] }
          : label === 'Conveyor'
            ? { label, stationType: label, capacity: 1, cycleTime: 0, operators: 0, transportTime: 5, shiftsPerDay: [1] }
            : { label, stationType: label, capacity: 1, cycleTime: 30, operators: 1, shiftsPerDay: [1] }
      return [
        ...nds,
        {
          id: `station_${id}`,
          type: 'station',
          position,
          data,
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

  // How many shifts/day this scenario defines — derived from the highest
  // SHIFT_n_START key present in simulation_config, same logic as the
  // backend's SimulationUtils.num_shifts, so "+ Add shift" in Simulation
  // Config (which just adds another SHIFT_n_START/END pair) is immediately
  // reflected here as an extra toggle button, not capped at 3.
  const simCfgRaw = (activeScenario?.simulation_config as Record<string, unknown> | undefined) ?? {}
  let numShifts = 3
  for (let i = 4; simCfgRaw[`SHIFT_${i}_START`] != null; i++) numShifts = i
  // Display-only — renaming happens in Simulation Config's Shift Calendar,
  // not here; this just reflects whatever SHIFT_n_NAME is currently saved.
  const shiftNames: Record<number, string | undefined> = Object.fromEntries(
    Array.from({ length: numShifts }, (_, i) => i + 1).map((n) => [n, simCfgRaw[`SHIFT_${n}_NAME`] as string | undefined])
  )
  // The scenario's GLOBAL working-days pattern per shift number (Simulation
  // Config's Shift Calendar) — the baseline a station's own per-station
  // override (workingDaysByShift) starts from and can diverge away from.
  // Matches the engine's own default (SimulationUtils.working_days): Mon-Fri
  // for shifts 1/2, every day for shift 3+, when the scenario hasn't set one.
  const globalWorkingDays: Record<number, number[]> = Object.fromEntries(
    Array.from({ length: numShifts }, (_, i) => i + 1).map((n) => [
      n,
      (simCfgRaw[`WORKING_DAYS_${n}`] as number[] | undefined) ?? (n <= 2 ? [0, 1, 2, 3, 4] : [0, 1, 2, 3, 4, 5, 6]),
    ])
  )
  // The scenario's GLOBAL shift hours per shift number — same fallback
  // constants as RunDashboard's Simulation Config dialog (SHIFT_DEFAULTS),
  // so a station's "no override" state shows the same hours the user would
  // see in Simulation Config, not an arbitrary placeholder.
  const SHIFT_HOUR_DEFAULTS: Record<number, { start: number; end: number }> = {
    1: { start: 6, end: 14 }, 2: { start: 14, end: 22 }, 3: { start: 22, end: 6 },
  }
  const globalShiftHours: Record<number, { start: number; end: number }> = Object.fromEntries(
    Array.from({ length: numShifts }, (_, i) => i + 1).map((n) => [
      n,
      {
        start: (simCfgRaw[`SHIFT_${n}_START`] as number | undefined) ?? SHIFT_HOUR_DEFAULTS[n]?.start ?? 8,
        end: (simCfgRaw[`SHIFT_${n}_END`] as number | undefined) ?? SHIFT_HOUR_DEFAULTS[n]?.end ?? 16,
      },
    ])
  )
  // The scenario's GLOBAL break windows per shift number — no default breaks
  // for a shift the scenario hasn't configured any for.
  const globalBreaks: Record<number, { start: number; duration: number }[]> = Object.fromEntries(
    Array.from({ length: numShifts }, (_, i) => i + 1).map((n) => [
      n,
      (simCfgRaw[`BREAKS_${n}`] as { start: number; duration: number }[] | undefined) ?? [],
    ])
  )

  /** Add another parallel machine for this station: duplicates the box, renames
   *  both to "Name #1" / "Name #2" (etc.), and wires the copy to the same
   *  predecessors/successors so it stays a proper parallel branch. */
  const addParallelMachine = (id: string) => {
    const newIdNum = nextNodeId()
    const newId = `station_${newIdNum}`

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
        ...incoming.map((e) => ({ ...e, id: `e_${e.source}__${newId}`, target: newId })),
        ...outgoing.map((e) => ({ ...e, id: `e_${newId}__${e.target}`, source: newId })),
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
        // Expand { 1: [0,1,2], 3: [5,6] } into workingDays1/workingDays3 keys
        // — the shape build_station_shift_config reads per shift number.
        const workingDaysFields: Record<string, number[]> = {}
        for (const [shiftNum, days] of Object.entries(n.data.workingDaysByShift ?? {})) {
          workingDaysFields[`workingDays${shiftNum}`] = days
        }
        // Per-station hour-window override, written into the SAME shift{n}
        // field the engine's build_station_shift_config already parses as
        // an "HH:MM-HH:MM" window (see parse_shift_window) — stations built
        // here have never actually used shift{n} for an operator name (that
        // was always a hardcoded 'Op1'/'' placeholder), so repurposing it
        // for the real hour override doesn't collide with anything.
        const shiftHourFields: Record<string, string> = {}
        for (const [shiftNum, hours] of Object.entries(n.data.shiftHoursByShift ?? {})) {
          const pad = (h: number) => String(Math.floor(h) % 24).padStart(2, '0')
          shiftHourFields[`shift${shiftNum}`] = `${pad(hours.start)}:00-${pad(hours.end)}:00`
        }
        // Expand { 1: [...] } into breaks1/breaks3 keys.
        const breaksFields: Record<string, { start: number; duration: number }[]> = {}
        for (const [shiftNum, breaks] of Object.entries(n.data.breaksByShift ?? {})) {
          breaksFields[`breaks${shiftNum}`] = breaks
        }
        stationsData[base] = {
          capacity: capacityCount[base], shifts_per_day: n.data.shiftsPerDay ?? [1],
          operator_per_station: n.data.operators,
          ...(n.data.stationType !== undefined ? { 'Station Type': n.data.stationType } : {}),
          ...(n.data.transportTime !== undefined ? { 'Transport Time': n.data.transportTime } : {}),
          ...(n.data.assemblyCount !== undefined ? { 'Assembly Count': n.data.assemblyCount } : {}),
          ...(n.data.assemblyInputs !== undefined ? { 'Assembly Inputs': n.data.assemblyInputs } : {}),
          ...workingDaysFields,
          ...breaksFields,
          'Failure rate': 0, 'Repair Time': 10, 'PM Schedule': 'Monthly',
          'Material Shortage Probability (%)': 0, 'Rework Probability (%)': 0,
          shift1: '', shift2: '', shift3: '', STATION_DOWNTIME: 0,
          ...shiftHourFields,
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
      // The duration written into the process-flow step. A Conveyor's time is
      // its transport time (the engine reads "Transport Time" but falls back
      // to the step duration), and a Connector never takes any time at all.
      const stepDuration = (n: Node<StationNodeData>): number => {
        const t = inferStationType(n.data.label, n.data.stationType)
        if (t === 'Connector') return 0
        if (t === 'Conveyor') return n.data.transportTime ?? n.data.cycleTime
        return n.data.cycleTime
      }

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
              duration: stepDuration(n),
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
            steps.push({ operation: `${base}_op`, resource: base, duration: stepDuration(n) })
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
      setJustReset(false)
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

                {/* 2D / 3D view toggle (only meaningful in View mode) */}
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
                      <LayoutIcon className="h-3 w-3" /> 2D
                    </button>
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

                {/* Operator skill legend */}
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
            <p className="text-[10px] text-gray-400 mb-3">Drag onto the canvas, or click to drop it in</p>
            <div className="space-y-2">
              {PALETTE_ITEMS.map((item) => {
                const [bgColor, , borderColor] = item.color.split(' ')
                return (
                  <button
                    key={item.label}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('application/linksim-palette-item', item.label)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onClick={() => addNode(item.label)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border border-l-4 border-gray-100 hover:shadow-sm text-left transition-all group cursor-grab active:cursor-grabbing ${borderColor}`}
                  >
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${bgColor}`}>
                      <IsoIcon type={item.label} color={STATION_TYPE_HEX[item.label] ?? DEFAULT_STATION_HEX} />
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
          <div className="flex-1 min-h-0" style={{ height: '100%' }}>
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
                      <LayoutIcon className="h-12 w-12 text-gray-200 mx-auto mb-3" />
                      <p className="text-sm font-medium text-gray-500">
                        {activeScenario ? 'Select a variant to view the process flow' : 'No scenario loaded'}
                      </p>
                    </div>
                  </div>
                )
              )
            ) : (
              <div
                className="w-full h-full"
                onDragOver={(e) => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  const label = e.dataTransfer.getData('application/linksim-palette-item')
                  if (!label || !buildFlowInstance) return
                  const position = buildFlowInstance.screenToFlowPosition({ x: e.clientX, y: e.clientY })
                  addNode(label, position)
                }}
              >
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
                onInit={(instance) => { setBuildFlowInstance(instance); instance.fitView({ padding: 0.2 }) }}
              >
                <Background color={isDark ? '#334155' : undefined} />
                <Controls />
                <MiniMap
                  nodeColor={(n) => {
                    const d = n.data as StationNodeData
                    const inferred = inferStationType(d.label, d.stationType)
                    return (inferred && STATION_TYPE_HEX[inferred]) || DEFAULT_STATION_HEX
                  }}
                  maskColor={isDark ? 'rgba(15,23,42,0.7)' : 'rgba(240,244,255,0.7)'}
                />
              </ReactFlow>
              </div>
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

              {activeRun && selectedFlowNode.data.jobs !== undefined && (
                <div className="bg-blue-50 border border-blue-100 rounded-lg p-2 text-center mb-4">
                  <p className="text-sm font-bold text-blue-700">{selectedFlowNode.data.jobs}</p>
                  <p className="text-[9px] text-blue-600">
                    Jobs completed{activeRun.status !== 'completed' ? ' so far' : ''}
                  </p>
                </div>
              )}

              {activeRun?.status === 'completed' && (
                <>
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">
                    Jobs processed ({selectedFlowNodeJobs.length})
                  </p>
                  {selectedFlowNodeJobs.length > 0 && (
                    <div className="grid grid-cols-2 gap-2 mb-3">
                      <div className="bg-green-50 border border-green-100 rounded-lg p-2 text-center">
                        <p className="text-sm font-bold text-green-700">
                          {selectedFlowNodeJobs.filter(j => (j.status ?? 'Completed') === 'Completed').length}
                        </p>
                        <p className="text-[9px] text-green-600">Completed</p>
                      </div>
                      <div className="bg-amber-50 border border-amber-100 rounded-lg p-2 text-center">
                        <p className="text-sm font-bold text-amber-700">
                          {selectedFlowNodeJobs.filter(j => j.status === 'In Progress').length}
                        </p>
                        <p className="text-[9px] text-amber-600">In progress</p>
                      </div>
                    </div>
                  )}
                  <div className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
                    {selectedFlowNodeJobs.map((j, i) => (
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
                numShifts={numShifts}
                shiftNames={shiftNames}
                globalWorkingDays={globalWorkingDays}
                globalShiftHours={globalShiftHours}
                globalBreaks={globalBreaks}
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
