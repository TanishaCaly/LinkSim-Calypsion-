import { useEffect, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { utilColor } from './layout'
import {
  CARD_PPU, MIN_SCALE, fmtMin, tagSize,
  type TagAnchor, type TagLevel, type TagLive,
} from './tags'

// Tags are HTML laid over the canvas. React renders what a tag says; the
// projector moves and scales them, writing transforms straight into the elements
// so orbiting the camera never re-renders anything.

export interface TagBus {
  live: React.MutableRefObject<TagLive[]>
  // What the overlay last rendered; the projector compares against it to know when to re-render.
  shown: React.MutableRefObject<TagLive[]>
  els: React.MutableRefObject<(HTMLDivElement | null)[]>
  bump: React.MutableRefObject<(() => void) | null>
}

interface ProjectorProps {
  anchors: TagAnchor[]
  bus: TagBus
  queues: React.MutableRefObject<Map<string, number>>
  selected: string | null
}

type Rect = [number, number, number, number]
interface Item { i: number; x: number; y: number; level: TagLevel; prio: number; sel: boolean }

const overlaps = (taken: Rect[], r: Rect) => taken.some(t => r[0] < t[2] && r[2] > t[0] && r[1] < t[3] && r[3] > t[1])

interface Placement { level: TagLevel; dy: number; scale: number }

// Sizes a card may take, largest first; a tube label never goes above 70%.
const SIZES = [1, 0.85, 0.7, 0.55, 0.45, MIN_SCALE]
const CHIP_SIZES = [0.7, 0.55, 0.45]

// Places tags best-first. Each takes the largest size that fits beside the ones
// already placed, trying the slots the loop gives it: a card tries below its
// machine; a tube label also tries further up and down. A card that finds no room
// becomes a dot (always shown); a label is hidden.
function layoutItems(items: Item[], anchors: TagAnchor[], sizes: number[], taken: Rect[], out: Placement[]) {
  for (const it of items) {
    const a = anchors[it.i]
    const [w, h] = tagSize(a, it.level)
    let done = false
    for (const sc of it.sel ? [1] : sizes) {
      const W = w * sc, H = h * sc, step = H + 4
      const slots = a.kind === 'flow' ? [0, step, -step, 2 * step, -2 * step] : a.kind === 'station' ? [0, step] : [0]
      for (const dy of slots) {
        const r: Rect = [it.x - W / 2, it.y + dy - H, it.x + W / 2, it.y + dy]
        if (it.sel || !overlaps(taken, r)) {
          taken.push(r)
          out[it.i] = { level: it.level, dy, scale: sc }
          done = true
          break
        }
      }
      if (done) break
    }
    if (!done) out[it.i] = a.kind === 'station' ? { level: 'dot', dy: 0, scale: 1 } : { level: 'hidden', dy: 0, scale: 1 }
  }
}

export function TagProjector({ anchors, bus, queues, selected }: ProjectorProps) {
  const v = useRef(new THREE.Vector3())
  const forms = useRef(new Map<string, 'card' | 'compact'>())
  // sig: the view the tags were last laid out for; scales: each tag's drawn size, easing back up.
  const cache = useRef({ sig: '', scales: new Map<number, number>(), growing: false })
  const state = useRef({ last: 0, dirty: false })

  useFrame(({ camera, size, clock }, delta) => {
    const cam = camera as THREE.PerspectiveCamera
    cam.updateMatrixWorld() // other rigs moved the camera this frame
    const live = bus.live.current
    const c = cache.current
    if (live.length !== anchors.length) {
      live.length = 0
      for (let i = 0; i < anchors.length; i++) live.push({ level: 'hidden', queue: 0 })
      c.sig = ''
    }

    // Lay the tags out again only when the view changed, or while the scale is
    // still easing back up; a still scene costs nothing.
    const sig = `${cam.matrixWorld.elements.join()}|${cam.fov}|${size.width}x${size.height}|${selected}`
    if (sig !== c.sig || c.growing) {
      c.sig = sig
      const k = size.height / (2 * Math.tan((cam.fov * Math.PI) / 360))

      // Where each anchor lands on screen, and how many pixels a world unit is there.
      const scr: ({ x: number; y: number; ppu: number } | null)[] = []
      const stationPpu = new Map<string, { sum: number; n: number }>()
      for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i]
        v.current.set(a.pos[0], a.pos[1], a.pos[2])
        const dist = cam.position.distanceTo(v.current)
        v.current.project(cam)
        if (v.current.z > 1 || Math.abs(v.current.x) > 1.1 || Math.abs(v.current.y) > 1.1) {
          scr.push(null)
          continue
        }
        const ppu = k / dist
        scr.push({ x: ((v.current.x + 1) / 2) * size.width, y: ((1 - v.current.y) / 2) * size.height, ppu })
        if (a.kind === 'station') {
          const e = stationPpu.get(a.station!) ?? { sum: 0, n: 0 }
          e.sum += ppu; e.n++
          stationPpu.set(a.station!, e)
        }
      }

      // Each station's machines share one form, chosen from the station's zoom
      // (with a 10% buffer so it doesn't flicker at the line).
      for (const [name, e] of stationPpu) {
        const was = forms.current.get(name)
        forms.current.set(name, e.sum / e.n >= CARD_PPU * (was === 'card' ? 0.9 : 1.1) ? 'card' : 'compact')
      }

      const cards: Item[] = []
      const chips: Item[] = []
      for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i], p = scr[i]
        live[i].level = 'hidden'
        if (!p) continue
        if (a.kind === 'station') {
          const sel = a.id === selected
          const prio = sel ? 1e9 : 100 + (a.showQueue ? queues.current.get(a.station!) ?? 0 : 0) * 2 + (a.util ?? 0)
          cards.push({ i, x: p.x, y: p.y, level: forms.current.get(a.station!) ?? 'compact', sel, prio })
        } else if (a.kind === 'prop') {
          if (p.ppu >= (a.minPpu ?? 0)) cards.push({ i, x: p.x, y: p.y, level: 'pill', sel: false, prio: 50 })
        } else {
          chips.push({ i, x: p.x, y: p.y, level: p.ppu >= CARD_PPU ? 'chipWide' : 'chip', sel: false, prio: 0 })
        }
      }
      // Stations first (busiest first), then props.
      cards.sort((p, r) => r.prio - p.prio)

      // Each card takes the largest size that still fits beside the cards placed
      // before it, so crowded far machines shrink without shrinking the near ones.
      // Tube labels come last and fill whatever room is left.
      const taken: Rect[] = []
      const placed: Placement[] = []
      layoutItems(cards, anchors, SIZES, taken, placed)
      layoutItems(chips, anchors, CHIP_SIZES, taken, placed)
      const scales = new Map<number, number>()
      c.growing = false
      for (const it of [...cards, ...chips]) {
        const pl = placed[it.i]
        live[it.i].level = pl.level
        if (pl.level === 'hidden') continue
        // Shrink at once so nothing overlaps; grow back over about half a second.
        let cur = c.scales.get(it.i) ?? pl.scale
        if (pl.scale < cur) cur = pl.scale
        else {
          cur += (pl.scale - cur) * (1 - Math.exp(-delta / 0.25))
          if (pl.scale - cur < 0.004) cur = pl.scale
        }
        if (cur < pl.scale) c.growing = true
        scales.set(it.i, cur)
        const el = bus.els.current[it.i]
        if (el) el.style.transform = `translate3d(${it.x.toFixed(1)}px,${(it.y + pl.dy).toFixed(1)}px,0) translate(-50%,-100%) scale(${cur.toFixed(3)})`
      }
      c.scales = scales
    }

    // Queue badges follow the timeline even when the view is still.
    let dirty = false
    for (let i = 0; i < live.length; i++) {
      const a = anchors[i]
      live[i].queue = a.kind === 'station' && a.showQueue ? queues.current.get(a.station!) ?? 0 : 0
      const prev = bus.shown.current[i]
      if (!prev || prev.level !== live[i].level || prev.queue !== live[i].queue) dirty = true
    }
    if (dirty) state.current.dirty = true
    if (state.current.dirty && clock.elapsedTime - state.current.last > 0.1) {
      state.current.dirty = false
      state.current.last = clock.elapsedTime
      bus.bump.current?.()
    }
  })
  return null
}

