import { useCallback, useRef, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { LayoutDashboard, FolderOpen, GitBranch, Lightbulb, Cpu, ChevronLeft, ChevronRight, Sun, Moon, LogOut } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store/useAppStore'
import { authApi } from '@/api/auth'

const nav = [
  { to: '/', icon: FolderOpen, label: 'Scenarios' },
  { to: '/run', icon: LayoutDashboard, label: 'Run & Results' },
  { to: '/canvas', icon: GitBranch, label: 'Visual Canvas' },
  { to: '/insights', icon: Lightbulb, label: 'AI Insights' },
]

const DEFAULT_SIDEBAR_WIDTH = 256
const MIN_SIDEBAR_WIDTH = 200

export default function Layout() {
  const { toast, clearToast, theme, toggleTheme } = useAppStore()
  const [collapsed, setCollapsed] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH)
  const [resizing, setResizing] = useState(false)
  const asideRef = useRef<HTMLElement>(null)
  const navigate = useNavigate()

  async function handleLogout() {
    await authApi.logout().catch(() => {})
    navigate('/login', { replace: true })
  }

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setResizing(true)
    const startX = e.clientX
    const startWidth = asideRef.current?.getBoundingClientRect().width ?? sidebarWidth

    function onMouseMove(ev: MouseEvent) {
      const raw = startWidth + (ev.clientX - startX)
      if (raw <= 96) {
        setCollapsed(true)
        return
      }
      setCollapsed(false)
      setSidebarWidth(Math.min(420, Math.max(MIN_SIDEBAR_WIDTH, raw)))
    }
    function onMouseUp() {
      setResizing(false)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [sidebarWidth])

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <aside
        ref={asideRef}
        style={{ width: collapsed ? 64 : sidebarWidth }}
        className={cn(
          'no-print relative bg-white border-r border-gray-100 flex flex-col shadow-sm',
          !resizing && 'transition-all duration-300'
        )}
      >
        {/* Logo */}
        <div className="px-6 py-6 border-b border-gray-100">
          <div className={cn('flex items-center gap-3', collapsed && 'justify-center')}>
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-sm shrink-0">
              <Cpu className="h-5 w-5 text-white" />
            </div>
            {!collapsed && (
              <div>
                <span className="text-lg font-bold text-gray-900 leading-none">LinkSim</span>
                <p className="text-xs text-gray-400 mt-0.5 leading-none">Manufacturing DES</p>
              </div>
            )}
          </div>
        </div>

        {/* Collapse toggle — floats on the right edge, below the logo */}
        <button
          onClick={() => setCollapsed(c => !c)}
          className="group/toggle absolute -right-3 top-20 w-6 h-6 rounded-full bg-white border border-gray-200 shadow-sm flex items-center justify-center hover:bg-gray-50 transition-colors z-30"
        >
          {collapsed
            ? <ChevronRight className="h-3 w-3 text-gray-500" />
            : <ChevronLeft className="h-3 w-3 text-gray-500" />
          }
          <span className="pointer-events-none absolute left-full ml-2 whitespace-nowrap rounded-lg bg-white text-gray-700 text-xs font-medium px-3 py-2 shadow-lg border border-gray-100 opacity-0 scale-95 origin-left transition-all duration-150 group-hover/toggle:opacity-100 group-hover/toggle:scale-100 z-30">
            {collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          </span>
        </button>

        {/* Nav */}
        <nav className="flex-1 p-4 space-y-1">
          {nav.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                cn(
                  'group relative flex items-center gap-3 py-3 rounded-xl text-sm font-medium transition-all duration-150',
                  collapsed ? 'justify-center px-0' : 'px-4',
                  isActive
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-gray-500 hover:bg-gray-50 hover:text-gray-800'
                )
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && !collapsed && (
                    <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-blue-600" />
                  )}
                  <Icon className={cn('h-4 w-4 shrink-0', isActive ? 'text-blue-600' : 'text-gray-400')} />
                  {!collapsed && label}
                  {collapsed && (
                    <span className="pointer-events-none absolute left-full ml-3 whitespace-nowrap rounded-lg bg-white text-gray-700 text-xs font-medium px-3 py-2 shadow-lg border border-gray-100 opacity-0 scale-95 origin-left transition-all duration-150 group-hover:opacity-100 group-hover:scale-100 z-20">
                      {label}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Theme toggle */}
        <div className="px-4 pb-2">
          <button
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className={cn(
              'flex items-center gap-3 w-full py-3 rounded-xl text-sm font-medium transition-all duration-150 text-gray-500 hover:bg-gray-50 hover:text-gray-800',
              collapsed ? 'justify-center px-0' : 'px-4'
            )}
          >
            {theme === 'dark'
              ? <Sun className="h-4 w-4 shrink-0 text-amber-400" />
              : <Moon className="h-4 w-4 shrink-0 text-gray-400" />
            }
            {!collapsed && (theme === 'dark' ? 'Light mode' : 'Dark mode')}
          </button>
          <button
            onClick={handleLogout}
            title="Log out"
            className={cn(
              'flex items-center gap-3 w-full py-3 rounded-xl text-sm font-medium transition-all duration-150 text-gray-500 hover:bg-red-50 hover:text-red-600',
              collapsed ? 'justify-center px-0' : 'px-4'
            )}
          >
            <LogOut className="h-4 w-4 shrink-0" />
            {!collapsed && 'Log out'}
          </button>
        </div>

        {/* Footer */}
        {!collapsed && (
          <div className="p-4 border-t border-gray-100">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
              <p className="text-xs text-gray-400">v0.1.0 · Phase 2</p>
            </div>
          </div>
        )}

        {/* Resize handle — drag to set a custom width. Split around the collapse-toggle button (top-20 to ~104px) so it stays clickable. Available even when collapsed so it can be dragged back open. */}
        <div
          onMouseDown={startResize}
          draggable={false}
          className="absolute top-0 -right-1.5 w-3 cursor-col-resize z-20 select-none"
          style={{ height: 80 }}
        />
        <div
          onMouseDown={startResize}
          draggable={false}
          className="absolute -right-1.5 bottom-0 w-3 cursor-col-resize z-20 flex items-center justify-center group/handle select-none"
          style={{ top: 104 }}
        >
          <div
            className={cn(
              'w-1 h-10 rounded-full bg-gray-200 group-hover/handle:bg-blue-300 transition-colors',
              resizing && 'bg-blue-400'
            )}
          />
          <span className="pointer-events-none absolute left-full ml-2 whitespace-nowrap rounded-lg bg-white text-gray-700 text-xs font-medium px-3 py-2 shadow-lg border border-gray-100 opacity-0 scale-95 origin-left transition-all duration-150 group-hover/handle:opacity-100 group-hover/handle:scale-100 z-30">
            Drag to resize
          </span>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>

      {/* Toast */}
      {toast && (
        <div
          onClick={clearToast}
          className={cn(
            'fixed bottom-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg text-sm cursor-pointer max-w-sm',
            toast.type === 'error' ? 'bg-red-600 text-white' : 'bg-green-600 text-white'
          )}
        >
          {toast.message}
        </div>
      )}
    </div>
  )
}
