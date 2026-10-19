import { STATUS_LABEL, type FlowGraph, type StoryEdge, type StoryNode } from '@/types/graph'
import { mountedNodes, sameCharacterName } from './characterRename'

/**
 * 时间线一致性检查 —— **纯函数、零依赖**（不碰网络 / store / DOM / localStorage）。
 *
 * 为什么单独成模块：与 layout.ts / characterRename.ts 同形态 —— 入参出参都是普通数据，
 * 规则可以在 jsdom 里逐条断言，改判定不会再「测不到」。UI 只消费产出的报告对象。
 *
 * 【本次范围】仅实现 **13 条纯规则**（冲突 6 + 遗漏 7）。
 * 另有 8 条语义项必须读正文 / 比对知识库，靠规则算不出来，
 * 已在 `CONSISTENCY_RULES` 里以 `needsAi: true` + `enabled: false` 登记占位，供后续接入。
 *
 * 【三条误报红线】（用户 2026-10-19 拍板的「时间字段」口径）
 *  1. `timeLabel` 是自由文本（契约 graph.ts:28-29，全仓 18 处命中全是显示 / 塞提示词，
 *     没有任何解析比较），因此**只做弱年份解析**：两端都抽出年份才比较，
 *     抽不出就跳过 —— 宁可漏报，不可误报。
 *  2. **跨 lane 不比 order**：`order` 是按 lane 分组各自编号的（layout.ts:118/151），
 *     支线与主线的 order 不可比；且示例里 lane=1 支线起点早于主线起点是合法用法。
 *  3. **`flow` 之外的边豁免顺序规则**：`flashback`（倒叙）的本职就是回指更早的事件，
 *     示例 sample.ts:218 的 `s6 → s3` 若参与顺序判定必被误报。
 */

/* ------------------------------------------------------------------ */
/* 一、类型                                                            */
/* ------------------------------------------------------------------ */

/** 严重级：error = 数据性矛盾；warn = 结构未闭合 / 存疑；info = 待补内容 */
export type IssueSeverity = 'error' | 'warn' | 'info'

/** conflict = 字段 / 结构互相矛盾；gap = 该填未填、该连未连 */
export type IssueCategory = 'conflict' | 'gap'

export interface ConsistencyIssue {
  /**
   * 稳定 id：`${rule}:${定位键}` —— 定位键对节点级规则是节点 id、对连线级规则是边 id、
   * 对分组规则是排序后的 `id+id`。UI 折叠 / 增量 diff / 忽略某条都靠它，
   * 因此**不得**包含时间戳或索引等易变量。
   */
  id: string
  /** 规则码，与 `CONSISTENCY_RULES[].id` 对齐 */
  rule: string
  category: IssueCategory
  severity: IssueSeverity
  /** 涉及节点（UI 点击定位用）；悬空连线可能两端都不在图上 ⇒ 允许为空数组 */
  nodeIds: string[]
  /** 人话描述，含具体字段名与具体值 */
  message: string
  /** 涉及连线（连线级规则才有） */
  edgeIds?: string[]
  /** 修复建议 */
  hint?: string
}

export interface ConsistencyRule {
  /** 规则码（即 ConsistencyIssue.rule） */
  id: string
  /** 中文名（UI 开关列表用） */
  label: string
  category: IssueCategory
  /** 默认严重级；`character-no-card` 会按出场次数降级，属唯一例外 */
  severity: IssueSeverity
  /** 是否默认开启 */
  enabled: boolean
  /** true = 需要 LLM 语义判定，本次未实现（`checkGraph` 永不产出这类规则码） */
  needsAi: boolean
  /** 说明（UI 悬浮解释用） */
  desc: string
}

export interface CheckOptions {
  /** 只看这些节点（选中态过滤）；缺省 = 全图。语义 = 只保留**涉及任一选中节点**的问题 */
  nodeIds?: string[]
  /** 关闭的规则码（作者可永久忽略某些规则） */
  disabled?: string[]
  /**
   * 跨 lane 时间冲突开关。**当前 13 条纯规则均不跨 lane 比较**（见文件头红线 2），
   * 故此开关暂不改变输出，仅为后续 AI 语义项（A2 跨 lane 并行冲突）预留。
   */
  crossLane?: boolean
  /** 固定「现在」（单测确定性用；缺省 Date.now()），见 search.ts:19-22 的同一纪律 */
  now?: number
}

