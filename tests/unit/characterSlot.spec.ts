/**
 * characterSlot.spec.ts —— 人物卡片初始落位（core/characterSlot.ts）单元测试
 *
 * 背景：人物卡片（`kind === 'character'`）被 `core/layout.ts` 的 `isLayoutExempt`
 * 按 kind **永久剔出布局集合**（`layoutTimeline` 里的 `auto` 不含它），
 * 所以布局永远不会再给它排一次位。创建入口若不显式给坐标，
 * `createNode` 会兜底成 (0, 0) ⇒ 第 2 张起全叠在同一处。
 * `nextCharacterSlot(nodes)` 就是那个「显式坐标」的唯一决策点，本文件把它钉死。
 *
 * 语义（实现已定稿，按此断言）：
 *   n     = 入参里 kind === 'character' 的节点数量
 *   baseX = 所有**非 character** 节点的 max(x + w) + GAP；无非 character 节点时取 FALLBACK_X
 *   x     = baseX + (n % COLUMNS) * STEP_X
 *   y     = BASE_Y + floor(n / COLUMNS) * STEP_Y
 *
 * 覆盖分六组：
 *   A 常量契约      B 横向基准（永不压住主线/支线）   C 人物卡自己不推着基准跑
 *   D 4 列网格错位   E 边界（空数组 / 只有人物卡 / 残缺 w）  F 纯函数性
 */
import { describe, it, expect } from 'vitest'
import {
  nextCharacterSlot,
  CHARACTER_SLOT_FALLBACK_X,
  CHARACTER_SLOT_GAP,
  CHARACTER_SLOT_BASE_Y,
  CHARACTER_SLOT_STEP_X,
  CHARACTER_SLOT_STEP_Y,
  CHARACTER_SLOT_COLUMNS
} from '@/core/characterSlot'
import { createNode, DEFAULT_NODE_W } from '@/core/model'
import type { StoryNode } from '@/types/graph'

/** 人物卡宽度（`characterCard.ts` 的 CHARACTER_NODE_W）—— 只用于造数据，不参与落位计算 */
const CARD_W = 196

/** 造一个「非 character」节点（主线 / 支线事件卡） */
function other(patch: Partial<StoryNode> = {}): StoryNode {
  return createNode({ kind: 'event', ...patch })
}

/** 造一张人物卡片 */
function card(patch: Partial<StoryNode> = {}): StoryNode {
  return createNode({ kind: 'character', lane: 100, w: CARD_W, ...patch })
}

/** 造 n 张人物卡片（坐标随意 —— 它们本就不参与 baseX 计算） */
function cards(n: number, x = 0, y = 0): StoryNode[] {
  return Array.from({ length: n }, (_, i) => card({ id: `c${i}`, x, y }))
}

/** 入参里「非 character 节点」的最右边缘（w 缺失时按 DEFAULT_NODE_W 兜底，与实现同口径） */
function maxRight(nodes: StoryNode[]): number {
  const others = nodes.filter((n) => n.kind !== 'character')
  if (!others.length) return -Infinity
  return Math.max(...others.map((n) => n.x + (n.w || DEFAULT_NODE_W)))
}

/** 剥掉 w 字段的残缺节点（模拟脏数据 / 非完整 StoryNode 的测试数据） */
function stripW(node: StoryNode): StoryNode {
  const partial: Partial<StoryNode> = { ...node }
  delete partial.w
  return partial as StoryNode
}

