import { STATION_MODELS } from '@/lib/stationTypes'

// Draw machines of one model as a single instanced batch, animated on the GPU,
// instead of one set of meshes (and one animation mixer) per machine.
// Off until it has been checked; in dev, localStorage 'linksim.3d.instancing' =
// 'on' | 'off' overrides it.
const INSTANCE_MACHINES = false

export function instancingOn(): boolean {
  if (import.meta.env.DEV) {
    try {
      const forced = localStorage.getItem('linksim.3d.instancing')
      if (forced === 'on') return true
      if (forced === 'off') return false
    } catch { /* private window */ }
  }
  return INSTANCE_MACHINES
}

// Every machine model can be batched; the Worker has its own in-place animation.
export const canInstance = (stationType: string) => stationType !== 'Worker' && !!STATION_MODELS[stationType]
