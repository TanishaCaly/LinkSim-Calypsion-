import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
})

/** FastAPI errors come back as a string, an array of validation errors, or a nested object.
 *  Flatten any of those into a readable message. */
function formatDetail(detail: unknown): string {
  if (detail == null) return 'Unknown error'
  if (typeof detail === 'string') return detail
  // 422 validation errors: [{ loc: [...], msg: '...', type: '...' }, ...]
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        if (d && typeof d === 'object' && 'msg' in d) {
          const loc = Array.isArray((d as any).loc)
            ? (d as any).loc.filter((p: unknown) => p !== 'body').join('.')
            : ''
          return loc ? `${loc}: ${(d as any).msg}` : String((d as any).msg)
        }
        return typeof d === 'string' ? d : JSON.stringify(d)
      })
      .join('; ')
  }
  if (typeof detail === 'object') {
    const obj = detail as Record<string, unknown>
    if (typeof obj.msg === 'string') return obj.msg
    return JSON.stringify(detail)
  }
  return String(detail)
}

api.interceptors.response.use(
  (r) => r,
  (err) => {
    const msg = err.response?.data?.detail
      ? formatDetail(err.response.data.detail)
      : (err.message ?? 'Unknown error')
    return Promise.reject(new Error(msg))
  }
)

export default api
