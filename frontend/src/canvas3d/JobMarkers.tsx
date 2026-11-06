import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { isWebGPU } from './renderer'
import { Html, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import type { Machine3D } from './layout'
import type { TimelineRefs } from './Scene'
import { modelHeight } from './StationModel'
import { buildTimeline, snapshot, type AssemblyInfo, type DismantleInfo, type JobState, type Phase, type Timeline } from './jobTimeline'
import { STATION_MODELS } from '@/lib/stationTypes'
import { jobPrefix } from '@/lib/variantColors'

// One marker per job, placed from the run's job log (see jobTimeline.ts): a
// part on its machine while it is processed, or in a block in front of the
// station while it waits. Positions, counts and phases are the engine's; only
// the easing of a marker from one place to the next is drawn for readability
// (the engine has no travel time).

const MODEL = '/models/Movable_Part_1.glb'
const MAX = 1024 // instances drawn at most
const QUEUE_SHOWN = 12 // markers drawn per queue; the badge carries the full count
const QUEUE_COLS = 4
const SPACING = 0.52
const QUEUE_GAP = 2.4 // from a station's centre to the first queue row
const TOKEN_SIZE = 0.42
const GLIDE = 10 // easing rate, 1/s
const EXIT_SECONDS = 0.6
const PILE_SHOWN = 60 // finished jobs kept in the pile at the End; the Finished count carries the rest
const PILE_COLS = 6
const PILE_GAP = 1.8 // from the End to the first row of the pile

const HOVER_COLOR = new THREE.Color('#ffffff')
const OUTCOME_COLOR = new THREE.Color('#ef4444') // a job turned away or scrapped
const COLORS: Record<Phase, THREE.Color> = {
  waiting: new THREE.Color('#f5c518'),
  setup: new THREE.Color('#8b5cf6'),
  processing: new THREE.Color('#32c76a'),
  parts: new THREE.Color('#38bdf8'), // an Assembly's main part, waiting on the machine for its parts
  blocked: new THREE.Color('#fb923c'), // a part held on its station until the Assembly has room
}

interface StationInfo {
  x: number
  zc: number
  dir: 1 | -1
  machines: Machine3D[]
  fallbackTop: number
  url: string | undefined
}

interface JobUI {
  pos: THREE.Vector3
  shown: boolean
  exit: number // 0..1 while flying off after the last station
}

interface JobMarkersProps {
  machines: Machine3D[]
  startPos?: [number, number, number]
  endPos?: [number, number, number]
  completionLog?: Record<string, unknown[]>
  // simulation_state.assemblies: which parts went into which assembly.
  assemblies?: Record<string, AssemblyInfo>
  // simulation_state.dismantles: the pieces each dismantled job was split into.
  dismantles?: Record<string, DismantleInfo>
  // Each product's colour (Build's Start table): product name -> colour.
  variantColors?: Record<string, string>
  timelineRefs: TimelineRefs
}

// A job's product and the colour its cube is tinted.
interface JobProduct {
  name: string
  hex: string
  color: THREE.Color
}

const MIN_MS = 60_000

// With no colour set for a product, each job gets its own from this palette (as in Build's replay), and a
// second variant's jobs are shifted so its job 1 doesn't look like the first variant's job 1.
const JOB_COLORS = [
  '#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#06b6d4', '#ec4899', '#84cc16',
  '#f97316', '#6366f1', '#14b8a6', '#e11d48', '#0ea5e9', '#8b5cf6', '#ca8a04', '#10b981',
]
// "variant1-012" -> 12 (a Dismantle's piece shows its source job's number, see jobNumber below).
const idNumber = (id: string) => Number(id.match(/^(.*?)-?(\d+)$/)?.[2] ?? 0)

// Put the tooltip at its marker's screen position, but keep the whole card
// (about 256 x 240 px) inside the canvas so it isn't cut off at an edge.
const tipPoint = new THREE.Vector3()
function clampToCanvas(obj: THREE.Object3D, camera: THREE.Camera, size: { width: number; height: number }): number[] {
  obj.getWorldPosition(tipPoint)
  tipPoint.project(camera)
  const x = (tipPoint.x * 0.5 + 0.5) * size.width
  const y = (-tipPoint.y * 0.5 + 0.5) * size.height
  return [Math.min(Math.max(x, 140), size.width - 140), Math.min(Math.max(y, 130), size.height - 130)]
}

// 0.4 -> "0.4 min", 95 -> "1h 35m", 4000 -> "2d 18h"
function fmtMin(m: number): string {
  if (m < 10) return `${m.toFixed(1)} min`
  if (m < 120) return `${Math.round(m)} min`
  if (m < 2880) return `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`
}

// "Day 1 · 06:00" for a time on the timeline (ms from its zero).
function fmtClock(zeroAbs: number, ms: number): string {
  const d = new Date(zeroAbs + ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `Day ${Math.floor(ms / 86_400_000) + 1} · ${hh}:${mm}`
}

const MAX_LISTED = 50 // jobs listed in a spot's card (the rest counted)

// The card for a spot where jobs wait: every job there, the one leaving next first, as in Build's replay.
function SpotCard({ tl, title, items, products, madeFrom, onEnter, onLeave }: {
  tl: Timeline
  title: string
  items: JobState[]
  products: (JobProduct | null)[]
  madeFrom: Map<string, string[]>
  onEnter: () => void
  onLeave: () => void
}) {
  const rows = [...items].sort((a, b) => tl.jobs[a.job].visits[a.visit].release - tl.jobs[b.job].visits[b.visit].release || a.job - b.job)
  const shown = rows.slice(0, MAX_LISTED)
  // The scene's controls zoom on the mouse wheel; over this card the wheel scrolls the list instead.
  const card = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = card.current
    if (!el) return
    const stop = (e: WheelEvent) => e.stopPropagation()
    el.addEventListener('wheel', stop)
    return () => el.removeEventListener('wheel', stop)
  }, [])
  return (
    <div
      ref={card}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="w-64 rounded-xl border border-gray-200 bg-white/95 text-[11px] text-gray-700 shadow-lg backdrop-blur-sm"
      style={{ pointerEvents: 'auto' }}
    >
      <div className="border-b border-gray-100 px-3 py-2 font-semibold text-gray-900">
        {title}
        {rows.length > 1 && <span className="font-normal text-gray-500"> · {rows.length} jobs</span>}
      </div>
      <div className="max-h-64 divide-y divide-gray-100 overflow-y-auto">
        {shown.map((st) => {
          const job = tl.jobs[st.job]
          const v = job.visits[st.visit]
          const from = madeFrom.get(job.id)
          return (
            <div key={job.id} className="space-y-0.5 px-3 py-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold text-gray-900">{job.id}</span>
                <span className="truncate text-gray-500">{products[st.job]?.name ?? ''}</span>
              </div>
              <div>{st.visit === 0 ? 'Released — waiting for its first station' : 'Waiting to move on'}</div>
              <div className="tabular-nums text-gray-500">Came {fmtClock(tl.zeroAbs, v.arrival)} · Leaves {fmtClock(tl.zeroAbs, v.release)}</div>
              {from && <div className="text-gray-500">Made from {from.join(' + ')}</div>}
            </div>
          )
        })}
        {rows.length > shown.length && <div className="px-3 py-1.5 text-gray-400">and {rows.length - shown.length} more</div>}
      </div>
    </div>
  )
}

