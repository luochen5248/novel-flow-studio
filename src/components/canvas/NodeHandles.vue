<script setup lang="ts">
import type { PortSide, StoryNode } from '@/types/graph'

const props = withDefaults(
  defineProps<{
    node: StoryNode
    visible?: boolean
    locked?: boolean
  }>(),
  { visible: false, locked: false }
)

const emit = defineEmits<{
  (e: 'insert-after', id: string): void
  (e: 'insert-before', id: string): void
  (e: 'insert-branch', dir: 1 | -1): void
  (e: 'remove', id: string): void
  (e: 'open-story', id: string): void
  (e: 'port-down', evt: PointerEvent, side: PortSide): void
}>()

/** 端口座标（相对节点左上角） */
function port(side: PortSide): { x: number; y: number } {
  const { w, h } = props.node
  switch (side) {
    case 'top':
      return { x: w / 2, y: 0 }
    case 'bottom':
      return { x: w / 2, y: h }
    case 'left':
      return { x: 0, y: h / 2 }
    default:
      return { x: w, y: h / 2 }
  }
}

const ports: Array<{ side: PortSide; title: string }> = [
  { side: 'top', title: '上方插入节点（可拖动连线）' },
  { side: 'bottom', title: '下方插入节点（可拖动连线）' },
  { side: 'left', title: '左侧拉出支线（可拖动连线）' },
  { side: 'right', title: '右侧拉出支线（可拖动连线）' }
]

function onPortDown(e: PointerEvent, side: PortSide): void {
  e.stopPropagation()
  emit('port-down', e, side)
}
</script>

<template>
  <g class="nf-handles" :class="{ 'is-visible': visible }">
    <!-- 四个连接桩 -->
    <g
      v-for="p in ports"
      :key="p.side"
      :class="['nf-handle', `nf-handle--${p.side}`]"
      :transform="`translate(${port(p.side).x}, ${port(p.side).y})`"
      @pointerdown="onPortDown($event, p.side)"
    >
      <title>{{ p.title }}</title>
      <circle class="nf-handle__hit" r="11" />
      <circle class="nf-handle__ring" r="5.5" />
      <circle class="nf-handle__core" r="2.4" />
    </g>

    <!-- 操作图标：删除 / 打开故事 -->
    <g
      v-if="!locked"
      class="nf-icon-btn nf-icon-btn--remove"
      :transform="`translate(${node.w + 12}, -8)`"
      @pointerdown.stop
      @click.stop="emit('remove', node.id)"
    >
      <title>删除节点</title>
      <circle class="nf-icon-btn__bg" r="11" />
      <path class="nf-icon-btn__glyph" d="M-3.4 -3.4 L3.4 3.4 M3.4 -3.4 L-3.4 3.4" />
    </g>

    <g
      class="nf-icon-btn nf-icon-btn--story"
      :transform="`translate(${node.w + 12}, 20)`"
      @pointerdown.stop
      @click.stop="emit('open-story', node.id)"
    >
      <title>打开故事正文</title>
      <circle class="nf-icon-btn__bg" r="11" />
      <path class="nf-icon-btn__glyph" d="M-4 -3.6 L0.6 -3.6 M-4 0 L4 0 M-4 3.6 L2.6 3.6" />
    </g>

    <!-- 快速插入（上下） -->
    <g
      v-if="!locked"
      class="nf-icon-btn nf-icon-btn--quick"
      :transform="`translate(${node.w / 2}, ${node.h + 14})`"
      @pointerdown.stop
      @click.stop="emit('insert-after', node.id)"
    >
      <title>在下方插入节点（Enter）</title>
      <rect class="nf-icon-btn__bg" x="-14" y="-8" width="28" height="16" rx="8" />
      <path class="nf-icon-btn__glyph" d="M-3.6 0 L3.6 0 M0 -3.6 L0 3.6" />
    </g>
  </g>
</template>

<style scoped>
.nf-handles {
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--nf-dur-fast) var(--nf-ease);
}
.nf-handles.is-visible {
  opacity: 1;
  pointer-events: auto;
}

.nf-handle {
  cursor: crosshair;
}
.nf-handle__hit {
  fill: transparent;
}
.nf-handle__ring {
  fill: #fff;
  stroke: var(--nf-teal);
  stroke-width: 1.5;
  transition: transform var(--nf-dur-fast) var(--nf-ease);
}
.nf-handle__core {
  fill: var(--nf-teal);
}
.nf-handle:hover .nf-handle__ring {
  transform: scale(1.22);
}
.nf-handle:hover .nf-handle__core {
  fill: var(--nf-teal-deep);
}

.nf-canvas--dark .nf-handle__ring {
  fill: #16232e;
}

.nf-icon-btn {
  cursor: pointer;
}
.nf-icon-btn__bg {
  fill: rgba(255, 255, 255, 0.92);
  stroke: var(--nf-card-hairline);
  stroke-width: 1;
}
.nf-icon-btn__glyph {
  fill: none;
  stroke: var(--nf-ink);
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.nf-icon-btn:hover .nf-icon-btn__bg {
  fill: #fff;
}
.nf-icon-btn--remove:hover .nf-icon-btn__glyph {
  stroke: var(--nf-danger);
}
.nf-icon-btn--story:hover .nf-icon-btn__glyph,
.nf-icon-btn--quick:hover .nf-icon-btn__glyph {
  stroke: var(--nf-teal-deep);
}

.nf-canvas--dark .nf-icon-btn__bg {
  fill: #1b2634;
  stroke: rgba(180, 205, 226, 0.16);
}
.nf-canvas--dark .nf-icon-btn__glyph {
  stroke: var(--nf-on-dark);
}
.nf-canvas--dark .nf-icon-btn:hover .nf-icon-btn__bg {
  fill: #22303f;
}
</style>
