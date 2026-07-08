import { useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { RoundedBox } from '@react-three/drei'
import * as THREE from 'three'
import type { Machine3D } from './layout'
import { utilColor } from './layout'

interface MachineBoxProps {
  machine: Machine3D
  selected?: boolean
  onClick: (machine: Machine3D) => void
  onHover?: (machineId: string | null) => void
}

export default function MachineBox({ machine, selected = false, onClick, onHover }: MachineBoxProps) {
  const groupRef = useRef<THREE.Group>(null)
  const glowRef = useRef<THREE.Mesh>(null)
  const [hovered, setHovered] = useState(false)
  const targetScale = useRef(new THREE.Vector3(1, 1, 1))
  const targetGlow = useRef(0)

  const color = utilColor(machine.utilization)
  const isActive = machine.utilization > 5
  const isIdle = machine.utilization <= 5

  const w = machine.width
  const h = machine.height

  useFrame((state, delta) => {
    if (!groupRef.current) return
    const s = hovered ? 1.05 : selected ? 1.03 : 1
    targetScale.current.set(s, s, s)
    groupRef.current.scale.lerp(targetScale.current, 0.1)

    if (glowRef.current) {
      const mat = glowRef.current.material as THREE.MeshBasicMaterial
      targetGlow.current = hovered ? 0.35 : selected ? 0.25 : 0
      mat.opacity += (targetGlow.current - mat.opacity) * Math.min(delta * 8, 1)
    }
  })

  return (
    <group
      ref={groupRef}
      position={machine.position}
      onClick={(e: THREE.Event) => {
        e.stopPropagation()
        onClick(machine)
      }}
      onPointerOver={(e: THREE.Event) => {
        e.stopPropagation()
        setHovered(true)
        onHover?.(machine.id)
        document.body.style.cursor = 'pointer'
      }}
      onPointerOut={() => {
        setHovered(false)
        onHover?.(null)
        document.body.style.cursor = 'auto'
      }}
    >
      {/* Glow ring under the box */}
      <mesh
        ref={glowRef}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.01, 0]}
      >
        <planeGeometry args={[w + 0.7, 2.2]} />
        <meshBasicMaterial
          color={selected ? '#f59e0b' : color}
          transparent
          opacity={0}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Main box body */}
      <RoundedBox
        args={[w, h, 1.5]}
        radius={0.12}
        smoothness={4}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial
          color={isIdle ? '#cbd5e1' : color}
          roughness={0.45}
          metalness={0.15}
          emissive={selected ? '#f59e0b' : isIdle ? '#64748b' : color}
          emissiveIntensity={selected ? 0.15 : isIdle ? 0.02 : 0.08}
          transparent={isIdle}
          opacity={isIdle ? 0.8 : 1}
        />
      </RoundedBox>

      {/* Top face accent stripe */}
      <mesh position={[0, h / 2 + 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w - 0.2, 1.3]} />
        <meshStandardMaterial
          color={color}
          roughness={0.3}
          metalness={0.2}
          transparent
          opacity={0.4}
        />
      </mesh>

      {/* Edge highlight lines */}
      {[
        { pos: [0, h / 2, -0.75] as [number, number, number], scale: [w, 0.02, 0.02] as [number, number, number] },
        { pos: [0, h / 2, 0.75] as [number, number, number], scale: [w, 0.02, 0.02] as [number, number, number] },
        { pos: [-w / 2, h / 2, 0] as [number, number, number], scale: [0.02, 0.02, 1.5] as [number, number, number] },
        { pos: [w / 2, h / 2, 0] as [number, number, number], scale: [0.02, 0.02, 1.5] as [number, number, number] },
      ].map((edge, i) => (
        <mesh key={i} position={edge.pos}>
          <boxGeometry args={edge.scale} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.2} />
        </mesh>
      ))}
    </group>
  )
}
