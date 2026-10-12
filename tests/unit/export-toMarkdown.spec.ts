/**
 * export-toMarkdown.spec.ts —— 测试 export/toMarkdown.ts 的大纲导出
 */
import { describe, it, expect } from 'vitest'
import { createGraph, createNode } from '@/core/model'
import { toMarkdown } from '@/export/toMarkdown'

describe('toMarkdown · 大纲导出', () => {
  it('正常：含图名一级标题、节点二级标题、支线三级标题并标注支线', () => {
    const g = createGraph('江雾渡')
    g.nodes.push(createNode({ title: '序章', lane: 0, order: 0 }))
    g.nodes.push(createNode({ title: '南岸当铺', lane: 1, order: 0 }))

    const md = toMarkdown(g)
    expect(md).toContain('# 江雾渡') // 一级标题
    expect(md).toContain('## ') // 主线二级标题
    expect(md).toContain('### ') // 支线三级标题
    expect(md).toContain('支线 1') // 支线标注
  })

  it('正常：顶部含 YAML front matter（title/updated/nodes）', () => {
    const g = createGraph('江雾渡')
    g.nodes.push(createNode({ title: '序章' }))

    const md = toMarkdown(g)
    expect(md).toContain('---')
    expect(md).toContain('title:')
    expect(md).toContain('updated:')
    expect(md).toContain('nodes:')
  })

  it('边界/异常：空图输出提示且无崩溃', () => {
    const g = createGraph('空图')
    const md = toMarkdown(g)
    expect(md).toContain('# 空图')
    expect(md).toContain('没有节点')
  })
})
