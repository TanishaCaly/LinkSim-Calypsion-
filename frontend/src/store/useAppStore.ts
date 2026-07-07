import { create } from 'zustand'
import type { Scenario, RunDetail } from '../types'

interface AppStore {
  // Selected scenario
  activeScenario: Scenario | null
  setActiveScenario: (s: Scenario | null) => void

  // Latest run for the active scenario
  activeRun: RunDetail | null
  setActiveRun: (r: RunDetail | null) => void

  // Polling interval ID
  pollingId: ReturnType<typeof setInterval> | null
  setPollingId: (id: ReturnType<typeof setInterval> | null) => void

  // Toast
  toast: { message: string; type: 'success' | 'error' } | null
  showToast: (message: string, type?: 'success' | 'error') => void
  clearToast: () => void

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

export const useAppStore = create<AppStore>((set) => ({
  activeScenario: null,
  setActiveScenario: (s) => set({ activeScenario: s }),

  activeRun: null,
  setActiveRun: (r) => set({ activeRun: r }),

  pollingId: null,
  setPollingId: (id) => set({ pollingId: id }),

  toast: null,
  showToast: (message, type = 'success') => set({ toast: { message, type } }),
  clearToast: () => set({ toast: null }),

  theme: initialTheme,
  toggleTheme: () => set((s) => {
    const next = s.theme === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    return { theme: next }
  }),
  setTheme: (t) => { applyTheme(t); set({ theme: t }) },
}))
