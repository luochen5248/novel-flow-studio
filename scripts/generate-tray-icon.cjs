/**
 * 生成托盘图标：electron/assets/tray-icon.png
 *
 * 为什么脚本入库（而不是直接提交一个 PNG）：
 *   PNG 是二进制 blob，单看仓库没人说得清它怎么来的、怎么改尺寸或配色。
 *   脚本入库后它就是可复现、可审计的产物 —— 换尺寸改 SIZE 常量、换配色改
 *   TOP/BOTTOM，重跑一次即可。
 *
 * 为什么不用任何 npm 包：
 *   本脚本只依赖 node:fs / node:path / node:zlib，PNG 字节（签名、IHDR、IDAT、
 *   IEND、CRC32）全部手写。这样它不会给仓库引入任何构建期依赖，CI 里裸 node 就能跑。
 *
 * 用法（项目根目录执行，Node ≥ 18）：
 *   node scripts/generate-tray-icon.cjs
 *   node scripts/generate-tray-icon.cjs electron/assets/tray-icon.png   # 显式指定输出路径
 *
 * 幂等：每次输出同样的字节，重复执行不会产生 diff。
 *
 * 图形：SIZE×SIZE 的青色圆点，竖向渐层 #6FDDE4 → #2AA6B0（与 AppHeader 的
 * .nf-header__mark 同色系），4×4 超采样 + coverage 加权得到抗锯齿半透明边缘。
 * 当前输出 32×32，交给 Electron 按系统 DPI 缩放 —— Windows 托盘在 150%/200%
 * 缩放下需要比 16×16 更大的源图，否则会糊。
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

/** 输出尺寸：改这里就能换 DPI（16 / 32 / 64 均可） */
const SIZE = 32
/** 超采样倍率：每边 SS×SS 次采样后平均，得到平滑边缘 */
const SS = 4
const N = SIZE * SS

/** 品牌青渐层（同 AppHeader 的 .nf-header__mark） */
const TOP = [0x6f, 0xdd, 0xe4]
const BOTTOM = [0x2a, 0xa6, 0xb0]

const DEFAULT_TARGET = path.join(__dirname, '..', 'electron', 'assets', 'tray-icon.png')
const TARGET = path.resolve(process.argv[2] || DEFAULT_TARGET)

/* ---------------------------- 采样：抗锯齿圆点 ---------------------------- */

/** RGBA 累加值（按 coverage 加权，避免半透明边缘被背景色污染） */
const acc = new Float64Array(SIZE * SIZE * 4)
/** 覆盖度累加（用于算 alpha） */
const cov = new Float64Array(SIZE * SIZE)

const CENTER = SIZE / 2
// 上下各留 1px 边距，不让圆点顶到边缘（系统托盘区域很小，贴边会显得糊成一团）
const RADIUS = SIZE / 2 - 1

for (let sy = 0; sy < N; sy++) {
  const py = (sy + 0.5) / SS
  for (let sx = 0; sx < N; sx++) {
    const px = (sx + 0.5) / SS
    const dist = Math.hypot(px - CENTER, py - CENTER)
    // 边缘留 1px 过渡带：coverage = clamp(RADIUS + 0.5 - dist, 0, 1)
    const coverage = Math.min(1, Math.max(0, RADIUS + 0.5 - dist))
    if (coverage <= 0) continue
    const t = Math.min(1, Math.max(0, (py - (CENTER - RADIUS)) / (RADIUS * 2)))
    const r = TOP[0] + (BOTTOM[0] - TOP[0]) * t
    const g = TOP[1] + (BOTTOM[1] - TOP[1]) * t
    const b = TOP[2] + (BOTTOM[2] - TOP[2]) * t
    const index = Math.floor(sy / SS) * SIZE + Math.floor(sx / SS)
    acc[index * 4 + 0] += r * coverage
    acc[index * 4 + 1] += g * coverage
    acc[index * 4 + 2] += b * coverage
    acc[index * 4 + 3] += coverage
    cov[index] += coverage
  }
}

/** 组装 RGBA 原始扫描线（每行前置 filter byte 0 = None） */
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
let cursor = 0
for (let y = 0; y < SIZE; y++) {
  raw[cursor++] = 0
  for (let x = 0; x < SIZE; x++) {
    const index = y * SIZE + x
    const weight = cov[index] || 1
    // 颜色按 coverage 加权平均；alpha 用平均覆盖度 → 边缘自然半透明
    raw[cursor++] = Math.round(acc[index * 4 + 0] / weight)
    raw[cursor++] = Math.round(acc[index * 4 + 1] / weight)
    raw[cursor++] = Math.round(acc[index * 4 + 2] / weight)
    raw[cursor++] = Math.round((cov[index] / (SS * SS)) * 255)
  }
}

/* ---------------------------- PNG 封装 ---------------------------- */

const crcTable = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0) // width
ihdr.writeUInt32BE(SIZE, 4) // height
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type：RGBA
ihdr[10] = 0 // compression：deflate
ihdr[11] = 0 // filter：adaptive
ihdr[12] = 0 // interlace：none

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

fs.mkdirSync(path.dirname(TARGET), { recursive: true })
fs.writeFileSync(TARGET, png)
console.log(`[tray-icon] 已生成 ${TARGET}（${SIZE}×${SIZE} RGBA，${png.length} bytes）`)
