<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  Drawer as ADrawer,
  Input as AInput,
  Textarea as ATextarea,
  RadioGroup as ARadioGroup,
  RadioButton as ARadioButton,
  Button as AButton
} from 'ant-design-vue'
import type { RadioChangeEvent } from 'ant-design-vue'
import type { NodeStatus, StoryNode } from '@/types/graph'
import { KIND_LABEL, NODE_STATUSES, STATUS_LABEL } from '@/types/graph'
import { useFlowStore } from '@/stores/useFlowStore'
import { useUiStore } from '@/stores/useUiStore'
import { useAiStore } from '@/stores/useAiStore'
import TagInput from '@/components/common/TagInput.vue'
import AiContextMenu from '@/components/common/AiContextMenu.vue'
import AiAssistDialog from '@/components/ai/AiAssistDialog.vue'
import type { AssistMode } from '@/core/aiPrompt'
import { pickNeighbors } from '@/core/aiPrompt'

/**
 * StoryEditorDrawer —— 右侧滑出式正文编辑抽屉（宽 640px）
 *
 * 让作者愿意在里面写下第一段话：充分负空间、柔和文本层级、少框线。
 * 正文变更 debounce 600ms 写入 store（避免每字压一条历史）。
 * 顶部可编辑标题 / 类型徽标 / 状态切换；侧栏快编 timeLabel / location / characters；
 * 底部按 lane+order 顺序在上一个 / 下一个节点间切换。
 *
 * 右键 AI：正文里右键 → 查资料 / 续写 / 润色，结果**流式直接写在光标处**，
 * 期间不落库（避免逐 chunk 压历史），流结束再落一次（见下方 AI 写入段落）。
 */

const store = useFlowStore()
const ui = useUiStore()
const ai = useAiStore()

const node = computed<StoryNode | null>(
  () => store.nodes.find((n) => n.id === ui.storyEditorId) ?? null
)
const open = computed(() => !!ui.storyEditorId && !!node.value)

/** 按 lane → order 排序的全局顺序，用于上 / 下篇切换 */
const sequence = computed(() =>
  [...store.nodes].sort(
    (a, b) => a.lane - b.lane || a.order - b.order || (a.id < b.id ? -1 : 1)
  )
)
const index = computed(() => sequence.value.findIndex((n) => n.id === node.value?.id))

const content = ref('')
const titleDraft = ref('')
/** 声明必须早于下方 immediate watch：watch 同步首跑时就会读它（TDZ 防护，m1） */
const assistDialog = ref<InstanceType<typeof AiAssistDialog> | null>(null)

watch(
  node,
  (next) => {
    // 切篇时先把流式任务结算到上一篇，否则 AI 会继续往新正文里写
    if (ai.streaming) assistDialog.value?.close()
    if (next) {
      content.value = next.content
      titleDraft.value = next.title
    }
  },
  { immediate: true }
)

/* ---------------- 正文：600ms 防抖写入 ---------------- */
let contentTimer: ReturnType<typeof setTimeout> | undefined
let contentTargetId: string | undefined
function onContentInput(): void {
  contentTargetId = node.value?.id
  if (contentTimer) clearTimeout(contentTimer)
  contentTimer = setTimeout(() => flushContent(), 600)
}
function flushContent(): void {
  if (contentTimer) {
    clearTimeout(contentTimer)
    contentTimer = undefined
  }
  if (contentTargetId && store.nodes.some((n) => n.id === contentTargetId)) {
    store.updateNode(contentTargetId, { content: content.value }, { merge: 'content' })
  }
}
const charCount = computed(() => content.value.length)

/** 把当前 content 立刻写成一条历史记录，并吃掉在飞的 600ms 定时器 */
function commitNow(): void {
  contentTargetId = node.value?.id
  flushContent()
}

/* ---------------- 右键 AI（流式写入光标处） ---------------- */
const menuOpen = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const selection = ref<{ start: number; end: number }>({ start: 0, end: 0 })
/** 触发右键的原生 textarea：流式期间靠它恢复光标 */
const streamEl = ref<HTMLTextAreaElement | null>(null)
/** 右键那一刻的节点 id：结算时以它为准 */
let streamTargetId = ''

function onContentContextMenu(e: Event): void {
  const target = e.target as HTMLTextAreaElement | null
  if (!target || typeof target.selectionStart !== 'number') return
  const mouse = e as MouseEvent
  streamEl.value = target
  selection.value = { start: target.selectionStart, end: target.selectionEnd }
  menuX.value = mouse.clientX
  menuY.value = mouse.clientY
  menuOpen.value = true
}

/** AI 每来一段就整段重写本地值（不落库），并把光标顶到新文本末尾 */
function writeStream(value: string, caretPos: number): void {
  content.value = value
  void nextTick(() => {
    const el = streamEl.value
    if (el) el.setSelectionRange(caretPos, caretPos)
  })
}

