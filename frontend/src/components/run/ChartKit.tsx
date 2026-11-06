import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// Small pieces every Analysis chart shares, so they read as one family:
// a take-away line under the chart, a row of headline numbers, and one tooltip.

/** The one sentence a reader should leave with. */
export function Insight({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 flex items-start gap-2.5 rounded-xl bg-ls-accent-soft px-3 py-2.5 text-[12.5px] leading-relaxed text-ls-ink2">
      <i className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-ls-accent text-[12px] font-bold not-italic text-white">i</i>
      <div>{children}</div>
    </div>
  )
}

/** "How to read this chart": what the colours mean, what the two axes are, and what is being measured. */
export function ChartKey({ colors, x, y, measure }: {
  colors?: { color: string; label: string; note?: string; dashed?: boolean }[]
  x?: string
  y?: string
  measure?: ReactNode
}) {
  return (
    <div className="mt-4 space-y-1.5 border-t border-ls-line pt-3 text-[11.5px] leading-relaxed text-ls-mute">
      {colors && colors.length > 0 && (
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {colors.map((c) => (
            <span key={c.label} className="inline-flex items-center gap-1.5">
              {c.dashed
                ? <i className="inline-block h-0 w-3.5 border-t-2 border-dashed" style={{ borderColor: c.color }} />
                : <i className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: c.color }} />}
              <b className="font-semibold text-ls-ink2">{c.label}</b>
              {c.note && <span>· {c.note}</span>}
            </span>
          ))}
        </div>
      )}
      {(x || y) && (
        <div className="flex flex-wrap gap-x-5 gap-y-0.5">
          {x && <span><b className="font-semibold text-ls-ink2">X axis</b> · {x}</span>}
          {y && <span><b className="font-semibold text-ls-ink2">Y axis</b> · {y}</span>}
        </div>
      )}
      {measure && <div><b className="font-semibold text-ls-ink2">Measure</b> · {measure}</div>}
    </div>
  )
}

/** Headline numbers above a chart. */
export function Stats({ items }: { items: { value: string; label: string; tone?: string }[] }) {
  return (
    <div className="mb-3 flex flex-wrap gap-x-6 gap-y-2">
      {items.map((s) => (
        <div key={s.label}>
          <b className="block text-2xl font-bold leading-none text-ls-ink" style={s.tone ? { color: s.tone } : undefined}>{s.value}</b>
          <span className="mt-1 block text-xs text-ls-mute">{s.label}</span>
        </div>
      ))}
    </div>
  )
}

/** The tooltip card used by every recharts chart. */
export function ChartTip({ active, payload, label, unit, name, labelOf }: { active?: boolean; payload?: { value?: number | string; color?: string }[]; label?: string | number; unit?: string; name?: string; labelOf?: (l: string | number | undefined) => string }) {
  if (!active || !payload?.length) return null
  const p = payload[0]
  return (
    <div className="rounded-xl border border-ls-line2 bg-ls-card px-3.5 py-2.5 text-xs shadow-lg">
      <p className="mb-1 font-semibold text-ls-ink">{labelOf ? labelOf(label) : label}</p>
      <div className="flex items-center gap-2">
        <i className="h-2.5 w-2.5 rounded-[3px]" style={{ background: p.color ?? 'var(--ls-accent)' }} />
        <span className="text-ls-mute">{name ?? 'Value'}</span>
        <b className="ml-1 text-ls-ink">{p.value}{unit ? ` ${unit}` : ''}</b>
      </div>
    </div>
  )
}

/** A raised rounded-square surface, the shared "object" look for chart bars and blocks. */
export const LIFT = '1.5px 2.5px 3px rgba(16,24,40,.16)'

/** An instant tooltip for plain HTML bars and blocks (the native `title` one is slow and unstyled).
 *  `bind(content)` goes on the hovered element; render `node` once anywhere in the component. */
export function useTip() {
  const [t, setT] = useState<{ x: number; y: number; c: ReactNode } | null>(null)
  const bind = (c: ReactNode) => ({
    onMouseMove: (e: MouseEvent) => setT({ x: e.clientX, y: e.clientY, c }),
    onMouseLeave: () => setT(null),
  })
  const show = (e: MouseEvent, c: ReactNode) => setT({ x: e.clientX, y: e.clientY, c })
  const hide = () => setT(null)
  const node = t ? <TipBox x={t.x} y={t.y}>{t.c}</TipBox> : null
  return { bind, node, show, hide }
}

function TipBox({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return createPortal(
    <div
      className="pointer-events-none fixed z-[9999] max-w-[260px] whitespace-pre-line rounded-xl bg-ls-dark px-3 py-2 text-xs font-semibold leading-snug text-ls-page shadow-lg"
      style={{ left: Math.min(x + 14, window.innerWidth - 270), top: y + 16 }}
    >
      {children}
    </div>,
    document.body,
  )
}

/** Mount once on a page: any element with a `data-tip="text"` attribute gets the instant tooltip
 *  (a line break in the text starts a new line). */
export function TipHost() {
  const [t, setT] = useState<{ x: number; y: number; text: string } | null>(null)
  useEffect(() => {
    const move = (e: globalThis.MouseEvent) => {
      const text = (e.target as Element | null)?.closest?.('[data-tip]')?.getAttribute('data-tip')
      setT(text ? { x: e.clientX, y: e.clientY, text } : null)
    }
    const leave = () => setT(null)
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseleave', leave)
    document.addEventListener('mousedown', leave)
    document.addEventListener('scroll', leave, true)
    return () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseleave', leave)
      document.removeEventListener('mousedown', leave)
      document.removeEventListener('scroll', leave, true)
    }
  }, [])
  return t ? <TipBox x={t.x} y={t.y}>{t.text}</TipBox> : null
}
