/**
 * layout.spec.ts —— 测试 core/layout.ts 的时间线自动布局
 *
 * 覆盖：主线排序/y 递增/不重叠、分支横向偏移、父锚定、幂等、
 * 以及 free 模式下的实测行为（layoutTimeline 不读取 layoutMode）。
 */
import { describe, it, expect } from 'vitest'
import { createGraph, createNode, createEdge, DEFAULT_SETTINGS } from '@/core/model'
import { layoutTimeline } from '@/core/layout'
import type { FlowGraph } from '@/types/graph'

function buildTimelineGraph(): FlowGraph {
  const g = createGraph('时间线布局测试')
  // 明确给出稳定的 settings，便于断言 rowGap / laneGap
  g.settings = {
    ...DEFAULT_SETTINGS,
    layoutMode: 'timeline',
    direction: 'vertical',
    rowGap: 200,
    laneGap: 320
  }
  const m1 = createNode({ lane: 0, order: 0, title: '序章' })
  const m2 = createNode({ lane: 0, order: 1, title: '第一章' })
  const m3 = createNode({ lane: 0, order: 2, title: '第二章' })
  const branch = createNode({ lane: 1, order: 0, title: '支线A' })
  g.nodes.push(m1, m2, m3, branch)
  g.edges.push(createEdge(m1.id, m2.id, 'flow'))
  g.edges.push(createEdge(m2.id, m3.id, 'flow'))
  g.edges.push(createEdge(m1.id, branch.id, 'branch'))
  return g
}

describe('layoutTimeline · 时间线自动布局', () => {
  it('正常：主线(lane=0)节点按 order 排序且 y 严格递增', () => {
    const g = buildTimelineGraph()
    layoutTimeline(g)
    const main = g.nodes.filter((n) => n.lane === 0).sort((a, b) => a.order - b.order)
    expect(main.map((n) => n.order)).toEqual([0, 1, 2])
    for (let i = 1; i < main.length; i++) {
      expect(main[i].y).toBeGreaterThan(main[i - 1].y)
    }
  })

  it('边界/正常：相同 lane 相邻节点垂直间距 ≥ rowGap 且不重叠', () => {
    const g = buildTimelineGraph()
    layoutTimeline(g)
    const main = g.nodes.filter((n) => n.lane === 0).sort((a, b) => a.order - b.order)
    for (let i = 1; i < main.length; i++) {
      const gap = main[i].y - main[i - 1].y
      expect(gap).toBeGreaterThanOrEqual(g.settings.rowGap)
      // 后一个节点的顶部不早于前一个节点的底部 ⇒ 不重叠
      expect(main[i].y).toBeGreaterThanOrEqual(main[i - 1].y + main[i - 1].h)
    }
  })

  it('正常：分支(lane=1)节点 x 相对主线偏移 +laneGap(320)', () => {
    const g = buildTimelineGraph()
    layoutTimeline(g)
    const main = g.nodes.find((n) => n.lane === 0)!
    const branch = g.nodes.find((n) => n.lane === 1)!
    // 两者都用 lanePos - w/2 求 x，差恰为 laneGap
    expect(branch.x - main.x).toBe(g.settings.laneGap)
  })

  it('正常：分支节点 y 锚定在父节点下方（约 parent.y + 0.6*rowGap）', () => {
    const g = buildTimelineGraph()
    layoutTimeline(g)
    const parent = g.nodes.find((n) => n.lane === 0 && n.order === 0)!
    const branch = g.nodes.find((n) => n.lane === 1)!
    expect(branch.y - parent.y).toBeCloseTo(g.settings.rowGap * 0.6, 5)
  })

  it('稳定：连续两次布局结果一致（幂等、可复现）', () => {
    const g = buildTimelineGraph()
    const first = layoutTimeline(g)
    const positions1 = first.nodes.map((n) => `${n.id}:${Math.round(n.x)},${Math.round(n.y)}`)
    const second = layoutTimeline(g)
    const positions2 = second.nodes.map((n) => `${n.id}:${Math.round(n.x)},${Math.round(n.y)}`)
    expect(positions2).toEqual(positions1)
  })

  it('free 模式实测：layoutTimeline 仍按 timeline 规则重排（不读取 layoutMode）', () => {
    const g = buildTimelineGraph()
    g.settings.layoutMode = 'free'
    // 人为摆放一个明显不同的坐标
    g.nodes[0].x = 5000
    g.nodes[0].y = 5000
    layoutTimeline(g)
    // 实测：函数体未对 free 模式做守卫，x/y 被重写为 lane/order 决定的值
    expect(g.nodes[0].x).not.toBe(5000)
    expect(g.nodes[0].y).not.toBe(5000)
  })
})
