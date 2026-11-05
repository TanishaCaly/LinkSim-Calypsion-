import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Machine3D, Prop3D } from './layout'

// A modern factory hall around the line: a concrete floor with safety and
// walkway markings, perimeter walls that fade out on the side the camera is
// outside of, steel columns, and dock doors by Start and End. Everything is
// static and ignores the pointer, so the only things that move or answer to
// clicks are still the machines, workers and job markers.

export const FACTORY_MARGIN = 10 // from the outermost object to the walls
const WALL_H = 7
const WALL_T = 0.5
const NOOP = () => {}
// Camera pitch (degrees looking down) at which the roof is fully there, and fully gone.
const ROOF_FULL = 18
const ROOF_GONE = 30

export interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number }

interface FactoryShellProps {
  bounds: Bounds
  machines: Machine3D[]
  props: Prop3D[]
  isDark: boolean
}

interface Palette {
  floor: string; ground: string; wallBase: string; wallUpper: string; steel: string
  window: string; door: string; yellow: string; white: string
}
const LIGHT: Palette = {
  floor: '#aab2bf', ground: '#8791a0', wallBase: '#5b6678', wallUpper: '#e4e8ee', steel: '#3f4a5c',
  window: '#a9d6f5', door: '#566073', yellow: '#f2b705', white: '#f3f5f8',
}
const DARK: Palette = {
  floor: '#262d38', ground: '#0e131a', wallBase: '#1c232d', wallUpper: '#3a4554', steel: '#161c25',
  window: '#5f8fbd', door: '#2b3442', yellow: '#c99700', white: '#8c97a8',
}

type Side = 'west' | 'east' | 'north' | 'south'
const SIDES: Side[] = ['west', 'east', 'north', 'south']

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z)
}

// A thin flat quad lying on the floor, coloured per vertex so one mesh carries every marking.
function strip(w: number, d: number, x: number, z: number, color: THREE.Color): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2).translate(x, 0.006, z)
  const n = g.attributes.position.count
  const c = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) color.toArray(c, i * 3)
  g.setAttribute('color', new THREE.BufferAttribute(c, 3))
  return g
}

function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  return list.length ? mergeGeometries(list, false) : null
}

// A box carrying its own colour, so a whole rack bay is one mesh.
function cbox(w: number, h: number, d: number, x: number, y: number, z: number, color: string): THREE.BufferGeometry {
  const g = box(w, h, d, x, y, z)
  const c = new THREE.Color(color)
  const n = g.attributes.position.count
  const a = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) c.toArray(a, i * 3)
  g.setAttribute('color', new THREE.BufferAttribute(a, 3))
  return g
}

// A bar between two points (roof truss members).
function beam(a: THREE.Vector3, b: THREE.Vector3, thick: number): THREE.BufferGeometry {
  const dir = b.clone().sub(a)
  const g = new THREE.BoxGeometry(dir.length(), thick, thick)
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir.normalize()))
  const mid = a.clone().add(b).multiplyScalar(0.5)
  return g.translate(mid.x, mid.y, mid.z)
}

