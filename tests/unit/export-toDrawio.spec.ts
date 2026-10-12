/**
 * export-toDrawio.spec.ts —— 测试 export/toDrawio.ts 的 draw.io XML 导出
 *
 * 覆盖：mxGraphModel / root / vertex / edge 结构；
 * 样式串 rounded=1 与 arcSize；属性中转义字符；XML 可被解析。
 */
import { describe, it, expect } from 'vitest'
import { createGraph, createNode, createEdge } from '@/core/model'
import { toDrawio } from '@/export/toDrawio'

function buildDangerousGraph() {
  const g = createGraph('图名&含<特殊>字符"与\'')
  const n1 = createNode({
    title: 'A & B < C > D " E \' F',
    summary: '摘要含 & < > " \''
  })
  const n2 = createNode({ title: '第二章' })
  g.nodes.push(n1, n2)
  g.edges.push(createEdge(n1.id, n2.id, 'flow', '连线&标签<x>'))
  return g
}

describe('toDrawio · draw.io XML 导出', () => {
  it('正常：含 mxGraphModel / root / vertex / edge 单元格', () => {
    const xml = toDrawio(buildDangerousGraph())
    expect(xml).toContain('<mxGraphModel')
    expect(xml).toContain('<root>')
    expect(xml).toContain('vertex="1"')
    expect(xml).toContain('edge="1"')
  })

  it('正常：样式串含 rounded=1 与 arcSize', () => {
    const xml = toDrawio(buildDangerousGraph())
    expect(xml).toContain('rounded=1')
    expect(xml).toContain('arcSize=')
  })

  it('正常：DOMParser 严格解析无 parsererror（含危险字符与中文的图）', () => {
    // 主判据：jsdom 的 DOMParser 以 application/xml 严格解析，
    // 任何未转义的裸标签 / 裸 & 都会生成 <parsererror>，draw.io / Visio 将无法打开。
    const xml = toDrawio(buildDangerousGraph())
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    expect(doc.querySelector('parsererror')).toBeNull()
  })

  it('正常：用户文本的特殊字符在 value 属性内被转义为 XML 实体', () => {
    const xml = toDrawio(buildDangerousGraph())
    expect(xml).toContain('&amp;')
    expect(xml).toContain('&lt;')
    expect(xml).toContain('&gt;')
    expect(xml).toContain('&quot;')
    expect(xml).toContain('&apos;')
    // value 属性内不得出现未转义的裸 & （实体 &amp; 本身除外）
    expect(xml).not.toMatch(/value="[^"]*&(?!amp;|lt;|gt;|quot;|apos;)/)
  })

  it('正常：空图仍输出合法 mxGraphModel 与 root（含两个默认单元）', () => {
    const xml = toDrawio(createGraph('空图'))
    expect(xml).toContain('<mxGraphModel')
    expect(xml).toContain('<root>')
  })

  it('修复回归：含 <b>/<br/> 富文本与中文的图，DOMParser 严格解析无 parsererror', () => {
    // 模拟用户输入自带富文本标记（<b>标题</b>）以及中文/标点，并带摘要、时间、地点、人物
    const g = createGraph('故事线&中文测试')
    const n1 = createNode({
      title: '<b>标题</b>',
      summary: '摘要含换行 <br/> 与中文标点：，。',
      location: '北京',
      characters: ['张三', '李四']
    })
    const n2 = createNode({ title: '第二章 <b>高潮</b>' })
    g.nodes.push(n1, n2)
    g.edges.push(createEdge(n1.id, n2.id, 'flow', '转折 <x> 与 & 符号'))

    const xml = toDrawio(g)

    // 关键回归点：整段富文本（含结构标签 <b>/<br/>）必须被 XML 转义，
    // 不能让裸标签出现在 value="..." 属性里（这正是原缺陷）。
    // 修法是方案 A：整体再escapeXml 一次 + html=1，
    // draw.io 会把 &lt;b&gt; 反向解析回 <b>，渲染效果不变。
    expect(xml).not.toMatch(/value="[^"]*<b>/)
    expect(xml).not.toMatch(/value="[^"]*<br\/>/)

    // 主判据：well-formed 校验，用 DOMParser 以 application/xml 严格解析。
    // 任何未转义的裸标签 / 裸 & 都会生成 <parsererror>，draw.io / Visio 打不开。
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    expect(doc.querySelector('parsererror')).toBeNull()

    // 反向确认：转义后的富文本仍以 html=1 渲染（否则修复会把富文本显示成字面量）
    expect(xml).toContain('html=1')
  })

  it('正常：DOMParser 严格解析能取回节点/边数量与 value 文本（转义未丢内容）', () => {
    const xml = toDrawio(buildDangerousGraph())
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    // 能取到 2 个 vertex、1 条 edge，说明解析结果不只是「没报错」而是结构正确
    const vertices = Array.from(doc.querySelectorAll('mxCell[vertex="1"]'))
    const edges = doc.querySelectorAll('mxCell[edge="1"]')
    expect(vertices.length).toBe(2)
    expect(edges.length).toBe(1)

    // 实体在解析后被正确解回原始字符（value 是属性，须用 getAttribute 读，
    // 不能用 textContent —— 属性值不进 textContent）
    const values = vertices.map((v) => v.getAttribute('value') ?? '')
    expect(values.join('\n')).toContain('&') // 'A & B < C > D " E \' F'
    expect(values.join('\n')).toContain('<') // 标题里的 < C >
    expect(values.join('\n')).toContain('第二章')
  })
})
