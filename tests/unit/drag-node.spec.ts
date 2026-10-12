/**
 * drag-node.spec.ts ——拖拽「弹回」回归测试
 *
 * 原 bug：useNodeDrag.finish() 在 timeline 模式松手时调 store.relayout()，
 * 而 relayout → layoutTimeline() 会重写所有节点 x/y，导致「拖到哪被拉回哪」。
 *
 * ✅ 现已修复，且采用**pinned 语义**：finish(true) 给拖过的节点打 pinned 标记，
 *   layoutTimeline 通过 isLayoutExempt() 把 pinned 节点（及 character 卡片）
 *   从布局集合中整个剔除 —— 不进 byLane、不占 order、不参与间距扫描、不改 h。
 *   于是「拖到哪停在哪」不仅在松手瞬间成立，之后任何 relayout（点「整理」、增删节点）也吸不回去。
 *
 * 说明：本文件用 Pinia + jsdom 指针事件驱动真实 composable，断言「可观察行为」
 * （拖完节点停在拖到位置），与 Max-C 的具体实现无关。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { useFlowStore } from '@/stores/useFlowStore'
import { useUiStore } from '@/stores/useUiStore'
import { useNodeDrag } from '@/composables/useNodeDrag'
import { layoutTimeline } from '@/core/layout'
import { deepClone } from '@/core/model'

/** 1:1 无缩放的 viewport stub（把屏幕位移当作 SVG 位移） */
const viewportStub: any = {
  screenDeltaToSvg: (dx: number, dy: number) => ({ dx, dy })
}

/** 构造一个最小 PointerEvent 替身（只需 button/clientX/clientY/stopPropagation） */
function fakePointer(x: number, y: number, button = 0): any {
  return { button, clientX: x, clientY: y, stopPropagation: () => {} }
}

/** 执行一次完整拖拽：按下 → 移动到 (toX,toY) → 松手 */
function dragTo(dragApi: any, node: any, toX: number, toY: number): void {
  dragApi.start(fakePointer(0, 0), node)
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: toX, clientY: toY }))
  window.dispatchEvent(new MouseEvent('pointerup'))
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('拖拽回归 · 松手不弹回（useNodeDrag）', () => {
  // 注：layoutTimeline 自身的重排正确性由 layout.spec.ts 守护（y 严格递增、间距 ≥ rowGap 等），
  // 本文件只聚焦「拖拽是否会被布局改回去」，不再重复断言布局基础行为。

  it('回归：timeline 模式拖拽后坐标停在拖到位置（不被 relayout 弹回）', () => {
    const store = useFlowStore()
    const ui = useUiStore()
    ui.snapEnabled = false
    store.createGraph('拖拽回归')
    const n1 = store.addNode({ title: 'N1', lane: 0 })!
    const g = store.activeGraph!
    const before = { x: n1.x, y: n1.y }

    const dragApi = useNodeDrag(ref(null) as any, viewportStub)
    dragTo(dragApi, n1, 80, 120)

    const after = g.nodes.find((n) => n.id === n1.id)!
    // 关键断言：拖到哪停在哪
    expect(after.x).toBe(before.x + 80)
    expect(after.y).toBe(before.y + 120)
  })

  it('回归：拖过的节点被打 pinned，后续 layoutTimeline 不再改写它', () => {
    const store = useFlowStore()
    const ui = useUiStore()
    ui.snapEnabled = false
    store.createGraph('拖拽回归2')
    const n1 = store.addNode({ title: 'N1', lane: 0 })!
    const g = store.activeGraph!

    const dragApi = useNodeDrag(ref(null) as any, viewportStub)
    dragTo(dragApi, n1, 80, 120)

    const after = g.nodes.find((n) => n.id === n1.id)!
    // 松手时 finish(true) 给拖过的节点打「手动摆放」标记
    expect(after.pinned).toBe(true)

    // 核心保证：即使之后有人调 relayout()（点工具栏「整理」、增删节点等），
    // 这个被拖过的节点也不会被 layoutTimeline 吸回去。
    // 注意：这里**不能**再断言「坐标 ≠ layout 结果」——因为 pinned 豁免后，
    // 克隆重排的结果本就应与拖后坐标一致（旧写法在 pinned 语义下必然失败）。
    const clone = deepClone(g)
    layoutTimeline(clone)
    const laidOut = clone.nodes.find((n) => n.id === n1.id)!
    expect(laidOut.x).toBe(after.x)
    expect(laidOut.y).toBe(after.y)
    // 且重排后仍带 pinned 标记（豁免是持久的）
    expect(laidOut.pinned).toBe(true)
  })

  it('对照：pinned 豁免不误伤 —— 未拖过的节点仍被 layoutTimeline 正常重排', () => {
    const store = useFlowStore()
    const ui = useUiStore()
    ui.snapEnabled = false
    store.createGraph('豁免对照')
    const dragged = store.addNode({ title: '被拖', lane: 0 })!
    const untouched = store.addNode({ title: '没被拖', lane: 0 })!
    const g = store.activeGraph!

    const dragApi = useNodeDrag(ref(null) as any, viewportStub)
    dragTo(dragApi, dragged, 80, 120)

    // 制造一个「被打乱」的坐标，验证 layout 仍会收拾没 pinned 的那个
    untouched.x = -9999
    untouched.y = -9999
    const untouchedBefore = { x: untouched.x, y: untouched.y }

    const clone = deepClone(g)
    layoutTimeline(clone)
    const fixed = clone.nodes.find((n) => n.id === untouched.id)!

    // 未拖节点被重排回布局位（不再是 -9999），证明 layout 没被整体瘫痪
    expect(fixed.x).not.toBe(untouchedBefore.x)
    expect(fixed.y).not.toBe(untouchedBefore.y)
    expect(fixed.pinned).not.toBe(true)
  })

  it('回归：timeline 模式下 x 轴也可自由移动（原先被锁死）', () => {
    const store = useFlowStore()
    const ui = useUiStore()
    ui.snapEnabled = false
    store.createGraph('拖拽回归3')
    const n1 = store.addNode({ title: 'N1', lane: 0 })!
    const g = store.activeGraph!
    const before = { x: n1.x }

    const dragApi = useNodeDrag(ref(null) as any, viewportStub)
    dragTo(dragApi, n1, 96, 0) // 纯水平拖拽

    const after = g.nodes.find((n) => n.id === n1.id)!
    expect(after.x).toBe(before.x + 96)
  })
})
