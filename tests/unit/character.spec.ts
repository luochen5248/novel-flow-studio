/**
 * character.spec.ts —— 人物卡片挂载测试
 *
 * 覆盖三块：
 * 1) characterCard.ts 的纯约定（isAttachable / isCharacterCard / CHARACTER_LANE / CHARACTER_NODE_W）
 * 2) store.addCharacter：同一人物挂多节点各自生效、同节点去重、空名忽略
 * 3) layoutTimeline：人物卡片放「保留 lane(100)」，因此不干扰 lane 0 事件节点的 order 推进与 y 间距
 *
 * 说明：人物卡片用独立 lane(100) 的设计（见 characterCard.ts 注释）正是为了不改 core/layout.ts，
 * 所以第 3 条是对该设计的回归守护（当前为绿）。
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
import { layoutTimeline } from '@/core/layout'
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

    // 追加一张人物卡片到保留 lane(100)，再次布局
    const card = createNode({ id: 'card', kind: 'character', lane: CHARACTER_LANE, title: '阿离' })
    g.nodes.push(card)
    layoutTimeline(g)

    const e1b = g.nodes.find((n) => n.id === 'e1')!
    const e2b = g.nodes.find((n) => n.id === 'e2')!
    const cardb = g.nodes.find((n) => n.id === 'card')!
    // 主线事件节点的 order 与间距不受人物卡片影响
    expect([e1b.order, e2b.order]).toEqual(ordersBefore)
    expect(e2b.y - e1b.y).toBe(gapBefore)
    // 人物卡片落在独立列（x 与主线不同），且仍在保留 lane
    expect(cardb.x).not.toBe(e1b.x)
    expect(cardb.lane).toBe(CHARACTER_LANE)
  })
})
