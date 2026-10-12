import type { NodeKind, StoryNode } from '@/types/graph'

/**
 * 人物卡片（character）的形状与落位约定
 *
 * 数据契约里 `NodeKind` 早已包含 'character'、`KIND_COLOR` 也已有 'character: clay'，
 * 这里只补「交互与排布」层面的约定，不新增任何字段。
 */

/**
 * 人物卡片专用 lane（保留道）。
 *
 * 它与 `layoutTimeline` 的 `pinned` 豁免机制是**互补**关系，两者各管一件事：
 *  - `CHARACTER_LANE = 100` 只决定人物卡片的**默认排布位置**。
 *    `laneAxisMap` 会把稀疏 lane 压成相邻列，所以哪怕 lane 号很大，
 *    所有人物卡片仍会被收拢成一列整齐排在主线右侧，不会散落各处；
 *  - 「用户手动摆放后不被重排」由 `layoutTimeline` 跳过 `pinned` 与
 *    `kind === 'character'` 的节点来保证 —— 那是 Max-A 在 core/layout.ts 的修复，
 *    不在本模块职责内。
 *
 * ⚠️ 不要误读：`layoutTimeline` 的 `for (const lane of lanes)` 遍历**所有** lane，
 * 人物卡片并非「mainLane 扫不到就天然安全」。早期注释曾据此认为 lane 100 可以免疫
 * 布局重排，那是错的 —— 全仓 9 处 layoutTimeline 调用（新增/插入/删除/整理/切模式等）
 * 都会重写 x/y。lane 100 只管默认位置，免疫性由 pinned 机制提供。
 *
 * 用一个远离 0 的常量（如 100）也避免与 `insertBranch` 的
 * 「从 anchor.lane±1 找空位」逻辑抢占常用 lane。
 */
export const CHARACTER_LANE = 100

/** 人物卡片比事件卡更小、更像一张「角色牌」 */
export const CHARACTER_NODE_W = 196

/** 可作为「挂载目标」的节点类型：人物卡片不挂到人物卡片上，避免自嵌套 */
const ATTACHABLE: NodeKind[] = ['event', 'scene', 'decision', 'milestone', 'note']

/** 该节点能否接收人物卡片的挂载 */
export function isAttachable(node: StoryNode): boolean {
  return ATTACHABLE.includes(node.kind)
}

/** 该节点是否为人物卡片 */
export function isCharacterCard(node: StoryNode): boolean {
  return node.kind === 'character'
}
