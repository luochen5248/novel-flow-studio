import type { FlowGraph, FlowWorkspace, UiPrefs } from '@/types/graph'
import { DEFAULT_SETTINGS, sanitizeEdge, sanitizeNode } from './model'
import { layoutTimeline } from './layout'
import { message } from 'ant-design-vue'

export const STORAGE_KEY = 'novelflow.workspace.v1'
export const WORKSPACE_VERSION = 1

export const DEFAULT_UI: UiPrefs = {
  theme: 'dark',
  sidebarCollapsed: false,
  showMinimap: true,
  snapEnabled: true
}

function emptyWorkspace(): FlowWorkspace {
  return { version: WORKSPACE_VERSION, graphs: [], activeId: '', ui: { ...DEFAULT_UI } }
}

/** 单图合法性兜底：任何脏数据都不应让界面白屏 */
export function sanitizeGraph(raw: unknown): FlowGraph | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null

  const nodesRaw = Array.isArray(r.nodes) ? r.nodes : []
  const nodes = nodesRaw.map(sanitizeNode).filter((n): n is NonNullable<typeof n> => !!n)
  const ids = new Set(nodes.map((n) => n.id))
  const edgesRaw = Array.isArray(r.edges) ? r.edges : []
  const edges = edgesRaw
    .map((e) => sanitizeEdge(e, ids))
    .filter((e): e is NonNullable<typeof e> => !!e)

  const settingsRaw = (r.settings ?? {}) as Record<string, unknown>
  const settings = {
    ...DEFAULT_SETTINGS,
    layoutMode: settingsRaw.layoutMode === 'free' ? ('free' as const) : ('timeline' as const),
    direction: settingsRaw.direction === 'horizontal' ? ('horizontal' as const) : ('vertical' as const),
    canvasMode: settingsRaw.canvasMode === 'dark' ? ('dark' as const) : ('light' as const),
    gridSnap: settingsRaw.gridSnap !== false,
    rowGap: typeof settingsRaw.rowGap === 'number' ? settingsRaw.rowGap : DEFAULT_SETTINGS.rowGap,
    laneGap: typeof settingsRaw.laneGap === 'number' ? settingsRaw.laneGap : DEFAULT_SETTINGS.laneGap
  }

  const now = Date.now()
  return {
    id: r.id,
    name: typeof r.name === 'string' && r.name ? r.name : '未命名故事线',
    ...(typeof r.cover === 'string' ? { cover: r.cover } : {}),
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : now,
    nodes,
    edges,
    settings
  }
}

export function sanitizeWorkspace(raw: unknown): FlowWorkspace {
  if (!raw || typeof raw !== 'object') return emptyWorkspace()
  const r = raw as Record<string, unknown>
  const graphs = (Array.isArray(r.graphs) ? r.graphs : [])
    .map(sanitizeGraph)
    .filter((g): g is FlowGraph => !!g)
  const uiRaw = (r.ui ?? {}) as Record<string, unknown>
  const ui: UiPrefs = {
    ...DEFAULT_UI,
    ...uiRaw,
    theme: uiRaw.theme === 'light' ? 'light' : 'dark'
  }
  const activeId =
    typeof r.activeId === 'string' && graphs.some((g) => g.id === r.activeId)
      ? r.activeId
      : graphs[0]?.id ?? ''
  return { version: WORKSPACE_VERSION, graphs, activeId, ui }
}

/** 读：localStorage 不可用 / JSON 损坏 ⇒ 降级为空工作区，绝不抛错 */
export function loadWorkspace(): FlowWorkspace {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyWorkspace()
    return sanitizeWorkspace(JSON.parse(raw))
  } catch (err) {
    console.warn('[NovelFlow] 读取本地工作区失败，已降级为空工作区', err)
    return emptyWorkspace()
  }
}

/** 写：配额超限 / 隐私模式禁用 ⇒ 静默失败，界面继续可用，但需让用户感知 */
export function saveWorkspace(ws: FlowWorkspace): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ws))
    return true
  } catch (err) {
    console.warn('[NovelFlow] 写入本地工作区失败（可能超过配额）', err)
    try {
      message.error('本地保存失败：存储空间已满或不可用，请清理后重试')
    } catch {
      /* 极端环境下 message 不可用，console 兜底已在上行 */
    }
    return false
  }
}

export function clearWorkspace(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* 忽略 */
  }
}

/* ------------------------------------------------------------------ */
/* 单图 JSON 导入 / 导出（侧栏「导入 / 导出 JSON」用）                    */
/* ------------------------------------------------------------------ */

export function serializeGraph(graph: FlowGraph): string {
  return JSON.stringify({ kind: 'novelflow.graph', version: WORKSPACE_VERSION, graph }, null, 2)
}

export function parseGraphFile(text: string): FlowGraph | null {
  try {
    const data = JSON.parse(text) as Record<string, unknown>
    const payload = data && data.graph ? data.graph : data
    const graph = sanitizeGraph(payload)
    if (!graph) return null
    if (!graph.nodes.some((n) => n.x || n.y)) layoutTimeline(graph)
    return graph
  } catch (err) {
    console.warn('[NovelFlow] JSON 解析失败', err)
    return null
  }
}

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  try {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (err) {
    console.warn('[NovelFlow] 下载失败', err)
  }
}
