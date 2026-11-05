import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { BakedClips } from './bakedAnimation'
import { bakedMatrix } from './bakedAnimation'

// Cheaper stand-ins for a machine model that is far from the camera: the whole
// model posed once (Waiting, first frame) and merged, then thinned by merging
// vertices that share a cell of a 3D grid, and finally a plain box.

// Every mesh of the model, in the model's space, in its Waiting pose, with its
// colour in a per-vertex attribute, as one non-indexed geometry.
export function posedGeometry(root: THREE.Object3D, baked: BakedClips): THREE.BufferGeometry {
  root.updateMatrixWorld(true)
  const parts: THREE.BufferGeometry[] = []
  const color = new THREE.Color()
  const driverMatrix = new THREE.Matrix4()
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    let driver: THREE.Object3D | null = null
    for (let p: THREE.Object3D | null = mesh; p && p !== root; p = p.parent) {
      if (baked.drivers.has(p.name)) { driver = p; break }
    }
    const geometry = mesh.geometry.clone()
    if (driver) {
      bakedMatrix(baked, driver.name, 1, 0, driverMatrix)
      geometry.applyMatrix4(driverMatrix.multiply(new THREE.Matrix4().copy(driver.matrixWorld).invert().multiply(mesh.matrixWorld)))
    } else {
      geometry.applyMatrix4(mesh.matrixWorld)
    }
    if (!geometry.attributes.color) {
      const base = (mesh.material as THREE.MeshStandardMaterial).color ?? color.set('#cccccc')
      const count = geometry.attributes.position.count
      const colors = new Float32Array(count * 3)
      for (let i = 0; i < count; i++) base.toArray(colors, i * 3)
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    }
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'color') geometry.deleteAttribute(name)
    }
    parts.push(geometry.index ? geometry.toNonIndexed() : geometry)
  })
  return mergeGeometries(parts, false)
}

// Merges vertices that fall in the same cell of a grid, then drops triangles that
// collapsed. The cell size is searched so about `target` triangles remain.
export function clusterGeometry(source: THREE.BufferGeometry, target: number): THREE.BufferGeometry {
  const pos = source.attributes.position
  const nor = source.attributes.normal
  const col = source.attributes.color
  const box = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute)
  const size = box.getSize(new THREE.Vector3())
  const triangles = pos.count / 3
  const key = (i: number, cell: number) => {
    const x = Math.floor((pos.getX(i) - box.min.x) / cell)
    const y = Math.floor((pos.getY(i) - box.min.y) / cell)
    const z = Math.floor((pos.getZ(i) - box.min.z) / cell)
    return x + y * 4096 + z * 16777216
  }
  const survivors = (cell: number) => {
    let n = 0
    for (let t = 0; t < triangles; t++) {
      const a = key(t * 3, cell), b = key(t * 3 + 1, cell), c = key(t * 3 + 2, cell)
      if (a !== b && b !== c && a !== c) n++
    }
    return n
  }
  let lo = size.length() / 400, hi = size.length() / 2
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2
    if (survivors(mid) > target) lo = mid
    else hi = mid
  }
  const cell = hi

  const index = new Map<number, number>()
  const sum: { p: THREE.Vector3; n: THREE.Vector3; c: THREE.Color; w: number }[] = []
  const slot = (i: number) => {
    const k = key(i, cell)
    let s = index.get(k)
    if (s === undefined) {
      s = sum.length
      index.set(k, s)
      sum.push({ p: new THREE.Vector3(), n: new THREE.Vector3(), c: new THREE.Color(0, 0, 0), w: 0 })
    }
    const e = sum[s]
    e.p.x += pos.getX(i); e.p.y += pos.getY(i); e.p.z += pos.getZ(i)
    e.n.x += nor.getX(i); e.n.y += nor.getY(i); e.n.z += nor.getZ(i)
    e.c.r += col.getX(i); e.c.g += col.getY(i); e.c.b += col.getZ(i)
    e.w++
    return s
  }
  const indices: number[] = []
  for (let t = 0; t < triangles; t++) {
    const a = slot(t * 3), b = slot(t * 3 + 1), c = slot(t * 3 + 2)
    if (a !== b && b !== c && a !== c) indices.push(a, b, c)
  }
  const out = new THREE.BufferGeometry()
  const positions = new Float32Array(sum.length * 3)
  const normals = new Float32Array(sum.length * 3)
  const colors = new Float32Array(sum.length * 3)
  sum.forEach((e, i) => {
    e.p.divideScalar(e.w).toArray(positions, i * 3)
    e.n.normalize().toArray(normals, i * 3)
    colors.set([e.c.r / e.w, e.c.g / e.w, e.c.b / e.w], i * 3)
  })
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  out.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  out.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  out.setIndex(indices)
  return out
}

