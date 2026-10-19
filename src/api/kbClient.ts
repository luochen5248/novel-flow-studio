/**
 * 知识库能力在渲染层的**唯一出口**（仿 aiClient.ts 的分流范式）。
 *
 * 桌面态：`window.electronAPI.kb.*` → IPC → 主进程 sql.js 数据库；
 * 浏览器态：IndexedDB 降层（src/api/kbIdb.ts，手写原生封装）。
 * 两边接口逐对对齐，调用方只 import 本模块，不分辨环境。
 *
 * 错误纪律：桌面态 IPC 返回 `{ok:false}` 一律 throw（与 aiClient 同构），
 * 由调用方决定是弹提示还是静默跳过（AI 注入链选静默，面板 CRUD 弹提示）。
 */
import type { KbApi } from '@/types/ai'
import type { AssistNodeContext } from '@/core/aiPrompt'
import type {
  CreateAnchorInput,
  CreateDocInput,
  CreateEntryInput,
  CreateMemoryInput,
  CurateReport,
  DocAnchor,
  DocFormat,
  KbDocument,
  KbEvent,
  KnowledgeEntry,
  MemoryEntry,
  NodeLinks,
  PrefKey,
  UpdateAnchorInput,
  UpdateDocInput,
  UpdateEntryInput,
  UpdateMemoryInput
} from '@/core/kb/types'
import { buildNodeQuery, rankEntries, type NodeQuerySource } from '@/core/kb/search'
import * as idb from './kbIdb'

/** 浏览器态（无 electronAPI.kb）的统一提示 */
export const KB_BROWSER_HINT = '知识库仅在桌面端可用（浏览器开发模式不支持）'
/** 浏览器态没有向量库（语义索引依赖主进程 sql.js），统一中文提示 */
export const KB_VEC_BROWSER_HINT = '语义检索仅在桌面端可用（浏览器开发模式没有本地向量库）'

/** AI 注入时最多带几条知识条目（注入块另有字符预算，双保险） */
const KB_INJECT_LIMIT = 5
/** 检索词个数上限：节点标题 / 人物 / 地点 / 标签逐个查，防一次 IPC 串太长 */
const KB_TERM_LIMIT = 6

/** 桌面判定（仿 hasAiBridge：读 window.electronAPI?.kb） */
export function hasKbBridge(): boolean {
  if (typeof window === 'undefined') return false
  return !!(window as unknown as { electronAPI?: { kb?: KbApi } }).electronAPI?.kb
}

/**
 * 取桌面桥。刻意用 unknown 再断言：既不依赖 declare global 是否生效，
 * 也不新增第二份全仓 window.electronAPI 全局声明（避免与 types/ai.ts 打架）。
 */
function bridge(): KbApi {
  const api = (window as unknown as { electronAPI?: { kb?: KbApi } }).electronAPI?.kb
  if (!api) throw new Error(KB_BROWSER_HINT)
  return api
}

/** IPC 统一解包：ok === false → throw 中文 error（aiClient 同款纪律） */
function unwrap(result: { ok: boolean; error?: string }, fallback: string): void {
  if (result.ok === false) throw new Error(result.error || fallback)
}

/* ---------------- 知识条目 ---------------- */

export async function listEntries(): Promise<KnowledgeEntry[]> {
  if (!hasKbBridge()) return idb.idbListEntries()
  const r = await bridge().listEntries()
  unwrap(r, '读取知识条目失败')
  return r.entries ?? []
}

export async function createEntry(input: CreateEntryInput): Promise<KnowledgeEntry> {
  if (!hasKbBridge()) return idb.idbCreateEntry(input)
  const r = await bridge().createEntry(input)
  unwrap(r, '新建条目失败')
  return r.entry as KnowledgeEntry
}

/**
 * 更新条目。返回 null 仅出现在浏览器态（条目已不存在）；桌面态对不存在
 * 的 id 直接抛中文错（「条目不存在或已被删除」）—— 陈旧编辑器应该看到
 * 错误而不是静默无操作。
 */
export async function updateEntry(id: string, patch: UpdateEntryInput): Promise<KnowledgeEntry | null> {
  if (!hasKbBridge()) return idb.idbUpdateEntry(id, patch)
  const r = await bridge().updateEntry(id, patch)
  unwrap(r, '更新条目失败')
  return r.entry ?? null
}

export async function removeEntry(id: string): Promise<boolean> {
  if (!hasKbBridge()) return idb.idbRemoveEntry(id)
  const r = await bridge().removeEntry(id)
  unwrap(r, '删除条目失败')
  return true
}

