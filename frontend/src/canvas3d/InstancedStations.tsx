import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import type { AnimState } from './stationActivity'
import { FADE_S, MODEL_SCALE, animatedNodeNames, templateFor, workInPlace } from './StationModel'
import { BAKED_STATES, BAKE_FPS, bakeClips } from './bakedAnimation'
import { boxGeometry, clusterGeometry, posedGeometry } from './lodGeometry'

// Draws every machine of one model as a single instanced batch. The clips are
// baked into a texture (see bakedAnimation.ts); a small vertex-shader patch poses
// each machine from it, using that machine's state and where it is in its loop.
// The patch is for the WebGL renderer.

const SHADER_HEAD = `
attribute vec4 aAnim;
uniform float uTime, uDur, uFps, uFade, uRow;
uniform sampler2D uBake;
vec4 bakeRow(float clip, float r, float f) {
  float f0 = floor(f);
  int y = int(uRow + clip * 3.0 + r);
  return mix(texelFetch(uBake, ivec2(int(f0), y), 0), texelFetch(uBake, ivec2(int(f0) + 1, y), 0), f - f0);
}`

// aAnim = (running clip offset, waiting clip offset, 1 when heading to Running, time of the last switch)
const POSE = `
float aFade = clamp((uTime - aAnim.w) / uFade, 0.0, 1.0);
float aWRun = aAnim.z > 0.5 ? aFade : 1.0 - aFade;
float aFRun = mod(uTime + aAnim.x, uDur) * uFps;
float aFWait = mod(uTime + aAnim.y, uDur) * uFps;
vec4 aR0, aR1, aR2;
if (aWRun > 0.999) {
  aR0 = bakeRow(0.0, 0.0, aFRun); aR1 = bakeRow(0.0, 1.0, aFRun); aR2 = bakeRow(0.0, 2.0, aFRun);
} else if (aWRun < 0.001) {
  aR0 = bakeRow(1.0, 0.0, aFWait); aR1 = bakeRow(1.0, 1.0, aFWait); aR2 = bakeRow(1.0, 2.0, aFWait);
} else {
  aR0 = aWRun * bakeRow(0.0, 0.0, aFRun) + (1.0 - aWRun) * bakeRow(1.0, 0.0, aFWait);
  aR1 = aWRun * bakeRow(0.0, 1.0, aFRun) + (1.0 - aWRun) * bakeRow(1.0, 1.0, aFWait);
  aR2 = aWRun * bakeRow(0.0, 2.0, aFRun) + (1.0 - aWRun) * bakeRow(1.0, 2.0, aFWait);
}`

const MOVE = `
transformed = vec3(dot(aR0, vec4(transformed, 1.0)), dot(aR1, vec4(transformed, 1.0)), dot(aR2, vec4(transformed, 1.0)));`
const TURN = `
objectNormal = normalize(vec3(dot(aR0.xyz, objectNormal), dot(aR1.xyz, objectNormal), dot(aR2.xyz, objectNormal)));`

interface Shared {
  uTime: { value: number }
  uDur: { value: number }
  uFps: { value: number }
  uFade: { value: number }
  uBake: { value: THREE.Texture }
}

