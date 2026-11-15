import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ChevronDown, Clock, Lightbulb, Play } from 'lucide-react'
import { insightsApi } from '@/api/insights'
import { FEATURE, useLicenseFeatures } from '@/hooks/useLicenseFeatures'
import { useAppStore } from '@/store/useAppStore'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { InsightItem } from '@/types'

// Interfaces & AI: what the run's analysis suggests (ranked, expandable). The suggestions
// are the engine's own insights for the run on screen.

const CATEGORIES = [
  { key: 'strategic_recommendations', label: 'Strategic', pill: 'bg-ls-accent-soft text-ls-accent-ink' },
  { key: 'operational_insights', label: 'Operational', pill: 'bg-ls-chip text-ls-ink2' },
  { key: 'predictive_analysis', label: 'Predictive', pill: 'bg-ls-idle-t text-ls-idle-i' },
  { key: 'optimization_opportunities', label: 'Optimisation', pill: 'bg-ls-ok-t text-ls-ok-i' },
  { key: 'risk_assessment', label: 'Risk', pill: 'bg-ls-crim-t text-ls-crim' },
] as const

const PRIORITY_PILL: Record<string, string> = {
  high: 'bg-ls-bad-t text-ls-bad-i',
  medium: 'bg-ls-warn-t text-ls-warn-i',
  low: 'bg-ls-idle-t text-ls-idle-i',
}
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 }

interface Ranked extends InsightItem { cat: (typeof CATEGORIES)[number]; id: string }

function EmptyState({ icon: Icon, title, text, action }: { icon: React.ComponentType<{ className?: string }>; title: string; text: string; action?: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-20 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-ls-accent-soft"><Icon className="h-8 w-8 text-ls-accent" /></div>
        <p className="text-lg font-semibold text-ls-ink">{title}</p>
        <p className="text-sm text-ls-mute">{text}</p>
        {action}
      </CardContent>
    </Card>
  )
}

