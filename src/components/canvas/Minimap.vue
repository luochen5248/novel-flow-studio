<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Rect, StoryNode } from '@/types/graph'
import { boundsOf } from '@/core/geometry'
import { isCharacterCard } from './characterCard'

const props = withDefaults(
  defineProps<{
    nodes: StoryNode[]
    viewBox: Rect
    width?: number
    height?: number
  }>(),
  { width: 190, height: 118 }
)

const emit = defineEmits<{ (e: 'jump', x: number, y: number): void }>()

const PAD = 10

const world = computed<Rect>(() => boundsOf(props.nodes, 60) ?? { x: -400, y: -100, w: 800, h: 600 })

/** 等比缩放：把 world 塞进小地图 */
const fit = computed(() => {
  const k = Math.min(
    (props.width - PAD * 2) / (world.value.w || 1),
    (props.height - PAD * 2) / (world.value.h || 1)
  )
  const ox = PAD + ((props.width - PAD * 2) - world.value.w * k) / 2
  const oy = PAD + ((props.height - PAD * 2) - world.value.h * k) / 2
  return { k, ox, oy }
})

function project(p: { x: number; y: number }): { x: number; y: number } {
  const { k, ox, oy } = fit.value
  return { x: (p.x - world.value.x) * k + ox, y: (p.y - world.value.y) * k + oy }
}

const nodesView = computed(() =>
  props.nodes.map((n) => {
    const p = project({ x: n.x, y: n.y })
    return {
      id: n.id,
      x: p.x,
      y: p.y,
      w: Math.max(3, n.w * fit.value.k),
      h: Math.max(2, n.h * fit.value.k),
      lane: n.lane,
      // 人物卡片既不画时间轨道也不归支线：它按 kind 永久豁免布局，
      // 落位与 lane 号无关。染成支线金色会误导用户以为它属于某条支线。
      char: isCharacterCard(n)
    }
  })
)

const viewportRect = computed(() => {
  const p = project({ x: props.viewBox.x, y: props.viewBox.y })
  return { x: p.x, y: p.y, w: props.viewBox.w * fit.value.k, h: props.viewBox.h * fit.value.k }
})

const el = ref<SVGSVGElement | null>(null)

function onDown(e: PointerEvent): void {
  const move = (ev: PointerEvent) => jumpTo(ev)
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  jumpTo(e)
}

function jumpTo(e: PointerEvent): void {
  const svg = el.value
  if (!svg) return
  const r = svg.getBoundingClientRect()
  const mx = ((e.clientX - r.left) / r.width) * props.width
  const my = ((e.clientY - r.top) / r.height) * props.height
  const { k, ox, oy } = fit.value
  emit('jump', (mx - ox) / k + world.value.x, (my - oy) / k + world.value.y)
}
</script>

<template>
  <div class="nf-minimap">
    <svg
      ref="el"
      :width="width"
      :height="height"
      :viewBox="`0 0 ${width} ${height}`"
      @pointerdown="onDown"
    >
      <rect class="nf-minimap__bg" :width="width" :height="height" rx="12" />
      <rect
        v-for="n in nodesView"
        :key="n.id"
        class="nf-minimap__node"
        :class="{ 'is-branch': n.lane !== 0 && !n.char, 'is-character': n.char }"
        :x="n.x"
        :y="n.y"
        :width="n.w"
        :height="n.h"
        rx="2.5"
      />
      <rect
        class="nf-minimap__viewport"
        :x="viewportRect.x"
        :y="viewportRect.y"
        :width="viewportRect.w"
        :height="viewportRect.h"
        rx="4"
      />
    </svg>
    <span class="nf-minimap__caption">缩略图</span>
  </div>
</template>

<style scoped>
.nf-minimap {
  position: absolute;
  right: 18px;
  bottom: 18px;
  padding: 6px 6px 2px;
  border-radius: 14px;
  background: rgba(19, 28, 38, 0.92);
  border: 1px solid var(--nf-shell-line);
  box-shadow: var(--nf-shadow-panel);
  backdrop-filter: blur(8px);
  user-select: none;
}

.nf-minimap svg {
  display: block;
  cursor: crosshair;
}

.nf-minimap__bg {
  fill: rgba(15, 23, 32, 0.72);
}

.nf-minimap__node {
  fill: rgba(77, 208, 217, 0.65);
}
.nf-minimap__node.is-branch {
  fill: rgba(201, 162, 39, 0.68);
}
/* 人物卡片：clay 色系（与卡片本体 --nf-node-clay-bar 同源），不按 lane 染支线金 */
.nf-minimap__node.is-character {
  fill: rgba(192, 138, 110, 0.72);
}

.nf-minimap__viewport {
  fill: rgba(232, 238, 244, 0.06);
  stroke: var(--nf-teal);
  stroke-width: 1;
  pointer-events: none;
}

.nf-minimap__caption {
  display: block;
  text-align: center;
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--nf-on-dark-faint);
  padding-bottom: 3px;
}
</style>
