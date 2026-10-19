import type { FlowGraph, StoryNode } from '@/types/graph'
import { DEFAULT_NODE_W, clamp } from './model'

/**
 * 时间线布局
 *
 * 纵向模式：x 由 lane 决定（lane=0 为主轴，其余 lane 按紧凑序号 × laneGap 左右展开），
 *           y 由 order 决定（自上而下，步长 = max(rowGap, 前节点高 + 呼吸间隙)）。
 * 横向模式：两轴互换（行进方向为 x，lane 展开为 y）。
 *
 * 支线额外做一次「父锚定」：支线节点期望落在父节点下方 0.6 个行距处，
 * 并按父节点 y 排序，再自上而下做一次最小间距扫描 ——
 * 这既保证同 lane 内不重叠，也让支线边自上而下单调、互不交叉打结。
 *
 * 【round3 · 布局豁免】以下两类节点是「坐标的绝缘体」，本函数不碰它们的 x/y/order：
 *   1. `node.pinned === true` —— 用户手动拖放过（useNodeDrag.finish 打标），
 *      语义是「拖到哪停在哪」，任何后续的增删改插都不得把它们吸回去；
 *   2. `node.kind === 'character'` —— 人物卡片走 CHARACTER_LANE 这条保留道，永久豁免。
 * 实现上不是「算完再跳过写入」，而是**从源头就不把它们放进布局集合**
 * （不进 byLane、不占 order、不参与间距扫描），
 * 这样既不会出现 travel 缺失回退到 0 的塌陷，也不会被相邻节点的 order 推进间接挤动。
 *
 * 【F-1 修正】但 **h 不在豁免范围内**：高度是内容尺寸测量而非摆放，
 * 因此在过滤 auto 之前先对全量节点跑一遍 `reflowHeights`。
 * 否则 pinned 节点的 h 会冻结在打标那一刻，改长标题后卡片与导出图都会截断。
 *
 * 复杂度：分组 O(n) + 排序 O(n log n) + 两趟线性扫描 O(n) ⇒ O(n log n)。
 * 排序键带 id 兜底 ⇒ 结果稳定可复现（撤销 / 重做后布局一致）。
 */

const MIN_BREATH = 40

/** 布局豁免判定：手动摆放 或 人物卡片 —— 布局不得改写其坐标与 order */
export function isLayoutExempt(node: StoryNode): boolean {
  return node.pinned === true || node.kind === 'character'
}

/** 依据文本量估算卡片高度（摘要固定 2 行截断，故高度有上限） */
export function fitNodeHeight(node: StoryNode): number {
  const w = node.w || DEFAULT_NODE_W
  const perLine = Math.max(8, Math.floor((w - 44) / 15))
  const titleLines = clamp(Math.ceil(node.title.length / perLine), 1, 2)
  const summaryLines = node.summary ? clamp(Math.ceil(node.summary.length / perLine), 1, 2) : 0
  const metaLine = node.characters.length || node.location ? 1 : 0
  return clamp(30 + titleLines * 25 + 24 + summaryLines * 25 + metaLine * 20 + 26, 104, 208)
}

/**
 * 【F-1】高度重算：**对所有节点执行**，与布局豁免无关。
 *
 * 背景：`fitNodeHeight` 是全项目唯一改写 `node.h` 的入口。round3 把布局集合
 * 收窄为 `auto` 时，高度重算也一并被收窄了，于是 pinned / character 节点的
 * `h` 被永久冻结在打标那一刻的值 —— 用户改长标题后卡片文字被裁掉，
 * 且导出的 PNG / draw.io 同样截断（它们都按 `node.h` 出图）。
 *
 * 语义切分：**高度永远跟着内容走，坐标归用户管**。
 * x/y/order 受豁免保护，h 不受 —— h 不是「摆放」，是「内容尺寸测量」。
 *
 * 单独导出是为了让编辑链路（检查器改标题 / 摘要）不必触发一次完整重排
 * 也能刷新高度。
 */
export function reflowHeights(graph: FlowGraph): void {
  for (const n of graph.nodes) n.h = fitNodeHeight(n)
}

/** lane 列表 → 紧凑轴坐标（去掉空洞，主轴恒为 0） */
export function laneAxisMap(nodes: StoryNode[], laneGap: number): Map<number, number> {
  const lanes = Array.from(new Set(nodes.map((n) => n.lane))).sort((a, b) => a - b)
  const zeroIdx = lanes.includes(0) ? lanes.indexOf(0) : Math.floor(lanes.length / 2)
  const map = new Map<number, number>()
  lanes.forEach((lane, i) => map.set(lane, (i - zeroIdx) * laneGap))
  return map
}