export async function searchEntries(query: string): Promise<KnowledgeEntry[]> {
  if (!hasKbBridge()) return idb.idbSearchEntries(query)
  const r = await bridge().searchEntries(query)
  unwrap(r, '搜索失败')
  return r.entries ?? []
}

/* ---------------- 节点关联 ---------------- */

export async function listLinksForNode(nodeId: string): Promise<NodeLinks> {
  if (!hasKbBridge()) return idb.idbListLinksForNode(nodeId)
  const r = await bridge().listLinksForNode(nodeId)
  unwrap(r, '读取节点关联失败')
  return { entries: r.entries ?? [], docs: r.docs ?? [] }
}

export async function linkEntry(entryId: string, nodeId: string): Promise<boolean> {
  if (!hasKbBridge()) return idb.idbLinkEntry(entryId, nodeId)
  const r = await bridge().linkEntry(entryId, nodeId)
  unwrap(r, '关联失败')
  return true
}

export async function unlinkEntry(entryId: string, nodeId: string): Promise<boolean> {
  if (!hasKbBridge()) return idb.idbUnlinkEntry(entryId, nodeId)
  const r = await bridge().unlinkEntry(entryId, nodeId)
  unwrap(r, '解除关联失败')
  return true
}

export async function linkDoc(docId: string, nodeId: string): Promise<boolean> {
  if (!hasKbBridge()) return idb.idbLinkDoc(docId, nodeId)
  const r = await bridge().linkDoc(docId, nodeId)
  unwrap(r, '关联失败')
  return true
}

export async function unlinkDoc(docId: string, nodeId: string): Promise<boolean> {
  if (!hasKbBridge()) return idb.idbUnlinkDoc(docId, nodeId)
  const r = await bridge().unlinkDoc(docId, nodeId)
  unwrap(r, '解除关联失败')
  return true
}

/* ---------------- 文档 ---------------- */

/** 列表不带 content（大文本不进列表通道） */
export async function listDocs(): Promise<KbDocument[]> {
  if (!hasKbBridge()) return idb.idbListDocs()
  const r = await bridge().listDocs()
  unwrap(r, '读取文档列表失败')
  return r.docs ?? []
}

export async function getDoc(id: string): Promise<KbDocument | null> {
  if (!hasKbBridge()) return idb.idbGetDoc(id)
  const r = await bridge().getDoc(id)
  unwrap(r, '读取文档失败')
  return r.doc ?? null
}

export async function createDoc(input: CreateDocInput): Promise<KbDocument> {
  if (!hasKbBridge()) return idb.idbCreateDoc(input)
  const r = await bridge().createDoc(input)
  unwrap(r, '新建文档失败')
  return r.doc as KbDocument
}

export async function updateDoc(id: string, patch: UpdateDocInput): Promise<KbDocument | null> {
  if (!hasKbBridge()) return idb.idbUpdateDoc(id, patch)
  const r = await bridge().updateDoc(id, patch)
  unwrap(r, '更新文档失败')
  return r.doc ?? null
}

export async function removeDoc(id: string): Promise<boolean> {
  if (!hasKbBridge()) return idb.idbRemoveDoc(id)
  const r = await bridge().removeDoc(id)
  unwrap(r, '删除文档失败')
  return true
}

/** 桌面态两段式第一段：dialog 选文件（浏览器态走隐藏 input，见 KnowledgePanel） */
export async function pickDoc(): Promise<{ canceled: boolean; path?: string }> {
  if (!hasKbBridge()) {
    throw new Error('浏览器态请用上传按钮选择 .md / .txt 文件（.docx 仅桌面端支持解析）')
  }
  const r = await bridge().pickDoc()
  unwrap(r, '选择文件失败')
  return { canceled: r.canceled === true, path: r.path }
}

/** 桌面态两段式第二段：读内容（后缀白名单 + 10MB 上限 + 防目录穿越在主进程） */
export async function readDoc(path: string): Promise<{ title: string; format: DocFormat; content: string }> {
  if (!hasKbBridge()) {
    throw new Error('浏览器态请直接上传 .md / .txt 文件内容')
  }
  const r = await bridge().readDoc(path)
  unwrap(r, '读取文件失败')
  return { title: r.title ?? '', format: (r.format ?? 'md') as DocFormat, content: r.content ?? '' }
}

/* ---------------- 文档锚点 ---------------- */

