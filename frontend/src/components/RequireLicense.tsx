import { useQuery } from '@tanstack/react-query'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { isLicensed, licenseQuery } from '@/api/license'

// Desktop build: nothing past here (login included) until this PC has a valid
// license. Web: sign in first (login/signup pass through), then nothing past
// here until the account has a valid license. In development licensing is
// off and this passes straight through.
export default function RequireLicense() {
  const location = useLocation()
  const { data, isError } = useQuery(licenseQuery())
  if (isError) return <Navigate to="/license" replace />
  if (!data) return null
  if (data.mode === 'user' && !data.signed_in) return <Outlet />
  if (!isLicensed(data)) {
    return <Navigate to="/license" replace state={{ from: location.pathname }} />
  }
  return <Outlet />
}
