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
const fmtHours = (min: number) => (min < 120 ? `${Math.round(min)} min` : `${Math.round(min / 60)} h`)
const fmtRunFor = (min: number) => (min >= 1440 ? `${fmtHours(min)} (${+(min / 1440).toFixed(1)} days)` : fmtHours(min))

export default function ReplayBar({ playing, onToggle, onRestart, speedId, onSpeed, pct, onScrub, clock, elapsedMin, startMs, runMin, settings }: {
  playing: boolean
  onToggle: () => void
  onRestart: () => void
  speedId: string
  onSpeed: (id: string) => void
  /** playhead position, 0 to 100 */
  pct: number
  onScrub: (pct: number) => void
  clock: string
  /** simulated minutes since the replay clock's zero */
  elapsedMin: number
  /** the replay clock's zero as a real date, and the run's length in minutes; the figures row shows when both are known */
  startMs?: number
  runMin?: number
  /** e.g. the Sim setting menu, shown at the far right of the top row */
  settings?: ReactNode
}) {
  const showInfo = startMs != null && startMs > 0 && runMin != null && runMin > 0
  return (
    <div className="rounded-xl border border-gray-200 bg-white/95 shadow-lg backdrop-blur-sm">
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <span className="mr-0.5 border-r border-gray-200 pr-3 text-[9.5px] font-bold uppercase tracking-[0.12em] text-gray-400" title="Plays back the finished run; it does not start a new simulation">Replay</span>
        <button onClick={onRestart} className="whitespace-nowrap rounded-lg border border-gray-200 bg-white px-2 py-1 text-[11.5px] font-medium text-gray-600 hover:bg-gray-50">⏮ Restart</button>
        <button onClick={onToggle} className="whitespace-nowrap rounded-lg border border-blue-500 bg-blue-50 px-2.5 py-1 text-[11.5px] font-medium text-blue-700 hover:bg-blue-100">{playing ? '⏸ Pause' : '▶ Replay'}</button>
        {REPLAY_SPEEDS.map((s) => (
          <button
            key={s.id}
            onClick={() => onSpeed(s.id)}
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
          onChange={(e) => onScrub(Number(e.target.value))}
          className="min-w-[60px] flex-1 accent-blue-600"
        />
        <span className="whitespace-nowrap text-[10.5px] font-semibold tabular-nums text-gray-500">{clock}</span>
        {settings && <div className="ml-0.5 border-l border-gray-200 pl-3">{settings}</div>}
      </div>
      {showInfo && (
        <div className="flex flex-wrap items-center gap-x-[18px] gap-y-0.5 border-t border-gray-100 px-3.5 py-1 text-[11px] tabular-nums text-gray-500">
          <span><em className="mr-1.5 text-[9.5px] font-semibold uppercase not-italic tracking-wide text-gray-400">Start</em><b className="font-semibold text-gray-700">{fmtDateTime(startMs!)}</b></span>
          <span><em className="mr-1.5 text-[9.5px] font-semibold uppercase not-italic tracking-wide text-gray-400">End</em><b className="font-semibold text-gray-700">{fmtDateTime(startMs! + runMin! * 60000)}</b></span>
          <span><em className="mr-1.5 text-[9.5px] font-semibold uppercase not-italic tracking-wide text-gray-400">Run for</em><b className="font-semibold text-gray-700">{fmtRunFor(runMin!)}</b></span>
          <span><em className="mr-1.5 text-[9.5px] font-semibold uppercase not-italic tracking-wide text-gray-400">Elapsed</em><b className="font-semibold text-gray-700">{fmtHours(elapsedMin)}</b> · {fmtHours(Math.max(0, runMin! - elapsedMin))} left</span>
        </div>
      )}
    </div>
  )
}
