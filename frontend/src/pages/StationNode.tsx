import { Handle, Position, type NodeTypes } from 'reactflow'
import type { StationNodeData } from '@/types'

function StationNode({ data, selected }: { data: StationNodeData; selected: boolean }) {
  return (
    <div className={`px-4 py-3 bg-white rounded-lg border-2 min-w-[140px] shadow-sm transition-colors ${selected ? 'border-blue-500' : 'border-gray-200'}`}>
      <Handle type="target" position={Position.Left} className="!bg-blue-400" />
      <div className="flex items-center gap-2 mb-1">
        <div className="w-2 h-2 rounded-full bg-blue-500" />
        <span className="text-sm font-semibold text-gray-900">{data.label}</span>
      </div>
      <div className="text-xs text-gray-400 space-y-0.5">
        <div>Capacity: {data.capacity}</div>
        <div>Cycle time: {data.cycleTime}m</div>
        <div>Operators: {data.operators}</div>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-blue-400" />
    </div>
  )
}

export const nodeTypes: NodeTypes = { station: StationNode }
export const defaultEdgeTypes = {}
