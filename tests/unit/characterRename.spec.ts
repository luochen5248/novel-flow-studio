/**
 * characterRename.spec.ts —— 人物改名级联守护（Round5 数据撕裂修复）
 *
 * 背景：人物名是**字符串**存在各节点 `characters` 数组里的（无独立角色实体）。
 * 原缺陷：角色牌只改标题 ⇒「卡片叫新名、事件卡里还写旧名」的数据撕裂；
 * 且撤销 merge key 曾用旧名口径，两张同名卡快速改名会历史坍缩
 * （两次改名合并成一条、一次 undo 把两张牌一起还原）。
 *
 * 本文件守护两层（实现已冻结，只读不改）：
 *
 * 一、`src/core/characterRename.ts`（纯决策层，普通对象数组即可测）：
 *   - 四类拒绝：空名 / 找不到卡 / 名字没变 / 与另一张角色牌同名
 *   - 级联收集：按名字反查挂载点、卡片自身不进 mounts、trim 容忍、去重
 *   - `sameCharacterName` / `mountedNodes` 的口径（大小写敏感、容忍前后空白）
 *
 * 二、`src/stores/useFlowStore.ts` 的 `renameCharacter`（应用层，真实 Pinia store）：
 *   - 级联真实落地：卡片标题 + 各挂载点 characters 同步换名
 *   - 合并守护：N+1 次 updateNode 共享 merge key `rename-char:${cardId}`
 *     ⇒ history 同 key 合并，一次改名整体只写一条历史，一次 undo 整体还原
 *   - 双卡异名不串（Vic GAP 回归）：不同 cardId ⇒ 不同 merge key，
 *     400ms 内也不合并，两次 undo 各还原各的
 *   - 拒绝路径不写历史：clash / unchanged 时 depth 与数据均不动
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFlowStore } from '@/stores/useFlowStore'
import { history } from '@/core/history'
import {
  mountedNodes,
  planCharacterRename,
  sameCharacterName,
  type RenamePlan
} from '@/core/characterRename'
import { createNode } from '@/core/model'
import type { StoryNode } from '@/types/graph'

/** 纯函数层造节点：planner 只读 id/kind/title/characters，其余字段用默认值即可 */
function fakeNode(patch: Partial<StoryNode>): StoryNode {
  return createNode(patch)
}

/** 把 RenamePlan 收窄到 ok 分支；被拒绝时直接抛错，防止后续断言恒真通过 */
function mustOk(plan: RenamePlan): Extract<RenamePlan, { ok: true }> {
  if (!plan.ok) throw new Error(`期望改名计划 ok:true，实际被拒绝：${plan.reason}`)
  return plan
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  // ⚠️ 必须清历史：`src/core/history.ts` 的 `history` 是**模块级单例**，
  // pinia 重建不会重置它。不清的话上一个用例的 graph 快照会残留，
  // depth 计数与 undo 目标都会被污染（同 round4.spec.ts 的既有约定）。
  useFlowStore().resetHistory()
})

