import type { NodeKind } from '@/types/graph'
import { resolveColor } from './constants'

/**
 * 导出层通用文本/几何工具。
 *
 * 全部为纯函数：不触碰 window / document，可在 jsdom 与 Node 下直接单测。
 */

/**
 * XML 属性转义（& < > " ' 五个字符）。
 * drawio XML、SVG 内联文本都必须过这一层，否则一个 & 就能让整个文件打不开。
 */
export function escapeXml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 单个字符的估算宽度（em 倍数）。
 * 中文字宽约 1.0em，西文约 0.55em —— 导出 SVG 无法调用浏览器排版，
 * 只能靠字符宽度估算来手动折行，这是自研渲染的固有代价。
 */
export function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  // CJK 汉字、全角标点、日文假名、韩文
  if (code > 0x2e80) return 1
  if (ch === ' ') return 0.28
  if (/[ilj1.,;:'`|![\](){}]/.test(ch)) return 0.3
  if (/[A-Zmw@%]/.test(ch)) return 0.78
  return 0.55
}

/** 估算一段文本在指定字号下的像素宽度 */
export function estimateTextWidth(text: string, fontSize: number): number {
  let w = 0
  for (const ch of String(text)) w += charWidth(ch) * fontSize
  return w
}

/**
 * 手动折行：按估算宽度切分为多行。
 * @param text 原文
 * @param fontSize 字号（px）
 * @param maxWidth 可用宽度（px）
 * @param maxLines 最大行数，超出则末行加省略号
 */
export function wrapText(
  text: string,
  fontSize: number,
  maxWidth: number,
  maxLines = Infinity
): string[] {
  const clean = String(text ?? '').replace(/\r?\n/g, ' ').trim()
  if (!clean) return []
  if (estimateTextWidth(clean, fontSize) <= maxWidth) return [clean]

  const lines: string[] = []
  let current = ''
  // 只有「真的放不下、被迫丢字」时才补省略号；刚好排满 N 行不能无脑加 …
  let truncated = false
  for (const ch of clean) {
    const next = current + ch
    if (estimateTextWidth(next, fontSize) > maxWidth && current) {
      lines.push(current)
      current = ch
      // 已经到行数上限：剩下的字符丢弃，并标记需要省略号
      if (lines.length >= maxLines) {
        current = ''
        truncated = true
        break
      }
    } else {
      current = next
    }
  }
  if (current && lines.length < maxLines) lines.push(current)

  if (truncated && lines.length === maxLines) {
    // 末行塞省略号：从末尾逐字回退，直到「文字 + …」能放下
    let last = lines[maxLines - 1]
    while (last.length > 1 && estimateTextWidth(last + '…', fontSize) > maxWidth) {
      last = last.slice(0, -1)
    }
    lines[maxLines - 1] = last + '…'
  }
  return lines.filter((l, i) => l !== '' || i === 0)
}

/** 单行截断（用于标题） */
export function truncateToWidth(text: string, fontSize: number, maxWidth: number): string {
  const clean = String(text ?? '').replace(/\r?\n/g, ' ').trim()
  if (!clean || estimateTextWidth(clean, fontSize) <= maxWidth) return clean
  let out = clean
  while (out.length > 1 && estimateTextWidth(out + '…', fontSize) > maxWidth) {
    out = out.slice(0, -1)
  }
  return out + '…'
}

/** 本地 id 生成（导入兜底 / 导出临时标识用，避免依赖运行时 id 模块） */
let seq = 0
export function uid(prefix = 'n'): string {
  seq += 1
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}${rand}`
}

/** 时间戳 → 「2026-10-12 10:30」 */
export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}`
}

/** 文件名安全化：去掉 Windows/macOS 非法字符 */
export function safeFilename(name: string): string {
  return (
    String(name || '未命名')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim() || '未命名'
  )
}

/** 生成导出文件名，如「长夜将尽_20261012-1030.png」 */
export function exportFilename(graphName: string, ext: string): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes()
  )}`
  return `${safeFilename(graphName)}_${stamp}.${ext}`
}

/** 节点的章节/时间徽标文案（三选一兜底） */
export function badgeTextOf(node: {
  timeLabel?: string
  chapter?: string
  kind?: NodeKind
}): string {
  return node.timeLabel || node.chapter || '未标注'
}

/** 取节点主色的 hex（导出专用，运行时 canvas 另有一套 token 解析） */
export function nodeHex(color: string | undefined, kind: NodeKind): string {
  return resolveColor(color, kind)
}
