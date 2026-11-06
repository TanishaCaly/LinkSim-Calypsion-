import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-ls-accent-soft text-ls-accent-ink',
        secondary: 'border-transparent bg-ls-chip text-ls-ink2',
        destructive: 'border-transparent bg-ls-bad-t text-ls-bad-i',
        outline: 'border-ls-line2 text-ls-ink2',
        success: 'border-transparent bg-ls-ok-t text-ls-ok-i',
        warning: 'border-transparent bg-ls-warn-t text-ls-warn-i',
      },
    },
    defaultVariants: { variant: 'default' },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
