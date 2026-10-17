<script setup lang="ts">
import { computed } from 'vue'
import type { GraphSettings, StoryNode } from '@/types/graph'
import { laneAxisMap } from '@/core/layout'
import { isCharacterCard } from './characterCard'

const props = withDefaults(
  defineProps<{
    nodes: StoryNode[]
    settings: GraphSettings
    mode?: 'light' | 'dark'
  }>(),
  { mode: 'light' }
)

interface Rail {
  lane: number
  /** 纵向模式：x；横向模式：y */
  pos: number
  from: number
  to: number
  main: boolean
  tone: 'teal' | 'gold' | 'mist'
  anchors: number[]
  /** 锚点到节点边缘的短须 */
  ticks: Array<{ at: number; from: number; to: number }>
}

const RAIL_OFFSET = 36

/** 轨道配色（与 token 同源，SVG 渐变里不能用 currentColor，故显式给值） */
const RAIL_TONE = {
  teal: '#4dd0d9',
  gold: '#c9a227',
  mist: '#6f9dc0'
} as const

const RAIL_TONES = ['teal', 'gold', 'mist'] as const

const rails = computed<Rail[]>(() => {
  const { laneGap, direction } = props.settings
  const horizontal = direction === 'horizontal'

  // 【人物卡片不画轨道】character 由 `core/layout.ts` 的 `isLayoutExempt` 按 kind
  // 永久剔出布局集合，位置完全归用户自由摆放。若仍按它的 CHARACTER_LANE(100)
  // 画一条轨道，卡片散开后 from/to 会横跨整张画布，轨道被拉成一条穿屏长线。
  // 注意 `laid` 只剔除 character，与 layoutTimeline 里 `laneAxisMap(auto, laneGap)`
  // 的口径差异仅限于 pinned 节点（auto 连 pinned 一并剔除）：若某条 lane 的节点
  // 全部被 pinned，该 lane 仍会占一个轴索引，轨道轴与布局实际落位会错开一个
  // laneGap（既有取舍，非本轮引入，要改需连 filter 一起动、单独评估）。
  // 边界：工作区里只有人物卡时 `laid` 为空 —— 下面的循环自然不执行，
  // `laneAxisMap([])` 也安全返回空 Map，不会出现 NaN / 崩溃。
  const laid = props.nodes.filter((n) => !isCharacterCard(n))
  const axis = laneAxisMap(laid, laneGap)

  const byLane = new Map<number, StoryNode[]>()
  for (const n of laid) {
    const list = byLane.get(n.lane)
    if (list) list.push(n)
    else byLane.set(n.lane, [n])
  }

  const out: Rail[] = []
  for (const [lane, list] of byLane) {
    const lanePos = axis.get(lane) ?? 0
    const half = Math.max(...list.map((n) => (horizontal ? n.h : n.w) / 2))
    // 轨道永远贴在「靠近主线」的那一侧：主线在最左，正 lane 的轨道在其左侧空档里
    const outward = lane >= 0 ? -1 : 1
    const pos = lanePos + outward * (half + RAIL_OFFSET)

    const sorted = [...list].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y))
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    const from = horizontal ? first.x + first.w / 2 : first.y + first.h / 2
    const to = horizontal ? last.x + last.w / 2 : last.y + last.h / 2

    const anchors = sorted.map((n) => (horizontal ? n.x + n.w / 2 : n.y + n.h / 2))
    const ticks = sorted.map((n) => {
      const center = horizontal ? n.x + n.w / 2 : n.y + n.h / 2
      const edge = horizontal ? (outward > 0 ? n.y + n.h : n.y) : outward > 0 ? n.x + n.w : n.x
      return { at: center, from: pos, to: edge }
    })

    out.push({
      lane,
      pos,
      from,
      to,
      main: lane === 0,
      tone: lane === 0 ? 'teal' : lane > 0 ? 'gold' : 'mist',
      anchors,
      ticks
    })
  }
  return out.sort((a, b) => Math.abs(a.lane) - Math.abs(b.lane))
})

function lineOf(r: Rail): { x1: number; y1: number; x2: number; y2: number } {
  const horizontal = props.settings.direction === 'horizontal'
  return horizontal
    ? { x1: r.from - 42, y1: r.pos, x2: r.to + 42, y2: r.pos }
    : { x1: r.pos, y1: r.from - 42, x2: r.pos, y2: r.to + 42 }
}

