import { useRef, useMemo, useEffect } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Machine3D, Connection3D } from './layout'
import type { TimelineRefs } from './Scene'

interface JobParticleProps {
  machines: Machine3D[]
  connections: Connection3D[]
  completionLog?: Record<string, unknown[]>
  timelineRefs: TimelineRefs
}

const SPHERE_HOVER_Y = 0.8

// ─── Gantt parsing (mirrors RunDashboard.parseGantt) ─────────────────────────

interface GanttEntry {
  station: string
  startMs: number
  endMs: number
  processingMin: number
  waitingMin: number
  blockedMin: number
  jobIndex: number
}

function parseCompletionLog(log: Record<string, unknown[]>): GanttEntry[] {
  const entries: GanttEntry[] = []
  for (const [station, rows] of Object.entries(log)) {
    let idx = 0
    for (const r of rows as Record<string, unknown>[]) {
      const sStr = r['process_start_time_real'] as string
      const eStr = r['process_end_time_real'] as string
      if (!sStr || !eStr) continue
      const startMs = new Date(sStr.replace(' ', 'T').replace(' ', '')).getTime()
      const endMs = new Date(eStr.replace(' ', 'T').replace(' ', '')).getTime()
      entries.push({
        station,
        startMs,
        endMs,
        processingMin: Number(r['Processing Time'] ?? 0),
        waitingMin: Number(r['Waiting Time'] ?? 0),
        blockedMin: Number(r['Blocked Time'] ?? 0),
        jobIndex: ++idx,
      })
    }
  }
  return entries
}

// ─── Pre-computed per-job data (flat arrays for zero-alloc hot loop) ─────────

interface JobData {
  startMs: Float64Array    // step start times
  endMs: Float64Array      // step end times
  procMs: Float64Array     // processing duration within step
  waitMs: Float64Array     // waiting duration within step
  pos: THREE.Vector3[]     // station position per step
  curveKeys: string[]      // "fromStation|toStation" per transition
  totalSteps: number
  jobStart: number         // first step startMs
  jobEnd: number           // last step endMs
}

// Reusable Vector3 to avoid getPoint() allocations per frame
const _curvePoint = new THREE.Vector3()

// ─── Three.js helpers ─────────────────────────────────────────────────────────

function makeSphereGroup(): THREE.Group {
  const geo = new THREE.SphereGeometry(0.12, 8, 8)
  const mat = new THREE.MeshBasicMaterial({ color: '#22c55e' })
  const mesh = new THREE.Mesh(geo, mat)
  const glowGeo = new THREE.SphereGeometry(0.2, 6, 6)
  const glowMat = new THREE.MeshBasicMaterial({ color: '#16a34a', transparent: true, opacity: 0.4 })
  const glowMesh = new THREE.Mesh(glowGeo, glowMat)
  const group = new THREE.Group()
  group.add(mesh)
  group.add(glowMesh)
  return group
}

function makeBoxGroup(): THREE.Group {
  const group = new THREE.Group()
  const geo = new THREE.BoxGeometry(0.24, 0.24, 0.24)
  const mat = new THREE.MeshBasicMaterial({ color: '#eab308' })
  const mesh = new THREE.Mesh(geo, mat)
  group.add(mesh)
  return group
}

function makeBlockedGroup(): THREE.Group {
  const group = new THREE.Group()
  const geo = new THREE.BoxGeometry(0.24, 0.24, 0.24)
  const mat = new THREE.MeshBasicMaterial({ color: '#ef4444' })
  const mesh = new THREE.Mesh(geo, mat)
  group.add(mesh)
  return group
}