// The colour a viewer sees: each triangle's colour weighted by its area and by how much
// it faces the camera, averaged over four views from above at 35 degrees. A plain average
// counts surfaces nobody sees (undersides, insides) and turns a machine muddy.
export function visibleColor(source: THREE.BufferGeometry): THREE.Color {
  const pos = source.attributes.position
  const col = source.attributes.color
  const elevation = (35 * Math.PI) / 180
  const views = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => new THREE.Vector3(x * Math.cos(elevation), Math.sin(elevation), z * Math.cos(elevation)))
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3()
  let w = 0, r = 0, g = 0, bl = 0
  for (let t = 0; t < pos.count; t += 3) {
    a.fromBufferAttribute(pos, t); b.fromBufferAttribute(pos, t + 1); c.fromBufferAttribute(pos, t + 2)
    n.copy(b.sub(a)).cross(c.sub(a))
    const area = n.length() / 2
    if (area === 0) continue
    n.normalize()
    const facing = views.reduce((sum, v) => sum + Math.max(0, n.dot(v)), 0)
    const weight = area * facing
    r += ((col.getX(t) + col.getX(t + 1) + col.getX(t + 2)) / 3) * weight
    g += ((col.getY(t) + col.getY(t + 1) + col.getY(t + 2)) / 3) * weight
    bl += ((col.getZ(t) + col.getZ(t + 1) + col.getZ(t + 2)) / 3) * weight
    w += weight
  }
  return w > 0 ? new THREE.Color(r / w, g / w, bl / w) : new THREE.Color('#cccccc')
}

// How much of the surface the far box must cover.
const BOX_FRACTION = 0.8

// Where `fraction` of the surface area lies between the two returned values, per axis (the
// tails are trimmed equally), so thin parts that stick out don't stretch the box.
function coreBounds(source: THREE.BufferGeometry, fraction: number): THREE.Box3 {
  const pos = source.attributes.position
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  const cells: { p: THREE.Vector3; w: number }[] = []
  for (let t = 0; t < pos.count; t += 3) {
    a.fromBufferAttribute(pos, t); b.fromBufferAttribute(pos, t + 1); c.fromBufferAttribute(pos, t + 2)
    const w = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).length() / 2
    cells.push({ p: a.clone().add(b).add(c).divideScalar(3), w })
  }
  const total = cells.reduce((sum, e) => sum + e.w, 0)
  const lo = new THREE.Vector3(), hi = new THREE.Vector3()
  for (const axis of ['x', 'y', 'z'] as const) {
    const sorted = [...cells].sort((p, q) => p.p[axis] - q.p[axis])
    let run = 0
    let low = sorted[0].p[axis], high = sorted[sorted.length - 1].p[axis]
    let lowSet = false
    for (const e of sorted) {
      run += e.w
      if (!lowSet && run >= total * (1 - fraction) / 2) { low = e.p[axis]; lowSet = true }
      if (run >= total * (1 - (1 - fraction) / 2)) { high = e.p[axis]; break }
    }
    lo[axis] = low
    hi[axis] = high
  }
  return new THREE.Box3(lo, hi)
}

// A box around the model's core, in the colour a viewer sees. It keeps the full height
// and floor line, so it stands where the model stands.
export function boxGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const full = new THREE.Box3().setFromBufferAttribute(source.attributes.position as THREE.BufferAttribute)
  const core = coreBounds(source, BOX_FRACTION)
  const box = new THREE.Box3(
    new THREE.Vector3(core.min.x, full.min.y, core.min.z),
    new THREE.Vector3(core.max.x, Math.min(full.max.y, core.max.y), core.max.z),
  )
  const size = box.getSize(new THREE.Vector3())
  const centre = box.getCenter(new THREE.Vector3())
  const geometry = new THREE.BoxGeometry(size.x, size.y, size.z).translate(centre.x, centre.y, centre.z)
  const mean = visibleColor(source)
  const colors = new Float32Array(geometry.attributes.position.count * 3)
  for (let i = 0; i < geometry.attributes.position.count; i++) mean.toArray(colors, i * 3)
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geometry.deleteAttribute('uv')
  return geometry
}
