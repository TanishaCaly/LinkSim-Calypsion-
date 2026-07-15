import { Canvas } from '@react-three/fiber'
import { OrbitControls, Grid } from '@react-three/drei'
import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import MachineBox from './MachineBox'
import LabelSprite from './LabelSprite'
import OperatorDot from './OperatorDot'
import FlowLine from './FlowLine'
import JobParticle from './JobParticle'
import QueueStack from './QueueStack'
import MachineDetail from './MachineDetail'
import type { Machine3D, Operator3D, Connection3D, StepLabel } from './layout'
import type { StationConfig, OperatorConfig } from '@/types'

export interface TimelineRefs {
  playing: React.MutableRefObject<boolean>
  speed: React.MutableRefObject<number>
  scrubPct: React.MutableRefObject<number>
  simClockMs: React.MutableRefObject<number>
  totalMs: React.MutableRefObject<number>
  setScrubUI: (pct: number) => void
  setTotalMsUI: (ms: number) => void
  setPlayingUI: (playing: boolean) => void
}

interface SceneProps {
  machines: Machine3D[]
  operators: Operator3D[]
  connections: Connection3D[]
  stepLabels: StepLabel[]
  stationsData: Record<string, StationConfig>
  operatorsData: Record<string, OperatorConfig>
  isDark: boolean
  completionLog?: Record<string, unknown[]>
}

function Floor({ isDark, size, centerX, centerZ }: { isDark: boolean; size: number; centerX: number; centerZ: number }) {
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[centerX, -0.02, centerZ]} receiveShadow>
        <planeGeometry args={[size, size]} />
        <meshStandardMaterial
          color={isDark ? '#1e293b' : '#f1f5f9'}
          roughness={0.95}
          metalness={0}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[centerX, -0.01, centerZ]}>
        <ringGeometry args={[size * 0.3, size * 0.6, 64]} />
        <meshBasicMaterial
          color={isDark ? '#0f172a' : '#e2e8f0'}
          transparent
          opacity={0.3}
        />
      </mesh>
    </>
  )
}

