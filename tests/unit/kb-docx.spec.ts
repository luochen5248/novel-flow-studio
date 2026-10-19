/**
 * kb-docx.spec.ts —— .docx 纯文本抽取单测（electron/kb/docx.cjs）
 *
 * 背景：docx.cjs 是纯 CJS（只用 node 内置 zlib/buffer，无 electron 依赖），
 * 自 task-002 起只靠主进程冒烟、无单测覆盖（VicUI 当时用 /tmp 临时脚本
 * 验证了 10 条断言）。本文件把那些冒烟固化为可持续回归的单测。
 *
 * 覆盖（对照调查报告与实现报告点名的边界）：
 *  - w:t 跨 run 拼接 / w:p 段落分段（含空段保留）/ w:tab / w:br / w:cr
 *  - XML 实体反转：命名 / 十进制 / 十六进制 / 未知实体 / 零码点 /
 *    双重解码防护 / 天文平面码点 / 越界码点守卫（E15–E17）
 *  - 中文正文；尾部垃圾字节（EOCD 反扫）；EOCD 注释；
 *    stored(method 0) / bit3 数据描述符
 *  - 异常路径：空/过短/非 Buffer、非 ZIP、缺 word/document.xml、解压失败、
 *    加密、不支持的压缩方法、zip64（定位器 / 饱和字段）、本地头损坏、
 *    数据越界、缺 w:body —— 全部按 docx.cjs 当前真实行为断言（消息文本
 *    以源码 docx.cjs 为准，非臆想）
 *
 * fixture 说明：用 node 内置 zlib.deflateRawSync 在内存造最小合法 .docx
 * （本地头 PK\x03\x04 + 中央目录 PK\x01\x02 + EOCD PK\x05\x06），
 * 不引 jszip / mammoth —— 与 docx.cjs「零依赖手写 ZIP」的取舍保持一致。
 * docx.cjs 对 XML 是正则扫描（非 DOM 解析），因此 fixture 里的实体按
 * 「原始字节」书写即可（如想测 &amp; 反转，XML 里就写 &amp;）。
 */
import { describe, it, expect } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { extractDocxText } = require('../../electron/kb/docx.cjs')

/* ---------- fixture：内存造最小合法 .docx ---------- */

const LOC_SIG = 0x04034b50 // PK\x03\x04 本地头
const CEN_SIG = 0x02014b50 // PK\x01\x02 中央目录
const EOCD_SIG = 0x06054b50 // PK\x05\x06 中央目录结尾

interface DocxFile {
  name: string
  data: Buffer
  /** 压缩方法：8 = deflate（默认）/ 0 = stored / 其他值造「不支持」场景 */
  method?: number
  /** 通用位标记（bit0 = 加密 / bit3 = 数据描述符） */
  flags?: number
  /** 模拟 bit3 数据描述符：本地头尺寸字段清零（中央目录仍写真实尺寸） */
  localSizesZero?: boolean
  /** 直接指定落盘的压缩字节（跳过 deflate，用于造「解压失败」场景） */
  rawPayload?: Buffer
  /** 覆盖中央目录里的 compressedSize（造「数据越界」场景） */
  cdCompressedSize?: number
  /** 覆盖中央目录里的本地头偏移（造「本地头损坏」场景） */
  cdLocalOffset?: number
}

interface DocxBuildOpts {
  /** EOCD 之后附着的垃圾字节（验证反扫定位） */
  trailingGarbage?: Buffer
  /** EOCD 注释（zip 写入工具会在注释里塞任意字节） */
  eocdComment?: Buffer
  /** 覆盖 EOCD 总条目数（造 zip64 饱和字段场景） */
  eocdTotal?: number
}

