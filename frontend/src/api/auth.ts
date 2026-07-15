import api, { setToken, clearToken } from './client'

export interface LoginResponse {
  token: string
  username: string
}

export const authApi = {
  login: (username: string, password: string) =>
    api.post<LoginResponse>('/auth/login', { username, password }).then((r) => {
      setToken(r.data.token)
      return r.data
    }),

  logout: () =>
    api.post('/auth/logout').finally(() => clearToken()),
}
