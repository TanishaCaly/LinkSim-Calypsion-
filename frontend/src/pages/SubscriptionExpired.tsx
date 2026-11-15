import { Lock } from 'lucide-react'
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
          <img src="/linksim-mark.png" alt="" className="mb-3 h-14 w-14 object-contain" />
          <h1 className="text-xl font-bold text-gray-900">LinkSim<sup className="relative -top-[2px] ml-0.5 text-[14px] font-semibold opacity-80">™</sup></h1>
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
