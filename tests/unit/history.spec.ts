/**
 * history.spec.ts —— 测试 core/history.ts 的撤销/重做栈
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createGraph, createNode } from '@/core/model'
import { HistoryStack, HISTORY_LIMIT } from '@/core/history'

describe('HistoryStack · 撤销/重做', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('正常：连续 commit 后 undo 逐步回退到初始，redo 可前进还原', () => {
    const stack = new HistoryStack()
    let g = createGraph('撤销重做')

    stack.push(g) // 初始（空图）
    g.nodes.push(createNode({ title: 'A' }))
    stack.push(g) // 含 A
    g.nodes.push(createNode({ title: 'B' }))
    stack.push(g) // 含 A,B

    expect(stack.canUndo).toBe(true)
    expect(stack.depth).toBe(3)

    g = stack.undo(g)!
    expect(g.nodes.length).toBe(2) // 回到 A,B
    g = stack.undo(g)!
    expect(g.nodes.length).toBe(1) // 回到 A
    g = stack.undo(g)!
    expect(g.nodes.length).toBe(0) // 回到空
    expect(stack.canUndo).toBe(false)
    expect(stack.canRedo).toBe(true)

    // 往返还原：redo 逐步前进，最终回到含 2 个节点的终态
    g = stack.redo(g)!
    expect(g.nodes.length).toBe(1) // 前进到 A
    g = stack.redo(g)!
    expect(g.nodes.length).toBe(2) // 前进到 A,B
    g = stack.redo(g)!
    expect(g.nodes.length).toBe(2) // 冗余尾步（仍为 A,B）
    expect(stack.canRedo).toBe(false)
    expect(g.nodes.length).toBe(2)
  })

  it('异常：空栈 undo / redo 返回 null 且不抛错', () => {
    const stack = new HistoryStack()
    expect(stack.undo(createGraph('x'))).toBeNull()
    expect(stack.redo(createGraph('x'))).toBeNull()
  })

  it('边界：超过上限(默认60)后最早记录被丢弃', () => {
    const stack = new HistoryStack()
    let g = createGraph('容量')
    for (let i = 0; i < 70; i++) {
      stack.push(g, `step${i}`)
      g.nodes.push(createNode({ title: String(i) }))
    }
    expect(stack.depth).toBe(HISTORY_LIMIT)
    expect(stack.depth).toBe(60)
  })

  it('合并：窗口内同 key 连续 commit 只产生一条记录（拖拽 5 次合 1）', () => {
    const stack = new HistoryStack()
    // 冻结时间，确保 5 次 commit 都落在 400ms 合并窗口内
    const spy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    let g = createGraph('拖拽')
    for (let i = 0; i < 5; i++) {
      g.nodes.push(createNode({ title: `m${i}` }))
      stack.push(g, 'drag', 'drag:n1')
    }
    expect(stack.depth).toBe(1)
    spy.mockRestore()
  })
})