function buildDocx(files: DocxFile[], opts: DocxBuildOpts = {}): Buffer {
  const locals: Buffer[] = []
  const cds: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const nameB = Buffer.from(f.name, 'utf-8')
    const method = f.method ?? 8
    const flags = f.flags ?? 0
    const payload = f.rawPayload ?? (method === 0 ? f.data : deflateRawSync(f.data))

    const loc = Buffer.alloc(30)
    loc.writeUInt32LE(LOC_SIG, 0)
    loc.writeUInt16LE(20, 4) // version needed
    loc.writeUInt16LE(flags, 6)
    loc.writeUInt16LE(method, 8)
    loc.writeUInt32LE(0, 14) // crc32：docx.cjs 不校验，写 0
    loc.writeUInt32LE(f.localSizesZero ? 0 : payload.length, 18)
    loc.writeUInt32LE(0, 22) // 未压缩尺寸：docx.cjs 不用，写 0
    loc.writeUInt16LE(nameB.length, 26)
    loc.writeUInt16LE(0, 28) // extra len
    locals.push(loc, nameB, payload)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(CEN_SIG, 0)
    cd.writeUInt16LE(20, 4) // version made by
    cd.writeUInt16LE(20, 6) // version needed
    cd.writeUInt16LE(flags, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(0, 16) // crc32
    cd.writeUInt32LE(f.cdCompressedSize ?? payload.length, 20)
    cd.writeUInt32LE(0, 24) // 未压缩尺寸
    cd.writeUInt16LE(nameB.length, 28)
    cd.writeUInt16LE(0, 30) // extra len
    cd.writeUInt16LE(0, 32) // comment len
    cd.writeUInt32LE(f.cdLocalOffset ?? offset, 42)
    cds.push(cd, nameB)

    offset += loc.length + nameB.length + payload.length
  }
  const cdStart = offset
  const cdSize = cds.reduce((sum, c) => sum + c.length, 0)
  const comment = opts.eocdComment ?? Buffer.alloc(0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(files.length, 8) // 本盘条目数
  eocd.writeUInt16LE(opts.eocdTotal ?? files.length, 10) // 总条目数
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(cdStart, 16)
  eocd.writeUInt16LE(comment.length, 20)
  const garbage = opts.trailingGarbage ?? Buffer.alloc(0)
  return Buffer.concat([...locals, ...cds, eocd, comment, garbage])
}

/** 包一层 <w:document><w:body>，模拟 word/document.xml */
function documentXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
}

/** 快捷造「只含 word/document.xml」的 .docx */
function docxWithBody(bodyXml: string, fileOpts: Omit<DocxFile, 'name' | 'data'> = {}): Buffer {
  return buildDocx([
    { name: 'word/document.xml', data: Buffer.from(documentXml(bodyXml), 'utf-8'), ...fileOpts }
  ])
}

/* ---------- 用例 ---------- */

describe('模块导出契约', () => {
  it('A1 只导出 extractDocxText 一个函数', () => {
    // decodeXmlEntities / extractText 等辅助函数未导出，只能经公开 API 间接覆盖
    expect(Object.keys(require('../../electron/kb/docx.cjs')).sort()).toEqual(['extractDocxText'])
    expect(typeof extractDocxText).toBe('function')
  })
})