// What the log says about the job under the cursor. Every number is the
// engine's; per-visit totals are for the whole visit, not just the part so far.
// A finished job in the End pile: when it finished and how long it spent in the line.
function DoneTip({ tl, job, product, madeFrom }: { tl: Timeline; job: number; product: JobProduct | null; madeFrom?: string[] }) {
  const j = tl.jobs[job]
  const end = j.visits[j.visits.length - 1].end
  return (
    <div className="pointer-events-none w-64 rounded-lg border border-gray-200 bg-white/95 p-3 text-xs text-gray-700 shadow-lg backdrop-blur-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-gray-900">{j.id}</span>
        <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-800">Finished</span>
      </div>
      {product && (
        <div className="mt-0.5 flex items-center gap-1.5 text-gray-500">
          <i className="h-2 w-2 rounded-sm" style={{ background: product.hex }} />{product.name}
        </div>
      )}
      {madeFrom && <div className="mt-0.5 text-gray-500">Made from {madeFrom.join(' + ')}</div>}
      <div className="mt-2 space-y-0.5">
        <div className="flex justify-between"><span>Finished</span><b className="tabular-nums">{fmtClock(tl.zeroAbs, end)}</b></div>
        <div className="flex justify-between"><span>Time in the line</span><b className="tabular-nums">{fmtMin(Math.max(0, (end - j.visits[0].arrival) / MIN_MS))}</b></div>
        <div className="flex justify-between"><span>Stations visited</span><b className="tabular-nums">{j.visits.length}</b></div>
      </div>
    </div>
  )
}

