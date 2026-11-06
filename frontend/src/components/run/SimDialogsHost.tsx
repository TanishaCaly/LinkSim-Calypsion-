import { useEffect, useState } from 'react'
import { SimConfigDialog, SimTimerDialog } from '@/components/run/SimDialogs'
import { useRunSimulation } from '@/hooks/useRunSimulation'

// The Sim config and Simulation Timer dialogs for the Workspace. Nothing is drawn until one opens: the
// Sim setting buttons (in the replay bar, or the top bar when there is no run to replay) ask for one by
// event, so the dialogs live in a single place.
export default function SimDialogsHost({ sim }: { sim: ReturnType<typeof useRunSimulation> }) {
  const { displayRun, simCfg, setSimCfg, persistSimConfig, progress, isRunning, start } = sim
  const [configOpen, setConfigOpen] = useState(false)
  const [timerOpen, setTimerOpen] = useState(false)
  useEffect(() => {
    const on = (e: Event) => ((e as CustomEvent<string>).detail === 'timer' ? setTimerOpen(true) : setConfigOpen(true))
    window.addEventListener('linksim:sim-dialog', on)
    return () => window.removeEventListener('linksim:sim-dialog', on)
  }, [])
  return (
    <>
      <SimConfigDialog open={configOpen} value={simCfg} onChange={persistSimConfig} onClose={() => setConfigOpen(false)} />
      <SimTimerDialog
        open={timerOpen}
        value={simCfg}
        onChange={setSimCfg}
        onClose={() => setTimerOpen(false)}
        progress={progress}
        onRun={(cfg) => start(cfg)}
        isRunning={isRunning}
        completionLog={displayRun?.result?.completion_log as Record<string, unknown[]> | undefined}
      />
    </>
  )
}
