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
import { layoutTimeline, isLayoutExempt } from '@/core/layout'
import { CHARACTER_LANE, CHARACTER_NODE_W } from '@/components/canvas/characterCard'
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

/**
 * A 组 · timeline 松手时的 order 重写与人物卡过滤（useNodeDrag.finish）。
 *
 * Ray 变异实证：finish() 的重排逻辑在原有用例下毫无守护。第一波落码时本组曾同时
 * 承担「order 重写先于打 pin」的时序哨兵职责 —— 但 **M2(b) 之后该时序已不可观测**：
 * 重写块的过滤是 `kind !== 'character'`、**不认 pinned**，被拖节点即便先被打 pin 也
 * 照样参与重编号，两个块谁先谁后在结果上完全等价（时序退化为实现风格，不是契约）。
 * ⇒ A1 的口径已更正为纯终值语义；「重编号参与者 = 时间线节点」这条真正要守的契约，
 *   移交给第二波的 **W1** 看守。
 *
 * 本组现在守的：
 *  - A1 钉终值：拖完后 order 按落地位置重排至末位 + pinned === true；
 *  - A2/A3 钉人物卡过滤：人物卡（kind === 'character'）不被卷入 order 重写、也不被打 pin
 *    （重写块与打 pin 块两处都得认 character）。
 *
 * 断言一律钉**终值语义**（拖完后的 order / pinned / lane），不钉中间过程。
 */
