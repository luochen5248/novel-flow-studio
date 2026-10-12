import type { StoryNode } from '@/types/graph'

/**
 * 最近邻吸附（nearest-neighbour snapping）的纯函数实现。
 *
 * 单独成模块的原因：这套几何判定是纯计算（入参 → 出参，不读 store、不碰 DOM），
 * 放这里既能被 FlowCanvas 复用，也能被单元测试直接 import —— 改吸附半径时
 * 不会再出现「改在 Vue 里、测不到」的盲区。
 *
 * 坐标约定：入参是 **SVG 世界坐标**（client → svg 的换算由调用方用
 * `toSvgPoint` / viewport 逆变换完成），所以本模块无需关心缩放与平移。
 */

/** 吸附半径（SVG 世界坐标单位）。恰好等于该值 **不** 命中，见 `nearestNode`。 */
export const SNAP_RADIUS = 120

/**
 * 点到矩形的最短距离（point-to-rect）。
 *
 * 落在矩形内部时返回 0。这是与 `pointInRect` 的关键区别：
 * `pointInRect` 要求指针**压住**矩形，而这里带距离容差，
 * 因此**不能**用它代替吸附判定。
 */
export function distToRect(px: number, py: number, n: StoryNode): number {
  const dx = Math.max(n.x - px, 0, px - (n.x + n.w))
  const dy = Math.max(n.y - py, 0, py - (n.y + n.h))
  return Math.hypot(dx, dy)
}

export interface NearestNodeOptions {
  /** 排除的节点 id（通常是连线起点 / 被拖动的卡片自身） */
  excludeId?: string
  /** 容差，默认 {@link SNAP_RADIUS} */
  tolerance?: number
  /** 额外的可命中过滤（如人物卡片只能挂到事件 / 场景上） */
  accept?: (n: StoryNode) => boolean
}

/**
 * 找出距离 (px, py) 最近的节点。
 *
 * 语义要点：
 *  - 严格 `d < tolerance`，恰好等于容差视为**未命中**（避免"擦边也算"的手感）；
 *  - 矩形内部的节点距离记 0，因此天然优先于任何在矩形外的节点；
 *  - 距离相同时保留数组中靠前者（`<` 而非 `<=`），保证结果可预期。
 *
 * @returns 命中的节点；无任何节点在容差内时返回 null
 */
export function nearestNode(
  px: number,
  py: number,
  nodes: StoryNode[],
  opts: NearestNodeOptions = {}
): StoryNode | null {
  const tolerance = opts.tolerance ?? SNAP_RADIUS
  let best: StoryNode | null = null
  let bestDist = tolerance
  for (const n of nodes) {
    if (opts.excludeId !== undefined && n.id === opts.excludeId) continue
    if (opts.accept && !opts.accept(n)) continue
    const d = distToRect(px, py, n)
    if (d < bestDist) {
      bestDist = d
      best = n
    }
  }
  return best
}

/** 节点中心点（吸附时把线头 / 提示吸到这里） */
export function centerOf(n: StoryNode): { x: number; y: number } {
  return { x: n.x + n.w / 2, y: n.y + n.h / 2 }
}

/**
 * 缩放归一后的吸附容差。
 *
 * 问题：`SNAP_RADIUS` 是 SVG **世界坐标**，而用户的直觉是「屏幕上约 120px 内吸住」。
 * 画布放大到 2x 时，世界坐标里的 120 已经变成屏幕 240px，手感突然变差。
 *
 * 解法：把世界容差按视口缩放反向换算 —— 缩放越大，世界容差越小，
 * 于是**屏幕上的实际吸附范围恒定**。
 *
 * @param scale 视口缩放（`useViewport().scale`，口径与 `screenDeltaToSvg` 逆变换一致）
 * @returns 夹在 [12, 400] 内的世界坐标容差，防止极端缩放时容差退化或爆炸
 */
export function snapTolerance(scale: number): number {
  const s = scale > 0 ? scale : 1
  return Math.min(Math.max(SNAP_RADIUS / s, 12), 400)
}