export interface ConsistencyReport {
  /** 已排序：严重级 → 规则声明顺序 → id，稳定可复现 */
  issues: ConsistencyIssue[]
  counts: Record<IssueSeverity, number>
  /** 画布角标直接查表：nodeId → 该节点的问题（已按严重级降序） */
  byNode: Record<string, ConsistencyIssue[]>
  checkedAt: number
}

/* ------------------------------------------------------------------ */
/* 二、规则元数据（13 条纯规则 + 8 条 AI 语义占位）                       */
/* ------------------------------------------------------------------ */

/**
 * 规则表 = UI 开关列表 / 说明文案 / 后续接入的唯一事实源。
 * **数组顺序即输出顺序的次级键**，调整顺序会影响 `issues` 的排列（一级键是严重级）。
 */
export const CONSISTENCY_RULES: ConsistencyRule[] = [
  /* —— 冲突类 · 纯规则 6 条 —— */
  {
    id: 'dangling-edge',
    label: '悬空连线',
    category: 'conflict',
    severity: 'error',
    enabled: true,
    needsAi: false,
    desc: '连线的起点或终点指向了不存在的节点。正常操作不会产生，多见于手工改过的导入 JSON。'
  },
  {
    id: 'flow-reverse',
    label: '顺序连线逆序',
    category: 'conflict',
    severity: 'error',
    enabled: true,
    needsAi: false,
    desc: '「顺序」连线说 A 在 B 之前，但同一条 lane 的排列顺序把 B 放到了 A 前面。倒叙 / 跳跃边豁免此规则（它们本就可能回指）。'
  },
  {
    id: 'chapter-duplicate',
    label: '章节号重复',
    category: 'conflict',
    severity: 'error',
    enabled: true,
    needsAi: false,
    desc: '同一个章节号被多个节点占用，导出目录与正文排序都会串。'
  },
  {
    id: 'status-content-mismatch',
    label: '已成稿却无正文',
    category: 'conflict',
    severity: 'error',
    enabled: true,
    needsAi: false,
    desc: '状态标了「已成稿」，正文却是空的 —— 状态与内容自相矛盾。'
  },
  {
    id: 'branch-unclosed',
    label: '支线未收束',
    category: 'conflict',
    severity: 'warn',
    enabled: true,
    needsAi: false,
    desc: '支线（lane ≠ 0）没有任何一条连线汇回主线，读者会不知道这段插叙何时结束。'
  },
  {
    id: 'time-jump-unverifiable',
    label: '跳跃边时间存疑',
    category: 'conflict',
    severity: 'warn',
    enabled: true,
    needsAi: false,
    desc: '倒叙 / 跳跃边缺少故事内时间，无法核对它是否真的回到了过去；或两端年份都写得出来、方向却看着不对。'
  },

  /* —— 遗漏类 · 纯规则 7 条 —— */
  {
    id: 'orphan-node',
    label: '孤立节点',
    category: 'gap',
    severity: 'warn',
    enabled: true,
    needsAi: false,
    desc: '既没有入边也没有出边 —— 还没接进时间线，导出时容易漏掉。'
  },
  {
    id: 'missing-time',
    label: '缺故事内时间',
    category: 'gap',
    severity: 'info',
    enabled: true,
    needsAi: false,
    desc: '没填故事内时间，时间线无法核对先后（UI 上会显示「未标时间」）。'
  },
  {
    id: 'missing-summary',
    label: '缺摘要',
    category: 'gap',
    severity: 'info',
    enabled: true,
    needsAi: false,
    desc: '卡片摘要为空，扫读时看不出这一节讲了什么。'
  },
  {
    id: 'missing-content',
    label: '已开工缺正文',
    category: 'gap',
    severity: 'info',
    enabled: true,
    needsAi: false,
    desc: '状态已不是「待写」，却还没有正文。'
  },
  {
    id: 'missing-chapter',
    label: '缺章节号',
    category: 'gap',
    severity: 'info',
    enabled: true,
    needsAi: false,
    desc: '内容节点没填章节号（人物卡不参与此规则 —— 它不在章节序列里）。'
  },
  {
    id: 'character-no-card',
    label: '出场人物无角色牌',
    category: 'gap',
    severity: 'warn',
    enabled: true,
    needsAi: false,
    desc: '节点里写了出场人物，但图上没有同名的角色牌。被 ≥2 个节点引用才报 warn，只出场一次降级为 info（大概率是路人）。'
  },
  {
    id: 'card-unmounted',
    label: '角色牌未挂载',
    category: 'gap',
    severity: 'info',
    enabled: true,
    needsAi: false,
    desc: '建了角色牌，但没有任何节点在 characters 里写过它的名字 —— 牌与正文是断开的。'
  },

  /* —— AI 语义 8 条：本次**不实现**，仅登记元数据 —— */
  {
    id: 'ai-time-contradiction',
    label: '时序矛盾',
    category: 'conflict',
    severity: 'warn',
    enabled: false,
    needsAi: true,
    desc: '（需 LLM）故事内时间文本与排列顺序、或正文里的时间推进互相打架。'
  },
  {
    id: 'ai-cross-lane',
    label: '跨支线并行冲突',
    category: 'conflict',
    severity: 'warn',
    enabled: false,
    needsAi: true,
    desc: '（需 LLM）同一人物在同一时段出现在不同支线的不同地点。规则召回候选，AI 定罪。'
  },
  {
    id: 'ai-flashback-check',
    label: '倒叙语义核对',
    category: 'conflict',
    severity: 'info',
    enabled: false,
    needsAi: true,
    desc: '（需 LLM）倒叙边的终点是否真的早于起点 —— timeLabel 不可比，只能读正文判定。'
  },
  {
    id: 'ai-character-consistency',
    label: '人物前后不一致',
    category: 'conflict',
    severity: 'info',
    enabled: false,
    needsAi: true,
    desc: '（需 LLM）同一人物的动机 / 性格在不同节点里前后打架。'
  },
  {
    id: 'ai-setting-conflict',
    label: '设定前后不一致',
    category: 'conflict',
    severity: 'warn',
    enabled: false,
    needsAi: true,
    desc: '（需 LLM）正文与知识库里的设定条目打架。规则召回候选，AI 定罪。'
  },
  {
    id: 'ai-unresolved-foreshadow',
    label: '伏笔未回收',
    category: 'gap',
    severity: 'info',
    enabled: false,
    needsAi: true,
    desc: '（需 LLM）标了「伏笔」的节点，后续节点没有呼应。规则召回候选，AI 定罪。'
  },
  {
    id: 'ai-appearance-order',
    label: '出场错位',
    category: 'conflict',
    severity: 'warn',
    enabled: false,
    needsAi: true,
    desc: '（需 LLM）人物在其「退场 / 死亡」之后的节点里仍然出场。规则召回候选，AI 定罪。'
  },
  {
    id: 'ai-pacing',
    label: '结构节奏失衡',
    category: 'gap',
    severity: 'info',
    enabled: false,
    needsAi: true,
    desc: '（需 LLM）里程碑前无抉择、高潮前无铺垫等。弱语义、可争议，建议默认关闭。'
  }
]