describe('正常路径 · w:t 拼接与 w:p 分段', () => {
  it('D1 单段落单 run：原文输出且以换行结尾', () => {
    expect(extractDocxText(docxWithBody('<w:p><w:r><w:t>雨夜初遇</w:t></w:r></w:p>'))).toBe('雨夜初遇\n\n')
  })

  it('D2 同段多个 run：w:t 内容连续拼接无分隔', () => {
    const xml =
      '<w:p><w:r><w:t>第一章</w:t></w:r><w:r><w:t>雨夜</w:t></w:r><w:r><w:t>初遇</w:t></w:r></w:p>'
    expect(extractDocxText(docxWithBody(xml))).toBe('第一章雨夜初遇\n\n')
  })

  it('D3 w:t 带属性（xml:space="preserve"）同样抽取，两端空格保留', () => {
    expect(extractDocxText(docxWithBody('<w:p><w:t xml:space="preserve"> 前后空格 </w:t></w:p>'))).toBe(
      ' 前后空格 \n\n'
    )
  })

  it('D4 多段落：每个 w:p 闭合产一个换行', () => {
    const xml = '<w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p>'
    expect(extractDocxText(docxWithBody(xml))).toBe('第一段\n第二段\n\n')
  })

  it('D5 空段落（w:p 自闭合）保留为空行', () => {
    const xml =
      '<w:p><w:r><w:t>前</w:t></w:r></w:p><w:p/><w:p/><w:p><w:r><w:t>后</w:t></w:r></w:p>'
    expect(extractDocxText(docxWithBody(xml))).toBe('前\n\n\n后\n\n')
  })

  it('D6 w:tab 转制表符', () => {
    expect(extractDocxText(docxWithBody('<w:p><w:r><w:t>甲</w:t><w:tab/><w:t>乙</w:t></w:r></w:p>'))).toBe(
      '甲\t乙\n\n'
    )
  })

  it('D7 w:br / w:cr 转换行', () => {
    const xml = '<w:p><w:r><w:t>甲</w:t><w:br/><w:t>乙</w:t><w:cr/><w:t>丙</w:t></w:r></w:p>'
    expect(extractDocxText(docxWithBody(xml))).toBe('甲\n乙\n丙\n\n')
  })

  it('D8 w:tab / w:br / w:cr 的「空格 + 斜杠」变体也识别', () => {
    // 段尾 <w:cr/> 的换行 + </w:p> 的换行 + 末尾补齐换行，共 3 个
    const xml = '<w:p><w:r><w:t>甲</w:t><w:tab /><w:t>乙</w:t><w:br /><w:t>丙</w:t><w:cr /></w:r></w:p>'
    expect(extractDocxText(docxWithBody(xml))).toBe('甲\t乙\n丙\n\n\n')
  })

  it('D9 w:t 内的 \\r\\n 与孤立 \\r 归一为 \\n', () => {
    const xml = '<w:p><w:r><w:t>甲\r\n乙</w:t></w:r><w:r><w:t>丙\r丁</w:t></w:r></w:p>'
    expect(extractDocxText(docxWithBody(xml))).toBe('甲\n乙丙\n丁\n\n')
  })

  it('D10 段落属性（w:pPr）不泄漏文本、不产生伪换行', () => {
    const xml =
      '<w:p><w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr><w:jc w:val="center"/><w:ind w:firstLine="200"/></w:pPr><w:r><w:t>正文</w:t></w:r></w:p>'
    expect(extractDocxText(docxWithBody(xml))).toBe('正文\n\n')
  })

  it('D11 空 body（无任何 token）：只返回一个换行', () => {
    expect(extractDocxText(docxWithBody(''))).toBe('\n')
  })

  it('D12 中文正文：多段 + 多 run + 空段 + tab 的完整输出', () => {
    const xml =
      '<w:p><w:r><w:t>第一章 · 雨夜</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>林深见鹿，</w:t></w:r><w:r><w:t>海蓝见鲸。</w:t></w:r></w:p>' +
      '<w:p/>' +
      '<w:p><w:r><w:t>路转见星，</w:t><w:tab/><w:t>雾散见你。</w:t></w:r></w:p>'
    expect(extractDocxText(docxWithBody(xml))).toBe(
      '第一章 · 雨夜\n林深见鹿，海蓝见鲸。\n\n路转见星，\t雾散见你。\n\n'
    )
  })
})

