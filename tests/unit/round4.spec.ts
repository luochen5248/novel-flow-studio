/**
 * round4.spec.ts —— F-1 高度刷新守护 + F-2 撤销重做往返守护
 *
 * 背景（Max-A 修复后补的守护，均为**既有正确行为**的回归守护，不是修缺陷）：
 *
 * 【F-1】原缺陷：pinned 节点被 `layoutTimeline` 整体豁免，其 h 也一并冻结在打标那一刻。
 *   用户接着在检查器里把标题改长，卡片/导出图仍按旧 h 裁剪 ⇒ **文字被截断**。
 *   Max-A 的修法（两处配合）：
 *     a) `src/core/layout.ts` 新增导出 `reflowHeights(graph)`：对**所有**节点执行 `n.h = fitNodeHeight(n)`；
 *        并在 `layoutTimeline` 中放在 auto 筛选**之前**（放之后的话，全 pinned / 全 character 时
 *        `auto.length === 0` 提前 return，高度仍会漏 —— 而那恰是最需要修的场景）。
 *     b) `src/stores/useFlowStore.ts` 的 `updateNode` 按需重算：只重算**被改的那一个**节点（O(1)），
 *        且用 `HEIGHT_KEYS` 白名单提前跳过 —— 拖拽期每帧 `{x, y}` 更新不触发任何计算。
 *
 *   ⇒ 语义是「pinned 只冻结坐标（x/y/order），不冻结高度（h）」。
 *
 * 【F-1 用例构成 · 共 6 条】4 条原有 + 2 条 Max-A 合并补充（原 __tmp_h.spec.ts 探针②③）：
 *   原有 4 条只覆盖 HEIGHT_KEYS 里的 'title' 项，且全走 updateNode / reflowHeights 路径；
 *   后 2 条补住两个盲区 —— 白名单的 'summary' 项、以及 addCharacter 那条不走 updateNode 的旁路。
 *
 * 【F-2】Ray 曾报「撤销重做后 pinned 丢失」，team-lead 核实 `history.undo()` 后判定为 **Invalid、不修**：
 *   undo() 弹出 past 快照的同时，会把**当前实时状态**（内存里 pinned 已是 true）深拷贝压进 future 栈，
 *   所以 pinned 进的是 future 而非 past；redo 取出时携带完整 `pinned=true`。
 *   本文件用一条往返用例把这个既有正确行为**锁住**，防止后人误"修"这个非缺陷。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { useFlowStore } from '@/stores/useFlowStore'
import { useUiStore } from '@/stores/useUiStore'
import { useNodeDrag } from '@/composables/useNodeDrag'
import { layoutTimeline, reflowHeights, fitNodeHeight } from '@/core/layout'

const viewportStub: any = {
  screenDeltaToSvg: (dx: number, dy: number) => ({ dx, dy })
}

function fakePointer(x: number, y: number, button = 0): any {
  return { button, clientX: x, clientY: y, stopPropagation: () => {} }
}

function dragTo(dragApi: any, node: any, toX: number, toY: number): void {
  dragApi.start(fakePointer(0, 0), node)
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: toX, clientY: toY }))
  window.dispatchEvent(new MouseEvent('pointerup'))
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  // ⚠️ 必须清历史：`src/core/history.ts` 的 `history` 是**模块级单例**，
  // pinia 重建不会重置它。不清的话上一个用例的 graph 快照会残留，
  // 导致 undo 取回「另一张图」的快照 —— 表现为节点 find 不到（实测报过这个错）。
  useFlowStore().resetHistory()
})

describe('F-1 · pinned 节点高度刷新（pinned 冻结坐标、不冻结高度）', () => {
  it('核心：pinned 节点改长标题后 h 变大，但 x/y/order 不变', () => {
    const store = useFlowStore()
    const ui = useUiStore()
    ui.snapEnabled = false
    store.createGraph('F-1 核心')
    const n = store.addNode({ title: '短标题', lane: 0 })!
    const g = store.activeGraph!
    const before = { x: n.x, y: n.y, order: n.order, h: n.h }

    // 先打 pinned 标记（拖拽即 finish(true) 打标，这里直接模拟标记后的编辑）
    store.updateNode(n.id, { pinned: true }, { silent: true })
    const pinnedBefore = { x: n.x, y: n.y, order: n.order, h: n.h }

    // 改长标题：这才该触发高度重算
    store.updateNode(n.id, { title: '这是一个非常非常非常长的标题足以让卡片从一行撑到两行显示' })

    const after = g.nodes.find((x) => x.id === n.id)!
    // 坐标与 order 一律不动（pinned 的语义）
    expect(after.x).toBe(pinnedBefore.x)
    expect(after.y).toBe(pinnedBefore.y)
    expect(after.order).toBe(pinnedBefore.order)
    // 高度必须跟着内容涨 —— 这正是原缺陷（曾冻结在打标那一刻）
    expect(after.h).toBeGreaterThan(before.h)
    // 且与 fitNodeHeight 的权威计算一致（不是"变大"而已，是"变对"）
    expect(after.h).toBe(fitNodeHeight(after))
  })

  it('反向对照：只改坐标（拖拽路径）不触发高度重算 —— 性能不被后人改坏', () => {
    const store = useFlowStore()
    const ui = useUiStore()
    ui.snapEnabled = false
    store.createGraph('F-1 反向')
    const n = store.addNode({ title: '短标题', lane: 0 })!
    const g = store.activeGraph!

    // 拖拽前记录起点（注意 n 就是 g.nodes 里的同一对象引用，拖拽会就地改它，
    // 所以必须提前取快照，不能拖完再拿 n.x 当"起点"比）
    const origin = { x: n.x, y: n.y }

    // 先把该节点高度置为「脏值」（与权威计算不一致），这样一旦被重算就能观察到
    const staleH = 999
    g.nodes.find((x) => x.id === n.id)!.h = staleH

    // 拖拽路径：每帧都是 silent 的 {x, y} 更新
    const dragApi = useNodeDrag(ref(null) as any, viewportStub)
    dragTo(dragApi, n, 64, 128)

    const after = g.nodes.find((x) => x.id === n.id)!
    // 高度应保持脏值不变 —— 证明拖拽路径没有触发任何高度计算
    expect(after.h).toBe(staleH)
    // 而坐标确实被拖拽改写了（确认这条路径真的走了 updateNode，不是没生效）
    expect(after.x).toBe(origin.x + 64)
    expect(after.y).toBe(origin.y + 128)
  })

  it('reflowHeights：对所有节点（含 character / pinned）按内容更新高度', () => {
    const store = useFlowStore()
    const ui = useUiStore()
    ui.snapEnabled = false
    store.createGraph('F-1 reflow')
    const plain = store.addNode({ title: '普通事件', lane: 0 })!
    const pinned = store.addNode({ title: '被钉住', lane: 0 })!
    const card = store.addNode({ title: '阿离', kind: 'character', lane: 100 })!
    const g = store.activeGraph!

    // 把三个节点的高度全部置脏
    for (const n of g.nodes) n.h = 999
    expect(g.nodes.every((n) => n.h === 999)).toBe(true)

    reflowHeights(g)

    // 三类节点全部被刷新，无一漏掉
    for (const n of g.nodes) {
      expect(n.h).not.toBe(999)
      expect(n.h).toBe(fitNodeHeight(n))
    }
    // 显式确认三种身份都覆盖到
    expect(g.nodes.find((n) => n.id === plain.id)!.h).toBe(fitNodeHeight(plain))
    expect(g.nodes.find((n) => n.id === pinned.id)!.h).toBe(fitNodeHeight(pinned))
    expect(g.nodes.find((n) => n.id === card.id)!.h).toBe(fitNodeHeight(card))
  })

  it('reflowHeights 放在 auto 筛选之前：全 pinned 图也不漏高度（原缺陷的极端场景）', () => {
    const store = useFlowStore()
    const ui = useUiStore()
    ui.snapEnabled = false
    store.createGraph('F-1 全pinned')
    const a = store.addNode({ title: '甲', lane: 0 })!
    const b = store.addNode({ title: '乙', lane: 0 })!
    const g = store.activeGraph!

    // 两个节点全部 pinned ⇒ auto 为空。若 reflowHeights 放在 auto 筛选之后，
    // `if (!auto.length) return graph` 会提前返回，高度永远刷新不到。
    store.updateNode(a.id, { pinned: true }, { silent: true })
    store.updateNode(b.id, { pinned: true }, { silent: true })

    for (const n of g.nodes) n.h = 999
    // 同时改长标题，让「应该变高」这件事可观察
    store.updateNode(a.id, { title: '甲被改成了一个特别特别特别长的标题撑到两行' }, { silent: true })
    // 注意：上面这行 updateNode 的 affectsHeight 命中 title，会顺手把 a 顶高，
    // 所以这里再统一置脏，专门考察 layoutTimeline 自身的 reflow 是否漏 pinned。
    for (const n of g.nodes) n.h = 999

    layoutTimeline(g)

    for (const n of g.nodes) {
      expect(n.h).not.toBe(999)
      expect(n.h).toBe(fitNodeHeight(n))
    }
  })

  // ==================== 以下 2 条为 Max-A 合并补充（原 __tmp_h.spec.ts 探针②③） ====================
  // 前 4 条只覆盖了 HEIGHT_KEYS 里的 'title' 一项，且全走 updateNode / reflowHeights 路径，
  // 下面两条分别守住「白名单其余字段」与「不走 updateNode 的旁路」这两个盲区。

  it('白名单守护：pinned 节点改长摘要后 h 变大，x/y/order 不变', () => {
    const store = useFlowStore()
    const ui = useUiStore()
    ui.snapEnabled = false
    store.createGraph('F-1 白名单 summary')
    const n = store.addNode({ title: '短标题', lane: 0 })!
    const g = store.activeGraph!

    store.updateNode(n.id, { pinned: true }, { silent: true })
    const pinnedBefore = { x: n.x, y: n.y, order: n.order, h: n.h }

    // 走 summary 而非 title —— 对应 `useFlowStore.ts` 的
    // `HEIGHT_KEYS = ['title', 'summary', 'characters', 'location', 'w']`（L36）里的 'summary' 项。
    // 前 4 条只覆盖 title：若后人误删/拼错 summary 这一项，原用例全绿而真实缺陷已发生
    // （用户改长摘要后卡片文字被截断，round4 却测不出来）。
    store.updateNode(n.id, { summary: '这是一段特别长的摘要'.repeat(8) })

    const after = g.nodes.find((x) => x.id === n.id)!
    expect(after.x).toBe(pinnedBefore.x)
    expect(after.y).toBe(pinnedBefore.y)
    expect(after.order).toBe(pinnedBefore.order)
    expect(after.h).toBeGreaterThan(pinnedBefore.h)
    // 与权威计算一致（"变大"且"变对"）
    expect(after.h).toBe(fitNodeHeight(after))
  })

  it('旁路守护：addCharacter 首位人物会把 h 顶起（绕过 updateNode 的唯一路径）', () => {
    const store = useFlowStore()
    const ui = useUiStore()
    ui.snapEnabled = false
    store.createGraph('F-1 addCharacter 旁路')
    const n = store.addNode({ title: '短标题', lane: 0 })!
    const g = store.activeGraph!
    const h0 = g.nodes.find((x) => x.id === n.id)!.h

    // addCharacter（`useFlowStore.ts` L458）直接改 `node.characters`，
    // **完全绕过 updateNode** —— 高度靠 L468 手动 `node.h = fitNodeHeight(node)` 顶起。
    // 这是全仓唯一一条不走 updateNode / reflowHeights 的高度刷新路径。
    // 语义：首位人物让 fitNodeHeight 的 metaLine 从 0 翻到 1 ⇒ h +20。
    store.addCharacter(n.id, '阿离')

    const after = g.nodes.find((x) => x.id === n.id)!
    expect(after.characters).toContain('阿离')
    expect(after.h).toBeGreaterThan(h0)
    expect(after.h).toBe(fitNodeHeight(after))
  })
})

describe('F-2 · 撤销/重做往返后 pinned 与坐标不丢失（既有正确行为的守护）', () => {
  it('拖动 → 撤销 → 重做：pinned 与坐标往返一致（redo === drag）', () => {
    const store = useFlowStore()
    const ui = useUiStore()
    ui.snapEnabled = false
    store.createGraph('F-2 往返')
    const n = store.addNode({ title: 'N1', lane: 0 })!
    const g = store.activeGraph!
    const origin = { x: n.x, y: n.y, order: n.order, h: n.h, pinned: n.pinned }

    // 1) 拖动：finish(true) 打 pinned 标记 + 移动坐标
    //    注意：n 与 g.nodes 内是同一对象引用，拖拽就地修改，故提前取快照
    const dragApi = useNodeDrag(ref(null) as any, viewportStub)
    dragTo(dragApi, n, 80, 120)
    const dragged = g.nodes.find((x) => x.id === n.id)!
    const afterDrag = { x: dragged.x, y: dragged.y, order: dragged.order, pinned: dragged.pinned }
    expect(afterDrag.pinned).toBe(true)
    expect(afterDrag.x).toBe(origin.x + 80)
    expect(afterDrag.y).toBe(origin.y + 120)

    // 2) 撤销：应回到拖动前（pinned 消失、坐标还原）
    //    注意不假设「一步 undo 就是拖动态」——历史栈里还有 createGraph / addNode 的 commit，
    //    这里只验「undo 后不再是拖动态」这个可观察事实。
    store.undo()
    const undone = store.activeGraph!.nodes.find((x) => x.id === n.id)
    if (undone) {
      // 若节点仍在图中，则必须已退回拖动前（pinned 消失、坐标还原）
      expect(undone.pinned).toBeFalsy()
      expect(undone.x).toBe(origin.x)
      expect(undone.y).toBe(origin.y)
    } else {
      // 若退到了 addNode 之前（节点尚未创建），同样是合法的 undo 结果
      expect(store.canUndo).toBe(true)
    }

    // 3) 重做：必须完整恢复拖动态 —— 这正是 team-lead 核实过的既有正确行为
    //    （undo() 把实时状态压进 future，故 pinned 经 future 携带回来）
    store.redo()
    const redone = store.activeGraph!.nodes.find((x) => x.id === n.id)!
    expect(redone.pinned).toBe(true)
    expect(redone.x).toBe(afterDrag.x)
    expect(redone.y).toBe(afterDrag.y)
    expect(redone.order).toBe(afterDrag.order)
    // 完整往返等价：redo 结果与 drag 结果逐字段相等
    expect({ x: redone.x, y: redone.y, order: redone.order, pinned: redone.pinned }).toEqual(afterDrag)
  })

  it('边界：一路 undo 到底不崩溃，再一路 redo 回顶 pinned 仍完整', () => {
    const store = useFlowStore()
    const ui = useUiStore()
    ui.snapEnabled = false
    store.createGraph('F-2 边界')
    const n = store.addNode({ title: 'N1', lane: 0 })!
    const dragApi = useNodeDrag(ref(null) as any, viewportStub)
    dragTo(dragApi, n, 80, 120)
    const afterDrag = { x: n.x, y: n.y, order: n.order, pinned: n.pinned }
    expect(afterDrag.pinned).toBe(true)

    // 注意：历史栈里除了「拖动」，还有 createGraph / addNode 各自的 commit 快照，
    // 所以 undo 链比直觉长 —— 一路点到 canUndo 为 false 才是真正的栈底。
    // 这里只验证「一路 undo 不抛错」，不假设深度。
    let guard = 0
    while (store.canUndo && guard++ < 50) {
      expect(() => store.undo()).not.toThrow()
    }
    expect(store.canUndo).toBe(false)

    // 栈底继续 undo（真空栈）：不应抛错，也不应改变状态
    const bottomGraph = store.activeGraph!
    const bottomIds = bottomGraph.nodes.map((x) => x.id).join(',')
    expect(() => store.undo()).not.toThrow()
    expect(store.activeGraph!.nodes.map((x) => x.id).join(',')).toBe(bottomIds)

    // 注意：undo 会把状态压进 future，所以 undo 到底后 canRedo 为 true（可重做全部），
    // 此时 redo **不是**空栈。真正的空栈 redo 要先一路 redo 回顶。
    let redoGuard = 0
    while (store.canRedo && redoGuard++ < 50) {
      expect(() => store.redo()).not.toThrow()
    }
    expect(store.canRedo).toBe(false)

    const top = store.activeGraph!.nodes.find((x) => x.id === n.id)
    // 节点必然已回到图中（redo 把 addNode 也重做了）
    expect(top).toBeDefined()
    expect({ x: top!.x, y: top!.y, order: top!.order, pinned: top!.pinned }).toEqual(afterDrag)

    // 真空栈 redo：不应抛错且不改变状态
    const topIds = store.activeGraph!.nodes.map((x) => x.id).join(',')
    expect(() => store.redo()).not.toThrow()
    expect(store.activeGraph!.nodes.map((x) => x.id).join(',')).toBe(topIds)
    const stillTop = store.activeGraph!.nodes.find((x) => x.id === n.id)!
    expect({ x: stillTop.x, y: stillTop.y, order: stillTop.order, pinned: stillTop.pinned }).toEqual(afterDrag)
  })
})
