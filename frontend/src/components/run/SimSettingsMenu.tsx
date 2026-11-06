import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Settings, Timer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// One "Sim setting" button; click it for the two simulation dialogs. Used by the Workspace run bar
// (menu opens upwards) and the Analysis header (opens downwards).
// The dialogs live in the Workspace run bar; anywhere else (the 3D replay bar) just asks it to open one.
export const openSimDialog = (which: 'config' | 'timer') => window.dispatchEvent(new CustomEvent('linksim:sim-dialog', { detail: which }))

export default function SimSettingsMenu({ onConfig, onTimer, up, small, compact, pill }: {
  onConfig: () => void
  onTimer: () => void
  up?: boolean
  small?: boolean
  // a small trigger in the same style as the 3D replay bar's buttons
  compact?: boolean
  // a round button in the Workspace top bar, next to Run
  pill?: boolean
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [open])

  const pick = (fn: () => void) => () => { setOpen(false); fn() }
  const item = 'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium text-ls-ink hover:bg-ls-chip'

  return (
    <div ref={box} className="relative">
      {compact ? (
        <button
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          className="flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
        >
          <Settings className="h-3.5 w-3.5" />
          Sim setting
          <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
        </button>
      ) : (
        <Button
          variant="outline"
          size={small ? 'sm' : undefined}
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          className={pill ? 'rounded-full px-4' : small ? undefined : 'h-10 rounded-xl'}
        >
          <Settings className={small || pill ? 'mr-1.5 h-4 w-4' : 'h-4 w-4'} />
          Sim setting
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', small ? 'ml-1.5' : 'ml-0.5', open && 'rotate-180')} />
        </Button>
      )}
      {open && (
        <div
          role="menu"
          className={cn('absolute right-0 z-50 w-52 rounded-xl border border-ls-line2 bg-ls-card p-1.5 shadow-lg', up ? 'bottom-full mb-2' : 'top-full mt-2')}
        >
          <button role="menuitem" onClick={pick(onConfig)} className={item}>
            <Settings className="h-4 w-4 text-ls-mute" />
            Sim config
          </button>
          <button role="menuitem" onClick={pick(onTimer)} className={item}>
            <Timer className="h-4 w-4 text-ls-mute" />
            Simulation Timer
          </button>
        </div>
      )}
    </div>
  )
}
