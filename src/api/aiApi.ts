import type {
  EdgeKind,
  FlowGraph,
  GraphSettings,
  NodeKind,
  NodeStatus,
  PortSide,
  StoryEdge,
  StoryNode
} from '@/types/graph'
import { createEdge, createGraph, createNode, deepClone, findNode } from '@/core/model'
import { layoutTimeline } from '@/core/layout'
// 人物名匹配复用 core 的唯一口径（大小写敏感、容忍前后空白），避免 aiApi 里再长出第二份实现
import { sameCharacterName } from '@/core/characterRename'
// 人物卡片落位复用 core 的纯函数，与工具栏「新建人物卡」共用同一套网格规则
import { nextCharacterSlot } from '@/core/characterSlot'
// 人物卡片的保留道 / 专用尺寸复用工具栏入口那两个常量，不另造魔数
import { CHARACTER_LANE, CHARACTER_NODE_W } from '@/components/canvas/characterCard'
import {
  downloadBlob,
  exportFilenameFor,
  exportJson,
  exportPng,
  toDrawio,
  toMarkdown,
  toMermaid,
  toSvgString
} from '@/export'
// 知识库 / 文档 / 记忆：渲染层唯一出口（桌面态 IPC、浏览器态 IDB 分流，kbClient 内部处理）
import {
  createAnchor,
  createDoc,
  createEntry,
  createMemory,
  getDoc,
  linkDoc,
  linkEntry,
  listDocs,
  listEntries,
  listLinksForNode,
  listMemories,
  removeDoc,
  removeEntry,
  removeMemory,
  searchEntries,
  unlinkDoc,
  unlinkEntry,
  updateDoc,
  updateEntry,
  updateMemory
} from './kbClient'
// 锚点模糊重定位：docAnchor 用 quote 在文档内容里现定位偏移量（与 UI 划词建锚点同一算法）
import { relocateAnchor } from '@/core/kb/anchor'
import type {
  CreateDocInput,
  CreateEntryInput,
  CreateMemoryInput,
  DocAnchor,
  KbDocument,
  KnowledgeEntry,
  KnowledgeType,
  MemoryEntry,
  NodeLinks,
  UpdateDocInput,
  UpdateEntryInput,
  UpdateMemoryInput
} from '@/core/kb/types'

/**
 * ==================================================================
 * NovelFlow 可编程控制 API —— window.NovelFlow
 * ==================================================================
 *
 * 目标：让 AI（以及会写 JS 的作者）能在浏览器控制台里 **直接把故事线画出来**，
 * 不必理解内部 store / 组件结构。设计上遵守三条纪律：
 *
 *  1. **永不抛异常到调用方**：所有方法内部 try/catch，统一返回 `{ ok, data?, error? }`。
 *     AI 在批量写入时最怕「第 7 条炸了、前面 6 条白写」，所以单条失败必须是可观测的数据而不是崩溃。
 *  2. **惰性拿 store**：store 通过动态 import 获取并缓存，避免模块初始化时序死锁
 *     （aiApi 可能在 Pinia 安装之前就被 import）。
 *  3. **同步优先**：除 exportPNG（栅格化天然异步）外，所有方法同步返回，
 *     这样 `NovelFlow.addNode({title:'雨夜'})` 在控制台里能立刻看到结果对象。
 *
 * ------------------------------------------------------------------
 * 控制台速查（直接粘贴即可运行）
 * ------------------------------------------------------------------
 *
 * ```js
 * // 1) 建一张图并连写三个节点（按数组顺序自动串联）
 * await NovelFlow.ready()
 * NovelFlow.addFlow('长夜将尽')
 * NovelFlow.addNodes([
 *   { title: '雨夜初遇', summary: '码头边的第一次交锋', timeLabel: '第一章 · 雨夜', characters: ['林毅','沈青'] },
 *   { title: '旧账', summary: '三年前的账本被翻出', timeLabel: '三年后' },
 *   { title: '抉择', kind: 'decision', summary: '留下还是离开' }
 * ])
 *
 * // 2) 在「雨夜初遇」之后插一个节点（自动连线、自动让位）
 * NovelFlow.addNode({ title: '追车', afterId: NovelFlow.getState().data.nodes[0].id })
 *
 * // 3) 从某个节点横向拉一条支线
 * NovelFlow.addNode({ title: '沈青的回忆', branchOf: NovelFlow.getState().data.nodes[1].id })
 *
 * // 4) 批量写备注 / 人物 / 标签
 * const id = NovelFlow.getState().data.nodes[0].id
 * NovelFlow.addNote(id, '这里要埋一个伏笔：她左手无名指的疤')
 * NovelFlow.addCharacter(id, '老周')
 * NovelFlow.setStatus(id, 'done')
 *
 * // 5) 一次性编排（batch 里单条失败不中断，逐条收集结果）
 * NovelFlow.batch([
 *   ['addNode', { title: '尾声', timeLabel: '十年后' }],
 *   ['setSettings', { rowGap: 240 }],
 *   ['layout']
 * ])
 *
 * // 6) 导出
 * NovelFlow.exportMarkdown().data          // 大纲文本
 * NovelFlow.exportMermaid().data           // 可粘贴进 Mermaid 编辑器
 * NovelFlow.exportDrawio().data            // draw.io XML
 * const png = await NovelFlow.exportPNG(2) // Blob（PNG 栅格化异步）
 *
 * // 7) 订阅变更（防抖 120ms）
 * const off = NovelFlow.subscribe((graph) => console.log('图变了', graph.nodes.length))
 * off()
 * ```
 *
 * 全部方法说明见 `NovelFlow.help()`。
 */

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

/**
 * 统一返回结构。
 * 说明：`data` 用 unknown / 具体泛型约束；仅在与未知形状的 store 交互处才放宽为 any，
 * 因为 store 由另一名工程师并行开发，接口名在合流前无法静态确定。
 */
export interface ApiResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

export interface AddNodeInput {
  /** 节点标题（必填） */
  title: string
  summary?: string
  kind?: NodeKind
  /** 插到该节点之后（自动连线 + 自动让位） */
  afterId?: string
  /** 作为该节点的横向分支 */
  branchOf?: string
  timeLabel?: string
  content?: string
  characters?: string[]
  tags?: string[]
  location?: string
  chapter?: string
  status?: NodeStatus
  lane?: number
  note?: string
  /** 故事正文以外的自定义颜色（token 名或 hex） */
  color?: string
}

export interface AddEdgeInput {
  label?: string
  kind?: EdgeKind
  dashed?: boolean
  /** 起端锚点：top / bottom / left / right，缺省 = 按 kind 规则自动推断 */
  sourceHandle?: PortSide
  /** 末端锚点：同上 */
  targetHandle?: PortSide
}

export interface FlowSummary {
  id: string
  name: string
  nodes: number
  edges: number
  updatedAt: number
}

export interface HelpItem {
  name: string
  signature: string
  desc: string
}

export interface NovelFlowApi {
  /** API 版本，便于 AI 自检 */
  version: string
  /** 等待 store 就绪（首次调用前先 await 一次最稳） */
  ready(): Promise<boolean>

  getState(): ApiResult<FlowGraph>
  listFlows(): ApiResult<FlowSummary[]>
  addFlow(name: string, opts?: Partial<GraphSettings>): ApiResult<FlowGraph>
  openFlow(idOrName: string): ApiResult<FlowGraph>
  removeFlow(id: string): ApiResult<boolean>
  renameFlow(name: string): ApiResult<FlowGraph>

  addNode(input: AddNodeInput): ApiResult<StoryNode>
  addNodes(list: AddNodeInput[]): ApiResult<StoryNode[]>
  addEdge(sourceId: string, targetId: string, options?: AddEdgeInput): ApiResult<StoryEdge>
  removeEdge(id: string): ApiResult<boolean>
  updateEdge(id: string, patch: Partial<StoryEdge>): ApiResult<StoryEdge>

  addNote(nodeId: string, text: string): ApiResult<StoryNode>
  addCharacter(nodeId: string, name: string): ApiResult<StoryNode>
  addTag(nodeId: string, tag: string): ApiResult<StoryNode>
  updateNode(id: string, patch: Partial<StoryNode>): ApiResult<StoryNode>
  removeNode(id: string): ApiResult<boolean>
  setChapter(nodeId: string, chapter: string): ApiResult<StoryNode>
  setStatus(nodeId: string, status: NodeStatus): ApiResult<StoryNode>
  setNodeImage(nodeId: string, url: string, prompt?: string): ApiResult<StoryNode>

  layout(): ApiResult<FlowGraph>
  setSettings(patch: Partial<GraphSettings>): ApiResult<GraphSettings>

  exportPNG(scale?: 1 | 2 | 4): Promise<ApiResult<Blob>>
  exportSVG(): ApiResult<string>
  exportJSON(): ApiResult<string>
  exportMermaid(): ApiResult<string>
  exportDrawio(): ApiResult<string>
  exportMarkdown(): ApiResult<string>
  /** 导出并直接触发浏览器下载 */
  download(format: 'png' | 'svg' | 'json' | 'markdown' | 'mermaid' | 'drawio', scale?: 1 | 2 | 4): Promise<ApiResult<string>>

