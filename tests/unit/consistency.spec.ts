/**
 * consistency.spec.ts —— 时间线一致性检查纯函数（src/core/consistency.ts）
 *
 * 覆盖目标（对照实现报告 implementer-consistency-report.md）：
 *  - **13 条纯规则逐条命中**：每条造一个最小图触发它，断言 rule / severity / nodeIds。
 *  - **四条误报红线**（队长 2026-10-19 拍板口径，本文件的重点）：
 *    ① flashback / jump 边不参与顺序判定（只有 `kind === 'flow'` 才判）；
 *    ② 跨 lane 不比 order；
 *    ③ 年份弱解析：两端都能抽出年份才比较，只有一端能抽出或都抽不出时**不报**；
 *    ④ 人物卡（`kind === 'character'`）豁免 missing-time / missing-chapter，
 *       但**不豁免** missing-summary（G3 是真缺口）。
 *  - 辅助函数（indexIssuesByNode / issuesForNode / severityRank）、规则元数据、
 *    disabled / nodeIds 过滤、输出确定性、示例图基线。
 *
 * fixture 纪律：先给一个「干净基线」（两节点一条 flow 边，所有字段齐全 ⇒ 0 问题），
 * 每条规则只在基线上**改一处**，这样断言到的必然是目标规则，不会被别的规则污染。
 *
 * 断言口径：以**实现当前真实行为**为准（不按理想行为写），行为与预期不符时
 * 记进报告回报，不自行改实现。唯一例外：单节点图按队长裁决**就应**报 1 条 orphan-node。
 */
import { describe, it, expect } from 'vitest'
import {
  CONSISTENCY_RULES,
  checkGraph,
  checkNodes,
  indexIssuesByNode,
  issuesForNode,
  severityRank
} from '@/core/consistency'
import type { CheckOptions, ConsistencyIssue, ConsistencyReport } from '@/core/consistency'
import { createSampleGraph } from '@/core/sample'
import type { EdgeKind, FlowGraph, StoryEdge, StoryNode } from '@/types/graph'

/* ------------------------------------------------------------------ */
/* fixture                                                             */
/* ------------------------------------------------------------------ */

/** 造节点：默认字段全部「齐全」，避免触发任何 gap 规则；只有显式覆盖的才缺 */
function n(over: Partial<StoryNode> & { id: string }): StoryNode {
  return {
    kind: 'event',
    title: over.id,
    timeLabel: '宣和三年 · 深秋',
    summary: '摘要',
    content: '正文',
    characters: [],
    location: '',
    tags: [],
    status: 'planned',
    chapter: over.id, // 章节号默认 = id，天然不重复、不为空
    color: 'teal',
    lane: 0,
    x: 0,
    y: 0,
    w: 268,
    h: 132,
    order: 0,
    ...over
  }
}

/** 造连线：默认 kind = 'flow'（顺序），id 自动生成，保证稳定可复现 */
function e(
  source: string,
  target: string,
  kind: EdgeKind = 'flow',
  id = `${source}-${target}`
): StoryEdge {
  return { id, source, target, kind }
}

/** 干净基线：a(order 0) → b(order 1)，两条主线同 lane，字段齐全 ⇒ 0 问题 */
function cleanGraph(): { nodes: StoryNode[]; edges: StoryEdge[] } {
  return {
    nodes: [n({ id: 'a', order: 0 }), n({ id: 'b', order: 1 })],
    edges: [e('a', 'b')]
  }
}

function run(
  nodes: StoryNode[],
  edges: StoryEdge[],
  options: CheckOptions = {}
): ConsistencyReport {
  return checkNodes(nodes, edges, { now: 0, ...options })
}

function g(nodes: StoryNode[], edges: StoryEdge[]): FlowGraph {
  return {
    id: 'g1',
    name: '测试图',
    createdAt: 0,
    updatedAt: 0,
    nodes,
    edges,
    settings: {
      layoutMode: 'free',
      direction: 'vertical',
      gridSnap: false,
      canvasMode: 'dark',
      rowGap: 196,
      laneGap: 340
    }
  }
}

/** 取某规则的命中列表 */
function hits(report: ConsistencyReport, rule: string): ConsistencyIssue[] {
  return report.issues.filter((i) => i.rule === rule)
}

/** 断言某规则恰好命中 1 条，并返回它 */
function sole(report: ConsistencyReport, rule: string): ConsistencyIssue {
  const list = hits(report, rule)
  expect(list, `期望恰好 1 条 ${rule}，实际 ${list.length} 条`).toHaveLength(1)
  return list[0]
}

const ALL_RULES = CONSISTENCY_RULES.map((r) => r.id)
const PURE_RULES = CONSISTENCY_RULES.filter((r) => !r.needsAi).map((r) => r.id)
const AI_RULES = CONSISTENCY_RULES.filter((r) => r.needsAi).map((r) => r.id)

/* ------------------------------------------------------------------ */
/* 0. 基线锚点                                                          */
/* ------------------------------------------------------------------ */

describe('干净基线', () => {
  it('字段齐全、顺序正确的两节点图 → 0 条问题', () => {
    const { nodes, edges } = cleanGraph()
    const report = run(nodes, edges)
    expect(report.issues).toEqual([])
    expect(report.counts).toEqual({ error: 0, warn: 0, info: 0 })
    expect(report.byNode).toEqual({})
  })
})