/** 规则码 → 声明序号（输出排序的次级键） */
const RULE_ORDER = new Map<string, number>(CONSISTENCY_RULES.map((r, i) => [r.id, i]))
/** 规则码 → 元数据（取 category 用） */
const RULE_MAP = new Map<string, ConsistencyRule>(CONSISTENCY_RULES.map((r) => [r.id, r]))

/**
 * 「出场人物无角色牌」的分级阈值：被 ≥2 个节点引用才升级为 warn。
 * 为什么是 2：示例故事（sample.ts，11 个内容节点）里 7 个名字会一次报满，
 * 全按 warn 报的话新用户第一眼就是满屏告警；只出场一次的大概率是路人，降为 info。
 */
const CHARACTER_WARN_MIN_REFS = 2

/* ------------------------------------------------------------------ */
/* 三、小工具（防御式取值 / 排序 / 弱年份解析）                          */
/* ------------------------------------------------------------------ */

/** 字段可能来自导入 JSON，一律按 unknown 取值后再收窄（同 search.ts:33/95-99 的防御口径） */
function textOf(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function trimmedOf(v: unknown): string {
  return textOf(v).trim()
}

function stringsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((i): i is string => typeof i === 'string') : []
}

/**
 * 人物卡判定：**数据层口径 `kind === 'character'`**。
 *
 * 为什么不用 components 层的 `CHARACTER_LANE`（characterCard.ts:29 = 100）：
 * 一是 core 反向依赖 components 会破坏分层（现有 core 模块都没有这么做）；
 * 二是 lane 号只是摆放位置，作者完全可能把一张事件卡拖到 lane 100，
 * 那它依然是事件卡、依然要参与时间线规则 —— 按 kind 判才不会误伤。
 * 与 layout.ts:34-36 的 `isLayoutExempt` 对人物卡的认定同源。
 */