  undo(): ApiResult<FlowGraph>
  redo(): ApiResult<FlowGraph>
  reset(): ApiResult<FlowGraph>

  batch(commands: Array<[string, ...unknown[]]>): ApiResult<ApiResult[]>
  subscribe(cb: (graph: FlowGraph) => void): () => void
  help(): ApiResult<HelpItem[]>

  /* ---------------- 知识库 / 文档 / 记忆（task-002） ----------------
   * 与图方法不同：这些能力的状态在主进程 sql.js / 浏览器态 IDB，
   * 因此全部是异步的（kbClient 的 Promise 直通，纪律同样是永不抛异常）。 */

  kbAddEntry(input: CreateEntryInput): Promise<ApiResult<KnowledgeEntry>>
  kbUpdateEntry(id: string, patch: UpdateEntryInput): Promise<ApiResult<KnowledgeEntry>>
  kbRemoveEntry(id: string): Promise<ApiResult<boolean>>
  kbListEntries(type?: KnowledgeType): Promise<ApiResult<KnowledgeEntry[]>>
  kbSearch(query: string): Promise<ApiResult<KnowledgeEntry[]>>
  kbLinkNode(entryId: string, nodeId: string): Promise<ApiResult<boolean>>
  kbUnlinkNode(entryId: string, nodeId: string): Promise<ApiResult<boolean>>
  kbListNodeLinks(nodeId: string): Promise<ApiResult<NodeLinks>>

  docAdd(input: CreateDocInput): Promise<ApiResult<KbDocument>>
  docList(): Promise<ApiResult<KbDocument[]>>
  docGet(id: string): Promise<ApiResult<KbDocument | null>>
  docUpdate(id: string, patch: UpdateDocInput): Promise<ApiResult<KbDocument>>
  docRemove(id: string): Promise<ApiResult<boolean>>
  /** 文档锚点：quote 经 relocateAnchor 模糊重定位后入库；定位不到返回中文错误 */
  docAnchor(input: {
    docId: string
    quote: string
    /** 大致字符偏移量（可选，辅助精确定位） */
    hint?: number
    nodeId?: string
    note?: string
  }): Promise<ApiResult<DocAnchor>>
  docLinkNode(docId: string, nodeId: string): Promise<ApiResult<boolean>>
  docUnlinkNode(docId: string, nodeId: string): Promise<ApiResult<boolean>>

  memoryAdd(input: CreateMemoryInput): Promise<ApiResult<MemoryEntry>>
  memoryList(): Promise<ApiResult<MemoryEntry[]>>
  memoryUpdate(id: string, patch: UpdateMemoryInput): Promise<ApiResult<MemoryEntry>>
  memoryRemove(id: string): Promise<ApiResult<boolean>>
}

/* ------------------------------------------------------------------ */
/* store 惰性获取                                                      */
/* ------------------------------------------------------------------ */

/*
 * store 由 Max-A 并行开发，此处刻意用 any 与之交互：
 * 我们只按「可能存在的方法名」去试探调用，失败就退回就地改数据（Pinia state 是响应式的，UI 照样更新）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StoreLike = any

let storeRef: StoreLike | null = null
let storeLoading: Promise<StoreLike | null> | null = null

/**
 * 惰性加载并缓存 store 实例。
 * 用动态 import：aiApi 可能在 Pinia 安装之前就被 import，静态取用会抛「no active pinia」。
 */
export async function ensureStore(): Promise<StoreLike | null> {
  if (storeRef) return storeRef
  if (storeLoading) return storeLoading
  storeLoading = (async () => {
    try {
      const mod = await import('@/stores/useFlowStore')
      const factory = mod?.useFlowStore
      if (typeof factory === 'function') {
        const instance = factory()
        if (instance) {
          storeRef = instance
          bindStoreSubscription(instance)
          return instance
        }
      }
    } catch {
      /* store 尚未就绪：静默失败，调用方会拿到「状态尚未就绪」的提示 */
    }
    return null
  })()
  return storeLoading
}

/** 取已缓存的 store；未就绪则顺手触发一次加载 */
function currentStore(): StoreLike | null {
  if (storeRef) return storeRef
  void ensureStore()
  return null
}

/* ------------------------------------------------------------------ */
/* store 字段的容错读取                                                 */
/* ------------------------------------------------------------------ */

/** 依次尝试若干候选属性名，返回第一个非 undefined 的值 */
function pick(store: StoreLike, keys: string[]): unknown {
  for (const key of keys) {
    const v = store?.[key]
    if (v !== undefined && v !== null) return v
  }
  return undefined
}

function readGraphs(store: StoreLike): FlowGraph[] {
  const list = pick(store, ['graphs', 'flowList', 'items', 'all'])
  return Array.isArray(list) ? (list as FlowGraph[]) : []
}

function readActiveId(store: StoreLike): string {
  const id = pick(store, ['activeId', 'currentId', 'currentFlowId'])
  return typeof id === 'string' ? id : ''
}

/** 取当前激活的图：优先直读 getter，其次按 activeId 在列表里找，最后退回第一张 */
export function readActiveGraph(store: StoreLike): FlowGraph | null {
  const direct = pick(store, ['activeGraph', 'currentGraph', 'graph', 'active'])
  if (direct && typeof direct === 'object' && Array.isArray((direct as FlowGraph).nodes)) {
    return direct as FlowGraph
  }
  const graphs = readGraphs(store)
  if (!graphs.length) return null
  const id = readActiveId(store)
  return graphs.find((g) => g.id === id) ?? graphs[0] ?? null
}

/* ------------------------------------------------------------------ */
/* 变更提交 / 历史 / 订阅                                               */
/* ------------------------------------------------------------------ */

/**
 * 尽力调用 store 上「可能存在的」方法：命中第一个可用的就执行并停止。
 * 名字对不上也不影响正确性 —— 数据已就地改过，响应式 UI 会跟上；
 * 这里只是尽量让 store 自己的持久化 / 历史记录机制也跑一遍。
 */
function callFirst(store: StoreLike, names: string[], args: unknown[] = []): boolean {
  return callFirstResult(store, names, args).called
}

/**
 * 同上，但把被调用方法的返回值带出来。
 * 用于「store 已经实现了这个能力」的场景（如 connectNodes 返回新建的连线），
 * 这样 AI 拿到的就是 store 真实创建的对象，而不是我们另造一个副本。
 */
function callFirstResult(
  store: StoreLike,
  names: string[],
  args: unknown[] = []
): { called: boolean; value: unknown } {
  for (const name of names) {
    const fn = store?.[name]
    if (typeof fn === 'function') {
      try {
        const value = (fn as (...a: unknown[]) => unknown).apply(store, args)
        return { called: true, value }
      } catch {
        /* 单个候选失败继续试下一个 */
      }
    }
  }
  return { called: false, value: undefined }
}

/** 提交一次变更：更新时间戳 → 通知持久化 → 通知订阅者 */
function commit(store: StoreLike, graph: FlowGraph): void {
  graph.updatedAt = Date.now()
  callFirst(store, ['persist', 'saveNow', 'save', 'flush', 'markDirty', 'syncStorage'])
  notifySubscribers()
}

/* ---- 自带的撤销 / 重做兜底：store 若已提供 undo/redo 则优先用 store 的 ---- */
const HISTORY_LIMIT = 60
const undoStack: FlowGraph[] = []
const redoStack: FlowGraph[] = []

function snapshot(graph: FlowGraph): void {
  undoStack.push(deepClone(graph))
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift()
  redoStack.length = 0
}

/** 把快照内容写回当前图（就地替换 nodes / edges，保持响应式引用不变） */
function restore(graph: FlowGraph, snap: FlowGraph): FlowGraph {
  graph.nodes = deepClone(snap.nodes)
  graph.edges = deepClone(snap.edges)
  graph.settings = deepClone(snap.settings)
  graph.updatedAt = Date.now()
  return graph
}

/* ---- 订阅：状态变更后 120ms 防抖回调 ---- */
const subscribers = new Set<(graph: FlowGraph) => void>()
let notifyTimer: ReturnType<typeof setTimeout> | null = null
const NOTIFY_DEBOUNCE = 120

function notifySubscribers(): void {
  if (!subscribers.size || notifyTimer !== null) return
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    const state = getState()
    if (!state.ok || !state.data) return
    for (const cb of Array.from(subscribers)) {
      try {
        cb(state.data)
      } catch {
        /* 订阅者自身的异常不能影响其他人 */
      }
    }
  }, NOTIFY_DEBOUNCE)
}

/** 若 store 是 Pinia 实例，直接挂 $subscribe，能捕获 UI 手动操作引发的变更 */
function bindStoreSubscription(store: StoreLike): void {
  const fn = store?.$subscribe
  if (typeof fn !== 'function') return
  try {
    ;(fn as (cb: () => void) => () => void).call(store, () => notifySubscribers())
  } catch {
    /* 不支持就算了 */
  }
}

