import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { Machine3D } from './layout'

// Smoothly moves the camera for two features: focusing a clicked machine and
// the top view. Each remembers the pose it left, so closing the machine panel
// (or leaving top view) flies back to exactly where you were.

interface Pose {
  position: THREE.Vector3
  target: THREE.Vector3
}

// The slice of drei's OrbitControls this uses (registered via makeDefault).
interface Controls {
  target: THREE.Vector3
  minDistance: number
  update: () => void
  addEventListener: (type: 'start', fn: () => void) => void
  removeEventListener: (type: 'start', fn: () => void) => void
}

interface CameraRigProps {
  focus: Machine3D | null
  topView: boolean
  // Layout footprint, for fitting the whole floor in top view.
  fit: { cx: number; cz: number; w: number; d: number }
}

const SPEED = 7 // 1/s — higher is snappier
const PANEL_PX = 320 // the machine detail panel covers this much of the right edge
const WORLD_UP = new THREE.Vector3(0, 1, 0)

export default function CameraRig({ focus, topView, fit }: CameraRigProps) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const controls = useThree((s) => s.controls) as unknown as Controls | null
  const size = useThree((s) => s.size)

  const dest = useRef<Pose | null>(null)
  const beforeTop = useRef<Pose | null>(null)
  const beforeFocus = useRef<Pose | null>(null)

  // Where the camera is heading, or where it is if it's not moving — so a pose
  // saved mid-flight is the one the user was about to see.
  const settledPose = (): Pose => dest.current
    ?? { position: camera.position.clone(), target: controls!.target.clone() }

  const flyTo = (pose: Pose) => { dest.current = pose }

  // Any manual orbit/pan/zoom takes over from the animation.
  useEffect(() => {
    if (!controls) return
    const stop = () => { dest.current = null }
    controls.addEventListener('start', stop)
    return () => controls.removeEventListener('start', stop)
  }, [controls])

  // Focus on a machine / return when it's deselected. Declared before the top
  // view effect so that, when both change at once, top view wins.
  useEffect(() => {
    if (!controls) return
    if (focus) {
      const from = settledPose()
      beforeFocus.current ??= from

      const dir = from.position.clone().sub(from.target)
      if (dir.lengthSq() < 1e-6) dir.set(1, 1, 1)
      dir.normalize()
      const dist = Math.max(controls.minDistance + 1, focus.width * 3.2 + focus.height * 1.5, 8)

      // Nudge the machine left of centre so the detail panel doesn't cover it.
      const right = new THREE.Vector3().crossVectors(WORLD_UP, dir)
      if (right.lengthSq() < 1e-6) right.set(1, 0, 0)
      right.normalize()
      const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
      const shift = (PANEL_PX * dist * tanHalf) / size.height

      const target = new THREE.Vector3(...focus.position).addScaledVector(right, shift)
      flyTo({ target, position: target.clone().addScaledVector(dir, dist) })
    } else if (beforeFocus.current) {
      flyTo(beforeFocus.current)
      beforeFocus.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.id, controls])

  useEffect(() => {
    if (!controls) return
    if (topView) {
      beforeTop.current ??= settledPose()
      const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
      // Extra room at the bottom (+z) for the playback bar over the canvas.
      const padTop = 4
      const padBottom = 12
      const pad = (padTop + padBottom) / 2
      const along = (padBottom - padTop) / 2
      const upright = Math.max((fit.d / 2 + pad) / tanHalf, (fit.w / 2 + 4) / (tanHalf * camera.aspect))
      const sideways = Math.max((fit.w / 2 + pad) / tanHalf, (fit.d / 2 + 4) / (tanHalf * camera.aspect))
      // A hair off vertical sets which way is "up" on screen. Upright (-z up):
      // step 0 at the top, flow left to right like the 2D view. A tall hall on
      // a wide screen is turned a quarter (+x up) so it fills the width.
      if (upright <= sideways) {
        const centerZ = fit.cz + along
        flyTo({
          target: new THREE.Vector3(fit.cx, 0, centerZ),
          position: new THREE.Vector3(fit.cx, upright, centerZ + upright * 0.001),
        })
      } else {
        const centerX = fit.cx - along
        flyTo({
          target: new THREE.Vector3(centerX, 0, fit.cz),
          position: new THREE.Vector3(centerX - sideways * 0.001, sideways, fit.cz),
        })
      }
    } else if (beforeTop.current) {
      flyTo(beforeTop.current)
      beforeTop.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topView, controls])

  useFrame((_, delta) => {
    const to = dest.current
    if (!to || !controls) return
    const k = 1 - Math.exp(-delta * SPEED)
    camera.position.lerp(to.position, k)
    controls.target.lerp(to.target, k)
    if (camera.position.distanceTo(to.position) < 0.02 && controls.target.distanceTo(to.target) < 0.02) {
      camera.position.copy(to.position)
      controls.target.copy(to.target)
      dest.current = null
    }
    controls.update()
  })

  return null
}
