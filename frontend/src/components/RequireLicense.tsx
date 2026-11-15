import { useQuery } from '@tanstack/react-query'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { isLicensed, licenseApi } from '@/api/license'

// Desktop build: nothing past here (login included) until this PC has a valid
// license. In development licensing is off and this passes straight through.
export default function RequireLicense() {
  const location = useLocation()
  const { data, isError } = useQuery({ queryKey: ['license'], queryFn: licenseApi.status, staleTime: 60_000 })
  if (isError) return <Navigate to="/license" replace />
  if (!data) return null
  if (!isLicensed(data)) {
    return <Navigate to="/license" replace state={{ from: location.pathname }} />
  }
  return <Outlet />
}
