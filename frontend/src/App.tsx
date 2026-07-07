import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Layout from '@/components/layout/Layout'
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
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
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
