import { ref, type Ref } from 'vue'
import type { StoryNode } from '@/types/graph'
import { useFlowStore } from '@/stores/useFlowStore'
import { useUiStore } from '@/stores/useUiStore'
import { isLayoutExempt } from '@/core/layout'
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
 *   timeline 模式下松手只按落地 travel 轴（纵向 y / 横向 x）重写本 lane 的 order
 *   （数据语义），不再调 relayout 重算坐标；
 *   想一键归位点工具栏「整理」。
 * - **人物卡片（character）例外**：不打 pinned、也不参与 order 重写 ——
 *   它由 `isLayoutExempt` 按 kind 永久豁免布局，坐标与位序都归用户管，
 *   不能让拖一张角色牌把整条 lane（乃至主线剧情顺序）洗一遍。
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
    // 取消拖拽：回到原位，不该留下 pinned 标记，也不该重写 order ——
    // finish 的重写块带 `&& pin`，这里的 false 会让它整块跳过。
    // （正常数据下重写一遍是 no-op，但 order 与 y 本就不一致的脏数据上，
    //  取消会静默把剧情顺序洗成 y 序，等于「没动过的操作改了数据」）
    finish(false)
  }

  /**
   * @param pin 是否把本次拖动的节点标记为「手动摆放」。
   *   true = 松手生效（拖到哪停在哪，后续任何 layoutTimeline 都不许吸回去），
   *     并按落地 travel 轴重写本 lane 的 order；
   *   false = Esc 取消，坐标已还原，无需打标，且**不写 order** ——
   *     取消的拖动不该改写数据（脏数据上 order 与 y 本就不一致，写一遍就是静默改剧情顺序）。
   */
  function finish(pin: boolean): void {
    const g = store.activeGraph
    // 两个块口径不同：
    //  - order 重写按 kind 认「时间线节点」（见下），pinned 照样参与重编号；
    //    且只在 `pin === true`（松手生效）时执行，取消路径整块跳过；
    //  - 打 pin 仍复用 `isLayoutExempt` 认布局豁免，character 不打、pinned 不重复打。
    // 保留「先重写后打 pin」的顺序，符合「松手即按视觉位置定格」的语义。
    if (g && timelineMode && draggingId.value && committed && pin) {
      // 只重写 order（数据语义），**不调用 relayout** ——
      // 松手后坐标就停在用户放下的位置，「拖到哪停在哪」。
      // 需要一键归位时点工具栏「整理」，那时才重算坐标。
      // 行进轴与 layout.ts / TimeRail.vue 同源：横向模式 travel 轴是 x，纵向是 y。
      const horizontal = g.settings.direction === 'horizontal'
      //
      // 位序重写的参与者是「时间线节点」而非「布局豁免节点」——两者差一个 pinned：
      //  - pinned 是时间线节点：用户只是手动摆过它，位序必须跟着视觉位置走。
      //    若把它排除在重编号之外，它保留的旧 order 会与重编号后的普通节点重复
      //    （lane 里 A(pinned, order=0)，拖 B 到 C 下方后 C 也被编成 0）——
      //    重复 order 会让 aiApi afterId 的后继边匹配（t.order === anchor.order + 1）错配。
      //  - character 不是时间线节点：按 kind 永久豁免，连 order 都不参与
      //    （拖一张角色牌不该洗任何 lane 的位序）。
      const lanes = new Set(
        g.nodes
          .filter((n) => movingIds.includes(n.id) && n.kind !== 'character')
          .map((n) => n.lane)
      )
      // 这里不另做 touch：任何真实拖动在 pointermove 阶段就由 `updateNode`
      // 刷新过 updatedAt（`updateNode` 的 touch 不受 silent 影响），
      // 而 order 重写只可能发生在有拖动的路径上 —— 重复 touch 无意义。
      for (const lane of lanes) {
        const list = g.nodes
          .filter((n) => n.lane === lane && n.kind !== 'character')
          .sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y))
        list.forEach((n, i) => {
          n.order = i
        })
      }
    }

    if (g && committed && pin) {
      // 标记为手动摆放：布局从此不再改写这些节点的 x/y/order。
      // 【character 例外】人物卡片由 `isLayoutExempt` 按 kind 永久豁免，pinned 对它
      // 是多余标记；且这张卡日后若被改成 event，残留的 pinned 会让它变成主线上的钉子
      // （而 character 是按 kind 豁免，「整理」清不掉 kind，只能靠 pinned —— 反之亦然）。
      for (const id of movingIds) {
        const n = g.nodes.find((x) => x.id === id)
        if (n && isLayoutExempt(n)) continue
        store.updateNode(id, { pinned: true }, { silent: true })
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
