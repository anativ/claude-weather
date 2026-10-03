import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { fromBase64, toBase64 } from '../hooks/base64'
import { decodePng } from '../hooks/png'

// A 256x256 solid red RGB PNG, rows Sub-filtered, as Tomorrow.io tiles are shaped.
const RED_TILE = 'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAACAUlEQVR42u3TQQ0AAAjEMM4N/lUgizcaaCUsWaa74KsYAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAGMAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAbAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAGMAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAATCAChgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAC4FtJ0GRB4aAORAAAAAElFTkSuQmCC'

function weather($: Engine, args: string) {
  return $.command.run({
    command: 'weather',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
}

const PANE = {
  component: 'Pane',
  requestId: 'weather',
  props: {
    title: 'Weather around the world',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

function reading(code: number, temperature: number) {
  const values = { weatherCode: code, temperature, temperatureApparent: temperature - 1, humidity: 70, windSpeed: 3.2 }
  return JSON.stringify({ data: { timelines: [{ timestep: 'current', intervals: [{ values }] }] } })
}

describe('weather-theme', () => {
  test('refresh fetches each city and the pane draws the featured one', async ($, on) => {
    mock.store(on, {
      cities: [
        { query: '51.5,-0.12', label: 'London' },
        { query: '35.6,139.6', label: 'Tokyo' },
      ],
    })
    mock.env(on, { TOMORROW_IO_API_KEY: 'test-key' })
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 3, 12) })
    const urls: string[] = []
    on('http.fetch', async (_$, e) => {
      urls.push(e.url)
      const isLondon = e.url.includes('51.5')
      return { value: { status: 200, ok: true, headers: {}, text: reading(isLondon ? 4001 : 1000, isLondon ? 12 : 26) } }
    })

    // Requests are spaced to respect the free plan's 3/second limit.
    const running = weather($, 'refresh')
    await clock.advance(1000)
    const ran = await running
    expect(ran.text).toContain('Fetched weather for 2 cities')
    expect(urls.length).toBe(2)
    expect(urls[0]).toContain('apikey=test-key')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'weather-theme', surface, ...PANE })
      expect(await ui.find({ type: 'Text', text: 'London' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Rain' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Clear, Sunny/ })).toBeDefined()
      const before = (await ui.find({ type: 'Text', text: /\/2 · updated/ }))?.text
      await ui.press({ key: 'next' })
      const after = (await ui.find({ type: 'Text', text: /\/2 · updated/ }))?.text
      expect(after).toBeDefined()
      expect(after).not.toBe(before)
      await ui.unmount()
    }
  })

  test('without a key it still fetches, leaving apikey off the URL', async ($, on) => {
    mock.store(on, { cities: [{ query: 'paris', label: 'Paris' }] })
    mock.env(on, {})
    mock.clock(on)
    const urls: string[] = []
    on('http.fetch', async (_$, e) => {
      urls.push(e.url)
      return { value: { status: 200, ok: true, headers: {}, text: reading(1001, 10.6) } }
    })
    const ran = await weather($, 'refresh')
    expect(ran.text).toContain('Fetched weather for 1 cities')
    expect(urls[0]).toContain('/v4/timelines?location=paris')
    expect(urls[0]).not.toContain('apikey')

    const ui = await $.ui.mount({ plugin: 'weather-theme', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: 'Cloudy' })).toBeDefined()
    await ui.unmount()
  })

  test('the shared hourly cap stops a forced refresh', async ($, on) => {
    const now = Date.UTC(2026, 9, 3, 12)
    mock.store(on, { requests: Array.from({ length: 45 }, (_, i) => now - i * 1000) })
    mock.env(on, {})
    mock.clock(on, { now })
    let calls = 0
    on('http.fetch', async () => {
      calls += 1
      return { value: { status: 200, ok: true, headers: {}, text: reading(1000, 20) } }
    })
    const ran = await weather($, 'refresh')
    expect(ran.text).toContain('Hourly request budget used')
    expect(calls).toBe(0)
  })

  test('add fetches only the new city; remove drops it from the cache', async ($, on) => {
    // A store of the test's own, so it can read what the plugin wrote.
    const store = new Map<string, unknown>([['cities', [{ query: 'paris', label: 'Paris' }]]])
    on('store.get', async (_$, e) => ({ value: store.get(e.key) }))
    on('store.set', async (_$, e) => {
      store.set(e.key, JSON.parse(JSON.stringify(e.value)))
      return { value: undefined }
    })
    on('store.delete', async (_$, e) => {
      store.delete(e.key)
      return { value: undefined }
    })
    const cached = () => (store.get('snapshot') as { cities: { label: string }[] }).cities.map(c => c.label)
    mock.env(on, {})
    mock.clock(on)
    const urls: string[] = []
    on('http.fetch', async (_$, e) => {
      urls.push(e.url)
      return { value: { status: 200, ok: true, headers: {}, text: reading(1000, 20) } }
    })
    await weather($, 'add oslo')
    expect(urls.length).toBe(1)
    expect(urls[0]).toContain('location=oslo')

    expect(cached()).toContain('Oslo')

    await weather($, 'remove oslo')
    expect(cached()).not.toContain('Oslo')
  })

  test('decodes a PNG tile and round-trips base64', async () => {
    const tile = decodePng(fromBase64(RED_TILE))
    expect([tile.width, tile.height]).toEqual([256, 256])
    expect(Array.from(tile.rgba.subarray(0, 8))).toEqual([200, 40, 40, 255, 200, 40, 40, 255])
    expect(Array.from(tile.rgba.subarray(-4))).toEqual([200, 40, 40, 255])
    expect(toBase64(fromBase64(RED_TILE))).toBe(RED_TILE)
  })

  test('/weather temp downloads four tiles and draws the map', async ($, on) => {
    mock.store(on)
    mock.env(on, { HOME: '/home/test' })
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 3, 12) })
    const downloads: string[] = []
    on('process.run', async (_$, e) => {
      if (e.argv[0] === 'curl') downloads.push(e.init?.stdin ?? '')
      return { value: { exitCode: 0, stdout: '200', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('fs.read', async () => ({ value: { base64: RED_TILE } }))
    on('ui.open', async () => ({ value: { isPlaced: true as const } }))

    const running = weather($, 'temp')
    await clock.advance(5000)
    expect((await running).text).toContain('Temperature map updated')
    expect(downloads.length).toBe(4)
    expect(downloads[0]).toContain('url = "https://api.tomorrow.io/v4/map/tile/1/0/0/temperature/now.png"')
    expect(downloads[0]).toContain('output = "/home/test/.cache/claude-weather/temperature-1-0-0.png.part"')

    const pane = { ...PANE, props: { ...PANE.props, bodyColumns: 60 } }
    const ui = await $.ui.mount({ plugin: 'weather-theme', surface: 'terminal', ...pane })
    expect(await ui.find({ type: 'Raster' })).toBeDefined()
    await ui.press({ key: 'pixels' })
    expect(await ui.find({ type: 'Image' })).toBeDefined()
    await ui.press({ key: 'view-cities' })
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    await ui.unmount()
  })

  test('every layer has a command, and /weather wind loads wind tiles', async ($, on) => {
    mock.store(on)
    mock.env(on, { HOME: '/home/test' })
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 3, 12) })
    const urls: string[] = []
    on('process.run', async (_$, e) => {
      if (e.argv[0] === 'curl') urls.push(e.init?.stdin ?? '')
      return { value: { exitCode: 0, stdout: '200', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('fs.read', async () => ({ value: { base64: RED_TILE } }))
    on('ui.open', async () => ({ value: { isPlaced: true as const } }))

    const listed = (await weather($, 'layers')).text
    for (const word of ['temp', 'precip', 'wind', 'gusts', 'clouds', 'humidity', 'pressure', 'uv', 'visibility', 'dew', 'feels']) {
      expect(listed).toContain(word)
    }

    const running = weather($, 'map wind')
    await clock.advance(5000)
    expect((await running).text).toContain('Wind speed map updated')
    expect(urls.every(u => u.includes('/windSpeed/now.png'))).toBe(true)

    const ui = await $.ui.mount({ plugin: 'weather-theme', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /Wind speed now/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /calm/ })).toBeDefined()
    await ui.unmount()
  })

  test('a failed tile download backs off instead of retrying each minute', async ($, on) => {
    mock.store(on)
    mock.env(on, { HOME: '/home/test' })
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 3, 12) })
    let curls = 0
    on('process.run', async (_$, e) => {
      if (e.argv[0] === 'curl') curls += 1
      return { value: { exitCode: 22, stdout: '500', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('fs.read', async () => ({ value: { base64: RED_TILE } }))
    on('ui.open', async () => ({ value: { isPlaced: true as const } }))

    expect((await weather($, 'wind')).text).toContain('HTTP 500')
    expect(curls).toBe(1)
    await clock.advance(2 * 60 * 1000)
    expect((await weather($, 'wind')).text).toContain('up to date')
    expect(curls).toBe(1)
  })

  test('inflate rejects a truncated stream', async () => {
    const png = fromBase64(RED_TILE)
    expect(() => decodePng(png.subarray(0, png.length - 40))).toThrow()
  })

  test('/weather play fetches 9 forecast frames and steps through 24 hours', async ($, on) => {
    mock.store(on)
    mock.env(on, { HOME: '/home/test' })
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 3, 12, 25) })
    const urls: string[] = []
    on('process.run', async (_$, e) => {
      if (e.argv[0] === 'curl') urls.push(e.init?.stdin ?? '')
      return { value: { exitCode: 0, stdout: '200', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('fs.read', async () => ({ value: { base64: RED_TILE } }))
    on('ui.open', async () => ({ value: { isPlaced: true as const } }))

    const running = weather($, 'play precip')
    await clock.advance(9 * 1000)
    expect((await running).text).toContain('Playing the next 24 hours of precipitation')
    expect(urls.length).toBe(9)
    expect(urls[0]).toContain('/map/tile/0/0/0/precipitationIntensity/2026-10-03T12:00:00Z.png')
    expect(urls[8]).toContain('/map/tile/0/0/0/precipitationIntensity/2026-10-04T12:00:00Z.png')

    const ui = await $.ui.mount({ plugin: 'weather-theme', surface: 'terminal', ...PANE })
    await clock.advance(3 * 400)
    const title = async () => (await ui.find({ type: 'Text', text: /^Precipitation/ }))?.text ?? ''
    expect(await title()).toMatch(/\(\+\d+h\)/)
    expect(await ui.find({ type: 'Raster' })).toBeDefined()

    await ui.press({ key: 'play' })
    const paused = await title()
    await clock.advance(5 * 400)
    expect(await title()).toBe(paused)

    await ui.press({ key: 'now' })
    expect(await title()).toBe('Precipitation now')
    await ui.unmount()
  })
})
