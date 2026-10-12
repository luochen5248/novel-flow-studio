<script setup lang="ts">
import { computed, ref } from 'vue'
import type { EdgeKind, GraphSettings, StoryEdge, StoryNode } from '@/types/graph'
import { buildEdgeGeom } from '@/core/geometry'

const props = withDefaults(
  defineProps<{
    edges: StoryEdge[]
    nodes: StoryNode[]
    settings: GraphSettings
    selectedId?: string | null
    mode?: 'light' | 'dark'
  }>(),
  { selectedId: null, mode: 'light' }
)

const emit = defineEmits<{
  (e: 'select', id: string): void
  (e: 'remove', id: string): void
  (e: 'insert-between', id: string): void
  (e: 'reconnect-start', evt: PointerEvent, id: string, end: 'source' | 'target'): void
}>()

const hoverId = ref<string | null>(null)

const nodeMap = computed(() => new Map(props.nodes.map((n) => [n.id, n])))

interface Rendered {
  edge: StoryEdge
  d: string
  mid: { x: number; y: number }
  start: { x: number; y: number }
  end: { x: number; y: number }
  kind: EdgeKind
}

const rendered = computed<Rendered[]>(() => {
  const out: Rendered[] = []
  for (const edge of props.edges) {
    const s = nodeMap.value.get(edge.source)
    const t = nodeMap.value.get(edge.target)
    if (!s || !t) continue
    const geom = buildEdgeGeom(s, t, edge.kind, { direction: props.settings.direction })
    out.push({
      edge,
      d: geom.d,
      mid: geom.mid,
      start: geom.start,
      end: geom.end,
      kind: edge.kind
    })
  }
  return out
})

const STROKE: Record<EdgeKind, string> = {
  flow: 'url(#nf-edge-flow)',
  branch: 'url(#nf-edge-branch)',
  flashback: 'url(#nf-edge-flash)',
  jump: 'url(#nf-edge-jump)'
}

const MARKER: Record<EdgeKind, string> = {
  flow: 'nf-arrow-flow',
  branch: 'nf-arrow-branch',
  flashback: 'nf-arrow-flash',
  jump: 'nf-arrow-jump'
}
</script>

<template>
  <g class="nf-edges">
    <defs>
      <!-- 纵向渐变：上深下浅，读起来像时间往下流 -->
      <linearGradient id="nf-edge-flow" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#2aa6b0" />
        <stop offset="100%" stop-color="#7fdde3" />
      </linearGradient>
      <linearGradient id="nf-edge-branch" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#a9881d" />
        <stop offset="100%" stop-color="#dcc072" />
      </linearGradient>
      <linearGradient id="nf-edge-jump" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#5b87a8" />
        <stop offset="100%" stop-color="#9dbdd6" />
      </linearGradient>
      <!-- 倒叙：降饱和的青灰 -->
      <linearGradient id="nf-edge-flash" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#8fa3ab" />
        <stop offset="100%" stop-color="#b7c6cd" />
      </linearGradient>

      <!-- 圆润三角箭头：不要细长针状 -->
      <marker
        v-for="m in [
          { id: 'nf-arrow-flow', color: '#2aa6b0' },
          { id: 'nf-arrow-branch', color: '#a9881d' },
          { id: 'nf-arrow-jump', color: '#5b87a8' },
          { id: 'nf-arrow-flash', color: '#8fa3ab' }
        ]"
        :id="m.id"
        :key="m.id"
        viewBox="0 0 12 12"
        markerWidth="13"
        markerHeight="13"
        refX="9.4"
        refY="6"
        markerUnits="userSpaceOnUse"
        orient="auto"
      >
        <path
          d="M2.3 2.5 Q8.4 5.3 9.5 6 Q8.4 6.7 2.3 9.5 Q1.5 6 2.3 2.5 Z"
          :fill="m.color"
        />
      </marker>
      <!-- 倒叙的反向箭头（挂在起点） -->
      <marker
        id="nf-arrow-flash-start"
        viewBox="0 0 12 12"
        markerWidth="12"
        markerHeight="12"
        refX="9.4"
        refY="6"
        markerUnits="userSpaceOnUse"
        orient="auto-start-reverse"
      >
        <path d="M2.3 2.5 Q8.4 5.3 9.5 6 Q8.4 6.7 2.3 9.5 Q1.5 6 2.3 2.5 Z" fill="#8fa3ab" />
      </marker>
    </defs>

    <g
      v-for="item in rendered"
      :key="item.edge.id"
      :class="[
        'nf-edge',
        `is-${item.kind}`,
        {
          'is-hover': hoverId === item.edge.id,
          'is-selected': selectedId === item.edge.id
        }
      ]"
      @pointerenter="hoverId = item.edge.id"
      @pointerleave="hoverId = null"
    >
      <!-- 加宽的透明命中区，细线也好点 -->
      <path
        class="nf-edge__hit"
        :d="item.d"
        @pointerdown.stop="emit('select', item.edge.id)"
        @dblclick.stop="emit('insert-between', item.edge.id)"
      />

      <path
        class="nf-edge__line"
        :d="item.d"
        :stroke="STROKE[item.kind]"
        :marker-end="item.kind === 'flashback' ? undefined : `url(#${MARKER[item.kind]})`"
        :marker-start="item.kind === 'flashback' ? 'url(#nf-arrow-flash-start)' : undefined"
      />

      <text
        v-if="item.edge.label"
        class="nf-edge__label"
        :x="item.mid.x"
        :y="item.mid.y - 12"
      >
        {{ item.edge.label }}
      </text>

      <!-- hover：中点「+」插入中间节点 -->
      <g
        v-if="hoverId === item.edge.id || selectedId === item.edge.id"
        class="nf-edge__plus"
        :transform="`translate(${item.mid.x}, ${item.mid.y})`"
        @pointerdown.stop
        @click.stop="emit('insert-between', item.edge.id)"
      >
        <title>在此处插入节点</title>
        <circle r="9.5" class="nf-edge__plus-bg" />
        <path d="M-3.4 0 L3.4 0 M0 -3.4 L0 3.4" class="nf-edge__plus-glyph" />
      </g>

      <!-- 选中：删除 -->
      <g
        v-if="selectedId === item.edge.id"
        class="nf-edge__del"
        :transform="`translate(${item.mid.x + 24}, ${item.mid.y})`"
        @pointerdown.stop
        @click.stop="emit('remove', item.edge.id)"
      >
        <title>删除连线</title>
        <circle r="9.5" class="nf-edge__del-bg" />
        <path d="M-2.8 -2.8 L2.8 2.8 M2.8 -2.8 L-2.8 2.8" class="nf-edge__del-glyph" />
      </g>

      <!-- 选中：端点拖拽改写连接 -->
      <template v-if="selectedId === item.edge.id">
        <circle
          class="nf-edge__endpoint"
          :cx="item.start.x"
          :cy="item.start.y"
          r="6"
          @pointerdown.stop="emit('reconnect-start', $event, item.edge.id, 'source')"
        />
        <circle
          class="nf-edge__endpoint"
          :cx="item.end.x"
          :cy="item.end.y"
          r="6"
          @pointerdown.stop="emit('reconnect-start', $event, item.edge.id, 'target')"
        />
      </template>
    </g>
  </g>
