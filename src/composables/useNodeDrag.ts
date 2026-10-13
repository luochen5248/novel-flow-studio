import { ref, type Ref } from 'vue'
import type { StoryNode } from '@/types/graph'
import { useFlowStore } from '@/stores/useFlowStore'
import { useUiStore } from '@/stores/useUiStore'
import type { ViewportApi } from './useViewport'

const GRID = 8
const GUIDE_TOLERANCE = 7

export interface Guides {
  v: number[]
  h: number[]
}

export interface NodeDragApi {
  draggingId: Ref<string | null>
  guides: Ref<Guides>
  start(e: PointerEvent, node: StoryNode): void
  cancel(): void
}

/**
 * 节点拖拽。
 * - 屏幕位移经 viewport 逆变换回 SVG 坐标（缩放状态下也不会「越拖越快」）
 * - **自由拖拽**：x / y 都可任意摆放，松手就停在用户放下的位置，不回弹。
 *   timeline 模式下松手只按落地 y 重写本 lane 的 order（数据语义），不再调 relayout 重算坐标；
 *   想一键归位点工具栏「整理」。
 * - 带 8px 网格吸附 + 智能参考线（对齐同列 x / 相邻 y），两种布局模式都生效
 * - 拖拽期间用 silent 更新，历史只在按下时压一条，不会产生几十条记录
 */