function disposeObject3D(obj: THREE.Object3D) {
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry?.dispose()
      const mats = Array.isArray(child.material) ? child.material : [child.material]
      for (const m of mats) m?.dispose()
    }
    if (child instanceof THREE.Sprite) {
      const mat = child.material as THREE.SpriteMaterial
      mat.map?.dispose()
      mat.dispose()
    }
  })
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function JobParticle({ machines, connections, completionLog, timelineRefs }: JobParticleProps) {
  const containerRef = useRef<THREE.Group>(new THREE.Group())
  const particlesRef = useRef<{ jobId: number; sphere: THREE.Group; box: THREE.Group; blocked: THREE.Group }[]>([])

  // Pipeline: ordered list of station groups
  const pipeline = useMemo(() => {
    const unique = new Map<string, Machine3D[]>()
    for (const m of machines) {
      if (!unique.has(m.baseName)) unique.set(m.baseName, [])
      unique.get(m.baseName)!.push(m)
    }
    const order: Machine3D[][] = []
    const seen = new Set<string>()
    for (const m of machines) {
      if (!seen.has(m.baseName)) {
        seen.add(m.baseName)
        order.push(unique.get(m.baseName)!)
      }
    }
    return order
  }, [machines])

  // Station name → ALL machine positions (hover height) for parallel machines
  const stationToPositions = useMemo(() => {
    const map = new Map<string, THREE.Vector3[]>()
    for (const group of pipeline) {
      const positions = group.map(m => new THREE.Vector3(m.position[0], SPHERE_HOVER_Y, m.position[2]))
      map.set(group[0].baseName, positions)
    }
    return map
  }, [pipeline])

  // Connection curves keyed by "fromStation|toStation"
  const connectionCurves = useMemo(() => {
    const map = new Map<string, THREE.QuadraticBezierCurve3>()
    for (const conn of connections) {
      const fromStation = findStation(conn.from[0], conn.from[2], stationToPositions)
      const toStation = findStation(conn.to[0], conn.to[2], stationToPositions)
      if (!fromStation || !toStation) continue
      const from = stationToPositions.get(fromStation)![0]
      const to = stationToPositions.get(toStation)![0]
      const dir = new THREE.Vector3().subVectors(to, from)
      const len = dir.length()
      const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5)
      const perp = new THREE.Vector3(-dir.z, 0, dir.x).normalize()
      const curveHeight = Math.min(len * 0.12, 0.6)
      const control = mid.clone()
      control.y += curveHeight
      control.add(perp.multiplyScalar(curveHeight * 0.3))
      map.set(`${fromStation}|${toStation}`, new THREE.QuadraticBezierCurve3(from, control, to))
    }
    return map
  }, [connections, stationToPositions])

  // Parse + pre-compute flat arrays for zero-alloc hot loop
  const { jobData, globalStart, globalEnd } = useMemo(() => {
    if (!completionLog) return { jobData: [], globalStart: 0, globalEnd: 1 }
    const entries = parseCompletionLog(completionLog)
    if (entries.length === 0) return { jobData: [], globalStart: 0, globalEnd: 1 }

    // Group by jobIndex
    const byJob = new Map<number, GanttEntry[]>()
    for (const e of entries) {
      if (!byJob.has(e.jobIndex)) byJob.set(e.jobIndex, [])
      byJob.get(e.jobIndex)!.push(e)
    }

    let gMin = Infinity, gMax = -Infinity
    const data: JobData[] = []

    for (const [jobIdx, jobEntries] of byJob) {
      jobEntries.sort((a, b) => a.startMs - b.startMs)
      const n = jobEntries.length
      const startMs = new Float64Array(n)
      const endMs = new Float64Array(n)
      const procMs = new Float64Array(n)
      const waitMs = new Float64Array(n)
      const pos: THREE.Vector3[] = new Array(n)
      const curveKeys: string[] = new Array(n - 1)

      for (let i = 0; i < n; i++) {
        const e = jobEntries[i]
        startMs[i] = e.startMs
        endMs[i] = e.endMs
        procMs[i] = e.processingMin * 60000
        waitMs[i] = e.waitingMin * 60000
        const positions = stationToPositions.get(e.station)
        const machineIdx = (jobIdx - 1) % (positions?.length ?? 1)
        pos[i] = positions ? positions[machineIdx] : new THREE.Vector3()
        if (i < n - 1) {
          curveKeys[i] = `${e.station}|${jobEntries[i + 1].station}`
        }
        if (e.startMs < gMin) gMin = e.startMs
        if (e.endMs > gMax) gMax = e.endMs
      }

      data.push({
        startMs, endMs, procMs, waitMs, pos, curveKeys,
        totalSteps: n,
        jobStart: startMs[0],
        jobEnd: endMs[n - 1],
      })
    }

    return { jobData: data, globalStart: gMin, globalEnd: gMax }
  }, [completionLog, stationToPositions])

  // Update totalMs ref for the timeline controls
  useEffect(() => {
    timelineRefs.totalMs.current = globalEnd - globalStart || 1
  }, [globalStart, globalEnd, timelineRefs.totalMs])

  // Create particle meshes for each job
  useEffect(() => {
    const container = containerRef.current
    for (const p of particlesRef.current) {
      disposeObject3D(p.sphere)
      disposeObject3D(p.box)
      disposeObject3D(p.blocked)
    }
    particlesRef.current = []
    container.clear()

    if (jobData.length === 0) return

    for (const jd of jobData) {
      const sphere = makeSphereGroup()
      const box = makeBoxGroup()
      const blocked = makeBlockedGroup()
      box.visible = false
      blocked.visible = false
      const firstPos = jd.pos[0]
      if (firstPos) {
        sphere.position.copy(firstPos)
        box.position.copy(firstPos)
        blocked.position.copy(firstPos)
      }
      container.add(sphere, box, blocked)
      particlesRef.current.push({ jobId: 0, sphere, box, blocked })
    }

    return () => {
      for (const p of particlesRef.current) {
        disposeObject3D(p.sphere)
        disposeObject3D(p.box)
        disposeObject3D(p.blocked)
      }
      particlesRef.current = []
      container.clear()
    }
  }, [jobData])

  // Animate particles — zero allocations in the hot path
  useFrame((_, delta) => {
    if (jobData.length === 0) return

    const { playing, speed, scrubPct, simClockMs, totalMs } = timelineRefs

    // Advance simulation clock
    if (playing.current) {
      simClockMs.current += delta * speed.current * 1000
      const pct = (simClockMs.current / totalMs.current) * 100
      if (pct >= 100) {
        scrubPct.current = 100
        simClockMs.current = totalMs.current
        playing.current = false
      } else {
        scrubPct.current = pct
      }
    }

    const now = globalStart + simClockMs.current

    for (let i = 0; i < jobData.length; i++) {
      const jd = jobData[i]
      const p = particlesRef.current[i]
      if (!p) continue

      // Binary search for current step
      const n = jd.totalSteps
      let stepIdx = -1

      // Simple scan — steps are sorted and typically few (< 20)
      for (let si = 0; si < n; si++) {
        if (now >= jd.startMs[si] && now <= jd.endMs[si]) {
          stepIdx = si
          break
        }
      }

      // Before first step → hidden
      if (stepIdx === -1 && now < jd.jobStart) {
        p.sphere.visible = false
        p.box.visible = false
        p.blocked.visible = false
        continue
      }

      // After last step → hidden
      if (stepIdx === -1 && now > jd.jobEnd) {
        p.sphere.visible = false
        p.box.visible = false
        p.blocked.visible = false
        continue
      }

      // Traveling between steps
      if (stepIdx === -1) {
        // Find which gap we're in
        for (let si = 0; si < n - 1; si++) {
          if (now > jd.endMs[si] && now < jd.startMs[si + 1]) {
            const travelDur = jd.startMs[si + 1] - jd.endMs[si]
            const t = travelDur > 0 ? (now - jd.endMs[si]) / travelDur : 1
            const clamped = Math.min(Math.max(t, 0), 0.999)

            p.sphere.visible = true
            p.box.visible = false
            p.blocked.visible = false

            const curve = connectionCurves.get(jd.curveKeys[si])
            if (curve) {
              curve.getPoint(clamped, _curvePoint)
              p.sphere.position.copy(_curvePoint)
            } else {
              p.sphere.position.lerpVectors(jd.pos[si], jd.pos[si + 1], clamped)
            }
            break
          }
        }
        continue
      }

      // At a station
      const procEnd = jd.procMs[stepIdx]
      const waitEnd = procEnd + jd.waitMs[stepIdx]
      const stepLocalTime = now - jd.startMs[stepIdx]

      let isProc = false
      let isWait = false
      let isBlock = false

      if (stepLocalTime < procEnd) {
        isProc = true
      } else if (stepLocalTime < waitEnd) {
        isWait = true
      } else {
        isBlock = true
      }

      p.sphere.visible = isProc
      p.box.visible = isWait
      p.blocked.visible = isBlock

      const active = isProc ? p.sphere : isWait ? p.box : p.blocked
      active.position.copy(jd.pos[stepIdx])
    }
  })

  return <primitive object={containerRef.current} />
}

function findStation(x: number, z: number, stationToPositions: Map<string, THREE.Vector3[]>): string | null {
  for (const [station, positions] of stationToPositions) {
    for (const pos of positions) {
      if (Math.abs(pos.x - x) < 0.01 && Math.abs(pos.z - z) < 0.01) return station
    }
  }
  return null
}
