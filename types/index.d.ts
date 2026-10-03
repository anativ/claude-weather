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

export type View =
  | 'cities'
  | 'temperature'
  | 'precipitationIntensity'
  | 'windSpeed'
  | 'windGust'
  | 'cloudCover'
  | 'humidity'
  | 'pressureSeaLevel'
  | 'uvIndex'
  | 'visibility'
  | 'dewPoint'
  | 'temperatureApparent'

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
      // The forecast animation: whether it plays, the hour shown (0 = now),
      // and its loading progress or failure.
      isPlaying: boolean
      playHour: number
      playStatus: string | null
    }
  }
}
