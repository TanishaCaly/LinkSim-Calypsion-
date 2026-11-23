import type { ReactNode } from 'react'

// The replay controller shared by Build and 3D, so they look and behave the same. It only draws the
// bar; each view keeps its own playback (what moves, and how the clock advances).

// Playback speed is simulated seconds per real second. "Fit" plays the whole run in a minute, which is
// the way to watch a run that spans days or months.
export const REPLAY_SPEEDS = [
  { id: '1x', label: '1×', simSecPerSec: 1 as number | null },
  { id: '50x', label: '50×', simSecPerSec: 50 },
  { id: '100x', label: '100×', simSecPerSec: 100 },
  { id: 'fit', label: 'Fit 1 min', simSecPerSec: null },
]
export const DEFAULT_REPLAY_SPEED = 'fit'

/** "Day 3 · 14:25". The log's wall-clock times are parsed as local time, so the local getters give them back. */
export function fmtReplayClock(zeroMs: number, minutes: number): string {
  const d = new Date(zeroMs + minutes * 60000)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `Day ${Math.floor(minutes / 1440) + 1} · ${hh}:${mm}`
}

const fmtDateTime = (ms: number) => {
  const d = new Date(ms)
  const date = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${date}, ${time}`
}
/** "45 min", "8 h", "7 h 30 min" — exact to the minute. */
const fmtHours = (min: number) => {
  const total = Math.round(min)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}
const fmtRunFor = (min: number) => (min >= 1440 ? `${fmtHours(min)} (${+(min / 1440).toFixed(1)} days)` : fmtHours(min))

export default function ReplayBar({ playing, onToggle, onRestart, speedId, onSpeed, pct, onScrub, clock, elapsedMin, startMs, runMin, settings, disabled }: {
  playing: boolean
  onToggle: () => void
  onRestart: () => void
  speedId: string
  onSpeed: (id: string) => void
  /** playhead position, 0 to 100 */
  pct: number
  onScrub: (pct: number) => void
  clock: string
  /** simulated minutes since the replay clock's zero; null: nothing played yet (shows "—") */
  elapsedMin: number | null
  /** the replay clock's zero as a real date, and the run's length in minutes; the figures row shows when both are known */
  startMs?: number
  runMin?: number
  /** e.g. the Sim setting menu, shown at the far right of the top row */
  settings?: ReactNode
  /** no run to replay yet: the playback controls are greyed out, only `settings` works */
  disabled?: boolean
}) {
  const known = startMs != null && startMs > 0 && runMin != null && runMin > 0
  const showInfo = disabled || known
  // No run yet: no figures, each shows "—".
  const none = <b className="font-semibold text-gray-700">—</b>
  return (
    <div className="rounded-xl border border-gray-200 bg-white/95 shadow-lg backdrop-blur-sm">
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <span className="mr-0.5 border-r border-gray-200 pr-3 text-[9.5px] font-bold uppercase tracking-[0.12em] text-gray-400" title={disabled ? 'Run the scenario to replay it' : 'Plays back the finished run; it does not start a new simulation'}>Replay</span>
        {/* Nothing to replay yet: the controls look as usual (hover too) but a click does nothing. */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5" aria-disabled={disabled} title={disabled ? 'Run the scenario to replay it' : undefined}>
        <button onClick={disabled ? undefined : onRestart} className="whitespace-nowrap rounded-lg border border-gray-200 bg-white px-2 py-1 text-[11.5px] font-medium text-gray-600 hover:bg-gray-50">⏮ Restart</button>
        <button onClick={disabled ? undefined : onToggle} className="whitespace-nowrap rounded-lg border border-blue-500 bg-blue-50 px-2.5 py-1 text-[11.5px] font-medium text-blue-700 hover:bg-blue-100">{playing ? '⏸ Pause' : pct > 0 && pct < 100 ? '▶ Resume' : '▶ Start'}</button>
        {REPLAY_SPEEDS.map((s) => (
          <button
            key={s.id}
            onClick={disabled ? undefined : () => onSpeed(s.id)}
            className={`whitespace-nowrap rounded-lg border px-2 py-1 text-[11.5px] font-medium transition-colors ${speedId === s.id ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-500 hover:border-blue-300'}`}
          >
            {s.label}
          </button>
        ))}
        <input
          type="range"
          min={0}
          max={100}
          step={0.1}
          value={pct}
          onChange={(e) => { if (!disabled) onScrub(Number(e.target.value)) }}
          className="min-w-[60px] flex-1 accent-blue-600"
        />
        <span className="whitespace-nowrap text-[10.5px] font-semibold tabular-nums text-gray-500">{clock}</span>
        </div>
        {settings && <div className="ml-0.5 border-l border-gray-200 pl-3">{settings}</div>}
      </div>
      {showInfo && (
        <div className="flex flex-wrap items-center gap-x-[18px] gap-y-0.5 border-t border-gray-100 px-3.5 py-1 text-[11px] tabular-nums text-gray-500">
          <span><em className="mr-1.5 text-[9.5px] font-semibold uppercase not-italic tracking-wide text-gray-400">Start</em>{!known ? none : <b className="font-semibold text-gray-700">{fmtDateTime(startMs!)}</b>}</span>
          <span><em className="mr-1.5 text-[9.5px] font-semibold uppercase not-italic tracking-wide text-gray-400">End</em>{!known ? none : <b className="font-semibold text-gray-700">{fmtDateTime(startMs! + runMin! * 60000)}</b>}</span>
          <span><em className="mr-1.5 text-[9.5px] font-semibold uppercase not-italic tracking-wide text-gray-400">Run for</em>{!known ? none : <b className="font-semibold text-gray-700">{fmtRunFor(runMin!)}</b>}</span>
          <span><em className="mr-1.5 text-[9.5px] font-semibold uppercase not-italic tracking-wide text-gray-400">Elapsed</em>{disabled || elapsedMin == null
            ? none
            : <><b className="font-semibold text-gray-700">{fmtHours(elapsedMin)}</b> · {fmtHours(Math.max(0, runMin! - elapsedMin))} left</>}</span>
        </div>
      )}
    </div>
  )
}

/** The engine's start when Sim setting has no start date (sim_core.py _simulation_start_date). */
const ENGINE_DEFAULT_START = () => new Date(2025, 0, 1, 6, 0, 0).getTime()

/** The bar when there is nothing to replay: it looks as usual, but only `settings` does anything:
 * - no run yet: Start / End / Run for / Elapsed show "—", the clock where a run would start;
 * - a run in which no job moved (e.g. too short for one to finish): that run's own
 *   `runStartMs` and `runMin`, so it is clear what was run. */
export function IdleReplayBar({ startDate, runStartMs, runMin, settings }: {
  /** Sim setting's SIMULATION_START_DATE, if set */
  startDate?: string
  runStartMs?: number
  runMin?: number
  settings: ReactNode
}) {
  const parsed = startDate ? new Date(startDate).getTime() : NaN
  const startMs = runStartMs && runStartMs > 0 ? runStartMs : Number.isFinite(parsed) ? parsed : ENGINE_DEFAULT_START()
  return (
    <ReplayBar
      disabled
      playing={false}
      onToggle={() => {}}
      onRestart={() => {}}
      speedId={DEFAULT_REPLAY_SPEED}
      onSpeed={() => {}}
      pct={0}
      onScrub={() => {}}
      clock={fmtReplayClock(startMs, 0)}
      elapsedMin={null}
      startMs={runStartMs}
      runMin={runMin}
      settings={settings}
    />
  )
}
