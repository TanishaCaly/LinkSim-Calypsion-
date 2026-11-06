// One place for "how busy is this station" -> label + colours, so 2D, 3D, Analysis
// and the legend all agree. Colours are the LinkSim v2 status tokens (index.css),
// which follow the light / dark theme.
export type StatusKey = 'bottleneck' | 'high' | 'healthy' | 'idle'

export interface StationStatus {
  key: StatusKey
  label: string
  /** solid colour — dots, bars, outlines */
  color: string
  /** soft background tint — pills */
  tint: string
  /** text colour on the tint */
  ink: string
  /** the utilisation band, for legends */
  range: string
}

const STATUS: Record<StatusKey, StationStatus> = {
  bottleneck: { key: 'bottleneck', label: 'Bottleneck', color: 'var(--ls-bad)', tint: 'var(--ls-bad-t)', ink: 'var(--ls-bad-i)', range: '≥85%' },
  high: { key: 'high', label: 'High load', color: 'var(--ls-warn)', tint: 'var(--ls-warn-t)', ink: 'var(--ls-warn-i)', range: '70–84%' },
  healthy: { key: 'healthy', label: 'Healthy', color: 'var(--ls-ok)', tint: 'var(--ls-ok-t)', ink: 'var(--ls-ok-i)', range: '40–69%' },
  idle: { key: 'idle', label: 'Idle', color: 'var(--ls-idle)', tint: 'var(--ls-idle-t)', ink: 'var(--ls-idle-i)', range: '<40%' },
}

/** The five states a station's time is split into, in softer tones than the status colours. */
const soft = (c: string) => `color-mix(in srgb, ${c} 78%, var(--ls-mute))`
export const STATE_COLOR = {
  working: soft('var(--ls-ok)'),
  setup: soft('var(--ls-purple)'),
  blocked: soft('var(--ls-bad)'),
  failed: soft('var(--ls-bad-i)'),
  free: soft('var(--ls-warn)'),
} as const

/** Same bands the app has always used: >= 85 bottleneck, 70-84 high load, 40-69 healthy, below 40 idle. */
export function statusOf(utilisationPct: number): StationStatus {
  if (utilisationPct >= 85) return STATUS.bottleneck
  if (utilisationPct >= 70) return STATUS.high
  if (utilisationPct >= 40) return STATUS.healthy
  return STATUS.idle
}

export const STATUS_LEGEND: StationStatus[] = [STATUS.healthy, STATUS.high, STATUS.bottleneck, STATUS.idle]