/* ------------------------------------------------------------------ */
/* 通用守卫                                                            */
/* ------------------------------------------------------------------ */

function ok<T>(data?: T): ApiResult<T> {
  return data === undefined ? { ok: true } : { ok: true, data }
}

function fail<T = never>(error: string): ApiResult<T> {
  return { ok: false, error }
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return typeof e === 'string' ? e : JSON.stringify(e)
}

/**
 * 统一入口：拿 store → 拿当前图 → 打快照 → 执行 → 提交。
 * 执行结果为失败时回滚快照，保证「失败的调用不污染撤销栈」。
 */
function guard<T>(fn: (graph: FlowGraph, store: StoreLike) => ApiResult<T>): ApiResult<T> {
  const store = currentStore()
  if (!store) {
    return fail('状态尚未就绪，请稍后再试（可先执行：await NovelFlow.ready()）')
  }
  const graph = readActiveGraph(store)
  if (!graph) {
    return fail('当前没有打开的故事线，请先执行 NovelFlow.addFlow("故事名")')
  }
  snapshot(graph)
  // 让 store 自己的历史栈也记一步（store.commit 的语义就是「修改之前压栈」）
  callFirst(store, ['commit'], ['AI 操作'])
  try {
    const result = fn(graph, store)
    if (!result.ok) {
      undoStack.pop()
      return result
    }
    commit(store, graph)
    return result
  } catch (e) {
    undoStack.pop()
    return fail(`执行失败：${errMessage(e)}`)
  }
}

/** 需要某个节点存在的场景 */
function withNode<T>(
  id: string,
  fn: (graph: FlowGraph, store: StoreLike, node: StoryNode) => ApiResult<T>
): ApiResult<T> {
  return guard((graph, store) => {
    const node = findNode(graph, id)
    if (!node) return fail(`找不到 id 为 ${id} 的节点`)
    return fn(graph, store, node)
  })
}

/* ------------------------------------------------------------------ */
/* 布局小工具                                                          */
/* ------------------------------------------------------------------ */

/** 某条 lane 上下一个可用 order */
function nextOrderIn(graph: FlowGraph, lane: number): number {
  const list = graph.nodes.filter((n) => n.lane === lane)
  if (!list.length) return 0
  return Math.max(...list.map((n) => n.order)) + 1
}

/** 找一条离 base 最近、且当前没被占用的 lane */
function freeLaneNear(graph: FlowGraph, base: number): number {
  const used = new Set(graph.nodes.map((n) => n.lane))
  for (let d = 1; d <= 6; d++) {
    for (const candidate of [base + d, base - d]) {
      if (!used.has(candidate)) return candidate
    }
  }
  return base + 1
}

/** timeline 模式下自动重排；free 模式尊重手工坐标 */
function relayoutIfNeeded(graph: FlowGraph): void {
  if (graph.settings?.layoutMode === 'timeline') {
    layoutTimeline(graph)
  }
}

/* ------------------------------------------------------------------ */
/* 方法实现                                                            */
/* ------------------------------------------------------------------ */

function getState(): ApiResult<FlowGraph> {
  const store = currentStore()
  if (!store) return fail('状态尚未就绪，请先 await NovelFlow.ready()')
  const graph = readActiveGraph(store)
  if (!graph) return fail('当前没有打开的故事线')
  return ok(deepClone(graph))
}

function listFlows(): ApiResult<FlowSummary[]> {
  const store = currentStore()
  if (!store) return fail('状态尚未就绪，请先 await NovelFlow.ready()')
  const graphs = readGraphs(store)
  return ok(
    graphs.map((g) => ({
      id: g.id,
      name: g.name,
      nodes: g.nodes?.length ?? 0,
      edges: g.edges?.length ?? 0,
      updatedAt: g.updatedAt ?? 0
    }))
  )
}

function addFlow(name: string, opts: Partial<GraphSettings> = {}): ApiResult<FlowGraph> {
  const store = currentStore()
  if (!store) return fail('状态尚未就绪，请先 await NovelFlow.ready()')
  try {
    const title = String(name || '新的故事线').trim() || '新的故事线'
    // 优先用 store 自己的建图流程（它会顺带处理激活、历史与持久化）
    const created = callFirstResult(store, ['createGraph', 'addFlow', 'newFlow'], [title])
    let graph: FlowGraph | null = null

    if (created.called) {
      // 重新从 store 读一次，拿到的是响应式代理对象（直接改它 UI 才会更新）
      graph = readActiveGraph(store)
    }
    if (!graph) {
      graph = createGraph(title)
      const graphs = readGraphs(store)
      if (graphs.length) graphs.push(graph)
      else store.graphs = [graph]
      if (typeof store.activeId === 'string') store.activeId = graph.id
      else callFirst(store, ['setActiveGraph', 'openFlow'], [graph.id])
    }
    if (opts && typeof opts === 'object' && Object.keys(opts).length) {
      callFirstResult(store, ['setSettings'], [opts])
    }
    commit(store, graph)
    return ok(deepClone(graph))
  } catch (e) {
    return fail(`addFlow 失败：${errMessage(e)}`)
  }
}

function openFlow(idOrName: string): ApiResult<FlowGraph> {
  const store = currentStore()
  if (!store) return fail('状态尚未就绪，请先 await NovelFlow.ready()')
  const graphs = readGraphs(store)
  const target =
    graphs.find((g) => g.id === idOrName) ?? graphs.find((g) => g.name === idOrName)
  if (!target) return fail(`找不到名为「${idOrName}」的故事线`)
  // 优先走 store 的切换流程（它会重置历史、清空选中、持久化 lastGraphId）
  if (!callFirst(store, ['setActiveGraph', 'openFlow', 'selectFlow'], [target.id])) {
    if (typeof store.activeId === 'string') store.activeId = target.id
  }
  notifySubscribers()
  return ok(deepClone(readActiveGraph(store) ?? target))
}

function removeFlow(id: string): ApiResult<boolean> {
  const store = currentStore()
  if (!store) return fail('状态尚未就绪，请先 await NovelFlow.ready()')
  const graphs = readGraphs(store)
  const index = graphs.findIndex((g) => g.id === id)
  if (index < 0) return fail(`找不到 id 为 ${id} 的故事线`)
  // 优先用 store 的删除（它会维护 activeId、历史与持久化）
  if (!callFirst(store, ['removeGraph', 'removeFlow', 'deleteFlow'], [id])) {
    graphs.splice(index, 1)
    if (readActiveId(store) === id && graphs.length) {
      if (typeof store.activeId === 'string') store.activeId = graphs[0].id
    }
  }
  notifySubscribers()
  return ok(true)
}

function renameFlow(name: string): ApiResult<FlowGraph> {
  return guard((graph, store) => {
    const next = String(name || '').trim()
    if (!next) return fail('renameFlow 失败：名字不能为空')
    if (!callFirst(store, ['renameGraph', 'renameFlow'], [graph.id, next])) {
      graph.name = next
    }
    commit(store, graph)
    return ok(deepClone(readActiveGraph(store) ?? graph))
  })
}

