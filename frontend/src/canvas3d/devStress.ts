import type { ProcessStep, StationConfig } from '@/types'

// Dev only: set localStorage 'linksim.3d.stress' to N and reload to repeat the
// line N times in the 3D view, for measuring big scenes. Never active in a
// production build, and it only changes what is drawn, nothing that is saved.
export function stressLine(
  processflow: Record<string, ProcessStep[]>,
  stations: Record<string, StationConfig>,
  variant: string,
): { processflow: Record<string, ProcessStep[]>; stations: Record<string, StationConfig> } {
  let copies = 1
  if (import.meta.env.DEV) {
    try { copies = Number(localStorage.getItem('linksim.3d.stress')) || 1 } catch { /* private window */ }
  }
  const base = processflow[variant]
  if (copies <= 1 || !base) return { processflow, stations }

  const steps: ProcessStep[] = []
  const copied: Record<string, StationConfig> = {}
  for (let k = 0; k < copies; k++) {
    for (const s of base) {
      if (typeof s.resource !== 'string') continue
      const name = `${s.resource}_${k}`
      steps.push({ ...s, resource: name })
      copied[name] = stations[s.resource]
    }
  }
  return { processflow: { ...processflow, [variant]: steps }, stations: copied }
}
