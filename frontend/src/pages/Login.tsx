import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import { Cpu, AlertCircle } from 'lucide-react'
import { authApi } from '@/api/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const from = (location.state as { from?: string })?.from ?? '/'

  // Tester build: sign in automatically and skip this screen. In development
  // the server answers 404, so the form below shows as usual.
  const [checkingAuto, setCheckingAuto] = useState(true)
  useEffect(() => {
    authApi.auto()
      .then(() => navigate(from, { replace: true }))
      .catch(() => setCheckingAuto(false))
  }, [])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await authApi.login(username, password)
      navigate(from, { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  if (checkingAuto) return null

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-white via-blue-50/30 to-indigo-50/40 p-6">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-sm mb-3">
            <Cpu className="h-6 w-6 text-white" />
          </div>
          <h1 className="text-xl font-bold text-gray-900">LinkSim</h1>
          <p className="text-sm text-gray-400 mt-0.5">Manufacturing DES</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-4">
          <div>
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="mt-1.5"
              autoComplete="username"
            />
          </div>
          <div>
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1.5"
              autoComplete="current-password"
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          <Button type="submit" disabled={loading || !username || !password} className="w-full bg-blue-600 hover:bg-blue-700">
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>

          <p className="text-sm text-center text-gray-500">
            Don't have an account?{' '}
            <Link to="/signup" className="text-blue-600 hover:underline font-medium">
              Sign up
            </Link>
          </p>
        </form>
      </div>
    </div>
  )
}
