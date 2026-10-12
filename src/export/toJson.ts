import type { FlowGraph, GraphSettings, StoryEdge, StoryNode } from '@/types/graph'
import { createGraph, sanitizeEdge, sanitizeNode } from '@/core/model'
import { uid } from './utils'

/**
 * JSON 导出 / 导入
 *
 * 导出的是「带信封」的结构：{ kind, version, exportedAt, graph }。
 * 多一层信封的好处是以后改数据结构时，导入端可以依据 version 走不同的兜底策略，
 * 而不是面对一份裸的 FlowGraph 瞎猜。
 *
 * 导入端刻意做成「宽容」：缺字段补默认值、非法字段丢弃、重复的 id 重新分配，
 * 只有「根本不是流程图数据」（没有 nodes 数组）才抛错。
 */

/** 当前文件格式版本号 */
export const GRAPH_FILE_VERSION = 1
/** 文件类型标识，用于快速判断一份 JSON 是不是本工具产出的 */
export const GRAPH_FILE_KIND = 'novelflow-graph'

/** 导出文件信封 */
export interface GraphFileEnvelope {
  kind: typeof GRAPH_FILE_KIND
  version: number
  exportedAt: string
  graph: FlowGraph
}

/**
 * 导出为 JSON 字符串。
 * @param graph 待导出的流程图
 * @returns 带信封的 JSON 文本（缩进 2 空格，便于人读与 git diff）
 */
export function exportJson(graph: FlowGraph): string {
  const envelope: GraphFileEnvelope = {
    kind: GRAPH_FILE_KIND,
    version: GRAPH_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    graph
  }
  return JSON.stringify(envelope, null, 2)
}

/**
 * 解析 JSON 文本为 FlowGraph。
 * 兼容两种形态：带信封的导出文件、裸的 FlowGraph。
 * @throws 非法 JSON / 缺少 nodes / 版本号高于当前程序时抛出明确 Error
 */
export function parseJson(text: string): FlowGraph {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('JSON 导入失败：文本不是合法的 JSON')
  }
  const payload = unwrapEnvelope(raw)
  return normalizeGraph(payload)
}

/** 剥掉信封（如果有），并做版本号校验 */
function unwrapEnvelope(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') {
    throw new Error('JSON 导入失败：顶层必须是对象')
  }
  const r = raw as Record<string, unknown>
  const isEnvelope =
    r.kind === GRAPH_FILE_KIND || (r.graph && typeof r.graph === 'object' && 'nodes' in r)
  if (!isEnvelope) return raw

  if (typeof r.version === 'number' && r.version > GRAPH_FILE_VERSION) {
    throw new Error(
      `JSON 导入失败：文件版本 v${r.version} 高于当前程序支持的 v${GRAPH_FILE_VERSION}，请升级后重试`
    )
  }
  return r.graph
}

/**
 * 把任意来源的对象规整成合法 FlowGraph（字段兜底 + id 去重 + 类型收敛）。
 * @throws 缺少 nodes 数组时抛出
 */
export function normalizeGraph(raw: unknown): FlowGraph {
  if (!raw || typeof raw !== 'object') {
    throw new Error('JSON 导入失败：图数据必须是对象')
  }
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.nodes)) {
    throw new Error('JSON 导入失败：缺少 nodes 数组')
  }

  const used = new Set<string>()
  const nodes: StoryNode[] = []
  for (const item of r.nodes) {
    const fixed = ensureId(item, 'n', used)
    const node = sanitizeNode(fixed)
    if (node) {
      used.add(node.id)
      nodes.push(node)
    }
  }

  const nodeIds = new Set(nodes.map((n) => n.id))
  const edgeIds = new Set<string>()
  const edges: StoryEdge[] = []
  if (Array.isArray(r.edges)) {
    for (const item of r.edges) {
      const fixed = ensureId(item, 'e', edgeIds)
      const edge = sanitizeEdge(fixed, nodeIds)
      if (edge) {
        edgeIds.add(edge.id)
        edges.push(edge)
      }
    }
  }

  const base = createGraph(typeof r.name === 'string' && r.name ? r.name : '导入的故事线')
  const graph: FlowGraph = {
    id: typeof r.id === 'string' && r.id ? r.id : base.id,
    name: typeof r.name === 'string' && r.name ? r.name : base.name,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : base.createdAt,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : Date.now(),
    nodes,
    edges,
    settings: normalizeSettings(r.settings)
  }
  if (typeof r.cover === 'string') graph.cover = r.cover

  reindexOrders(graph)
  return graph
}

/** settings 字段兜底 */
export function normalizeSettings(raw: unknown): GraphSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return {
    layoutMode: r.layoutMode === 'free' ? 'free' : 'timeline',
    direction: r.direction === 'horizontal' ? 'horizontal' : 'vertical',
    gridSnap: typeof r.gridSnap === 'boolean' ? r.gridSnap : true,
    canvasMode: r.canvasMode === 'dark' ? 'dark' : 'light',
    rowGap: num(r.rowGap, 200),
    laneGap: num(r.laneGap, 320)
  }
}

/** 保证对象有字符串 id，且与已用 id 不冲突 */
function ensureId(item: unknown, prefix: string, used: Set<string>): unknown {
  if (!item || typeof item !== 'object') return item
  const r = item as Record<string, unknown>
  if (typeof r.id === 'string' && r.id && !used.has(r.id)) return item
  let id = uid(prefix)
  while (used.has(id)) id = uid(prefix)
  return { ...r, id }
}

/** 若导入数据的 order 全部塌陷为相同值，按 lane 内出现顺序重新编号 */
function reindexOrders(graph: FlowGraph): void {
  const byLane = new Map<number, StoryNode[]>()
  for (const n of graph.nodes) {
    const list = byLane.get(n.lane)
    if (list) list.push(n)
    else byLane.set(n.lane, [n])
  }
  for (const list of byLane.values()) {
    const hasGap = new Set(list.map((n) => n.order)).size !== list.length
    const collapsed = list.every((n) => n.order === list[0].order)
    if (hasGap || collapsed) {
      list.forEach((n, i) => {
        n.order = i
      })
    }
  }
}
