import type { FlowGraph, StoryNode } from '@/types/graph'
import { buildEdgeGeom } from '@/core/geometry'
import {
  ACCENT_BAR_W,
  CARD_RADIUS,
  CARD_RADIUS_SMALL,
  DARK_THEME,
  EDGE_STYLE,
  EXPORT_PADDING,
  FONT_BADGE,
  FONT_HEADER,
  FONT_HEADER_META,
  FONT_META,
  FONT_STACK,
  FONT_SUMMARY,
  FONT_TITLE,
  HEADER_HEIGHT,
  LIGHT_THEME,
  type ExportTheme
} from './constants'
import {
  escapeXml,
  estimateTextWidth,
  formatDateTime,
  nodeHex,
  truncateToWidth,
  wrapText
} from './utils'

/**
 * 导出专用 SVG 构建器
 *
 * 与运行时画布（FlowCanvas）彻底解耦：
 *  - 不引用任何 Vue 组件、不 foreignObject、不依赖外部 CSS / webfont；
 *  - 字体栈内联在 <style> 里，栅格化（PNG）与离线打开都不会掉字体；
 *  - 阴影用 <filter> 双层 feDropShadow 复刻，卡片用 SVG 原生圆角矩形 + 裁剪导条；
 *  - 连线走 @/core/geometry 的 buildEdgeGeom（与屏幕上的曲线是同一套算法）。
 *
 * 因此「导出结果」与「屏幕所见」在形状、配色、层级上保持一致，
 * 而导出的 SVG 又是一张自洽的静态图（可直接拖进浏览器 / Figma / Illustrator）。
 */

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'

export interface SvgExportOptions {
  /** 输出倍率：1 / 2 / 4。作用于 SVG 的 width/height（矢量光栅化尺寸） */
  scale?: number
  /** 透明背景（PNG 用），为 true 时不画底色矩形 */
  transparent?: boolean
  /** 画布明暗模式，缺省跟随图的 settings.canvasMode */
  canvasMode?: 'light' | 'dark'
  /** 额外内边距，缺省 48 */
  padding?: number
  /** 是否绘制顶部标题区（图名 + 生成时间） */
  showHeader?: boolean
  /**
   * 是否把节点配图以 <image> 嵌入。默认 false：
   * 远程图片会让 canvas 被跨域污染，PNG 导出（toBlob）会直接抛 SecurityError。
   */
  includeImages?: boolean
}

interface BuildContext {
  defs: SVGDefsElement
  theme: ExportTheme
  scale: number
  includeImages: boolean
}

/** 创建带属性的 SVG 元素 */
function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {}
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  return node
}

/** 创建带文本的 SVG <text> */
function text(
  content: string,
  attrs: Record<string, string | number> = {}
): SVGTextElement {
  const node = el('text', attrs)
  node.textContent = content
  return node
}

function r2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * 构建一张可独立存在的导出 SVG。
 *
 * @param graph 流程图数据
 * @param options 导出选项
 * @returns SVGSVGElement（未挂载到文档，可直接交给 XMLSerializer）
 */
export function buildExportSvg(graph: FlowGraph, options: SvgExportOptions = {}): SVGSVGElement {
  const scale = options.scale && options.scale > 0 ? options.scale : 1
  const padding = typeof options.padding === 'number' ? options.padding : EXPORT_PADDING
  const showHeader = options.showHeader !== false
  // 明暗模式：优先听调用方，缺省跟随图自身的 settings.canvasMode
  const mode = options.canvasMode ?? graph.settings?.canvasMode
  const theme = mode === 'dark' ? DARK_THEME : LIGHT_THEME
  const headerH = showHeader ? HEADER_HEIGHT : 0

  // 1) 包围盒
  const box = computeBounds(graph.nodes, padding, headerH)

  const svg = el('svg', {
    xmlns: SVG_NS,
    'xmlns:xlink': XLINK_NS,
    version: '1.1',
    width: r2(box.w * scale),
    height: r2(box.h * scale),
    viewBox: `${r2(box.x)} ${r2(box.y)} ${r2(box.w)} ${r2(box.h)}`,
    'font-family': FONT_STACK
  })

  const defs = el('defs')
  svg.appendChild(defs)
  buildSharedDefs(defs, theme)

  const ctx: BuildContext = {
    defs,
    theme,
    scale,
    includeImages: options.includeImages === true
  }

  // 2) 底：宣纸暖白 / 夜间墨色（transparent 时不画）
  if (!options.transparent) {
    svg.appendChild(
      el('rect', {
        x: box.x,
        y: box.y,
        width: box.w,
        height: box.h,
        fill: theme.background
      })
    )
  }

  // 3) 时间轨道：主线一条贯穿的柔和光带（视觉红线 8.1.3）
  svg.appendChild(buildTimeRail(graph, theme))

  // 4) 连线（在卡片下方）
  svg.appendChild(buildEdgeLayer(graph))

  // 5) 节点卡片
  const nodeLayer = el('g', { class: 'nf-nodes' })
  graph.nodes.forEach((node, i) => {
    nodeLayer.appendChild(buildCard(node, ctx, i))
  })
  svg.appendChild(nodeLayer)

  // 6) 顶部标题区
  if (showHeader) {
    svg.appendChild(buildHeader(graph, box, theme))
  }

  return svg
}

