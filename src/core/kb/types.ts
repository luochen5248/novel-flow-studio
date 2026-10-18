/**
 * 知识库数据契约（纯类型，零依赖）。
 *
 * 与主进程 `electron/kb/store.cjs` 的表结构逐字段对齐（id/title/type/…），
 * 渲染层（kbClient / useKbStore / UI）与主进程（IPC）共用这一份形状。
 * 关联关系的事实源在 db（kb_links / doc_links），按 nodeId 反查 ——
 * StoryNode 上**不加** kbLinkIds/docLinkIds 冗余镜像字段（双写必漂移，
 * 且会把知识库态带进 localStorage 工作区 JSON）。
 */

/** 知识条目类型（store.cjs 的 ENTRY_TYPES 白名单一致） */
export type KnowledgeType = 'note' | 'setting' | 'character' | 'plot' | 'style'

/** 作者记忆类型 */
export type MemoryType = 'preference' | 'fact' | 'decision' | 'background'

/** 记忆来源：manual = 作者手写 / assist = AI 结果转存 / auto = 整理升格 */
export type MemorySource = 'manual' | 'assist' | 'auto'

/** 文档格式（v1：md/txt 双端可用，docx 仅桌面态解析） */
export type DocFormat = 'md' | 'txt' | 'docx'

/** 偏好键（preferences 表；两个开关默认 false = 隐私优先） */
export type PrefKey = 'pref.chat_memory' | 'pref.local_memory' | 'pref.work_background'

export interface KnowledgeEntry {
  id: string
  title: string
  type: KnowledgeType
  content: string
  tags: string[]
  createdAt: number
  updatedAt: number
}

/** kb_links 行（条目 ↔ 节点） */
export interface KbLink {
  entryId: string
  nodeId: string
  flowId: string | null
  createdAt: number
}

export interface KbDocument {
  id: string
  title: string
  format: DocFormat
  createdAt: number
  updatedAt: number
  /** 列表通道不带 content（大文本不进列表）；getDoc 才带 */
  content?: string
}

/** doc_links 行（文档 ↔ 节点） */
export interface DocLink {
  docId: string
  nodeId: string
  flowId: string | null
  createdAt: number
}

/** 文档锚点：quote + 偏移量定位文档里的一段（支持模糊重定位） */
export interface DocAnchor {
  id: string
  docId: string
  nodeId: string | null
  quote: string
  startOffset: number
  endOffset: number
  note: string
  createdAt: number
}

/** 作者记忆（注入 AI 提示词的素材） */
export interface MemoryEntry {
  id: string
  type: MemoryType
  content: string
  source: MemorySource
  pinned: boolean
  createdAt: number
  updatedAt: number
}

/** 工作过程事件（过程日志；与 memories 语义分离，不进注入块） */
export interface KbEvent {
  id: number
  kind: string
  refId: string | null
  summary: string
  createdAt: number
}

/* ---------------- 客户端入参（kbClient 方法签名用） ---------------- */

export interface CreateEntryInput {
  title: string
  type?: KnowledgeType
  content?: string
  tags?: string[]
}

export interface UpdateEntryInput {
  title?: string
  type?: KnowledgeType
  content?: string
  tags?: string[]
}

export interface CreateDocInput {
  title: string
  format: DocFormat
  content: string
}

export interface UpdateDocInput {
  title?: string
  content?: string
}

export interface CreateAnchorInput {
  docId: string
  nodeId?: string | null
  quote: string
  startOffset: number
  endOffset: number
  note?: string
}

export interface UpdateAnchorInput {
  nodeId?: string | null
  quote?: string
  startOffset?: number
  endOffset?: number
  note?: string
}

export interface CreateMemoryInput {
  type: MemoryType
  content: string
  source?: MemorySource
  pinned?: boolean
}

export interface UpdateMemoryInput {
  type?: MemoryType
  content?: string
  pinned?: boolean
}

/** 按节点反查的关联结果（NodeInspector「关联」TabPane 用） */
export interface NodeLinks {
  entries: KnowledgeEntry[]
  docs: KbDocument[]
}

/** kb:curate 整理报告 */
export interface CurateReport {
  merged: number
  before: number
  after: number
  byType: Record<string, number>
}
