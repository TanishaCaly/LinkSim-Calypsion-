import { useEffect } from 'react'
import { X } from 'lucide-react'

// A side drawer for details that should not take over the page: a station's
// numbers, or the table behind a chart.
export function Drawer({ open, onClose, title, eyebrow, children }: {
  open: boolean
  onClose: () => void
  title: string
  eyebrow?: string
  children: React.ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="no-print fixed inset-0 z-[60]">
      <div className="absolute inset-0 bg-[rgba(14,23,38,0.18)]" onClick={onClose} />
      <aside className="absolute bottom-0 right-0 top-0 flex w-[min(520px,92vw)] flex-col bg-ls-card shadow-lg">
        <div className="flex items-start justify-between gap-3 border-b border-ls-line px-6 py-5">
          <div className="min-w-0">
            {eyebrow && <p className="text-[11px] font-bold uppercase tracking-wide text-ls-mute">{eyebrow}</p>}
            <h2 className="truncate font-display text-lg font-bold text-ls-ink">{title}</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-ls-page text-ls-ink2 hover:bg-ls-chip"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto px-6 py-5">{children}</div>
      </aside>
    </div>
  )
}

export interface DataTableProps {
  title: string
  columns: string[]
  rows: string[][]
}

export function DataTable({ columns, rows }: DataTableProps) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-ls-mute">
          {columns.map((c, i) => (
            <th key={c} className={i === 0 ? 'py-2 pr-3' : 'px-3 py-2 text-right'}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, ri) => (
          <tr key={ri} className="border-t border-ls-line">
            {r.map((cell, i) => (
              <td key={i} className={i === 0 ? 'py-2.5 pr-3 font-semibold text-ls-ink' : 'px-3 py-2.5 text-right font-mono text-[12.5px] text-ls-ink2'}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
