import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactFlow, {
  addEdge, Background, Controls, MiniMap, Panel,
  useNodesState, useEdgesState, useEdges,
  type Connection, type Edge, type Node, type NodeTypes, type ReactFlowInstance,
  Handle, Position, MarkerType, ConnectionMode, SelectionMode,
} from 'reactflow'
import 'reactflow/dist/style.css'
import JobReplay, { type AssemblyRecord, type DismantleRecord, type ReplayTarget } from '../canvas2d/JobReplay'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  Save, Plus, Trash2, Eye, Play, ChevronLeft, ChevronRight, X, RefreshCw, Square,
  ChevronDown, Check,
} from 'lucide-react'
import { scenariosApi } from '@/api/scenarios'
import { type SimConfigOverride, DEFAULT_SIM_TIME, NEW_SCENARIO_CALENDAR } from '@/api/simulations'
import { useAppStore } from '@/store/useAppStore'
import SimDialogsHost from '@/components/run/SimDialogsHost'
import SimSettingsMenu, { openSimDialog } from '@/components/run/SimSettingsMenu'
import { IdleReplayBar } from '@/components/run/ReplayBar'
import { useRunSimulation } from '@/hooks/useRunSimulation'
import { FEATURE, useLicenseFeatures } from '@/hooks/useLicenseFeatures'
import { STATUS_LEGEND } from '@/lib/status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import Scene from '@/canvas3d/Scene'
import { buildScene3D } from '@/canvas3d/layout'
import { stressLine } from '@/canvas3d/devStress'
import { inferStationType } from '@/lib/stationTypes'
import type { StationNodeData, ScenarioCreate, StationConfig, MuRow, AssemblyConfig, AssemblyTableKind, AssemblyTableRow, DismantleConfig, DismantleRow, CanvasLayout, CanvasLayoutBox, WorkerStat, StationStateStat, BufferStateStat, PartsFlow, Scenario } from '@/types'
import { defaultVariantColor, unusedVariantColor, jobPrefix } from '@/lib/variantColors'

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
  if (u >= 85) return '#F04438'
  if (u >= 70) return '#F59E0B'
  if (u >= 40) return '#12B76A'
  return '#3E8BF5'
}

