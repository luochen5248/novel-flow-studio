/**
 * NovelFlow Studio · .docx 纯文本抽取（electron/kb/docx.cjs）
 *
 * 为什么手写而不引第三方库：.docx 本质是 ZIP（本地头 PK\x03\x04 / 中央目录
 * PK\x01\x02 / EOCD PK\x05\x06），正文在 word/document.xml，条目多为 raw
 * deflate —— Node 内置 zlib.inflateRawSync 直接能解。为一个「只抽纯文本」
 * 的需求引 jszip / mammoth 会把打包体积和依赖面白白扩大（Q9 方案评估）。
 *
 * v1 只抽纯文本：段落 w:p → 换行、w:tab → 制表符、w:br/w:cr → 换行、
 * w:t 内容拼接，XML 实体反转。加粗 / 标题层级 / 表格结构一律丢弃。
 *
 * 边界坑与对策（都转成中文错误引导用户转存 md/txt，绝不静默出错）：
 *  - zip64（EOCD 定位器 PK\x06\x07 或字段饱和值）→ 明确报错；
 *  - 加密 zip（通用位 bit0）→ 提示去除密码；
 *  - 数据描述符（bit3）→ 用中央目录里的压缩尺寸，不受本地头影响；
 *  - word/document.xml 缺失 / 解压失败 → 引导另存为 .md / .txt。
 */
'use strict'

const zlib = require('node:zlib')

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50
const ZIP64_LOC_SIG = 0x07064b50

/** EOCD 定长 22 字节 + 最长 65535 注释；向前扫的范围上限 */
const MAX_EOCD_SCAN = 22 + 0xffff

function u16(buf, offset) {
  return buf.readUInt16LE(offset)
}

function u32(buf, offset) {
  return buf.readUInt32LE(offset)
}

/** 反向扫 EOCD：zip 写入工具会在注释里塞任意字节，只能从尾部反扫签名 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - MAX_EOCD_SCAN)
  for (let i = buf.length - 22; i >= min; i--) {
    if (u32(buf, i) === EOCD_SIG) return i
  }
  return -1
}

/** 中央目录里定位 word/document.xml：拿压缩方法 / 尺寸 / 本地头偏移 */
function findDocumentEntry(buf, eocdOffset) {
  const total = u16(buf, eocdOffset + 10)
  let cdOffset = u32(buf, eocdOffset + 16)
  // zip64 探测：条目数或中央目录偏移出现饱和值 ⇒ 本实现不支持
  if (total === 0xffff || cdOffset === 0xffffffff) {
    throw new Error('文档过大（zip64 格式），暂不支持，请在 Word 里另存为 .md 或 .txt 后重试')
  }
  // EOCD 里记录的中央目录偏移不可信时（允许注释导致的扫描偏差已在 findEocd 处理），
  // 这里直接按签名正序遍历，遇到非中央目录签名即停
  for (let i = 0; i < total; i++) {
    if (cdOffset + 46 > buf.length || u32(buf, cdOffset) !== CEN_SIG) break
    const flags = u16(buf, cdOffset + 8)
    const method = u16(buf, cdOffset + 10)
    const compressedSize = u32(buf, cdOffset + 20)
    const nameLen = u16(buf, cdOffset + 28)
    const extraLen = u16(buf, cdOffset + 30)
    const commentLen = u16(buf, cdOffset + 32)
    const localOffset = u32(buf, cdOffset + 42)
    const name = buf.toString('utf-8', cdOffset + 46, cdOffset + 46 + nameLen)
    if (name === 'word/document.xml') {
      if (flags & 0x0001) {
        throw new Error('这是加密文档，请先去除密码后重试')
      }
      if (method !== 0 && method !== 8) {
        throw new Error('文档用了不支持的压缩方式，请另存为 .md 或 .txt 后重试')
      }
      return { method, compressedSize, localOffset }
    }
    cdOffset += 46 + nameLen + extraLen + commentLen
  }
  throw new Error('这个 .docx 里找不到正文（word/document.xml），请另存为 .md 或 .txt 后重试')
}