/** 依据 afterId / branchOf / 追加末尾 三种语义决定落点与连线 */
function addNode(input: AddNodeInput): ApiResult<StoryNode> {
  return guard((graph) => {
    if (!input || typeof input !== 'object') return fail('addNode 失败：参数必须是对象')
    const title = String(input.title ?? '').trim()
    if (!title) return fail('addNode 失败：title 不能为空')

    const kind = input.kind ?? 'event'
    // 人物卡片重名拦截（fail-fast：必须早于下面的 order 位移，否则拦晚了就是白改一圈再回滚）。
    // 人物名是全图认亲的唯一键（挂载 / chip 统计 / 级联改名都按名字匹配），同名双卡会让后建的牌
    // 认走先建那张的挂载关系，且改名时会被「已有同名人物」拒死而无法自救。
    // 工具栏走自增命名（新人物 / 新人物 2…），AI API 走拒绝 —— 程序化调用方要的是明确报错，
    // 不是被静默改名导致返回节点标题与入参不一致。
    if (kind === 'character') {
      const clash = graph.nodes.some(
        (n) => n.kind === 'character' && sameCharacterName(n.title, title)
      )
      if (clash) {
        return fail(`addNode 失败：已存在同名人物卡片「${title}」—— 人物名是全图唯一键，请换个名字`)
      }
    }

    // 【人物卡 · 完全取消自动连边与让位（用户决策）】
    // afterId / branchOf 都是主线语义：连一条边 + 同 lane 内 order 位移。套在人物卡上
    // 会把角色牌接进主线 flow 链（toMarkdown 的 outlineOrder / toMermaid 的 lane 分桶 /
    // aiPrompt 的 pickNeighbors 都按 lane 分组，导出时会露馅），且 order 位移白改一圈。
    // 处置：显式传入即报错（程序化调用方要明确反馈，不是静默忽略）；
    // 报错点早于下面任何状态变更（order 位移 / 建节点 / 连边都在其后）⇒ 失败零副作用。
    // 重名拦截在上面先行 —— 两者同时命中时优先报 name clash（更具体、可操作）。
    if (kind === 'character') {
      if (input.afterId) {
        return fail(
          `addNode 失败：人物卡片不支持 afterId「${input.afterId}」—— 人物卡不参与连线与时间线让位，请去掉 afterId（或改用普通 kind）`
        )
      }
      if (input.branchOf) {
        return fail(
          `addNode 失败：人物卡片不支持 branchOf「${input.branchOf}」—— 人物卡不参与连线与时间线让位，请去掉 branchOf（或改用普通 kind）`
        )
      }
    }

    let lane = 0
    let order = 0
    let connectFrom: string | null = null
    let edgeKind: EdgeKind = 'flow'
    let successorEdge: StoryEdge | null = null

    if (kind === 'character') {
      // 人物卡专用落点：保留道（调用方显式传 lane 时尊重调用方）+ 道内自增 order。
      // connectFrom / successorEdge 恒为 null ⇒ 不连任何边、不改接任何既有边。
      lane = typeof input.lane === 'number' ? input.lane : CHARACTER_LANE
      order = nextOrderIn(graph, lane)
    } else if (input.afterId) {
      const anchor = findNode(graph, input.afterId)
      if (!anchor) return fail(`addNode 失败：找不到 afterId 对应的节点「${input.afterId}」`)
      lane = typeof input.lane === 'number' ? input.lane : anchor.lane
      order = anchor.order + 1
      // 原来的「anchor → 后继」边先记下来，稍后改接到新节点之后，保证链条不断
      successorEdge =
        graph.edges.find((e) => {
          if (e.source !== anchor.id) return false
          const t = findNode(graph, e.target)
          return !!t && t.lane === anchor.lane && t.order === anchor.order + 1
        }) ?? null
      // 同 lane 里 order ≥ 新 order 的节点整体后移一格
      for (const n of graph.nodes) {
        if (n.lane === lane && n.order >= order) n.order += 1
      }
      connectFrom = anchor.id
    } else if (input.branchOf) {
      const parent = findNode(graph, input.branchOf)
      if (!parent) return fail(`addNode 失败：找不到 branchOf 对应的节点「${input.branchOf}」`)
      lane = typeof input.lane === 'number' ? input.lane : freeLaneNear(graph, parent.lane)
      order = parent.order
      connectFrom = parent.id
      edgeKind = 'branch'
    } else {
      lane = typeof input.lane === 'number' ? input.lane : 0
      order = nextOrderIn(graph, lane)
      if (typeof input.lane !== 'number') {
        const main = graph.nodes.filter((n) => n.lane === 0).sort((a, b) => a.order - b.order)
        if (main.length) connectFrom = main[main.length - 1].id
      }
    }

    const node = createNode(
      {
        title,
        kind,
        summary: input.summary ?? '',
        timeLabel: input.timeLabel ?? '',
        content: input.content ?? '',
        // 人物名是全图认载的唯一键（挂载/chip 统计/级联改名都按名字匹配）：
        // 与 addCharacter 入口保持一致，trim + 去重 + 滤空，防 '沈青 ' 这类静默丢数据
        characters: Array.isArray(input.characters)
          ? [
              ...new Set(
                input.characters
                  .filter((c): c is string => typeof c === 'string')
                  .map((c) => c.trim())
                  .filter(Boolean)
              )
            ]
          : [],
        tags: Array.isArray(input.tags) ? [...input.tags] : [],
        location: input.location ?? '',
        chapter: input.chapter ?? '',
        status: input.status ?? 'planned',
        lane,
        order,
        // 【人物卡 · 与工具栏入口对齐的三件套】character 必须走 CHARACTER_LANE 保留道、
        // 用 CHARACTER_NODE_W 专用尺寸、并用 nextCharacterSlot 错位落位。
        //   - lane：不补的话 character 会落到 lane 0，而 `toMarkdown` 的 outlineOrder、
        //     `toMermaid` 的 lane 分桶、`aiPrompt` 的 pickNeighbors 都按 lane 分组 ——
        //     人物卡会被当成主线剧情节点排进主线。画布上看不出来（character 布局豁免），
        //     但导出会露馅，正是用户要摆脱的那种「被时间线管控」。
        //     调用方显式传 lane 时尊重调用方，只有缺省才用保留道。
        //     （lane 已在上面人物卡分支算好：显式数字尊重调用方，非数字（含脏类型
        //     如 '7'）收敛为保留道；此处直接用该变量，保持单点真相——
        //     不再出现 spread 透传脏 lane、reload 后被 sanitizeNode 打回主线的事故。）
        //   - w：与工具栏建出来的人物卡同宽（196），不补则是 268 的普通卡宽度。
        //   - x / y：character 被 `isLayoutExempt` 永久剔出布局集合，
        //     `layoutTimeline` 不会再给它排位，留给 createNode 兜底 (0,0) 就会叠成一坨。
        // order 与连边同样已在上面人物卡分支处理（道内自增、不连边），此处不重复。
        ...(kind === 'character'
          ? {
              lane,
              w: CHARACTER_NODE_W,
              ...nextCharacterSlot(graph.nodes)
            }
          : {}),
        ...(input.note ? { note: input.note } : {}),
        ...(input.color ? { color: input.color } : {})
      },
      order
    )
    graph.nodes.push(node)

    if (successorEdge) successorEdge.source = node.id
    if (connectFrom) {
      graph.edges.push(createEdge(connectFrom, node.id, edgeKind))
    }

    relayoutIfNeeded(graph)
    return ok(deepClone(node))
  })
}

/**
 * 批量添加：首项按自身规则落位，之后每一项接在前一项之后并自动连线。
 * 任一项失败即停止（已创建的节点保留，便于排查）。
 *
 * ⚠️ 人物卡（`kind === 'character'`）**不参与批量链**：
 *   - 不给它注入 afterId（调用方显式传的透传，由 addNode 的守卫报错）；
 *   - 它也不充当后续项的 previousId。
 * 否则混合批量（如 `[character, event]`）会把事件继承到人物道（lane 100）并接到
 * 角色牌上 —— 主线剧情整体变形，且连坐影响后面全部项。
 */
function addNodes(list: AddNodeInput[]): ApiResult<StoryNode[]> {
  if (!Array.isArray(list)) return fail('addNodes 失败：参数必须是数组')
  if (!list.length) return ok<StoryNode[]>([])
  const created: StoryNode[] = []
  let previousId: string | null = null
  for (const [i, raw] of list.entries()) {
    const isCharacter = (raw.kind ?? 'event') === 'character'
    const input: AddNodeInput =
      i === 0 || isCharacter ? raw : { ...raw, afterId: raw.afterId ?? previousId ?? undefined }
    const result = addNode(input)
    if (!result.ok || !result.data) {
      return fail(`addNodes 第 ${i + 1} 项失败：${result.error ?? '未知错误'}`)
    }
    created.push(result.data)
    // 人物卡不当链头：后续项的 afterId 不能指向它（见函数头 ⚠️ 段）
    if (result.data.kind !== 'character') previousId = result.data.id
  }
  return ok(created)
}

function addEdge(
  sourceId: string,
  targetId: string,
  options: AddEdgeInput = {}
): ApiResult<StoryEdge> {
  return guard((graph, store) => {
    if (!sourceId || !targetId) return fail('addEdge 失败：sourceId 与 targetId 都不能为空')
    if (sourceId === targetId) return fail('addEdge 失败：不能自己连自己')
    if (!findNode(graph, sourceId)) return fail(`addEdge 失败：找不到源节点 ${sourceId}`)
    if (!findNode(graph, targetId)) return fail(`addEdge 失败：找不到目标节点 ${targetId}`)
    const exists = graph.edges.some(
      (e) =>
        e.source === sourceId &&
        e.target === targetId &&
        e.kind === (options.kind ?? 'flow') &&
        (e.sourceHandle ?? null) === (options.sourceHandle ?? null) &&
        (e.targetHandle ?? null) === (options.targetHandle ?? null)
    )
    if (exists) return fail('addEdge 失败：这两个节点之间已经有相同锚点的连线了')

    // store.connectNodes 已经做了重复检测、历史与持久化，优先用（handle 一并透传）
    const result = callFirstResult(store, ['connectNodes'], [
      sourceId,
      targetId,
      options.kind ?? 'flow',
      { sourceHandle: options.sourceHandle, targetHandle: options.targetHandle }
    ])
    let edge: StoryEdge | null = null
    if (result.called && result.value && typeof result.value === 'object') {
      edge = result.value as StoryEdge
    } else {
      edge = createEdge(sourceId, targetId, options.kind ?? 'flow', options.label, {
        sourceHandle: options.sourceHandle,
        targetHandle: options.targetHandle
      })
      graph.edges.push(edge)
    }
    // store 版本不支持 label，补写一次
    if (edge && options.label) {
      const patched = callFirstResult(store, ['updateEdge'], [edge.id, { label: options.label }])
      if (!patched.called) edge.label = options.label
    }
    const dashed = options.dashed
    if (edge && typeof dashed === 'boolean') {
      const patched = callFirstResult(store, ['updateEdge'], [edge.id, { dashed }])
      if (!patched.called) edge.dashed = dashed
    }
    if (!edge) return fail('addEdge 失败：store 未返回连线对象')
    return ok(deepClone(edge))
  })
}

