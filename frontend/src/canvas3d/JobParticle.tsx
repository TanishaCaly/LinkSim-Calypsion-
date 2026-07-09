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

const SPHERE_Y_OFFSET = 0.35

/* ------------------------------------------------------------------ */
/*  Parse the completion log to extract job count & timeline bounds    */
/* ------------------------------------------------------------------ */

function countJobsAndBounds(log: Record<string, unknown[]>) {
  const jobIds = new Set<string>()
  let gMin = Infinity
  let gMax = -Infinity

  for (const [, rows] of Object.entries(log)) {
    let idx = 0
    for (const r of rows as Record<string, unknown>[]) {
      const sStr = r['process_start_time_real'] as string
      const eStr = r['process_end_time_real'] as string
      const jobId = (r['job_id'] as string) || `fallback-${++idx}`
      if (!sStr || !eStr) continue
      jobIds.add(jobId)
      const startMs = new Date(sStr.replace(' ', 'T').replace(' ', '')).getTime()
      const endMs = new Date(eStr.replace(' ', 'T').replace(' ', '')).getTime()
      if (startMs < gMin) gMin = startMs
      if (endMs > gMax) gMax = endMs
    }
  }

  return {
    jobCount: jobIds.size,
    globalStart: gMin === Infinity ? 0 : gMin,
    globalEnd: gMax === -Infinity ? 1 : gMax,
  }
}

/* ------------------------------------------------------------------ */
/*  Shared geometries & materials (blue glow style)                    */
/* ------------------------------------------------------------------ */

const sphereGeo = new THREE.SphereGeometry(0.12, 12, 12)
const sphereMat = new THREE.MeshBasicMaterial({ color: '#60a5fa' })
const glowGeo = new THREE.SphereGeometry(0.25, 10, 10)
const glowMat = new THREE.MeshBasicMaterial({
  color: '#3b82f6',
  transparent: true,
  opacity: 0.4,
})

