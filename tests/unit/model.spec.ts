/**
 * model.spec.ts —— 测试 core/model.ts 的 createNode / createEdge
 */
import { describe, it, expect } from 'vitest'
import { createNode, createEdge, DEFAULT_NODE_W, DEFAULT_NODE_H } from '@/core/model'

describe('createNode · 节点默认值', () => {
  it('正常：缺省参数时默认值齐全', () => {
    const n = createNode()
    expect(n.kind).toBe('event')
    expect(n.status).toBe('planned')
    expect(n.lane).toBe(0)
    expect(n.order).toBe(0)
    expect(n.w).toBe(DEFAULT_NODE_W) // 实际约定为 268（非任务书口头的 260）
    expect(n.h).toBe(DEFAULT_NODE_H) // 132
    expect(n.x).toBe(0)
    expect(n.y).toBe(0)
    expect(n.color).toBe('teal') // KIND_COLOR['event']
    expect(n.characters).toEqual([])
    expect(n.tags).toEqual([])
    expect(n.timeLabel).toBe('')
    expect(n.summary).toBe('')
    expect(n.content).toBe('')
    expect(n.location).toBe('')
    expect(n.chapter).toBe('')
    expect(typeof n.id).toBe('string')
    expect(n.id.length).toBeGreaterThan(0)
  })

  it('正常：传入 partial 时覆盖默认值、其余保留', () => {
    const n = createNode({ kind: 'milestone', lane: 2, w: 400, title: '里程碑A' })
    expect(n.kind).toBe('milestone')
    expect(n.lane).toBe(2)
    expect(n.w).toBe(400)
    expect(n.title).toBe('里程碑A')
    expect(n.status).toBe('planned') // 未传则保留默认
    expect(n.h).toBe(DEFAULT_NODE_H)
  })

  it('边界：传入 characters/tags 返回新数组副本（不共享引用）', () => {
    const src = ['阿离']
    const n = createNode({ characters: src })
    expect(n.characters).toEqual(['阿离'])
    src.push('误加') // 修改外部数组不应影响节点
    expect(n.characters).toEqual(['阿离'])
  })
})

describe('createEdge · 连线', () => {
  it('正常：生成唯一 id 且 kind 默认为 flow', () => {
    const e1 = createEdge('a', 'b')
    const e2 = createEdge('a', 'b')
    expect(e1.id).not.toBe(e2.id)
    expect(e1.kind).toBe('flow')
    expect(e1.source).toBe('a')
    expect(e1.target).toBe('b')
  })

  it('边界：大量生成下 id 不碰撞', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 200; i++) ids.add(createEdge('a', 'b').id)
    expect(ids.size).toBe(200)
  })

  it('异常：flashback 类型自动标记 dashed', () => {
    const e = createEdge('a', 'b', 'flashback')
    expect(e.kind).toBe('flashback')
    expect(e.dashed).toBe(true)
  })
})