export default function Scene({
  machines,
  operators,
  connections,
  stepLabels,
  stationsData,
  operatorsData,
  isDark,
  completionLog,
}: SceneProps) {
  const [selectedMachine, setSelectedMachine] = useState<Machine3D | null>(null)
  const [highlightedMachine, setHighlightedMachine] = useState<string | null>(null)

  const playingRef = useRef(false)
  const speedRef = useRef(10)
  const scrubPctRef = useRef(0)
  const simClockMsRef = useRef(0)
  const totalMsRef = useRef(1)
  const [scrubUI, setScrubUI] = useState(0)
  const [totalMsUI, setTotalMsUI] = useState(1)
  const [speedUI, setSpeedUI] = useState(10)
  const [playingUI, setPlayingUI] = useState(false)

  const timelineRefs: TimelineRefs = useMemo(() => ({
    playing: playingRef,
    speed: speedRef,
    scrubPct: scrubPctRef,
    simClockMs: simClockMsRef,
    totalMs: totalMsRef,
    setScrubUI,
    setTotalMsUI,
    setPlayingUI,
  }), [])

  useEffect(() => {
    scrubPctRef.current = 0
    simClockMsRef.current = 0
    playingRef.current = false
    setScrubUI(0)
    setPlayingUI(false)
  }, [completionLog])

  const handleSelectMachine = useCallback((machine: Machine3D | null) => {
    setSelectedMachine(machine)
  }, [])

  const handleHighlight = useCallback((machineId: string | null) => {
    setHighlightedMachine(machineId)
  }, [])

  const selectedOperators = selectedMachine
    ? operators
        .filter(op => op.machineId === selectedMachine.id)
        .map(op => ({
          name: op.name,
          skill: op.skill,
          availability: op.availability,
        }))
    : []

  const stationConfig = selectedMachine
    ? stationsData[selectedMachine.baseName]
    : undefined

  const { floorSize, centerZ } = (() => {
    if (machines.length === 0) return { floorSize: 40, centerZ: 0 }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const m of machines) {
      minX = Math.min(minX, m.position[0])
      maxX = Math.max(maxX, m.position[0])
      minZ = Math.min(minZ, m.position[2])
      maxZ = Math.max(maxZ, m.position[2])
    }
    for (const op of operators) {
      minX = Math.min(minX, op.position[0])
      maxX = Math.max(maxX, op.position[0])
      minZ = Math.min(minZ, op.position[2])
      maxZ = Math.max(maxZ, op.position[2])
    }
    const spanX = maxX - minX
    const spanZ = maxZ - minZ
    const size = Math.max(spanX, spanZ) + 12
    const cz = (minZ + maxZ) / 2
    return { floorSize: Math.max(size, 40), centerZ: cz }
  })()

  const centerX = machines.length > 0
    ? (machines[machines.length - 1].position[0] + machines[0].position[0]) / 2
    : 0

  const totalMinutes = Math.round(totalMsUI / 60000)
  const curMinutes = Math.round((scrubUI / 100) * totalMinutes)

  return (
    <div className="relative w-full h-full">
      <Canvas
        camera={{ position: [centerX + floorSize * 0.35, floorSize * 0.3, centerZ + floorSize * 0.35], fov: 42 }}
        shadows="pcf"
        gl={{ antialias: true, toneMapping: 3 }}
        onPointerMissed={() => setSelectedMachine(null)}
      >
        <ambientLight intensity={isDark ? 0.35 : 0.55} />
        <directionalLight
          position={[centerX + 12, 25, centerZ + 12]}
          intensity={isDark ? 1.0 : 1.4}
          castShadow
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
          shadow-camera-far={floorSize * 1.2}
          shadow-camera-left={centerX - floorSize / 2}
          shadow-camera-right={centerX + floorSize / 2}
          shadow-camera-top={centerZ + floorSize / 2}
          shadow-camera-bottom={centerZ - floorSize / 2}
          shadow-bias={-0.0005}
        />
        <hemisphereLight
          args={[isDark ? '#334155' : '#e2e8f0', isDark ? '#0f172a' : '#f8fafc', 0.4]}
        />
        <pointLight position={[centerX, 5, centerZ]} intensity={0.3} color="#f59e0b" distance={30} />

        <Floor isDark={isDark} size={floorSize} centerX={centerX} centerZ={centerZ} />

        <Grid
          args={[floorSize, floorSize]}
          cellSize={1}
          cellThickness={0.4}
          cellColor={isDark ? '#334155' : '#e2e8f0'}
          sectionSize={5}
          sectionThickness={0.8}
          sectionColor={isDark ? '#475569' : '#cbd5e1'}
          fadeDistance={floorSize * 1.5}
          infiniteGrid
          position={[centerX, 0.01, centerZ]}
        />

        <OrbitControls
          enablePan
          enableZoom
          enableRotate
          minDistance={5}
          maxDistance={floorSize * 1.5}
          maxPolarAngle={Math.PI / 2.05}
          target={[centerX, 0, centerZ]}
          enableDamping
          dampingFactor={0.05}
        />

        {stepLabels.map((label, i) => (
          <LabelSprite
            key={`step-${i}`}
            position={label.position}
            text={label.text}
            scale={0.8}
          />
        ))}

        {machines.map(m => (
          <MachineBox
            key={m.id}
            machine={m}
            selected={selectedMachine?.id === m.id}
            onClick={handleSelectMachine}
            onHover={handleHighlight}
          />
        ))}

        {machines.map(m => (
          <LabelSprite
            key={`label-${m.id}`}
            position={m.position}
            text={m.label}
            utilization={m.utilization}
            selected={selectedMachine?.id === m.id}
          />
        ))}

        {operators.map(op => (
          <OperatorDot
            key={op.id}
            operator={op}
            onHighlight={handleHighlight}
          />
        ))}

        {machines.filter(m => m.queueDepth > 0).map(m => (
          <QueueStack key={`queue-${m.id}`} machine={m} />
        ))}

        {connections.map(c => (
          <FlowLine key={c.id} connection={c} />
        ))}

        <JobParticle
          machines={machines}
          connections={connections}
          completionLog={completionLog}
          timelineRefs={timelineRefs}
        />
      </Canvas>

      {completionLog && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-white/95 backdrop-blur-sm rounded-xl shadow-lg border border-gray-200 px-4 py-2 z-10">
          <button
            onClick={() => {
              scrubPctRef.current = 0
              simClockMsRef.current = 0
              playingRef.current = false
              setPlayingUI(false)
              setScrubUI(0)
            }}
            className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 font-medium"
          >
            ↩ Reset
          </button>
          <button
            onClick={() => { playingRef.current = !playingRef.current; setPlayingUI(playingRef.current) }}
            className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-medium"
          >
            {playingUI ? '⏸ Pause' : '▶ Play'}
          </button>
          {[1, 10, 50].map(s => (
            <button
              key={s}
              onClick={() => { speedRef.current = s; setSpeedUI(s) }}
              className={`text-xs px-2 py-1.5 rounded-lg border font-medium transition-colors ${speedUI === s ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-500 hover:border-blue-300'}`}
            >
              {s}×
            </button>
          ))}
          <input
            type="range"
            min={0}
            max={100}
            step={0.1}
            value={scrubUI}
            onChange={e => {
              playingRef.current = false
              setPlayingUI(false)
              const pct = Number(e.target.value)
              scrubPctRef.current = pct
              simClockMsRef.current = (pct / 100) * totalMsRef.current
              setScrubUI(pct)
            }}
            className="w-40 accent-blue-600"
          />
          <span className="text-[10px] text-gray-400 font-medium whitespace-nowrap">
            {curMinutes}m / {totalMinutes}m
          </span>
        </div>
      )}

      {selectedMachine && (
        <MachineDetail
          machine={selectedMachine}
          stationConfig={stationConfig}
          operators={selectedOperators}
          onClose={() => setSelectedMachine(null)}
        />
      )}

      {highlightedMachine && !selectedMachine && (
        <div className="absolute bottom-4 left-4 bg-white/95 backdrop-blur-sm rounded-xl shadow-lg border border-gray-200 px-4 py-2.5 text-sm text-gray-800 z-10 font-medium">
          {highlightedMachine}
        </div>
      )}
    </div>
  )
}
