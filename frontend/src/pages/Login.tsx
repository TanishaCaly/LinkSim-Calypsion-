import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import { authApi } from '@/api/auth'
import AuthShell from '@/components/auth/AuthShell'

export default function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [show, setShow] = useState(false)

  // Land on the Workspace unless the user was heading to a specific page
  const wanted = (location.state as { from?: string })?.from
  const from = wanted && wanted !== '/' ? wanted : '/canvas'

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
    <AuthShell eyebrow="Welcome back" title="Sign in to LinkSim">
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="username">Username</label>
          <input id="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" placeholder="Enter your username" />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" placeholder="Enter your password" />
          <button type="button" className="show" onClick={() => setShow((v) => !v)}>{show ? 'Hide' : 'Show'}</button>
        </div>

        {error && <div className="err">{error}</div>}

        <button type="submit" disabled={loading || !username || !password} className="go">
          {loading ? 'Signing in…' : 'Sign in'} <span aria-hidden="true">→</span>
        </button>

        <p className="alt">
          Don't have an account? <Link to="/signup">Sign up</Link>
        </p>
      </form>
    </AuthShell>
  )
}
