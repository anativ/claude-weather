import { describe, expect, mock, test } from 'claude-code/testing'

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
    const running = $.command.run({ command: 'weather', args: 'refresh' })
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
    const ran = await $.command.run({ command: 'weather', args: 'refresh' })
    expect(ran.text).toContain('Fetched weather for 1 cities')
    expect(urls[0]).toContain('/v4/timelines?location=paris')
    expect(urls[0]).not.toContain('apikey')

    const ui = await $.ui.mount({ plugin: 'weather-theme', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: 'Cloudy' })).toBeDefined()
    await ui.unmount()
  })
})
