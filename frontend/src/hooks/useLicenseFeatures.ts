import { useQuery } from '@tanstack/react-query'
import { licenseQuery } from '@/api/license'

// Feature codes on the LINKSIM product (licensing backoffice). The backend
// enforces the same codes; this only hides what the license doesn't include.
export const FEATURE = {
  simRun: 'sim.run',
  importFiles: 'import.excel',
  insightsAi: 'insights.ai',
  view3d: 'view.3d',
  limitStations: 'limit.stations',
  limitScenarios: 'limit.scenarios',
} as const

export function useLicenseFeatures() {
  const { data } = useQuery(licenseQuery())
  const features = (data?.enabled && data.license?.features) || {}
  return {
    // A feature the license doesn't mention (or licensing off) is not restricted.
    allows: (code: string) => features[code] === undefined || !!features[code],
    // null = unlimited
    limit: (code: string) => (typeof features[code] === 'number' ? (features[code] as number) : null),
  }
}
