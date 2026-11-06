import { Cpu, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { clearToken } from '@/api/client'

export default function SubscriptionExpired() {
  function handleBackToLogin() {
    clearToken()
    window.location.href = '/login'
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-ls-page p-6">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-[14px] bg-ls-dark flex items-center justify-center shadow-md mb-3">
            <Cpu className="h-6 w-6 text-ls-card" />
          </div>
          <h1 className="text-xl font-bold text-gray-900">LinkSim</h1>
          <p className="text-sm text-gray-400 mt-0.5">Manufacturing DES</p>
        </div>

        <div className="bg-ls-card rounded-2xl shadow-md p-6 space-y-4 text-center">
          <div className="flex items-center justify-center gap-2 text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
            <Lock className="h-4 w-4 shrink-0" />
            <span className="text-sm font-medium">Subscription expired</span>
          </div>
          <p className="text-sm text-gray-500">
            Your access to LinkSim has expired. Please contact your administrator to renew your subscription.
          </p>
          <Button onClick={handleBackToLogin} className="w-full">
            Back to login
          </Button>
        </div>
      </div>
    </div>
  )
}