export function useNodeDrag(
  _svgRef: Ref<SVGSVGElement | null>,
  viewport: ViewportApi
): NodeDragApi {
  const store = useFlowStore()
  const ui = useUiStore()
  const draggingId = ref<string | null>(null)
  const guides = ref<Guides>({ v: [], h: [] })

  let originX = 0
  let originY = 0
  let startPositions = new Map<string, { x: number; y: number }>()
  let movingIds: string[] = []
  let timelineMode = false
  /** 只有真正移动过才压历史，避免「点一下」产生一条空记录 */
  let committed = false

  /**
   * 摘掉全部窗口监听并复位拖拽态。
   *
   * 三条退出路径（onUp→finish(true)、onEsc→finish(false)、cancel()）都经过这里，
   * 所以「恢复持久化 + 补一次落盘」（G3）放在此处统一管理，任何一条退出都不会漏。
   */
  function cleanup(): void {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('keydown', onEsc, true)
    // 拖拽结束：恢复持久化并立即落盘一次（finish 里的 silent 更新发生在下一行之前，
    // 仍被暂停覆盖，不会每帧都排一次防抖保存）
    store.resumePersist()
  }

  function onEsc(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return
    for (const [id, pos] of startPositions) {
      store.updateNode(id, { x: pos.x, y: pos.y }, { silent: true })
    }
    // 取消拖拽：回到原位，不该留下 pinned 标记
    finish(false)
  }

  /**
   * @param pin 是否把本次拖动的节点标记为「手动摆放」。
   *   true = 松手生效（拖到哪停在哪，后续任何 layoutTimeline 都不许吸回去）；
   *   false = Esc 取消，坐标已还原，无需打标。
   */
  function finish(pin: boolean): void {
    const g = store.activeGraph
    if (g && committed && pin) {
      // 标记为手动摆放：布局从此不再改写这些节点的 x/y/order
      for (const id of movingIds) {
        store.updateNode(id, { pinned: true }, { silent: true })
      }
    }
    if (g && timelineMode && draggingId.value && committed) {
      // 只重写 order（数据语义），**不调用 relayout** ——
      // 松手后坐标就停在用户放下的位置，「拖到哪停在哪」。
      // 需要一键归位时点工具栏「整理」，那时才重算坐标。
      for (const lane of new Set(g.nodes.filter((n) => movingIds.includes(n.id)).map((n) => n.lane))) {
        const list = g.nodes.filter((n) => n.lane === lane).sort((a, b) => a.y - b.y)
        list.forEach((n, i) => {
          n.order = i
        })
      }
    }
    draggingId.value = null
    guides.value = { v: [], h: [] }
    startPositions = new Map()
    movingIds = []
    committed = false
    cleanup()
  }

  function onMove(e: PointerEvent): void {
    const g = store.activeGraph
    const id = draggingId.value
    if (!g || !id) return
    const raw = viewport.screenDeltaToSvg(e.clientX - originX, e.clientY - originY)
    if (!committed && Math.abs(raw.dx) + Math.abs(raw.dy) < 2) return
    if (!committed) {
      committed = true
      store.commit('移动节点')
    }
    const d = raw
    const base = startPositions.get(id)
    if (!base) return

    let nx = base.x + d.dx
    let ny = base.y + d.dy

    if (ui.snapEnabled) {
      nx = Math.round(nx / GRID) * GRID
      ny = Math.round(ny / GRID) * GRID
    }

    // 智能参考线：与「未参与拖动」的节点对齐（timeline / free 两种模式都生效）
    const gv: number[] = []
    const gh: number[] = []
    {
      const others = g.nodes.filter((n) => !movingIds.includes(n.id))
      const node = g.nodes.find((n) => n.id === id)
      const w = node?.w ?? 0
      const h = node?.h ?? 0
      for (const o of others) {
        for (const ox of [o.x, o.x + o.w / 2, o.x + o.w]) {
          if (Math.abs(nx - ox) <= GUIDE_TOLERANCE) {
            nx = ox
            gv.push(ox)
          } else if (Math.abs(nx + w - ox) <= GUIDE_TOLERANCE) {
            nx = ox - w
            gv.push(ox)
          } else if (Math.abs(nx + w / 2 - ox) <= GUIDE_TOLERANCE) {
            nx = ox - w / 2
            gv.push(ox)
          }
        }
        for (const oy of [o.y, o.y + o.h / 2, o.y + o.h]) {
          if (Math.abs(ny - oy) <= GUIDE_TOLERANCE) {
            ny = oy
            gh.push(oy)
          } else if (Math.abs(ny + h - oy) <= GUIDE_TOLERANCE) {
            ny = oy - h
            gh.push(oy)
          } else if (Math.abs(ny + h / 2 - oy) <= GUIDE_TOLERANCE) {
            ny = oy - h / 2
            gh.push(oy)
          }
        }
      }
    }
    guides.value = { v: [...new Set(gv)].slice(0, 3), h: [...new Set(gh)].slice(0, 3) }

    const dx = nx - base.x
    const dy = ny - base.y
    for (const [mid, pos] of startPositions) {
      // x / y 都自由移动：timeline 模式下也不再锁 x，用户可以真正随意摆放
      store.updateNode(mid, { x: pos.x + dx, y: pos.y + dy }, { silent: true })
    }
  }

  function onUp(): void {
    finish(true)
  }

  function start(e: PointerEvent, node: StoryNode): void {
    const g = store.activeGraph
    if (!g || ui.locked) return
    if (e.button !== 0) return
    e.stopPropagation()

    timelineMode = g.settings.layoutMode === 'timeline'
    const ids = store.selectedIds.includes(node.id) && store.selectedIds.length > 1
      ? [...store.selectedIds]
      : [node.id]
    movingIds = ids
    startPositions = new Map()
    for (const id of ids) {
      const n = g.nodes.find((x) => x.id === id)
      if (n) startPositions.set(id, { x: n.x, y: n.y })
    }
    originX = e.clientX
    originY = e.clientY
    draggingId.value = node.id
    committed = false
    // G3 / 性能快赢 2：拖拽期间暂停持久化，松手 / Esc / cancel 时由 cleanup 补一次落盘
    store.pausePersist()

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onEsc, true)
  }

  function cancel(): void {
    cleanup()
    draggingId.value = null
    guides.value = { v: [], h: [] }
  }

  return { draggingId, guides, start, cancel }
}
