import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, Clock, RefreshCw, Settings, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ALL_DAYS, DEFAULT_SIM_TIME, type SimConfigOverride } from '@/api/simulations'

// ─── SimConfig dialog ─────────────────────────────────────────────────────────

const PRESETS = [
  { label: '1 Shift',  sub: '8 hours',   SIM_TIME: 480,    SHIFT_DURATION: 480 },
  { label: '1 Day',    sub: '24 hours',  SIM_TIME: 1440,   SHIFT_DURATION: 480 },
  { label: '1 Week',   sub: '7 days',    SIM_TIME: 10080,  SHIFT_DURATION: 480 },
  { label: '1 Month',  sub: '30 days',   SIM_TIME: 43200,  SHIFT_DURATION: 480 },
  { label: '1 Year',   sub: '365 days',  SIM_TIME: 525600, SHIFT_DURATION: 480 },
]

interface SimConfigDialogProps {
  open: boolean
  value: SimConfigOverride
  onChange: (v: SimConfigOverride) => void
  onClose: () => void
  /** No scenario open yet (a new one): a shift with no saved days/breaks
   * shows every day and no break — what a new scenario is saved with. */
  fresh?: boolean
}

export interface RunProgress { pct: number; msg: string; simTimeNow?: number; simTimeTotal?: number }

// Engine defaults from backend/parsers/yaml_parser.py — used whenever a
// scenario/override hasn't set its own SHIFT_n_START/END. Only covers the
// original fixed 3 — a 4th+ shift always has explicit hours set by whoever
// added it via "+ Add shift" (see addShift below), never a silent default.
const SHIFT_DEFAULTS: Record<number, { start: number; end: number }> = {
  1: { start: 6, end: 14 },
  2: { start: 14, end: 22 },
  3: { start: 22, end: 6 },
}

const CALENDAR_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function fmtHour(h: number): string {
  const hh = Math.floor(h) % 24
  const period = hh < 12 ? 'am' : 'pm'
  const display = hh % 12 === 0 ? 12 : hh % 12
  return `${display}${period}`
}

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => h)

// Python weekday() numbering used by the backend: Monday=0 ... Sunday=6.
// For a saved scenario without WORKING_DAYS_n (older ones; new ones save
// every day, see NEW_SCENARIO_CALENDAR). Matches SimulationUtils.working_days' fallback when a shift has no
// explicit WORKING_DAYS_n set — Shift 1/2 default to Mon-Fri, Shift 3
// defaults to every day, same as the engine's original assumption. Any
// shift beyond the original 3 defaults to Mon-Fri, same as 1/2.
const DEFAULT_WORKING_DAYS: Record<number, number[]> = {
  1: [0, 1, 2, 3, 4],
  2: [0, 1, 2, 3, 4],
  3: [0, 1, 2, 3, 4, 5, 6],
}

interface BreakWindow { start: number; duration: number }

/** One shift's full editable config — an arbitrary-length array of these
 * replaces the old fixed Record<1|2|3, T> shape, so "+ Add shift" is just
 * pushing a new entry rather than a structural change. */
interface ShiftEntry {
  num: number
  name: string
  start: number
  end: number
  workingDays: number[]
  breaks: BreakWindow[]
}

// For a saved scenario without BREAKS_n (older ones; new ones save no
// breaks, see NEW_SCENARIO_CALENDAR). Matches backend/parsers/yaml_parser.py's _SIM_CONFIG_DEFAULTS — one
// default break per shift so a run has a realistic rest/lunch break out of
// the box, even before the user opens this dialog. A 4th+ shift gets no
// default break (empty), consistent with having no default hours either.
const DEFAULT_BREAKS: Record<number, BreakWindow[]> = {
  1: [{ start: 10, duration: 30 }],
  2: [{ start: 18, duration: 30 }],
  3: [{ start: 2, duration: 30 }],
}

/** Build the initial ShiftEntry[] from a SimConfigOverride, covering
 * whichever SHIFT_n_START keys are present (at least 3, or more if the
 * scenario was saved with extra shifts already). */
function shiftEntriesFromConfig(value: SimConfigOverride, fresh = false): ShiftEntry[] {
  let maxNum = 3
  for (let i = 4; value[`SHIFT_${i}_START`] != null; i++) maxNum = i
  return Array.from({ length: maxNum }, (_, i) => {
    const num = i + 1
    return {
      num,
      name: (value[`SHIFT_${num}_NAME`] as string | undefined) ?? '',
      start: (value[`SHIFT_${num}_START`] as number | undefined) ?? SHIFT_DEFAULTS[num]?.start ?? 8,
      end: (value[`SHIFT_${num}_END`] as number | undefined) ?? SHIFT_DEFAULTS[num]?.end ?? 16,
      workingDays: (value[`WORKING_DAYS_${num}`] as number[] | undefined) ?? (fresh ? ALL_DAYS : DEFAULT_WORKING_DAYS[num] ?? [0, 1, 2, 3, 4]),
      breaks: (value[`BREAKS_${num}`] as BreakWindow[] | undefined) ?? (fresh ? [] : DEFAULT_BREAKS[num] ?? []),
    }
  })
}

/** Flatten ShiftEntry[] back into the SHIFT_n_START/WORKING_DAYS_n/BREAKS_n/
 * SHIFT_n_NAME keys the engine and rest of the app read. */
function shiftEntriesToConfig(shifts: ShiftEntry[]): Partial<SimConfigOverride> {
  const out: Record<string, unknown> = {}
  shifts.forEach(s => {
    out[`SHIFT_${s.num}_START`] = s.start
    out[`SHIFT_${s.num}_END`] = s.end
    out[`WORKING_DAYS_${s.num}`] = s.workingDays
    out[`BREAKS_${s.num}`] = s.breaks
    out[`SHIFT_${s.num}_NAME`] = s.name
  })
  return out
}