function rng(seed: number) {
  let a = seed
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

// One pallet-rack bay: blue uprights, orange beams, three levels of pallets and cartons.
// Local axes: x along the wall (2.7 wide), z away from it (1.1 deep), y up.
const BAY_W = 2.7
const BAY_D = 1.1
function bayGeometry(): THREE.BufferGeometry {
  const r = rng(7)
  const list: THREE.BufferGeometry[] = []
  for (const x of [-1.29, 1.29]) for (const z of [0.06, BAY_D - 0.06]) list.push(cbox(0.12, 4.2, 0.12, x, 2.1, z, '#2a5db0'))
  for (const y of [0.25, 1.65, 3.05]) {
    for (const z of [0.04, BAY_D - 0.04]) list.push(cbox(BAY_W, 0.14, 0.08, 0, y, z, '#e8821a'))
    for (const x of [-0.65, 0.65]) {
      list.push(cbox(1.15, 0.12, 1.0, x, y + 0.13, BAY_D / 2, '#b88a5a'))
      if (r() < 0.8) {
        const stacks = r() < 0.5 ? 1 : 2
        let top = y + 0.19
        for (let s = 0; s < stacks; s++) {
          const h = 0.45 + r() * 0.4
          list.push(cbox(1.0, h, 0.8, x, top + h / 2, BAY_D / 2, ['#c9a36b', '#b98f55', '#d8b982'][Math.floor(r() * 3)]))
          top += h
        }
      }
    }
  }
  return mergeGeometries(list, false)
}

// Which wall a point is nearest to, and where along it.
function nearestWall(p: [number, number, number], x0: number, x1: number, z0: number, z1: number): { side: Side; along: number } {
  const d: [Side, number][] = [['west', p[0] - x0], ['east', x1 - p[0]], ['north', p[2] - z0], ['south', z1 - p[2]]]
  d.sort((a, b) => a[1] - b[1])
  const side = d[0][0]
  return { side, along: side === 'north' || side === 'south' ? p[0] : p[2] }
}

function floorTexture(color: string, joint: string): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 512
  const g = c.getContext('2d')!
  g.fillStyle = color
  g.fillRect(0, 0, 512, 512)
  // speckle, so a big floor doesn't read as a flat colour
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.05)'
    g.fillRect(Math.random() * 512, Math.random() * 512, 2, 2)
  }
  // expansion joints: a slab is 6 x 6 units, four slabs to the tile
  g.strokeStyle = joint
  g.lineWidth = 2
  for (const p of [1, 256]) {
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 512); g.stroke()
    g.beginPath(); g.moveTo(0, p); g.lineTo(512, p); g.stroke()
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

function textPlane(text: string, color: string): THREE.Mesh {
  const c = document.createElement('canvas')
  c.width = 512; c.height = 128
  const g = c.getContext('2d')!
  g.fillStyle = color
  g.font = '700 84px "IBM Plex Sans", system-ui, sans-serif'
  g.textAlign = 'center'; g.textBaseline = 'middle'
  g.fillText(text, 256, 68)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(8, 2).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false }),
  )
  m.raycast = NOOP
  return m
}

interface WallParts { base: THREE.BufferGeometry[]; upper: THREE.BufferGeometry[]; window: THREE.BufferGeometry[]; steel: THREE.BufferGeometry[]; door: THREE.BufferGeometry[]; hazard: THREE.BufferGeometry[] }

