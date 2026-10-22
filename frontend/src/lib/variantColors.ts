// Each product (variant) has its own colour so its jobs can be told apart —
// picked in the Start's MU table; until then, these defaults in table order.
// All dark enough to read the white job number on.
export const VARIANT_COLORS = [
  '#3b82f6', // blue
  '#f97316', // orange
  '#22c55e', // green
  '#a855f7', // purple
  '#ef4444', // red
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#ca8a04', // dark yellow
  '#14b8a6', // teal
  '#6366f1', // indigo
  '#84cc16', // lime
  '#e11d48', // rose
]

/** The default colour of the product at `index` in the MU table. */
export function defaultVariantColor(index: number): string {
  return VARIANT_COLORS[index % VARIANT_COLORS.length]
}

/** A default colour no product uses yet (for a new row), else by position. */
export function unusedVariantColor(used: string[], index: number): string {
  const taken = new Set(used.map((c) => c.toLowerCase()))
  return VARIANT_COLORS.find((c) => !taken.has(c)) ?? defaultVariantColor(index)
}

/** The job-id prefix the engine gives a product's jobs ("tshirt_v2" -> "tshirtv2"). */
export function jobPrefix(variant: string): string {
  return variant.replace(/[^\p{L}\p{N}]/gu, '') || variant
}