describe('XML 实体反转', () => {
  it('E1 命名实体 &amp; 反转', () => {
    expect(extractDocxText(docxWithBody('<w:p><w:t>&amp;</w:t></w:p>'))).toBe('&\n\n')
  })

  it('E2 命名实体 &lt; 反转', () => {
    expect(extractDocxText(docxWithBody('<w:p><w:t>&lt;</w:t></w:p>'))).toBe('<\n\n')
  })

  it('E3 命名实体 &gt; 反转', () => {
    expect(extractDocxText(docxWithBody('<w:p><w:t>&gt;</w:t></w:p>'))).toBe('>\n\n')
  })

  it('E4 命名实体 &quot; 反转', () => {
    expect(extractDocxText(docxWithBody('<w:p><w:t>&quot;</w:t></w:p>'))).toBe('"\n\n')
  })

  it('E5 命名实体 &apos; 反转', () => {
    expect(extractDocxText(docxWithBody('<w:p><w:t>&apos;</w:t></w:p>'))).toBe("'\n\n")
  })

  it('E6 十进制实体 &#20013; 转为「中」', () => {
    expect(extractDocxText(docxWithBody('<w:p><w:t>&#20013;</w:t></w:p>'))).toBe('中\n\n')
  })

  it('E7 十六进制实体 &#x56FD;（小写 x）转为「国」', () => {
    expect(extractDocxText(docxWithBody('<w:p><w:t>&#x56FD;</w:t></w:p>'))).toBe('国\n\n')
  })

  it('E8 十六进制实体大写数字 &#x4E2D; 转为「中」', () => {
    expect(extractDocxText(docxWithBody('<w:p><w:t>&#x4E2D;</w:t></w:p>'))).toBe('中\n\n')
  })

  it('E9 未知命名实体（&nbsp; / &copy;）原样保留', () => {
    expect(extractDocxText(docxWithBody('<w:p><w:t>&nbsp;&copy;</w:t></w:p>'))).toBe('&nbsp;&copy;\n\n')
  })

  it('E10 零码点 &#0; 原样保留（code > 0 守卫）', () => {
    expect(extractDocxText(docxWithBody('<w:p><w:t>&#0;</w:t></w:p>'))).toBe('&#0;\n\n')
  })

  it('E11 大写 X 的 &#X42; 不匹配实体语法，原样保留', () => {
    // 源码 body[1] === 'X' 分支实际不可达（正则只产生小写 x），此处如实记录现状
    expect(extractDocxText(docxWithBody('<w:p><w:t>&#X42;</w:t></w:p>'))).toBe('&#X42;\n\n')
  })

  it('E12 天文平面码点 &#x1F600; 转为 emoji', () => {
    expect(extractDocxText(docxWithBody('<w:p><w:t>&#x1F600;</w:t></w:p>'))).toBe('\u{1F600}\n\n')
  })

  it('E13 双重解码防护：&amp;lt; 只解一层得字面 &lt;，不会变成 <', () => {
    expect(extractDocxText(docxWithBody('<w:p><w:t>&amp;lt;</w:t></w:p>'))).toBe('&lt;\n\n')
  })

  it('E14 实体混排：命名 + 十进制 + 十六进制 + 未知，一次全部按规则处理', () => {
    const xml = '<w:p><w:t>&amp;&lt;&gt;&quot;&apos;|&#20013;|&#x56FD;|&nbsp;</w:t></w:p>'
    expect(extractDocxText(docxWithBody(xml))).toBe('&<>"\'|中|国|&nbsp;\n\n')
  })

  it('E15 越界码点 &#x110000;：原样保留实体文本（MaxPerf 守卫修复后翻转）', () => {
    // 历史：修复前 String.fromCodePoint(1114112) 抛未捕获 RangeError，击穿中文
    // 错误引导（见 tester-report.md §5-1）。MaxPerf 加 code <= 0x10FFFF 守卫后，
    // 越界码点与未知实体同哲学——原样保留。本用例跟随真实行为翻转。
    expect(extractDocxText(docxWithBody('<w:p><w:t>&#x110000;</w:t></w:p>'))).toBe('&#x110000;\n\n')
  })

  it('E16 越界码点十进制变体 &#1114112;（=0x110000）：同样原样保留', () => {
    expect(extractDocxText(docxWithBody('<w:p><w:t>&#1114112;</w:t></w:p>'))).toBe('&#1114112;\n\n')
  })

  it('E17 合法上边界 &#x10FFFF;：正常解码为 U+10FFFF，守卫不误伤', () => {
    expect(extractDocxText(docxWithBody('<w:p><w:t>&#x10FFFF;</w:t></w:p>'))).toBe(
      `${String.fromCodePoint(0x10ffff)}\n\n`
    )
  })
})

