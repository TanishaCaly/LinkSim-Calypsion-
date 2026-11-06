import { useEffect } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { BarChart3, FolderOpen, GitBranch, Sparkles, Cpu, Sun, Moon, LogOut } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store/useAppStore'
import { authApi } from '@/api/auth'

const nav = [
  { to: '/canvas', icon: GitBranch, label: 'Workspace' },
  { to: '/run', icon: BarChart3, label: 'Analysis' },
  { to: '/', icon: FolderOpen, label: 'Scenarios' },
  { to: '/interfaces', icon: Sparkles, label: 'Interfaces & AI' },
]

const TOAST_MS = 3000

export default function Layout() {
  const { toast, clearToast, theme, toggleTheme, activeScenario } = useAppStore()
  const navigate = useNavigate()

  // Notifications close by themselves after 3 s. Each new one (a fresh
  // object, even with the same text) restarts the 3 s.
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(clearToast, TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast, clearToast])

  async function handleLogout() {
    await authApi.logout().catch(() => {})
    navigate('/login', { replace: true })
  }

  const iconButton =
    'flex h-9 w-9 items-center justify-center rounded-full bg-ls-page text-ls-ink2 transition-colors hover:bg-ls-chip'

  return (
    <div className="flex h-screen flex-col bg-ls-page text-ls-ink">
      {/* Top bar */}
      <header
        className="no-print relative z-10 flex h-[60px] shrink-0 items-center gap-5 bg-ls-card px-5"
        style={{ boxShadow: '0 1px 0 var(--ls-line2), 0 4px 14px -8px rgba(16,24,40,0.10)' }}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-ls-dark">
            <Cpu className="h-[18px] w-[18px] text-ls-card" />
          </div>
          <div className="leading-none">
            <span className="font-display text-lg font-bold tracking-tight">LinkSim</span>
            <p className="mt-0.5 text-[10.5px] text-ls-mute max-[1060px]:hidden">Manufacturing DES</p>
          </div>
        </div>

        {/* The scenario that is open (opened from Scenarios, or built in Workspace) */}
        <div className="hidden min-w-0 items-center border-l border-ls-line pl-5 font-display text-[15px] font-semibold md:flex">
          <span className={cn('truncate', !activeScenario && 'font-normal text-ls-mute')}>
            {activeScenario?.name ?? 'No scenario open'}
          </span>
        </div>

        <nav className="ml-auto flex items-center gap-2">
          {nav.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              title={label}
              className={({ isActive }) =>
                cn(
                  'flex h-[38px] items-center gap-2 whitespace-nowrap rounded-full px-4 text-[13.5px] font-semibold transition-colors max-[1060px]:px-3',
                  isActive
                    ? 'bg-ls-dark text-ls-card shadow-md'
                    : 'bg-ls-card text-ls-ink2 hover:bg-ls-soft'
                )
              }
            >
              <Icon className="h-[15px] w-[15px] shrink-0" />
              <span className="max-[1060px]:hidden">{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <button
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className={iconButton}
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <button onClick={handleLogout} title="Log out" className={cn(iconButton, 'hover:bg-ls-bad-t hover:text-ls-bad-i')}>
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* Main */}
      <main className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </main>

      {/* Toast */}
      {toast && (
        <div
          onClick={clearToast}
          className={cn(
            'fixed left-1/2 top-[76px] z-50 max-w-sm -translate-x-1/2 cursor-pointer rounded-xl px-4 py-2.5 text-[13px] shadow-lg',
            toast.type === 'error' ? 'bg-red-600 text-white' : 'bg-ls-dark text-ls-card'
          )}
        >
          {toast.message}
        </div>
      )}
    </div>
  )
}
