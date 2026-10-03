import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { City, CityWeather, Snapshot } from '../types'
import { HEIGHT, WIDTH, describe, scene, tempColor } from './art'

const PANE = 'weather'
// /timelines answers without a key too (2/second, 50/hour, 200/day);
// a free key raises that to 3/second, 25/hour, 500/day.
const API = 'https://api.tomorrow.io/v4/timelines'
const FIELDS = 'temperature,temperatureApparent,humidity,windSpeed,weatherCode'
const MIN_REFRESH_MS = 30 * 60 * 1000
const DAILY_BUDGET = { keyless: 150, keyed: 400 }
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
  await refresh($)
  await setStatus($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'weather',
      description: 'Weather around the world: open the pane, or key/add/remove/list/reset/refresh',
    })
    void start($)
    $.clock.every(CHECK_MS, () => void refresh($))
    void openPane($)

    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) stopTicker()
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
      default:
        return { text: HELP }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const tick = await read($, frame)
    const shift = await read($, offset)
    const list = snap.cities
    const wide = e.props.bodyColumns >= WIDTH + 28

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
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
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection={wide ? 'row' : 'column'}>
          {picture}
          {details}
        </Box>
        <Box>
          <Button key="prev" label="◀" hotkey="p" onPress={() => update($, offset, n => n - 1)} />
          <Text> </Text>
          <Button key="next" label="▶" hotkey="n" onPress={() => update($, offset, n => n + 1)} />
          <Text> </Text>
          <Button key="refresh" label="refresh" hotkey="r" onPress={() => void refresh($, true)} />
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
