/**
 * 生成运行时窗口图标：electron/assets/app-icon.png（256×256）
 *
 * 为什么单独生成一份小的：
 *   package.json 的 build.files 会把整个 electron 目录打进安装包，而
 *   app-icon.png **只服务开发态**（打包后 Windows 的任务栏 / 标题栏用 exe 内嵌图标）。
 *   原先是直接把 build/icon.png 复制过来，1024×1024、700KB+ 白白随每次发布进安装目录。
 *   这里从同一张源图降采样出 256×256：视觉上开发态够用，体积小一个量级。
 *
 *   build/icon.png 保持高分辨率不动 —— electron-builder 要靠它生成多尺寸 .ico。
 *
 * 为什么不引 sharp / pngjs：只想做个降采样，不值得为此加构建期依赖。
 *   本脚本手写 PNG 解码（IHDR / IDAT / IEND + 五种 filter 的逆变换）与编码，
 *   只依赖 node:fs / node:path / node:zlib。
 *
 * 用法（项目根目录执行，Node ≥ 18）：
 *   node scripts/generate-app-icon.cjs                      # build/icon.png → electron/assets/app-icon.png
 *   node scripts/generate-app-icon.cjs <源png> <输出png>     # 显式指定
 *
 * 幂等：同样的源图每次输出同样的字节。
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

/** 输出边长：开发态窗口图标 256 足够（Electron 会自己缩到 16/24/32） */
const OUT_SIZE = 256

const SOURCE = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'build', 'icon.png')
const TARGET = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(__dirname, '..', 'electron', 'assets', 'app-icon.png')

/* ---------------------------- PNG 解码 ---------------------------- */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * 解出 { width, height, bpp, pixels }，pixels 是每行 width*bpp 字节的未过滤行首尾相接。
 * 只覆盖本仓库图标会遇到的形态：8 位深、无隔行、RGB 或 RGBA。
 */
function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('不是 PNG 文件（签名不符）')
  }

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idatParts = []

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idatParts.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }

  if (!width || !height) throw new Error('IHDR 缺失或尺寸为 0')
  if (bitDepth !== 8) throw new Error(`不支持的位深 ${bitDepth}（只处理 8 位）`)
  if (interlace !== 0) throw new Error('不支持隔行扫描的 PNG')
  if (colorType !== 6 && colorType !== 2) {
    throw new Error(`不支持的颜色类型 ${colorType}（只处理 RGB / RGBA）`)
  }

  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  const raw = zlib.inflateSync(Buffer.concat(idatParts))
  const expected = height * (stride + 1)
  if (raw.length !== expected) {
    throw new Error(`IDAT 长度异常：${raw.length} != ${expected}`)
  }

  const out = Buffer.alloc(height * stride)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const rowStart = y * stride
    const prevStart = (y - 1) * stride
    for (let x = 0; x < stride; x++) {
      const value = raw[pos + x]
      const a = x >= bpp ? out[rowStart + x - bpp] : 0
      const b = y > 0 ? out[prevStart + x] : 0
      const c = y > 0 && x >= bpp ? out[prevStart + x - bpp] : 0
      let recon
      switch (filter) {
        case 0:
          recon = value
          break
        case 1:
          recon = value + a
          break
        case 2:
          recon = value + b
          break
        case 3:
          recon = value + ((a + b) >> 1)
          break
        case 4:
          recon = value + paeth(a, b, c)
          break
        default:
          throw new Error(`未知 filter ${filter}（第 ${y} 行）`)
      }
      out[rowStart + x] = recon & 0xff
    }
    pos += stride
  }

  return { width, height, bpp, pixels: out }
}

/* ---------------------------- 盒式降采样 ---------------------------- */

/**
 * 按面积平均缩放。alpha 走预乘累加：直接平均非预乘 RGBA 会让半透明边缘出现
 * 黑边 / 白边，图标缩小后一眼就能看出来。
 */
function boxResize(src, outSize) {
  const { width, height, bpp, pixels } = src
  const out = Buffer.alloc(outSize * outSize * 4)

  for (let y = 0; y < outSize; y++) {
    const y0 = Math.floor((y * height) / outSize)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / outSize))
    for (let x = 0; x < outSize; x++) {
      const x0 = Math.floor((x * width) / outSize)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / outSize))

      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let count = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = sy * width * bpp + sx * bpp
          const alpha = bpp === 4 ? pixels[i + 3] : 255
          r += pixels[i] * alpha
          g += pixels[i + 1] * alpha
          b += pixels[i + 2] * alpha
          a += alpha
          count++
        }
      }

      const o = (y * outSize + x) * 4
      if (a === 0) {
        out[o] = 0
        out[o + 1] = 0
        out[o + 2] = 0
        out[o + 3] = 0
      } else {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
        out[o + 3] = Math.round(a / count)
      }
    }
  }

  return { width: outSize, height: outSize, bpp: 4, pixels: out }
}

/* ---------------------------- PNG 编码 ---------------------------- */

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

function encodePng(image) {
  const { width, height, bpp, pixels } = image
  const stride = width * bpp
  // 每行前置 filter byte 0（None）：小图标不值得上自适应 filter，省事且一定合法
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = bpp === 4 ? 6 : 2
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ---------------------------- 入口 ---------------------------- */

const source = decodePng(fs.readFileSync(SOURCE))
const resized = boxResize(source, OUT_SIZE)
const png = encodePng(resized)

fs.mkdirSync(path.dirname(TARGET), { recursive: true })
fs.writeFileSync(TARGET, png)

const shrink = ((1 - png.length / fs.statSync(SOURCE).size) * 100).toFixed(1)
console.log(
  `[app-icon] ${SOURCE} ${source.width}×${source.height} → ${TARGET} ${resized.width}×${resized.height}，` +
    `${fs.statSync(SOURCE).size} B → ${png.length} B（-${shrink}%）`
)
