import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type {
  EdgeKind,
  FlowGraph,
  FlowWorkspace,
  GraphSettings,
  NodeKind,
  PortSide,
  StoryEdge,
  StoryNode
} from '@/types/graph'
import { createEdge, createGraph, createNode, deepClone, nextOrder, DEFAULT_SETTINGS } from '@/core/model'
import { fitNodeHeight, layoutTimeline, tidyUp } from '@/core/layout'
import { planCharacterRename, type RenamePlan } from '@/core/characterRename'
import { history } from '@/core/history'
import { loadWorkspace, saveWorkspace } from '@/core/storage'
import { createSampleGraph } from '@/core/sample'
import { useUiStore } from './useUiStore'

export interface WriteOptions {
  /** true ⇒ 不产生历史记录（拖拽过程中由调用方在起点手动 commit 一次） */
  silent?: boolean
  /** 同 key 且在时间窗内 ⇒ 合并为一条历史 */
  merge?: string
}

/**
 * 会影响卡片高度估算的字段白名单。
 *
 * 严格对照 `core/layout.ts` 的 `fitNodeHeight` 实现 —— 它只读这 5 个字段：
 *   w（宽度决定每行字数）→ title.length → summary.length → characters.length → location
 * 刻意**不含** `chapter` / `status` / `note` / `content`：
 * `chapter` 虽在计划里被点名，但 fitNodeHeight 并不读它，加进来只会白白触发重算。
 *
 * 这条白名单同时是 `updateNode` 的**性能开关**：拖拽期 useNodeDrag 每个 pointermove
 * 都会silent 更新 `{x, y}`，不命中白名单 ⇒ 直接跳过重算，长图上零开销。
 */
const HEIGHT_KEYS = ['title', 'summary', 'characters', 'location', 'w'] as const

/** patch 是否可能改变该节点的高度估算 */
function affectsHeight(patch: Partial<StoryNode>): boolean {
  for (const k of HEIGHT_KEYS) {
    if (k in patch) return true
  }
  return false
}

const PERSIST_DELAY = 260

/**
 * 图数据主 store。
 *
 * 暴露给 UI 层（Max-C 的 Inspector / Max-B 的 window.NovelFlow）的 API 名称是契约，
 * 不得改名。所有写操作内部都会 commit 到 history 并自动持久化。
 */