const _curvePoint = new THREE.Vector3()

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function JobParticle({
  machines,
  connections,
  completionLog,
  timelineRefs,
}: JobParticleProps) {
  const containerRef = useRef<THREE.Group>(new THREE.Group())
  const spheresRef = useRef<THREE.Group[]>([])
  const lastUIUpdateRef = useRef(0)

  /* ---------- ordered unique station names ---------- */
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

  /* ---------- curves grouped by segment ---------- */
  /*
   * For segment i (station[i] → station[i+1]), collect ALL connection
   * curves between every machine pair. This is the key to the split/merge
   * visual: each particle shows one sub-sphere on every tube.
   */
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

  /* ---------- max curves in any single segment ---------- */
  const maxCurvesPerSeg = useMemo(() => {
    return Math.max(...segmentCurves.map(c => c.length), 1)
  }, [segmentCurves])

  /* ---------- weighted pipeline segments ---------- */
  const segmentData = useMemo(() => {
    const N = pipelineOrder.length
    if (N < 2) return { totalWeight: 0, segments: [] }

    const durMap = new Map<string, number>()
    for (const c of connections) {
      const k = `${c.fromStation}|${c.toStation}`
      if (!durMap.has(k)) durMap.set(k, c.duration)
    }

    const weights: number[] = []
    for (let i = 0; i < N - 1; i++) {
      const k = `${pipelineOrder[i]}|${pipelineOrder[i + 1]}`
      weights.push(durMap.get(k) ?? 5)
    }

    const totalWeight = weights.reduce((a, b) => a + b, 0)

    const segments: { tStart: number; tEnd: number }[] = []
    let cum = 0
    for (const w of weights) {
      const tStart = cum / totalWeight
      cum += w
      segments.push({ tStart, tEnd: cum / totalWeight })
    }

    return { totalWeight, segments }
  }, [connections, pipelineOrder])

  /* ---------- job count & timeline bounds ---------- */
  const { particleCount, globalStart, globalEnd } = useMemo(() => {
    if (!completionLog)
      return { particleCount: 0, globalStart: 0, globalEnd: 1 }
    const r = countJobsAndBounds(completionLog)
    return {
      particleCount: Math.max(r.jobCount, 1),
      globalStart: r.globalStart,
      globalEnd: r.globalEnd,
    }
  }, [completionLog])

  /* ---------- traversal duration (sim-ms for one pipeline pass) ---------- */
  const traversalMs = useMemo(() => {
    const mins = segmentData.totalWeight
    return mins * 60_000 || 60_000
  }, [segmentData])

  /* ---------- total sphere pool size ---------- */
  const totalSpheres = useMemo(() => {
    return particleCount * maxCurvesPerSeg
  }, [particleCount, maxCurvesPerSeg])

  /* ---------- set timeline bounds ---------- */
  useEffect(() => {
    if (!timelineRefs) return
    const ms = globalEnd - globalStart || 1
    timelineRefs.totalMs.current = ms
    timelineRefs.setTotalMsUI(ms)
  }, [globalStart, globalEnd, timelineRefs])

  /* ---------- create sphere pool ---------- */
  useEffect(() => {
    const container = containerRef.current
    spheresRef.current = []
    container.clear()

    for (let i = 0; i < totalSpheres; i++) {
      const mesh = new THREE.Mesh(sphereGeo, sphereMat)
      const glow = new THREE.Mesh(glowGeo, glowMat)
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

  /* ---------- per-frame update ---------- */
  useFrame((state, delta) => {
    if (
      particleCount === 0 ||
      segmentData.segments.length === 0 ||
      !timelineRefs
    )
      return

    const {
      playing, speed, scrubPct, simClockMs, totalMs,
      setScrubUI, setPlayingUI,
    } = timelineRefs
    const segs = segmentData.segments

    /* --- advance simulation clock --- */
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

    /*
     * Each particle enters the pipeline at a staggered time and
     * traverses it exactly once. During each segment, it spawns one
     * sub-sphere on EVERY connection curve for that segment, creating
     * the visual split across machines and merge at the next station.
     */
    const lastIdx = Math.max(particleCount - 1, 1)
    const stagger = Math.max((totalMs.current - traversalMs) / lastIdx, 0)

    let si = 0 // sphere pool index

    for (let p = 0; p < particleCount; p++) {
      const startMs = p * stagger
      const progress = (simClockMs.current - startMs) / traversalMs

      if (progress < 0 || progress >= 1) {
        // Not started or finished — hide all sub-spheres for this particle
        for (let c = 0; c < maxCurvesPerSeg; c++) {
          const sphere = spheresRef.current[si]
          if (sphere) sphere.visible = false
          si++
        }
        continue
      }

      // Find which segment this progress falls in
      let segIdx = segs.length - 1
      for (let s = 0; s < segs.length; s++) {
        if (progress >= segs[s].tStart && progress < segs[s].tEnd) {
          segIdx = s
          break
        }
      }

      const seg = segs[segIdx]
      const localT =
        seg.tEnd > seg.tStart
          ? (progress - seg.tStart) / (seg.tEnd - seg.tStart)
          : 0
      const curves = segmentCurves[segIdx]

      // Show one sub-sphere on each connection curve of this segment
      for (let c = 0; c < maxCurvesPerSeg; c++) {
        const sphere = spheresRef.current[si]
        if (!sphere) { si++; continue }

        if (c < curves.length) {
          curves[c].getPoint(localT, _curvePoint)
          sphere.position.copy(_curvePoint)
          sphere.visible = true
        } else {
          sphere.visible = false
        }
        si++
      }
    }

    // Hide any remaining unused spheres
    for (; si < totalSpheres; si++) {
      const sphere = spheresRef.current[si]
      if (sphere) sphere.visible = false
    }
  })

  return <primitive object={containerRef.current} />
}
