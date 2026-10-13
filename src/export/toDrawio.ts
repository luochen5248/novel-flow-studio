import type { FlowGraph, PortSide, StoryNode } from '@/types/graph'
import { EDGE_STYLE, TOKEN_COLORS } from './constants'
import { escapeXml, nodeHex } from './utils'

/**
 * draw.io / diagrams.net XML 导出
 *
 * 产出标准 mxGraphModel（<mxfile><diagram><mxGraphModel><root>…），
 * draw.io 网页版 / 桌面版可直接打开，Visio 通过 draw.io 插件导入。
 *
 * 排版约定：
 *  - 圆角卡片：`rounded=1;arcSize=12`（arcSize 是圆角占短边的百分比，
 *    260×132 的卡片上约等于 12% ≈ 18px 圆角，与运行时 SVG 的 rx=18 观感一致）；
 *  - 多层文本用 `html=1` + `<br/>`，文本本身必须先做 XML 转义；
 *  - 坐标整体平移到非负（draw.io 不会自动归位负坐标内容，否则打开时图在画布外）。
 */

export interface DrawioOptions {
  /** 页面留白，默认 40 */
  margin?: number
  /** 是否在卡片里带上摘要 */
  withSummary?: boolean
}

interface Layout {
  offsetX: number
  offsetY: number
  pageWidth: number
  pageHeight: number
}

/** 计算平移量，保证所有内容为非负坐标 */
function computeLayout(nodes: StoryNode[], margin: number): Layout {
  if (!nodes.length) {
    return { offsetX: margin, offsetY: margin, pageWidth: 1100, pageHeight: 850 }
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + n.w)
    maxY = Math.max(maxY, n.y + n.h)
  }
  return {
    offsetX: margin - minX,
    offsetY: margin - minY,
    pageWidth: Math.round(maxX - minX + margin * 2),
    pageHeight: Math.round(maxY - minY + margin * 2)
  }
}

/**
 * 卡片 value：多行富文本（draw.io 用 html=1 渲染）。
 * 关键：整个富文本串（含结构标签 <b>/<br/>）一并做 XML 转义，
 * 否则裸标签会让 mxCell 的 value="..." 属性变成非 well-formed XML，
 * draw.io / Visio 严格解析会直接失败（DOMParser 报 parsererror）。
 * html=1 下 draw.io 会把 &lt;b&gt; 反向解析回 <b> 富文本，渲染效果不变。
 */
function nodeValue(node: StoryNode, withSummary: boolean): string {
  const parts: string[] = []
  const title = node.title || '未命名事件'
  parts.push(`<b>${escapeXml(title)}</b>`)
  const time = node.timeLabel || node.chapter
  if (time) parts.push(escapeXml(`时间：${time}`))
  if (withSummary && node.summary) parts.push(escapeXml(node.summary))
  const footer = [node.location, node.characters.join('、')].filter(Boolean).join(' · ')
  if (footer) parts.push(escapeXml(footer))
  // 整体再转义一次，确保 value 属性 well-formed（<b>/<br/> 也变成 &lt;b&gt;/&lt;br/&gt;）
  return escapeXml(parts.join('<br/>'))
}

/** 卡片样式：圆角 + 主色描边 + 左对齐上对齐（与运行时卡片内部排版一致） */
function nodeStyle(node: StoryNode): string {
  const accent = nodeHex(node.color, node.kind)
  return [
    'rounded=1',
    // arcSize=12 = 圆角半径取短边 12%（260×132 卡片上约 15px），与运行时 rx=18 的柔和圆角同族
    'arcSize=12',
    'html=1',
    'whiteSpace=wrap',
    'align=left',
    'verticalAlign=top',
    'spacingLeft=14',
    'spacingTop=10',
    'fillColor=#FFFFFF',
    `strokeColor=${accent}`,
    'strokeWidth=2',
    'fontColor=#1B2634',
    'fontSize=13',
    'shadow=1'
  ].join(';') + ';'
}

/**
 * 锚点 → draw.io 退出/进入方位（0..1 的相对坐标）。
 * 缺省（旧边无 handle）保持既有硬编码：出口在下边中点、入口在上边中点。
 */
