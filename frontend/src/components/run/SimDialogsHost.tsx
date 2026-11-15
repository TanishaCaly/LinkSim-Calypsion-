import { useEffect, useState } from 'react'
import { SimConfigDialog, SimTimerDialog } from '@/components/run/SimDialogs'
import { useRunSimulation } from '@/hooks/useRunSimulation'
import { useAppStore } from '@/store/useAppStore'
import type { SimConfigOverride } from '@/api/simulations'

// The Sim config and Simulation Timer dialogs for the Workspace. Nothing is drawn until one opens: the
// Sim setting buttons (in the replay bar, always shown in the Workspace) ask for one by
// event, so the dialogs live in a single place.
// onRun: Save & Run in the Simulation Timer (the Workspace saves a new or changed scenario first).
export default function SimDialogsHost({ sim, onRun }: { sim: ReturnType<typeof useRunSimulation>; onRun?: (cfg: SimConfigOverride) => void }) {
  const { displayRun, simCfg, setSimCfg, persistSimConfig, progress, isRunning, start } = sim
  // No scenario open: the dialogs show a new scenario's calendar (every day, no breaks).
  const fresh = !useAppStore((s) => s.activeScenario)
  const [configOpen, setConfigOpen] = useState(false)
  const [timerOpen, setTimerOpen] = useState(false)
  useEffect(() => {
    const on = (e: Event) => ((e as CustomEvent<string>).detail === 'timer' ? setTimerOpen(true) : setConfigOpen(true))
    window.addEventListener('linksim:sim-dialog', on)
    return () => window.removeEventListener('linksim:sim-dialog', on)
  }, [])
  return (
    <>
      <SimConfigDialog open={configOpen} value={simCfg} fresh={fresh} onChange={persistSimConfig} onClose={() => setConfigOpen(false)} />
      <SimTimerDialog
        open={timerOpen}
        value={simCfg}
        fresh={fresh}
        onChange={setSimCfg}
        onClose={() => setTimerOpen(false)}
        progress={progress}
        onRun={(cfg) => (onRun ? onRun(cfg) : start(cfg))}
        isRunning={isRunning}
        completionLog={displayRun?.result?.completion_log as Record<string, unknown[]> | undefined}
      />
    </>
  )
}