function removeEdge(id: string): ApiResult<boolean> {
  return guard((graph, store) => {
    if (!graph.edges.some((e) => e.id === id)) return fail(`removeEdge 失败：找不到连线 ${id}`)
    if (!callFirst(store, ['removeEdge', 'deleteEdge'], [id])) {
      graph.edges = graph.edges.filter((e) => e.id !== id)
    }
    return ok(true)
  })
}

function updateEdge(id: string, patch: Partial<StoryEdge>): ApiResult<StoryEdge> {
  return guard((graph, store) => {
    const edge = graph.edges.find((e) => e.id === id)
    if (!edge) return fail(`updateEdge 失败：找不到连线 ${id}`)
    // id / source / target 不允许被 patch 改写，否则会破坏图的一致性；
    // label / kind / dashed / sourceHandle / targetHandle 均放行（handle 缺省即自动推断）
    const { id: _id, source: _s, target: _t, ...safe } = patch ?? {}
    if (!callFirst(store, ['updateEdge'], [id, safe])) {
      Object.assign(edge, safe)
    }
    return ok(deepClone(graph.edges.find((e) => e.id === id) ?? edge))
  })
}

/** 追加备注：多次调用以换行拼接，绝不覆盖已有内容 */
function addNote(nodeId: string, text: string): ApiResult<StoryNode> {
  return withNode(nodeId, (graph, store, node) => {
    const body = String(text ?? '').trim()
    if (!body) return fail('addNote 失败：备注内容不能为空')
    const merged = node.note ? `${node.note}\n${body}` : body
    if (!callFirst(store, ['updateNode'], [nodeId, { note: merged }])) {
      node.note = merged
    }
    return ok(deepClone(currentNode(graph, nodeId)))
  })
}

function addCharacter(nodeId: string, name: string): ApiResult<StoryNode> {
  return withNode(nodeId, (graph, store, node) => {
    const value = String(name ?? '').trim()
    if (!value) return fail('addCharacter 失败：人物名不能为空')
    if (!callFirst(store, ['addCharacter'], [nodeId, value])) {
      if (!Array.isArray(node.characters)) node.characters = []
      if (!node.characters.includes(value)) node.characters.push(value)
    }
    return ok(deepClone(currentNode(graph, nodeId)))
  })
}

function addTag(nodeId: string, tag: string): ApiResult<StoryNode> {
  return withNode(nodeId, (graph, store, node) => {
    const value = String(tag ?? '').trim()
    if (!value) return fail('addTag 失败：标签不能为空')
    if (!callFirst(store, ['addTag'], [nodeId, value])) {
      if (!Array.isArray(node.tags)) node.tags = []
      if (!node.tags.includes(value)) node.tags.push(value)
    }
    return ok(deepClone(currentNode(graph, nodeId)))
  })
}

function updateNode(id: string, patch: Partial<StoryNode>): ApiResult<StoryNode> {
  return withNode(id, (graph, store, node) => {
    if (!patch || typeof patch !== 'object') return fail('updateNode 失败：patch 必须是对象')
    // id 是图的索引键，不允许改写
    const { id: _id, ...safe } = patch

    // 人物卡片重名拦截：按「补丁后」的 kind / title 判断（改名与改类型两条路径都要覆盖），
    // 且**必须排除自身** —— 否则改一张牌的摘要 / 颜色也会被自己误伤。
    const nextKind = safe.kind ?? node.kind
    const nextTitle = String(safe.title ?? node.title ?? '').trim()
    if (nextKind === 'character' && nextTitle) {
      const clash = graph.nodes.some(
        (n) => n.id !== node.id && n.kind === 'character' && sameCharacterName(n.title, nextTitle)
      )
      if (clash) {
        return fail(
          `updateNode 失败：已存在同名人物卡片「${nextTitle}」—— 人物名是全图唯一键，请换个名字`
        )
      }
    }

    if (!callFirst(store, ['updateNode'], [id, safe])) {
      Object.assign(node, safe)
    }
    if ('lane' in safe || 'order' in safe) relayoutIfNeeded(graph)
    return ok(deepClone(currentNode(graph, id)))
  })
}

function removeNode(id: string): ApiResult<boolean> {
  return guard((graph, store) => {
    if (!findNode(graph, id)) return fail(`removeNode 失败：找不到节点 ${id}`)
    // store 版本会连带删边、重排、清选中
    if (!callFirst(store, ['removeNode', 'deleteNode'], [id])) {
      graph.nodes = graph.nodes.filter((n) => n.id !== id)
      graph.edges = graph.edges.filter((e) => e.source !== id && e.target !== id)
      relayoutIfNeeded(graph)
    }
    return ok(true)
  })
}

function setChapter(nodeId: string, chapter: string): ApiResult<StoryNode> {
  return withNode(nodeId, (graph, store) => {
    if (!callFirst(store, ['updateNode'], [nodeId, { chapter: String(chapter ?? '') }])) {
      const target = findNode(graph, nodeId)
      if (target) target.chapter = String(chapter ?? '')
    }
    return ok(deepClone(currentNode(graph, nodeId)))
  })
}

function setStatus(nodeId: string, status: NodeStatus): ApiResult<StoryNode> {
  return withNode(nodeId, (graph, store) => {
    if (status !== 'planned' && status !== 'drafted' && status !== 'done') {
      return fail(`setStatus 失败：状态只能是 planned / drafted / done，收到「${String(status)}」`)
    }
    if (!callFirst(store, ['updateNode'], [nodeId, { status }])) {
      const target = findNode(graph, nodeId)
      if (target) target.status = status
    }
    return ok(deepClone(currentNode(graph, nodeId)))
  })
}

/** 设置节点配图：一律存远端 URL（不转 base64，否则 localStorage 会被撑爆） */
function setNodeImage(nodeId: string, url: string, prompt?: string): ApiResult<StoryNode> {
  return withNode(nodeId, (graph, store) => {
    const src = String(url ?? '').trim()
    if (!src) return fail('setNodeImage 失败：图片地址不能为空')
    const image = {
      url: src,
      ...(prompt ? { prompt } : {}),
      createdAt: Date.now()
    }
    // store 没有专门的 setNodeImage 时用 updateNode 兜底，行为完全一致
    if (!callFirst(store, ['setNodeImage'], [nodeId, src, prompt]) &&
        !callFirst(store, ['updateNode'], [nodeId, { image }])) {
      const target = findNode(graph, nodeId)
      if (target) target.image = image
    }
    return ok(deepClone(currentNode(graph, nodeId)))
  })
}

/**
 * 重排当前故事线。
 *
 * ⚠️ 撤销契约 —— **两边只能有一处 commit**，改动前务必读完这段：
 *  - 本函数能撤销，靠的是**外层 `guard()`**：它在执行 fn **之前**就调了
 *    `store.commit('AI 操作')`（语义是「修改前压栈」，见 `guard()` 实现），
 *    并非靠 `store.relayout()`。所以布局改动是进撤销栈的（已实测：改动后可 undo 回原坐标）。
 *  - 被调的 `store.relayout()`（useFlowStore）自身**不带** commit，它只负责算坐标。
 *  - 若日后把 `store.relayout()` 接到 UI 按钮（如工具栏「重新布局」），**必须自行补一次 commit**，
 *    否则那条路径改了坐标却不进撤销栈。
 *  - 反之：若给 `store.relayout()` 内部补 commit，则经由本函数时会压**两条**历史，
 *    撤销要按两次且中间态错乱 —— 故 `relayout()` 与 `layout()` 两边**只能有一处** commit。
 */
function layout(): ApiResult<FlowGraph> {
  return guard((graph, store) => {
    // 优先用 store 的 relayout（它会持久化），没有则就地重排
    if (!callFirst(store, ['relayout', 'tidyLayout'], [])) {
      layoutTimeline(graph)
    }
    return ok(deepClone(readActiveGraph(store) ?? graph))
  })
}

function setSettings(patch: Partial<GraphSettings>): ApiResult<GraphSettings> {
  return guard((graph, store) => {
    if (!patch || typeof patch !== 'object') return fail('setSettings 失败：patch 必须是对象')
    if (!callFirst(store, ['setSettings'], [patch])) {
      Object.assign(graph.settings, patch)
      relayoutIfNeeded(graph)
    }
    return ok(deepClone((readActiveGraph(store) ?? graph).settings))
  })
}

/** 取回「改完之后」的节点：优先从图里重新查，避免返回修改前的快照 */
function currentNode(graph: FlowGraph, id: string): StoryNode {
  return findNode(graph, id) ?? ({ id } as StoryNode)
}

/* ---- 导出 ---- */

