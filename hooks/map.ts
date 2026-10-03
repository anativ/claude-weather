// World weather maps: Tomorrow.io tiles at zoom 1 (2x2 tiles of 256 px)
// over a land mask, cropped to the rows the mask covers, and drawn either
// as pixels (an Image) or as half-block cells (a Raster).

import { toBase64 } from './base64'
import type { Decoded } from './png'
import { MASK_HEIGHT, MASK_SIZE, MASK_Y0, landMask } from './landmask'

// Tomorrow.io's map layers that answer without a key. `isOpaque` layers cover
// every pixel, so the sea is dimmed to show the continents; the others are
// blended over land and sea. `legend` runs from `low` to `high`, sampled
// from the tiles' own palettes.
export const LAYERS = [
  { field: 'temperature', tab: 'temp', hotkey: '2', title: 'Temperature', isOpaque: true, low: 'cold', high: 'hot', legend: ['#3c64c8', '#3cc8c8', '#50c850', '#f0d040', '#e05030'] },
  { field: 'precipitationIntensity', tab: 'precip', hotkey: '3', title: 'Precipitation', isOpaque: false, low: 'light', high: 'heavy', legend: ['#9fe0e0', '#40c000', '#f0e000', '#f08000', '#e02020'] },
  { field: 'windSpeed', tab: 'wind', hotkey: '4', title: 'Wind speed', isOpaque: true, low: 'calm', high: 'strong', legend: ['#f0f0b0', '#a0d0a0', '#6080e0', '#4030a0', '#c040c0'] },
  { field: 'windGust', tab: 'gusts', hotkey: '5', title: 'Wind gusts', isOpaque: true, low: 'calm', high: 'strong', legend: ['#f0f0c0', '#b0d8a8', '#7090e0', '#4838a8', '#c048c8'] },
  { field: 'cloudCover', tab: 'clouds', hotkey: '6', title: 'Cloud cover', isOpaque: false, low: 'clear', high: 'overcast', legend: ['#101010', '#3060a0', '#80b0e0', '#d0e0f0', '#ffffff'] },
  { field: 'humidity', tab: 'humidity', hotkey: '7', title: 'Humidity', isOpaque: true, low: 'dry', high: 'humid', legend: ['#fff0c0', '#e0a060', '#a05080', '#702878', '#401860'] },
  { field: 'pressureSeaLevel', tab: 'pressure', hotkey: '8', title: 'Sea-level pressure', isOpaque: true, low: 'low', high: 'high', legend: ['#e0f0ff', '#80c060', '#c0d020', '#f0c000', '#f08000'] },
  { field: 'uvIndex', tab: 'uv', hotkey: '9', title: 'UV index', isOpaque: false, low: 'low', high: 'extreme', legend: ['#0060ff', '#00c000', '#f0f000', '#f04000', '#e000e0'] },
  { field: 'visibility', tab: 'visibility', hotkey: 'v', title: 'Visibility', isOpaque: false, low: 'poor', high: 'fair', legend: ['#c02030', '#e06040', '#f0a080', '#f0d0c0'] },
  { field: 'dewPoint', tab: 'dew', hotkey: 'd', title: 'Dew point', isOpaque: true, low: 'low', high: 'high', legend: ['#3050c0', '#40b0c0', '#60d0a0', '#e0d060', '#f0a030'] },
  { field: 'temperatureApparent', tab: 'feels', hotkey: 'f', title: 'Feels like', isOpaque: true, low: 'cold', high: 'hot', legend: ['#3c64c8', '#3cc8c8', '#50c850', '#f0d040', '#e05030'] },
] as const

export type Layer = (typeof LAYERS)[number]
export type Field = Layer['field']

export function layerOf(field: Field): Layer {
  return LAYERS.find(l => l.field === field)!
}

// What `/weather <word>` and `/weather map <word>` accept for each layer.
export function findLayer(word: string): Layer | undefined {
  const w = word.toLowerCase()
  const aliases: Record<string, Field> = {
    map: 'temperature',
    temperature: 'temperature',
    rain: 'precipitationIntensity',
    precipitation: 'precipitationIntensity',
    gust: 'windGust',
    cloud: 'cloudCover',
    cloudcover: 'cloudCover',
    feelslike: 'temperatureApparent',
    dewpoint: 'dewPoint',
  }
  return LAYERS.find(l => l.tab === w || l.field.toLowerCase() === w || l.field === aliases[w])
}

export const MAP_WIDTH = MASK_SIZE
export const MAP_HEIGHT = MASK_HEIGHT
export const ZOOM = 1
export const TILES: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
]

const WATER: Rgb = [16, 24, 34]
const LAND: Rgb = [52, 52, 56]

type Rgb = [number, number, number]

let mask: Uint8Array | undefined
let edges: Uint8Array | undefined

