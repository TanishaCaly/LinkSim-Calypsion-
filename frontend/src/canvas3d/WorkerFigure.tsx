import { Suspense, useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { MutableRefObject } from 'react'
import type { Group } from 'three'
import StationModel from './StationModel'
import { STATION_MODELS } from '@/lib/stationTypes'
import { poseAt, type WorkerSeg } from './workerSchedule'
import type { AnimState } from './stationActivity'
import type { TagAnchor } from './tags'
import { along, steer, type Route } from './walkPath'

// Where every Worker is right now, so a Worker can walk round the others.
const others = new Map<string, [number, number]>()
const SIDE_BY_SIDE = 1.1 // Workers at the same station stand this far apart

type Router = ((a: [number, number], b: [number, number]) => Route) & { open: (x: number, z: number) => boolean }

interface Props {
  id: string
  route: Router
  home: [number, number, number]
  segs: WorkerSeg[]
  spot: (station: string) => [number, number] | undefined
  // This Worker's place among the pool's Workers: at a shared station they stand side by side, not on one spot.
  slot: number
  slots: number
  globalStart: number
  travel: number
  clock: MutableRefObject<number>
  anchor?: TagAnchor
}

// A pool Worker that walks to the station it is working at, following the replay clock.
export default function WorkerFigure({ id, route, home, segs, spot, slot, slots, globalStart, travel, clock, anchor }: Props) {
  const group = useRef<Group>(null)
  const state = useRef<AnimState>('Waiting')
  const facing = useRef(0)
  const lastRaw = useRef<[number, number] | null>(null)
  const side = useRef<[number, number]>([0, 0]) // current sidestep, eased so it never jumps
  const getState = useRef(() => state.current).current
  useEffect(() => () => { others.delete(id) }, [id])

  useFrame((_, delta) => {
    const g = group.current
    if (!g) return
    const pose = poseAt(segs, globalStart + clock.current, travel)
    const shift = (slot - (slots - 1) / 2) * SIDE_BY_SIDE
    const at = (s: string | null): [number, number] => {
      const p = s && spot(s)
      return p ? [p[0] + shift, p[1]] : [home[0], home[2]]
    }
    let x: number, z: number
    let hx = 0, hz = 0
    if (pose.to) {
      const w = along(route(at(pose.from), at(pose.to)), pose.k)
      x = w.x; z = w.z
      hx = w.dx; hz = w.dz
    } else [x, z] = at(pose.station)

    // Steer round any other Worker ahead (standing or walking) by stepping to the side, easing in and out.
    const hl = Math.hypot(hx, hz)
    const [tx, tz] = hl > 1e-6 ? steer(id, x, z, hx, hz, others, route.open) : [0, 0]
    // Ease by distance walked (not just time), so the sidestep keeps up at fast replay speeds.
    const moved = lastRaw.current ? Math.hypot(x - lastRaw.current[0], z - lastRaw.current[1]) : 0
    lastRaw.current = [x, z]
    const k = 1 - Math.exp(-(6 * Math.min(delta, 0.1) + Math.min(moved, 2) / 0.5))
    side.current[0] += (tx - side.current[0]) * k
    side.current[1] += (tz - side.current[1]) * k
    x += side.current[0]
    z += side.current[1]
    if (hl > 1e-6) facing.current = Math.atan2(hx + side.current[0] * 0.5, hz + side.current[1] * 0.5)
    others.set(id, [x, z])
    g.position.set(x, 0, z)
    g.rotation.y = facing.current
    state.current = pose.working || pose.to ? 'Running' : 'Waiting'
    if (anchor) { anchor.pos[0] = x; anchor.pos[2] = z }
  })

  return (
    <group ref={group} position={home}>
      <Suspense fallback={null}>
        <StationModel url={STATION_MODELS.Worker} getState={getState} inPlace />
      </Suspense>
    </group>
  )
}
