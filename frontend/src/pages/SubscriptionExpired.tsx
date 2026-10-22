import { Cpu, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { clearToken } from '@/api/client'

export default function SubscriptionExpired() {
  function handleBackToLogin() {
    clearToken()
    window.location.href = '/login'
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-white via-blue-50/30 to-indigo-50/40 p-6">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-sm mb-3">
            <Cpu className="h-6 w-6 text-white" />
          </div>
          <h1 className="text-xl font-bold text-gray-900">LinkSim</h1>
          <p className="text-sm text-gray-400 mt-0.5">Manufacturing DES</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-4 text-center">
          <div className="flex items-center justify-center gap-2 text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
            <Lock className="h-4 w-4 shrink-0" />
            <span className="text-sm font-medium">Subscription expired</span>
          </div>
          <p className="text-sm text-gray-500">
            Your access to LinkSim has expired. Please contact your administrator to renew your subscription.
          </p>
          <Button onClick={handleBackToLogin} className="w-full bg-blue-600 hover:bg-blue-700">
            Back to login
          </Button>
        </div>
      </div>
    </div>
  )
}
