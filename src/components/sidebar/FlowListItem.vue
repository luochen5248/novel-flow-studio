<script setup lang="ts">
import { nextTick, ref } from 'vue'
import type { FlowGraph } from '@/types/graph'

const props = defineProps<{
  graph: FlowGraph
  active?: boolean
  favorite?: boolean
}>()

const emit = defineEmits<{
  (e: 'select', id: string): void
  (e: 'rename', id: string, name: string): void
  (e: 'duplicate', id: string): void
  (e: 'remove', id: string): void
  (e: 'toggle-favorite', id: string): void
  (e: 'export', id: string): void
}>()

const editing = ref(false)
const draft = ref('')
const input = ref<HTMLInputElement | null>(null)

async function beginEdit(): Promise<void> {
  draft.value = props.graph.name
  editing.value = true
  await nextTick()
  input.value?.focus()
  input.value?.select()
}

function commitEdit(): void {
  if (!editing.value) return
  editing.value = false
  const name = draft.value.trim()
  if (name && name !== props.graph.name) emit('rename', props.graph.id, name)
}

const count = props.graph.nodes.length
</script>

<template>
  <li
    class="nf-flow-item"
    :class="{ 'is-active': active }"
    @click="emit('select', graph.id)"
    @dblclick.stop="beginEdit"
  >
    <span class="nf-flow-item__rail" aria-hidden="true" />

    <div class="nf-flow-item__main">
      <template v-if="editing">
        <input
          ref="input"
          v-model="draft"
          class="nf-flow-item__input"
          @blur="commitEdit"
          @keydown.enter.prevent="commitEdit"
          @keydown.esc.prevent="editing = false"
          @click.stop
        />
      </template>
      <template v-else>
        <span class="nf-flow-item__name">{{ graph.name }}</span>
        <span class="nf-flow-item__count">{{ count }} 节点</span>
      </template>
    </div>

    <div class="nf-flow-item__tools" @click.stop>
      <button
        class="nf-icon-btn"
        :class="{ 'is-on': favorite }"
        :title="favorite ? '取消收藏' : '收藏置顶'"
        @click="emit('toggle-favorite', graph.id)"
      >
        <svg viewBox="0 0 16 16" width="14" height="14">
          <path
            d="M8 2.2 L9.72 5.9 L13.8 6.5 L10.9 9.4 L11.6 13.6 L8 11.7 L4.4 13.6 L5.1 9.4 L2.2 6.5 L6.28 5.9 Z"
            :fill="favorite ? 'currentColor' : 'none'"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <button class="nf-icon-btn" title="导出 JSON" @click="emit('export', graph.id)">
        <svg viewBox="0 0 16 16" width="14" height="14">
          <path
            d="M8 2.6 V9.4 M8 9.4 L5.4 6.8 M8 9.4 L10.6 6.8 M3 11.4 V12.8 A1.2 1.2 0 0 0 4.2 14 H11.8 A1.2 1.2 0 0 0 13 12.8 V11.4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <button class="nf-icon-btn" title="复制" @click="emit('duplicate', graph.id)">
        <svg viewBox="0 0 16 16" width="14" height="14">
          <rect x="5.4" y="5.4" width="8.2" height="8.2" rx="2" fill="none" stroke="currentColor" stroke-width="1.3" />
          <path d="M10.6 5.4 V4.2 A1.8 1.8 0 0 0 8.8 2.4 H4.2 A1.8 1.8 0 0 0 2.4 4.2 V8.8 A1.8 1.8 0 0 0 4.2 10.6 H5.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
      </button>
      <button class="nf-icon-btn is-danger" title="删除" @click="emit('remove', graph.id)">
        <svg viewBox="0 0 16 16" width="14" height="14">
          <path d="M3.4 4.6 H12.6 M6.4 4.6 V3.2 H9.6 V4.6 M4.8 4.6 L5.3 13 A1 1 0 0 0 6.3 13.9 H9.7 A1 1 0 0 0 10.7 13 L11.2 4.6 M6.8 7.4 V11.4 M9.2 7.4 V11.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
  </li>
</template>

<style scoped>
.nf-flow-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px 9px 14px;
  border-radius: var(--nf-r-ctl);
  cursor: pointer;
  color: var(--nf-on-dark);
  transition:
    background var(--nf-dur-fast) var(--nf-ease),
    transform var(--nf-dur-fast) var(--nf-ease);
}

.nf-flow-item:hover {
  background: rgba(148, 172, 196, 0.07);
}

/* 选中：主色发光 + 左侧导条，不用灰底 */
.nf-flow-item.is-active {
  background: linear-gradient(
    90deg,
    rgba(77, 208, 217, 0.14) 0%,
    rgba(77, 208, 217, 0.05) 62%,
    transparent 100%
  );
  box-shadow: inset 0 0 0 1px rgba(77, 208, 217, 0.24);
}
.nf-flow-item.is-active .nf-flow-item__name {
  color: var(--nf-on-dark-strong);
}

.nf-flow-item__rail {
  position: absolute;
  left: 5px;
  top: 50%;
  width: 3px;
  height: 0;
  transform: translateY(-50%);
  border-radius: 999px;
  background: linear-gradient(180deg, #6fdde4 0%, #2aa6b0 100%);
  transition: height var(--nf-dur) var(--nf-ease);
}
.nf-flow-item.is-active .nf-flow-item__rail {
  height: 60%;
}

.nf-flow-item__main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nf-flow-item__name {
  font-size: var(--nf-fs-sm);
  color: var(--nf-on-dark);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nf-flow-item__count {
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.06em;
  color: var(--nf-on-dark-faint);
}

.nf-flow-item__input {
  width: 100%;
  background: rgba(8, 14, 19, 0.5);
  border: 1px solid rgba(77, 208, 217, 0.5);
  border-radius: 6px;
  padding: 2px 6px;
  color: var(--nf-on-dark-strong);
  font-size: var(--nf-fs-sm);
  outline: none;
}

.nf-flow-item__tools {
  display: flex;
  align-items: center;
  gap: 1px;
  opacity: 0;
  transition: opacity var(--nf-dur-fast) var(--nf-ease);
}
.nf-flow-item:hover .nf-flow-item__tools,
.nf-flow-item.is-active .nf-flow-item__tools {
  opacity: 1;
}

.nf-icon-btn {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--nf-on-dark-faint);
  width: 24px;
  height: 24px;
  border-radius: 7px;
  display: grid;
  place-items: center;
  cursor: pointer;
  transition:
    color var(--nf-dur-fast) var(--nf-ease),
    background var(--nf-dur-fast) var(--nf-ease);
}
.nf-icon-btn:hover {
  color: var(--nf-teal);
  background: rgba(77, 208, 217, 0.12);
}
.nf-icon-btn.is-on {
  color: var(--nf-gold);
}
.nf-icon-btn.is-danger:hover {
  color: var(--nf-danger);
  background: rgba(200, 106, 99, 0.12);
}
</style>
