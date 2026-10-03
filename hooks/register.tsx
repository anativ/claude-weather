import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { City, CityWeather, Snapshot, View } from '../types'
import { HEIGHT, WIDTH, describe, scene, tempColor } from './art'
import { LAYERS, MAP_HEIGHT, MAP_WIDTH, TILES, ZOOM, blend, cityPixel, compose, findLayer, layerOf, toCells, withMarkers } from './map'
import type { Field } from './map'
import { fromBase64, toBase64 } from './base64'
import { decodePng } from './png'
import type { Decoded } from './png'

const PANE = 'weather'
// /timelines answers without a key too (2/second, 50/hour, 200/day);
// a free key raises that to 3/second, 25/hour, 500/day.
const API = 'https://api.tomorrow.io/v4/timelines'
const FIELDS = 'temperature,temperatureApparent,humidity,windSpeed,weatherCode'
const MIN_REFRESH_MS = 30 * 60 * 1000
// Cities take most of the day's budget; map tiles (4 a layer) the rest.
const DAILY_BUDGET = { keyless: 110, keyed: 400 }
const TILE_MAX_AGE_MS = { keyless: 3 * 60 * 60 * 1000, keyed: 60 * 60 * 1000 }
// Hard caps, a little under Tomorrow.io's, over every session's requests.
const HOUR_CAP = { keyless: 45, keyed: 22 }
const DAY_CAP = { keyless: 190, keyed: 480 }
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const MAX_CITIES = 12
const CHECK_MS = 60 * 1000
const REQUEST_GAP_MS = 600
const TICK_MS = 300
const TICKS_PER_CITY = 30

const DEFAULT_CITIES: City[] = [
  { query: '32.0853,34.7818', label: 'Tel Aviv' },
  { query: '40.7128,-74.0060', label: 'New York' },
  { query: '51.5074,-0.1278', label: 'London' },
  { query: '35.6762,139.6503', label: 'Tokyo' },
  { query: '-33.8688,151.2093', label: 'Sydney' },
  { query: '64.1466,-21.9426', label: 'Reykjavik' },
  { query: '-22.9068,-43.1729', label: 'Rio de Janeiro' },
  { query: '30.0444,31.2357', label: 'Cairo' },
]

const EMPTY: Snapshot = { cities: [], fetchedAt: 0, error: null }

const snapshot = atom({ plugin: 'weather-theme', key: 'snapshot' } as const, EMPTY)
const frame = atom({ plugin: 'weather-theme', key: 'frame' } as const, 0)
const offset = atom({ plugin: 'weather-theme', key: 'offset' } as const, 0)
const view = atom({ plugin: 'weather-theme', key: 'view' } as const, 'cities' as View)
const mapVersion = atom({ plugin: 'weather-theme', key: 'mapVersion' } as const, 0)
const mapError = atom({ plugin: 'weather-theme', key: 'mapError' } as const, null as string | null)
const pixels = atom({ plugin: 'weather-theme', key: 'pixels' } as const, false)
const isPlaying = atom({ plugin: 'weather-theme', key: 'isPlaying' } as const, false)
const playHour = atom({ plugin: 'weather-theme', key: 'playHour' } as const, 0)
const playStatus = atom({ plugin: 'weather-theme', key: 'playStatus' } as const, null as string | null)

// The forecast animation: one zoom 0 tile (the whole world) every
// STEP_HOURS for HOURS, the hours between blended; 9 requests a layer.
const HOURS = 24
const STEP_HOURS = 3
const KEYFRAMES = HOURS / STEP_HOURS + 1
const PLAY_TICK_MS = 400
const PLAY_HOLD_TICKS = 3


type $ = EngineInterface

async function apiKey($: $): Promise<string | undefined> {
  const stored = await $.store.get('apiKey')
  if (typeof stored === 'string' && stored) return stored
  return $.env.get('TOMORROW_IO_API_KEY')
}

async function cities($: $): Promise<City[]> {
  const stored = await $.store.get('cities')
  return Array.isArray(stored) && stored.length ? (stored as City[]) : DEFAULT_CITIES
}

function wait($: $, ms: number): Promise<void> {
  return new Promise(resolve => $.clock.after(ms, resolve))
}

