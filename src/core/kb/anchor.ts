/**
 * 文档锚点模糊重定位（纯函数，零依赖）—— 调查报告 Q12 的签名与算法照抄实现。
 *
 * 场景：作者在文档里划词建了锚点（quote + 偏移量），之后文档被改了几个字 /
 * 前面插了一段 —— 偏移量失效，但 quote 还在。按序短路：
 *   1. 归一化（\r\n → \n）后精确 indexOf；
 *   2. hint ±256 窗口内滑窗，bigram Dice ≥ 0.55（quote 被改一字能兜住）；
 *   3. 无 hint / 窗口失败：以 quote 前 8 字符的所有出现位逐位 Dice 验证；
 *   4. 回落 hint（clamp 后 start < end 才认，score 0.3）；
 *   5. 其余 → none（UI 提示「该段落定位失败，请重新选择」）。
 */

export interface AnchorHint {
  startOffset: number
  endOffset: number
}

export type AnchorConfidence = 'exact' | 'fuzzy' | 'hint' | 'none'

export interface AnchorResolution {
  start: number
  end: number
  confidence: AnchorConfidence
  score: number
}

/** 模糊命中阈值（bigram Dice 系数） */
const FUZZY_THRESHOLD = 0.55
/** hint 窗口半径：偏移量前后各扫 256 字符 */
const HINT_WINDOW = 256
/** 滑窗长度容忍：quote.length ± 25% */
const LENGTH_TOLERANCE = 0.25
/** 无 hint 时用 quote 前 8 字符生成候选位 */
const CANDIDATE_PREFIX = 8
/** 容忍长度扫描只对短 quote 开放（>400 字的选区多轮滑窗成本失控，固定长度足够） */
const TOLERANCE_SCAN_MAX_QUOTE = 400

/** 归一化：\r\n / \r → \n（存储内容在读入时已归一，这里是对脏数据的兜底） */
function normalize(text: string): string {
  return String(text ?? '').replace(/\r\n?/g, '\n')
}

/** bigram 多重集（Dice 系数的交集按重数计） */
function bigrams(text: string): Map<string, number> {
  const map = new Map<string, number>()
  for (let i = 0; i < text.length - 1; i++) {
    const gram = text.slice(i, i + 2)
    map.set(gram, (map.get(gram) ?? 0) + 1)
  }
  return map
}

/** bigram Dice 系数：2·|A∩B| / (|A| + |B|)，对中文逐字滑窗的鲁棒相似度 */
export function diceCoefficient(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a.length > 0 && a === b ? 1 : 0
  const ma = bigrams(a)
  const mb = bigrams(b)
  let intersection = 0
  for (const [gram, count] of ma) {
    const other = mb.get(gram)
    if (other) intersection += Math.min(count, other)
  }
  const total = a.length - 1 + (b.length - 1)
  return total > 0 ? (2 * intersection) / total : 0
}

interface WindowHit {
  start: number
  end: number
  score: number
}

/**
 * 窗口内滑窗找最优模糊命中。
 * 两遍扫描：第一遍固定窗长 = quote.length（覆盖「改一个字」的绝大多数场景，
 * 成本 O(窗口 × quote)）；第一遍不达标才对 ≤400 字的 quote 补一轮 ±25%
 * 容忍长度扫描（覆盖「插入 / 删除一小段」）。
 */
function bestFuzzyIn(window: string, quote: string): WindowHit | null {
  const qLen = quote.length
  if (qLen < 2 || window.length < 2) return null

  const scan = (length: number): WindowHit | null => {
    if (length < 2 || length > window.length) return null
    let best: WindowHit | null = null
    for (let start = 0; start + length <= window.length; start++) {
      const score = diceCoefficient(quote, window.slice(start, start + length))
      if (score >= FUZZY_THRESHOLD && (!best || score > best.score)) {
        best = { start, end: start + length, score }
      }
    }
    return best
  }

  const fixed = scan(qLen)
  if (fixed) return fixed
  if (qLen > TOLERANCE_SCAN_MAX_QUOTE) return null

  const minLen = Math.max(2, Math.floor(qLen * (1 - LENGTH_TOLERANCE)))
  const maxLen = Math.ceil(qLen * (1 + LENGTH_TOLERANCE))
  let best: WindowHit | null = null
  for (let len = minLen; len <= maxLen; len++) {
    if (len === qLen) continue
    const hit = scan(len)
    if (hit && (!best || hit.score > best.score)) best = hit
  }
  return best
}

function validHint(hint?: AnchorHint | null): boolean {
  return (
    !!hint &&
    typeof hint.startOffset === 'number' &&
    Number.isFinite(hint.startOffset) &&
    typeof hint.endOffset === 'number' &&
    Number.isFinite(hint.endOffset)
  )
}

/**
 * 锚点重定位（主入口）。
 * 返回的 start/end 是**归一化后 content** 上的偏移量（存储内容读入时已
 * 归一化 \r\n，两者一致）。
 */
export function relocateAnchor(
  content: string,
  quote: string,
  hint?: AnchorHint | null
): AnchorResolution {
  const text = normalize(content)
  const q = String(quote ?? '').trim()
  if (!q || q.length > text.length) {
    return { start: 0, end: 0, confidence: 'none', score: 0 }
  }

  // 1) 精确命中
  const exact = text.indexOf(q)
  if (exact >= 0) {
    return { start: exact, end: exact + q.length, confidence: 'exact', score: 1 }
  }

  // 2) hint 窗口内模糊
  if (validHint(hint)) {
    const from = Math.max(0, Math.min(text.length, Math.trunc(hint!.startOffset) - HINT_WINDOW))
    const to = Math.max(from, Math.min(text.length, Math.trunc(hint!.endOffset) + HINT_WINDOW))
    const hit = bestFuzzyIn(text.slice(from, to), q)
    if (hit) {
      return { start: from + hit.start, end: from + hit.end, confidence: 'fuzzy', score: hit.score }
    }
  }

  // 3) quote 前 8 字符候选位逐位验证（无 hint / 窗口失败时）
  const prefix = q.slice(0, CANDIDATE_PREFIX)
  if (prefix) {
    let from = 0
    for (;;) {
      const pos = text.indexOf(prefix, from)
      if (pos < 0) break
      const score = diceCoefficient(q, text.slice(pos, pos + q.length))
      if (score >= FUZZY_THRESHOLD) {
        return { start: pos, end: pos + q.length, confidence: 'fuzzy', score }
      }
      from = pos + 1
    }
  }

  // 4) 回落 hint：clamp 到 [0, len] 且 start < end 才认
  if (validHint(hint)) {
    const start = Math.min(Math.max(0, Math.trunc(hint!.startOffset)), text.length)
    const end = Math.min(Math.max(0, Math.trunc(hint!.endOffset)), text.length)
    if (start < end) {
      return { start, end, confidence: 'hint', score: 0.3 }
    }
  }

  return { start: 0, end: 0, confidence: 'none', score: 0 }
}

/** 取展示上下文：以 [start,end) 为中心前后各取 radius 字符，越界补省略号 */
export function sliceAround(
  content: string,
  start: number,
  end: number,
  radius = 120
): string {
  const text = normalize(content)
  const from = Math.max(0, Math.min(text.length, Math.trunc(start) - radius))
  const to = Math.max(from, Math.min(text.length, Math.trunc(end) + radius))
  const prefix = from > 0 ? '……' : ''
  const suffix = to < text.length ? '……' : ''
  return `${prefix}${text.slice(from, to)}${suffix}`
}
