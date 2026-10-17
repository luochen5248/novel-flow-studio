/**
 * characterApiEntrance.spec.ts —— 「AI / 控制台入口」建人物卡的落位一致性
 *
 * 背景：`window.NovelFlow.addNode({ kind: 'character' })`（`src/api/aiApi.ts`）是
 * 除工具栏「新建人物卡」之外的第二个建卡入口（AI 与控制台脚本都走它）。
 * 人物卡被 `isLayoutExempt` 永久剔出布局集合，坐标只在创建那一刻决定一次，
 * 所以两个入口必须产出**同一套三件套**，否则 AI 建出来的角色牌会掉进主线。
 *
 * 三件套（与工具栏 `CanvasToolbar.addCharacterCard` 对齐）：
 *   lane === CHARACTER_LANE(100)  —— 保留道，导出层（markdown/mermaid/aiPrompt）按 lane 分桶
 *   w    === CHARACTER_NODE_W(196) —— 人物卡专用尺寸
 *   x/y  === nextCharacterSlot(建卡前的 nodes) —— 4 列一行网格错位
 *
 * ⚠️ 模块时序说明（踩坑记录，别改回静态 import）：
 *   `src/api/aiApi.ts` 在被 import 时**立即**执行 `installNovelFlow()` + `void ensureStore()`，
 *   而 `ensureStore()` 内部 `useFlowStore()` 需要**已激活的 pinia**；
 *   一旦那一次失败，`storeRef` 会被永久缓存为 null（见 aiApi 的 `storeLoading` 短路），
 *   之后 `await ready()` 也救不回来 —— 表现为所有 addNode 都返回「状态尚未就绪」。
 *   ⇒ 必须在 `setActivePinia()` **之后**再动态 import 本模块，且整个文件共用同一份 store 实例
 *   （aiApi 缓存的 `storeRef` 是模块级单例，中途换 pinia 会让它指向旧实例）。
 *
 * 人物卡与 afterId / branchOf 的语义（2026-10-15 用户裁决「AI/控制台建人物卡
 * 完全取消自动连边」后落定，见 H 组断言）：
 *   - `addNode({ kind:'character', afterId / branchOf })` ⇒ **显式报错**（H1 / H2），
 *     error 同时含「不支持」与对应关键字，且失败早于任何状态变更（零副作用）；
 *   - 默认落位 ⇒ 不连任何边（G5 / G9）；
 *   - 混合批量 `addNodes` 里人物卡不参与链：不注入 afterId、不当 previousId、
 *     不带偏后续项的 lane（H3 / H4 / H6）。
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFlowStore } from '@/stores/useFlowStore'
import { nextCharacterSlot } from '@/core/characterSlot'
import { CHARACTER_LANE, CHARACTER_NODE_W } from '@/components/canvas/characterCard'
import type { StoryNode } from '@/types/graph'

/** window.NovelFlow 的句柄（any：可编程 API 面向控制台脚本，形状宽松） */
let api: any
let store: ReturnType<typeof useFlowStore>

beforeAll(async () => {
  localStorage.clear()
  // 顺序至关重要：先激活 pinia，再 import aiApi（见文件头「模块时序说明」）
  setActivePinia(createPinia())
  await import('@/api/aiApi')
  api = (window as Window & { NovelFlow?: unknown }).NovelFlow
  expect(api).toBeTruthy()
  const ready = await api.ready()
  expect(ready).toBe(true)
  store = useFlowStore()
})

beforeEach(() => {
  // 每例一张全新故事线（store 实例是共用的，不能重建 pinia）
  store.createGraph('AI 入口 · 人物卡')
})

/** 取当前图的全部节点（浅拷贝，够 nextCharacterSlot 用，且它本身是纯函数） */
function currentNodes(): StoryNode[] {
  return store.activeGraph!.nodes.map((n) => ({ ...n }))
}