function Bar({ util }: { util: number }) {
  return (
    <span className="h-[5px] w-[54px] flex-none overflow-hidden rounded-[3px] bg-gray-200">
      <span className="block h-full rounded-[3px]" style={{ width: `${Math.max(3, Math.min(100, util))}%`, background: utilColor(util) }} />
    </span>
  )
}

function Tag({ a, level, queue, selected }: { a: TagAnchor; level: TagLevel; queue: number; selected: boolean }) {
  if (a.kind === 'flow') {
    return <span className="whitespace-nowrap rounded-md border border-gray-200 bg-white/95 px-2 py-0.5 text-[10px] font-medium text-gray-600 shadow-sm">{level === 'chipWide' ? a.detail : a.name}</span>
  }
  if (a.kind === 'prop') {
    return <span className="whitespace-nowrap rounded-full border border-gray-300 bg-white/95 px-2.5 py-0.5 text-[11px] font-semibold text-gray-900 shadow-sm">{a.name}</span>
  }
  const col = a.hasRun ? utilColor(a.util ?? 0) : '#94a3b8'
  const step = `Step ${a.step}`
  if (level === 'dot') {
    return (
      <span className="grid h-3.5 w-3.5 place-items-center rounded-full border border-white/80 font-mono text-[7.5px] font-semibold text-white" style={{ background: col }}>
        {a.step}
      </span>
    )
  }
  if (level === 'compact') {
    return (
      <div className={`relative w-[112px] rounded-md border border-gray-300 bg-white/95 py-[3px] pl-2.5 pr-1.5 text-left text-gray-900 shadow-md ${selected ? 'ring-2 ring-blue-500' : ''}`}>
        <span className="absolute bottom-1 left-0 top-1 w-[3px] rounded-sm" style={{ background: col }} />
        <div className="flex items-center justify-between gap-1">
          <span className="truncate text-[10.5px] font-semibold leading-tight" title={a.routing ? `${a.name} · ${a.routing}` : a.name}>{a.name}</span>
          {queue > 0 && <span className="flex-none rounded-full bg-[#f59e0b] px-1.5 font-mono text-[9px] font-semibold leading-[13px] text-[#1a1206]">{queue}</span>}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          {a.hasRun && <span className="h-1 w-9 flex-none overflow-hidden rounded-sm bg-gray-200"><span className="block h-full" style={{ width: `${Math.max(3, Math.min(100, a.util ?? 0))}%`, background: col }} /></span>}
          <span className="whitespace-nowrap font-mono text-[9px] leading-tight text-gray-500">{a.hasRun ? `${(a.util ?? 0).toFixed(0)}%` : fmtMin(a.dur ?? 0)}</span>
          <span className="ml-auto font-mono text-[9px] leading-tight text-gray-500">{a.step}</span>
        </div>
      </div>
    )
  }
  const fig = `${a.hasRun ? `${(a.util ?? 0).toFixed(0)}%  ·  ` : ''}${fmtMin(a.dur ?? 0)}${(a.ops ?? 1) > 1 ? ` · ${a.ops} ops` : ''}`
  return (
    <div className={`relative w-[196px] rounded-[9px] border border-gray-300 bg-white/95 py-[7px] pl-3.5 pr-2.5 text-left text-gray-900 shadow-md ${selected ? 'ring-2 ring-blue-500 ring-offset-2' : ''}`}>
      <span className="absolute bottom-1.5 left-0 top-1.5 w-1 rounded-sm" style={{ background: col }} />
      {queue > 0 && (
        <span className="absolute -top-[9px] right-2 rounded-full bg-[#f59e0b] px-2 py-0.5 font-mono text-[10px] font-semibold text-[#1a1206] shadow">Queue {queue}</span>
      )}
      <div className="flex items-baseline justify-between gap-2">
        <span className="max-w-[128px] truncate text-xs font-semibold" title={a.name}>{a.name}</span>
        <span className="whitespace-nowrap font-mono text-[9.5px] text-gray-500">{step}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        {a.hasRun && <Bar util={a.util ?? 0} />}
        <span className="whitespace-nowrap font-mono text-[10px] text-gray-500">{fig}</span>
      </div>
      {a.routing && <div className="mt-0.5 truncate font-mono text-[10px] text-gray-500">{a.routing}</div>}
    </div>
  )
}

export function TagOverlay({ anchors, bus, selected }: { anchors: TagAnchor[]; bus: TagBus; selected: string | null }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    bus.bump.current = () => {
      bus.shown.current = bus.live.current.map(l => ({ ...l }))
      setTick(t => t + 1)
    }
    return () => { bus.bump.current = null }
  }, [bus])

  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden">
      {anchors.map((a, i) => {
        const lv = bus.shown.current[i]
        const level = lv?.level ?? 'hidden'
        return (
          <div
            key={a.id}
            ref={el => { bus.els.current[i] = el }}
            className="absolute left-0 top-0 will-change-transform"
            style={{ display: level === 'hidden' ? 'none' : 'block', transformOrigin: '50% 100%' }}
          >
            {level !== 'hidden' && <Tag a={a} level={level} queue={lv.queue} selected={a.id === selected} />}
          </div>
        )
      })}
    </div>
  )
}