function isCharacterCard(node: StoryNode): boolean {
  return node.kind === 'character'
}

/** 排序键（lane → order → id）：与 aiPrompt.ts:163-165 / layout.ts:75-77 同口径，不另发明 */
function byLaneOrderId(a: StoryNode, b: StoryNode): number {
  return a.lane - b.lane || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 中文数字 → 数值；「元」按 1 处理（元年 = 1）。解析不了返回 NaN */
const CN_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  元: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9
}

function parseCnNumber(raw: string): number {
  if (!raw) return Number.NaN
  // 含「十」⇒ 十进位写法：十二 = 12、十 = 10、二十 = 20
  const tenAt = raw.indexOf('十')
  if (tenAt >= 0) {
    const head = raw.slice(0, tenAt)
    const tail = raw.slice(tenAt + 1)
    const tens = head ? CN_DIGITS[head] : 1
    const ones = tail ? CN_DIGITS[tail] : 0
    if (tens === undefined || ones === undefined) return Number.NaN
    return tens * 10 + ones
  }
  // 逐位拼十进制：「二零二六」→ 2026、「元」→ 1
  let out = 0
  for (const ch of raw) {
    const d = CN_DIGITS[ch]
    if (d === undefined) return Number.NaN
    out = out * 10 + d
  }
  return out
}

/** 弱年份：4 位阿拉伯年份，或「X年」的中文写法（含「元年」「三年后」） */
const YEAR_RE = /([0-9]{1,4}|[零一二两三四五六七八九十元]{1,4})\s*年/

/**
 * 从 `timeLabel` 里**弱提取**年份；抽不出返回 null。
 *
 * 为什么只做「弱」：`timeLabel` 是裸字符串、无格式约定，示例数据里就混了
 * 「宣和三年 · 深秋 / 十月初二 / 春 / 冬」四种粒度。
 * 因此调用方必须遵守「**两端都抽出年份才比较，抽不出就跳过**」——
 * 宁可漏报，绝不能把「春」和「三年后」比出一个伪冲突。
 */
function parseYearLabel(label: unknown): number | null {
  const m = YEAR_RE.exec(textOf(label))
  if (!m) return null
  const raw = m[1]
  const n = /^[0-9]+$/.test(raw) ? Number(raw) : parseCnNumber(raw)
  return typeof n === 'number' && Number.isFinite(n) && !Number.isNaN(n) ? n : null
}

function emptyReport(now: number): ConsistencyReport {
  return { issues: [], counts: { error: 0, warn: 0, info: 0 }, byNode: {}, checkedAt: now }
}

/** 严重级排序权重（UI 列表与 byNode 共用，避免两边写岔） */
export function severityRank(s: IssueSeverity): number {
  return s === 'error' ? 0 : s === 'warn' ? 1 : 2
}

function makeIssue(
  rule: string,
  severity: IssueSeverity,
  nodeIds: string[],
  message: string,
  extra?: { edgeIds?: string[]; hint?: string }
): ConsistencyIssue {
  const meta = RULE_MAP.get(rule)
  const issue: ConsistencyIssue = {
    id: `${rule}:${nodeIds.length ? nodeIds.join('+') : (extra?.edgeIds?.[0] ?? '')}`,
    rule,
    category: meta?.category ?? 'conflict',
    severity,
    nodeIds,
    message
  }
  if (extra?.edgeIds?.length) issue.edgeIds = [...extra.edgeIds]
  if (extra?.hint) issue.hint = extra.hint
  return issue
}