function settleStream(): void {
  // 锁到右键那一刻的节点：中途换过节点也不会写错地方
  contentTargetId = streamTargetId || node.value?.id
  flushContent()
  streamTargetId = ''
  void nextTick(() => {
    const el = streamEl.value
    const pos = Math.min(content.value.length, el?.selectionStart ?? content.value.length)
    if (el) el.setSelectionRange(pos, pos)
  })
}

function onAssist(mode: AssistMode): void {
  const target = node.value
  if (!target) return
  // 先把用户刚打的字落库，避免在飞的 600ms 定时器与 AI 写入互相覆盖
  commitNow()
  streamTargetId = target.id
  assistDialog.value?.open({
    mode,
    node: {
      id: target.id,
      title: target.title,
      summary: target.summary,
      content: content.value,
      characters: target.characters,
      location: target.location,
      timeLabel: target.timeLabel,
      chapter: target.chapter,
      kind: target.kind
    },
    neighbors: pickNeighbors(store.nodes, target.id),
    baseText: content.value,
    selection: { ...selection.value },
    x: menuX.value,
    y: menuY.value,
    onUpdate: writeStream,
    onSettled: settleStream
  })
}

/* ---------------- 顶部字段 ---------------- */
function onTitleChange(e: Event): void {
  const value = (e.target as HTMLInputElement).value
  titleDraft.value = value
  if (node.value && value.trim()) store.updateNode(node.value.id, { title: value.trim() })
}
function onStatusChange(e: RadioChangeEvent): void {
  if (node.value) store.updateNode(node.value.id, { status: e.target.value as NodeStatus })
}

/* ---------------- 侧栏快编 ---------------- */
function onTime(e: Event): void {
  if (node.value) store.updateNode(node.value.id, { timeLabel: (e.target as HTMLInputElement).value })
}
function onLocation(e: Event): void {
  if (node.value) store.updateNode(node.value.id, { location: (e.target as HTMLInputElement).value })
}
function setCharacters(value: string[]): void {
  if (node.value) store.updateNode(node.value.id, { characters: value })
}

/* ---------------- 上 / 下篇切换 ---------------- */
function goto(targetId: string): void {
  // 正在流式写入时必须先结算：否则换节点后 AI 会继续往新节点的正文里写字
  assistDialog.value?.close()
  flushContent()
  ui.openStoryEditor(targetId)
  store.select([targetId])
}
function prev(): void {
  const i = index.value
  if (i > 0) goto(sequence.value[i - 1].id)
}
function next(): void {
  const i = index.value
  if (i >= 0 && i < sequence.value.length - 1) goto(sequence.value[i + 1].id)
}

function close(): void {
  assistDialog.value?.close()
  flushContent()
  ui.closeStoryEditor()
}
</script>

<template>
  <ADrawer
    :open="open"
    placement="right"
    :width="640"
    :closable="true"
    :mask-closable="true"
    :keyboard="true"
    :destroy-on-close="true"
    class="nf-story-drawer"
    @close="close"
  >
    <template v-if="node" #title>
      <div class="nf-story__titlebar">
        <span class="nf-story__kind" :class="`is-${node.kind}`">{{ KIND_LABEL[node.kind] }}</span>
        <AInput
          :value="titleDraft"
          size="large"
          :bordered="false"
          class="nf-story__title"
          placeholder="未命名节点"
          @change="onTitleChange"
        />
        <ARadioGroup :value="node.status" class="nf-story__status" @change="onStatusChange">
          <ARadioButton v-for="s in NODE_STATUSES" :key="s" :value="s">{{ STATUS_LABEL[s] }}</ARadioButton>
        </ARadioGroup>
      </div>
    </template>

    <div v-if="node" class="nf-story__body">
      <div class="nf-story__main">
        <ATextarea
          v-model:value="content"
          class="nf-story__editor"
          placeholder="在这里写下这一段故事……"
          :auto-size="{ minRows: 18, maxRows: 30 }"
          @input="onContentInput"
          @contextmenu.prevent="onContentContextMenu"
        />
        <div class="nf-story__count">{{ charCount.toLocaleString() }} 字</div>
      </div>

      <aside class="nf-story__side">
        <div class="nf-story__side-field">
          <label class="nf-story__side-label">故事内时间</label>
          <AInput :value="node.timeLabel" size="small" placeholder="如：雨夜 / 三年后" @change="onTime" />
        </div>
        <div class="nf-story__side-field">
          <label class="nf-story__side-label">地点</label>
          <AInput :value="node.location" size="small" placeholder="如：旧码头" @change="onLocation" />
        </div>
        <div class="nf-story__side-field">
          <label class="nf-story__side-label">人物</label>
          <TagInput :model-value="node.characters" placeholder="回车增删" @update:model-value="setCharacters" />
        </div>
        <p class="nf-story__side-hint">
          正文每停顿 0.6 秒自动保存一次。<br />
          正文里<b>右键</b>可以唤 AI 查资料 / 续写 / 润色。
        </p>
      </aside>
    </div>

    <template #footer>
      <div v-if="node" class="nf-story__nav">
        <AButton
          class="nf-story__nav-btn"
          :disabled="index <= 0"
          @click="prev"
        >
          <svg viewBox="0 0 16 16" width="14" height="14">
            <path d="M10 3.4 L6 8 L10 12.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          上一篇
        </AButton>
        <span class="nf-story__nav-pos">{{ index + 1 }} / {{ sequence.length }}</span>
        <AButton
          class="nf-story__nav-btn"
          :disabled="index < 0 || index >= sequence.length - 1"
          @click="next"
        >
          下一篇
          <svg viewBox="0 0 16 16" width="14" height="14">
            <path d="M6 3.4 L10 8 L6 12.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </AButton>
      </div>
    </template>
  </ADrawer>

  <!-- 浮层挂在抽屉之外：抽屉关闭 / 切换上下篇时由 close() 统一结算流式状态 -->
  <AiContextMenu
    :open="menuOpen"
    :x="menuX"
    :y="menuY"
    :has-selection="selection.end > selection.start"
    :busy="ai.streaming"
    @select="onAssist"
    @close="menuOpen = false"
  />
  <AiAssistDialog ref="assistDialog" />
