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

export type View = 'cities' | 'temperature' | 'precipitationIntensity'

declare module 'claude-code' {
  interface PluginState {
    'weather-theme': {
      snapshot: Snapshot
      frame: number
      offset: number
      view: View
      // Bumped when a map's tiles change, so the pane redraws.
      mapVersion: number
      mapError: string | null
      // Draw maps as pixels (kitty graphics) rather than half-block cells.
      pixels: boolean
    }
  }
}
