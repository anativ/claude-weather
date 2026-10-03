// Animated ASCII scenes for Tomorrow.io weather codes.
// https://docs.tomorrow.io/reference/data-layers-weather-codes

export type Kind =
  | 'sun'
  | 'mostlyClear'
  | 'partly'
  | 'mostlyCloudy'
  | 'cloudy'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'heavyRain'
  | 'snow'
  | 'heavySnow'
  | 'sleet'
  | 'freezing'
  | 'thunder'
  | 'unknown'

export type Seg = { text: string; color?: string; bold?: boolean }

const CODES: Record<number, [Kind, string]> = {
  1000: ['sun', 'Clear, Sunny'],
  1100: ['mostlyClear', 'Mostly Clear'],
  1101: ['partly', 'Partly Cloudy'],
  1102: ['mostlyCloudy', 'Mostly Cloudy'],
  1001: ['cloudy', 'Cloudy'],
  2000: ['fog', 'Fog'],
  2100: ['fog', 'Light Fog'],
  4000: ['drizzle', 'Drizzle'],
  4001: ['rain', 'Rain'],
  4200: ['drizzle', 'Light Rain'],
  4201: ['heavyRain', 'Heavy Rain'],
  5000: ['snow', 'Snow'],
  5001: ['snow', 'Flurries'],
  5100: ['snow', 'Light Snow'],
  5101: ['heavySnow', 'Heavy Snow'],
  6000: ['freezing', 'Freezing Drizzle'],
  6001: ['freezing', 'Freezing Rain'],
  6200: ['freezing', 'Light Freezing Rain'],
  6201: ['freezing', 'Heavy Freezing Rain'],
  7000: ['sleet', 'Ice Pellets'],
  7101: ['sleet', 'Heavy Ice Pellets'],
  7102: ['sleet', 'Light Ice Pellets'],
  8000: ['thunder', 'Thunderstorm'],
}

const ICONS: Record<Kind, string> = {
  sun: '☀️',
  mostlyClear: '🌤️',
  partly: '⛅',
  mostlyCloudy: '🌥️',
  cloudy: '☁️',
  fog: '🌫️',
  drizzle: '🌦️',
  rain: '🌧️',
  heavyRain: '🌧️',
  snow: '🌨️',
  heavySnow: '❄️',
  sleet: '🌨️',
  freezing: '🧊',
  thunder: '⛈️',
  unknown: '❔',
}

export function describe(code: number): { kind: Kind; label: string; icon: string } {
  const [kind, label] = CODES[code] ?? ['unknown', 'Unknown']
  return { kind, label, icon: ICONS[kind] }
}

export function tempColor(celsius: number): string {
  if (celsius < 0) return '#87d7ff'
  if (celsius < 10) return '#5fafff'
  if (celsius < 20) return '#87d787'
  if (celsius < 28) return '#ffd75f'
  return '#ff875f'
}

export const WIDTH = 28
export const HEIGHT = 9

const YELLOW = '#ffd700'
const ORANGE = '#ffaf00'
const WHITE = '#e4e4e4'
const GRAY = '#9e9e9e'
const DARK = '#6c6c6c'

const SUN = [
  [
    '   \\   |   /   ',
    '     .---.     ',
    ' -- (     ) -- ',
    "     `---'     ",
    '   /   |   \\   ',
  ],
  [
    "    \\  '  /    ",
    " '   .---.   ' ",
    '--- (     ) ---',
    " .   `---'   . ",
    '    /  .  \\    ',
  ],
]

const CLOUD = [
  '     .--.    ',
  '  .-(    ).  ',
  ' (___.__)__) ',
]

const BIG_CLOUD = [
  '        .--.       ',
  '     .-(    ).--.  ',
  '  .-(            ).',
  ' (_____.___.______)',
]

const BOLT = ['  /', ' /_', '  /', " '"]

type Cell = { ch: string; color?: string; bold?: boolean }
type Grid = Cell[][]

function blank(): Grid {
  return Array.from({ length: HEIGHT }, () =>
    Array.from({ length: WIDTH }, () => ({ ch: ' ' })),
  )
}

// Paints a sprite; inside each line's first..last glyph spaces are opaque,
// so a cloud hides the sun behind it.
function paint(g: Grid, lines: string[], x: number, y: number, color: string, bold = false) {
  lines.forEach((line, dy) => {
    const row = g[y + dy]
    if (!row) return
    const first = line.search(/\S/)
    if (first < 0) return
    const last = line.length - 1 - line.split('').reverse().join('').search(/\S/)
    for (let i = first; i <= last; i++) {
      const cell = row[x + i]
      if (cell) row[x + i] = { ch: line.charAt(i), color, bold }
    }
  })
}

function put(g: Grid, x: number, y: number, ch: string, color: string) {
  const row = g[y]
  if (row?.[x]?.ch === ' ') row[x] = { ch, color }
}