</template>

<style scoped>
.nf-edge__hit {
  fill: none;
  stroke: transparent;
  stroke-width: 18;
  pointer-events: stroke;
  cursor: pointer;
}

.nf-edge__line {
  fill: none;
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  pointer-events: none;
  transition:
    stroke-width var(--nf-dur-fast) var(--nf-ease),
    opacity var(--nf-dur-fast) var(--nf-ease),
    filter var(--nf-dur-fast) var(--nf-ease);
}

.nf-edge.is-flashback .nf-edge__line {
  stroke-dasharray: 8 8;
  opacity: 0.72;
}
.nf-edge.is-jump .nf-edge__line {
  stroke-dasharray: 2 7;
  opacity: 0.85;
}

.nf-edge.is-hover .nf-edge__line {
  stroke-width: 3.2;
  filter: drop-shadow(0 2px 6px rgba(15, 23, 32, 0.14));
}
.nf-edge.is-selected .nf-edge__line {
  stroke-width: 3.4;
  filter: drop-shadow(0 0 8px rgba(77, 208, 217, 0.5));
}

.nf-edge__label {
  font-size: 11px;
  letter-spacing: 0.04em;
  fill: var(--nf-ink-soft);
  text-anchor: middle;
  paint-order: stroke;
  stroke: var(--nf-paper);
  stroke-width: 3.5;
  stroke-linejoin: round;
  pointer-events: none;
}

.nf-canvas--dark .nf-edge__label {
  fill: var(--nf-on-dark-soft);
  stroke: var(--nf-night);
}

/* 中点「+」 */
.nf-edge__plus,
.nf-edge__del {
  cursor: pointer;
  animation: nf-fade-in var(--nf-dur-fast) var(--nf-ease) both;
}
.nf-edge__plus-bg,
.nf-edge__del-bg {
  fill: #fff;
  stroke: var(--nf-teal);
  stroke-width: 1.2;
}
.nf-edge__plus-glyph {
  stroke: var(--nf-teal-deep);
  stroke-width: 1.6;
  stroke-linecap: round;
  fill: none;
}
.nf-edge__del-bg {
  stroke: var(--nf-danger);
}
.nf-edge__del-glyph {
  stroke: var(--nf-danger);
  stroke-width: 1.6;
  stroke-linecap: round;
  fill: none;
}

.nf-canvas--dark .nf-edge__plus-bg,
.nf-canvas--dark .nf-edge__del-bg {
  fill: #1b2634;
}

.nf-edge__endpoint {
  fill: #fff;
  stroke: var(--nf-teal);
  stroke-width: 2;
  cursor: crosshair;
  animation: nf-fade-in var(--nf-dur-fast) var(--nf-ease) both;
}
.nf-canvas--dark .nf-edge__endpoint {
  fill: #16232e;
}
</style>
