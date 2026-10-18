/**
 * 知识库检索相关性精排（纯函数，零依赖）。
 *
 * 为什么精排放渲染层：主进程 store.cjs 的 SQL 只做「标题 / 标签 / 正文
 * LIKE 预筛」（sql.js 官方构建无 FTS5，unicode61 不切中文），加权粗排；
 * 真正的「标题命中 > 标签命中 > 正文命中 + 时间衰减」在这里算 ——
 * 入参出参都是普通数据，Tess 可单测。
 */
import type { KnowledgeEntry } from './types'

/** 节点 → 检索词的来源（结构上兼容 aiPrompt 的 AssistNodeContext，不 import 它） */
export interface NodeQuerySource {
  title?: string
  characters?: string[]
  location?: string
  tags?: string[]
}

export interface RankOptions {
  /** 固定「现在」（单测确定性用；缺省 Date.now()） */
  now?: number
}

/** 字段权重：标题命中 >> 标签命中 > 正文命中（与 store.cjs SQL 里的 3/2/1 同序） */
const WEIGHT = { title: 100, titlePrefix: 20, tag: 60, content: 30, contentExtra: 2 }
/** 内容重复命中的加分上限（防一条长文刷满分） */
const CONTENT_EXTRA_CAP = 10
/** 时间衰减半衰期（天）：半年前的条目得分减半，一年的约 1/3 */
const DECAY_HALF_LIFE_DAYS = 180

/** 把查询串切成词（空白分隔；中文整串即一个词，天然适配） */
function termsOf(query: string): string[] {
  return String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
}

/** 半衰期衰减：updatedAt 越新分越高（知识会过时，但老设定仍有价值，故衰减放缓） */
function timeDecay(updatedAt: number, now: number): number {
  const ageDays = Math.max(0, (now - updatedAt) / 86_400_000)
  return 1 / (1 + ageDays / DECAY_HALF_LIFE_DAYS)
}

/** 单条目的原始分（未乘时间衰减；导出供单测逐字段断言） */
export function scoreEntry(entry: KnowledgeEntry, query: string): number {
  const terms = termsOf(query)
  if (!terms.length) return 0
  const title = entry.title.toLowerCase()
  const tags = entry.tags.map((t) => t.toLowerCase())
  const content = entry.content.toLowerCase()
  let score = 0
  for (const term of terms) {
    if (title.includes(term)) {
      score += WEIGHT.title
      if (title.startsWith(term)) score += WEIGHT.titlePrefix
    }
    if (tags.some((t) => t.includes(term))) score += WEIGHT.tag
    if (content.includes(term)) {
      // 命中次数：第一次满分，之后每次 +2（封顶），长文不至于一条刷爆
      let count = 0
      let from = 0
      while ((from = content.indexOf(term, from)) !== -1) {
        count += 1
        from += term.length
      }
      score += WEIGHT.content + Math.min(CONTENT_EXTRA_CAP, (count - 1) * WEIGHT.contentExtra)
    }
  }
  return score
}

/**
 * 精排 + 排序：按「字段加权分 × 时间衰减」降序，零分条目直接滤掉。
 * 稳定排序：同分保持传入顺序（调用方一般是按更新时间倒序的列表）。
 */
export function rankEntries(
  entries: KnowledgeEntry[],
  query: string,
  options: RankOptions = {}
): KnowledgeEntry[] {
  const now = options.now ?? Date.now()
  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry, query) * timeDecay(entry.updatedAt, now) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((row) => row.entry)
}

/** 节点 → 检索词：标题 + 人物 + 地点 + 标签（与 useAiAssist 的节点上下文同源） */
export function buildNodeQuery(node: NodeQuerySource | null | undefined): string {
  if (!node) return ''
  return [
    node.title,
    ...(Array.isArray(node.characters) ? node.characters : []),
    node.location,
    ...(Array.isArray(node.tags) ? node.tags : [])
  ]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean)
    .join(' ')
}