describe('A · planCharacterRename（纯决策层，不挂 store）', () => {
  it('A1 正常级联：事件卡 characters 里的旧名换成新名，prev/next/mounts 精确返回', () => {
    const nodes: StoryNode[] = [
      fakeNode({ id: 'e1', kind: 'event', title: '雨夜', characters: ['林七'] }),
      fakeNode({ id: 'c1', kind: 'character', title: '林七' })
    ]
    const plan = planCharacterRename(nodes, 'c1', '林七A')
    expect(plan).toEqual({
      ok: true,
      cardId: 'c1',
      prev: '林七',
      next: '林七A',
      mounts: [{ nodeId: 'e1', characters: ['林七A'] }]
    })
  })

  it('A2 空名（trim 后为空）拒绝：empty-name', () => {
    const nodes: StoryNode[] = [fakeNode({ id: 'c1', kind: 'character', title: '林七' })]
    expect(planCharacterRename(nodes, 'c1', '   ')).toEqual({ ok: false, reason: 'empty-name' })
  })

  it('A3 找不到卡片拒绝：no-card', () => {
    const nodes: StoryNode[] = [fakeNode({ id: 'c1', kind: 'character', title: '林七' })]
    expect(planCharacterRename(nodes, 'nope', '林七A')).toEqual({ ok: false, reason: 'no-card' })
  })

  it('A4 名字没变拒绝：unchanged（静默路径，不写历史）', () => {
    const nodes: StoryNode[] = [fakeNode({ id: 'c1', kind: 'character', title: '林七' })]
    expect(planCharacterRename(nodes, 'c1', '林七')).toEqual({ ok: false, reason: 'unchanged' })
  })

  it('A5 与另一张角色牌同名拒绝：clash（否则两张牌共用一个名字，mountCount 统计会串）', () => {
    const nodes: StoryNode[] = [
      fakeNode({ id: 'c1', kind: 'character', title: '林七' }),
      fakeNode({ id: 'c2', kind: 'character', title: '林七A' })
    ]
    expect(planCharacterRename(nodes, 'c1', '林七A')).toEqual({ ok: false, reason: 'clash' })
  })

  it('A6 目标名只出现在非角色节点的 characters 里（手打名字、没有牌）⇒ 允许改名', () => {
    // 只有「另一张角色牌」才阻塞改名；没有牌的名字不该阻塞
    const nodes: StoryNode[] = [
      fakeNode({ id: 'e1', kind: 'event', title: '雨夜', characters: ['林七A'] }),
      fakeNode({ id: 'c1', kind: 'character', title: '林七' })
    ]
    const plan = mustOk(planCharacterRename(nodes, 'c1', '林七A'))
    expect(plan.prev).toBe('林七')
    expect(plan.next).toBe('林七A')
    // e1 引用的是新名而非旧名，不是本次改名的挂载点
    expect(plan.mounts).toEqual([])
  })

  it('A7 mounts 去重：事件卡已含新名时，换名后不得出现重复项', () => {
    const nodes: StoryNode[] = [
      fakeNode({ id: 'e1', kind: 'event', title: '雨夜', characters: ['林七', '林七A'] }),
      fakeNode({ id: 'c1', kind: 'character', title: '林七' })
    ]
    const plan = mustOk(planCharacterRename(nodes, 'c1', '林七A'))
    expect(plan.mounts).toEqual([{ nodeId: 'e1', characters: ['林七A'] }])
  })

  it('A8 trim 容忍：事件卡 characters 里带尾空格的名字（aiApi 泄漏）也能命中挂载', () => {
    const nodes: StoryNode[] = [
      fakeNode({ id: 'e1', kind: 'event', title: '雨夜', characters: ['沈青 '] }),
      fakeNode({ id: 'c1', kind: 'character', title: '沈青' })
    ]
    const plan = mustOk(planCharacterRename(nodes, 'c1', '沈青岚'))
    expect(plan.mounts).toEqual([{ nodeId: 'e1', characters: ['沈青岚'] }])
  })

  it('A9 多挂载点全收集：3 个事件卡都引用旧名 ⇒ mounts 收齐 3 条', () => {
    const nodes: StoryNode[] = [
      fakeNode({ id: 'e1', kind: 'event', title: '一', characters: ['林七'] }),
      fakeNode({ id: 'e2', kind: 'event', title: '二', characters: ['林七'] }),
      fakeNode({ id: 'e3', kind: 'event', title: '三', characters: ['林七'] }),
      fakeNode({ id: 'c1', kind: 'character', title: '林七' })
    ]
    const plan = mustOk(planCharacterRename(nodes, 'c1', '林七A'))
    expect(plan.mounts.length).toBe(3)
    expect(plan.mounts.map((m) => m.nodeId).sort()).toEqual(['e1', 'e2', 'e3'])
    for (const m of plan.mounts) expect(m.characters).toEqual(['林七A'])
  })

  it('A10 卡片自身不进 mounts（id 防自）：角色牌自身 characters 含自己名字也不被收集', () => {
    const nodes: StoryNode[] = [
      fakeNode({ id: 'e1', kind: 'event', title: '雨夜', characters: ['林七'] }),
      fakeNode({ id: 'c1', kind: 'character', title: '林七', characters: ['林七'] })
    ]
    const plan = mustOk(planCharacterRename(nodes, 'c1', '林七A'))
    expect(plan.mounts).toEqual([{ nodeId: 'e1', characters: ['林七A'] }])
  })
})

