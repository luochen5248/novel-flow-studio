<script setup lang="ts">
import type { Rect } from '@/types/graph'

defineProps<{
  box: Rect | null
  /** 智能参考线：v 为纵向（x 值），h 为横向（y 值） */
  guides: { v: number[]; h: number[] }
  bounds: Rect | null
}>()
</script>

<template>
  <g class="nf-selection" pointer-events="none">
    <!-- 智能参考线：青色细实线 + 淡入（松手即消失） -->
    <template v-if="bounds">
      <line
        v-for="x in guides.v"
        :key="`v${x}`"
        class="nf-guide"
        :x1="x"
        :y1="bounds.y"
        :x2="x"
        :y2="bounds.y + bounds.h"
      />
      <line
        v-for="y in guides.h"
        :key="`h${y}`"
        class="nf-guide"
        :x1="bounds.x"
        :y1="y"
        :x2="bounds.x + bounds.w"
        :y2="y"
      />
    </template>

    <rect
      v-if="box"
      class="nf-marquee"
      :x="box.x"
      :y="box.y"
      :width="box.w"
      :height="box.h"
      rx="6"
    />
  </g>
</template>

<style scoped>
/* 框选框：实线 + 极淡主色填充。
   原本想用虚线蚂蚁框表达「这是临时区域」，但 plan.md 第 8 节明令禁止虚线，
   且实线 + 淡填充反而更能表达「这些将被选中」，信息量更足。 */
.nf-marquee {
  fill: rgba(77, 208, 217, 0.08);
  stroke: var(--nf-teal);
  stroke-width: 1;
  animation: nf-fade-in var(--nf-dur-fast) var(--nf-ease) both;
}

/* 智能对齐参考线：同样改实线，靠「细 + 低透明度」退居背景，不与卡片争夺注意力。
   （拖拽松手即消失，属瞬时辅助线，实线完全够用且更干净。） */
.nf-guide {
  stroke: var(--nf-teal);
  stroke-width: 1;
  opacity: 0.38;
  animation: nf-fade-in var(--nf-dur-fast) var(--nf-ease) both;
}
</style>
