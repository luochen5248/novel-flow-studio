import type { StoryNode } from '@/types/graph'
import { DEFAULT_NODE_W } from './model'

/**
 * 人物卡片的初始落位（纯函数，供所有「新建人物卡」入口调用）
 *
 * 背景：人物卡片（`kind === 'character'`）被 `core/layout.ts` 的 `isLayoutExempt`
 * **永久剔出布局集合**（`layoutTimeline` 里的 `auto` 不包含它），
 * 所以布局永远不会再给它排一次位。创建时若不显式给坐标，
 * 就会落到 `core/model.ts` 的 `createNode` 兜底 (0, 0) ——
 * 于是新建的第 2、3、4… 张人物卡全部叠在同一处，用户得先手动扒开才能用。
 *
 * 修法：创建入口调用 `nextCharacterSlot(nodes)` 取一个「不与现有内容打架的空格子」。
 *
 * ── 落位规则（逐条） ────────────────────────────────────────────────
 *
 * 1) **横向基准 base = 现存所有「非 character 节点」的 max(x + w) + GAP**。
 *    即「主内容（主线 + 全部支线）的最右边缘，再右移一个间距」。
 *    为什么取 max(x+w) 而不是某个写死的常数：
 *      - 支线 lane 是**稀疏且可任意扩展**的（laneGap 默认 320，lane 2 就占到 [506, 774]），
 *        任何写死的 base（哪怕是 560）都会在用户拉出第 2 条以上支线时被压住；
 *      - 人物卡本来就「不归时间线管」，让它永远展开在主内容的**右侧空白区**，
 *        既不会压住主线/支线，也符合「角色牌在旁边一列排开」的直觉；
 *      - 只统计非 character 节点 ⇒ base 不被人物卡自己推着往右跑
 *        （否则每建一张卡基准就右移 300，卡片会一路爬向无穷远）。
 *    GAP = 60 给的只是一个呼吸间隙，不参与 4 列网格的步长。
 *
 * 2) **没有任何非 character 节点时，用 FALLBACK_X = 560 兜底**。
 *    空图（或图里只有人物卡）时 max 无从计算，取一个不与常规内容冲突的起点。
 *
 * 3) **纵向基准固定 BASE_Y = 0**：与主内容起点齐平。
 *    base 已经保证横向不重叠，纵向不必再避让；从第 0 行开始，用户新建后一眼可见。
 *
 * 4) **4 列一行网格错位**：第 n 张卡（n = 已有人物卡数量）落在
 *    `col = n % 4` 列、`row = floor(n / 4)` 行，
 *    `x = base + col * STEP_X`，`y = BASE_Y + row * STEP_Y`。
 *    STEP_X = 300 / STEP_Y = 216 均大于卡片尺寸（宽 196，高最大 208 ——
 *    见 `core/layout.ts` 的 `fitNodeHeight` clamp 上限 208）。
 *    STEP_Y 必须 > 208：取 180 时换行后第二行会与第一行的长卡纵向重叠
 *    （208 - 180 = 28px 叠字），216 = 208 + 8px 呼吸间隙。
 *
 * ── 边界与取舍 ──────────────────────────────────────────────────────
 *  - **避让只针对「主内容」（非 character 节点），不针对已有人物卡**。
 *    横向基准让新卡永远不压住主线 / 支线；但格子序号只按已有 character 卡数量递增，
 *    所以不保证不压住用户手动拖到那片区域的旧人物卡 —— 用户把卡拖走、或删掉中间
 *    某张后，新卡可能落进看起来「空着」的格子。这是刻意的取舍：坐标只是**初始建议值**，
 *    人物卡本来就归用户自由摆放；且基准若把人物卡也算进去，每建一张卡基准就右移 300，
 *    卡片会一路爬向无穷远。
 *  - 因此「人物卡之间互不重叠」只在用户不去手动挪动的前提下成立，
 *    这与「人物卡 = 用户自由摆放」的定位是一致的。
 *  - `w` 缺失（非完整 StoryNode 的测试数据）时回落到 `DEFAULT_NODE_W`，
 *    不引入第二个「默认宽度」魔数。
 *  - 不修改 `createNode` 的默认坐标语义（那会影响其它 kind），只在人物卡入口传坐标。
 */
export const CHARACTER_SLOT_FALLBACK_X = 560
export const CHARACTER_SLOT_GAP = 60
export const CHARACTER_SLOT_BASE_Y = 0
export const CHARACTER_SLOT_STEP_X = 300
export const CHARACTER_SLOT_STEP_Y = 216
export const CHARACTER_SLOT_COLUMNS = 4

/** 单个节点占据的右边缘（x + w；w 缺失时回落到项目默认宽度） */
function rightEdge(node: StoryNode): number {
  return node.x + (node.w || DEFAULT_NODE_W)
}

/**
 * 下一张人物卡片的初始落位（左上角坐标）。
 *
 * @param nodes 当前工作区的全部节点（含非人物卡，函数内部自行筛 `kind === 'character'`）
 * @returns 第 n 张卡（n = 已有人物卡数量）应落的 `{ x, y }`
 *
 * 语义：纯函数、无副作用、只依赖传入数组 —— 便于单测直接覆盖。
 *  - 空数组 / 只有人物卡 ⇒ 横向基准取 `CHARACTER_SLOT_FALLBACK_X`；
 *  - 有主内容 ⇒ 横向基准取「主内容最右边缘 + CHARACTER_SLOT_GAP」。
 */
export function nextCharacterSlot(nodes: StoryNode[]): { x: number; y: number } {
  const characters: StoryNode[] = []
  const others: StoryNode[] = []
  for (const node of nodes) {
    if (node.kind === 'character') characters.push(node)
    else others.push(node)
  }

  const baseX = others.length
    ? Math.max(...others.map(rightEdge)) + CHARACTER_SLOT_GAP
    : CHARACTER_SLOT_FALLBACK_X

  const n = characters.length
  const col = n % CHARACTER_SLOT_COLUMNS
  const row = Math.floor(n / CHARACTER_SLOT_COLUMNS)
  return {
    x: baseX + col * CHARACTER_SLOT_STEP_X,
    y: CHARACTER_SLOT_BASE_Y + row * CHARACTER_SLOT_STEP_Y
  }
}