describe('B · sameCharacterName / mountedNodes（名字口径）', () => {
  it('B1 sameCharacterName：容忍前后空白，大小写敏感（既定语义）', () => {
    expect(sameCharacterName('沈青', '沈青 ')).toBe(true)
    expect(sameCharacterName('a', 'b')).toBe(false)
    expect(sameCharacterName('abc', 'ABC')).toBe(false)
  })

  it('B2 mountedNodes：排除卡片自身、含全部引用节点；无引用时返回空数组', () => {
    const card = fakeNode({ id: 'c1', kind: 'character', title: '林七' })
    const nodes: StoryNode[] = [
      card,
      fakeNode({ id: 'e1', kind: 'event', title: '一', characters: ['林七'] }),
      // 带尾空格的引用同样应命中（trim 容忍）
      fakeNode({ id: 'e2', kind: 'event', title: '二', characters: ['林七 '] }),
      fakeNode({ id: 'e3', kind: 'event', title: '三', characters: ['阿离'] })
    ]
    expect(mountedNodes(nodes, card).map((n) => n.id).sort()).toEqual(['e1', 'e2'])
    // 无引用时返回空数组（不是 undefined、不是全部节点）
    const lone = fakeNode({ id: 'c9', kind: 'character', title: '没人认识' })
    expect(mountedNodes(nodes, lone)).toEqual([])
  })
})