describe('G · AI 入口（window.NovelFlow.addNode）建人物卡的落位一致性', () => {
  it('G1 三件套与工具栏一致：lane=100 / w=196 / 坐标 === nextCharacterSlot（建卡前）', () => {
    store.addNode({ title: '事件一', lane: 0 })!
    const before = currentNodes()
    const slot = nextCharacterSlot(before)

    const res = api.addNode({ kind: 'character', title: '阿离' })
    expect(res.ok).toBe(true)
    const node = res.data as StoryNode

    expect(node.kind).toBe('character')
    expect(node.lane).toBe(CHARACTER_LANE)
    expect(node.w).toBe(CHARACTER_NODE_W)
    expect({ x: node.x, y: node.y }).toEqual(slot)

    // 落库后的节点坐标同样不变 —— `relayoutIfNeeded`（timeline 模式下会跑一次
    // layoutTimeline）吸不回人物卡，这正是「建出来就停在那」的保证
    const saved = store.activeGraph!.nodes.find((n) => n.id === node.id)!
    expect({ x: saved.x, y: saved.y }).toEqual(slot)
    expect(saved.lane).toBe(CHARACTER_LANE)
  })

  it('G2 连续建 3 张：坐标与纯函数逐次一致，且同行相邻相差 STEP_X(300)', () => {
    store.addNode({ title: '事件一', lane: 0 })!

    const got: { x: number; y: number }[] = []
    for (const name of ['甲', '乙', '丙']) {
      const slot = nextCharacterSlot(currentNodes())
      const res = api.addNode({ kind: 'character', title: name })
      expect(res.ok).toBe(true)
      const node = res.data as StoryNode
      expect({ x: node.x, y: node.y }).toEqual(slot)
      got.push({ x: node.x, y: node.y })
    }

    // 三张都在第一行，横向依次 +300（不叠一起）
    expect(got[1].x - got[0].x).toBe(300)
    expect(got[2].x - got[1].x).toBe(300)
    expect(got.map((g) => g.y)).toEqual([0, 0, 0])
  })

  it('G3 调用方显式传 lane ⇒ 尊重调用方（只有缺省才用保留道）', () => {
    store.addNode({ title: '事件一', lane: 0 })!
    const slot = nextCharacterSlot(currentNodes())

    const res = api.addNode({ kind: 'character', title: '乙', lane: 7 })
    expect(res.ok).toBe(true)
    const node = res.data as StoryNode
    // lane 由调用方接管
    expect(node.lane).toBe(7)
    // 但宽度与落位仍旧走人物卡那套（不是普通卡）
    expect(node.w).toBe(CHARACTER_NODE_W)
    expect({ x: node.x, y: node.y }).toEqual(slot)
  })

  it('G4 不压住主线 / 支线：AI 建的人物卡 x 恒在所有非 character 节点右边缘之外', () => {
    const e1 = store.addNode({ title: '主线1', lane: 0 })!
    const b1 = store.addNode({ title: '支线A', lane: 1 })!
    const b2 = store.addNode({ title: '支线B', lane: 2 })!
    expect([e1, b1, b2].every(Boolean)).toBe(true)

    const right = Math.max(...currentNodes().map((n) => n.x + n.w))
    const res = api.addNode({ kind: 'character', title: '阿离' })
    expect(res.ok).toBe(true)
    const node = res.data as StoryNode

    expect(node.x).toBeGreaterThan(right)
    expect(node.x).toBeGreaterThanOrEqual(right + 60)
  })

  it('G7 显式传 lane ⇒ 不连任何边（与 G5 互为反面，且两种裁决下都成立）', () => {
    // 为什么这条可以放心钉：aiApi:626 的 `if (typeof input.lane !== 'number')` 为假时
    // connectFrom 保持 null ⇒ 不连边。无论队长最终裁定「人物卡一律不连边」还是
    // 「记已知限制」，显式 lane 这条路都不连边 —— 本断言在两种结论下都成立。
    store.addNode({ title: '事件一', lane: 0 })!
    const edgesBefore = store.activeGraph!.edges.length

    const res = api.addNode({ kind: 'character', title: '乙', lane: 7 })
    expect(res.ok).toBe(true)
    const node = res.data as StoryNode

    expect(node.lane).toBe(7)
    expect(store.activeGraph!.edges.filter((e) => e.target === node.id)).toEqual([])
    expect(store.activeGraph!.edges.length).toBe(edgesBefore)
  })

  it('G5 默认追加不连边：AI 建的人物卡不会被接进主线 flow 链（用户裁决后钉死）', () => {
    // 历史：修复前 aiApi 对「未传 lane 的追加」一律把 connectFrom 设为主线最后一个节点，
    // 人物卡被接进主线 flow 链（导出 markdown 的 outlineOrder / mermaid 分桶会把它当
    // 主线的一环）。2026-10-15 用户裁决「完全取消自动连边」后，人物卡分支统一短路：
    // connectFrom / successorEdge 恒为 null ⇒ 一条边都不连。
    store.addNode({ title: '事件一', lane: 0 })!
    const edgesBefore = store.activeGraph!.edges.length

    const res = api.addNode({ kind: 'character', title: '阿离' })
    expect(res.ok).toBe(true)
    const node = res.data as StoryNode

    expect(store.activeGraph!.edges.filter((e) => e.target === node.id)).toEqual([])
    expect(store.activeGraph!.edges.length).toBe(edgesBefore)
  })

  it('G9 纯人物卡批量：三张全建成、lane 均 100、x 按网格错位、且零互连', () => {
    // 「不连边」与「建成数」必须同时断言，防伪绿：
    // 若日后 character 因 afterId 被拒导致第 2 项中断，只建成 1 张、自然一条边都没连，
    // 只写「不连边」会悄悄绿 —— 所以「建成数 === 3」是独立哨兵（现在就绿，
    // 一旦「第 2 项起被拒/中断」立刻红）。
    // 修复前（Vic 实测）：批量建人物卡会产生「甲→乙、乙→丙」的人物卡互连
    // （addNodes 给第 2 项起注入 afterId = 前一人物卡 id）。用户裁决「完全取消
    // 自动连边」后：人物卡不注入 afterId，互连消失，本条把新语义钉死。
    store.addNode({ title: '主线事件', lane: 0 })!
    const edgesBefore = store.activeGraph!.edges.length
    const firstSlot = nextCharacterSlot(currentNodes())

    const res = api.addNodes([
      { kind: 'character', title: '甲' },
      { kind: 'character', title: '乙' },
      { kind: 'character', title: '丙' }
    ])
    expect(res.ok).toBe(true)
    const created = res.data as StoryNode[]
    expect(created.length).toBe(3)
    for (const n of created) {
      expect(n.kind).toBe('character')
      expect(n.lane).toBe(CHARACTER_LANE)
      expect(n.w).toBe(CHARACTER_NODE_W)
    }
    // 落位仍走同一套网格（与工具栏/单条入口同口径）
    expect(created[0].x).toBe(firstSlot.x)
    expect(created[1].x - created[0].x).toBe(300)
    expect(created[2].x - created[1].x).toBe(300)
    expect(created.map((n) => n.y)).toEqual([0, 0, 0])
    // 零互连：整张图一条新边都没有，三张卡之间更没有甲→乙→丙
    const g = store.activeGraph!
    expect(g.edges.length).toBe(edgesBefore)
    const ids = new Set(created.map((n) => n.id))
    expect(g.edges.filter((e) => ids.has(e.source) || ids.has(e.target))).toEqual([])
  })

  it('G8 防误伤哨兵：addNodes([event, event]) 正常串联且都落在 lane 0', () => {
    // 为什么现在就写、且与「修 / 不修」的裁定无关：
    // 三种裁定下这条都必须成立。它的价值在「修之前先立」—— aiApi 的 addNodes
    // 已改动 :703（afterId 注入）与 :709（previousId 赋值）以豁免人物卡，
    // 而这两处正是「普通事件批量串联」赖以工作的地方；本条把正常态钉绿，
    // 改动后一旦串不上了立刻能发现。
    store.addNode({ title: '主线事件', lane: 0 })!

    const res = api.addNodes([{ title: '事件A' }, { title: '事件B' }])
    expect(res.ok).toBe(true)
    const created = res.data as StoryNode[]
    expect(created.length).toBe(2)

    const g = store.activeGraph!
    // 两项都仍在主线，不被人物道 / 人物卡带偏
    for (const n of created) {
      expect(n.kind).toBe('event')
      expect(n.lane).toBe(0)
    }
    // 串联正常：主线末 → A → B
    const edges = g.edges
    expect(edges.some((e) => e.target === created[0].id)).toBe(true)
    expect(edges.some((e) => e.source === created[0].id && e.target === created[1].id)).toBe(true)
  })

  it('G6 对照：工具栏入口（store.addNode）建人物卡不连边 —— 两入口的差异点', () => {
    store.addNode({ title: '事件一', lane: 0 })!
    const edgesBefore = store.activeGraph!.edges.length

    // 工具栏 `addCharacterCard` 走的就是 store.addNode（不经过 aiApi），它只建节点
    const card = store.addNode({
      kind: 'character',
      title: '阿离',
      lane: CHARACTER_LANE,
      w: CHARACTER_NODE_W,
      x: 640,
      y: 0
    })!

    expect(card.kind).toBe('character')
    // 与 G5 形成对照：这条路径不会自动连边
    expect(store.activeGraph!.edges.length).toBe(edgesBefore)
    // 且布局不改写它（豁免）
    expect({ x: card.x, y: card.y }).toEqual({ x: 640, y: 0 })
  })
})

