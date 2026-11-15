import api, { getToken } from './client'

export interface LicenseStatus {
  enabled: boolean
  // machine = desktop (the PC's license, before login); user = web (each
  // account's own license, after login)
  mode: 'off' | 'machine' | 'user'
  signed_in: boolean
  state: 'unlicensed' | 'valid' | 'offline' | 'invalid'
  reason: string
  message: string
  key: string | null
  offline_until: number | null
  air_gapped: boolean
  license: {
    customer: string | null
    edition: string | null
    term_type: string | null
    expires_at: number | null
    features: Record<string, boolean | number>
  } | null
}

export const isLicensed = (s: LicenseStatus) => !s.enabled || s.state === 'valid' || s.state === 'offline'

// On the web the license belongs to the signed-in user, so the cache is per session.
export const licenseQueryKey = () => ['license', getToken()]
export const licenseQuery = () => ({ queryKey: licenseQueryKey(), queryFn: licenseApi.status, staleTime: 60_000 })

export const licenseApi = {
  status: () => api.get<LicenseStatus>('/license/status').then((r) => r.data),
  activate: (key: string) => api.post<LicenseStatus>('/license/activate', { key }).then((r) => r.data),
  refresh: () => api.post<LicenseStatus>('/license/refresh').then((r) => r.data),
  deactivate: () => api.post<LicenseStatus>('/license/deactivate').then((r) => r.data),
  // Air-gapped PCs
  offlineRequest: (key: string) =>
    api.post<{ request: string }>('/license/offline-request', { key }).then((r) => r.data.request),
  importLicenseFile: (licenseFile: string) =>
    api.post<LicenseStatus>('/license/offline-license', { license_file: licenseFile }).then((r) => r.data),
}