function JobTip({ tl, state, t, queueSize, product, madeFrom }: { tl: Timeline; state: JobState; t: number; queueSize: number; product: JobProduct | null; madeFrom?: string[] }) {
  const job = tl.jobs[state.job]
  const visit = job.visits[state.visit]
  const known = visit.status === 'Completed' // the other statuses have no per-visit totals yet
  const rows: [string, number][] = known
    ? [
        ['Waited in queue', visit.queueMin],
        ['Processing', visit.processingMin],
        ['Paused (shifts, breaks)', visit.pauseMin],
        ['Waiting for material', visit.materialMin],
        ['Machine breakdown', visit.downtimeMin],
        ['Rework', visit.reworkMin],
        ['Setup', visit.setupMin],
        ['Operator downtime', visit.operatorMin],
      ]
    : []
  const shown = rows.filter(([, v]) => v > 0.005)
  const waiting = state.phase === 'waiting'
  // An Assembly: a part in its room, a part held back, or a main part waiting for parts.
  const inRoom = waiting && visit.status === 'Assembled'
  // A Dismantle's extra piece, not taken by its first station yet.
  const fresh = state.phase === 'blocked' && !!job.piece && t < visit.arrival
  const heldFor = state.phase === 'blocked' ? (fresh ? visit.station : job.visits[state.visit + 1]?.station) : undefined
  const heldSince = fresh ? job.piece!.at : visit.end
  const badge = inRoom ? 'In the room' : state.phase === 'blocked' ? 'Blocked' : state.phase === 'parts' ? 'Waiting for parts'
    : waiting ? 'Waiting' : state.phase === 'setup' ? 'Setup' : 'Processing'
  return (
    <div className="pointer-events-none w-64 rounded-lg border border-gray-200 bg-white/95 p-3 text-xs text-gray-700 shadow-lg backdrop-blur-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-gray-900">{job.id}</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${state.phase === 'parts' ? 'bg-sky-100 text-sky-800' : waiting || state.phase === 'blocked' ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800'}`}>
          {badge}
        </span>
      </div>
      <div className="mt-0.5 text-gray-500">{state.station} · {fresh ? `piece of ${job.piece!.of}` : `visit ${state.visit + 1}`}</div>
      {product && (
        <div className="mt-0.5 flex items-center gap-1.5 text-gray-500">
          <i className="h-2 w-2 rounded-sm" style={{ background: product.hex }} />{product.name}
        </div>
      )}
      {madeFrom && <div className="mt-0.5 text-gray-500">Made from {madeFrom.join(' + ')}</div>}
      <div className="mt-2 space-y-0.5">
        {inRoom ? (
          <>
            <div className="flex justify-between"><span>In the Assembly's room for</span><b className="tabular-nums">{fmtMin(Math.max(0, (t - visit.arrival) / MIN_MS))}</b></div>
            {job.absorbed && <div className="flex justify-between"><span>Goes into</span><b>{job.absorbed.into}</b></div>}
          </>
        ) : state.phase === 'blocked' ? (
          <>
            <div className="flex justify-between"><span>Held here for</span><b className="tabular-nums">{fmtMin(Math.max(0, (t - heldSince) / MIN_MS))}</b></div>
            {heldFor && <div className="flex justify-between"><span>Until {heldFor} takes it</span><b /></div>}
          </>
        ) : state.phase === 'parts' ? (
          <div className="flex justify-between"><span>Waiting for its parts</span><b className="tabular-nums">{fmtMin(Math.max(0, (t - (visit.waitingParts ? visit.arrival : visit.release)) / MIN_MS))}</b></div>
        ) : waiting ? (
          <>
            <div className="flex justify-between"><span>In queue so far</span><b className="tabular-nums">{fmtMin(Math.max(0, (t - visit.arrival) / MIN_MS))}</b></div>
            <div className="flex justify-between"><span>Place in queue</span><b className="tabular-nums">{state.rank + 1} of {queueSize}</b></div>
          </>
        ) : (
          <div className="flex justify-between"><span>On the machine for</span><b className="tabular-nums">{fmtMin(Math.max(0, (t - visit.start) / MIN_MS))}</b></div>
        )}
      </div>
      {shown.length > 0 && (
        <div className="mt-2 border-t border-gray-100 pt-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-gray-400">This visit, whole</div>
          {shown.map(([label, v]) => (
            <div key={label} className="flex justify-between"><span>{label}</span><b className="tabular-nums">{fmtMin(v)}</b></div>
          ))}
        </div>
      )}
    </div>
  )
}

function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  const gr = g.createRadialGradient(64, 64, 4, 64, 64, 62)
  gr.addColorStop(0, 'rgba(255,255,255,1)')
  gr.addColorStop(0.45, 'rgba(255,255,255,0.35)')
  gr.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = gr
  g.fillRect(0, 0, 128, 128)
  return new THREE.CanvasTexture(c)
}