function exportSVG(): ApiResult<string> {
  const state = getState()
  if (!state.ok || !state.data) return fail(state.error ?? '导出失败：拿不到当前图')
  try {
    return ok(toSvgString(state.data))
  } catch (e) {
    return fail(`exportSVG 失败：${errMessage(e)}`)
  }
}

function exportJSON(): ApiResult<string> {
  const state = getState()
  if (!state.ok || !state.data) return fail(state.error ?? '导出失败：拿不到当前图')
  try {
    return ok(exportJson(state.data))
  } catch (e) {
    return fail(`exportJSON 失败：${errMessage(e)}`)
  }
}

function exportMermaid(): ApiResult<string> {
  const state = getState()
  if (!state.ok || !state.data) return fail(state.error ?? '导出失败：拿不到当前图')
  try {
    return ok(toMermaid(state.data))
  } catch (e) {
    return fail(`exportMermaid 失败：${errMessage(e)}`)
  }
}

function exportDrawio(): ApiResult<string> {
  const state = getState()
  if (!state.ok || !state.data) return fail(state.error ?? '导出失败：拿不到当前图')
  try {
    return ok(toDrawio(state.data))
  } catch (e) {
    return fail(`exportDrawio 失败：${errMessage(e)}`)
  }
}

function exportMarkdown(): ApiResult<string> {
  const state = getState()
  if (!state.ok || !state.data) return fail(state.error ?? '导出失败：拿不到当前图')
  try {
    return ok(toMarkdown(state.data))
  } catch (e) {
    return fail(`exportMarkdown 失败：${errMessage(e)}`)
  }
}

/** PNG 栅格化天然异步，是唯一返回 Promise 的方法 */
async function exportPNG(scale: 1 | 2 | 4 = 2): Promise<ApiResult<Blob>> {
  const state = getState()
  if (!state.ok || !state.data) return fail(state.error ?? '导出失败：拿不到当前图')
  try {
    const blob = await exportPng(state.data, { scale })
    return ok(blob)
  } catch (e) {
    return fail(`exportPNG 失败：${errMessage(e)}`)
  }
}

/** 导出并直接下载；返回下载的文件名 */
async function download(
  format: 'png' | 'svg' | 'json' | 'markdown' | 'mermaid' | 'drawio',
  scale: 1 | 2 | 4 = 2
): Promise<ApiResult<string>> {
  const state = getState()
  if (!state.ok || !state.data) return fail(state.error ?? '导出失败：拿不到当前图')
  try {
    const graph = state.data
    const filename = exportFilenameFor(graph, format)
    if (format === 'png') {
      downloadBlob(await exportPng(graph, { scale }), filename)
    } else {
      const text =
        format === 'svg'
          ? toSvgString(graph)
          : format === 'json'
            ? exportJson(graph)
            : format === 'markdown'
              ? toMarkdown(graph)
              : format === 'mermaid'
                ? toMermaid(graph)
                : toDrawio(graph)
      downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), filename)
    }
    return ok(filename)
  } catch (e) {
    return fail(`download 失败：${errMessage(e)}`)
  }
}

/* ---- 撤销 / 重做 / 重置 ---- */

function undo(): ApiResult<FlowGraph> {
  const store = currentStore()
  if (!store) return fail('状态尚未就绪，请先 await NovelFlow.ready()')
  // store 自带历史就用自带的（能覆盖 UI 手工操作），否则用 API 自己维护的栈
  if (callFirst(store, ['undo'], [])) {
    const graph = readActiveGraph(store)
    return graph ? ok(deepClone(graph)) : fail('undo 失败：拿不到当前图')
  }
  const graph = readActiveGraph(store)
  if (!graph) return fail('undo 失败：当前没有打开的故事线')
  const previous = undoStack.pop()
  if (!previous) return fail('undo 失败：没有可撤销的操作')
  redoStack.push(deepClone(graph))
  commit(store, restore(graph, previous))
  return ok(deepClone(graph))
}

function redo(): ApiResult<FlowGraph> {
  const store = currentStore()
  if (!store) return fail('状态尚未就绪，请先 await NovelFlow.ready()')
  if (callFirst(store, ['redo'], [])) {
    const graph = readActiveGraph(store)
    return graph ? ok(deepClone(graph)) : fail('redo 失败：拿不到当前图')
  }
  const graph = readActiveGraph(store)
  if (!graph) return fail('redo 失败：当前没有打开的故事线')
  const next = redoStack.pop()
  if (!next) return fail('redo 失败：没有可重做的操作')
  undoStack.push(deepClone(graph))
  commit(store, restore(graph, next))
  return ok(deepClone(graph))
}

/**
 * 清空当前故事线的全部节点与连线（保留故事线本身）。
 * 可通过 undo 恢复 —— 特意不写成「删库」，避免 AI 误调用造成不可逆损失。
 */
function reset(): ApiResult<FlowGraph> {
  // guard 已经打过快照，所以 reset 本身是可撤销的一步
  return guard((graph) => {
    graph.nodes = []
    graph.edges = []
    return ok(deepClone(graph))
  })
}

/* ------------------------------------------------------------------ */
/* 知识库 / 文档 / 记忆（task-002）                                      */
/*                                                                    */
/* 与图操作不同：kb 的全部状态在主进程 sql.js（桌面）/ IndexedDB        */
/* （浏览器），本模块只做「参数兜底 + 调 kbClient + 归一 ApiResult」，   */
/* 纪律与图方法一致：永不抛异常到调用方。                               */
/* ------------------------------------------------------------------ */

/** kbClient 的统一包装：它抛出的中文错误 → {ok:false, error} */
async function kbCall<T>(fn: () => Promise<T>): Promise<ApiResult<T>> {
  try {
    return ok(await fn())
  } catch (e) {
    return fail(errMessage(e))
  }
}

/** 标签兜底：只收字符串、去空白、限 50 个（与 kbClient / MCP 层同口径） */
function safeTags(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = raw
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 50)
  return out
}

async function kbAddEntry(input: CreateEntryInput): Promise<ApiResult<KnowledgeEntry>> {
  const title = String(input?.title ?? '').trim()
  if (!title) return fail('kbAddEntry 失败：条目标题不能为空')
  const tags = safeTags(input?.tags)
  return kbCall(() =>
    createEntry({
      title,
      ...(input?.type ? { type: input.type } : {}),
      ...(input?.content !== undefined ? { content: String(input.content) } : {}),
      ...(tags ? { tags } : {})
    })
  )
}

async function kbUpdateEntry(id: string, patch: UpdateEntryInput): Promise<ApiResult<KnowledgeEntry>> {
  const key = String(id ?? '').trim()
  if (!key) return fail('kbUpdateEntry 失败：id 不能为空')
  if (!patch || typeof patch !== 'object') return fail('kbUpdateEntry 失败：patch 必须是对象')
  const tags = safeTags(patch.tags)
  // 下面按已知键显式构造 safe：控制台直调时多带的键（含 id）天然被剥掉
  const safe: UpdateEntryInput = {
    ...(patch.title !== undefined ? { title: String(patch.title) } : {}),
    ...(patch.type ? { type: patch.type } : {}),
    ...(patch.content !== undefined ? { content: String(patch.content) } : {}),
    ...(tags ? { tags } : {})
  }
  try {
    const entry = await updateEntry(key, safe)
    if (!entry) return fail(`kbUpdateEntry 失败：找不到条目 ${key}`)
    return ok(entry)
  } catch (e) {
    return fail(`kbUpdateEntry 失败：${errMessage(e)}`)
  }
}

async function kbRemoveEntry(id: string): Promise<ApiResult<boolean>> {
  const key = String(id ?? '').trim()
  if (!key) return fail('kbRemoveEntry 失败：id 不能为空')
  return kbCall(() => removeEntry(key))
}

async function kbListEntries(type?: KnowledgeType): Promise<ApiResult<KnowledgeEntry[]>> {
  return kbCall(async () => {
    const all = await listEntries()
    return type ? all.filter((e) => e.type === type) : all
  })
}

async function kbSearch(query: string): Promise<ApiResult<KnowledgeEntry[]>> {
  const q = String(query ?? '').trim()
  if (!q) return fail('kbSearch 失败：关键词不能为空')
  return kbCall(() => searchEntries(q))
}

async function kbLinkNode(entryId: string, nodeId: string): Promise<ApiResult<boolean>> {
  const e = String(entryId ?? '').trim()
  const n = String(nodeId ?? '').trim()
  if (!e || !n) return fail('kbLinkNode 失败：entryId 与 nodeId 都不能为空')
  return kbCall(() => linkEntry(e, n))
}

async function kbUnlinkNode(entryId: string, nodeId: string): Promise<ApiResult<boolean>> {
  const e = String(entryId ?? '').trim()
  const n = String(nodeId ?? '').trim()
  if (!e || !n) return fail('kbUnlinkNode 失败：entryId 与 nodeId 都不能为空')
  return kbCall(() => unlinkEntry(e, n))
}

async function kbListNodeLinks(nodeId: string): Promise<ApiResult<NodeLinks>> {
  const n = String(nodeId ?? '').trim()
  if (!n) return fail('kbListNodeLinks 失败：nodeId 不能为空')
  return kbCall(() => listLinksForNode(n))
}

