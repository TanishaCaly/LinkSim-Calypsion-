import { useState, type ChangeEvent, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { isLicensed, licenseApi, type LicenseStatus } from '@/api/license'
import AuthShell from '@/components/auth/AuthShell'

const fmtDate = (unix: number | null | undefined) =>
  unix ? new Date(unix * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null

// The activation page (desktop build): enter a license key, see this PC's
// license, or free its seat to move LinkSim to another PC.
export default function License() {
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const { data: status, error: loadError } = useQuery({ queryKey: ['license'], queryFn: licenseApi.status })

  const [key, setKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDeactivate, setConfirmDeactivate] = useState(false)
  const [offline, setOffline] = useState(false)
  const [request, setRequest] = useState<string | null>(null)

  const wanted = (location.state as { from?: string })?.from
  const keyValue = key ?? status?.key ?? ''

  async function run(action: () => Promise<LicenseStatus>) {
    setError(null)
    setBusy(true)
    try {
      const s = await action()
      queryClient.setQueryData(['license'], s)
      return s
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  function goToApp() {
    navigate(wanted && wanted !== '/license' ? wanted : '/login', { replace: true })
  }

  async function handleActivate(e: FormEvent) {
    e.preventDefault()
    const s = await run(() => licenseApi.activate(keyValue))
    if (s && isLicensed(s)) goToApp()
  }

  async function handleRequest() {
    setError(null)
    try {
      setRequest(await licenseApi.offlineRequest(keyValue))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    }
  }

  function downloadRequest() {
    if (!request) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([request], { type: 'text/plain' }))
    a.download = 'linksim-activation-request.txt'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  async function handleLicenseFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const text = await file.text()
    const s = await run(() => licenseApi.importLicenseFile(text))
    if (s && isLicensed(s)) goToApp()
  }

  if (loadError) {
    return (
      <AuthShell eyebrow="License" title="LinkSim license" sub="">
        <div className="err">Could not read the license status: {(loadError as Error).message}</div>
      </AuthShell>
    )
  }
  if (!status) return null

  if (!status.enabled) {
    return (
      <AuthShell eyebrow="License" title="Licensing is off" sub="This build does not check licenses (development).">
        <button className="go" onClick={goToApp}>Continue <span aria-hidden="true">→</span></button>
      </AuthShell>
    )
  }

  if (isLicensed(status)) {
    const lic = status.license
    return (
      <AuthShell eyebrow="License" title="LinkSim is activated" sub="This PC has a valid license.">
        {status.state === 'offline' && (
          <div className="note">
            The license server can't be reached right now. LinkSim keeps working offline
            {status.offline_until ? ` until ${fmtDate(status.offline_until)}` : ''} — connect to the internet before then.
          </div>
        )}
        <dl className="facts">
          <dt>Licensed to</dt><dd>{lic?.customer ?? '—'}</dd>
          <dt>Edition</dt><dd>{lic?.edition ?? '—'}</dd>
          <dt>Key</dt><dd>{status.key}</dd>
          <dt>Valid until</dt><dd>{fmtDate(lic?.expires_at) ?? 'No end date'}</dd>
        </dl>
        {error && <div className="err">{error}</div>}
        <button className="go" onClick={goToApp}>Continue to LinkSim <span aria-hidden="true">→</span></button>
        {status.air_gapped ? null : !confirmDeactivate ? (
          <button className="ghost" onClick={() => setConfirmDeactivate(true)}>Deactivate this PC</button>
        ) : (
          <>
            <p className="offhelp" style={{ marginTop: 18 }}>
              This frees the license so it can be used on another PC. LinkSim will ask for a key again here. Your scenarios are kept.
            </p>
            <button className="ghost danger" disabled={busy} onClick={() => run(licenseApi.deactivate)}>
              {busy ? 'Deactivating…' : 'Yes, deactivate this PC'}
            </button>
            <button className="ghost" disabled={busy} onClick={() => setConfirmDeactivate(false)}>Cancel</button>
          </>
        )}
      </AuthShell>
    )
  }

  return (
    <AuthShell eyebrow="Activate" title="Enter your license key" sub="LinkSim needs a license for this PC.">
      <form onSubmit={handleActivate}>
        {status.state === 'invalid' && <div className="err">{status.message}</div>}
        <div className="field">
          <label htmlFor="key">License key</label>
          <input
            id="key"
            autoFocus
            value={keyValue}
            onChange={(e) => setKey(e.target.value)}
            placeholder="LNK-XXXX-XXXX-XXXX"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {error && <div className="err">{error}</div>}

        <button type="submit" disabled={busy || !keyValue.trim()} className="go">
          {busy ? 'Activating…' : 'Activate'} <span aria-hidden="true">→</span>
        </button>
        {status.state === 'invalid' && status.key && (
          <button type="button" className="ghost" disabled={busy} onClick={() => run(licenseApi.refresh)}>
            Retry
          </button>
        )}

        <p className="alt">
          {offline ? (
            <button type="button" className="linkbtn" onClick={() => setOffline(false)}>Hide offline activation</button>
          ) : (
            <>No internet on this PC? <button type="button" className="linkbtn" onClick={() => setOffline(true)}>Activate offline</button></>
          )}
        </p>
      </form>

      {offline && (
        <div style={{ marginTop: 18 }}>
          <p className="offhelp">
            1. Enter your key above, then create an activation request and send it to Calypsion support.
          </p>
          <button type="button" className="ghost" disabled={!keyValue.trim()} onClick={handleRequest}>
            Create activation request
          </button>
          {request && (
            <div className="field" style={{ marginTop: 12 }}>
              <textarea readOnly value={request} onFocus={(e) => e.target.select()} />
              <button type="button" className="ghost" onClick={downloadRequest}>Save as file</button>
            </div>
          )}
          <p className="offhelp" style={{ marginTop: 18 }}>2. Open the license file (.lic) you get back.</p>
          <label className="ghost" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', margin: 0 }}>
            Open license file…
            <input type="file" accept=".lic,.json,.txt" onChange={handleLicenseFile} style={{ display: 'none' }} />
          </label>
        </div>
      )}
    </AuthShell>
  )
}