describe('拖拽回归 · timeline order 重写与人物卡豁免（useNodeDrag.finish）', () => {
  /**
   * 期望模型：给定「重写发生时」的节点快照与各节点落地 y，算出 lane 内参与重编号的
   * 节点按落地 y 排序后的全新序号（终值语义，不钉中间过程）。
   * 快照必须在拖拽前取 —— 拖完被拖节点已打 pin，事后用 `isLayoutExempt` 过滤会漏掉它；
   * 而拖拽前无人 pinned，此时 `!isLayoutExempt` 与实现的 `kind !== 'character'` 等价，
   * 正是重写那一刻的参与者口径。
   */
  function expectedOrdersByLandingY(
    snapshot: Array<{ id: string; lane: number }>,
    landingY: Map<string, number>,
    lane: number
  ): Map<string, number> {
    const list = snapshot
      .filter((n) => n.lane === lane && !isLayoutExempt(n as any))
      .map((n) => ({ id: n.id, y: landingY.get(n.id)! }))
      .sort((a, b) => a.y - b.y)
    const m = new Map<string, number>()
    list.forEach((n, i) => m.set(n.id, i))
    return m
  }

  it('A1 首节点拖到最底：order 按落地位置重排至末位 + pinned === true（终值语义）', () => {
    const store = useFlowStore()
    const ui = useUiStore()
    ui.snapEnabled = false
    store.createGraph('A1 order 终值')
    const n1 = store.addNode({ title: '节点一', lane: 0 })!
    const n2 = store.addNode({ title: '节点二', lane: 0 })!
    const n3 = store.addNode({ title: '节点三', lane: 0 })!
    const g = store.activeGraph!

    // 拖拽前快照（重写发生时的豁免状态 + 落地 y 的基准）
    const snapshot = g.nodes.map((n) => ({ ...n }))
    const landingY = new Map(snapshot.map((n) => [n.id, n.y]))

    // 首节点拖到最底：目标 y 远超末节点（避开参考线 7px 吸附容差）
    const bottom = Math.max(n1.y, n2.y, n3.y) + 300
    const dy = bottom - n1.y
    const dragApi = useNodeDrag(ref(null) as any, viewportStub)
    dragTo(dragApi, n1, 0, dy)
    landingY.set(n1.id, landingY.get(n1.id)! + dy)

    const dragged = g.nodes.find((n) => n.id === n1.id)!
    // 松手生效：被拖节点打上「手动摆放」标记
    expect(dragged.pinned).toBe(true)

    // order 终值：lane 0 非 character 节点按落地 y 的全新序号 —— 被拖节点落末位，
    // 其余节点相应前移（n2: 1→0，n3: 2→1）。
    //
    // 口径更正（2026-10-16）：本条只钉终值，**不再声称**防「先打 pin 再重写」——
    // M2(b) 之后重写块按 `kind !== 'character'` 过滤、不认 pinned，被拖节点先打 pin
    // 也照样参与重编号，该时序在行为上不可观测（把两块顺序换过来，本条仍绿）。
    // 时序哨兵的替代者是 W1：它守的是「重编号参与者 = 时间线节点」这条真契约。
    const expected = expectedOrdersByLandingY(snapshot, landingY, 0)
    expect(expected.size).toBe(3)
    for (const [id, order] of expected) {
      expect(g.nodes.find((n) => n.id === id)!.order).toBe(order)
    }
    expect(dragged.order).toBe(2)
    expect(dragged.y).toBeGreaterThan(g.nodes.find((n) => n.id === n3.id)!.y)
  })

  it('A2 lane 100 两张人物卡互拖：order 与 pinned 均不受影响（人物卡过滤哨兵）', () => {
    const store = useFlowStore()
    const ui = useUiStore()
    ui.snapEnabled = false
    store.createGraph('A2 人物卡豁免')
    const cardA = store.addNode({
      kind: 'character',
      title: '甲',
      lane: CHARACTER_LANE,
      w: CHARACTER_NODE_W,
      x: 640,
      y: 0
    })!
    const cardB = store.addNode({
      kind: 'character',
      title: '乙',
      lane: CHARACTER_LANE,
      w: CHARACTER_NODE_W,
      x: 640,
      y: 300
    })!
    const g = store.activeGraph!
    const ordersBefore = [cardA.order, cardB.order]
    const yBeforeB = cardB.y
    expect(ordersBefore).toEqual([0, 1])

    // 第二张拖到第一张上方（-500 远离一切参考线吸附）
    const dragApi = useNodeDrag(ref(null) as any, viewportStub)
    dragTo(dragApi, cardB, 0, -500)

    const afterA = g.nodes.find((n) => n.id === cardA.id)!
    const afterB = g.nodes.find((n) => n.id === cardB.id)!
    // 拖拽确实发生了（防「压根没拖」的伪绿）
    expect(afterB.y).toBeLessThan(yBeforeB)
    // order 不被洗：人物卡不是时间线节点，不参与位序重写。
    // 防的回归：重写块的 `kind !== 'character'` 过滤被删/改窄 ⇒ 两张按落地 y 洗 Swap
    // （A:0→1, B:1→0），此断言红。
    expect([afterA.order, afterB.order]).toEqual(ordersBefore)
    // pinned 也不打：character 按 kind 永久豁免，pinned 是多余标记。
    // 防的回归：打 pin 块的 `isLayoutExempt` 若改窄成只认 pinned（不认 character）
    // ⇒ 两张被打 pin，此断言红。
    expect(afterA.pinned).toBeFalsy()
    expect(afterB.pinned).toBeFalsy()
  })

  it('A3 混合多选（普通节点 + 人物卡）同拖：主线 order 按落地重排、角色牌零污染', () => {
    const store = useFlowStore()
    const ui = useUiStore()
    ui.snapEnabled = false
    store.createGraph('A3 混合多选')
    const n1 = store.addNode({ title: '节点一', lane: 0 })!
    const n2 = store.addNode({ title: '节点二', lane: 0 })!
    const cardA = store.addNode({
      kind: 'character',
      title: '甲',
      lane: CHARACTER_LANE,
      w: CHARACTER_NODE_W,
      x: 640,
      y: 0
    })!
    const cardB = store.addNode({
      kind: 'character',
      title: '乙',
      lane: CHARACTER_LANE,
      w: CHARACTER_NODE_W,
      x: 640,
      y: 300
    })!
    const g = store.activeGraph!
    const cardOrdersBefore = [cardA.order, cardB.order]

    // 拖拽前快照（重写发生时的豁免状态 + 落地 y 的基准）
    const snapshot = g.nodes.map((n) => ({ ...n }))
    const landingY = new Map(snapshot.map((n) => [n.id, n.y]))

    // 多选：普通节点 + 一张人物卡一起拖（harness 经 store.selectedIds 支持多选）
    store.select([n1.id, cardA.id])
    const bottom = Math.max(n2.y, cardB.y) + 400
    const dy = bottom - n1.y
    const dragApi = useNodeDrag(ref(null) as any, viewportStub)
    dragTo(dragApi, n1, 0, dy)
    // 多选整体平移：n1 与 cardA 落点相同
    landingY.set(n1.id, landingY.get(n1.id)! + dy)
    landingY.set(cardA.id, landingY.get(cardA.id)! + dy)

    // 普通节点：pinned + order 按落地 y 重排（n1 落末位、n2 前移）
    const moved = g.nodes.find((n) => n.id === n1.id)!
    expect(moved.pinned).toBe(true)
    const expected = expectedOrdersByLandingY(snapshot, landingY, 0)
    expect(expected.size).toBe(2)
    for (const [id, order] of expected) {
      expect(g.nodes.find((n) => n.id === id)!.order).toBe(order)
    }
    expect(moved.order).toBe(1)

    // 人物卡：order / pinned 均不动 —— 多选混入角色牌时，既不重排主线、也不给角色牌打 pin。
    // 防的回归：重写块的 `kind !== 'character'` 过滤被删 ⇒ lane 100 也被重写
    // （cardA 被拖到底 ⇒ order 0→1）；打 pin 块的豁免改窄成只认 pinned ⇒ cardA 被打 pin。
    // 两种情况下面两条都红。
    const afterCardA = g.nodes.find((n) => n.id === cardA.id)!
    const afterCardB = g.nodes.find((n) => n.id === cardB.id)!
    expect([afterCardA.order, afterCardB.order]).toEqual(cardOrdersBefore)
    expect(afterCardA.pinned).toBeFalsy()
    expect(afterCardB.pinned).toBeFalsy()
  })
})

