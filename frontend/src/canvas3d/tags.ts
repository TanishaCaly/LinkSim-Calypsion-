import type { Machine3D, Prop3D, Connection3D } from './layout'

export type TagLevel = 'hidden' | 'dot' | 'pill' | 'compact' | 'card' | 'chip' | 'chipWide'

// One thing in the scene that can wear a tag: a station, a labelled prop, or a
// flow tube. Positions are world coordinates; the projector turns them into pixels.
export interface TagAnchor {
  id: string
  kind: 'station' | 'prop' | 'flow'
  pos: [number, number, number]
  name: string
  step?: number
  station?: string // station name, for its queue
  showQueue?: boolean
  util?: number
  dur?: number
  ops?: number
  routing?: string // Exit Controller order, shown on the full card
  hasRun?: boolean
  detail?: string // flow chip text when zoomed in close
  // workers are only labelled once the screen scale reaches this
  minPpu?: number
}

export interface TagLive {
  level: TagLevel
  queue: number
}

// Screen pixels per world unit where a station's card goes from compact to full.
export const CARD_PPU = 14
// All cards share one scale; it shrinks until they fit, but not below this.
export const MIN_SCALE = 0.35

// 95 -> "95 min", 4000 -> "2h 40m", 4000000 -> "2d 18h"; same wording as the rest of the 3D view.
export function fmtMin(m: number): string {
  if (m < 10) return `${m.toFixed(1)} min`
  if (m < 120) return `${Math.round(m)} min`
  if (m < 2880) return `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`
}

export function tagSize(a: TagAnchor, level: TagLevel): [number, number] {
  switch (level) {
    case 'dot': return [16, 16]
    case 'pill': return [a.kind === 'station' ? 70 + a.name.length * 6.2 : 24 + a.name.length * 6.2, 22]
    case 'compact': return [112, 32]
    case 'card': return [196, 64]
    case 'chip': return [20 + a.name.length * 5.6, 18]
    case 'chipWide': return [20 + (a.detail ?? a.name).length * 5.6, 18]
    default: return [0, 0]
  }
}

export function buildTagAnchors(machines: Machine3D[], props: Prop3D[], connections: Connection3D[]): TagAnchor[] {
  const out: TagAnchor[] = []

  const byStation = new Map<string, Machine3D[]>()
  for (const m of machines) {
    const list = byStation.get(m.baseName)
    if (list) list.push(m)
    else byStation.set(m.baseName, [m])
  }
  // One tag per machine. Utilisation, duration and the queue are the station's
  // (the engine reports them per station), so parallel machines repeat them; the
  // queue badge is only on the first machine so it isn't read as per machine.
  let step = 0
  for (const [station, ms] of byStation) {
    for (const m of ms) {
      out.push({
        id: m.id,
        kind: 'station',
        station,
        showQueue: m.machineIndex === 0,
        pos: [m.position[0], m.height / 2 + 1.6, m.position[2]],
        name: m.label,
        step,
        util: m.utilization,
        dur: m.steps[0]?.duration ?? 0,
        ops: m.steps.length,
        hasRun: m.stats !== undefined,
        routing: m.routing,
      })
    }
    step++
  }

  for (const p of props) {
    if (!p.label) continue
    out.push({
      id: p.id,
      kind: 'prop',
      pos: [p.position[0], 1.6, p.position[2]],
      name: p.routing ? `${p.label} · ${p.routing}` : p.label,
      minPpu: p.labelScale && p.labelScale < 1 ? CARD_PPU : 0,
    })
  }

  // One chip per pair of stations, not per pair of parallel machines.
  const seen = new Set<string>()
  for (const c of connections) {
    if (!c.operation) continue
    const key = `${c.fromStation}>${c.toStation}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      id: c.id,
      kind: 'flow',
      pos: [(c.from[0] + c.to[0]) / 2, (c.from[1] + c.to[1]) / 2 + 0.9, (c.from[2] + c.to[2]) / 2],
      name: `${c.operation} · ${fmtMin(c.duration)}`,
      detail: `${c.fromStation} → ${c.toStation} · ${c.operation} · ${fmtMin(c.duration)}`,
    })
  }
  return out
}