describe('A · 常量契约（改常量即改语义，必须显式确认）', () => {
  it('A1 六个落位常量取值锁定', () => {
    expect(CHARACTER_SLOT_FALLBACK_X).toBe(560)
    expect(CHARACTER_SLOT_GAP).toBe(60)
    expect(CHARACTER_SLOT_BASE_Y).toBe(0)
    expect(CHARACTER_SLOT_STEP_X).toBe(300)
    expect(CHARACTER_SLOT_STEP_Y).toBe(216)
    expect(CHARACTER_SLOT_COLUMNS).toBe(4)
  })

  it('A2 STEP_Y 必须大于人物卡最大高度 208（fitNodeHeight 的 clamp 上限）', () => {
    // 208 的来源：core/layout.ts `fitNodeHeight` 的 clamp(..., 104, 208) 上限 ——
    // 人物卡长标题 + 摘要 + 人物行全满时高度可达 208。
    // 曾经的 bug：STEP_Y = 180 < 208，第 5 张卡换行到 y = 180，
    // 与第一行可高 208 的长卡纵向重叠 28px（叠字）。216 = 208 + 8px 呼吸间隙。
    expect(CHARACTER_SLOT_STEP_Y).toBeGreaterThan(208)
  })
})

describe('B · 横向基准：永不压住主线 / 支线', () => {
  it('B1 单条主线：baseX = 主线节点右边缘 + GAP', () => {
    const nodes = [other({ id: 'e1', lane: 0, x: 0, w: DEFAULT_NODE_W })]
    expect(nextCharacterSlot(nodes)).toEqual({
      x: DEFAULT_NODE_W + CHARACTER_SLOT_GAP,
      y: CHARACTER_SLOT_BASE_Y
    })
  })

  it('B2 多支线 + 负坐标：取「所有非 character 节点」的最右边缘，不是最后一条 lane', () => {
    const nodes = [
      other({ id: 'l0', lane: 0, x: -134, w: 268 }), // right = 134
      other({ id: 'l1', lane: 1, x: 186, w: 268 }), // right = 454
      other({ id: 'l2', lane: 2, x: 506, w: 268 }), // right = 774  ← 最大
      other({ id: 'l3', lane: 3, x: -1000, w: 268 }) // right = -732 ← 负数不干扰
    ]
    expect(nextCharacterSlot(nodes).x).toBe(774 + CHARACTER_SLOT_GAP)
  })

  it('B3 全负坐标（支线整体在左）：基准跟着走负，但仍恒在最右边缘之外', () => {
    const nodes = [
      other({ id: 'n1', x: -1200, w: 268 }), // right = -932
      other({ id: 'n2', x: -800, w: 196 }) // right = -604  ← 最大
    ]
    const slot = nextCharacterSlot(nodes)
    expect(slot.x).toBe(-604 + CHARACTER_SLOT_GAP)
    // 即便基准为负，「不压住主内容」这个不变量照样成立
    expect(slot.x).toBeGreaterThan(maxRight(nodes))
  })

  it('B4 不变量扫描：3 种图 × 0..9 张已有卡 ⇒ x 恒 ≥ 主内容最右边缘 + GAP', () => {
    const scenes: StoryNode[][] = [
      // 只有主线
      [other({ id: 'a1', lane: 0, x: -134, w: 268 })],
      // 主线 + 两条支线（含负 x）
      [
        other({ id: 'b1', lane: 0, x: -134, w: 268 }),
        other({ id: 'b2', lane: 1, x: 186, w: 268 }),
        other({ id: 'b3', lane: 2, x: 506, w: 196 })
      ],
      // 极宽卡片 + 极右卡片混排
      [
        other({ id: 'c1', lane: 0, x: -2000, w: 460 }),
        other({ id: 'c2', lane: 1, x: 3000, w: 180 })
      ]
    ]
    for (const base of scenes) {
      const right = maxRight(base)
      for (let n = 0; n < 10; n++) {
        const nodes = [...base, ...cards(n, 99999, 99999)]
        const slot = nextCharacterSlot(nodes)
        expect(slot.x).toBeGreaterThanOrEqual(right + CHARACTER_SLOT_GAP)
        expect(slot.x).toBeGreaterThan(right)
      }
    }
  })
})

