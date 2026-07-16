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

const SPHERE_Y_OFFSET = 1.2

/* ------------------------------------------------------------------ */
/*  Parse the completion log for job count, bounds, and station stats  */
/* ------------------------------------------------------------------ */

interface StationPhase {
  avgProcessMin: number
  avgBlockedMin: number
  avgWaitMin: number
}

function parseCompletionLog(log: Record<string, unknown[]>) {
  let gMin = Infinity
  let gMax = -Infinity

  const stationAccum = new Map<string, {
    totalProcess: number; totalBlocked: number;
    prevCumWait: number; totalWait: number; count: number
  }>()

  // Track each job's global start and end bounds
  const jobIntervals = new Map<string, { start: number, end: number }>()
  let syntheticIdx = 0

  for (const [station, rows] of Object.entries(log)) {
    if (!stationAccum.has(station)) {
      stationAccum.set(station, {
        totalProcess: 0, totalBlocked: 0,
        prevCumWait: 0, totalWait: 0, count: 0,
      })
    }
    const acc = stationAccum.get(station)!

    for (const r of rows as Record<string, unknown>[]) {
      const sStr = r['process_start_time_real'] as string
      const eStr = r['process_end_time_real'] as string
      const jobId = (r['job_id'] as string) || `fallback-${++syntheticIdx}`
      
      if (!jobIntervals.has(jobId)) {
        jobIntervals.set(jobId, { start: Infinity, end: -Infinity })
      }
      const interval = jobIntervals.get(jobId)!

      // If timestamps are missing, synthesize them later. Otherwise, parse.
      if (sStr && eStr) {
        const startMs = new Date(sStr.replace(' ', 'T')).getTime()
        const endMs = new Date(eStr.replace(' ', 'T')).getTime()
        if (!isNaN(startMs) && startMs < gMin) gMin = startMs
        if (!isNaN(endMs) && endMs > gMax) gMax = endMs

        if (!isNaN(startMs) && startMs < interval.start) interval.start = startMs
        if (!isNaN(endMs) && endMs > interval.end) interval.end = endMs
      }

      acc.totalProcess += (r['Processing Time'] as number) || 0
      acc.totalBlocked += (r['Blocked Time'] as number) || 0

      const cumWait = (r['Waiting Time'] as number) || 0
      const jobWait = Math.max(cumWait - acc.prevCumWait, 0)
      acc.totalWait += jobWait
      acc.prevCumWait = cumWait

      acc.count++
    }
  }

  // Synthesize bounds if no real dates existed
  if (gMin === Infinity) {
    gMin = 0
    gMax = 8 * 60 * 60 * 1000 // 8 hours
    
    // Spread synthetic jobs evenly across the shift
    const jobIds = Array.from(jobIntervals.keys())
    const stagger = gMax / Math.max(jobIds.length, 1)
    const dur = 60 * 60 * 1000 // 1 hour per synthetic job
    jobIds.forEach((id, i) => {
      const interval = jobIntervals.get(id)!
      interval.start = i * stagger
      interval.end = interval.start + dur
    })
  }

  const stationPhases = new Map<string, StationPhase>()
  for (const [station, acc] of stationAccum) {
    const n = Math.max(acc.count, 1)
    stationPhases.set(station, {
      avgProcessMin: acc.totalProcess / n,
      avgBlockedMin: acc.totalBlocked / n,
      avgWaitMin: acc.totalWait / n,
    })
  }

  return {
    jobCount: jobIntervals.size,
    jobIntervals: Array.from(jobIntervals.values()),
    globalStart: gMin,
    globalEnd: gMax,
    stationPhases,
  }
}

/* ------------------------------------------------------------------ */
/*  Phase enum & colors                                                */
/* ------------------------------------------------------------------ */

enum Phase { BLOCKED, TRAVEL, WAITING, PROCESSING }

const MAT_CORE = {
  [Phase.BLOCKED]:    new THREE.MeshBasicMaterial({ color: 0xff4500 }),
  [Phase.TRAVEL]:     new THREE.MeshBasicMaterial({ color: 0x38bdf8 }),
  [Phase.WAITING]:    new THREE.MeshBasicMaterial({ color: 0xfacc15 }),
  [Phase.PROCESSING]: new THREE.MeshBasicMaterial({ color: 0x4ade80 }),
}

const MAT_GLOW = {
  [Phase.BLOCKED]:    new THREE.MeshBasicMaterial({ color: 0xff6b35, transparent: true, opacity: 0.65 }),
  [Phase.TRAVEL]:     new THREE.MeshBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.65 }),
  [Phase.WAITING]:    new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.65 }),
  [Phase.PROCESSING]: new THREE.MeshBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.65 }),
}

const sphereGeo = new THREE.SphereGeometry(0.12, 12, 12)
const glowGeo = new THREE.SphereGeometry(0.35, 10, 10)
const _curvePoint = new THREE.Vector3()

interface SegmentInfo {
  tStart: number       
  tEnd: number
  blockedEnd: number   
  travelEnd: number    
  waitEnd: number      
}

