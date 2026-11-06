import type { Node, Edge } from 'reactflow'
import type { ProcessStep, StationConfig, StationStat, OperatorConfig, StationNodeData } from '@/types'
import { inferStationType } from '@/lib/stationTypes'

export interface Machine3D {
  id: string
  position: [number, number, number]
  label: string
  baseName: string
  stationType: string
  // Which way the line runs through this station: 1 = +x, -1 = -x.
  flowDir: 1 | -1
  capacity: number
  machineIndex: number
  machineCount: number
  utilization: number
  stats?: StationStat
  steps: ProcessStep[]
  height: number
  width: number
  queueDepth: number
  // Exit Controller order when this station splits into several next stations.
  routing?: string
}

export interface Operator3D {
  id: string
  name: string
  skill: number
  availability: number
  machineId: string
  position: [number, number, number]
  index: number
  totalCount: number
}

export interface Connection3D {
  id: string
  from: [number, number, number]
  to: [number, number, number]
  operation: string
  duration: number
  fromStation: string
  toStation: string
  // A line of another product (Build fades these when a product is picked).
  dim?: boolean
}

export interface StepLabel {
  position: [number, number, number]
  text: string
}

// Non-processing objects the 2D view also shows — Start/End endpoints and the
// Workplace / Worker Controller / pool Worker wiring. Kept out of `machines`
// so the job markers and the MachineDetail panel never see them.
export interface Prop3D {
  id: string
  stationType: string
  position: [number, number, number]
  label?: string
  labelScale?: number
  // Stations whose activity animates this object; absent = the whole line
  // (Start/End run whenever any job is in process).
  stations?: string[]
  // The Start's product release order (its Exit Controller), when it has one.
  routing?: string
}

// 2D Build units -> 3D units. Build's column gap (260px) is one 7-unit column,
// which also makes its row gap (190px) about 5 units. A free layout whose boxes
// sit closer than MIN_GAP is scaled up as a whole so models never overlap.
const SCALE = 7 / 260
const MIN_GAP = 3.4
const MAX_PAIRWISE = 600 // beyond this the O(n²) spacing check is skipped
const MAX_COLS = 8 // a line with more columns than this wraps onto rows...
const COLS_PER_ROW = 6 // ...of this many
const ROW_GAP = 8.75 // free space between wrapped rows

// Types that are wiring/endpoints rather than machines a job is processed on.
// Worker-pool wiring: drawn near the station it serves rather than in the line.
const POOL_TYPES = new Set(['Workplace', 'Worker', 'Worker Controller'])
const PROP_TYPES = new Set(['Source', 'Drain', 'Workplace', 'Worker', 'Worker Controller'])

