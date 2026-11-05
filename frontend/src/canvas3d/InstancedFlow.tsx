import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { buildFlow } from './FlowLine'
import type { Connection3D } from './layout'

// Every flow tube as one merged mesh and every arrow as one instanced mesh,
// instead of a tube and a few cones per connection.
export default function InstancedFlow({ connections, faded = false }: { connections: Connection3D[]; faded?: boolean }) {
  const { tubes, arrows } = useMemo(() => {
    const flows = connections.map(buildFlow)
    const tubes = mergeGeometries(flows.map((f) => f.tubeGeometry))
    for (const f of flows) f.tubeGeometry.dispose()
    return { tubes, arrows: flows.flatMap((f) => f.arrowPositions) }
  }, [connections])

  const arrowGeometry = useMemo(() => new THREE.ConeGeometry(0.18, 0.4, 6), [])
  const arrowMesh = useRef<THREE.InstancedMesh>(null)
  useLayoutEffect(() => {
    const mesh = arrowMesh.current
    if (!mesh) return
    const place = new THREE.Matrix4()
    const turn = new THREE.Matrix4().makeRotationX(Math.PI / 2)
    const spin = new THREE.Matrix4()
    arrows.forEach((a, i) => {
      place.makeTranslation(a.pos.x, a.pos.y, a.pos.z).multiply(spin.makeRotationY(a.rot)).multiply(turn)
      mesh.setMatrixAt(i, place)
    })
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
  }, [arrows])

  useEffect(() => () => { tubes?.dispose(); arrowGeometry.dispose() }, [tubes, arrowGeometry])

  return (
    <group>
      {tubes && (
        <mesh geometry={tubes}>
          <meshStandardMaterial color="#94a3b8" roughness={0.5} metalness={0.2} transparent opacity={faded ? 0.2 : 0.85} />
        </mesh>
      )}
      {arrows.length > 0 && (
        <instancedMesh key={arrows.length} ref={arrowMesh} args={[arrowGeometry, undefined, arrows.length]}>
          <meshStandardMaterial color="#64748b" roughness={0.4} metalness={0.3} transparent={faded} opacity={faded ? 0.2 : 1} />
        </instancedMesh>
      )}
    </group>
  )
}
