/**
 * export-toSvg.spec.ts —— 测试 export/toSvg.ts 的 toSvgString（仅测字符串，不测 toPng）
 */
import { describe, it, expect } from 'vitest'
import { createGraph, createNode, createEdge } from '@/core/model'
import { toSvgString } from '@/export/toSvg'

describe('toSvgString · 导出 SVG（仅字符串层）', () => {
  it('正常：返回含 <svg / xmlns / xmlns:xlink / rx 的字符串', () => {
    const g = createGraph('江雾渡')
    g.nodes.push(createNode({ title: '序章', summary: '秋雨连下七日' }))
    g.nodes.push(createNode({ title: '第一章' }))
    g.edges.push(createEdge(g.nodes[0].id, g.nodes[1].id, 'flow'))

    const svg = toSvgString(g)
    expect(typeof svg).toBe('string')
    expect(svg).toContain('<svg')
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain('xmlns:xlink')
    expect(svg).toContain('rx="18"')
  })

  it('正常：节点数对应的卡片 rect 数量、连线对应的 path 数量一致', () => {
    const g = createGraph('计数')
    const n1 = createNode({ title: '一' })
    const n2 = createNode({ title: '二' })
    const n3 = createNode({ title: '三' })
    g.nodes.push(n1, n2, n3)
    g.edges.push(createEdge(n1.id, n2.id, 'flow'))
    g.edges.push(createEdge(n2.id, n3.id, 'jump'))

    const svg = toSvgString(g)
    // 每张卡片一个 card rect（fill=url(#nf-card-grad)）
    const cardRects = (svg.match(/fill="url\(#nf-card-grad\)"/g) || []).length
    expect(cardRects).toBe(3)

    // 4 个箭头 marker 的 <path> + 2 条边 = 6
    const paths = (svg.match(/<path/g) || []).length
    expect(paths - 4).toBe(g.edges.length)
  })

  it('关键：含中文标题/摘要时不抛异常且输出含中文（验证中文不崩溃）', () => {
    const g = createGraph('江雾渡 · 示例时间线')
    g.nodes.push(
      createNode({
        title: '序章 · 雨夜渡口',
        summary: '一场连下七日的秋雨，把渡口的石阶泡成了墨色'
      })
    )
    let svg = ''
    expect(() => {
      svg = toSvgString(g)
    }).not.toThrow()
    expect(svg).toContain('江雾渡')
    expect(svg).toContain('序章')
  })

  it('边界：空图也能生成不含崩溃的 SVG', () => {
    const g = createGraph('空图')
    let svg = ''
    expect(() => {
      svg = toSvgString(g)
    }).not.toThrow()
    expect(svg).toContain('<svg')
  })
})
