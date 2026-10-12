/**
 * export-toJson.spec.ts —— 测试 export/toJson.ts 的序列化与解析
 */
import { describe, it, expect } from 'vitest'
import { createGraph, createNode, createEdge } from '@/core/model'
import { exportJson, parseJson } from '@/export/toJson'

describe('exportJson / parseJson · JSON 往返', () => {
  it('正常：exportJson 序列化后再 parseJson 回来字段一致', () => {
    const g = createGraph('江雾渡')
    const n1 = createNode({ title: '序章', summary: '秋雨' })
    const n2 = createNode({ title: '第一章' })
    g.nodes.push(n1, n2)
    g.edges.push(createEdge(n1.id, n2.id, 'flow'))

    const text = exportJson(g)
    // 缩进 2 空格，故冒号后有空格
    expect(text).toContain('"kind": "novelflow-graph"')

    const back = parseJson(text)
    expect(back.name).toBe('江雾渡')
    expect(back.nodes.length).toBe(2)
    expect(back.edges.length).toBe(1)
    expect(back.nodes[0].id).toBe(n1.id)
  })

  it('正常：parseJson 兼容裸 FlowGraph（无信封）', () => {
    const raw = JSON.stringify({
      id: 'g1',
      name: '裸图',
      nodes: [{ id: 'n1', title: 'x' }],
      edges: []
    })
    const g = parseJson(raw)
    expect(g.name).toBe('裸图')
    expect(g.nodes.length).toBe(1)
  })

  it('异常：非法 JSON 抛出错误', () => {
    expect(() => parseJson('这不是 json }{')).toThrow()
  })

  it('异常：文件版本高于当前程序时抛出错误', () => {
    const future = JSON.stringify({
      kind: 'novelflow-graph',
      version: 99,
      graph: { nodes: [] }
    })
    expect(() => parseJson(future)).toThrow(/版本|version/i)
  })
})