/**
 * Two shift-hour windows as (start, end) hour-of-day pairs, where end <= start
 * means the shift wraps past midnight (e.g. 22-6). Every window is expressed
 * as its "today" AND "tomorrow" occurrence on a 0-48 timeline — a plain
 * same-day shift (e.g. 2-4) still needs its tomorrow occurrence (26-28) to
 * correctly detect overlap against a wrapping shift that spills into the
 * next calendar day (e.g. 22-6, whose today-occurrence is 22-30). Returns
 * true if the two windows share ANY overlapping time.
 */
function hourWindowsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  const toIntervals = (start: number, end: number): [number, number][] => {
    const todayEnd = end <= start ? end + 24 : end
    return [[start, todayEnd], [start + 24, todayEnd + 24]]
  }
  const as = toIntervals(aStart, aEnd)
  const bs = toIntervals(bStart, bEnd)
  return as.some(([as1, ae1]) => bs.some(([bs1, be1]) => as1 < be1 && bs1 < ae1))
}

/**
 * Warnings for the Shift Calendar — non-blocking (Apply/Save always works
 * regardless; see the "warning only" decision this mirrors from elsewhere in
 * the app, e.g. Source/Drain). Flags five real misconfigurations:
 *
 *   1. Two shifts overlapping in time on a day both are actually active —
 *      e.g. Shift 1 6am-2pm and Shift 4 8am-4pm both running Monday means
 *      the same hours are double-covered, almost certainly not intended.
 *   2. A break scheduled outside its OWN shift's hours — it would never
 *      actually happen, since the engine only checks breaks while that
 *      shift is active.
 *   3. A shift with every day of the week unchecked — it will never run at
 *      all, silently, with nothing else in the UI explaining why.
 *   4. A shift whose start and end hour are identical — ambiguous: could
 *      mean "runs the full 24 hours" but is far more often a forgotten edit
 *      to the end-hour dropdown.
 *   5. A day of the week with zero shifts active across the WHOLE
 *      calendar — flagged only when at least one OTHER day does have
 *      coverage, so an intentionally fully-idle scenario (e.g. a paused
 *      line) doesn't get warned on every single day.
 *
 * Does NOT flag: a day with zero shifts when the whole week has no active
 * shifts anywhere (that's covered by #3 on every shift instead), or a
 * break that's merely long (already caught by #2 once it spills past the
 * shift's own end).
 */
function shiftCalendarWarnings(shifts: ShiftEntry[]): string[] {
  const warnings: string[] = []
  const dayLabel = (d: number) => CALENDAR_DAYS[d] ?? `Day ${d}`
  const shiftLabel = (s: ShiftEntry) => s.name.trim() || `Shift ${s.num}`

  for (let i = 0; i < shifts.length; i++) {
    for (let j = i + 1; j < shifts.length; j++) {
      const a = shifts[i]
      const b = shifts[j]
      if (!hourWindowsOverlap(a.start, a.end, b.start, b.end)) continue
      const sharedDays = a.workingDays.filter((d) => b.workingDays.includes(d))
      if (sharedDays.length === 0) continue
      warnings.push(`${shiftLabel(a)} and ${shiftLabel(b)} overlap on ${sharedDays.map(dayLabel).join(', ')}`)
    }
  }

  for (const s of shifts) {
    for (const bw of s.breaks) {
      const breakEnd = bw.start + bw.duration / 60
      if (!hourWindowsOverlap(s.start, s.end, bw.start, breakEnd)) {
        warnings.push(`${shiftLabel(s)}'s break is outside its own hours — it won't happen`)
      }
    }
  }

  for (const s of shifts) {
    if (s.workingDays.length === 0) {
      warnings.push(`${shiftLabel(s)} has no working days — it will never run`)
    }
  }

  for (const s of shifts) {
    if (s.start === s.end) {
      warnings.push(`${shiftLabel(s)} start and end time are the same`)
    }
  }

  const anyShiftHasAnyDay = shifts.some((s) => s.workingDays.length > 0)
  if (anyShiftHasAnyDay) {
    for (let d = 0; d < 7; d++) {
      const covered = shifts.some((s) => s.workingDays.includes(d))
      if (!covered) warnings.push(`No shift runs on ${dayLabel(d)}`)
    }
  }

  return warnings
}

/**
 * Editable weekly view of however many shifts this scenario uses (3 by
 * default, more via "+ Add shift"). Each shift has its own independent
 * working-days pattern — no shift is special-cased to always run every day.
 * Double-click a cell to toggle that shift on/off for that day. A station's
 * own "Shifts/Day" setting (Canvas Build panel) decides which of these
 * shifts it actually observes — 0/empty ignores this calendar entirely and
 * runs 24/7.
 */