describe('C · 人物卡自己不推着基准跑（否则每建一张往右爬 300）', () => {
  const base = [other({ id: 'e1', lane: 0, x: 0, w: 268 }), other({ id: 'e2', lane: 1, x: 506, w: 268 })]
  const baseX = 774 + CHARACTER_SLOT_GAP

  it('C1 0 张卡时的基准', () => {
    expect(nextCharacterSlot(base).x).toBe(baseX)
  })

  it('C2 已有 1 张卡（哪怕它自己在 x=99999）：基准不变，只是 +1 列', () => {
    const slot = nextCharacterSlot([...base, ...cards(1, 99999)])
    expect(slot.x).toBe(baseX + CHARACTER_SLOT_STEP_X)
    expect(slot.y).toBe(CHARACTER_SLOT_BASE_Y)
  })

  it('C3 已有 4 张卡（n % COLUMNS === 0）：x 精确回到基准，只有 y 换行', () => {
    const slot = nextCharacterSlot([...base, ...cards(4, 99999, 99999)])
    expect(slot.x).toBe(baseX)
    expect(slot.y).toBe(CHARACTER_SLOT_STEP_Y)
  })

  it('C4 已有 8 张卡：仍在第二行起点之后，基准依旧不动', () => {
    const slot = nextCharacterSlot([...base, ...cards(8, 99999, 99999)])
    // n=8 ⇒ col 0 / row 2 ⇒ x 回到 baseX
    expect(slot.x).toBe(baseX)
    expect(slot.y).toBe(2 * CHARACTER_SLOT_STEP_Y)
  })
})

describe('D · 4 列一行网格错位', () => {
  const baseX = DEFAULT_NODE_W + CHARACTER_SLOT_GAP // 主线 x=0, w=268 ⇒ 328

  it('D1 同一行相邻两张 x 相差 STEP_X(300)（连续新建 4 张不叠一起）', () => {
    const nodes: StoryNode[] = [other({ id: 'e1', lane: 0, x: 0, w: DEFAULT_NODE_W })]
    const xs: number[] = []
    for (let i = 0; i < CHARACTER_SLOT_COLUMNS; i++) {
      const slot = nextCharacterSlot(nodes)
      xs.push(slot.x)
      expect(slot.y).toBe(CHARACTER_SLOT_BASE_Y) // 前 4 张都在第一行
      nodes.push(card({ id: `c${i}`, x: slot.x, y: slot.y }))
    }
    expect(xs).toEqual([baseX, baseX + 300, baseX + 600, baseX + 900])
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i] - xs[i - 1]).toBe(CHARACTER_SLOT_STEP_X)
    }
  })

  it('D2 第 5 张（n=4）换到第二行：x 回到 baseX，y + STEP_Y', () => {
    const nodes: StoryNode[] = [other({ id: 'e1', lane: 0, x: 0, w: DEFAULT_NODE_W })]
    for (let i = 0; i < 4; i++) {
      const slot = nextCharacterSlot(nodes)
      nodes.push(card({ id: `c${i}`, x: slot.x, y: slot.y }))
    }
    const fifth = nextCharacterSlot(nodes)
    expect(fifth.x).toBe(baseX)
    expect(fifth.y).toBe(CHARACTER_SLOT_BASE_Y + CHARACTER_SLOT_STEP_Y)
  })

  it('D3 网格公式全覆盖：n = 0..11 的 x/y 逐一对上 baseX + (n%4)*300 / floor(n/4)*216', () => {
    const base = [other({ id: 'e1', lane: 0, x: 100, w: 200 })] // baseX = 300 + 60 = 360
    const expectedBaseX = 300 + CHARACTER_SLOT_GAP
    for (let n = 0; n < 12; n++) {
      const slot = nextCharacterSlot([...base, ...cards(n)])
      expect(slot.x).toBe(expectedBaseX + (n % CHARACTER_SLOT_COLUMNS) * CHARACTER_SLOT_STEP_X)
      expect(slot.y).toBe(
        CHARACTER_SLOT_BASE_Y + Math.floor(n / CHARACTER_SLOT_COLUMNS) * CHARACTER_SLOT_STEP_Y
      )
    }
  })
})

