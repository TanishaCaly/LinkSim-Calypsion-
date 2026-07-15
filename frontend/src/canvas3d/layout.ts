import type { ProcessStep, StationConfig, StationStat, OperatorConfig } from '@/types'

export interface Machine3D {
  id: string
  position: [number, number, number]
  label: string
  baseName: string
  capacity: number
  machineIndex: number
  machineCount: number
  utilization: number
  stats?: StationStat
  steps: ProcessStep[]
  height: number
  width: number
  queueDepth: number
}

export interface Operator3D {
  id: string
  name: string
  skill: number
  availability: number
  machineId: string
  position: [number, number, number]
  index: number
  totalCount: number
}

export interface Connection3D {
  id: string
  from: [number, number, number]
  to: [number, number, number]
  operation: string
  duration: number
  fromStation: string
  toStation: string
}

export interface StepLabel {
  position: [number, number, number]
  text: string
}

const X_GAP = 6
const Z_GAP = 3.5
const COLS_PER_ROW = 5

function utilColor(u: number): string {
  if (u >= 85) return '#ef4444'
  if (u >= 70) return '#f59e0b'
  if (u >= 40) return '#22c55e'
  return '#94a3b8'
}

export { utilColor }

export function buildScene3D(
  processflow: Record<string, ProcessStep[]>,
  variant: string,
  stationsData: Record<string, StationConfig>,
  operatorsData: Record<string, OperatorConfig>,
  stationStats: StationStat[],
): { machines: Machine3D[]; operators: Operator3D[]; connections: Connection3D[]; stepLabels: StepLabel[] } {
  const steps = processflow[variant] ?? []
  const statsMap = new Map(stationStats.map(s => [s.station_name, s]))

  const maxDuration = Math.max(...steps.map(s => s.duration), 1)

  const seen = new Map<string, { col: number; machines: Machine3D[] }>()
  const machines: Machine3D[] = []
  const operators: Operator3D[] = []

  let stepIdx = 0
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const station = stationsData[step.resource]
    if (!station) continue

    if (!seen.has(step.resource)) {
      const capacity = station.capacity || 1
      const colMachines: Machine3D[] = []
      const stats = statsMap.get(step.resource)
      const util = stats?.station_utilization ?? 0
      const isBottleneck = util > 85
      const queueDepth = isBottleneck
        ? Math.min(Math.floor((util - 85) / 2), 8)
        : 0
      const height = 1.2 + (step.duration / maxDuration) * 0.8
      const width = 2.0 + (capacity - 1) * 0.3

      const row = Math.floor(stepIdx / COLS_PER_ROW)
      const colInRow = stepIdx % COLS_PER_ROW
      const isReversed = row % 2 === 1
      const col = isReversed ? (COLS_PER_ROW - 1 - colInRow) : colInRow
      const xPos = col * X_GAP - (COLS_PER_ROW - 1) * X_GAP * 0.5
      const zPos = row * Z_GAP * 2.5

      for (let m = 0; m < capacity; m++) {
        const id = capacity > 1 ? `${step.resource}#${m + 1}` : step.resource
        const z = capacity > 1
          ? zPos + (-(((capacity - 1) * Z_GAP) / 2) + m * Z_GAP)
          : zPos

        const machine: Machine3D = {
          id,
          position: [xPos, height / 2, z],
          label: capacity > 1 ? `${step.resource} #${m + 1}` : step.resource,
          baseName: step.resource,
          capacity,
          machineIndex: m,
          machineCount: capacity,
          utilization: stats?.station_utilization ?? 0,
          stats,
          steps: [],
          height,
          width,
          queueDepth,
        }
        colMachines.push(machine)
        machines.push(machine)
      }

      seen.set(step.resource, { col: stepIdx, machines: colMachines })

      const opCount = station.operator_per_station || 1
      const shiftOp = station.shift1 || 'Op?'
      const opConfig = operatorsData[shiftOp]

      for (let mi = 0; mi < colMachines.length; mi++) {
        for (let oi = 0; oi < opCount; oi++) {
          const name = oi === 0 ? shiftOp : `${shiftOp}+${oi}`
          const machinePos = colMachines[mi].position
          const spread = (oi - (opCount - 1) / 2) * 0.7
          operators.push({
            id: `op-${step.resource}-${mi}-${oi}`,
            name,
            skill: opConfig?.['Skill Rating'] ?? 3,
            availability: opConfig?.['Availability (%)'] ?? 90,
            machineId: colMachines[mi].id,
            position: [
              machinePos[0] + spread,
              0,
              machinePos[2] + 1.6,
            ],
            index: oi,
            totalCount: opCount,
          })
        }
      }

      stepIdx++
    }

    const entry = seen.get(step.resource)!
    for (const m of entry.machines) {
      if (!m.steps.some(s => s.operation === step.operation)) {
        m.steps.push(step)
      }
    }
  }

  const stationOrder = steps.map(s => s.resource).filter((v, i, a) => a.indexOf(v) === i)
  const connections: Connection3D[] = []

  for (let i = 0; i < stationOrder.length - 1; i++) {
    const fromName = stationOrder[i]
    const toName = stationOrder[i + 1]
    const fromEntry = seen.get(fromName)
    const toEntry = seen.get(toName)
    if (!fromEntry || !toEntry) continue

    const matchingStep = steps.find(
      s => s.resource === fromName && steps.indexOf(s) < steps.findIndex(t => t.resource === toName)
    )

    for (const fromMachine of fromEntry.machines) {
      for (const toMachine of toEntry.machines) {
        connections.push({
          id: `conn-${fromMachine.id}-${toMachine.id}`,
          from: fromMachine.position,
          to: toMachine.position,
          operation: matchingStep?.operation ?? '',
          duration: matchingStep?.duration ?? 0,
          fromStation: fromName,
          toStation: toName,
        })
      }
    }
  }

  const uniqueSteps = steps.filter((s, i) => steps.findIndex(t => t.resource === s.resource) === i)
  const stepLabels: StepLabel[] = uniqueSteps.map((step, i) => {
    const row = Math.floor(i / COLS_PER_ROW)
    const colInRow = i % COLS_PER_ROW
    const isReversed = row % 2 === 1
    const col = isReversed ? (COLS_PER_ROW - 1 - colInRow) : colInRow
    const xPos = col * X_GAP - (COLS_PER_ROW - 1) * X_GAP * 0.5
    const zPos = row * Z_GAP * 2.5
    return {
      position: [xPos, 0.02, zPos - 3.5],
      text: `Step ${i}`,
    }
  })

  return { machines, operators, connections, stepLabels }
}
