import { useMemo } from 'react'
import * as THREE from 'three'
import { makeLabelTexture } from './makeLabelTexture'
import { utilColor } from './layout'

interface LabelSpriteProps {
  position: [number, number, number]
  text: string
  utilization?: number
  scale?: number
  selected?: boolean
}

export default function LabelSprite({ position, text, utilization, scale = 1, selected }: LabelSpriteProps) {
  const texture = useMemo(
    () => makeLabelTexture({
      text,
      badge: utilization !== undefined
        ? { text: `${utilization.toFixed(1)}%`, color: utilColor(utilization) }
        : undefined,
      shadow: true,
    }),
    [text, utilization],
  )

  return (
    <sprite
      position={[position[0], position[1] + 1.6, position[2]]}
      scale={[3.2 * scale, 1.1 * scale, 1]}
    >
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  )
}