export async function listAnchors(filter: { docId?: string; nodeId?: string }): Promise<DocAnchor[]> {
  if (!hasKbBridge()) return idb.idbListAnchors(filter)
  const r = await bridge().listAnchors(filter)
  unwrap(r, '读取锚点失败')
  return r.anchors ?? []
}

export async function createAnchor(input: CreateAnchorInput): Promise<DocAnchor> {
  if (!hasKbBridge()) return idb.idbCreateAnchor(input)
  const r = await bridge().createAnchor(input)
  unwrap(r, '新建锚点失败')
  return r.anchor as DocAnchor
}

export async function updateAnchor(id: string, patch: UpdateAnchorInput): Promise<DocAnchor | null> {
  if (!hasKbBridge()) return idb.idbUpdateAnchor(id, patch)
  const r = await bridge().updateAnchor(id, patch)
  unwrap(r, '更新锚点失败')
  return r.anchor ?? null
}

export async function removeAnchor(id: string): Promise<boolean> {
  if (!hasKbBridge()) return idb.idbRemoveAnchor(id)
  const r = await bridge().removeAnchor(id)
  unwrap(r, '删除锚点失败')
  return true
}

/* ---------------- 作者记忆 ---------------- */

export async function listMemories(): Promise<MemoryEntry[]> {
  if (!hasKbBridge()) return idb.idbListMemories()
  const r = await bridge().listMemories()
  unwrap(r, '读取记忆失败')
  return r.memories ?? []
}

export async function createMemory(input: CreateMemoryInput): Promise<MemoryEntry> {
  if (!hasKbBridge()) return idb.idbCreateMemory(input)
  const r = await bridge().createMemory(input)
  unwrap(r, '保存记忆失败')
  return r.memory as MemoryEntry
}

export async function updateMemory(id: string, patch: UpdateMemoryInput): Promise<MemoryEntry | null> {
  if (!hasKbBridge()) return idb.idbUpdateMemory(id, patch)
  const r = await bridge().updateMemory(id, patch)
  unwrap(r, '更新记忆失败')
  return r.memory ?? null
}

export async function removeMemory(id: string): Promise<boolean> {
  if (!hasKbBridge()) return idb.idbRemoveMemory(id)
  const r = await bridge().removeMemory(id)
  unwrap(r, '删除记忆失败')
  return true
}

export async function resetMemories(): Promise<boolean> {
  if (!hasKbBridge()) return idb.idbResetMemories()
  const r = await bridge().resetMemories()
  unwrap(r, '重置记忆失败')
  return true
}

export async function exportMemories(): Promise<string> {
  if (!hasKbBridge()) return idb.idbExportMemories()
  const r = await bridge().exportMemories()
  unwrap(r, '导出记忆失败')
  return r.json ?? ''
}

export async function importMemories(json: string): Promise<number> {
  if (!hasKbBridge()) return idb.idbImportMemories(json)
  const r = await bridge().importMemories(json)
  unwrap(r, '导入记忆失败')
  return r.imported ?? 0
}

/* ---------------- 偏好 ---------------- */

export async function getPreferences(): Promise<Record<string, string>> {
  if (!hasKbBridge()) return idb.idbGetPreferences()
  const r = await bridge().getPreferences()
  unwrap(r, '读取偏好失败')
  return r.preferences ?? {}
}

export async function setPreference(key: PrefKey, value: string): Promise<boolean> {
  if (!hasKbBridge()) return idb.idbSetPreference(key, value)
  const r = await bridge().setPreference(key, value)
  unwrap(r, '保存偏好失败')
  return true
}

/* ---------------- 本地 embedding 配置（复用偏好通道） ---------------- */

/**
 * 本地 embedding 的两个偏好键（与 `electron/main.cjs` 的 `PREF_EMBEDDING_*`
 * 同源；主进程侧键名白名单在 `KB_PREF_KEYS`）。
 *
 * 为什么配置走**偏好**而不是新增 IPC：`src/types/ai.ts` 是「前端禁改」的跨进程
 * 契约红线，preload 不能新增通道；而 `kb:get-preferences` / `kb:set-preference`
 * 早在 task-002 就有类型声明。这是唯一「一个字都不动红线、用户还能在界面里配」
 * 的路径。
 *
 * 维度（dim）刻意不配：由首次 embedding 返回的向量长度自动推断 —— 用户手填容易
 * 错，且换模型就失效。
 */
export const PREF_EMBEDDING_BASE_URL = 'pref.embedding_base_url'
export const PREF_EMBEDDING_MODEL = 'pref.embedding_model'

