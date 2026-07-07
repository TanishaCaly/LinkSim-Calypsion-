import * as THREE from 'three'

interface LabelOptions {
  text: string
  subtext?: string
  badge?: { text: string; color: string }
  fontSize?: number
  backgroundColor?: string
  padding?: number
  maxWidth?: number
  shadow?: boolean
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

export function makeLabelTexture(options: LabelOptions): THREE.CanvasTexture {
  const {
    text,
    subtext,
    badge,
    fontSize = 14,
    backgroundColor = 'rgba(255,255,255,0.95)',
    padding = 12,
    maxWidth = 260,
    shadow = false,
  } = options

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!

  const dpr = Math.min(window.devicePixelRatio || 1, 3) * 3
  const font = `bold ${fontSize}px system-ui, -apple-system, sans-serif`
  const subFont = `${fontSize - 3}px system-ui, -apple-system, sans-serif`
  const badgeFont = `bold ${fontSize - 3}px system-ui, -apple-system, sans-serif`

  ctx.font = font
  const textWidth = Math.min(ctx.measureText(text).width, maxWidth)

  let badgeWidth = 0
  let badgeHeight = 0
  if (badge) {
    ctx.font = badgeFont
    badgeWidth = ctx.measureText(badge.text).width + 14
    badgeHeight = fontSize + 6
  }

  const totalWidth = padding * 2 + textWidth + (badge ? badgeWidth + 10 : 0)
  const lineSpacing = subtext ? fontSize + 6 : 0
  const totalHeight = padding * 2 + fontSize + lineSpacing

  const shadowOffset = shadow ? 6 : 0
  const canvasWidth = totalWidth + shadowOffset
  const canvasHeight = totalHeight + shadowOffset

  canvas.width = Math.ceil(canvasWidth * dpr)
  canvas.height = Math.ceil(canvasHeight * dpr)
  canvas.style.width = `${canvasWidth}px`
  canvas.style.height = `${canvasHeight}px`
  ctx.scale(dpr, dpr)

  // Drop shadow
  if (shadow) {
    roundRect(ctx, 3, 3, totalWidth, totalHeight, 8)
    ctx.fillStyle = 'rgba(0,0,0,0.12)'
    ctx.fill()
  }

  // Background
  roundRect(ctx, 0, 0, totalWidth, totalHeight, 8)
  ctx.fillStyle = backgroundColor
  ctx.fill()

  // Border
  roundRect(ctx, 0, 0, totalWidth, totalHeight, 8)
  ctx.strokeStyle = 'rgba(0,0,0,0.06)'
  ctx.lineWidth = 1
  ctx.stroke()

  // Text
  ctx.font = font
  ctx.fillStyle = '#0f172a'
  ctx.textBaseline = 'top'
  ctx.fillText(text, padding, padding)

  // Badge
  if (badge) {
    const badgeX = padding + textWidth + 10
    const badgeY = padding
    roundRect(ctx, badgeX, badgeY, badgeWidth, badgeHeight, 5)
    ctx.fillStyle = badge.color
    ctx.fill()
    ctx.font = badgeFont
    ctx.fillStyle = '#fff'
    ctx.textBaseline = 'top'
    ctx.fillText(badge.text, badgeX + 7, badgeY + 3)
  }

  // Subtext
  if (subtext) {
    ctx.font = subFont
    ctx.fillStyle = '#64748b'
    ctx.textBaseline = 'top'
    ctx.fillText(subtext, padding, padding + fontSize + 6)
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  return texture
}

export function makeOperatorTooltipTexture(options: {
  name: string
  skill: number
  availability: number
}): THREE.CanvasTexture {
  const { name, skill, availability } = options
  const fontSize = 12
  const padding = 10

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const dpr = Math.min(window.devicePixelRatio || 1, 3) * 3

  const lines = [
    { text: name, bold: true },
    { text: `Skill: ${'★'.repeat(skill)}${'☆'.repeat(5 - skill)}`, bold: false },
    { text: `Avail: ${availability}%`, bold: false },
  ]

  const font = `bold ${fontSize}px system-ui, -apple-system, sans-serif`
  const subFont = `${fontSize - 1}px system-ui, -apple-system, sans-serif`

  ctx.font = font
  const maxTextWidth = Math.max(...lines.map((l) => {
    ctx.font = l.bold ? font : subFont
    return ctx.measureText(l.text).width
  }))

  const totalWidth = padding * 2 + maxTextWidth
  const totalHeight = padding * 2 + (fontSize + 4) * lines.length + 4
  const shadowOffset = 4

  canvas.width = Math.ceil((totalWidth + shadowOffset) * dpr)
  canvas.height = Math.ceil((totalHeight + shadowOffset) * dpr)
  canvas.style.width = `${totalWidth + shadowOffset}px`
  canvas.style.height = `${totalHeight + shadowOffset}px`
  ctx.scale(dpr, dpr)

  // Shadow
  roundRect(ctx, 2, 2, totalWidth, totalHeight, 6)
  ctx.fillStyle = 'rgba(0,0,0,0.2)'
  ctx.fill()

  // Background
  roundRect(ctx, 0, 0, totalWidth, totalHeight, 6)
  ctx.fillStyle = 'rgba(15,23,42,0.95)'
  ctx.fill()

  // Border
  roundRect(ctx, 0, 0, totalWidth, totalHeight, 6)
  ctx.strokeStyle = 'rgba(255,255,255,0.1)'
  ctx.lineWidth = 0.5
  ctx.stroke()

  let y = padding
  lines.forEach((line) => {
    ctx.font = line.bold ? font : subFont
    ctx.fillStyle = line.bold ? '#f8fafc' : '#cbd5e1'
    ctx.textBaseline = 'top'
    ctx.fillText(line.text, padding, y)
    y += fontSize + 4
  })

  const texture = new THREE.CanvasTexture(canvas)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  return texture
}
