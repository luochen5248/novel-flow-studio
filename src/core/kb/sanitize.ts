/**
 * 知识库脏数据兜底（照 src/core/storage.ts 的 sanitizeGraph 哲学：
 * 任何脏数据都不应让界面白屏）。
 *
 * 使用场景：IndexedDB 降级态（浏览器开发态没有主进程校验）、
 * import-all / import-memories 的 JSON 回灌、以及 IPC 返回的防御性收敛。
 * 所有函数入参 unknown、出参合法契约对象或 null。
 */
import type {
  DocAnchor,
  DocFormat,
  KbDocument,
  KnowledgeEntry,
  KnowledgeType,
  MemoryEntry,
  MemorySource,
  MemoryType
} from './types'

const ENTRY_TYPES: KnowledgeType[] = ['note', 'setting', 'character', 'plot', 'style']
const MEMORY_TYPES: MemoryType[] = ['preference', 'fact', 'decision', 'background']
const MEMORY_SOURCES: MemorySource[] = ['manual', 'assist', 'auto']
const DOC_FORMATS: DocFormat[] = ['md', 'txt', 'docx']

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

export function sanitizeEntry(raw: unknown): KnowledgeEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  const title = str(r.title).trim()
  if (!title) return null
  const ts = Date.now()
  return {
    id: r.id,
    title,
    type: ENTRY_TYPES.includes(r.type as KnowledgeType) ? (r.type as KnowledgeType) : 'note',
    content: str(r.content),
    tags: strArray(r.tags).map((t) => t.trim()).filter(Boolean),
    createdAt: num(r.createdAt, ts),
    updatedAt: num(r.updatedAt, ts)
  }
}

export function sanitizeDoc(raw: unknown): KbDocument | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  const ts = Date.now()
  const doc: KbDocument = {
    id: r.id,
    title: str(r.title).trim() || '未命名文档',
    format: DOC_FORMATS.includes(r.format as DocFormat) ? (r.format as DocFormat) : 'md',
    createdAt: num(r.createdAt, ts),
    updatedAt: num(r.updatedAt, ts)
  }
  // content 可选：列表通道刻意不带，只有 getDoc / 编辑器才需要
  if (typeof r.content === 'string') doc.content = r.content
  return doc
}

export function sanitizeAnchor(raw: unknown): DocAnchor | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  if (typeof r.docId !== 'string' || !r.docId) return null
  if (typeof r.quote !== 'string' || !r.quote) return null
  const start = Math.max(0, Math.trunc(num(r.startOffset, 0)))
  const end = Math.max(start, Math.trunc(num(r.endOffset, start)))
  return {
    id: r.id,
    docId: r.docId,
    nodeId: typeof r.nodeId === 'string' && r.nodeId ? r.nodeId : null,
    quote: r.quote,
    startOffset: start,
    endOffset: end,
    note: str(r.note),
    createdAt: num(r.createdAt, Date.now())
  }
}

export function sanitizeMemory(raw: unknown): MemoryEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  const content = str(r.content).trim()
  if (!content) return null
  const ts = Date.now()
  return {
    id: r.id,
    type: MEMORY_TYPES.includes(r.type as MemoryType) ? (r.type as MemoryType) : 'fact',
    content,
    source: MEMORY_SOURCES.includes(r.source as MemorySource) ? (r.source as MemorySource) : 'manual',
    pinned: r.pinned === true,
    createdAt: num(r.createdAt, ts),
    updatedAt: num(r.updatedAt, ts)
  }
}

/** 标签输入收敛：trim + 去重 + 滤空（UI 与 IPC 两侧共用同一口径） */
export function normalizeTags(raw: unknown): string[] {
  return [...new Set(strArray(raw).map((t) => t.trim()).filter(Boolean))]
}