/* ------------------------------------------------------------------ */
/* 1. 健壮性 / 空输入                                                    */
/* ------------------------------------------------------------------ */

describe('checkGraph · 空输入与防御', () => {
  it('null / undefined → 空报告，不抛异常', () => {
    for (const input of [null, undefined]) {
      const report = checkGraph(input)
      expect(report.issues).toEqual([])
      expect(report.counts).toEqual({ error: 0, warn: 0, info: 0 })
      expect(report.byNode).toEqual({})
    }
  })

  it('nodes / edges 不是数组 → 空报告', () => {
    const report = checkGraph({ nodes: 'x', edges: 42 } as unknown as FlowGraph)
    expect(report.issues).toEqual([])
  })

  it('全空图（nodes 与 edges 都为空数组）→ 空报告', () => {
    expect(run([], []).issues).toEqual([])
    expect(checkGraph(g([], [])).issues).toEqual([])
  })

  it('now 可注入：checkedAt 等于传入值，不读系统时钟', () => {
    expect(checkGraph(g([], []), { now: 12345 }).checkedAt).toBe(12345)
    expect(run([], [], { now: 999 }).checkedAt).toBe(999)
  })

  it('不修改入参（节点 / 边数组原样返回）', () => {
    const { nodes, edges } = cleanGraph()
    const c1 = [n({ id: 'c', lane: 1 })]
    const e1 = [e('a', 'c', 'branch')]
    const before = JSON.stringify({ nodes: [...nodes, ...c1], edges: [...edges, ...e1] })
    run([...nodes, ...c1], [...edges, ...e1])
    expect(JSON.stringify({ nodes: [...nodes, ...c1], edges: [...edges, ...e1] })).toBe(before)
  })

  it('节点 / 边里混入 null 项不炸', () => {
    const report = run(
      [n({ id: 'a' }), null as unknown as StoryNode],
      [null as unknown as StoryEdge, e('a', 'a')]
    )
    expect(report.issues.some((i) => i.rule === 'missing-time')).toBe(false)
    expect(Array.isArray(report.issues)).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* 2. C1 悬空连线（error）                                               */
/* ------------------------------------------------------------------ */

describe('C1 dangling-edge', () => {
  it('一端指向不存在的节点 → error，nodeIds 只含存在的那一端', () => {
    const { nodes } = cleanGraph()
    const report = run(nodes, [e('a', 'b'), e('b', 'ghost')])
    const issue = sole(report, 'dangling-edge')
    expect(issue.severity).toBe('error')
    expect(issue.category).toBe('conflict')
    expect(issue.nodeIds).toEqual(['b'])
    expect(issue.edgeIds).toEqual(['b-ghost'])
    expect(issue.message).toContain('ghost')
  })

  it('两端都不存在 → nodeIds 为空数组，且不会进 byNode（无处可标）', () => {
    const report = run([], [e('x', 'y')])
    const issue = sole(report, 'dangling-edge')
    expect(issue.nodeIds).toEqual([])
    expect(report.byNode).toEqual({})
  })

  it('悬空的「顺序」边不会顺带报 flow-reverse（端点缺失交给 C1，不重复报）', () => {
    const { nodes } = cleanGraph()
    const report = run(nodes, [e('a', 'b'), e('b', 'ghost', 'flow', 'e2')])
    expect(hits(report, 'flow-reverse')).toHaveLength(0)
    expect(hits(report, 'dangling-edge')).toHaveLength(1)
  })

  it('起点缺失也算悬空，nodeIds 只含终点', () => {
    const { nodes } = cleanGraph()
    const report = run(nodes, [e('a', 'b'), e('ghost', 'a', 'flow', 'e3')])
    expect(sole(report, 'dangling-edge').nodeIds).toEqual(['a'])
  })
})

/* ------------------------------------------------------------------ */
/* 3. C2 顺序连线逆序（error）                                           */
/* ------------------------------------------------------------------ */

describe('C2 flow-reverse', () => {
  it('同 lane 且 source.order > target.order → error，nodeIds 为 [源, 目标]', () => {
    const report = run([n({ id: 'a', order: 2 }), n({ id: 'b', order: 1 })], [e('a', 'b')])
    const issue = sole(report, 'flow-reverse')
    expect(issue.severity).toBe('error')
    expect(issue.nodeIds).toEqual(['a', 'b'])
    expect(issue.edgeIds).toEqual(['a-b'])
  })

  it('红线①：flashback 边即使逆序也不报（倒叙本职就是回指更早事件）', () => {
    const report = run(
      [n({ id: 'a', order: 2 }), n({ id: 'b', order: 1 })],
      [e('a', 'b', 'flashback')]
    )
    expect(hits(report, 'flow-reverse')).toHaveLength(0)
  })

  it('红线①：jump 边即使逆序也不报（无强制顺序语义）', () => {
    const report = run([n({ id: 'a', order: 2 }), n({ id: 'b', order: 1 })], [e('a', 'b', 'jump')])
    expect(hits(report, 'flow-reverse')).toHaveLength(0)
  })

  it('红线②：跨 lane 不比 order（支线起点 order 小是合法用法）', () => {
    const report = run(
      [n({ id: 'a', lane: 0, order: 5 }), n({ id: 'b', lane: 1, order: 0 })],
      [e('a', 'b')]
    )
    expect(hits(report, 'flow-reverse')).toHaveLength(0)
  })

  it('端点含人物卡时不报（人物卡 order 被 layout 永久豁免，无时序意义）', () => {
    const report = run(
      [
        n({ id: 'a', order: 0, characters: ['甲'] }),
        n({ id: 'c', kind: 'character', title: '甲', lane: 100, order: 9 })
      ],
      [e('c', 'a')]
    )
    expect(hits(report, 'flow-reverse')).toHaveLength(0)
    expect(report.issues).toEqual([]) // 人物卡两侧豁免后这张图应当全清
  })

  it('顺序一致（source.order < target.order）→ 不报', () => {
    const { nodes, edges } = cleanGraph()
    expect(hits(run(nodes, edges), 'flow-reverse')).toHaveLength(0)
  })

  it('source.order === target.order 的同 lane 边 → 不报（等号不算逆序）', () => {
    const report = run([n({ id: 'a', order: 1 }), n({ id: 'b', order: 1 })], [e('a', 'b')])
    expect(hits(report, 'flow-reverse')).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* 4. C3 章节号重复（error）                                             */
/* ------------------------------------------------------------------ */

describe('C3 chapter-duplicate', () => {
  it('两个非人物卡节点共用同一章节号 → error，nodeIds 按 id 升序', () => {
    const report = run(
      [n({ id: 'b', chapter: '一' }), n({ id: 'a', chapter: '一' })],
      [e('a', 'b')]
    )
    const issue = sole(report, 'chapter-duplicate')
    expect(issue.severity).toBe('error')
    expect(issue.nodeIds).toEqual(['a', 'b'])
  })

  it('trim 后相同也算重复（「 一 」≈「一」）', () => {
    const report = run(
      [n({ id: 'a', chapter: ' 一 ' }), n({ id: 'b', chapter: '一' })],
      [e('a', 'b')]
    )
    expect(hits(report, 'chapter-duplicate')).toHaveLength(1)
  })

  it('人物卡豁免：人物卡与事件卡撞号 → 不报（人物卡不进章节序列）', () => {
    const report = run(
      [
        n({ id: 'a', chapter: '一', characters: ['甲'] }),
        n({ id: 'b', chapter: '二' }),
        n({ id: 'c', kind: 'character', title: '甲', chapter: '一', lane: 100 })
      ],
      [e('a', 'b')]
    )
    expect(hits(report, 'chapter-duplicate')).toHaveLength(0)
  })

  it('空章节号不参与（那是 G5 的活，同一批节点不被两条规则重复报）', () => {
    const report = run([n({ id: 'a', chapter: '' }), n({ id: 'b', chapter: '' })], [e('a', 'b')])
    expect(hits(report, 'chapter-duplicate')).toHaveLength(0)
    expect(hits(report, 'missing-chapter')).toHaveLength(2)
  })

  it('三个节点同号 → 只报 1 条，nodeIds 含全部三个', () => {
    const report = run(
      [n({ id: 'a', chapter: 'x' }), n({ id: 'b', chapter: 'x' }), n({ id: 'c', chapter: 'x' })],
      [e('a', 'b'), e('b', 'c')]
    )
    expect(sole(report, 'chapter-duplicate').nodeIds).toEqual(['a', 'b', 'c'])
  })
})

/* ------------------------------------------------------------------ */
/* 5. C4 已成稿却无正文（error）                                         */
/* ------------------------------------------------------------------ */

describe('C4 status-content-mismatch', () => {
  it('status = done 且正文为空 → error', () => {
    const report = run([n({ id: 'a', status: 'done', content: '' }), n({ id: 'b' })], [e('a', 'b')])
    const issue = sole(report, 'status-content-mismatch')
    expect(issue.severity).toBe('error')
    expect(issue.nodeIds).toEqual(['a'])
  })

  it('正文只有空白字符也算空', () => {
    const report = run(
      [n({ id: 'a', status: 'done', content: '   \n  ' }), n({ id: 'b' })],
      [e('a', 'b')]
    )
    expect(hits(report, 'status-content-mismatch')).toHaveLength(1)
  })

  it('草稿无正文不算矛盾（那是 G4 的 info，不升级为 error）', () => {
    const report = run(
      [n({ id: 'a', status: 'drafted', content: '' }), n({ id: 'b' })],
      [e('a', 'b')]
    )
    expect(hits(report, 'status-content-mismatch')).toHaveLength(0)
    expect(hits(report, 'missing-content')).toHaveLength(1)
  })

  it('done + 有正文 → 不报', () => {
    const report = run([n({ id: 'a', status: 'done' }), n({ id: 'b' })], [e('a', 'b')])
    expect(hits(report, 'status-content-mismatch')).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* 6. C5 支线未收束（warn）                                              */
/* ------------------------------------------------------------------ */

describe('C5 branch-unclosed', () => {
  it('支线没有任何边汇回主线 → warn，nodeIds 取该 lane 的末端节点', () => {
    const report = run(
      [n({ id: 'a', order: 0 }), n({ id: 'b', order: 1 }), n({ id: 'c', lane: 1 })],
      [e('a', 'b'), e('a', 'c', 'branch')]
    )
    const issue = sole(report, 'branch-unclosed')
    expect(issue.severity).toBe('warn')
    expect(issue.nodeIds).toEqual(['c'])
  })

  it('有任意一条边汇回 lane 0 的非人物卡节点 → 不报（不限边 kind）', () => {
    const report = run(
      [n({ id: 'a', order: 0 }), n({ id: 'b', order: 1 }), n({ id: 'c', lane: 1 })],
      [e('a', 'b'), e('a', 'c', 'branch'), e('c', 'b', 'branch')]
    )
    expect(hits(report, 'branch-unclosed')).toHaveLength(0)
  })

  it('人物道（lane 100 + kind = character）不算支线，不报', () => {
    const report = run(
      [
        n({ id: 'a', order: 0, characters: ['甲'] }),
        n({ id: 'b', order: 1 }),
        n({ id: 'c', kind: 'character', title: '甲', lane: 100 })
      ],
      [e('a', 'b')]
    )
    expect(hits(report, 'branch-unclosed')).toHaveLength(0)
  })

  it('同一 lane 多个节点只报 1 条，nodeIds 取无出边的末端', () => {
    const report = run(
      [
        n({ id: 'a', order: 0 }),
        n({ id: 'b', order: 1 }),
        n({ id: 'c', lane: 1, order: 0 }),
        n({ id: 'd', lane: 1, order: 1 })
      ],
      [e('a', 'b'), e('a', 'c', 'branch'), e('c', 'd', 'flow')]
    )
    expect(sole(report, 'branch-unclosed').nodeIds).toEqual(['d'])
  })

  it('支线互连成环（全员都有出边）时退化为整条 lane', () => {
    const report = run(
      [n({ id: 'a' }), n({ id: 'c', lane: 1, order: 0 }), n({ id: 'd', lane: 1, order: 1 })],
      [e('a', 'c', 'branch'), e('c', 'd', 'flow'), e('d', 'c', 'flow')]
    )
    expect(sole(report, 'branch-unclosed').nodeIds).toEqual(['c', 'd'])
  })
})

/* ------------------------------------------------------------------ */
/* 7. C6 跳跃边时间存疑（warn）                                          */
/* ------------------------------------------------------------------ */

describe('C6 time-jump-unverifiable', () => {
  it('倒叙边有一端没写故事内时间 → warn（文案只说「无法核对」，不说冲突）', () => {
    const report = run(
      [n({ id: 'a', timeLabel: '宣和三年 · 深秋' }), n({ id: 'b', timeLabel: '' })],
      [e('a', 'b', 'flashback')]
    )
    const issue = sole(report, 'time-jump-unverifiable')
    expect(issue.severity).toBe('warn')
    expect(issue.nodeIds).toEqual(['a', 'b'])
    expect(issue.message).toContain('无法核对')
  })

  it('跳跃边缺时间同样报 warn（6a 对 flashback / jump 一视同仁）', () => {
    const report = run(
      [n({ id: 'a', timeLabel: '宣和三年' }), n({ id: 'b', timeLabel: '   ' })],
      [e('a', 'b', 'jump')]
    )
    expect(hits(report, 'time-jump-unverifiable')).toHaveLength(1)
  })

  it('两端年份都写得出来、终点却更晚 → warn「疑似方向不对」', () => {
    const report = run(
      [n({ id: 'a', timeLabel: '宣和三年 · 深秋' }), n({ id: 'b', timeLabel: '宣和九年 · 秋' })],
      [e('a', 'b', 'flashback')]
    )
    const issue = sole(report, 'time-jump-unverifiable')
    expect(issue.severity).toBe('warn')
    expect(issue.message).toContain('疑似')
  })

  it('倒叙回到更早的年份 → 不报（这才是倒叙的正常方向）', () => {
    const report = run(
      [n({ id: 'a', timeLabel: '宣和九年 · 秋' }), n({ id: 'b', timeLabel: '宣和三年 · 深秋' })],
      [e('a', 'b', 'flashback')]
    )
    expect(hits(report, 'time-jump-unverifiable')).toHaveLength(0)
  })

  it('红线③：两端都抽不出年份（「春」/「冬」）→ 不报，绝不误报', () => {
    const report = run(
      [n({ id: 'a', timeLabel: '春' }), n({ id: 'b', timeLabel: '冬' })],
      [e('a', 'b', 'flashback')]
    )
    expect(report.issues).toEqual([])
  })

  it('红线③：只有一端能抽出年份 → 不报（宁可漏报）', () => {
    const report = run(
      [n({ id: 'a', timeLabel: '宣和三年' }), n({ id: 'b', timeLabel: '春' })],
      [e('a', 'b', 'flashback')]
    )
    expect(hits(report, 'time-jump-unverifiable')).toHaveLength(0)
  })

  it('jump 边不参与年份比较（方向反了也不报），只报缺时间的 6a', () => {
    const report = run(
      [n({ id: 'a', timeLabel: '宣和三年' }), n({ id: 'b', timeLabel: '宣和九年' })],
      [e('a', 'b', 'jump')]
    )
    expect(hits(report, 'time-jump-unverifiable')).toHaveLength(0)
  })

  it('阿拉伯年份也能解析（2026 年 → 2027 年 的倒叙 → 报疑似）', () => {
    const report = run(
      [n({ id: 'a', timeLabel: '2026年 三月' }), n({ id: 'b', timeLabel: '2027年 五月' })],
      [e('a', 'b', 'flashback')]
    )
    expect(hits(report, 'time-jump-unverifiable')).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ */
/* 8. G1 孤立节点（warn）                                               */
/* ------------------------------------------------------------------ */

describe('G1 orphan-node', () => {
  it('既无入边也无出边 → warn（每个孤立节点各一条）', () => {
    const report = run([n({ id: 'a' }), n({ id: 'b' })], [])
    const list = hits(report, 'orphan-node')
    expect(list).toHaveLength(2)
    expect(list.map((i) => i.nodeIds)).toEqual([['a'], ['b']])
    expect(list[0].severity).toBe('warn')
    expect(list[0].category).toBe('gap')
  })

  it('只有入边或只有出边 → 不算孤立', () => {
    const report = run([n({ id: 'a', order: 0 }), n({ id: 'b', order: 1 })], [e('a', 'b')])
    expect(hits(report, 'orphan-node')).toHaveLength(0)
  })

  it('人物卡豁免（角色牌本来就钉在保留道上，不进时间线）', () => {
    const report = run(
      [n({ id: 'a', characters: ['甲'] }), n({ id: 'c', kind: 'character', title: '甲', lane: 100 })],
      [e('a', 'a', 'flow', 'self')]
    )
    // a 只连了自己，不算孤立；人物卡 c 也不算孤立
    expect(hits(report, 'orphan-node')).toHaveLength(0)
  })

  it('单节点图按队长裁决仍报 1 条 orphan-node（字面行为，不是 bug）', () => {
    const report = run([n({ id: 'a' })], [])
    expect(hits(report, 'orphan-node')).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ */
/* 9. G2 / G3 / G4 / G5 缺字段（info）                                   */
/* ------------------------------------------------------------------ */

describe('G2–G5 缺字段规则', () => {
  it('G2 事件卡缺 timeLabel → 报 missing-time（info）', () => {
    const report = run([n({ id: 'a', timeLabel: '' }), n({ id: 'b' })], [e('a', 'b')])
    const issue = sole(report, 'missing-time')
    expect(issue.severity).toBe('info')
    expect(issue.nodeIds).toEqual(['a'])
  })

  it('G3 缺 summary → 报 missing-summary（info）', () => {
    const report = run([n({ id: 'a', summary: '  ' }), n({ id: 'b' })], [e('a', 'b')])
    expect(sole(report, 'missing-summary').nodeIds).toEqual(['a'])
  })

  it('G4 已开工（drafted）却无正文 → 报 missing-content（info）', () => {
    const report = run([n({ id: 'a', status: 'drafted', content: '' }), n({ id: 'b' })], [e('a', 'b')])
    expect(sole(report, 'missing-content').nodeIds).toEqual(['a'])
  })

  it('G4 待写节点无正文 → 不报（待写本来就没正文，报了是噪音）', () => {
    const report = run([n({ id: 'a', status: 'planned', content: '' }), n({ id: 'b' })], [e('a', 'b')])
    expect(hits(report, 'missing-content')).toHaveLength(0)
  })

  it('done + 无正文：C4 的 error 与 G4 的 info 都会出现（两条规则不互斥）', () => {
    const report = run([n({ id: 'a', status: 'done', content: '' }), n({ id: 'b' })], [e('a', 'b')])
    expect(hits(report, 'status-content-mismatch')).toHaveLength(1)
    expect(hits(report, 'missing-content')).toHaveLength(1)
  })

  it('G5 事件卡缺章节号 → 报 missing-chapter（info）', () => {
    const report = run([n({ id: 'a', chapter: '' }), n({ id: 'b' })], [e('a', 'b')])
    expect(sole(report, 'missing-chapter').nodeIds).toEqual(['a'])
  })

  it('红线④：人物卡豁免 missing-time（G2，它压根没有时点可填）', () => {
    const report = run(
      [
        n({ id: 'a', characters: ['甲'] }),
        n({ id: 'c', kind: 'character', title: '甲', timeLabel: '', lane: 100 })
      ],
      [e('a', 'a', 'flow', 'self')]
    )
    expect(hits(report, 'missing-time')).toHaveLength(0)
  })

  it('红线④：人物卡**不**豁免 missing-summary（G3 —— 没描述是真缺口）', () => {
    const report = run(
      [
        n({ id: 'a', characters: ['甲'] }),
        n({ id: 'c', kind: 'character', title: '甲', summary: '', lane: 100 })
      ],
      [e('a', 'a', 'flow', 'self')]
    )
    expect(sole(report, 'missing-summary').nodeIds).toEqual(['c'])
  })

  it('红线④：人物卡豁免 missing-chapter（G5，不在章节序列里）', () => {
    const report = run(
      [
        n({ id: 'a', characters: ['甲'] }),
        n({ id: 'c', kind: 'character', title: '甲', chapter: '', lane: 100 })
      ],
      [e('a', 'a', 'flow', 'self')]
    )
    expect(hits(report, 'missing-chapter')).toHaveLength(0)
  })

  it('事件卡字段全空 → G2/G3/G5 三条一起报（人物卡只报 G3）', () => {
    const report = run(
      [n({ id: 'a', timeLabel: '', summary: '', chapter: '' }), n({ id: 'b' })],
      [e('a', 'b')]
    )
    expect(hits(report, 'missing-time')).toHaveLength(1)
    expect(hits(report, 'missing-summary')).toHaveLength(1)
    expect(hits(report, 'missing-chapter')).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ */
/* 10. G6 出场人物无角色牌（warn / info）                                */
/* ------------------------------------------------------------------ */

describe('G6 character-no-card', () => {
  it('出场 1 次且无同名角色牌 → info（大概率是路人）', () => {
    const report = run([n({ id: 'a', characters: ['路人甲'] }), n({ id: 'b' })], [e('a', 'b')])
    const issue = sole(report, 'character-no-card')
    expect(issue.severity).toBe('info')
    expect(issue.nodeIds).toEqual(['a'])
  })

  it('被 ≥2 个节点引用 → 升级为 warn', () => {
    const report = run(
      [n({ id: 'a', characters: ['阿霁'] }), n({ id: 'b', characters: ['阿霁'] })],
      [e('a', 'b')]
    )
    const issue = sole(report, 'character-no-card')
    expect(issue.severity).toBe('warn')
    expect(issue.nodeIds).toEqual(['a', 'b'])
  })

  it('图上有同名角色牌 → 不报', () => {
    const report = run(
      [
        n({ id: 'a', characters: ['阿霁'] }),
        n({ id: 'b', characters: ['阿霁'] }),
        n({ id: 'c', kind: 'character', title: '阿霁', lane: 100 })
      ],
      [e('a', 'b')]
    )
    expect(hits(report, 'character-no-card')).toHaveLength(0)
  })

  it('名字带残留空白也能匹配上角色牌（复用 sameCharacterName 的容忍口径）', () => {
    const report = run(
      [
        n({ id: 'a', characters: ['沈青 '] }),
        n({ id: 'b', characters: ['沈青'] }),
        n({ id: 'c', kind: 'character', title: '沈青', lane: 100 })
      ],
      [e('a', 'b')]
    )
    expect(hits(report, 'character-no-card')).toHaveLength(0)
  })

  it('同一节点里同一个名字写两次只算 1 次出场（仍按 info，不升级 warn）', () => {
    const report = run([n({ id: 'a', characters: ['甲', '甲'] }), n({ id: 'b' })], [e('a', 'b')])
    const issue = sole(report, 'character-no-card')
    expect(issue.nodeIds).toEqual(['a'])
    expect(issue.severity).toBe('info')
  })

  it('大小写不同视为不同人物（系统一贯的大小写敏感口径）→ 仍会报', () => {
    const report = run(
      [n({ id: 'a', characters: ['Ann'] }), n({ id: 'c', kind: 'character', title: 'ann', lane: 100 })],
      [e('a', 'a', 'flow', 'self')]
    )
    expect(hits(report, 'character-no-card')).toHaveLength(1)
  })

  it('characters 里的空串 / 非字符串项被忽略，不产生问题', () => {
    const report = run(
      [n({ id: 'a', characters: ['', '   '] } as unknown as StoryNode), n({ id: 'b' })],
      [e('a', 'b')]
    )
    expect(hits(report, 'character-no-card')).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* 11. G7 角色牌未挂载（info）                                           */
/* ------------------------------------------------------------------ */

describe('G7 card-unmounted', () => {
  it('角色牌没有任何节点引用 → info', () => {
    const report = run(
      [n({ id: 'a' }), n({ id: 'c', kind: 'character', title: '甲', lane: 100 })],
      [e('a', 'a', 'flow', 'self')]
    )
    const issue = sole(report, 'card-unmounted')
    expect(issue.severity).toBe('info')
    expect(issue.nodeIds).toEqual(['c'])
  })

  it('有节点在 characters 里写了这个名字 → 已挂载，不报', () => {
    const report = run(
      [
        n({ id: 'a', characters: ['甲'] }),
        n({ id: 'c', kind: 'character', title: '甲', lane: 100 })
      ],
      [e('a', 'a', 'flow', 'self')]
    )
    expect(hits(report, 'card-unmounted')).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* 12. 规则元数据                                                       */
/* ------------------------------------------------------------------ */

describe('CONSISTENCY_RULES 元数据', () => {
  it('共 21 项：13 条纯规则 + 8 条 AI 语义占位', () => {
    expect(CONSISTENCY_RULES).toHaveLength(21)
    expect(PURE_RULES).toHaveLength(13)
    expect(AI_RULES).toHaveLength(8)
  })

  it('规则码唯一，且字段齐全（label / desc 非空、category / severity 合法）', () => {
    expect(new Set(ALL_RULES).size).toBe(21)
    for (const rule of CONSISTENCY_RULES) {
      expect(rule.label.length).toBeGreaterThan(0)
      expect(rule.desc.length).toBeGreaterThan(0)
      expect(['conflict', 'gap']).toContain(rule.category)
      expect(['error', 'warn', 'info']).toContain(rule.severity)
    }
  })

  it('纯规则 13 条：needsAi = false 且默认开启', () => {
    for (const rule of CONSISTENCY_RULES.filter((r) => !r.needsAi)) {
      expect(rule.enabled).toBe(true)
    }
  })

  it('AI 语义 8 条：needsAi = true 且默认关闭，规则码以 ai- 开头', () => {
    for (const rule of CONSISTENCY_RULES.filter((r) => r.needsAi)) {
      expect(rule.enabled).toBe(false)
      expect(rule.id.startsWith('ai-')).toBe(true)
    }
  })

  it('checkGraph 永不产出 needsAi 规则的 issue（那 8 条本次未实现）', () => {
    const messyNodes = [
      n({ id: 'a', order: 3, status: 'done', content: '', timeLabel: '', summary: '', chapter: '' }),
      n({ id: 'b', order: 0, characters: ['甲', '乙'] }),
      n({ id: 'c', lane: 1, chapter: '同号', characters: ['甲'] }),
      n({ id: 'd', kind: 'character', title: '乙', lane: 100 })
    ]
    const messyEdges = [e('a', 'b'), e('a', 'c', 'branch'), e('b', 'ghost'), e('c', 'a', 'flashback')]
    const report = run(messyNodes, messyEdges)
    expect(report.issues.length).toBeGreaterThan(0)
    for (const issue of report.issues) {
      expect(AI_RULES).not.toContain(issue.rule)
      expect(ALL_RULES).toContain(issue.rule)
    }
  })
})

/* ------------------------------------------------------------------ */
/* 13. 过滤与开关                                                       */
/* ------------------------------------------------------------------ */

describe('CheckOptions · 过滤与开关', () => {
  it('disabled 关闭某规则后该规则不再产出', () => {
    const nodes = [n({ id: 'a', summary: '' }), n({ id: 'b', summary: '' })]
    expect(hits(run(nodes, [e('a', 'b')]), 'missing-summary')).toHaveLength(2)
    expect(
      hits(run(nodes, [e('a', 'b')], { disabled: ['missing-summary'] }), 'missing-summary')
    ).toHaveLength(0)
  })

  it('disabled 可以同时关多条，且不影响其它规则', () => {
    const nodes = [n({ id: 'a', summary: '', timeLabel: '' }), n({ id: 'b' })]
    const report = run(nodes, [e('a', 'b')], {
      disabled: ['missing-summary', 'missing-time']
    })
    expect(hits(report, 'missing-summary')).toHaveLength(0)
    expect(hits(report, 'missing-time')).toHaveLength(0)
    expect(report.issues).toEqual([])
  })

  it('nodeIds 过滤：只保留**涉及任一选中节点**的问题', () => {
    const nodes = [n({ id: 'a', summary: '' }), n({ id: 'b', summary: '' })]
    const report = run(nodes, [e('a', 'b')], { nodeIds: ['b'] })
    expect(report.issues.map((i) => i.id)).toEqual(['missing-summary:b'])
  })

  it('nodeIds 过滤对分组规则按组整体保留（不做组内再切分）', () => {
    const nodes = [
      n({ id: 'a', order: 0 }),
      n({ id: 'b', order: 1 }),
      n({ id: 'c', lane: 1, order: 0 }),
      n({ id: 'd', lane: 1, order: 1 })
    ]
    const edges = [e('a', 'b'), e('a', 'c', 'branch'), e('c', 'd', 'flow')]
    // branch-unclosed 的 nodeIds 是末端 ['d']，选中同 lane 的非末端 c 不会命中
    expect(hits(run(nodes, edges, { nodeIds: ['c'] }), 'branch-unclosed')).toHaveLength(0)
    expect(hits(run(nodes, edges, { nodeIds: ['d'] }), 'branch-unclosed')).toHaveLength(1)
  })

  it('crossLane 开关当前不改变输出（仅为 AI 语义项预留）', () => {
    const nodes = [n({ id: 'a', lane: 0, order: 5 }), n({ id: 'b', lane: 1, order: 0 })]
    const edges = [e('a', 'b')]
    const off = run(nodes, edges, { crossLane: false })
    const on = run(nodes, edges, { crossLane: true })
    expect(on.issues.map((i) => i.id)).toEqual(off.issues.map((i) => i.id))
  })

  it('counts 与 issues 始终自洽', () => {
    const nodes = [
      n({ id: 'a', status: 'done', content: '', summary: '' }),
      n({ id: 'b', summary: '' }),
      n({ id: 'c', lane: 1 })
    ]
    const report = run(nodes, [e('a', 'b'), e('a', 'c', 'branch')])
    const tally = { error: 0, warn: 0, info: 0 }
    for (const i of report.issues) tally[i.severity] += 1
    expect(report.counts).toEqual(tally)
  })
})

/* ------------------------------------------------------------------ */
/* 14. 输出确定性                                                       */
/* ------------------------------------------------------------------ */

describe('输出确定性与排序', () => {
  const messyNodes = [
    n({ id: 'a', order: 3, status: 'done', content: '', timeLabel: '', summary: '', chapter: '' }),
    n({ id: 'b', order: 0, characters: ['甲', '乙'] }),
    n({ id: 'c', lane: 1, chapter: '同号', characters: ['甲'] }),
    n({ id: 'd', kind: 'character', title: '乙', lane: 100 })
  ]
  const messyEdges = [
    e('a', 'b'),
    e('a', 'c', 'branch'),
    e('b', 'ghost'),
    e('c', 'a', 'flashback', 'fb1')
  ]

  it('两次调用产出完全一致的 id 序列（UI 列表不会抖）', () => {
    const first = run(messyNodes, messyEdges)
    const second = run(messyNodes, messyEdges)
    expect(second.issues.map((i) => i.id)).toEqual(first.issues.map((i) => i.id))
    expect(second.issues.map((i) => i.message)).toEqual(first.issues.map((i) => i.message))
  })

  it('issues 按 严重级 → 规则声明顺序 → id 排列', () => {
    const report = run(messyNodes, messyEdges)
    const ranks = report.issues.map((i) => severityRank(i.severity))
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y))
    // 同一严重级内，规则顺序必须单调不减
    for (let i = 1; i < report.issues.length; i += 1) {
      if (ranks[i] !== ranks[i - 1]) continue
      const prev = ALL_RULES.indexOf(report.issues[i - 1].rule)
      const cur = ALL_RULES.indexOf(report.issues[i].rule)
      expect(cur).toBeGreaterThanOrEqual(prev)
    }
  })

  it('issue.id 稳定：不含时间戳 / 索引，等于 `${rule}:${定位键}`', () => {
    const report = run(messyNodes, messyEdges)
    for (const issue of report.issues) {
      expect(issue.id.startsWith(`${issue.rule}:`)).toBe(true)
      expect(issue.id).not.toMatch(/\d{10,}/) // 没有毫秒时间戳
    }
  })

  it('checkGraph 与 checkNodes 对同一份数据产出一致', () => {
    const viaNodes = run(messyNodes, messyEdges)
    const viaGraph = checkGraph(g(messyNodes, messyEdges), { now: 0 })
    expect(viaGraph.issues.map((i) => i.id)).toEqual(viaNodes.issues.map((i) => i.id))
    expect(viaGraph.counts).toEqual(viaNodes.counts)
  })
})

/* ------------------------------------------------------------------ */
/* 15. 辅助函数                                                        */
/* ------------------------------------------------------------------ */

describe('辅助函数', () => {
  it('severityRank：error 0 < warn 1 < info 2', () => {
    expect(severityRank('error')).toBe(0)
    expect(severityRank('warn')).toBe(1)
    expect(severityRank('info')).toBe(2)
  })

  it('indexIssuesByNode：按 nodeId 建索引，一条问题可进多个节点', () => {
    const shared: ConsistencyIssue = {
      id: 'r:a+b',
      rule: 'flow-reverse',
      category: 'conflict',
      severity: 'error',
      nodeIds: ['a', 'b'],
      message: 'x'
    }
    const index = indexIssuesByNode([shared])
    expect(index.a).toEqual([shared])
    expect(index.b).toEqual([shared])
  })

  it('indexIssuesByNode：nodeIds 为空的问题不进索引；非数组入参返回空对象', () => {
    const noNode: ConsistencyIssue = {
      id: 'dangling-edge:e',
      rule: 'dangling-edge',
      category: 'conflict',
      severity: 'error',
      nodeIds: [],
      message: 'y'
    }
    expect(indexIssuesByNode([noNode])).toEqual({})
    expect(indexIssuesByNode(null as unknown as ConsistencyIssue[])).toEqual({})
  })

  it('issuesForNode：取得到 / 取不到 / 空 id 三种情况', () => {
    const report = run([n({ id: 'a', summary: '' }), n({ id: 'b' })], [e('a', 'b')])
    expect(issuesForNode(report, 'a').map((i) => i.rule)).toEqual(['missing-summary'])
    expect(issuesForNode(report, 'b')).toEqual([])
    expect(issuesForNode(report, '')).toEqual([])
  })

  it('checkNodes 接受裸数组，也能容忍非数组入参', () => {
    expect(checkNodes([], []).issues).toEqual([])
    expect(
      checkNodes(null as unknown as StoryNode[], null as unknown as StoryEdge[]).issues
    ).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* 16. 示例故事基线                                                     */
/* ------------------------------------------------------------------ */

describe('createSampleGraph 基线', () => {
  const report = checkGraph(createSampleGraph(), { now: 0 })

  it('error 0 / warn 3 / info 4（调查报告 C7 与实现报告 §11 的共同预期）', () => {
    expect(report.counts).toEqual({ error: 0, warn: 3, info: 4 })
  })

  it('7 条全是 character-no-card：3 条 warn（≥2 次出场）+ 4 条 info（1 次）', () => {
    expect(report.issues).toHaveLength(7)
    for (const issue of report.issues) expect(issue.rule).toBe('character-no-card')
    expect(report.issues.filter((i) => i.severity === 'warn')).toHaveLength(3)
    expect(report.issues.filter((i) => i.severity === 'info')).toHaveLength(4)
  })

  it('示例图不得命中任何结构性规则（顺序 / 悬空 / 支线收束 / 跳跃 / 缺字段）', () => {
    for (const rule of [
      'flow-reverse',
      'dangling-edge',
      'chapter-duplicate',
      'status-content-mismatch',
      'branch-unclosed',
      'time-jump-unverifiable',
      'orphan-node',
      'missing-time',
      'missing-summary',
      'missing-content',
      'missing-chapter',
      'card-unmounted'
    ]) {
      expect(hits(report, rule), `示例图不应命中 ${rule}`).toHaveLength(0)
    }
  })

  it('示例图不会把 s6→s3 的倒叙边误报为顺序冲突（红线①的真实用例）', () => {
    expect(hits(report, 'flow-reverse')).toHaveLength(0)
    expect(hits(report, 'time-jump-unverifiable')).toHaveLength(0)
  })

  it('byNode 索引覆盖全部出场人物所在节点', () => {
    expect(Object.keys(report.byNode).sort()).toEqual([
      'b1',
      'b2',
      'b3',
      's1',
      's2',
      's3',
      's4',
      's5',
      's6',
      's7',
      's8'
    ])
    expect(issuesForNode(report, 's3').length).toBeGreaterThan(0)
  })
})