function sortStable(list: StoryNode[]): StoryNode[] {
  return [...list].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * 时间线布局主入口。就地修改 graph（x/y/order/h 被重写）并返回同一对象。
 * 豁免节点（pinned / character）的 x/y/order 保持原样，但 h 照常按内容重算。
 */
export function layoutTimeline(graph: FlowGraph): FlowGraph {
  const { rowGap, laneGap, direction } = graph.settings
  const nodes = graph.nodes
  if (!nodes.length) return graph

  // 【F-1】高度重算必须在 auto 筛选之前、且覆盖全量节点（含 pinned / character），
  // 否则豁免节点的 h 会被永久冻结，用户改长标题后卡片与导出图都会截断。
  reflowHeights(graph)

  // 【关键】再把豁免节点剔出布局集合，后续坐标计算都只基于 auto
  const auto = nodes.filter((n) => !isLayoutExempt(n))
  if (!auto.length) return graph

  const horizontal = direction === 'horizontal'
  const alongSize = (n: StoryNode): number => (horizontal ? n.w : n.h)
  const stepOf = (n: StoryNode): number => Math.max(rowGap, alongSize(n) + MIN_BREATH)

  const axis = laneAxisMap(auto, laneGap)
  const byLane = new Map<number, StoryNode[]>()
  for (const n of auto) {
    const list = byLane.get(n.lane)
    if (list) list.push(n)
    else byLane.set(n.lane, [n])
  }
  const lanes = Array.from(byLane.keys()).sort((a, b) => Math.abs(a) - Math.abs(b) || a - b)

  // 行进坐标（纵向模式是 y，横向模式是 x）
  const travel = new Map<string, number>()

  // 1) 主线：严格单调推进
  const mainLane = lanes.includes(0) ? 0 : lanes[0]
  const main = sortStable(byLane.get(mainLane) as StoryNode[])
  let cursor = 0
  for (let i = 0; i < main.length; i++) {
    travel.set(main[i].id, cursor)
    main[i].order = i
    cursor += stepOf(main[i])
  }

  // 2) 支线：父锚定 + 自上而下最小间距扫描
  const nodeById = new Map(auto.map((n) => [n.id, n]))
  const parentTravel = new Map<string, number>()
  for (const e of graph.edges) {
    const p = nodeById.get(e.source)
    const t = travel.get(e.source)
    const target = nodeById.get(e.target)
    // 两端都必须在布局集合内，豁免节点不参与父子锚定
    if (p && t !== undefined && target && p.lane !== target.lane) {
      parentTravel.set(e.target, Math.min(parentTravel.get(e.target) ?? Infinity, t))
    }
  }

  for (const lane of lanes) {
    if (lane === mainLane) continue
    const list = sortStable(byLane.get(lane) as StoryNode[])
    list.sort((a, b) => {
      const pa = parentTravel.get(a.id)
      const pb = parentTravel.get(b.id)
      // 【F-2 · 单位必须一致】parentTravel 存的是父节点的**像素**行进坐标，
      // 而 `a.order` 只是 0..n-1 的**序号**。原实现 `?? a.order` 把两种单位混着比，
      // 后果是「有跨 lane 父边的支线节点」永远被排到没有父边的节点之后 ——
      // 示例故事 lane=1 的 b1（父锚定在 s2 下方）被挤到最后一位，支线顺序整个反过来，
      // 连带让 b1 → b2 这条 flow 边变成「连线方向与排列顺序相反」。
      // 修正：没有像素锚点的节点不参与像素比较（也不能拿序号冒充像素），
      // 统一按「有锚点者优先（它的位置由父节点决定）、无锚点者彼此按 order」排，
      // order 相同再用 id 兜底，结果稳定可复现。
      if (pa !== undefined && pb !== undefined) {
        return pa - pb || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      }
      if (pa !== undefined) return -1
      if (pb !== undefined) return 1
      return a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    })

    let prevEnd = -Infinity
    for (let i = 0; i < list.length; i++) {
      const node = list[i]
      const anchor = parentTravel.get(node.id)
      const desired = anchor === undefined ? i * rowGap : anchor + rowGap * 0.6
      const pos = Math.max(desired, prevEnd + MIN_BREATH)
      travel.set(node.id, pos)
      node.order = i
      prevEnd = pos + alongSize(node)
    }
  }

  // 3) 落到 x / y（横向模式交换轴）；豁免节点直接跳过，保留用户摆的坐标
  for (const n of auto) {
    const lanePos = axis.get(n.lane) ?? 0
    const t = travel.get(n.id) ?? 0
    if (horizontal) {
      n.x = t
      n.y = lanePos - n.h / 2
    } else {
      n.x = lanePos - n.w / 2
      n.y = t
    }
  }

  graph.updatedAt = Date.now()
  return graph
}

/**
 * 「整理」按钮：语义 = **放弃手动摆放，回到自动布局**。
 * 先清掉全部 pinned 标记，再做一次完整重排。
 * 注意：character 卡片是按 kind 永久豁免的，不受「整理」影响（保留道）。
 */
export function tidyUp(graph: FlowGraph): FlowGraph {
  for (const n of graph.nodes) {
    if (n.pinned) n.pinned = false
  }
  return layoutTimeline(graph)
}

/** 自由模式下把节点吸附到网格。O(n) */
export function snapAll(graph: FlowGraph, step = 8): FlowGraph {
  for (const n of graph.nodes) {
    n.x = Math.round(n.x / step) * step
    n.y = Math.round(n.y / step) * step
  }
  return graph
}

/** 多选后对齐（工具栏可用） */
export function alignNodes(graph: FlowGraph, ids: string[], mode: 'left' | 'centerX'): void {
  const list = graph.nodes.filter((n) => ids.includes(n.id))
  if (list.length < 2) return
  if (mode === 'left') {
    const x = Math.min(...list.map((n) => n.x))
    for (const n of list) n.x = x
  } else {
    const center = list.reduce((sum, n) => sum + (n.x + n.w / 2), 0) / list.length
    for (const n of list) n.x = center - n.w / 2
  }
}
