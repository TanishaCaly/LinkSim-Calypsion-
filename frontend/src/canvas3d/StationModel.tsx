import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useAnimations, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { STATION_MODELS } from '@/lib/stationTypes'
import type { AnimState } from './stationActivity'
import { mergeStaticParts } from './mergeStaticParts'

// One shared scale keeps every model in its authored proportion to the others.
export const MODEL_SCALE = 1.4

export const FADE_S = 0.3

// The Worker model's Running clip walks the whole figure away and back. For
// an in-place version, keep only the arm swing (both arms in phase) and the
// body bob, and pin the figure to its resting spot. `rest` is the Worker
// node's position in the model itself. Every clip places the Worker over a
// unit in front of the model origin (Waiting too, not just the walk), so those
// tracks are dropped from all of them — otherwise the figure stands off its disc.
const WALK_TRACKS = new Set(['Worker.position', 'Worker.quaternion', 'hip.quaternion', 'hip_1.quaternion'])

export function workInPlace(clip: THREE.AnimationClip, rest: THREE.Vector3): THREE.AnimationClip {
  if (clip.name !== 'Running') {
    return new THREE.AnimationClip(clip.name, clip.duration, clip.tracks.filter((t) => !WALK_TRACKS.has(t.name)))
  }
  const track = (name: string) => clip.tracks.find((t) => t.name === name)
  const tracks: THREE.KeyframeTrack[] = []

  const pos = track('Worker.position')
  if (pos) {
    const v = Array.from(pos.values)
    for (let i = 0; i < v.length; i += 3) {
      v[i] = rest.x
      v[i + 1] = rest.y + (pos.values[i + 1] - pos.values[1])
      v[i + 2] = rest.z
    }
    tracks.push(new THREE.VectorKeyframeTrack(pos.name, Array.from(pos.times), v))
  }

  const left = track('shoulder.quaternion')
  const right = track('shoulder_1.quaternion')
  if (left && right) {
    tracks.push(left)
    tracks.push(new THREE.QuaternionKeyframeTrack(right.name, Array.from(left.times), Array.from(left.values)))
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}

// Merged model, built once per file (and in-place flag) and cloned per use.
const templates = new Map<string, { object: THREE.Object3D; offset: THREE.Vector3; height: number; size: THREE.Vector3 }>()

export function templateFor(key: string, scene: THREE.Object3D, animated: Set<string>) {
  let template = templates.get(key)
  if (!template) {
    const object = mergeStaticParts(scene, animated)
    const box = new THREE.Box3().setFromObject(object)
    const center = box.getCenter(new THREE.Vector3())
    template = { object, offset: new THREE.Vector3(-center.x, -box.min.y, -center.z), height: box.max.y - box.min.y, size: box.getSize(new THREE.Vector3()) }
    templates.set(key, template)
  }
  return template
}

// Names of the nodes a set of clips moves.
export const animatedNodeNames = (clips: THREE.AnimationClip[]) => new Set(clips.flatMap((c) => c.tracks.map((t) => t.name.split('.')[0])))

// How tall a loaded machine model stands on the floor, or undefined until it has loaded.
export function modelHeight(url: string): number | undefined {
  const template = templates.get(`${url}|false`)
  return template && template.height * MODEL_SCALE
}

interface StationModelProps {
  url: string
  // Which clip to play, read every frame (no run loaded → always Waiting).
  // Clips keep looping while the timeline is paused; only the state follows
  // the scrub position.
  getState?: () => AnimState
  // Work at the spot instead of walking (the Worker model).
  inPlace?: boolean
}

export default function StationModel({ url, getState, inPlace = false }: StationModelProps) {
  const { scene, animations } = useGLTF(url)
  const rootRef = useRef<THREE.Group>(null)
  const clips = useMemo(() => {
    if (!inPlace) return animations
    const rest = scene.getObjectByName('Worker')?.position ?? new THREE.Vector3()
    return animations.map((c) => workInPlace(c, rest))
  }, [animations, scene, inPlace])
  const { actions } = useAnimations(clips, rootRef)
  const current = useRef<AnimState | null>(null)
  // Where in its loop this instance starts each clip, so identical models
  // don't all move in lockstep.
  const phase = useMemo(() => Math.random(), [])

  // Nodes the clips move, and the ones they scale.
  const animated = useMemo(() => animatedNodeNames(clips), [clips])
  const scaled = useMemo(
    () => new Set(clips.flatMap((c) => c.tracks.filter((t) => t.name.endsWith('.scale')).map((t) => t.name.split('.')[0]))),
    [clips],
  )

  // One merged template per model; each instance is a clone of it (geometry
  // and materials stay shared), sat on the floor and centred on its origin.
  // The model's own meshes take pointer events, so hover and click follow
  // whatever is drawn, animation included.
  const object = useMemo(() => {
    const template = templateFor(`${url}|${inPlace}`, scene, animated)
    const object = template.object.clone(true)
    object.position.copy(template.offset)
    // The Workplace model has a person built in; the people in 3D are the Worker nodes, as in Build.
    if (url === STATION_MODELS.Workplace) object.getObjectByName('worker')?.traverse((o) => { o.visible = false })
    return object
  }, [url, inPlace, scene, animated])
  const scaleNodes = useMemo(
    () => [...scaled].map((n) => object.getObjectByName(n)).filter((n): n is THREE.Object3D => !!n),
    [object, scaled],
  )

  useFrame(() => {
    // A clip hides a part by scaling it to zero, which still costs a draw call.
    for (const node of scaleNodes) node.visible = node.scale.x > 0.001

    const next = getState?.() ?? 'Waiting'
    if (next === current.current) return
    const action = actions[next]
    if (!action) return
    const prev = current.current ? actions[current.current] : null
    action.reset()
    action.time = phase * action.getClip().duration
    if (prev) {
      action.fadeIn(FADE_S).play()
      prev.fadeOut(FADE_S)
    } else {
      action.play()
    }
    current.current = next
  })

  return (
    <group scale={MODEL_SCALE}>
      <group ref={rootRef}>
        <primitive object={object} />
      </group>
    </group>
  )
}

Object.values(STATION_MODELS).forEach((url) => useGLTF.preload(url))
