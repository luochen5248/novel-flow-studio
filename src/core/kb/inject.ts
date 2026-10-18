/**
 * 三路注入组装（纯函数）：作者记忆 / 知识库参考 / 写作依据（文档锚点）。
 *
 * 产出都是**预组装好的纯文本块**，直接喂给 aiPrompt 的 BuildAssistOptions
 * （memory → system 位，kbContext / docContext → user 位）—— 这样
 * aiPrompt.ts 不 import 任何 kb 模块，依赖方向干净。
 *
 * 文案红线：禁出现「检索」「联网」二字（踩 tests/unit/aiPrompt.spec.ts:73-81
 * 的回归线），统一用「参考 / 背景 / 依据 / 偏好」。
 *
 * 预算纪律：三路各自独立预算、独立成块；超限**先砍条数保正文** ——
 * 记忆与知识是增益，节点正文才是本体。
 */
import { relocateAnchor, sliceAround } from './anchor'
import type { DocAnchor, KnowledgeEntry, KnowledgeType, MemoryEntry, MemoryType } from './types'

/** 作者记忆块总预算（含工作背景 + top-N 记忆；Q16 定的 1200） */
export const MEMORY_MAX_CHARS = 1200
/** 知识库参考块预算 */
export const KB_MAX_CHARS = 1000
/** 写作依据块预算 */
export const DOC_MAX_CHARS = 1000

/** 工作背景裁剪上限（保记忆条目的额度） */
const MEMORY_BG_MAX = 400
/** 单条记忆裁剪上限 */
const MEMORY_ITEM_MAX = 200
/** 单条知识条目裁剪上限 */
const KB_ITEM_MAX = 240
/** 单个锚点段裁剪上限 */
const DOC_ITEM_MAX = 240

const KNOWLEDGE_TYPE_LABEL: Record<KnowledgeType, string> = {
  note: '笔记',
  setting: '设定',
  character: '人物',
  plot: '情节',
  style: '风格'
}

const MEMORY_TYPE_LABEL: Record<MemoryType, string> = {
  preference: '偏好',
  fact: '事实',
  decision: '决定',
  background: '背景'
}

function clip(text: string, max: number): string {
  const value = String(text ?? '').trim()
  if (value.length <= max) return value
  return `${value.slice(0, max)}…`
}

/** 超限砍条目：从末尾砍「- 」记忆行，背景行永不被砍；返回是否还有可砍的 */
function trimLines(lines: string[], budget: number): void {
  while (lines.join('\n').length > budget) {
    const idx = lines.map((l) => l.startsWith('- ')).lastIndexOf(true)
    if (idx < 0) break
    lines.splice(idx, 1)
  }
}

/**
 * 作者记忆块（system 位）。
 * @param background 工作背景长文本（pref.work_background）
 * @param memories 记忆列表（调用方按相关度 / pinned 预排序，砍时从末尾砍）
 */
export function buildMemoryBlock(background: string, memories: MemoryEntry[]): string {
  const bg = String(background ?? '').trim()
  const lines: string[] = []
  if (bg) lines.push(`工作背景：${clip(bg, MEMORY_BG_MAX)}`)
  for (const m of memories ?? []) {
    if (!m || typeof m.content !== 'string' || !m.content.trim()) continue
    const label = MEMORY_TYPE_LABEL[m.type] ?? '记忆'
    lines.push(`- ${label}：${clip(m.content, MEMORY_ITEM_MAX)}`)
  }
  if (!lines.length) return ''
  trimLines(lines, MEMORY_MAX_CHARS)
  return ['## 作者记忆', ...lines].join('\n')
}

/** 知识库参考块（user 位，插在「光标选中的片段」之前） */
export function buildKbBlock(entries: KnowledgeEntry[]): string {
  const list = (entries ?? []).filter((e) => e && typeof e.title === 'string' && e.title)
  if (!list.length) return ''
  const lines: string[] = []
  for (const entry of list) {
    const label = KNOWLEDGE_TYPE_LABEL[entry.type] ?? '笔记'
    const tags = entry.tags?.length ? `（标签：${entry.tags.join('、')}）` : ''
    const body = entry.content?.trim() ? `：${clip(entry.content, KB_ITEM_MAX)}` : ''
    lines.push(`- 《${entry.title}》[${label}]${tags}${body}`)
  }
  trimLines(lines, KB_MAX_CHARS)
  if (!lines.length) return ''
  return ['## 知识库参考', ...lines].join('\n')
}

/** 写作依据入参：文档标题 + 文档全文 + 锚点（注入时现定位，防偏移量过期） */
export interface DocSnippetInput {
  docTitle: string
  content: string
  anchor: DocAnchor
}

/**
 * 写作依据块（user 位）：关联文档的锚点段，带文档标题与段落标注。
 * 锚点偏移量失效时先模糊重定位（relocateAnchor）；连模糊都失败才退回
 * quote 原文 —— quote 本身仍是有效的「依据」。
 */
export function buildDocBlock(snippets: DocSnippetInput[]): string {
  const list = (snippets ?? []).filter((s) => s && s.anchor && typeof s.anchor.quote === 'string' && s.anchor.quote)
  if (!list.length) return ''
  const lines: string[] = []
  for (const snippet of list) {
    const resolved = relocateAnchor(snippet.content, snippet.anchor.quote, snippet.anchor)
    const span =
      resolved.confidence === 'none'
        ? clip(snippet.anchor.quote, DOC_ITEM_MAX)
        : clip(sliceAround(snippet.content, resolved.start, resolved.end, 60), DOC_ITEM_MAX)
    lines.push(`- 《${snippet.docTitle}》相关段落：${span}`)
  }
  trimLines(lines, DOC_MAX_CHARS)
  if (!lines.length) return ''
  return ['## 写作依据（文档锚点）', ...lines].join('\n')
}
