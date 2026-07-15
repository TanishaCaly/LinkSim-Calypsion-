import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Layout from '@/components/layout/Layout'
import RequireAuth from '@/components/RequireAuth'
import Login from '@/pages/Login'
import ScenarioManager from '@/pages/ScenarioManager'
import RunDashboard from '@/pages/RunDashboard'
import Canvas from '@/pages/Canvas'
import Insights from '@/pages/Insights'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 10_000 },
  },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="login" element={<Login />} />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route index element={<ScenarioManager />} />
            <Route path="run" element={<RunDashboard />} />
            <Route path="canvas" element={<Canvas />} />
            <Route path="insights" element={<Insights />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
