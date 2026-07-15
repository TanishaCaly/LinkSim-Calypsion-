import { useRef, useMemo, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Machine3D } from './layout'

interface QueueStackProps {
  machine: Machine3D
}

const BLOCK_HEIGHT = 0.12
const BLOCK_GAP = 0.04
const BLOCK_SIZE = 0.4

export default function QueueStack({ machine }: QueueStackProps) {
  const [visibleCount, setVisibleCount] = useState(0)
  const lastUpdate = useRef(Date.now())
  const maxCount = machine.queueDepth

  const interval = useMemo(() => {
    if (maxCount <= 0) return 0
    return Math.max(800, 6000 / maxCount)
  }, [maxCount])

  useFrame(() => {
    if (maxCount <= 0 || visibleCount >= maxCount) return
    const now = Date.now()
    if (now - lastUpdate.current > interval) {
      setVisibleCount(c => Math.min(c + 1, maxCount))
      lastUpdate.current = now
    }
  })

  if (maxCount <= 0) return null

  return (
    <group position={[machine.position[0], 0, machine.position[2] - 1.6]}>
      {Array.from({ length: maxCount }, (_, i) => {
        const isShown = i < visibleCount
        return (
          <mesh
            key={i}
            position={[0, BLOCK_HEIGHT / 2 + i * (BLOCK_HEIGHT + BLOCK_GAP), 0]}
            castShadow
            visible={isShown}
            scale={[1, isShown ? 1 : 0, 1]}
          >
            <boxGeometry args={[BLOCK_SIZE, BLOCK_HEIGHT, BLOCK_SIZE]} />
            <meshStandardMaterial
              color="#f59e0b"
              roughness={0.4}
              metalness={0.1}
              transparent
              opacity={0.4 + (i / maxCount) * 0.5}
            />
          </mesh>
        )
      })}
      {maxCount > 0 && visibleCount > 0 && (
        <mesh position={[0, maxCount * (BLOCK_HEIGHT + BLOCK_GAP) + 0.15, 0]}>
          <boxGeometry args={[0.25, 0.08, 0.25]} />
          <meshBasicMaterial color="#f59e0b" transparent opacity={0.6} />
        </mesh>
      )}
    </group>
  )
}
