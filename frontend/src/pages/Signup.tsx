import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { authApi } from '@/api/auth'
import { licenseQuery } from '@/api/license'
import AuthShell from '@/components/auth/AuthShell'

const MIN_PASSWORD = 8

export default function Signup() {
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [show, setShow] = useState(false)

  // Web version: a new account has no license yet, so go straight to entering the key.
  const { data: license } = useQuery(licenseQuery())

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (password.length < MIN_PASSWORD) {
      setError(`Password must be at least ${MIN_PASSWORD} characters`)
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }
    setLoading(true)
    try {
      await authApi.signup(username, password, email.trim())
      navigate(license?.mode === 'user' ? '/license' : '/canvas', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signup failed')
    } finally {
      setLoading(false)
    }
  }

  const ready = username && password && confirmPassword

  return (
    <AuthShell eyebrow="Get started" title="Create your account" sub="Build and run your first line in minutes.">
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="username">Username</label>
          <input id="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" placeholder="Choose a username" />
        </div>
        <div className="field">
          <label htmlFor="email">Email <span style={{ fontWeight: 400, color: 'var(--mute)' }}>(optional)</span></label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@company.com" />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder={`At least ${MIN_PASSWORD} characters`} />
          <button type="button" className="show" onClick={() => setShow((v) => !v)}>{show ? 'Hide' : 'Show'}</button>
        </div>
        <div className="field">
          <label htmlFor="confirmPassword">Confirm password</label>
          <input id="confirmPassword" type={show ? 'text' : 'password'} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" placeholder="Repeat your password" />
        </div>

        {error && <div className="err">{error}</div>}

        <button type="submit" disabled={loading || !ready} className="go">
          {loading ? 'Creating account…' : 'Create account'} <span aria-hidden="true">→</span>
        </button>

        <p className="alt">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </AuthShell>
  )
}
