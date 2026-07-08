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

interface JobData {
  jobId: number
  startMs: Float64Array
  endMs: Float64Array
  procMs: Float64Array
  waitMs: Float64Array
  pos: THREE.Vector3[][]
  curveKeys: string[]
  totalSteps: number
  totalMeshes: number
  stepMeshStart: Uint32Array
  jobStart: number
  jobEnd: number
}

const _curvePoint = new THREE.Vector3()
const _tangent = new THREE.Vector3()
const _perp = new THREE.Vector3()

const sphereGeo = new THREE.SphereGeometry(0.12, 8, 8)
const sphereMat = new THREE.MeshBasicMaterial({ color: '#22c55e' })
const glowGeo = new THREE.SphereGeometry(0.2, 6, 6)
const glowMat = new THREE.MeshBasicMaterial({ color: '#16a34a', transparent: true, opacity: 0.4 })
const boxGeo = new THREE.BoxGeometry(0.24, 0.24, 0.24)
const boxMat = new THREE.MeshBasicMaterial({ color: '#eab308' })
const blockedMat = new THREE.MeshBasicMaterial({ color: '#ef4444' })

function makeSphereGroup(): THREE.Group {
  const mesh = new THREE.Mesh(sphereGeo, sphereMat)
  const glowMesh = new THREE.Mesh(glowGeo, glowMat)
  const group = new THREE.Group()
  group.add(mesh)
  group.add(glowMesh)
  return group
}

function makeBoxGroup(): THREE.Group {
  const group = new THREE.Group()
  const mesh = new THREE.Mesh(boxGeo, boxMat)
  group.add(mesh)
  return group
}

function makeBlockedGroup(): THREE.Group {
  const group = new THREE.Group()
  const mesh = new THREE.Mesh(boxGeo, blockedMat)
  group.add(mesh)
  return group
}