export default function JobMarkers({ machines, startPos, endPos, completionLog, assemblies, dismantles, variantColors, timelineRefs }: JobMarkersProps) {
  // The soft glow is a point sprite, which WebGPU cannot size; it is left out there for now.
  const showGlow = !isWebGPU(useThree(s => s.gl))
  const gltf = useGLTF(MODEL)

  // The part itself: the Movable Part's cube, standing on y = 0, scaled to a small marker.
  // The material is made white and each job's cube is tinted per instance, so a
  // job with no product colour keeps the cube's own colour (baseColor).
  const { tokenGeo, tokenMat, tokenScale, tokenH, baseColor } = useMemo(() => {
    let cube: THREE.Mesh | null = null
    gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh && !cube && o.name === 'cube') cube = o as THREE.Mesh })
    if (!cube) gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh && !cube) cube = o as THREE.Mesh })
    const mesh = cube as THREE.Mesh | null
    const geo = mesh ? mesh.geometry.clone() : new THREE.BoxGeometry(0.6, 0.6, 0.6)
    geo.computeBoundingBox()
    const b = geo.boundingBox!
    geo.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2)
    const size = b.getSize(new THREE.Vector3())
    const mat = (mesh ? (mesh.material as THREE.Material).clone() : new THREE.MeshStandardMaterial({ color: '#dd0a17' })) as THREE.MeshStandardMaterial
    const base = mat.color ? mat.color.clone() : new THREE.Color('#dd0a17')
    mat.color?.set('#ffffff')
    const scale = TOKEN_SIZE / Math.max(size.x, size.z)
    return { tokenGeo: geo, tokenMat: mat, tokenScale: scale, tokenH: size.y * scale, baseColor: base }
  }, [gltf])

  const ringGeo = useMemo(() => new THREE.RingGeometry(0.3, 0.44, 40).rotateX(-Math.PI / 2), [])
  const ringMat = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }), [])
  const glow = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 3), 3))
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX * 3), 3))
    geo.setDrawRange(0, 0)
    const mat = new THREE.PointsMaterial({
      size: 1.1, sizeAttenuation: true, map: glowTexture(), transparent: true, depthWrite: false, vertexColors: true, opacity: 0.5,
    })
    return { geo, mat }
  }, [])

  // Job numbers: one flat quad per digit lying on the cube's top, each showing its digit from a strip texture.
  const digits = useMemo(() => {
    const c = document.createElement('canvas')
    c.width = 640
    c.height = 64
    const g = c.getContext('2d')!
    g.font = 'bold 50px sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.lineWidth = 7
    g.strokeStyle = 'rgba(15,23,42,0.9)'
    g.fillStyle = '#ffffff'
    for (let d = 0; d < 10; d++) { g.strokeText(String(d), d * 64 + 32, 34); g.fillText(String(d), d * 64 + 32, 34) }
    const map = new THREE.CanvasTexture(c)
    map.colorSpace = THREE.SRGBColorSpace
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 1)
    geo.setAttribute('aDigit', attr)
    const mat = new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false })
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aDigit;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = vec2((vMapUv.x + aDigit) * 0.1, vMapUv.y);\n#endif')
    }
    return { geo, mat, attr }
  }, [])
  const digitsRef = useRef<THREE.InstancedMesh>(null)

  const tokens = useRef<THREE.InstancedMesh>(null)
  const rings = useRef<THREE.InstancedMesh>(null)
  const slices = useRef<THREE.InstancedMesh>(null) // the other colours of a mixed job, laid over its cube

  const tl = useMemo(() => (completionLog ? buildTimeline(completionLog, assemblies, dismantles) : null), [completionLog, assemblies, dismantles])
  // Finished jobs stay at the End: job index -> place in the pile, in the order they finished.
  const pile = useMemo(() => {
    const m = new Map<number, number>()
    if (!tl) return m
    const done: { j: number; end: number }[] = []
    tl.jobs.forEach((job, j) => {
      const end = job.visits[job.visits.length - 1]?.end
      if (!job.outcome && job.group === undefined && !job.absorbed && Number.isFinite(end)) done.push({ j, end })
    })
    done.sort((a, b) => a.end - b.end).slice(0, PILE_SHOWN).forEach((x, i) => m.set(x.j, i))
    return m
  }, [tl])
  const ui = useMemo<JobUI[]>(
    () => (tl ? tl.jobs.map(() => ({ pos: new THREE.Vector3(), shown: false, exit: 0 })) : []),
    [tl],
  )

  // Each job's product and its colour, as in Build's replay: the colour of the
  // product its id belongs to; a Dismantle's piece takes its source job's colour
  // and what an Assembly makes takes its main part's. With only one product
  // there is nothing to tell apart, so the cube keeps its own colour.
  const products = useMemo<(JobProduct | null)[]>(() => {
    if (!tl) return []
    const entries = Object.entries(variantColors ?? {}).filter(([, hex]) => !!hex)
    const byPrefix = new Map(entries.map(([name, hex]) => [jobPrefix(name), { name, hex, color: new THREE.Color(hex) }]))
    const index = new Map(tl.jobs.map((j, i) => [j.id, i]))
    const made = new Map<string, string>() // what an Assembly made -> its main part
    for (const [out, rec] of Object.entries(assemblies ?? {})) made.set(out, rec.main)
    const cache = new Map<number, JobProduct | null>()
    const find = (i: number, depth: number): JobProduct | null => {
      if (cache.has(i)) return cache.get(i)!
      const job = tl.jobs[i]
      let found: JobProduct | null = byPrefix.get(job.id.match(/^(.*?)-?(\d+)$/)?.[1] ?? job.id) ?? null
      if (!found && depth < 6) {
        const from = job.piece ? index.get(job.piece.of) : made.has(job.id) ? index.get(made.get(job.id)!) : undefined
        if (from !== undefined && from !== i) found = find(from, depth + 1)
      }
      cache.set(i, found)
      return found
    }
    const shifts = new Map<string, number>()
    return tl.jobs.map((job, i) => {
      const found = find(i, 0)
      if (found) return found
      const prefix = job.id.match(/^(.*?)-?(\d+)$/)?.[1] ?? job.id
      if (!shifts.has(prefix)) shifts.set(prefix, shifts.size * 5)
      const hex = JOB_COLORS[(Math.max(idNumber(job.id), 1) - 1 + shifts.get(prefix)!) % JOB_COLORS.length]
      return { name: prefix, hex, color: new THREE.Color(hex) }
    })
  }, [tl, variantColors, assemblies])

  // What an Assembly set to attach all parts makes shows every part type's colour, one slice each (main
  // part first), as in Build's replay; a Dismantle's pieces keep the mix of the job they came from.
  const mixes = useMemo(() => {
    const m = new Map<number, { from: number; colors: THREE.Color[] }>()
    if (!tl) return m
    const index = new Map(tl.jobs.map((j, i) => [j.id, i]))
    for (const [out, rec] of Object.entries(assemblies ?? {})) {
      if (rec.mode !== 'attach') continue
      const oi = index.get(out)
      if (oi === undefined) continue
      const seen = new Set<string>()
      const colors: THREE.Color[] = []
      for (const id of [rec.main, ...rec.parts]) {
        const pr = products[index.get(id) ?? -1]
        if (pr && !seen.has(pr.hex)) { seen.add(pr.hex); colors.push(pr.color) }
      }
      if (colors.length < 2) continue
      const job = tl.jobs[oi]
      const from = out === rec.main ? (job.visits.filter((v) => v.station === rec.station).at(-1)?.end ?? 0) : (job.visits[0]?.start ?? 0)
      m.set(oi, { from, colors })
    }
    for (const [id, rec] of Object.entries(dismantles ?? {})) {
      const wi = index.get(id)
      const whole = wi !== undefined ? m.get(wi) : undefined
      if (!whole) continue
      for (const pid of rec.pieces) {
        const pi = pid === id ? undefined : index.get(pid)
        if (pi !== undefined) m.set(pi, { from: Math.max(whole.from, tl.jobs[pi].piece?.at ?? 0), colors: whole.colors })
      }
    }
    return m
  }, [tl, products, assemblies, dismantles])

  // What each assembled job or dismantle piece was made from, for the hover cards.
  const madeFrom = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const [out, rec] of Object.entries(assemblies ?? {})) if (rec.mode === 'attach') m.set(out, [rec.main, ...rec.parts])
    for (const [id, rec] of Object.entries(dismantles ?? {})) for (const pid of rec.pieces) if (pid !== id) m.set(pid, [id])
    return m
  }, [assemblies, dismantles])

  // The number painted on each job's cube; a Dismantle's piece shows the number of the job it came from.
  const numbers = useMemo(() => (tl ? tl.jobs.map((j) => idNumber(j.piece ? j.piece.of : j.id)) : []), [tl])

  const stations = useMemo(() => {
    const map = new Map<string, StationInfo>()
    for (const m of machines) {
      let s = map.get(m.baseName)
      if (!s) {
        s = { x: m.position[0], zc: 0, dir: m.flowDir, machines: [], fallbackTop: m.height, url: STATION_MODELS[m.stationType] }
        map.set(m.baseName, s)
      }
      s.machines[m.machineIndex] = m
    }
    for (const s of map.values()) s.zc = s.machines.reduce((a, m) => a + m.position[2], 0) / s.machines.length
    return map
  }, [machines])

  // Where a job first shows up: the line's Start, from which it glides to its first station.
  const entryPoint = useMemo(() => (startPos ? new THREE.Vector3(startPos[0], 0.3, startPos[2]) : null), [startPos])

  const exitTarget = useMemo(() => {
    if (endPos) return new THREE.Vector3(endPos[0], 0.3, endPos[2])
    const last = machines[machines.length - 1]
    return new THREE.Vector3(last?.position[0] ?? 0, 0.3, last?.position[2] ?? 0)
  }, [endPos, machines])

  // Timeline length: the 3D view's scrub bar and clock run off this.
  useEffect(() => {
    const ms = tl ? tl.span || 1 : 1
    timelineRefs.totalMs.current = ms
    timelineRefs.setTotalMsUI(ms)
    timelineRefs.setZeroMsUI(tl ? tl.zeroAbs : 0)
  }, [tl, timelineRefs])

  const hover = useRef(-1) // job under the cursor
  const tip = useRef<THREE.Group>(null)
  const [hoverJob, setHoverJob] = useState<number | null>(null)
  const [, setTick] = useState(0)
  // The spot whose list card is open (hovering its count or its cube); it stays open while the mouse is on the card.
  const [openSpot, setOpenSpot] = useState<string | null>(null)
  const openRef = useRef<string | null>(null)
  const closeTimer = useRef<number | undefined>(undefined)
  const spotOn = (k: string) => { window.clearTimeout(closeTimer.current); openRef.current = k; setOpenSpot(k) }
  const spotOff = () => { closeTimer.current = window.setTimeout(() => { openRef.current = null; setOpenSpot(null) }, 150) }
  const [spots, setSpots] = useState<{ key: string; x: number; z: number; n: number }[]>([]) // where jobs wait, with how many

  const scratch = useRef({
    instJob: new Int32Array(MAX), // which job each drawn marker is
    lastTick: 0,
    hoverState: null as JobState | null,
    hoverDone: null as number | null, // a finished job in the End pile under the cursor
    hoverQueue: 0,
    hoverT: 0,
    states: [] as JobState[],
    lastT: 0,
    lastUI: 0,
    lastSpot: 0,
    spotSig: '',
    lastCard: 0,
    holdLists: new Map<string, { title: string; items: JobState[] }>(),
    frontSpot: new Map<number, string>(),
    counts: { waiting: -1, processing: -1, done: -1, assembled: -1, dismantled: -1, rejected: -1, scrapped: -1 },
    present: new Uint8Array(0),
    dummy: new THREE.Object3D(),
    target: new THREE.Vector3(),
    absorbTo: new THREE.Vector3(),
  })

  function topOf(s: StationInfo): number {
    const h = s.url ? modelHeight(s.url) : undefined
    return h ?? s.fallbackTop
  }

  useFrame((state, delta) => {
    const tokensMesh = tokens.current
    const ringsMesh = rings.current
    const slicesMesh = slices.current
    if (!tl || !tokensMesh || !ringsMesh) return
    const sc = scratch.current
    const { playing, speed, scrubPct, simClockMs, totalMs, setScrubUI, setPlayingUI, setCounts } = timelineRefs

    // Advance the playback clock (speed is simulated ms per real second).
    if (playing.current) {
      simClockMs.current += delta * speed.current
      const pct = (simClockMs.current / totalMs.current) * 100
      if (pct >= 100) {
        scrubPct.current = 100
        simClockMs.current = totalMs.current
        playing.current = false
        setScrubUI(100)
        setPlayingUI(false)
      } else {
        scrubPct.current = pct
        if (state.clock.elapsedTime - sc.lastUI > 0.1) {
          sc.lastUI = state.clock.elapsedTime
          setScrubUI(pct)
        }
      }
    }

    const t = simClockMs.current
    // Ease markers while playing; jump straight to the place when scrubbing or after a big skip.
    const snap = !playing.current || Math.abs(t - sc.lastT) > speed.current * 0.4
    sc.lastT = t
    const ease = 1 - Math.exp(-delta * GLIDE)

    const states = snapshot(tl, t, sc.states)
    if (sc.present.length !== tl.jobs.length) sc.present = new Uint8Array(tl.jobs.length)
    sc.present.fill(0)

    // Counts and queue lengths, exactly as the log has them.
    let waiting = 0
    const queueLen = new Map<string, number>()
    for (const s of states) {
      if (s.phase === 'waiting') {
        waiting++
        queueLen.set(s.station, (queueLen.get(s.station) ?? 0) + 1)
      } else if (s.phase === 'blocked' || s.phase === 'parts') {
        waiting++ // held up, but on a machine rather than in a queue
      }
    }
    const processing = states.length - waiting
    // Finished = its last visit has ended; a job not released yet is not, and
    // neither is a part an Assembly used up (counted as Assembled).
    let done = 0
    let assembled = 0
    let rejected = 0
    let scrapped = 0
    for (const job of tl.jobs) {
      if (job.outcome) { // turned away or scrapped: neither finished nor assembled
        if (t >= job.outcome.at) { if (job.outcome.kind === 'rejected') rejected++; else scrapped++ }
        continue
      }
      if (job.group !== undefined) continue // counted with its dismantled job below
      if (job.absorbed) {
        if (job.absorbed.kind !== 'dismantle' && t >= job.absorbed.at) assembled++
      } else if (t >= job.visits[job.visits.length - 1].end) done++
    }
    // A dismantled job is one finished job, once its last piece is done.
    let dismantled = 0
    for (const g of tl.groups) {
      if (t >= g.at) dismantled++
      if (t >= g.finishAt) done++
    }
    const c = sc.counts
    if (c.waiting !== waiting || c.processing !== processing || c.done !== done || c.assembled !== assembled || c.dismantled !== dismantled
      || c.rejected !== rejected || c.scrapped !== scrapped) {
      c.waiting = waiting; c.processing = processing; c.done = done; c.assembled = assembled; c.dismantled = dismantled
      c.rejected = rejected; c.scrapped = scrapped
      setCounts(waiting, processing, done, assembled, dismantled, rejected, scrapped)
    }

    const { dummy, target } = sc
    const glowPos = glow.geo.attributes.position as THREE.BufferAttribute
    const glowCol = glow.geo.attributes.color as THREE.BufferAttribute
    let n = 0

    let sn = 0 // slices drawn this frame
    let dn = 0 // digits drawn this frame
    const digitsMesh = digitsRef.current
    const hovered = hover.current
    const put = (j: number, pos: THREE.Vector3, color: THREE.Color, scale: number, spin: number, ringPulse: number) => {
      if (n >= MAX) return
      const hot = j === hovered
      dummy.position.copy(pos)
      dummy.rotation.set(0, spin, 0)
      dummy.scale.setScalar(tokenScale * scale)
      dummy.updateMatrix()
      tokensMesh.setMatrixAt(n, dummy.matrix)
      tokensMesh.setColorAt(n, products[j]?.color ?? baseColor)
      dummy.position.set(pos.x, pos.y + 0.02, pos.z)
      dummy.rotation.set(0, 0, 0)
      dummy.scale.setScalar(scale * ringPulse * (hot ? 1.35 : 1))
      dummy.updateMatrix()
      ringsMesh.setMatrixAt(n, dummy.matrix)
      ringsMesh.setColorAt(n, hot ? HOVER_COLOR : color)
      glowPos.setXYZ(n, pos.x, pos.y + 0.22, pos.z)
      glowCol.setXYZ(n, color.r, color.g, color.b)
      sc.instJob[n] = j
      n++
      if (digitsMesh) {
        const str = String(numbers[j] ?? 0)
        const dw = Math.min(TOKEN_SIZE * scale * 0.85 / str.length, TOKEN_SIZE * scale * 0.6)
        for (let i = 0; i < str.length && dn < MAX * 3; i++) {
          const off = (i - (str.length - 1) / 2) * dw
          dummy.position.set(pos.x + Math.cos(spin) * off, pos.y + tokenH * scale * 1.06 + 0.012, pos.z - Math.sin(spin) * off)
          dummy.rotation.set(0, spin, 0)
          dummy.scale.set(dw, 1, dw)
          dummy.updateMatrix()
          digitsMesh.setMatrixAt(dn, dummy.matrix)
          digits.attr.setX(dn, str.charCodeAt(i) - 48)
          dn++
        }
      }
      const mix = mixes.get(j)
      if (slicesMesh && mix && t >= mix.from) {
        const k = mix.colors.length
        tokensMesh.setColorAt(n - 1, mix.colors[0])
        const w = TOKEN_SIZE * scale
        for (let i = 1; i < k && sn < MAX; i++) {
          const off = ((i + 0.5) / k - 0.5) * w
          dummy.position.set(pos.x + Math.cos(spin) * off, pos.y, pos.z - Math.sin(spin) * off)
          dummy.rotation.set(0, spin, 0)
          dummy.scale.set((tokenScale * scale) / k, tokenScale * scale * 1.04, tokenScale * scale * 1.04)
          dummy.updateMatrix()
          slicesMesh.setMatrixAt(sn, dummy.matrix)
          slicesMesh.setColorAt(sn, mix.colors[i])
          sn++
        }
      }
    }

    const elapsed = state.clock.elapsedTime
    // Several held jobs on one machine (a Dismantle holding all its pieces) sit side by side.
    const crowd = new Map<string, number>()
    // Jobs waiting for their next station stay where they are — at the Start, or at the output of the
    // station they just left. Each such spot shows one cube, the job that leaves next, and counts the rest.
    const holdOf = (s: JobState, info: StationInfo): { key: string; x: number; z: number; dir: number } | null => {
      const job = tl.jobs[s.job]
      if (job.visits[s.visit].status === 'Assembled' || job.piece) return null
      const prev = s.visit > 0 ? stations.get(job.visits[s.visit - 1].station) : undefined
      if (prev) return { key: job.visits[s.visit - 1].station, x: prev.x, z: prev.zc, dir: prev.dir }
      return s.visit === 0 && startPos ? { key: 'start', x: startPos[0], z: startPos[2], dir: info.dir } : null
    }
    const holds = new Map<string, { x: number; z: number; dir: number; n: number; front: number; frontRank: number; states: JobState[] }>()
    for (const s of states) {
      if (s.phase !== 'waiting') continue
      const info = stations.get(s.station)
      const h = info && holdOf(s, info)
      if (!h) continue
      const e = holds.get(h.key)
      if (!e) holds.set(h.key, { x: h.x, z: h.z, dir: h.dir, n: 1, front: s.job, frontRank: s.rank, states: [s] })
      else {
        e.n++
        e.states.push(s)
        if (s.rank < e.frontRank || (s.rank === e.frontRank && s.job < e.front)) { e.front = s.job; e.frontRank = s.rank }
      }
    }
    for (const s of states) {
      const info = stations.get(s.station)
      if (!info) continue
      const j = s.job
      sc.present[j] = 1
      const u = ui[j]
      if (s.phase === 'waiting') {
        const h = holdOf(s, info)
        if (h) {
          if (holds.get(h.key)!.front !== j) { u.shown = false; continue } // counted in the badge
          target.set(h.x + h.dir * QUEUE_GAP, 0.02, h.z)
        } else {
          if (s.rank >= QUEUE_SHOWN) { u.shown = false; continue }
          const row = Math.floor(s.rank / QUEUE_COLS)
          const col = s.rank % QUEUE_COLS
          target.set(info.x - info.dir * (QUEUE_GAP + row * SPACING), 0.02, info.zc + (col - (QUEUE_COLS - 1) / 2) * SPACING)
        }
      } else {
        const m = info.machines[Math.min(s.machine, info.machines.length - 1)] ?? info.machines[0]
        target.set(m.position[0], topOf(info) + 0.02, m.position[2] + 0.25)
        if (s.phase === 'blocked' || s.phase === 'parts') {
          const key = `${s.station}|${s.machine}`
          const n = crowd.get(key) ?? 0
          crowd.set(key, n + 1)
          target.x += n * 0.55
        }
      }
      if (snap) u.pos.copy(target)
      else if (!u.shown) u.pos.copy(entryPoint && s.visit === 0 && !tl.jobs[j].piece ? entryPoint : target)
      else u.pos.lerp(target, ease)
      u.shown = true
      u.exit = 0
      const pulse = s.phase === 'processing' ? 1 + 0.12 * Math.sin(elapsed * 5 + j) : 1
      put(j, u.pos, COLORS[s.phase], 1, s.phase === 'processing' ? elapsed * 1.8 + j : 0, pulse)
    }

    sc.holdLists = new Map([...holds].map(([k, e]) => [k, { title: k === 'start' ? 'After Start' : `After ${k}`, items: e.states }]))
    sc.frontSpot = new Map([...holds].map(([k, e]) => [e.front, k]))
    const crowded = [...holds]
    const sig = crowded.map(([k, e]) => `${k}:${e.n}`).join('|')
    if (sig !== sc.spotSig && state.clock.elapsedTime - sc.lastSpot > 0.1) {
      sc.spotSig = sig
      sc.lastSpot = state.clock.elapsedTime
      setSpots(crowded.map(([key, e]) => ({ key, x: e.x + e.dir * QUEUE_GAP, z: e.z, n: e.n })))
    }
    // An open card keeps its times current.
    if (openRef.current && state.clock.elapsedTime - sc.lastCard > 0.25) { sc.lastCard = state.clock.elapsedTime; setTick((k) => k + 1) }

    // Finished jobs glide to the End and stay there, in rows behind it.
    const endDir = machines[machines.length - 1]?.flowDir ?? 1
    for (const [j, rank] of pile) {
      const job = tl.jobs[j]
      if (t < job.visits[job.visits.length - 1].end) continue
      const u = ui[j]
      sc.present[j] = 1
      target.set(
        exitTarget.x + endDir * (PILE_GAP + Math.floor(rank / PILE_COLS) * SPACING),
        0.02,
        exitTarget.z + ((rank % PILE_COLS) - (PILE_COLS - 1) / 2) * SPACING,
      )
      if (snap || !u.shown) u.pos.copy(target)
      else u.pos.lerp(target, ease)
      u.shown = true
      u.exit = 0
      put(j, u.pos, COLORS.processing, 1, 0, 1)
    }

    // Jobs that just left their last station fly off to the End and shrink away;
    // a part used in an Assembly shrinks into that Assembly instead (and so does any job past the pile).
    for (let j = 0; j < ui.length; j++) {
      const u = ui[j]
      if (sc.present[j] || !u.shown) continue
      if (snap) { u.shown = false; continue }
      u.exit += delta / EXIT_SECONDS
      if (u.exit >= 1) { u.shown = false; u.exit = 0; continue }
      // A rejected or scrapped job turns red and shrinks where it is.
      if (tl.jobs[j].outcome) { put(j, u.pos, OUTCOME_COLOR, 1 - u.exit, 0, 1); continue }
      const into = tl.jobs[j].absorbed && stations.get(tl.jobs[j].absorbed!.station)
      const to = into ? sc.absorbTo.set(into.machines[0].position[0], topOf(into) + 0.02, into.machines[0].position[2] + 0.25) : exitTarget
      u.pos.lerp(to, ease)
      put(j, u.pos, COLORS.processing, 1 - u.exit, 0, 1)
    }

    tokensMesh.count = n
    ringsMesh.count = n
    if (digitsMesh) {
      digitsMesh.count = dn
      digitsMesh.instanceMatrix.needsUpdate = true
      digits.attr.needsUpdate = true
    }
    if (slicesMesh) {
      slicesMesh.count = sn
      slicesMesh.instanceMatrix.needsUpdate = true
      if (slicesMesh.instanceColor) slicesMesh.instanceColor.needsUpdate = true
    }
    tokensMesh.computeBoundingSphere() // picking tests this first, and the markers move
    tokensMesh.instanceMatrix.needsUpdate = true
    if (tokensMesh.instanceColor) tokensMesh.instanceColor.needsUpdate = true
    ringsMesh.instanceMatrix.needsUpdate = true
    if (ringsMesh.instanceColor) ringsMesh.instanceColor.needsUpdate = true
    glow.geo.setDrawRange(0, n)
    glowPos.needsUpdate = true
    glowCol.needsUpdate = true

    timelineRefs.queues.current = queueLen // the station tags show these

    // Keep the tooltip on its marker, and refresh its numbers a few times a second.
    if (hover.current >= 0) {
      const u = ui[hover.current]
      if (tip.current && u) tip.current.position.set(u.pos.x, u.pos.y + 0.9, u.pos.z)
      if (state.clock.elapsedTime - sc.lastTick > 0.25) {
        sc.lastTick = state.clock.elapsedTime
        sc.hoverState = states.find((s) => s.job === hover.current) ?? null
        const hj = hover.current
        sc.hoverDone = !sc.hoverState && pile.has(hj) && t >= tl.jobs[hj].visits[tl.jobs[hj].visits.length - 1].end ? hj : null
        sc.hoverQueue = sc.hoverState ? (queueLen.get(sc.hoverState.station) ?? 0) : 0
        sc.hoverT = t
        setTick((k) => k + 1)
      }
    }
  })

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    if (e.instanceId === undefined) return
    const j = scratch.current.instJob[e.instanceId]
    e.stopPropagation()
    const spot = scratch.current.frontSpot.get(j) // the cube standing for a waiting spot: its card lists every job there
    if (spot) {
      spotOn(spot)
      if (hover.current !== -1) { hover.current = -1; setHoverJob(null) }
      return
    }
    if (hover.current !== j) {
      hover.current = j
      scratch.current.lastTick = 0 // refresh the tooltip on the next frame
      setHoverJob(j)
    }
  }
  const onOut = () => {
    spotOff()
    hover.current = -1
    document.body.style.cursor = 'auto'
    setHoverJob(null)
  }

  return (
    <>
      <instancedMesh
        ref={tokens}
        args={[tokenGeo, tokenMat, MAX]}
        frustumCulled={false}
        castShadow
        onPointerMove={onMove}
        onPointerOut={onOut}
      />
      <instancedMesh ref={rings} args={[ringGeo, ringMat, MAX]} frustumCulled={false} raycast={() => {}} />
      <instancedMesh ref={slices} args={[tokenGeo, tokenMat, MAX]} frustumCulled={false} raycast={() => {}} />
      {showGlow && <instancedMesh ref={digitsRef} args={[digits.geo, digits.mat, MAX * 3]} frustumCulled={false} raycast={() => {}} />}
      {showGlow && <points geometry={glow.geo} material={glow.mat} frustumCulled={false} raycast={() => {}} />}
      {spots.map((sp) => {
        const list = scratch.current.holdLists.get(sp.key)
        return (
          <Html key={sp.key} position={[sp.x, 0.9, sp.z]} center zIndexRange={[openSpot === sp.key ? 40 : 20, 0]} style={{ pointerEvents: 'none' }}>
            <div style={{ position: 'relative' }}>
              {sp.n > 1 && (
                <span
                  onMouseEnter={() => spotOn(sp.key)}
                  onMouseLeave={spotOff}
                  className="rounded-full bg-amber-500 px-2 py-0.5 text-[11px] font-bold text-white shadow"
                  style={{ pointerEvents: 'auto' }}
                >
                  {sp.n}
                </span>
              )}
              {openSpot === sp.key && tl && list && (
                <div style={{ position: 'absolute', left: '50%', top: '100%', transform: 'translateX(-50%)', paddingTop: 4 }}>
                  <SpotCard tl={tl} title={list.title} items={list.items} products={products} madeFrom={madeFrom} onEnter={() => spotOn(sp.key)} onLeave={spotOff} />
                </div>
              )}
            </div>
          </Html>
        )
      })}
      <group ref={tip}>
        {tl && hoverJob !== null && !scratch.current.hoverState && scratch.current.hoverDone !== null && (
          <Html center calculatePosition={clampToCanvas} zIndexRange={[30, 0]} style={{ pointerEvents: 'none' }}>
            <DoneTip tl={tl} job={scratch.current.hoverDone} product={products[scratch.current.hoverDone] ?? null} madeFrom={madeFrom.get(tl.jobs[scratch.current.hoverDone].id)} />
          </Html>
        )}
        {tl && hoverJob !== null && scratch.current.hoverState && (
          <Html center calculatePosition={clampToCanvas} zIndexRange={[30, 0]} style={{ pointerEvents: 'none' }}>
            <JobTip tl={tl} state={scratch.current.hoverState} t={scratch.current.hoverT} queueSize={scratch.current.hoverQueue} product={products[scratch.current.hoverState.job] ?? null} madeFrom={madeFrom.get(tl.jobs[scratch.current.hoverState.job].id)} />
          </Html>
        )}
      </group>
    </>
  )
}

useGLTF.preload(MODEL)