const EXIT_ENTRY: Record<PortSide, { x: number; y: number }> = {
  top: { x: 0.5, y: 0 },
  bottom: { x: 0.5, y: 1 },
  left: { x: 0, y: 0.5 },
  right: { x: 1, y: 0.5 }
}

/** 连线样式：正交圆角（drawio 内部会平滑）+ 细长实心箭头 */
function edgeStyle(
  kind: keyof typeof EDGE_STYLE,
  edge: { sourceHandle?: PortSide; targetHandle?: PortSide }
): string {
  const s = EDGE_STYLE[kind] ?? EDGE_STYLE.flow
  const exit = edge.sourceHandle ? EXIT_ENTRY[edge.sourceHandle] : { x: 0.5, y: 1 }
  const entry = edge.targetHandle ? EXIT_ENTRY[edge.targetHandle] : { x: 0.5, y: 0 }
  const parts = [
    'edgeStyle=orthogonalEdgeStyle',
    'rounded=1',
    'html=1',
    'endArrow=block',
    `strokeWidth=${s.width}`,
    `strokeColor=${s.color}`,
    `exitX=${exit.x}`,
    `exitY=${exit.y}`,
    'exitDx=0',
    'exitDy=0',
    `entryX=${entry.x}`,
    `entryY=${entry.y}`,
    'entryDx=0',
    'entryDy=0'
  ]
  if (s.dash) parts.push('dashed=1')
  return parts.join(';') + ';'
}

/**
 * 生成 draw.io XML 文本。
 * @param graph 流程图
 * @param options 输出选项
 */
export function toDrawio(graph: FlowGraph, options: DrawioOptions = {}): string {
  const margin = typeof options.margin === 'number' ? options.margin : 40
  const withSummary = options.withSummary !== false
  const layout = computeLayout(graph.nodes, margin)
  const safeName = escapeXml(graph.name || '未命名故事线')

  const idOf = new Map<string, string>()
  graph.nodes.forEach((node, i) => idOf.set(node.id, `node${i}`))

  const body: string[] = []

  for (const [i, node] of graph.nodes.entries()) {
    const x = Math.round(node.x + layout.offsetX)
    const y = Math.round(node.y + layout.offsetY)
    const w = Math.round(node.w || 260)
    const h = Math.round(node.h || 132)
    body.push(
      `        <mxCell id="node${i}" value="${nodeValue(node, withSummary)}" style="${nodeStyle(
        node
      )}" vertex="1" parent="1">`
    )
    body.push(`          <mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry" />`)
    body.push('        </mxCell>')
  }

  let edgeIndex = 0
  for (const edge of graph.edges) {
    const source = idOf.get(edge.source)
    const target = idOf.get(edge.target)
    if (!source || !target) continue
    const label = edge.label ? ` value="${escapeXml(edge.label)}"` : ''
    body.push(
      `        <mxCell id="edge${edgeIndex}"${label} style="${edgeStyle(
        edge.kind,
        edge
      )}" edge="1" parent="1" source="${source}" target="${target}">`
    )
    body.push('          <mxGeometry relative="1" as="geometry" />')
    body.push('        </mxCell>')
    edgeIndex += 1
  }

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<mxfile host="NovelFlow" agent="NovelFlow Studio" version="1.0" type="device">`,
    `  <diagram id="${escapeXml(graph.id || 'graph')}" name="${safeName}">`,
    `    <mxGraphModel dx="1102" dy="798" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${layout.pageWidth}" pageHeight="${layout.pageHeight}" math="0" shadow="0">`,
    `      <root>`,
    `        <mxCell id="0" />`,
    `        <mxCell id="1" parent="0" />`,
    ...body,
    `      </root>`,
    `    </mxGraphModel>`,
    `  </diagram>`,
    `</mxfile>`,
    ''
  ].join('\n')
}

/** draw.io 的 fillColor 若想跟随主题，可覆盖这里（浅色卡片默认白色） */
export const DRAWIO_CARD_FILL = TOKEN_COLORS.teal
