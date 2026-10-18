/**
 * AI 能力共享契约 —— 主进程（electron/main.cjs）与渲染层（src/api/aiClient.ts）的唯一事实源
 *
 * 三条铁律：
 *  1. `ModelConfig.apiKey` **只存在于主进程**（内存 + userData/config.json），
 *     任何 IPC 返回都不会带上它；渲染层唯一可见形态是 `ModelView`。
 *  2. 本文件由主进程侧（Max-A）维护，前端只 import，**禁止修改**；两端以此冻结契约。
 *  3. 字段名与 IPC 通道名一一对应（见 `AiApi`），不得擅自更名。
 */

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
  PrefKey,
  UpdateAnchorInput,
  UpdateDocInput,
  UpdateEntryInput,
  UpdateMemoryInput
} from '@/core/kb/types'

/** 协议：openai = OpenAI 兼容（chat/images）；grsai = 私有「提交 + 轮询」 */
export type ModelProtocol = 'openai' | 'grsai'
/** 能力：llm = 对话/文本；image = 生图 */
export type ModelType = 'llm' | 'image'

/** 完整模型配置（含密钥），仅主进程持有 */
export interface ModelConfig {
  id: string
  name: string
  type: ModelType
  protocol: ModelProtocol
  /** https://api.example.com/v1 ；grsai 为 https://grsai.dakka.com.cn */
  baseUrl: string
  /** 仅主进程持有，绝不回传渲染层 */
  apiKey: string
  /** gpt-4o / nano-banana-fast … */
  model: string
  headers?: Record<string, string>
  enabled: boolean
  /** 仅 llm：联网增强（提示词引导模型检索并标注来源） */
  webSearch?: boolean
  /** grsai 内置，不可删除 */
  builtin?: boolean
  createdAt: number
}

/** 渲染层唯一可见形态：脱敏，永不回传完整 apiKey */
export interface ModelView {
  id: string
  name: string
  type: ModelType
  protocol: ModelProtocol
  baseUrl: string
  model: string
  headers?: Record<string, string>
  enabled: boolean
  webSearch?: boolean
  builtin?: boolean
  createdAt: number
  /** 是否已配置密钥 */
  hasKey: boolean
  /** 脱敏提示，如 'sk-…ab12' */
  keyHint: string
}

