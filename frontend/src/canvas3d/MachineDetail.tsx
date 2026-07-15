import { X } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { Machine3D } from './layout'
import { utilColor } from './layout'
import type { StationConfig } from '@/types'

interface MachineDetailProps {
  machine: Machine3D
  stationConfig: StationConfig | undefined
  operators: { name: string; skill: number; availability: number }[]
  onClose: () => void
}

function ProgressBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="h-2 w-full rounded-full bg-gray-200">
      <div
        className="h-2 rounded-full transition-all duration-300"
        style={{ width: `${Math.min(value, 100)}%`, backgroundColor: color }}
      />
    </div>
  )
}

export default function MachineDetail({ machine, stationConfig, operators, onClose }: MachineDetailProps) {
  const stats = machine.stats
  const util = machine.utilization
  const utilCol = utilColor(util)

  return (
    <div className="absolute right-4 top-4 bottom-4 w-80 z-10 overflow-y-auto rounded-2xl shadow-2xl border border-gray-200 bg-white">
      <div className="sticky top-0 z-10 bg-white border-b border-gray-100 px-4 py-3 flex items-center justify-between rounded-t-2xl">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-bold text-gray-900">{machine.label}</h2>
          <Badge variant={util >= 85 ? 'destructive' : util >= 70 ? 'warning' : 'success'}>
            {util.toFixed(1)}%
          </Badge>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-md hover:bg-gray-100 transition-colors"
        >
          <X className="h-4 w-4 text-gray-500" />
        </button>
      </div>

      <div className="p-4 space-y-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Station Properties</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Capacity</span>
              <span className="font-medium text-gray-900">{machine.capacity}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Operators / Machine</span>
              <span className="font-medium text-gray-900">{stationConfig?.operator_per_station ?? '—'}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Shifts / Day</span>
              <span className="font-medium text-gray-900">{stationConfig?.shifts_per_day ?? '—'}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Failure Rate</span>
              <span className="font-medium text-gray-900">{stationConfig?.['Failure rate'] != null ? `${stationConfig['Failure rate'] * 100}%` : '—'}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Repair Time</span>
              <span className="font-medium text-gray-900">{stationConfig?.['Repair Time'] != null ? `${stationConfig['Repair Time']} min` : '—'}</span>
            </div>
          </CardContent>
        </Card>

        {operators.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Operators ({operators.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {operators.map((op, i) => (
                  <div key={i} className="flex items-center justify-between text-sm rounded-md bg-gray-50 px-3 py-2">
                    <span className="font-medium text-gray-800">{op.name}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-gray-500">Skill {op.skill}/5</span>
                      <span className="text-gray-500">{op.availability}%</span>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {stats && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Simulation Results</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-gray-500">Station Utilization</span>
                  <span className="font-medium" style={{ color: utilCol }}>{stats.station_utilization.toFixed(1)}%</span>
                </div>
                <ProgressBar value={stats.station_utilization} color={utilCol} />
              </div>
              <div>
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-gray-500">Operator Utilization</span>
                  <span className="font-medium">{stats.operator_utilization.toFixed(1)}%</span>
                </div>
                <ProgressBar value={stats.operator_utilization} color={utilColor(stats.operator_utilization)} />
              </div>
              <div className="grid grid-cols-2 gap-2 pt-1">
                <div className="text-center rounded-md bg-gray-50 p-2">
                  <div className="text-lg font-bold text-gray-900">{stats.completed_jobs}</div>
                  <div className="text-xs text-gray-500">Completed Jobs</div>
                </div>
                <div className="text-center rounded-md bg-gray-50 p-2">
                  <div className="text-lg font-bold text-gray-900">{stats.throughput.toFixed(1)}</div>
                  <div className="text-xs text-gray-500">Throughput /hr</div>
                </div>
                <div className="text-center rounded-md bg-gray-50 p-2">
                  <div className="text-lg font-bold text-gray-900">{stats.failure_breakdowns}</div>
                  <div className="text-xs text-gray-500">Failures</div>
                </div>
                <div className="text-center rounded-md bg-gray-50 p-2">
                  <div className="text-lg font-bold text-gray-900">{stats.pm_breakdowns}</div>
                  <div className="text-xs text-gray-500">PM Stops</div>
                </div>
                <div className="text-center rounded-md bg-gray-50 p-2">
                  <div className="text-lg font-bold text-gray-900">{stats.rework_percentage.toFixed(1)}%</div>
                  <div className="text-xs text-gray-500">Rework %</div>
                </div>
                <div className="text-center rounded-md bg-gray-50 p-2">
                  <div className="text-lg font-bold text-gray-900">{stats.avg_block_time.toFixed(1)}</div>
                  <div className="text-xs text-gray-500">Avg Block (min)</div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {machine.steps.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Process Steps</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                {machine.steps.map((step, i) => (
                  <div key={i} className="flex items-center justify-between text-sm rounded-md bg-gray-50 px-3 py-2">
                    <span className="text-gray-700">{i + 1}. {step.operation}</span>
                    <span className="text-gray-500 font-mono text-xs">{step.duration} min</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