/**
 * W 组 · 修复回归（第二波）。
 *
 * Ray 的 M2 / m3 两处修复已落码，本组把「修复被回退」的代价变成红灯：
 *  - W1 钉「重编号参与者 = 时间线节点（kind !== 'character'）」—— pinned 照样参与；
 *  - W2 钉「横向模式 travel 轴是 x」。
 * 两条都只钉拖完后的 order 终值（唯一性 + 按落地位置的序号），不钉实现细节。
 */
describe('修复回归 · order 重编号参与者与行进轴（第二波）', () => {
  it('W1 同 lane 重复 order 哨兵：已 pinned 的节点照样参与重编号，order 两两不重复', () => {
    const store = useFlowStore()
    const ui = useUiStore()
    ui.snapEnabled = false
    store.createGraph('W1 重复 order 哨兵')
    const a = store.addNode({ title: '节点A', lane: 0 })!
    const b = store.addNode({ title: '节点B', lane: 0 })!
    const c = store.addNode({ title: '节点C', lane: 0 })!
    const g = store.activeGraph!

    const dragApi = useNodeDrag(ref(null) as any, viewportStub)
    // 1) 先把 A 拖一下 ⇒ A 被打 pinned（轻微位移，仍停在首位）
    dragTo(dragApi, a, 0, 20)
    const afterFirstDrag = g.nodes.find((n) => n.id === a.id)!
    expect(afterFirstDrag.pinned).toBe(true)
    // 撞号的前提：pinned 的 A 此刻仍占着 order 0 —— 旧实现把 pinned 排除在重编号外时，
    // 它就是那枚「不动的旧号」，与下面被重编号成 0 的 C 撞在一起。
    expect(afterFirstDrag.order).toBe(0)

    // 2) 再把 B 拖到 C 下方（+300 远离参考线 7px 吸附容差）
    const bottom = Math.max(a.y, b.y, c.y) + 300
    dragTo(dragApi, b, 0, bottom - b.y)

    // 前提哨兵：lane 里确实有一个 pinned 节点 —— 场景不成立的话重复号根本不会出现
    expect(g.nodes.find((n) => n.id === a.id)!.pinned).toBe(true)
    expect(g.nodes.find((n) => n.id === b.id)!.pinned).toBe(true)

    const lane0 = g.nodes.filter((n) => n.lane === 0 && n.kind !== 'character')
    // 终值语义 1：同一 lane 内 order 两两不重复。
    // 防的回归：list 过滤若退回 `!isLayoutExempt`（把 pinned 排除在重编号外）⇒
    // pinned 的 A 保留旧 order 0，而 C 被重编号成 0 ⇒ 撞号，此断言红。
    const orders = lane0.map((n) => n.order)
    expect(new Set(orders).size).toBe(orders.length)

    // 终值语义 2：order 等于按落地 travel 轴（纵向是 y）的序号 —— 被拖的 B 落末位
    const byLanding = [...lane0].sort((p, q) => p.y - q.y).map((n) => n.id)
    expect(byLanding).toEqual([a.id, c.id, b.id])
    lane0.forEach((n) => expect(n.order).toBe(byLanding.indexOf(n.id)))
  })

  it('W2 横向模式：order 按 travel 轴 x 重排（首节点拖到最右 ⇒ 变末位）', () => {
    const store = useFlowStore()
    const ui = useUiStore()
    ui.snapEnabled = false
    store.createGraph('W2 横向模式')
    const a = store.addNode({ title: '节点一', lane: 0 })!
    const b = store.addNode({ title: '节点二', lane: 0 })!
    const c = store.addNode({ title: '节点三', lane: 0 })!
    const g = store.activeGraph!

    // 切横向：layoutTimeline 把 travel 轴换成 x（x 递增、y 只由车道决定）
    store.setSettings({ direction: 'horizontal' })
    expect(g.settings.direction).toBe('horizontal')
    // 前提哨兵：三个节点同 lane 同高 ⇒ y 全相等，本例里 x 是唯一变量
    const yBefore = a.y
    expect(new Set([a.y, b.y, c.y]).size).toBe(1)

    // 首节点拖到最右侧：x 变大、y 不变（+300 远离参考线吸附）
    const right = Math.max(a.x, b.x, c.x) + 300
    const dragApi = useNodeDrag(ref(null) as any, viewportStub)
    dragTo(dragApi, a, right - a.x, 0)

    const dragged = g.nodes.find((n) => n.id === a.id)!
    expect(dragged.y).toBe(yBefore)
    // 终值语义：order 按落地 travel 轴（横向是 x）重排 —— 被拖节点落末位。
    // 防的回归：sort 键若退回 `a.y - b.y` ⇒ 横向拖动不改变 order（三个 y 全相等），
    // 被拖节点仍是 0 而不是末位，下面两条全红。
    const lane0 = g.nodes.filter((n) => n.lane === 0 && n.kind !== 'character')
    const byLanding = [...lane0].sort((p, q) => p.x - q.x).map((n) => n.id)
    expect(byLanding).toEqual([b.id, c.id, a.id])
    lane0.forEach((n) => expect(n.order).toBe(byLanding.indexOf(n.id)))
    expect(dragged.order).toBe(lane0.length - 1)
  })
})

