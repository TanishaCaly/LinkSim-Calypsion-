import api, { setToken, clearToken } from './client'

export interface LoginResponse {
  token: string
  username: string
  user_id: number
}

export const authApi = {
  login: (username: string, password: string) =>
    api.post<LoginResponse>('/auth/login', { username, password }).then((r) => {
      setToken(r.data.token)
      return r.data
    }),

  signup: (username: string, password: string) =>
    api.post<LoginResponse>('/auth/signup', { username, password }).then((r) => {
      setToken(r.data.token)
      return r.data
    }),

  // Tester build only (the server answers 404 in development): sign in
  // without the login screen.
  auto: () =>
    api.post<LoginResponse>('/auth/auto').then((r) => {
      setToken(r.data.token)
      return r.data
    }),

  logout: () =>
    api.post('/auth/logout').finally(() => clearToken()),
}
