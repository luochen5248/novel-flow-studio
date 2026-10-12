import type { StoryNode } from '@/types/graph'

/**
 * 人物改名 / 挂载关系的**纯决策层**（planner）。
 *
 * 为什么单独成模块：这套规则原先住在 FlowCanvas.vue 的 onRenameCharacter 里，
 * 既读 store 又做判断，单测必须挂整个 Pinia 实例才能覆盖边界。
 * 抽成「入参出参均为普通数据」的纯函数后，jsdom 里可直接逐条断言
 * （重名拒绝、空名拒绝、容忍空白、级联换名、去重），改规则不会再「测不到」。
 *
 * 命名口径：人物名是**字符串**存在各节点 `characters` 数组里的，没有独立角色实体。
 * 因此「谁是这张牌的挂载点」只能按名字反查 —— 本模块是全仓这件事的**唯一**口径，
 * chip 统计、视口定位、级联收集三处共用，消灭双份实现。
 */

export type RenameRejection = 'no-card' | 'empty-name' | 'clash' | 'unchanged'

export interface RenameMount {
  nodeId: string
  /** 改名 + 去重后的 characters 数组，store 直接应用 */
  characters: string[]
}

export type RenamePlan =
  | { ok: false; reason: RenameRejection }
  | { ok: true; cardId: string; prev: string; next: string; mounts: RenameMount[] }

/**
 * 人物名匹配：**大小写敏感**（系统一贯语义，审查明确裁决不做模糊匹配），
 * 但**容忍前后空白** —— aiApi 建节点路径曾透传未 trim 的名字（Vic 实测 '沈青 ' 残留），
 * 若此处不容忍，那种名字永远匹配不上，会静默丢挂载关系。
 */
export function sameCharacterName(a: string, b: string): boolean {
  return a.trim() === b.trim()
}

/**
 * 该角色牌当前挂载的全部节点（按名字口径，不含自身）。
 *
 * chip 统计、视口定位、级联收集共用此谓词 —— 这是本模块存在的核心理由。
 */
export function mountedNodes(nodes: StoryNode[], card: StoryNode): StoryNode[] {
  return nodes.filter(
    (n) => n.id !== card.id && n.characters.some((c) => sameCharacterName(c, card.title))
  )
}

/**
 * 角色牌改名决策。
 *
 * 规则（与抽离前 FlowCanvas.onRenameCharacter 逐条对齐）：
 *  - 空名（trim 后）→ 拒绝
 *  - 找不到卡片 → 拒绝
 *  - 名字没变 → 拒绝（不写历史）
 *  - 与**另一张角色牌**同名 → 拒绝（否则两张牌共用一个名字，mountCount 统计会串）
 *  - 否则：收集所有引用了旧名的节点，算出换名 + 去重后的 characters
 *
 * 两处相对原实现的刻意变化：
 *  1. 匹配容忍前后空白（`sameCharacterName`）—— 见上方注释；
 *  2. 调用方负责决定 merge key（见 store），本函数不碰历史。
 *
 * @param nodes 全图节点（只读）
 * @param cardId 被改名的角色牌 id
 * @param rawNext 用户输入的新名字（未 trim）
 */
export function planCharacterRename(
  nodes: StoryNode[],
  cardId: string,
  rawNext: string
): RenamePlan {
  const next = rawNext.trim()
  if (!next) return { ok: false, reason: 'empty-name' }
  const card = nodes.find((n) => n.id === cardId)
  if (!card) return { ok: false, reason: 'no-card' }
  const prev = card.title
  if (prev === next) return { ok: false, reason: 'unchanged' }

  // 只与「另一张角色牌」重名才算冲突：characters 里也可能有没有牌的名字
  // （用户在检查器手打的、AI 写入的），那些不是角色牌、不该阻塞改名。
  const clash = nodes.some(
    (n) => n.id !== cardId && n.kind === 'character' && n.title === next
  )
  if (clash) return { ok: false, reason: 'clash' }

  const mounts: RenameMount[] = nodes
    .filter((n) => n.id !== cardId && n.characters.some((c) => sameCharacterName(c, prev)))
    .map((n) => ({
      nodeId: n.id,
      // 去重：rename 到该节点已存在的新名时会产生重复项
      characters: [...new Set(n.characters.map((c) => (sameCharacterName(c, prev) ? next : c)))]
    }))
  return { ok: true, cardId, prev, next, mounts }
}
