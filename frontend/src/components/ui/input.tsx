import * as React from 'react'
import { cn } from '@/lib/utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        'flex h-9 w-full rounded-[10px] border border-ls-line2 bg-ls-soft px-3 py-1 text-sm text-ls-ink transition-colors file:border-0 file:bg-ls-accent-soft file:text-ls-accent-ink file:text-sm file:font-medium file:px-3 file:py-1 file:mr-3 file:rounded file:cursor-pointer placeholder:text-ls-mute focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ls-accent disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      ref={ref}
      {...props}
    />
  )
)
Input.displayName = 'Input'

export { Input }
