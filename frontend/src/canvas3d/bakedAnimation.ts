import * as THREE from 'three'

// A machine model's clips move a handful of nodes (a lamp, a head, a rod...).
// This samples those clips once, at load, into a float texture: for each moving
// node, clip and frame, the node's full transform in the model's space. A vertex
// shader can then pose any number of machines from that table, so no animation
// mixer has to run per machine.

export const BAKED_STATES = ['Running', 'Waiting'] as const
export const BAKE_FPS = 30

export interface BakedClips {
  texture: THREE.DataTexture
  // Index of each moving node; its rows start at ((index * clips) + clip) * 3.
  drivers: Map<string, number>
  frames: number
  duration: number
  data: Float32Array
}

// `template` is the merged model, at rest. Nodes are found by the names the clips use.
export function bakeClips(template: THREE.Object3D, clips: THREE.AnimationClip[]): BakedClips {
  const wanted = BAKED_STATES.map((s) => clips.find((c) => c.name === s))
  const missing = wanted.findIndex((c) => !c)
  if (missing >= 0) throw new Error(`Model has no ${BAKED_STATES[missing]} clip`)
  const found = wanted as THREE.AnimationClip[]

  const duration = Math.max(...found.map((c) => c.duration))
  const frames = Math.round(duration * BAKE_FPS) + 1

  const names = new Set<string>()
  for (const clip of found) for (const t of clip.tracks) names.add(t.name.split('.')[0])
  const drivers = new Map<string, number>()
  for (const name of names) if (template.getObjectByName(name)) drivers.set(name, drivers.size)

  const rows = drivers.size * found.length * 3
  const data = new Float32Array(frames * rows * 4)

  found.forEach((clip, c) => {
    // A fresh copy per clip, so one clip's last pose never leaks into the next.
    const root = template.clone(true)
    const nodes = [...drivers.keys()].map((name) => root.getObjectByName(name)!)
    const mixer = new THREE.AnimationMixer(root)
    const action = mixer.clipAction(clip)
    action.setLoop(THREE.LoopOnce, 1)
    action.clampWhenFinished = true
    action.play()

    for (let f = 0; f < frames; f++) {
      mixer.setTime(Math.min(f / BAKE_FPS, clip.duration))
      root.updateMatrixWorld(true)
      nodes.forEach((node, d) => {
        const e = node.matrixWorld.elements
        const base = (d * found.length + c) * 3
        const rowsOf = [
          [e[0], e[4], e[8], e[12]],
          [e[1], e[5], e[9], e[13]],
          [e[2], e[6], e[10], e[14]],
        ]
        for (let r = 0; r < 3; r++) data.set(rowsOf[r], ((base + r) * frames + f) * 4)
      })
    }
  })

  const texture = new THREE.DataTexture(data, frames, rows, THREE.RGBAFormat, THREE.FloatType)
  texture.minFilter = texture.magFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return { texture, drivers, frames, duration, data }
}

// A moving node's transform in the model's space at one frame of one clip (0 Running, 1 Waiting).
export function bakedMatrix(baked: BakedClips, driver: string, clip: number, frame: number, out: THREE.Matrix4): THREE.Matrix4 {
  const base = (baked.drivers.get(driver)! * BAKED_STATES.length + clip) * 3
  const row = (r: number) => ((base + r) * baked.frames + frame) * 4
  const d = baked.data
  const a = row(0), b = row(1), c = row(2)
  return out.set(d[a], d[a + 1], d[a + 2], d[a + 3], d[b], d[b + 1], d[b + 2], d[b + 3], d[c], d[c + 1], d[c + 2], d[c + 3], 0, 0, 0, 1)
}