describe('C · store.renameCharacter（应用层，真实 Pinia store）', () => {
  /** 标准场景：一张角色牌 + 两个事件挂载点（C1/C2 共用） */
  function setupTwoMounts(graphName: string): {
    store: ReturnType<typeof useFlowStore>
    card: StoryNode
    e1: StoryNode
    e2: StoryNode
  } {
    const store = useFlowStore()
    store.createGraph(graphName)
    const e1 = store.addNode({ title: '事件一' })!
    store.addCharacter(e1.id, '林七')
    const e2 = store.addNode({ title: '事件二' })!
    store.addCharacter(e2.id, '林七')
    const card = store.addNode({ kind: 'character', title: '林七' })!
    return { store, card, e1, e2 }
  }

  it('C1 级联落地：卡片标题与两个事件卡的 characters 同时换成新名', () => {
    const { store, card, e1, e2 } = setupTwoMounts('C1 级联')
    const plan = mustOk(store.renameCharacter(card.id, '林七A'))
    expect(plan.cardId).toBe(card.id)
    expect(plan.prev).toBe('林七')
    expect(plan.next).toBe('林七A')

    const g = store.activeGraph!
    // 卡片标题换名（不再是「卡片叫新名、事件卡还写旧名」的撕裂态）
    expect(g.nodes.find((n) => n.id === card.id)!.title).toBe('林七A')
    // 两个挂载点同步换名
    expect(g.nodes.find((n) => n.id === e1.id)!.characters).toEqual(['林七A'])
    expect(g.nodes.find((n) => n.id === e2.id)!.characters).toEqual(['林七A'])
  })

  it('C2 一条历史（合并守护）：N+1 次 updateNode 坍缩成一条，一次 undo 整体还原', () => {
    const { store, card, e1, e2 } = setupTwoMounts('C2 合并')
    const before = history.depth

    mustOk(store.renameCharacter(card.id, '林七A'))

    // 卡片标题 + 2 个挂载点共 3 次 updateNode，必须只留下 1 条历史
    expect(history.depth).toBe(before + 1)

    // 一次 undo 必须同时还原卡片标题与两个挂载点
    // （若未合并，一次 undo 只能还原最后一处写入）
    store.undo()
    const g = store.activeGraph!
    expect(g.nodes.find((n) => n.id === card.id)!.title).toBe('林七')
    expect(g.nodes.find((n) => n.id === e1.id)!.characters).toEqual(['林七'])
    expect(g.nodes.find((n) => n.id === e2.id)!.characters).toEqual(['林七'])
  })

  it('C3 双卡异名不串（Vic GAP 回归）：两次改名两条历史，逐次 undo 各还原各的', () => {
    const store = useFlowStore()
    store.createGraph('C3 双卡')
    const e1 = store.addNode({ title: '事件一' })!
    store.addCharacter(e1.id, '林七')
    const e2 = store.addNode({ title: '事件二' })!
    store.addCharacter(e2.id, '林七')
    // 两张同名角色牌（旧 bug 的触发前提）
    const cardA = store.addNode({ kind: 'character', title: '林七' })!
    const cardB = store.addNode({ kind: 'character', title: '林七' })!

    const before = history.depth
    mustOk(store.renameCharacter(cardA.id, '甲'))
    mustOk(store.renameCharacter(cardB.id, '乙'))
    // 不同 cardId ⇒ 不同 merge key，400ms 内也不合并：两次改名 = 两条历史
    expect(history.depth).toBe(before + 2)

    // 第一次 undo：只还原后改名的 cardB，cardA 保持 '甲'
    // （旧 bug：merge key 用旧名 ⇒ 两次改名合并成一条，一次 undo 把两张牌一起还原）
    store.undo()
    let g = store.activeGraph!
    expect(g.nodes.find((n) => n.id === cardB.id)!.title).toBe('林七')
    expect(g.nodes.find((n) => n.id === cardA.id)!.title).toBe('甲')

    // 第二次 undo：cardA 也回到 '林七'
    store.undo()
    g = store.activeGraph!
    expect(g.nodes.find((n) => n.id === cardA.id)!.title).toBe('林七')
    // 本条只守护两张牌的 title 与历史条数；同名双卡的挂载归属是名字模型的
    // 已知语义，不在本文件固化（不断言 e1/e2 的 characters）
  })

  it('C4 拒绝路径不写历史：clash 时历史栈、标题、挂载点均不动', () => {
    const store = useFlowStore()
    store.createGraph('C4 clash')
    const e1 = store.addNode({ title: '事件一' })!
    store.addCharacter(e1.id, '林七')
    const cardA = store.addNode({ kind: 'character', title: '林七' })!
    const cardB = store.addNode({ kind: 'character', title: '林七A' })!

    const before = history.depth
    expect(store.renameCharacter(cardA.id, '林七A')).toEqual({ ok: false, reason: 'clash' })
    expect(history.depth).toBe(before)

    const g = store.activeGraph!
    expect(g.nodes.find((n) => n.id === cardA.id)!.title).toBe('林七')
    expect(g.nodes.find((n) => n.id === cardB.id)!.title).toBe('林七A')
    expect(g.nodes.find((n) => n.id === e1.id)!.characters).toEqual(['林七'])
  })

  it('C5 unchanged 不写历史：传入当前标题原样返回拒绝，depth 不变', () => {
    const store = useFlowStore()
    store.createGraph('C5 unchanged')
    const card = store.addNode({ kind: 'character', title: '林七' })!

    const before = history.depth
    expect(store.renameCharacter(card.id, card.title)).toEqual({ ok: false, reason: 'unchanged' })
    expect(history.depth).toBe(before)
    expect(store.activeGraph!.nodes.find((n) => n.id === card.id)!.title).toBe('林七')
  })
})