export interface EmbeddingConfig {
  baseUrl: string
  model: string
}

/** 缺省本机预设（与 `electron/main.cjs` 的 `EMBED_DEFAULT_*` 同源） */
export const EMBEDDING_DEFAULT: EmbeddingConfig = {
  baseUrl: 'http://localhost:11434/v1',
  model: 'nomic-embed-text'
}

/** 读本地 embedding 配置（没配过就回报本机预设，与 main.cjs 同口径） */
export async function getEmbeddingConfig(): Promise<EmbeddingConfig> {
  const prefs = await getPreferences()
  return {
    baseUrl: String(prefs[PREF_EMBEDDING_BASE_URL] ?? '').trim() || EMBEDDING_DEFAULT.baseUrl,
    model: String(prefs[PREF_EMBEDDING_MODEL] ?? '').trim() || EMBEDDING_DEFAULT.model
  }
}

/**
 * 写本地 embedding 配置（只写传进来的字段；端点留空表示恢复本机预设）。
 *
 * 断言说明：这两个键还不在 `PrefKey` 联合类型里（`src/core/kb/types.ts` 不在
 * 本次授权范围），故此处显式断言。安全性不依赖类型 —— 主进程侧有键名白名单 +
 * 环回 hostname 强校验，写外网地址会被中文错误直接挡回。
 */
export async function setEmbeddingConfig(patch: Partial<EmbeddingConfig>): Promise<boolean> {
  const next: Array<[string, string]> = []
  if (typeof patch.baseUrl === 'string') next.push([PREF_EMBEDDING_BASE_URL, patch.baseUrl.trim()])
  if (typeof patch.model === 'string') next.push([PREF_EMBEDDING_MODEL, patch.model.trim()])
  for (const [key, value] of next) {
    await setPreference(key as PrefKey, value)
  }
  return true
}

/* ---------------- 工作过程事件 ---------------- */

export async function listEvents(limit = 100): Promise<KbEvent[]> {
  if (!hasKbBridge()) return idb.idbListEvents()
  const r = await bridge().listEvents(limit)
  unwrap(r, '读取工作日志失败')
  return r.events ?? []
}

export async function logEvent(kind: string, refId: string | null, summary: string): Promise<boolean> {
  if (!hasKbBridge()) return idb.idbLogEvent()
  const r = await bridge().logEvent(kind, refId, summary)
  // 事件是附属品：失败静默（绝不为一条日志打断用户的结构性操作）
  return r.ok !== false
}

export async function curate(): Promise<CurateReport> {
  if (!hasKbBridge()) return idb.idbCurate()
  const r = await bridge().curate()
  unwrap(r, '整理失败')
  return r.report as CurateReport
}

/* ---------------- 全量导入导出 ---------------- */

export async function exportAll(): Promise<string> {
  if (!hasKbBridge()) return idb.idbExportAll()
  const r = await bridge().exportAll()
  unwrap(r, '导出失败')
  return r.json ?? ''
}

export async function importAll(json: string): Promise<{ entries: number; documents: number; memories: number }> {
  if (!hasKbBridge()) return idb.idbImportAll(json)
  const r = await bridge().importAll(json)
  unwrap(r, '导入失败')
  return {
    entries: r.entries ?? 0,
    documents: r.documents ?? 0,
    memories: r.memories ?? 0
  }
}

/* ---------------- 语义检索（向量索引） ---------------- */

/**
 * 语义检索的返回形状。
 *
 * `mode` 是**不能省**的字段：'vector' = 真的走了向量；'keyword' = 已明说降级
 * 到关键词（见 notice）。调用方必须能区分二者 —— 把降级结果伪装成语义结果
 * 是最坏的一种「假成功」。
 */
export interface SemanticSearchResult {
  ok: boolean
  mode?: 'vector' | 'keyword'
  /** 降级 / 提示说明（中文，直接给用户看） */
  notice?: string
  entries?: KnowledgeEntry[]
  /** 命中的文档：向量库不冗余正文，只回 id / 标题 / 分数，正文另走 getDoc */
  docs?: Array<{ id: string; title: string; score: number }>
  error?: string
}

export interface SemanticSearchOptions {
  limit?: number
  /** 相似度下限（-1 ~ 1），缺省由主进程决定 */
  minScore?: number
  /** 限定来源类型，缺省全部 */
  refTypes?: Array<'entry' | 'doc' | 'memory'>
}

