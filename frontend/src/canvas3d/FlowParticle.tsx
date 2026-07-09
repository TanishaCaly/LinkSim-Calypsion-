import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Connection3D } from './layout'
import type { TimelineRefs } from './Scene'

interface FlowParticleProps {
  connection: Connection3D
  count?: number
  timelineRefs?: TimelineRefs
}

export default function FlowParticle({ connection, count = 2, timelineRefs }: FlowParticleProps) {
  const groupRef = useRef<THREE.Group>(null)
  const particlesRef = useRef<THREE.Mesh[]>([])
  const glowsRef = useRef<THREE.Mesh[]>([])

  const curve = useMemo(() => {
    const from = new THREE.Vector3(...connection.from)
    const to = new THREE.Vector3(...connection.to)
    const dir = new THREE.Vector3().subVectors(to, from)
    const len = dir.length()
    const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5)
    const perp = new THREE.Vector3(-dir.z, 0, dir.x).normalize()
    const curveHeight = Math.min(len * 0.12, 0.6)
    const control = mid.clone()
    control.y += curveHeight
    control.add(perp.multiplyScalar(curveHeight * 0.3))
    return new THREE.QuadraticBezierCurve3(from, control, to)
  }, [connection.from, connection.to])

  const speed = useMemo(() => {
    return 1 / Math.max(connection.duration, 1) * 0.8
  }, [connection.duration])

  const offsets = useMemo(() => {
    return Array.from({ length: count }, (_, i) => i / count)
  }, [count])

  useFrame((state, delta) => {
    let globalTime = Date.now() * 0.001
    if (timelineRefs && timelineRefs.simClockMs) {
      globalTime = timelineRefs.simClockMs.current * 0.001
    }
    for (let i = 0; i < count; i++) {
      const mesh = particlesRef.current[i]
      const glow = glowsRef.current[i]
      if (!mesh) continue
      const t = ((globalTime * speed + offsets[i]) % 1)
      const pos = curve.getPoint(t)
      mesh.position.set(pos.x, pos.y, pos.z)
      if (glow) {
        glow.position.set(pos.x, pos.y, pos.z)
      }
    }
  })

  return (
    <group ref={groupRef}>
      {offsets.map((_, i) => (
        <group key={i}>
          {/* Inner bright core */}
          <mesh
            ref={el => { if (el) particlesRef.current[i] = el }}
          >
            <sphereGeometry args={[0.12, 12, 12]} />
            <meshBasicMaterial color="#60a5fa" />
          </mesh>
          {/* Outer glow shell */}
          <mesh
            ref={el => { if (el) glowsRef.current[i] = el }}
          >
            <sphereGeometry args={[0.25, 10, 10]} />
            <meshBasicMaterial color="#3b82f6" />
          </mesh>
        </group>
      ))}
    </group>
  )
}
