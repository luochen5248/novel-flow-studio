/**
 * character.spec.ts —— 人物卡片挂载测试
 *
 * 覆盖四块：
 * 1) characterCard.ts 的纯约定（isAttachable / isCharacterCard / CHARACTER_LANE / CHARACTER_NODE_W）
 * 2) store.addCharacter：同一人物挂多节点各自生效、同节点去重、空名忽略
 * 3) layoutTimeline：人物卡片放「保留 lane(100)」，因此不干扰 lane 0 事件节点的 order 推进与 y 间距
 * 4) 【布局豁免】人物卡按 kind 被 `isLayoutExempt` 永久豁免：布局不碰 x/y/order，但 h 照常按内容重算
 *
 * 说明：人物卡片用独立 lane(100) 的设计（见 characterCard.ts 注释）正是为了不改 core/layout.ts，
 * 所以第 3 条是对该设计的回归守护（当前为绿）。
 * 第 4 条是「人物卡脱离时间线管控、可任意拖动」的守护：坐标归用户，高度归内容。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFlowStore } from '@/stores/useFlowStore'
import {
  CHARACTER_LANE,
  CHARACTER_NODE_W,
  isAttachable,
  isCharacterCard
} from '@/components/canvas/characterCard'
import { createGraph, createNode, DEFAULT_SETTINGS } from '@/core/model'
import { layoutTimeline, isLayoutExempt, fitNodeHeight, tidyUp } from '@/core/layout'
import type { FlowGraph } from '@/types/graph'

describe('characterCard · 人物卡片约定（纯函数）', () => {
  it('isCharacterCard 只认 character 类型', () => {
    expect(isCharacterCard(createNode({ kind: 'character' }))).toBe(true)
    expect(isCharacterCard(createNode({ kind: 'event' }))).toBe(false)
  })

  it('isAttachable：事件/场景/抉择/里程碑/备忘可挂载，character 不可（防自嵌套）', () => {
    for (const k of ['event', 'scene', 'decision', 'milestone', 'note'] as const) {
      expect(isAttachable(createNode({ kind: k }))).toBe(true)
    }
    expect(isAttachable(createNode({ kind: 'character' }))).toBe(false)
  })

  it('人物卡片使用保留 lane 与专用尺寸', () => {
    expect(CHARACTER_LANE).toBe(100)
    expect(CHARACTER_NODE_W).toBe(196)
  })
})

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('addCharacter · 人物挂载（store）', () => {
  it('同一人物挂到多个节点 → 各自生效', () => {
    const store = useFlowStore()
    store.createGraph('人物测试')
    const a = store.addNode({ title: 'A' })!
    const b = store.addNode({ title: 'B' })!

    store.addCharacter(a.id, '阿离')
    store.addCharacter(b.id, '阿离')

    const nodes = store.activeGraph!.nodes
    expect(nodes.find((n) => n.id === a.id)!.characters).toContain('阿离')
    expect(nodes.find((n) => n.id === b.id)!.characters).toContain('阿离')
  })

  it('重复挂同一人物到同一节点 → 去重（不产生重复项）', () => {
    const store = useFlowStore()
    store.createGraph('人物去重')
    const a = store.addNode({ title: 'A' })!

    store.addCharacter(a.id, '阿离')
    store.addCharacter(a.id, '阿离')
    store.addCharacter(a.id, '阿离')

    const node = store.activeGraph!.nodes.find((n) => n.id === a.id)!
    expect(node.characters).toEqual(['阿离'])
    expect(node.characters.length).toBe(1)
  })

  it('人物名为空/空白 → 忽略（不写入）', () => {
    const store = useFlowStore()
    store.createGraph('人物空名')
    const a = store.addNode({ title: 'A' })!

    store.addCharacter(a.id, '')
    store.addCharacter(a.id, '   ')

    const node = store.activeGraph!.nodes.find((n) => n.id === a.id)!
    expect(node.characters).toEqual([])
  })
})

describe('layoutTimeline · 人物卡片不干扰主线排序（保留 lane 设计回归）', () => {
  it('人物卡片（lane=100）不改变 lane 0 事件节点的 order 与 y 间距', () => {
    const g: FlowGraph = createGraph('主线排序')
    g.settings = {
      ...DEFAULT_SETTINGS,
      layoutMode: 'timeline',
      direction: 'vertical',
      rowGap: 200,
      laneGap: 320
    }
    const e1 = createNode({ id: 'e1', kind: 'event', lane: 0, order: 0, title: '事件1' })
    const e2 = createNode({ id: 'e2', kind: 'event', lane: 0, order: 1, title: '事件2' })
    g.nodes.push(e1, e2)
    layoutTimeline(g)
    const ordersBefore = [e1.order, e2.order]
    const gapBefore = e2.y - e1.y

    // 追加一张人物卡片到保留 lane(100)，再次布局。
    // 坐标给一个明显「非布局位」的值：若 character 参与了布局，它会被 laneAxisMap
    // 收拢到主线右侧（x = 0 - w/2 = -134）并被 order 扫描改写 y —— 一比就知道。
    const card = createNode({
      id: 'card',
      kind: 'character',
      lane: CHARACTER_LANE,
      title: '阿离',
      x: 777,
      y: 333
    })
    const cardBefore = { x: card.x, y: card.y, order: card.order, pinned: card.pinned }
    g.nodes.push(card)
    layoutTimeline(g)

    const e1b = g.nodes.find((n) => n.id === 'e1')!
    const e2b = g.nodes.find((n) => n.id === 'e2')!
    const cardb = g.nodes.find((n) => n.id === 'card')!
    // 主线事件节点的 order 与间距不受人物卡片影响
    expect([e1b.order, e2b.order]).toEqual(ordersBefore)
    expect(e2b.y - e1b.y).toBe(gapBefore)
    // 人物卡片仍在保留 lane
    expect(cardb.lane).toBe(CHARACTER_LANE)
    // 【强化断言】原为 `expect(cardb.x).not.toBe(e1b.x)` —— 那是弱断言：
    // character 参不参与布局它都绿。改成「布局前后 x/y/order 逐字段完全不变」，
    // 才能真正钉住「人物卡不被布局改写坐标」这条语义。
    // （前置：pinned 为 false，所以下面的不变只能来自 kind 豁免）
    expect(cardBefore.pinned).toBe(false)
    expect({ x: cardb.x, y: cardb.y, order: cardb.order }).toEqual({
      x: cardBefore.x,
      y: cardBefore.y,
      order: cardBefore.order
    })
  })
})

describe('layoutTimeline · 人物卡的布局豁免（坐标归用户，高度归内容）', () => {
  /** 建一张纵向 timeline 图（settings 显式化，便于断言） */
  function makeGraph(name: string): FlowGraph {
    const g = createGraph(name)
    g.settings = {
      ...DEFAULT_SETTINGS,
      layoutMode: 'timeline',
      direction: 'vertical',
      rowGap: 200,
      laneGap: 320
    }
    return g
  }

  it('未 pinned 的 character 卡：布局后 x/y/order 原样不动（豁免只靠 kind）', () => {
    const g = makeGraph('豁免 · 坐标不动')
    const e1 = createNode({ id: 'e1', kind: 'event', lane: 0, order: 0, title: '事件1' })
    const c1 = createNode({
      id: 'c1',
      kind: 'character',
      lane: CHARACTER_LANE,
      order: 7,
      title: '阿离',
      w: CHARACTER_NODE_W,
      x: 640,
      y: -240
    })
    g.nodes.push(e1, c1)

    layoutTimeline(g)

    const card = g.nodes.find((n) => n.id === 'c1')!
    expect(card.pinned).toBe(false) // 不是靠 pinned 豁免的
    expect(card.x).toBe(640)
    expect(card.y).toBe(-240)
    expect(card.order).toBe(7)
  })

  it('character 卡不占 order 名额：同 lane 的主线事件 order 仍是 0..n-1 连续', () => {
    const g = makeGraph('豁免 · order 名额')
    const e1 = createNode({ id: 'e1', kind: 'event', lane: 0, order: 0, title: '一' })
    const e2 = createNode({ id: 'e2', kind: 'event', lane: 0, order: 1, title: '二' })
    const e3 = createNode({ id: 'e3', kind: 'event', lane: 0, order: 2, title: '三' })
    // 故意把人物卡塞进 lane 0 并给一个会插队的 order
    const c1 = createNode({ id: 'c1', kind: 'character', lane: 0, order: 1, title: '阿离', x: 640 })
    g.nodes.push(e1, e2, e3, c1)

    layoutTimeline(g)

    const events = g.nodes.filter((n) => n.kind !== 'character').sort((a, b) => a.order - b.order)
    expect(events.map((n) => n.order)).toEqual([0, 1, 2])
    // 人物卡既没被重新编号，也没把主线 order 挤开
    expect(g.nodes.find((n) => n.id === 'c1')!.order).toBe(1)
  })

  it('character 卡改长标题 / 长摘要：布局后 h 变大且与 fitNodeHeight 一致（round4 F-1 精神的 character 版）', () => {
    const g = makeGraph('豁免 · 高度重算')
    const e1 = createNode({ id: 'e1', kind: 'event', lane: 0, order: 0, title: '事件1' })
    const c1 = createNode({
      id: 'c1',
      kind: 'character',
      lane: CHARACTER_LANE,
      title: '阿离',
      w: CHARACTER_NODE_W,
      x: 900,
      y: 40
    })
    g.nodes.push(e1, c1)

    layoutTimeline(g)
    const hShort = g.nodes.find((n) => n.id === 'c1')!.h

    // 改长标题 + 长摘要：高度必须跟着内容涨（豁免冻结的是坐标，不是高度）
    c1.title = '一个非常非常非常长的名字足以从一行撑到两行'
    c1.summary = '一段很长很长的摘要文字'.repeat(6)
    layoutTimeline(g)

    const after = g.nodes.find((n) => n.id === 'c1')!
    expect(after.h).toBeGreaterThan(hShort)
    expect(after.h).toBe(fitNodeHeight(after))
    // 与此同时坐标一动不动
    expect({ x: after.x, y: after.y }).toEqual({ x: 900, y: 40 })
  })

  it('幂等 / 「整理」：反复布局与 tidyUp 都吸不回人物卡（拖到哪停在哪）', () => {
    const g = makeGraph('豁免 · 整理')
    const e1 = createNode({ id: 'e1', kind: 'event', lane: 0, order: 0, title: '事件1' })
    const c1 = createNode({
      id: 'c1',
      kind: 'character',
      lane: CHARACTER_LANE,
      title: '阿离',
      x: 1234,
      y: 567
    })
    g.nodes.push(e1, c1)

    layoutTimeline(g)
    layoutTimeline(g)
    expect({ x: c1.x, y: c1.y }).toEqual({ x: 1234, y: 567 })

    // tidyUp = 「放弃手动摆放」：清掉全部 pinned，但 character 是按 kind 豁免，清不掉
    tidyUp(g)
    expect(c1.pinned).toBe(false)
    expect({ x: c1.x, y: c1.y }).toEqual({ x: 1234, y: 567 })
  })
})

describe('isLayoutExempt · 豁免口径（pinned 或 character，或关系）', () => {
  it('pinned:true 的普通节点 ⇒ 豁免', () => {
    expect(isLayoutExempt(createNode({ kind: 'event', pinned: true }))).toBe(true)
  })

  it('kind:character 的节点 ⇒ 豁免（哪怕 pinned:false）', () => {
    expect(isLayoutExempt(createNode({ kind: 'character', pinned: false }))).toBe(true)
  })

  it('character + pinned:true ⇒ 仍豁免（两者是或关系，不是互斥）', () => {
    expect(isLayoutExempt(createNode({ kind: 'character', pinned: true }))).toBe(true)
  })

  it('普通未 pinned 节点 ⇒ 不豁免（对照，防豁免谓词被写成恒真）', () => {
    for (const k of ['event', 'scene', 'decision', 'milestone', 'note'] as const) {
      expect(isLayoutExempt(createNode({ kind: k, pinned: false }))).toBe(false)
    }
  })
})