/**
 * 序列化导出 SVG 为字符串（带 XML 声明，可直接存成 .svg 文件）。
 */
export function toSvgString(graph: FlowGraph, options: SvgExportOptions = {}): string {
  const svg = buildExportSvg(graph, options)
  const serializer = new XMLSerializer()
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + serializer.serializeToString(svg)
}

/* ------------------------------------------------------------------ */
/* 内部实现                                                            */
/* ------------------------------------------------------------------ */

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** 计算内容包围盒并留出内边距与标题区 */
function computeBounds(nodes: StoryNode[], padding: number, headerH: number): Box {
  if (!nodes.length) {
    return { x: 0, y: 0, w: 880, h: 620 }
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
  // 连线可能探出节点（曲线外拱），统一再留 24px 余量
  const slack = 24
  return {
    x: minX - padding - slack,
    y: minY - padding - headerH - slack,
    w: maxX - minX + (padding + slack) * 2,
    h: maxY - minY + (padding + slack) * 2 + headerH
  }
}

/** 共享 defs：卡片渐层、双层柔阴影、箭头、轨道渐变 */
function buildSharedDefs(defs: SVGDefsElement, theme: ExportTheme): void {
  // 内联样式：字体栈 + 文本渲染，避免依赖任何外部 CSS / webfont
  const style = el('style', { type: 'text/css' })
  style.textContent = `
  text { font-family: ${FONT_STACK}; }
  .nf-title { font-weight: 600; }
  .nf-badge { letter-spacing: .04em; }
  .nf-muted { letter-spacing: .02em; }
`
  defs.appendChild(style)

  // 卡片柔和渐层（上浅下略深），而非纯色块
  const grad = el('linearGradient', {
    id: 'nf-card-grad',
    x1: '0',
    y1: '0',
    x2: '0',
    y2: '1'
  })
  grad.appendChild(el('stop', { offset: '0', 'stop-color': theme.cardFrom }))
  grad.appendChild(el('stop', { offset: '1', 'stop-color': theme.cardTo }))
  defs.appendChild(grad)

  // 双层柔阴影：0 1px 2px rgba(15,23,32,.05) + 0 8px 24px rgba(15,23,32,.06)
  const shadow = el('filter', {
    id: 'nf-card-shadow',
    x: '-25%',
    y: '-25%',
    width: '150%',
    height: '150%'
  })
  shadow.appendChild(
    el('feDropShadow', {
      dx: '0',
      dy: '1',
      stdDeviation: '1',
      'flood-color': theme.shadow,
      'flood-opacity': '0.05'
    })
  )
  shadow.appendChild(
    el('feDropShadow', {
      dx: '0',
      dy: '8',
      stdDeviation: '12',
      'flood-color': theme.shadow,
      'flood-opacity': '0.06'
    })
  )
  defs.appendChild(shadow)

  // 时间轨道纵向渐变（上深下浅，表达时间流逝）
  const rail = el('linearGradient', { id: 'nf-rail-grad', x1: '0', y1: '0', x2: '0', y2: '1' })
  rail.appendChild(el('stop', { offset: '0', 'stop-color': theme.rail, 'stop-opacity': '0.75' }))
  rail.appendChild(el('stop', { offset: '1', 'stop-color': theme.rail, 'stop-opacity': '0.12' }))
  defs.appendChild(rail)

  // 箭头：细长、端点圆润，绝不做成夸张的大三角
  defs.appendChild(
    buildMarker('nf-arrow', theme.rail, 'M 0 0 L 7 3.2 L 0 6.4 Z', 7, 6.4, 6.6, 3.2)
  )
  defs.appendChild(
    buildMarker('nf-arrow-branch', '#C9A227', 'M 0 0 L 7 3.2 L 0 6.4 Z', 7, 6.4, 6.6, 3.2)
  )
  defs.appendChild(
    buildMarker('nf-arrow-muted', '#8A94A0', 'M 0 0 L 7 3.2 L 0 6.4 Z', 7, 6.4, 6.6, 3.2)
  )
  // 倒叙线起点反向箭头
  defs.appendChild(
    buildMarker('nf-arrow-back', '#8A94A0', 'M 7 0 L 0 3.2 L 7 6.4 Z', 7, 6.4, 0.4, 3.2)
  )
}

function buildMarker(
  id: string,
  color: string,
  d: string,
  w: number,
  h: number,
  refX: number,
  refY: number
): SVGMarkerElement {
  const marker = el('marker', {
    id,
    viewBox: `0 0 ${w} ${h}`,
    markerWidth: w,
    markerHeight: h,
    refX,
    refY,
    orient: 'auto',
    markerUnits: 'userSpaceOnUse'
  })
  marker.appendChild(el('path', { d, fill: color }))
  return marker
}

/** 主线时间轨道：一条 2px 实线 + 一层柔光晕 */
function buildTimeRail(graph: FlowGraph, theme: ExportTheme): SVGGElement {
  const g = el('g', { class: 'nf-rail' })
  const main = graph.nodes.filter((n) => n.lane === 0)
  if (main.length < 2) return g

  const horizontal = graph.settings.direction === 'horizontal'
  const centerOf = (n: StoryNode): number =>
    horizontal ? n.y + n.h / 2 : n.x + n.w / 2
  const startOf = (n: StoryNode): number => (horizontal ? n.x : n.y)
  const endOf = (n: StoryNode): number => (horizontal ? n.x + n.w : n.y + n.h)

  const center =
    main.reduce((sum, n) => sum + centerOf(n), 0) / main.length
  const from = Math.min(...main.map(startOf)) - 28
  const to = Math.max(...main.map(endOf)) + 28

  const common = horizontal
    ? { x1: from, y1: center, x2: to, y2: center }
    : { x1: center, y1: from, x2: center, y2: to }

  // 呼吸光晕
  g.appendChild(
    el('line', {
      ...common,
      stroke: theme.rail,
      'stroke-width': 10,
      'stroke-linecap': 'round',
      'stroke-opacity': '0.10'
    })
  )
  // 主体
  g.appendChild(
    el('line', {
      ...common,
      stroke: 'url(#nf-rail-grad)',
      'stroke-width': 2,
      'stroke-linecap': 'round'
    })
  )
  return g
}

/** 连线图层：贝塞尔 + 箭头 + 可选标签 */
function buildEdgeLayer(graph: FlowGraph): SVGGElement {
  const g = el('g', { class: 'nf-edges' })
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))

  for (const edge of graph.edges) {
    const source = byId.get(edge.source)
    const target = byId.get(edge.target)
    if (!source || !target) continue

    // 复用 core/geometry：与画布同一套三次贝塞尔（含 flashback 外拱、branch 甩出、jump 大肚子）
    const geom = buildEdgeGeom(source, target, edge.kind, {
      direction: graph.settings.direction
    })
    const style = EDGE_STYLE[edge.kind] ?? EDGE_STYLE.flow
    const attrs: Record<string, string | number> = {
      d: geom.d,
      fill: 'none',
      stroke: style.color,
      'stroke-width': style.width,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round'
    }
    if (edge.kind === 'flashback') {
      attrs['marker-start'] = 'url(#nf-arrow-back)'
      attrs['marker-end'] = 'url(#nf-arrow-muted)'
    } else {
      attrs['marker-end'] =
        edge.kind === 'branch' ? 'url(#nf-arrow-branch)' : 'url(#nf-arrow)'
    }
    if (edge.dashed || style.dash) attrs['stroke-dasharray'] = style.dash ?? '6 6'
    g.appendChild(el('path', attrs))

    if (edge.label) {
      const w = estimateTextWidth(edge.label, FONT_META) + 16
      g.appendChild(
        el('rect', {
          x: r2(geom.mid.x - w / 2),
          y: r2(geom.mid.y - 9),
          width: r2(w),
          height: 18,
          rx: 9,
          fill: 'rgba(255,255,255,0.86)',
          stroke: 'rgba(15,23,32,0.08)'
        })
      )
      g.appendChild(
        text(edge.label, {
          x: r2(geom.mid.x),
          y: r2(geom.mid.y + 4),
          'text-anchor': 'middle',
          'font-size': FONT_META,
          fill: '#55606C'
        })
      )
    }
  }
  return g
}