describe('E · 边界（空数组 / 只有人物卡 / 残缺节点）', () => {
  it('E1 空数组 ⇒ 首格（FALLBACK_X, BASE_Y）', () => {
    expect(nextCharacterSlot([])).toEqual({
      x: CHARACTER_SLOT_FALLBACK_X,
      y: CHARACTER_SLOT_BASE_Y
    })
  })

  it('E2 只有人物卡、没有任何其它节点 ⇒ 横向基准走 FALLBACK_X 兜底（不是 0）', () => {
    // ⚠️ 语义澄清：FALLBACK_X 兜的是「基准 baseX」，不是「永远返回 (560, 0)」。
    // 已有 n 张人物卡时仍会按 (n%4, floor(n/4)) 错位 —— 首格 (560, 0) 只在 n = 0 时成立
    // （即 E1 的空数组，或「全图只有人物卡且一张都还没建」这种不可能的场景）。
    for (let n = 0; n < 6; n++) {
      const slot = nextCharacterSlot(cards(n, 99999, 99999))
      expect(slot.x).toBe(
        CHARACTER_SLOT_FALLBACK_X + (n % CHARACTER_SLOT_COLUMNS) * CHARACTER_SLOT_STEP_X
      )
      expect(slot.y).toBe(
        CHARACTER_SLOT_BASE_Y + Math.floor(n / CHARACTER_SLOT_COLUMNS) * CHARACTER_SLOT_STEP_Y
      )
    }
    // n=4 时 x 精确回到 560（甩掉列偏移后的纯基准），可直接读出兜底值
    expect(nextCharacterSlot(cards(4)).x).toBe(CHARACTER_SLOT_FALLBACK_X)
  })

  it('E3 w 字段缺失的残缺节点 ⇒ 回落到 DEFAULT_NODE_W，不炸', () => {
    const node = stripW(other({ id: 'broken', x: 100, w: 268 }))
    expect(node.w).toBeUndefined()
    expect(() => nextCharacterSlot([node])).not.toThrow()
    expect(nextCharacterSlot([node]).x).toBe(100 + DEFAULT_NODE_W + CHARACTER_SLOT_GAP)
  })

  it('E4 w = 0（falsy）同样回落 DEFAULT_NODE_W', () => {
    const node = other({ id: 'zero', x: 100, w: 0 })
    expect(nextCharacterSlot([node]).x).toBe(100 + DEFAULT_NODE_W + CHARACTER_SLOT_GAP)
  })

  it('E5 残缺节点与正常节点混排：取 max 时不因残缺而失真', () => {
    const nodes = [
      stripW(other({ id: 'broken', x: 400, w: 268 })), // 兜底后 right = 400 + 268 = 668
      other({ id: 'ok', x: 0, w: 268 }) // right = 268
    ]
    expect(nextCharacterSlot(nodes).x).toBe(668 + CHARACTER_SLOT_GAP)
  })
})

describe('F · 纯函数性（无副作用、可重入）', () => {
  it('F1 不修改入参数组：调用前后逐字段深比较不变', () => {
    const nodes: StoryNode[] = [
      other({ id: 'e1', lane: 0, x: -134, w: 268 }),
      card({ id: 'c1', x: 700, y: 240 }),
      card({ id: 'c2', x: 1000, y: 240 })
    ]
    const snapshot = JSON.stringify(nodes)
    const slot = nextCharacterSlot(nodes)

    expect(JSON.stringify(nodes)).toBe(snapshot)
    // 长度也不变（既不新增也不删除）
    expect(nodes.length).toBe(3)
    // 顺带确认返回值确实是「第三列」而不是被入参改写过
    expect(slot.x).toBe(134 + CHARACTER_SLOT_GAP + 2 * CHARACTER_SLOT_STEP_X)
  })

  it('F2 同一入参两次调用结果相等（可重入、无内部状态）', () => {
    const nodes: StoryNode[] = [other({ id: 'e1', x: 0, w: 268 }), ...cards(3)]
    const a = nextCharacterSlot(nodes)
    const b = nextCharacterSlot(nodes)
    expect(b).toEqual(a)
    expect(b.x).toBe(a.x)
    expect(b.y).toBe(a.y)
  })
})
