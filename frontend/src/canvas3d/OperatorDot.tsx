import { useRef, useState, useMemo, useEffect } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { makeOperatorTooltipTexture } from './makeLabelTexture'
import type { Operator3D } from './layout'

interface OperatorDotProps {
  operator: Operator3D
  onHighlight?: (machineId: string | null) => void
}

const SKILL_COLORS: Record<number, string> = {
  1: '#ef4444',
  2: '#f97316',
  3: '#f59e0b',
  4: '#22c55e',
  5: '#3b82f6',
}

function skillColor(skill: number): string {
  return SKILL_COLORS[Math.min(Math.max(skill, 1), 5)] ?? '#94a3b8'
}

export default function OperatorDot({ operator, onHighlight }: OperatorDotProps) {
  const meshRef = useRef<THREE.Mesh>(null)
  const glowRef = useRef<THREE.Mesh>(null)
  const [hovered, setHovered] = useState(false)
  const targetScale = useRef(new THREE.Vector3(1, 1, 1))

  const color = skillColor(operator.skill)

  const tooltipTexture = useMemo(
    () => makeOperatorTooltipTexture({
      name: operator.name,
      skill: operator.skill,
      availability: operator.availability,
    }),
    [operator.name, operator.skill, operator.availability],
  )

  useEffect(() => () => { tooltipTexture.dispose() }, [tooltipTexture])

  useFrame((_, delta) => {
    if (!meshRef.current) return
    const s = hovered ? 1.4 : 1
    targetScale.current.set(s, s, s)
    meshRef.current.scale.lerp(targetScale.current, 0.1)

    if (glowRef.current) {
      const mat = glowRef.current.material as THREE.MeshBasicMaterial
      mat.opacity += ((hovered ? 0.25 : 0) - mat.opacity) * Math.min(delta * 8, 1)
    }
  })

  return (
    <group position={operator.position}>
      {/* Base disc */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <circleGeometry args={[0.35, 16]} />
        <meshBasicMaterial color={color} transparent opacity={0.2} side={THREE.DoubleSide} />
      </mesh>

      {/* Glow disc */}
      <mesh
        ref={glowRef}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.02, 0]}
      >
        <circleGeometry args={[0.55, 16]} />
        <meshBasicMaterial color={color} transparent opacity={0} side={THREE.DoubleSide} />
      </mesh>

      {/* Cylinder body */}
      <mesh
        ref={meshRef}
        position={[0, 0.4, 0]}
        onPointerOver={(e) => {
          e.stopPropagation()
          setHovered(true)
          onHighlight?.(operator.machineId)
          document.body.style.cursor = 'pointer'
        }}
        onPointerOut={() => {
          setHovered(false)
          onHighlight?.(null)
          document.body.style.cursor = 'auto'
        }}
        castShadow
      >
        <cylinderGeometry args={[0.18, 0.22, 0.8, 12]} />
        <meshStandardMaterial
          color={color}
          roughness={0.35}
          metalness={0.25}
          emissive={color}
          emissiveIntensity={hovered ? 0.3 : 0.08}
        />
      </mesh>

      {/* Top cap */}
      <mesh position={[0, 0.81, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.18, 12]} />
        <meshStandardMaterial
          color={color}
          roughness={0.3}
          metalness={0.3}
        />
      </mesh>

      {/* Tooltip on hover */}
      {hovered && (
        <sprite
          position={[0, 1.3, 0]}
          scale={[2.4, 1.3, 1]}
        >
          <spriteMaterial map={tooltipTexture} transparent depthTest={false} />
        </sprite>
      )}
    </group>
  )
}