function anchorPos(r: Rail, at: number): { x: number; y: number } {
  const horizontal = props.settings.direction === 'horizontal'
  return horizontal ? { x: at, y: r.pos } : { x: r.pos, y: at }
}

function tickLine(t: { at: number; from: number; to: number }): {
  x1: number
  y1: number
  x2: number
  y2: number
} {
  const horizontal = props.settings.direction === 'horizontal'
  return horizontal
    ? { x1: t.at, y1: t.from, x2: t.at, y2: t.to }
    : { x1: t.from, y1: t.at, x2: t.to, y2: t.at }
}
</script>

<template>
  <g class="nf-rail" pointer-events="none">
    <!-- 纵向渐变：两端淡、中段实 —— 表达「时间从雾里来、回雾里去」 -->
    <defs>
      <linearGradient
        v-for="tone in RAIL_TONES"
        :id="`nf-rail-grad-${tone}`"
        :key="tone"
        x1="0"
        y1="0"
        x2="0"
        y2="1"
      >
        <stop offset="0%" :stop-color="RAIL_TONE[tone]" stop-opacity="0.12" />
        <stop offset="16%" :stop-color="RAIL_TONE[tone]" stop-opacity="0.8" />
        <stop offset="84%" :stop-color="RAIL_TONE[tone]" stop-opacity="0.8" />
        <stop offset="100%" :stop-color="RAIL_TONE[tone]" stop-opacity="0.12" />
      </linearGradient>
    </defs>

    <g
      v-for="r in rails"
      :key="r.lane"
      :class="['nf-rail__lane', `is-${r.tone}`, { 'is-main': r.main }]"
    >
      <!-- 呼吸光晕：一条更宽更淡的同位置线 -->
      <line class="nf-rail__glow" v-bind="lineOf(r)" />
      <!-- 轨道本体 -->
      <line class="nf-rail__line" :stroke="`url(#nf-rail-grad-${r.tone})`" v-bind="lineOf(r)" />

      <!-- 锚点短须 -->
      <line
        v-for="(t, i) in r.ticks"
        :key="`t${i}`"
        class="nf-rail__tick"
        v-bind="tickLine(t)"
      />

      <!-- 同心圆环锚点：外环淡、内点实 -->
      <template v-for="(at, i) in r.anchors" :key="`a${i}`">
        <circle
          class="nf-rail__ring"
          v-bind="{ ...anchorPos(r, at), r: r.main ? 7.5 : 5.5 }"
        />
        <circle class="nf-rail__core" v-bind="{ ...anchorPos(r, at), r: r.main ? 3 : 2.2 }" />
      </template>
    </g>
  </g>
</template>

<style scoped>
.nf-rail__lane {
  color: var(--nf-mist, #6f9dc0);
}
.nf-rail__lane.is-teal {
  color: var(--nf-teal);
}
.nf-rail__lane.is-gold {
  color: var(--nf-gold);
}
.nf-rail__lane.is-mist {
  color: var(--nf-info);
}

.nf-rail__line {
  stroke: url(#nf-rail-grad);
  stroke-width: 2;
  stroke-linecap: round;
}

.nf-rail__glow {
  stroke: currentColor;
  stroke-width: 9;
  stroke-linecap: round;
  opacity: 0.14;
  filter: blur(4px);
  animation: nf-rail-breathe 6.5s ease-in-out infinite;
}

.nf-rail__lane:not(.is-main) .nf-rail__line {
  stroke-width: 1.5;
  opacity: 0.5;
}
.nf-rail__lane:not(.is-main) .nf-rail__glow {
  animation-duration: 9s;
}

.nf-rail__tick {
  stroke: currentColor;
  stroke-width: 1;
  stroke-linecap: round;
  opacity: 0.22;
}

.nf-rail__ring {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  opacity: 0.5;
}
.nf-rail__core {
  fill: currentColor;
  opacity: 0.95;
}
.nf-rail__lane:not(.is-main) .nf-rail__ring {
  opacity: 0.32;
}
.nf-rail__lane:not(.is-main) .nf-rail__core {
  opacity: 0.6;
}
</style>
