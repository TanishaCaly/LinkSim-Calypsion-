import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle, TrendingUp, Shield, Zap, BarChart2, Clock, Lightbulb, Play,
} from 'lucide-react'
import { insightsApi } from '@/api/insights'
import { useAppStore } from '@/store/useAppStore'
import { Button } from '@/components/ui/button'
import { cn, priorityColor } from '@/lib/utils'
import type { InsightItem } from '@/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SECTION_META: Record<string, { icon: React.ElementType; label: string; color: string }> = {
  strategic_recommendations: { icon: TrendingUp, label: 'Strategic',      color: 'text-purple-600 bg-purple-50 border-purple-100' },
  operational_insights:      { icon: BarChart2,  label: 'Operational',    color: 'text-blue-600 bg-blue-50 border-blue-100' },
  predictive_analysis:       { icon: Clock,      label: 'Predictive',     color: 'text-amber-600 bg-amber-50 border-amber-100' },
  optimization_opportunities:{ icon: Zap,        label: 'Optimisation',   color: 'text-green-600 bg-green-50 border-green-100' },
  risk_assessment:           { icon: Shield,     label: 'Risk Assessment', color: 'text-red-600 bg-red-50 border-red-100' },
}

const PRIORITY_BORDER: Record<string, string> = {
  high:   'border-l-red-500',
  medium: 'border-l-amber-400',
  low:    'border-l-blue-400',
}

function InsightCard({ item }: { item: InsightItem }) {
  const borderColor = PRIORITY_BORDER[item.priority] ?? 'border-l-blue-400'
  return (
    <div className={cn(
      'bg-white rounded-2xl border border-gray-100 border-l-4 shadow-sm hover:shadow-md transition-all duration-200 p-5',
      borderColor
    )}>
      {/* Title + priority badge */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <h3 className="text-sm font-semibold text-gray-900 leading-snug">{item.title}</h3>
        <span className={cn('text-xs font-semibold px-2.5 py-0.5 rounded-full shrink-0', priorityColor(item.priority))}>
          {item.priority}
        </span>
      </div>

      {/* Insight text */}
      <p className="text-sm text-gray-500 mb-3">{item.insight}</p>

      {/* Recommendation box */}
      <div className="bg-blue-50 rounded-xl p-3 mb-4 border border-blue-100">
        <div className="flex items-start gap-2">
          <Lightbulb className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
          <p className="text-sm text-blue-700 font-medium">{item.recommendation}</p>
        </div>
      </div>

      {/* Footer metadata */}
      <div className="flex items-center justify-between text-xs text-gray-400 pt-3 border-t border-gray-100">
        <div className="flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" />
          {item.impact}
        </div>
        <div className="flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {item.timeframe}
        </div>
        <div className="font-medium text-gray-500">
          {Math.round(item.confidence * 100)}% confidence
        </div>
      </div>
    </div>
  )
}

function SectionPanel({
  title,
  icon: Icon,
  color,
  items,
}: {
  title: string
  icon: React.ElementType
  color: string
  items: InsightItem[]
}) {
  if (items.length === 0) return null
  const [textColor, bgColor, borderColor] = color.split(' ')
  return (
    <div className="mb-10">
      {/* Section header */}
      <div className="flex items-center gap-3 mb-4">
        <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center border', bgColor, borderColor)}>
          <Icon className={cn('h-4 w-4', textColor)} />
        </div>
        <h2 className="text-base font-semibold text-gray-800">{title}</h2>
        <span className={cn('text-xs font-semibold px-2.5 py-0.5 rounded-full border', bgColor, textColor, borderColor)}>
          {items.length}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {items.map((item, i) => (
          <InsightCard key={i} item={item} />
        ))}
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Insights() {
  const navigate = useNavigate()
  const { activeRun, activeScenario } = useAppStore()

  const { data, isLoading, error } = useQuery({
    queryKey: ['insights', activeRun?.id],
    queryFn: () => insightsApi.get(activeRun!.id),
    enabled: !!activeRun && activeRun.status === 'completed',
  })

  if (!activeRun) {
    return (
      <div className="min-h-full p-8">
        <div className="max-w-5xl mx-auto">
          <div className="rounded-2xl border border-gray-100 bg-white/70 py-32 flex flex-col items-center gap-4">
            <div className="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center">
              <Lightbulb className="h-8 w-8 text-blue-400" />
            </div>
            <p className="text-gray-700 font-semibold text-lg">No run selected</p>
            <p className="text-sm text-gray-400">Run a simulation first to see AI insights.</p>
            <Button onClick={() => navigate('/run')} className="bg-blue-600 hover:bg-blue-700 shadow-sm mt-2">
              <Play className="h-4 w-4 mr-2" />
              Go to Run Dashboard
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (activeRun.status !== 'completed') {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-4">
        <div className="w-16 h-16 bg-amber-50 rounded-2xl flex items-center justify-center">
          <Clock className="h-8 w-8 text-amber-400" />
        </div>
        <p className="text-lg font-semibold text-gray-600">Run #{activeRun.id} is {activeRun.status}</p>
        <p className="text-sm text-gray-400">Insights are generated after a run completes.</p>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <div className="animate-pulse text-gray-400">Generating insights…</div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-3">
        <AlertTriangle className="h-12 w-12 text-red-300" />
        <p>Failed to load insights</p>
        <Button variant="outline" onClick={() => navigate('/run')}>Back to Dashboard</Button>
      </div>
    )
  }

  const { insights } = data
  const sectionKeys = Object.keys(SECTION_META) as (keyof typeof SECTION_META)[]
  const totalInsights = sectionKeys.reduce((sum, key) => {
    const items = insights[key as keyof typeof insights] as InsightItem[] | undefined
    return sum + (items?.length ?? 0)
  }, 0)

  return (
    <div className="min-h-full bg-gradient-to-br from-white via-blue-50/30 to-indigo-50/40 p-8">
      <div className="max-w-5xl mx-auto">

        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">AI Insights</h1>
            <p className="text-sm text-gray-400 mt-0.5">
              {activeScenario?.name} · Run #{activeRun.id} · {activeRun.completed_jobs} jobs completed
            </p>
          </div>

          <div className="flex items-center gap-2">
            {/* AI Confidence pill */}
            <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-full px-4 py-2">
              <div className="w-2 h-2 rounded-full bg-green-500" />
              <span className="text-sm font-semibold text-green-700">
                {Math.round(insights.ai_confidence * 100)}% confidence
              </span>
            </div>

            {/* Insights count pill */}
            <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-full px-4 py-2">
              <Lightbulb className="h-3.5 w-3.5 text-blue-500" />
              <span className="text-sm font-semibold text-blue-700">{totalInsights} insights</span>
            </div>
          </div>
        </div>

        {/* Sections */}
        {Object.entries(SECTION_META).map(([key, { icon, label, color }]) => {
          const items = (insights as Record<string, InsightItem[]>)[key] ?? []
          return (
            <SectionPanel key={key} title={label} icon={icon} color={color} items={items} />
          )
        })}

        {totalInsights === 0 && (
          <div className="text-center py-24 rounded-2xl bg-white/70 border border-blue-100">
            <div className="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <Lightbulb className="h-8 w-8 text-blue-400" />
            </div>
            <p className="text-gray-500 font-medium">No insights generated for this run.</p>
          </div>
        )}

      </div>
    </div>
  )
}