function hash(a: number, b: number): number {
  let h = Math.imul(a, 374761393) + Math.imul(b, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return (h ^ (h >>> 16)) >>> 0
}

// 0,1,2,3,2,1,0,... stepping every `every` frames.
function drift(frame: number, every = 4, span = 3): number {
  const t = Math.floor(frame / every) % (span * 2)
  return t <= span ? t : span * 2 - t
}

type Fall = {
  density: number
  chars: [string, string][] // [char, color] picked by hash
  slant: boolean
  slow: number // frames per row
}

const FALLS: Partial<Record<Kind, Fall>> = {
  drizzle: { density: 9, chars: [['.', '#87afd7'], ["'", '#87afd7']], slant: false, slow: 1 },
  rain: { density: 5, chars: [["'", '#5fafff'], ['/', '#5fafff']], slant: true, slow: 1 },
  heavyRain: { density: 3, chars: [['/', '#5f87ff'], ['/', '#5fafff']], slant: true, slow: 1 },
  thunder: { density: 4, chars: [['/', '#5f87ff'], ["'", '#5fafff']], slant: true, slow: 1 },
  freezing: { density: 5, chars: [["'", '#87ffff'], ['/', '#afffff']], slant: true, slow: 1 },
  snow: { density: 7, chars: [['*', '#ffffff'], ['.', WHITE]], slant: false, slow: 2 },
  heavySnow: { density: 4, chars: [['*', '#ffffff'], ['*', WHITE]], slant: false, slow: 2 },
  sleet: { density: 5, chars: [['*', '#ffffff'], ["'", '#87ffff']], slant: false, slow: 1 },
}

function fall(g: Grid, spec: Fall, frame: number, top: number) {
  const step = Math.floor(frame / spec.slow)
  for (let r = top; r < HEIGHT; r++) {
    for (let c = 1; c < WIDTH - 1; c++) {
      // Snow sways a column left and right as it falls.
      const sway = spec.slow > 1 ? (Math.floor((r - step) / 2) & 1) : 0
      const key = spec.slant ? c + r : c + sway
      const h = hash(key, r - step)
      if (h % spec.density !== 0) continue
      const [ch, color] = spec.chars[(h >>> 8) % spec.chars.length]!
      put(g, c, r, ch, color)
    }
  }
}

function fog(g: Grid, frame: number, top: number) {
  const pattern = '_ - _ -- _ - __ - _ '
  for (let r = top; r < HEIGHT; r++) {
    const shift = Math.floor(frame / 2) * (r % 2 ? 1 : -1)
    for (let c = 0; c < WIDTH; c++) {
      const i = (((c + shift + r * 3) % pattern.length) + pattern.length) % pattern.length
      const ch = pattern.charAt(i)
      if (ch !== ' ') put(g, c, r, ch, r % 2 ? GRAY : DARK)
    }
  }
}

export function scene(kind: Kind, frame: number): Seg[][] {
  const g = blank()
  const sun = SUN[Math.floor(frame / 3) % 2]!
  const sunColor = Math.floor(frame / 3) % 2 ? ORANGE : YELLOW
  const d = drift(frame)

  switch (kind) {
    case 'sun':
      paint(g, sun, 6, 2, sunColor, true)
      break
    case 'mostlyClear':
      paint(g, sun, 3, 1, sunColor, true)
      paint(g, CLOUD, 12 + d, 5, WHITE)
      break
    case 'partly':
      paint(g, sun, 2, 0, sunColor, true)
      paint(g, BIG_CLOUD, 7 + d, 4, WHITE)
      break
    case 'mostlyCloudy':
      paint(g, sun, 1, 0, ORANGE)
      paint(g, BIG_CLOUD, 4 + d, 2, GRAY)
      paint(g, CLOUD, 13 - d, 5, WHITE)
      break
    case 'cloudy':
      paint(g, CLOUD, 1 + d, 0, GRAY)
      paint(g, BIG_CLOUD, 7 - d, 2, WHITE)
      paint(g, CLOUD, 2 + d, 6, DARK)
      break
    case 'fog':
      paint(g, CLOUD, 6 + d, 0, GRAY)
      fog(g, frame, 3)
      break
    case 'unknown':
      paint(g, BIG_CLOUD, 4 + d, 2, GRAY)
      paint(g, ['?'], 13 + d, 4, YELLOW, true)
      break
    case 'thunder': {
      const flash = [0, 1, 3].includes(frame % 10)
      paint(g, BIG_CLOUD, 4 + d, 0, flash ? '#ffffff' : DARK, flash)
      if (flash) paint(g, BOLT, 11 + d, 4, YELLOW, true)
      fall(g, FALLS.thunder!, frame, 4)
      break
    }
    default: {
      const dark = kind === 'heavyRain' || kind === 'heavySnow'
      paint(g, BIG_CLOUD, 4 + d, 0, dark ? GRAY : WHITE)
      fall(g, FALLS[kind]!, frame, 4)
    }
  }

  return g.map(row => {
    const segs: Seg[] = []
    for (const cell of row) {
      const last = segs[segs.length - 1]
      if (last && last.color === cell.color && last.bold === cell.bold) last.text += cell.ch
      else segs.push({ text: cell.ch, color: cell.color, bold: cell.bold })
    }
    return segs
  })
}
