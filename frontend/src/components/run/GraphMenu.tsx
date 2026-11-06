import { AreaChart, BarChart3, GanttChart, Gauge, Grid3x3, Layers, LayoutGrid, LineChart, PieChart, ChartNoAxesColumn } from 'lucide-react'
import { cn } from '@/lib/utils'

// The Analysis page's left menu: pick what the page shows. "Dashboard" is the full Overview with all
// its sections; every other entry shows that one graph (KPIs and Gantt reuse the page's own views).

export type GraphKey = 'dash' | 'kpis' | 'bar' | 'stacked' | 'line' | 'area' | 'pie' | 'hist' | 'heat' | 'gantt'

export const GRAPHS: { key: GraphKey; label: string; sub: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'dash', label: 'Dashboard', sub: 'Every section on one page', icon: LayoutGrid },
  { key: 'kpis', label: 'KPIs', sub: 'All run measures', icon: Gauge },
  { key: 'bar', label: 'Bar graph', sub: 'Station utilization', icon: BarChart3 },
  { key: 'stacked', label: 'Stacked bar', sub: 'Time by state, per station', icon: Layers },
  { key: 'line', label: 'Line chart', sub: 'Output over time', icon: LineChart },
  { key: 'area', label: 'Area chart', sub: 'Cumulative output', icon: AreaChart },
  { key: 'pie', label: 'Pie chart', sub: 'Time by state, overall', icon: PieChart },
  { key: 'hist', label: 'Histogram', sub: 'Time jobs spent in the line', icon: ChartNoAxesColumn },
  { key: 'heat', label: 'Heatmap', sub: 'Delay by station and shift', icon: Grid3x3 },
  { key: 'gantt', label: 'Gantt', sub: 'Which job ran where, and when', icon: GanttChart },
]

export default function GraphMenu({ value, onChange }: { value: GraphKey; onChange: (k: GraphKey) => void }) {
  return (
    <aside className="no-print w-[248px] shrink-0 overflow-auto border-r border-ls-line2 bg-ls-card px-3.5 py-5">
      <p className="px-2 pb-2.5 text-[10.5px] font-bold uppercase tracking-[0.14em] text-ls-mute">Graphs</p>
      {GRAPHS.map(({ key, label, sub, icon: Icon }) => {
        const on = key === value
        return (
          <button
            key={key}
            onClick={() => onChange(key)}
            className={cn('mb-0.5 flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors', on ? 'bg-ls-accent-soft' : 'hover:bg-ls-soft')}
          >
            <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px]', on ? 'bg-ls-accent' : 'bg-ls-chip')}>
              <Icon className={cn('h-[17px] w-[17px]', on ? 'text-white' : 'text-ls-ink2')} />
            </span>
            <span className="min-w-0">
              <b className="block text-[13.5px] font-semibold text-ls-ink">{label}</b>
              <small className="block truncate text-[11px] font-medium text-ls-mute">{sub}</small>
            </span>
          </button>
        )
      })}
    </aside>
  )
}
