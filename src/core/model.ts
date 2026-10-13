import {
  KIND_COLOR,
  type EdgeKind,
  type FlowGraph,
  type GraphSettings,
  type NodeKind,
  type NodeStatus,
  type PortSide,
  type StoryEdge,
  type StoryNode
} from '@/types/graph'
import { edgeId, graphId, nodeId } from './id'

/** 节点默认尺寸（timeline 模式下 h 会按内容略作自适应） */
export const DEFAULT_NODE_W = 268
export const DEFAULT_NODE_H = 132
export const MIN_NODE_W = 180
export const MAX_NODE_W = 460

export const DEFAULT_SETTINGS: GraphSettings = {
  layoutMode: 'timeline',
  direction: 'vertical',
  gridSnap: true,
  canvasMode: 'light',
  rowGap: 200,
  laneGap: 320
}

/**
 * 建一个空节点。
 * order 缺省为当前最大 order + 1，调用方可显式传入以插到指定位置。
 */
export function createNode(patch: Partial<StoryNode> = {}, fallbackOrder = 0): StoryNode {
  return {
    id: patch.id ?? nodeId(),
    kind: patch.kind ?? 'event',
    title: patch.title ?? '未命名事件',
    timeLabel: patch.timeLabel ?? '',
    summary: patch.summary ?? '',
    content: patch.content ?? '',
    characters: patch.characters ? [...patch.characters] : [],
    location: patch.location ?? '',
    tags: patch.tags ? [...patch.tags] : [],
    status: patch.status ?? 'planned',
    chapter: patch.chapter ?? '',
    color: patch.color ?? KIND_COLOR[patch.kind ?? 'event'],
    lane: patch.lane ?? 0,
    x: patch.x ?? 0,
    y: patch.y ?? 0,
    w: patch.w ?? DEFAULT_NODE_W,
    h: patch.h ?? DEFAULT_NODE_H,
    note: patch.note,
    image: patch.image,
    order: patch.order ?? fallbackOrder,
    pinned: patch.pinned ?? false
  }
}

export function createEdge(
  source: string,
  target: string,
  kind: EdgeKind = 'flow',
  label?: string,
  handles?: { sourceHandle?: PortSide; targetHandle?: PortSide }
): StoryEdge {
  const edge: StoryEdge = {
    id: edgeId(),
    source,
    target,
    kind
  }
  if (label !== undefined) edge.label = label
  if (kind === 'flashback') edge.dashed = true
  if (handles?.sourceHandle) edge.sourceHandle = handles.sourceHandle
  if (handles?.targetHandle) edge.targetHandle = handles.targetHandle
  return edge
}

export function createGraph(name = '新的故事线'): FlowGraph {
  const now = Date.now()
  return {
    id: graphId(),
    name,
    createdAt: now,
    updatedAt: now,
    nodes: [],
    edges: [],
    settings: { ...DEFAULT_SETTINGS }
  }
}

/* ------------------------------------------------------------------ */
/* 只读查询工具                                                        */
/* ------------------------------------------------------------------ */

export function findNode(graph: FlowGraph | undefined, id: string): StoryNode | undefined {
  return graph?.nodes.find((n) => n.id === id)
}

/** 主线（lane === 0）节点，按 order 升序 */
export function mainLine(graph: FlowGraph): StoryNode[] {
  return graph.nodes.filter((n) => n.lane === 0).sort((a, b) => a.order - b.order)
}

/** 某条 lane 上的节点，按 order 升序 */
export function laneNodes(graph: FlowGraph, lane: number): StoryNode[] {
  return graph.nodes.filter((n) => n.lane === lane).sort((a, b) => a.order - b.order)
}

export function nextOrder(graph: FlowGraph, lane = 0): number {
  const list = graph.nodes.filter((n) => n.lane === lane)
  if (!list.length) return 0
  return Math.max(...list.map((n) => n.order)) + 1
}

export function outgoing(graph: FlowGraph, id: string): StoryEdge[] {
  return graph.edges.filter((e) => e.source === id)
}

export function incoming(graph: FlowGraph, id: string): StoryEdge[] {
  return graph.edges.filter((e) => e.target === id)
}

