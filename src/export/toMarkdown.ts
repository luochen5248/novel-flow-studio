import type { FlowGraph, StoryNode } from '@/types/graph'
import { KIND_TEXT, STATUS_TEXT } from './constants'
import { formatDateTime } from './utils'

/**
 * Markdown 大纲导出
 *
 * 形态：一级标题 = 图名；主线节点为二级标题；支线节点降为三级并标注所属支线。
 * 顶部带 YAML front matter，可直接丢进 Obsidian / 语雀 / 任意静态博客。
 */

export interface MarkdownOptions {
  /** 是否附带完整正文（content）。默认 false —— 大纲就该是大纲 */
  includeContent?: boolean
  /** 是否输出 YAML front matter。默认 true */
  includeFrontMatter?: boolean
  /** 是否输出备注（note） */
  includeNote?: boolean
}

/** YAML 字符串值转义：统一加引号并处理内部引号 */
function yamlString(value: string): string {
  return '"' + String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/** 大纲排序：主线在前，其余按 |lane| 升序、lane 内按 order 升序 */
function outlineOrder(nodes: StoryNode[]): StoryNode[] {
  return [...nodes].sort((a, b) => {
    const ga = a.lane === 0 ? 0 : 1
    const gb = b.lane === 0 ? 0 : 1
    if (ga !== gb) return ga - gb
    if (Math.abs(a.lane) !== Math.abs(b.lane)) return Math.abs(a.lane) - Math.abs(b.lane)
    if (a.lane !== b.lane) return a.lane - b.lane
    return a.order - b.order
  })
}

/**
 * 生成 Markdown 大纲。
 * @param graph 流程图
 * @param options 输出选项
 */
export function toMarkdown(graph: FlowGraph, options: MarkdownOptions = {}): string {
  const includeFrontMatter = options.includeFrontMatter !== false
  const lines: string[] = []

  if (includeFrontMatter) {
    lines.push('---')
    lines.push(`title: ${yamlString(graph.name || '未命名故事线')}`)
    lines.push(`updated: ${yamlString(new Date(graph.updatedAt || Date.now()).toISOString())}`)
    lines.push(`nodes: ${graph.nodes.length}`)
    lines.push(`edges: ${graph.edges.length}`)
    lines.push('---')
    lines.push('')
  }

  lines.push(`# ${graph.name || '未命名故事线'}`)
  lines.push('')
  lines.push(
    `> 生成于 ${formatDateTime(Date.now())} · 共 ${graph.nodes.length} 个节点 · ${graph.edges.length} 条连线`
  )
  lines.push('')

  const ordered = outlineOrder(graph.nodes)
  if (!ordered.length) {
    lines.push('_（这张图还没有节点）_')
    lines.push('')
    return lines.join('\n')
  }

  ordered.forEach((node, i) => {
    const index = i + 1
    const isBranch = node.lane !== 0
    const title = node.title || '未命名事件'
    lines.push(`${isBranch ? '###' : '##'} ${index} · ${title}`)
    lines.push('')

    const bullets: string[] = []
    const time = node.timeLabel || node.chapter
    if (time) bullets.push(`- **时间**：${time}`)
    if (node.location) bullets.push(`- **地点**：${node.location}`)
    if (node.characters.length) bullets.push(`- **人物**：${node.characters.join('、')}`)
    if (node.summary) bullets.push(`- **摘要**：${node.summary}`)
    if (isBranch) bullets.push(`- **所属支线**：${branchNameOf(node.lane)}`)
    bullets.push(`- **类型**：${KIND_TEXT[node.kind] ?? node.kind}`)
    bullets.push(`- **状态**：${STATUS_TEXT[node.status] ?? node.status}`)
    if (node.tags.length) bullets.push(`- **标签**：${node.tags.join('、')}`)
    if (options.includeNote !== false && node.note) {
      bullets.push(`- **备注**：${node.note.replace(/\r?\n/g, ' / ')}`)
    }
    lines.push(...bullets)
    lines.push('')

    if (options.includeContent && node.content) {
      lines.push(node.content.trim())
      lines.push('')
    }
  })

  return lines.join('\n')
}

/** 支线命名：lane 1 → 支线 1；lane -1 → 支线 -1 */
function branchNameOf(lane: number): string {
  return `支线 ${lane}`
}