export default function JobParticle({ machines, connections, completionLog, timelineRefs }: JobParticleProps) {
  const containerRef = useRef<THREE.Group>(new THREE.Group())
  const particlesRef = useRef<{ jobId: number; meshes: { sphere: THREE.Group; box: THREE.Group; blocked: THREE.Group }[] }[]>([])

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

  const stationToPositions = useMemo(() => {
    const map = new Map<string, THREE.Vector3[]>()
    for (const group of pipeline) {
      const positions = group.map(m => new THREE.Vector3(m.position[0], SPHERE_HOVER_Y, m.position[2]))
      map.set(group[0].baseName, positions)
    }
    return map
  }, [pipeline])

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

  const { jobData, globalStart, globalEnd } = useMemo(() => {
    if (!completionLog) return { jobData: [], globalStart: 0, globalEnd: 1 }
    const entries = parseCompletionLog(completionLog)
    if (entries.length === 0) return { jobData: [], globalStart: 0, globalEnd: 1 }

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
      const pos: THREE.Vector3[][] = new Array(n)
      const curveKeys: string[] = new Array(n - 1)

      let totalMeshes = 0
      const stepMeshStart = new Uint32Array(n)

      for (let i = 0; i < n; i++) {
        const e = jobEntries[i]
        startMs[i] = e.startMs
        endMs[i] = e.endMs
        procMs[i] = e.processingMin * 60000
        waitMs[i] = e.waitingMin * 60000
        pos[i] = stationToPositions.get(e.station) ?? [new THREE.Vector3()]
        stepMeshStart[i] = totalMeshes
        totalMeshes += pos[i].length
        if (i < n - 1) {
          curveKeys[i] = `${e.station}|${jobEntries[i + 1].station}`
        }
        if (e.startMs < gMin) gMin = e.startMs
        if (e.endMs > gMax) gMax = e.endMs
      }

      data.push({
        jobId: jobIdx,
        startMs, endMs, procMs, waitMs, pos, curveKeys,
        totalSteps: n, totalMeshes, stepMeshStart,
        jobStart: startMs[0],
        jobEnd: endMs[n - 1],
      })
    }

    return { jobData: data, globalStart: gMin, globalEnd: gMax }
  }, [completionLog, stationToPositions])

  useEffect(() => {
    if (!timelineRefs) return
    timelineRefs.totalMs.current = globalEnd - globalStart || 1
  }, [globalStart, globalEnd, timelineRefs?.totalMs])

  useEffect(() => {
    const container = containerRef.current
    particlesRef.current = []
    container.clear()

    if (jobData.length === 0) return

    for (const jd of jobData) {
      const meshes: { sphere: THREE.Group; box: THREE.Group; blocked: THREE.Group }[] = []
      for (let si = 0; si < jd.totalSteps; si++) {
        for (const p of jd.pos[si]) {
          const sphere = makeSphereGroup()
          const box = makeBoxGroup()
          const blocked = makeBlockedGroup()
          sphere.visible = false
          box.visible = false
          blocked.visible = false
          sphere.position.copy(p)
          box.position.copy(p)
          blocked.position.copy(p)
          container.add(sphere, box, blocked)
          meshes.push({ sphere, box, blocked })
        }
      }
      particlesRef.current.push({ jobId: jd.jobId, meshes })
    }

    return () => {
      particlesRef.current = []
      container.clear()
    }
  }, [jobData])

  useFrame((_, delta) => {
    if (jobData.length === 0 || !timelineRefs) return

    const { playing, speed, scrubPct, simClockMs, totalMs } = timelineRefs

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

      const n = jd.totalSteps
      let stepIdx = -1

      for (let si = 0; si < n; si++) {
        if (now >= jd.startMs[si] && now <= jd.endMs[si]) {
          stepIdx = si
          break
        }
      }

      for (let mi = 0; mi < p.meshes.length; mi++) {
        const m = p.meshes[mi]
        m.sphere.visible = false
        m.box.visible = false
        m.blocked.visible = false
      }

      if (stepIdx === -1 && now < jd.jobStart) continue
      if (stepIdx === -1 && now > jd.jobEnd) continue

      if (stepIdx === -1) {
        for (let si = 0; si < n - 1; si++) {
          if (now > jd.endMs[si] && now < jd.startMs[si + 1]) {
            const travelDur = jd.startMs[si + 1] - jd.endMs[si]
            const t = travelDur > 0 ? (now - jd.endMs[si]) / travelDur : 1
            const clamped = Math.min(Math.max(t, 0), 0.999)

            const srcStart = jd.stepMeshStart[si]
            const srcCount = jd.pos[si].length
            const nextStart = jd.stepMeshStart[si + 1]
            const nextCount = jd.pos[si + 1].length

            for (let mi = 0; mi < srcCount; mi++) {
              p.meshes[srcStart + mi].sphere.visible = true
            }
            for (let mi = 0; mi < nextCount; mi++) {
              p.meshes[nextStart + mi].sphere.visible = true
            }

            const curve = connectionCurves.get(jd.curveKeys[si])
            if (curve) {
              for (let mi = 0; mi < srcCount; mi++) {
                p.meshes[srcStart + mi].sphere.position.lerpVectors(jd.pos[si][mi], jd.pos[si + 1][mi % nextCount], clamped)
              }
              for (let mi = 0; mi < nextCount; mi++) {
                p.meshes[nextStart + mi].sphere.position.lerpVectors(jd.pos[si][mi % srcCount], jd.pos[si + 1][mi], clamped)
              }
            } else {
              _tangent.set(0, 0, 0)
              for (const p of jd.pos[si]) _tangent.add(p)
              _tangent.divideScalar(srcCount)
              _perp.set(0, 0, 0)
              for (const p of jd.pos[si + 1]) _perp.add(p)
              _perp.divideScalar(nextCount)
              _curvePoint.lerpVectors(_tangent, _perp, clamped)
              for (let mi = 0; mi < srcCount; mi++) {
                p.meshes[srcStart + mi].sphere.position.lerpVectors(jd.pos[si][mi], _curvePoint, clamped)
              }
              for (let mi = 0; mi < nextCount; mi++) {
                p.meshes[nextStart + mi].sphere.position.lerpVectors(_curvePoint, jd.pos[si + 1][mi], clamped)
              }
            }
            break
          }
        }
        continue
      }

      const procEnd = jd.procMs[stepIdx]
      const waitEnd = procEnd + jd.waitMs[stepIdx]
      const stepLocalTime = now - jd.startMs[stepIdx]

      const isProc = stepLocalTime < procEnd
      const isWait = !isProc && stepLocalTime < waitEnd
      const isBlock = !isProc && !isWait

      const meshStart = jd.stepMeshStart[stepIdx]
      const meshCount = jd.pos[stepIdx].length
      for (let mi = 0; mi < meshCount; mi++) {
        const m = p.meshes[meshStart + mi]
        const pos = jd.pos[stepIdx][mi]
        if (isProc) { m.sphere.visible = true; m.sphere.position.copy(pos) }
        else if (isWait) { m.box.visible = true; m.box.position.copy(pos) }
        else { m.blocked.visible = true; m.blocked.position.copy(pos) }
      }
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