/** 重排某 lane 的 order 为 0..n-1（保持传入顺序） */
export function reindexLane(graph: FlowGraph, lane: number, orderedIds: string[]): void {
  const index = new Map(orderedIds.map((id, i) => [id, i]))
  for (const node of graph.nodes) {
    if (node.lane === lane && index.has(node.id)) {
      node.order = index.get(node.id) as number
    }
  }
}

/* ------------------------------------------------------------------ */
/* 结构合法性（读 localStorage / 导入 JSON 时兜底）                     */
/* ------------------------------------------------------------------ */

const KIND_SET = new Set<string>(['event', 'scene', 'decision', 'character', 'milestone', 'note'])
const STATUS_SET = new Set<string>(['planned', 'drafted', 'done'])
const PORT_SIDE_SET = new Set<string>(['top', 'bottom', 'left', 'right'])

export function sanitizeNode(raw: unknown): StoryNode | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((i) => typeof i === 'string') : [])

  const kind: NodeKind = KIND_SET.has(str(r.kind)) ? (str(r.kind) as NodeKind) : 'event'
  const status: NodeStatus = STATUS_SET.has(str(r.status))
    ? (str(r.status) as NodeStatus)
    : 'planned'

  const node: StoryNode = {
    id: r.id,
    kind,
    title: str(r.title, '未命名事件'),
    timeLabel: str(r.timeLabel),
    summary: str(r.summary),
    content: str(r.content),
    characters: arr(r.characters),
    location: str(r.location),
    tags: arr(r.tags),
    status,
    chapter: str(r.chapter),
    color: str(r.color, KIND_COLOR[kind]),
    lane: Math.round(num(r.lane, 0)),
    x: num(r.x, 0),
    y: num(r.y, 0),
    w: clamp(num(r.w, DEFAULT_NODE_W), MIN_NODE_W, MAX_NODE_W),
    h: clamp(num(r.h, DEFAULT_NODE_H), 88, 320),
    order: num(r.order, 0),
    // 老数据无 pinned 字段 → 显式兜 false，类型上不留 undefined
    pinned: r.pinned === true
  }
  if (typeof r.note === 'string') node.note = r.note
  if (r.image && typeof r.image === 'object') {
    const img = r.image as Record<string, unknown>
    if (typeof img.url === 'string') {
      node.image = {
        url: img.url,
        ...(typeof img.prompt === 'string' ? { prompt: img.prompt } : {}),
        ...(typeof img.createdAt === 'number' ? { createdAt: img.createdAt } : {})
      }
    }
  }
  return node
}

export function sanitizeEdge(raw: unknown, nodeIds: Set<string>): StoryEdge | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  if (typeof r.source !== 'string' || typeof r.target !== 'string') return null
  if (!nodeIds.has(r.source) || !nodeIds.has(r.target)) return null
  const kindRaw = typeof r.kind === 'string' ? r.kind : 'flow'
  const kind: EdgeKind = (['flow', 'branch', 'flashback', 'jump'] as string[]).includes(kindRaw)
    ? (kindRaw as EdgeKind)
    : 'flow'
  const edge: StoryEdge = { id: r.id, source: r.source, target: r.target, kind }
  if (typeof r.label === 'string') edge.label = r.label
  if (typeof r.dashed === 'boolean') edge.dashed = r.dashed
  // 四向锚点：合法值才进白名单，非法值丢弃（回落 undefined = 按 kind 规则推断）。
  // 旧数据无此字段 ⇒ undefined，渲染行为与改造前完全一致。
  if (typeof r.sourceHandle === 'string' && PORT_SIDE_SET.has(r.sourceHandle)) {
    edge.sourceHandle = r.sourceHandle as PortSide
  }
  if (typeof r.targetHandle === 'string' && PORT_SIDE_SET.has(r.targetHandle)) {
    edge.targetHandle = r.targetHandle as PortSide
  }
  return edge
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

/** 深拷贝：localStorage 快照 / 撤销栈都用它，避免共享引用 */
export function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((i) => deepClone(i)) as unknown as T
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>)) {
    out[key] = deepClone((value as Record<string, unknown>)[key])
  }
  return out as T
}
