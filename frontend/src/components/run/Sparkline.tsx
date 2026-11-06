import { useId, useState } from 'react'
import { useTip } from './ChartKit'

// A tiny area for a KPI card: the same measure over the run, fading out below the line, last point marked.
export default function Sparkline({ values, color = 'var(--ls-accent)', height = 40, label = '' }: { values: number[]; color?: string; height?: number; label?: string }) {
  const id = useId()
  const { node, show, hide } = useTip()
  const [hover, setHover] = useState<number | null>(null)
  if (values.length < 2) return null
  const w = 140
  const mx = Math.max(...values)
  const mn = Math.min(...values)
  const span = mx - mn || 1
  const X = (i: number) => 2 + (i * (w - 4)) / (values.length - 1)
  const Y = (v: number) => height - 4 - ((v - mn) / span) * (height - 10)
  const pts = values.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')
  const last = values.length - 1
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const i = Math.max(0, Math.min(last, Math.round(((e.clientX - r.left) / r.width) * last)))
    setHover(i)
    const v = values[i]
    show(e, `${label ? label + '\n' : ''}${Number.isInteger(v) ? v : +v.toFixed(2)}  ·  point ${i + 1} of ${values.length}`)
  }
  return (
    <>
    {node}
    <svg viewBox={`0 0 ${w} ${height}`} className="mt-2 block w-full" style={{ height }} preserveAspectRatio="none" onMouseMove={onMove} onMouseLeave={() => { setHover(null); hide() }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".3" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon fill={`url(#${id})`} points={`${X(0)},${height} ${pts} ${X(last)},${height}`} />
      <polyline fill="none" stroke={color} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" points={pts} />
      <circle cx={X(hover ?? last)} cy={Y(values[hover ?? last])} r="2.8" fill={color} />
    </svg>
    </>
  )
}