/** `ai:list-models` 的返回 */
export interface AiModelsPayload {
  models: ModelView[]
  activeIds: { llm: string | null; image: string | null }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatResult {
  ok: boolean
  text?: string
  error?: string
  usage?: { promptTokens?: number; completionTokens?: number }
}

export interface ImageResult {
  ok: boolean
  urls?: string[]
  error?: string
}

export interface TestResult {
  ok: boolean
  latencyMs?: number
  error?: string
  /** 端点返回的模型数量（仅 /models 可用时） */
  modelCount?: number
}

/** 流式增量推送事件体（通道 `ai:chunk`） */
export interface AiChunk {
  requestId: string
  delta?: string
  done?: boolean
  error?: string
}

/* ------------------------------------------------------------------ */
/* IPC 入参                                                            */
/* ------------------------------------------------------------------ */

export interface ChatRequest {
  modelId: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
}

export interface ImageRequest {
  modelId: string
  prompt: string
  /** '1024x1024' 等；grsai 会换算成比例 */
  size?: string
  /** 生成张数，默认 1，上限 4 */
  n?: number
}

export interface SetActivePayload {
  llm?: string | null
  image?: string | null
}

/** `ai:chat-stream` 的立即返回（正文走 `ai:chunk` 事件） */
export interface ChatStreamStart {
  ok: boolean
  requestId?: string
  error?: string
}

export interface OkResult {
  ok: boolean
  error?: string
}

/* ------------------------------------------------------------------ */
/* 知识库契约（kb:* IPC 面；数据形状与 src/core/kb/types.ts 同源）        */
/* ------------------------------------------------------------------ */

/** `kb:pick-doc` / `kb:read-doc` 的返回 */
export interface KbDocPickResult {
  ok: boolean
  canceled?: boolean
  path?: string
  title?: string
  format?: DocFormat
  content?: string
  error?: string
}

export interface KbApi {
  /* ---- 知识条目 ---- */
  listEntries: () => Promise<{ ok: boolean; entries?: KnowledgeEntry[]; error?: string }>
  createEntry: (input: CreateEntryInput) => Promise<{ ok: boolean; entry?: KnowledgeEntry; error?: string }>
  updateEntry: (
    id: string,
    patch: UpdateEntryInput
  ) => Promise<{ ok: boolean; entry?: KnowledgeEntry; error?: string }>
  removeEntry: (id: string) => Promise<{ ok: boolean; error?: string }>
  searchEntries: (query: string) => Promise<{ ok: boolean; entries?: KnowledgeEntry[]; error?: string }>
  /* ---- 节点关联 ---- */
  listLinksForNode: (nodeId: string) => Promise<{ ok: boolean; entries?: KnowledgeEntry[]; docs?: KbDocument[]; error?: string }>
  linkEntry: (entryId: string, nodeId: string) => Promise<{ ok: boolean; error?: string }>
  unlinkEntry: (entryId: string, nodeId: string) => Promise<{ ok: boolean; error?: string }>
  linkDoc: (docId: string, nodeId: string) => Promise<{ ok: boolean; error?: string }>
  unlinkDoc: (docId: string, nodeId: string) => Promise<{ ok: boolean; error?: string }>
  /* ---- 文档 ---- */
  listDocs: () => Promise<{ ok: boolean; docs?: KbDocument[]; error?: string }>
  getDoc: (id: string) => Promise<{ ok: boolean; doc?: KbDocument; error?: string }>
  createDoc: (input: CreateDocInput) => Promise<{ ok: boolean; doc?: KbDocument; error?: string }>
  updateDoc: (id: string, patch: UpdateDocInput) => Promise<{ ok: boolean; doc?: KbDocument; error?: string }>
  removeDoc: (id: string) => Promise<{ ok: boolean; error?: string }>
  pickDoc: () => Promise<KbDocPickResult>
  readDoc: (path: string) => Promise<KbDocPickResult>
  /* ---- 锚点 ---- */
  listAnchors: (filter: { docId?: string; nodeId?: string }) => Promise<{ ok: boolean; anchors?: DocAnchor[]; error?: string }>
  createAnchor: (input: CreateAnchorInput) => Promise<{ ok: boolean; anchor?: DocAnchor; error?: string }>
  updateAnchor: (
    id: string,
    patch: UpdateAnchorInput
  ) => Promise<{ ok: boolean; anchor?: DocAnchor; error?: string }>
  removeAnchor: (id: string) => Promise<{ ok: boolean; error?: string }>
  /* ---- 作者记忆 ---- */
  listMemories: () => Promise<{ ok: boolean; memories?: MemoryEntry[]; error?: string }>
  createMemory: (input: CreateMemoryInput) => Promise<{ ok: boolean; memory?: MemoryEntry; error?: string }>
  updateMemory: (
    id: string,
    patch: UpdateMemoryInput
  ) => Promise<{ ok: boolean; memory?: MemoryEntry; error?: string }>
  removeMemory: (id: string) => Promise<{ ok: boolean; error?: string }>
  resetMemories: () => Promise<{ ok: boolean; error?: string }>
  exportMemories: () => Promise<{ ok: boolean; json?: string; error?: string }>
  importMemories: (json: string) => Promise<{ ok: boolean; imported?: number; error?: string }>
  /* ---- 偏好 ---- */
  getPreferences: () => Promise<{ ok: boolean; preferences?: Record<string, string>; error?: string }>
  setPreference: (key: PrefKey, value: string) => Promise<{ ok: boolean; error?: string }>
  /* ---- 工作过程事件 ---- */
  listEvents: (limit?: number) => Promise<{ ok: boolean; events?: KbEvent[]; error?: string }>
  logEvent: (kind: string, refId: string | null, summary: string) => Promise<{ ok: boolean; error?: string }>
  curate: () => Promise<{ ok: boolean; report?: CurateReport; error?: string }>
  /* ---- 全量导入导出 ---- */
  exportAll: () => Promise<{ ok: boolean; json?: string; error?: string }>
  importAll: (json: string) => Promise<{ ok: boolean; entries?: number; documents?: number; memories?: number; error?: string }>
}

/* ------------------------------------------------------------------ */
/* window.electronAPI（由 preload.cjs 注入）                            */
/* ------------------------------------------------------------------ */

export interface AiApi {
  listModels: () => Promise<AiModelsPayload>
  saveModel: (cfg: ModelConfig) => Promise<OkResult>
  removeModel: (id: string) => Promise<OkResult>
  setActive: (patch: SetActivePayload) => Promise<OkResult>
  /** 主进程代发最小请求，错误信息已剔除 Authorization 与 URL 中的 key */
  testModel: (cfg: ModelConfig) => Promise<TestResult>
  chat: (req: ChatRequest) => Promise<ChatResult>
  chatStream: (req: ChatRequest) => Promise<ChatStreamStart>
  cancelChat: (requestId: string) => Promise<OkResult>
  image: (req: ImageRequest) => Promise<ImageResult>
  /** 订阅流式增量：返回取消订阅函数（范式同 onUpdateStatus） */
  onAiChunk: (callback: (chunk: AiChunk) => void) => () => void
}

/** 自动更新状态推送（与 main.cjs 的 `update:status` 一致） */
export interface UpdateStatusPayload {
  phase: string
  info?: unknown
  error?: string
  percent?: number
}

export interface ElectronApi {
  /** 是否运行在 Electron 桌面环境（浏览器里为 undefined，前端据此降级） */
  isDesktop: true
  getAppVersion: () => Promise<string>
  getPlatform: () => Promise<string>
  /** 旧生图链路仍在用；新链路一律走 `ai.*` */
  getGrsaiKey: () => Promise<string>
  setGrsaiKey: (key: string) => Promise<OkResult>
  checkForUpdates: () => Promise<{ ok: boolean; version?: string; error?: string }>
  downloadUpdate: () => Promise<{ ok: boolean; error?: string }>
  installUpdate: () => void
  onUpdateStatus: (callback: (payload: UpdateStatusPayload) => void) => () => void
  ai: AiApi
  /** 知识库 / 文档 / 记忆（userData/novelflow.db；浏览器态为 undefined，前端据此降级到 IndexedDB） */
  kb: KbApi
}

declare global {
  interface Window {
    /** 仅 Electron 桌面环境存在（浏览器 dev 下为 undefined） */
    electronAPI?: ElectronApi
  }
}
