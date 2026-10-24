// 生成应用图标：resources/icon.png、resources/tray.png、build/icon.ico
// 纯代码绘制（圆角渐变方块 + 白色信封），不依赖任何图片工具。
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const sdRoundRect = (px, py, cx, cy, hx, hy, r) => {
  const qx = Math.abs(px - cx) - (hx - r)
  const qy = Math.abs(py - cy) - (hy - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
const sdSegment = (px, py, ax, ay, bx, by) => {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)))
  return Math.hypot(pax - bax * h, pay - bay * h)
}
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const C1 = hex('#3d7bf5')
const C2 = hex('#8a5cf6')

function render(size, { tray = false } = {}) {
  const out = Buffer.alloc(size * size * 4)
  const ss = 4
  const stroke = tray ? 0.085 : 0.06
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = (x + (sx + 0.5) / ss) / size
          const py = (y + (sy + 0.5) / ss) / size
          const bg = sdRoundRect(px, py, 0.5, 0.5, 0.47, 0.47, tray ? 0.2 : 0.235)
          if (bg > 0) continue
          const t = Math.min(1, Math.max(0, (px + py) / 2))
          let cr = C1[0] + (C2[0] - C1[0]) * t
          let cg = C1[1] + (C2[1] - C1[1]) * t
          let cb = C1[2] + (C2[2] - C1[2]) * t
          // 顶部高光
          const hl = Math.max(0, 0.35 - py) * 0.5
          cr += (255 - cr) * hl
          cg += (255 - cg) * hl
          cb += (255 - cb) * hl
          // 信封
          const env = Math.abs(sdRoundRect(px, py, 0.5, 0.52, 0.27, 0.195, 0.05)) - stroke / 2
          const flap = Math.min(sdSegment(px, py, 0.26, 0.365, 0.5, 0.53), sdSegment(px, py, 0.5, 0.53, 0.74, 0.365)) - stroke / 2
          if (Math.min(env, flap) < 0) {
            cr = 255
            cg = 255
            cb = 255
          }
          r += cr
          g += cg
          b += cb
          a += 255
        }
      }
      const n = ss * ss
      const i = (y * size + x) * 4
      const alpha = a / n
      out[i] = alpha ? Math.round((r / (a / 255))) : 0
      out[i + 1] = alpha ? Math.round((g / (a / 255))) : 0
      out[i + 2] = alpha ? Math.round((b / (a / 255))) : 0
      out[i + 3] = Math.round(alpha)
    }
  }
  return png(size, out)
}

function ico(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const entries = []
  let offset = 6 + images.length * 16
  for (const { size, data } of images) {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size
    e[1] = size >= 256 ? 0 : size
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    entries.push(e)
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)])
}

mkdirSync(join(root, 'resources'), { recursive: true })
mkdirSync(join(root, 'build'), { recursive: true })
const big = render(256)
writeFileSync(join(root, 'resources', 'icon.png'), big)
writeFileSync(join(root, 'build', 'icon.png'), render(512))
writeFileSync(join(root, 'resources', 'tray.png'), render(32, { tray: true }))
writeFileSync(join(root, 'resources', 'tray@2x.png'), render(64, { tray: true }))
writeFileSync(join(root, 'build', 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: size === 256 ? big : render(size, { tray: size <= 32 }) }))))
console.log('icons written')
