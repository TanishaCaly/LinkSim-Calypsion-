import { statusOf, STATE_COLOR } from '@/lib/status'
import type { StationStat, StationStateStat } from '@/types'

const SEGMENTS = [
  { key: 'working', label: 'Working', color: STATE_COLOR.working },
  { key: 'setup', label: 'Setup', color: STATE_COLOR.setup },
  { key: 'blocked', label: 'Blocked', color: STATE_COLOR.blocked },
  { key: 'failed', label: 'Failed', color: STATE_COLOR.failed },
  { key: 'free', label: 'Free', color: STATE_COLOR.free },
] as const

// One station's numbers from the run: status, where its time went, and the headline figures.
export default function StationDrawer({ stat, states }: {
  stat: StationStat | undefined
  states: StationStateStat | undefined
}) {
  if (!stat) return <p className="text-sm text-ls-mute">No data for this station in the run on screen.</p>
  const st = statusOf(stat.station_utilization)
  const tiles: [string, string][] = [
    ['Jobs completed', String(stat.completed_jobs)],
    ['Throughput', `${stat.throughput.toFixed(2)} /hr`],
    ['Utilization', `${stat.station_utilization.toFixed(1)}%`],
    ['Operator utilization', `${stat.operator_utilization.toFixed(1)}%`],
    ['Buffer blocked', `${stat.buffer_blocked_ratio.toFixed(1)}%`],
    ['Avg block time', `${stat.avg_block_time.toFixed(1)} min`],
    ['Failures', String(stat.failure_breakdowns)],
    ['Rework', `${stat.rework_percentage.toFixed(1)}%`],
  ]
  return (
    <div className="space-y-5">
      <span className="inline-block rounded-full px-2.5 py-1 text-xs font-semibold" style={{ background: st.tint, color: st.ink }}>
        {st.label} · {stat.station_utilization.toFixed(0)}%
      </span>

      {states && (
        <div>
          <p className="mb-2 text-xs font-semibold text-ls-ink2">Where the time went</p>
          <div className="flex h-4 gap-px overflow-hidden rounded-[5px] bg-ls-chip">
            {SEGMENTS.filter((g) => states[g.key] > 0).map((g) => (
              <i key={g.key} data-tip={`${g.label}\n${states[g.key].toFixed(1)}% of operating time`} style={{ width: `${states[g.key]}%`, background: g.color }} />
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {SEGMENTS.map((g) => (
              <span key={g.key} className="inline-flex items-center gap-1.5 text-[11.5px] text-ls-ink2">
                <i className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: g.color }} />
                {g.label} <b className="font-mono text-[11px] text-ls-ink">{states[g.key].toFixed(0)}%</b>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        {tiles.map(([l, v]) => (
          <div key={l} className="rounded-xl bg-ls-soft px-3 py-2.5">
            <span className="block text-[10.5px] font-semibold text-ls-mute">{l}</span>
            <b className="font-display text-base font-bold text-ls-ink">{v}</b>
          </div>
        ))}
      </div>

    </div>
  )
}
