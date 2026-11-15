// Routes for walking Workers: a path around machines and props found on a coarse floor grid
// (A*, then straightened), so a Worker walks round things instead of through them.
export interface Box { x: number; z: number; hw: number; hd: number } // centre and half sizes

export interface Route { pts: [number, number][]; len: number }

const CELL = 0.3
const PAD = 0.35 // a Worker's own radius

export function makeRouter(boxes: Box[]) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
  for (const b of boxes) {
    x0 = Math.min(x0, b.x - b.hw); x1 = Math.max(x1, b.x + b.hw)
    z0 = Math.min(z0, b.z - b.hd); z1 = Math.max(z1, b.z + b.hd)
  }
  x0 -= 8; z0 -= 8; x1 += 8; z1 += 8
  const W = Math.ceil((x1 - x0) / CELL), H = Math.ceil((z1 - z0) / CELL)
  const blocked = new Uint8Array(W * H)
  for (const b of boxes) {
    const i0 = Math.max(0, Math.floor((b.x - b.hw - PAD - x0) / CELL)), i1 = Math.min(W - 1, Math.floor((b.x + b.hw + PAD - x0) / CELL))
    const j0 = Math.max(0, Math.floor((b.z - b.hd - PAD - z0) / CELL)), j1 = Math.min(H - 1, Math.floor((b.z + b.hd + PAD - z0) / CELL))
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) blocked[j * W + i] = 1
  }
  const cellOf = (p: [number, number]): [number, number] => [
    Math.min(W - 1, Math.max(0, Math.floor((p[0] - x0) / CELL))),
    Math.min(H - 1, Math.max(0, Math.floor((p[1] - z0) / CELL))),
  ]
  const centre = (i: number, j: number): [number, number] => [x0 + (i + 0.5) * CELL, z0 + (j + 0.5) * CELL]
  // Nearest free cell to p (a spot may sit inside a padded box).
  const free = (p: [number, number]): [number, number] => {
    const [ci, cj] = cellOf(p)
    for (let r = 0; r < 40; r++)
      for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++)
        if (i >= 0 && j >= 0 && i < W && j < H && Math.max(Math.abs(i - ci), Math.abs(j - cj)) === r && !blocked[j * W + i]) return [i, j]
    return [ci, cj]
  }
  const clear = (a: [number, number], b: [number, number]) => {
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (CELL / 2))
    for (let s = 0; s <= n; s++) {
      const [i, j] = cellOf([a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n])
      if (blocked[j * W + i]) return false
    }
    return true
  }
  const cache = new Map<string, Route>()
  const measure = (pts: [number, number][]): Route => ({ pts, len: pts.slice(1).reduce((s, p, k) => s + Math.hypot(p[0] - pts[k][0], p[1] - pts[k][1]), 0) })

  function route(a: [number, number], b: [number, number]): Route {
    const key = `${a[0].toFixed(2)},${a[1].toFixed(2)}>${b[0].toFixed(2)},${b[1].toFixed(2)}`
    const hit = cache.get(key)
    if (hit) return hit
    let result: Route
    if (clear(a, b)) result = measure([a, b])
    else {
      const [si, sj] = free(a), [gi, gj] = free(b)
      const g = new Float32Array(W * H).fill(Infinity)
      const from = new Int32Array(W * H).fill(-1)
      const open: [number, number][] = [[0, sj * W + si]] // [f, cell]; small grids, a plain sorted array is fine
      g[sj * W + si] = 0
      const h = (i: number, j: number) => Math.hypot(i - gi, j - gj)
      let found = false
      while (open.length) {
        open.sort((p, q) => q[0] - p[0])
        const cur = open.pop()![1]
        const ci = cur % W, cj = (cur / W) | 0
        if (ci === gi && cj === gj) { found = true; break }
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue
          const ni = ci + di, nj = cj + dj
          if (ni < 0 || nj < 0 || ni >= W || nj >= H || blocked[nj * W + ni]) continue
          if (di && dj && (blocked[cj * W + ni] || blocked[nj * W + ci])) continue // no cutting corners
          const ng = g[cur] + Math.hypot(di, dj)
          if (ng < g[nj * W + ni]) { g[nj * W + ni] = ng; from[nj * W + ni] = cur; open.push([ng + h(ni, nj), nj * W + ni]) }
        }
      }
      if (!found) result = measure([a, b])
      else {
        const cells: [number, number][] = []
        for (let c = gj * W + gi; c !== -1; c = from[c]) cells.push(centre(c % W, (c / W) | 0))
        cells.reverse()
        const pts: [number, number][] = [a]
        let anchor = a
        for (let k = 0; k < cells.length; k++) {
          const nextOk = k + 1 < cells.length && clear(anchor, cells[k + 1])
          if (!nextOk && cells[k] !== anchor) { pts.push(cells[k]); anchor = cells[k] }
        }
        pts.push(b)
        result = measure(pts)
      }
    }
    cache.set(key, result)
    return result
  }
  // Whether a spot is clear floor (not inside a padded machine or prop).
  route.open = (x: number, z: number) => { const [i, j] = cellOf([x, z]); return !blocked[j * W + i] }
  return route
}

export function along(r: Route, k: number): { x: number; z: number; dx: number; dz: number } {
  let d = Math.min(1, Math.max(0, k)) * r.len
  for (let i = 1; i < r.pts.length; i++) {
    const [ax, az] = r.pts[i - 1], [bx, bz] = r.pts[i]
    const seg = Math.hypot(bx - ax, bz - az)
    if (d <= seg || i === r.pts.length - 1) {
      const t = seg ? Math.min(1, d / seg) : 1
      return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, dx: bx - ax, dz: bz - az }
    }
    d -= seg
  }
  const [x, z] = r.pts[0]
  return { x, z, dx: 0, dz: 0 }
}

const LOOKAHEAD = 2.6 // start steering round another Worker this far off
const CLEARANCE = 1.2 // keep at least this far from another Worker when passing
const PASSING = 1.2 // keep the sidestep this long after drawing level, so we are past them before easing back

// How far to step sideways (x, z) to leave a gap round any other Worker ahead, standing or walking.
// Heading is (hx, hz). Head-on, each takes its own right, so they pass.
export function steer(
  id: string, x: number, z: number, hx: number, hz: number,
  others: Map<string, [number, number]>, open: (x: number, z: number) => boolean,
): [number, number] {
  const hl = Math.hypot(hx, hz)
  const ux = hx / hl, uz = hz / hl
  const nx = -uz, nz = ux
  let want = 0
  for (const [oid, [ox, oz]] of others) {
    if (oid === id) continue
    const rx = ox - x, rz = oz - z
    const ahead = rx * ux + rz * uz
    const lateral = rx * nx + rz * nz
    if (ahead > LOOKAHEAD || ahead < -PASSING) continue
    // Ease in as we close in and out as we pass, so the sidestep never snaps.
    const ramp = ahead >= 0 ? Math.min(1, (LOOKAHEAD - ahead) / (LOOKAHEAD * 0.6)) : 1 + ahead / PASSING
    const need = Math.max(0, CLEARANCE - Math.abs(lateral)) * ramp
    if (need > Math.abs(want)) want = (lateral > 0.05 ? -1 : 1) * need
  }
  if (!want) return [0, 0]
  // Only to a side with clear floor; if neither is clear, stay on the line.
  if (open(x + nx * want, z + nz * want)) return [nx * want, nz * want]
  if (open(x - nx * want, z - nz * want)) return [-nx * want, -nz * want]
  return [0, 0]
}
