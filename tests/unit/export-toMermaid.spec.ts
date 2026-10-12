/**
 * export-toMermaid.spec.ts —— 测试 export/toMermaid.ts 的 Mermaid 导出
 */
import { describe, it, expect } from 'vitest'
import { createGraph, createNode } from '@/core/model'
import { toMermaid, mermaidLabel, sanitizeMermaidText } from '@/export/toMermaid'

describe('toMermaid · Mermaid 导出', () => {
  it('正常：以 flowchart TD 开头并含 %% 版本说明注释', () => {
    const g = createGraph('江雾渡')
    g.nodes.push(createNode({ title: '序章' }))
    const m = toMermaid(g)
    // 实现在 flowchart 之前先放了一行 %% 版本注释（Mermaid 合法），故用 includes 而非 startsWith
    expect(m).toContain('flowchart TD')
    expect(m).toContain('%%')
  })

  it('正常：支线被 subgraph 包裹', () => {
    const g = createGraph('江雾渡')
    g.nodes.push(createNode({ title: '序章', lane: 0, order: 0 }))
    g.nodes.push(createNode({ title: '当铺', lane: 1, order: 0 }))
    const m = toMermaid(g)
    expect(m).toContain('subgraph')
    expect(m).toContain('end')
    expect(m).toContain('支线 1')
  })

  it('正常：sanitizeMermaidText 移除危险符号（#;()[]{}|<>&）并压缩空白', () => {
    expect(sanitizeMermaidText('a#b;c(d)e[f]{g}|h<i>j&k')).toBe('abcdefghijk')
  })

  it('异常：含危险字符的节点文本被安全转义（不破坏语法）', () => {
    const dangerous = 'A"B(C)[D]#E'
    const g = createGraph('图')
    g.nodes.push(createNode({ title: dangerous }))

    const m = toMermaid(g)
    // 危险字符不应以原文出现
    expect(m).not.toContain('A"B(C)[D]#E')
    // 双引号被转换为 mermaid 实体
    expect(m).toContain('#quot;')
    // 节点定义行形如 n0["..."]，引号内不应出现未转义的 ]
    expect(m).toMatch(/n0\["[^\]]*"\]/)

    // 进一步：标签函数本身也安全
    expect(mermaidLabel(createNode({ title: 'X"Y(Z)[W]#' }))).toBe('X#quot;YZW')
  })
})
