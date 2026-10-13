/**
 * NovelFlow 数据契约 —— 唯一事实源
 *
 * 本文件是 plan.md 第 4 节的直接落地，字段命名与结构不得擅自更改：
 * 导出层（Max-B）、Inspector（Max-C）、测试（Tess）均以此为唯一依据。
 */

export type NodeStatus = 'planned' | 'drafted' | 'done'

export type NodeKind =
  | 'event'
  | 'scene'
  | 'decision'
  | 'character'
  | 'milestone'
  | 'note'

export interface NodeImage {
  url: string
  prompt?: string
  createdAt?: number
}

export interface StoryNode {
  id: string
  kind: NodeKind
  title: string
  /** 故事内时间，如「第一章 · 雨夜」「三年后」 */
  timeLabel: string
  /** 卡片上显示的简短描述 */
  summary: string
  /** 完整故事正文（抽屉里编辑） */
  content: string
  characters: string[]
  location: string
  tags: string[]
  status: NodeStatus
  chapter: string
  /** 卡片主色：token 名或 hex */
  color: string
  /** 0 = 主线；±1, ±2 为分支列 */
  lane: number
  x: number
  y: number
  w: number
  h: number
  /** 备注（AI 可写） */
  note?: string
  image?: NodeImage
  /** 主线顺序（自动布局权重） */
  order: number
  /**
   * 手动摆放标记（round3 新增）：true 表示 x/y 由用户决定，
   * `layoutTimeline` 不得改写其坐标与 order；点工具栏「整理」会清除全部标记。
   * `kind === 'character'` 的节点永久豁免，不依赖此字段。
   */
  pinned?: boolean
}

export type EdgeKind = 'flow' | 'branch' | 'flashback' | 'jump'

export interface StoryEdge {
  id: string
  source: string
  target: string
  label?: string
  kind: EdgeKind
  dashed?: boolean
  /**
   * 连线起端锚点（四向手柄：上/下/左/右）。
   * 缺省 = 按 kind 规则自动推断，兼容旧数据（刷新不丢既有边的观感）。
   */
  sourceHandle?: PortSide
  /** 连线末端锚点；缺省语义同 sourceHandle */
  targetHandle?: PortSide
}

export interface GraphSettings {
  layoutMode: 'timeline' | 'free'
  direction: 'vertical' | 'horizontal'
  gridSnap: boolean
  canvasMode: 'light' | 'dark'
  rowGap: number
  laneGap: number
}

export interface FlowGraph {
  id: string
  name: string
  cover?: string
  createdAt: number
  updatedAt: number
  nodes: StoryNode[]
  edges: StoryEdge[]
  settings: GraphSettings
}

export interface UiPrefs {
  theme: 'dark' | 'light'
  sidebarCollapsed: boolean
  lastGraphId?: string
  showMinimap: boolean
  snapEnabled: boolean
  [key: string]: unknown
}

export interface FlowWorkspace {
  version: 1
  graphs: FlowGraph[]
  activeId: string
  ui: UiPrefs
}

/* ------------------------------------------------------------------ */
/* 派生类型（不影响存储结构，仅供 UI 层使用）                            */
/* ------------------------------------------------------------------ */

export type PortSide = 'top' | 'bottom' | 'left' | 'right'

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const NODE_KINDS: NodeKind[] = [
  'event',
  'scene',
  'decision',
  'character',
  'milestone',
  'note'
]

export const EDGE_KINDS: EdgeKind[] = ['flow', 'branch', 'flashback', 'jump']

export const NODE_STATUSES: NodeStatus[] = ['planned', 'drafted', 'done']

/** 节点类型 → 默认主色（青 / 金 两个家族内取值，避免杂色） */
export const KIND_COLOR: Record<NodeKind, string> = {
  event: 'teal',
  scene: 'mist',
  decision: 'gold',
  character: 'clay',
  milestone: 'ink',
  note: 'sage'
}

export const KIND_LABEL: Record<NodeKind, string> = {
  event: '事件',
  scene: '场景',
  decision: '抉择',
  character: '人物',
  milestone: '里程碑',
  note: '备忘'
}

export const STATUS_LABEL: Record<NodeStatus, string> = {
  planned: '待写',
  drafted: '草稿',
  done: '已成稿'
}

export const EDGE_KIND_LABEL: Record<EdgeKind, string> = {
  flow: '顺序',
  branch: '分支',
  flashback: '倒叙',
  jump: '跳跃'
}
