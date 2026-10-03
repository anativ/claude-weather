# claude-weather

A Claude Code mod that shows the weather around the world in a pane, with an
animated ASCII scene for each [Tomorrow.io weather code](https://docs.tomorrow.io/reference/data-layers-weather-codes):
sun, clouds, fog, drizzle, rain, snow, ice pellets, freezing rain and thunderstorms.

```
            .--.              London
         .-(    ).--.         Rain
      .-(            ).       12.0°C feels 11°
     (_____.___.______)       humidity 70%  wind 3.2 m/s
   /          '' /    '/  '   3/8 · updated 10:04
 '     ///  ' '     /  /  '
  /  //    /  '    '          [ ◀ ] [ ▶ ] [ refresh ]
```

The pane cycles through the cities every ~9 seconds, lists them all with
icon, temperature and condition, and puts the featured city on the status line.

## Install

```sh
claude --plugin-dir /path/to/claude-weather
```

The pane opens by itself on terminals 144+ columns wide; otherwise run `/weather`.

## Commands

| Command | |
| --- | --- |
| `/weather` | open the pane |
| `/weather add <place>` | add a city (`paris` or `48.85,2.35`) |
| `/weather remove <name>` | remove a city |
| `/weather list` / `reset` | list cities / back to the defaults |
| `/weather refresh` | fetch now |
| `/weather key <KEY>` | optional Tomorrow.io API key |

Pane keys: `p` / `n` previous / next city, `r` refresh.

## API key and rate limits

No key needed: the mod uses Tomorrow.io's `/v4/timelines` endpoint, which
answers anonymous requests at 2/second, 50/hour, 200/day. A free key
(`/weather key <KEY>` or `TOMORROW_IO_API_KEY`) raises that to 500/day.

The refresh interval spreads a daily budget (150 requests keyless, 400 with a
key) across the cities, never faster than every 30 minutes. Every request is
also logged in the plugin's store and checked against hard hourly and daily
caps shared by all sessions, so forced refreshes (`/weather refresh`, `r`)
can't blow through the limit. `/weather add` fetches only the new city, and
the list holds up to 12 cities. Readings are cached across sessions.

## Layout

| Path | |
| --- | --- |
| `hooks/register.tsx` | the hooks module: fetching, caching, `/weather`, the pane |
| `hooks/art.ts` | weather code → animated ASCII scene |
| `types/index.d.ts` | the mod's `$.state` contract |
| `tests/weather.test.tsx` | `claude plugin test .` |

Check it with `claude plugin validate .` and `claude plugin test .`.
