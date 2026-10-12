import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { Rect } from '@/types/graph'
import { clamp } from '@/core/model'

export const MIN_ZOOM = 0.2
export const MAX_ZOOM = 3

export interface ViewportApi {
  viewBox: Ref<Rect>
  size: Ref<{ w: number; h: number }>
  zoom: ComputedRef<number>
  scale: ComputedRef<number>
  setSize(w: number, h: number): void
  /** 以某屏幕点为锚缩放（滚轮 / 按钮） */
  zoomAt(factor: number, clientX?: number, clientY?: number): void
  setZoom(z: number, clientX?: number, clientY?: number): void
  panBy(dxScreen: number, dyScreen: number): void
  /** 屏幕位移 → 画布位移 */
  screenDeltaToSvg(dx: number, dy: number): { dx: number; dy: number }
  clientToSvg(clientX: number, clientY: number, el: SVGSVGElement | null): { x: number; y: number }
  fit(rect: Rect | null, padding?: number): void
  center(): void
  reset(): void
}

/**
 * 视口：SVG viewBox + transform 实现缩放平移（不用 CSS transform，
 * 这样导出 / 命中检测都还在同一坐标系里）。
 * 模块级单例 —— 单画布应用，工具栏、小地图共享同一份状态最简单可靠。
 */
let singleton: ViewportApi | null = null

export function useViewport(): ViewportApi {
  if (singleton) return singleton

  const viewBox = ref<Rect>({ x: -600, y: -120, w: 1400, h: 900 })
  const size = ref({ w: 1400, h: 900 })
  const zoom = ref(1)

  /** 基础视口尺寸（zoom = 1 时 viewBox 的宽高 = 容器像素尺寸） */
  const base = computed(() => ({
    w: size.value.w || 1400,
    h: size.value.h || 900
  }))

  const scale = computed(() => base.value.w / (viewBox.value.w || 1))

  /** 容器尺寸变化：保持 zoom 不变，只把可视范围按新尺寸重算（中心不动） */
  function setSize(w: number, h: number): void {
    if (!w || !h) return
    const prev = viewBox.value
    size.value = { w, h }
    const nw = w / zoom.value
    const nh = h / zoom.value
    viewBox.value = {
      x: prev.x + (prev.w - nw) / 2,
      y: prev.y + (prev.h - nh) / 2,
      w: nw,
      h: nh
    }
  }

  function applyZoom(next: number, clientX?: number, clientY?: number): void {
    const z = clamp(next, MIN_ZOOM, MAX_ZOOM)
    const cx = clientX ?? size.value.w / 2
    const cy = clientY ?? size.value.h / 2
    const ratio = base.value.w / viewBox.value.w
    // 锚点在画布中的坐标
    const ax = viewBox.value.x + cx / ratio
    const ay = viewBox.value.y + cy / (base.value.h / viewBox.value.h || 1)
    const nextW = base.value.w / z
    const nextH = base.value.h / z
    viewBox.value = {
      x: ax - (cx / base.value.w) * nextW,
      y: ay - (cy / base.value.h) * nextH,
      w: nextW,
      h: nextH
    }
    zoom.value = z
  }

  function zoomAt(factor: number, clientX?: number, clientY?: number): void {
    applyZoom(zoom.value * factor, clientX, clientY)
  }

  function setZoom(z: number, clientX?: number, clientY?: number): void {
    applyZoom(z, clientX, clientY)
  }

  function panBy(dxScreen: number, dyScreen: number): void {
    const ratioX = viewBox.value.w / base.value.w
    const ratioY = viewBox.value.h / base.value.h
    viewBox.value = {
      ...viewBox.value,
      x: viewBox.value.x - dxScreen * ratioX,
      y: viewBox.value.y - dyScreen * ratioY
    }
  }

  function screenDeltaToSvg(dx: number, dy: number): { dx: number; dy: number } {
    return {
      dx: (dx * viewBox.value.w) / base.value.w,
      dy: (dy * viewBox.value.h) / base.value.h
    }
  }

  function clientToSvg(
    clientX: number,
    clientY: number,
    el: SVGSVGElement | null
  ): { x: number; y: number } {
    if (!el) return { x: 0, y: 0 }
    const r = el.getBoundingClientRect()
    const ratioX = viewBox.value.w / (r.width || base.value.w)
    const ratioY = viewBox.value.h / (r.height || base.value.h)
    return {
      x: viewBox.value.x + (clientX - r.left) * ratioX,
      y: viewBox.value.y + (clientY - r.top) * ratioY
    }
  }

  function fit(rect: Rect | null, padding = 96): void {
    if (!rect || !rect.w || !rect.h) {
      center()
      return
    }
    const bw = base.value.w
    const bh = base.value.h
    const z = clamp(Math.min(bw / (rect.w + padding * 2), bh / (rect.h + padding * 2)), MIN_ZOOM, MAX_ZOOM)
    const w = bw / z
    const h = bh / z
    viewBox.value = {
      x: rect.x + rect.w / 2 - w / 2,
      y: rect.y + rect.h / 2 - h / 2,
      w,
      h
    }
    zoom.value = z
  }

  function center(): void {
    const w = base.value.w / zoom.value
    const h = base.value.h / zoom.value
    viewBox.value = {
      x: viewBox.value.x + viewBox.value.w / 2 - w / 2,
      y: viewBox.value.y + viewBox.value.h / 2 - h / 2,
      w,
      h
    }
  }

  function reset(): void {
    zoom.value = 1
    viewBox.value = {
      x: -base.value.w / 2,
      y: -140,
      w: base.value.w,
      h: base.value.h
    }
  }

  const api: ViewportApi = {
    viewBox,
    size,
    zoom: computed(() => zoom.value),
    scale,
    setSize,
    zoomAt,
    setZoom,
    panBy,
    screenDeltaToSvg,
    clientToSvg,
    fit,
    center,
    reset
  }
  singleton = api
  return api
}
