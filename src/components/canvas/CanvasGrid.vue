<script setup lang="ts">
import { computed } from 'vue'
import type { Rect } from '@/types/graph'

const props = withDefaults(
  defineProps<{
    viewBox: Rect
    mode?: 'light' | 'dark'
    /** zoom=1 时的基准点距 */
    base?: number
  }>(),
  { mode: 'light', base: 26 }
)

/**
 * 宣纸点阵网格：点距随缩放做 2 的幂次自适应，
 * 保证屏幕上的点距始终落在 15–52px —— 放大不糊、缩小不糊成一片灰。
 */
const step = computed(() => {
  const s = props.viewBox.w
  // viewBox 越宽 ⇒ 缩放越小 ⇒ 点距要放大
  const ratio = 1400 / Math.max(s, 1)
  let v = props.base
  while (v / ratio < 15) v *= 2
  while (v / ratio > 52) v /= 2
  return v
})

const dot = computed(() => Math.max(0.9, Math.min(2.2, step.value * 0.055)))
</script>

<template>
  <g class="nf-grid" pointer-events="none">
    <defs>
      <!-- 图案原点固定在世界坐标 0,0：网格跟着内容一起平移缩放，而不是糊在屏幕上 -->
      <pattern id="nf-dot-grid" :width="step" :height="step" patternUnits="userSpaceOnUse">
        <circle :cx="step / 2" :cy="step / 2" :r="dot" class="nf-grid__dot" />
      </pattern>
      <radialGradient id="nf-paper-vignette" cx="50%" cy="42%" r="76%">
        <stop offset="0%" stop-color="#fff" stop-opacity="0.55" />
        <stop offset="62%" stop-color="#fff" stop-opacity="0.06" />
        <stop offset="100%" stop-color="#0f1720" stop-opacity="0.07" />
      </radialGradient>
    </defs>

    <rect
      :x="viewBox.x"
      :y="viewBox.y"
      :width="viewBox.w"
      :height="viewBox.h"
      class="nf-grid__paper"
    />
    <rect
      :x="viewBox.x"
      :y="viewBox.y"
      :width="viewBox.w"
      :height="viewBox.h"
      fill="url(#nf-dot-grid)"
    />
    <rect
      :x="viewBox.x"
      :y="viewBox.y"
      :width="viewBox.w"
      :height="viewBox.h"
      fill="url(#nf-paper-vignette)"
    />
  </g>
</template>

<style scoped>
.nf-grid__paper {
  fill: var(--nf-paper);
  transition: fill var(--nf-dur-slow) var(--nf-ease);
}

.nf-grid__dot {
  fill: rgba(21, 34, 44, 0.16);
  transition: fill var(--nf-dur-slow) var(--nf-ease);
}

:global(.nf-canvas--dark) .nf-grid__paper {
  fill: var(--nf-night);
}
:global(.nf-canvas--dark) .nf-grid__dot {
  fill: rgba(180, 205, 226, 0.16);
}
</style>
