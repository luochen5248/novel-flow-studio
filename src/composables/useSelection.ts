import { ref, type Ref } from 'vue'
import type { Rect, StoryNode } from '@/types/graph'
import { useFlowStore } from '@/stores/useFlowStore'
import { rectsIntersect } from '@/core/geometry'
import type { ViewportApi } from './useViewport'

export interface SelectionApi {
  /** 框选矩形（SVG 坐标），null 表示当前没在框选 */
  box: Ref<Rect | null>
  selecting: Ref<boolean>
  startMarquee(e: PointerEvent): void
  hitTest(nodes: StoryNode[]): string[]
}

/** 框选 + 多选。空白处按下即开始框选，Shift 保留原选区 */
export function useSelection(
  svgRef: Ref<SVGSVGElement | null>,
  viewport: ViewportApi
): SelectionApi {
  const store = useFlowStore()
  const box = ref<Rect | null>(null)
  const selecting = ref(false)

  let start = { x: 0, y: 0 }
  let additive = false

  function cleanup(): void {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }

  function hitTest(nodes: StoryNode[]): string[] {
    const r = box.value
    if (!r) return []
    return nodes.filter((n) => rectsIntersect({ x: n.x, y: n.y, w: n.w, h: n.h }, r)).map((n) => n.id)
  }

  function onMove(e: PointerEvent): void {
    const p = viewport.clientToSvg(e.clientX, e.clientY, svgRef.value)
    const x = Math.min(start.x, p.x)
    const y = Math.min(start.y, p.y)
    const w = Math.abs(p.x - start.x)
    const h = Math.abs(p.y - start.y)
    box.value = { x, y, w, h }
    const hits = hitTest(store.nodes)
    store.select(additive ? [...new Set([...store.selectedIds, ...hits])] : hits)
  }

  function onUp(): void {
    selecting.value = false
    box.value = null
    cleanup()
  }

  function startMarquee(e: PointerEvent): void {
    if (e.button === 1) return
    const p = viewport.clientToSvg(e.clientX, e.clientY, svgRef.value)
    start = p
    additive = e.shiftKey
    selecting.value = true
    box.value = { x: p.x, y: p.y, w: 0, h: 0 }
    if (!additive) store.clearSelection()
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return { box, selecting, startMarquee, hitTest }
}