async function docAdd(input: CreateDocInput): Promise<ApiResult<KbDocument>> {
  const title = String(input?.title ?? '').trim()
  if (!title) return fail('docAdd 失败：文档标题不能为空')
  const content = String(input?.content ?? '')
  if (!content.trim()) return fail('docAdd 失败：文档内容不能为空')
  return kbCall(() =>
    createDoc({
      title,
      format: input?.format ?? 'md',
      content
    })
  )
}

async function docList(): Promise<ApiResult<KbDocument[]>> {
  return kbCall(() => listDocs())
}

async function docGet(id: string): Promise<ApiResult<KbDocument | null>> {
  const key = String(id ?? '').trim()
  if (!key) return fail('docGet 失败：id 不能为空')
  return kbCall(() => getDoc(key))
}

async function docUpdate(id: string, patch: UpdateDocInput): Promise<ApiResult<KbDocument>> {
  const key = String(id ?? '').trim()
  if (!key) return fail('docUpdate 失败：id 不能为空')
  if (!patch || typeof patch !== 'object') return fail('docUpdate 失败：patch 必须是对象')
  // 按已知键显式构造：id 与 format 不可改（format 决定解析口径，
  // 改了会让已存锚点的偏移量失效）；控制台直调多带的键天然被剥掉
  const safe: UpdateDocInput = {
    ...(patch.title !== undefined ? { title: String(patch.title) } : {}),
    ...(patch.content !== undefined ? { content: String(patch.content) } : {})
  }
  try {
    const doc = await updateDoc(key, safe)
    if (!doc) return fail(`docUpdate 失败：找不到文档 ${key}`)
    return ok(doc)
  } catch (e) {
    return fail(`docUpdate 失败：${errMessage(e)}`)
  }
}

async function docRemove(id: string): Promise<ApiResult<boolean>> {
  const key = String(id ?? '').trim()
  if (!key) return fail('docRemove 失败：id 不能为空')
  return kbCall(() => removeDoc(key))
}

/**
 * 文档锚点（AI 侧入口）：与 UI 划词建锚点不同，AI 只有 quote 文本，
 * 因此先读文档全文，用 relocateAnchor 现定位偏移量再入库 ——
 * 定位不到（confidence: 'none'）返回中文错误，绝不存错位锚点。
 */
async function docAnchor(input: {
  docId: string
  quote: string
  hint?: number
  nodeId?: string
  note?: string
}): Promise<ApiResult<DocAnchor>> {
  const docId = String(input?.docId ?? '').trim()
  const quote = String(input?.quote ?? '').trim()
  if (!docId) return fail('docAnchor 失败：docId 不能为空')
  if (!quote) return fail('docAnchor 失败：quote 不能为空')
  try {
    const doc = await getDoc(docId)
    if (!doc) return fail(`docAnchor 失败：找不到文档 ${docId}`)
    const content = doc.content ?? ''
    // hint 是单点偏移量：扩展成 [hint, hint + quote.length] 的窗口供模糊匹配
    const hintWindow =
      typeof input.hint === 'number' && Number.isFinite(input.hint)
        ? { startOffset: Math.max(0, Math.trunc(input.hint)), endOffset: Math.max(0, Math.trunc(input.hint)) + quote.length }
        : null
    const hit = relocateAnchor(content, quote, hintWindow)
    if (hit.confidence === 'none') {
      return fail('docAnchor 失败：在文档里定位不到这段文字——请确认 quote 与文档内容一致（可附 hint 偏移量）')
    }
    const anchor = await createAnchor({
      docId,
      quote,
      startOffset: hit.start,
      endOffset: hit.end,
      ...(input.nodeId ? { nodeId: String(input.nodeId) } : {}),
      ...(input.note ? { note: String(input.note) } : {})
    })
    return ok(anchor)
  } catch (e) {
    return fail(`docAnchor 失败：${errMessage(e)}`)
  }
}

async function docLinkNode(docId: string, nodeId: string): Promise<ApiResult<boolean>> {
  const d = String(docId ?? '').trim()
  const n = String(nodeId ?? '').trim()
  if (!d || !n) return fail('docLinkNode 失败：docId 与 nodeId 都不能为空')
  return kbCall(() => linkDoc(d, n))
}

async function docUnlinkNode(docId: string, nodeId: string): Promise<ApiResult<boolean>> {
  const d = String(docId ?? '').trim()
  const n = String(nodeId ?? '').trim()
  if (!d || !n) return fail('docUnlinkNode 失败：docId 与 nodeId 都不能为空')
  return kbCall(() => unlinkDoc(d, n))
}

async function memoryAdd(input: CreateMemoryInput): Promise<ApiResult<MemoryEntry>> {
  const content = String(input?.content ?? '').trim()
  if (!content) return fail('memoryAdd 失败：记忆内容不能为空')
  return kbCall(() =>
    createMemory({
      type: input?.type ?? 'preference',
      content,
      // AI 侧新增统一记 manual：来源语义由界面转存（assist）与整理升格（auto）区分
      ...(input?.source ? { source: input.source } : {}),
      ...(input?.pinned !== undefined ? { pinned: !!input.pinned } : {})
    })
  )
}

async function memoryList(): Promise<ApiResult<MemoryEntry[]>> {
  return kbCall(() => listMemories())
}

async function memoryUpdate(id: string, patch: UpdateMemoryInput): Promise<ApiResult<MemoryEntry>> {
  const key = String(id ?? '').trim()
  if (!key) return fail('memoryUpdate 失败：id 不能为空')
  if (!patch || typeof patch !== 'object') return fail('memoryUpdate 失败：patch 必须是对象')
  // 按已知键显式构造 safe：id 不可改；控制台直调多带的键天然被剥掉
  const safe: UpdateMemoryInput = {
    ...(patch.type ? { type: patch.type } : {}),
    ...(patch.content !== undefined ? { content: String(patch.content) } : {}),
    ...(patch.pinned !== undefined ? { pinned: !!patch.pinned } : {})
  }
  try {
    const m = await updateMemory(key, safe)
    if (!m) return fail(`memoryUpdate 失败：找不到记忆 ${key}`)
    return ok(m)
  } catch (e) {
    return fail(`memoryUpdate 失败：${errMessage(e)}`)
  }
}

async function memoryRemove(id: string): Promise<ApiResult<boolean>> {
  const key = String(id ?? '').trim()
  if (!key) return fail('memoryRemove 失败：id 不能为空')
  return kbCall(() => removeMemory(key))
}

/* ---- 批量 ---- */

/**
 * 顺序执行多条命令，收集结果数组。
 * 单条失败只记录失败，**不中断**后续命令 —— 这是给 AI 批量写入用的核心能力。
 * @example NovelFlow.batch([['addNode',{title:'雨夜'}], ['setStatus', id, 'done']])
 */
function batch(commands: Array<[string, ...unknown[]]>): ApiResult<ApiResult[]> {
  if (!Array.isArray(commands)) return fail('batch 失败：参数必须是命令数组')
  const results: ApiResult[] = []
  for (const command of commands) {
    if (!Array.isArray(command) || typeof command[0] !== 'string') {
      results.push(fail('batch 失败：每条命令必须是 [方法名, ...参数]'))
      continue
    }
    const [name, ...args] = command
    const fn = (api as unknown as Record<string, unknown>)[name]
    if (typeof fn !== 'function') {
      results.push(fail(`batch 失败：没有这个方法「${name}」`))
      continue
    }
    try {
      results.push((fn as (...a: unknown[]) => ApiResult).apply(api, args))
    } catch (e) {
      results.push(fail(`batch 中「${name}」执行异常：${errMessage(e)}`))
    }
  }
  return ok(results)
}

/** 订阅状态变更（防抖 120ms），返回取消订阅函数 */
function subscribe(cb: (graph: FlowGraph) => void): () => void {
  if (typeof cb !== 'function') return () => undefined
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}

/* ------------------------------------------------------------------ */
/* 帮助清单                                                            */
/* ------------------------------------------------------------------ */

