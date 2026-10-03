export type City = { query: string; label: string }

export type CityWeather = {
  label: string
  code: number
  temperature: number
  feelsLike: number
  humidity: number
  windSpeed: number
  fetchedAt: number
}

export type Snapshot = {
  cities: CityWeather[]
  fetchedAt: number
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'weather-theme': {
      snapshot: Snapshot
      frame: number
      offset: number
    }
  }
}
