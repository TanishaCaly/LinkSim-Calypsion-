import * as THREE from 'three'

export type RendererKind = 'webgl' | 'webgpu'

export const webgpuSupported = typeof navigator !== 'undefined' && 'gpu' in navigator

// WebGPU is used automatically when the browser has it, and WebGL otherwise (or
// if WebGPU fails to start). It is switched off for now: it is not faster yet
// and lacks the job-marker glow. Turn it on once the GPU-side markers land.
// In dev, localStorage 'linksim.3d.renderer' = 'webgl' | 'webgpu' forces either
// one, for comparing them.
const AUTO_WEBGPU = false

export function preferredRenderer(): RendererKind {
  let forced: string | null = null
  if (import.meta.env.DEV) {
    try { forced = localStorage.getItem('linksim.3d.renderer') } catch { /* private window */ }
  }
  if (forced === 'webgl') return 'webgl'
  if (forced === 'webgpu') return webgpuSupported ? 'webgpu' : 'webgl'
  return AUTO_WEBGPU && webgpuSupported ? 'webgpu' : 'webgl'
}

// True for either WebGPU renderer, so parts that WebGPU can't draw can step aside.
export const isWebGPU = (gl: unknown) => (gl as { isWebGPURenderer?: boolean }).isWebGPURenderer === true

// Loaded on demand, so the WebGPU build is only downloaded when it is used. If
// it can't get a GPU device, the canvas falls back to a plain WebGL renderer.
export async function createWebGPURenderer(props: { canvas: HTMLCanvasElement | OffscreenCanvas }) {
  try {
    const { WebGPURenderer } = await import('three/webgpu')
    const renderer = new WebGPURenderer({ canvas: props.canvas, antialias: true })
    await renderer.init()
    renderer.toneMapping = THREE.CineonToneMapping
    // The canvas wrapper only needs render/setSize/info and friends, which both renderers have.
    return renderer as unknown as THREE.WebGLRenderer
  } catch (err) {
    console.warn('WebGPU unavailable, using WebGL', err)
    const renderer = new THREE.WebGLRenderer({ canvas: props.canvas, antialias: true })
    renderer.toneMapping = THREE.CineonToneMapping
    return renderer
  }
}