function patch(shader: { uniforms: Record<string, THREE.IUniform>; vertexShader: string }, shared: Shared, row: number, lit: boolean) {
  Object.assign(shader.uniforms, shared, { uRow: { value: row } })
  shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${SHADER_HEAD}`)
  shader.vertexShader = lit
    ? shader.vertexShader
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${POSE}${TURN}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>${MOVE}`)
    : shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\n${POSE}${MOVE}`)
}

// Machines whose model reaches into view (a little past it, for shadows) are drawn.
const CULL_RADIUS = 5
// A model is drawn in full while it is at least FULL_PX pixels tall, as a thinned
// copy down to SIMPLE_PX, and as a plain box below that.
const FULL_PX = 60
const SIMPLE_PX = 18
const SIMPLE_TRIANGLES = 1500

// One thing to draw: where its model stands on the floor, and its Running/Waiting
// state, read every frame (none → always Waiting).
export interface BatchItem {
  id: string
  position: [number, number, number]
  getState?: () => AnimState
}

interface InstancedStationsProps {
  url: string
  items: BatchItem[]
  // Work at the spot instead of walking (the Worker model).
  inPlace?: boolean
  // Pixel height at which the full model gives way to the thinned one.
  fullPx?: number
  // Draw thinned copies when far; without this the model simply disappears at fullPx.
  lod?: boolean
  // Scale targets by item id (default 1); the items ease toward them.
  emphasis?: React.MutableRefObject<Map<string, number>>
}

export default function InstancedStations({ url, items, inPlace = false, fullPx = FULL_PX, lod = true, emphasis }: InstancedStationsProps) {
  const { scene, animations } = useGLTF(url)

  const batch = useMemo(() => {
    const clips = inPlace
      ? animations.map((c) => workInPlace(c, scene.getObjectByName('Worker')?.position ?? new THREE.Vector3()))
      : animations
    const template = templateFor(`${url}|${inPlace}`, scene, animatedNodeNames(clips))
    const root = template.object
    root.updateMatrixWorld(true)
    const baked = bakeClips(root, clips)
    const n = items.length

    // One placement per item, shared by every mesh of the batch: where it stands, the
    // model scale, and the model's own centring. The masters hold every item; the
    // attributes the meshes read hold only the visible ones, one set per detail level.
    const placements = new Float32Array(n * 16)
    const centres = new Float32Array(n * 3)
    const matrices = [0, 1, 2].map(() => new THREE.InstancedBufferAttribute(new Float32Array(n * 16), 16).setUsage(THREE.DynamicDrawUsage))
    const place = new THREE.Matrix4()
    const scale = new THREE.Matrix4()
    const centre = new THREE.Matrix4().makeTranslation(template.offset.x, template.offset.y, template.offset.z)
    const placeItem = (i: number, emphasised = 1) => {
      scale.makeScale(MODEL_SCALE * emphasised, MODEL_SCALE * emphasised, MODEL_SCALE * emphasised)
      place.makeTranslation(...items[i].position).multiply(scale).multiply(centre)
      place.toArray(placements, i * 16)
    }
    items.forEach((item, i) => {
      placeItem(i)
      centres.set(item.position, i * 3)
    })
    const index = new Map(items.map((item, i) => [item.id, i]))
    const emphasised = new Map<string, number>()

    const animMaster = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) animMaster[i * 4 + 3] = -1e9
    const anim = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4)
    anim.setUsage(THREE.DynamicDrawUsage)

    const shared: Shared = {
      uTime: { value: 0 },
      uDur: { value: baked.duration },
      uFps: { value: BAKE_FPS },
      uFade: { value: FADE_S },
      uBake: { value: baked.texture },
    }

    const meshes: THREE.InstancedMesh[] = []
    const owned: { dispose: () => void }[] = [baked.texture]
    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      // The moving node this mesh rides on, if any (the mesh itself counts).
      let driver: THREE.Object3D | null = null
      for (let p: THREE.Object3D | null = mesh; p && p !== root; p = p.parent) {
        if (baked.drivers.has(p.name)) { driver = p; break }
      }
      const geometry = mesh.geometry.clone()
      geometry.applyMatrix4(
        driver ? new THREE.Matrix4().copy(driver.matrixWorld).invert().multiply(mesh.matrixWorld) : mesh.matrixWorld,
      )
      geometry.setAttribute('aAnim', anim)

      const material = (mesh.material as THREE.Material).clone()
      const im = new THREE.InstancedMesh(geometry, material, n)
      im.instanceMatrix = matrices[0]
      im.frustumCulled = false
      im.castShadow = true
      im.receiveShadow = true
      owned.push(geometry, material)

      if (driver) {
        const row = baked.drivers.get(driver.name)! * BAKED_STATES.length * 3
        material.onBeforeCompile = (shader) => patch(shader, shared, row, true)
        const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
        depth.onBeforeCompile = (shader) => patch(shader, shared, row, false)
        im.customDepthMaterial = depth
        owned.push(depth)
      }
      meshes.push(im)
    })

    // The thinned copy and the box: still, in the Waiting pose. Only the thinned copy casts a shadow.
    const lodMeshes: THREE.InstancedMesh[] = []
    if (lod) {
      const posed = posedGeometry(root, baked)
      const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.25 })
      owned.push(material, posed)
      for (const [level, geometry] of [[1, clusterGeometry(posed, SIMPLE_TRIANGLES)], [2, boxGeometry(posed)]] as const) {
        const im = new THREE.InstancedMesh(geometry, material, n)
        im.instanceMatrix = matrices[level]
        im.frustumCulled = false
        im.castShadow = level === 1
        im.receiveShadow = true
        owned.push(geometry)
        lodMeshes.push(im)
      }
    }

    return { meshes, lodMeshes, anim, matrices, placements, animMaster, centres, placeItem, index, emphasised, height: template.height * MODEL_SCALE, shared, duration: baked.duration, owned }
  }, [url, scene, animations, items, inPlace, lod])

  useEffect(() => () => { for (const o of batch.owned) o.dispose() }, [batch])

  const getters = useMemo(() => items.map((item) => item.getState), [items])
  const current = useMemo<(AnimState | null)[]>(() => items.map(() => null), [items])
  // Where in its loop each item starts a clip, so identical ones don't move in lockstep.
  const phase = useMemo(() => items.map(() => Math.random()), [items])

  // Which items are in view, and at which detail level, so the batch draws only those.
  const view = useMemo(() => ({
    sig: '',
    inverse: new THREE.Matrix4(),
    projection: new THREE.Matrix4(),
    frustum: new THREE.Frustum(),
    sphere: new THREE.Sphere(new THREE.Vector3(), CULL_RADIUS),
    level: new Int8Array(items.length).fill(2),
  }), [batch, items.length])

  useFrame((state) => {
    const t = state.clock.elapsedTime
    batch.shared.uTime.value = t
    const a = batch.animMaster
    let changed = false
    // Ease hovered or selected items toward their scale (and back to 1 when released).
    const wanted = emphasis?.current
    if ((wanted && wanted.size > 0) || batch.emphasised.size > 0) {
      const ids = new Set([...(wanted?.keys() ?? []), ...batch.emphasised.keys()])
      for (const id of ids) {
        const i = batch.index.get(id)
        if (i === undefined) continue
        const now = batch.emphasised.get(id) ?? 1
        const goal = wanted?.get(id) ?? 1
        const eased = now + (goal - now) * 0.2
        const next = Math.abs(eased - goal) < 0.002 ? goal : eased
        if (next === now) continue
        batch.placeItem(i, next)
        if (next === 1) batch.emphasised.delete(id)
        else batch.emphasised.set(id, next)
        changed = true
      }
    }
    for (let i = 0; i < items.length; i++) {
      const next = getters[i]?.() ?? 'Waiting'
      if (next === current[i]) continue
      const off = phase[i] * batch.duration - t // so (t + off) mod duration = phase * duration + time since the switch
      a[i * 4 + (next === 'Running' ? 0 : 1)] = off
      a[i * 4 + 2] = next === 'Running' ? 1 : 0
      a[i * 4 + 3] = current[i] === null ? -1e9 : t
      current[i] = next
      changed = true
    }
    // Redo the visible set when the camera moved or an item changed state.
    const cam = state.camera as THREE.PerspectiveCamera
    cam.updateMatrixWorld()
    const sig = `${cam.matrixWorld.elements.join()}|${cam.projectionMatrix.elements[0]}|${cam.projectionMatrix.elements[5]}|${state.size.height}`
    if (!changed && sig === view.sig) return
    view.sig = sig
    view.inverse.copy(cam.matrixWorld).invert()
    view.projection.multiplyMatrices(cam.projectionMatrix, view.inverse)
    view.frustum.setFromProjectionMatrix(view.projection)

    // Distances at which the model is fullPx and SIMPLE_PX tall on screen.
    const pixelsPerUnit = state.size.height / (2 * Math.tan((cam.fov * Math.PI) / 360))
    const d0 = (batch.height * pixelsPerUnit) / fullPx
    const d1 = lod ? (batch.height * pixelsPerUnit) / SIMPLE_PX : d0
    const { placements, animMaster, centres, matrices, anim } = batch
    const counts = [0, 0, 0]
    for (let i = 0; i < items.length; i++) {
      const x = centres[i * 3], y = centres[i * 3 + 1] + 1, z = centres[i * 3 + 2]
      view.sphere.center.set(x, y, z)
      if (!view.frustum.intersectsSphere(view.sphere)) continue
      const d = Math.hypot(x - cam.position.x, y - cam.position.y, z - cam.position.z)
      // A 10% margin keeps an item from flickering between levels at the line.
      let level = view.level[i]
      if (level > 1 && d < d1 * 0.9) level = 1
      if (level > 0 && d < d0 * 0.9) level = 0
      if (level === 0 && d > d0 * 1.1) level = 1
      if (level === 1 && d > d1 * 1.1) level = 2
      view.level[i] = level
      if (level > 0 && !lod) continue
      const k = counts[level]++
      ;(matrices[level].array as Float32Array).set(placements.subarray(i * 16, i * 16 + 16), k * 16)
      if (level === 0) (anim.array as Float32Array).set(animMaster.subarray(i * 4, i * 4 + 4), k * 4)
    }
    for (const mesh of batch.meshes) mesh.count = counts[0]
    batch.lodMeshes.forEach((mesh, j) => { mesh.count = counts[j + 1] })
    for (const attribute of matrices) attribute.needsUpdate = true
    anim.needsUpdate = true
  })

  return (
    <group>
      {[...batch.meshes, ...batch.lodMeshes].map((mesh) => <primitive key={mesh.uuid} object={mesh} />)}
    </group>
  )
}
