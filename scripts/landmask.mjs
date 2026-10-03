// Rasterizes Natural Earth land into hooks/landmask.ts.
//   curl -sLO https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson
//   node scripts/landmask.mjs ne_50m_land.geojson
import fs from 'node:fs'
const SIZE = 512, Y0 = 88, Y1 = 368 // ~75.5°N to ~61°S: drop the poles
const geo = JSON.parse(fs.readFileSync(process.argv[2] ?? "ne_50m_land.geojson", 'utf8'))
const px = lon => ((lon + 180) / 360) * SIZE
const py = lat => {
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180)
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * SIZE
}
const rings = []
for (const f of geo.features) {
  const g = f.geometry
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
  for (const p of polys) for (const r of p) rings.push(r.map(([lo, la]) => [px(lo), py(la)]))
}
const H = Y1 - Y0
const mask = new Uint8Array(SIZE * H)
for (let y = 0; y < H; y++) {
  const cy = Y0 + y + 0.5
  const xs = []
  for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [x1, y1] = r[i], [x2, y2] = r[j]
    if ((y1 > cy) !== (y2 > cy)) xs.push(x1 + ((cy - y1) / (y2 - y1)) * (x2 - x1))
  }
  xs.sort((a, b) => a - b)
  for (let k = 0; k + 1 < xs.length; k += 2) {
    for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x < Math.min(SIZE, xs[k + 1] - 0.5); x++) mask[y * SIZE + x] = 1
  }
}
// Run lengths, alternating water/land from water, as LEB128 varints.
const out = []
let cur = 0, run = 0
const push = n => { do { let b = n & 127; n >>>= 7; if (n) b |= 128; out.push(b) } while (n) }
for (const v of mask) { if (v === cur) run++; else { push(run); cur = v; run = 1 } }
push(run)
const b64 = Buffer.from(out).toString('base64')
fs.writeFileSync(process.argv[3] ?? new URL("../hooks/landmask.ts", import.meta.url), `// World land mask, web-mercator zoom 1 (512 px across), rows ${Y0}..${Y1}.
// Rasterized from Natural Earth 1:50m land (public domain) by
// scripts/landmask.mjs; regenerate rather than edit.
// Runs of water/land pixels, alternating from water, as LEB128 varints.

import { fromBase64 } from './base64'

export const MASK_SIZE = ${SIZE}
export const MASK_Y0 = ${Y0}
export const MASK_HEIGHT = ${H}

const RUNS =
  '${b64}'

export function landMask(): Uint8Array {
  const bytes = fromBase64(RUNS)
  const mask = new Uint8Array(MASK_SIZE * MASK_HEIGHT)
  let at = 0
  let value = 0
  for (let i = 0; i < bytes.length; ) {
    let run = 0
    let shift = 0
    let b: number
    do {
      b = bytes[i++]!
      run |= (b & 127) << shift
      shift += 7
    } while (b & 128)
    mask.fill(value, at, at + run)
    at += run
    value ^= 1
  }
  return mask
}
`)
// Preview as ASCII at 1/8 scale
for (let y = 0; y < H; y += 10) { let s = ''; for (let x = 0; x < SIZE; x += 5) s += mask[y * SIZE + x] ? '#' : '.'; console.log(s) }
console.log('bytes', out.length, 'b64', b64.length)
