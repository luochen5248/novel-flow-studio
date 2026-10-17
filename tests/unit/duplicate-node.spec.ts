/**
 * duplicate-node.spec.ts —— 「复制节点」落位回归（useFlowStore.duplicateNode）
 *
 * 背景：人物卡（`kind === 'character'`）被 `core/layout.ts` 的 `isLayoutExempt`
 * 按 kind **永久剔出布局集合** ⇒ 布局永远不再给它排一次位，坐标只在「创建那一刻」
 * 决定。于是「新建人物卡」的每一个入口都得自己给一个不打架的坐标，规则统一收在
 * `core/characterSlot.ts` 的 `nextCharacterSlot(nodes)`（横向基准 = 非 character
 * 节点 max(x+w)+60；4 列网格 STEP_X 300 / STEP_Y 216）。
 *
 * 工具栏入口（CanvasToolbar）与 AI 入口（aiApi）早已接入，
 * **复制（duplicateNode）是第三个入口** —— 本文件把它钉在「同一套错位规则」上。
 *
 * 修复前的 bug：`copy.x = src.x + 40; copy.y = src.y + 40; copy.order = src.order + 1`
 * 对所有 kind 一视同仁 ⇒
 *  - 坐标：人物卡宽 196 / 高最大 208 ⇒ 副本与原卡重叠约 156×92，用户得先手动扒开；
 *  - order：普通节点的重复 order 会被随后的 `layoutTimeline` 重编号自愈，
 *    而人物卡被豁免、**没有自愈机会** ⇒ `src.order + 1` 在人物道里留下重复号，
 *    导出排序（以及 aiApi afterId 的 `t.order === anchor.order + 1` 匹配）就此歧义。
 *
 * 断言一律钉**可观察的终值**（副本落库后的 x/y/order 与人物道内的 order 唯一性），
 * 不钉实现细节 —— 唯一用到的实现知识是「落位规则由 `nextCharacterSlot` 决定」，
 * 而它本身就是全项目人物卡落位的唯一权威（characterSlot.spec.ts 已单测）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFlowStore } from '@/stores/useFlowStore'
import { nextCharacterSlot } from '@/core/characterSlot'
import { CHARACTER_LANE, CHARACTER_NODE_W } from '@/components/canvas/characterCard'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

/** 人物道（lane 100）里的全部人物卡 */
function cardsInLane(nodes: any[], lane: number) {
  return nodes.filter((n) => n.kind === 'character' && n.lane === lane)
}

describe('复制节点 · 人物卡走统一错位落位（useFlowStore.duplicateNode）', () => {
  it('T1 复制人物卡：副本落在 nextCharacterSlot 算出的格子，且 order 在人物道内不重复', () => {
    const store = useFlowStore()
    store.createGraph('T1 复制人物卡')
    // 一个普通节点（决定 nextCharacterSlot 的横向基准）+ 两张人物卡（占掉前两格）
    store.addNode({ title: '主线一', lane: 0 })
    const cardA = store.addNode({
      kind: 'character',
      title: '甲',
      lane: CHARACTER_LANE,
      w: CHARACTER_NODE_W
    })!
    const cardB = store.addNode({
      kind: 'character',
      title: '乙',
      lane: CHARACTER_LANE,
      w: CHARACTER_NODE_W
    })!
    const g = store.activeGraph!

    // 期望值必须在 duplicateNode **之前**算：`nextCharacterSlot` 统计的是「已有」人物卡，
    // push 之后副本自己也会把格子序号往后推（那时算就会多走一格）。
    const expectedSlot = nextCharacterSlot(g.nodes)
    const ordersBefore = [cardA.order, cardB.order]

    const copy = store.duplicateNode(cardA.id)!
    // 前提哨兵：复制确实发生了，且副本还是人物卡（否则后面的断言全是空转）
    expect(copy.kind).toBe('character')
    expect(copy.id).not.toBe(cardA.id)

    // 终值语义 1：坐标 = 统一错位规则算出的格子。
    // 防的回归：duplicateNode 退回 `src.x + 40 / src.y + 40` ⇒ 副本与原卡重叠约 156×92，
    // 且坐标 ≠ 网格落位 ⇒ 此断言红。
    expect(copy.x).toBe(expectedSlot.x)
    expect(copy.y).toBe(expectedSlot.y)
    // 显式排除「恰好还是 +40/+40」这条老路
    expect([copy.x, copy.y]).not.toEqual([cardA.x + 40, cardA.y + 40])

    // 终值语义 2：order 在人物道内两两不重复。
    // 防的回归：`copy.order = src.order + 1` ⇒ 副本抄走 cardB 的号（甲 0、乙 1、副本 1），
    // 人物道没有 layoutTimeline 自愈机会 ⇒ 重复号永久留在库里 ⇒ 此断言红。
    const peers = cardsInLane(g.nodes, copy.lane)
    expect(peers.length).toBe(3)
    const orders = peers.map((n) => n.order)
    expect(new Set(orders).size).toBe(orders.length)
    // 且副本取的是「道内最大 order + 1」—— 不与原卡撞号的最直接表达
    expect(copy.order).toBe(Math.max(...ordersBefore) + 1)
    // 原卡不受影响（复制是只读源节点的操作）
    expect([cardA.order, cardB.order]).toEqual(ordersBefore)
  })

  it('T1b 防误伤：复制普通节点仍是原坐标 +40/+40（不误用人物卡落位规则）', () => {
    const store = useFlowStore()
    store.createGraph('T1b 复制普通节点')
    // ⚠️ 为什么切自由布局：timeline 模式下 duplicateNode 末尾会调 `layoutTimeline`，
    // 而普通节点（非豁免）会被它立刻重排 —— x 由 lane 定、y 由 order 定，
    // 「+40/+40」这条坐标契约在那里根本不可观测（写完就被覆盖了）。
    // 自由布局不跑 layoutTimeline，才能看到 duplicateNode 自己写下的坐标。
    // 人物卡那条分支不受影响：它本就被豁免，两种模式下看到的都是落位函数的结果。
    store.setSettings({ layoutMode: 'free' })
    const g = store.activeGraph!
    expect(g.settings.layoutMode).toBe('free')

    const e1 = store.addNode({ title: '主线一', lane: 0 })!
    const src = { x: e1.x, y: e1.y, order: e1.order }

    const copy = store.duplicateNode(e1.id)!
    expect(copy.kind).not.toBe('character')
    // 终值语义：普通节点分支一个字节都不能动 ——
    // 防的回归：把 `nextCharacterSlot` 误加到 else 分支 ⇒ 副本跑到人物卡网格里，
    // 与「原坐标 +40」不符 ⇒ 此断言红。
    expect(copy.x).toBe(src.x + 40)
    expect(copy.y).toBe(src.y + 40)
    expect(copy.order).toBe(src.order + 1)
  })
})
