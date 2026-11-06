import { Suspense, useRef, useState, useMemo, useEffect } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { makeOperatorTooltipTexture } from './makeLabelTexture'
import type { Operator3D } from './layout'
import StationModel from './StationModel'
import type { AnimState } from './stationActivity'
import { STATION_MODELS } from '@/lib/stationTypes'

interface OperatorDotProps {
  operator: Operator3D
  getState?: () => AnimState
}

const SKILL_COLORS: Record<number, string> = {
  1: '#F04438',
  2: '#f97316',
  3: '#F59E0B',
  4: '#12B76A',
  5: '#3E8BF5',
}

export function skillColor(skill: number): string {
  return SKILL_COLORS[Math.min(Math.max(skill, 1), 5)] ?? '#94a3b8'
}

export default function OperatorDot({ operator, getState }: OperatorDotProps) {
  const glowRef = useRef<THREE.Mesh>(null)
  const [hovered, setHovered] = useState(false)

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

  // Hover feedback is the floor glow and the tooltip — the model keeps its size.
  useFrame((_, delta) => {
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

      {/* Body: the Worker model, or the skill-colored cylinder while it loads */}
      <group
        onPointerOver={(e) => {
          e.stopPropagation()
          setHovered(true)
          document.body.style.cursor = 'pointer'
        }}
        onPointerOut={() => {
          setHovered(false)
          document.body.style.cursor = 'auto'
        }}
      >
        <Suspense
          fallback={
            <>
              <mesh position={[0, 0.4, 0]} castShadow>
                <cylinderGeometry args={[0.18, 0.22, 0.8, 12]} />
                <meshStandardMaterial
                  color={color}
                  roughness={0.35}
                  metalness={0.25}
                  emissive={color}
                  emissiveIntensity={hovered ? 0.3 : 0.08}
                />
              </mesh>
              <mesh position={[0, 0.81, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                <circleGeometry args={[0.18, 12]} />
                <meshStandardMaterial color={color} roughness={0.3} metalness={0.3} />
              </mesh>
            </>
          }
        >
          <StationModel url={STATION_MODELS.Worker} getState={getState} inPlace />
        </Suspense>
      </group>

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