export default function FactoryShell({ bounds, machines, props, isDark }: FactoryShellProps) {
  const pal = isDark ? DARK : LIGHT
  const x0 = bounds.minX - FACTORY_MARGIN, x1 = bounds.maxX + FACTORY_MARGIN
  const z0 = bounds.minZ - FACTORY_MARGIN, z1 = bounds.maxZ + FACTORY_MARGIN
  const W = x1 - x0, D = z1 - z0
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2

  const floorTex = useMemo(() => {
    const t = floorTexture(pal.floor, isDark ? 'rgba(0,0,0,0.55)' : 'rgba(60,70,85,0.45)')
    t.repeat.set(W / 12, D / 12)
    return t
  }, [pal.floor, isDark, W, D])

  // Stations, rows and where the line enters and leaves the hall.
  const layout = useMemo(() => {
    const stations = new Map<string, { x: number; zc: number; half: number }>()
    for (const m of machines) {
      const s = stations.get(m.baseName)
      const zs = machines.filter((o) => o.baseName === m.baseName).map((o) => o.position[2])
      if (!s) stations.set(m.baseName, { x: m.position[0], zc: (Math.min(...zs) + Math.max(...zs)) / 2, half: (Math.max(...zs) - Math.min(...zs)) / 2 + 1.25 })
    }
    const rows = new Map<number, { zc: number; half: number }>()
    for (const s of stations.values()) {
      const key = Math.round(s.zc * 10)
      const r = rows.get(key)
      if (!r) rows.set(key, { zc: s.zc, half: s.half })
      else r.half = Math.max(r.half, s.half)
    }
    return { stations: [...stations.values()], rows: [...rows.values()].sort((a, b) => a.zc - b.zc) }
  }, [machines])

  const start = props.find((p) => p.id === 'start')?.position
  const end = props.find((p) => p.id === 'end')?.position

  // Floor markings: yellow safety frames round each station, white walkway lines between rows.
  const markings = useMemo(() => {
    const yellow = new THREE.Color(pal.yellow), white = new THREE.Color(pal.white)
    const list: THREE.BufferGeometry[] = []
    const t = 0.14
    for (const s of layout.stations) {
      const hw = 2.3, hd = s.half + 0.4
      list.push(strip(hw * 2 + t, t, s.x, s.zc - hd, yellow), strip(hw * 2 + t, t, s.x, s.zc + hd, yellow))
      list.push(strip(t, hd * 2, s.x - hw, s.zc, yellow), strip(t, hd * 2, s.x + hw, s.zc, yellow))
    }
    for (let i = 0; i + 1 < layout.rows.length; i++) {
      const a = layout.rows[i], b = layout.rows[i + 1]
      const mid = (a.zc + a.half + 2.2 + b.zc - b.half - 4.2) / 2
      for (const dz of [-1, 1]) list.push(strip(x1 - x0 - 3, 0.12, cx, mid + dz, white))
    }
    return merge(list)
  }, [layout, pal.yellow, pal.white, x0, x1, cx])

  // Walls, one group per side so each can fade on its own.
  const walls = useMemo(() => {
    const parts: Record<Side, WallParts> = {
      west: { base: [], upper: [], window: [], steel: [], door: [], hazard: [] },
      east: { base: [], upper: [], window: [], steel: [], door: [], hazard: [] },
      north: { base: [], upper: [], window: [], steel: [], door: [], hazard: [] },
      south: { base: [], upper: [], window: [], steel: [], door: [], hazard: [] },
    }
    // Place a box on a wall: `along` is the position along the wall, `off` how far it
    // sits inside (+) or outside (-) the wall's inner face.
    const put = (side: Side, list: keyof WallParts, len: number, h: number, thick: number, along: number, y: number, off: number) => {
      const alongX = side === 'north' || side === 'south'
      const face = side === 'west' ? x0 : side === 'east' ? x1 : side === 'north' ? z0 : z1
      const inward = side === 'west' || side === 'north' ? 1 : -1
      const pos = face + inward * off
      parts[side][list].push(alongX ? box(len, h, thick, along, y, pos) : box(thick, h, len, pos, y, along))
    }
    for (const side of SIDES) {
      const alongX = side === 'north' || side === 'south'
      const L = alongX ? W : D
      const mid = alongX ? cx : cz
      put(side, 'base', L, 1.2, WALL_T, mid, 0.6, -WALL_T / 2)
      put(side, 'upper', L, WALL_H - 1.2, WALL_T, mid, 1.2 + (WALL_H - 1.2) / 2, -WALL_T / 2)
      put(side, 'window', L - 4, 1.1, 0.12, mid, 4.6, 0.04)
      const n = Math.max(2, Math.round(L / 10))
      for (let i = 0; i <= n; i++) put(side, 'steel', 0.7, WALL_H, 0.7, mid - L / 2 + (L * i) / n, WALL_H / 2, 0.35)
    }
    // Dock doors on whichever wall is nearest to Start and End.
    const door = (p: [number, number, number] | undefined) => {
      if (!p) return
      const { side, along } = nearestWall(p, x0, x1, z0, z1)
      put(side, 'steel', 5.6, 5.4, 0.7, along, 2.7, 0.35) // frame
      put(side, 'door', 4.6, 4.6, 0.2, along, 2.3, 0.62) // roller door
      put(side, 'hazard', 4.6, 0.4, 0.24, along, 0.3, 0.64) // hazard band
    }
    door(start); door(end)
    return SIDES.map((side) => ({
      side,
      base: merge(parts[side].base), upper: merge(parts[side].upper), window: merge(parts[side].window),
      steel: merge(parts[side].steel), door: merge(parts[side].door), hazard: merge(parts[side].hazard),
    }))
  }, [x0, x1, z0, z1, W, D, cx, cz, start, end])

  // One set of materials per wall, so a wall fades without touching the others.
  const wallMats = useMemo(() => walls.map(() => ({
    base: new THREE.MeshStandardMaterial({ color: pal.wallBase, roughness: 0.9 }),
    upper: new THREE.MeshStandardMaterial({ color: pal.wallUpper, roughness: 0.95 }),
    window: new THREE.MeshStandardMaterial({ color: pal.window, emissive: pal.window, emissiveIntensity: isDark ? 0.5 : 0.25, roughness: 0.3 }),
    steel: new THREE.MeshStandardMaterial({ color: pal.steel, roughness: 0.55, metalness: 0.5 }),
    door: new THREE.MeshStandardMaterial({ color: pal.door, roughness: 0.6, metalness: 0.3 }),
    hazard: new THREE.MeshStandardMaterial({ color: pal.yellow, roughness: 0.7 }),
    rack: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.15 }),
  })), [walls, pal, isDark])

  // Pallet racks stand along the walls (one instanced mesh per wall, so they fade with it),
  // leaving a gap at the dock doors. Every bay is the same; a slight tint tells them apart.
  const bay = useMemo(() => bayGeometry(), [])
  const racks = useMemo(() => {
    const doors = [start, end].filter((p): p is [number, number, number] => !!p).map((p) => nearestWall(p, x0, x1, z0, z1))
    const rand = rng(11)
    const up = new THREE.Vector3(0, 1, 0), unit = new THREE.Vector3(1, 1, 1)
    return walls.map((w, i) => {
      const alongX = w.side === 'north' || w.side === 'south'
      const L = alongX ? W : D, mid = alongX ? cx : cz
      const us: number[] = []
      for (let u = mid - L / 2 + 2.4; u <= mid + L / 2 - 2.4; u += BAY_W + 0.15) {
        if (doors.some((d) => d.side === w.side && Math.abs(d.along - u) < 4.4)) continue
        us.push(u)
      }
      const mesh = new THREE.InstancedMesh(bay, wallMats[i].rack, Math.max(1, us.length))
      const q = new THREE.Quaternion().setFromAxisAngle(up, w.side === 'north' ? 0 : w.side === 'south' ? Math.PI : w.side === 'west' ? Math.PI / 2 : -Math.PI / 2)
      const m = new THREE.Matrix4(), p = new THREE.Vector3(), tint = new THREE.Color()
      us.forEach((u, k) => {
        if (w.side === 'north') p.set(u, 0, z0 + 0.9)
        else if (w.side === 'south') p.set(u, 0, z1 - 0.9)
        else if (w.side === 'west') p.set(x0 + 0.9, 0, u)
        else p.set(x1 - 0.9, 0, u)
        mesh.setMatrixAt(k, m.compose(p, q, unit))
        mesh.setColorAt(k, tint.setScalar(0.8 + rand() * 0.2))
      })
      mesh.count = us.length
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.frustumCulled = false
      mesh.raycast = NOOP
      return mesh
    })
  }, [walls, wallMats, bay, x0, x1, z0, z1, W, D, cx, cz, start, end])

  // Open roof: trusses across the short side on the columns, purlins along the long side, and
  // rows of hanging lamps between the trusses. Two merged meshes.
  const roof = useMemo(() => {
    const spanX = W <= D
    const sMin = spanX ? x0 : z0, sMax = spanX ? x1 : z1
    const tMin = spanX ? z0 : x0, tMax = spanX ? z1 : x1
    const at = (s: number, y: number, t: number) => (spanX ? new THREE.Vector3(s, y, t) : new THREE.Vector3(t, y, s))
    const Y0 = WALL_H + 0.1, Y1 = WALL_H + 1.7
    const n = Math.max(2, Math.round((tMax - tMin) / 10))
    const panels = Math.max(4, Math.round((sMax - sMin) / 3))
    const steel: THREE.BufferGeometry[] = [], lamps: THREE.BufferGeometry[] = []
    const ts = Array.from({ length: n + 1 }, (_, i) => tMin + ((tMax - tMin) * i) / n)
    const ss = Array.from({ length: panels + 1 }, (_, i) => sMin + ((sMax - sMin) * i) / panels)
    for (const t of ts) {
      steel.push(beam(at(sMin, Y1, t), at(sMax, Y1, t), 0.2), beam(at(sMin, Y0, t), at(sMax, Y0, t), 0.2))
      ss.forEach((s, i) => {
        steel.push(beam(at(s, Y0, t), at(s, Y1, t), 0.1))
        if (i < panels) steel.push(i % 2 === 0 ? beam(at(s, Y0, t), at(ss[i + 1], Y1, t), 0.1) : beam(at(s, Y1, t), at(ss[i + 1], Y0, t), 0.1))
      })
    }
    for (let j = 1; j <= 5; j++) {
      const s = sMin + ((sMax - sMin) * j) / 6
      steel.push(beam(at(s, Y1 + 0.12, tMin), at(s, Y1 + 0.12, tMax), 0.12))
    }
    for (let k = 0; k < n; k++) {
      const t = (ts[k] + ts[k + 1]) / 2
      for (let j = 0; j < 4; j++) {
        const s = sMin + ((sMax - sMin) * (j + 0.5)) / 4
        const p = at(s, WALL_H - 0.65, t)
        lamps.push(spanX ? box(2.6, 0.08, 0.7, p.x, p.y, p.z) : box(0.7, 0.08, 2.6, p.x, p.y, p.z))
        for (const d of [-0.9, 0.9]) {
          const r = at(s + d, WALL_H - 0.255, t)
          steel.push(box(0.04, 0.71, 0.04, r.x, r.y, r.z))
        }
      }
    }
    return { steel: merge(steel), lamps: merge(lamps) }
  }, [x0, x1, z0, z1, W, D])
  const roofMats = useMemo(() => ({
    steel: new THREE.MeshStandardMaterial({ color: pal.steel, roughness: 0.55, metalness: 0.5 }),
    lamps: new THREE.MeshBasicMaterial({ color: '#fff3cf' }),
  }), [pal])
  const roofSteelRef = useRef<THREE.Mesh>(null)
  const roofLampRef = useRef<THREE.Mesh>(null)
  const roofO = useRef({ steel: 0, lamps: 0 })
  const lookDir = useMemo(() => new THREE.Vector3(), [])

  const wallRefs = useRef<(THREE.Group | null)[]>([])
  const opacity = useRef([1, 1, 1, 1])

  // A wall fades out while the camera is outside it, so the line is never hidden.
  useFrame(({ camera }, delta) => {
    // The roof is there only at a side angle: fully visible while the camera looks across the
    // hall (down less than ROOF_FULL degrees) and gone once it looks down more than ROOF_GONE,
    // so from above it never covers the line. Its lamps follow the same rule.
    camera.getWorldDirection(lookDir)
    const pitch = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(-lookDir.y, -1, 1))) // + = looking down
    const roofTarget = THREE.MathUtils.clamp((ROOF_GONE - pitch) / (ROOF_GONE - ROOF_FULL), 0, 1)
    const k = Math.min(1, delta * 8)
    roofO.current.steel += (roofTarget - roofO.current.steel) * k
    roofO.current.lamps = roofO.current.steel
    for (const [key, mat] of [['steel', roofMats.steel], ['lamps', roofMats.lamps]] as const) {
      const o = roofO.current[key]
      const translucent = o < 0.99
      if (mat.transparent !== translucent) { mat.transparent = translucent; mat.needsUpdate = true }
      mat.opacity = o
    }
    const showRoof = roofO.current.steel > 0.02
    if (roofSteelRef.current) roofSteelRef.current.visible = showRoof
    if (roofLampRef.current) roofLampRef.current.visible = showRoof

    const p = camera.position
    const outside: Record<Side, boolean> = { west: p.x < x0, east: p.x > x1, north: p.z < z0, south: p.z > z1 }
    walls.forEach((w, i) => {
      const target = outside[w.side] ? 0 : 1
      const o = opacity.current[i] + (target - opacity.current[i]) * Math.min(1, delta * 8)
      opacity.current[i] = Math.abs(o - target) < 0.01 ? target : o
      const g = wallRefs.current[i]
      if (g) g.visible = opacity.current[i] > 0.02
      const translucent = opacity.current[i] < 0.99
      for (const m of Object.values(wallMats[i])) {
        if (m.transparent !== translucent) { m.transparent = translucent; m.needsUpdate = true }
        m.opacity = opacity.current[i]
      }
    })
  })

  const receiving = useMemo(() => textPlane('START', pal.white), [pal.white])
  const shipping = useMemo(() => textPlane('END', pal.white), [pal.white])
  useEffect(() => () => {
    floorTex.dispose()
    markings?.dispose()
    walls.forEach((w) => [w.base, w.upper, w.window, w.steel, w.door, w.hazard].forEach((g) => g?.dispose()))
  }, [floorTex, markings, walls])
  useEffect(() => () => { roof.steel?.dispose(); roof.lamps?.dispose() }, [roof])
  useEffect(() => () => { bay.dispose() }, [bay])

  const markingMat = useMemo(() => new THREE.MeshBasicMaterial({ vertexColors: true }), [])

  return (
    <group>
      {/* outside ground, then the hall's concrete slab */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, -0.05, cz]} raycast={NOOP}>
        <planeGeometry args={[W * 5, D * 5]} />
        <meshStandardMaterial color={pal.ground} roughness={1} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, -0.02, cz]} receiveShadow raycast={NOOP}>
        <planeGeometry args={[W, D]} />
        <meshStandardMaterial map={floorTex} roughness={0.85} metalness={0.05} />
      </mesh>
      {markings && <mesh geometry={markings} material={markingMat} raycast={NOOP} />}

      {start && <primitive object={receiving} position={[start[0], 0.012, start[2] + 3.6]} />}
      {end && <primitive object={shipping} position={[end[0], 0.012, end[2] + 3.6]} />}

      {walls.map((w, i) => (
        <group key={w.side} ref={(g) => { wallRefs.current[i] = g }}>
          {w.base && <mesh geometry={w.base} material={wallMats[i].base} raycast={NOOP} />}
          {w.upper && <mesh geometry={w.upper} material={wallMats[i].upper} raycast={NOOP} />}
          {w.window && <mesh geometry={w.window} material={wallMats[i].window} raycast={NOOP} />}
          {w.steel && <mesh geometry={w.steel} material={wallMats[i].steel} raycast={NOOP} />}
          {w.door && <mesh geometry={w.door} material={wallMats[i].door} raycast={NOOP} />}
          {w.hazard && <mesh geometry={w.hazard} material={wallMats[i].hazard} raycast={NOOP} />}
          <primitive object={racks[i]} />
        </group>
      ))}

      {roof.steel && <mesh ref={roofSteelRef} geometry={roof.steel} material={roofMats.steel} raycast={NOOP} />}
      {roof.lamps && <mesh ref={roofLampRef} geometry={roof.lamps} material={roofMats.lamps} raycast={NOOP} />}
    </group>
  )
}