/* ------------------------------------------------------------------ */
/* 四、主入口                                                          */
/* ------------------------------------------------------------------ */

/**
 * 全图一致性检查（纯函数，不修改入参；graph 为空 / 结构缺失时返回空报告）。
 *
 * 复杂度：O(n + e) 建索引 + 每规则一次线性扫描 + 一次排序 ⇒ 百节点量级可忽略。
 */
export function checkGraph(
  graph: FlowGraph | null | undefined,
  options: CheckOptions = {}
): ConsistencyReport {
  const now = options.now ?? Date.now()
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return emptyReport(now)
  return checkNodes(graph.nodes, graph.edges, { ...options, now })
}

/**
 * 只传数组的版本：单测 fixture 与「只算一部分」场景用，不依赖 FlowGraph 包装。
 */
export function checkNodes(
  nodes: StoryNode[],
  edges: StoryEdge[],
  options: CheckOptions = {}
): ConsistencyReport {
  const now = options.now ?? Date.now()
  const nodeList = Array.isArray(nodes) ? nodes : []
  const edgeList = Array.isArray(edges) ? edges : []
  if (!nodeList.length && !edgeList.length) return emptyReport(now)

  const nodeById = new Map<string, StoryNode>()
  for (const n of nodeList) if (n && typeof n.id === 'string' && n.id) nodeById.set(n.id, n)

  // 出入度：一次 O(e) 建索引（不照抄 model.ts:116/120 的逐次 filter，那是 O(n·e)）
  const hasOut = new Set<string>()
  const hasIn = new Set<string>()
  for (const e of edgeList) {
    if (!e || typeof e.source !== 'string' || typeof e.target !== 'string') continue
    hasOut.add(e.source)
    hasIn.add(e.target)
  }

  const issues: ConsistencyIssue[] = []
  const push = (i: ConsistencyIssue): void => {
    issues.push(i)
  }

  /* ---------------- C1 悬空连线（error） ---------------- */
  // 为什么单独一条：sanitizeEdge 只在新导入时兜底（model.ts:192-197），
  // 手工改过的 JSON / 老版本存档仍可能残留，留着会让下游规则读到 undefined 端点。
  for (const e of edgeList) {
    if (!e || typeof e.source !== 'string' || typeof e.target !== 'string') continue
    const missing: string[] = []
    const present: string[] = []
    if (!nodeById.has(e.source)) missing.push(e.source)
    else present.push(e.source)
    if (!nodeById.has(e.target)) missing.push(e.target)
    else present.push(e.target)
    if (!missing.length) continue
    push(
      makeIssue(
        'dangling-edge',
        'error',
        present,
        `连线指向了不存在的节点：${missing.map((id) => `「${id}」`).join('、')}`,
        {
          edgeIds: [e.id],
          hint: '删掉这条连线，或改成连到图上已有的节点。'
        }
      )
    )
  }

  /* ---------------- C2 顺序连线逆序（error） ---------------- */
  // 只对 kind === 'flow' 生效：flashback 的本职就是回指更早事件（sample.ts:218 的 s6 → s3），
  // jump 没有强制语义（示例里根本没用过），两者都不得参与顺序判定，否则必误报。
  // 且要求两端同 lane —— 跨 lane 的 order 是各自编号的，不可比（layout.ts:118/151）。
  for (const e of edgeList) {
    if (!e || e.kind !== 'flow') continue
    const src = nodeById.get(e.source)
    const dst = nodeById.get(e.target)
    if (!src || !dst) continue // 端点缺失属 C1，此处不重复报
    if (isCharacterCard(src) || isCharacterCard(dst)) continue // 人物卡的 order 被布局豁免，无时序意义
    if (src.lane !== dst.lane) continue
    if (src.order <= dst.order) continue
    push(
      makeIssue(
        'flow-reverse',
        'error',
        [src.id, dst.id],
        `「顺序」连线方向与排列顺序相反：「${src.title}」（第 ${src.order + 1} 位）→ 「${dst.title}」（第 ${dst.order + 1} 位）`,
        {
          edgeIds: [e.id],
          hint: '拖动节点调整顺序，或把这条边改成「倒叙」—— 倒叙边允许回指更早的事件。'
        }
      )
    )
  }

  /* ---------------- C3 章节号重复（error） ---------------- */
  // 只统计非人物卡：人物卡不在章节序列里（与 G5 的豁免同口径）。
  // 空章节号不参与（那是 G5 的活），避免同一批节点被两条规则重复报。
  const chapterGroups = new Map<string, string[]>()
  for (const n of nodeList) {
    if (!n || isCharacterCard(n)) continue
    const chapter = trimmedOf(n.chapter)
    if (!chapter) continue
    const list = chapterGroups.get(chapter)
    if (list) list.push(n.id)
    else chapterGroups.set(chapter, [n.id])
  }
  for (const [chapter, ids] of chapterGroups) {
    if (ids.length < 2) continue
    const sorted = [...ids].sort(compareId)
    push(
      makeIssue(
        'chapter-duplicate',
        'error',
        sorted,
        `章节号「${chapter}」被 ${sorted.length} 个节点重复使用：${sorted.join('、')}`,
        { hint: '给其中一个换章节号，或确认它们本就是同一章的不同视角。' }
      )
    )
  }

  /* ---------------- C4 已成稿却无正文（error） ---------------- */
  for (const n of nodeList) {
    if (!n) continue
    if (n.status !== 'done') continue
    if (trimmedOf(n.content)) continue
    push(
      makeIssue(
        'status-content-mismatch',
        'error',
        [n.id],
        `「${n.title}」已标记为「${STATUS_LABEL.done}」，但正文是空的`,
        { hint: '补上正文，或把状态改回「草稿」。' }
      )
    )
  }

  /* ---------------- C5 支线未收束（warn） ---------------- */
  // 支线 lane：含非人物卡节点、且 lane !== 0。
  // 用 kind 剔除人物卡而不是硬编码 lane !== 100 —— 与文件头的口径一致，
  // 同时避免「作者把事件卡拖到 lane 100」这种合法摆放被误判成人物道。
  const laneGroups = new Map<number, StoryNode[]>()
  for (const n of nodeList) {
    if (!n || isCharacterCard(n) || n.lane === 0) continue
    const list = laneGroups.get(n.lane)
    if (list) list.push(n)
    else laneGroups.set(n.lane, [n])
  }
  for (const [lane, rawMembers] of laneGroups) {
    const members = [...rawMembers].sort(byLaneOrderId)
    const memberIds = new Set(members.map((n) => n.id))
    // 汇回判定：任一条「支线 → 主线(lane 0 的非人物卡)」的边都算收束，不限 kind
    const closed = edgeList.some((e) => {
      if (!e || !memberIds.has(e.source)) return false
      const dst = nodeById.get(e.target)
      return !!dst && dst.lane === 0 && !isCharacterCard(dst)
    })
    if (closed) continue
    // 末端节点 = 该 lane 内没有任何出边的节点；极端情况（支线互连成环）退化为整条 lane
    const terminals = members.filter((n) => !hasOut.has(n.id))
    const targets = terminals.length ? terminals : members
    push(
      makeIssue(
        'branch-unclosed',
        'warn',
        targets.map((n) => n.id),
        `第 ${lane} 列支线没有汇回主线：${targets.map((n) => `「${n.title}」`).join('、')}`,
        { hint: '从支线末端连一条边到主线节点（一般用「分支」），读者才知道这段插叙何时结束。' }
      )
    )
  }

  /* ---------------- C6 跳跃边时间存疑（warn） ---------------- */
  for (const e of edgeList) {
    if (!e || (e.kind !== 'flashback' && e.kind !== 'jump')) continue
    const src = nodeById.get(e.source)
    const dst = nodeById.get(e.target)
    if (!src || !dst) continue // 端点缺失属 C1

    // 6a 两端任一没写故事内时间 ⇒ 完全无法核对它是否真的跳到了过去。
    // 文案只说「无法核对」、不说「冲突」—— 缺信息 ≠ 有错。
    if (!trimmedOf(src.timeLabel) || !trimmedOf(dst.timeLabel)) {
      push(
        makeIssue(
          'time-jump-unverifiable',
          'warn',
          [src.id, dst.id],
          `「${e.kind === 'flashback' ? '倒叙' : '跳跃'}」连线有一端没写故事内时间，无法核对跳跃方向：「${src.title}」→「${dst.title}」`,
          {
            edgeIds: [e.id],
            hint: '给两端补上故事内时间（如「宣和三年 · 深秋」），才能真正核对这条线跳去了哪里。'
          }
        )
      )
      continue
    }

    // 6b 弱年份解析：**两端都能抽出年份才比较**，抽不出就跳过（不误报）。
    // 且只核对 flashback —— jump 没有强制语义（示例数据里根本没用过），不拿它当判据。
    if (e.kind !== 'flashback') continue
    const srcYear = parseYearLabel(src.timeLabel)
    const dstYear = parseYearLabel(dst.timeLabel)
    if (srcYear === null || dstYear === null) continue
    if (dstYear <= srcYear) continue
    push(
      makeIssue(
        'time-jump-unverifiable',
        'warn',
        [src.id, dst.id],
        `倒叙连线疑似方向不对：「${src.title}」（${src.timeLabel}）→「${dst.title}」（${dst.timeLabel}），终点看起来更晚`,
        {
          edgeIds: [e.id],
          hint: '确认这条边是不是该用「顺序」或「跳跃」；若确实是回到更早的场景，请核对两端的年份标注。'
        }
      )
    )
  }

  /* ---------------- G1 孤立节点（warn） ---------------- */
  // 人物卡豁免：它本来就是钉在保留道上的设定卡，不进时间线（layout 对它永久豁免）。
  for (const n of nodeList) {
    if (!n || isCharacterCard(n)) continue
    if (hasIn.has(n.id) || hasOut.has(n.id)) continue
    push(
      makeIssue('orphan-node', 'warn', [n.id], `「${n.title}」既没有入边也没有出边，还没接进时间线`, {
        hint: '把它连进主线或支线；若只是暂存的素材，建议先删掉以免导出时漏看。'
      })
    )
  }

  /* ---------------- G2 / G3 / G4 / G5 空字段（info） ---------------- */
  for (const n of nodeList) {
    if (!n) continue
    // G2 缺故事内时间：**人物卡豁免** —— 人物卡描述的是「谁」而不是「何时」，
    // 它压根没有时点可填，报了是纯噪音；缺描述（G3）才是人物卡的真缺口，故不豁免 G3。
    if (!isCharacterCard(n) && !trimmedOf(n.timeLabel)) {
      push(
        makeIssue('missing-time', 'info', [n.id], `「${n.title}」没写故事内时间`, {
          hint: '填上如「宣和三年 · 深秋」的时间标注，时间线才能核对先后。'
        })
      )
    }
    if (!trimmedOf(n.summary)) {
      push(makeIssue('missing-summary', 'info', [n.id], `「${n.title}」没写摘要`, { hint: '一两句话概括这一节，扫读时才看得出讲了什么。' }))
    }
    // G4 只在「已开工」时报：待写节点本来就没正文，报了就是噪音
    if (n.status !== 'planned' && !trimmedOf(n.content)) {
      push(
        makeIssue(
          'missing-content',
          'info',
          [n.id],
          `「${n.title}」状态是「${STATUS_LABEL[n.status] ?? n.status}」，但还没有正文`,
          { hint: '补正文，或把状态改回「待写」。' }
        )
      )
    }
    // G5 缺章节号：人物卡豁免（它不在章节序列里）
    if (!isCharacterCard(n) && !trimmedOf(n.chapter)) {
      push(makeIssue('missing-chapter', 'info', [n.id], `「${n.title}」没填章节号`, { hint: '填上章节号，导出目录与正文排序才不会串。' }))
    }
  }

  /* ---------------- G6 出场人物无角色牌（warn / info） ---------------- */
  // 人物名匹配**复用** sameCharacterName（characterRename.ts:33）：
  // 那是全仓唯一口径（trim 后比较、大小写敏感），另写一份就是双份实现。
  const cardTitles = nodeList.filter((n) => n && isCharacterCard(n)).map((n) => n.title)
  const nameRefs = new Map<string, { name: string; nodeIds: string[] }>()
  for (const n of nodeList) {
    if (!n) continue
    const seen = new Set<string>()
    for (const raw of stringsOf(n.characters)) {
      const name = trimmedOf(raw)
      if (!name || seen.has(name)) continue // 同一节点里写两次只算一次出场
      seen.add(name)
      const rec = nameRefs.get(name) ?? { name, nodeIds: [] }
      rec.nodeIds.push(n.id)
      nameRefs.set(name, rec)
    }
  }
  for (const rec of nameRefs.values()) {
    if (cardTitles.some((t) => sameCharacterName(t, rec.name))) continue
    const nodeIds = [...rec.nodeIds].sort(compareId)
    const severe = nodeIds.length >= CHARACTER_WARN_MIN_REFS
    push(
      makeIssue(
        'character-no-card',
        severe ? 'warn' : 'info',
        nodeIds,
        severe
          ? `出场人物「${rec.name}」在 ${nodeIds.length} 个节点出现，但图上没有同名的角色牌`
          : `出场人物「${rec.name}」没有对应的角色牌（只出现 1 次，可能是路人）`,
        { hint: '在工具栏新建一张人物卡、名字写一致，即可自动挂载到这些节点。' }
      )
    )
  }

  /* ---------------- G7 角色牌未挂载（info） ---------------- */
  // 挂载统计复用 mountedNodes（characterRename.ts:42-46），与 chip 统计 / 视口定位同口径。
  for (const n of nodeList) {
    if (!n || !isCharacterCard(n)) continue
    if (mountedNodes(nodeList, n).length) continue
    push(
      makeIssue('card-unmounted', 'info', [n.id], `角色牌「${n.title}」还没挂到任何节点`, {
        hint: '在节点的出场人物里写上这个名字，牌与正文才算连起来。'
      })
    )
  }

  /* ---------------- 过滤 ---------------- */
  const disabled = new Set(options.disabled ?? [])
  const scope = options.nodeIds?.length ? new Set(options.nodeIds) : null
  const kept = issues.filter((i) => {
    if (disabled.has(i.rule)) return false
    // 只看选中节点：保留**涉及任一选中节点**的问题（分组规则也按此口径，不做组内再切分）
    if (scope && !i.nodeIds.some((id) => scope.has(id))) return false
    return true
  })

  /* ---------------- 排序（稳定可复现，否则 UI 列表会抖） ---------------- */
  kept.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      (RULE_ORDER.get(a.rule) ?? 999) - (RULE_ORDER.get(b.rule) ?? 999) ||
      compareId(a.id, b.id) ||
      compareId(a.message, b.message)
  )

  const counts: Record<IssueSeverity, number> = { error: 0, warn: 0, info: 0 }
  for (const i of kept) counts[i.severity] += 1

  return { issues: kept, counts, byNode: indexIssuesByNode(kept), checkedAt: now }
}

/* ------------------------------------------------------------------ */
/* 五、索引辅助                                                        */
/* ------------------------------------------------------------------ */

/**
 * 把问题数组建成 nodeId → issues 索引（画布角标用）。
 * 入参已按严重级降序 ⇒ 每个节点的问题列表天然也是严重级降序。
 */
export function indexIssuesByNode(issues: ConsistencyIssue[]): Record<string, ConsistencyIssue[]> {
  const out: Record<string, ConsistencyIssue[]> = {}
  if (!Array.isArray(issues)) return out
  for (const issue of issues) {
    for (const id of issue.nodeIds) {
      const list = out[id]
      if (list) list.push(issue)
      else out[id] = [issue]
    }
  }
  return out
}

/** 只取与某节点相关的问题（AI 注入按节点过滤用，避免给节点 A 塞节点 B 的问题） */
export function issuesForNode(report: ConsistencyReport, nodeId: string): ConsistencyIssue[] {
  if (!report || !nodeId) return []
  return report.byNode[nodeId] ?? []
}