export interface KbIndexStatus {
  ok: boolean
  ready?: boolean
  total?: number
  byRefType?: Record<string, number>
  model?: string
  dim?: number
  lastBuiltAt?: number | null
  building?: boolean
  progress?: Record<string, unknown> | null
  lastRebuild?: Record<string, unknown> | null
  embedding?: { baseUrl: string; model: string; ready: boolean; error: string }
  error?: string
}

export interface KbRebuildResult {
  ok: boolean
  started?: boolean
  error?: string
}

/**
 * 语义检索三件套在 preload 上的形状。
 *
 * 为什么不写进 `src/types/ai.ts` 的 `KbApi`：那个文件头注释「前端禁改」是
 * 硬红线（折中方案的代价），跨进程契约里没有这三个方法的签名。所以这里在
 * kbClient 内部做**局部扩展**，字段名与 preload.cjs 新增的三个透传一一对应；
 * 将来 M2 若放开改契约，把这层就地删掉即可，调用方无需变动。
 */
interface KbVecBridge {
  semanticSearch: (query: string, opts?: SemanticSearchOptions) => Promise<SemanticSearchResult>
  indexStatus: () => Promise<KbIndexStatus>
  rebuildIndex: (opts?: { full?: boolean }) => Promise<KbRebuildResult>
}

/** 取语义检索桥；浏览器态明确抛中文提示（绝不静默假成功） */
function vecBridge(): KbVecBridge {
  const api = (window as unknown as { electronAPI?: { kb?: unknown } }).electronAPI?.kb as
    | (KbApi & Partial<KbVecBridge>)
    | undefined
  if (!api?.semanticSearch) throw new Error(KB_VEC_BROWSER_HINT)
  return api as unknown as KbVecBridge
}

/**
 * 语义检索。
 *
 * 降级契约：本地 embedding 未配置 / 服务不可达 / 索引为空时，主进程返回
 * `mode:'keyword'` + 中文 notice，结果就是现有关键词检索的产物。**这里不做
 * 任何「假向量」兜底** —— 哈希 / 关键词向量与语义 embedding 不在同一空间，
 * 混进余弦只会产出看起来有分、实际是噪声的排序。
 */
export async function semanticSearch(
  query: string,
  opts: SemanticSearchOptions = {}
): Promise<SemanticSearchResult> {
  const q = String(query ?? '').trim()
  if (!q) throw new Error('语义检索关键词不能为空')
  const r = await vecBridge().semanticSearch(q, opts)
  unwrap(r, '语义检索失败')
  return {
    ok: true,
    mode: r.mode ?? 'keyword',
    notice: r.notice ?? '',
    entries: r.entries ?? [],
    docs: r.docs ?? []
  }
}

/** 语义索引状态（块数 / 模型 / 维度 / 最近重建 / 本地 embedding 是否就绪） */
export async function indexStatus(): Promise<KbIndexStatus> {
  const r = await vecBridge().indexStatus()
  unwrap(r, '读取语义索引状态失败')
  return r
}

/** 触发后台重建索引（立即返回；进度查 indexStatus） */
export async function rebuildIndex(opts: { full?: boolean } = {}): Promise<KbRebuildResult> {
  const r = await vecBridge().rebuildIndex(opts)
  unwrap(r, '重建语义索引失败')
  return { ok: true, started: r.started === true }
}

/* ---------------- AI 注入便捷方法 ---------------- */

/**
 * 按节点检索知识库（useAiAssist 的注入入口）。
 *
 * 逐个词查而不是拼成长串：LIKE 是子串匹配，「雨夜诀别 林毅」整串一起查
 * 会一条都命中不上。合并去重后交 search.ts 精排，取 top-N。
 * 单个词失败静默跳过（不阻断 AI 主链由调用方兜底）。
 */
export async function searchForNode(
  node: NodeQuerySource | AssistNodeContext | null | undefined
): Promise<KnowledgeEntry[]> {
  const query = buildNodeQuery(node as NodeQuerySource)
  if (!query) return []
  const terms = query.split(/\s+/).filter(Boolean).slice(0, KB_TERM_LIMIT)
  const seen = new Map<string, KnowledgeEntry>()
  for (const term of terms) {
    let hits: KnowledgeEntry[] = []
    try {
      hits = await searchEntries(term)
    } catch {
      continue
    }
    for (const hit of hits) {
      if (!seen.has(hit.id)) seen.set(hit.id, hit)
    }
  }
  if (!seen.size) return []
  return rankEntries([...seen.values()], query).slice(0, KB_INJECT_LIMIT)
}