const HELP_LIST: HelpItem[] = [
  { name: 'ready', signature: 'ready(): Promise<boolean>', desc: '等待 store 就绪，首次调用前先 await 一次最稳妥' },
  { name: 'getState', signature: 'getState()', desc: '返回当前故事线的深拷贝（含 nodes / edges / settings）' },
  { name: 'listFlows', signature: 'listFlows()', desc: '列出全部故事线：id / 名称 / 节点数 / 连线数' },
  { name: 'addFlow', signature: 'addFlow(name, opts?)', desc: '新建一条故事线并切换过去，opts 可覆盖 settings' },
  { name: 'openFlow', signature: 'openFlow(idOrName)', desc: '按 id 或名称打开某条故事线' },
  { name: 'removeFlow', signature: 'removeFlow(id)', desc: '删除指定的故事线' },
  { name: 'renameFlow', signature: 'renameFlow(name)', desc: '重命名当前故事线' },
  { name: 'addNode', signature: 'addNode({title, afterId?, branchOf?, ...})', desc: '新增节点：给 afterId 插到其后并连线；给 branchOf 拉横向分支；都不给则追加到主线末尾。例外：kind:"character" 不走时间线——不支持 afterId/branchOf（传了会报错），自动落人物保留道且不连边；显式传 lane 的人物卡会按该 lane 参与导出分组（可能进主线桶），不传 lane 才进保留道' },
  { name: 'addNodes', signature: 'addNodes([...])', desc: '批量新增，按数组顺序自动串联成一条链；人物卡（kind:"character"）不参与链：不串联、不连边、不带偏后续项' },
  { name: 'addEdge', signature: 'addEdge(sourceId, targetId, {label?, kind?, sourceHandle?, targetHandle?})', desc: '新增连线，kind 可选 flow / branch / flashback / jump；sourceHandle / targetHandle 可选 top / bottom / left / right，缺省 = 按 kind 规则自动推断' },
  { name: 'removeEdge', signature: 'removeEdge(id)', desc: '删除指定连线' },
  { name: 'updateEdge', signature: 'updateEdge(id, patch)', desc: '修改连线的 label / kind / dashed / sourceHandle / targetHandle（不可改 id 与端点）' },
  { name: 'addNote', signature: 'addNote(nodeId, text)', desc: '追加备注，多次调用换行拼接，不覆盖已有内容' },
  { name: 'addCharacter', signature: 'addCharacter(nodeId, name)', desc: '给节点追加人物（自动去重）' },
  { name: 'addTag', signature: 'addTag(nodeId, tag)', desc: '给节点追加标签（自动去重）' },
  { name: 'updateNode', signature: 'updateNode(id, patch)', desc: '任意字段更新（id 不可改）；改 lane/order 会自动重排' },
  { name: 'removeNode', signature: 'removeNode(id)', desc: '删除节点，并连带删除挂在它上面的连线' },
  { name: 'setChapter', signature: 'setChapter(nodeId, chapter)', desc: '设置章节' },
  { name: 'setStatus', signature: 'setStatus(nodeId, status)', desc: '设置状态：planned / drafted / done' },
  { name: 'setNodeImage', signature: 'setNodeImage(nodeId, url, prompt?)', desc: '设置节点配图，只存远端 URL' },
  { name: 'layout', signature: 'layout()', desc: '重跑时间线自动布局' },
  { name: 'setSettings', signature: 'setSettings(patch)', desc: '修改画布设置：layoutMode / direction / rowGap / laneGap / canvasMode …' },
  { name: 'exportPNG', signature: 'exportPNG(scale?)', desc: '导出 PNG（1/2/4 倍），返回 Promise<{ok,data:Blob}>' },
  { name: 'exportSVG', signature: 'exportSVG()', desc: '导出独立 SVG 文本' },
  { name: 'exportJSON', signature: 'exportJSON()', desc: '导出带版本信封的 JSON 文本' },
  { name: 'exportMermaid', signature: 'exportMermaid()', desc: '导出 Mermaid flowchart 文本（已做语法转义）' },
  { name: 'exportDrawio', signature: 'exportDrawio()', desc: '导出 draw.io / Visio 可打开的 mxGraph XML' },
  { name: 'exportMarkdown', signature: 'exportMarkdown()', desc: '导出 Markdown 大纲（含 YAML front matter）' },
  { name: 'download', signature: 'download(format, scale?)', desc: '导出并直接触发浏览器下载，返回文件名' },
  { name: 'undo', signature: 'undo()', desc: '撤销一步（优先用 store 的历史，否则用 API 自带的栈）' },
  { name: 'redo', signature: 'redo()', desc: '重做一步' },
  { name: 'reset', signature: 'reset()', desc: '清空当前故事线的全部节点与连线，可 undo 恢复' },
  { name: 'batch', signature: 'batch([[name, ...args], ...])', desc: '顺序执行多条命令，单条失败不中断，收集全部结果' },
  { name: 'subscribe', signature: 'subscribe(cb)', desc: '订阅状态变更（防抖 120ms），返回取消订阅函数' },
  { name: 'help', signature: 'help()', desc: '返回本清单' },
  { name: 'kbAddEntry', signature: 'kbAddEntry({title, type?, content?, tags?})', desc: '新建知识条目（note / setting / character / plot / style）' },
  { name: 'kbUpdateEntry', signature: 'kbUpdateEntry(id, patch)', desc: '更新知识条目（id 不可改）' },
  { name: 'kbRemoveEntry', signature: 'kbRemoveEntry(id)', desc: '删除知识条目（连带解除节点关联）' },
  { name: 'kbListEntries', signature: 'kbListEntries(type?)', desc: '列出知识条目（可按类型过滤，列表不带正文）' },
  { name: 'kbSearch', signature: 'kbSearch(query)', desc: '搜索知识条目（标题 / 标签 / 正文加权 + 时间衰减）' },
  { name: 'kbLinkNode', signature: 'kbLinkNode(entryId, nodeId)', desc: '把知识条目关联到节点（写故事时可被检索注入）' },
  { name: 'kbUnlinkNode', signature: 'kbUnlinkNode(entryId, nodeId)', desc: '解除知识条目与节点的关联' },
  { name: 'kbListNodeLinks', signature: 'kbListNodeLinks(nodeId)', desc: '反查节点关联的全部知识条目与文档' },
  { name: 'docAdd', signature: 'docAdd({title, format?, content})', desc: '新建文档（md / txt / docx 纯文本直接入库）' },
  { name: 'docList', signature: 'docList()', desc: '列出全部文档（不含正文）' },
  { name: 'docGet', signature: 'docGet(id)', desc: '读取文档全文（含 content）' },
  { name: 'docUpdate', signature: 'docUpdate(id, patch)', desc: '更新文档标题或正文（id 与 format 不可改）' },
  { name: 'docRemove', signature: 'docRemove(id)', desc: '删除文档（连带删除锚点与节点关联）' },
  { name: 'docAnchor', signature: 'docAnchor({docId, quote, hint?, nodeId?, note?})', desc: '把文档里的一段文字建成锚点（自动模糊重定位），可同时关联节点' },
  { name: 'docLinkNode', signature: 'docLinkNode(docId, nodeId)', desc: '把整篇文档关联到节点' },
  { name: 'docUnlinkNode', signature: 'docUnlinkNode(docId, nodeId)', desc: '解除文档与节点的关联' },
  { name: 'memoryAdd', signature: 'memoryAdd({type?, content, pinned?})', desc: '新增作者记忆（preference / fact / decision / background）' },
  { name: 'memoryList', signature: 'memoryList()', desc: '列出全部作者记忆' },
  { name: 'memoryUpdate', signature: 'memoryUpdate(id, patch)', desc: '更新记忆（id 不可改）' },
  { name: 'memoryRemove', signature: 'memoryRemove(id)', desc: '删除一条作者记忆' }
]

function help(): ApiResult<HelpItem[]> {
  return ok(HELP_LIST.map((item) => ({ ...item })))
}

/** 把 help 清单渲染成可复制的多行文本（控制台 UI 用） */
export function helpText(): string {
  return HELP_LIST.map((item) => `${item.signature}\n    ${item.desc}`).join('\n')
}

/* ------------------------------------------------------------------ */
/* 组装与安装                                                          */
/* ------------------------------------------------------------------ */

export const api: NovelFlowApi = {
  version: '1.0.0',
  ready: async (): Promise<boolean> => {
    const store = await ensureStore()
    return !!store
  },
  getState,
  listFlows,
  addFlow,
  openFlow,
  removeFlow,
  renameFlow,
  addNode,
  addNodes,
  addEdge,
  removeEdge,
  updateEdge,
  addNote,
  addCharacter,
  addTag,
  updateNode,
  removeNode,
  setChapter,
  setStatus,
  setNodeImage,
  layout,
  setSettings,
  exportPNG,
  exportSVG,
  exportJSON,
  exportMermaid,
  exportDrawio,
  exportMarkdown,
  download,
  undo,
  redo,
  reset,
  batch,
  subscribe,
  help,
  kbAddEntry,
  kbUpdateEntry,
  kbRemoveEntry,
  kbListEntries,
  kbSearch,
  kbLinkNode,
  kbUnlinkNode,
  kbListNodeLinks,
  docAdd,
  docList,
  docGet,
  docUpdate,
  docRemove,
  docAnchor,
  docLinkNode,
  docUnlinkNode,
  memoryAdd,
  memoryList,
  memoryUpdate,
  memoryRemove
}

declare global {
  interface Window {
    NovelFlow?: NovelFlowApi
  }
}

/**
 * 把 API 挂到 window.NovelFlow。
 * 幂等：重复调用只会覆盖引用，不会重复注册订阅。
 */
export function installNovelFlow(): NovelFlowApi {
  if (typeof window !== 'undefined') {
    window.NovelFlow = api
  }
  return api
}

// 模块被 import 时自动安装并预取 store：等到用户真正调用时，store 早已缓存好
if (typeof window !== 'undefined') {
  installNovelFlow()
  void ensureStore()
}

export default api
