import { Canvas } from '@react-three/fiber'
import { OrbitControls, Grid } from '@react-three/drei'
import { useState, useCallback } from 'react'
import MachineBox from './MachineBox'
import LabelSprite from './LabelSprite'
import OperatorDot from './OperatorDot'
import FlowLine from './FlowLine'
import MachineDetail from './MachineDetail'
import type { Machine3D, Operator3D, Connection3D } from './layout'
import type { StationConfig, OperatorConfig } from '@/types'

interface SceneProps {
  machines: Machine3D[]
  operators: Operator3D[]
  connections: Connection3D[]
  stationsData: Record<string, StationConfig>
  operatorsData: Record<string, OperatorConfig>
  isDark: boolean
}

function Floor({ isDark }: { isDark: boolean }) {
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
        <planeGeometry args={[120, 120]} />
        <meshStandardMaterial
          color={isDark ? '#1e293b' : '#f1f5f9'}
          roughness={0.95}
          metalness={0}
        />
      </mesh>
      {/* Subtle gradient edge */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
        <ringGeometry args={[30, 60, 64]} />
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
  stationsData,
  operatorsData,
  isDark,
}: SceneProps) {
  const [selectedMachine, setSelectedMachine] = useState<Machine3D | null>(null)
  const [highlightedMachine, setHighlightedMachine] = useState<string | null>(null)

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

  const centerX = machines.length > 0
    ? (machines[machines.length - 1].position[0] + machines[0].position[0]) / 2
    : 0

  return (
    <div className="relative w-full h-full">
      <Canvas
        camera={{ position: [18, 12, 18], fov: 42 }}
        shadows
        gl={{ antialias: true, toneMapping: 3 }}
        onPointerMissed={() => setSelectedMachine(null)}
      >
        {/* Lighting */}
        <ambientLight intensity={isDark ? 0.35 : 0.55} />
        <directionalLight
          position={[12, 25, 12]}
          intensity={isDark ? 1.0 : 1.4}
          castShadow
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
          shadow-camera-far={80}
          shadow-camera-left={-30}
          shadow-camera-right={30}
          shadow-camera-top={30}
          shadow-camera-bottom={-30}
          shadow-bias={-0.0005}
        />
        <hemisphereLight
          args={[isDark ? '#334155' : '#e2e8f0', isDark ? '#0f172a' : '#f8fafc', 0.4]}
        />
        <pointLight position={[centerX, 5, 0]} intensity={0.3} color="#f59e0b" distance={30} />

        {/* Floor */}
        <Floor isDark={isDark} />

        {/* Grid */}
        <Grid
          args={[120, 120]}
          cellSize={1}
          cellThickness={0.4}
          cellColor={isDark ? '#334155' : '#e2e8f0'}
          sectionSize={5}
          sectionThickness={0.8}
          sectionColor={isDark ? '#475569' : '#cbd5e1'}
          fadeDistance={55}
          infiniteGrid
          position={[0, 0.01, 0]}
        />

        {/* Camera controls */}
        <OrbitControls
          enablePan
          enableZoom
          enableRotate
          minDistance={5}
          maxDistance={65}
          maxPolarAngle={Math.PI / 2.05}
          target={[centerX, 0, 0]}
          enableDamping
          dampingFactor={0.05}
        />

        {/* Machines */}
        {machines.map(m => (
          <MachineBox
            key={m.id}
            machine={m}
            selected={selectedMachine?.id === m.id}
            onClick={handleSelectMachine}
            onHover={handleHighlight}
          />
        ))}

        {/* Labels */}
        {machines.map(m => (
          <LabelSprite
            key={`label-${m.id}`}
            position={m.position}
            text={m.label}
            utilization={m.utilization}
            selected={selectedMachine?.id === m.id}
          />
        ))}

        {/* Operators */}
        {operators.map(op => (
          <OperatorDot
            key={op.id}
            operator={op}
            onHighlight={handleHighlight}
          />
        ))}

        {/* Flow connections */}
        {connections.map(c => (
          <FlowLine key={c.id} connection={c} />
        ))}
      </Canvas>

      {/* Selection detail panel */}
      {selectedMachine && (
        <MachineDetail
          machine={selectedMachine}
          stationConfig={stationConfig}
          operators={selectedOperators}
          onClose={() => setSelectedMachine(null)}
        />
      )}

      {/* Hover tooltip */}
      {highlightedMachine && !selectedMachine && (
        <div className="absolute bottom-4 left-4 bg-white/95 backdrop-blur-sm rounded-xl shadow-lg border border-gray-200 px-4 py-2.5 text-sm text-gray-800 z-10 font-medium">
          {highlightedMachine}
        </div>
      )}
    </div>
  )
}