</template>

<style scoped>
.nf-story__titlebar {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding-right: 8px;
}
.nf-story__kind {
  flex: none;
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.08em;
  color: var(--nf-teal);
  background: rgba(77, 208, 217, 0.12);
  border-radius: var(--nf-r-chip);
  padding: 3px 10px;
}
.nf-story__kind.is-decision { color: var(--nf-gold); background: rgba(201, 162, 39, 0.14); }
.nf-story__kind.is-milestone { color: var(--nf-on-dark-soft); background: rgba(148, 172, 196, 0.14); }
.nf-story__title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--nf-fs-xl);
  font-weight: 600;
}
.nf-story__title :deep(.ant-input) {
  font-size: var(--nf-fs-xl);
  font-weight: 600;
  color: var(--nf-on-dark-strong);
}
.nf-story__status {
  flex: none;
}

.nf-story__body {
  display: flex;
  gap: 22px;
  height: 100%;
  min-height: 0;
}
.nf-story__main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}
.nf-story__editor {
  flex: 1;
  width: 100%;
}
.nf-story__editor :deep(.ant-input) {
  height: 100% !important;
  resize: none;
  border: none;
  box-shadow: none;
  background: transparent;
  padding: 4px 0;
  font-size: 15px;
  line-height: 1.9;
  color: var(--nf-on-dark-strong);
  max-width: 60ch;
}
.nf-story__editor :deep(.ant-input::placeholder) {
  color: var(--nf-on-dark-faint);
}
.nf-story__count {
  position: absolute;
  right: 4px;
  bottom: 4px;
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.04em;
  color: var(--nf-on-dark-faint);
  background: var(--nf-shell-800);
  padding: 2px 8px;
  border-radius: var(--nf-r-chip);
}

.nf-story__side {
  flex: none;
  width: 188px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-left: 22px;
  border-left: 1px solid var(--nf-shell-line-soft);
}
.nf-story__side-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.nf-story__side-label {
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.06em;
  color: var(--nf-on-dark-faint);
}
.nf-story__side-hint {
  margin-top: auto;
  font-size: 10px;
  line-height: 1.7;
  color: var(--nf-on-dark-faint);
  opacity: 0.8;
}

.nf-story__nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.nf-story__nav-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.nf-story__nav-pos {
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.06em;
  color: var(--nf-on-dark-faint);
  font-variant-numeric: tabular-nums;
}
</style>

<style>
/* 抽屉整体暗色外壳观感（覆盖 antd portal 样式，必须非 scoped） */
.nf-story-drawer .ant-drawer-content {
  background: #131c26;
}
.nf-story-drawer .ant-drawer-header {
  background: transparent;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  padding: 16px 20px;
}
.nf-story-drawer .ant-drawer-title {
  color: var(--nf-on-dark-strong);
  font-weight: 600;
}
.nf-story-drawer .ant-drawer-close {
  color: var(--nf-on-dark-soft);
}
.nf-story-drawer .ant-drawer-body {
  padding: 18px 20px;
}
.nf-story-drawer .ant-drawer-footer {
  border-top: 1px solid rgba(255, 255, 255, 0.07);
  padding: 12px 20px;
}
.nf-story-drawer .ant-input {
  background: transparent;
  color: var(--nf-on-dark);
}
</style>