describe('ZIP 结构 · 正常路径', () => {
  it('Z1 stored（method 0）不压缩直接读取', () => {
    expect(extractDocxText(docxWithBody('<w:p><w:t>stored</w:t></w:p>', { method: 0 }))).toBe('stored\n\n')
  })

  it('Z2 bit3 数据描述符：本地头尺寸清零时仍用中央目录尺寸解出', () => {
    expect(
      extractDocxText(docxWithBody('<w:p><w:t>bit3</w:t></w:p>', { flags: 0x0008, localSizesZero: true }))
    ).toBe('bit3\n\n')
  })

  it('Z3 尾部 3KB 垃圾字节：EOCD 反扫定位，抽取不受影响', () => {
    const buf = buildDocx(
      [{ name: 'word/document.xml', data: Buffer.from(documentXml('<w:p><w:t>反扫</w:t></w:p>'), 'utf-8') }],
      { trailingGarbage: Buffer.alloc(3000, 0x58) } // 0x58 = 'X'，不含任何 PK 签名
    )
    expect(extractDocxText(buf)).toBe('反扫\n\n')
  })

  it('Z4 EOCD 带 512B 注释：反扫跳过注释定位 EOCD', () => {
    const buf = buildDocx(
      [{ name: 'word/document.xml', data: Buffer.from(documentXml('<w:p><w:t>带注释</w:t></w:p>'), 'utf-8') }],
      { eocdComment: Buffer.alloc(512, 0x43) } // 0x43 = 'C'
    )
    expect(extractDocxText(buf)).toBe('带注释\n\n')
  })

  it('Z5 多文件 zip：只抽取 word/document.xml，忽略其余条目', () => {
    const buf = buildDocx([
      { name: '[Content_Types].xml', data: Buffer.from('<Types xmlns="ct"/>', 'utf-8') },
      { name: '_rels/.rels', data: Buffer.from('<Relationships/>', 'utf-8') },
      {
        name: 'word/document.xml',
        data: Buffer.from(documentXml('<w:p><w:t>正文在此</w:t></w:p>'), 'utf-8')
      },
      { name: 'word/styles.xml', data: Buffer.from('<w:styles/>', 'utf-8') }
    ])
    expect(extractDocxText(buf)).toBe('正文在此\n\n')
  })
})

