// A small PNG decoder for Tomorrow.io map tiles: 8-bit RGB or RGBA,
// non-interlaced. The plugin environment has no zlib, so inflate
// (RFC 1950/1951) is here too, after Mark Adler's puff.c.

export type Decoded = { width: number; height: number; rgba: Uint8Array }

class Bits {
  readonly data: Uint8Array
  pos = 0
  private bit = 0
  constructor(data: Uint8Array) {
    this.data = data
  }

  read(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) {
      if (this.pos >= this.data.length) throw new Error('inflate: out of input')
      v |= ((this.data[this.pos]! >> this.bit) & 1) << i
      if (++this.bit === 8) {
        this.bit = 0
        this.pos++
      }
    }
    return v
  }

  align() {
    if (this.bit) {
      this.bit = 0
      this.pos++
    }
  }
}

type Huffman = { counts: Uint16Array; symbols: Uint16Array }

function huffman(lengths: ArrayLike<number>): Huffman {
  const counts = new Uint16Array(16)
  const offsets = new Uint16Array(16)
  const symbols = new Uint16Array(lengths.length)
  for (let i = 0; i < lengths.length; i++) counts[lengths[i]!]!++
  counts[0] = 0
  for (let len = 1; len < 16; len++) offsets[len] = offsets[len - 1]! + counts[len - 1]!
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i]!
    if (len) symbols[offsets[len]!++] = i
  }
  return { counts, symbols }
}

function decodeSymbol(bits: Bits, h: Huffman): number {
  let code = 0
  let first = 0
  let index = 0
  for (let len = 1; len < 16; len++) {
    code |= bits.read(1)
    const count = h.counts[len]!
    if (code - count < first) return h.symbols[index + (code - first)]!
    index += count
    first = (first + count) << 1
    code <<= 1
  }
  throw new Error('inflate: bad code')
}

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CODE_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

let fixed: [Huffman, Huffman] | undefined

function fixedTrees(): [Huffman, Huffman] {
  if (!fixed) {
    const lit = new Uint8Array(288)
    lit.fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288)
    fixed = [huffman(lit), huffman(new Uint8Array(30).fill(5))]
  }
  return fixed
}

function dynamicTrees(bits: Bits): [Huffman, Huffman] {
  const nlen = bits.read(5) + 257
  const ndist = bits.read(5) + 1
  const ncode = bits.read(4) + 4
  const codeLengths = new Uint8Array(19)
  for (let i = 0; i < ncode; i++) codeLengths[CODE_ORDER[i]!] = bits.read(3)
  const codes = huffman(codeLengths)

  const lengths = new Uint8Array(nlen + ndist)
  for (let i = 0; i < nlen + ndist; ) {
    const sym = decodeSymbol(bits, codes)
    if (sym < 16) {
      lengths[i++] = sym
      continue
    }
    let repeat = 0
    let value = 0
    if (sym === 16) {
      if (i === 0) throw new Error('inflate: repeat with no length')
      value = lengths[i - 1]!
      repeat = 3 + bits.read(2)
    } else if (sym === 17) repeat = 3 + bits.read(3)
    else repeat = 11 + bits.read(7)
    if (i + repeat > lengths.length) throw new Error('inflate: too many lengths')
    lengths.fill(value, i, i + repeat)
    i += repeat
  }
  return [huffman(lengths.subarray(0, nlen)), huffman(lengths.subarray(nlen))]
}

// Inflates a zlib stream into a buffer of the size the caller expects.
export function inflate(zlib: Uint8Array, size: number): Uint8Array {
  if ((zlib[0]! & 0x0f) !== 8) throw new Error('inflate: not deflate')
  const bits = new Bits(zlib.subarray(2))
  const out = new Uint8Array(size)
  let at = 0
  let isLast = 0
  while (!isLast) {
    isLast = bits.read(1)
    const type = bits.read(2)
    if (type === 0) {
      bits.align()
      const d = bits.data
      if (bits.pos + 4 > d.length) throw new Error('inflate: out of input')
      const len = d[bits.pos]! | (d[bits.pos + 1]! << 8)
      const nlen = d[bits.pos + 2]! | (d[bits.pos + 3]! << 8)
      if ((len ^ 0xffff) !== nlen) throw new Error('inflate: bad stored block')
      bits.pos += 4
      if (bits.pos + len > d.length) throw new Error('inflate: out of input')
      if (at + len > size) throw new Error('inflate: output overflow')
      out.set(d.subarray(bits.pos, bits.pos + len), at)
      bits.pos += len
      at += len
      continue
    }
    if (type === 3) throw new Error('inflate: bad block type')
    const [lit, dist] = type === 1 ? fixedTrees() : dynamicTrees(bits)
    for (;;) {
      const sym = decodeSymbol(bits, lit)
      if (sym < 256) {
        if (at >= size) throw new Error('inflate: output overflow')
        out[at++] = sym
      } else if (sym === 256) break
      else {
        const l = sym - 257
        if (l >= LEN_BASE.length) throw new Error('inflate: bad length code')
        const len = LEN_BASE[l]! + bits.read(LEN_EXTRA[l]!)
        const d = decodeSymbol(bits, dist)
        if (d >= DIST_BASE.length) throw new Error('inflate: bad distance code')
        const back = DIST_BASE[d]! + bits.read(DIST_EXTRA[d]!)
        if (!(back <= at && at + len <= size)) throw new Error('inflate: bad distance')
        for (let i = 0; i < len; i++, at++) out[at] = out[at - back]!
      }
    }
  }
  if (at !== size) throw new Error('inflate: short output')
  return out
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

export function decodePng(png: Uint8Array): Decoded {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  if (view.getUint32(0) !== 0x89504e47) throw new Error('png: bad signature')
  let width = 0
  let height = 0
  let channels = 0
  const idat: Uint8Array[] = []
  for (let i = 8; i + 8 <= png.length; ) {
    const len = view.getUint32(i)
    const type = String.fromCharCode(...png.subarray(i + 4, i + 8))
    const data = png.subarray(i + 8, i + 8 + len)
    if (type === 'IHDR') {
      width = view.getUint32(i + 8)
      height = view.getUint32(i + 12)
      const [depth, color, , , interlace] = data.subarray(8)
      if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) {
        throw new Error(`png: unsupported format (depth ${depth}, color ${color})`)
      }
      channels = color === 6 ? 4 : 3
      if (!width || !height || width > 4096 || height > 4096) throw new Error('png: bad size')
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    i += 12 + len
  }
  if (!width || !channels) throw new Error('png: no IHDR')

  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0))
  idat.reduce((at, c) => (joined.set(c, at), at + c.length), 0)
  const stride = width * channels
  const raw = inflate(joined, (stride + 1) * height)

  const px = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const src = y * (stride + 1) + 1
    const row = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[row + x - channels]! : 0
      const b = y ? px[row - stride + x]! : 0
      const c = x >= channels && y ? px[row - stride + x - channels]! : 0
      const v = raw[src + x]!
      px[row + x] =
        (filter === 1 ? v + a : filter === 2 ? v + b : filter === 3 ? v + ((a + b) >> 1) : filter === 4 ? v + paeth(a, b, c) : v) & 255
    }
  }

  if (channels === 4) return { width, height, rgba: px }
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) {
    rgba[j] = px[i]!
    rgba[j + 1] = px[i + 1]!
    rgba[j + 2] = px[i + 2]!
    rgba[j + 3] = 255
  }
  return { width, height, rgba }
}
