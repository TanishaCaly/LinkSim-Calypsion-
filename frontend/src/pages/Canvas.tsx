import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactFlow, {
  addEdge, Background, Controls, MiniMap,
  useNodesState, useEdgesState, useEdges,
  type Connection, type Edge, type Node, type NodeTypes, type ReactFlowInstance,
  Handle, Position, MarkerType, ConnectionMode,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  Save, Plus, Trash2, Settings, Eye, Edit3, Play, ChevronLeft, ChevronRight, Box, Layout as LayoutIcon, X,
  ChevronDown, Check,
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
// Assembly, Dismantle), differentiated by the shape
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

/**
 * Flat inspection-table platform for Start/End — matches the reference
 * render: a conveyor feeding onto a low tabletop, a status-light pole, a
 * round button, and (Start only) a box sitting on the table. Deliberately
 * NOT the tall glass-front MachineHousing — Start/End aren't machines
 * doing work, they're just where a job appears on/leaves the line.
 * `hasBox` distinguishes Start (job present) from End (table empty).
 */
function StartEndPlatform({ color, hasBox }: { color: string; hasBox: boolean }) {
  return (
    <g>
      <ConveyorSide x={0} />
      {/* Low tabletop */}
      <rect x="14" y="36" width="38" height="16" rx="2.5" fill={HOUSING} />
      <rect x="14" y="36" width="38" height="16" rx="2.5" fill="none" stroke={HOUSING_SHADE} strokeWidth="1" />
      <rect x="18" y="39" width="30" height="6" rx="1" fill="#f1f5f9" />
      {/* Status-light pole */}
      <rect x="41" y="18" width="3" height="20" fill="#64748b" />
      <rect x="38.5" y="12" width="8" height="7" rx="1.5" fill="#1e293b" />
      <ellipse cx="42.5" cy="13.5" rx="4" ry="2.2" fill={color} />
      {/* Round push-button */}
      <circle cx="46" cy="46.5" r="2.6" fill="#1e293b" />
      <circle cx="46" cy="46.5" r="1.7" fill={color} />
      {hasBox && (
        <>
          <polygon points="24,28 33,32 24,36 15,32" fill={shade('#f97316', 20)} />
          <polygon points="15,32 24,36 24,44 15,40" fill={shade('#f97316', -15)} />
          <polygon points="33,32 24,36 24,44 33,40" fill="#f97316" />
        </>
      )}
    </g>
  )
}

const ISO_ICON_BODY: Record<string, (color: string) => React.ReactNode> = {
  // Start/End deliberately do NOT use the MachineHousing family — see
  // StartEndPlatform above. Start shows a box sitting on the table (a job
  // has just appeared); End shows the table empty (the job has left).
  Source: (color) => <StartEndPlatform color={color} hasBox />,
  Drain: (color) => <StartEndPlatform color={color} hasBox={false} />,
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
  // Worker — a small figure in a hi-vis vest and hardhat, matching the
  // reference render. `color` tints the vest so it still reads as this
  // node's type color (amber) at a glance among the other icons.
  Worker: (color) => (
    <g>
      <ellipse cx="32" cy="56" rx="12" ry="3" fill="#00000014" />
      {/* legs */}
      <rect x="26" y="42" width="5" height="14" rx="2" fill="#475569" />
      <rect x="33" y="42" width="5" height="14" rx="2" fill="#334155" />
      {/* torso + vest */}
      <rect x="24" y="28" width="16" height="16" rx="3" fill="#475569" />
      <rect x="24" y="28" width="16" height="16" rx="3" fill={color} opacity="0.9" />
      <line x1="32" y1="28" x2="32" y2="44" stroke="#f1f5f9" strokeWidth="1.4" />
      <line x1="25" y1="33" x2="31" y2="35" stroke="#f1f5f9" strokeWidth="1.4" />
      <line x1="39" y1="33" x2="33" y2="35" stroke="#f1f5f9" strokeWidth="1.4" />
      {/* arms */}
      <rect x="18" y="29" width="5" height="12" rx="2.5" fill="#334155" />
      <rect x="41" y="29" width="5" height="12" rx="2.5" fill="#334155" />
      {/* head + hardhat */}
      <circle cx="32" cy="20" r="6.5" fill="#f2c9a0" />
      <path d="M24.5 18 a7.5 7.5 0 0 1 15 0 z" fill="#f8fafc" />
      <rect x="24" y="16.5" width="16" height="2.2" rx="1" fill="#e2e8f0" />
    </g>
  ),
  // Workplace — same glass-housing body every other station uses (so it
  // matches the palette's color/shape language instead of standing out),
  // with a small worker figure + robot arm sharing the glass window —
  // a place where both a human and a machine perform work.
  Workplace: (color) => (
    <MachineHousing statusColor={color}>
      {/* worker figure */}
      <circle cx="23" cy="19" r="2.6" fill="#f1f5f9" />
      <rect x="20" y="22.5" width="6" height="7" rx="2" fill="#f1f5f9" />
      {/* robot arm */}
      <rect x="33" y="24" width="2" height="7" rx="1" fill={color} />
      <rect x="33.5" y="17.5" width="7" height="2.4" rx="1.2" fill={color} transform="rotate(-25 34 24)" />
      <circle cx="34" cy="24" r="2" fill={shade(color, -15)} />
    </MachineHousing>
  ),
  // Worker Controller — a badge/access-control reader box: screen, red/green
  // indicator lights, side lever, and a beacon on top, matching the
  // reference render. `color` tints the screen icon and beacon.
  'Worker Controller': (color) => (
    <g>
      <rect x="16" y="52" width="32" height="4" rx="1.5" fill="#1e293b" />
      <rect x="14" y="18" width="36" height="34" rx="3" fill={HOUSING} />
      <rect x="14" y="18" width="36" height="34" rx="3" fill="none" stroke={HOUSING_SHADE} strokeWidth="1" />
      {/* screen */}
      <rect x="19" y="22" width="26" height="14" rx="1.5" fill="#1e293b" />
      <circle cx="26" cy="28" r="3" fill={color} />
      <rect x="31" y="26" width="10" height="1.6" rx="0.8" fill={color} opacity="0.8" />
      <rect x="31" y="29.5" width="10" height="1.6" rx="0.8" fill={color} opacity="0.5" />
      {/* indicator lights + lever */}
      <circle cx="22" cy="42" r="2.2" fill="#4ade80" />
      <circle cx="29" cy="42" r="2.2" fill="#f87171" />
      <rect x="39" y="38" width="6" height="9" rx="1.5" fill={shade(color, -20)} />
      <rect x="40.5" y="34" width="3" height="6" rx="1.5" fill="#334155" />
      {/* beacon */}
      <rect x="29" y="10" width="6" height="6" rx="1.5" fill="#1e293b" />
      <ellipse cx="32" cy="10" rx="3.6" ry="2" fill={color} />
    </g>
  ),
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
  shiftsPerDay?: number[]
  // Set when this station names a Worker Controller pool (stations_data's
  // "Worker Controller" field) — lets the View-mode panel show "Staffed by
  // Worker Controller X" instead of leaving a pooled station looking
  // identical to one using the plain static shift1/2/3 assignment.
  workerController?: string
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
// specified (Station=green, Buffer/Queue=brown, Assembly=pink). "Buffer" is a
// queue/buffer-like station (name contains "Queue"), not a real Object
// Palette item — inferred purely from naming, same as the others below.
// Falls back to green (plain Station) for legacy nodes with no stationType
// set and no recognizable keyword.
const STATION_TYPE_COLORS: Record<string, { border: string; dot: string; handle: string }> = {
  Source:           { border: 'border-emerald-500', dot: 'bg-emerald-500', handle: '!bg-emerald-500' },
  Station:          { border: 'border-green-400',  dot: 'bg-green-500',  handle: '!bg-green-400' },
  'Parallel Station': { border: 'border-cyan-400', dot: 'bg-cyan-500',   handle: '!bg-cyan-400' },
  Buffer:           { border: 'border-amber-700',  dot: 'bg-amber-700',  handle: '!bg-amber-700' },
  Assembly:         { border: 'border-pink-400',   dot: 'bg-pink-500',   handle: '!bg-pink-400' },
  Dismantle:        { border: 'border-lime-500',   dot: 'bg-lime-600',   handle: '!bg-lime-500' },
  Conveyor:         { border: 'border-yellow-500', dot: 'bg-yellow-500', handle: '!bg-yellow-500' },
  Robot:            { border: 'border-indigo-400', dot: 'bg-indigo-500', handle: '!bg-indigo-400' },
  Connector:        { border: 'border-slate-400',  dot: 'bg-slate-500',  handle: '!bg-slate-400' },
  'Movable Part':   { border: 'border-rose-400',   dot: 'bg-rose-500',   handle: '!bg-rose-400' },
  Drain:            { border: 'border-red-400',    dot: 'bg-red-500',   handle: '!bg-red-400' },
  Workplace:        { border: 'border-blue-400',   dot: 'bg-blue-500',  handle: '!bg-blue-400' },
  Worker:           { border: 'border-amber-500',  dot: 'bg-amber-500', handle: '!bg-amber-500' },
  'Worker Controller': { border: 'border-violet-400', dot: 'bg-violet-500', handle: '!bg-violet-400' },
}
const DEFAULT_STATION_COLOR = STATION_TYPE_COLORS.Station

// Same station-type color coding as hex values, for contexts that can't use
// Tailwind classes directly (e.g. React Flow's MiniMap nodeColor prop).
const STATION_TYPE_HEX: Record<string, string> = {
  Source: '#10b981', Station: '#22c55e', 'Parallel Station': '#06b6d4', Buffer: '#b45309',
  Assembly: '#ec4899', Dismantle: '#65a30d',
  Conveyor: '#eab308', Robot: '#6366f1', Connector: '#64748b', 'Movable Part': '#f43f5e', Drain: '#ef4444',
  Workplace: '#3b82f6', Worker: '#f59e0b', 'Worker Controller': '#8b5cf6',
}
const DEFAULT_STATION_HEX = STATION_TYPE_HEX.Station

/**
 * Infer a station's palette type for color-coding when stationType isn't
 * set — which is EVERY station in a scenario imported from Excel/YAML,
 * since 'Station Type' is a Canvas-only concept never written by the
 * parsers. Falls back to keyword-matching the station's name, the same
 * pattern already used for isAssembly below, extended to Buffer too.
 * Defaults to 'Station' (the common case — a plain
 * processing station) when no special keyword matches, rather than an
 * "unknown" color, since that's what almost every unmatched name actually is.
 */
function inferStationType(label: string, stationType?: string): string {
  if (stationType) return stationType
  const name = label.toLowerCase()
  if (name.startsWith('assembly')) return 'Assembly'
  if (/dismantle|disassembl/.test(name)) return 'Dismantle'
  if (/queue|buffer/.test(name)) return 'Buffer'
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
function StationNode({ id, data, selected }: { id: string; data: StationNodeData; selected: boolean }) {
  const inferredType = inferStationType(data.label, data.stationType)
  const colors = (inferredType && STATION_TYPE_COLORS[inferredType]) || DEFAULT_STATION_COLOR
  // Worker/Workplace/Worker Controller are annotation-scale nodes (zero-time,
  // no capacity of their own) — a slightly smaller icon than the full
  // machine housing types reads as "lighter weight" and reduces the crowding
  // these three caused sitting at full station size.
  const isSmallIcon = inferredType === 'Worker' || inferredType === 'Workplace' || inferredType === 'Worker Controller'

  // A Workplace, Worker, or Worker Controller with no edges at all isn't
  // wired into anything yet — grey it out on the canvas so it visually
  // reads as "not wired in" until the user connects it (Workplace to a
  // station, Worker/Worker Controller to each other).
  const edges = useEdges()
  const isUnwired =
    (inferredType === 'Workplace' || inferredType === 'Worker' || inferredType === 'Worker Controller') &&
    !edges.some((e) => e.source === id || e.target === id)

  // Default React Flow handles render at ~6px — easy to miss the hit-box on
  // a fast drag, especially for the smaller Worker/Workplace/Worker
  // Controller icons. Sized up with a white ring so they're both a bigger
  // target and visible against any icon behind them.
  const handleStyle = { width: 14, height: 14, border: '2px solid white' }

  // Both dots are declared type="source". Under connectionMode={Loose} a
  // source handle can both START and RECEIVE a connection (only "target"
  // handles are start-restricted), so this makes every dot symmetric —
  // any dot really can connect to any dot, in either direction — without
  // stacking two overlapping <Handle> elements on the same spot (that
  // approach silently breaks pointer hit-testing for whichever one ends
  // up underneath).
  return (
    <div className="flex flex-col items-center px-1 py-1 group">
      <Handle id="left" type="source" position={Position.Left} className={colors.handle} style={handleStyle} />
      {/* Just the icon artwork + name — no card/rectangle around it. The
          selection ring sits behind the icon rather than boxing it in, so
          the icon's own silhouette (housing, robot arm, belt, ...) stays
          the only visible shape. */}
      <div
        className={`${isSmallIcon ? 'w-24 h-24' : 'w-32 h-32'} rounded-xl transition-shadow ${selected ? 'ring-2 ring-blue-500 ring-offset-2' : 'group-hover:ring-2 group-hover:ring-blue-200 group-hover:ring-offset-2'} ${isUnwired ? 'grayscale opacity-60' : ''}`}
      >
        <IsoIcon type={inferredType} color={(inferredType && STATION_TYPE_HEX[inferredType]) || DEFAULT_STATION_HEX} />
      </div>
      <span className="text-sm font-semibold text-gray-800 truncate max-w-[150px] mt-1 bg-white/80 px-1.5 rounded">
        {data.label}
      </span>
      <Handle id="right" type="source" position={Position.Right} className={colors.handle} style={handleStyle} />
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

// Read-only "Shifts available" display (View-mode station panel) — a plain
// row of pills, one per shift, stops being readable once a scenario defines
// more than a handful (wraps into several messy lines). Caps the pills shown
// and folds the rest behind a "+N more" toggle instead, same idea as
// ShiftAvailabilityDropdown below but for a static list, not an editor.
function ShiftPillList({
  shiftNums, shiftNames, maxVisible = 4,
}: {
  shiftNums: number[]
  shiftNames: Record<number, string | undefined>
  maxVisible?: number
}) {
  const [expanded, setExpanded] = useState(false)
  const shiftLabel = (n: number) => shiftNames[n]?.trim() || `Shift ${n}`
  const visible = expanded ? shiftNums : shiftNums.slice(0, maxVisible)
  const hiddenCount = shiftNums.length - visible.length

  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((n) => (
        <span
          key={n}
          className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200"
        >
          {shiftLabel(n)}
        </span>
      ))}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors"
        >
          +{hiddenCount} more
        </button>
      )}
      {expanded && shiftNums.length > maxVisible && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors"
        >
          Show less
        </button>
      )}
    </div>
  )
}

