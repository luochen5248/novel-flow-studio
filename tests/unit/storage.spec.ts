/**
 * storage.spec.ts —— 测试 core/storage.ts 的 localStorage 持久化与兜底
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createGraph, createNode, createEdge } from '@/core/model'
import {
  STORAGE_KEY,
  DEFAULT_UI,
  loadWorkspace,
  saveWorkspace,
  sanitizeWorkspace,
  serializeGraph,
  parseGraphFile
} from '@/core/storage'
import type { FlowWorkspace } from '@/types/graph'

describe('storage · 持久化与兜底', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('正常：save → load 回合一致（字段完整）', () => {
    const g = createGraph('故事线一')
    g.nodes.push(createNode({ title: '序章' }))
    const ws: FlowWorkspace = {
      version: 1,
      graphs: [g],
      activeId: g.id,
      ui: { ...DEFAULT_UI, theme: 'light' }
    }
    expect(saveWorkspace(ws)).toBe(true)

    const loaded = loadWorkspace()
    expect(loaded.version).toBe(1)
    expect(loaded.graphs.length).toBe(1)
    expect(loaded.graphs[0].name).toBe('故事线一')
    expect(loaded.graphs[0].nodes.length).toBe(1)
    expect(loaded.activeId).toBe(g.id)
    expect(loaded.ui.theme).toBe('light')
  })

  it('异常：损坏 JSON 时 load 返回含 activeId 的空默认结构且不抛错', () => {
    localStorage.setItem(STORAGE_KEY, '{ 这是一段损坏的 json ')
    let ws: FlowWorkspace | undefined
    expect(() => {
      ws = loadWorkspace()
    }).not.toThrow()
    expect(ws!.graphs).toEqual([])
    expect(typeof ws!.activeId).toBe('string')
    expect(ws!.version).toBe(1)
  })

  it('边界：缺失字段时 sanitizeWorkspace 给出合理默认值', () => {
    expect(sanitizeWorkspace(null).graphs).toEqual([])
    expect(typeof sanitizeWorkspace(null).activeId).toBe('string')

    const empty = sanitizeWorkspace({})
    expect(empty.graphs).toEqual([])
    expect(empty.activeId).toBe('')

    // graphs 不是数组 ⇒ 降级为空
    const bad = sanitizeWorkspace({ graphs: 'not-an-array' as unknown as [] })
    expect(bad.graphs).toEqual([])

    // 有合法图 ⇒ activeId 落到第一张图
    const ok = sanitizeWorkspace({ graphs: [{ id: 'g1', nodes: [{ id: 'n1' }] }] })
    expect(ok.graphs.length).toBe(1)
    expect(ok.activeId).toBe('g1')
  })

  it('正常：空 workspace 时 load 返回含 activeId 的默认结构', () => {
    const ws = loadWorkspace()
    expect(ws.graphs).toEqual([])
    expect(ws.activeId).toBe('')
    expect(ws.ui).toBeDefined()
  })

  it('正常：单图 serializeGraph → parseGraphFile 往返字段一致', () => {
    const g = createGraph('江雾渡')
    const n1 = createNode({ title: '序章' })
    const n2 = createNode({ title: '第一章' })
    g.nodes.push(n1, n2)
    g.edges.push(createEdge(n1.id, n2.id, 'flow'))

    const text = serializeGraph(g)
    const back = parseGraphFile(text)
    expect(back).not.toBeNull()
    expect(back!.name).toBe('江雾渡')
    expect(back!.nodes.length).toBe(2)
    expect(back!.edges.length).toBe(1)
    expect(back!.nodes[0].id).toBe(n1.id)
  })
})