const optionsOf = (r: ProcessStep['resource']): string[] => (typeof r === 'string' ? [r] : r.options ?? [])
const baseOf = (n: Node<StationNodeData>) => n.data.savedName ?? n.data.label.replace(/\s+#\d+$/, '')
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function utilColor(u: number): string {
  if (u >= 85) return '#F04438'
  if (u >= 70) return '#F59E0B'
  if (u >= 40) return '#12B76A'
  return '#3E8BF5'
}

export { utilColor }

/**
 * Builds the 3D scene from the same boxes and arrows the 2D Build canvas draws
 * (`nodes` / `edges`), so a change to what Build shows reaches 3D with no 3D
 * edit: positions, machines, flow arrows, Start/End, worker pools and Exit
 * Controller routing all come from the graph. `processflow` / `stationsData`
 * only supply per-machine detail (steps, operators); utilization comes from
 * `stationStats`.
 */
export function buildScene3D(
  nodes: Node<StationNodeData>[],
  edges: Edge[],
  processflow: Record<string, ProcessStep[]>,
  variant: string,
  stationsData: Record<string, StationConfig>,
  operatorsData: Record<string, OperatorConfig>,
  stationStats: StationStat[],
  // Wrap a very long line onto rows. Off for a saved drawing, whose positions are mirrored exactly.
  wrapLongLines = true,
): { machines: Machine3D[]; operators: Operator3D[]; connections: Connection3D[]; stepLabels: StepLabel[]; props: Prop3D[] } {
  const steps = processflow[variant] ?? []
  const statsMap = new Map(stationStats.map(s => [s.station_name, s]))
  const typeOf = (n: Node<StationNodeData>) => inferStationType(n.data.label, n.data.stationType)

  // 2D position -> 3D x/z, centred on the origin, scaled up if boxes are too close.
  let scale = SCALE
  if (nodes.length > 1 && nodes.length <= MAX_PAIRWISE) {
    let min = Infinity
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const d = Math.hypot(nodes[i].position.x - nodes[j].position.x, nodes[i].position.y - nodes[j].position.y)
        if (d > 0 && d < min) min = d
      }
    }
    if (min * SCALE < MIN_GAP) scale = MIN_GAP / min
  }
  const xs = nodes.map(n => n.position.x)
  const ys = nodes.map(n => n.position.y)
  const cx = nodes.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0
  const cy = nodes.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 0
  const placed = new Map<string, [number, number]>(
    nodes.map(n => [n.id, [(n.position.x - cx) * scale, (n.position.y - cy) * scale]]),
  )

  const out = new Map<string, string[]>()
  const into = new Map<string, string[]>()
  for (const e of edges) {
    out.set(e.source, [...(out.get(e.source) ?? []), e.target])
    into.set(e.target, [...(into.get(e.target) ?? []), e.source])
  }
  const byId = new Map(nodes.map(n => [n.id, n]))

  // A line wider than MAX_COLS columns would be one very long hall, so past
  // that it continues on further rows, snaking back and forth. Every box in a
  // column stays together; worker-pool boxes keep their offset from the
  // station they serve. Shorter lines are left as exact mirrors of Build.
  const rowOfNode = new Map<string, number>()
  const lineNodes = nodes.filter(n => !POOL_TYPES.has(typeOf(n)))
  const colXs = [...new Set(lineNodes.map(n => n.position.x))].sort((a, b) => a - b)
  if (wrapLongLines && colXs.length > MAX_COLS) {
    const colIndex = new Map(colXs.map((x, i) => [x, i]))
    const colStep = Math.max(((colXs[colXs.length - 1] - colXs[0]) / (colXs.length - 1)) * scale, 1)
    const rows = Math.ceil(colXs.length / COLS_PER_ROW)
    const rowOfCol = (i: number) => Math.floor(i / COLS_PER_ROW)
    const span = Array.from({ length: rows }, () => ({ min: Infinity, max: -Infinity }))
    for (const n of lineNodes) {
      const s = span[rowOfCol(colIndex.get(n.position.x)!)]
      s.min = Math.min(s.min, n.position.y)
      s.max = Math.max(s.max, n.position.y)
    }
    const height = span.map(s => (s.max - s.min) * scale)
    const rowZ = [0]
    for (let r = 1; r < rows; r++) rowZ.push(rowZ[r - 1] + height[r - 1] / 2 + height[r] / 2 + ROW_GAP)
    const zMid = rowZ[rows - 1] / 2
    for (const n of lineNodes) {
      const i = colIndex.get(n.position.x)!
      const r = rowOfCol(i)
      const k = r % 2 === 1 ? COLS_PER_ROW - 1 - (i % COLS_PER_ROW) : i % COLS_PER_ROW
      const x = (k - (COLS_PER_ROW - 1) / 2) * colStep
      const z = rowZ[r] - zMid + (n.position.y - (span[r].min + span[r].max) / 2) * scale
      placed.set(n.id, [x, z])
      rowOfNode.set(n.id, r)
    }
    // Pool boxes (Workplace / Controller / Worker): follow the line box they hang off.
    for (const n of nodes) {
      if (!POOL_TYPES.has(typeOf(n))) continue
      let anchor: Node<StationNodeData> | undefined
      let frontier = [n.id]
      for (let hop = 0; hop < 3 && !anchor; hop++) {
        const next: string[] = []
        for (const id of frontier) {
          for (const t of [...(out.get(id) ?? []), ...(into.get(id) ?? [])]) {
            const m = byId.get(t)
            if (m && !POOL_TYPES.has(typeOf(m))) { anchor = anchor ?? m } else next.push(t)
          }
        }
        frontier = next
      }
      if (!anchor) continue
      const [ax, az] = placed.get(anchor.id)!
      placed.set(n.id, [ax + (n.position.x - anchor.position.x) * scale, az + (n.position.y - anchor.position.y) * scale])
    }
  }
  const at = (n: Node<StationNodeData>): [number, number] => placed.get(n.id)!
  const nodesOf = (ids: string[] | undefined) =>
    (ids ?? []).map(id => byId.get(id)).filter((n): n is Node<StationNodeData> => !!n)

  // ── machines (every non-prop box) ──────────────────────────────────────────
  const machineNodes = nodes.filter(n => !PROP_TYPES.has(typeOf(n)))
  const groupSize = new Map<string, number>()
  for (const n of machineNodes) groupSize.set(baseOf(n), (groupSize.get(baseOf(n)) ?? 0) + 1)
  const maxDuration = Math.max(...machineNodes.map(n => n.data.cycleTime ?? 0), 1)

  const machines: Machine3D[] = []
  const machineOf = new Map<string, Machine3D>() // node id -> machine
  const usedIds = new Set<string>()
  for (const n of machineNodes) {
    const base = baseOf(n)
    const count = groupSize.get(base) ?? 1
    const suffix = n.data.label.match(/\s+#(\d+)$/)
    const index = count > 1 && suffix && base !== n.data.label ? Number(suffix[1]) - 1 : 0
    let id = count > 1 ? `${base}#${index + 1}` : base
    if (usedIds.has(id)) id = `${id}@${n.id}`
    usedIds.add(id)

    const stats = statsMap.get(base)
    const util = stats?.station_utilization ?? 0
    const height = 1.2 + ((n.data.cycleTime ?? 0) / maxDuration) * 0.8
    const [x, z] = at(n)
    const dx = nodesOf(out.get(n.id))
      .filter(t => !PROP_TYPES.has(typeOf(t)))
      .reduce((s, t) => s + (t.position.x - n.position.x), 0)

    const machine: Machine3D = {
      id,
      position: [x, height / 2, z],
      label: count > 1 ? `${base} #${index + 1}` : base,
      baseName: base,
      stationType: typeOf(n),
      // On a wrapped line the rows snake: odd rows run the other way.
      flowDir: rowOfNode.has(n.id) ? (rowOfNode.get(n.id)! % 2 === 1 ? -1 : 1) : dx < 0 ? -1 : 1,
      capacity: count,
      machineIndex: index,
      machineCount: count,
      utilization: util,
      stats,
      steps: steps.filter(s => optionsOf(s.resource).includes(base)),
      height,
      width: 2.0 + (count - 1) * 0.3,
      queueDepth: util > 85 ? Math.min(Math.floor((util - 85) / 2), 8) : 0,
    }
    machines.push(machine)
    machineOf.set(n.id, machine)
  }

  // ── operators ──────────────────────────────────────────────────────────────
  // operator_per_station is an explicit count (0 is real: a Buffer or
  // machine-only station has none), so there is no `|| 1` fallback.
  const operators: Operator3D[] = []
  for (const n of machineNodes) {
    const m = machineOf.get(n.id)!
    const cfg = stationsData[m.baseName]
    const opCount = cfg?.operator_per_station ?? n.data.operators ?? 1
    // shift1 is a per-station shift-time override, not an operator name.
    const shiftOp = cfg?.shift1 || 'Operator'
    const opConfig = operatorsData[shiftOp]
    for (let oi = 0; oi < opCount; oi++) {
      const spread = (oi - (opCount - 1) / 2) * 0.7
      operators.push({
        id: `op-${m.id}-${oi}`,
        name: oi === 0 ? shiftOp : `${shiftOp}+${oi}`,
        skill: opConfig?.['Skill Rating'] ?? 3,
        availability: opConfig?.['Availability (%)'] ?? 90,
        machineId: m.id,
        position: [m.position[0] + spread, 0, m.position[2] + 1.6],
        index: oi,
        totalCount: opCount,
      })
    }
  }

  // ── props (Start/End, Workplace, Worker Controller, Worker) ────────────────
  const props: Prop3D[] = []
  const propOf = new Map<string, Prop3D>()
  // Controller id -> stations it staffs (Station -> Workplace -> Controller).
  const staffedBy = new Map<string, string[]>()
  for (const n of nodes) {
    if (typeOf(n) !== 'Worker Controller') continue
    const stations = nodesOf(into.get(n.id)).flatMap(w => nodesOf(into.get(w.id)).map(baseOf))
    staffedBy.set(n.id, [...new Set(stations)])
  }
  let sawStart = false
  let sawEnd = false
  for (const n of nodes) {
    const type = typeOf(n)
    if (!PROP_TYPES.has(type)) continue
    const [x, z] = at(n)
    const prop: Prop3D = { id: `prop-${n.id}`, stationType: type, position: [x, 0, z] }
    if (type === 'Source') {
      // Scene and FactoryShell look the line's first Start / End up by id.
      if (!sawStart) prop.id = 'start'
      sawStart = true
      prop.label = n.data.label
    } else if (type === 'Drain') {
      if (!sawEnd) prop.id = 'end'
      sawEnd = true
      prop.label = n.data.label
    } else if (type === 'Workplace') {
      prop.stations = nodesOf(into.get(n.id)).map(baseOf)
    } else if (type === 'Worker Controller') {
      prop.label = n.data.label
      prop.stations = staffedBy.get(n.id)
    } else if (type === 'Worker') {
      prop.label = n.data.label
      prop.labelScale = 0.55
      const ctrl = (out.get(n.id) ?? []).find(t => staffedBy.has(t))
      prop.stations = ctrl ? staffedBy.get(ctrl) : undefined
    }
    props.push(prop)
    propOf.set(n.id, prop)
  }

  // ── flow: one tube per 2D arrow ────────────────────────────────────────────
  const connections: Connection3D[] = []
  const nameOf = (id: string) => machineOf.get(id)?.baseName ?? byId.get(id)?.data.label ?? ''
  for (const e of edges) {
    const a = machineOf.get(e.source)
    const b = machineOf.get(e.target)
    const pa = propOf.get(e.source)
    const pb = propOf.get(e.target)
    if (!(a || pa) || !(b || pb)) continue
    // A prop has no height of its own — its end of the tube meets the machine's.
    const fromY = a?.position[1] ?? b?.position[1] ?? 0.4
    const toY = b?.position[1] ?? a?.position[1] ?? 0.4
    const from: [number, number, number] = a ? a.position : [pa!.position[0], toY, pa!.position[2]]
    const to: [number, number, number] = b ? b.position : [pb!.position[0], fromY, pb!.position[2]]
    const step = a && b ? a.steps[0] : undefined
    // A flow line the picked product doesn't go along (Build's faded lines).
    const products = (e.data as { products?: string[] } | undefined)?.products
    const dim = !!a && !!b && !POOL_TYPES.has(typeOf(byId.get(e.source)!)) && !POOL_TYPES.has(typeOf(byId.get(e.target)!))
      && products !== undefined && !products.includes(variant)
    connections.push({
      id: `conn-${e.id}`,
      from,
      to,
      operation: step?.operation ?? '',
      duration: step?.duration ?? 0,
      fromStation: nameOf(e.source),
      toStation: nameOf(e.target),
      ...(dim ? { dim: true } : {}),
    })
  }

  // ── labels: "Step N" per column of machines ───
  const stepLabels: StepLabel[] = []
  const columns = new Map<number, Machine3D[]>()
  for (const m of machines) {
    const key = Math.round(m.position[0] * 10)
    columns.set(key, [...(columns.get(key) ?? []), m])
  }
  ;[...columns.entries()].sort((p, q) => p[0] - q[0]).forEach(([, ms], i) => {
    stepLabels.push({
      position: [ms[0].position[0], 0.02, Math.min(...ms.map(m => m.position[2])) - 3.5],
      text: `Step ${i}`,
    })
  })
  // Exit Controller routing, shown beside the station (or Start) that splits.
  for (const n of nodes) {
    const type = typeOf(n)
    // Next stations along the picked product's own lines — a split used only
    // by different products is no choice for any one product.
    const nextOf = (own: boolean) => edges
      .filter(e => e.source === n.id && byId.has(e.target) && !PROP_TYPES.has(typeOf(byId.get(e.target)!)))
      .filter(e => {
        const products = (e.data as { products?: string[] } | undefined)?.products
        return !own || products === undefined || products.includes(variant)
      }).length
    if (type === 'Source') {
      if (n.data.muStrategy && propOf.has(n.id)) propOf.get(n.id)!.routing = `Release: ${cap(n.data.muStrategy)}`
    } else if (machineOf.has(n.id)) {
      if (n.data.routeByProduct && nextOf(false) > 1) machineOf.get(n.id)!.routing = 'Exit: Route by product'
      else if (nextOf(true) > 1) machineOf.get(n.id)!.routing = `Exit: ${cap(n.data.exitStrategy ?? 'cyclic')}`
    }
  }

  return { machines, operators, connections, stepLabels, props }
}
