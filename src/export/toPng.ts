import type { FlowGraph } from '@/types/graph'
import { buildExportSvg } from './toSvg'

/**
 * PNG 导出
 *
 * 路线（plan.md 已明确禁用 html-to-image 等库）：
 *   构建导出专用 SVG → XMLSerializer → Blob URL → new Image() → canvas.drawImage → toBlob
 *
 * 两个关键坑：
 *  1. 倍率必须作用在 **SVG 的 width/height** 上（而不是 canvas transform）。
 *     浏览器光栅化 SVG 时按图片内在尺寸取样，若只对 canvas 做 scale，等于把 1x 位图放大 —— 会糊。
 *  2. 必须等 image.onload；并且等 document.fonts.ready，否则首帧会用回退字体。
 */

export type PngScale = 1 | 2 | 4

export interface PngExportOptions {
  /** 输出倍率，1x / 2x / 4x */
  scale?: PngScale
  /** 透明背景 */
  transparent?: boolean
  /** 画布明暗模式，缺省跟随图的 settings.canvasMode */
  canvasMode?: 'light' | 'dark'
}

/** 把任意数值收敛到合法的导出倍率 */
export function normalizeScale(scale: number | undefined): PngScale {
  if (scale === 1 || scale === 2 || scale === 4) return scale
  if (typeof scale === 'number' && scale >= 4) return 4
  if (typeof scale === 'number' && scale >= 2) return 2
  return 2
}

/** 等待系统字体就绪（jsdom / 老浏览器上没有 document.fonts，静默跳过） */
async function waitFontsReady(): Promise<void> {
  const fonts = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts
  if (fonts && typeof fonts.ready?.then === 'function') {
    try {
      await fonts.ready
    } catch {
      /* 字体加载失败不应阻断导出 */
    }
  }
}

/**
 * 导出 PNG。
 * @throws 非浏览器环境 / 图片加载失败 / canvas 上下文不可用时抛出明确 Error
 */
export async function exportPng(graph: FlowGraph, options: PngExportOptions = {}): Promise<Blob> {
  if (typeof document === 'undefined') {
    throw new Error('PNG 导出失败：当前环境没有 document（请在浏览器中执行）')
  }
  const scale = normalizeScale(options.scale)
  await waitFontsReady()

  const svg = buildExportSvg(graph, {
    scale,
    transparent: options.transparent === true,
    canvasMode: options.canvasMode
  })
  const source = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg)
  const svgBlob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' })

  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('PNG 导出失败：当前环境不支持 URL.createObjectURL')
  }
  const url = URL.createObjectURL(svgBlob)

  const width = Math.max(1, Math.round(Number(svg.getAttribute('width')) || 0))
  const height = Math.max(1, Math.round(Number(svg.getAttribute('height')) || 0))

  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = (): void => resolve()
      image.onerror = (): void => reject(new Error('PNG 导出失败：SVG 转位图时图片加载出错'))
      image.src = url
    })

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('PNG 导出失败：无法获取 canvas 2D 上下文')
    // 1:1 绘制：SVG 已经按 scale 放大过，这里不能再缩放，否则二次采样变糊
    ctx.drawImage(image, 0, 0, width, height)

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((result) => resolve(result), 'image/png')
    })
    if (!blob) throw new Error('PNG 导出失败：canvas.toBlob 返回空（画布可能被跨域图片污染）')
    return blob
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * 触发浏览器下载。
 * @param blob 待下载内容
 * @param filename 文件名（含扩展名）
 */
export function downloadBlob(blob: Blob, filename: string): void {
  if (typeof document === 'undefined') {
    throw new Error('下载失败：当前环境没有 document')
  }
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  // 立刻 revoke 在部分浏览器会取消下载，延后一拍
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
