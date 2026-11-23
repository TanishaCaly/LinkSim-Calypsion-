import { Canvas, useThree, type GLProps } from '@react-three/fiber'
import { OrbitControls, Grid } from '@react-three/drei'
import { Maximize2, Minimize2 } from 'lucide-react'
import { Suspense, useState, useCallback, useRef, useMemo, useEffect } from 'react'
import MachineBox from './MachineBox'
import CameraRig from './CameraRig'
import FactoryShell from './FactoryShell'
import StationModel from './StationModel'
import InstancedStations, { type BatchItem } from './InstancedStations'
import InstancedOperators from './InstancedOperators'
import InstancedFlow from './InstancedFlow'
import InstancedMachines from './InstancedMachines'
import NearShadowLight from './NearShadowLight'
import { canInstance, instancingOn } from './instancing'
import { STATION_MODELS } from '@/lib/stationTypes'
import { TagProjector, TagOverlay, type TagBus } from './StationTags'
import { buildTagAnchors } from './tags'
import { CineonToneMapping } from 'three'
import PerfProbe from './PerfProbe'
import { createWebGPURenderer, isWebGPU, preferredRenderer } from './renderer'
import OperatorDot from './OperatorDot'
import FlowLine from './FlowLine'
import JobMarkers from './JobMarkers'
import MachineDetail from './MachineDetail'
import type { Machine3D, Operator3D, Connection3D, StepLabel, Prop3D } from './layout'
import { buildStationActivity, activeCount, type AnimState } from './stationActivity'
import type { AssemblyInfo, DismantleInfo } from './jobTimeline'
import type { StationConfig, OperatorConfig, WorkerPoolStat } from '@/types'
import WorkerFigure from './WorkerFigure'
import { planWorkers, travelMs } from './workerSchedule'
import { makeRouter, type Box } from './walkPath'
import ReplayBar, { DEFAULT_REPLAY_SPEED, IdleReplayBar, REPLAY_SPEEDS, fmtReplayClock } from '@/components/run/ReplayBar'

export interface TimelineRefs {
  playing: React.MutableRefObject<boolean>
  speed: React.MutableRefObject<number>
  scrubPct: React.MutableRefObject<number>
  simClockMs: React.MutableRefObject<number>
  totalMs: React.MutableRefObject<number>
  setScrubUI: (pct: number) => void
  setTotalMsUI: (ms: number) => void
  // Real-world time (ms) of the timeline's zero, for the Day / clock reading.
  setZeroMsUI: (ms: number) => void
  setPlayingUI: (playing: boolean) => void
  setCounts: (waiting: number, processing: number, done: number, assembled?: number, dismantled?: number, rejected?: number, scrapped?: number) => void
  // Jobs waiting at each station right now, written every frame for the tags.
  queues: React.MutableRefObject<Map<string, number>>
}

interface SceneProps {
  machines: Machine3D[]
  operators: Operator3D[]
  connections: Connection3D[]
  stepLabels: StepLabel[]
  props: Prop3D[]
  stationsData: Record<string, StationConfig>
  operatorsData: Record<string, OperatorConfig>
  isDark: boolean
  completionLog?: Record<string, unknown[]>
  // simulation_state.assemblies of the run (what each Assembly made, from which parts).
  assemblies?: Record<string, AssemblyInfo>
  // simulation_state.dismantles of the run (the pieces each dismantled job split into).
  dismantles?: Record<string, DismantleInfo>
  // Each product's colour from Build's Start table: product name -> colour.
  variantColors?: Record<string, string>
  // How many jobs the run turned away (rejected) or lost (scrapped); the legend shows them only when there are some.
  outcomes?: { rejected: number; scrapped: number }
  // How long the run was set to simulate, in minutes; the replay bar shows it as "Run for".
  runMinutes?: number
  // When the run started (its first job release), for the bar of a run in which no job moved.
  runStartMs?: number
  // run.result.worker_pool_stats: which stations each pool Worker served; the Workers walk to them in the replay.
  workerPool?: Record<string, WorkerPoolStat>
}

const WEBGL_PROPS = { antialias: true, toneMapping: CineonToneMapping }