/** 本地头定位数据区：30 字节定长 + 文件名 + extra；尺寸用中央目录的（防 bit3 数据描述符） */
function readEntryData(buf, entry) {
  const loc = entry.localOffset
  if (loc + 30 > buf.length || u32(buf, loc) !== LOC_SIG) {
    throw new Error('这个 .docx 的内部结构损坏（本地头识别失败），请另存为 .md 或 .txt 后重试')
  }
  const nameLen = u16(buf, loc + 26)
  const extraLen = u16(buf, loc + 28)
  const start = loc + 30 + nameLen + extraLen
  const end = start + entry.compressedSize
  if (end > buf.length) {
    throw new Error('这个 .docx 的内部结构损坏（正文数据越界），请另存为 .md 或 .txt 后重试')
  }
  const slice = buf.subarray(start, end)
  if (entry.method === 0) return slice.toString('utf-8')
  try {
    return zlib.inflateRawSync(slice).toString('utf-8')
  } catch {
    throw new Error('文档正文解压失败，文件可能损坏，请另存为 .md 或 .txt 后重试')
  }
}

/** XML 实体反转（含十进制 / 十六进制数字实体） */
function decodeXmlEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match
    }
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    return named[body] ?? match
  })
}

/**
 * document.xml → 纯文本。
 * 单遍扫描五类 token（w:t 内容 / w:tab / w:br,w:cr / w:p 自闭合空段 /
 * w:p 闭合），不做「先替换标签再剥标签」的两步处理 —— 那样会把 w:t 里的
 * 文本和 w:pPr 里的属性混在一起反复反转实体，容易双重解码。
 * 段落边界才产换行；w:t 是段内 run，直接拼接。
 */
function extractText(xml) {
  const TOKEN =
    /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/?>|<w:br\s*\/?>|<w:cr\s*\/?>|<w:p(?:\s[^>]*)?\/>|<\/w:p\s*>/g
  const out = []
  let match
  while ((match = TOKEN.exec(xml)) !== null) {
    if (match[1] !== undefined) out.push(decodeXmlEntities(match[1]))
    else if (match[0].startsWith('<w:tab')) out.push('\t')
    else if (match[0].startsWith('<w:br') || match[0].startsWith('<w:cr')) out.push('\n')
    else out.push('\n') // w:p 段落边界（含自闭合空段）→ 换行
  }
  // 末尾补一个换行，避免最后一段与后续拼接粘连；\r\n 归一为 \n
  // （存储内容的偏移量与 relocateAnchor 的归一化前提保持一致）
  return `${out.join('').replace(/\r\n?/g, '\n')}\n`
}

/**
 * 抽取 .docx 纯文本。
 * @param {Buffer} buffer .docx 文件字节
 * @returns {string} 纯文本（\r\n 已归一为 \n，偏移量与存储内容一致）
 */
function extractDocxText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    throw new Error('这个 .docx 文件是空的或已损坏')
  }
  // zip64 定位器（PK\x06\x07）出现在尾部 ⇒ 明确报错，不猜
  const tailStart = Math.max(0, buffer.length - MAX_EOCD_SCAN)
  const locator = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]), tailStart)
  if (locator >= 0) {
    throw new Error('文档过大（zip64 格式），暂不支持，请在 Word 里另存为 .md 或 .txt 后重试')
  }
  const eocd = findEocd(buffer)
  if (eocd < 0) {
    throw new Error('这个文件不是有效的 .docx（ZIP 结构识别失败），请另存为 .md 或 .txt 后重试')
  }
  const entry = findDocumentEntry(buffer, eocd)
  const xml = readEntryData(buffer, entry)
  if (!xml.includes('<w:body')) {
    throw new Error('文档正文结构异常（找不到 w:body），请另存为 .md 或 .txt 后重试')
  }
  return extractText(xml)
}

module.exports = { extractDocxText }