function InsightRow({ item, rank, reviewed, onReview }: { item: Ranked; rank: number; reviewed: boolean; onReview: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <Card className={cn('mb-2.5 transition-opacity', reviewed && 'opacity-60')}>
      <CardContent className="p-4">
        <button onClick={() => setOpen((o) => !o)} className="flex w-full items-start gap-3 text-left">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ls-chip font-display text-xs font-bold text-ls-ink2">{rank}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <b className="font-display text-sm text-ls-ink">{item.title}</b>
              <span className={cn('rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold', item.cat.pill)}>{item.cat.label}</span>
              <span className={cn('rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold capitalize', PRIORITY_PILL[item.priority] ?? PRIORITY_PILL.low)}>{item.priority}</span>
              {reviewed && <span className="rounded-full bg-ls-chip px-2.5 py-0.5 text-[11.5px] font-semibold text-ls-ink2">Reviewed</span>}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-ls-ink2">{item.insight}</p>
          </div>
          <div className="shrink-0 text-right">
            <p className="max-w-[160px] text-xs font-semibold text-ls-ok-i">{item.impact}</p>
            <p className="text-[11px] text-ls-mute">{Math.round(item.confidence * 100)}% confidence</p>
          </div>
          <ChevronDown className={cn('mt-1 h-4 w-4 shrink-0 text-ls-mute transition-transform', open && 'rotate-180')} />
        </button>

        {open && (
          <div className="mt-3 border-t border-ls-line pt-3">
            <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-ls-mute">Suggested change</p>
            <div className="mb-3 flex items-start gap-2 rounded-xl bg-ls-accent-soft p-3">
              <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-ls-accent" />
              <p className="text-sm font-medium text-ls-accent-ink">{item.recommendation}</p>
            </div>
            <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-ls-mute">
              <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{item.timeframe}</span>
              <span className="flex items-center gap-1"><AlertTriangle className="h-3 w-3" />{item.impact}</span>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={onReview}>{reviewed ? 'Mark unreviewed' : 'Mark reviewed'}</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default function Insights() {
  const navigate = useNavigate()
  const { activeRun, activeScenario } = useAppStore()
  const [filter, setFilter] = useState<string>('all')
  const [reviewed, setReviewed] = useState<Set<string>>(new Set())
  const canInsights = useLicenseFeatures().allows(FEATURE.insightsAi)

  const { data, isLoading, error } = useQuery({
    queryKey: ['insights', activeRun?.id],
    queryFn: () => insightsApi.get(activeRun!.id),
    enabled: canInsights && !!activeRun && activeRun.status === 'completed',
  })

  // Every insight in one list, most important first (priority, then confidence).
  const ranked: Ranked[] = useMemo(() => {
    if (!data) return []
    const all = CATEGORIES.flatMap((cat) =>
      ((data.insights[cat.key] as InsightItem[] | undefined) ?? []).map((it, i) => ({ ...it, cat, id: `${cat.key}-${i}` })),
    )
    return all.sort((a, b) => (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3) || b.confidence - a.confidence)
  }, [data])

  const shown = filter === 'all' ? ranked : ranked.filter((r) => r.cat.key === filter)
  const toggleReviewed = (id: string) => setReviewed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  let body: React.ReactNode
  if (!canInsights) {
    body = <EmptyState icon={Lightbulb} title="AI insights are not included in your license"
      text="Contact Calypsion to upgrade your LinkSim edition." />
  } else if (!activeRun) {
    body = (
      <EmptyState icon={Lightbulb} title="No run selected" text="Run a simulation first to see AI insights."
        action={<Button onClick={() => navigate('/run')} className="mt-2"><Play className="h-4 w-4" />Go to Analysis</Button>} />
    )
  } else if (activeRun.status !== 'completed') {
    body = <EmptyState icon={Clock} title={`Run #${activeRun.id} is ${activeRun.status}`} text="Insights are generated after a run completes." />
  } else if (isLoading) {
    body = <div className="animate-pulse py-24 text-center text-ls-mute">Generating insights…</div>
  } else if (error || !data) {
    body = (
      <EmptyState icon={AlertTriangle} title="Failed to load insights" text="The run's analysis could not be read."
        action={<Button variant="outline" onClick={() => navigate('/run')}>Back to Analysis</Button>} />
    )
  } else {
    const count = (k: string) => (k === 'all' ? ranked.length : ranked.filter((r) => r.cat.key === k).length)
    body = (
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card className="mb-3">
            <CardContent className="flex flex-wrap gap-2 p-3">
              {[{ key: 'all', label: 'All' }, ...CATEGORIES].map((c) => (
                <button
                  key={c.key}
                  onClick={() => setFilter(c.key)}
                  className={cn('h-8 rounded-full px-3.5 text-[12.5px] font-semibold transition-colors', filter === c.key ? 'bg-ls-dark text-ls-card' : 'bg-ls-card text-ls-ink2 shadow-sm hover:bg-ls-soft')}
                >
                  {c.label} · {count(c.key)}
                </button>
              ))}
            </CardContent>
          </Card>
          {shown.length === 0 ? (
            <Card><CardContent className="py-16 text-center text-sm text-ls-mute">No insights in this category for the run.</CardContent></Card>
          ) : (
            shown.map((r) => <InsightRow key={r.id} item={r} rank={ranked.indexOf(r) + 1} reviewed={reviewed.has(r.id)} onReview={() => toggleReviewed(r.id)} />)
          )}
        </div>

        <div>
          <Card className="mb-4">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-ls-ink2">Analysis of run #{activeRun.id}</CardTitle>
              <p className="text-xs text-ls-mute">Built from this run's station results.</p>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-2">
                {[
                  ['Confidence', `${Math.round(data.insights.ai_confidence * 100)}%`],
                  ['Found', String(ranked.length)],
                  ['High priority', String(ranked.filter((r) => r.priority === 'high').length)],
                  ['Reviewed', String(reviewed.size)],
                ].map(([l, v]) => (
                  <div key={l} className="rounded-xl bg-ls-soft px-3 py-2.5">
                    <span className="block text-[10.5px] font-semibold text-ls-mute">{l}</span>
                    <b className="font-display text-lg font-bold text-ls-ink">{v}</b>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs leading-relaxed text-ls-mute">
                Suggestions are advice. Change the layout in the Workspace and run again to see the effect.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-full p-7">
      <div className="mx-auto max-w-[1280px]">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-5">
            <h1 className="text-2xl font-semibold text-ls-ink">Interfaces &amp; AI</h1>
          </div>
          {activeRun && (
            <p className="text-[12.5px] font-semibold text-ls-mute">
              {activeScenario?.name} · Run #{activeRun.id}{activeRun.completed_jobs != null ? ` · ${activeRun.completed_jobs} jobs completed` : ''}
            </p>
          )}
        </div>
        {body}
      </div>
    </div>
  )
}
