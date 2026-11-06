import { useMemo } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartKey } from './ChartKit'
import { useAppStore } from '@/store/useAppStore'
import type { SimConfig } from '@/types'

// Where jobs lose time, by station and by shift: the average of queue wait + breakdown +
// waiting for an operator or material, over the visits that started in that shift. Read from
// the run's job log and the scenario's shift hours.

interface Shift { name: string; start: number; end: number }

const parseHours = (s: unknown): number | null => {
  if (typeof s !== 'string') return null
  const d = new Date(s.replace(' ', 'T'))
  return Number.isFinite(d.getTime()) ? d.getHours() + d.getMinutes() / 60 : null
}

const dur = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')} m` : `${m.toFixed(1)} min`)

function shiftsOf(cfg: Partial<SimConfig> | undefined): Shift[] {
  const c = (cfg ?? {}) as Record<string, unknown>
  const out: Shift[] = []
  for (let n = 1; n <= 6; n++) {
    const s = c[`SHIFT_${n}_START`]
    const e = c[`SHIFT_${n}_END`]
    if (typeof s === 'number' && typeof e === 'number') {
      out.push({ name: (c[`SHIFT_${n}_NAME`] as string | undefined)?.trim() || `Shift ${n}`, start: s, end: e })
    }
  }
  return out
}

const inShift = (h: number, s: Shift) => (s.start < s.end ? h >= s.start && h < s.end : h >= s.start || h < s.end)

export default function ShiftHeatmap({ completionLog, onData }: {
  completionLog: Record<string, unknown[]> | undefined
  onData?: (t: { title: string; columns: string[]; rows: string[][] }) => void
}) {
  const cfg = useAppStore((s) => s.activeScenario?.simulation_config)
  const grid = useMemo(() => {
    const shifts = shiftsOf(cfg)
    if (!completionLog || shifts.length === 0) return null
    const rows = Object.entries(completionLog).map(([station, entries]) => {
      const cells = shifts.map((sh) => {
        let sum = 0
        let n = 0
        for (const e of entries as Record<string, unknown>[]) {
          const h = parseHours(e['process_start_time_real'])
          if (h === null || !inShift(h, sh)) continue
          sum += Number(e['Blocked Time'] ?? 0) + Number(e['station_downtime'] ?? 0) + Number(e['operators_downtime'] ?? 0) + Number(e['material_unavailability'] ?? 0)
          n += 1
        }
        return n ? sum / n : null
      })
      return { station, cells }
    })
    const vals = rows.flatMap((r) => r.cells).filter((v): v is number => v !== null)
    if (vals.length === 0) return null
    let best = { station: '', shift: 0, v: -1 }
    rows.forEach((r) => r.cells.forEach((v, i) => { if (v !== null && v > best.v) best = { station: r.station, shift: i, v } }))
    return { shifts, rows, min: Math.min(...vals), max: Math.max(...vals), best }
  }, [completionLog, cfg])
  if (!grid) return null

  return (
    <Card className="mb-5">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-semibold text-ls-ink2">Delay by station and shift</CardTitle>
          {onData && (
            <button
              onClick={() => onData({ title: 'Delay by station and shift', columns: ['Station', ...grid.shifts.map((s) => s.name)], rows: grid.rows.map((r) => [r.station, ...r.cells.map((v) => (v === null ? '—' : dur(v)))]) })}
              className="rounded-lg bg-ls-page px-2.5 py-1 text-[11.5px] font-semibold text-ls-ink2 hover:bg-ls-chip"
            >
              Data
            </button>
          )}
        </div>
        <p className="text-xs text-ls-mute">
          {grid.best.v > 0
            ? `${grid.best.station} in ${grid.shifts[grid.best.shift].name.toLowerCase()} loses the most, ${dur(grid.best.v)} per visit on average.`
            : 'No visit lost time waiting in this run.'}
        </p>
      </CardHeader>
      <CardContent>
        <div className="mb-2 flex items-center gap-2 text-[11.5px] text-ls-ink2">
          <i className="inline-block h-2.5 w-9 rounded-[3px]" style={{ background: 'linear-gradient(90deg, color-mix(in srgb, var(--ls-accent) 8%, var(--ls-card)), color-mix(in srgb, var(--ls-accent) 64%, var(--ls-card)))' }} />
          Average delay per visit <b className="font-mono text-ls-ink">{dur(grid.min)} – {dur(grid.max)}</b>
        </div>
        <div className="grid items-center gap-1" style={{ gridTemplateColumns: `130px repeat(${grid.shifts.length}, minmax(0, 1fr))` }}>
          <span />
          {grid.shifts.map((s) => <span key={s.name} className="text-center text-[11.5px] font-semibold text-ls-mute">{s.name}</span>)}
          {grid.rows.map((r) => (
            <div key={r.station} className="contents">
              <span className="truncate text-xs text-ls-ink2" title={r.station}>{r.station}</span>
              {r.cells.map((v, i) => {
                const q = v === null || grid.max === grid.min ? 0 : (v - grid.min) / (grid.max - grid.min)
                return (
                  <div
                    key={i}
                    data-tip={`${r.station} · ${grid.shifts[i].name}\n${v === null ? 'No visits started in this shift' : `${dur(v)} lost per visit on average`}`}
                    className="grid h-8 place-items-center rounded-md font-mono text-[11px] font-semibold"
                    style={v === null ? { background: 'var(--ls-chip)', color: 'var(--ls-mute)' } : { background: `color-mix(in srgb, var(--ls-accent) ${Math.round(8 + q * 56)}%, var(--ls-card))`, color: q > 0.7 ? '#fff' : 'var(--ls-ink)' }}
                  >
                    {v === null ? '—' : dur(v)}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
        <ChartKey
          x="Shifts, from the shift hours in your scenario"
          y="Stations"
          measure="Delay is queue wait plus breakdown plus waiting for an operator or material, averaged over the visits that started in that shift. A darker cell means more delay; a dash means no visit started in that shift."
        />
      </CardContent>
    </Card>
  )
}