export const useFlowStore = defineStore('flow', () => {
  const workspace = ref<FlowWorkspace>(loadWorkspace())
  const graphs = computed<FlowGraph[]>(() => workspace.value.graphs)
  const activeId = ref<string>(workspace.value.activeId || workspace.value.graphs[0]?.id || '')
  const selectedIds = ref<string[]>([])
  /** 结构变更计数器：确保数组增删改后 activeGraph 一定重算 */
  const rev = ref(0)

  const activeGraph = computed<FlowGraph | null>(() => {
    void rev.value
    return graphs.value.find((g) => g.id === activeId.value) ?? null
  })
  const currentNode = computed<StoryNode | null>(() => {
    const g = activeGraph.value
    if (!g || !selectedIds.value.length) return null
    return g.nodes.find((n) => n.id === selectedIds.value[0]) ?? null
  })
  const edges = computed<StoryEdge[]>(() => activeGraph.value?.edges ?? [])
  const nodes = computed<StoryNode[]>(() => activeGraph.value?.nodes ?? [])
  const favorites = computed<string[]>(() => (workspace.value.ui.favorites as string[]) ?? [])

  const canUndo = ref(history.canUndo)
  const canRedo = ref(history.canRedo)
  const lastMessage = ref('')

  /* ---------------- 持久化 ---------------- */

  let timer: ReturnType<typeof setTimeout> | null = null
  /**
   * 拖拽期持久化暂停标志（性能快赢 2 / G3）。
   * useNodeDrag 的 start→finish 期间为 true：拖拽每帧的 silent 更新不再触发
   * 260ms 防抖落盘，finish（onUp / onEsc / cancel 三条退出路径都会到）时补一次。
   */
  let dragPersistPaused = false

  function persist(): void {
    if (dragPersistPaused) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      saveWorkspace(workspace.value)
    }, PERSIST_DELAY)
  }

  /** 拖拽开始：暂停持久化（由 useNodeDrag.start 调用） */
  function pausePersist(): void {
    dragPersistPaused = true
  }

  /**
   * 拖拽结束：恢复持久化并立即落盘一次（由 useNodeDrag 的 cleanup 调用，
   * onUp / onEsc / cancel 三条退出路径全部经过 cleanup，不会漏）。
   */
  function resumePersist(): void {
    if (!dragPersistPaused) return
    dragPersistPaused = false
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    saveWorkspace(workspace.value)
  }

  /**
   * G4：边被删（直接删 / 删节点级联 / 中间插节点替换）后清掉失效的
   * selectedEdgeId，防止残留选中态让后续 Delete 误触发 removeEdge。
   * 在 store 动作内清理，快捷键与画布读到的一定是有效 id。
   */
  function clearStaleEdgeSelection(): void {
    const ui = useUiStore()
    const id = ui.selectedEdgeId
    if (id && !activeGraph.value?.edges.some((e) => e.id === id)) {
      ui.clearEdgeSelection()
    }
  }

  watch(
    () => workspace.value.ui,
    () => persist(),
    { deep: true }
  )

  /* ---------------- 历史 ---------------- */

  function syncHistoryFlags(): void {
    canUndo.value = history.canUndo
    canRedo.value = history.canRedo
  }

  /**
   * 把「当前状态」压入撤销栈。约定：在修改之前调用。
   * @param label 操作名
   * @param mergeKey 同 key 且在时间窗内 ⇒ 合并（拖动只留一条记录）
   */
  function commit(label = '编辑', mergeKey = ''): void {
    const g = activeGraph.value
    if (!g) return
    history.push(g, label, mergeKey)
    syncHistoryFlags()
  }

  /** 切换图时重置历史，避免把 A 图的快照撤到 B 图上 */
  function resetHistory(): void {
    history.reset()
    rev.value += 1
    syncHistoryFlags()
  }

  function undo(): void {
    const g = activeGraph.value
    if (!g) return
    const prev = history.undo(g)
    if (!prev) return
    const idx = graphs.value.findIndex((x) => x.id === g.id)
    if (idx >= 0) graphs.value[idx] = prev
    rev.value += 1
    syncHistoryFlags()
    persist()
    lastMessage.value = '已撤销'
  }

  function redo(): void {
    const g = activeGraph.value
    if (!g) return
    const next = history.redo(g)
    if (!next) return
    const idx = graphs.value.findIndex((x) => x.id === g.id)
    if (idx >= 0) graphs.value[idx] = next
    rev.value += 1
    syncHistoryFlags()
    persist()
    lastMessage.value = '已重做'
  }

  /* ---------------- 图级操作 ---------------- */

  function touch(g: FlowGraph): void {
    g.updatedAt = Date.now()
  }

  function ensureActive(): void {
    if (!activeId.value || !graphs.value.some((g) => g.id === activeId.value)) {
      activeId.value = graphs.value[0]?.id ?? ''
    }
    workspace.value.activeId = activeId.value
  }

  function createGraphLocal(name = '新的故事线'): FlowGraph {
    const g = createGraph(name)
    workspace.value.graphs.push(g)
    activeId.value = g.id
    workspace.value.activeId = g.id
    resetHistory()
    persist()
    return g
  }

  function renameGraph(id: string, name: string): void {
    const g = graphs.value.find((x) => x.id === id)
    if (!g || !name.trim()) return
    commit('重命名故事线')
    g.name = name.trim()
    touch(g)
    persist()
  }

  function duplicateGraph(id: string): FlowGraph | null {
    const g = graphs.value.find((x) => x.id === id)
    if (!g) return null
    const copy = deepClone(g)
    copy.id = createGraph().id
    copy.name = `${g.name} · 副本`
    const now = Date.now()
    copy.createdAt = now
    copy.updatedAt = now
    const pos = graphs.value.findIndex((x) => x.id === id)
    workspace.value.graphs.splice(pos + 1, 0, copy)
    activeId.value = copy.id
    workspace.value.activeId = copy.id
    resetHistory()
    persist()
    return copy
  }

  function removeGraph(id: string): void {
    const idx = graphs.value.findIndex((x) => x.id === id)
    if (idx < 0) return
    workspace.value.graphs.splice(idx, 1)
    ensureActive()
    resetHistory()
    persist()
  }

  function setActiveGraph(id: string): void {
    if (activeId.value === id) return
    activeId.value = id
    workspace.value.activeId = id
    workspace.value.ui.lastGraphId = id
    selectedIds.value = []
    resetHistory()
    persist()
  }

  function toggleFavorite(id: string): void {
    const list = ((workspace.value.ui.favorites as string[]) ?? []).slice()
    const i = list.indexOf(id)
    if (i >= 0) list.splice(i, 1)
    else list.push(id)
    workspace.value.ui.favorites = list
    persist()
  }

  function importGraph(g: FlowGraph): FlowGraph {
    workspace.value.graphs.push(g)
    activeId.value = g.id
    workspace.value.activeId = g.id
    resetHistory()
    persist()
    return g
  }

  function loadSampleGraph(): FlowGraph {
    return importGraph(createSampleGraph())
  }

  /* ---------------- 节点操作 ---------------- */

  function requireGraph(): FlowGraph | null {
    return activeGraph.value
  }

  function addNode(payload: Partial<StoryNode> = {}, opts: WriteOptions = {}): StoryNode | null {
    const g = requireGraph()
    if (!g) return null
    if (!opts.silent) commit('新增节点', opts.merge)
    const node = createNode(payload, nextOrder(g, payload.lane ?? 0))
    g.nodes.push(node)
    if (g.settings.layoutMode === 'timeline') layoutTimeline(g)
    touch(g)
    selectedIds.value = [node.id]
    persist()
    return node
  }

  function updateNode(id: string, patch: Partial<StoryNode>, opts: WriteOptions = {}): void {
    const g = requireGraph()
    if (!g) return
    const node = g.nodes.find((n) => n.id === id)
    if (!node) return
    if (!opts.silent) commit('编辑节点', opts.merge ?? `node:${id}`)
    Object.assign(node, patch)
    // 【P1-followup】改标题/摘要/人物/地点后立刻把该节点高度顶到正确值，
    // 否则 foreignObject 与导出图都按旧的 h 裁剪 ⇒ 文字被截断。
    // 这里只重算「被改的这一个」节点（O(1)）而非 reflowHeights(g)（O(n) 全图），
    // 因为其余节点的高度并未受本次编辑影响；整图高度的权威刷新仍由 layoutTimeline 负责。
    // 性能关键：不命中 HEIGHT_KEYS 就直接跳过 —— 拖拽期的每帧 {x,y} 更新不触发任何计算。
    if (affectsHeight(patch)) node.h = fitNodeHeight(node)
    touch(g)
    persist()
  }

  function removeNode(id: string, opts: WriteOptions = {}): void {
    const g = requireGraph()
    if (!g) return
    if (!opts.silent) commit('删除节点')
    g.nodes = g.nodes.filter((n) => n.id !== id)
    g.edges = g.edges.filter((e) => e.source !== id && e.target !== id)
    selectedIds.value = selectedIds.value.filter((x) => x !== id)
    clearStaleEdgeSelection()
    if (g.settings.layoutMode === 'timeline') layoutTimeline(g)
    touch(g)
    persist()
  }

  function duplicateNode(id: string): StoryNode | null {
    const g = requireGraph()
    if (!g) return null
    const src = g.nodes.find((n) => n.id === id)
    if (!src) return null
    commit('复制节点')
    const copy = deepClone(src)
    copy.id = createNode().id
    copy.title = `${src.title} · 副本`
    copy.x = src.x + 40
    copy.y = src.y + 40
    copy.order = src.order + 1
    g.nodes.push(copy)
    if (g.settings.layoutMode === 'timeline') layoutTimeline(g)
    touch(g)
    selectedIds.value = [copy.id]
    persist()
    return copy
  }

  /** 在指定节点正下方插入同 lane 的节点，并自动连线 */
  function insertNodeAfter(id: string, patch: Partial<StoryNode> = {}): StoryNode | null {
    const g = requireGraph()
    if (!g) return null
    const anchor = g.nodes.find((n) => n.id === id)
    if (!anchor) return null
    commit('在下方插入节点')
    for (const n of g.nodes) {
      if (n.lane === anchor.lane && n.order > anchor.order) n.order += 1
    }
    const node = createNode(
      { ...patch, lane: anchor.lane, kind: patch.kind ?? 'event' },
      anchor.order + 1
    )
    g.nodes.push(node)
    g.edges.push(createEdge(anchor.id, node.id, 'flow'))
    if (g.settings.layoutMode === 'timeline') layoutTimeline(g)
    touch(g)
    selectedIds.value = [node.id]
    persist()
    return node
  }

  /** 在指定节点正上方插入同 lane 的节点，并自动连线 */
  function insertNodeBefore(id: string, patch: Partial<StoryNode> = {}): StoryNode | null {
    const g = requireGraph()
    if (!g) return null
    const anchor = g.nodes.find((n) => n.id === id)
    if (!anchor) return null
    commit('在上方插入节点')
    for (const n of g.nodes) {
      if (n.lane === anchor.lane && n.order >= anchor.order) n.order += 1
    }
    const node = createNode(
      { ...patch, lane: anchor.lane, kind: patch.kind ?? 'event' },
      anchor.order
    )
    node.order = anchor.order
    g.nodes.push(node)
    g.edges.push(createEdge(node.id, anchor.id, 'flow'))
    if (g.settings.layoutMode === 'timeline') layoutTimeline(g)
    touch(g)
    selectedIds.value = [node.id]
    persist()
    return node
  }

  /** 从指定节点横向甩出一条支线节点 */
  function insertBranch(
    id: string,
    patch: Partial<StoryNode> = {},
    dir: 1 | -1 = 1
  ): StoryNode | null {
    const g = requireGraph()
    if (!g) return null
    const anchor = g.nodes.find((n) => n.id === id)
    if (!anchor) return null
    commit('插入分支')
    const usedLanes = new Set(g.nodes.map((n) => n.lane))
    let lane = anchor.lane + dir
    const guard = dir > 0 ? anchor.lane + 8 : anchor.lane - 8
    while (usedLanes.has(lane) && (dir > 0 ? lane < guard : lane > guard)) lane += dir
    const node = createNode({ ...patch, lane, kind: patch.kind ?? 'scene' }, nextOrder(g, lane))
    g.nodes.push(node)
    g.edges.push(createEdge(anchor.id, node.id, 'branch'))
    if (g.settings.layoutMode === 'timeline') layoutTimeline(g)
    touch(g)
    selectedIds.value = [node.id]
    persist()
    return node
  }

  function connectNodes(
    sourceId: string,
    targetId: string,
    kind: EdgeKind = 'flow',
    handles?: { sourceHandle?: PortSide; targetHandle?: PortSide }
  ): StoryEdge | null {
    const g = requireGraph()
    if (!g || sourceId === targetId) return null
    const has = g.nodes.some((n) => n.id === sourceId) && g.nodes.some((n) => n.id === targetId)
    if (!has) return null
    // 去重键 = 两端点 + kind + 两端 handle：同两端同 kind 但锚点不同 ⇒ 允许共存
    // （四向锚点后，「从上连」与「从下连」是两条不同的线，不是重复）
    const dup = g.edges.some(
      (e) =>
        e.source === sourceId &&
        e.target === targetId &&
        e.kind === kind &&
        (e.sourceHandle ?? null) === (handles?.sourceHandle ?? null) &&
        (e.targetHandle ?? null) === (handles?.targetHandle ?? null)
    )
    if (dup) return null
    commit('连接节点')
    const edge = createEdge(sourceId, targetId, kind, undefined, handles)
    g.edges.push(edge)
    touch(g)
    persist()
    return edge
  }

  function removeEdge(id: string, opts: WriteOptions = {}): void {
    const g = requireGraph()
    if (!g) return
    if (!opts.silent) commit('删除连线')
    g.edges = g.edges.filter((e) => e.id !== id)
    clearStaleEdgeSelection()
    touch(g)
    persist()
  }

  function updateEdge(id: string, patch: Partial<StoryEdge>): void {
    const g = requireGraph()
    if (!g) return
    const edge = g.edges.find((e) => e.id === id)
    if (!edge) return
    commit('编辑连线', `edge:${id}`)
    Object.assign(edge, patch)
    touch(g)
    persist()
  }

  /**
   * 改写连接：把某条边的端点改到另一个节点上。
   * @param handle 落下端的锚点；缺省时清掉该端旧 handle（回落 kind 规则），
   *   避免旧锚点残留在新节点上
   */
  function reconnectEdge(
    edgeId: string,
    end: 'source' | 'target',
    nodeId: string,
    handle?: PortSide
  ): void {
    const g = requireGraph()
    if (!g) return
    const edge = g.edges.find((e) => e.id === edgeId)
    if (!edge || !g.nodes.some((n) => n.id === nodeId)) return
    commit('改写连接')
    edge[end] = nodeId
    if (end === 'source') edge.sourceHandle = handle
    else edge.targetHandle = handle
    touch(g)
    persist()
  }

  /** 在一条线的中间插入节点：A → 新 → B，kind 保持不变 */
  function insertBetween(edgeId: string): StoryNode | null {
    const g = requireGraph()
    if (!g) return null
    const edge = g.edges.find((e) => e.id === edgeId)
    if (!edge) return null
    const a = g.nodes.find((n) => n.id === edge.source)
    const b = g.nodes.find((n) => n.id === edge.target)
    if (!a || !b) return null
    commit('在连线中插入节点')
    const lane = a.lane === b.lane ? a.lane : a.lane
    for (const n of g.nodes) {
      if (n.lane === lane && n.order > a.order) n.order += 1
    }
    const node = createNode({ lane, kind: 'event', title: '新的情节' }, a.order + 1)
    g.nodes.push(node)
    // G5：外端 handle 继承 —— S→N 继承 E.sourceHandle，N→T 继承 E.targetHandle；
    // 中间节点 N 的两个内端不设 handle（走 kind 规则）。E 无 handle 时
    // createEdge 不会写入任何字段，行为与改造前完全一致。
    g.edges.push(createEdge(a.id, node.id, edge.kind, undefined, { sourceHandle: edge.sourceHandle }))
    g.edges.push(createEdge(node.id, b.id, edge.kind, undefined, { targetHandle: edge.targetHandle }))
    g.edges = g.edges.filter((e) => e.id !== edgeId)
    clearStaleEdgeSelection()
    if (g.settings.layoutMode === 'timeline') layoutTimeline(g)
    touch(g)
    selectedIds.value = [node.id]
    persist()
    return node
  }

  function updateNodeNote(id: string, note: string): void {
    updateNode(id, { note }, { merge: `note:${id}` })
  }

  function addCharacter(id: string, name: string): void {
    const g = requireGraph()
    const node = g?.nodes.find((n) => n.id === id)
    if (!g || !node || !name.trim()) return
    const value = name.trim()
    if (node.characters.includes(value)) return
    commit('添加人物', `char:${id}`)
    node.characters = [...node.characters, value]
    // 首位人物会把 fitNodeHeight 的 metaLine 从 0 翻到 1（高度 +20），
    // 这条路径直接改 characters 绕过了 updateNode，故在此自行顶高。
    node.h = fitNodeHeight(node)
    touch(g)
    persist()
  }

  /**
   * 角色牌改名（级联）。
   *
   * 人物名是字符串存在各节点 `characters` 里的，没有独立角色实体，
   * 所以只改卡片标题会数据撕裂。决策规则在 `core/characterRename.ts`（纯函数、
   * 可单测），这里只负责应用：**N+1 次 updateNode 共享同一个 merge key**
   *  ⇒ history 的同 key 合并把它们坍缩成**一条**历史，
   *    Ctrl+Z 一次就把「卡片标题 + 所有引用」一起还原。
   *
   * 注意：history / persist / touch 全部由 updateNode 天然负责，
   * 这里**不要**自己调 commit，否则会多压一条噪音记录。
   *
   * @returns 改名计划；`ok: false` 时数据未被改动（含拒绝原因）
   */
  function renameCharacter(id: string, rawNext: string): RenamePlan {
    const g = requireGraph()
    if (!g) return { ok: false, reason: 'no-card' }
    const plan = planCharacterRename(g.nodes, id, rawNext)
    if (!plan.ok) return plan
    // merge key 用 **cardId** 而非旧名：旧名可能含特殊字符、且同一 session 内
    // 反复改名会产生不同 key，导致合并链断裂、撤销栈被噪音撑爆。
    const mergeKey = `rename-char:${plan.cardId}`
    updateNode(plan.cardId, { title: plan.next }, { merge: mergeKey })
    for (const m of plan.mounts) {
      updateNode(m.nodeId, { characters: m.characters }, { merge: mergeKey })
    }
    return plan
  }

  function addTag(id: string, tag: string): void {
    const g = requireGraph()
    const node = g?.nodes.find((n) => n.id === id)
    if (!g || !node || !tag.trim()) return
    const value = tag.trim()
    if (node.tags.includes(value)) return
    commit('添加标签', `tag:${id}`)
    node.tags = [...node.tags, value]
    touch(g)
    persist()
  }

  function setNodeKind(id: string, kind: NodeKind): void {
    updateNode(id, { kind })
  }

  /* ---------------- 设置 / 布局 ---------------- */

  function setSettings(patch: Partial<GraphSettings>): void {
    const g = requireGraph()
    if (!g) return
    commit('调整画布设置', 'settings')
    g.settings = { ...DEFAULT_SETTINGS, ...g.settings, ...patch }
    if (g.settings.layoutMode === 'timeline') layoutTimeline(g)
    touch(g)
    persist()
  }

  /** 一键整理：按当前 lane/order 重新收紧 */
  function tidyLayout(): void {
    const g = requireGraph()
    if (!g) return
    commit('整理布局')
    tidyUp(g)
    persist()
  }

  function relayout(): void {
    const g = requireGraph()
    if (!g) return
    layoutTimeline(g)
    persist()
  }

  /* ---------------- 选择 ---------------- */

  function select(ids: string[]): void {
    selectedIds.value = [...new Set(ids)]
  }

  function toggleSelect(id: string): void {
    const i = selectedIds.value.indexOf(id)
    if (i >= 0) selectedIds.value.splice(i, 1)
    else selectedIds.value.push(id)
  }

  function clearSelection(): void {
    selectedIds.value = []
  }

  /* ---------------- 启动 ---------------- */

  ensureActive()
  if (!graphs.value.length) {
    // 首次进入：自动铺一份示例，避免用户面对空白画布发呆
    const sample = createSampleGraph()
    workspace.value.graphs.push(sample)
    activeId.value = sample.id
    workspace.value.activeId = sample.id
    persist()
  }
  syncHistoryFlags()

  return {
    // 状态
    workspace,
    graphs,
    activeGraph,
    activeId,
    selectedIds,
    currentNode,
    nodes,
    edges,
    favorites,
    canUndo,
    canRedo,
    lastMessage,
    // 图
    createGraph: createGraphLocal,
    renameGraph,
    duplicateGraph,
    removeGraph,
    setActiveGraph,
    toggleFavorite,
    importGraph,
    loadSampleGraph,
    // 节点 / 边
    addNode,
    updateNode,
    removeNode,
    duplicateNode,
    insertNodeAfter,
    insertNodeBefore,
    insertBranch,
    connectNodes,
    removeEdge,
    updateEdge,
    reconnectEdge,
    insertBetween,
    updateNodeNote,
    addCharacter,
    renameCharacter,
    addTag,
    setNodeKind,
    // 设置
    setSettings,
    tidyLayout,
    relayout,
    // 选择
    select,
    toggleSelect,
    clearSelection,
    // 历史
    commit,
    undo,
    redo,
    resetHistory,
    // 拖拽期持久化暂停（G3：useNodeDrag start→finish 期间跳过 persist）
    pausePersist,
    resumePersist
  }
})
