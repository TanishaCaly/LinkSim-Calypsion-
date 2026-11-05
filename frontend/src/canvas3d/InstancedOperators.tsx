import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { STATION_MODELS } from '@/lib/stationTypes'
import InstancedStations, { type BatchItem } from './InstancedStations'
import { makeOperatorTooltipTexture } from './makeLabelTexture'
import { skillColor } from './OperatorDot'
import type { Operator3D } from './layout'
import type { AnimState } from './stationActivity'

// Every operator at once: the workers as one batch, the skill-coloured discs
// under them as another, and a single glow disc and tooltip that follow
// whichever operator the pointer is over.

// How far in front of an operator a click box must be to hide them, in world units.
const OWN_BOX = 2.2

interface InstancedOperatorsProps {
  operators: Operator3D[]
  // An operator's Running/Waiting state: the machine they work at.
  stateOf: (operator: Operator3D) => (() => AnimState) | undefined
}

export default function InstancedOperators({ operators, stateOf }: InstancedOperatorsProps) {
  const [hovered, setHovered] = useState<number | null>(null)
  const glow = useRef<THREE.Mesh>(null)
  const tooltips = useRef(new Map<string, THREE.CanvasTexture>())

  const items = useMemo<BatchItem[]>(
    () => operators.map((op) => ({ id: op.id, position: op.position, getState: stateOf(op) })),
    [operators, stateOf],
  )

  const discs = useMemo(() => {
    const geometry = new THREE.CircleGeometry(0.35, 16).rotateX(-Math.PI / 2)
    const material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.2, side: THREE.DoubleSide })
    const mesh = new THREE.InstancedMesh(geometry, material, operators.length)
    const m = new THREE.Matrix4()
    const c = new THREE.Color()
    operators.forEach((op, i) => {
      mesh.setMatrixAt(i, m.makeTranslation(op.position[0], op.position[1] + 0.01, op.position[2]))
      mesh.setColorAt(i, c.set(skillColor(op.skill)))
    })
    mesh.frustumCulled = false
    mesh.raycast = () => {}
    return mesh
  }, [operators])

  // Invisible boxes that take the pointer: the worker batch is posed on the GPU, so
  // the CPU cannot hit-test it.
  const hit = useRef<THREE.InstancedMesh>(null)
  const hitGeometry = useMemo(() => new THREE.BoxGeometry(0.7, 1.6, 0.7).translate(0, 0.8, 0), [])
  const hitMaterial = useMemo(() => new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }), [])
  useLayoutEffect(() => {
    const mesh = hit.current
    if (!mesh) return
    const m = new THREE.Matrix4()
    operators.forEach((op, i) => mesh.setMatrixAt(i, m.makeTranslation(...op.position)))
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
  }, [operators])

  const glowGeometry = useMemo(() => new THREE.CircleGeometry(0.55, 16).rotateX(-Math.PI / 2), [])

  useEffect(() => () => {
    discs.geometry.dispose()
    ;(discs.material as THREE.Material).dispose()
    discs.dispose()
    glowGeometry.dispose()
    hitGeometry.dispose()
    hitMaterial.dispose()
  }, [discs, glowGeometry, hitGeometry, hitMaterial])
  useEffect(() => {
    const cache = tooltips.current
    return () => { for (const t of cache.values()) t.dispose(); cache.clear() }
  }, [])

  useEffect(() => {
    document.body.style.cursor = hovered === null ? 'auto' : 'pointer'
  }, [hovered])

  const op = hovered === null ? null : operators[hovered]
  // Built the first time an operator is hovered, then kept.
  const tooltip = useMemo(() => {
    if (!op) return null
    let texture = tooltips.current.get(op.id)
    if (!texture) {
      texture = makeOperatorTooltipTexture({ name: op.name, skill: op.skill, availability: op.availability })
      tooltips.current.set(op.id, texture)
    }
    return texture
  }, [op])

  // The pointer is tested against the hit boxes here, not through the event system,
  // because an instanced mesh posed on the GPU needs this one cheap test per frame.
  const dom = useThree((s) => s.gl.domElement)
  const over = useRef<number | null>(null)
  useEffect(() => {
    const leave = () => { over.current = null; setHovered(null) }
    dom.addEventListener('pointerleave', leave)
    return () => dom.removeEventListener('pointerleave', leave)
  }, [dom])

  useFrame((state, delta) => {
    if (hit.current) {
      state.raycaster.setFromCamera(state.pointer, state.camera)
      const first = state.raycaster.intersectObject(hit.current, false)[0]
      let next = first?.instanceId ?? null
      // Another machine's click box well in front hides the operator. Their own machine's box
      // overlaps the spot they stand on, so it only counts when it is more than OWN_BOX nearer.
      if (first) {
        const nearer = state.raycaster.intersectObjects(state.internal.interaction, true)[0]
        if (nearer && first.distance - nearer.distance > OWN_BOX) next = null
      }
      if (next !== over.current) {
        over.current = next
        setHovered(next)
      }
    }
    const mesh = glow.current
    if (!mesh) return
    const mat = mesh.material as THREE.MeshBasicMaterial
    mat.opacity += ((op ? 0.25 : 0) - mat.opacity) * Math.min(delta * 8, 1)
    mesh.visible = mat.opacity > 0.005
  })

  return (
    <>
      <primitive object={discs} />
      <mesh ref={glow} geometry={glowGeometry} position={op ? [op.position[0], op.position[1] + 0.02, op.position[2]] : [0, -10, 0]} raycast={() => {}}>
        <meshBasicMaterial color={op ? skillColor(op.skill) : '#ffffff'} transparent opacity={0} side={THREE.DoubleSide} />
      </mesh>
      <Suspense fallback={null}>
        <InstancedStations url={STATION_MODELS.Worker} items={items} inPlace lod={false} fullPx={14} />
      </Suspense>
      <instancedMesh ref={hit} args={[hitGeometry, hitMaterial, operators.length]} frustumCulled={false} />
      {op && tooltip && (
        <sprite position={[op.position[0], op.position[1] + 1.3, op.position[2]]} scale={[2.4, 1.3, 1]}>
          <spriteMaterial map={tooltip} transparent depthTest={false} />
        </sprite>
      )}
    </>
  )
}