// A multi-select dropdown for which shifts a station runs — a button-grid
// with one cell per shift stops being usable once a scenario defines more
// than ~6 shifts (wraps into an unreadable multi-row mess), so this instead
// shows a compact summary ("Shift 1, Shift 2" or "3 shifts selected") and
// opens a scrollable checklist on click, which stays readable at any shift count.
function ShiftAvailabilityDropdown({
  numShifts, shiftNames, selected, onChange,
}: {
  numShifts: number
  shiftNames: Record<number, string | undefined>
  selected: number[]
  onChange: (next: number[]) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  const shiftLabel = (n: number) => shiftNames[n]?.trim() || `Shift ${n}`
  const summary =
    selected.length === 0 ? 'No shifts selected'
    : selected.length === 1 ? shiftLabel(selected[0])
    : selected.length <= 2 ? selected.map(shiftLabel).join(', ')
    : `${selected.length} shifts selected`

  const toggle = (shiftNum: number) => {
    const next = selected.includes(shiftNum)
      ? selected.filter((n) => n !== shiftNum)
      : [...selected, shiftNum]
    onChange(next.sort((a, b) => a - b))
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`w-full h-8 flex items-center justify-between gap-2 rounded-lg border px-2.5 text-xs font-semibold transition-colors ${
          selected.length === 0
            ? 'border-amber-200 bg-amber-50 text-amber-600'
            : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
        }`}
      >
        <span className="truncate">{summary}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute left-0 right-0 z-20 mt-1 max-h-52 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg py-1">
          {Array.from({ length: numShifts }, (_, i) => i + 1).map((shiftNum) => {
            const active = selected.includes(shiftNum)
            return (
              <button
                key={shiftNum}
                type="button"
                onClick={() => toggle(shiftNum)}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-left transition-colors ${
                  active ? 'bg-emerald-50 hover:bg-emerald-100' : 'hover:bg-gray-50'
                }`}
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                    active ? 'bg-emerald-500 border-emerald-500' : 'border-gray-300 bg-white'
                  }`}
                >
                  {active && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
                </span>
                <span className={active ? 'font-semibold text-emerald-700' : 'text-gray-500'}>{shiftLabel(shiftNum)}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// A plain native <select>'s dropdown popup is rendered by the OS/browser,
// not by our CSS — so it always shows default black-border/blue-highlight
// styling no matter what className is put on the <select> itself. This is a
// small custom single-select styled the same way ShiftAvailabilityDropdown
// is (toggle button + absolute styled panel + click-outside-to-close), so
// both the closed control and the open list match the rest of the app.
function StyledSelect({
  value, options, onChange,
}: {
  value: string
  options: { value: string; label: string }[]
  onChange: (next: string) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  const current = options.find((o) => o.value === value)

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full h-8 flex items-center justify-between gap-2 rounded-lg border border-gray-200 bg-gray-50 hover:bg-white px-2.5 text-sm text-gray-900 transition-colors"
      >
        <span className="truncate">{current?.label ?? value}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute left-0 right-0 z-20 mt-1 rounded-lg border border-gray-200 bg-white shadow-lg py-1">
          {options.map((opt) => {
            const active = opt.value === value
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => { onChange(opt.value); setOpen(false) }}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-left transition-colors ${
                  active ? 'bg-blue-50 hover:bg-blue-100' : 'hover:bg-gray-50'
                }`}
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors ${
                    active ? 'border-blue-500' : 'border-gray-300'
                  }`}
                >
                  {active && <span className="h-2 w-2 rounded-full bg-blue-500" />}
                </span>
                <span className={active ? 'font-semibold text-blue-700' : 'text-gray-600'}>{opt.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function MultiStyledSelect({
  values, options, onChange, placeholder = 'Select…',
}: {
  values: string[]
  options: { value: string; label: string }[]
  onChange: (next: string[]) => void
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  const selectedLabels = options.filter((o) => values.includes(o.value)).map((o) => o.label)
  const toggle = (value: string) =>
    onChange(values.includes(value) ? values.filter((v) => v !== value) : [...values, value])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full h-8 flex items-center justify-between gap-2 rounded-lg border border-gray-200 bg-gray-50 hover:bg-white px-2.5 text-xs text-gray-900 transition-colors"
      >
        <span className="truncate">
          {selectedLabels.length > 0 ? selectedLabels.join(', ') : placeholder}
        </span>
        <ChevronDown className={`h-3 w-3 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute left-0 right-0 z-20 mt-1 rounded-lg border border-gray-200 bg-white shadow-lg py-1">
          {options.length === 0 ? (
            <p className="px-2.5 py-1.5 text-xs text-gray-400">No tasks yet.</p>
          ) : (
            options.map((opt) => {
              const active = values.includes(opt.value)
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => toggle(opt.value)}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-left transition-colors ${
                    active ? 'bg-blue-50 hover:bg-blue-100' : 'hover:bg-gray-50'
                  }`}
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                      active ? 'border-blue-500 bg-blue-500' : 'border-gray-300'
                    }`}
                  >
                    {active && <Check className="h-3 w-3 text-white" />}
                  </span>
                  <span className={active ? 'font-semibold text-blue-700' : 'text-gray-600'}>{opt.label}</span>
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

// ─── Property editor ─────────────────────────────────────────────────────────

function PropertyEditor({
  node, nodes, edges, onChange, onDelete, onSaveStation, onAddParallel, onAddWorkplace, onRemoveWorkplace, onToggleWire, onAssignOperator, onUnassignOperator, numShifts, shiftNames, operatorsData,
}: {
  node: Node<StationNodeData>
  nodes: Node<StationNodeData>[]
  edges: Edge[]
  onChange: (id: string, data: Partial<StationNodeData>) => void
  onDelete: (id: string) => void
  onSaveStation: () => void
  onAddParallel: (id: string) => void
  onAddWorkplace: (id: string) => void
  onRemoveWorkplace: (id: string) => void
  onToggleWire: (sourceId: string, targetId: string, connect: boolean) => void
  onAssignOperator: (operatorName: string, controllerId: string, workplaceId: string) => void
  onUnassignOperator: (operatorName: string, controllerId: string, workplaceId: string) => void
  numShifts: number
  shiftNames: Record<number, string | undefined>
  operatorsData: Record<string, { 'Skill Rating': number; 'Availability (%)': number }>
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
  // Worker and Worker Controller are zero-time annotation nodes, just like
  // Connector — they don't do work themselves. A Worker Controller becomes a
  // live dispatch pool at run time, drawing from every Worker wired upstream
  // of it and staffing every Workplace wired downstream (see the save
  // mutation's pool-wiring walk, and backend/engine/worker_pool.py).
  const isWorker = nodeType === 'Worker'
  const isWorkerController = nodeType === 'Worker Controller'
  const isAnnotation = isConnector || isBookend || isWorker || isWorkerController

  // Non-blocking heads-up for a Worker Controller with nothing actually
  // wired to it yet — same idea as RunDashboard.tsx's shiftCalendarWarnings:
  // saving/running still works either way, this just flags a pool that will
  // silently do nothing at run time (no Workers to dispatch, or nothing to
  // dispatch them TO). Mirrors the save mutation's own upstream walk
  // (Worker/Connector/Workplace are passthroughs) so the check matches
  // exactly what gets written to stations_data on save.
  const controllerWarnings: string[] = []
  if (isWorkerController) {
    const seen = new Set<string>()
    let hasWorker = false
    const staffedStations: Node<StationNodeData>[] = []
    let frontierIds = [node.id]
    while (frontierIds.length > 0) {
      const nextIds: string[] = []
      for (const id of frontierIds) {
        if (seen.has(id)) continue
        seen.add(id)
        for (const e of edges.filter((edge) => edge.target === id)) {
          const neighbor = nodes.find((nn) => nn.id === e.source)
          if (!neighbor) continue
          const t = inferStationType(neighbor.data.label, neighbor.data.stationType)
          if (t === 'Worker') hasWorker = true
          if (t === 'Worker' || t === 'Connector' || t === 'Workplace') {
            nextIds.push(neighbor.id)
          } else {
            staffedStations.push(neighbor)
          }
        }
      }
      frontierIds = nextIds
    }
    if (!hasWorker) controllerWarnings.push('No Workers wired in — this pool has nobody to dispatch.')
    if (staffedStations.length === 0) controllerWarnings.push('No stations staffed — wire a Workplace to a real station.')
  }
  // Workplace behaves exactly like Station, but a workplace with 0 operators
  // makes no sense (per its whole purpose — a station that requires a
  // worker), so its Operators field is clamped to a minimum of 1 instead of
  // allowing the machine-only 0 that a plain Station permits.
  const isWorkplace = nodeType === 'Workplace'
  const isBuffer = nodeType === 'Buffer'
  const isRobot = nodeType === 'Robot'
  // A plain, real station (not Connector/Conveyor/Source/Drain/Worker/
  // Workplace/Worker Controller/Buffer/Robot) can opt into being staffed
  // directly by a Worker Controller via the "Requires Workplace" checkbox
  // below, instead of needing a separate Workplace node manually wired in.
  // A Buffer is just a queue/holding spot, and a Robot runs unattended —
  // neither is ever a place a Worker stands, so both are excluded the same
  // as the annotation types.
  const isPlainStation = !isAnnotation && !isConveyor && !isWorkplace && !isBuffer && !isRobot

  // Non-blocking heads-up for a Workplace not actually wired into anything —
  // it needs BOTH an incoming edge from a real station (what it staffs) and
  // an outgoing edge reaching a Worker Controller (through any chain of
  // Connectors) to do anything at run time.
  const workplaceWarnings: string[] = []
  // Operators of every Worker currently wired into the Worker Controller
  // this Workplace reaches — informational only (a Workplace never picks an
  // operator itself; it's staffed by whichever Worker(s) are in that pool).
  let workplaceOperatorNames: string[] = []
  let reachedController: Node<StationNodeData> | null = null
  if (isWorkplace) {
    const hasRealStationIn = edges
      .filter((e) => e.target === node.id)
      .some((e) => {
        const src = nodes.find((nn) => nn.id === e.source)
        if (!src) return false
        const t = inferStationType(src.data.label, src.data.stationType)
        return t !== 'Worker' && t !== 'Worker Controller' && t !== 'Workplace'
      })
    const seen = new Set<string>()
    let frontierIds = [node.id]
    while (frontierIds.length > 0 && !reachedController) {
      const nextIds: string[] = []
      for (const id of frontierIds) {
        if (seen.has(id)) continue
        seen.add(id)
        for (const e of edges.filter((edge) => edge.source === id)) {
          const dest = nodes.find((nn) => nn.id === e.target)
          if (!dest) continue
          const t = inferStationType(dest.data.label, dest.data.stationType)
          if (t === 'Worker Controller') { reachedController = dest; break }
          if (t === 'Connector') nextIds.push(dest.id)
        }
        if (reachedController) break
      }
      frontierIds = nextIds
    }
    if (!hasRealStationIn) workplaceWarnings.push('Not connected from a real station — nothing to staff.')
    if (!reachedController) workplaceWarnings.push('Not wired to a Worker Controller — this pool link does nothing.')
    if (reachedController) {
      workplaceOperatorNames = edges
        .filter((e) => e.target === reachedController!.id)
        .map((e) => nodes.find((nn) => nn.id === e.source))
        .filter((n): n is Node<StationNodeData> => !!n && inferStationType(n.data.label, n.data.stationType) === 'Worker')
        // A Worker with no assignedWorkplaceIds set hasn't used the picker
        // yet — treat it as serving every Workplace on its Controller
        // (old/simple behaviour). Once a Worker has picked specific
        // Workplaces, only show it under those, not every sibling Workplace
        // sharing the same Controller pool.
        .filter((n) => !n.data.assignedWorkplaceIds || n.data.assignedWorkplaceIds.includes(node.id))
        .map((n) => n.data.assignedOperator)
        .filter((op): op is string => !!op)
    }
  }

  // A plain station's Tasks mirror whichever Worker Controller staffs it —
  // reached via its Workplace child (Station -> Workplace -> ... -> Controller),
  // same chain the Workplace panel walks above. Kept as one shared list (on
  // the Controller node) rather than a separate per-station list, so editing
  // Tasks from either panel stays in sync.
  let stationReachedController: Node<StationNodeData> | null = null
  if (isPlainStation) {
    const workplaceChild = edges
      .filter((e) => e.source === node.id)
      .map((e) => nodes.find((nn) => nn.id === e.target))
      .find((n): n is Node<StationNodeData> => !!n && inferStationType(n.data.label, n.data.stationType) === 'Workplace')
    if (workplaceChild) {
      const seen = new Set<string>()
      let frontierIds = [workplaceChild.id]
      while (frontierIds.length > 0 && !stationReachedController) {
        const nextIds: string[] = []
        for (const id of frontierIds) {
          if (seen.has(id)) continue
          seen.add(id)
          for (const e of edges.filter((edge) => edge.source === id)) {
            const dest = nodes.find((nn) => nn.id === e.target)
            if (!dest) continue
            const t = inferStationType(dest.data.label, dest.data.stationType)
            if (t === 'Worker Controller') { stationReachedController = dest; break }
            if (t === 'Connector') nextIds.push(dest.id)
          }
          if (stationReachedController) break
        }
        frontierIds = nextIds
      }
    }
  }

  const fields = isAnnotation
    // A Worker is identified purely by its picked Operator (see below) — an
    // extra free-text Name would be redundant with that and never appears
    // anywhere the operator name doesn't already, so it's dropped here.
    ? (isWorker ? [] : [{ key: 'label', label: 'Name', type: 'text' }])
    : isConveyor
      ? [
          { key: 'label',         label: 'Name',                type: 'text'   },
          { key: 'transportTime', label: 'Transport Time (min)', type: 'number' },
        ]
      // A Workplace is never its own processflow step (see the save
      // mutation's stepDuration — always 0 for Workplace) and its Operators
      // count is never read either, since real staffing comes from the
      // Worker Controller's pool. Cycle Time/Operators would silently do
      // nothing here, so only Name is shown.
      : isWorkplace
        ? [{ key: 'label', label: 'Name', type: 'text' }]
        : [
            { key: 'label',     label: 'Name',            type: 'text'   },
            { key: 'cycleTime', label: 'Cycle Time (min)', type: 'number' },
            { key: 'operators', label: 'Operators',        type: 'number' },
          ]

  // An operator is one real person — the same one can't be two separate
  // Worker nodes at once. Kept in the list (not filtered out) so the full
  // roster is always visible, but disabled for picking once assigned to any
  // OTHER Worker node on the canvas (this node's own current pick stays
  // enabled, so re-opening the dropdown doesn't disable its own selection).
  const operatorsTakenElsewhere = new Set(
    nodes
      .filter((n) => n.id !== node.id && inferStationType(n.data.label, n.data.stationType) === 'Worker')
      .map((n) => n.data.assignedOperator)
      .filter((op): op is string => !!op)
  )
  const operatorNames = Object.keys(operatorsData)

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
  // A Workplace/Worker/Worker Controller reached from here is pool-wiring,
  // not a real routing destination — excluded so wiring a Workplace next to
  // a station never looks like a 2-way branch needing an Exit Controller.
  const destinationBases = Array.from(new Set(
    edges
      .filter((e) => e.source === node.id)
      .map((e) => nodes.find((n) => n.id === e.target))
      .filter((n): n is Node<StationNodeData> => !!n)
      .filter((n) => {
        const t = inferStationType(n.data.label, n.data.stationType)
        return t !== 'Workplace' && t !== 'Worker' && t !== 'Worker Controller'
      })
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

        {/* Plain station — check to auto-create a Workplace node wired to
            this station (Station -> Workplace); wire that Workplace on to a
            Worker Controller yourself to finish staffing it. Unchecking
            removes whichever Workplace(s) this created. */}
        {isPlainStation && (
          <div>
            <label className="flex items-center gap-2 text-xs font-semibold text-gray-700">
              <input
                type="checkbox"
                checked={node.data.requiresWorker ?? false}
                onChange={(e) => {
                  onChange(node.id, { requiresWorker: e.target.checked })
                  if (e.target.checked) onAddWorkplace(node.id)
                  else onRemoveWorkplace(node.id)
                }}
                className="h-3.5 w-3.5 rounded border-gray-300"
              />
              Requires Workplace
            </label>
            {node.data.requiresWorker && (
              <p className="text-[10px] text-gray-400 mt-1.5">
                A Workplace node was added below this station — wire it to a Worker Controller to finish staffing it.
              </p>
            )}
          </div>
        )}

        {isPlainStation && (
          <div>
            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
              Tasks
            </label>
            {stationReachedController ? (() => {
              const controllerId = stationReachedController!.id
              const tasks = stationReachedController!.data.controllerTasks ?? [
                { id: 'demo-1', label: 'Restock cutting station thread spools', done: false },
              ]
              const toggleTask = (id: string) =>
                onChange(controllerId, {
                  controllerTasks: tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
                })
              const removeTask = (id: string) =>
                onChange(controllerId, { controllerTasks: tasks.filter((t) => t.id !== id) })
              const addTask = () =>
                onChange(controllerId, {
                  controllerTasks: [...tasks, { id: `task-${Date.now()}`, label: 'New task', done: false }],
                })
              return (
                <div className="space-y-1.5">
                  {tasks.length > 0 ? (
                    <div className="rounded-lg border border-gray-200 divide-y divide-gray-100">
                      {tasks.map((t) => (
                        <div key={t.id} className="flex items-center gap-2 px-2 py-1.5">
                          <input
                            type="checkbox"
                            checked={t.done}
                            onChange={() => toggleTask(t.id)}
                            className="h-3.5 w-3.5 rounded border-gray-300 shrink-0"
                          />
                          <input
                            type="text"
                            value={t.label}
                            onChange={(e) =>
                              onChange(controllerId, {
                                controllerTasks: tasks.map((tt) =>
                                  tt.id === t.id ? { ...tt, label: e.target.value } : tt
                                ),
                              })
                            }
                            className="text-xs flex-1 min-w-0 bg-transparent border-none focus:outline-none focus:ring-1 focus:ring-indigo-300 rounded px-1 -mx-1 text-gray-700"
                          />
                          <button
                            onClick={() => removeTask(t.id)}
                            className="text-gray-300 hover:text-red-500 transition-colors shrink-0"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[10px] text-gray-400">No tasks yet.</p>
                  )}
                  <button
                    onClick={addTask}
                    className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[11px] font-semibold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg border border-indigo-100 transition-colors"
                  >
                    <Plus className="w-3 h-3" /> Add task
                  </button>
                </div>
              )
            })() : (
              <p className="text-[10px] text-gray-400">
                Wire this station's Workplace to a Worker Controller to see and edit its Tasks here.
              </p>
            )}
          </div>
        )}

        {/* Worker — pick which named operator (defined in the scenario's
            Operators tab) this node represents, plus how long it takes this
            worker to move to a DIFFERENT Workplace than the one it was last
            dispatched to (no cost returning to the same one). Contributes
            into whichever Worker Controller's pool this node is wired to. */}
        {isWorker && (
          <div>
            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
              Operator
            </label>
            {operatorNames.length > 0 ? (
              <select
                value={node.data.assignedOperator ?? ''}
                onChange={(e) => {
                  const picked = e.target.value || undefined
                  // The canvas node's own label follows the picked operator's
                  // name (e.g. "Op1") instead of staying the generic "Worker
                  // N" it was created with, so the wiring diagram reads as
                  // who's actually assigned, not just which box was dropped
                  // first. Falls back to the type name if cleared.
                  onChange(node.id, { assignedOperator: picked, label: picked ?? 'Worker' })
                }}
                className="w-full h-8 text-sm rounded-lg border border-gray-200 bg-gray-50 focus:bg-white px-2"
              >
                <option value="">Select an operator…</option>
                {operatorNames.map((name) => (
                  <option key={name} value={name} disabled={operatorsTakenElsewhere.has(name)}>
                    {name}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-[10px] text-amber-500">No operators defined yet — add one in the Operators tab.</p>
            )}
            {node.data.assignedOperator && operatorsData[node.data.assignedOperator] && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div className="bg-gray-50 border border-gray-100 rounded-lg p-2 text-center">
                  <p className="text-sm font-bold text-gray-800">{operatorsData[node.data.assignedOperator]['Skill Rating']}</p>
                  <p className="text-[9px] text-gray-500">Skill Rating</p>
                </div>
                <div className="bg-gray-50 border border-gray-100 rounded-lg p-2 text-center">
                  <p className="text-sm font-bold text-gray-800">{operatorsData[node.data.assignedOperator]['Availability (%)']}%</p>
                  <p className="text-[9px] text-gray-500">Availability</p>
                </div>
              </div>
            )}
            <div className="mt-3">
              <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                Travel Time (min)
              </label>
              <NumericField
                value={node.data.travelTime ?? 0}
                onCommit={(n) => onChange(node.id, { travelTime: Math.max(0, n) })}
                className="h-8 text-sm rounded-lg border-gray-200 bg-gray-50 focus:bg-white [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
              />
              <p className="text-[10px] text-gray-400 mt-1">Delay paid only when reassigned to a different Workplace.</p>
            </div>
            <p className="text-[10px] text-gray-400 mt-2">Connect this to a Worker Controller to join its pool.</p>

            <div className="mt-3">
              <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                Workplaces
              </label>
              {(() => {
                const controllerEdge = edges.find(
                  (e) =>
                    e.source === node.id &&
                    (() => {
                      const dest = nodes.find((nn) => nn.id === e.target)
                      return dest ? inferStationType(dest.data.label, dest.data.stationType) === 'Worker Controller' : false
                    })()
                )
                const controllerId = controllerEdge?.target
                const allWorkplaces = nodes.filter((n) => inferStationType(n.data.label, n.data.stationType) === 'Workplace')
                if (!controllerId) {
                  return (
                    <p className="text-[10px] text-gray-400">
                      Connect this Worker to a Worker Controller first, then pick Workplaces here.
                    </p>
                  )
                }
                if (allWorkplaces.length === 0) {
                  return <p className="text-[10px] text-gray-400">No Workplaces on the canvas yet.</p>
                }
                const assignedIds = node.data.assignedWorkplaceIds ?? []
                return (
                  <div className="rounded-lg border border-gray-200 divide-y divide-gray-100 max-h-40 overflow-y-auto">
                    {allWorkplaces.map((wp) => {
                      const checked = assignedIds.includes(wp.id)
                      return (
                        <label
                          key={wp.id}
                          className="flex items-center gap-2 px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-50 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              // This Worker's own picked-list — independent of
                              // any other Worker sharing the same Controller
                              // pool (assignedWorkplaceIds), so OP_01 checking
                              // a Workplace never shows as checked for OP_02.
                              onChange(node.id, {
                                assignedWorkplaceIds: e.target.checked
                                  ? [...assignedIds, wp.id]
                                  : assignedIds.filter((id) => id !== wp.id),
                              })
                              // Still keep the real Workplace -> Controller
                              // edge present so the pool-wiring/save logic and
                              // the Workplace's own Operators picker see this
                              // Workplace as reachable from the Controller.
                              if (e.target.checked && !edges.some((ed) => ed.source === wp.id && ed.target === controllerId)) {
                                onToggleWire(wp.id, controllerId, true)
                              }
                            }}
                            className="h-3.5 w-3.5 rounded border-gray-300"
                          />
                          {wp.data.label}
                        </label>
                      )
                    })}
                  </div>
                )
              })()}
              <p className="text-[10px] text-gray-400 mt-1">
                Checked Workplaces are the ones this Worker serves.
              </p>
            </div>
          </div>
        )}

        {/* Worker Controller — the dispatch brain. It does not do work
            itself: it maintains a pool of Workers (wired IN, upstream) and
            staffs Workplaces (wired OUT, downstream) — see the save
            mutation's pool-wiring walk and worker_pool.py's WorkerPool for
            exactly how each setting below is used at run time. */}
        {isWorkerController && (
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-xs font-semibold text-gray-700">
              <input
                type="checkbox"
                checked={node.data.controllerEnabled ?? true}
                onChange={(e) => onChange(node.id, { controllerEnabled: e.target.checked })}
                className="h-3.5 w-3.5 rounded border-gray-300"
              />
              Enabled
            </label>

            <div>
              <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                Assignment Strategy
              </label>
              <StyledSelect
                value={node.data.assignmentStrategy ?? 'first_available'}
                onChange={(v) => onChange(node.id, { assignmentStrategy: v as 'first_available' | 'round_robin' })}
                options={[
                  { value: 'first_available', label: 'First Available' },
                  { value: 'round_robin', label: 'Round Robin' },
                ]}
              />
            </div>

            <label className="flex items-center gap-2 text-xs font-semibold text-gray-700">
              <input
                type="checkbox"
                checked={node.data.useWorkerTravelTime ?? true}
                onChange={(e) => onChange(node.id, { useWorkerTravelTime: e.target.checked })}
                className="h-3.5 w-3.5 rounded border-gray-300"
              />
              Use Worker Travel Time
            </label>

            <p className="text-[10px] text-gray-400">
              Wire Worker(s) in and Workplace(s) out to build this Controller's pool, or pick Workers below.
            </p>

            {/* Combined Workers + Tasks table — checking a Worker in still
                creates/removes exactly the same edge the canvas wiring uses
                (Worker -> Controller), so walkRealStations and the save
                mutation don't need to know this table exists at all. Each
                wired Worker additionally gets a Task dropdown right in its
                row (assignedTaskId, UI-only), so assigning "who does what"
                happens in one place instead of two separate lists.
                Workplaces are wired in from the Workplace node's own panel
                instead (its Operators picker), not from here. */}
            <div>
              <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                Workers &amp; Tasks
              </label>
              {(() => {
                const workers = nodes.filter((n) => inferStationType(n.data.label, n.data.stationType) === 'Worker')
                return workers.length > 0 ? (
                  <table className="w-full table-fixed border border-gray-200 rounded-lg border-collapse">
                    <thead>
                      <tr className="bg-gray-50">
                        <th className="w-20 text-left text-[10px] font-bold text-gray-400 uppercase tracking-widest px-2 py-1.5 border-b border-gray-200">
                          Worker
                        </th>
                        <th className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-widest px-2 py-1.5 border-b border-gray-200">
                          Task
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {workers.map((w) => {
                        const wired = edges.some((e) => e.source === w.id && e.target === node.id)
                        const taskTexts = w.data.taskTexts ?? ['']
                        return (
                          <tr key={w.id}>
                            <td className="px-2 py-1.5 align-top w-20 overflow-hidden">
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={wired}
                                  onChange={(e) => onToggleWire(w.id, node.id, e.target.checked)}
                                  className="h-3.5 w-3.5 rounded border-gray-300 shrink-0"
                                />
                                <span className="text-xs text-gray-700 truncate">{w.data.label}</span>
                              </label>
                            </td>
                            <td className="px-2 py-1.5 align-top">
                              {wired && (
                                <div className="space-y-1 min-w-0">
                                  {taskTexts.map((text, i) => (
                                    <div key={i} className="flex items-center gap-1 min-w-0">
                                      <div className="group/tt relative min-w-0 flex-1">
                                        <input
                                          type="text"
                                          value={text}
                                          onChange={(e) =>
                                            onChange(w.id, {
                                              taskTexts: taskTexts.map((t, ti) => (ti === i ? e.target.value : t)),
                                            })
                                          }
                                          placeholder="blank space to write the task"
                                          className="w-full min-w-0 text-xs bg-gray-50 border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300 text-gray-700 placeholder:text-gray-400"
                                        />
                                        {text && (
                                          <span className="pointer-events-none absolute left-0 top-full mt-1 z-30 max-w-xs whitespace-normal break-words rounded-lg bg-white text-gray-700 text-xs font-medium px-3 py-2 shadow-lg border border-gray-100 opacity-0 scale-95 origin-top transition-all duration-150 group-hover/tt:opacity-100 group-hover/tt:scale-100">
                                            {text}
                                          </span>
                                        )}
                                      </div>
                                      <button
                                        onClick={() => {
                                          const next = taskTexts.filter((_, ti) => ti !== i)
                                          onChange(w.id, { taskTexts: next.length > 0 ? next : [''] })
                                        }}
                                        className="text-gray-300 hover:text-red-500 transition-colors shrink-0"
                                      >
                                        <Trash2 className="w-3 h-3" />
                                      </button>
                                    </div>
                                  ))}
                                  <button
                                    onClick={() => onChange(w.id, { taskTexts: [...taskTexts, ''] })}
                                    className="flex items-center gap-1 text-[10px] font-semibold text-indigo-600 hover:text-indigo-700 transition-colors"
                                  >
                                    <Plus className="w-3 h-3" /> Add task
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-[10px] text-gray-400">No Workers on the canvas yet.</p>
                )
              })()}
            </div>

            {controllerWarnings.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 space-y-1">
                {controllerWarnings.map((w, i) => (
                  <p key={i} className="text-[10px] text-amber-700 flex items-start gap-1">
                    <span className="shrink-0">⚠</span>
                    <span>{w}</span>
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Shift availability — any combination of the day's shifts (1, 2, 3)
            this station actually runs on, e.g. shift 2+3 while skipping
            shift 1. Feeds shifts_per_day, which the engine reads directly
            when deciding if the station is active. Names shown come from
            the scenario's simulation_config (SHIFT_n_NAME) — renamed from
            Simulation Config's Shift Calendar, not editable here. Not shown
            for Connector/Source/Drain — none of them are ever "off shift"
            in a way that means anything. Not shown for Workplace either —
            its shifts always mirror the station it staffs (see
            addWorkplaceFor/updateNode), so editing it here would be
            misleading. */}
        {!isAnnotation && !isWorkplace && (
        <div>
          <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
            Shift Available
          </label>
          <ShiftAvailabilityDropdown
            numShifts={numShifts}
            shiftNames={shiftNames}
            selected={node.data.shiftsPerDay ?? [1]}
            onChange={(next) => onChange(node.id, { shiftsPerDay: next })}
          />
          {(node.data.shiftsPerDay ?? [1]).length === 0 && (
            <p className="text-[10px] text-amber-500 mt-1">No shift selected — station will never be active.</p>
          )}
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
            field. Not meaningful for Connector/Source/Drain/Worker/Worker
            Controller — there is only ever exactly one of each in a line.
            Not meaningful for Workplace either — a Workplace just names
            which station a Worker Controller staffs; "more capacity" there
            is already the station's own Parallel Machines / the pool's own
            Worker count, not a second Workplace. Not meaningful for Buffer
            either — a Buffer is just a queue/holding spot, not a machine
            whose throughput scales with parallel lanes. */}
        {!isAnnotation && !isWorkplace && !isBuffer && (
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

        {isWorkplace && (
          <div>
            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
              Operators &amp; Tasks
            </label>
            {!reachedController ? (
              <p className="text-[10px] text-gray-400">
                Wire this Workplace to a Worker Controller to assign operators here.
              </p>
            ) : Object.keys(operatorsData).length > 0 ? (
              (() => {
                return (
                  <div className="rounded-lg border border-gray-200 max-h-72 overflow-y-auto">
                    <table className="w-full table-fixed border-collapse">
                      <thead>
                        <tr>
                          <th className="sticky top-0 z-10 bg-gray-50 w-20 text-left text-[10px] font-bold text-gray-400 uppercase tracking-widest px-2 py-1.5 border-b border-gray-200">
                            Operator
                          </th>
                          <th className="sticky top-0 z-10 bg-gray-50 text-left text-[10px] font-bold text-gray-400 uppercase tracking-widest px-2 py-1.5 border-b border-gray-200">
                            Task
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {Object.keys(operatorsData).map((name) => {
                          const checked = workplaceOperatorNames.includes(name)
                          const workerNode = checked
                            ? nodes.find(
                                (n) =>
                                  inferStationType(n.data.label, n.data.stationType) === 'Worker' &&
                                  n.data.assignedOperator === name
                              )
                            : undefined
                          return (
                            <tr key={name}>
                              <td className="px-2 py-1.5 align-top w-20 overflow-hidden">
                                <label className="flex items-center gap-2 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={(e) =>
                                      e.target.checked
                                        ? onAssignOperator(name, reachedController!.id, node.id)
                                        : onUnassignOperator(name, reachedController!.id, node.id)
                                    }
                                    className="h-3.5 w-3.5 rounded border-gray-300 shrink-0"
                                  />
                                  <span className="text-xs text-gray-700 truncate">{name}</span>
                                </label>
                              </td>
                              <td className="px-2 py-1.5 align-top">
                                {checked && workerNode && (() => {
                                  const taskTexts = (workerNode.data.taskTexts ?? ['']).filter((t) => t.trim())
                                  return taskTexts.length > 0 ? (
                                    <div className="space-y-1 min-w-0">
                                      {taskTexts.map((text, i) => (
                                        <div key={i} className="group/tt relative min-w-0">
                                          <p className="truncate text-xs text-gray-700">
                                            {text}
                                          </p>
                                          <span className="pointer-events-none absolute left-0 top-full mt-1 z-30 max-w-xs whitespace-normal break-words rounded-lg bg-white text-gray-700 text-xs font-medium px-3 py-2 shadow-lg border border-gray-100 opacity-0 scale-95 origin-top transition-all duration-150 group-hover/tt:opacity-100 group-hover/tt:scale-100">
                                            {text}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <p className="text-[10px] text-gray-400">No task set.</p>
                                  )
                                })()}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )
              })()
            ) : (
              <p className="text-[10px] text-amber-500">No operators defined yet — add one in the Operators tab.</p>
            )}
          </div>
        )}

        {isWorkplace && workplaceWarnings.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 space-y-1">
            {workplaceWarnings.map((w, i) => (
              <p key={i} className="text-[10px] text-amber-700 flex items-start gap-1">
                <span className="shrink-0">⚠</span>
                <span>{w}</span>
              </p>
            ))}
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
// `displayLabel` (when present) is shown in the UI in place of `label` —
// `label` stays the real internal type identifier (stationType, icon/color
// map key, what gets saved as "Station Type") so existing scenarios saved
// with e.g. "Station Type": "Source" keep working unchanged. Only Source and
// Drain currently use this — their user-facing names ("Start"/"End") read
// better than the internal type names they're stored under.
const PALETTE_ITEMS = [
  { label: 'Source',           displayLabel: 'Start', description: 'Job entry point',    color: 'bg-emerald-50 text-emerald-500 border-emerald-400' },
  { label: 'Station',          description: 'Processing station', color: 'bg-teal-50 text-teal-500 border-teal-400' },
  { label: 'Parallel Station', description: 'Multi-lane station', color: 'bg-cyan-50 text-cyan-500 border-cyan-400' },
  { label: 'Assembly',         description: 'Assembly station',   color: 'bg-green-50 text-green-500 border-green-400' },
  { label: 'Dismantle',        description: 'Disassembly station', color: 'bg-lime-50 text-lime-600 border-lime-400' },
  { label: 'Buffer',           description: 'Queue / buffer',     color: 'bg-amber-50 text-amber-700 border-amber-700' },
  { label: 'Conveyor',         description: 'Material transport', color: 'bg-yellow-50 text-yellow-600 border-yellow-500' },
  { label: 'Robot',            description: 'Robotic handler',    color: 'bg-indigo-50 text-indigo-500 border-indigo-400' },
  { label: 'Connector',        description: 'Routing junction',   color: 'bg-slate-100 text-slate-500 border-slate-400' },
  { label: 'Movable Part',     description: 'Part / WIP token',   color: 'bg-rose-50 text-rose-500 border-rose-400' },
  { label: 'Workplace',        description: 'Station requiring a worker', color: 'bg-blue-50 text-blue-500 border-blue-400' },
  { label: 'Worker',           description: 'Assigned operator',  color: 'bg-amber-50 text-amber-600 border-amber-500' },
  { label: 'Worker Controller', description: 'Skill/availability gate', color: 'bg-violet-50 text-violet-500 border-violet-400' },
  { label: 'Drain',            displayLabel: 'End',   description: 'Job exit point',     color: 'bg-red-50 text-red-500 border-red-400' },
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
  stationsData: Record<string, { capacity?: number; 'Station Type'?: string; shifts_per_day?: number | number[]; 'Worker Controller'?: string }> = {},
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
            shiftsPerDay: normalizeShiftsPerDay(stationsData[resourceName]?.shifts_per_day),
            workerController: stationsData[resourceName]?.['Worker Controller'],
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
    // Skip the synthetic Start/End pill when the first/last column already
    // IS a real Source/Drain station — otherwise the flow shows two "Start"
    // (or "End") nodes stacked back to back for the same entry/exit point.
    const firstColIsSource = firstCol.some(
      (id) => nodes.find((n) => n.id === id)?.data.stationType === 'Source'
    )
    const lastColIsDrain = lastCol.some(
      (id) => nodes.find((n) => n.id === id)?.data.stationType === 'Drain'
    )
    const firstColYs = firstCol.map((id) => nodes.find((n) => n.id === id)!.position.y)
    const lastColYs = lastCol.map((id) => nodes.find((n) => n.id === id)!.position.y)
    const entryY = firstColYs.reduce((a, b) => a + b, 0) / firstColYs.length
    const exitY = lastColYs.reduce((a, b) => a + b, 0) / lastColYs.length

    if (!firstColIsSource) {
      nodes.push({
        id: 'entry',
        type: 'endpoint',
        position: { x: -160, y: entryY },
        data: { label: 'Start', kind: 'entry' },
      })
    }
    if (!lastColIsDrain) {
      nodes.push({
        id: 'exit',
        type: 'endpoint',
        position: { x: stepNodeIds.length * COL_GAP + 40, y: exitY },
        data: { label: 'End', kind: 'exit' },
      })
    }

    for (const tgt of (firstColIsSource ? [] : firstCol)) {
      edges.push({
        id: `e_entry__${tgt}`,
        source: 'entry',
        target: tgt,
        type: 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed, color: '#16a34a' },
        style: { stroke: '#86efac', strokeWidth: 2 },
      })
    }
    for (const src of (lastColIsDrain ? [] : lastCol)) {
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
  const COL_GAP = 260
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
            // Worker/Worker Controller/Workplace are never real processflow
            // steps, so they never reach this per-step loop at all — they're
            // reconstructed separately, straight from stationsData, right
            // before this function returns (see the "controllerEntries" pass
            // below), which is also where their own fields get restored.
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

  // Worker/Worker Controller/Workplace never appear as processflow_data
  // steps (they're zero-time pool-wiring passthroughs — see _is_passthrough
  // in sim_core.py), so the per-step loop above never creates nodes for
  // them. Reconstruct them here directly from stationsData so reopening a
  // saved scenario in Build mode restores the wiring instead of silently
  // dropping it (previously only the propagated effect — "Worker
  // Controller"/"Pool Workers" on stationsData — survived a reload; the
  // canvas nodes themselves reset to nothing). One Workplace is synthesized
  // per real station a Controller staffs, and one Worker per pool member —
  // this doesn't reproduce the exact original canvas layout (a Worker node's
  // specific identity isn't separately recorded, only which operator it
  // picked), but it IS a fully equivalent, re-editable wiring.
  const controllerEntries = Object.entries(stationsData)
    .filter(([, cfg]) => cfg['Station Type'] === 'Worker Controller')
  if (controllerEntries.length > 0) {
    // Real stations this Controller staffs — anything in stationsData whose
    // "Worker Controller" names it (base names, so a parallel-machine
    // station's #2/#3 boxes don't each get their own separate Workplace).
    const staffedByController: Record<string, string[]> = {}
    for (const [stationBase, cfg] of Object.entries(stationsData)) {
      const ctrl = cfg['Worker Controller']
      if (ctrl) (staffedByController[ctrl] ??= []).push(stationBase)
    }

    let poolNodeIndex = 0
    const poolY = (nodes.length > 0 ? Math.max(...nodes.map((n) => n.position.y)) : 0) + ROW_GAP * 1.5
    controllerEntries.forEach(([controllerBase, controllerCfg], ci) => {
      const controllerNodeId = `wctl_${ci}_${controllerBase}`
      const controllerX = ci * EDITABLE_COL_GAP + 40

      nodes.push({
        id: controllerNodeId,
        type: 'station',
        position: { x: controllerX, y: poolY },
        data: {
          label: controllerBase,
          stationType: 'Worker Controller',
          capacity: 1,
          cycleTime: 0,
          operators: 0,
          controllerEnabled: controllerCfg['Enabled'] ?? true,
          assignmentStrategy: controllerCfg['Assignment Strategy'] ?? 'first_available',
          queuePolicy: controllerCfg['Queue Policy'] ?? 'queue',
          maxQueueSize: controllerCfg['Max Queue Size'] ?? 20,
          shiftStart: controllerCfg['Shift Start'],
          shiftEnd: controllerCfg['Shift End'],
          allowOvertime: controllerCfg['Allow Overtime'] ?? true,
          useWorkerTravelTime: controllerCfg['Use Worker Travel Time'] ?? true,
        },
      })

      // One Worker node per pool member, stacked above the Controller.
      const poolWorkers = controllerCfg['Pool Workers'] ?? []
      poolWorkers.forEach((w, wi) => {
        const workerId = `worker_${poolNodeIndex++}_${controllerBase}_${wi}`
        nodes.push({
          id: workerId,
          type: 'station',
          position: { x: controllerX - 90 + wi * 90, y: poolY - ROW_GAP },
          data: {
            label: w.name || `Worker ${wi + 1}`,
            stationType: 'Worker',
            capacity: 1,
            cycleTime: 0,
            operators: 0,
            assignedOperator: w.name || undefined,
            travelTime: w.travel_time ?? 0,
          },
        })
        edges.push({ id: `e_${workerId}__${controllerNodeId}`, source: workerId, target: controllerNodeId })
      })

      // One Workplace per real station this Controller staffs, wired
      // Station -> Workplace -> Worker Controller (edges point INTO the
      // Controller, matching how Canvas.tsx's save mutation walks them).
      const staffed = staffedByController[controllerBase] ?? []
      staffed.forEach((stationBase, si) => {
        const stationNodeId = nodes.find((n) => baseStationName(n.data.label) === stationBase)?.id
        if (!stationNodeId) return
        const workplaceId = `wp_${poolNodeIndex++}_${controllerBase}_${si}`
        nodes.push({
          id: workplaceId,
          type: 'station',
          position: { x: controllerX + 90 + si * 90, y: poolY - ROW_GAP },
          data: {
            label: `${stationBase} Workplace`,
            stationType: 'Workplace',
            capacity: 1,
            cycleTime: 0,
            operators: 0,
          },
        })
        edges.push({ id: `e_${stationNodeId}__${workplaceId}`, source: stationNodeId, target: workplaceId })
        edges.push({ id: `e_${workplaceId}__${controllerNodeId}`, source: workplaceId, target: controllerNodeId })
      })
    })
  }

  return { nodes, edges }
}

// Column/row spacing matching buildEditableGraph's own layout, needed again
// here since ensureSourceAndDrain positions its inserted boxes relative to it.
const EDITABLE_COL_GAP = 260

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
      data: { label: 'Start', stationType: 'Source', capacity: 1, cycleTime: 0, operators: 0, shiftsPerDay: [1] },
    })
    for (const n of entryNodes) nextEdges.push({ id: `e_${id}__${n.id}`, source: id, target: n.id })
  }
  if (needsDrain) {
    const id = `station_${nextId()}`
    nextNodes.push({
      id, type: 'station',
      position: { x: maxX + EDITABLE_COL_GAP, y: avgY },
      data: { label: 'End', stationType: 'Drain', capacity: 1, cycleTime: 0, operators: 0, shiftsPerDay: [1] },
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
  // Worker/Worker Controller/Workplace wiring is a data relationship, not a
  // process-flow connection — hide those edges' lines on the canvas however
  // they were created (drag-drawn, or via a picker checkbox), so the
  // diagram only shows the actual production flow. The edges themselves
  // still exist in `edges` and are used exactly as before for save/pool
  // logic; only the rendered ReactFlow instance gets this filtered view.
  const visibleEdges = useMemo(
    () =>
      edges.map((e) => {
        const src = nodes.find((n) => n.id === e.source)
        const dst = nodes.find((n) => n.id === e.target)
        const srcType = src ? inferStationType(src.data.label, src.data.stationType) : undefined
        const dstType = dst ? inferStationType(dst.data.label, dst.data.stationType) : undefined
        const isPoolWiring = (t?: string) => t === 'Worker' || t === 'Worker Controller' || t === 'Workplace'
        if (isPoolWiring(srcType) || isPoolWiring(dstType)) {
          return { ...e, style: { ...e.style, opacity: 0, pointerEvents: 'none' as const } }
        }
        return e
      }),
    [edges, nodes]
  )
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

  // Per-type display label — a monotonic "highest number ever assigned"
  // counter, e.g. add Controller 1/2/3, delete #2, add another: the next
  // one is Controller 4, not a reused 2 — a delete never frees a number.
  // Seeded (and re-seeded on every call, via Math.max) from the highest
  // EXACT "BaseLabel N" match currently on the canvas, so a reload picks up
  // from the right point without needing separate persistence, but the ref
  // itself never moves backward once advanced, so a mid-session delete
  // can't cause reuse the way scanning live nodes alone would.
  const labelCounterRef = useRef<Record<string, number>>({})
  const nextLabel = (baseLabel: string, currentNodes: Node<StationNodeData>[]) => {
    const highestOnCanvas = currentNodes.reduce((max, n) => {
      const m = n.data.label.match(/^(.*)\s+(\d+)$/)
      return m && m[1] === baseLabel ? Math.max(max, Number(m[2])) : max
    }, 0)
    const prev = labelCounterRef.current[baseLabel] ?? 0
    const next = Math.max(prev, highestOnCanvas) + 1
    labelCounterRef.current[baseLabel] = next
    return `${baseLabel} ${next}`
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
    // Reconstructed/imported edges carry no handle info of their own —
    // normalized the same way onConnect normalizes new edges, so a reload
    // renders the same clean right-to-left flow instead of React Flow
    // picking default (possibly backward-looking) anchor points.
    setNodes(finalNodes)
    setEdges(finalEdges.map((e) => ({ ...e, sourceHandle: 'right', targetHandle: 'left' })))
    setScenarioName(activeScenario.name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, activeScenario, selectedVariant])

  // Build mode handlers.
  // Every station has a "left" and "right" dot, both declared type="source"
  // under connectionMode={Loose} so either dot can start OR receive a drag
  // (see StationNode's comment) — but that means a connection can just as
  // easily land left-to-left or right-to-right, which React Flow then
  // renders as a curved, backward-looking line instead of the clean
  // left-to-right flow the sketch shows. New connections are normalized
  // here to always leave a node's right dot and arrive at the other node's
  // left dot, regardless of which two dots the user actually dragged
  // between, so every edge reads the same direction on the canvas.
  const onConnect = useCallback(
    (params: Connection | Edge) => {
      setEdges((eds) => addEdge({ ...params, sourceHandle: 'right', targetHandle: 'left' }, eds))
    },
    [setEdges]
  )

  // Edge (connection line) labeling — purely a visual note on the arrow
  // (e.g. "Pass" / "Fail" / "70%"), no effect on simulation behaviour.
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const updateEdgeLabel = (id: string, label: string) => {
    setEdges((eds) => eds.map((e) => (e.id === id ? { ...e, label } : e)))
  }
  const deleteEdge = (id: string) => {
    setEdges((eds) => eds.filter((e) => e.id !== id))
    setSelectedEdgeId(null)
  }

  // `dropPosition` (already in flow coordinates) places the new node exactly
  // there — used when a palette item is dragged onto the canvas, Tecomatix-
  // style. Omitted for a plain click on the palette item, which keeps the
  // old auto-placement (rightmost node + offset) as a one-click fallback.
  // `typeName` is the real internal type (stationType, e.g. "Source") — kept
  // unchanged so existing scenarios stay compatible. `initialName` (when
  // given, e.g. "Start" for Source) is just what the station's own editable
  // Name field starts as, since the internal type name isn't always the
  // nicest thing to show a user as the station's actual name.
  const addNode = (typeName: string, dropPosition?: { x: number; y: number }, initialName?: string) => {
    const id = nextNodeId()
    // Every drop of the same palette item otherwise gets the identical label
    // (e.g. two "Worker" nodes) — a monotonically increasing per-type
    // counter suffixes the next number so each instance is distinct out of
    // the box ("Worker 1", "Worker 2", ...). Skipped when the caller passes
    // an explicit initialName (e.g. Source/Drain's "Start"/"End" — those
    // stay singular by convention). Computed here, OUTSIDE setNodes's
    // updater, because React 18 Strict Mode (dev only) invokes a functional
    // setState updater twice — nextLabel has a side effect (advancing
    // labelCounterRef), so calling it from inside the updater silently burnt
    // two numbers per add (only odd numbers ever appearing: Worker 1, 3, 5).
    const label = initialName ?? nextLabel(initialName ?? typeName, nodes)
    const newNodeId = `station_${id}`
    setNodes((nds) => {
      const rightmostX = nds.length > 0 ? Math.max(...nds.map((n) => n.position.x)) : 40
      const avgY = nds.length > 0 ? nds.reduce((sum, n) => sum + n.position.y, 0) / nds.length : 160
      const position = dropPosition ?? { x: nds.length > 0 ? rightmostX + 220 : 80, y: avgY }
      // Non-machine types start with values that match how the engine treats
      // them: a Connector never processes (0 cycle time, no operator) and a
      // Conveyor moves rather than works (transport time, no operator).
      const data: StationNodeData =
        typeName === 'Connector' || typeName === 'Worker' || typeName === 'Worker Controller'
          ? { label, stationType: typeName, capacity: 1, cycleTime: 0, operators: 0, shiftsPerDay: [1] }
          : typeName === 'Conveyor'
            ? { label, stationType: typeName, capacity: 1, cycleTime: 0, operators: 0, transportTime: 5, shiftsPerDay: [1] }
            : { label, stationType: typeName, capacity: 1, cycleTime: 30, operators: 1, shiftsPerDay: [1] }
      return [
        ...nds,
        {
          id: newNodeId,
          type: 'station',
          position,
          data,
        },
      ]
    })
    return newNodeId
  }

  // Workplace panel's Operator picker — checking an operator name either
  // wires an existing unassigned Worker for that operator into this
  // Workplace's Controller, or creates a fresh Worker node (positioned near
  // the Controller) preset to that operator and wires it in. Reuses the same
  // Worker -> Controller edge toggleWire already creates by hand. Also
  // records this Workplace on the Worker's own assignedWorkplaceIds, so two
  // Workers sharing one Controller pool can each serve different
  // Workplace(s) instead of a checkbox for one silently applying to both.
  const assignOperatorToController = (operatorName: string, controllerId: string, workplaceId: string) => {
    const controllerNode = nodes.find((n) => n.id === controllerId)
    // Any Worker node already representing this operator — whether or not
    // it's wired to this Controller yet — is reused rather than duplicated.
    // A duplicate would previously get created whenever the operator was
    // already wired to THIS SAME Controller (just for a different
    // Workplace), since the old check only looked for an unwired Worker.
    const existingWorker = nodes.find(
      (n) => inferStationType(n.data.label, n.data.stationType) === 'Worker' && n.data.assignedOperator === operatorName
    )
    if (existingWorker) {
      if (!edges.some((e) => e.source === existingWorker.id && e.target === controllerId)) {
        toggleWire(existingWorker.id, controllerId, true)
      }
      updateNode(existingWorker.id, {
        assignedWorkplaceIds: [...(existingWorker.data.assignedWorkplaceIds ?? []), workplaceId],
      })
      return
    }
    const controllerPos = controllerNode?.position ?? { x: 80, y: 160 }
    // Stagger each newly-created Worker vertically by how many Workers are
    // already wired into this Controller, so repeatedly picking new
    // operators from the Workplace panel doesn't stack them on top of each
    // other at the exact same spot.
    const existingWorkerCount = nodes.filter(
      (n) =>
        inferStationType(n.data.label, n.data.stationType) === 'Worker' &&
        edges.some((e) => e.source === n.id && e.target === controllerId)
    ).length
    const newWorkerId = addNode('Worker', {
      x: controllerPos.x - 220,
      y: controllerPos.y + existingWorkerCount * 40,
    })
    updateNode(newWorkerId, { assignedOperator: operatorName, label: operatorName, assignedWorkplaceIds: [workplaceId] })
    toggleWire(newWorkerId, controllerId, true)
  }

  // Unchecking an operator in ONE Workplace's picker should only exclude it
  // from THAT Workplace, not evict it from the whole Controller pool if it
  // still serves other Workplaces there. Only fully unwire (toggleWire ...
  // false) when this was the Worker's last Workplace on this Controller —
  // mirrors assignOperatorToController, which is the only other place that
  // creates this edge from the Workplace side.
  const unassignOperatorFromController = (operatorName: string, controllerId: string, workplaceId: string) => {
    const allWorkplacesOnController = nodes
      .filter((n) => inferStationType(n.data.label, n.data.stationType) === 'Workplace')
      .filter((wp) => edges.some((e) => e.source === wp.id && e.target === controllerId))
      .map((wp) => wp.id)
    nodes
      .filter(
        (n) =>
          inferStationType(n.data.label, n.data.stationType) === 'Worker' &&
          n.data.assignedOperator === operatorName &&
          edges.some((e) => e.source === n.id && e.target === controllerId)
      )
      .forEach((n) => {
        // No assignedWorkplaceIds yet means "serves every Workplace on this
        // Controller" (see workplaceOperatorNames) — unchecking one specific
        // Workplace has to first spell out the full list minus this one,
        // otherwise there'd be no way to record "all but this Workplace".
        const currentList = n.data.assignedWorkplaceIds ?? allWorkplacesOnController
        const remaining = currentList.filter((id) => id !== workplaceId)
        updateNode(n.id, { assignedWorkplaceIds: remaining })
        if (remaining.length === 0) toggleWire(n.id, controllerId, false)
      })
  }

  const updateNode = (id: string, patch: Partial<StationNodeData>) => {
    // A station's own Shift Available selection propagates onto any
    // Workplace(s) it created via "Requires Workplace" — the Workplace
    // exists only to staff this one station, so it should never claim
    // availability on a shift the station itself doesn't run.
    const workplaceIds = patch.shiftsPerDay
      ? new Set(
          edges.filter((e) => e.source === id).map((e) => e.target)
            .filter((wid) => nodes.find((n) => n.id === wid)?.data.stationType === 'Workplace')
        )
      : null
    setNodes((nds) => nds.map((n) => {
      if (n.id === id) return { ...n, data: { ...n.data, ...patch } }
      if (workplaceIds?.has(n.id)) return { ...n, data: { ...n.data, shiftsPerDay: patch.shiftsPerDay } }
      return n
    }))
    if (selectedNode?.id === id) setSelectedNode((p) => p ? { ...p, data: { ...p.data, ...patch } } : null)
  }

  const deleteNode = (id: string) => {
    setNodes((nds) => nds.filter((n) => n.id !== id))
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id))
    setSelectedNode(null)
  }

  /** Worker Controller panel's Worker/Workplace picker tables: checking a
   *  row draws (or unchecking removes) the exact same source->target edge
   *  the canvas wiring itself uses, so no other pool-wiring logic needs to
   *  change to support this alternate way of building the pool. */
  const toggleWire = (sourceId: string, targetId: string, connect: boolean) => {
    setEdges((eds) => {
      if (connect) {
        if (eds.some((e) => e.source === sourceId && e.target === targetId)) return eds
        // style: opacity 0 keeps this a fully normal React Flow edge (so save
        // and the pool-wiring graph-walk see it exactly like a hand-drawn
        // connection, and it survives React Flow's own change-tracking)
        // without drawing a visible line on the canvas — picker-driven
        // wiring shouldn't clutter the diagram the way an intentional
        // drag-drawn connection does. (hidden: true was tried first but
        // React Flow silently dropped those edges on re-render.)
        return [
          ...eds,
          {
            id: `e_${sourceId}__${targetId}`,
            source: sourceId,
            target: targetId,
            style: { opacity: 0, pointerEvents: 'none' as const },
          },
        ]
      }
      return eds.filter((e) => !(e.source === sourceId && e.target === targetId))
    })
  }

  /** "Requires Workplace" checkbox on a plain station: creates a Workplace node
   *  next to it, pre-wired Station -> Workplace, so the user only has to draw
   *  the remaining Workplace -> Worker Controller edge themselves. */
  const addWorkplaceFor = (stationId: string) => {
    const workplaceId = `station_${nextNodeId()}`
    setNodes((nds) => {
      const station = nds.find((n) => n.id === stationId)
      if (!station) return nds
      const label = `${baseStationName(station.data.label)} Workplace`
      return [
        ...nds,
        {
          id: workplaceId,
          type: 'station',
          position: { x: station.position.x, y: station.position.y + 170 },
          data: {
            label, stationType: 'Workplace', capacity: 1, cycleTime: 0, operators: 1,
            // Mirrors the station's own shift availability — a Workplace only
            // ever exists to staff its one station, so it should never be
            // "available" on a shift the station itself doesn't run.
            shiftsPerDay: station.data.shiftsPerDay ?? [1],
          },
        },
      ]
    })
    setEdges((eds) => [...eds, { id: `e_${stationId}__${workplaceId}`, source: stationId, target: workplaceId }])
    return workplaceId
  }

  /** Removes the Workplace node(s) this station created when its "Requires
   *  Worker" checkbox is unchecked, so toggling it off doesn't leave an
   *  orphaned Workplace dangling on the canvas. */
  const removeWorkplaceFor = (stationId: string) => {
    const workplaceIds = new Set(
      edges.filter((e) => e.source === stationId).map((e) => e.target)
        .filter((id) => nodes.find((n) => n.id === id)?.data.stationType === 'Workplace')
    )
    if (workplaceIds.size === 0) return
    setNodes((nds) => nds.filter((n) => !workplaceIds.has(n.id)))
    setEdges((eds) => eds.filter((e) => !workplaceIds.has(e.source) && !workplaceIds.has(e.target)))
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
        stationsData[base] = {
          capacity: capacityCount[base], shifts_per_day: n.data.shiftsPerDay ?? [1],
          operator_per_station: n.data.operators,
          ...(n.data.stationType !== undefined ? { 'Station Type': n.data.stationType } : {}),
          ...(n.data.transportTime !== undefined ? { 'Transport Time': n.data.transportTime } : {}),
          ...(n.data.assemblyCount !== undefined ? { 'Assembly Count': n.data.assemblyCount } : {}),
          ...(n.data.assemblyInputs !== undefined ? { 'Assembly Inputs': n.data.assemblyInputs } : {}),
          'Failure rate': 0, 'Repair Time': 10, 'PM Schedule': 'Monthly',
          'Material Shortage Probability (%)': 0, 'Rework Probability (%)': 0,
          shift1: '', shift2: '', shift3: '', STATION_DOWNTIME: 0,
        }
      })

      // Worker Controller is a live dispatch pool at run time (see
      // backend/engine/worker_pool.py). Everything it needs is wired UPSTREAM
      // of it (edges point INTO the Controller, same direction for both):
      //   Worker -> Worker Controller               (a pool member)
      //   Station -> Workplace -> Worker Controller  (a station it staffs)
      // A Workplace itself never processes anything — it's the staffing
      // point that names which ONE real station a dispatched Worker actually
      // goes to. Worker/Connector/Workplace nodes are all zero-time
      // passthroughs for this walk, so walking upstream from the Controller
      // resolves straight through a Workplace to the real Station wired into
      // it, and through a Connector to whatever's further upstream still.
      const isPassthroughForPoolWiring = (n: Node<StationNodeData>): boolean => {
        const t = inferStationType(n.data.label, n.data.stationType)
        return t === 'Worker' || t === 'Connector' || t === 'Workplace'
      }
      const walkRealStations = (
        startId: string, direction: 'upstream' | 'downstream',
      ): Node<StationNodeData>[] => {
        const seen = new Set<string>()
        const found: Node<StationNodeData>[] = []
        let frontierIds = [startId]
        while (frontierIds.length > 0) {
          const nextIds: string[] = []
          for (const id of frontierIds) {
            if (seen.has(id)) continue
            seen.add(id)
            const neighborEdges = direction === 'downstream'
              ? edges.filter((e) => e.source === id)
              : edges.filter((e) => e.target === id)
            for (const e of neighborEdges) {
              const neighborId = direction === 'downstream' ? e.target : e.source
              const neighbor = nodes.find((nn) => nn.id === neighborId)
              if (!neighbor) continue
              if (isPassthroughForPoolWiring(neighbor)) {
                nextIds.push(neighbor.id)
              } else {
                found.push(neighbor)
              }
            }
          }
          frontierIds = nextIds
        }
        return found
      }

      nodes.forEach((n) => {
        const nodeType = inferStationType(n.data.label, n.data.stationType)
        if (nodeType !== 'Worker Controller') return
        const controllerBase = baseStationName(n.data.label)
        const controllerConfig = stationsData[controllerBase]
        if (!controllerConfig) return

        // Everything reachable upstream of this Controller (through any
        // chain of Worker/Connector/Workplace passthroughs) — Worker nodes
        // become this Controller's pool; anything else found here is a REAL
        // station reached by walking straight through a Workplace, i.e. the
        // one station that Workplace stands in for (Station -> Workplace ->
        // Worker Controller, all edges pointing INTO the Controller).
        const upstreamNodes = walkRealStations(n.id, 'upstream')

        // Pool Workers — each contributing its picked operator's
        // Availability (from operators_data) plus its own Travel Time.
        const workerNodes = upstreamNodes
          .filter((w) => inferStationType(w.data.label, w.data.stationType) === 'Worker')
        controllerConfig['Pool Workers'] = workerNodes
          .filter((w) => w.data.assignedOperator)
          .map((w) => {
            const op = w.data.assignedOperator!
            const opCfg = activeScenario?.operators_data?.[op]
            return {
              name: op,
              availability: opCfg?.['Availability (%)'] ?? 100,
              travel_time: w.data.travelTime ?? 0,
            }
          })

        // This Controller's own dispatch settings.
        controllerConfig['Enabled'] = n.data.controllerEnabled ?? true
        controllerConfig['Assignment Strategy'] = n.data.assignmentStrategy ?? 'first_available'
        controllerConfig['Queue Policy'] = n.data.queuePolicy ?? 'queue'
        controllerConfig['Max Queue Size'] = n.data.maxQueueSize ?? 20
        if (n.data.shiftStart !== undefined && n.data.shiftStart !== 0) controllerConfig['Shift Start'] = n.data.shiftStart
        if (n.data.shiftEnd !== undefined && n.data.shiftEnd !== 24) controllerConfig['Shift End'] = n.data.shiftEnd
        controllerConfig['Allow Overtime'] = n.data.allowOvertime ?? true
        controllerConfig['Use Worker Travel Time'] = n.data.useWorkerTravelTime ?? true

        // Everything found upstream that ISN'T a Worker is a real station
        // reached by walking straight through one of this Controller's
        // connected Workplaces — i.e. the station that Workplace stands in
        // for. That real station is what actually names this Controller as
        // its pool (never the Workplace itself, which stays zero-time).
        const staffedStations = upstreamNodes
          .filter((s) => inferStationType(s.data.label, s.data.stationType) !== 'Worker')
        for (const target of staffedStations) {
          const targetConfig = stationsData[baseStationName(target.data.label)]
          if (!targetConfig) continue
          targetConfig['Worker Controller'] = controllerBase
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
        if (t === 'Connector' || t === 'Worker' || t === 'Worker Controller' || t === 'Workplace') return 0
        if (t === 'Conveyor') return n.data.transportTime ?? n.data.cycleTime
        return n.data.cycleTime
      }
      // Edges into a Worker, Worker Controller, or Workplace exist ONLY for
      // the pool-wiring pass above (Station -> Workplace -> Worker Controller,
      // Worker -> Worker Controller) — they are never a real "next step in
      // the job's path," so this walk must not follow them. Without this
      // filter, a Station wired to a Workplace would have the Workplace (and
      // whatever it's wired to in turn) spliced into the middle of the job's
      // actual flow, scrambling downstream routing.
      const isPoolWiringTarget = (nodeId: string): boolean => {
        const target = nodes.find((nn) => nn.id === nodeId)
        if (!target) return false
        const t = inferStationType(target.data.label, target.data.stationType)
        return t === 'Worker' || t === 'Worker Controller' || t === 'Workplace'
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

          const outgoing = edges.filter((e) => e.source === n.id && !isPoolWiringTarget(e.target))
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
                    onClick={() => addNode(item.label, undefined, item.displayLabel)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border border-l-4 border-gray-100 hover:shadow-sm text-left transition-all group cursor-grab active:cursor-grabbing ${borderColor}`}
                  >
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${bgColor}`}>
                      <IsoIcon type={item.label} color={STATION_TYPE_HEX[item.label] ?? DEFAULT_STATION_HEX} />
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-gray-800">{item.displayLabel ?? item.label}</div>
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
                  const displayLabel = PALETTE_ITEMS.find((item) => item.label === label)?.displayLabel
                  addNode(label, position, displayLabel)
                }}
              >
              <ReactFlow
                nodes={nodes}
                edges={visibleEdges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                nodeTypes={stableNodeTypes}
                // Default "strict" connection mode only lets a drag START on
                // a source handle (right dot) and END on a target handle
                // (left dot) — easy to grab the wrong one on a compact node
                // like Worker/Workplace/Worker Controller where both dots
                // sit close together, silently failing the connection with
                // no visible error. Loose mode accepts a drag started/ended
                // on either handle type, in either direction.
                connectionMode={ConnectionMode.Loose}
                // Default snap radius (20px) grabs whichever handle is
                // nearest the drop point even if it's the "wrong" one on a
                // compact node — e.g. dragging toward a station's right dot
                // can still snap to its left dot if that's a hair closer.
                // Shrinking the radius makes a drop only snap when the
                // cursor is nearly on top of the intended dot.
                connectionRadius={8}
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
                <p className="text-xs font-bold text-green-700 uppercase tracking-widest">Start Station</p>
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
                <p className="text-xs font-bold text-red-700 uppercase tracking-widest">End Station</p>
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

              {/* A station dispatched by a Worker Controller pool looks
                  identical to one using the plain static shift1/2/3
                  assignment unless flagged — this is that flag. Not shown on
                  the Controller's own panel (redundant with its Worker Pool
                  stats section just below). */}
              {selectedFlowNode.data.workerController && selectedFlowNode.data.stationType !== 'Worker Controller' && (
                <div className="mb-3">
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-violet-50 text-violet-700 border border-violet-200">
                    Staffed by {selectedFlowNode.data.workerController}
                  </span>
                </div>
              )}

              <div className="mb-3">
                <p className="text-[10px] text-gray-400 mb-1">Shifts available</p>
                {(selectedFlowNode.data.shiftsPerDay ?? []).length > 0 ? (
                  <ShiftPillList shiftNums={selectedFlowNode.data.shiftsPerDay ?? []} shiftNames={shiftNames} />
                ) : (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-600 border border-amber-200">
                    No shifts selected
                  </span>
                )}
              </div>

              {/* Worker Controller pool stats — from worker_pool.py's
                  WorkerPool.get_stats(), reached via activeRun.result.
                  worker_pool_stats (see types/index.ts's WorkerPoolStat).
                  Only meaningful once a run has actually completed; a
                  Controller with no pool wired (no Workers connected) simply
                  has no entry here at all. */}
              {selectedFlowNode.data.stationType === 'Worker Controller' && (
                <div className="mb-4">
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                    Worker Pool
                  </p>
                  {(() => {
                    const stats = activeRun?.result?.worker_pool_stats?.[baseStationName(selectedFlowNode.data.resource)]
                    if (!stats) {
                      return (
                        <p className="text-[11px] text-gray-400">
                          {activeRun ? 'No pool data — no Workers wired to this Controller.' : 'Run a simulation to see pool stats.'}
                        </p>
                      )
                    }
                    return (
                      <div className="space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                          <div className="bg-gray-50 border border-gray-100 rounded-lg p-2 text-center">
                            <p className="text-sm font-bold text-gray-800">{stats.workers_busy} / {stats.workers_busy + stats.workers_idle}</p>
                            <p className="text-[9px] text-gray-500">Workers busy</p>
                          </div>
                          <div className="bg-gray-50 border border-gray-100 rounded-lg p-2 text-center">
                            <p className="text-sm font-bold text-gray-800">{stats.queue_length}</p>
                            <p className="text-[9px] text-gray-500">Queue length</p>
                          </div>
                          <div className="bg-gray-50 border border-gray-100 rounded-lg p-2 text-center">
                            <p className="text-sm font-bold text-gray-800">{stats.jobs_completed}</p>
                            <p className="text-[9px] text-gray-500">Jobs completed</p>
                          </div>
                          <div className="bg-gray-50 border border-gray-100 rounded-lg p-2 text-center">
                            <p className="text-sm font-bold text-gray-800">{stats.jobs_rejected}</p>
                            <p className="text-[9px] text-gray-500">Jobs rejected</p>
                          </div>
                        </div>
                        <div className="bg-gray-50 border border-gray-100 rounded-lg p-2">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[10px] text-gray-400">Worker utilization</span>
                            <span
                              className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                              style={{ color: utilColor(stats.worker_utilization), background: utilColor(stats.worker_utilization) + '20' }}
                            >
                              {stats.worker_utilization.toFixed(0)}%
                            </span>
                          </div>
                          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full"
                              style={{ width: `${Math.min(stats.worker_utilization, 100)}%`, background: utilColor(stats.worker_utilization) }}
                            />
                          </div>
                        </div>
                        <p className="text-[10px] text-gray-500">
                          Average wait: <span className="font-semibold text-gray-700">{stats.avg_wait_time.toFixed(1)} min</span>
                        </p>
                      </div>
                    )
                  })()}
                </div>
              )}

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
                onAddWorkplace={addWorkplaceFor}
                onRemoveWorkplace={removeWorkplaceFor}
                onToggleWire={toggleWire}
                onAssignOperator={assignOperatorToController}
                onUnassignOperator={unassignOperatorFromController}
                numShifts={numShifts}
                shiftNames={shiftNames}
                operatorsData={activeScenario?.operators_data ?? {}}
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
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => deleteEdge(selectedEdgeId)}
                      className="w-6 h-6 flex items-center justify-center rounded-lg text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                      title="Delete connection"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => setSelectedEdgeId(null)}
                      className="w-6 h-6 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-50 transition-colors"
                    >
                      ✕
                    </button>
                  </div>
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
                <div className="px-4 pb-4 space-y-2">
                  <button
                    onClick={() => setSelectedEdgeId(null)}
                    className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition-colors"
                  >
                    Done
                  </button>
                  <button
                    onClick={() => deleteEdge(selectedEdgeId)}
                    className="w-full py-2 text-xs font-semibold text-red-600 bg-red-50 hover:bg-red-100 rounded-xl transition-colors"
                  >
                    Delete Connection
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