// Land pixels with water beside them: the coastline.
function coast(): { land: Uint8Array; coast: Uint8Array } {
  if (!mask || !edges) {
    const land = landMask()
    const e = new Uint8Array(land.length)
    for (let y = 0; y < MAP_HEIGHT; y++) {
      for (let x = 0; x < MAP_WIDTH; x++) {
        const i = y * MAP_WIDTH + x
        if (!land[i]) continue
        const left = x > 0 ? land[i - 1] : 1
        const right = x < MAP_WIDTH - 1 ? land[i + 1] : 1
        const up = y > 0 ? land[i - MAP_WIDTH] : 1
        const down = y < MAP_HEIGHT - 1 ? land[i + MAP_WIDTH] : 1
        e[i] = left && right && up && down ? 0 : 1
      }
    }
    mask = land
    edges = e
  }
  return { land: mask, coast: edges }
}

// A city's pixel on the map, when its query is "lat,lon".
export function cityPixel(query: string): [number, number] | undefined {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(query)
  if (!m) return undefined
  const lat = Number(m[1])
  const lon = Number(m[2])
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180)
  const x = Math.floor(((lon + 180) / 360) * MAP_WIDTH)
  const y = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * MAP_WIDTH) - MASK_Y0
  return x >= 0 && x < MAP_WIDTH && y >= 0 && y < MAP_HEIGHT ? [x, y] : undefined
}

// Lays the field's tiles over the land mask, coastlines drawn over both.
export function compose(field: Field, tiles: ReadonlyMap<string, Decoded>): Uint8Array {
  const { land, coast: edge } = coast()
  const layer = layerOf(field)
  const out = new Uint8Array(MAP_WIDTH * MAP_HEIGHT * 4)
  for (let y = 0; y < MAP_HEIGHT; y++) {
    const gy = y + MASK_Y0
    for (let x = 0; x < MAP_WIDTH; x++) {
      const i = y * MAP_WIDTH + x
      const isLand = land[i] === 1
      const tile = tiles.get(`${x >> 8},${gy >> 8}`)
      let [r, g, b] = isLand ? LAND : WATER
      if (tile) {
        const t = (((gy & 255) * tile.width) + (x & 255)) * 4
        const a = tile.rgba[t + 3]! / 255
        const k = layer.isOpaque && !isLand ? 0.6 : 1
        r = r * (1 - a) + tile.rgba[t]! * a * k
        g = g * (1 - a) + tile.rgba[t + 1]! * a * k
        b = b * (1 - a) + tile.rgba[t + 2]! * a * k
      }
      if (edge[i]) {
        const [er, eg, eb, ea] = layer.isOpaque ? [0, 0, 0, 0.55] : [150, 150, 160, 0.7]
        r = r * (1 - ea) + er * ea
        g = g * (1 - ea) + eg * ea
        b = b * (1 - ea) + eb * ea
      }
      out[i * 4] = r
      out[i * 4 + 1] = g
      out[i * 4 + 2] = b
      out[i * 4 + 3] = 255
    }
  }
  return out
}

// A copy with each city as a white square in a dark ring.
export function withMarkers(rgba: Uint8Array, markers: [number, number][]): Uint8Array {
  const out = rgba.slice()
  for (const [mx, my] of markers) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = mx + dx
        const y = my + dy
        if (x < 0 || y < 0 || x >= MAP_WIDTH || y >= MAP_HEIGHT) continue
        const ring = Math.max(Math.abs(dx), Math.abs(dy)) === 2
        const v = ring ? 0 : 255
        out.set([v, v, v, 255], (y * MAP_WIDTH + x) * 4)
      }
    }
  }
  return out
}

function average(rgba: Uint8Array, x0: number, x1: number, y0: number, y1: number): number {
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * MAP_WIDTH + x) * 4
      r += rgba[i]!
      g += rgba[i + 1]!
      b += rgba[i + 2]!
      n++
    }
  }
  if (!n) return 0
  return (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n)
}

const UPPER_HALF = 0x2580
const DOT = 0x25cf

// Half-block cells: each cell is two map pixels tall, the upper one its
// foreground and the lower its background. Cities are dots.
export function toCells(rgba: Uint8Array, columns: number, rows: number, cities: [number, number][]): string {
  const words = new Uint32Array(columns * rows * 3)
  const sx = MAP_WIDTH / columns
  const sy = MAP_HEIGHT / (rows * 2)
  const span = (a: number, s: number, max: number) => [Math.floor(a * s), Math.max(Math.floor(a * s) + 1, Math.min(max, Math.floor((a + 1) * s)))] as const
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const [x0, x1] = span(col, sx, MAP_WIDTH)
      const [t0, t1] = span(row * 2, sy, MAP_HEIGHT)
      const [b0, b1] = span(row * 2 + 1, sy, MAP_HEIGHT)
      const i = (row * columns + col) * 3
      words[i] = UPPER_HALF
      words[i + 1] = average(rgba, x0, x1, t0, t1)
      words[i + 2] = average(rgba, x0, x1, b0, b1)
    }
  }
  for (const [x, y] of cities) {
    const col = Math.min(columns - 1, Math.floor(x / sx))
    const row = Math.min(rows - 1, Math.floor(y / sy / 2))
    const i = (row * columns + col) * 3
    words[i + 2] = words[y / sy / 2 - row < 0.5 ? i + 1 : i + 2]!
    words[i] = DOT
    words[i + 1] = 0xffffff
  }
  return toBase64(new Uint8Array(words.buffer))
}
