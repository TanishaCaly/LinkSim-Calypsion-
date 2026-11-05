import { useEffect, useRef } from 'react'
import type * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { isWebGPU } from './renderer'

export interface PerfSample {
  renderer: string
  fps: number
  medianMs: number
  p95Ms: number
  calls: number
  triangles: number
}

declare global {
  interface Window { __perf?: PerfSample }
}

// Dev only: once a second, writes frame timing and the renderer's draw-call and
// triangle counts to window.__perf, so renderers and scene sizes can be compared
// from the console.
// Draw calls and triangles the scene would send, by the 'cat:' group each object sits in
// (main pass only; objects that cast shadows are drawn again in the shadow pass).
function breakdown(scene: THREE.Object3D) {
  const cats: Record<string, { meshes: number; casters: number; tris: number; casterTris: number }> = {}
  const walk = (o: THREE.Object3D, cat: string) => {
    if (!o.visible) return
    const here = o.name.startsWith('cat:') ? o.name.slice(4) : cat
    const mesh = o as THREE.Mesh
    if (mesh.isMesh || (o as THREE.Points).isPoints) {
      const g = mesh.geometry
      const per = g.index ? g.index.count / 3 : g.attributes.position.count / (mesh.isMesh ? 3 : 1)
      const n = (o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count : 1
      const c = (cats[here] ??= { meshes: 0, casters: 0, tris: 0, casterTris: 0 })
      c.meshes++
      c.tris += per * n
      if (o.castShadow) { c.casters++; c.casterTris += per * n }
    }
    for (const child of o.children) walk(child, here)
  }
  walk(scene, 'other')
  return Object.entries(cats)
    .map(([name, c]) => ({ name, ...c, tris: Math.round(c.tris), casterTris: Math.round(c.casterTris) }))
    .sort((a, b) => b.tris - a.tris)
}

declare global {
  interface Window { __breakdown?: () => ReturnType<typeof breakdown> }
}

export default function PerfProbe() {
  const gl = useThree(s => s.gl)
  const scene = useThree(s => s.scene)
  const acc = useRef({ ms: [] as number[], t: 0 })
  useEffect(() => {
    window.__breakdown = () => breakdown(scene)
    return () => { delete window.__breakdown }
  }, [scene])

  useFrame((_, dt) => {
    const a = acc.current
    a.ms.push(dt * 1000)
    a.t += dt
    if (a.t < 1) return
    const sorted = [...a.ms].sort((p, q) => p - q)
    const info = (gl as unknown as { info: { render: { calls: number; triangles: number } } }).info.render
    window.__perf = {
      renderer: isWebGPU(gl) ? 'webgpu' : 'webgl',
      fps: Math.round((a.ms.length / a.t) * 10) / 10,
      medianMs: Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10,
      p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10,
      calls: info.calls,
      triangles: info.triangles,
    }
    a.ms = []
    a.t = 0
  })
  return null
}