function ShiftCalendar({
  shifts, onChange, onAddShift, onRemoveShift,
}: {
  shifts: ShiftEntry[]
  onChange: (num: number, patch: Partial<ShiftEntry>) => void
  onAddShift: () => void
  onRemoveShift: (num: number) => void
}) {
  const toggleDay = (num: number, dayIdx: number) => {
    const s = shifts.find(sh => sh.num === num)
    if (!s) return
    const days = s.workingDays
    onChange(num, { workingDays: days.includes(dayIdx) ? days.filter(d => d !== dayIdx) : [...days, dayIdx].sort() })
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs font-semibold text-gray-400 uppercase tracking-widest">
          Shift Calendar
        </label>
        <button
          type="button"
          onClick={onAddShift}
          className="text-[11px] font-semibold text-blue-600 hover:text-blue-700"
        >
          + Add shift
        </button>
      </div>
      <div className="border border-gray-200 rounded-xl bg-gray-50 p-3">
        <div className="grid gap-1.5 items-center" style={{ gridTemplateColumns: '64px repeat(7, 1fr)' }}>
          <div />
          {CALENDAR_DAYS.map(d => (
            <div key={d} className="text-[10px] font-bold text-gray-400 text-center uppercase">{d}</div>
          ))}
          {shifts.map(s => (
            <FragmentRow
              key={s.num}
              name={s.name}
              shiftNum={s.num}
              onRename={name => onChange(s.num, { name })}
              color="bg-green-400"
              start={s.start}
              end={s.end}
              days={s.workingDays}
              onToggleDay={dayIdx => toggleDay(s.num, dayIdx)}
            />
          ))}
        </div>

        <div className="mt-3 pt-3 border-t border-gray-200 space-y-2">
          {shifts.map(s => (
            <div key={s.num} className="flex items-center gap-2">
              <span className="text-[11px] text-gray-500 font-medium w-16 shrink-0 truncate">{s.name.trim() || `Shift ${s.num}`}</span>
              <select
                value={s.start}
                onChange={e => onChange(s.num, { start: Number(e.target.value) })}
                className="h-7 text-xs text-gray-800 bg-white border border-gray-200 rounded-md px-1.5"
              >
                {HOUR_OPTIONS.map(h => <option key={h} value={h}>{fmtHour(h)}</option>)}
              </select>
              <span className="text-xs text-gray-400">–</span>
              <select
                value={s.end}
                onChange={e => onChange(s.num, { end: Number(e.target.value) })}
                className="h-7 text-xs text-gray-800 bg-white border border-gray-200 rounded-md px-1.5"
              >
                {HOUR_OPTIONS.map(h => <option key={h} value={h}>{fmtHour(h)}</option>)}
              </select>
              {shifts.length > 1 && (
                <button
                  type="button"
                  onClick={() => onRemoveShift(s.num)}
                  className="text-gray-300 hover:text-red-500 transition-colors ml-auto"
                  aria-label="Remove shift"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="mt-3 pt-3 border-t border-gray-200 space-y-3">
          <p className="text-[11px] text-gray-500 font-medium">Breaks (e.g. lunch)</p>
          {shifts.map(s => (
            <div key={s.num} className="space-y-1.5">
              <span className="text-[11px] text-gray-500 font-medium">{s.name.trim() || `Shift ${s.num}`}</span>
              {s.breaks.map((bw, bi) => (
                <div key={bi} className="flex items-center gap-2 pl-2">
                  <select
                    value={bw.start}
                    onChange={e => {
                      const next = s.breaks.map((w, i) => i === bi ? { ...w, start: Number(e.target.value) } : w)
                      onChange(s.num, { breaks: next })
                    }}
                    className="h-7 text-xs text-gray-800 bg-white border border-gray-200 rounded-md px-1.5"
                  >
                    {HOUR_OPTIONS.map(h => <option key={h} value={h}>{fmtHour(h)}</option>)}
                  </select>
                  <span className="text-xs text-gray-400">for</span>
                  <BreakDurationInput
                    value={bw.duration}
                    onCommit={parsed => {
                      const next = s.breaks.map((w, i) => i === bi ? { ...w, duration: parsed } : w)
                      onChange(s.num, { breaks: next })
                    }}
                  />
                  <span className="text-xs text-gray-400">min</span>
                  <button
                    type="button"
                    onClick={() => onChange(s.num, { breaks: s.breaks.filter((_, i) => i !== bi) })}
                    className="text-gray-300 hover:text-red-500 transition-colors ml-1"
                    aria-label="Remove break"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => onChange(s.num, { breaks: [...s.breaks, { start: 12, duration: 30 }] })}
                className="pl-2 text-[11px] font-medium text-blue-600 hover:text-blue-700"
              >
                + Add break
              </button>
            </div>
          ))}
        </div>

        <p className="text-[11px] text-gray-400 mt-2.5 leading-relaxed">
          Double-click a day in the calendar to turn that shift on/off for that day — each shift keeps its own
          schedule. A station's own "Shift Available" setting decides which of these it uses.
        </p>
      </div>
    </div>
  )
}

/**
 * Break duration input as an uncontrolled-feeling text field: keeps its own
 * draft string while typing (so backspacing to empty actually works instead
 * of a controlled numeric value snapping back every keystroke), and only
 * commits a real number — clamped to >= 1 — on blur.
 */
function BreakDurationInput({ value, onCommit }: { value: number; onCommit: (parsed: number) => void }) {
  const [draft, setDraft] = useState(String(value))

  useEffect(() => { setDraft(String(value)) }, [value])

  return (
    <input
      type="number"
      min={1}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => {
        const parsed = Math.max(1, Number(draft) || 1)
        setDraft(String(parsed))
        onCommit(parsed)
      }}
      className="h-7 w-16 text-xs text-gray-800 bg-white border border-gray-200 rounded-md px-1.5 [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
    />
  )
}

function FragmentRow({
  name, shiftNum, onRename, color, start, end, days, onToggleDay,
}: {
  name: string
  shiftNum: number
  onRename: (name: string) => void
  color: string
  start: number
  end: number
  days: number[]
  onToggleDay: (dayIdx: number) => void
}) {
  return (
    <>
      <input
        value={name}
        onChange={e => onRename(e.target.value)}
        placeholder={`Shift ${shiftNum}`}
        className="text-[11px] text-gray-700 font-medium h-7 w-full rounded-md border border-transparent hover:border-gray-200 focus:border-blue-300 focus:bg-white bg-transparent px-1.5 transition-colors"
      />
      {CALENDAR_DAYS.map((d, i) => {
        const active = days.includes(i)
        return (
          <div key={d} className="relative group/cell">
            <div
              onDoubleClick={() => onToggleDay(i)}
              className={`h-6 rounded-md cursor-pointer select-none transition-colors ${active ? `${color} hover:brightness-95` : 'bg-gray-100 hover:bg-gray-200'}`}
            />
            <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 whitespace-nowrap rounded-lg bg-white text-gray-700 text-xs font-medium px-3 py-2 shadow-lg border border-gray-100 opacity-0 scale-95 origin-bottom transition-all duration-150 group-hover/cell:opacity-100 group-hover/cell:scale-100 z-30">
              {active ? `${fmtHour(start)}–${fmtHour(end)}` : 'Off'}
            </span>
          </div>
        )
      })}
    </>
  )
}

// ─── Simulation Timer dialog ──────────────────────────────────────────────────
// Separate, dedicated entry point for "when does the simulated clock start,
// and for how long does it run" — distinct from the general Simulation
// Config dialog's shift/breaks/working-days setup. Mirrors the run-timing
// pattern used by tools like Simio/FlexSim (a real start date/time + a run
// length), rather than bundling it into the broader config modal.

/** Format a Date as the value a <input type="datetime-local"> expects (local time, no timezone/seconds). */
function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Custom dropdown calendar + time picker, styled to match the rest of the
 * app instead of relying on the browser's own tiny native calendar-icon
 * popup on <input type="datetime-local">. Value/onChange use the same
 * "YYYY-MM-DDTHH:mm" string shape as toDatetimeLocalValue so it's a drop-in
 * replacement wherever that native input was used.
 */
function DateTimePicker({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const parsed = value ? new Date(value) : new Date()
  const [viewMonth, setViewMonth] = useState(() => new Date(parsed.getFullYear(), parsed.getMonth(), 1))

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const selectDay = (day: number) => {
    const d = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), day, parsed.getHours(), parsed.getMinutes())
    onChange(toDatetimeLocalValue(d))
  }

  const setTime = (hh: number, mm: number) => {
    const d = new Date(parsed)
    d.setHours(hh, mm)
    onChange(toDatetimeLocalValue(d))
  }

  const firstOfMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1)
  const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate()
  // Monday-first grid: JS getDay() is Sunday=0, shift so Monday lands at column 0.
  const leadingBlanks = (firstOfMonth.getDay() + 6) % 7
  const cells: (number | null)[] = [...Array(leadingBlanks).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)]

  const isSelectedDay = (day: number) =>
    parsed.getFullYear() === viewMonth.getFullYear() && parsed.getMonth() === viewMonth.getMonth() && parsed.getDate() === day
  const isToday = (day: number) => {
    const t = new Date()
    return t.getFullYear() === viewMonth.getFullYear() && t.getMonth() === viewMonth.getMonth() && t.getDate() === day
  }

  return (
    <div ref={wrapRef} className={`relative ${className ?? ''}`}>
      <div className="w-full h-10 flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 focus-within:bg-white focus-within:border-blue-400 transition-colors pl-3 pr-1.5">
        <button
          type="button"
          onClick={() => { setViewMonth(new Date(parsed.getFullYear(), parsed.getMonth(), 1)); setOpen(v => !v) }}
          className="flex items-center gap-2 text-sm text-gray-800 hover:text-blue-600 transition-colors"
        >
          <CalendarDays className="h-3.5 w-3.5 text-gray-400 shrink-0" />
          {parsed.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' })}
        </button>
        <span className="text-gray-300">·</span>
        {/* Directly editable — no need to open the calendar dropdown just to
            nudge the time, which is the part users adjust most often. */}
        <input
          type="time"
          value={`${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`}
          onChange={(e) => {
            const [hh, mm] = e.target.value.split(':').map(Number)
            if (Number.isFinite(hh) && Number.isFinite(mm)) setTime(hh, mm)
          }}
          className="flex-1 min-w-0 h-full text-sm text-gray-800 bg-transparent focus:outline-none"
        />
      </div>

      {open && (
        <div className="absolute z-20 mt-1.5 w-72 bg-white rounded-xl border border-gray-200 shadow-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              onClick={() => setViewMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100"
            ><ChevronLeft className="h-4 w-4" /></button>
            <span className="text-sm font-semibold text-gray-800">
              {viewMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
            </span>
            <button
              type="button"
              onClick={() => setViewMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100"
            ><ChevronRight className="h-4 w-4" /></button>
          </div>

          <div className="grid grid-cols-7 gap-0.5 mb-1">
            {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(d => (
              <div key={d} className="text-center text-[10px] font-semibold text-gray-400 py-1">{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((day, i) => (
              <button
                key={i}
                type="button"
                disabled={day === null}
                onClick={() => day && selectDay(day)}
                className={`h-8 rounded-lg text-xs transition-colors ${
                  day === null
                    ? ''
                    : isSelectedDay(day)
                      ? 'bg-blue-600 text-white font-semibold'
                      : isToday(day)
                        ? 'text-blue-600 font-semibold bg-blue-50 hover:bg-blue-100'
                        : 'text-gray-700 hover:bg-gray-100'
                }`}
              >
                {day ?? ''}
              </button>
            ))}
          </div>

          <div className="flex justify-end mt-3 pt-3 border-t border-gray-100">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="h-8 px-3 text-xs font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function SimTimerDialog({
  open, value, onChange, onClose, progress, onRun, isRunning, completionLog, fresh = false,
}: SimConfigDialogProps & { progress?: RunProgress | null; onRun?: (cfg: SimConfigOverride) => void; isRunning?: boolean; completionLog?: Record<string, unknown[]> | null }) {
  // Start/End from the current settings: the saved start (or now) and its
  // run length (8 hours unless set).
  const startFrom = (v: SimConfigOverride) =>
    v.SIMULATION_START_DATE ? String(v.SIMULATION_START_DATE).slice(0, 16) : toDatetimeLocalValue(new Date())
  const endFrom = (v: SimConfigOverride) => {
    const d = v.SIMULATION_START_DATE ? new Date(String(v.SIMULATION_START_DATE)) : new Date()
    d.setMinutes(d.getMinutes() + Number(v.SIM_TIME ?? DEFAULT_SIM_TIME))
    return toDatetimeLocalValue(d)
  }
  const [startDate, setStartDate] = useState(() => startFrom(value))
  const [endDateStr, setEndDateStr] = useState(() => endFrom(value))
  const [warmup, setWarmup] = useState(String(value.WARMUP_TIME ?? 0))
  // The dialog stays mounted: each time it opens, show the current settings
  // (not the ones from when the page loaded).
  useEffect(() => {
    if (!open) return
    setStartDate(startFrom(value))
    setEndDateStr(endFrom(value))
    setWarmup(String(value.WARMUP_TIME ?? 0))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Replay controls for the last completed run's recorded timeline — the
  // backend runs SimPy as a single batch job with no live-pause capability,
  // so Reset/Play/Pause/speed here can only scrub an already-finished run's
  // completion_log, same mechanism as GanttTimeline/the 3D canvas use.
  const [replayPct, setReplayPct] = useState(0)
  const [replayPlaying, setReplayPlaying] = useState(false)
  const [replaySpeed, setReplaySpeed] = useState<1 | 10 | 50>(10)
  const replaySpeedMap = { 1: 1, 10: 10, 50: 50 }

  const replayJobs = useMemo(() => {
    if (!completionLog) return []
    const rows: { start: number; end: number }[] = []
    for (const entries of Object.values(completionLog)) {
      for (const e of entries as Record<string, unknown>[]) {
        const startStr = e['process_start_time_real'] as string
        const endStr = e['process_end_time_real'] as string
        if (!startStr || !endStr) continue
        const start = new Date(startStr.replace(' ', 'T')).getTime()
        const end = new Date(endStr.replace(' ', 'T')).getTime()
        if (Number.isFinite(start) && Number.isFinite(end)) rows.push({ start, end })
      }
    }
    return rows
  }, [completionLog])

  const replayTMin = replayJobs.length > 0 ? Math.min(...replayJobs.map(j => j.start)) : 0
  const replayTMax = replayJobs.length > 0 ? Math.max(...replayJobs.map(j => j.end)) : 1
  const replayTotalMs = Math.max(1, replayTMax - replayTMin)
  const hasReplayData = replayJobs.length > 0

  useEffect(() => {
    // Reset scrub position whenever the underlying run data changes, so
    // reopening the dialog for a different run doesn't start mid-timeline.
    setReplayPct(0)
    setReplayPlaying(false)
  }, [completionLog])

  useEffect(() => {
    if (!replayPlaying) return
    let raf: number
    let last = performance.now()
    const tick = (now: number) => {
      const delta = now - last
      last = now
      const advanceMs = delta * replaySpeedMap[replaySpeed]
      setReplayPct(p => {
        const next = p + (advanceMs / replayTotalMs) * 100
        if (next >= 100) { setReplayPlaying(false); return 100 }
        return next
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [replayPlaying, replaySpeed, replayTotalMs])

  const replayCutoffMs = replayTMin + (replayPct / 100) * replayTotalMs
  const replayElapsedMin = hasReplayData ? Math.round((replayCutoffMs - replayTMin) / 60000) : 0
  const replayTotalMin = hasReplayData ? Math.round(replayTotalMs / 60000) : 0

  useEffect(() => {
    if (!open) return
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [open])

  if (!open) return null

  // Duration (minutes) is derived from the start/end gap — end date is the
  // source of truth here (AnyLogic-style), not a separately-tracked count.
  const durationMins = (() => {
    if (!startDate || !endDateStr) return null
    const mins = (new Date(endDateStr).getTime() - new Date(startDate).getTime()) / 60000
    return Number.isFinite(mins) && mins > 0 ? mins : null
  })()

  const applyPreset = (mins: number) => {
    const d = new Date(startDate)
    d.setMinutes(d.getMinutes() + mins)
    setEndDateStr(toDatetimeLocalValue(d))
  }

  // Moving the start date shifts the end date by the same amount, preserving
  // whatever run length was already set instead of silently changing it.
  const shiftStartTo = (newStart: string) => {
    if (startDate && endDateStr) {
      const deltaMs = new Date(newStart).getTime() - new Date(startDate).getTime()
      if (Number.isFinite(deltaMs)) {
        setEndDateStr(toDatetimeLocalValue(new Date(new Date(endDateStr).getTime() + deltaMs)))
      }
    }
    setStartDate(newStart)
  }

  // Shift-1 window/working-days this override actually uses (falls back to
  // the same engine defaults SimConfigDialog uses), so the weekday check and
  // "snap to shift start" below reflect the real config, not a guess.
  const shift1Start = (value.SHIFT_1_START as number | undefined) ?? SHIFT_DEFAULTS[1].start
  const shift1WorkingDays = (value.WORKING_DAYS_1 as number[] | undefined) ?? (fresh ? ALL_DAYS : DEFAULT_WORKING_DAYS[1])
  const shift1Name = (value.SHIFT_1_NAME as string | undefined)?.trim() || 'Shift 1'

  const startDateObj = startDate ? new Date(startDate) : null
  // JS getDay(): Sunday=0..Saturday=6 -> convert to Python-style Monday=0..Sunday=6
  // used by WORKING_DAYS_n, so this lines up with the engine's own weekday check.
  const startIsWorkingDay = startDateObj
    ? shift1WorkingDays.includes((startDateObj.getDay() + 6) % 7)
    : true

  /** Jump Start Date to the next moment Shift 1 is actually scheduled to run. */
  const snapToNextShiftStart = () => {
    const base = startDateObj ?? new Date()
    const d = new Date(base)
    d.setHours(Math.floor(shift1Start), Math.round((shift1Start % 1) * 60), 0, 0)
    if (d.getTime() <= base.getTime()) d.setDate(d.getDate() + 1)
    for (let i = 0; i < 8; i++) {
      if (shift1WorkingDays.includes((d.getDay() + 6) % 7)) break
      d.setDate(d.getDate() + 1)
    }
    shiftStartTo(toDatetimeLocalValue(d))
  }

  const buildConfig = (): SimConfigOverride => ({
    ...value,
    SIMULATION_START_DATE: startDate ? `${startDate}:00` : undefined,
    SIM_TIME: durationMins ?? Number(value.SIM_TIME ?? DEFAULT_SIM_TIME),
    WARMUP_TIME: Math.max(0, Number(warmup) || 0),
  })

  const apply = () => {
    onChange(buildConfig())
    onClose()
  }

  // Applies the config AND immediately triggers a run with it — passes the
  // freshly-built config directly to onRun rather than relying on onChange's
  // state update having landed yet (see triggerMutation's overrideCfg param).
  const applyAndRun = () => {
    const cfg = buildConfig()
    onChange(cfg)
    onRun?.(cfg)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] z-10 flex flex-col overflow-hidden">

        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
              <Clock className="h-4 w-4 text-blue-600" />
            </div>
            <h2 className="text-base font-semibold text-gray-900">Simulation Timer</h2>
          </div>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4 overflow-y-auto overflow-x-hidden [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-gray-50 [&::-webkit-scrollbar-thumb]:bg-blue-300 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-blue-400">

          {/* Live running-time readout while a run is in progress — mirrors the
              "Time" field Tecnomatix Plant Simulation shows at the top of its
              own event-controller dialog, fed from the same SSE progress state
              the header progress bar uses. */}
          {progress && progress.simTimeNow != null && progress.simTimeTotal != null && (
            <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 flex items-center justify-between">
              <span className="text-xs font-semibold text-blue-400 uppercase tracking-widest">Time</span>
              <span className="text-sm font-bold text-blue-900 tabular-nums">
                {progress.simTimeNow.toFixed(1)} / {progress.simTimeTotal.toFixed(1)} min
                <span className="text-blue-400 font-medium ml-2">({progress.pct.toFixed(0)}%)</span>
              </span>
            </div>
          )}

          {/* Replay controls for the last completed run's recorded timeline.
              The engine is a one-shot SimPy batch job — it can't be paused
              mid-computation — so these buttons scrub playback of a FINISHED
              run's completion_log rather than controlling a live simulation,
              the same model GanttTimeline/the 3D canvas already use. */}
          {!isRunning && hasReplayData && (
            <section className="rounded-xl border border-gray-200 bg-gray-50/60 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-widest">Replay last run</span>
                <span className="text-[10px] text-gray-400 tabular-nums">{replayElapsedMin}m / {replayTotalMin}m</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  title="Reset"
                  onClick={() => { setReplayPct(0); setReplayPlaying(false) }}
                  className="h-8 w-8 flex items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 shrink-0"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title={replayPlaying ? 'Pause' : 'Play'}
                  onClick={() => {
                    if (replayPct >= 100) setReplayPct(0)
                    setReplayPlaying(p => replayPct >= 100 ? true : !p)
                  }}
                  className="h-8 px-3 flex items-center justify-center rounded-lg bg-blue-600 text-white hover:bg-blue-700 text-xs font-semibold shrink-0"
                >
                  {replayPlaying ? '⏸ Pause' : '▶ Start'}
                </button>
                <button
                  type="button"
                  title="Stop"
                  onClick={() => setReplayPlaying(false)}
                  className="h-8 px-3 flex items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 text-xs font-semibold shrink-0"
                >
                  ■ Stop
                </button>
                <div className="flex items-center rounded-lg border border-gray-200 overflow-hidden shrink-0 ml-auto">
                  {([1, 10, 50] as const).map(s => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setReplaySpeed(s)}
                      className={`h-8 px-2.5 text-xs font-semibold transition-colors ${replaySpeed === s ? 'bg-blue-50 text-blue-700' : 'bg-white text-gray-400 hover:bg-gray-50'}`}
                    >
                      {s}×
                    </button>
                  ))}
                </div>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={0.1}
                value={replayPct}
                onChange={(e) => { setReplayPlaying(false); setReplayPct(Number(e.target.value)) }}
                className="w-full accent-blue-600"
              />
            </section>
          )}

          {/* Date range */}
          <section className="rounded-xl border border-gray-200 p-4 space-y-4">
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold text-gray-400 uppercase tracking-widest">Start Date &amp; Time</label>
                {startDateObj && (
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${startIsWorkingDay ? 'text-gray-500 bg-gray-100' : 'text-amber-600 bg-amber-50'}`}>
                    {startDateObj.toLocaleDateString(undefined, { weekday: 'long' })}
                    {!startIsWorkingDay && ' — non-working day'}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <DateTimePicker value={startDate} onChange={shiftStartTo} className="flex-1" />
                <button
                  type="button"
                  onClick={() => shiftStartTo(toDatetimeLocalValue(new Date()))}
                  className="h-10 px-3 text-xs font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg border border-blue-100 transition-colors whitespace-nowrap"
                >
                  Now
                </button>
              </div>
              <div className="flex items-center justify-between mt-1.5 gap-2">
                <p className="text-[10px] text-gray-400">
                  Anchors shift working-days (e.g. "Monday") to actual weekdays.
                </p>
                <button
                  type="button"
                  onClick={snapToNextShiftStart}
                  className="text-[10px] font-semibold text-blue-600 hover:text-blue-700 whitespace-nowrap shrink-0"
                >
                  Snap to next {shift1Name} start
                </button>
              </div>
              {!startIsWorkingDay && (
                <p className="text-[10px] text-amber-600 mt-1">
                  {shift1Name} doesn't run on this weekday — the station will sit idle until its next working day.
                </p>
              )}
            </div>

            <div className="border-t border-gray-100 pt-4">
              <label className="text-xs font-semibold text-gray-400 uppercase tracking-widest block mb-2">End Date &amp; Time</label>
              <DateTimePicker
                value={endDateStr}
                onChange={(v) => setEndDateStr(v)}
              />
              <p className="text-[10px] text-gray-400 mt-1.5">
                The real calendar date the simulated clock stops at. Run length is computed from the gap to Start Date.
              </p>
            </div>

            <div className="border-t border-gray-100 pt-4">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Quick Fill</p>
              <div className="grid grid-cols-5 gap-2">
                {PRESETS.map((p) => (
                  <button
                    key={p.label}
                    onClick={() => applyPreset(p.SIM_TIME)}
                    className={`flex flex-col items-center py-3 rounded-xl border text-sm transition-all duration-150 ${
                      // Selected whenever the run length matches it, the default 8 h included.
                      durationMins === p.SIM_TIME
                        ? 'border-blue-500 bg-blue-50 text-blue-700 shadow-sm'
                        : 'border-gray-100 bg-gray-50 hover:border-blue-200 hover:bg-blue-50/50 text-gray-600'
                    }`}
                  >
                    <span className="font-semibold text-sm">{p.label}</span>
                    <span className="text-[10px] text-gray-400 mt-0.5">{p.sub}</span>
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-gray-400 mt-1.5">Sets End Date to Start Date + the chosen length. Edit End Date directly for anything else.</p>
            </div>
          </section>

          {/* Warm-up + summary */}
          <section className="rounded-xl border border-gray-200 p-4 space-y-4">
            <div>
              <label className="text-xs font-semibold text-gray-400 uppercase tracking-widest block mb-2">
                Warm-up Time (minutes)
              </label>
              <div className="flex items-center border border-gray-200 rounded-xl bg-gray-50 focus-within:border-blue-400 focus-within:bg-white transition-colors overflow-hidden">
                <button
                  type="button"
                  onClick={() => setWarmup(v => String(Math.max(0, Number(v) - 60)))}
                  className="px-3 py-2.5 text-blue-500 hover:bg-blue-50 hover:text-blue-700 text-lg font-bold transition-colors select-none"
                >−</button>
                <input
                  type="number"
                  min={0}
                  max={Math.max(0, (durationMins ?? 0) - 60)}
                  value={warmup}
                  onChange={e => setWarmup(e.target.value)}
                  className="flex-1 text-center text-sm text-gray-900 bg-transparent focus:outline-none [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
                />
                <button
                  type="button"
                  onClick={() => setWarmup(v => String(Math.min(Math.max(0, (durationMins ?? 0) - 60), Number(v) + 60)))}
                  className="px-3 py-2.5 text-blue-500 hover:bg-blue-50 hover:text-blue-700 text-lg font-bold transition-colors select-none"
                >+</button>
              </div>
              <p className="text-xs text-gray-400 mt-1.5">
                {Number(warmup) > 0
                  ? `First ${(Number(warmup) / 60).toFixed(1)} hours excluded from utilization/throughput — lets the line fill up before measuring steady-state.`
                  : 'Off by default. Set a value to exclude the initial ramp-up period from KPIs.'}
              </p>
            </div>

            <div className="rounded-xl bg-blue-50 border border-blue-100 px-4 py-3">
              <p className="text-[10px] font-semibold text-blue-400 uppercase tracking-widest mb-1">Simulated Period</p>
              {durationMins ? (
                <>
                  <p className="text-sm text-blue-900 font-medium">
                    {new Date(startDate).toLocaleString()} &rarr; {new Date(endDateStr).toLocaleString()}
                  </p>
                  <p className="text-[11px] text-blue-400 mt-1">
                    = {(durationMins / 60).toFixed(1)} hours · {(durationMins / 1440).toFixed(1)} days
                  </p>
                </>
              ) : (
                <p className="text-sm text-red-500 font-medium">End Date must be after Start Date.</p>
              )}
            </div>

            {/* Informational only — LinkSim's SimPy engine is event-driven and
                always jumps straight between scheduled events, so it already
                behaves as if this were on; there's no tick-based mode to
                disable it for. Shown checked/locked for parity with tools
                like Plant Simulation that expose it as a real toggle. */}
            <label className="flex items-center gap-2 text-xs text-gray-500 cursor-default select-none">
              <input type="checkbox" checked disabled className="h-3.5 w-3.5 rounded border-gray-300 accent-blue-400 opacity-80" />
              Skip long event intervals
              <span className="text-[10px] text-gray-400">(always on — engine is event-driven)</span>
            </label>
          </section>
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={apply} disabled={!durationMins} variant="outline">Save Timer</Button>
          {onRun && (
            <Button
              size="sm"
              onClick={applyAndRun}
              disabled={!durationMins || isRunning}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {isRunning ? 'Running…' : 'Save & Run'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

export function SimConfigDialog({ open, value, onChange, onClose, fresh = false }: SimConfigDialogProps) {
  const [custom, setCustom] = useState(String(value.SIM_TIME ?? DEFAULT_SIM_TIME))
  const [reps, setReps] = useState(String(value.num_replications ?? 1))
  // Arbitrary-length list of shift configs (hours, working days, breaks,
  // display name) — replaces the old fixed 1/2/3 Record shape so "+ Add
  // shift" is just pushing another entry, not a structural change.
  const [shifts, setShifts] = useState<ShiftEntry[]>(() => shiftEntriesFromConfig(value, fresh))

  // SimConfigDialog stays mounted permanently (only `open` toggles
  // visibility, see its render call in RunDashboard), so the useState
  // initializer above only ever runs once for the whole page's lifetime.
  // Without this, reopening the dialog after switching scenarios (or after
  // the scenario's saved shift names load in asynchronously) kept showing
  // whatever `shifts` was first computed from, not the current `value` —
  // which is why saved shift names appeared to "reset" to Shift 1/2/3.
  useEffect(() => {
    if (open) setShifts(shiftEntriesFromConfig(value, fresh))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Non-blocking — Apply always works regardless of these. Just flags
  // overlapping shift hours and breaks scheduled outside their own shift's
  // hours, both real (if easy to make) configuration mistakes.
  const calendarWarnings = useMemo(() => shiftCalendarWarnings(shifts), [shifts])

  const updateShift = (num: number, patch: Partial<ShiftEntry>) => {
    setShifts(prev => prev.map(s => s.num === num ? { ...s, ...patch } : s))
  }
  const addShift = () => {
    setShifts(prev => {
      const num = Math.max(...prev.map(s => s.num)) + 1
      // A newly added shift works every day, with no break.
      return [...prev, { num, name: '', start: 8, end: 16, workingDays: ALL_DAYS, breaks: [] }]
    })
  }
  const removeShift = (num: number) => {
    setShifts(prev => prev.length > 1 ? prev.filter(s => s.num !== num) : prev)
  }

  // Freeze the page behind the dialog — without this, the underlying
  // dashboard's own horizontal/vertical scrollbars stay live and visible
  // (and scrollable) while this modal is open.
  useEffect(() => {
    if (!open) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prevOverflow }
  }, [open])

  if (!open) return null

  const apply = () => {
    onChange({
      ...value,
      SIM_TIME: Number(custom),
      num_replications: Math.max(1, Math.min(30, Number(reps) || 1)),
      // No Random Seed box any more — every run is random ("Auto").
      RANDOM_SEED: undefined,
      ...shiftEntriesToConfig(shifts),
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] z-10 flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
              <Settings className="h-4 w-4 text-blue-600" />
            </div>
            <h2 className="text-base font-semibold text-gray-900">Simulation Config</h2>
          </div>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-5 overflow-y-auto overflow-x-hidden [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-gray-50 [&::-webkit-scrollbar-thumb]:bg-blue-200 [&::-webkit-scrollbar-thumb]:rounded-full">
          {/* Presets */}
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Duration Presets</p>
            <div className="grid grid-cols-5 gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => setCustom(String(p.SIM_TIME))}
                  className={`flex flex-col items-center py-3 rounded-xl border text-sm transition-all duration-150 ${
                    // Selected whenever the time matches it, the default 480 included.
                    Number(custom) === p.SIM_TIME
                      ? 'border-blue-500 bg-blue-50 text-blue-700 shadow-sm'
                      : 'border-gray-100 bg-gray-50 hover:border-blue-200 hover:bg-blue-50/50 text-gray-600'
                  }`}
                >
                  <span className="font-semibold text-sm">{p.label}</span>
                  <span className="text-[10px] text-gray-400 mt-0.5">{p.sub}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Simulation Time */}
          <div>
            <label className="text-xs font-semibold text-gray-400 uppercase tracking-widest block mb-2">
              Simulation Time (minutes)
            </label>
            <div className="flex items-center border border-gray-200 rounded-xl bg-gray-50 focus-within:border-blue-400 focus-within:bg-white transition-colors overflow-hidden">
              <button
                type="button"
                onClick={() => setCustom(v => String(Math.max(60, Number(v) - 60)))}
                className="px-3 py-2.5 text-blue-500 hover:bg-blue-50 hover:text-blue-700 text-lg font-bold transition-colors select-none"
              >−</button>
              <input
                type="number"
                min={60}
                max={525600}
                value={custom}
                onChange={e => setCustom(e.target.value)}
                className="flex-1 text-center text-sm text-gray-900 bg-transparent focus:outline-none [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
              />
              <button
                type="button"
                onClick={() => setCustom(v => String(Math.min(525600, Number(v) + 60)))}
                className="px-3 py-2.5 text-blue-500 hover:bg-blue-50 hover:text-blue-700 text-lg font-bold transition-colors select-none"
              >+</button>
            </div>
            <p className="text-xs text-gray-400 mt-1.5">
              = {(Number(custom) / 60).toFixed(1)} hours · {(Number(custom) / 1440).toFixed(1)} days
            </p>
          </div>

          {/* Shift Calendar — editable view of however many shifts this run
              uses (3 by default, more via "+ Add shift"). Each shift has its
              own independent working-days pattern (double-click a cell to
              toggle), no shift is special-cased to always run every day.
              Each station's own "Shift Available" setting (Canvas Build
              panel) decides which of these shifts actually apply to it.
              Values shown fall back to the engine defaults (6am-2pm /
              2pm-10pm / 10pm-6am, Mon-Fri for Shift 1/2 and every day for
              Shift 3) when not yet configured. */}
          <ShiftCalendar
            shifts={shifts}
            onChange={updateShift}
            onAddShift={addShift}
            onRemoveShift={removeShift}
          />

          {/* Non-blocking — flags overlapping shift hours and breaks
              scheduled outside their own shift's hours. Save/Apply still
              works either way; this is just a heads-up. */}
          {calendarWarnings.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1.5">
              {calendarWarnings.map((w, i) => (
                <p key={i} className="text-xs text-amber-700 flex items-start gap-1.5">
                  <span className="shrink-0">⚠</span>
                  <span>{w}</span>
                </p>
              ))}
            </div>
          )}

          {/* Replications */}
          <div>
            <label className="text-xs font-semibold text-gray-400 uppercase tracking-widest block mb-2">
              Replications (1–30)
            </label>
            <div className="flex items-center border border-gray-200 rounded-xl bg-gray-50 focus-within:border-blue-400 focus-within:bg-white transition-colors overflow-hidden">
              <button
                type="button"
                onClick={() => setReps(v => String(Math.max(1, Number(v) - 1)))}
                className="px-3 py-2.5 text-blue-500 hover:bg-blue-50 hover:text-blue-700 text-lg font-bold transition-colors select-none"
              >−</button>
              <input
                type="number"
                min={1}
                max={30}
                value={reps}
                onChange={e => setReps(e.target.value)}
                className="flex-1 text-center text-sm text-gray-900 bg-transparent focus:outline-none [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
              />
              <button
                type="button"
                onClick={() => setReps(v => String(Math.min(30, Number(v) + 1)))}
                className="px-3 py-2.5 text-blue-500 hover:bg-blue-50 hover:text-blue-700 text-lg font-bold transition-colors select-none"
              >+</button>
            </div>
            <p className="text-xs text-gray-400 mt-1.5">Multiple replications average results for statistical stability.</p>
          </div>

        </div>

        {/* Footer */}
        <div className="flex gap-3 px-6 py-4 border-t border-gray-100 shrink-0">
          <Button variant="outline" className="flex-1 rounded-xl border-gray-200 text-gray-600 hover:border-blue-300 hover:text-blue-600" onClick={onClose}>Cancel</Button>
          <Button className="flex-1 rounded-xl bg-blue-600 hover:bg-blue-700 shadow-sm" onClick={apply}>Apply</Button>
        </div>
      </div>
    </div>
  )
}