// Spreads a day's request budget over the cities, never faster than 30 min.
function refreshMs(cityCount: number, hasKey: boolean): number {
  const budget = hasKey ? DAILY_BUDGET.keyed : DAILY_BUDGET.keyless
  return Math.max(MIN_REFRESH_MS, Math.ceil((cityCount * 24 * 60 * 60 * 1000) / budget))
}

// Timestamps of the last day's requests, shared by every session through
// $.store, so forced refreshes and parallel sessions stay under the caps.
async function takeRequest($: $, now: number, hasKey: boolean): Promise<string | null> {
  const stored = await $.store.get('requests')
  const log = (Array.isArray(stored) ? (stored as number[]) : []).filter(t => now - t < DAY_MS)
  const tier = hasKey ? 'keyed' : 'keyless'
  if (log.length >= DAY_CAP[tier]) return 'Daily request budget used; showing last readings.'
  if (log.filter(t => now - t < HOUR_MS).length >= HOUR_CAP[tier]) {
    return 'Hourly request budget used; showing last readings.'
  }
  await $.store.set('requests', [...log, now])
  return null
}

function featuredIndex(n: number, tick: number, shift: number): number {
  if (n === 0) return 0
  return (((Math.floor(tick / TICKS_PER_CITY) + shift) % n) + n) % n
}

let isRefreshing = false

