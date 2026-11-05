import { useMemo, useEffect } from 'react'
import * as THREE from 'three'
import type { Connection3D } from './layout'

interface FlowLineProps {
  connection: Connection3D
}

// The tube along a connection and the arrows on it.
export function buildFlow(connection: Connection3D) {
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

    const curve = new THREE.QuadraticBezierCurve3(from, control, to)
    const tubeGeo = new THREE.TubeGeometry(curve, 32, 0.08, 8, false)

    const arrowCount = Math.min(Math.floor(len / 3.5), 3)
    const arrows: { pos: THREE.Vector3; rot: number }[] = []
    for (let a = 1; a <= arrowCount; a++) {
      const t = a / (arrowCount + 1)
      const p = curve.getPoint(t)
      const tangent = curve.getTangent(t)
      const rot = Math.atan2(tangent.x, tangent.z)
      arrows.push({ pos: p, rot })
    }

    return { tubeGeometry: tubeGeo, arrowPositions: arrows }
}

export default function FlowLine({ connection }: FlowLineProps) {
  const { tubeGeometry, arrowPositions } = useMemo(() => buildFlow(connection), [connection])

  useEffect(() => () => { tubeGeometry.dispose() }, [tubeGeometry])

  return (
    <group>
      {/* Main tube */}
      <mesh geometry={tubeGeometry}>
        <meshStandardMaterial
          color="#94a3b8"
          roughness={0.5}
          metalness={0.2}
          transparent
          opacity={connection.dim ? 0.2 : 0.85}
        />
      </mesh>

      {/* Direction arrows */}
      {arrowPositions.map((arrow, i) => (
        <group key={i} position={[arrow.pos.x, arrow.pos.y, arrow.pos.z]} rotation={[0, arrow.rot, 0]}>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <coneGeometry args={[0.18, 0.4, 6]} />
            <meshStandardMaterial
              color="#64748b"
              roughness={0.4}
              metalness={0.3}
              transparent={!!connection.dim}
              opacity={connection.dim ? 0.2 : 1}
            />
          </mesh>
        </group>
      ))}
    </group>
  )
}