/**
 * B 组 · backlog 修复回归（第三波）。
 *
 * 三条 backlog 里属于拖拽链路的两条：#3（Esc 取消不写数据）有真缺陷、已配哨兵；
 * #4（order 重写后刷新 updatedAt）经实证判定**不是缺陷**，按「无需修改」结案，
 * 曾为它写过的 T3 已作为伪守护删除（结案记录见 test-report-backlog.md 第 5 节）。
 *
 *  - T2 钉「取消不写数据」：Esc 取消只还原坐标，不得顺手按 y 序洗一遍 order。
 *    只钉拖完后的可观察终值（order / 坐标），不钉实现细节。
 */
describe('backlog 修复回归 · 取消不写 order 与 updatedAt 刷新（第三波）', () => {
  it('T2 拖动后按 Esc 取消：坐标还原且全部节点 order 保持原值（脏数据不被洗）', () => {
    const store = useFlowStore()
    const ui = useUiStore()
    ui.snapEnabled = false
    store.createGraph('T2 Esc 取消')
    const n1 = store.addNode({ title: '节点一', lane: 0 })!
    const n2 = store.addNode({ title: '节点二', lane: 0 })!
    const n3 = store.addNode({ title: '节点三', lane: 0 })!
    const g = store.activeGraph!
    expect([n1.order, n2.order, n3.order]).toEqual([0, 1, 2])

    // 造「order 与 y 不一致」的脏数据：order 0 的那个（n1）y 反而最大。
    // 真实来源：撤销/重做、导入 JSON、手改 order，都能造出这种不一致。
    const maxY = Math.max(n1.y, n2.y, n3.y)
    n1.y = maxY + 600
    const before = g.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, order: n.order }))
    const ordersBefore = [n1.order, n2.order, n3.order]
    // 前提哨兵：脏数据确实「y 序 ≠ order 序」，否则重写一遍本就是 no-op，测不出东西
    expect([...before].sort((a, b) => a.y - b.y).map((n) => n.order)).not.toEqual([
      0, 1, 2
    ])

    const dragApi = useNodeDrag(ref(null) as any, viewportStub)
    dragApi.start(fakePointer(0, 0), n2)
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 0, clientY: 400 }))
    // 防伪绿哨兵：拖拽确实发生了（committed 为真、重写块够得着），
    // 否则「Esc 不写 order」可能只是因为压根没进过 finish 的重写块。
    const yBeforeN2 = before.find((n) => n.id === n2.id)!.y
    expect(g.nodes.find((n) => n.id === n2.id)!.y).not.toBe(yBeforeN2)

    // 取消：Esc 走 onEsc → finish(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    // 终值语义 1：坐标全部还原
    for (const snap of before) {
      const after = g.nodes.find((n) => n.id === snap.id)!
      expect({ x: after.x, y: after.y }).toEqual({ x: snap.x, y: snap.y })
    }
    // 终值语义 2：**order 保持原值** —— 取消的拖拽不该改写数据。
    // 防的回归：finish 的重写块条件去掉 `&& pin` ⇒ Esc 也会按还原后的 y 序洗一遍
    // （还原后 y 序是 n2 < n3 < n1，会被写成 n2=0、n3=1、n1=2）⇒ 此断言红。
    expect([n1.order, n2.order, n3.order]).toEqual(ordersBefore)

    // 反向哨兵：同一份脏数据**松手生效**时 order 确实会被洗（证明上面那条不是因为
    // 重写路径压根没跑，而是「取消路径被正确地挡住了」）。
    dragTo(dragApi, n2, 0, 400)
    expect([n1.order, n2.order, n3.order]).not.toEqual(ordersBefore)
  })
  // 本组原本还有一条 T3（order 重写后刷新 updatedAt），**已删除** —— 它被实证判定为
  // 伪守护：拖拽期 onMove 的 updateNode 已经无条件 touch 过，修复前后 updatedAt 都是新的，
  // 「再补一次 touch」没有可守护的契约。完整结案记录见
  // .agent-runs/2026-10-15/task-001/test-report-backlog.md 第 5 节。
})
