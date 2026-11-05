/**
 * Infer a station's palette type for color-coding when stationType isn't
 * set — which is EVERY station in a scenario imported from Excel/YAML,
 * since 'Station Type' is a Canvas-only concept never written by the
 * parsers. Falls back to keyword-matching the station's name, the same
 * pattern Canvas uses for isAssembly, extended to Buffer too.
 * Defaults to 'Station' (the common case — a plain
 * processing station) when no special keyword matches, rather than an
 * "unknown" color, since that's what almost every unmatched name actually is.
 */
export function inferStationType(label: string, stationType?: string): string {
  if (stationType) return stationType
  const name = label.toLowerCase()
  if (name.startsWith('assembly')) return 'Assembly'
  if (/dismantle|disassembl/.test(name)) return 'Dismantle'
  if (/queue|buffer/.test(name)) return 'Buffer'
  if (/conveyor|convey/.test(name)) return 'Conveyor'
  if (/\brobot/.test(name)) return 'Robot'
  if (/^source|entry/.test(name)) return 'Source'
  if (/^drain|^exit/.test(name)) return 'Drain'
  return 'Station'
}

// The 3D view's model for each Object Palette type (files in public/models/).
// A type missing here renders as the plain utilization-colored box.
export const STATION_MODELS: Record<string, string> = {
  Source: '/models/Start.glb',
  Drain: '/models/End.glb',
  Station: '/models/Station_4.glb',
  'Parallel Station': '/models/Parallel_Station_1.glb',
  Assembly: '/models/Assembly_1.glb',
  Dismantle: '/models/Dismantle_1.glb',
  Buffer: '/models/Buffer_1.glb',
  Conveyor: '/models/Conveyor_1.glb',
  Robot: '/models/Robot_1.glb',
  Connector: '/models/Connector_1.glb',
  'Movable Part': '/models/Movable_Part_1.glb',
  Workplace: '/models/Workplace_1.glb',
  Worker: '/models/Worker_Human.glb',
  'Worker Controller': '/models/Worker_Controller_1.glb',
}