const FIT_SECONDS = 60

// Parts that need WebGL (drei's shader grid) step aside under WebGPU.
function WebGLOnly({ children }: { children: React.ReactNode }) {
  const gl = useThree(s => s.gl)
  return isWebGPU(gl) ? null : <>{children}</>
}

function Floor({ isDark, size, centerX, centerZ }: { isDark: boolean; size: number; centerX: number; centerZ: number }) {
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[centerX, -0.02, centerZ]} receiveShadow>
        <planeGeometry args={[size, size]} />
        <meshStandardMaterial
          color={isDark ? '#3b4758' : '#f1f5f9'}
          roughness={0.95}
          metalness={0}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[centerX, -0.01, centerZ]}>
        <ringGeometry args={[size * 0.3, size * 0.6, 64]} />
        <meshBasicMaterial
          color={isDark ? '#2a3441' : '#e2e8f0'}
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
  props,
  stationsData,
  isDark,
  completionLog,
  workerPool,
  assemblies,
  dismantles,
  variantColors,
  outcomes,
  runMinutes,
  runStartMs,
}: SceneProps) {
  const [selectedMachine, setSelectedMachine] = useState<Machine3D | null>(null)
  const [topView, setTopView] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const [full, setFull] = useState(false)
  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === rootRef.current)
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])
  const toggleFull = () => (document.fullscreenElement ? document.exitFullscreen() : rootRef.current?.requestFullscreen())?.catch(() => {})
  // Factory hall around the line, or the plain floor; remembered between visits.
  const [factory, setFactory] = useState(() => {
    try { return localStorage.getItem('linksim.3d.factory') !== 'off' } catch { return true }
  })
  const toggleFactory = () => {
    setFactory(f => {
      try { localStorage.setItem('linksim.3d.factory', f ? 'off' : 'on') } catch { /* private window */ }
      return !f
    })
  }
  // WebGPU when the browser has it (and it is switched on in renderer.ts), WebGL otherwise.
  const [renderer] = useState(preferredRenderer)
  // Station and flow labels; remembered the same way.
  const [tags, setTags] = useState(() => {
    try { return localStorage.getItem('linksim.3d.tags') !== 'off' } catch { return true }
  })
  const toggleTags = () => {
    setTags(t => {
      try { localStorage.setItem('linksim.3d.tags', t ? 'off' : 'on') } catch { /* private window */ }
      return !t
    })
  }

  const playingRef = useRef(false)
  const speedRef = useRef(60_000) // simulated ms per real second
  const scrubPctRef = useRef(0)
  const simClockMsRef = useRef(0)
  const totalMsRef = useRef(1)
  const queuesRef = useRef(new Map<string, number>())
  const tagBus: TagBus = useMemo(() => ({ live: { current: [] }, shown: { current: [] }, els: { current: [] }, bump: { current: null } }), [])
  const tagAnchors = useMemo(() => buildTagAnchors(machines, props, connections), [machines, props, connections])
  const [scrubUI, setScrubUI] = useState(0)
  const [totalMsUI, setTotalMsUI] = useState(1)
  const [zeroMsUI, setZeroMsUI] = useState(0)
  const [speedId, setSpeedId] = useState(DEFAULT_REPLAY_SPEED)
  const [playingUI, setPlayingUI] = useState(false)

  // Legend numbers are written straight into the page so a change in the line
  // doesn't re-render the whole scene.
  const waitingEl = useRef<HTMLSpanElement>(null)
  const processingEl = useRef<HTMLSpanElement>(null)
  const doneEl = useRef<HTMLSpanElement>(null)
  const assembledEl = useRef<HTMLSpanElement>(null)
  const dismantledEl = useRef<HTMLSpanElement>(null)
  const rejectedEl = useRef<HTMLSpanElement>(null)
  const scrappedEl = useRef<HTMLSpanElement>(null)
  const setCounts = useCallback((waiting: number, processing: number, done: number, assembled = 0, dismantled = 0, rejected = 0, scrapped = 0) => {
    if (waitingEl.current) waitingEl.current.textContent = String(waiting)
    if (processingEl.current) processingEl.current.textContent = String(processing)
    if (doneEl.current) doneEl.current.textContent = String(done)
    if (assembledEl.current) assembledEl.current.textContent = String(assembled)
    if (dismantledEl.current) dismantledEl.current.textContent = String(dismantled)
    if (rejectedEl.current) rejectedEl.current.textContent = String(rejected)
    if (scrappedEl.current) scrappedEl.current.textContent = String(scrapped)
  }, [])

  const timelineRefs: TimelineRefs = useMemo(() => ({
    playing: playingRef,
    speed: speedRef,
    scrubPct: scrubPctRef,
    simClockMs: simClockMsRef,
    totalMs: totalMsRef,
    setScrubUI,
    setTotalMsUI,
    setZeroMsUI,
    setPlayingUI,
    setCounts,
    queues: queuesRef,
  }), [setCounts])

  useEffect(() => {
    scrubPctRef.current = 0
    simClockMsRef.current = 0
    playingRef.current = false
    setScrubUI(0)
    setPlayingUI(false)
  }, [completionLog])

  useEffect(() => {
    const preset = REPLAY_SPEEDS.find(s => s.id === speedId)
    speedRef.current = preset?.simSecPerSec != null ? preset.simSecPerSec * 1000 : Math.max(totalMsUI / FIT_SECONDS, 1)
  }, [speedId, totalMsUI])

  const handleSelectMachine = useCallback((machine: Machine3D | null) => {
    setSelectedMachine(machine)
  }, [])

  // Machine search box (top right).
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [active, setActive] = useState(0)
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return machines
      .filter(m => m.label.toLowerCase().includes(q) || m.baseName.toLowerCase().includes(q))
      .slice(0, 8)
  }, [machines, query])
  const pickMachine = (m: Machine3D) => {
    setTopView(false) // the top view can't focus a machine
    setSelectedMachine(m)
    setQuery('')
    setSearchOpen(false)
  }

  // Running/Waiting for each model at the current timeline position, read
  // per frame from the sim clock ref. Null until a run is loaded (models then
  // loop Waiting). The log has no machine index, so a capacity-N station with
  // k jobs in process runs its first k machines.
  const anim = useMemo(() => {
    if (!completionLog) return null
    const activity = buildStationActivity(completionLog)
    const busy = (station: string) => activeCount(activity, station, simClockMsRef.current)
    const state = (running: boolean): AnimState => (running ? 'Running' : 'Waiting')
    const allStations = Array.from(activity.byStation.keys())
    return {
      machine: (m: Machine3D) => () => state(busy(m.baseName) > m.machineIndex),
      stations: (stations = allStations) => () => state(stations.some(s => busy(s) > 0)),
    }
  }, [completionLog])

  // Each pool Worker's visits to stations over the run (an estimate, see workerSchedule.ts).
  const workerPlan = useMemo(() => {
    if (!completionLog || !workerPool) return null
    const activity = buildStationActivity(completionLog)
    let end = activity.globalStart
    for (const { ends } of activity.byStation.values()) for (const e of ends) if (isFinite(e) && e > end) end = e
    return { segs: planWorkers(activity, workerPool), globalStart: activity.globalStart, travel: travelMs(end - activity.globalStart) }
  }, [completionLog, workerPool])
  // What a walking Worker goes round: every machine and every prop except the Workers themselves.
  const router = useMemo(() => {
    const size: Record<string, [number, number]> = { Workplace: [1.0, 0.7], 'Worker Controller': [0.6, 0.6], Source: [1.6, 0.8], Drain: [1.6, 0.8] }
    const boxes: Box[] = [
      ...machines.map(m => ({ x: m.position[0], z: m.position[2], hw: m.width / 2 + 0.3, hd: 1.0 })),
      ...props.filter(p => size[p.stationType]).map(p => ({ x: p.position[0], z: p.position[2], hw: size[p.stationType][0], hd: size[p.stationType][1] })),
    ]
    return makeRouter(boxes)
  }, [machines, props])
  const workerSlots = useMemo(() => props.filter(p => p.stationType === 'Worker' && p.label && workerPlan?.segs.has(p.label)).map(p => p.id), [props, workerPlan])
  const stationSpot = useCallback((station: string): [number, number] | undefined => {
    // Workers work at the Workplace that feeds the station, standing just in front of it.
    const wp = props.find(p => p.stationType === 'Workplace' && p.stations?.includes(station))
    // Never at the station itself: with no Workplace the Worker stays at its own spot.
    return wp ? [wp.position[0], wp.position[2] + 1.3] : undefined
  }, [props])

  const machineById = useMemo(() => new Map(machines.map(m => [m.id, m])), [machines])

  const stateOf = useCallback((m: Machine3D) => anim?.machine(m), [anim])
  const operatorState = useCallback((op: Operator3D) => { const m = machineById.get(op.machineId); return m && anim?.machine(m) }, [machineById, anim])
  // The batch's shader patch is for the WebGL renderer, so batching is off under WebGPU.
  const batching = useMemo(() => instancingOn() && preferredRenderer() === 'webgl', [])
  // Machines to grow a little while hovered or selected (id → scale), shared by the batch and its click boxes.
  const emphasis = useRef(new Map<string, number>())

  // Machines whose model is drawn as an instanced batch instead of one by one.
  const instanced = useMemo(
    () => (batching ? machines.filter(m => canInstance(m.stationType)) : []),
    [machines, batching],
  )
  // One batch per model file.
  const instancedGroups = useMemo(() => {
    const groups = new Map<string, Machine3D[]>()
    for (const m of instanced) {
      const url = STATION_MODELS[m.stationType]
      groups.set(url, [...(groups.get(url) ?? []), m])
    }
    return [...groups]
  }, [instanced])
  // Each machine stands on the floor under its box.
  const instancedByModel = useMemo(
    () => instancedGroups.map(([url, group]) => [url, group.map((m): BatchItem => ({ id: m.id, position: [m.position[0], m.position[1] - m.height / 2, m.position[2]], getState: stateOf(m) }))] as const),
    [instancedGroups, stateOf],
  )
  const instancedIds = useMemo(() => new Set(instanced.map(m => m.id)), [instanced])

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

  const { floorSize, centerZ, spanX, spanZ, bounds } = (() => {
    if (machines.length === 0) return { floorSize: 40, centerZ: 0, spanX: 0, spanZ: 0, bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 } }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const m of machines) {
      minX = Math.min(minX, m.position[0])
      maxX = Math.max(maxX, m.position[0])
      minZ = Math.min(minZ, m.position[2])
      maxZ = Math.max(maxZ, m.position[2])
    }
    for (const op of [...operators, ...props]) {
      minX = Math.min(minX, op.position[0])
      maxX = Math.max(maxX, op.position[0])
      minZ = Math.min(minZ, op.position[2])
      maxZ = Math.max(maxZ, op.position[2])
    }
    const spanX = maxX - minX
    const spanZ = maxZ - minZ
    const size = Math.max(spanX, spanZ) + 12
    const cz = (minZ + maxZ) / 2
    return { floorSize: Math.max(size, 40), centerZ: cz, spanX, spanZ, bounds: { minX, maxX, minZ, maxZ } }
  })()

  const centerX = machines.length > 0
    ? (machines[machines.length - 1].position[0] + machines[0].position[0]) / 2
    : 0

  // Top view frames the line itself (the hall walls are cropped) so every
  // machine gets as many pixels as possible for its tag.
  const fit = useMemo(
    () => ({ cx: (bounds.minX + bounds.maxX) / 2, cz: centerZ, w: spanX + 12, d: spanZ + 12 }),
    [bounds, centerZ, spanX, spanZ],
  )

  const curMinutes = Math.round(((scrubUI / 100) * totalMsUI) / 60000)

  return (
    <div ref={rootRef} className="relative w-full h-full">
      <Canvas
        camera={{ position: [centerX + floorSize * 0.35, floorSize * 0.3, centerZ + floorSize * 0.35], fov: 42, far: Math.max(1000, floorSize * 4) }}
        shadows="percentage"
        gl={(renderer === 'webgpu' ? createWebGPURenderer : WEBGL_PROPS) as GLProps}
        onPointerMissed={() => setSelectedMachine(null)}
      >
        <ambientLight intensity={isDark ? 0.8 : 0.55} />
        {batching ? (
          <NearShadowLight intensity={isDark ? 1.5 : 1.4} maxRadius={floorSize / 2 + 10} />
        ) : (
          <directionalLight
            position={[centerX + 12, 25, centerZ + 12]}
            intensity={isDark ? 1.5 : 1.4}
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
        )}
        <hemisphereLight
          args={[isDark ? '#64748b' : '#e2e8f0', isDark ? '#334155' : '#f8fafc', isDark ? 0.8 : 0.4]}
        />
        <pointLight position={[centerX, 5, centerZ]} intensity={0.3} color="#f59e0b" distance={30} />

        {factory ? (
          <>
            <color attach="background" args={[isDark ? '#2a3441' : '#8791a0']} />
            <group name="cat:hall"><FactoryShell bounds={bounds} machines={machines} props={props} isDark={isDark} /></group>
          </>
        ) : (
          <>
            <Floor isDark={isDark} size={floorSize} centerX={centerX} centerZ={centerZ} />
            <WebGLOnly><Grid
              args={[floorSize, floorSize]}
              cellSize={1}
              cellThickness={0.4}
              cellColor={isDark ? '#4b5a70' : '#e2e8f0'}
              sectionSize={5}
              sectionThickness={0.8}
              sectionColor={isDark ? '#64748b' : '#cbd5e1'}
              fadeDistance={floorSize * 1.5}
              infiniteGrid
              position={[centerX, 0.01, centerZ]}
            /></WebGLOnly>
          </>
        )}

        <OrbitControls
          makeDefault
          enablePan
          enableZoom
          enableRotate
          minDistance={5}
          maxDistance={floorSize * 2}
          maxPolarAngle={Math.PI / 2.05}
          target={[centerX, 0, centerZ]}
          enableDamping
          dampingFactor={0.05}
        />
        <CameraRig focus={selectedMachine} topView={topView} fit={fit} />

        {import.meta.env.DEV && <PerfProbe />}
        {tags && <TagProjector anchors={tagAnchors} bus={tagBus} queues={queuesRef} selected={selectedMachine?.id ?? null} />}

        <group name="cat:machine-boxes">
        {machines.filter(m => !instancedIds.has(m.id)).map(m => (
          <MachineBox
            key={m.id}
            machine={m}
            selected={selectedMachine?.id === m.id}
            onClick={handleSelectMachine}
            getState={anim?.machine(m)}
          />
        ))}
        </group>

        <group name="cat:machine-pads">
          {instancedGroups.map(([url, group]) => (
            <Suspense key={url} fallback={null}>
              <InstancedMachines url={url} machines={group} selectedId={selectedMachine?.id ?? null} onSelect={handleSelectMachine} emphasis={emphasis} />
            </Suspense>
          ))}
        </group>
        <group name="cat:instanced">
          {instancedByModel.map(([url, group]) => (
            <Suspense key={url} fallback={null}>
              <InstancedStations url={url} items={group} emphasis={emphasis} />
            </Suspense>
          ))}
        </group>

        <group name="cat:operators">
        {batching ? <InstancedOperators operators={operators} stateOf={operatorState} /> : operators.map(op => {
          const machine = machineById.get(op.machineId)
          return (
            <OperatorDot
              key={op.id}
              operator={op}
              getState={machine && anim?.machine(machine)}
            />
          )
        })}
        </group>

        <group name="cat:props">
        {props.map(p => workerPlan && p.stationType === 'Worker' && p.label && workerPlan.segs.has(p.label) ? (
          <WorkerFigure
            key={p.id}
            id={p.id}
            route={router}
            slot={workerSlots.indexOf(p.id)}
            slots={workerSlots.length}
            home={p.position}
            segs={workerPlan.segs.get(p.label)!}
            spot={stationSpot}
            globalStart={workerPlan.globalStart}
            travel={workerPlan.travel}
            clock={simClockMsRef}
            anchor={tagAnchors.find(a => a.id === p.id)}
          />
        ) : (
          <group key={p.id}>
            <group position={p.position}>
              <Suspense fallback={null}>
                <StationModel
                  url={STATION_MODELS[p.stationType]}
                  getState={anim?.stations(p.stations)}
                  inPlace={p.stationType === 'Worker'}
                />
              </Suspense>
            </group>
          </group>
        ))}
        </group>

        <group name="cat:flow">
        {batching ? (
          <>
            <InstancedFlow connections={connections.filter(c => !c.dim)} />
            {connections.some(c => c.dim) && <InstancedFlow connections={connections.filter(c => c.dim)} faded />}
          </>
        ) : connections.map(c => (
          <FlowLine key={c.id} connection={c} />
        ))}
        </group>

        <Suspense fallback={null}>
          <group name="cat:jobs"><JobMarkers
            machines={machines}
            startPos={props.find(p => p.id === 'start')?.position}
            endPos={props.find(p => p.id === 'end')?.position}
            completionLog={completionLog}
            assemblies={assemblies}
            dismantles={dismantles}
            variantColors={variantColors}
            timelineRefs={timelineRefs}
            runMinutes={runMinutes}
          /></group>
        </Suspense>
      </Canvas>

      {tags && <TagOverlay anchors={tagAnchors} bus={tagBus} selected={selectedMachine?.id ?? null} />}

      <div className="absolute top-4 left-4 z-10 flex gap-2">
        <button
          onClick={() => {
            // Switching views closes any open machine panel, so the camera
            // doesn't have to serve both at once.
            setSelectedMachine(null)
            setTopView(v => !v)
          }}
          className={`text-xs px-3 py-1.5 rounded-lg border shadow-sm font-medium transition-colors ${topView ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white/95 text-gray-600 hover:bg-gray-50'}`}
        >
          {topView ? 'Perspective' : 'Top view'}
        </button>

        <button
          onClick={toggleTags}
          className={`text-xs px-3 py-1.5 rounded-lg border shadow-sm font-medium transition-colors ${tags ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white/95 text-gray-600 hover:bg-gray-50'}`}
          title="Show or hide the station and flow labels"
        >
          Tags
        </button>

        <button
          onClick={toggleFactory}
          className={`text-xs px-3 py-1.5 rounded-lg border shadow-sm font-medium transition-colors ${factory ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white/95 text-gray-600 hover:bg-gray-50'}`}
          title="Show the factory hall around the line"
        >
          {factory ? 'Factory' : 'Plain floor'}
        </button>
      </div>

      <button
        onClick={toggleFull}
        className={`absolute top-4 z-20 grid h-8 w-8 place-items-center rounded-lg border border-gray-200 bg-white/95 text-gray-600 shadow-sm hover:bg-gray-50 ${selectedMachine ? 'right-[22rem]' : 'right-4'}`}
        title={full ? 'Exit full screen' : 'Full screen'}
      >
        {full ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
      </button>

      <div className={`absolute top-4 z-20 w-56 ${selectedMachine ? 'right-[24.5rem]' : 'right-14'}`}>
        <input
          value={query}
          onChange={e => { setQuery(e.target.value); setSearchOpen(true); setActive(0) }}
          onFocus={() => setSearchOpen(true)}
          onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
          onKeyDown={e => {
            if (e.key === 'ArrowDown' && matches.length) { e.preventDefault(); setActive(i => (i + 1) % matches.length) }
            if (e.key === 'ArrowUp' && matches.length) { e.preventDefault(); setActive(i => (i - 1 + matches.length) % matches.length) }
            if (e.key === 'Enter' && matches[active]) pickMachine(matches[active])
            if (e.key === 'Escape') { setQuery(''); setSearchOpen(false) }
          }}
          placeholder="Search machines…"
          className="w-full text-xs px-3 py-1.5 rounded-lg border border-gray-200 bg-white/95 text-gray-700 shadow-sm outline-none focus:border-blue-500"
        />
        {searchOpen && query.trim() && (
          <ul className="mt-1 rounded-lg border border-gray-200 bg-white/95 shadow-md overflow-hidden text-xs">
            {matches.length === 0 && <li className="px-3 py-1.5 text-gray-400">No machines found</li>}
            {matches.map((m, i) => (
              <li key={m.id}>
                <button
                  onMouseDown={() => pickMachine(m)}
                  className={`w-full text-left px-3 py-1.5 text-gray-700 hover:bg-blue-50 ${i === active ? 'bg-blue-50' : ''}`}
                >
                  {m.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {completionLog && (
        <div className="absolute bottom-[5.75rem] right-[max(14px,calc(50%-450px))] z-10 flex max-w-[calc(100%-28px)] flex-wrap items-center gap-x-4 gap-y-1 rounded-full border border-gray-200 bg-white/95 px-4 py-1.5 text-xs text-gray-600 shadow-sm backdrop-blur-sm">
          <div className="flex flex-wrap items-center gap-4 font-medium">
            <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-[#f5c518]" />Waiting <b ref={waitingEl} className="tabular-nums text-gray-900">0</b></span>
            <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-[#32c76a]" />Processing <b ref={processingEl} className="tabular-nums text-gray-900">0</b></span>
            <span className="flex items-center gap-1.5">Finished <b ref={doneEl} className="tabular-nums text-gray-900">0</b></span>
            {assemblies && Object.keys(assemblies).length > 0 && (
              <span className="flex items-center gap-1.5">Assembled <b ref={assembledEl} className="tabular-nums text-gray-900">0</b></span>
            )}
            {dismantles && Object.keys(dismantles).length > 0 && (
              <span className="flex items-center gap-1.5">Dismantled <b ref={dismantledEl} className="tabular-nums text-gray-900">0</b></span>
            )}
            {!!outcomes?.rejected && (
              <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-[#F04438]" />Rejected <b ref={rejectedEl} className="tabular-nums text-gray-900">0</b></span>
            )}
            {!!outcomes?.scrapped && (
              <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-[#F04438]" />Scrapped <b ref={scrappedEl} className="tabular-nums text-gray-900">0</b></span>
            )}
          </div>
          {variantColors && Object.keys(variantColors).length > 1 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-l border-gray-200 pl-4 text-[10px] text-gray-600">
              {Object.entries(variantColors).map(([name, hex]) => (
                <span key={name} className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm" style={{ background: hex }} />{name}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* No job moved in this run (e.g. too short for any to finish): no timeline to play, but
          the bar stays, greyed out, with this run's figures and Sim setting — as in Build. */}
      {completionLog && zeroMsUI <= 0 && (
        <div className="absolute bottom-4 left-1/2 z-10 w-[min(900px,calc(100%-28px))] -translate-x-1/2">
          <IdleReplayBar
            runStartMs={runStartMs}
            runMin={runMinutes}
            settings={null}
          />
        </div>
      )}
      {completionLog && zeroMsUI > 0 && (
        <div className="absolute bottom-4 left-1/2 z-10 w-[min(900px,calc(100%-28px))] -translate-x-1/2">
          <ReplayBar
            playing={playingUI}
            onRestart={() => {
              scrubPctRef.current = 0
              simClockMsRef.current = 0
              playingRef.current = false
              setPlayingUI(false)
              setScrubUI(0)
            }}
            onToggle={() => {
              // Play at the end starts over, as in the 2D bar.
              if (!playingRef.current && scrubPctRef.current >= 100) {
                scrubPctRef.current = 0
                simClockMsRef.current = 0
                setScrubUI(0)
              }
              playingRef.current = !playingRef.current
              setPlayingUI(playingRef.current)
            }}
            speedId={speedId}
            onSpeed={setSpeedId}
            pct={scrubUI}
            onScrub={pct => {
              playingRef.current = false
              setPlayingUI(false)
              scrubPctRef.current = pct
              simClockMsRef.current = (pct / 100) * totalMsRef.current
              setScrubUI(pct)
            }}
            clock={fmtReplayClock(zeroMsUI, curMinutes)}
            elapsedMin={curMinutes}
            startMs={zeroMsUI}
            runMin={runMinutes ?? totalMsUI / 60000}
          />
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

    </div>
  )
}
