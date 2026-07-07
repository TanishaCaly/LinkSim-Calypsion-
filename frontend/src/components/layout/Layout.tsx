import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { LayoutDashboard, FolderOpen, GitBranch, Lightbulb, Cpu, ChevronLeft, ChevronRight, Sun, Moon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store/useAppStore'

const nav = [
  { to: '/', icon: FolderOpen, label: 'Scenarios' },
  { to: '/run', icon: LayoutDashboard, label: 'Run & Results' },
  { to: '/canvas', icon: GitBranch, label: 'Visual Canvas' },
  { to: '/insights', icon: Lightbulb, label: 'AI Insights' },
]

export default function Layout() {
  const { toast, clearToast, theme, toggleTheme } = useAppStore()
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <aside
        className={cn(
          'no-print relative bg-white border-r border-gray-100 flex flex-col shadow-sm transition-all duration-300',
          collapsed ? 'w-16' : 'w-64'
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
          className="absolute -right-3 top-20 w-6 h-6 rounded-full bg-white border border-gray-200 shadow-sm flex items-center justify-center hover:bg-gray-50 transition-colors z-10"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed
            ? <ChevronRight className="h-3 w-3 text-gray-500" />
            : <ChevronLeft className="h-3 w-3 text-gray-500" />
          }
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
                  'relative flex items-center gap-3 py-3 rounded-xl text-sm font-medium transition-all duration-150',
                  collapsed ? 'justify-center px-0' : 'px-4',
                  isActive
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-gray-500 hover:bg-gray-50 hover:text-gray-800'
                )
              }
              title={collapsed ? label : undefined}
            >
              {({ isActive }) => (
                <>
                  {isActive && !collapsed && (
                    <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-blue-600" />
                  )}
                  <Icon className={cn('h-4 w-4 shrink-0', isActive ? 'text-blue-600' : 'text-gray-400')} />
                  {!collapsed && label}
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
