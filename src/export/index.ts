import type { FlowGraph } from '@/types/graph'
import { exportJson, parseJson, normalizeGraph, GRAPH_FILE_VERSION } from './toJson'
import { buildExportSvg, toSvgString } from './toSvg'
import { downloadBlob, exportPng, normalizeScale, type PngScale } from './toPng'
import { toMarkdown } from './toMarkdown'
import { toMermaid } from './toMermaid'
import { toDrawio } from './toDrawio'
import { exportFilename } from './utils'

/**
 * 导出层统一入口
 *
 * UI（ExportMenu）、AI API（window.NovelFlow.exportXXX）、测试都只认这一层，
 * 具体格式的差异被收在各自模块里。
 */

export type ExportFormat = 'png' | 'svg' | 'json' | 'markdown' | 'mermaid' | 'drawio'

export const EXPORT_FORMATS: ExportFormat[] = [
  'png',
  'svg',
  'json',
  'markdown',
  'mermaid',
  'drawio'
]

/** 各格式的扩展名与 MIME，下载与 Blob 构造都从这里取，避免两处硬编码 */
export const FORMAT_META: Record<ExportFormat, { ext: string; mime: string; label: string }> = {
  png: { ext: 'png', mime: 'image/png', label: 'PNG 图片' },
  svg: { ext: 'svg', mime: 'image/svg+xml;charset=utf-8', label: 'SVG 矢量图' },
  json: { ext: 'json', mime: 'application/json;charset=utf-8', label: 'JSON 数据' },
  markdown: { ext: 'md', mime: 'text/markdown;charset=utf-8', label: 'Markdown 大纲' },
  mermaid: { ext: 'mmd', mime: 'text/plain;charset=utf-8', label: 'Mermaid 流程图' },
  drawio: { ext: 'drawio', mime: 'application/xml;charset=utf-8', label: 'draw.io XML' }
}

export interface ExportOptions {
  /** PNG 倍率 1 / 2 / 4 */
  scale?: PngScale
  /** PNG / SVG 是否透明背景 */
  transparent?: boolean
  /** 覆盖画布明暗模式 */
  canvasMode?: 'light' | 'dark'
  /** Markdown 是否附带正文 */
  includeContent?: boolean
  /** Mermaid 主方向 */
  direction?: 'TD' | 'LR'
  /** SVG 是否内嵌节点配图（会让 PNG 导出被跨域污染，谨慎开启） */
  includeImages?: boolean
}

export interface ExportResult {
  /** 建议文件名，含扩展名 */
  filename: string
  /** 产物内容 */
  blob: Blob
  /** MIME */
  mime: string
  /** 扩展名 */
  ext: string
}

/** 生成「图名_时间戳.扩展名」 */
export function exportFilenameFor(graph: FlowGraph, format: ExportFormat): string {
  return exportFilename(graph.name || '未命名故事线', FORMAT_META[format].ext)
}

/**
 * 统一导出：任何格式都返回 Blob + 文件名，调用方只需 downloadBlob(result.blob, result.filename)。
 * 纯文本格式也在浏览器里包成 Blob，这样下载路径只有一条。
 * @throws 环境不支持（如无 document）或数据非法时抛出明确 Error
 */
export async function doExport(
  graph: FlowGraph,
  format: ExportFormat,
  options: ExportOptions = {}
): Promise<ExportResult> {
  const meta = FORMAT_META[format]
  const filename = exportFilenameFor(graph, format)

  let blob: Blob
  switch (format) {
    case 'png':
      blob = await exportPng(graph, {
        scale: normalizeScale(options.scale),
        transparent: options.transparent,
        canvasMode: options.canvasMode
      })
      break
    case 'svg':
      blob = new Blob(
        [
          toSvgString(graph, {
            transparent: options.transparent,
            canvasMode: options.canvasMode,
            includeImages: options.includeImages
          })
        ],
        { type: meta.mime }
      )
      break
    case 'json':
      blob = new Blob([exportJson(graph)], { type: meta.mime })
      break
    case 'markdown':
      blob = new Blob([toMarkdown(graph, { includeContent: options.includeContent })], {
        type: meta.mime
      })
      break
    case 'mermaid':
      blob = new Blob([toMermaid(graph, { direction: options.direction })], { type: meta.mime })
      break
    case 'drawio':
      blob = new Blob([toDrawio(graph)], { type: meta.mime })
      break
    default:
      throw new Error(`不支持的导出格式：${String(format)}`)
  }

  return { filename, blob, mime: meta.mime, ext: meta.ext }
}

/* ------------------------------------------------------------------ */
/* 再导出：方便外部按需引用                                             */
/* ------------------------------------------------------------------ */

export { exportJson, parseJson, normalizeGraph, GRAPH_FILE_VERSION }
export { buildExportSvg, toSvgString }
export { exportPng, downloadBlob, normalizeScale }
export { toMarkdown }
export { toMermaid }
export { toDrawio }
export { exportFilename }
export type { PngScale }
export type { SvgExportOptions } from './toSvg'
export type { PngExportOptions } from './toPng'
export type { MarkdownOptions } from './toMarkdown'
export type { MermaidOptions } from './toMermaid'
export type { DrawioOptions } from './toDrawio'
export type { GraphFileEnvelope } from './toJson'