describe('H · 人物卡 × afterId/branchOf/批量链（2026-10-15 用户裁决「完全取消自动连边」）', () => {
  /** 全图 nodes + edges 的 JSON 指纹（零副作用断言用；h 会随内容重算，失败路径不改内容故指纹稳定） */
  function fingerprint(): string {
    const g = store.activeGraph!
    return JSON.stringify({ n: g.nodes, e: g.edges })
  }

  it('H1 人物卡 + afterId ⇒ 报错含「不支持」与「afterId」，且图零改动', () => {
    const e1 = store.addNode({ title: '事件一', lane: 0 })!
    const before = fingerprint()

    const res = api.addNode({ kind: 'character', title: '阿离', afterId: e1.id })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('不支持')
    expect(res.error).toContain('afterId')
    // 零副作用：失败早于任何状态变更 —— 节点/边一个没多，同 lane 的 order 没被位移
    expect(fingerprint()).toBe(before)
  })

  it('H2 人物卡 + branchOf ⇒ 报错含「不支持」与「branchOf」，且图零改动', () => {
    const e1 = store.addNode({ title: '事件一', lane: 0 })!
    const before = fingerprint()

    const res = api.addNode({ kind: 'character', title: '阿离', branchOf: e1.id })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('不支持')
    expect(res.error).toContain('branchOf')
    expect(fingerprint()).toBe(before)
  })

  it('H3 混合批量 [character, event]：事件落 lane 0 走默认追加，不被带进人物道、不接角色牌', () => {
    const e1 = store.addNode({ title: '主线1', lane: 0 })!

    const res = api.addNodes([{ kind: 'character', title: '阿离' }, { title: '新事件' }])
    expect(res.ok).toBe(true)
    const [cardNode, ev] = res.data as StoryNode[]
    const g = store.activeGraph!

    // 人物卡：保留道 + 零边
    expect(cardNode.kind).toBe('character')
    expect(cardNode.lane).toBe(CHARACTER_LANE)
    expect(g.edges.filter((e) => e.source === cardNode.id || e.target === cardNode.id)).toEqual([])

    // 事件：lane 0（不是被继承的 100），接的是主线末节点 —— 与单独 addNode({title}) 的
    // 默认追加语义一致（人物卡不充当它的前驱，链在人物卡处断开而非污染）
    expect(ev.kind).toBe('event')
    expect(ev.lane).toBe(0)
    const into = g.edges.filter((e) => e.target === ev.id)
    expect(into.length).toBe(1)
    expect(into[0].source).toBe(e1.id)
  })

  it('H4 混合批量 [character, event, event]：防连坐——两个事件都在 lane 0 且正常串联', () => {
    store.addNode({ title: '主线1', lane: 0 })!

    const res = api.addNodes([
      { kind: 'character', title: '阿离' },
      { title: '事件A' },
      { title: '事件B' }
    ])
    expect(res.ok).toBe(true)
    const [cardNode, a, b] = res.data as StoryNode[]
    const g = store.activeGraph!

    expect(cardNode.lane).toBe(CHARACTER_LANE)
    expect(a.lane).toBe(0)
    expect(b.lane).toBe(0)
    // 没有任何边碰人物卡
    expect(g.edges.filter((e) => e.source === cardNode.id || e.target === cardNode.id)).toEqual([])
    // 两个事件之间串联正常（A→B）—— 批量链在人物卡之后仍能接续
    expect(g.edges.some((e) => e.source === a.id && e.target === b.id)).toBe(true)
    // 防连坐的正面哨兵：人物道里只有人物卡自己，没有被搬进去的事件
    expect(g.nodes.filter((n) => n.lane === CHARACTER_LANE).map((n) => n.id)).toEqual([cardNode.id])
  })

  it('H5 只有人物卡的图上 [character, event]：主线为空 ⇒ 事件不连边（默认追加的无对象场景）', () => {
    // 与 H3 互为补充：默认追加的 connectFrom 取「主线末节点」，主线为空时无对象可接 ——
    // 此时事件就是一条不连边的 lane 0 新节点，与单条 addNode({title}) 行为一致。
    const res = api.addNodes([{ kind: 'character', title: '阿离' }, { title: '新事件' }])
    expect(res.ok).toBe(true)
    const [cardNode, ev] = res.data as StoryNode[]
    const g = store.activeGraph!

    expect(cardNode.lane).toBe(CHARACTER_LANE)
    expect(ev.lane).toBe(0)
    expect(g.edges.length).toBe(0)
  })

  it('H6 批量里人物卡显式传 afterId ⇒ 第 2 项即失败并透出原因，第 1 项保留', () => {
    // addNodes 对人物卡「不注入但透传」显式 afterId：调用方显式传了就让 addNode 的
    // 守卫报错，batch 语义「已创建的节点保留，便于排查」不变。
    const e1 = store.addNode({ title: '事件一', lane: 0 })!

    const res = api.addNodes([
      { title: '事件A' },
      { kind: 'character', title: '阿离', afterId: e1.id }
    ])
    expect(res.ok).toBe(false)
    expect(res.error).toContain('第 2 项失败')
    expect(res.error).toContain('不支持')
    // 第 1 项已建成并保留
    expect(store.activeGraph!.nodes.some((n) => n.title === '事件A')).toBe(true)
    // 人物卡没有建成
    expect(store.activeGraph!.nodes.some((n) => n.kind === 'character')).toBe(false)
  })

  it('H7 混合批量 [event, character]（人物卡不带显式 afterId）：事件串主线末、角色牌落保留道零边', () => {
    // 与 H3（[character, event]）对称的最常见混合形态：人物卡在第二项、且不带
    // afterId。Ray 指出的覆盖空白 —— addNodes 若给第二项注入 afterId = 前一事件 id，
    // 会撞人物卡守卫导致整批失败，或把角色牌接进主线。
    const e0 = store.addNode({ title: '主线1', lane: 0 })!
    const edgesBefore = store.activeGraph!.edges.length

    const res = api.addNodes([{ title: '事件A' }, { kind: 'character', title: '阿离' }])
    expect(res.ok).toBe(true)
    const [ev, card] = res.data as StoryNode[]
    const g = store.activeGraph!

    // 事件A：lane 0，默认追加语义 —— 接在主线末节点之后（与单独 addNode({title}) 一致）
    expect(ev.kind).toBe('event')
    expect(ev.lane).toBe(0)
    const into = g.edges.filter((e) => e.target === ev.id)
    expect(into.length).toBe(1)
    expect(into[0].source).toBe(e0.id)

    // 人物卡：保留道 + 专用宽 + 整张图没有任何边碰它
    expect(card.kind).toBe('character')
    expect(card.lane).toBe(CHARACTER_LANE)
    expect(card.w).toBe(CHARACTER_NODE_W)
    expect(g.edges.filter((e) => e.source === card.id || e.target === card.id)).toEqual([])
    // 全图只多了「主线1 → 事件A」这一条边：既防「注入 afterId 撞守卫整批失败」
    // （res.ok 已红），也防角色牌被接进主线的多连边
    expect(g.edges.length).toBe(edgesBefore + 1)
  })

  it('W3 脏 lane 不透传：字符串 lane 收敛为保留道，数字 lane 仍被尊重', () => {
    // M3 修复回归。LLM / 控制台调用方常把 lane 写成字符串（'7'）——
    // 修复前 character spread 里写的是 `input.lane ?? CHARACTER_LANE`，
    // 字符串 '7' 会被 `??` 原样透传进节点；当次看起来「能用」（画布按 lane 分组没崩），
    // 但 reload 后 sanitizeNode 把非数字 lane 打回 0 ⇒ 人物卡悄悄落进主线，
    // toMarkdown / toMermaid / aiPrompt 按 lane 分桶导出时它就变成主线剧情的一环。
    store.addNode({ title: '事件一', lane: 0 })!

    // 1) 脏输入：字符串 lane ⇒ 收敛为保留道，且类型是干净的数字
    const dirty = api.addNode({ kind: 'character', title: '阿离', lane: '7' })
    expect(dirty.ok).toBe(true)
    const dirtyNode = dirty.data as StoryNode
    expect(typeof dirtyNode.lane).toBe('number')
    expect(dirtyNode.lane).toBe(CHARACTER_LANE)
    expect(dirtyNode.w).toBe(CHARACTER_NODE_W)
    // 落库的那一份同样干净（防「返回时补了、库里没补」）
    const saved = store.activeGraph!.nodes.find((n) => n.id === dirtyNode.id)!
    expect(typeof saved.lane).toBe('number')
    expect(saved.lane).toBe(CHARACTER_LANE)
    // 且不靠 lane 0 存活：没被接进主线
    expect(store.activeGraph!.edges.filter((e) => e.target === dirtyNode.id)).toEqual([])

    // 2) 对照：数字 lane 仍被尊重（与 G3 同口径，防修过头把显式 lane 也吃掉）
    const clean = api.addNode({ kind: 'character', title: '乙', lane: 7 })
    expect(clean.ok).toBe(true)
    const cleanNode = clean.data as StoryNode
    expect(cleanNode.lane).toBe(7)
    expect(cleanNode.w).toBe(CHARACTER_NODE_W)
  })
})
