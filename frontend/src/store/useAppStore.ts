import { create } from 'zustand'
import type { Scenario, RunDetail } from '../types'

interface AppStore {
  // Selected scenario
  activeScenario: Scenario | null
  setActiveScenario: (s: Scenario | null) => void

  // Latest run for the active scenario
  activeRun: RunDetail | null
  setActiveRun: (r: RunDetail | null) => void

  // Set by the Run Dashboard's Reset button; tells Canvas's View Flow to show
  // a blank Build canvas instead of the real scenario's stations, until the
  // user actually triggers a fresh run (which clears it again).
  justReset: boolean
  setJustReset: (v: boolean) => void

  // Polling interval ID
  pollingId: ReturnType<typeof setInterval> | null
  setPollingId: (id: ReturnType<typeof setInterval> | null) => void

  // Toast
  toast: { message: string; type: 'success' | 'error'; detail?: string } | null
  showToast: (message: string, type?: 'success' | 'error', detail?: string) => void
  clearToast: () => void

  // Set by the Workspace while it is open: called before leaving it (a top
  // tab or Log out). It saves the canvas, then calls go(); on a problem it
  // shows the error and does not call go(), so the user stays.
  leaveGuard: ((go: () => void) => void) | null
  setLeaveGuard: (g: ((go: () => void) => void) | null) => void

  // Theme
  theme: 'light' | 'dark'
  toggleTheme: () => void
  setTheme: (t: 'light' | 'dark') => void
}

// Read persisted theme (default light) and apply the `dark` class to <html>
const initialTheme: 'light' | 'dark' =
  (typeof localStorage !== 'undefined' && localStorage.getItem('theme') === 'dark') ? 'dark' : 'light'

function applyTheme(t: 'light' | 'dark') {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark', t === 'dark')
  try { localStorage.setItem('theme', t) } catch { /* ignore */ }
}
applyTheme(initialTheme)

// Paper is white: print in the light theme, then put the dark one back.
if (typeof window !== 'undefined') {
  let wasDark = false
  window.addEventListener('beforeprint', () => { wasDark = document.documentElement.classList.contains('dark'); document.documentElement.classList.remove('dark') })
  window.addEventListener('afterprint', () => { if (wasDark) document.documentElement.classList.add('dark') })
}

export const useAppStore = create<AppStore>((set) => ({
  activeScenario: null,
  setActiveScenario: (s) => set({ activeScenario: s }),

  activeRun: null,
  setActiveRun: (r) => set({ activeRun: r }),

  justReset: false,
  setJustReset: (v) => set({ justReset: v }),

  pollingId: null,
  setPollingId: (id) => set({ pollingId: id }),

  toast: null,
  showToast: (message, type = 'success', detail) => set({ toast: { message, type, detail } }),
  clearToast: () => set({ toast: null }),

  leaveGuard: null,
  setLeaveGuard: (g) => set({ leaveGuard: g }),

  theme: initialTheme,
  toggleTheme: () => set((s) => {
    const next = s.theme === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    return { theme: next }
  }),
  setTheme: (t) => { applyTheme(t); set({ theme: t }) },
}))