/** 单张节点卡片：圆角矩形 + 左侧主色导条 + 标题/时间徽标/摘要/页脚 */
function buildCard(node: StoryNode, ctx: BuildContext, index: number): SVGGElement {
  const { theme, defs } = ctx
  const g = el('g', { class: 'nf-node', 'data-id': escapeXml(node.id) })
  const radius = node.h < 104 ? CARD_RADIUS_SMALL : CARD_RADIUS
  const accent = nodeHex(node.color, node.kind)
  const padX = 16
  const textX = node.x + padX
  const textW = node.w - padX - 14

  // 导条裁剪路径：让 4px 竖条跟随卡片左侧圆角，而不是戳出方角
  const clipId = `nf-clip-${index}`
  const clip = el('clipPath', { id: clipId })
  clip.appendChild(
    el('rect', { x: node.x, y: node.y, width: node.w, height: node.h, rx: radius, ry: radius })
  )
  defs.appendChild(clip)

  g.appendChild(
    el('rect', {
      x: node.x,
      y: node.y,
      width: node.w,
      height: node.h,
      rx: radius,
      ry: radius,
      fill: 'url(#nf-card-grad)',
      stroke: theme.cardBorder,
      'stroke-width': 1,
      filter: 'url(#nf-card-shadow)'
    })
  )
  g.appendChild(
    el('rect', {
      x: node.x,
      y: node.y,
      width: ACCENT_BAR_W,
      height: node.h,
      fill: accent,
      'clip-path': `url(#${clipId})`
    })
  )

  // 标题（单行截断）
  g.appendChild(
    text(truncateToWidth(node.title || '未命名', FONT_TITLE, textW), {
      x: textX,
      y: node.y + 30,
      'font-size': FONT_TITLE,
      fill: theme.title,
      class: 'nf-title'
    })
  )

  // 时间徽标
  const badge = node.timeLabel || node.chapter || '未标注'
  const badgeW = Math.min(estimateTextWidth(badge, FONT_BADGE) + 16, textW)
  g.appendChild(
    el('rect', {
      x: textX,
      y: node.y + 38,
      width: r2(badgeW),
      height: 18,
      rx: 9,
      fill: theme.badgeBg
    })
  )
  g.appendChild(
    text(truncateToWidth(badge, FONT_BADGE, badgeW - 12), {
      x: textX + 8,
      y: node.y + 51,
      'font-size': FONT_BADGE,
      fill: theme.badgeText,
      class: 'nf-badge'
    })
  )

  // 摘要：最多 2 行，行高 1.6，超出加省略号
  const summaryLines = wrapText(node.summary, FONT_SUMMARY, textW, 2)
  summaryLines.forEach((line, i) => {
    g.appendChild(
      text(line, {
        x: textX,
        y: node.y + 82 + i * 18,
        'font-size': FONT_SUMMARY,
        fill: theme.body
      })
    )
  })

  // 页脚：地点 · 人物（高度不够时省略）
  if (node.h >= 112) {
    const footer = [node.location, node.characters.join('、')].filter(Boolean).join(' · ')
    if (footer) {
      g.appendChild(
        text(truncateToWidth(footer, FONT_META, textW), {
          x: textX,
          y: node.y + node.h - 12,
          'font-size': FONT_META,
          fill: theme.muted,
          class: 'nf-muted'
        })
      )
    }
  }

  // 配图（默认关闭，见 SvgExportOptions.includeImages 说明）
  if (ctx.includeImages && node.image?.url) {
    const thumbW = 64
    const thumbH = 40
    const img = el('image', {
      x: node.x + node.w - thumbW - 14,
      y: node.y + node.h - thumbH - 12,
      width: thumbW,
      height: thumbH,
      preserveAspectRatio: 'xMidYMid slice'
    })
    img.setAttribute('xlink:href', node.image.url)
    img.setAttribute('href', node.image.url)
    g.appendChild(img)
  }

  return g
}

/** 顶部标题区：图名 + 生成时间 + 统计 + 一条细分隔线 */
function buildHeader(graph: FlowGraph, box: Box, theme: ExportTheme): SVGGElement {
  const g = el('g', { class: 'nf-header' })
  const x = box.x + 4
  const y = box.y
  g.appendChild(
    text(graph.name || '未命名故事线', {
      x,
      y: y + 30,
      'font-size': FONT_HEADER,
      fill: theme.title,
      class: 'nf-title'
    })
  )
  const meta = `生成于 ${formatDateTime(Date.now())} · ${graph.nodes.length} 个节点 · ${
    graph.edges.length
  } 条连线`
  g.appendChild(
    text(meta, {
      x,
      y: y + HEADER_HEIGHT - 8,
      'font-size': FONT_HEADER_META,
      fill: theme.muted,
      class: 'nf-muted'
    })
  )
  g.appendChild(
    el('line', {
      x1: x,
      y1: y + HEADER_HEIGHT + 4,
      x2: box.x + box.w - 4,
      y2: y + HEADER_HEIGHT + 4,
      stroke: theme.cardBorder,
      'stroke-width': 1,
      'stroke-opacity': '0.7'
    })
  )
  return g
}
