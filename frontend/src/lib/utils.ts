import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDate(iso: string) {
  return new Date(iso).toLocaleString()
}

export function priorityColor(priority: string) {
  switch (priority) {
    case 'high': return 'text-red-600 bg-red-50'
    case 'medium': return 'text-amber-600 bg-amber-50'
    default: return 'text-blue-600 bg-blue-50'
  }
}
