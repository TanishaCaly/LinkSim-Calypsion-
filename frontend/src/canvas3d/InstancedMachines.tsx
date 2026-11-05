import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { MODEL_SCALE, animatedNodeNames, templateFor } from './StationModel'
import { utilColor, type Machine3D } from './layout'

// What a machine keeps when its model is drawn by an instanced batch: the faint
// utilisation-coloured pad on the floor (one instanced mesh), invisible click
// boxes (one instanced mesh), and one shared pad each for hover and selection.

interface InstancedMachinesProps {
  url: string
  machines: Machine3D[]
  selectedId: string | null
  onSelect: (machine: Machine3D) => void
  // Scale targets by machine id; the batch eases the models toward them.
  emphasis: React.MutableRefObject<Map<string, number>>
}

const floorY = (m: Machine3D) => m.position[1] - m.height / 2
const PAD_DEPTH = 2.2
const AMBER = new THREE.Color('#f59e0b')

export default function InstancedMachines({ url, machines, selectedId, onSelect, emphasis }: InstancedMachinesProps) {
  const { scene, animations } = useGLTF(url)
  const size = templateFor(`${url}|false`, scene, animatedNodeNames(animations)).size
  const [hovered, setHovered] = useState<number | null>(null)

  const padGeometry = useMemo(() => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), [])
  const pads = useMemo(() => {
    const material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.2, side: THREE.DoubleSide })
    const mesh = new THREE.InstancedMesh(padGeometry, material, machines.length)
    const m = new THREE.Matrix4()
    const scale = new THREE.Matrix4()
    const c = new THREE.Color()
    machines.forEach((machine, i) => {
      m.makeTranslation(machine.position[0], floorY(machine) + 0.02, machine.position[2])
      m.multiply(scale.makeScale(machine.width + 0.7, 1, PAD_DEPTH))
      mesh.setMatrixAt(i, m)
      mesh.setColorAt(i, c.set(utilColor(machine.utilization)))
    })
    mesh.frustumCulled = false
    mesh.raycast = () => {}
    return mesh
  }, [machines, padGeometry])

  const hitGeometry = useMemo(() => new THREE.BoxGeometry(1, 1, 1), [])
  const hitMaterial = useMemo(() => new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }), [])
  const hit = useRef<THREE.InstancedMesh>(null)
  useLayoutEffect(() => {
    const mesh = hit.current
    if (!mesh) return
    const [w, h, d] = [size.x * MODEL_SCALE, size.y * MODEL_SCALE, size.z * MODEL_SCALE]
    const m = new THREE.Matrix4()
    const scale = new THREE.Matrix4().makeScale(w, h, d)
    machines.forEach((machine, i) => {
      mesh.setMatrixAt(i, m.makeTranslation(machine.position[0], floorY(machine) + h / 2, machine.position[2]).multiply(scale))
    })
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
  }, [machines, size])

  // Hover and selection each light one shared pad, easing in and out.
  const hoverPad = useRef<THREE.Mesh>(null)
  const selectPad = useRef<THREE.Mesh>(null)
  const selected = selectedId === null ? -1 : machines.findIndex((m) => m.id === selectedId)
  const light = (mesh: THREE.Mesh | null, index: number | null, opacity: number, delta: number, color?: THREE.Color) => {
    if (!mesh) return
    const mat = mesh.material as THREE.MeshBasicMaterial
    const on = index !== null && index >= 0
    if (on) {
      const m = machines[index]
      mesh.position.set(m.position[0], floorY(m) + 0.03, m.position[2])
      mesh.scale.set(m.width + 0.7, 1, PAD_DEPTH)
      mat.color.copy(color ?? new THREE.Color(utilColor(m.utilization)))
    }
    mat.opacity += ((on ? opacity : 0) - mat.opacity) * Math.min(delta * 8, 1)
    mesh.visible = mat.opacity > 0.005
  }
  useFrame((_, delta) => {
    light(hoverPad.current, hovered, 0.35, delta)
    light(selectPad.current, selected, 0.25, delta, AMBER)
  })

  useEffect(() => () => {
    padGeometry.dispose()
    ;(pads.material as THREE.Material).dispose()
    pads.dispose()
    hitGeometry.dispose()
    hitMaterial.dispose()
  }, [padGeometry, pads, hitGeometry, hitMaterial])
  useEffect(() => { document.body.style.cursor = hovered === null ? 'auto' : 'pointer' }, [hovered])
  // A hovered machine grows 5%, a selected one 3%.
  useEffect(() => {
    const map = emphasis.current
    const ids: string[] = []
    const hoveredId = hovered === null ? null : machines[hovered]?.id
    if (hoveredId) { map.set(hoveredId, 1.05); ids.push(hoveredId) }
    if (selected >= 0 && selectedId !== hoveredId) { map.set(selectedId!, 1.03); ids.push(selectedId!) }
    return () => { for (const id of ids) map.delete(id) }
  }, [hovered, selected, selectedId, machines, emphasis])

  return (
    <>
      <primitive object={pads} />
      <mesh ref={hoverPad} geometry={padGeometry} raycast={() => {}} visible={false}>
        <meshBasicMaterial transparent opacity={0} side={THREE.DoubleSide} />
      </mesh>
      <mesh ref={selectPad} geometry={padGeometry} raycast={() => {}} visible={false}>
        <meshBasicMaterial transparent opacity={0} side={THREE.DoubleSide} />
      </mesh>
      <instancedMesh
        ref={hit}
        args={[hitGeometry, hitMaterial, machines.length]}
        frustumCulled={false}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => {
          if (e.instanceId === undefined) return
          e.stopPropagation()
          setHovered(e.instanceId)
        }}
        onPointerOut={() => setHovered(null)}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          if (e.instanceId === undefined) return
          e.stopPropagation()
          onSelect(machines[e.instanceId])
        }}
      />
    </>
  )
}
