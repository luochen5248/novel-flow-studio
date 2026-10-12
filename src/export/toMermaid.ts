import type { FlowGraph, StoryNode } from '@/types/graph'

/**
 * Mermaid 导出
 *
 * Mermaid 的节点文本是「裸语法」：引号、括号、方括号、#、; 都会把语法打断，
 * 所以这里做两级处理 —— 先剥掉危险字符，再把英文双引号替换成 Mermaid 认可的数字实体 `#quot;`。
 * 节点 id 一律用 n{index}（index = 在 graph.nodes 中的下标），避免用户 id 里的非法字符。
 */

export interface MermaidOptions {
  /** 主方向：TD（纵向时间轴）/ LR（横向） */
  direction?: 'TD' | 'LR'
  /** 是否输出开头的提示注释。默认 true */
  includeComment?: boolean
  /** 节点标签里是否带上时间徽标 */
  withTimeLabel?: boolean
}

/**
 * Mermaid 文本转义。
 * 顺序很关键：先去危险符号，再补 `#quot;`（否则补出来的 # 和 ; 会被自己清掉）。
 */
export function sanitizeMermaidText(text: string): string {
  return String(text ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\r?\n/g, ' ')
    .replace(/[#;()[\]{}|<>]/g, '')
    .replace(/"/g, '#quot;')
    .replace(/&/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 节点标签：标题（可选追加时间徽标），剥掉一切会破坏语法的字符 */
export function mermaidLabel(node: StoryNode, withTimeLabel = true): string {
  const time = withTimeLabel ? node.timeLabel || node.chapter : ''
  const raw = time ? `${node.title || '未命名'} · ${time}` : node.title || '未命名'
  return sanitizeMermaidText(raw) || '未命名'
}

/**
 * 生成 Mermaid flowchart 文本。
 * 主线与各支线分别包进 subgraph，边声明放在 subgraph 之后（兼容性最好）。
 */
export function toMermaid(graph: FlowGraph, options: MermaidOptions = {}): string {
  const direction = options.direction ?? (graph.settings.direction === 'horizontal' ? 'LR' : 'TD')
  const withTimeLabel = options.withTimeLabel !== false
  const lines: string[] = []

  if (options.includeComment !== false) {
    lines.push('%% 可直接粘贴到支持 Mermaid 的编辑器（需 Mermaid ≥ 11.14，低于此版本可能不识别 flowchart 的 subgraph 语法）')
  }
  lines.push(`flowchart ${direction}`)

  // 1) 按 lane 分组，节点声明放进各自的 subgraph
  const idOf = new Map<string, string>()
  graph.nodes.forEach((node, i) => idOf.set(node.id, `n${i}`))

  const lanes = Array.from(new Set(graph.nodes.map((n) => n.lane))).sort(
    (a, b) => Math.abs(a) - Math.abs(b) || a - b
  )
  for (const lane of lanes) {
    const members = graph.nodes
      .map((node, i) => ({ node, i }))
      .filter((item) => item.node.lane === lane)
      .sort((a, b) => a.node.order - b.node.order)
    if (!members.length) continue

    lines.push(`  subgraph lane${lane < 0 ? `m${Math.abs(lane)}` : lane}["${laneName(lane)}"]`)
    for (const { node, i } of members) {
      lines.push(`    n${i}["${mermaidLabel(node, withTimeLabel)}"]`)
    }
    lines.push('  end')
  }

  // 2) 边声明
  for (const edge of graph.edges) {
    const from = idOf.get(edge.source)
    const to = idOf.get(edge.target)
    if (!from || !to) continue
    const arrow = arrowOf(edge.kind)
    const label = edge.label ? sanitizeMermaidText(edge.label) : ''
    lines.push(label ? `  ${from} ${arrow}|${label}| ${to}` : `  ${from} ${arrow} ${to}`)
  }

  return lines.join('\n')
}

/** lane → subgraph 标题 */
function laneName(lane: number): string {
  return lane === 0 ? '主线' : `支线 ${lane}`
}

/** 连线类型 → Mermaid 箭头 */
function arrowOf(kind: string): string {
  switch (kind) {
    case 'flashback':
      return '-.->'
    case 'jump':
      return '==>'
    default:
      return '-->'
  }
}