function utilBorder(u: number) {
  if (u >= 85) return '#F04438'
  if (u >= 70) return '#F59E0B'
  if (u >= 40) return '#12B76A'
  return '#9CC0F8'
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
  // Buffer-only stats (from StationStat) — a Buffer has no process time/parallel
  // machines/shifts of its own, it just holds jobs, so the View-mode panel
  // shows these instead for a Buffer node.
  bufferCapacity?: number
  bufferDiscipline?: string
  bufferBlockedRatio?: number
  bufferBlockedTime?: number
  // Only set for a Buffer that ran in 3D mode (see backend's
  // rack_lane_count/rack_occupied) — null/undefined for a 2D Buffer, which
  // keeps showing the plain bufferCapacity number instead.
  rackLaneCount?: number | null
  rackOccupied?: number | null
  // Buffer-only CONFIG (Build mode) — how many jobs this Buffer can hold at
  // once. Deliberately a separate field from bufferCapacity above, which is
  // a run-result readback (StationStat.buffer_capacity) written fresh after
  // every run; reusing that field for the editable config would have the
  // next run's stats silently overwrite whatever the user configured here.
  // Saves to the scenario's 'Buffer Capacity' station field, same as a real
  // station's own Buffer Quantity column.
  bufferQuantity?: number
  bufferUnlimited?: boolean
  // '2D' (default, plain Buffer Quantity) or '3D' (X/Y/Z lane dimensions
  // instead). Config-only, same save path as bufferQuantity — not read
  // from an uploaded sheet; a 3D buffer always starts at X=Y=Z=1 until the
  // user changes it here.
  bufferConfigMode?: '2D' | '3D'
  bufferX?: number
  bufferY?: number
  bufferZ?: number
  // Editable Build-mode FIFO/LIFO choice — distinct from the read-only
  // bufferDiscipline above (that one mirrors a completed run's stats).
  // Saves to the scenario's 'Buffer Discipline' station field, same field
  // every other station already uses (see ScenarioManager's Stations tab).
  bufferOrder?: 'FIFO' | 'LIFO'
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

// The View-mode Start / End circles (buildFlowGraph adds them when the line
// has no Start / End node of its own).
interface EndpointNodeData {
  label: string
  kind: 'entry' | 'exit'
}

function EndpointNode({ data }: { data: EndpointNodeData }) {
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
function NumericField({ value, onCommit, className, disabled }: { value: number; onCommit: (n: number) => void; className?: string; disabled?: boolean }) {
  const [draft, setDraft] = useState(String(value))

  useEffect(() => { setDraft(String(value)) }, [value])

  return (
    <Input
      type="number"
      value={draft}
      disabled={disabled}
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
      if (rootRef.current && !rootRef.current.contains(e.target as globalThis.Node)) setOpen(false)
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
      if (rootRef.current && !rootRef.current.contains(e.target as globalThis.Node)) setOpen(false)
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

// ─── Property editor ─────────────────────────────────────────────────────────

function PropertyEditor({
  node, nodes, edges, allEdges, onChange, onDelete, onSaveStation, onAddParallel, onOpenMuTable, startProducts, allStartProducts, productColors, onProductColor, products, onAddWorkplace, onRemoveWorkplace, onToggleWire, onAssignOperator, onUnassignOperator, numShifts, shiftNames, operatorsData, workerResults, stationStates, bufferStates, partsFlow,
}: {
  node: Node<StationNodeData>
  nodes: Node<StationNodeData>[]
  edges: Edge[]
  // Every line on the drawing, whichever product uses it.
  allEdges: Edge[]
  onChange: (id: string, data: Partial<StationNodeData>) => void
  onDelete: (id: string) => void
  onSaveStation: () => void
  onAddParallel: (id: string) => void
  onOpenMuTable: (id: string) => void
  // Start only: its products (MU table), for its Exit Controller.
  startProducts: string[]
  // A Start: every product in the MU table (all Starts) — its Job colour list.
  allStartProducts: string[]
  // Each product's job colour, and a change of it (Start only).
  productColors: Record<string, string>
  onProductColor: (id: string, mu: string, color: string) => void
  // The scenario's products, for Route by product.
  products: string[]
  onAddWorkplace: (id: string) => void
  onRemoveWorkplace: (id: string) => void
  onToggleWire: (sourceId: string, targetId: string, connect: boolean) => void
  onAssignOperator: (operatorName: string, controllerId: string, workplaceId: string) => void
  onUnassignOperator: (operatorName: string, controllerId: string, workplaceId: string) => void
  numShifts: number
  shiftNames: Record<number, string | undefined>
  operatorsData: Record<string, { 'Skill Rating': number; 'Availability (%)': number }>
  // The last run's pooled Workers, by name (empty before a run).
  workerResults: Record<string, WorkerStat>
  // The last run's statistical analysis, by station (empty before a run).
  stationStates: Record<string, StationStateStat>
  // The same for the Buffers.
  bufferStates: Record<string, BufferStateStat>
  // The last run's parts delivered / collected (undefined before a run).
  partsFlow?: PartsFlow
}) {
  const nodeType = inferStationType(node.data.label, node.data.stationType)
  // A Connector is a routing junction, a Conveyor is transport, and a
  // Source/Drain is just where jobs enter/leave the line — none of these are
  // a machine, so the machine fields below (capacity, process time, operators,
  // shifts, parallel machines) don't apply to them (the engine ignores those
  // fields for Connector/Conveyor; Source/Drain have no real engine semantics
  // at all yet — see sim_core.py's Station Type handling). Showing them
  // anyway would invite settings that do nothing.
  const isConnector = nodeType === 'Connector'
  const isConveyor = nodeType === 'Conveyor'
  const [sensorDialogOpen, setSensorDialogOpen] = useState(false)
  const isBookend =nodeType === 'Source' || nodeType === 'Drain'
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
          { key: 'conveyorLength', label: 'Length (m)', type: 'number' },
          { key: 'conveyorSpeed', label: 'Speed (m/min)', type: 'number' },
          { key: 'conveyorCapacity', label: 'Capacity (units)', type: 'number' },
          { key: 'conveyorWidth', label: 'Width (m)', type: 'number' },
          { key: 'conveyorHeight', label: 'Height (m)', type: 'number' },
        ]
      // A Workplace is never its own processflow step (see the save
      // mutation's stepDuration — always 0 for Workplace) and its Operators
      // count is never read either, since real staffing comes from the
      // Worker Controller's pool. Process Time/Operators would silently do
      // nothing here, so only Name is shown.
      : isWorkplace
        ? [{ key: 'label', label: 'Name', type: 'text' }]
        // A Buffer/Queue node has no process/setup duration and no
        // operator of its own — it's a waiting slot, not a work station —
        // so Setup/Process Time and Operators would all be inert
        // here, same reasoning as Workplace above.
        : isBuffer
          ? [{ key: 'label', label: 'Name', type: 'text' }]
          : [
            { key: 'label',       label: 'Name',              type: 'text'   },
            { key: 'processTime',   label: 'Process Time (min)', type: 'number' },
            { key: 'setupTime',   label: 'Setup Time (min)',   type: 'number' },
            { key: 'operators',   label: 'Operators',          type: 'number' },
            { key: 'repairTime',  label: 'Repair Time (min)',  type: 'number' },
            { key: 'failureTime', label: 'Failure Time (min)', type: 'number' },
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

  // 2+ successors = this station needs an Exit Controller.
  const successorBases = exitSuccessorLabels(node.id, nodes, edges)
  const exitStrategy = node.data.exitStrategy ?? 'cyclic'
  const exitPercentages = node.data.exitPercentages ?? {}
  const exitPercentTotal = successorBases.reduce((sum, s) => sum + (exitPercentages[s] ?? 0), 0)
  const exitPriorities = exitPriorityValues(node.data, successorBases)
  const exitPrioritiesValid = exitPrioritiesAreValid(exitPriorities)
  // This station splits jobs over different next stations — a shape the
  // simulation doesn't support yet shows why here (Save is blocked too).
  const splitProblem = canvasSplits(nodes, edges).find((s) => s.sourceId === node.id)?.problem

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-ls-soft border-b border-ls-line">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="w-10 h-10 shrink-0 rounded-[10px] bg-ls-card shadow-sm flex items-center justify-center">
            <IsoIcon type={nodeType} color={(nodeType && STATION_TYPE_HEX[nodeType]) || DEFAULT_STATION_HEX} />
          </div>
          <div className="min-w-0">
            <p className="truncate font-display text-sm font-bold text-ls-ink leading-none">{node.data.label}</p>
            <p className="text-[10.5px] text-ls-mute mt-1">{nodeType === 'Source' ? 'Start' : nodeType === 'Drain' ? 'End' : nodeType} properties</p>
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
        {(() => {
          const renderField = ({ key, label, type }: (typeof fields)[number]) => (
            <div key={key}>
              <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5 leading-tight min-h-[2.2em] flex items-end">
                {label}
              </label>
              {type === 'number' ? (
                <NumericField
                  // Fields that only exist on some station types (e.g. a
                  // Conveyor's conveyorLength) are undefined on a freshly added
                  // node — Number(undefined) is NaN, which would render an empty
                  // uneditable box, so fall back to 0 (repairTime too, matching
                  // the save mutation's own default). conveyorCapacity falls
                  // back to 1, the engine's default for a conveyor saved
                  // without one.
                  value={Number(node.data[key as keyof StationNodeData] ?? (key === 'conveyorCapacity' ? 1 : 0))}
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
          )
          // Text fields (Name) stay full-width; number fields (Setup/
          // Process Time, Operators, ...) are paired two-per-row so they
          // don't each burn a full row of vertical space.
          const textFields = fields.filter((f) => f.type !== 'number')
          const numberFields = fields.filter((f) => f.type === 'number')
          const numberRows: (typeof fields)[number][][] = []
          for (let i = 0; i < numberFields.length; i += 2) {
            numberRows.push(numberFields.slice(i, i + 2))
          }
          return (
            <>
              {textFields.map(renderField)}
              {numberRows.map((row, i) => (
                <div key={i} className="grid grid-cols-2 gap-3">
                  {row.map(renderField)}
                </div>
              ))}
              {isConveyor && (() => {
                const transport = conveyorTransportTime(node.data)
                return (
                  <div>
                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                      Transport Time (min)
                    </label>
                    <p className="h-8 px-3 flex items-center text-sm rounded-lg border border-gray-200 bg-gray-100 text-gray-600 tabular-nums">
                      {transport !== undefined ? formatDecimal(transport, 4) : '—'}
                    </p>
                    <p className="text-[10px] text-gray-400 mt-1">Length ÷ Speed</p>
                  </div>
                )
              })()}
              {isConveyor && !((node.data.conveyorLength ?? 0) > 0) && (
                <p className="text-[10px] text-amber-600">
                  Length must be more than 0.
                </p>
              )}
              {isConveyor && !((node.data.conveyorSpeed ?? 0) > 0) && (
                <p className="text-[10px] text-amber-600">
                  Speed must be more than 0.
                </p>
              )}
              {isConveyor && (node.data.conveyorCapacity ?? 1) < 1 && (
                <p className="text-[10px] text-amber-600">
                  Capacity must be 1 or more.
                </p>
              )}
              {/* Sensor — ticking opens the pop-up; unticking removes the
                  sensor. The engine only counts jobs passing it. */}
              {isConveyor && (
                <div>
                  <label className="flex items-center gap-2 text-xs font-semibold text-gray-700">
                    <input
                      type="checkbox"
                      checked={!!node.data.conveyorSensor || sensorDialogOpen}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSensorDialogOpen(true)
                        } else {
                          setSensorDialogOpen(false)
                          onChange(node.id, { conveyorSensor: undefined })
                        }
                      }}
                    />
                    Sensor
                  </label>
                  {node.data.conveyorSensor && (
                    <button
                      type="button"
                      onClick={() => setSensorDialogOpen(true)}
                      className="mt-1 ml-5 text-[11px] text-blue-600 hover:underline"
                    >
                      Sensor at {formatDecimal(node.data.conveyorSensor.length)} m · {node.data.conveyorSensor.position === 'front' ? 'Front' : 'Rear'}
                    </button>
                  )}
                  {node.data.conveyorSensor && node.data.conveyorSensor.length > (node.data.conveyorLength ?? 0) && (
                    <p className="text-[10px] text-red-600 mt-1">
                      Sensor ({formatDecimal(node.data.conveyorSensor.length)} m) is longer than the conveyor ({formatDecimal(node.data.conveyorLength ?? 0)} m) — change one of them before saving.
                    </p>
                  )}
                  {sensorDialogOpen && (
                    <ConveyorSensorDialog
                      conveyorName={node.data.label}
                      conveyorLength={node.data.conveyorLength ?? 0}
                      initial={node.data.conveyorSensor}
                      onApply={(sensor) => onChange(node.id, { conveyorSensor: sensor })}
                      onClose={() => setSensorDialogOpen(false)}
                    />
                  )}
                </div>
              )}
            </>
          )
        })()}

        {/* Start: its MU table (the products it creates) — also opens on a
            click on the Start box itself. */}
        {nodeType === 'Source' && (
          <div>
            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
              MU
            </label>
            <button
              onClick={() => onOpenMuTable(node.id)}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[11px] font-semibold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg border border-indigo-100 transition-colors"
            >
              Open MU table{node.data.muTable ? ` (${node.data.muTable.length})` : ''}
            </button>
            {allStartProducts.length > 0 && (
              <div className="mt-2.5 space-y-1.5">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Job colour</p>
                {allStartProducts.map((mu) => (
                  <label key={mu} className="flex items-center gap-2 text-xs text-gray-700">
                    <input
                      type="color"
                      value={productColors[mu] || '#3b82f6'}
                      onChange={(e) => onProductColor(node.id, mu, e.target.value)}
                      title={`Colour of ${mu}'s jobs`}
                      className="h-6 w-8 cursor-pointer rounded-md border border-gray-200 bg-gray-50 p-0.5"
                    />
                    <span className="truncate">{mu}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Start's Exit Controller — the order its products are released in,
            each product as one whole batch, one after another (each job its
            product's Interval after the one before). Cyclic/Random/Successor
            run in the simulation; Percentage is UI only for now. */}
        {nodeType === 'Source' && startProducts.length > 1 && (() => {
          // Nothing chosen = Cyclic (saved as Cyclic too).
          const muStrategy = node.data.muStrategy ?? 'cyclic'
          const muPriorities = startProducts.map((p, i) => node.data.muPriorities?.[p] ?? i + 1)
          const muPrioritiesValid = exitPrioritiesAreValid(muPriorities)
          const muPercentages = node.data.muPercentages ?? {}
          const muPercentTotal = startProducts.reduce((sum, p) => sum + (muPercentages[p] ?? 0), 0)
          return (
            <div>
              <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                Exit Controller ({startProducts.length} products)
              </label>
              <select
                value={muStrategy}
                onChange={(e) => onChange(node.id, { muStrategy: e.target.value as StationNodeData['muStrategy'] })}
                className="h-8 w-full text-sm rounded-lg border border-gray-200 bg-gray-50 focus:bg-white px-2"
              >
                <option value="cyclic">Cyclic</option>
                <option value="random">Random</option>
                <option value="successor">Route</option>
                <option value="percentage">Percentage</option>
              </select>

              {muStrategy === 'cyclic' && (
                <p className="text-[10px] text-gray-400 mt-1.5">Releases each product's jobs in MU table order: all of {startProducts[0]}, then all of {startProducts[1]}, …</p>
              )}
              {muStrategy === 'random' && (
                <p className="text-[10px] text-gray-400 mt-1.5">Releases the products in a random order — each product's jobs still all together.</p>
              )}

              {muStrategy === 'successor' && (
                <div className="mt-2 space-y-1.5">
                  <label className="text-[10px] text-gray-400 block">Priority (1 = released first)</label>
                  {startProducts.map((p, i) => (
                    <div key={p} className="flex items-center gap-2">
                      <span className="text-xs text-gray-600 flex-1 truncate">{p}</span>
                      <NumericField
                        value={muPriorities[i]}
                        onCommit={(n) => onChange(node.id, {
                          muPriorities: {
                            ...Object.fromEntries(startProducts.map((q, j) => [q, muPriorities[j]])),
                            [p]: n,
                          },
                        })}
                        className="h-8 w-20 text-sm rounded-lg border-gray-200 bg-gray-50 focus:bg-white [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
                      />
                    </div>
                  ))}
                  {!muPrioritiesValid && (
                    <p className="text-[10px] text-amber-600">
                      Use each number from 1 to {startProducts.length} once.
                    </p>
                  )}
                </div>
              )}

              {muStrategy === 'percentage' && (
                <div className="mt-2 space-y-1.5">
                  {startProducts.map((p) => (
                    <div key={p} className="flex items-center gap-2">
                      <span className="text-xs text-gray-600 flex-1 truncate">{p}</span>
                      <div className="relative w-20">
                        <NumericField
                          value={muPercentages[p] ?? 0}
                          onCommit={(n) => onChange(node.id, { muPercentages: { ...muPercentages, [p]: n } })}
                          className="h-8 text-sm rounded-lg border-gray-200 bg-gray-50 focus:bg-white pr-6 [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
                        />
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">%</span>
                      </div>
                    </div>
                  ))}
                  <p className={`text-[10px] ${muPercentTotal === 100 ? 'text-gray-400' : 'text-amber-600'}`}>
                    Total: {muPercentTotal}%{muPercentTotal !== 100 && ' — should add up to 100%'}
                  </p>
                </div>
              )}
            </div>
          )
        })()}

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

        {/* What happens to a part already in progress when this station's
            machine fails mid-operation — saves to the scenario's 'Failure
            Policy' field (backend/engine/machine.py's FailurePolicy enum).
            Same isPlainStation guard as Repair Time above: only a real
            machine (not a Conveyor/Workplace/Buffer/annotation) can fail. */}
        {isPlainStation && (
          <div>
            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
              Failure Policy
            </label>
            <select
              value={node.data.failurePolicy || 'resume'}
              onChange={(e) => onChange(node.id, { failurePolicy: e.target.value })}
              className="h-8 w-full text-sm rounded-lg border border-gray-200 bg-gray-50 focus:bg-white px-2"
              title="What happens to a part already in progress when this machine fails"
            >
              <option value="resume">Resume</option>
              <option value="restart">Restart</option>
              <option value="scrap">Scrap</option>
            </select>
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
            {/* Last run: how long this Worker worked, and where. */}
            {node.data.assignedOperator && workerResults[node.data.assignedOperator] && (() => {
              const w = workerResults[node.data.assignedOperator!]
              return (
                <div className="mt-3">
                  <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                    Last Run
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-gray-50 border border-gray-100 rounded-lg p-2 text-center">
                      <p className="text-sm font-bold text-gray-800">{w.worked_time.toFixed(1)} min</p>
                      <p className="text-[9px] text-gray-500">Worked</p>
                    </div>
                    <div className="bg-gray-50 border border-gray-100 rounded-lg p-2 text-center">
                      <p className="text-sm font-bold text-gray-800">{w.jobs}</p>
                      <p className="text-[9px] text-gray-500">Jobs</p>
                    </div>
                  </div>
                  {w.workplaces.map((p) => (
                    <p key={p.station} className="text-[10px] text-gray-500 mt-1.5">
                      Worked {p.worked_time.toFixed(1)} min at {p.station} ({p.jobs} job{p.jobs === 1 ? '' : 's'})
                    </p>
                  ))}
                  <p className="text-[10px] text-gray-400 mt-1">{w.utilization.toFixed(1)}% of the run.</p>
                  {/* Statistical analysis: Working / Free % of its available
                      time — the Worker Controller's shift minus the time it
                      was away, after the warm-up. Walking counts as Free. */}
                  {w.working_pct !== undefined && (() => {
                    const rows = [
                      { label: 'Working', value: w.working_pct ?? 0, color: '#22c55e' },
                      { label: 'Free', value: w.free_pct ?? 0, color: '#cbd5e1' },
                    ]
                    return (
                      <div className="mt-3">
                        <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                          Statistical Analysis
                        </label>
                        <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-gray-100">
                          {rows.map((r) => r.value > 0 && (
                            <div key={r.label} style={{ width: `${r.value}%`, background: r.color }} title={`${r.label} ${r.value.toFixed(2)}%`} />
                          ))}
                        </div>
                        <div className="mt-2 space-y-1">
                          {rows.map((r) => (
                            <div key={r.label} className="flex items-center justify-between text-xs">
                              <span className="flex items-center gap-1.5 text-gray-600">
                                <span className="h-2 w-2 rounded-sm" style={{ background: r.color }} />
                                {r.label}
                              </span>
                              <span className="font-semibold text-gray-800 tabular-nums">{r.value.toFixed(2)}%</span>
                            </div>
                          ))}
                        </div>
                        <p className="text-[10px] text-gray-400 mt-1.5">
                          Of {(w.available_time ?? 0).toFixed(0)} min available (the Worker Controller's shift, minus time away, after the warm-up).
                        </p>
                      </div>
                    )
                  })()}
                </div>
              )
            })()}

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

        {/* Buffer capacity — how many finished jobs this Buffer node can hold
            at once. The engine blocks the upstream station once the Buffer
            is full, same as a real station's own Buffer Capacity field (see
            sim_core.py's _is_buffer hand-off). 0 means zero room (nothing
            can wait here at all); check Unlimited for no cap.
            2D/3D only changes HOW capacity is entered: one flat number, or
            X/Y/Z lane dimensions (always starts 1-1-1, never imported from
            a sheet — user edits them here if they want something else).
            Buffer Order (FIFO/LIFO) applies the same way in both modes. */}
        {isBuffer && (
        <div>
          <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
            Buffer Mode
          </label>
          <div className="flex gap-1.5 mb-3">
            {(['2D', '3D'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => onChange(node.id, { bufferConfigMode: mode })}
                className={`flex-1 h-8 text-sm font-medium rounded-lg border transition-colors ${
                  (node.data.bufferConfigMode ?? '2D') === mode
                    ? 'bg-blue-500 text-white border-blue-500'
                    : 'bg-gray-50 text-gray-500 border-gray-200 hover:bg-gray-100'
                }`}
              >
                {mode}
              </button>
            ))}
          </div>

          {(node.data.bufferConfigMode ?? '2D') === '2D' ? (
            <>
              <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                Buffer Quantity
              </label>
              <NumericField
                value={node.data.bufferQuantity ?? 0}
                onCommit={(n) => onChange(node.id, { bufferQuantity: n })}
                disabled={!!node.data.bufferUnlimited}
                className="h-8 text-sm rounded-lg border-gray-200 bg-gray-50 focus:bg-white disabled:opacity-50 [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
              />
              <label className="flex items-center gap-1.5 mt-1.5 text-[11px] text-gray-500">
                <input
                  type="checkbox"
                  checked={!!node.data.bufferUnlimited}
                  onChange={(e) => onChange(node.id, { bufferUnlimited: e.target.checked })}
                  className="h-3.5 w-3.5"
                />
                Unlimited
              </label>
            </>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">X</label>
                <NumericField
                  value={node.data.bufferX ?? 1}
                  onCommit={(n) => onChange(node.id, { bufferX: n })}
                  className="h-8 text-sm rounded-lg border-gray-200 bg-gray-50 focus:bg-white [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">Y</label>
                <NumericField
                  value={node.data.bufferY ?? 1}
                  onCommit={(n) => onChange(node.id, { bufferY: n })}
                  className="h-8 text-sm rounded-lg border-gray-200 bg-gray-50 focus:bg-white [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">Z</label>
                <NumericField
                  value={node.data.bufferZ ?? 1}
                  onCommit={(n) => onChange(node.id, { bufferZ: n })}
                  className="h-8 text-sm rounded-lg border-gray-200 bg-gray-50 focus:bg-white [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
                />
              </div>
            </div>
          )}

          <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5 mt-3">
            Buffer Order
          </label>
          <select
            value={node.data.bufferOrder ?? 'FIFO'}
            onChange={(e) => onChange(node.id, { bufferOrder: e.target.value as 'FIFO' | 'LIFO' })}
            className="h-8 text-sm text-gray-800 bg-gray-50 border border-gray-200 rounded-lg px-2 w-full"
          >
            <option value="FIFO">FIFO</option>
            <option value="LIFO">LIFO</option>
          </select>
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

        {/* Assembly: its settings, applied as you change them. UI only for now. */}
        {nodeType === 'Assembly' && (
          <AssemblyPanel
            assembly={assemblySettings(node.data.assembly)}
            products={products}
            incoming={incomingStations(node.id, nodes, allEdges)}
            lineProducts={Object.fromEntries(incomingStations(node.id, nodes, allEdges).map((from) => [from, Array.from(new Set(
              allEdges
                .filter((e) => e.target === node.id && nodes.some((n) => n.id === e.source && groupKey(n) === from))
                .flatMap((e) => edgeProducts(e) ?? []),
            ))]))}
            onChange={(assembly) => onChange(node.id, { assembly })}
          />
        )}

        {/* Dismantle: its settings, applied as you change them. */}
        {nodeType === 'Dismantle' && (
          <DismantlePanel
            dismantle={dismantleSettings(node.data.dismantle)}
            outgoing={outgoingStations(node.id, nodes, allEdges)}
            onChange={(dismantle) => onChange(node.id, { dismantle })}
          />
        )}

        {/* Dismantle / Assembly: the Workers who worked here in the last run
            (from calling them — Assembly: once every part is there — until
            the parts were separated / merged). */}
        {(nodeType === 'Dismantle' || nodeType === 'Assembly') && (() => {
          const station = node.data.savedName ?? stationKey(node)
          const here = Object.values(workerResults).flatMap((w) =>
            w.workplaces.filter((p) => p.station === station).map((p) => ({ name: w.name, ...p })))
          if (here.length === 0) return null
          return (
            <div>
              <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                Workers (last run)
              </label>
              <div className="space-y-1.5">
                {here.map((p) => (
                  <div key={p.name} className="flex items-center justify-between gap-2 bg-gray-50 border border-gray-100 rounded-lg px-2.5 py-2">
                    <span className="text-xs font-semibold text-gray-700 truncate">{p.name}</span>
                    <span className="text-xs text-gray-600 tabular-nums whitespace-nowrap">
                      {p.worked_time.toFixed(1)} min · {p.jobs} job{p.jobs === 1 ? '' : 's'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )
        })()}

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
          {node.data.parallelGroup && (
            <p className="text-[10px] text-gray-500 mb-1.5">
              Machine of group <span className="font-semibold text-gray-700">{node.data.parallelGroup}</span>
              {' · '}{nodes.filter((n) => n.data.parallelGroup === node.data.parallelGroup).length} machines,
              one shared waiting line. This machine's settings are its own.
            </p>
          )}
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

        {/* Exit Controller — which of this station's next stations (parallel
            copies or different stations) each finished job goes to.
            Cyclic/Random/Successor run in the simulation; Percentage is UI
            only for now. Route by product is saved as before ('Route By
            Product' + 'Product Routes'), with Cyclic/Random as its Exit
            Strategy — so a scenario saved with the old checkbox opens on it. */}
        {successorBases.length > 1 && (
          <div>
            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
              Exit Controller ({successorBases.length} paths)
            </label>
            {splitProblem && (
              <p className="text-[10px] text-amber-600 mb-1.5">
                {splitProblem} The simulation can't run this layout yet.
              </p>
            )}
            <select
              value={node.data.routeByProduct ? 'product' : exitStrategy}
              onChange={(e) => onChange(node.id, e.target.value === 'product'
                ? {
                    routeByProduct: true,
                    // First time on: every product may go everywhere.
                    productRoutes: node.data.productRoutes
                      ?? Object.fromEntries(products.map((p) => [p, [...successorBases]])),
                    // Route based is always Cyclic.
                    exitStrategy: 'cyclic',
                  }
                : { routeByProduct: false, exitStrategy: e.target.value as StationNodeData['exitStrategy'] })}
              className="h-8 w-full text-sm rounded-lg border border-gray-200 bg-gray-50 focus:bg-white px-2"
            >
              <option value="cyclic">Cyclic</option>
              <option value="random">Random</option>
              <option value="successor">Successor</option>
              <option value="percentage">Percentage</option>
              {(products.length > 1 || node.data.routeByProduct) && (
                <option value="product">Route based</option>
              )}
            </select>

            {!node.data.routeByProduct && exitStrategy === 'cyclic' && (
              <p className="text-[10px] text-gray-400 mt-1.5">Sends jobs to each next station in turn.</p>
            )}
            {!node.data.routeByProduct && exitStrategy === 'random' && (
              <p className="text-[10px] text-gray-400 mt-1.5">Sends each job to a randomly chosen next station.</p>
            )}

            {!node.data.routeByProduct && exitStrategy === 'successor' && (
              <div className="mt-2 space-y-1.5">
                <label className="text-[10px] text-gray-400 block">Priority (1 = first choice)</label>
                {successorBases.map((s, i) => (
                  <div key={s} className="flex items-center gap-2">
                    <span className="text-xs text-gray-600 flex-1 truncate">{s}</span>
                    <NumericField
                      value={exitPriorities[i]}
                      onCommit={(n) => onChange(node.id, {
                        exitPriorities: {
                          ...Object.fromEntries(successorBases.map((b, j) => [b, exitPriorities[j]])),
                          [s]: n,
                        },
                      })}
                      className="h-8 w-20 text-sm rounded-lg border-gray-200 bg-gray-50 focus:bg-white [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
                    />
                  </div>
                ))}
                {!exitPrioritiesValid && (
                  <p className="text-[10px] text-amber-600">
                    Use each number from 1 to {successorBases.length} once.
                  </p>
                )}
              </div>
            )}

            {!node.data.routeByProduct && exitStrategy === 'percentage' && (
              <div className="mt-2 space-y-1.5">
                {successorBases.map((s) => (
                  <div key={s} className="flex items-center gap-2">
                    <span className="text-xs text-gray-600 flex-1 truncate">{s}</span>
                    <div className="relative w-20">
                      <NumericField
                        value={exitPercentages[s] ?? 0}
                        onCommit={(n) => onChange(node.id, { exitPercentages: { ...exitPercentages, [s]: n } })}
                        className="h-8 text-sm rounded-lg border-gray-200 bg-gray-50 focus:bg-white pr-6 [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
                      />
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">%</span>
                    </div>
                  </div>
                ))}
                <p className={`text-[10px] ${exitPercentTotal === 100 ? 'text-gray-400' : 'text-amber-600'}`}>
                  Total: {exitPercentTotal}%{exitPercentTotal !== 100 && ' — should add up to 100%'}
                </p>
              </div>
            )}

            {/* Route by product: the ticks say which next stations each
                product may go to; the choice below picks among a product's
                ticked ones (Cyclic: its own strict turn), and a job waits
                for the station it was given. */}
            {node.data.routeByProduct && (() => {
              const routes = node.data.productRoutes ?? {}
              const allowed = (p: string) => (routes[p] ?? []).filter((s) => successorBases.includes(s))
              const toggle = (p: string, s: string) => {
                const now = allowed(p)
                onChange(node.id, {
                  productRoutes: { ...routes, [p]: now.includes(s) ? now.filter((x) => x !== s) : [...now, s] },
                })
              }
              const missing = products.filter((p) => allowed(p).length === 0)
              return (
                <div className="mt-2">
                  <div className="overflow-x-auto">
                    <table className="text-[11px] border border-gray-200 rounded-lg">
                      <thead>
                        <tr className="bg-gray-50 text-gray-500">
                          <th className="px-1.5 py-1 text-left font-semibold"></th>
                          {successorBases.map((s) => (
                            <th key={s} className="px-1.5 py-1 font-semibold whitespace-nowrap">{s}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {products.map((p) => (
                          <tr key={p} className="border-t border-gray-100">
                            <td className={`px-1.5 py-1 whitespace-nowrap ${allowed(p).length === 0 ? 'text-amber-600 font-semibold' : 'text-gray-700'}`}>{p}</td>
                            {successorBases.map((s) => (
                              <td key={s} className="px-1.5 py-1 text-center">
                                <input
                                  type="checkbox"
                                  checked={allowed(p).includes(s)}
                                  onChange={() => toggle(p, s)}
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {missing.length > 0 && (
                    <p className="text-[10px] text-amber-600 mt-1.5">
                      Tick at least one station for {missing.join(', ')}.
                    </p>
                  )}
                  <p className="text-[10px] text-gray-400 mt-1.5">
                    Each product only goes to its ticked stations, strictly in turn from the first (#1, #2, #1, …) — a job waits for the one whose turn it is, never skipping to another.
                  </p>
                </div>
              )
            })()}
          </div>
        )}

        {/* Start: parts delivered / End: parts collected (last run, after
            the warm-up) — the total and per product. An End collects what
            leaves the stations whose lines go into it (for the products on
            those lines); a Dismantle's pieces count one by one. */}
        {(nodeType === 'Source' || nodeType === 'Drain') && partsFlow && (() => {
          const isStart = nodeType === 'Source'
          const byProduct: Record<string, number> = {}
          const add = (counts: Record<string, number> | undefined) => {
            for (const [p, n] of Object.entries(counts ?? {})) byProduct[p] = (byProduct[p] ?? 0) + n
          }
          if (isStart) {
            // Every Start shows all products, as delivered by all Starts
            // (one MU table for every Start).
            Object.values(partsFlow.delivered).forEach((c) => add(c))
          } else {
            // Each line in: the parts whose route is a product of that line
            // (every product for a line not tagged), by the part's own name.
            for (const e of allEdges.filter((e) => e.target === node.id)) {
              const src = nodes.find((n) => n.id === e.source)
              if (!src) continue
              const lineProducts = edgeProducts(e)
              for (const [route, names] of Object.entries(partsFlow.collected[src.data.savedName ?? stationKey(src)] ?? {})) {
                if (!lineProducts || lineProducts.includes(route)) add(names)
              }
            }
          }
          const count = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))
          const total = Object.values(byProduct).reduce((a, b) => a + b, 0)
          return (
            <div>
              <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                Statistical Analysis
              </label>
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-gray-700">{isStart ? 'Parts delivered' : 'Parts collected'}</span>
                <span className="font-bold text-gray-900 tabular-nums">{count(total)}</span>
              </div>
              <div className="mt-1.5 space-y-1">
                {Object.entries(byProduct).sort(([a], [b]) => a.localeCompare(b)).map(([p, n]) => (
                  <div key={p} className="flex items-center justify-between text-xs">
                    <span className="text-gray-600 truncate">{p}</span>
                    <span className="font-semibold text-gray-800 tabular-nums">{count(n)}</span>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-gray-400 mt-1.5">Last run, after the warm-up.</p>
            </div>
          )
        })()}

        {/* Buffer: statistical analysis (last run) — the share of its
            operating time it was Empty, Occupied (parts, room for more) or
            Full; the three add up to 100%. */}
        {nodeType === 'Buffer' && (() => {
          const st = bufferStates[node.data.savedName ?? stationKey(node)]
          if (!st) return null
          const rows = [
            { label: 'Empty', value: st.empty, color: '#cbd5e1' },
            { label: 'Occupied', value: st.occupied, color: '#3b82f6' },
            { label: 'Full', value: st.full, color: '#ef4444' },
          ]
          return (
            <div>
              <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                Statistical Analysis
              </label>
              <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-gray-100">
                {rows.map((r) => r.value > 0 && (
                  <div key={r.label} style={{ width: `${r.value}%`, background: r.color }} title={`${r.label} ${r.value.toFixed(2)}%`} />
                ))}
              </div>
              <div className="mt-2 space-y-1">
                {rows.map((r) => (
                  <div key={r.label} className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-gray-600">
                      <span className="h-2 w-2 rounded-sm" style={{ background: r.color }} />
                      {r.label}
                    </span>
                    <span className="font-semibold text-gray-800 tabular-nums">{r.value.toFixed(2)}%</span>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-gray-400 mt-1.5">
                Last run · of {st.operating_time.toFixed(0)} min operating time (shift time minus breaks).
              </p>
              {/* Parts, as on a station: in the buffer at the end of the run;
                  moved on from it after the warm-up; scrap (always 0). */}
              {st.completed_parts !== undefined && (() => {
                const count = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))
                const parts = [
                  { label: 'Current parts', value: st.current_parts ?? 0 },
                  { label: 'Completed parts', value: st.completed_parts ?? 0 },
                  { label: 'Scrap count', value: st.scrapped_parts ?? 0 },
                ]
                return (
                  <div className="mt-2.5 space-y-1 border-t border-gray-100 pt-2">
                    {parts.map((p) => (
                      <div key={p.label} className="flex items-center justify-between text-xs">
                        <span className="text-gray-600">{p.label}</span>
                        <span className="font-semibold text-gray-800 tabular-nums">{count(p.value)}</span>
                      </div>
                    ))}
                  </div>
                )
              })()}
            </div>
          )
        })()}

        {/* Statistical analysis (last run): the share of this station's
            operating time — shift time minus breaks and PM — it spent in
            each state; the five add up to 100%. Working stations only. */}
        {!['Source', 'Drain', 'Buffer', 'Connector', 'Worker', 'Workplace', 'Worker Controller'].includes(nodeType) && (() => {
          const st = stationStates[node.data.savedName ?? stationKey(node)]
          if (!st) return null
          const rows = [
            { label: 'Working', value: st.working, color: '#22c55e' },
            { label: 'Free', value: st.free, color: '#cbd5e1' },
            { label: 'Setup', value: st.setup, color: '#8b5cf6' },
            { label: 'Blocked', value: st.blocked, color: '#f59e0b' },
            { label: 'Failed', value: st.failed, color: '#ef4444' },
          ]
          return (
            <div>
              <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
                Statistical Analysis
              </label>
              <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-gray-100">
                {rows.map((r) => r.value > 0 && (
                  <div key={r.label} style={{ width: `${r.value}%`, background: r.color }} title={`${r.label} ${r.value.toFixed(2)}%`} />
                ))}
              </div>
              <div className="mt-2 space-y-1">
                {rows.map((r) => (
                  <div key={r.label} className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-gray-600">
                      <span className="h-2 w-2 rounded-sm" style={{ background: r.color }} />
                      {r.label}
                    </span>
                    <span className="font-semibold text-gray-800 tabular-nums">{r.value.toFixed(2)}%</span>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-gray-400 mt-1.5">
                Last run · of {st.operating_time.toFixed(0)} min operating time (shift time minus breaks and PM).
              </p>
              {/* Parts: on the machine at the end of the run (not the queue in
                  front); completed and scrapped after the warm-up; Dismantle:
                  the pieces it gave out. */}
              {st.completed_parts !== undefined && (() => {
                const count = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))
                const parts = [
                  { label: 'Current parts', value: st.current_parts ?? 0 },
                  { label: 'Completed parts', value: st.completed_parts ?? 0 },
                  { label: 'Scrap count', value: st.scrapped_parts ?? 0 },
                  ...(st.output_components != null ? [{ label: 'Output components', value: st.output_components }] : []),
                ]
                return (
                  <div className="mt-2.5 space-y-1 border-t border-gray-100 pt-2">
                    {parts.map((p) => (
                      <div key={p.label} className="flex items-center justify-between text-xs">
                        <span className="text-gray-600">{p.label}</span>
                        <span className="font-semibold text-gray-800 tabular-nums">{count(p.value)}</span>
                      </div>
                    ))}
                  </div>
                )
              })()}
            </div>
          )
        })()}
      </div>

      {/* Save station button — applies the station's values and closes the panel.
          (Delete is available via the trash icon in the header.) */}
      <div className="px-4 pb-4">
        <button
          onClick={onSaveStation}
          className="w-full py-2 text-xs font-semibold text-ls-card bg-ls-dark hover:opacity-90 rounded-xl transition-colors"
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

// A step's `resource` is a plain station name. Scenarios saved while the Exit
// Controller existed may still hold a {mode, options, ...} dict — only its
// first station is used, matching backend/engine/sim_core.py's
// _resolve_step_resource. Never render/key the raw dict (React throws on a
// plain object child).
function stepResourceOptions(resource: string | { options?: string[] }): string[] {
  if (typeof resource === 'string') return [resource]
  const first = resource?.options?.[0]
  return first ? [first] : []
}

// The columns of a variant's flow, in order: a plain step is a column of its
// own; consecutive steps sharing a "branch" number (a split — each job visits
// only one of them) are one column, drawn as stacked boxes. Matches
// _branch_slots in backend/engine/sim_core.py.
function stepColumns<T extends { branch?: number }>(steps: T[]): T[][] {
  const columns: T[][] = []
  for (const step of steps) {
    const last = columns[columns.length - 1]
    if (step.branch !== undefined && last && last[0].branch === step.branch) last.push(step)
    else columns.push([step])
  }
  return columns
}

// ─── Flow builder from scenario ───────────────────────────────────────────────

function buildFlowGraph(
  processflow: Record<string, { operation: string; resource: string | { options?: string[] }; duration: number; branch?: number }[]>,
  variant: string,
  stationStats: Record<string, {
    utilization: number; jobs: number
    bufferCapacity: number; bufferDiscipline: string
    bufferBlockedRatio: number; bufferBlockedTime: number
    rackLaneCount?: number | null; rackOccupied?: number | null
  }>,
  stationsData: Record<string, { capacity?: number; 'Station Type'?: string; shifts_per_day?: number | number[]; 'Worker Controller'?: string }> = {},
): { nodes: Node<FlowNodeData | EndpointNodeData>[]; edges: Edge[] } {
  const steps = processflow[variant] ?? []
  // FlowNode is now icon-first (112px icon + name/resource/duration/util rows
  // beneath it, ~200px tall overall) rather than the old compact text card —
  // ROW_GAP needs real room to keep stacked parallel-machine icons from
  // overlapping, same fix already applied to Build mode's layout.
  const COL_GAP = 260
  const ROW_GAP = 170     // vertical spacing between parallel machines

  const nodes: Node<FlowNodeData | EndpointNodeData>[] = []
  // stepNodeIds[i] = list of node ids in column i (one per parallel machine)
  const stepNodeIds: string[][] = []

  stepColumns(steps).forEach((column, i) => {
    // One entry per station in this column (a split stacks several).
    const options = column.flatMap((step) => stepResourceOptions(step.resource).map((name) => ({ name, step })))
    const ids: string[] = []

    // capacity>1 fans out into stacked parallel-machine boxes.
    const groupCapacities = options.map(({ name }) => stationsData[name]?.capacity ?? 1)
    const totalRows = groupCapacities.reduce((a, b) => a + b, 0)
    const BASE_Y = 100
    const stackHeight = (totalRows - 1) * ROW_GAP
    let rowCursor = 0

    options.forEach(({ name: resourceName, step }, oi) => {
      const stat = stationStats[resourceName]
      const capacity = groupCapacities[oi]
      for (let m = 0; m < capacity; m++) {
        const id = `step_${i}_o${oi}_m${m}`
        ids.push(id)
        const label = capacity > 1 ? `${step.operation} #${m + 1}` : step.operation
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
            bufferCapacity: stat?.bufferCapacity,
            bufferDiscipline: stat?.bufferDiscipline,
            bufferBlockedRatio: stat?.bufferBlockedRatio,
            bufferBlockedTime: stat?.bufferBlockedTime,
            rackLaneCount: stat?.rackLaneCount,
            rackOccupied: stat?.rackOccupied,
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
    // (Only station nodes exist yet — the Start/End pills are added below.)
    const stationTypeOf = (id: string) => (nodes.find((n) => n.id === id)?.data as FlowNodeData | undefined)?.stationType
    const firstColIsSource = firstCol.some((id) => stationTypeOf(id) === 'Source')
    const lastColIsDrain = lastCol.some((id) => stationTypeOf(id) === 'Drain')
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
 *  editable boxes (same layout/positions as buildFlowGraph), each fully editable. */
function buildEditableGraph(
  processflow: Record<string, { operation: string; resource: string | { options?: string[] }; duration: number; branch?: number }[]>,
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

  stepColumns(steps).forEach((column, i) => {
    // One entry per station in this column (a split stacks several).
    const options = column.flatMap((step) => stepResourceOptions(step.resource).map((name) => ({ name, step })))
    const groupCapacities = options.map(({ name }) => stationsData[name]?.capacity ?? 1)
    const totalRows = groupCapacities.reduce((a, b) => a + b, 0)
    const BASE_Y = 100
    const stackHeight = (totalRows - 1) * ROW_GAP
    let rowCursor = 0
    const ids: string[] = []

    options.forEach(({ name: resourceName, step }, oi) => {
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
            savedName: resourceName,
            // A machine of a parallel group keeps its group. An older station
            // with N machines becomes a group of N, each box a machine of its
            // own (starting from the station's settings) once it is saved.
            parallelGroup: cfg?.['Parallel Group'] || (capacity > 1 ? resourceName : undefined),
            stationType: cfg?.['Station Type'],
            capacity: capacity > 1 ? 1 : capacity,
            processTime: step.duration,
            operators: cfg?.operator_per_station ?? 1,
            shiftsPerDay: normalizeShiftsPerDay(cfg?.shifts_per_day),
            // An older conveyor saved with Length + Transport Time (no Speed)
            // gets its Speed as Length / Transport Time, so it rides the same.
            conveyorSpeed: cfg?.['Conveyor Speed']
              ?? ((cfg?.['Conveyor Length'] ?? 0) > 0 && (cfg?.['Transport Time'] ?? 0) > 0
                ? cfg!['Conveyor Length']! / cfg!['Transport Time']!
                : undefined),
            conveyorLength: cfg?.['Conveyor Length'],
            conveyorWidth: cfg?.['Conveyor Width'],
            conveyorHeight: cfg?.['Conveyor Height'],
            conveyorCapacity: cfg?.['Conveyor Capacity'],
            conveyorSensor: cfg?.['Conveyor Sensor Length'] !== undefined
              ? {
                  length: cfg['Conveyor Sensor Length'],
                  position: cfg['Conveyor Sensor Position'] === 'Rear' ? 'rear' : 'front',
                }
              : undefined,
            exitStrategy: cfg?.['Exit Strategy'],
            exitPercentages: cfg?.['Exit Percentages'],
            exitPriorities: cfg?.['Exit Priorities'],
            routeByProduct: cfg?.['Route By Product'],
            productRoutes: cfg?.['Product Routes'],
            assembly: cfg?.['Assembly'],
            dismantle: cfg?.['Dismantle'],
            setupTime: cfg?.['Setup time'],
            repairTime: cfg?.['Repair Time'],
            failureTime: cfg?.['MTBF'] as number | undefined,
            failurePolicy: cfg?.['Failure Policy'],
            bufferQuantity: cfg?.['Buffer Capacity'],
            bufferUnlimited: cfg?.['Buffer Unlimited'],
            bufferConfigMode: cfg?.['Buffer Config Mode'],
            bufferX: cfg?.['Buffer X'],
            bufferY: cfg?.['Buffer Y'],
            bufferZ: cfg?.['Buffer Z'],
            bufferOrder: cfg?.['Buffer Discipline'] as StationNodeData['bufferOrder'],
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
          savedName: controllerBase,
          stationType: 'Worker Controller',
          capacity: 1,
          processTime: 0,
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
            processTime: 0,
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
        // Every box saved under that name — an older station with N machines
        // is N boxes, each staffed like the station was.
        const stationNodeIds = nodes
          .filter((n) => n.data.label === stationBase || n.data.savedName === stationBase)
          .map((n) => n.id)
        if (stationNodeIds.length === 0) return
        const workplaceId = `wp_${poolNodeIndex++}_${controllerBase}_${si}`
        nodes.push({
          id: workplaceId,
          type: 'station',
          position: { x: controllerX + 90 + si * 90, y: poolY - ROW_GAP },
          data: {
            label: `${stationBase} Workplace`,
            stationType: 'Workplace',
            capacity: 1,
            processTime: 0,
            operators: 0,
          },
        })
        for (const stationNodeId of stationNodeIds) {
          edges.push({ id: `e_${stationNodeId}__${workplaceId}`, source: stationNodeId, target: workplaceId })
        }
        edges.push({ id: `e_${workplaceId}__${controllerNodeId}`, source: workplaceId, target: controllerNodeId })
      })
    })
  }

  return { nodes, edges }
}

// ─── The saved drawing (canvas_layout) ───────────────────────────────────────
// One drawing for the whole scenario. Each flow line remembers the products
// whose route uses it, and the product picked on the Canvas is highlighted.
// A line with no products yet (drawn, not saved) is the picked product's.
// Worker / Worker Controller / Workplace lines are staffing wiring, never
// part of a route. Routes stay in processflow_data, which the engine reads.

type FlowStep = ScenarioCreate['processflow_data'][string][number]

const WIRING_TYPES = ['Worker', 'Worker Controller', 'Workplace']

function isWiringNode(n: Node<StationNodeData>): boolean {
  return WIRING_TYPES.includes(inferStationType(n.data.label, n.data.stationType))
}

// A box left out of the line: every box of the flow (not the Worker /
// Worker Controller / Workplace wiring) needs a line coming in (all but
// Start), or jobs never get there. A line may end anywhere without an End:
// a part is finished when it leaves the last box (a last Buffer keeps it;
// a Start alone: finished when released). The first such box, as the
// message to show.
function lineProblem(nodes: Node<StationNodeData>[], edges: Edge[]): string | undefined {
  const flow = nodes.filter((n) => !isWiringNode(n))
  const ids = new Set(flow.map((n) => n.id))
  const flowEdges = edges.filter((e) => ids.has(e.source) && ids.has(e.target))
  for (const n of flow) {
    const type = inferStationType(n.data.label, n.data.stationType)
    const hasIn = flowEdges.some((e) => e.target === n.id)
    if (type !== 'Source' && !hasIn) {
      return `${n.data.label} has no line coming into it — connect it from the box before it`
    }
  }
  return undefined
}

function edgeProducts(e: Edge): string[] | undefined {
  return (e.data as { products?: string[] } | undefined)?.products
}

function withProducts(e: Edge, products: string[]): Edge {
  return { ...e, data: { ...(e.data ?? {}), products } }
}

// Whether a flow line is part of `product`'s route, `shown` being the
// product picked on the Canvas (a new line, with no products yet, is its; a
// line with an empty list is used by no product).
function lineIsFor(e: Edge, product: string | null, shown: string | null): boolean {
  const ps = edgeProducts(e)
  return ps !== undefined ? product !== null && ps.includes(product) : product === shown
}

// A line between two boxes of the flow (not staffing wiring).
function isFlowEdge(e: Edge, byId: Map<string, Node<StationNodeData>>): boolean {
  const a = byId.get(e.source)
  const b = byId.get(e.target)
  return !!a && !!b && !isWiringNode(a) && !isWiringNode(b)
}

// A box's id in the saved drawing is its kind plus a number: STN-3, SRC-1, ...
const BOX_ID_PREFIX: Record<string, string> = {
  Source: 'SRC', Drain: 'DRN', Station: 'STN', Assembly: 'ASM', Dismantle: 'DSM',
  Buffer: 'BUF', Conveyor: 'CNV', Connector: 'CON', Robot: 'ROB',
  Worker: 'WRK', 'Worker Controller': 'WCT', Workplace: 'WPL',
}

function boxIdPrefix(n: Node<StationNodeData>): string {
  return BOX_ID_PREFIX[inferStationType(n.data.label, n.data.stationType)] ?? 'OBJ'
}

// One product's part of the drawing: its lines and the boxes on them, plus
// the staffing wiring. For the picked product also boxes not joined to any
// line yet (a box just dropped in is its, as before).
function productGraph(
  nodes: Node<StationNodeData>[], edges: Edge[], product: string, shown: string,
): { nodes: Node<StationNodeData>[]; edges: Edge[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const flow = edges.filter((e) => isFlowEdge(e, byId))
  const used = new Set(flow.filter((e) => lineIsFor(e, product, shown)).flatMap((e) => [e.source, e.target]))
  const wired = new Set(flow.flatMap((e) => [e.source, e.target]))
  const kept = nodes.filter((n) => isWiringNode(n) || used.has(n.id) || (product === shown && !wired.has(n.id)))
  const ids = new Set(kept.map((n) => n.id))
  return {
    nodes: kept,
    edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)
      && (!isFlowEdge(e, byId) || lineIsFor(e, product, shown))),
  }
}

// A route compared by shape: the station pairs it goes along, and the
// stations it starts and ends at. Same shape = same route.
function routeShape(pairs: Set<string>, first: Set<string>, last: Set<string>): string {
  return JSON.stringify([Array.from(pairs).sort(), Array.from(first).sort(), Array.from(last).sort()])
}
const EMPTY_ROUTE_SIG = routeShape(new Set(), new Set(), new Set())

function routeSig(steps: FlowStep[]): string {
  const cols = stepColumns(steps).map((col) => col.flatMap((st) => stepResourceOptions(st.resource)))
  const pairs = new Set<string>()
  for (let i = 0; i + 1 < cols.length; i++) {
    for (const a of cols[i]) for (const b of cols[i + 1]) pairs.add(`${a}>${b}`)
  }
  return routeShape(pairs, new Set(cols[0] ?? []), new Set(cols[cols.length - 1] ?? []))
}

function graphRouteSig(
  nodes: Node<StationNodeData>[], edges: Edge[], product: string, shown: string | null,
  nameOf: (n: Node<StationNodeData>) => string,
): string {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const typeOf = (n: Node<StationNodeData>) => inferStationType(n.data.label, n.data.stationType)
  const pairs = new Set<string>()
  const first = new Set<string>()
  const last = new Set<string>()
  for (const e of edges) {
    if (!isFlowEdge(e, byId) || !lineIsFor(e, product, shown)) continue
    const a = byId.get(e.source)!
    const b = byId.get(e.target)!
    const fromStart = typeOf(a) === 'Source'
    const toEnd = typeOf(b) === 'Drain'
    if (fromStart && !toEnd) first.add(nameOf(b))
    else if (toEnd && !fromStart) last.add(nameOf(a))
    else if (!fromStart && !toEnd) pairs.add(`${nameOf(a)}>${nameOf(b)}`)
  }
  // A Buffer ending the line with no End is a last box too.
  for (const e of edges) {
    if (!isFlowEdge(e, byId) || !lineIsFor(e, product, shown)) continue
    const b = byId.get(e.target)!
    if (typeOf(b) === 'Buffer' && !edges.some((o) => o.source === b.id && isFlowEdge(o, byId) && lineIsFor(o, product, shown))) {
      last.add(nameOf(b))
    }
  }
  return routeShape(pairs, first, last)
}

// Each product's lines on the drawing, by shape.
function linesByProduct(products: string[], nodes: Node<StationNodeData>[], edges: Edge[]): Record<string, string> {
  return Object.fromEntries(products.map((p) => [p, graphRouteSig(nodes, edges, p, null, (n) => n.data.savedName ?? stationKey(n))]))
}

// A route from a drawing: walk it from where it starts into a list of
// steps, one per station, in flow order (splits and parallel machines
// share a "branch").
function routeFromGraph(
  nodes: Node<StationNodeData>[], edges: Edge[], stepDuration: (n: Node<StationNodeData>) => number,
): FlowStep[] {
  const hasIncoming = new Set(edges.map((e) => e.target))
  const entryNodes = nodes.filter((n) => !hasIncoming.has(n.id))
  const steps: FlowStep[] = []
  const seenStations = new Set<string>()
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

  // The stations of each split share a "branch" number on their steps —
  // the engine then sends each job to only ONE of them (see
  // _branch_slots in sim_core.py). They are pushed back to back below,
  // since the walk reaches all of a split's stations in the same round.
  // A parallel group's machines are one stop the same way (each job goes
  // to one machine), so a group outside any split gets a number too.
  const branchOf: Record<string, number> = {}
  const splits = canvasSplits(nodes, edges)
  splits.forEach((split, i) => {
    for (const b of split.bases) branchOf[b] ??= i + 1
  })
  let nextBranch = splits.length + 1
  for (const n of nodes) {
    const g = n.data.parallelGroup
    if (g && branchOf[g] === undefined && nodes.filter((o) => o.data.parallelGroup === g).length > 1) {
      branchOf[g] = nextBranch++
    }
  }

  let frontier = entryNodes
  const visitedNodeIds = new Set<string>()
  while (frontier.length > 0) {
    const next: Node<StationNodeData>[] = []
    for (const n of frontier) {
      if (visitedNodeIds.has(n.id)) continue
      visitedNodeIds.add(n.id)
      const base = stationKey(n)
      if (seenStations.has(base)) continue
      seenStations.add(base)

      const outgoing = edges.filter((e) => e.source === n.id && !isPoolWiringTarget(e.target))
      const destNodes = outgoing
        .map((e) => nodes.find((nn) => nn.id === e.target))
        .filter((nn): nn is Node<StationNodeData> => !!nn)

      // Source/Drain are entry/exit markers, not a step in the job's
      // route — a saved scenario with a "Start"/"End" step in
      // processflow_data shows a misleading editable column in
      // ScenarioManager's Process Flow tab even at duration 0 (the
      // column itself implies it's a real station). Skip pushing a step
      // for them, but still walk through to whatever they connect to —
      // Source has no incoming edge (it's always an entryNode) and Drain
      // has no outgoing edges, so neither skip affects the rest of the
      // walk.
      const nodeType = inferStationType(n.data.label, n.data.stationType)
      if (nodeType === 'Source' || nodeType === 'Drain') {
        for (const d of destNodes) next.push(d)
        continue
      }

      steps.push({
        operation: `${base}_op`, resource: base, duration: stepDuration(n),
        ...(branchOf[groupKey(n)] !== undefined ? { branch: branchOf[groupKey(n)] } : {}),
        // A Buffer with no line going on (no End): its parts stay in it.
        ...(nodeType === 'Buffer' && destNodes.length === 0 ? { holds_parts: true } : {}),
      })
      for (const d of destNodes) next.push(d)
    }
    frontier = next
  }
  return steps
}

// A station's box settings, read from its saved settings the same way a
// route's boxes are.
function stationBoxData(name: string, stationsData: Record<string, StationConfig>, duration: number): StationNodeData {
  const { nodes } = buildEditableGraph(
    { box: [{ operation: name, resource: name, duration }] }, 'box', { [name]: stationsData[name] },
  )
  return nodes[0].data
}

// A box's saved settings. Drawings saved before the rename keep the box's
// time under its old name "cycleTime" (it always was the Process Time) —
// read it as processTime. Such a drawing may also hold an old unused
// "processTime" display field; the "cycleTime" value is the real one.
function savedBoxData(data: CanvasLayoutBox['data']): Partial<StationNodeData> {
  if (!data || !('cycleTime' in data)) return data ?? {}
  const { cycleTime, ...rest } = data as Partial<StationNodeData> & { cycleTime?: number }
  return { ...rest, processTime: cycleTime }
}

// The saved drawing, back as boxes and lines. Settings come from the saved
// stations (the Scenario page edits those); a station deleted there loses
// its box. A product whose route was changed on the Scenario page since the
// drawing was saved gets its lines drawn again from the route (a station new
// to the drawing is placed next to the one before it).
function graphFromLayout(
  layout: CanvasLayout,
  processflow: Record<string, FlowStep[]>,
  stationsData: Record<string, StationConfig>,
): { nodes: Node<StationNodeData>[]; edges: Edge[] } {
  const products = Object.keys(processflow)
  const nodes: Node<StationNodeData>[] = []
  for (const box of layout.boxes) {
    // An older station of N machines is saved under its own name, its boxes as "Name #k".
    const key = stationsData[box.name] ? box.name : baseStationName(box.name)
    const cfg = stationsData[key]
    if (!cfg && !['Source', 'Drain', ...WIRING_TYPES].includes(box.type)) continue
    const saved = savedBoxData(box.data)
    const data: StationNodeData = cfg
      ? { ...saved, ...stationBoxData(key, stationsData, saved.processTime ?? 0), label: box.name, savedName: key, capacity: 1, boxId: box.id }
      : { capacity: 1, processTime: 0, operators: 0, shiftsPerDay: [1], ...saved, label: box.name, boxId: box.id }
    nodes.push({ id: box.id, type: 'station', position: { x: box.x, y: box.y }, data })
  }
  const ids = new Set(nodes.map((n) => n.id))
  let edges: Edge[] = []
  for (const line of layout.lines) {
    if (!ids.has(line.from) || !ids.has(line.to)) continue
    // Lines of products no longer in the scenario go.
    const kept = line.products?.filter((p) => products.includes(p))
    if (kept && kept.length === 0 && line.products!.length > 0) continue
    edges.push({
      id: `e_${line.from}__${line.to}`, source: line.from, target: line.to,
      ...(line.label ? { label: line.label } : {}),
      ...(kept ? { data: { products: kept } } : {}),
    })
  }

  const nameOf = (n: Node<StationNodeData>) => n.data.savedName ?? stationKey(n)
  const typeOf = (n: Node<StationNodeData>) => inferStationType(n.data.label, n.data.stationType)
  for (const p of products) {
    const steps = processflow[p] ?? []
    const savedShape = layout.routes?.[p]
    if (savedShape !== undefined
      ? savedShape === routeSig(steps)
      : graphRouteSig(nodes, edges, p, null, nameOf) === routeSig(steps)) continue
    // Changed on the Scenario page: take its lines off, draw them from its route.
    edges = edges.flatMap((e) => {
      const ps = edgeProducts(e)
      if (!ps || !ps.includes(p)) return [e]
      const rest = ps.filter((x) => x !== p)
      return rest.length > 0 ? [withProducts(e, rest)] : []
    })
    const cols = stepColumns(steps).map((col) => col.flatMap((st) => stepResourceOptions(st.resource)))
    if (cols.length === 0) continue
    const link = (a: Node<StationNodeData>, b: Node<StationNodeData>) => {
      const existing = edges.find((e) => e.source === a.id && e.target === b.id)
      if (!existing) {
        edges.push({ id: `e_${a.id}__${b.id}`, source: a.id, target: b.id, data: { products: [p] } })
      } else if (!(edgeProducts(existing) ?? []).includes(p)) {
        edges = edges.map((e) => (e === existing ? withProducts(e, [...(edgeProducts(e) ?? []), p]) : e))
      }
    }
    const boxesOf = (name: string, near?: Node<StationNodeData>): Node<StationNodeData>[] => {
      const found = nodes.filter((n) => !isWiringNode(n) && nameOf(n) === name)
      if (found.length > 0 || !stationsData[name]) return found
      const box: Node<StationNodeData> = {
        id: `added_${nodes.length}`, type: 'station',
        position: near ? { x: near.position.x + 130, y: near.position.y + 170 } : { x: 40, y: 100 },
        data: { ...stationBoxData(name, stationsData, 0), label: name, savedName: name, capacity: 1 },
      }
      nodes.push(box)
      return [box]
    }
    const firstBoxes = boxesOf(cols[0][0])
    const start = nodes.find((n) => typeOf(n) === 'Source' && edges.some((e) => e.source === n.id && firstBoxes.some((b) => b.id === e.target)))
      ?? nodes.find((n) => typeOf(n) === 'Source')
    let prev: Node<StationNodeData>[] = start ? [start] : []
    for (const col of cols) {
      const here = col.flatMap((name) => boxesOf(name, prev[0]))
      for (const a of prev) for (const b of here) link(a, b)
      prev = here
    }
    const end = nodes.find((n) => typeOf(n) === 'Drain' && edges.some((e) => e.target === n.id && prev.some((b) => b.id === e.source)))
      ?? nodes.find((n) => typeOf(n) === 'Drain')
    if (end) for (const a of prev) link(a, end)
  }
  return { nodes, edges }
}

// A scenario with no saved drawing (saved before drawings were kept, or
// imported): every product's route drawn as one picture — each station
// once, a line per step tagged with the products going along it, laid out
// left to right by how far along the flow each station is.
function wholeScenarioGraph(
  processflow: Record<string, FlowStep[]>,
  stationsData: Record<string, StationConfig>,
): { nodes: Node<StationNodeData>[]; edges: Edge[] } {
  const nodes: Node<StationNodeData>[] = []
  let edges: Edge[] = []
  const unionId = new Map<string, string>()
  const typeOf = (n: Node<StationNodeData>) => inferStationType(n.data.label, n.data.stationType)
  const link = (source: string, target: string, product?: string) => {
    const existing = edges.find((e) => e.source === source && e.target === target)
    if (!existing) {
      edges.push({ id: `e_${source}__${target}`, source, target, ...(product ? { data: { products: [product] } } : {}) })
    } else if (product && !(edgeProducts(existing) ?? []).includes(product)) {
      edges = edges.map((e) => (e === existing ? withProducts(e, [...(edgeProducts(e) ?? []), product]) : e))
    }
  }
  // A station's column: the furthest along any route has it first.
  const column = new Map<string, number>()
  const sourceName = Object.keys(stationsData).find((k) => stationsData[k]?.['Station Type'] === 'Source') ?? 'Start'
  const drainName = Object.keys(stationsData).find((k) => stationsData[k]?.['Station Type'] === 'Drain') ?? 'End'
  const start: Node<StationNodeData> = {
    id: 'start', type: 'station', position: { x: 0, y: 0 },
    data: { label: sourceName, stationType: 'Source', capacity: 1, processTime: 0, operators: 0, shiftsPerDay: [1] },
  }
  const end: Node<StationNodeData> = {
    id: 'end', type: 'station', position: { x: 0, y: 0 },
    data: { label: drainName, stationType: 'Drain', capacity: 1, processTime: 0, operators: 0, shiftsPerDay: [1] },
  }
  for (const p of Object.keys(processflow)) {
    const g = buildEditableGraph(processflow, p, stationsData)
    if (g.nodes.length === 0) continue
    const local = new Map<string, string>()
    for (const n of g.nodes) {
      const key = `${typeOf(n)}|${n.data.label}`
      if (!unionId.has(key)) {
        unionId.set(key, n.id)
        nodes.push(n)
      }
      local.set(n.id, unionId.get(key)!)
    }
    const gById = new Map(g.nodes.map((n) => [n.id, n]))
    const flow = g.edges.filter((e) => isFlowEdge(e, gById))
    // Where each station first comes in this route (its column).
    const firstCol = new Map<string, number>()
    for (const n of g.nodes) {
      const col = Number(n.id.match(/^st_(\d+)_/)?.[1] ?? NaN)
      const at = local.get(n.id)!
      if (Number.isFinite(col) && !(firstCol.get(at)! <= col)) firstCol.set(at, col)
    }
    for (const e of g.edges) link(local.get(e.source)!, local.get(e.target)!, isFlowEdge(e, gById) ? p : undefined)
    for (const [at, col] of firstCol) column.set(at, Math.max(column.get(at) ?? 0, col + 1))
    // Its Start and End — unless the route already has its own.
    for (const n of g.nodes.filter((x) => !isWiringNode(x))) {
      const t = typeOf(n)
      if (t !== 'Source' && !flow.some((e) => e.target === n.id)) link(start.id, local.get(n.id)!, p)
      if (t !== 'Drain' && !flow.some((e) => e.source === n.id)) link(local.get(n.id)!, end.id, p)
    }
  }
  if (nodes.length === 0) return { nodes, edges }
  const taken = new Set(nodes.map((n) => n.data.label))
  for (const box of [start, end]) {
    if (!edges.some((e) => e.source === box.id || e.target === box.id)) continue
    for (let k = 2; taken.has(box.data.label); k++) box.data = { ...box.data, label: `${box.id === 'start' ? sourceName : drainName} ${k}` }
    taken.add(box.data.label)
    if (box.id === 'start') nodes.unshift(box)
    else nodes.push(box)
  }
  column.set(start.id, 0)
  column.set(end.id, Math.max(0, ...column.values()) + 1)

  // Each column's boxes stacked.
  const rank = new Map(nodes.filter((n) => !isWiringNode(n) && column.has(n.id)).map((n) => [n.id, column.get(n.id)!]))
  const ROW_GAP = 190
  const columns = new Map<number, Node<StationNodeData>[]>()
  for (const n of nodes) {
    if (!rank.has(n.id)) continue
    const col = rank.get(n.id)!
    columns.set(col, [...(columns.get(col) ?? []), n])
  }
  const placed = new Map<string, { x: number; y: number }>()
  for (const [col, boxes] of columns) {
    boxes.forEach((n, i) => placed.set(n.id, { x: col * EDITABLE_COL_GAP + 40, y: 100 - ((boxes.length - 1) * ROW_GAP) / 2 + i * ROW_GAP }))
  }
  return { nodes: nodes.map((n) => (placed.has(n.id) ? { ...n, position: placed.get(n.id)! } : n)), edges }
}

// Station settings the Canvas save writes itself (from the boxes and their
// wiring). Everything else in a station's saved settings is kept as is.
const CANVAS_STATION_KEYS = [
  'capacity', 'shifts_per_day', 'operator_per_station', 'Station Type', 'Parallel Group',
  // Start's Exit Controller (restored onto the Start box when it loads).
  'MU Strategy', 'MU Priorities', 'MU Percentages',
  'Conveyor Speed', 'Conveyor Length', 'Conveyor Width', 'Conveyor Height', 'Conveyor Capacity',
  'Conveyor Sensor Length', 'Conveyor Sensor Position',
  'Exit Strategy', 'Exit Percentages', 'Exit Priorities', 'Route By Product', 'Product Routes',
  // 'Assembly Count' / 'Assembly Inputs': the old assembly fields, now
  // gone — listed so a save clears them.
  'Assembly', 'Assembly Count', 'Assembly Inputs', 'Dismantle', 'Setup time',
  'Buffer Capacity', 'Buffer Unlimited', 'Buffer Config Mode', 'Buffer X', 'Buffer Y', 'Buffer Z', 'Buffer Discipline',
  'Repair Time', 'Failure Policy',
  // Worker Controller wiring — rebuilt from the edges on every save.
  'Worker Controller', 'Pool Workers', 'Enabled', 'Assignment Strategy', 'Queue Policy', 'Max Queue Size',
  'Shift Start', 'Shift End', 'Allow Overtime', 'Use Worker Travel Time',
]

// Column/row spacing matching buildEditableGraph's own layout, needed again
// here since ensureSourceAndDrain positions its inserted boxes relative to it.
const EDITABLE_COL_GAP = 260


/** A conveyor's transport time (min) = Length (m) / Speed (m/min); undefined until both are > 0. */
function conveyorTransportTime(data: StationNodeData): number | undefined {
  const length = data.conveyorLength ?? 0
  const speed = data.conveyorSpeed ?? 0
  return length > 0 && speed > 0 ? length / speed : undefined
}

/** Up to `digits` decimals (default 2), no trailing zeros (30, 2.5, 3.33). */
function formatDecimal(n: number, digits = 2): string {
  const f = 10 ** digits
  return String(Math.round(n * f) / f)
}

// Conveyor Sensor pop-up — a sensor's position along the belt (Length, m)
// and whether a job's Front or Rear end triggers it (only one). OK saves and
// closes, Apply saves and stays open, Cancel closes without changes.
function ConveyorSensorDialog({ conveyorName, conveyorLength, initial, onApply, onClose }: {
  conveyorName: string
  conveyorLength: number
  initial?: { length: number; position: 'front' | 'rear' }
  onApply: (sensor: { length: number; position: 'front' | 'rear' }) => void
  onClose: () => void
}) {
  const [lengthDraft, setLengthDraft] = useState(String(initial?.length ?? 0))
  const [position, setPosition] = useState<'front' | 'rear'>(initial?.position ?? 'front')

  const length = lengthDraft.trim() === '' ? NaN : Number(lengthDraft)
  const valid = Number.isFinite(length) && length >= 0 && length <= conveyorLength
  const sensor = { length, position }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-[340px] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-indigo-50">
          <div>
            <h2 className="text-sm font-bold text-gray-900">Sensor</h2>
            <p className="text-xs text-gray-400 mt-0.5">{conveyorName}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Fields */}
        <div className="p-5 space-y-4">
          <div>
            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1.5">
              Length (m)
            </label>
            <Input
              type="number"
              min={0}
              value={lengthDraft}
              onChange={(e) => setLengthDraft(e.target.value)}
              className="h-8 text-sm rounded-lg border-gray-200 bg-gray-50 focus:bg-white [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
            />
            {!valid && (
              <p className="text-[10px] text-amber-600 mt-1">
                Sensor length must be between 0 and the conveyor length ({formatDecimal(conveyorLength)} m).
              </p>
            )}
          </div>
          <div className="space-y-2">
            {(['front', 'rear'] as const).map((p) => (
              <label key={p} className="flex items-center gap-2 text-xs font-semibold text-gray-700">
                <input
                  type="checkbox"
                  checked={position === p}
                  onChange={() => setPosition(p)}
                />
                {p === 'front' ? 'Front' : 'Rear'}
              </label>
            ))}
          </div>
        </div>

        {/* Buttons */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-100">
          <Button
            size="sm"
            disabled={!valid}
            onClick={() => { onApply(sensor); onClose() }}
          >
            OK
          </Button>
          <Button size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="outline" disabled={!valid} onClick={() => onApply(sensor)}>
            Apply
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// A row of the MU table pop-up: a MuRow plus where it came from — `orig` is
// the product's name when the pop-up opened (undefined for a row added here),
// `copyFrom` the existing product whose route a new row copies.
interface MuDialogRow extends MuRow {
  orig?: string
  copyFrom?: string
  // The Start that releases it (its station name); one Start's products are
  // kept in that Start's own MU table.
  start?: string
}

// Assembly station settings — Tecnomatix's AssemblyStation Attributes tab,
// shown in the station panel; each change applies at once, like the panel's
// other fields. UI only for now: saved with the scenario, not read by the
// simulation.
const DEFAULT_ASSEMBLY: AssemblyConfig = {
  table: 'none', mainMuFromPredecessor: 1, mainMuDefault: true,
  mode: 'delete_mus', exitingMu: 'main_mu',
  predecessorRows: [], muTypeRows: [],
}

const ASSEMBLY_TABLE_KINDS: { value: AssemblyTableKind; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'predecessors', label: 'Predecessors' },
  { value: 'mu_types', label: 'Flow Entity(FE)' },
]

// A box's assembly settings with every field set. A type no longer offered
// (Depends on / Fill-up Main MU) reads as None; Default is ticked when the
// main part is predecessor 1.
function assemblySettings(saved?: AssemblyConfig): AssemblyConfig {
  const a = { ...DEFAULT_ASSEMBLY, ...saved }
  return {
    ...a,
    mainMuDefault: saved?.mainMuDefault ?? a.mainMuFromPredecessor === 1,
    table: ASSEMBLY_TABLE_KINDS.some((k) => k.value === a.table) ? a.table : 'none',
  }
}

// The stations whose lines come into a box, in the order they were
// connected (P1 = the first line connected; delete one and the later ones
// move up) — staffing wiring left out. For an Assembly: its incoming lines.
function incomingStations(nodeId: string, nodes: Node<StationNodeData>[], edges: Edge[]): string[] {
  return Array.from(new Set(
    edges
      .filter((e) => e.target === nodeId)
      .map((e) => nodes.find((n) => n.id === e.source))
      .filter((n): n is Node<StationNodeData> => !!n && !isWiringNode(n))
      .map(groupKey),
  ))
}

// The stations a box's lines go to, in the order they were connected
// (staffing wiring left out). For a Dismantle: its successors 1, 2, ...
function outgoingStations(nodeId: string, nodes: Node<StationNodeData>[], edges: Edge[]): string[] {
  return Array.from(new Set(
    edges
      .filter((e) => e.source === nodeId)
      .map((e) => nodes.find((n) => n.id === e.target))
      .filter((n): n is Node<StationNodeData> => !!n && !isWiringNode(n))
      .map(groupKey),
  ))
}

// Each line's No. into an Assembly: Predecessors — as typed in Assembly
// needs; otherwise (or not typed) the order the lines were connected.
function typedNumbers(assembly: AssemblyConfig, incoming: string[]): Record<string, number> {
  return Object.fromEntries(incoming.map((from, i) => {
    const no = assembly.table === 'predecessors' ? assembly.needs?.find((x) => x.from === from)?.no : undefined
    return [from, no ?? i + 1]
  }))
}

// The number each line shows on the canvas (P1, P2, ...): its No., but while
// that No. is in error (not a whole number from 1 to the lines coming in, or
// another line has it too) the order it was connected.
function lineNumbers(assembly: AssemblyConfig, incoming: string[]): Record<string, number> {
  const typed = typedNumbers(assembly, incoming)
  const nos = Object.values(typed)
  return Object.fromEntries(incoming.map((from, i) => {
    const no = typed[from]
    const ok = Number.isInteger(no) && no >= 1 && no <= incoming.length && nos.filter((x) => x === no).length === 1
    return [from, ok ? no : i + 1]
  }))
}

// Why a Predecessors Assembly needs table can't be used, or undefined (shown
// in the panel; blocks Save): every No. a whole number from 1 to the lines
// coming in, each line its own; every amount 1 or more; a line with the No.
// of Main FE from predecessor.
function needsProblem(assembly: AssemblyConfig, incoming: string[]): string | undefined {
  if (assembly.table !== 'predecessors' || incoming.length === 0) return undefined
  const whole = (n: number | null | undefined, min: number) => n != null && Number.isInteger(n) && n >= min
  const numbers = typedNumbers(assembly, incoming)
  const nos = incoming.map((from) => numbers[from])
  const amounts = incoming.map((from) => assembly.needs?.find((x) => x.from === from)?.amount ?? 1)
  const mainNo = assembly.mainMuDefault ? 1 : assembly.mainMuFromPredecessor
  const lines = incoming.length
  return nos.some((n) => !whole(n, 1)) ? 'No. must be a whole number, 1 or more.'
    : nos.some((n) => n > lines) ? `No. can't be more than ${lines} — only ${lines} line${lines === 1 ? '' : 's'} come in.`
      : new Set(nos).size !== nos.length ? 'Each line needs its own No.'
        : amounts.some((n) => !whole(n, 1)) ? 'Amount must be a whole number, 1 or more.'
          : !nos.includes(mainNo) ? `No line has No. ${mainNo} — the main part (Main FE from predecessor).`
            : undefined
}

// Why these assembly settings can't be used, or undefined.
// - Types None and Flow Entity(FE): Main FE from predecessor is the main
//   line, counted in the order connected, so it can't be more than the lines
//   coming in.
// - With exactly 2 lines, Attach all parts can't go on as the Main FE.
// - Delete entity keeps only the main part, so nothing is joined to make a New FE.
function assemblyProblem(assembly: AssemblyConfig, incomingLines: number): string | undefined {
  const mainLine = assembly.mainMuDefault ? 1 : assembly.mainMuFromPredecessor
  if (assembly.table !== 'predecessors' && incomingLines > 0 && mainLine > incomingLines) {
    return `Main FE from predecessor is ${mainLine}, but only ${incomingLines} line${incomingLines === 1 ? '' : 's'} come into this Assembly.`
  }
  // With exactly 2 lines, attached parts can't go on as the Main FE (any type).
  if (incomingLines === 2 && assembly.mode === 'attach_mus' && assembly.exitingMu === 'main_mu') {
    return 'With 2 lines, Attach all parts needs a New FE — or choose Delete entity.'
  }
  if (assembly.exitingMu !== 'new_fe') return undefined
  if (assembly.mode === 'delete_mus') return 'Delete entity keeps only the main part — a New FE needs Attach all parts (or choose Main FE).'
  if (!(assembly.newFeName ?? '').trim()) return 'Give the New FE a name.'
  return undefined
}

function AssemblyPanel({ assembly, products, incoming, lineProducts, onChange }: {
  assembly: AssemblyConfig
  products: string[]
  // The stations whose lines come into this Assembly, in the order connected.
  incoming: string[]
  // Incoming station -> the products whose route uses its line in.
  lineProducts: Record<string, string[]>
  onChange: (assembly: AssemblyConfig) => void
}) {
  const set = (patch: Partial<AssemblyConfig>) => onChange({ ...assembly, ...patch })
  // Flow Entity(FE): its table (FE Name + Amount) is right here; Predecessors
  // has the Assembly needs table. Each keeps its own rows.
  const hasRows = assembly.table === 'mu_types'
  const rows = assembly.muTypeRows
  const setRows = (next: AssemblyTableRow[]) => set({ muTypeRows: next })
  const update = (i: number, patch: Partial<AssemblyTableRow>) => setRows(rows.map((r, ri) => (ri === i ? { ...r, ...patch } : r)))
  const whole = (n: number | null | undefined, min: number) => n != null && Number.isInteger(n) && n >= min

  const mainMuValid = assembly.mainMuDefault || whole(assembly.mainMuFromPredecessor, 1)
  const feNames = rows.map((r) => (r.mu ?? '').trim())
  // The main part (on line "Main FE from predecessor", in the order connected) is not
  // an FE to add — it's already the main part.
  const mainLine = incoming[(assembly.mainMuDefault ? 1 : assembly.mainMuFromPredecessor) - 1]
  const mainParts = mainLine ? lineProducts[mainLine] ?? [] : []
  const mainPicked = feNames.find((n) => mainParts.includes(n))
  const problem =
    feNames.some((n) => !n) ? 'Choose an FE for every row.'
      : mainPicked ? `${mainPicked} is the main part (Main FE from predecessor) — pick another FE.`
      : new Set(feNames).size !== feNames.length ? 'Each FE only once — add up its Amount instead.'
        : rows.some((r) => !whole(r.amount, 1)) ? 'Amount must be a whole number, 1 or more.'
          : undefined

  const heading = 'text-[11px] font-medium text-gray-500 block mb-1'
  const small = 'text-[10px] text-gray-400 block mb-0.5'
  const field = 'h-8 text-sm rounded-lg border-gray-200 bg-white [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden'
  const select = 'h-8 w-full text-sm rounded-lg border border-gray-200 bg-white px-2'

  return (
    <div className="rounded-xl border border-pink-200 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-pink-50 border-b border-pink-100">
        <span className="flex items-center gap-1.5 text-xs font-bold text-gray-800">
          <span className="h-2 w-2 rounded-full bg-pink-500" />
          Assembly
        </span>
      </div>

      <div className="p-2.5 space-y-3 bg-white">
        <div>
          <label className={heading}>Assembly type</label>
          <select value={assembly.table} onChange={(e) => set({ table: e.target.value as AssemblyTableKind })} className={select}>
            {ASSEMBLY_TABLE_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </div>

        {/* Assembly needs: every line coming in — its No. (you set it; Main
            MU from predecessor points at one) and how many of its parts make
            one assembly. The Assembly holds that many of each while it
            waits for the rest. Applied as you type, like the rest. Not for
            type None: it takes 1 part from each line (numbered in the order connected). */}
        {assembly.table === 'predecessors' && (() => {
          // Each line's No. starts as the order it was connected (1 = the
          // first line, P1); a No. changed in its box is kept as set.
          const saved = assembly.needs ?? []
          const numbers = typedNumbers(assembly, incoming)
          const needRows = incoming.map((from) => ({ from, no: numbers[from], amount: saved.find((x) => x.from === from)?.amount ?? 1 }))
          // Only a No. you typed is saved — the others keep following the
          // connection order.
          const setNeed = (from: string, patch: { no?: number; amount?: number }) => set({
            needs: incoming.map((f) => {
              const s = saved.find((x) => x.from === f)
              const p = f === from ? patch : {}
              const no = 'no' in p ? p.no : s?.no
              return { from: f, ...(no !== undefined ? { no } : {}), amount: p.amount ?? s?.amount ?? 1 }
            }),
          })
          const mainNo = assembly.mainMuDefault ? 1 : assembly.mainMuFromPredecessor
          const needProblem = needsProblem(assembly, incoming)
          // Every line, with its amount; the main line (Main FE from
          // predecessor) is the one whose route the output follows.
          return (
            <div>
              <label className={heading}>Assembly needs</label>
              <p className="text-[10px] text-gray-400 mb-1.5">Lines are numbered in the order you connected them (P1, P2, ...) — change a No. if needed.</p>
              {needRows.length === 0 ? (
                <p className="text-[10px] text-gray-400">Connect the lines coming into this Assembly to list them here.</p>
              ) : (
                <div className="space-y-1.5">
                  {needRows.map((r) => {
                    const isMain = r.no === mainNo
                    return (
                      <div
                        key={r.from}
                        className={`rounded-lg border px-2.5 py-2 ${isMain ? 'border-pink-200 bg-pink-50/50' : 'border-gray-200 bg-gray-50/60'}`}
                      >
                        <div className="flex items-center gap-2">
                          <span className={`shrink-0 h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold ${isMain ? 'bg-pink-500 text-white' : 'bg-gray-200 text-gray-600'}`}>
                            {r.no}
                          </span>
                          <span className="min-w-0 flex-1 text-xs font-semibold text-gray-700 break-words">{r.from}</span>
                          {isMain && (
                            <span className="shrink-0 rounded-full bg-pink-100 px-1.5 py-0.5 text-[9px] font-semibold text-pink-600">Main</span>
                          )}
                        </div>
                        <div className="mt-1.5 grid grid-cols-2 gap-2">
                          <label className="min-w-0 block">
                            <span className="text-[10px] text-gray-500 block mb-0.5">No.</span>
                            <NumericField
                              value={r.no}
                              onCommit={(n) => setNeed(r.from, { no: n })}
                              className={`${field} h-7 w-full min-w-0 px-1 text-center`}
                            />
                          </label>
                          <label className="min-w-0 block">
                            <span className="text-[10px] text-gray-500 block mb-0.5">Amount</span>
                            <NumericField
                              value={r.amount}
                              onCommit={(n) => setNeed(r.from, { amount: n })}
                              className={`${field} h-7 w-full min-w-0 px-1 text-center`}
                            />
                          </label>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
              {needProblem && <p className="text-[10px] text-red-600 mt-1">{needProblem}</p>}
            </div>
          )
        })()}

        {/* FE table: which FEs (products) and how many of each make one
            assembly. Applied as you choose, like the rest. */}
        {hasRows && (
          <div>
            <label className={heading}>FE table</label>
            <div className="space-y-1.5">
              {rows.map((r, i) => (
                <div key={i} className="rounded-lg border border-gray-200 bg-gray-50/60 px-2.5 py-2">
                  <label className="block">
                    <span className="text-[10px] text-gray-500 block mb-0.5">FE Name</span>
                    <select
                      value={r.mu ?? ''}
                      onChange={(e) => update(i, { mu: e.target.value })}
                      className="h-8 w-full text-sm text-gray-900 rounded-lg border border-gray-300 bg-white px-2 shadow-sm"
                    >
                      <option value="">Choose…</option>
                      {Array.from(new Set([...products.filter((p) => !mainParts.includes(p)), ...(r.mu ? [r.mu] : [])])).map((p) => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                  </label>
                  <div className="mt-1.5 flex items-end justify-between gap-2">
                    <label className="block">
                      <span className="text-[10px] text-gray-500 block mb-0.5">Amount</span>
                      <NumericField
                        value={r.amount}
                        onCommit={(n) => update(i, { amount: n })}
                        className={`${field} w-20 px-1 text-center`}
                      />
                    </label>
                    <button
                      onClick={() => setRows(rows.filter((_, ri) => ri !== i))}
                      className="mb-2 text-gray-300 hover:text-red-500 transition-colors"
                      aria-label="Delete row"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
              {rows.length === 0 && <p className="text-[10px] text-gray-400">No FEs yet — add one below.</p>}
            </div>
            <button
              type="button"
              onClick={() => setRows([...rows, { mu: '', amount: 1 }])}
              className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700"
            >
              <Plus className="h-3.5 w-3.5" /> Add row
            </button>
            {problem && <p className="text-[10px] text-amber-600 mt-1">{problem}</p>}
          </div>
        )}

        {/* Default = predecessor 1; switch it off to choose another. */}
        <div>
          <label className={heading}>Main FE from predecessor</label>
          <div className="flex items-center justify-between gap-2">
            <div className="w-14 shrink-0">
              <NumericField
                value={assembly.mainMuDefault ? 1 : assembly.mainMuFromPredecessor}
                disabled={assembly.mainMuDefault}
                onCommit={(n) => set({ mainMuFromPredecessor: n })}
                className={`${field} w-full px-1 text-center disabled:bg-gray-100 disabled:text-gray-400 disabled:opacity-100`}
              />
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={!!assembly.mainMuDefault}
              onClick={() => set(assembly.mainMuDefault ? { mainMuDefault: false } : { mainMuDefault: true, mainMuFromPredecessor: 1 })}
              className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-gray-600"
            >
              <span className={`relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors ${assembly.mainMuDefault ? 'bg-blue-600' : 'bg-gray-300'}`}>
                <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform ${assembly.mainMuDefault ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
              </span>
              Default
            </button>
          </div>
          {!mainMuValid && (
            <p className="text-[10px] text-amber-600 mt-1">Must be a whole number, 1 or more.</p>
          )}
        </div>

        {/* Assembly mode: the parts are deleted, or all attached to the main part. */}
        <div className="flex flex-col rounded-lg border border-gray-200 overflow-hidden divide-y divide-gray-200">
          {([['delete_mus', 'Delete entity'], ['attach_mus', 'Attach all parts']] as const).map(([value, text]) => (
            <button
              key={value}
              type="button"
              onClick={() => set({ mode: value })}
              className={`h-8 text-xs font-semibold transition-all ${assembly.mode === value
                ? 'bg-ls-dark text-ls-card'
                : 'text-gray-500 hover:bg-gray-50'}`}
            >
              {text}
            </button>
          ))}
        </div>

        {/* Main FE: the main part continues. New FE: a new product, made
            from the attached parts, continues. */}
        <div>
          <label className={heading}>Assembled FE</label>
          <select value={assembly.exitingMu} onChange={(e) => set({ exitingMu: e.target.value as AssemblyConfig['exitingMu'] })} className={select}>
            <option value="main_mu">Main FE</option>
            <option value="new_fe">New FE</option>
          </select>
          {assembly.exitingMu === 'new_fe' && (
            <div className="mt-2">
              <label className={small}>New FE name</label>
              <Input
                value={assembly.newFeName ?? ''}
                onChange={(e) => set({ newFeName: e.target.value })}
                placeholder="e.g. Car"
                className={field}
              />
            </div>
          )}
          {assemblyProblem(assembly, incoming.length) && (
            <p className="text-[10px] text-red-600 mt-1.5">{assemblyProblem(assembly, incoming.length)}</p>
          )}
        </div>
      </div>
    </div>
  )
}

// Dismantle station settings — Tecnomatix's DismantleStation Attributes tab,
// shown in the station panel; each change applies at once. The simulation
// uses Sequence (FEs to all Successors: one piece per next station; Dismantle
// input configuration: the Dismantle table) and Exiting FE (Main FE: every
// piece keeps the part's name; New FE: the New FE name). Dismantle Mode and
// Main FE to Successor (the main line) make no difference yet.
const DEFAULT_DISMANTLE: DismantleConfig = {
  sequence: 'all_successors', mode: 'create_fe', mainFeToSuccessor: 1, exitingFe: 'new_fe',
}

// FEs to all Successors with Create FE: Exiting FE is New FE only (Main FE
// isn't offered). One saved with Main FE before keeps it until changed.
const dismantleNoMainFe = (d: DismantleConfig) => d.sequence === 'all_successors' && d.mode === 'create_fe'

// Why these Dismantle settings can't be used, or undefined (shown in the
// panel; blocks Save). FEs to all Successors + Create FE + New FE: Main FE to
// Successor is the line that keeps the part's name, so it can't be more than
// the lines going out.
function dismantleProblem(d: DismantleConfig, outgoingLines: number): string | undefined {
  if (!dismantleNoMainFe(d) || d.exitingFe !== 'new_fe' || outgoingLines === 0) return undefined
  const n = d.mainFeToSuccessor
  if (Number.isInteger(n) && n >= 1 && n > outgoingLines) {
    return `Main FE to Successor is ${n}, but only ${outgoingLines} line${outgoingLines === 1 ? '' : 's'} go out.`
  }
  return undefined
}

/**
 * The boxes and arrows Build draws for a scenario's product: the saved drawing
 * exactly as it was left — or, for a scenario not saved from the Canvas since
 * drawings were kept (or imported), every product's route drawn as one
 * picture. Build loads it onto the canvas and the 3D view builds its scene
 * from it, so both always show the same thing.
 */
function loadScenarioGraph(
  scenario: { processflow_data: Record<string, FlowStep[]>; stations_data: Record<string, StationConfig>; canvas_layout?: CanvasLayout | null },
  variant: string,
): { nodes: Node<StationNodeData>[]; edges: Edge[] } {
  const { nodes: drawnNodes, edges: finalEdges } = scenario.canvas_layout?.boxes?.length
    ? graphFromLayout(scenario.canvas_layout, scenario.processflow_data, scenario.stations_data)
    : wholeScenarioGraph(scenario.processflow_data, scenario.stations_data)
  // Each box shows the picked product's time at it.
  const shownTime: Record<string, number> = {}
  for (const st of scenario.processflow_data[variant] ?? []) {
    for (const r of stepResourceOptions(st.resource)) shownTime[r] = st.duration
  }
  // The Start isn't a route step, so it is drawn fresh — give it back its
  // saved MU table and Exit Controller.
  const nodes = drawnNodes.map((drawn) => {
    const time = shownTime[drawn.data.savedName ?? drawn.data.label]
    const n = time !== undefined ? { ...drawn, data: { ...drawn.data, processTime: time } } : drawn
    if (inferStationType(n.data.label, n.data.stationType) !== 'Source') return n
    const cfg = scenario.stations_data?.[n.data.label]
    if (!cfg) return n
    return {
      ...n,
      data: {
        ...n.data,
        ...(cfg['MU Table'] ? { muTable: cfg['MU Table'] } : {}),
        ...(cfg['MU Strategy'] ? { muStrategy: cfg['MU Strategy'] } : {}),
        ...(cfg['MU Priorities'] ? { muPriorities: cfg['MU Priorities'] } : {}),
        ...(cfg['MU Percentages'] ? { muPercentages: cfg['MU Percentages'] } : {}),
      },
    }
  })
  // Reconstructed/imported edges carry no handle info of their own —
  // normalized the same way onConnect normalizes new edges, so a reload
  // renders the same clean right-to-left flow instead of React Flow
  // picking default (possibly backward-looking) anchor points.
  return { nodes, edges: finalEdges.map((e) => ({ ...e, sourceHandle: 'right', targetHandle: 'left' })) }
}

function dismantleSettings(saved?: DismantleConfig): DismantleConfig {
  return { ...DEFAULT_DISMANTLE, ...saved }
}

// The Dismantle table's rows: one per line going out, as saved or (a new
// line) Number 1, Successor = its line's number.
function dismantleRows(dismantle: DismantleConfig, outgoing: string[]): DismantleRow[] {
  return outgoing.map((to, i) =>
    dismantle.table?.find((r) => r.to === to) ?? { to, number: 1, successor: i + 1 })
}

function DismantlePanel({ dismantle, outgoing, onChange }: {
  dismantle: DismantleConfig
  // The stations its lines go to, in the order connected (successor 1, 2, ...).
  outgoing: string[]
  onChange: (dismantle: DismantleConfig) => void
}) {
  const set = (patch: Partial<DismantleConfig>) => onChange({ ...dismantle, ...patch })
  // Choosing a Sequence / Dismantle Mode that has no Main FE moves Exiting FE
  // to New FE.
  const setFlow = (patch: Partial<DismantleConfig>) => {
    const next = { ...dismantle, ...patch }
    onChange(dismantleNoMainFe(next) && next.exitingFe === 'main_fe' ? { ...next, exitingFe: 'new_fe' } : next)
  }
  const offerMainFe = !dismantleNoMainFe(dismantle) || dismantle.exitingFe === 'main_fe'
  const successorValid = Number.isInteger(dismantle.mainFeToSuccessor) && dismantle.mainFeToSuccessor >= 1
  const whole = (n: number, min: number) => Number.isInteger(n) && n >= min

  const tableRows = dismantleRows(dismantle, outgoing)
  const setRow = (to: string, patch: Partial<DismantleRow>) =>
    set({ table: tableRows.map((r) => (r.to === to ? { ...r, ...patch } : r)) })
  const tableProblem =
    tableRows.some((r) => !whole(r.number, 1)) ? 'Number must be a whole number, 1 or more.'
        : tableRows.some((r) => !whole(r.successor, 1) || r.successor > outgoing.length)
          ? `Successor must be from 1 to ${outgoing.length}.`
          : undefined

  const heading = 'text-[11px] font-medium text-gray-500 block mb-1'
  const small = 'text-[10px] text-gray-400 block mb-0.5'
  const field = 'h-8 text-sm rounded-lg border-gray-200 bg-white [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden'
  const select = 'h-8 w-full text-sm rounded-lg border border-gray-200 bg-white px-2'

  return (
    <div className="rounded-xl border border-lime-200 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-lime-50 border-b border-lime-100">
        <span className="flex items-center gap-1.5 text-xs font-bold text-gray-800">
          <span className="h-2 w-2 rounded-full bg-lime-600" />
          Dismantle
        </span>
      </div>

      <div className="p-2.5 space-y-3 bg-white">
        <div>
          <label className={heading}>Sequence</label>
          <select value={dismantle.sequence} onChange={(e) => setFlow({ sequence: e.target.value as DismantleConfig['sequence'] })} className={select}>
            <option value="all_successors">FEs to all Successors</option>
            <option value="input_config">Dismantle input configuration</option>
          </select>
        </div>

        {/* Dismantle table: one row per line out — how many pieces go
            there, and its Successor: the order the pieces leave in (1
            first). Their name comes from Exiting FE, as with FEs to all
            Successors. */}
        {dismantle.sequence === 'input_config' && (
          <div>
            <label className={heading}>Dismantle table</label>
            {tableRows.length === 0 ? (
              <p className="text-[10px] text-gray-400">Connect the lines leaving this Dismantle to list them here.</p>
            ) : (
              <div className="space-y-1.5">
                {tableRows.map((r, i) => (
                  <div key={r.to} className="rounded-lg border border-gray-200 bg-gray-50/60 px-2.5 py-2">
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold bg-gray-200 text-gray-600">
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1 text-xs font-semibold text-gray-700 break-words">{r.to}</span>
                    </div>
                    <div className="mt-1.5 grid grid-cols-2 gap-2">
                      <label className="min-w-0 block">
                        <span className="text-[10px] text-gray-500 block mb-0.5">Number</span>
                        <NumericField
                          value={r.number}
                          onCommit={(n) => setRow(r.to, { number: n })}
                          className={`${field} h-7 w-full min-w-0 px-1 text-center`}
                        />
                      </label>
                      <label className="min-w-0 block">
                        <span className="text-[10px] text-gray-500 block mb-0.5">Successor</span>
                        <NumericField
                          value={r.successor}
                          onCommit={(n) => setRow(r.to, { successor: n })}
                          className={`${field} h-7 w-full min-w-0 px-1 text-center`}
                        />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {tableProblem && <p className="text-[10px] text-red-600 mt-1">{tableProblem}</p>}
          </div>
        )}

        <div>
          <label className={heading}>Dismantle Mode</label>
          <select value={dismantle.mode} onChange={(e) => setFlow({ mode: e.target.value as DismantleConfig['mode'] })} className={select}>
            <option value="create_fe">Create FE</option>
            <option value="detach_fe">Detach FE</option>
          </select>
        </div>

        <div>
          <label className={heading}>Main FE to Successor</label>
          <div className="w-14">
            <NumericField
              value={dismantle.mainFeToSuccessor}
              onCommit={(n) => set({ mainFeToSuccessor: n })}
              className={`${field} w-full px-1 text-center`}
            />
          </div>
          {!successorValid && (
            <p className="text-[10px] text-red-600 mt-1">Must be a whole number, 1 or more.</p>
          )}
          {dismantleProblem(dismantle, outgoing.length) && (
            <p className="text-[10px] text-red-600 mt-1">{dismantleProblem(dismantle, outgoing.length)}</p>
          )}
        </div>

        {/* Main FE: every piece keeps the part's name. New FE: every piece
            gets the New FE name (empty: the part's name + A). */}
        <div>
          <label className={heading}>Exiting FE</label>
          <select value={dismantle.exitingFe} onChange={(e) => set({ exitingFe: e.target.value as DismantleConfig['exitingFe'] })} className={select}>
            {offerMainFe && <option value="main_fe">Main FE</option>}
            <option value="new_fe">New FE</option>
          </select>
          {dismantle.exitingFe === 'new_fe' && (
            <div className="mt-2">
              <label className={small}>New FE name</label>
              <Input
                value={dismantle.newFeName ?? ''}
                onChange={(e) => set({ newFeName: e.target.value })}
                placeholder="e.g. Body"
                className={field}
              />
              <p className="text-[10px] text-gray-400 mt-1">
                Every piece gets this name. Empty: the part’s name + A.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// The Routes panel (right side): one row per station, one column per
// product — tick the stations each product goes through (the order comes
// from the drawing). Apply gives the products their lines; Cancel closes.
function RoutesPanel({ products, stations, colors, initial, problemsOf, onApply, onClose }: {
  products: string[]
  stations: string[]
  colors: Record<string, string>
  initial: Record<string, string[]>
  problemsOf: (ticks: Record<string, string[]>) => string[]
  onApply: (ticks: Record<string, string[]>) => void
  onClose: () => void
}) {
  const [ticks, setTicks] = useState<Record<string, string[]>>(initial)
  const toggle = (p: string, st: string) => setTicks((t) => {
    const now = t[p] ?? []
    return { ...t, [p]: now.includes(st) ? now.filter((x) => x !== st) : [...now, st] }
  })
  const problems = problemsOf(ticks)
  const changed = JSON.stringify(ticks) !== JSON.stringify(initial)

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 bg-blue-50 border-b border-blue-100">
        <span className="text-xs font-bold text-gray-800">Routes</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="p-3 space-y-3">
        <p className="text-[10px] text-gray-400">Tick the stations each product goes through — the order comes from the drawing.</p>
        <div className="rounded-lg border border-gray-200 max-h-[45vh] overflow-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-gray-500">
                <th className="px-2 py-1.5 text-left text-[10px] font-semibold">Station</th>
                {products.map((p) => (
                  <th key={p} className="px-1 py-1.5 text-center text-[10px] font-semibold">
                    <span className="inline-flex items-center gap-1">
                      <span className="h-2 w-2 rounded-full" style={{ background: colors[p] || '#9ca3af' }} />
                      {p}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stations.map((st) => (
                <tr key={st} className="border-b border-gray-100 last:border-0">
                  <td className="px-2 py-1.5 text-gray-700 break-words">{st}</td>
                  {products.map((p) => (
                    <td key={p} className="px-1 py-1.5 text-center">
                      <input
                        type="checkbox"
                        checked={(ticks[p] ?? []).includes(st)}
                        onChange={() => toggle(p, st)}
                        className="h-3.5 w-3.5 cursor-pointer"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {problems.length > 0 && (
          <div className="space-y-1">
            {problems.map((msg) => <p key={msg} className="text-[10px] text-amber-600">{msg}</p>)}
          </div>
        )}
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="flex-1" disabled={problems.length > 0 || !changed} onClick={() => { onApply(ticks); onClose() }}>
            Apply
          </Button>
        </div>
      </div>
    </div>
  )
}

// Start's MU table (Tecnomatix style): one row per product the Start
// creates — MU (the product), Number (how many), Name (a display name),
// Interval (minutes between its jobs), Colour (its jobs on the Canvas).
// Apply saves it to the scenario at
// once (see applyMuTable): a new row copies an existing product's route, a
// deleted row (after a confirmation) takes its route with it, a renamed MU
// renames the product everywhere.
function MuTableDialog({ startName, starts, initial, onApply, onClose }: {
  startName: string
  // Every Start on the Canvas (station names); the first is the one a new
  // row is released from when opened from it.
  starts: string[]
  initial: MuDialogRow[]
  onApply: (rows: MuDialogRow[]) => Promise<void> | void
  onClose: () => void
}) {
  const [rows, setRows] = useState<MuDialogRow[]>(initial)
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const update = (i: number, patch: Partial<MuDialogRow>) =>
    setRows((rs) => rs.map((r, ri) => (ri === i ? { ...r, ...patch } : r)))
  // Products a new row can copy its route from — as named in the table now.
  const existing = rows.filter((r) => r.orig !== undefined)

  const names = rows.map((r) => r.mu.trim())
  const problem =
    names.some((n) => !n) ? 'Every row needs an MU (product) name.'
      : new Set(names).size !== names.length ? 'Two rows have the same MU — each product needs its own name.'
        : rows.some((r) => !Number.isInteger(r.number) || r.number < 0) ? 'Number must be a whole number, 0 or more.'
          : rows.some((r) => r.interval != null && (!Number.isFinite(r.interval) || r.interval < 0)) ? 'Interval must be 0 or more (empty = all jobs at once).'
            // Only when there is a product to copy from (a new canvas has none).
            : existing.length > 0 && rows.some((r) => r.orig === undefined && !r.copyFrom) ? 'Pick which product a new row copies its route from.'
              : undefined
  // Two products with one colour is allowed, just hard to tell apart.
  const colors = rows.map((r) => (r.color ?? '').toLowerCase())
  const sameColor = rows.find((r, i) => r.color && colors.indexOf(colors[i]) !== i)
  const sameColorAs = sameColor ? rows[colors.indexOf((sameColor.color ?? '').toLowerCase())] : undefined

  const apply = async () => {
    setSaving(true)
    try {
      await onApply(rows.map((r) => ({ ...r, mu: r.mu.trim(), name: r.name.trim() })))
      onClose()
    } catch {
      // Not saved (the error was already shown) — stay open to retry.
    } finally {
      setSaving(false)
    }
  }

  const head = 'px-2 py-1.5 text-[10px] font-bold uppercase tracking-widest text-left whitespace-nowrap'
  const cellInput = 'h-8 text-sm rounded-md border-gray-200 bg-gray-50 focus:bg-white'
  const deleting = confirmDelete !== null ? rows[confirmDelete] : null
  const manyStarts = starts.length > 1

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative bg-white rounded-2xl shadow-2xl ${manyStarts ? 'w-[900px]' : 'w-[760px]'} max-h-[80vh] flex flex-col overflow-hidden`}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-indigo-50">
          <div>
            <h2 className="text-sm font-bold text-gray-900">MU</h2>
            <p className="text-xs text-gray-400 mt-0.5">{startName}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Table */}
        <div className="p-5 overflow-auto">
          <table className="w-full text-sm border border-gray-200 rounded-lg">
            <thead>
              {/* Column data types, as in Tecnomatix */}
              <tr className="bg-gray-50 text-gray-400 border-b border-gray-200">
                <th className={`${head} w-12`}></th>
                <th className={head}>object <span className="text-gray-300">1</span></th>
                <th className={head}>integer <span className="text-gray-300">2</span></th>
                <th className={head}>string <span className="text-gray-300">3</span></th>
                <th className={head}>time <span className="text-gray-300">4</span></th>
                <th className={head}>color <span className="text-gray-300">5</span></th>
                {manyStarts && <th className={head}>object <span className="text-gray-300">6</span></th>}
                <th className="w-8"></th>
              </tr>
              <tr className="bg-blue-50/60 text-gray-700 border-b border-gray-200">
                <th className={`${head} text-gray-400`}>string</th>
                <th className={head}>MU</th>
                <th className={head}>Number</th>
                <th className={head}>Name</th>
                <th className={head}>Interval (min)</th>
                <th className={head}>Colour</th>
                {manyStarts && <th className={head}>Released from</th>}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-gray-100 last:border-0 align-top">
                  <td className="px-2 py-2.5 text-xs font-semibold text-gray-400">{i + 1}</td>
                  <td className="px-2 py-1">
                    <Input
                      value={r.mu}
                      onChange={(e) => update(i, { mu: e.target.value })}
                      placeholder="Product"
                      className={cellInput}
                    />
                    {/* A new product starts with a copy of an existing route (none to copy: hidden). */}
                    {r.orig === undefined && existing.length > 0 && (
                      <select
                        value={r.copyFrom ?? ''}
                        onChange={(e) => update(i, { copyFrom: e.target.value || undefined })}
                        className="mt-1 w-full h-7 text-[11px] text-gray-700 bg-white border border-gray-200 rounded-md px-1.5"
                      >
                        <option value="">Copy route from…</option>
                        {existing.map((x) => (
                          <option key={x.orig} value={x.orig}>Copy route from {x.mu.trim() || x.orig}</option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="px-2 py-1">
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      value={Number.isFinite(r.number) ? r.number : ''}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => update(i, { number: e.target.value === '' ? NaN : Number(e.target.value) })}
                      className={`${cellInput} w-24`}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <Input
                      value={r.name}
                      onChange={(e) => update(i, { name: e.target.value })}
                      placeholder="Display name"
                      className={cellInput}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <Input
                      type="number"
                      min={0}
                      value={r.interval != null && Number.isFinite(r.interval) ? r.interval : ''}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => update(i, { interval: e.target.value === '' ? null : Number(e.target.value) })}
                      placeholder="—"
                      className={`${cellInput} w-24`}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      type="color"
                      value={r.color ?? '#3b82f6'}
                      onChange={(e) => update(i, { color: e.target.value })}
                      title="Pick this product's colour"
                      className="h-8 w-12 cursor-pointer rounded-md border border-gray-200 bg-gray-50 p-0.5"
                    />
                  </td>
                  {manyStarts && (
                    <td className="px-2 py-1">
                      <select
                        value={r.start ?? starts[0]}
                        onChange={(e) => update(i, { start: e.target.value })}
                        className="h-8 w-full text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-md px-1.5"
                      >
                        {starts.map((st) => <option key={st} value={st}>{st}</option>)}
                      </select>
                    </td>
                  )}
                  <td className="px-1 py-2">
                    <button
                      onClick={() => (r.orig === undefined
                        ? setRows((rs) => rs.filter((_, ri) => ri !== i))
                        : setConfirmDelete(i))}
                      className="text-gray-300 hover:text-red-500 transition-colors"
                      aria-label="Delete row"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={manyStarts ? 8 : 7} className="py-6 text-center text-gray-400 text-xs">No products yet — add a row below.</td>
                </tr>
              )}
            </tbody>
          </table>
          <button
            onClick={() => setRows((rs) => [...rs, {
              mu: '', number: 0, name: '', interval: null, copyFrom: rs.find((x) => x.orig !== undefined)?.orig,
              color: unusedVariantColor(rs.map((x) => x.color ?? ''), rs.length),
              // Released from the Start the table was opened from.
              start: startName,
            }])}
            className="mt-3 flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700"
          >
            <Plus className="h-3.5 w-3.5" /> Add row
          </button>
          {problem && (
            <p className="text-[10px] text-amber-600 mt-2">{problem}</p>
          )}
          {sameColor && sameColorAs && (
            <p className="text-[10px] text-amber-600 mt-2">
              {sameColorAs.mu || 'A row'} and {sameColor.mu || 'another row'} have the same colour — their jobs will look alike.
            </p>
          )}
        </div>

        {/* Buttons */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-100">
          <Button size="sm" variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="outline" disabled={!!problem || saving} onClick={apply}>
            {saving ? 'Saving…' : 'Apply'}
          </Button>
        </div>

        {/* Deleting a product also deletes its route — ask first. */}
        {deleting && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/70">
            <div className="bg-white rounded-xl shadow-xl border border-gray-100 w-[340px] p-5">
              <p className="text-sm text-gray-800">
                Delete <span className="font-semibold">{deleting.orig}</span> and its route?
              </p>
              <p className="text-xs text-gray-400 mt-1">
                Its quantity, interval and its route through the stations are removed when you click Apply.
              </p>
              <div className="flex justify-end gap-2 mt-4">
                <Button size="sm" variant="outline" onClick={() => setConfirmDelete(null)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="bg-red-600 hover:bg-red-700"
                  onClick={() => {
                    setRows((rs) => rs
                      .filter((_, ri) => ri !== confirmDelete)
                      .map((x) => (x.copyFrom === deleting.orig ? { ...x, copyFrom: undefined } : x)))
                    setConfirmDelete(null)
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

// What Save would write from the canvas — compared to tell unsaved changes.
function canvasSignatureOf(nodes: Node<StationNodeData>[], edges: Edge[]): string {
  return JSON.stringify({
    n: nodes.map((n) => [n.id, n.data, Math.round(n.position.x), Math.round(n.position.y)]),
    e: edges.map((e) => [e.source, e.target, edgeProducts(e) ?? null]),
  })
}

// Asked before Delete removes the selected stations / lines from the Canvas.
function ConfirmDeleteDialog({ stations, lines, onDelete, onClose }: {
  stations: number
  lines: number
  onDelete: () => void
  onClose: () => void
}) {
  const what = [
    stations > 0 ? `${stations} station${stations > 1 ? 's' : ''}` : '',
    lines > 0 ? `${lines} connection${lines > 1 ? 's' : ''}` : '',
  ].filter(Boolean).join(' and ')
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-[380px] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-indigo-50">
          <h2 className="text-sm font-bold text-gray-900">Delete</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 text-sm text-gray-700">
          Are you sure you want to delete <span className="font-semibold">{what}</span>?
          {stations > 0 && (
            <p className="text-xs text-gray-400 mt-1">Their connections are removed too.</p>
          )}
        </div>

        {/* Buttons */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-100">
          <Button size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" className="bg-red-600 hover:bg-red-700" onClick={onDelete} autoFocus>
            Delete
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// Asked when switching product in Build with unsaved changes on the Canvas.
function SwitchProductDialog({ from, to, saving, onSave, onDiscard, onClose }: {
  from: string
  to: string
  saving: boolean
  onSave: () => void
  onDiscard: () => void
  onClose: () => void
}) {
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-[380px] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-indigo-50">
          <div>
            <h2 className="text-sm font-bold text-gray-900">Unsaved changes</h2>
            <p className="text-xs text-gray-400 mt-0.5">{from}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 text-sm text-gray-700">
          Save changes to <span className="font-semibold">{from}</span> before opening <span className="font-semibold">{to}</span>?
        </div>

        {/* Buttons */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-100">
          <Button size="sm" disabled={saving} onClick={onSave}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button size="sm" variant="outline" disabled={saving} onClick={onDiscard}>
            Discard
          </Button>
          <Button size="sm" variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** Strip a trailing " #N" suffix used to label parallel-machine boxes, e.g. "Stitching #2" -> "Stitching" */
function baseStationName(label: string): string {
  return label.replace(/\s+#\d+$/, '')
}

/** The station a box is saved as. A machine of a parallel group is a station
 *  of its own, named exactly like its box; otherwise "Name #2" boxes are
 *  machines of one station "Name" (boxes drawn before groups existed). */
function stationKey(n: Node<StationNodeData>): string {
  return n.data.parallelGroup ? n.data.label : baseStationName(n.data.label)
}

/** What a box counts as for routing: its parallel group (all its machines
 *  are one stop), or its station. */
function groupKey(n: Node<StationNodeData>): string {
  return n.data.parallelGroup ?? baseStationName(n.data.label)
}

// Distinct next boxes of a station (full label, so each parallel machine
// "Station 2 #1", "#2", ... counts as its own path). Workplace/Worker/Worker
// Controller edges are pool wiring, not a job's next step.
function exitSuccessorLabels(nodeId: string, nodes: Node<StationNodeData>[], edges: Edge[]): string[] {
  return Array.from(new Set(
    edges
      .filter((e) => e.source === nodeId)
      .map((e) => nodes.find((n) => n.id === e.target))
      .filter((n): n is Node<StationNodeData> => !!n)
      .filter((n) => {
        const t = inferStationType(n.data.label, n.data.stationType)
        return t !== 'Workplace' && t !== 'Worker' && t !== 'Worker Controller'
      })
      .map((n) => n.data.label)
  ))
}

// A split: a station connected to 2+ DIFFERENT next stations (Station 2,
// Station 3, ... — parallel copies of one station don't count on their own).
// Each job goes to only one of them, picked by the station's Exit
// Controller. Supported for now: every path is one station, and all paths
// meet again at the same next station (or all end). `problem` explains a
// shape that isn't supported yet.
interface CanvasSplit {
  sourceId: string
  sourceLabel: string
  bases: string[]
  problem?: string
}

function canvasSplits(nodes: Node<StationNodeData>[], edges: Edge[]): CanvasSplit[] {
  const typeOf = (n: Node<StationNodeData>) => inferStationType(n.data.label, n.data.stationType)
  const isWiring = (n: Node<StationNodeData>) => ['Worker', 'Worker Controller', 'Workplace'].includes(typeOf(n))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const nextOf = (id: string) => edges
    .filter((e) => e.source === id)
    .map((e) => byId.get(e.target))
    .filter((n): n is Node<StationNodeData> => !!n && !isWiring(n))
  const prevOf = (id: string) => edges
    .filter((e) => e.target === id)
    .map((e) => byId.get(e.source))
    .filter((n): n is Node<StationNodeData> => !!n && !isWiring(n))
  const baseSet = (list: Node<StationNodeData>[]) => Array.from(new Set(list.map(groupKey)))

  const splits: CanvasSplit[] = []
  for (const n of nodes) {
    if (isWiring(n) || typeOf(n) === 'Drain') continue
    const bases = baseSet(nextOf(n.id).filter((d) => typeOf(d) !== 'Drain' && typeOf(d) !== 'Source'))
    if (bases.length < 2) continue
    const sourceBase = groupKey(n)
    const branchNodes = nodes.filter((b) => bases.includes(groupKey(b)))
    let problem: string | undefined
    const ends = new Set<string>()
    for (const b of branchNodes) {
      const t = typeOf(b)
      if (t === 'Buffer' || t === 'Connector') {
        problem = `${b.data.label}: a path must start with a station, not a ${t}.`
        break
      }
      const after = baseSet(nextOf(b.id))
      if (after.length > 1) {
        problem = `${b.data.label} splits again — a split inside a path isn't supported yet.`
        break
      }
      ends.add(after[0] ?? '')
      if (baseSet(prevOf(b.id)).some((p) => p !== sourceBase)) {
        problem = `${b.data.label} is also fed from another station — each path must come only from ${sourceBase}.`
        break
      }
    }
    if (!problem && ends.size > 1) {
      problem = 'Each path must be one station, and all paths must meet at the same next station.'
    }
    splits.push({ sourceId: n.id, sourceLabel: n.data.label, bases, problem })
  }
  return splits
}

// Why the parallel groups can't be saved as drawn, or undefined. Every box is
// saved as a station of its own name, so names must be unique; and a group's
// machines are one stop, so they must all be wired to the same stations.
function parallelGroupProblem(nodes: Node<StationNodeData>[], edges: Edge[]): string | undefined {
  const typeOf = (n: Node<StationNodeData>) => inferStationType(n.data.label, n.data.stationType)
  const isWiring = (n: Node<StationNodeData>) => ['Worker', 'Worker Controller', 'Workplace'].includes(typeOf(n))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const named = new Map<string, Node<StationNodeData>>()
  for (const n of nodes) {
    if (!n.data.parallelGroup) continue
    const other = named.get(n.data.label)
    if (other) return `Two boxes are named "${n.data.label}" — give each machine its own name.`
    named.set(n.data.label, n)
    const clash = nodes.find((o) => o !== n && !o.data.parallelGroup && stationKey(o) === n.data.label)
    if (clash) return `Two boxes are named "${n.data.label}" — give each machine its own name.`
  }
  const wiredTo = (n: Node<StationNodeData>, dir: 'next' | 'prev') => Array.from(new Set(edges
    .filter((e) => (dir === 'next' ? e.source : e.target) === n.id)
    .map((e) => byId.get(dir === 'next' ? e.target : e.source))
    .filter((o): o is Node<StationNodeData> => !!o && !isWiring(o))
    .map(groupKey))).sort().join('|')
  const groups = new Map<string, Node<StationNodeData>[]>()
  for (const n of nodes) if (n.data.parallelGroup) groups.set(n.data.parallelGroup, [...(groups.get(n.data.parallelGroup) ?? []), n])
  for (const [group, members] of groups) {
    if (members.length < 2) continue
    for (const dir of ['prev', 'next'] as const) {
      const odd = members.find((m) => wiredTo(m, dir) !== wiredTo(members[0], dir))
      if (odd) {
        return `${odd.data.label} and ${members[0].data.label} are machines of parallel group ${group}, so they must be connected to the same stations.`
      }
    }
  }
  return undefined
}

// Exit Controller "Successor" priorities, one per successor. Unset boxes
// show their position (1, 2, 3, ...) as the default order.
function exitPriorityValues(data: StationNodeData, successors: string[]): number[] {
  return successors.map((s, i) => data.exitPriorities?.[s] ?? i + 1)
}

// Valid = each of 1..N used exactly once.
function exitPrioritiesAreValid(priorities: number[]): boolean {
  return [...priorities].sort((a, b) => a - b).every((p, i) => p === i + 1)
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
  // One run state for the whole page: the Run button (top bar in Build) and the bottom bar share it.
  const sim = useRunSimulation()

  // Memoized so React Flow always sees the same object reference across renders/HMR —
  // an unstable nodeTypes reference makes React Flow re-init internally on every
  // render, which breaks node dragging (clicks fall through to the pane instead).
  const stableNodeTypes = useMemo(() => nodeTypes, [])

  // Mode: 'view' shows scenario flow; 'build' is free-canvas builder
  const [mode, setMode] = useState<'view' | 'build'>('build')
  const can3d = useLicenseFeatures().allows(FEATURE.view3d)
  useEffect(() => { if (!can3d) setMode('build') }, [can3d])

  // On a narrow window the side panel starts collapsed so the canvas keeps the room
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => typeof window !== 'undefined' && window.innerWidth < 900)
  const [paletteQuery, setPaletteQuery] = useState('')
  const [selectedVariant, setSelectedVariant] = useState<string>('')

  // Build mode state
  const [nodes, setNodes, onNodesChange] = useNodesState<StationNodeData>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  // The product (variant) picked on the Build canvas — the drawing is one
  // for the whole scenario; this product's lines are highlighted, new lines
  // are its, and Save writes its route (others keep theirs unless their
  // lines were changed).
  const [buildVariant, setBuildVariant] = useState<string | null>(null)
  // The product the last Save wrote (read once it succeeds).
  const savedVariantRef = useRef<string | null>(null)
  // The ids and line products the last Save gave the drawing.
  const savedDrawingRef = useRef<{ boxIdOf: Record<string, string>; productsOf: Record<string, string[] | undefined> } | null>(null)
  // Each product's lines (their shape) as last loaded/saved: Save keeps
  // another product's route as it is unless these were changed.
  const loadedLinesRef = useRef<Record<string, string>>({})
  // Each box's time as last loaded/saved (box id -> minutes).
  const loadedTimesRef = useRef<Record<string, number>>({})
  // Unsaved changes: the canvas as last loaded/saved, compared with now
  // (box positions included — they are saved).
  const canvasSignature = canvasSignatureOf(nodes, edges)
  const [savedSignature, setSavedSignature] = useState<string | null>(null)
  const canvasDirty = savedSignature === null ? nodes.length > 0 : savedSignature !== canvasSignature
  // Bumped to make Build reload the selected product's line.
  const [reloadTick, setReloadTick] = useState(0)
  // The Start box whose MU table pop-up is open.
  const [muDialogNodeId, setMuDialogNodeId] = useState<string | null>(null)
  // Product to open once the "unsaved changes" question is answered.
  const [switchTarget, setSwitchTarget] = useState<string | null>(null)
  // Worker/Worker Controller/Workplace wiring is a data relationship, not a
  // process-flow connection — hide those edges' lines on the canvas however
  // they were created (drag-drawn, or via a picker checkbox), so the
  // diagram only shows the actual production flow. The edges themselves
  // still exist in `edges` and are used exactly as before for save/pool
  // logic; only the rendered ReactFlow instance gets this filtered view.
  // The drawing is one for every product: with 2+ products, lines and boxes
  // the picked product doesn't use are faded.
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const fadeOthers = !!buildVariant && Object.keys(activeScenario?.processflow_data ?? {}).length > 1
  // Lines into an Assembly carry their number (P1, P2, ...) — next to a
  // label of your own, if the line has one.
  const assemblyLineNo = useMemo(() => {
    const out = new Map<string, number>()
    for (const n of nodes) {
      if (inferStationType(n.data.label, n.data.stationType) !== 'Assembly') continue
      const numbers = lineNumbers(assemblySettings(n.data.assembly), incomingStations(n.id, nodes, edges))
      for (const e of edges) {
        const src = e.target === n.id ? nodeById.get(e.source) : undefined
        if (src && !isWiringNode(src) && numbers[groupKey(src)] !== undefined) out.set(e.id, numbers[groupKey(src)])
      }
    }
    return out
  }, [nodes, edges, nodeById])
  const visibleEdges = useMemo(
    () =>
      edges.map((e) => {
        const src = nodeById.get(e.source)
        const dst = nodeById.get(e.target)
        if ((src && isWiringNode(src)) || (dst && isWiringNode(dst))) {
          return { ...e, style: { ...e.style, opacity: 0, pointerEvents: 'none' as const } }
        }
        const no = assemblyLineNo.get(e.id)
        const line = no === undefined ? e : { ...e, label: e.label ? `P${no} · ${e.label}` : `P${no}` }
        if (fadeOthers && !lineIsFor(e, buildVariant, buildVariant)) {
          return { ...line, style: { ...e.style, opacity: 0.15 } }
        }
        return line
      }),
    [edges, nodeById, fadeOthers, buildVariant, assemblyLineNo]
  )
  const visibleNodes = useMemo(() => {
    if (!fadeOthers) return nodes
    const flow = edges.filter((e) => isFlowEdge(e, nodeById))
    const used = new Set(flow.filter((e) => lineIsFor(e, buildVariant, buildVariant)).flatMap((e) => [e.source, e.target]))
    const wired = new Set(flow.flatMap((e) => [e.source, e.target]))
    return nodes.map((n) => (isWiringNode(n) || used.has(n.id) || !wired.has(n.id)
      ? n
      : { ...n, style: { ...n.style, opacity: 0.3 } }))
  }, [nodes, edges, nodeById, fadeOthers, buildVariant])
  // Routes table: the stations a product can be ticked for, left to right
  // (a parallel group is one column — a job goes to one of its machines).
  const [routesOpen, setRoutesOpen] = useState(false)
  const routeStations = useMemo(() => {
    const leftmost = new Map<string, number>()
    for (const n of nodes) {
      const t = inferStationType(n.data.label, n.data.stationType)
      if (t === 'Source' || t === 'Drain' || isWiringNode(n)) continue
      const key = groupKey(n)
      leftmost.set(key, Math.min(leftmost.get(key) ?? Infinity, n.position.x))
    }
    return Array.from(leftmost.entries()).sort((a, b) => a[1] - b[1]).map(([key]) => key)
  }, [nodes])
  // The picked product's lines (plus staffing wiring): what the station
  // panel and the Save checks look at.
  const productEdges = useMemo(
    () => edges.filter((e) => !isFlowEdge(e, nodeById) || lineIsFor(e, buildVariant, buildVariant)),
    [edges, nodeById, buildVariant]
  )
  const [selectedNode, setSelectedNode] = useState<Node<StationNodeData> | null>(null)
  // A line into an Assembly deleted: the No.s typed in its Assembly needs are
  // cleared, so its lines go back to the order connected (P1, P2, ...) — in
  // the panel, on Save and in the run. Amounts are kept. Seen by the lines
  // themselves (box ids), so renaming a station clears nothing; nor does
  // taking 1 machine of a parallel group off while the group's line stays.
  // Not when a drawing is opened (the loader clears the ref).
  const assemblyLinesRef = useRef<Map<string, Map<string, string>> | null>(null)
  useEffect(() => {
    // Each Assembly's lines in: source box id -> its station (groupKey).
    const now = new Map<string, Map<string, string>>()
    for (const n of nodes) {
      if (inferStationType(n.data.label, n.data.stationType) !== 'Assembly') continue
      const lines = new Map<string, string>()
      for (const e of edges) {
        const src = e.target === n.id ? nodes.find((x) => x.id === e.source) : undefined
        if (src && !isWiringNode(src)) lines.set(src.id, groupKey(src))
      }
      now.set(n.id, lines)
    }
    const before = assemblyLinesRef.current
    assemblyLinesRef.current = now
    if (!before) return
    const reset = new Map<string, AssemblyConfig>()
    for (const n of nodes) {
      const was = before.get(n.id)
      const is = now.get(n.id)
      const assembly = n.data.assembly
      if (!was || !is || !assembly?.needs?.some((x) => x.no !== undefined)) continue
      const stations = new Set(is.values())
      const deleted = Array.from(was.entries()).some(([id, station]) => !is.has(id) && !stations.has(station))
      if (!deleted) continue
      reset.set(n.id, { ...assembly, needs: assembly.needs.map(({ from, amount }) => ({ from, amount })) })
    }
    if (reset.size === 0) return
    setNodes((nds) => nds.map((n) => (reset.has(n.id) ? { ...n, data: { ...n.data, assembly: reset.get(n.id) } } : n)))
    setSelectedNode((p) => (p && reset.has(p.id) ? { ...p, data: { ...p.data, assembly: reset.get(p.id) } } : p))
  }, [nodes, edges, setNodes])
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
    const out: Record<string, {
      utilization: number; jobs: number
      bufferCapacity: number; bufferDiscipline: string
      bufferBlockedRatio: number; bufferBlockedTime: number
      rackLaneCount: number | null | undefined; rackOccupied: number | null | undefined
    }> = {}
    for (const s of (activeRun?.station_stats ?? [])) {
      out[s.station_name] = {
        utilization: s.station_utilization,
        jobs: s.completed_jobs,
        bufferCapacity: s.buffer_capacity,
        bufferDiscipline: s.buffer_discipline,
        bufferBlockedRatio: s.buffer_blocked_ratio,
        bufferBlockedTime: s.buffer_blocked_time,
        rackLaneCount: s.rack_lane_count,
        rackOccupied: s.rack_occupied,
      }
    }
    return out
  }, [activeRun])

  const { nodes: viewNodesBase } = useMemo(() => {
    if (!activeScenario || !selectedVariant) return { nodes: [], edges: [] }
    return buildFlowGraph(activeScenario.processflow_data, selectedVariant, stationStats, activeScenario.stations_data)
  }, [activeScenario, selectedVariant, stationStats])

  // Only the Entry/Exit endpoint nodes are draggable/clickable in View mode —
  // regular flow nodes stay locked since they reflect the real process flow,
  // not something a user should be able to rearrange. Dragged positions are
  // tracked separately so switching variants/re-deriving viewNodesBase doesn't
  // wipe them out unnecessarily (keyed by node id, reset when variant changes).
  const [endpointPositions, setEndpointPositions] = useState<Record<string, { x: number; y: number }>>({})
  // Regular station ("flow") nodes are still non-draggable, but they ARE
  // clickable — clicking one opens a right panel with that station's stats.

  useEffect(() => { setEndpointPositions({}) }, [selectedVariant])

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


  // Build-mode canvas instance — needed to convert a drag-and-drop's screen
  // (clientX/clientY) coordinates into flow-space coordinates, so a palette
  // item dropped on the canvas lands exactly under the cursor instead of at
  // an auto-computed "rightmost + offset" spot.
  const [buildFlowInstance, setBuildFlowInstance] = useState<ReactFlowInstance | null>(null)

  // 3D Scene data (View mode)
  const scene3D = useMemo(() => {
    if (!activeScenario || !selectedVariant) return { machines: [], operators: [], connections: [], stepLabels: [], props: [] }
    const { processflow, stations } = stressLine(activeScenario.processflow_data, activeScenario.stations_data, selectedVariant)
    // The same boxes and arrows Build draws.
    const graph = loadScenarioGraph({ ...activeScenario, processflow_data: processflow, stations_data: stations }, selectedVariant)
    return buildScene3D(
      graph.nodes,
      graph.edges,
      processflow,
      selectedVariant,
      stations,
      activeScenario.operators_data,
      activeRun?.station_stats ?? [],
      // A saved drawing is mirrored exactly; only an auto-laid-out one is wrapped.
      !activeScenario.canvas_layout?.boxes?.length,
    )
  }, [activeScenario, selectedVariant, activeRun])

  // Raw completion log passed straight through to the 3D Scene (it does its own
  // per-station filtering); the 2D view instead uses selectedFlowNodeJobs above,
  // which is already filtered to the clicked station.
  const completionLog = useMemo(() =>
    (activeRun?.result as Record<string, unknown> | null)?.completion_log as Record<string, unknown[]> | undefined,
    [activeRun]
  )
  // What each Assembly made in the run (simulation_state.assemblies): the 3D
  // replay needs it to show parts being used up.
  const assemblies3D = useMemo(() =>
    ((activeRun?.result as { simulation_state?: { assemblies?: Record<string, { station: string; main: string; mode: string; parts: string[] }> } } | null)
      ?.simulation_state?.assemblies),
    [activeRun]
  )
  // The same for Dismantles (simulation_state.dismantles): the pieces each
  // dismantled job split into.
  const dismantles3D = useMemo(() =>
    ((activeRun?.result as { simulation_state?: { dismantles?: Record<string, { station: string; mode: string; pieces: string[] }> } } | null)
      ?.simulation_state?.dismantles),
    [activeRun]
  )
  // Jobs the run turned away (rejected) or lost (scrapped), from simulation_state.
  const outcomes3D = useMemo(() => {
    const st = (activeRun?.result as { simulation_state?: { rejected_jobs?: number; scrapped_jobs?: number } } | null)?.simulation_state
    return st ? { rejected: st.rejected_jobs ?? 0, scrapped: st.scrapped_jobs ?? 0 } : undefined
  }, [activeRun])
  // Build-mode job replay: which box each station (and parallel machine,
  // "Station 2 #2" -> machine 2) is drawn at.
  const replayTargets = useMemo<ReplayTarget[]>(() => nodes.map((n) => {
    // A machine of a parallel group is a station of its own — unless the box
    // still stands for machine N of an older station not yet saved as a group.
    const ownStation = n.data.parallelGroup && (n.data.savedName === undefined || n.data.savedName === n.data.label)
    const suffix = ownStation ? null : n.data.label.match(/\s+#(\d+)$/)
    return {
      nodeId: n.id,
      station: ownStation ? n.data.label : baseStationName(n.data.label),
      machine: suffix ? Number(suffix[1]) : 1,
      isSource: inferStationType(n.data.label, n.data.stationType) === 'Source',
      isDrain: inferStationType(n.data.label, n.data.stationType) === 'Drain',
      // A Start: the products it releases (its own MU table).
      products: inferStationType(n.data.label, n.data.stationType) === 'Source'
        ? (n.data.muTable ?? activeScenario?.stations_data?.[stationKey(n)]?.['MU Table'] ?? []).map((r) => jobPrefix(r.mu))
        : undefined,
    }
  }), [nodes, activeScenario])
  const replayState = (activeRun?.result as { simulation_state?: { job_release_times?: Record<string, unknown>; job_finish_times?: Record<string, unknown>; assemblies?: Record<string, AssemblyRecord>; dismantles?: Record<string, DismantleRecord> } } | null)?.simulation_state
  // When the run started: its first job release ("2025-01-01 06:00:00", local time).
  const runStartMs = useMemo(() => {
    let first = Infinity // a loop: a big run has hundreds of thousands of jobs
    for (const t of Object.values(replayState?.job_release_times ?? {})) {
      const ms = typeof t === 'string' ? new Date(t.replace(' ', 'T')).getTime() : NaN
      if (ms < first) first = ms
    }
    return Number.isFinite(first) ? first : undefined
  }, [replayState])

  // The store's copy of the scenario can be older than the saved one — the
  // Scenarios page saves straight to the server without touching it. Fetch
  // the latest once each time the Canvas opens (or the scenario changes),
  // before any boxes are built from it, so the boxes never show — and Save
  // never writes back — values already changed elsewhere.
  const [freshScenarioId, setFreshScenarioId] = useState<number | null>(null)
  useEffect(() => {
    const id = activeScenario?.id
    if (id === undefined || freshScenarioId === id) return
    let cancelled = false
    scenariosApi.get(id)
      .then((fresh) => {
        if (cancelled) return
        setActiveScenario(fresh)
        setFreshScenarioId(id)
      })
      // Offline / failed: fall back to the copy we have rather than an empty canvas.
      .catch(() => { if (!cancelled) setFreshScenarioId(id) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScenario?.id, freshScenarioId])

  // When switching into Build mode with a scenario loaded, populate the canvas
  // with editable boxes for that scenario (only if Build is currently empty —
  // so we never clobber in-progress manual edits).
  useEffect(() => {
    if (mode !== 'build' || !activeScenario || !selectedVariant) return
    if (freshScenarioId !== activeScenario.id) return
    // Boxes already on the canvas stay — unless they are another product's
    // line with nothing unsaved (e.g. a different product was picked in View).
    if (nodes.length > 0 && (buildVariant === null || buildVariant === selectedVariant || canvasDirty)) return
    const { nodes: finalNodes, edges: loadedEdges } = loadScenarioGraph(activeScenario, selectedVariant)
    if (finalNodes.length === 0) {
      // No route yet: an empty canvas, saved as that product.
      setBuildVariant(selectedVariant)
      return
    }
    assemblyLinesRef.current = null
    setNodes(finalNodes)
    setEdges(loadedEdges)
    loadedLinesRef.current = linesByProduct(Object.keys(activeScenario.processflow_data ?? {}), finalNodes, loadedEdges)
    loadedTimesRef.current = Object.fromEntries(finalNodes.map((n) => [n.id, n.data.processTime]))
    setScenarioName(activeScenario.name)
    setBuildVariant(selectedVariant)
    setSavedSignature(canvasSignatureOf(finalNodes, loadedEdges))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, activeScenario, selectedVariant, freshScenarioId, reloadTick])

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
      // A new line is the picked product's (see productGraph).
      setEdges((eds) => addEdge({
        ...params, sourceHandle: 'right', targetHandle: 'left',
        ...(buildVariant ? { data: { products: [buildVariant] } } : {}),
      }, eds))
    },
    [setEdges, buildVariant]
  )

  // Edge (connection line) labeling — purely a visual note on the arrow
  // (e.g. "Pass" / "Fail" / "70%"), no effect on simulation behaviour.
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const updateEdgeLabel = (id: string, label: string) => {
    setEdges((eds) => eds.map((e) => (e.id === id ? { ...e, label } : e)))
  }
  // The drawing is shared by every product. Deleting a line another product
  // also uses only takes it out of the picked product's route; deleting
  // boxes joins the other products' routes around them (the picked
  // product's gap is left for you to reconnect, as before).
  const dropLines = (eds: Edge[], lineIds: Set<string>): Edge[] => eds.flatMap((e) => {
    if (!lineIds.has(e.id)) return [e]
    const ps = edgeProducts(e)
    if (buildVariant && ps && ps.includes(buildVariant) && ps.length > 1) {
      return [withProducts(e, ps.filter((p) => p !== buildVariant))]
    }
    return []
  })
  const removeBoxes = (eds: Edge[], ids: Set<string>): Edge[] => {
    let out = eds
    for (const id of ids) {
      const bridges: Edge[] = []
      for (const a of out.filter((e) => e.target === id && isFlowEdge(e, nodeById))) {
        for (const b of out.filter((e) => e.source === id && isFlowEdge(e, nodeById))) {
          const both = (edgeProducts(a) ?? []).filter((p) => p !== buildVariant && (edgeProducts(b) ?? []).includes(p))
          if (both.length === 0 || a.source === b.target) continue
          bridges.push({ id: `e_${a.source}__${b.target}`, source: a.source, target: b.target, sourceHandle: 'right', targetHandle: 'left', data: { products: both } })
        }
      }
      out = out.filter((e) => e.source !== id && e.target !== id)
      for (const br of bridges) {
        const existing = out.find((o) => o.source === br.source && o.target === br.target)
        if (!existing) {
          out = [...out, br]
          continue
        }
        const had = edgeProducts(existing)
        const base = had !== undefined ? had : buildVariant ? [buildVariant] : []
        out = out.map((o) => (o === existing ? withProducts(o, Array.from(new Set([...base, ...(edgeProducts(br) ?? [])]))) : o))
      }
    }
    return out
  }
  const deleteEdge = (id: string) => {
    setEdges((eds) => dropLines(eds, new Set([id])))
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
    // Every box needs its own name: a second Start is "Start 2", and so on.
    let label = initialName ?? nextLabel(typeName, nodes)
    if (initialName) {
      const taken = new Set(nodes.map((n) => n.data.label))
      for (let k = 2; taken.has(label); k++) label = `${initialName} ${k}`
    }
    const newNodeId = `station_${id}`
    setNodes((nds) => {
      const rightmostX = nds.length > 0 ? Math.max(...nds.map((n) => n.position.x)) : 40
      const avgY = nds.length > 0 ? nds.reduce((sum, n) => sum + n.position.y, 0) / nds.length : 160
      const position = dropPosition ?? { x: nds.length > 0 ? rightmostX + 220 : 80, y: avgY }
      // Non-machine types start with values that match how the engine treats
      // them: a Connector never processes (0 process time, no operator) and a
      // Conveyor moves rather than works (transport time, no operator).
      const data: StationNodeData =
        typeName === 'Connector' || typeName === 'Worker' || typeName === 'Worker Controller'
          ? { label, stationType: typeName, capacity: 1, processTime: 0, operators: 0, shiftsPerDay: [1] }
          : typeName === 'Conveyor'
            ? { label, stationType: typeName, capacity: 1, processTime: 0, operators: 0, conveyorSpeed: 1, conveyorCapacity: 1, shiftsPerDay: [1] }
            : { label, stationType: typeName, capacity: 1, processTime: 30, operators: 0, setupTime: 0, repairTime: 0, failureTime: 0, shiftsPerDay: [1] }
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

  // Ctrl+C / Ctrl+V on the Build canvas: copies the selected stations (not
  // Start/End — a line has one of each) and the lines between them; each
  // paste lands a little lower-right, named "<name> copy", with the original's
  // settings. Copied machines of a parallel group form a new group of their own.
  const clipboardRef = useRef<{ nodes: Node<StationNodeData>[]; edges: Edge[] } | null>(null)
  // What Delete is about to remove, waiting for the user to confirm.
  const [pendingDelete, setPendingDelete] = useState<{ nodeIds: string[]; edgeIds: string[] } | null>(null)
  const confirmDelete = () => {
    if (!pendingDelete) return
    const ids = new Set(pendingDelete.nodeIds)
    const lines = new Set(pendingDelete.edgeIds)
    setNodes((nds) => nds.filter((n) => !ids.has(n.id)))
    // Lines of removed stations go too, hidden worker wiring included.
    setEdges((eds) => removeBoxes(dropLines(eds, lines), ids))
    setSelectedNode(null)
    setSelectedEdgeId(null)
    setPendingDelete(null)
  }
  const pasteCountRef = useRef(0)
  useEffect(() => {
    if (mode !== 'build') return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return
      // Delete / Backspace: ask before removing what is selected.
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey) {
        const nodeIds = nodes.filter((n) => n.selected).map((n) => n.id)
        const edgeIds = edges.filter((ed) => ed.selected).map((ed) => ed.id)
        if (nodeIds.length + edgeIds.length === 0) return
        e.preventDefault()
        setPendingDelete({ nodeIds, edgeIds })
        return
      }
      if (!(e.ctrlKey || e.metaKey)) return
      const key = e.key.toLowerCase()
      if (key === 'c') {
        const picked = nodes.filter((n) => n.selected && !['Source', 'Drain'].includes(inferStationType(n.data.label, n.data.stationType)))
        if (picked.length === 0) return
        const ids = new Set(picked.map((n) => n.id))
        clipboardRef.current = { nodes: picked, edges: edges.filter((ed) => ids.has(ed.source) && ids.has(ed.target)) }
        pasteCountRef.current = 0
        showToast(`Copied ${picked.length} station${picked.length > 1 ? 's' : ''}`)
      } else if (key === 'v' && clipboardRef.current) {
        e.preventDefault()
        const clip = clipboardRef.current
        pasteCountRef.current += 1
        const shift = 60 * pasteCountRef.current
        const taken = new Set(nodes.flatMap((n) => [n.data.label, n.data.parallelGroup ?? '']))
        const copyName = (name: string) => {
          let candidate = `${name} copy`
          for (let k = 2; taken.has(candidate); k++) candidate = `${name} copy ${k}`
          taken.add(candidate)
          return candidate
        }
        const newGroup: Record<string, string> = {}
        const newId: Record<string, string> = {}
        const pasted = clip.nodes.map((n) => {
          newId[n.id] = `station_${nextNodeId()}`
          const group = n.data.parallelGroup
          if (group && !(group in newGroup)) newGroup[group] = copyName(group)
          const data: StationNodeData = {
            ...n.data,
            label: copyName(n.data.label),
            parallelGroup: group ? newGroup[group] : undefined,
            savedName: undefined,
            copiedFrom: n.data.savedName ?? stationKey(n),
          }
          return { ...n, id: newId[n.id], position: { x: n.position.x + shift, y: n.position.y + shift }, selected: true, data }
        })
        const pastedEdges = clip.edges.map((ed) => ({
          ...ed, id: `e_${newId[ed.source]}__${newId[ed.target]}`, source: newId[ed.source], target: newId[ed.target], selected: false,
          data: buildVariant ? { products: [buildVariant] } : undefined,
        }))
        setNodes((nds) => [...nds.map((n) => (n.selected ? { ...n, selected: false } : n)), ...pasted])
        setEdges((eds) => [...eds.map((ed) => (ed.selected ? { ...ed, selected: false } : ed)), ...pastedEdges])
        setSelectedNode(null)
        showToast(`Pasted ${pasted.length} station${pasted.length > 1 ? 's' : ''}`)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, nodes, edges])

  const deleteNode = (id: string) => {
    setNodes((nds) => nds.filter((n) => n.id !== id))
    setEdges((eds) => removeBoxes(eds, new Set([id])))
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
      const label = `${stationKey(station)} Workplace`
      return [
        ...nds,
        {
          id: workplaceId,
          type: 'station',
          position: { x: station.position.x, y: station.position.y + 170 },
          data: {
            label, stationType: 'Workplace', capacity: 1, processTime: 0, operators: 1,
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
  /** Add another parallel machine for this station: duplicates the box into
   *  the station's parallel group ("Name #1", "Name #2", ...) and wires the
   *  copy to the same predecessors/successors so it stays a proper parallel
   *  branch. Each machine is a station of its own (own settings, own name —
   *  renaming one keeps it in the group). */
  const addParallelMachine = (id: string) => {
    const newIdNum = nextNodeId()
    const newId = `station_${newIdNum}`

    setNodes((nds) => {
      const source = nds.find((n) => n.id === id)
      if (!source) return nds
      const group = groupKey(source)
      const siblings = nds.filter((n) => groupKey(n) === group)

      // The first time, the station becomes machine #1 of its new group.
      // Machines already in the group keep their names.
      const renamed = nds.map((n) => {
        if (groupKey(n) !== group) return n
        const label = n.data.parallelGroup || siblings.length > 1 ? n.data.label : `${group} #1`
        return { ...n, data: { ...n.data, label, parallelGroup: group } }
      })
      const taken = new Set(renamed.map((n) => n.data.label))
      let nextIndex = siblings.length + 1
      while (taken.has(`${group} #${nextIndex}`)) nextIndex += 1

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
        data: { ...source.data, label: `${group} #${nextIndex}`, parallelGroup: group },
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
    // name: the name to save under (the name box's, unless given).
    // simCfg: the Sim setting a new scenario is created with (this one's,
    // unless given — e.g. a timer just applied, not in state yet).
    // stationsOnly: the auto-save of a canvas that can't make a route yet
    // (a box with no line, ...): only the station settings and the drawing
    // are saved; the saved routes stay as they are.
    mutationFn: async (vars?: { name?: string; simCfg?: SimConfigOverride; stationsOnly?: boolean }) => {
      const saveName = vars?.name ?? scenarioName
      // Each station's settings as saved right now (fetched fresh, so edits
      // made meanwhile in the Scenarios page are kept). Save starts from
      // these and only changes what this Canvas manages — settings it
      // doesn't show (Rework %, Enable Failures, Availability/MTBF, Material
      // Shortage %, PM Schedule, ...) stay exactly as they were.
      // Fetched fresh too: the other products' routes, quantities and
      // intervals, which this Save keeps as they are.
      const savedScenario = activeScenario ? await scenariosApi.get(activeScenario.id) : null
      const savedStations: Record<string, Record<string, unknown>> =
        (savedScenario?.stations_data ?? {}) as Record<string, Record<string, unknown>>

      // Each machine of a parallel group is a station of its own, saved under
      // its box's name (stationKey). Boxes drawn before groups existed that
      // share a base name ("Stitching #1" / "Stitching #2") are still merged
      // into one station whose capacity is the number of such boxes.
      const stationsData: ScenarioCreate['stations_data'] = {}
      // An Assembly's settings, with the lines coming into it for the
      // simulation, in the order connected: No. as in Assembly needs
      // (Predecessors) or that order, amount as in Assembly needs
      // (Predecessors) or 1.
      const assemblyToSave = (n: Node<StationNodeData>): AssemblyConfig => {
        const assembly = assemblySettings(n.data.assembly)
        const incoming = incomingStations(n.id, nodes, edges)
        const numbers = typedNumbers(assembly, incoming)
        const lines = incoming.map((from) => {
          const need = assembly.table === 'predecessors' ? assembly.needs?.find((x) => x.from === from) : undefined
          return { from, no: numbers[from], amount: need?.amount ?? 1 }
        })
        return { ...assembly, lines }
      }
      // A Dismantle's settings, with its Dismantle table as shown: one row
      // per line going out now (a deleted line's row is left out).
      // Plus its lines out, in the order connected (successor 1, 2, ...).
      const dismantleToSave = (n: Node<StationNodeData>): DismantleConfig => {
        const dismantle = dismantleSettings(n.data.dismantle)
        const outgoing = outgoingStations(n.id, nodes, edges)
        return { ...dismantle, table: dismantleRows(dismantle, outgoing), successors: outgoing }
      }
      const capacityCount: Record<string, number> = {}
      nodes.forEach((n) => {
        const base = stationKey(n)
        capacityCount[base] = (capacityCount[base] ?? 0) + 1
      })
      nodes.forEach((n) => {
        const base = stationKey(n)
        // Its saved settings — under the name it was loaded with, so a
        // station renamed here keeps them (a new machine copies the one it
        // was added from). Minus every key this save writes itself (below,
        // and the Worker Controller wiring further down), so something
        // removed on the Canvas (a sensor, a wiring, ...) doesn't come back
        // from the old copy.
        const saved: Record<string, unknown> = {
          ...(savedStations[n.data.savedName ?? base] ?? savedStations[base]
            ?? (n.data.copiedFrom ? savedStations[n.data.copiedFrom] : undefined) ?? {}),
        }
        for (const key of CANVAS_STATION_KEYS) delete saved[key]
        // Conveyor time is Length / Speed now; an older saved Transport Time
        // would only confuse whoever reads the scenario.
        if (n.data.conveyorSpeed !== undefined) delete saved['Transport Time']
        // Failure Time 0 = never breaks down: no MTBF (the engine can't take 0).
        if (n.data.failureTime !== undefined && !(n.data.failureTime > 0)) delete saved['MTBF']
        stationsData[base] = {
          // A brand-new station's defaults; a saved one keeps its own.
          'Failure rate': 0, 'PM Schedule': 'Monthly',
          'Material Shortage Probability (%)': 0, 'Rework Probability (%)': 0,
          shift1: '', shift2: '', shift3: '', STATION_DOWNTIME: 0,
          ...saved,
          ...(n.data.failureTime === undefined ? {}
            : n.data.failureTime > 0 ? { MTBF: n.data.failureTime } : { 'Failure rate': 0 }),
          capacity: capacityCount[base], shifts_per_day: n.data.shiftsPerDay ?? [1],
          operator_per_station: n.data.operators,
          ...(n.data.parallelGroup ? { 'Parallel Group': n.data.parallelGroup } : {}),
          ...(n.data.muTable ? { 'MU Table': n.data.muTable } : {}),
          // A Start saved from now on releases its products batch by batch:
          // Cyclic unless another order was chosen. (A scenario never saved
          // since keeps its old arrivals — the engine only orders a Start
          // that has an MU Strategy.)
          ...(inferStationType(n.data.label, n.data.stationType) === 'Source'
            ? { 'MU Strategy': n.data.muStrategy ?? 'cyclic' } : {}),
          ...(n.data.muPriorities ? { 'MU Priorities': n.data.muPriorities } : {}),
          ...(n.data.muPercentages ? { 'MU Percentages': n.data.muPercentages } : {}),
          ...(n.data.stationType !== undefined ? { 'Station Type': n.data.stationType } : {}),
          ...(n.data.conveyorSpeed !== undefined ? { 'Conveyor Speed': n.data.conveyorSpeed } : {}),
          ...(n.data.conveyorLength !== undefined ? { 'Conveyor Length': n.data.conveyorLength } : {}),
          ...(n.data.conveyorWidth !== undefined ? { 'Conveyor Width': n.data.conveyorWidth } : {}),
          ...(n.data.conveyorHeight !== undefined ? { 'Conveyor Height': n.data.conveyorHeight } : {}),
          ...(n.data.conveyorCapacity !== undefined ? { 'Conveyor Capacity': n.data.conveyorCapacity } : {}),
          ...(n.data.conveyorSensor ? {
            'Conveyor Sensor Length': n.data.conveyorSensor.length,
            'Conveyor Sensor Position': n.data.conveyorSensor.position === 'rear' ? 'Rear' : 'Front',
          } : {}),
          // Route based is always Cyclic (one saved with Random before runs Cyclic too).
          ...(n.data.routeByProduct ? { 'Exit Strategy': 'cyclic' }
            : n.data.exitStrategy !== undefined ? { 'Exit Strategy': n.data.exitStrategy } : {}),
          ...(n.data.exitPercentages !== undefined ? { 'Exit Percentages': n.data.exitPercentages } : {}),
          ...(n.data.exitPriorities !== undefined ? { 'Exit Priorities': n.data.exitPriorities } : {}),
          ...(n.data.routeByProduct ? { 'Route By Product': true, 'Product Routes': n.data.productRoutes ?? {} } : {}),
          ...(inferStationType(n.data.label, n.data.stationType) === 'Assembly' ? { 'Assembly': assemblyToSave(n) } : {}),
          ...(inferStationType(n.data.label, n.data.stationType) === 'Dismantle' ? { 'Dismantle': dismantleToSave(n) } : {}),
          ...(n.data.setupTime !== undefined ? { 'Setup time': n.data.setupTime } : {}),
          // Buffer Quantity from the Build panel — only meaningful for a
          // Buffer node (see backend's _is_buffer hand-off); harmless to
          // include on every station since a real station reads its OWN
          // 'Buffer Capacity'/'Buffer Unlimited' fields the same way (see
          // ScenarioManager's Stations tab), just never set from here.
          ...(n.data.bufferQuantity !== undefined ? { 'Buffer Capacity': n.data.bufferQuantity } : {}),
          ...(n.data.bufferUnlimited !== undefined ? { 'Buffer Unlimited': n.data.bufferUnlimited } : {}),
          ...(n.data.bufferConfigMode !== undefined ? { 'Buffer Config Mode': n.data.bufferConfigMode } : {}),
          ...(n.data.bufferX !== undefined ? { 'Buffer X': n.data.bufferX } : {}),
          ...(n.data.bufferY !== undefined ? { 'Buffer Y': n.data.bufferY } : {}),
          ...(n.data.bufferZ !== undefined ? { 'Buffer Z': n.data.bufferZ } : {}),
          ...(n.data.bufferOrder !== undefined ? { 'Buffer Discipline': n.data.bufferOrder } : {}),
          'Repair Time': n.data.repairTime ?? 0,
          'Failure Policy': n.data.failurePolicy ?? 'resume',
        } as ScenarioCreate['stations_data'][string]
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
      // A Worker is not walked through: it is found, so it joins the pool
      // (walked through, it was never found and the pool stayed empty).
      const isPassthroughForPoolWiring = (n: Node<StationNodeData>): boolean => {
        const t = inferStationType(n.data.label, n.data.stationType)
        return t === 'Connector' || t === 'Workplace'
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
        const controllerBase = stationKey(n)
        const controllerConfig = stationsData[controllerBase]
        if (!controllerConfig) return

        // Everything reachable upstream of this Controller (through any
        // chain of Connector/Workplace passthroughs) — Worker nodes
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
          const targetConfig = stationsData[stationKey(target)]
          if (!targetConfig) continue
          targetConfig['Worker Controller'] = controllerBase
        }
      })

      // The duration written into the process-flow step. A Conveyor's time is
      // its transport time, Length / Speed (the engine computes the same but
      // falls back to the step duration), and a Connector never takes any
      // time at all.
      const stepDuration = (n: Node<StationNodeData>): number => {
        const t = inferStationType(n.data.label, n.data.stationType)
        // Source/Drain are entry/exit markers, not work — the backend
        // already treats them as zero-time passthroughs (_is_passthrough in
        // sim_core.py) regardless of what's stored here, so writing a
        // nonzero duration only misleads whoever edits it later in
        // ScenarioManager's Grid mode (an editable "Start (min)" column that
        // silently does nothing).
        if (t === 'Connector' || t === 'Worker' || t === 'Worker Controller' || t === 'Workplace' || t === 'Source' || t === 'Drain') return 0
        if (t === 'Conveyor') return conveyorTransportTime(n.data) ?? n.data.processTime
        return n.data.processTime
      }

      // The product this Save writes from the Canvas: the one picked in
      // View/Build. A brand-new line gets a name from its first box.
      const hasIncoming = new Set(edges.map((e) => e.target))
      const entryNodes = nodes.filter((n) => !hasIncoming.has(n.id))
      const savedFlow = (savedScenario?.processflow_data ?? {}) as ScenarioCreate['processflow_data']
      const variant = buildVariant && (buildVariant in savedFlow || !savedScenario)
        ? buildVariant
        : entryNodes.length > 0
          ? `product_${baseStationName(entryNodes[0].data.label)}`.toLowerCase()
          : 'product'
      savedVariantRef.current = variant
      // Its route: the stations along its lines on the drawing — or, while
      // its lines are as loaded, its saved route kept as it is (a drawing
      // shows each station once, so walking it would lose a route's second
      // visit to a station), with only the times changed on its boxes.
      const shownGraph = productGraph(nodes, edges, variant, variant)
      const steps = routeFromGraph(shownGraph.nodes, shownGraph.edges, stepDuration)
      const shownLinesBefore = loadedLinesRef.current[variant]
      const shownLinesKept = shownLinesBefore !== undefined && graphRouteSig(
        shownGraph.nodes, shownGraph.edges, variant, variant, (n) => n.data.savedName ?? stationKey(n),
      ) === shownLinesBefore
      const timesFromBoxes = (route: FlowStep[]): FlowStep[] => route.map((step) => {
        const box = typeof step.resource === 'string'
          ? nodes.find((n) => !isWiringNode(n) && stationKey(n) === step.resource)
          : undefined
        if (!box) return step
        const changed = inferStationType(box.data.label, box.data.stationType) === 'Conveyor'
          || box.data.processTime !== loadedTimesRef.current[box.id]
        return changed ? { ...step, duration: stepDuration(box) } : step
      })

      // The drawing itself, as it is now. Every box keeps its id (a new box
      // gets the next free id of its kind) and every flow line its products
      // (a new line: the product on the Canvas).
      const boxIdOf: Record<string, string> = {}
      const highestId: Record<string, number> = {}
      for (const n of nodes) {
        const m = n.data.boxId?.match(/^([A-Z]+)-(\d+)$/)
        if (m) highestId[m[1]] = Math.max(highestId[m[1]] ?? 0, Number(m[2]))
      }
      const usedBoxIds = new Set<string>()
      for (const n of nodes) {
        let id = n.data.boxId
        if (!id || usedBoxIds.has(id)) {
          const prefix = boxIdPrefix(n)
          highestId[prefix] = (highestId[prefix] ?? 0) + 1
          id = `${prefix}-${highestId[prefix]}`
        }
        usedBoxIds.add(id)
        boxIdOf[n.id] = id
      }
      const nodeOf = new Map(nodes.map((n) => [n.id, n]))
      // A first save with MU tables filled in on the Starts: their products,
      // each with its Number and Interval, its route along the lines from the
      // Start that releases it (not one default product of 200).
      const firstSavePlan = (() => {
        if (activeScenario) return null
        const flowEdges = edges.filter((e) => isFlowEdge(e, nodeOf))
        const isStart = (n: Node<StationNodeData>) => inferStationType(n.data.label, n.data.stationType) === 'Source'
        const flow: ScenarioCreate['processflow_data'] = {}
        const qty: Record<string, number> = {}
        const intervals: Record<string, number> = {}
        const linesOf: Record<string, string[]> = {}
        for (const start of nodes.filter(isStart)) {
          const rows = (start.data.muTable ?? []).filter((r) => r.mu.trim() && !(r.mu in flow))
          if (rows.length === 0) continue
          const reached = new Set([start.id])
          const queue = [start.id]
          while (queue.length > 0) {
            const at = queue.shift()!
            for (const e of flowEdges) {
              if (e.source !== at || reached.has(e.target) || isStart(nodeOf.get(e.target)!)) continue
              reached.add(e.target)
              queue.push(e.target)
            }
          }
          const lines = flowEdges.filter((e) => reached.has(e.source) && reached.has(e.target))
          const ids = new Set([...reached, ...nodes.filter(isWiringNode).map((n) => n.id)])
          const route = routeFromGraph(
            nodes.filter((n) => ids.has(n.id)),
            edges.filter((e) => ids.has(e.source) && ids.has(e.target) && (!isFlowEdge(e, nodeOf) || lines.includes(e))),
            stepDuration,
          )
          for (const r of rows) {
            flow[r.mu] = route
            qty[r.mu] = r.number
            if (r.interval != null && r.interval > 0) intervals[r.mu] = r.interval
            for (const e of lines) (linesOf[e.id] ??= []).push(r.mu)
          }
        }
        return Object.keys(flow).length > 0 ? { flow, qty, intervals, linesOf } : null
      })()
      if (firstSavePlan) savedVariantRef.current = Object.keys(firstSavePlan.flow)[0]
      const productsOf: Record<string, string[] | undefined> = {}
      for (const e of edges) {
        const ps = edgeProducts(e)
        productsOf[e.id] = !isFlowEdge(e, nodeOf) ? undefined
          : firstSavePlan ? firstSavePlan.linesOf[e.id] ?? []
          : ps !== undefined ? ps : [variant]
      }
      const layout: CanvasLayout = {
        version: 1,
        boxes: nodes.map((n) => {
          const data: Partial<StationNodeData> = { ...n.data }
          delete data.savedName
          delete data.copiedFrom
          delete data.boxId
          return {
            id: boxIdOf[n.id], name: n.data.label, type: inferStationType(n.data.label, n.data.stationType),
            x: Math.round(n.position.x), y: Math.round(n.position.y), data,
          }
        }),
        lines: edges.filter((e) => nodeOf.has(e.source) && nodeOf.has(e.target)).map((e) => ({
          from: boxIdOf[e.source],
          to: boxIdOf[e.target],
          ...(productsOf[e.id] ? { products: productsOf[e.id] } : {}),
          ...(typeof e.label === 'string' && e.label ? { label: e.label } : {}),
        })),
      }
      savedDrawingRef.current = { boxIdOf, productsOf }

      // Editing the scenario that's already open updates it in place (same
      // id, same row) instead of creating a second copy. Only this product's
      // route changes — every other product keeps its route, quantity and
      // interval, and the stations only they use stay in the station list.
      if (activeScenario && savedScenario) {
        // Stations renamed here (a box loaded as one name, saved as another;
        // an older N-machine station saved as its N machines): the other
        // products' routes follow the new name(s).
        const renamed: Record<string, string[]> = {}
        for (const n of nodes) {
          const key = stationKey(n)
          const old = n.data.savedName
          if (old && old !== key && savedStations[old] && !(old in stationsData)) {
            if (!(renamed[old] ??= []).includes(key)) renamed[old].push(key)
          }
        }
        for (const [name, cfg] of Object.entries(savedStations)) {
          if (!(name in stationsData) && (!(name in renamed) || vars?.stationsOnly)) {
            stationsData[name] = cfg as ScenarioCreate['stations_data'][string]
          }
        }
        // Routes not saved: keep every station they use (a renamed one under
        // its old name too) and the drawing's route marks as they were.
        if (vars?.stationsOnly) {
          return scenariosApi.update(activeScenario.id, {
            stations_data: stationsData,
            canvas_layout: { ...layout, routes: savedScenario.canvas_layout?.routes },
          })
        }
        const followRenames = (otherSteps: ScenarioCreate['processflow_data'][string]) => {
          let nextBranch = Math.max(0, ...otherSteps.map((s) => s.branch ?? 0)) + 1
          return otherSteps.flatMap((s) => {
            const res = typeof s.resource === 'string' ? s.resource : undefined
            const to = res !== undefined ? renamed[res] : undefined
            if (!res || !to) return [s]
            const op = (name: string) => (s.operation === res ? name : s.operation === `${res}_op` ? `${name}_op` : to.length === 1 ? s.operation : `${name}_op`)
            if (to.length === 1) return [{ ...s, resource: to[0], operation: op(to[0]) }]
            // One station became a parallel group: its machines are one stop.
            const branch = s.branch ?? nextBranch++
            return to.map((name) => ({ ...s, resource: name, operation: op(name), branch }))
          })
        }
        const processflow: ScenarioCreate['processflow_data'] = {}
        for (const [v, otherSteps] of Object.entries(savedFlow)) {
          if (v === variant) continue
          // Another product keeps its route as saved — unless its lines on
          // the drawing were changed here; then its route follows them, each
          // station keeping its time.
          const graph = productGraph(nodes, edges, v, variant)
          const drawn = graphRouteSig(graph.nodes, graph.edges, v, variant, (n) => n.data.savedName ?? stationKey(n))
          const before = loadedLinesRef.current[v]
          if (before !== undefined ? drawn === before : drawn === EMPTY_ROUTE_SIG || drawn === routeSig(otherSteps)) {
            processflow[v] = followRenames(otherSteps)
            continue
          }
          const timeOf: Record<string, number> = {}
          for (const st of otherSteps) for (const r of stepResourceOptions(st.resource)) timeOf[r] = st.duration
          processflow[v] = routeFromGraph(graph.nodes, graph.edges, (n) => {
            const name = n.data.savedName ?? stationKey(n)
            return inferStationType(n.data.label, n.data.stationType) !== 'Conveyor' && name in timeOf ? timeOf[name] : stepDuration(n)
          })
        }
        processflow[variant] = shownLinesKept && savedFlow[variant]
          ? timesFromBoxes(followRenames(savedFlow[variant]))
          : steps
        const variantQty: Record<string, number> = {
          ...(savedScenario.variant_quantities ?? {}),
          [variant]: savedScenario.variant_quantities?.[variant] ?? 200,
        }
        layout.routes = Object.fromEntries(Object.entries(processflow).map(([v, st]) => [v, routeSig(st)]))
        return scenariosApi.update(activeScenario.id, {
          name: saveName, stations_data: stationsData, processflow_data: processflow,
          variant_quantities: variantQty,
          variant_intervals: savedScenario.variant_intervals ?? {},
          canvas_layout: layout,
        })
      }

      const processflow: ScenarioCreate['processflow_data'] = firstSavePlan?.flow ?? { [variant]: steps }
      const variantQty: Record<string, number> = firstSavePlan?.qty ?? { [variant]: 200 }
      layout.routes = Object.fromEntries(Object.entries(processflow).map(([v, st]) => [v, routeSig(st)]))
      return scenariosApi.create({
        name: saveName, stations_data: stationsData, processflow_data: processflow,
        variant_quantities: variantQty,
        ...(firstSavePlan && Object.keys(firstSavePlan.intervals).length > 0 ? { variant_intervals: firstSavePlan.intervals } : {}),
        canvas_layout: layout,
        operators_data: { Op1: { 'Skill Rating': 3, 'Availability (%)': 100 } },
        // Defaults, with what was set in Sim setting before this first save.
        simulation_config: {
          SIM_TIME: DEFAULT_SIM_TIME, SHIFT_DURATION: 480,
          SHIFT_1_START: 6, SHIFT_1_END: 14, SHIFT_2_START: 14, SHIFT_2_END: 22,
          SHIFT_3_START: 22, SHIFT_3_END: 6, STATION_DOWNTIME: 0, ACTIVE_PROCESSING_TIME: 480,
          ...NEW_SCENARIO_CALENDAR,
          ...(vars?.simCfg ?? sim.simCfg),
        } as ScenarioCreate['simulation_config'],
      })
    },
    onSuccess: (scenario, vars) => {
      queryClient.invalidateQueries({ queryKey: ['scenarios'] })
      setActiveScenario(scenario)
      // Station settings only: the canvas still counts as unsaved, so Run
      // and Save Scenario save (and check) the whole thing.
      if (vars?.stationsOnly) return
      setJustReset(false)
      // Each box is now saved under its own station name and id, and each
      // line with its products.
      const drawing = savedDrawingRef.current
      const savedNodes = nodes.map((n) => {
        const boxId = drawing?.boxIdOf[n.id] ?? n.data.boxId
        return n.data.savedName === stationKey(n) && n.data.boxId === boxId
          ? n
          : { ...n, data: { ...n.data, savedName: stationKey(n), boxId } }
      })
      const savedEdges = edges.map((e) => {
        const ps = drawing?.productsOf[e.id]
        return ps && JSON.stringify(ps) !== JSON.stringify(edgeProducts(e)) ? withProducts(e, ps) : e
      })
      setNodes(savedNodes)
      setEdges(savedEdges)
      setSavedSignature(canvasSignatureOf(savedNodes, savedEdges))
      loadedLinesRef.current = linesByProduct(Object.keys(scenario.processflow_data ?? {}), savedNodes, savedEdges)
      loadedTimesRef.current = Object.fromEntries(savedNodes.map((n) => [n.id, n.data.processTime]))
      // The canvas now shows this saved product.
      if (savedVariantRef.current) {
        setBuildVariant(savedVariantRef.current)
        setSelectedVariant(savedVariantRef.current)
      }
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  })

  // Validate before saving so users get a clear, friendly message instead of a
  // raw API error. navigateAfter=true (the top-bar "Save Scenario" button)
  // just saves and stays on the Workspace (only Run runs); false (the
  // per-station panel's Save button) persists the same scenario but keeps
  // the user in Canvas so they can keep editing other stations.
  // onSaved: just save and then do this (switching product), instead of
  // going to Run / running.
  // name: save under this name instead of the name box's.
  // simCfg: the Sim setting to create a new scenario with (see saveMutation).
  const autoScenarioName = () => {
    const d = new Date()
    const p2 = (x: number) => String(x).padStart(2, '0')
    return `Scenario ${p2(d.getDate())}-${p2(d.getMonth() + 1)}-${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  }
  // Why the canvas can't be saved as a route yet (Save shows it), or undefined.
  const canvasProblem = (): string | undefined => {
    // No lines at all is fine for a Start alone; any other box without a
    // line coming in is caught by lineProblem.
    const notInLine = lineProblem(nodes, edges)
    if (notInLine) return notInLine
    // Every Assembly box (also one never opened: its defaults count too).
    // Assembly needs (Predecessors) too: a wrong No. or amount.
    const assemblyIssue = (n: Node<StationNodeData>) => {
      if (inferStationType(n.data.label, n.data.stationType) !== 'Assembly') return undefined
      const assembly = assemblySettings(n.data.assembly)
      const incoming = incomingStations(n.id, nodes, edges)
      return assemblyProblem(assembly, incoming.length) ?? needsProblem(assembly, incoming)
    }
    const badAssembly = nodes.find((n) => assemblyIssue(n))
    if (badAssembly) return `${badAssembly.data.label}: ${assemblyIssue(badAssembly)}`
    const dismantleIssue = (n: Node<StationNodeData>) => inferStationType(n.data.label, n.data.stationType) === 'Dismantle'
      ? dismantleProblem(dismantleSettings(n.data.dismantle), outgoingStations(n.id, nodes, edges).length)
      : undefined
    const badDismantle = nodes.find((n) => dismantleIssue(n))
    if (badDismantle) return `${badDismantle.data.label}: ${dismantleIssue(badDismantle)}`
    // Every box needs its own name — the simulation finds stations by name.
    const named = nodes.filter((n) => !isWiringNode(n))
    const sameName = named.find((n, i) => named.findIndex((o) => o.data.label.trim() === n.data.label.trim()) !== i)
    if (sameName) return `Two boxes are named "${sameName.data.label}" — give each box its own name`
    const badPriorities = nodes.find((n) => {
      const successors = exitSuccessorLabels(n.id, nodes, productEdges)
      return n.data.exitStrategy === 'successor' && successors.length > 1
        && !exitPrioritiesAreValid(exitPriorityValues(n.data, successors))
    })
    if (badPriorities) return `${badPriorities.data.label}: Exit Controller priorities must use each number from 1 to ${exitSuccessorLabels(badPriorities.id, nodes, productEdges).length} once`
    const emptyConveyor = nodes.find((n) =>
      inferStationType(n.data.label, n.data.stationType) === 'Conveyor' && (n.data.conveyorCapacity ?? 1) < 1)
    if (emptyConveyor) return `${emptyConveyor.data.label}: Conveyor capacity must be 1 or more`
    const conveyors = nodes.filter((n) => inferStationType(n.data.label, n.data.stationType) === 'Conveyor')
    const noLength = conveyors.find((n) => !((n.data.conveyorLength ?? 0) > 0))
    if (noLength) return `${noLength.data.label}: Conveyor length must be more than 0`
    const noSpeed = conveyors.find((n) => !((n.data.conveyorSpeed ?? 0) > 0))
    if (noSpeed) return `${noSpeed.data.label}: Conveyor speed must be more than 0`
    const badSensor = conveyors.find((n) => n.data.conveyorSensor && n.data.conveyorSensor.length > (n.data.conveyorLength ?? 0))
    if (badSensor) return `${badSensor.data.label}: sensor (${formatDecimal(badSensor.data.conveyorSensor!.length)} m) is longer than the conveyor (${formatDecimal(badSensor.data.conveyorLength ?? 0)} m)`
    const badSplit = canvasSplits(nodes, productEdges).find((s) => s.problem)
    if (badSplit) return `${badSplit.sourceLabel}: ${badSplit.problem}`
    // Route by product: every product needs at least one ticked station.
    for (const n of nodes) {
      if (!n.data.routeByProduct || variants.length < 2) continue
      const successors = exitSuccessorLabels(n.id, nodes, productEdges)
      if (successors.length < 2) continue
      const none = variants.find((p) => !(n.data.productRoutes?.[p] ?? []).some((s) => successors.includes(s)))
      if (none) return `${n.data.label}: Route based — tick at least one station for ${none}`
    }
    return parallelGroupProblem(nodes, edges) ?? undefined
  }

  // Auto-save: while a scenario is open, a change on the canvas (a property
  // panel value, a box, a line) is saved a moment later, so the Scenarios
  // page always shows it. A canvas that can't make a route yet saves its
  // station settings and drawing only (see saveMutation's stationsOnly).
  useEffect(() => {
    if (!activeScenario || !canvasDirty || nodes.length === 0) return
    const t = window.setTimeout(() => {
      if (saveMutation.isPending) return
      saveMutation.mutate({
        name: scenarioName.trim() || activeScenario.name,
        stationsOnly: !!canvasProblem(),
      })
    }, 800)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, canvasDirty, activeScenario?.id])

  const handleSave = (navigateAfter: boolean, onSaved?: (scenario: Scenario) => void, name?: string, simCfg?: SimConfigOverride) => {
    if (nodes.length === 0) {
      showToast('Add at least one station before saving', 'error')
      return
    }
    // No name yet: name it after the date and time; it can be renamed in the
    // name box and saved again.
    if (!(name ?? scenarioName).trim()) {
      name = autoScenarioName()
      setScenarioName(name)
    }
    const problem = canvasProblem()
    if (problem) {
      showToast(problem, 'error')
      return
    }
    saveMutation.mutate({ name, simCfg }, {
      onSuccess: (scenario) => {
        if (onSaved) {
          showToast(`"${scenario.name}" saved`)
          onSaved(scenario)
          return
        }
        showToast(navigateAfter ? `"${scenario.name}" saved` : 'Station saved')
      },
    })
  }

  // Save the canvas if it needs it, then `then(the saved scenario's id)`.
  // No name yet: it is named after the date and time ("Scenario
  // 11-11-2026 23:38:05"), shown in the name box so it can be renamed later.
  // A problem (not connected, ...) shows the same error as Save, and
  // `then` is not called. Nothing on the canvas, or nothing changed since
  // the last save: no save, `then` straight away (id: the open scenario's,
  // if any).
  const saveThen = (then: (scenarioId: number | undefined) => void, simCfg?: SimConfigOverride) => {
    if (saveMutation.isPending) return
    const renamed = !!activeScenario && scenarioName.trim() !== '' && scenarioName !== activeScenario.name
    if (nodes.length === 0 || !(canvasDirty || renamed)) { then(activeScenario?.id); return }
    let name = scenarioName.trim()
    if (!name) {
      name = autoScenarioName()
      setScenarioName(name)
    }
    handleSave(false, (scenario) => then(scenario.id), name, simCfg)
  }
  // Leaving the Workspace (a top tab or Log out) saves the canvas first, so
  // a layout built here is never lost.
  const leaveWorkspace = (go: () => void) => saveThen(() => go())
  // Run (top bar, or Save & Run in Simulation Timer with its new `cfg`):
  // a new or changed scenario is saved first, the same way, then run —
  // a run always uses the saved version.
  const runNow = (cfg?: SimConfigOverride) => saveThen((scenarioId) => {
    if (scenarioId == null) { showToast('Add at least one station before running', 'error'); return }
    sim.start(cfg, scenarioId)
  }, cfg && { ...sim.simCfg, ...cfg })
  const leaveWorkspaceRef = useRef(leaveWorkspace)
  leaveWorkspaceRef.current = leaveWorkspace
  const setLeaveGuard = useAppStore((st) => st.setLeaveGuard)
  useEffect(() => {
    setLeaveGuard((go) => leaveWorkspaceRef.current(go))
    return () => setLeaveGuard(null)
  }, [setLeaveGuard])

  // Build: open another product's line. With unsaved changes on the canvas,
  // ask first (Save / Discard / Cancel).
  const openProduct = (v: string) => {
    setNodes([])
    setEdges([])
    setSavedSignature(null)
    setBuildVariant(null)
    setSelectedVariant(v)
    setReloadTick((t) => t + 1)
  }
  // The MU table's rows: the scenario's own products (variants), with their
  // quantity and interval; Name from the Start's saved table. Products keep
  // the saved table's order, then any others. A canvas not saved yet as a
  // scenario only has the table on its Start box.
  // The MU table: the products of every Start together, each with the Start
  // that releases it — the Start whose own MU table lists it (one listed
  // nowhere: the first Start, as the simulation does too).
  const startBoxes = nodes.filter((n) => inferStationType(n.data.label, n.data.stationType) === 'Source')
  const startTableOf = (startNode: Node<StationNodeData>): MuRow[] => startNode.data.muTable
    ?? activeScenario?.stations_data?.[stationKey(startNode)]?.['MU Table'] ?? []
  const muTableRows = (startNode: Node<StationNodeData>): MuDialogRow[] => {
    const starts = startBoxes.length > 0 ? startBoxes : [startNode]
    const listed = starts.flatMap((st) => startTableOf(st).map((r) => ({ row: r, start: stationKey(st) })))
    const ownerOf = (v: string) => listed.find((x) => x.row.mu === v)
    if (!activeScenario) {
      return listed.map(({ row, start }, i) => ({ ...row, start, color: row.color ?? defaultVariantColor(i) }))
    }
    const products = Array.from(new Set([
      ...listed.map((x) => x.row.mu),
      ...Object.keys(activeScenario.processflow_data ?? {}),
      ...Object.keys(activeScenario.variant_quantities ?? {}),
    ])).filter((v) => v in (activeScenario.processflow_data ?? {}) || v in (activeScenario.variant_quantities ?? {}))
    return products.map((v, i) => ({
      mu: v,
      orig: v,
      color: ownerOf(v)?.row.color ?? defaultVariantColor(i),
      number: activeScenario.variant_quantities?.[v] ?? 0,
      name: ownerOf(v)?.row.name ?? '',
      interval: activeScenario.variant_intervals?.[v] ?? null,
      start: ownerOf(v)?.start ?? stationKey(starts[0]),
    }))
  }

  // A product's job colour set from the Start's properties: written into that
  // Start's own MU table (the product's row is added when it has none yet).
  const setProductColor = (id: string, mu: string, color: string) => {
    // The Start that releases it (its table lists it), else this one.
    const start = startBoxes.find((st) => startTableOf(st).some((x) => x.mu === mu))
      ?? nodes.find((n) => n.id === id)
    if (!start) return
    id = start.id
    const table = startTableOf(start)
    const next = table.some((x) => x.mu === mu)
      ? table.map((x) => (x.mu === mu ? { ...x, color } : x))
      : [...table, {
          mu, name: '', color,
          number: activeScenario?.variant_quantities?.[mu] ?? 0,
          interval: activeScenario?.variant_intervals?.[mu] ?? null,
        }]
    updateNode(id, { muTable: next })
  }

  // Each product's colour (Start's MU table, else the defaults) for the
  // moving jobs. Kept stable while the colours don't change, so the replay
  // doesn't re-read the run on every canvas edit.
  const variantColorsNow = (() => {
    const start = nodes.find((n) => inferStationType(n.data.label, n.data.stationType) === 'Source')
    const rows = start
      ? muTableRows(start)
      : Object.keys(activeScenario?.processflow_data ?? {}).map((v, i) => ({ mu: v, color: defaultVariantColor(i) }))
    return Object.fromEntries(rows.map((r) => [r.mu, r.color ?? '']))
  })()
  const variantColorsKey = JSON.stringify(variantColorsNow)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const variantColors = useMemo(() => variantColorsNow, [variantColorsKey])

  // Apply on the MU table saves straight to the scenario: each row is a
  // product — its quantity and interval; a renamed MU renames the product
  // everywhere (route, quantity, interval, setup matrix); a new row gets a
  // copy of the chosen product's route; a deleted row takes its route with
  // it. Name is kept in the Start's own settings.
  const applyMuTable = async (startNode: Node<StationNodeData>, rows: MuDialogRow[]) => {
    // Each Start keeps its own products in its own MU table.
    const starts = startBoxes.length > 0 ? startBoxes : [startNode]
    const isStart = (n: Node<StationNodeData>) => starts.some((st) => st.id === n.id)
    const ownRows = (st: Node<StationNodeData>) => rows.filter((r) => (r.start ?? stationKey(startNode)) === stationKey(st))
    const tableOf = (st: Node<StationNodeData>): MuRow[] => ownRows(st)
      .map(({ mu, number, name, interval, color }) => ({ mu, number, name, interval: interval ?? null, color }))
    // A Start's Exit Controller entries follow its renamed products; deleted
    // (or moved to another Start) ones go, new ones start unset.
    const byProduct = (st: Node<StationNodeData>, values?: Record<string, number>) => (values ? Object.fromEntries(
      ownRows(st).filter((r) => r.orig !== undefined && r.orig in values).map((r) => [r.mu, values[r.orig!]]),
    ) : undefined)
    const setStartTable = () => setNodes((nds) => nds.map((n) => (
      isStart(n)
        ? { ...n, data: { ...n.data, muTable: tableOf(n), muPriorities: byProduct(n, n.data.muPriorities), muPercentages: byProduct(n, n.data.muPercentages) } }
        : n
    )))
    if (!activeScenario) {
      setStartTable()
      return
    }
    try {
      const fresh = await scenariosApi.get(activeScenario.id)
      const flow = fresh.processflow_data ?? {}
      const renamed: Record<string, string> = {}
      for (const r of rows) if (r.orig !== undefined) renamed[r.orig] = r.mu
      const processflow: ScenarioCreate['processflow_data'] = {}
      const quantities: Record<string, number> = {}
      const intervals: Record<string, number> = {}
      for (const r of rows) {
        const source = r.orig !== undefined ? r.orig : r.copyFrom
        processflow[r.mu] = JSON.parse(JSON.stringify(source !== undefined ? flow[source] ?? [] : []))
        quantities[r.mu] = r.number
        if (r.interval != null && r.interval > 0) intervals[r.mu] = r.interval
      }
      // Setup matrix pairs ("from|to") follow renames; pairs of a deleted product go.
      const setupMatrix: Record<string, Record<string, number>> = {}
      for (const [station, pairs] of Object.entries(fresh.setup_matrix ?? {})) {
        const kept: Record<string, number> = {}
        for (const [key, minutes] of Object.entries(pairs)) {
          const [from, to] = key.split('|')
          const f = from in renamed ? renamed[from] : from in processflow ? from : undefined
          const t = to in renamed ? renamed[to] : to in processflow ? to : undefined
          if (f !== undefined && t !== undefined) kept[`${f}|${t}`] = minutes
        }
        if (Object.keys(kept).length > 0) setupMatrix[station] = kept
      }
      // Name lives in the Start's settings (a Start, so the engine skips it).
      const stations = { ...(fresh.stations_data ?? {}) }
      // Route by product ticks follow renamed products; a deleted product's go.
      const followProducts = (routes?: Record<string, string[]>) => (routes ? Object.fromEntries(
        Object.entries(routes).filter(([p]) => p in renamed).map(([p, to]) => [renamed[p], to]),
      ) : routes)
      for (const [name, cfg] of Object.entries(stations)) {
        if (cfg['Product Routes']) stations[name] = { ...cfg, 'Product Routes': followProducts(cfg['Product Routes']) }
      }
      for (const st of starts) {
        const key = stationKey(st)
        const muPriorities = byProduct(st, st.data.muPriorities)
        const muPercentages = byProduct(st, st.data.muPercentages)
        stations[key] = {
          ...(stations[key] ?? { 'Station Type': 'Source', capacity: 1, shifts_per_day: 1, operator_per_station: 0 }),
          'MU Table': tableOf(st),
          'MU Strategy': st.data.muStrategy ?? stations[key]?.['MU Strategy'] ?? 'cyclic',
          ...(muPriorities ? { 'MU Priorities': muPriorities } : {}),
          ...(muPercentages ? { 'MU Percentages': muPercentages } : {}),
        } as StationConfig
      }
      // Lines on the drawing follow the products: renamed, copied for a new
      // product, gone with a deleted one.
      const retag = (products: string[]) => {
        const next = new Set<string>()
        for (const p of products) if (p in renamed) next.add(renamed[p])
        for (const r of rows) if (r.orig === undefined && r.copyFrom && products.includes(r.copyFrom)) next.add(r.mu)
        return Array.from(next)
      }
      const savedRoutes = fresh.canvas_layout?.routes
      const layout = fresh.canvas_layout
        ? {
            ...fresh.canvas_layout,
            lines: fresh.canvas_layout.lines.flatMap((l) => {
              if (!l.products || l.products.length === 0) return [l]
              const products = retag(l.products)
              return products.length > 0 ? [{ ...l, products }] : []
            }),
            routes: savedRoutes
              ? Object.fromEntries(rows.flatMap((r) => {
                  const from = r.orig ?? r.copyFrom
                  return from !== undefined && savedRoutes[from] !== undefined ? [[r.mu, savedRoutes[from]]] : []
                }))
              : undefined,
          }
        : undefined
      const updated = await scenariosApi.update(activeScenario.id, {
        processflow_data: processflow,
        variant_quantities: quantities,
        variant_intervals: intervals,
        setup_matrix: setupMatrix,
        stations_data: stations,
        ...(layout ? { canvas_layout: layout } : {}),
      })
      queryClient.invalidateQueries({ queryKey: ['scenarios'] })
      setActiveScenario(updated)
      setStartTable()
      setNodes((nds) => nds.map((n) => (
        n.data.productRoutes ? { ...n, data: { ...n.data, productRoutes: followProducts(n.data.productRoutes) } } : n
      )))
      setEdges((eds) => eds.flatMap((e) => {
        const ps = edgeProducts(e)
        if (!ps || ps.length === 0) return [e]
        const products = retag(ps)
        return products.length > 0 ? [withProducts(e, products)] : []
      }))
      // The product on the canvas follows its rename; if it was deleted,
      // open another one.
      const shown = buildVariant ?? selectedVariant
      if (shown && shown in renamed && renamed[shown] !== shown) {
        setBuildVariant(renamed[shown])
        setSelectedVariant(renamed[shown])
      } else if (shown && !(shown in renamed)) {
        const next = Object.keys(processflow)[0]
        if (next) openProduct(next)
      }
      showToast('Products saved')
    } catch (err) {
      showToast((err as Error).message || 'Could not save the products', 'error')
      throw err
    }
  }

  // Routes table. A product's ticks are the stations on its lines; Apply
  // gives each product the lines between its ticked stations, the line from
  // its own Start and the line into End — the order of the route still
  // comes from the drawing. The drawing itself never changes.
  const isRouteStation = (n: Node<StationNodeData>) => {
    const t = inferStationType(n.data.label, n.data.stationType)
    return t !== 'Source' && t !== 'Drain' && !isWiringNode(n)
  }
  const routeTicksNow = (): Record<string, string[]> => Object.fromEntries(variants.map((p) => [p, Array.from(new Set(
    edges.filter((e) => isFlowEdge(e, nodeById) && lineIsFor(e, p, buildVariant))
      .flatMap((e) => [nodeById.get(e.source)!, nodeById.get(e.target)!])
      .filter(isRouteStation)
      .map(groupKey),
  ))]))
  // The Start(s) a product comes from: its "Released from" in the MU table.
  const releasingStarts = (p: string): Node<StationNodeData>[] => {
    if (startBoxes.length < 2) return startBoxes
    const owner = muTableRows(startBoxes[0]).find((r) => r.mu === p)?.start
    const own = startBoxes.filter((st) => stationKey(st) === owner)
    return own.length > 0 ? own : startBoxes
  }
  const routeLines = (p: string, ticked: string[]): Set<string> => {
    const on = (n: Node<StationNodeData>) => isRouteStation(n) && ticked.includes(groupKey(n))
    const starts = new Set(releasingStarts(p).map((n) => n.id))
    const flow = edges.filter((e) => isFlowEdge(e, nodeById))
    const middle = flow.filter((e) => on(nodeById.get(e.source)!) && on(nodeById.get(e.target)!))
    const fromStart = flow.filter((e) => starts.has(e.source) && on(nodeById.get(e.target)!))
    const toEnd = flow.filter((e) => on(nodeById.get(e.source)!)
      && inferStationType(nodeById.get(e.target)!.data.label, nodeById.get(e.target)!.data.stationType) === 'Drain'
      && !middle.some((m) => m.source === e.source))
    return new Set([...middle, ...fromStart, ...toEnd].map((e) => e.id))
  }
  const routeProblems = (ticks: Record<string, string[]>): string[] => variants.flatMap((p) => {
    const ticked = ticks[p] ?? []
    if (ticked.length === 0) return [`${p}: tick at least one station.`]
    const lines = edges.filter((e) => routeLines(p, ticked).has(e.id))
    const reached = new Set<string>()
    let frontier = releasingStarts(p).map((n) => n.id)
    const seen = new Set(frontier)
    while (frontier.length > 0) {
      const next: string[] = []
      for (const id of frontier) {
        for (const e of lines.filter((l) => l.source === id)) {
          const n = nodeById.get(e.target)!
          if (isRouteStation(n)) reached.add(groupKey(n))
          if (!seen.has(n.id)) { seen.add(n.id); next.push(n.id) }
        }
      }
      frontier = next
    }
    const starts = releasingStarts(p).map((n) => n.data.label).join(' / ') || 'a Start'
    return ticked.filter((st) => !reached.has(st))
      .map((st) => `${p}: ${st} is ticked, but no line reaches it from ${starts} through its ticked stations — draw the line or untick it.`)
  })
  const applyRoutes = (ticks: Record<string, string[]>) => {
    const linesOf = Object.fromEntries(variants.map((p) => [p, routeLines(p, ticks[p] ?? [])]))
    setEdges((eds) => eds.map((e) => {
      if (!isFlowEdge(e, nodeById)) return e
      const had = edgeProducts(e) ?? (buildVariant ? [buildVariant] : [])
      const kept = had.filter((p) => !variants.includes(p))
      return withProducts(e, [...kept, ...variants.filter((p) => linesOf[p].has(e.id))])
    }))
  }

  const pickBuildProduct = (v: string) => {
    if (v === (buildVariant ?? selectedVariant)) return
    if (canvasDirty) {
      setSwitchTarget(v)
      return
    }
    openProduct(v)
  }

  const onBuild = mode === 'build'
  // Run (and Stop while running) sit at the right end of the replay bar, next to Sim setting, in Build and in 3D alike.
  // The replay bar is always there, in Build and 3D, and carries Sim setting. With no run to
  // replay (a new or not-yet-run scenario, an empty Workspace) it is greyed out: only Sim
  // setting works, and its Start / End / Run for / Elapsed show "—".
  const runButtons = (
    <>
      <Button
        onClick={() => runNow()}
        disabled={sim.isRunning || saveMutation.isPending}
        title={canvasDirty || !activeScenario ? 'Saves the scenario, then runs it' : 'Run the saved scenario'}
        size="sm"
        className="h-[30px] rounded-lg px-3 text-xs"
      >
        {sim.isRunning ? <><RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" />Running{sim.progress ? ` ${Math.round(sim.progress.pct)}%` : '…'}</> : <><Play className="h-3.5 w-3.5 mr-1.5" />Run</>}
      </Button>
      {(sim.isRunning || sim.displayRun?.status === 'running') && (
        <Button
          variant="outline"
          onClick={sim.stop}
          disabled={sim.stopPending || !sim.canStop}
          size="sm"
          className="h-[30px] rounded-lg border-red-200 px-3 text-xs text-red-600 hover:bg-red-50"
          title="Stop this run at its next checkpoint — partial results are kept"
        >
          <Square className="h-3.5 w-3.5 mr-1.5" />
          {sim.stopPending ? 'Stopping…' : 'Stop'}
        </Button>
      )}
    </>
  )
  const replayShown = !!completionLog && (mode === 'view' ? scene3D.machines.length > 0 : activeRun?.status === 'completed')
  const idleReplayBar = replayShown ? null : (
    <IdleReplayBar
      startDate={sim.simCfg.SIMULATION_START_DATE}
      settings={<div className="flex items-center gap-1.5"><SimSettingsMenu compact up onConfig={() => openSimDialog('config')} onTimer={() => openSimDialog('timer')} />{runButtons}</div>}
    />
  )
  const on3d = mode === 'view'
  const segBtn = (active: boolean, disabled?: boolean) =>
    `h-7 rounded-full px-4 text-[12.5px] font-bold font-display transition-colors disabled:opacity-40 ${active ? 'bg-ls-card text-ls-ink shadow-md' : 'text-ls-ink2 hover:text-ls-ink'}${disabled ? '' : ''}`
  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Sub bar: how to look at the line, and what the colours mean */}
      <div className="no-print flex h-[50px] shrink-0 items-center justify-between gap-3 border-b border-ls-line bg-ls-card px-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex rounded-full bg-ls-chip p-[3px]">
            <button onClick={() => setMode('build')} className={segBtn(onBuild)}>Build</button>
            <button
              onClick={() => { setMode('view') }}
              disabled={!activeScenario || !can3d}
              title={can3d ? undefined : 'The 3D view is not included in your LinkSim license'}
              className={segBtn(on3d)}
            >3D</button>
          </div>
          {activeRun?.status === 'completed' && (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-ls-page px-2.5 py-1 text-[11.5px] font-semibold text-ls-ink2">
              <span className="h-1.5 w-1.5 rounded-full bg-ls-ok" />Run #{activeRun.id} completed
            </span>
          )}
        </div>
        {activeRun?.status === 'completed' && (
          <div className="flex shrink-0 items-center gap-2 max-lg:hidden">
            {STATUS_LEGEND.map((st) => (
              <span key={st.key} className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold" style={{ background: st.tint, color: st.ink }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: st.color }} />
                {st.label} {st.range}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Sidebar (Build only) */}
      {mode !== 'view' && <aside className={`relative border-r border-gray-100 bg-white flex flex-col shadow-sm transition-all duration-300 ${sidebarCollapsed ? 'w-10' : 'w-56'}`}>
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

        {!sidebarCollapsed && <>{(
          <div className="flex-1 p-4 overflow-auto">
            <p className="font-display text-sm font-bold text-ls-ink mb-2.5">Object library</p>
            <Input
              value={paletteQuery}
              onChange={(e) => setPaletteQuery(e.target.value)}
              placeholder="Search objects…"
              className="h-9 mb-1"
            />
            {[
              { group: 'Flow', labels: ['Source', 'Drain'] },
              { group: 'Processing', labels: ['Station', 'Parallel Station', 'Assembly', 'Dismantle', 'Robot'] },
              { group: 'Material', labels: ['Buffer', 'Conveyor', 'Movable Part'] },
              { group: 'Operator', labels: ['Workplace', 'Worker', 'Worker Controller'] },
            ].map(({ group, labels }) => {
              const q = paletteQuery.trim().toLowerCase()
              const items = labels
                .map((l) => PALETTE_ITEMS.find((it) => it.label === l))
                .filter((it): it is (typeof PALETTE_ITEMS)[number] => !!it
                  && (!q || (it.displayLabel ?? it.label).toLowerCase().includes(q) || it.description.toLowerCase().includes(q)))
              if (items.length === 0) return null
              return (
                <div key={group}>
                  <div className="mt-3.5 mb-1 flex justify-between text-[11px] font-bold uppercase tracking-wider text-ls-mute">
                    <span>{group}</span><span>{items.length}</span>
                  </div>
                  {items.map((item) => (
                    <button
                      key={item.label}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('application/linksim-palette-item', item.label)
                        e.dataTransfer.effectAllowed = 'move'
                      }}
                      onClick={() => addNode(item.label, undefined, item.displayLabel)}
                      className="w-full flex items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left transition-colors hover:bg-ls-soft cursor-grab active:cursor-grabbing"
                    >
                      <span className="w-10 h-10 shrink-0 rounded-[10px] bg-ls-soft flex items-center justify-center">
                        <IsoIcon type={item.label} color={STATION_TYPE_HEX[item.label] ?? DEFAULT_STATION_HEX} />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium text-ls-ink leading-tight">{item.displayLabel ?? item.label}</span>
                        <span className="block text-[10.5px] text-ls-mute leading-tight mt-0.5">{item.description}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )
            })}
            <p className="mt-4 border-t border-ls-line pt-3 text-[11px] text-ls-mute">Drag onto the canvas, or click to drop it in</p>
          </div>
        )}
        </>}
      </aside>}

      {/* Canvas */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 bg-white shadow-sm">
          {mode === 'view' ? (
            <>
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-gray-900">{activeScenario?.name ?? 'No scenario'}</span>
                {selectedVariant && (
                  <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
                    {variants.map((v) => (
                      <button
                        key={v}
                        onClick={() => setSelectedVariant(v)}
                        className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                          v === selectedVariant ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                        }`}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                )}
                <span className="text-xs text-gray-400">{viewNodes.length} operations</span>
              </div>
              <div className="flex items-center gap-2">
                {activeRun?.status === 'completed' && (
                  <span className="text-xs font-semibold text-green-700 bg-green-50 border border-green-200 px-3 py-1 rounded-full">
                    Run #{activeRun.id} overlaid
                  </span>
                )}
                <Button variant="outline" onClick={() => navigate('/run')} className="rounded-full px-4">
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
              {/* Product picker: the canvas shows (and Save writes) one
                  product's line; the other products are kept as they are. */}
              {activeScenario && variants.length > 0 && (
                <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
                  {variants.map((v) => (
                    <button
                      key={v}
                      onClick={() => pickBuildProduct(v)}
                      className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                        v === (buildVariant ?? selectedVariant) ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              )}
              {activeScenario && variants.length > 0 && nodes.length > 0 && (
                <button
                  onClick={() => { setRoutesOpen((o) => !o); setSelectedNode(null); setSelectedEdgeId(null) }}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${routesOpen
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'text-indigo-600 bg-indigo-50 hover:bg-indigo-100 border-indigo-100'}`}
                >
                  Routes
                </button>
              )}
              <span className="text-xs text-gray-400">{nodes.length} stations · {edges.length} connections</span>
              {muDialogNodeId && (() => {
                const startNode = nodes.find((n) => n.id === muDialogNodeId)
                if (!startNode) return null
                return (
                  <MuTableDialog
                    startName={stationKey(startNode)}
                    starts={startBoxes.map(stationKey)}
                    initial={muTableRows(startNode)}
                    onApply={(rows) => applyMuTable(startNode, rows)}
                    onClose={() => setMuDialogNodeId(null)}
                  />
                )
              })()}
              {pendingDelete && (
                <ConfirmDeleteDialog
                  stations={pendingDelete.nodeIds.length}
                  lines={pendingDelete.edgeIds.length}
                  onDelete={confirmDelete}
                  onClose={() => setPendingDelete(null)}
                />
              )}
              {switchTarget && (
                <SwitchProductDialog
                  from={buildVariant ?? selectedVariant}
                  to={switchTarget}
                  saving={saveMutation.isPending}
                  onSave={() => {
                    const target = switchTarget
                    handleSave(false, () => { setSwitchTarget(null); openProduct(target) })
                  }}
                  onDiscard={() => { const target = switchTarget; setSwitchTarget(null); openProduct(target) }}
                  onClose={() => setSwitchTarget(null)}
                />
              )}
              <div className="flex items-center gap-2">
              {activeScenario && (
                <Button
                  variant="outline"
                  title="Checks the saved scenario: every process-flow step must name a real station"
                  onClick={async () => {
                    try {
                      const v = await scenariosApi.validate(activeScenario.id)
                      const first = v.issues[0]
                      showToast(
                        v.issue_count === 0
                          ? 'Flow valid — every step has its station'
                          : `${v.issue_count} issue${v.issue_count === 1 ? '' : 's'}: ${first.variant} · "${first.resource}" ${first.type === 'case_mismatch' ? `should be "${first.resolved_to}"` : 'is not a station'}`,
                        v.issue_count === 0 ? 'success' : 'error',
                      )
                    } catch (err) {
                      showToast((err as Error).message, 'error')
                    }
                  }}
                  className="rounded-full px-4"
                >
                  Check flow
                </Button>
              )}
              <Button
                disabled={saveMutation.isPending}
                onClick={() => handleSave(true)}
                className="rounded-full px-4"
              >
                <Save className="h-3.5 w-3.5 mr-1.5" />
                {saveMutation.isPending ? 'Saving…' : 'Save Scenario'}
              </Button>
              </div>
            </>
          )}
        </div>

        {/* Flow + property panel */}
        <div className="flex-1 flex min-h-0">
          <div className="relative flex-1 min-h-0" style={{ height: '100%' }}>
            {mode === 'view' && idleReplayBar && (
              <div className="absolute bottom-4 left-1/2 z-10 w-[min(900px,calc(100%-28px))] -translate-x-1/2">
                {/* 3D only replays: no Sim setting or Run here (they are in Build). */}
                <IdleReplayBar startDate={sim.simCfg.SIMULATION_START_DATE} settings={null} />
              </div>
            )}
            {mode === 'view' ? (
                scene3D.machines.length > 0 ? (
                  <Scene
                    machines={scene3D.machines}
                    operators={scene3D.operators}
                    connections={scene3D.connections}
                    stepLabels={scene3D.stepLabels}
                    props={scene3D.props}
                    stationsData={activeScenario!.stations_data}
                    operatorsData={activeScenario!.operators_data}
                    isDark={isDark}
                    completionLog={completionLog}
                    workerPool={activeRun?.result?.worker_pool_stats}
                    assemblies={assemblies3D}
                    dismantles={dismantles3D}
                    variantColors={variantColors}
                    outcomes={outcomes3D}
                    runMinutes={activeRun?.simulation_time ?? undefined}
                    runStartMs={runStartMs}
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
                nodes={visibleNodes}
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
                onNodeClick={(_, node) => {
                  setSelectedNode(node as Node<StationNodeData>)
                  setSelectedEdgeId(null)
                  setRoutesOpen(false)
                  // Clicking Start opens its MU table.
                  const data = (node as Node<StationNodeData>).data
                  if (inferStationType(data.label, data.stationType) === 'Source') setMuDialogNodeId(node.id)
                }}
                onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); setSelectedNode(null); setRoutesOpen(false) }}
                onPaneClick={() => { setSelectedNode(null); setSelectedEdgeId(null) }}
                nodesDraggable
                elementsSelectable
                panOnDrag
                selectionOnDrag={false}
                // Shift + drag on empty space draws a selection box: the
                // stations fully inside it, and the lines between them, are
                // selected — move them together, Delete them (after a
                // confirmation), or Ctrl+C / Ctrl+V them (see the keyboard
                // handler). Plain drag still moves the canvas. No Ctrl/Cmd +
                // click multi-select.
                selectionKeyCode="Shift"
                selectionMode={SelectionMode.Full}
                multiSelectionKeyCode={null}
                deleteKeyCode={null}
                // Several things selected: the side panel shows none of them.
                onSelectionChange={({ nodes: picked, edges: pickedEdges }) => {
                  if (picked.length + pickedEdges.length > 1) {
                    setSelectedNode(null)
                    setSelectedEdgeId(null)
                  }
                }}
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
                {activeRun?.status === 'completed' && completionLog && (
                  <JobReplay
                    completionLog={completionLog}
                    releaseTimes={replayState?.job_release_times}
                    finishTimes={replayState?.job_finish_times}
                    assemblies={replayState?.assemblies}
                    dismantles={replayState?.dismantles}
                    targets={replayTargets}
                    variantColors={variantColors}
                    runMinutes={activeRun?.simulation_time ?? undefined}
                    runControls={runButtons}
                  />
                )}
                {idleReplayBar && (
                  <Panel position="bottom-center">
                    <div className="w-[min(900px,calc(100vw-80px))]">{idleReplayBar}</div>
                  </Panel>
                )}
              </ReactFlow>
              </div>
            )}
          </div>

          {/* Routes panel — from the Routes button in the top bar. */}
          {mode === 'build' && routesOpen && !selectedNode && !selectedEdgeId && (
            <div className="w-56 border-l border-gray-200 bg-white p-3 overflow-y-auto">
              <RoutesPanel
                products={variants}
                stations={routeStations}
                colors={variantColorsNow}
                initial={routeTicksNow()}
                problemsOf={routeProblems}
                onApply={applyRoutes}
                onClose={() => setRoutesOpen(false)}
              />
            </div>
          )}

          {/* Build mode property panel */}
          {mode === 'build' && selectedNode && (
            <div className="w-56 border-l border-gray-200 bg-white p-3 overflow-y-auto">
              <PropertyEditor
                node={selectedNode}
                nodes={nodes}
                edges={productEdges}
                allEdges={edges}
                onChange={updateNode}
                onDelete={deleteNode}
                onSaveStation={() => { setSelectedNode(null); handleSave(false) }}
                onAddParallel={addParallelMachine}
                onOpenMuTable={setMuDialogNodeId}
                productColors={variantColors}
                onProductColor={setProductColor}
                products={variants}
                startProducts={inferStationType(selectedNode.data.label, selectedNode.data.stationType) === 'Source'
                  ? muTableRows(selectedNode).filter((r) => r.start === stationKey(selectedNode)).map((r) => r.mu)
                  : []}
                allStartProducts={inferStationType(selectedNode.data.label, selectedNode.data.stationType) === 'Source'
                  ? muTableRows(selectedNode).map((r) => r.mu)
                  : []}
                onAddWorkplace={addWorkplaceFor}
                onRemoveWorkplace={removeWorkplaceFor}
                onToggleWire={toggleWire}
                onAssignOperator={assignOperatorToController}
                onUnassignOperator={unassignOperatorFromController}
                numShifts={numShifts}
                shiftNames={shiftNames}
                operatorsData={activeScenario?.operators_data ?? {}}
                workerResults={Object.fromEntries(Object.values(activeRun?.result?.worker_pool_stats ?? {})
                  .flatMap((p) => (p.workers ?? []).map((w) => [w.name, w] as const)))}
                stationStates={(activeRun?.result?.station_states as Record<string, StationStateStat> | undefined) ?? {}}
                bufferStates={(activeRun?.result?.buffer_states as Record<string, BufferStateStat> | undefined) ?? {}}
                partsFlow={activeRun?.result?.parts_flow as PartsFlow | undefined}
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
                    className="w-full py-2 text-xs font-semibold text-ls-card bg-ls-dark hover:opacity-90 rounded-xl transition-colors"
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

        {/* Run + settings, shared with the Analysis page */}
        <SimDialogsHost sim={sim} onRun={runNow} />
      </div>
      </div>
    </div>
  )
}
