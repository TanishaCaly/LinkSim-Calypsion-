import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// The GLB models are built from dozens of tiny meshes (a machine is ~40, a
// worker 8), each its own draw call. Most never move relative to each other.
// This merges the parts that move together into one mesh per material kind,
// so a machine drops to roughly a third of the draw calls.
//
// `animated` holds the names of the nodes the animation clips move. A mesh
// belongs to the nearest animated ancestor (or the model root), and meshes
// sharing a frame and a material kind are merged in that frame's local space,
// so everything still moves with its clip. Animated meshes themselves are
// left as they are.

interface Entry {
  material: THREE.MeshStandardMaterial
  geometries: THREE.BufferGeometry[]
}

// Materials are plain colours, so the colour moves into a per-vertex
// attribute and meshes that differ only in colour can share one material.
const kindOf = (m: THREE.MeshStandardMaterial) =>
  `${m.roughness}|${m.metalness}|${m.emissive.getHex()}|${m.emissiveIntensity}`

export function mergeStaticParts(source: THREE.Object3D, animated: Set<string>): THREE.Object3D {
  const root = source.clone(true)
  root.updateMatrixWorld(true)

  const meshes: THREE.Mesh[] = []
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh) })

  const frames = new Map<THREE.Object3D, Map<string, Entry>>()
  const color = new THREE.Color()

  for (const mesh of meshes) {
    const mat = mesh.material
    if (animated.has(mesh.name) || Array.isArray(mat) || !(mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) continue
    const std = mat as THREE.MeshStandardMaterial
    if (std.transparent || std.map) continue

    let frame: THREE.Object3D = root
    for (let p = mesh.parent; p && p !== root; p = p.parent) {
      if (animated.has(p.name)) { frame = p; break }
    }

    // Into the frame's local space, with the colour baked in.
    const geometry = mesh.geometry.clone()
    geometry.applyMatrix4(new THREE.Matrix4().copy(frame.matrixWorld).invert().multiply(mesh.matrixWorld))
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name)
    }
    const count = geometry.attributes.position.count
    const colors = new Float32Array(count * 3)
    color.copy(std.color)
    for (let i = 0; i < count; i++) color.toArray(colors, i * 3)
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))

    let kinds = frames.get(frame)
    if (!kinds) frames.set(frame, (kinds = new Map()))
    const key = kindOf(std)
    let entry = kinds.get(key)
    if (!entry) {
      kinds.set(key, (entry = {
        material: new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: std.roughness,
          metalness: std.metalness,
          emissive: std.emissive,
          emissiveIntensity: std.emissiveIntensity,
        }),
        geometries: [],
      }))
    }
    entry.geometries.push(geometry)
    mesh.removeFromParent()
  }

  for (const [frame, kinds] of frames) {
    for (const { material, geometries } of kinds.values()) {
      // Merging needs all-indexed or none, so flatten mixed sets.
      const flat = geometries.every((g) => g.index) || geometries.every((g) => !g.index)
        ? geometries
        : geometries.map((g) => (g.index ? g.toNonIndexed() : g))
      const merged = mergeGeometries(flat, false)
      const mesh = new THREE.Mesh(merged, material)
      mesh.name = 'merged'
      frame.add(mesh)
    }
  }

  // Drop the groups that held only the merged meshes.
  const prune = (node: THREE.Object3D) => {
    for (const child of [...node.children]) prune(child)
    if (node !== root && !node.children.length && !(node as THREE.Mesh).isMesh && !animated.has(node.name)) {
      node.removeFromParent()
    }
  }
  prune(root)

  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      const mesh = o as THREE.Mesh
      mesh.castShadow = true
      mesh.receiveShadow = true
    }
  })
  return root
}