export default function JobParticle({
  machines,
  connections,
  completionLog,
  timelineRefs,
}: JobParticleProps) {
  const containerRef = useRef<THREE.Group>(new THREE.Group())
  const spheresRef = useRef<THREE.Group[]>([])
  const lastUIUpdateRef = useRef(0)

  const pipelineOrder = useMemo(() => {
    const seen = new Set<string>()
    const order: string[] = []
    for (const m of machines) {
      if (!seen.has(m.baseName)) {
        seen.add(m.baseName)
        order.push(m.baseName)
      }
    }
    return order
  }, [machines])

  const segmentCurves = useMemo(() => {
    const result: THREE.QuadraticBezierCurve3[][] = []
    const N = pipelineOrder.length

    for (let i = 0; i < N - 1; i++) {
      const fromStation = pipelineOrder[i]
      const toStation = pipelineOrder[i + 1]
      const curves: THREE.QuadraticBezierCurve3[] = []

      for (const conn of connections) {
        if (conn.fromStation === fromStation && conn.toStation === toStation) {
          const from = new THREE.Vector3(
            conn.from[0], conn.from[1] + SPHERE_Y_OFFSET, conn.from[2],
          )
          const to = new THREE.Vector3(
            conn.to[0], conn.to[1] + SPHERE_Y_OFFSET, conn.to[2],
          )
          const dir = new THREE.Vector3().subVectors(to, from)
          const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5)
          const perp = new THREE.Vector3(-dir.z, 0, dir.x).normalize()
          const curveHeight = Math.min(dir.length() * 0.12, 0.6)
          const control = mid.clone()
          control.y += curveHeight
          control.add(perp.multiplyScalar(curveHeight * 0.3))
          curves.push(new THREE.QuadraticBezierCurve3(from, control, to))
        }
      }

      result.push(curves)
    }

    return result
  }, [connections, pipelineOrder])

  const maxCurvesPerSeg = useMemo(() => {
    return Math.max(...segmentCurves.map(c => c.length), 1)
  }, [segmentCurves])

  const { particleCount, jobIntervals, globalStart, globalEnd, stationPhases } = useMemo(() => {
    if (!completionLog)
      return { particleCount: 0, jobIntervals: [], globalStart: 0, globalEnd: 1, stationPhases: new Map() }
    const r = parseCompletionLog(completionLog)
    return {
      particleCount: Math.max(r.jobCount, 1),
      jobIntervals: r.jobIntervals,
      globalStart: r.globalStart,
      globalEnd: r.globalEnd,
      stationPhases: r.stationPhases,
    }
  }, [completionLog])

  const segmentData = useMemo(() => {
    const N = pipelineOrder.length
    if (N < 2) return { totalWeight: 0, segments: [] as SegmentInfo[] }

    const durMap = new Map<string, number>()
    for (const c of connections) {
      const k = `${c.fromStation}|${c.toStation}`
      if (!durMap.has(k)) durMap.set(k, c.duration)
    }

    const segWeights: number[] = []
    const rawPhases: { blocked: number; travel: number; wait: number; process: number }[] = []

    for (let i = 0; i < N - 1; i++) {
      const fromStation = pipelineOrder[i]
      const toStation = pipelineOrder[i + 1]
      const connDur = durMap.get(`${fromStation}|${toStation}`) ?? 5

      const srcPhase = stationPhases.get(fromStation)
      const dstPhase = stationPhases.get(toStation)

      const blocked = srcPhase?.avgBlockedMin ?? 0
      const travel = Math.max(connDur * 0.3, 2) 
      const wait = dstPhase?.avgWaitMin ?? 0
      const process = dstPhase?.avgProcessMin ?? connDur

      const total = blocked + travel + wait + process
      segWeights.push(total)
      rawPhases.push({ blocked, travel, wait, process })
    }

    const totalWeight = segWeights.reduce((a, b) => a + b, 0)

    const segments: SegmentInfo[] = []
    let cum = 0
    for (let i = 0; i < segWeights.length; i++) {
      const tStart = cum / totalWeight
      cum += segWeights[i]
      const tEnd = cum / totalWeight

      const { blocked, travel, wait, process } = rawPhases[i]
      const segTotal = blocked + travel + wait + process

      const blockedEnd = blocked / segTotal
      const travelEnd = (blocked + travel) / segTotal
      const waitEnd = (blocked + travel + wait) / segTotal

      segments.push({ tStart, tEnd, blockedEnd, travelEnd, waitEnd })
    }

    return { totalWeight, segments }
  }, [connections, pipelineOrder, stationPhases])

  const traversalMs = useMemo(() => {
    const mins = segmentData.totalWeight
    return mins * 60_000 || 60_000
  }, [segmentData])

  const totalSpheres = useMemo(() => {
    return particleCount * maxCurvesPerSeg
  }, [particleCount, maxCurvesPerSeg])

  useEffect(() => {
    if (!timelineRefs) return
    const ms = globalEnd - globalStart || 1
    console.log("Timeline Bounds set to:", { globalStart, globalEnd, totalMs: ms })
    timelineRefs.totalMs.current = ms
    timelineRefs.setTotalMsUI(ms)
  }, [globalStart, globalEnd, timelineRefs])

  useEffect(() => {
    const container = containerRef.current
    spheresRef.current = []
    container.clear()

    for (let i = 0; i < totalSpheres; i++) {
      const mesh = new THREE.Mesh(sphereGeo, MAT_CORE[Phase.TRAVEL])
      const glow = new THREE.Mesh(glowGeo, MAT_GLOW[Phase.TRAVEL])
      const group = new THREE.Group()
      group.add(mesh)
      group.add(glow)
      group.visible = false
      container.add(group)
      spheresRef.current.push(group)
    }

    return () => {
      spheresRef.current = []
      container.clear()
    }
  }, [totalSpheres])

  useFrame((state, delta) => {
    if (particleCount === 0 || segmentData.segments.length === 0 || !timelineRefs) return

    const { playing, speed, scrubPct, simClockMs, totalMs, setScrubUI, setPlayingUI } = timelineRefs
    const segs = segmentData.segments

    if (playing.current) {
      simClockMs.current += delta * speed.current * 1000

      const pct = (simClockMs.current / totalMs.current) * 100
      if (pct >= 100) {
        scrubPct.current = 100
        simClockMs.current = totalMs.current
        playing.current = false
        setScrubUI(100)
        setPlayingUI(false)
      } else {
        scrubPct.current = pct
        const now = state.clock.elapsedTime
        if (now - lastUIUpdateRef.current > 0.1) {
          lastUIUpdateRef.current = now
          setScrubUI(pct)
        }
      }
    }

    // Determine how many jobs are currently active in the simulation at this exact timeline moment
    const currentAbsoluteMs = globalStart + simClockMs.current
    let activeJobCount = 0
    for (let i = 0; i < jobIntervals.length; i++) {
      if (currentAbsoluteMs >= jobIntervals[i].start && currentAbsoluteMs <= jobIntervals[i].end) {
        activeJobCount++
      }
    }

    /* --- ambient particle flow (decoupled from timeline for smooth animation) --- */
    // The number of visible particles dynamically matches the active jobs, capped at 25 for performance
    const visualCount = Math.min(activeJobCount, 25)


    let si = 0 // sphere pool index

    for (let p = 0; p < particleCount; p++) {
      // Hide particles beyond the currently active job count
      if (p >= visualCount) {
        for (let c = 0; c < maxCurvesPerSeg; c++) {
          const sphere = spheresRef.current[si]
          if (sphere) sphere.visible = false
          si++
        }
        continue
      }

      // Smooth, continuous loop from 0.0 to 1.0
      // Denominator is fixed at 25 so existing particles don't jerk around when visualCount changes
      const offset = p / 25 
      const rawProgress = (simClockMs.current / traversalMs) + offset
      const progress = rawProgress % 1.0

      let segIdx = segs.length - 1
      for (let s = 0; s < segs.length; s++) {
        if (progress >= segs[s].tStart && progress < segs[s].tEnd) {
          segIdx = s
          break
        }
      }

      const seg = segs[segIdx]
      const segLocal = seg.tEnd > seg.tStart
        ? (progress - seg.tStart) / (seg.tEnd - seg.tStart)
        : 0

      let curveT: number
      let phase: Phase

      if (segLocal < seg.blockedEnd) {
        curveT = 0
        phase = Phase.BLOCKED
      } else if (segLocal < seg.travelEnd) {
        curveT = (segLocal - seg.blockedEnd) / (seg.travelEnd - seg.blockedEnd)
        phase = Phase.TRAVEL
      } else if (segLocal < seg.waitEnd) {
        curveT = 1
        phase = Phase.WAITING
      } else {
        curveT = 1
        phase = Phase.PROCESSING
      }

      const curves = segmentCurves[segIdx]

      for (let c = 0; c < maxCurvesPerSeg; c++) {
        const sphere = spheresRef.current[si]
        if (!sphere) { si++; continue }

        if (c < curves.length) {
          curves[c].getPoint(curveT, _curvePoint)
          
          if (curveT === 0 || curveT === 1) {
            _curvePoint.x += (Math.sin(p * 13.1 + c * 3.7) * 0.4)
            _curvePoint.z += (Math.cos(p * 11.3 + c * 2.9) * 0.4)
          }

          sphere.position.copy(_curvePoint)
          sphere.visible = true

          const coreMesh = sphere.children[0] as THREE.Mesh
          const glowMesh = sphere.children[1] as THREE.Mesh
          if (coreMesh.material !== MAT_CORE[phase]) {
            coreMesh.material = MAT_CORE[phase]
            glowMesh.material = MAT_GLOW[phase]
          }
        } else {
          sphere.visible = false
        }
        si++
      }
    }

    for (; si < totalSpheres; si++) {
      const sphere = spheresRef.current[si]
      if (sphere) sphere.visible = false
    }
  })

  return <primitive object={containerRef.current} />
}
