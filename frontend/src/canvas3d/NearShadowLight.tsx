import { useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

// The sun, with a shadow map that covers only the area around where the camera is
// looking, so near shadows are sharp and nothing far away is drawn into the map.
// The area grows with the camera's distance, between `minRadius` and `maxRadius`.
export default function NearShadowLight({ intensity, minRadius = 30, maxRadius }: { intensity: number; minRadius?: number; maxRadius: number }) {
  const light = useRef<THREE.DirectionalLight>(null)
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3 } | null
  const last = useRef('')

  useFrame(() => {
    const sun = light.current
    if (!sun || !controls) return
    const t = controls.target
    const radius = Math.round(THREE.MathUtils.clamp(camera.position.distanceTo(t) * 0.9, minRadius, Math.max(minRadius, maxRadius)) / 2) * 2
    const sig = `${t.x.toFixed(1)}|${t.z.toFixed(1)}|${radius}`
    if (sig === last.current) return
    last.current = sig
    sun.position.set(t.x + 12, 25, t.z + 12)
    sun.target.position.set(t.x, 0, t.z)
    sun.target.updateMatrixWorld()
    const c = sun.shadow.camera
    c.left = -radius; c.right = radius; c.top = radius; c.bottom = -radius
    c.near = 1; c.far = 80 + radius
    c.updateProjectionMatrix()
  })

  return (
    <directionalLight
      ref={light}
      intensity={intensity}
      castShadow
      shadow-mapSize-width={2048}
      shadow-mapSize-height={2048}
      shadow-bias={-0.0005}
    />
  )
}