describe('异常路径（按 docx.cjs 真实行为断言）', () => {
  it('X1 空 Buffer：抛「文件是空的或已损坏」', () => {
    expect(() => extractDocxText(Buffer.alloc(0))).toThrow('这个 .docx 文件是空的或已损坏')
  })

  it('X2 不足 4 字节的 Buffer：同样抛「文件是空的或已损坏」', () => {
    expect(() => extractDocxText(Buffer.from('ab'))).toThrow('这个 .docx 文件是空的或已损坏')
  })

  it('X3 非 Buffer 输入（字符串）：抛「文件是空的或已损坏」', () => {
    expect(() => extractDocxText('这不是 Buffer' as unknown as Buffer)).toThrow(
      '这个 .docx 文件是空的或已损坏'
    )
  })

  it('X4 非 ZIP 数据：抛「ZIP 结构识别失败」并引导另存为 md/txt', () => {
    const buf = Buffer.from('这不是 zip 只是一个普通文本文件内容，长度足够超过四个字节', 'utf-8')
    expect(() => extractDocxText(buf)).toThrow(
      '这个文件不是有效的 .docx（ZIP 结构识别失败），请另存为 .md 或 .txt 后重试'
    )
  })

  it('X5 缺 word/document.xml：抛「找不到正文」并引导另存为 md/txt', () => {
    const buf = buildDocx([{ name: '[Content_Types].xml', data: Buffer.from('<Types/>', 'utf-8') }])
    expect(() => extractDocxText(buf)).toThrow(
      '这个 .docx 里找不到正文（word/document.xml），请另存为 .md 或 .txt 后重试'
    )
  })

  it('X6 解压失败（method 8 + 非 deflate 字节）：抛「正文解压失败」', () => {
    const junk = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff])
    const buf = buildDocx([{ name: 'word/document.xml', data: junk, rawPayload: junk, method: 8 }])
    expect(() => extractDocxText(buf)).toThrow(
      '文档正文解压失败，文件可能损坏，请另存为 .md 或 .txt 后重试'
    )
  })

  it('X7 加密文档（通用位 bit0）：抛「请先去除密码」', () => {
    expect(() => extractDocxText(docxWithBody('<w:p><w:t>x</w:t></w:p>', { flags: 0x0001 }))).toThrow(
      '这是加密文档，请先去除密码后重试'
    )
  })

  it('X8 不支持的压缩方法（method 12）：抛错并引导另存为 md/txt', () => {
    expect(() => extractDocxText(docxWithBody('<w:p><w:t>x</w:t></w:p>', { method: 12 }))).toThrow(
      '文档用了不支持的压缩方式，请另存为 .md 或 .txt 后重试'
    )
  })

  it('X9 zip64 定位器（尾部 PK\\x06\\x07）：明确报错暂不支持', () => {
    const buf = buildDocx(
      [{ name: 'word/document.xml', data: Buffer.from(documentXml('<w:p><w:t>x</w:t></w:p>'), 'utf-8') }],
      { trailingGarbage: Buffer.concat([Buffer.from([0x50, 0x4b, 0x06, 0x07]), Buffer.alloc(16)]) }
    )
    expect(() => extractDocxText(buf)).toThrow(
      '文档过大（zip64 格式），暂不支持，请在 Word 里另存为 .md 或 .txt 后重试'
    )
  })

  it('X10 zip64 饱和字段（EOCD 条目数 0xffff）：明确报错暂不支持', () => {
    const buf = buildDocx(
      [{ name: 'word/document.xml', data: Buffer.from(documentXml('<w:p><w:t>x</w:t></w:p>'), 'utf-8') }],
      { eocdTotal: 0xffff }
    )
    expect(() => extractDocxText(buf)).toThrow(
      '文档过大（zip64 格式），暂不支持，请在 Word 里另存为 .md 或 .txt 后重试'
    )
  })

  it('X11 本地头损坏（CD 偏移指向非本地头）：抛「本地头识别失败」', () => {
    expect(() => extractDocxText(docxWithBody('<w:p><w:t>x</w:t></w:p>', { cdLocalOffset: 1 }))).toThrow(
      '这个 .docx 的内部结构损坏（本地头识别失败），请另存为 .md 或 .txt 后重试'
    )
  })

  it('X12 正文数据越界（CD 压缩尺寸超过文件长度）：抛「正文数据越界」', () => {
    expect(() =>
      extractDocxText(docxWithBody('<w:p><w:t>x</w:t></w:p>', { cdCompressedSize: 0x7ffffff0 }))
    ).toThrow('这个 .docx 的内部结构损坏（正文数据越界），请另存为 .md 或 .txt 后重试')
  })

  it('X13 document.xml 缺 w:body：抛「正文结构异常」', () => {
    const buf = buildDocx([
      { name: 'word/document.xml', data: Buffer.from('<w:document xmlns:w="x">oops</w:document>', 'utf-8') }
    ])
    expect(() => extractDocxText(buf)).toThrow(
      '文档正文结构异常（找不到 w:body），请另存为 .md 或 .txt 后重试'
    )
  })
})
