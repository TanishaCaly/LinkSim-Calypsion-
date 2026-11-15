import { useEffect } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { BarChart3, FolderOpen, GitBranch, Sparkles, Sun, Moon, LogOut, Check, AlertCircle, KeyRound, WifiOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store/useAppStore'
import { authApi } from '@/api/auth'
import { licenseApi } from '@/api/license'

const nav = [
  { to: '/canvas', icon: GitBranch, label: 'Workspace' },
  { to: '/run', icon: BarChart3, label: 'Analysis' },
  { to: '/', icon: FolderOpen, label: 'Scenarios' },
  { to: '/interfaces', icon: Sparkles, label: 'Interfaces & AI' },
]

const TOAST_MS = 3000

export default function Layout() {
  const { toast, clearToast, theme, toggleTheme, activeScenario, leaveGuard } = useAppStore()
  const navigate = useNavigate()
  const location = useLocation()
  const { data: license } = useQuery({ queryKey: ['license'], queryFn: licenseApi.status, staleTime: 60_000 })

  // Notifications close by themselves after 3 s. Each new one (a fresh
  // object, even with the same text) restarts the 3 s.
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(clearToast, TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast, clearToast])

  async function logout() {
    await authApi.logout().catch(() => {})
    navigate('/login', { replace: true })
  }
  // Leaving the Workspace saves it first (see leaveGuard).
  function handleLogout() {
    if (leaveGuard) leaveGuard(() => { void logout() })
    else void logout()
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
          <img src="/linksim-mark.png" alt="" className="h-9 w-9 object-contain" />
          <div className="leading-none">
            <span className="font-display text-lg font-bold tracking-tight">LinkSim<sup className="relative -top-[2px] ml-0.5 text-[14px] font-semibold opacity-80">™</sup></span>
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
              onClick={(e) => {
                if (!leaveGuard || location.pathname === to) return
                e.preventDefault()
                leaveGuard(() => navigate(to))
              }}
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
          {/* Desktop build: this PC's license (details, deactivate) */}
          {license?.enabled && (
            <button
              onClick={() => (leaveGuard ? leaveGuard(() => navigate('/license')) : navigate('/license'))}
              title={license.state === 'offline' ? 'License server unreachable — working offline' : 'License'}
              className={cn(iconButton, license.state === 'offline' && 'text-amber-600')}
            >
              {license.state === 'offline' ? <WifiOff className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
            </button>
          )}
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
          key={toast.message + (toast.detail ?? '')}
          onClick={clearToast}
          className="toast fixed bottom-6 right-6 z-50 flex w-max max-w-sm cursor-pointer items-center gap-3 overflow-hidden rounded-[14px] border border-ls-line bg-ls-card py-3 pl-3 pr-5 text-[13px] text-ls-ink shadow-[0_10px_28px_rgba(16,24,40,.14)]"
        >
          <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full', toast.type === 'error' ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-600')}>
            {toast.type === 'error' ? <AlertCircle className="h-4 w-4" /> : <Check className="h-4 w-4" />}
          </span>
          <div className="min-w-0">
            <b className="block font-semibold leading-tight">{toast.message}</b>
            {toast.detail && <small className="mt-0.5 block truncate text-xs leading-tight text-ls-ink2">{toast.detail}</small>}
          </div>
          <i className={cn('toast-bar absolute bottom-0 left-0 h-[3px] w-full', toast.type === 'error' ? 'bg-red-500' : 'bg-ls-accent')} style={{ animationDuration: `${TOAST_MS}ms` }} />
        </div>
      )}
    </div>
  )
}