// Fetches every city (or just `only`), keeping the last good reading for
// any that fail. The cache lives in $.store so every session shares it.
async function refresh($: $, force = false, only?: string): Promise<string> {
  if (isRefreshing) return 'Already refreshing.'
  const cached = (await $.store.get('snapshot')) as Snapshot | undefined
  const now = await $.clock.now()
  const key = await apiKey($)
  const list = await cities($)
  if (!force && cached && now - cached.fetchedAt < refreshMs(list.length, Boolean(key))) {
    await update($, snapshot, () => cached)
    return 'Using cached weather.'
  }
  // Another session is mid-refresh; its result lands in the shared cache.
  const busyUntil = Number((await $.store.get('refreshingUntil')) ?? 0)
  if (busyUntil > now) return 'Another session is refreshing.'

  const targets = only ? list.filter(c => c.label === only) : list
  isRefreshing = true
  await $.store.set('refreshingUntil', now + targets.length * (REQUEST_GAP_MS + 10_000))
  try {
    const previous = new Map((cached?.cities ?? []).map(c => [c.label, c]))
    const results: CityWeather[] = []
    let error: string | null = null

    for (const [i, city] of targets.entries()) {
      const overBudget = await takeRequest($, now, Boolean(key))
      if (overBudget) {
        error = overBudget
        break
      }
      if (i > 0) await wait($, REQUEST_GAP_MS)
      const auth = key ? `&apikey=${encodeURIComponent(key)}` : ''
      const url = `${API}?location=${encodeURIComponent(city.query)}&fields=${FIELDS}&timesteps=current&units=metric${auth}`
      try {
        const res = await $.http.fetch(url, { headers: { accept: 'application/json' } })
        if (res.status === 401 || res.status === 403) {
          error = 'Tomorrow.io rejected the API key.'
          break
        }
        if (res.status === 429) {
          error = 'Tomorrow.io rate limit hit; showing last readings.'
          break
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const v = JSON.parse(res.text).data.timelines[0].intervals[0].values
        results.push({
          label: city.label,
          code: v.weatherCode,
          temperature: v.temperature,
          feelsLike: v.temperatureApparent,
          humidity: v.humidity,
          windSpeed: v.windSpeed,
          fetchedAt: now,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // The key rides in the URL; keep it off the screen if an error echoes it.
        error = `${city.label}: ${key ? message.split(key).join('***') : message}`
      }
    }

    // Cities not fetched this round keep their previous reading.
    const fetched = new Set(results.map(r => r.label))
    const merged = list
      .map(c => (fetched.has(c.label) ? results.find(r => r.label === c.label) : previous.get(c.label)))
      .filter((c): c is CityWeather => c !== undefined)

    const next: Snapshot = { cities: merged, fetchedAt: only ? (cached?.fetchedAt ?? now) : now, error }
    await $.store.set('snapshot', next)
    await update($, snapshot, () => next)
    return error ?? `Fetched weather for ${results.length} cities.`
  } finally {
    isRefreshing = false
    await $.store.delete('refreshingUntil')
  }
}

// Maps, built from tiles on disk; the module's own, rebuilt after a reload.
type MapImage = { plain: Uint8Array; marked?: { key: string; b64: string }; cells?: { key: string; b64: string } }
const maps = new Map<Field, MapImage>()
let isFetchingTiles = false
// A layer asked for while another was downloading; loaded when that ends.
let pendingField: Field | undefined

const TILE_RETRY_MS = 10 * 60 * 1000
const TILE_SIZE = 256

async function tilePath($: $, field: Field, x: number, y: number): Promise<string> {
  const home = (await $.env.get('HOME')) ?? '/tmp'
  return `${home}/.cache/claude-weather/${field}-${ZOOM}-${x}-${y}.png`
}

async function cityPixels($: $): Promise<[number, number][]> {
  return (await cities($)).map(c => cityPixel(c.query)).filter((p): p is [number, number] => p !== undefined)
}

function curlQuote(value: string): string {
  return `"${value.replace(/[\\"]/g, c => `\\${c}`)}"`
}

// Downloads one tile to a temporary file and moves it into place, so a cut
// download never replaces a good tile. curl reads its options from stdin,
// keeping the API key off the command line; $.http.fetch answers text and
// tiles are PNG bytes.
async function downloadTile($: $, url: string, path: string): Promise<string | null> {
  const partial = `${path}.part`
  const config = [`url = ${curlQuote(url)}`, `output = ${curlQuote(partial)}`, 'write-out = "%{http_code}"', ''].join('\n')
  const run = await $.process.run(['curl', '-s', '-f', '--create-dirs', '-K', '-'], { stdin: config, timeoutMs: 20_000 })
  if (run.exitCode !== 0) {
    const status = run.stdout.trim()
    return status === '429'
      ? 'Tomorrow.io rate limit hit; showing the last map.'
      : status === '401' || status === '403'
        ? 'Tomorrow.io rejected the API key.'
        : `Map tile download failed (HTTP ${status || '–'}, curl ${run.exitCode}).`
  }
  const moved = await $.process.run(['mv', '-f', partial, path])
  return moved.exitCode === 0 ? null : 'Could not save a map tile.'
}

// One download at a time, maps and forecasts alike: the flag is taken before
// the first await, and a layer asked for meanwhile loads once it is free.
async function loadMap($: $, field: Field, force = false): Promise<string> {
  if (isFetchingTiles) {
    pendingField = field
    return 'Fetching another map first; this one follows.'
  }
  isFetchingTiles = true
  try {
    return await fetchMap($, field, force)
  } finally {
    isFetchingTiles = false
    await loadPending($, field)
  }
}

async function loadPending($: $, done: Field) {
  const next = pendingField
  pendingField = undefined
  if (next && next !== done && (await read($, view)) === next) await loadMap($, next)
}

// Downloads a layer's tiles when they are stale, then decodes them into the
// map. A failed download is retried after TILE_RETRY_MS, not every check.
async function fetchMap($: $, field: Field, force: boolean): Promise<string> {
  const now = await $.clock.now()
  const key = await apiKey($)
  const stamps = ((await $.store.get('tilesAt')) ?? {}) as Partial<Record<Field, number>>
  const failures = ((await $.store.get('tilesFailedAt')) ?? {}) as Partial<Record<Field, number>>
  const maxAge = key ? TILE_MAX_AGE_MS.keyed : TILE_MAX_AGE_MS.keyless
  const isFresh = !force && now - (stamps[field] ?? 0) < maxAge
  const isBackingOff = !force && now - (failures[field] ?? 0) < TILE_RETRY_MS
  if ((isFresh || isBackingOff) && maps.has(field)) return 'Map is up to date.'

  let error: string | null = null
  try {
    if (!isFresh && !isBackingOff) {
      for (const [i, [x, y]] of TILES.entries()) {
        const overBudget = await takeRequest($, now, Boolean(key))
        if (overBudget) {
          error = overBudget
          break
        }
        if (i > 0) await wait($, REQUEST_GAP_MS)
        const auth = key ? `?apikey=${encodeURIComponent(key)}` : ''
        const url = `https://api.tomorrow.io/v4/map/tile/${ZOOM}/${x}/${y}/${field}/now.png${auth}`
        error = await downloadTile($, url, await tilePath($, field, x, y))
        if (error) break
      }
      if (error) await $.store.set('tilesFailedAt', { ...failures, [field]: now })
      else await $.store.set('tilesAt', { ...stamps, [field]: now })
    }

    const tiles = new Map<string, Decoded>()
    let unreadable = 0
    for (const [x, y] of TILES) {
      let base64: string
      try {
        base64 = (await $.fs.read(await tilePath($, field, x, y), { as: 'bytes' })).base64
      } catch {
        continue // Never downloaded: its quarter stays bare land and sea.
      }
      try {
        const tile = decodePng(fromBase64(base64))
        if (tile.width !== TILE_SIZE || tile.height !== TILE_SIZE) throw new Error('png: unexpected size')
        tiles.set(`${x},${y}`, tile)
      } catch {
        unreadable += 1
      }
    }
    if (unreadable) error ??= `${unreadable} cached map tile(s) could not be read; refresh to fetch them again.`
    if (tiles.size === 0) {
      error ??= 'No map tiles yet.'
    } else {
      maps.set(field, { plain: compose(field, tiles) })
    }
  } finally {
    await update($, mapError, () => error)
    await update($, mapVersion, n => n + 1)
  }
  return error ?? `${layerOf(field).title} map updated.`
}

// Keyframes per layer, composited; `base` is the hour of the first.
type Animation = { base: number; frames: Uint8Array[]; pixels: Map<string, string>; cells: Map<string, string> }
const animations = new Map<Field, Animation>()
let playTimer: { cancel: () => void } | undefined
let playTicks = 0

function frameTime(base: number, k: number): string {
  return new Date(base + k * STEP_HOURS * HOUR_MS).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function animPath($: $, field: Field, k: number): Promise<string> {
  const home = (await $.env.get('HOME')) ?? '/tmp'
  return `${home}/.cache/claude-weather/forecast/${field}-${k}.png`
}

async function loadAnimation($: $, field: Field): Promise<string | null> {
  if (isFetchingTiles) return 'Fetching a map; try again in a moment.'
  isFetchingTiles = true
  try {
    return await fetchAnimation($, field)
  } finally {
    isFetchingTiles = false
    await loadPending($, field)
  }
}

// Which forecast the files on disk hold: its first hour, how many leading
// frames belong to it, and when it was fetched (0 after a partial download,
// so the next play tries again).
type ForecastStamp = { at: number; base: number; usable?: number }

// Downloads the layer's keyframes when the cached ones are stale, then
// decodes and composites them. Plays whatever unbroken run loaded, and
// never a mix of two forecasts.
async function fetchAnimation($: $, field: Field): Promise<string | null> {
  const now = await $.clock.now()
  const key = await apiKey($)
  const stamps = ((await $.store.get('forecastAt')) ?? {}) as Partial<Record<Field, ForecastStamp>>
  const maxAge = key ? TILE_MAX_AGE_MS.keyed : TILE_MAX_AGE_MS.keyless
  const stamp = stamps[field]
  const isFresh = stamp !== undefined && now - stamp.at < maxAge
  if (isFresh && animations.get(field)?.base === stamp.base) return null

  let error: string | null = null
  try {
    let base = stamp?.base ?? 0
    // Stamps from before `usable` was kept were written only after a full download.
    let usable = stamp ? (stamp.usable ?? KEYFRAMES) : 0
    if (!isFresh) {
      const fresh = Math.floor(now / HOUR_MS) * HOUR_MS
      const auth = key ? `?apikey=${encodeURIComponent(key)}` : ''
      let downloaded = 0
      for (let k = 0; k < KEYFRAMES; k++) {
        await update($, playStatus, () => `Loading forecast ${k + 1}/${KEYFRAMES}…`)
        const overBudget = await takeRequest($, now, Boolean(key))
        if (overBudget) {
          error = overBudget
          break
        }
        if (k > 0) await wait($, REQUEST_GAP_MS)
        const url = `https://api.tomorrow.io/v4/map/tile/0/0/0/${field}/${frameTime(fresh, k)}.png${auth}`
        error = await downloadTile($, url, await animPath($, field, k))
        if (error) break
        downloaded += 1
      }
      if (downloaded > 0) {
        base = fresh
        usable = downloaded
        const next: ForecastStamp = { at: error ? 0 : now, base, usable }
        await $.store.set('forecastAt', { ...stamps, [field]: next })
      }
    }

    const frames: Uint8Array[] = []
    for (let k = 0; k < usable; k++) {
      try {
        const { base64 } = await $.fs.read(await animPath($, field, k), { as: 'bytes' })
        const tile = decodePng(fromBase64(base64))
        if (tile.width !== TILE_SIZE || tile.height !== TILE_SIZE) break
        frames.push(compose(field, new Map([['0,0', tile]]), 0))
      } catch {
        break
      }
    }
    if (frames.length < 2) error ??= 'No forecast frames yet.'
    else {
      // Only the layer being played is kept: nine frames are ~5 MB.
      animations.clear()
      animations.set(field, { base, frames, pixels: new Map(), cells: new Map() })
    }
  } finally {
    await update($, playStatus, () => error)
  }
  return error
}

function frames(field: Field): number {
  return animations.get(field)?.frames.length ?? 0
}

// The hours the loaded keyframes cover.
function lastHour(field: Field): number {
  return Math.max(0, (frames(field) - 1) * STEP_HOURS)
}

// The map `hour` hours ahead, blended between the keyframes either side.
function frameAt(anim: Animation, hour: number): Uint8Array {
  const k = Math.min(Math.floor(hour / STEP_HOURS), anim.frames.length - 1)
  const t = (hour % STEP_HOURS) / STEP_HOURS
  const a = anim.frames[k]!
  const b = anim.frames[k + 1]
  return t === 0 || !b ? a : blend(a, b, t)
}

async function advancePlay($: $) {
  const current = await read($, view)
  if (current === 'cities') return stopPlay($)
  playTicks = (playTicks + 1) % (lastHour(current) + 1 + PLAY_HOLD_TICKS)
  await update($, playHour, () => Math.min(playTicks, lastHour(current)))
}

// Bumped by every play and stop, so a play whose frames are still loading
// gives way to whatever the person did meanwhile.
let playRequest = 0

async function startPlay($: $, field: Field): Promise<string> {
  const request = ++playRequest
  await update($, view, () => field)
  const error = await loadAnimation($, field)
  if (frames(field) < 2) return error ?? 'No forecast frames.'
  if (request !== playRequest || (await read($, view)) !== field) return 'Playback was cancelled.'
  playTicks = Math.min(await read($, playHour), lastHour(field))
  await update($, playHour, () => playTicks)
  await update($, isPlaying, () => true)
  stopTimer()
  playTimer = $.clock.every(PLAY_TICK_MS, () => void advancePlay($))
  const playing = `Playing the next ${lastHour(field)} hours of ${layerOf(field).title.toLowerCase()}.`
  return error ? `${playing} (${error})` : playing
}

function stopTimer() {
  playTimer?.cancel()
  playTimer = undefined
}

async function stopPlay($: $) {
  playRequest += 1
  stopTimer()
  await update($, isPlaying, () => false)
}

async function togglePlay($: $) {
  const current = await read($, view)
  if (current === 'cities') return
  if (await read($, isPlaying)) await stopPlay($)
  else await startPlay($, current)
}

// Back to the live map.
async function showNow($: $) {
  await stopPlay($)
  playTicks = 0
  await update($, playHour, () => 0)
}

async function showView($: $, next: View) {
  await showNow($)
  await update($, view, () => next)
  if (next !== 'cities') await loadMap($, next)
}

async function togglePixels($: $) {
  await update($, pixels, p => !p)
}

async function refreshView($: $) {
  const current = await read($, view)
  if (current === 'cities') await refresh($, true)
  else await loadMap($, current, true)
}

function fmt(n: number | undefined, digits = 0): string {
  return n === undefined || Number.isNaN(n) ? '–' : n.toFixed(digits)
}

function clock(ms: number): string {
  if (!ms) return 'never'
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, c => c.toUpperCase())
}

const HELP = [
  '/weather                 open the weather pane',
  '/weather key <KEY>       optional: a free Tomorrow.io key raises the rate limits',
  '/weather add <place>     add a city ("paris" or "48.85,2.35")',
  '/weather remove <name>   remove a city',
  '/weather list            list cities',
  '/weather reset           back to the default cities',
  '/weather refresh         fetch now (uses API quota)',
  '/weather <layer>         show a world map: temp precip wind gusts clouds',
  '                         humidity pressure uv visibility dew feels',
  '/weather layers          list the map layers',
  '/weather play [layer]    animate the next 24 hours (9 requests a layer)',
  '/weather stop            stop and go back to the live map',
  '/weather cities          back to the city view',
].join('\n')

let ticker: { cancel: () => void } | undefined
let lastStatus = ''

async function setStatus($: $) {
  const { cities: list } = await read($, snapshot)
  const city = list[featuredIndex(list.length, await read($, frame), await read($, offset))]
  const text = city ? `${describe(city.code).icon} ${city.label} ${fmt(city.temperature)}°C` : ''
  if (text !== lastStatus) {
    lastStatus = text
    $.ui.status(text || undefined)
  }
}

async function advance($: $) {
  await update($, frame, n => n + 1)
  await setStatus($)
}

function startTicker($: $) {
  ticker ??= $.clock.every(TICK_MS, () => void advance($))
}

function stopTicker() {
  ticker?.cancel()
  ticker = undefined
}

async function openPane($: $) {
  startTicker($)
  return $.ui.open({ id: PANE, title: 'Weather around the world' })
}

async function start($: $) {
  // A reload drops the play timer; start from the live map.
  await update($, isPlaying, () => false)
  await update($, playHour, () => 0)
  // Ghostty, kitty and WezTerm draw real pixels; others get half-blocks.
  const term = ((await $.env.get('TERM_PROGRAM')) ?? '').toLowerCase()
  await update($, pixels, () => ['ghostty', 'kitty', 'wezterm'].includes(term))
  const current = await read($, view)
  if (current !== 'cities') await loadMap($, current)
  await refresh($)
  await setStatus($)
}

async function check($: $) {
  await refresh($)
  const current = await read($, view)
  if (current !== 'cities') await loadMap($, current)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'weather',
      description: 'Weather around the world: open the pane, temp/precip maps, or key/add/remove/list/reset/refresh',
    })
    void start($)
    $.clock.every(CHECK_MS, () => void check($))
    void openPane($)

    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      stopTicker()
      await stopPlay($)
    }
    return next(e)
  })

  on('command.run', { command: 'weather' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ')

    switch (sub.toLowerCase()) {
      case '':
      case 'open':
        await openPane($)
        return { text: 'Weather pane opened.' }
      case 'help':
        return { text: HELP }
      case 'key': {
        if (!arg) return { text: 'Usage: /weather key <KEY>' }
        await $.store.set('apiKey', arg)
        return { text: `API key saved. ${await refresh($, true)}` }
      }
      case 'add': {
        if (!arg) return { text: 'Usage: /weather add <place>' }
        const list = await cities($)
        const label = titleCase(arg)
        if (list.some(c => c.label.toLowerCase() === label.toLowerCase())) {
          return { text: `${label} is already on the list.` }
        }
        if (list.length >= MAX_CITIES) {
          return { text: `Up to ${MAX_CITIES} cities fit the free rate limits; remove one first.` }
        }
        await $.store.set('cities', [...list, { query: arg, label }])
        return { text: `Added ${label}. ${await refresh($, true, label)}` }
      }
      case 'remove': {
        const list = await cities($)
        const kept = list.filter(c => c.label.toLowerCase() !== arg.toLowerCase())
        if (kept.length === list.length) return { text: `No city named "${arg}".` }
        await $.store.set('cities', kept)
        const drop = (s: Snapshot): Snapshot => ({
          ...s,
          cities: s.cities.filter(c => c.label.toLowerCase() !== arg.toLowerCase()),
        })
        const cached = (await $.store.get('snapshot')) as Snapshot | undefined
        if (cached) await $.store.set('snapshot', drop(cached))
        await update($, snapshot, drop)
        return { text: `Removed ${arg}.` }
      }
      case 'list':
        return { text: (await cities($)).map(c => `${c.label} (${c.query})`).join('\n') }
      case 'reset':
        await $.store.delete('cities')
        return { text: `Back to the default cities. ${await refresh($, true)}` }
      case 'refresh':
        return { text: await refresh($, true) }
      case 'layers':
        return { text: LAYERS.map(l => `${l.tab.padEnd(11)} ${l.title}  (key ${l.hotkey})`).join('\n') }
      case 'play': {
        const current = await read($, view)
        const layer = arg ? findLayer(arg) : current === 'cities' ? findLayer('precip') : layerOf(current)
        if (!layer) return { text: `No layer "${arg}". /weather layers lists them.` }
        await openPane($)
        return { text: await startPlay($, layer.field) }
      }
      case 'stop':
        await showNow($)
        return { text: 'Back to the live map.' }
      case 'cities':
        await showNow($)
        await update($, view, () => 'cities')
        await openPane($)
        return { text: 'City view.' }
      default: {
        // `/weather wind` or `/weather map wind`
        const layer = findLayer(sub === 'map' ? arg || 'temp' : sub)
        if (!layer) return { text: HELP }
        await openPane($)
        await showNow($)
        await update($, view, () => layer.field)
        return { text: await loadMap($, layer.field) }
      }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const current = await read($, view)

    const views: [View, string, string][] = [
      ['cities', 'cities', '1'],
      ...LAYERS.map((l): [View, string, string] => [l.field, l.tab, l.hotkey]),
    ]
    const tabs = (
      <Box flexWrap="wrap" columnGap={1}>
        {views.map(([id, label, hotkey]) => (
          <Button
            key={`view-${id}`}
            label={label}
            hotkey={hotkey}
            variant={current === id ? 'primary' : 'secondary'}
            onPress={() => void showView($, id)}
          />
        ))}
        <Button key="refresh" label="refresh" hotkey="r" onPress={() => void refreshView($)} />
      </Box>
    )

    if (current !== 'cities') {
      await read($, mapVersion)
      const error = await read($, mapError)
      const usePixels = await read($, pixels)
      const hour = await read($, playHour)
      const playing = await read($, isPlaying)
      const status = await read($, playStatus)
      const layer = layerOf(current)
      const image = maps.get(current)
      const anim = animations.get(current)
      const isForecast = anim !== undefined && (playing || hour > 0)
      const columns = Math.max(20, Math.min(e.props.bodyColumns, 160))
      const rows = Math.max(5, Math.round((columns * MAP_HEIGHT) / MAP_WIDTH / 2))
      const stamps = ((await $.store.get('tilesAt')) ?? {}) as Partial<Record<Field, number>>
      const markers = await cityPixels($)
      const markerKey = JSON.stringify(markers)

      let picture = <Text dimColor>{error ?? `Loading ${layer.title.toLowerCase()} map…`}</Text>
      if ((image || isForecast) && e.surface !== 'terminal') {
        picture = <Text dimColor>Maps draw in the terminal.</Text>
      } else if ((image || isForecast) && e.surface === 'terminal') {
        const { Image, Raster } = $.ui.resolve(e)
        let pixelsB64: () => string
        let cellsB64: () => string
        if (anim && isForecast) {
          const cache = (store: Map<string, string>, key: string, make: () => string) => {
            if (store.size > HOURS + 1) store.clear()
            let value = store.get(key)
            if (value === undefined) store.set(key, (value = make()))
            return value
          }
          pixelsB64 = () => cache(anim.pixels, `${hour}:${markerKey}`, () => toBase64(withMarkers(frameAt(anim, hour), markers)))
          cellsB64 = () =>
            cache(anim.cells, `${hour}:${columns}x${rows}:${markerKey}`, () => toCells(frameAt(anim, hour), columns, rows, markers))
        } else {
          const still = image!
          pixelsB64 = () => {
            if (still.marked?.key !== markerKey) still.marked = { key: markerKey, b64: toBase64(withMarkers(still.plain, markers)) }
            return still.marked.b64
          }
          cellsB64 = () => {
            const key = `${columns}x${rows}:${markerKey}`
            if (still.cells?.key !== key) still.cells = { key, b64: toCells(still.plain, columns, rows, markers) }
            return still.cells.b64
          }
        }
        picture = usePixels ? (
          <Image
            key="map"
            source={{ rgba: pixelsB64(), width: MAP_WIDTH, height: MAP_HEIGHT }}
            columns={columns}
            rows={rows}
            alt={`${layer.title} (this terminal shows no images: press b for blocks)`}
          />
        ) : (
          <Raster key="map" columns={columns} rows={rows} cells={cellsB64()} />
        )
      }

      let when = 'now'
      if (anim && isForecast && hour > 0) {
        const at = new Date(anim.base + hour * HOUR_MS)
        const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][at.getDay()]
        when = `${day} ${String(at.getHours()).padStart(2, '0')}:00 (+${hour}h)`
      }
      const span = anim ? lastHour(current) : HOURS
      const timeline = '━'.repeat(Math.min(hour, span)) + '●' + '─'.repeat(Math.max(0, span - hour))

      return (
        <Box flexDirection="column">
          {tabs}
          <Text bold>
            {layer.title} {isForecast ? '· ' : ''}
            {when}
          </Text>
          {picture}
          <Box>
            <Text dimColor>{layer.low} </Text>
            {layer.legend.map(color => (
              <Text color={color}>■</Text>
            ))}
            <Text dimColor> {layer.high}</Text>
            <Text dimColor>
              {' '}· {isForecast ? 'forecast' : `tiles ${clock(stamps[current] ?? 0)}`} · © Tomorrow.io, Natural Earth{' '}
            </Text>
            {e.surface === 'terminal' && (
              <Button key="pixels" label={usePixels ? 'blocks' : 'pixels'} hotkey="b" onPress={() => void togglePixels($)} />
            )}
          </Box>
          <Box columnGap={1}>
            <Button key="play" label={playing ? '❚❚ pause' : '▶ play 24h'} hotkey="p" onPress={() => void togglePlay($)} />
            {(playing || hour > 0) && <Button key="now" label="now" hotkey="o" onPress={() => void showNow($)} />}
            <Text color={isForecast ? '#87afd7' : undefined} dimColor={!isForecast}>
              {timeline}
            </Text>
            {status && <Text dimColor>{status}</Text>}
          </Box>
          {image && error && <Text color="#ff875f">{error}</Text>}
        </Box>
      )
    }

    const snap = await read($, snapshot)
    const tick = await read($, frame)
    const shift = await read($, offset)
    const list = snap.cities
    const wide = e.props.bodyColumns >= WIDTH + 28

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          {tabs}
          <Text color="#ffd75f">{snap.error ?? 'Fetching weather from Tomorrow.io…'}</Text>
          <Text dimColor>/weather help for commands</Text>
        </Box>
      )
    }

    const index = featuredIndex(list.length, tick, shift)
    const city = list[index]!
    const info = describe(city.code)
    const art = scene(info.kind, tick)

    const picture = (
      <Box flexDirection="column" width={WIDTH} height={HEIGHT}>
        {art.map(row => (
          <Box>
            {row.map(seg => (
              <Text color={seg.color} bold={seg.bold}>
                {seg.text}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    )

    const details = (
      <Box flexDirection="column" paddingLeft={wide ? 2 : 0}>
        <Text bold>{city.label}</Text>
        <Text>{info.label}</Text>
        <Text color={tempColor(city.temperature)} bold>
          {fmt(city.temperature, 1)}°C <Text dimColor>feels {fmt(city.feelsLike)}°</Text>
        </Text>
        <Text dimColor>
          humidity {fmt(city.humidity)}%  wind {fmt(city.windSpeed, 1)} m/s
        </Text>
        <Text dimColor>
          {index + 1}/{list.length} · updated {clock(snap.fetchedAt)}
        </Text>
        <Box marginTop={1}>
          <Button key="prev" label="◀" hotkey="p" onPress={() => update($, offset, n => n - 1)} />
          <Text> </Text>
          <Button key="next" label="▶" hotkey="n" onPress={() => update($, offset, n => n + 1)} />
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {tabs}
        <Box flexDirection={wide ? 'row' : 'column'}>
          {picture}
          {details}
        </Box>
        <Text dimColor>{'─'.repeat(Math.max(10, Math.min(e.props.bodyColumns, 56)))}</Text>
        {list.map((c, i) => {
          const d = describe(c.code)
          return (
            <Box>
              <Box width={3}>
                <Text>{d.icon}</Text>
              </Box>
              <Box width={16}>
                <Text bold={i === index} wrap="truncate">
                  {c.label}
                </Text>
              </Box>
              <Box width={7}>
                <Text color={tempColor(c.temperature)}>{fmt(c.temperature)}°C</Text>
              </Box>
              <Text dimColor wrap="truncate">
                {d.label}
              </Text>
            </Box>
          )
        })}
        {snap.error && <Text color="#ff875f">{snap.error}</Text>}
      </Box>
    )
  })
}
