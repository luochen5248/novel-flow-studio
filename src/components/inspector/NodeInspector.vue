<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  Tabs as ATabs,
  TabPane as ATabPane,
  Input as AInput,
  Textarea as ATextarea,
  Select as ASelect,
  SelectOption as ASelectOption,
  RadioGroup as ARadioGroup,
  RadioButton as ARadioButton,
  Button as AButton,
  Popconfirm as APopconfirm,
  Empty as AEmpty,
  Progress as AProgress
} from 'ant-design-vue'
import type { RadioChangeEvent } from 'ant-design-vue'
import type { NodeKind, NodeStatus, StoryNode } from '@/types/graph'
import {
  KIND_LABEL,
  NODE_KINDS,
  NODE_STATUSES,
  STATUS_LABEL
} from '@/types/graph'
import { useFlowStore } from '@/stores/useFlowStore'
import { useUiStore } from '@/stores/useUiStore'
import { useAiStore } from '@/stores/useAiStore'
import { useKbStore } from '@/stores/useKbStore'
import { useConsistencyStore } from '@/stores/useConsistencyStore'
import type { KnowledgeType, NodeLinks } from '@/core/kb/types'
import TagInput from '@/components/common/TagInput.vue'
import AiContextMenu from '@/components/common/AiContextMenu.vue'
import AiAssistDialog from '@/components/ai/AiAssistDialog.vue'
import type { AssistMode } from '@/core/aiPrompt'
import { pickNeighbors } from '@/core/aiPrompt'

/**
 * NodeInspector —— 右侧属性检查器（宽 320px，可折叠）
 *
 * - 选中节点：按「故事 / 内容 / 要素 / 状态 / 图像」五组分栏编辑，所有写操作走 store.updateNode。
 * - 未选中：展示画布总览态（节点数、分支数、完成度环、字数统计），空图时给插画感引导。
 * 折叠态由 ui.inspectorOpen 控制，组件自身在选中节点时自动展开。
 */

const emit = defineEmits<{ (e: 'open-ai-image'): void }>()

const store = useFlowStore()
const ui = useUiStore()
const ai = useAiStore()
const kbStore = useKbStore()
const consistency = useConsistencyStore()

const node = computed<StoryNode | null>(() => store.currentNode)

/* 选中节点即展开检查器；首屏无选中时也让总览态可见 */
watch(node, (next) => {
  // 切节点时先把流式任务结算到旧节点上，避免 AI 接着往新节点里写
  if (ai.streaming) assistDialog.value?.close()
  if (next) {
    ui.inspectorOpen = true
    // 关联区按节点反查（事实源在 db，节点上不存镜像字段）
    void kbStore.refreshNodeLinks(next.id)
  }
})
onMounted(() => {
  if (!store.currentNode) ui.inspectorOpen = true
  else void kbStore.refreshNodeLinks(store.currentNode.id)
})

/* ---------------- 关联（知识条目 / 文档，按 nodeId 反查） ---------------- */

/** 当前节点的关联数据；store 里缓存的是「哪个节点的」要一并核对，防串节点 */
const nodeLinks = computed<NodeLinks>(() => {
  const links = kbStore.nodeLinks
  if (links && node.value && links.nodeId === node.value.id) return links
  return { entries: [], docs: [] }
})

const ENTRY_TYPE_LABEL: Record<KnowledgeType, string> = {
  note: '笔记',
  setting: '设定',
  character: '人物',
  plot: '情节',
  style: '风格'
}

function onUnlinkEntry(entryId: string): void {
  if (!node.value) return
  kbStore
    .unlinkEntryAction(entryId, node.value.id)
    .catch((e) => message.error(e instanceof Error ? e.message : '解除关联失败'))
}

function onUnlinkDoc(docId: string): void {
  if (!node.value) return
  kbStore
    .unlinkDocAction(docId, node.value.id)
    .catch((e) => message.error(e instanceof Error ? e.message : '解除关联失败'))
}

function openKbPanel(): void {
  kbStore.openPanel('entries')
}

/* ---------------- 总览态统计 ---------------- */
const totalNodes = computed(() => store.nodes.length)
const doneCount = computed(() => store.nodes.filter((n) => n.status === 'done').length)
const branchCount = computed(() => store.edges.filter((e) => e.kind === 'branch').length)
const laneCount = computed(
  () => new Set(store.nodes.filter((n) => n.lane !== 0).map((n) => n.lane)).size
)
const wordCount = computed(() =>
  store.nodes.reduce((sum, n) => sum + (n.content?.length ?? 0) + (n.summary?.length ?? 0), 0)
)
const donePercent = computed(() =>
  totalNodes.value ? Math.round((doneCount.value / totalNodes.value) * 100) : 0
)

/* ---------------- 一致性（消费 useConsistencyStore 的最近一次检查快照） ---------------- */
/** 当前节点的问题列表；报告未跑过时 issuesFor 返回空数组 ⇒ 节点态不渲染问题块（不占位、不提示） */
const nodeIssues = computed(() => (node.value ? consistency.issuesFor(node.value.id) : []))

/* ---------------- 写操作 ---------------- */
function update(patch: Partial<StoryNode>): void {
  if (node.value) store.updateNode(node.value.id, patch)
}

/** 文本类字段：轻量防抖，避免逐字压历史 */
let textTimer: ReturnType<typeof setTimeout> | undefined
function textUpdate(patch: Partial<StoryNode>): void {
  if (textTimer) clearTimeout(textTimer)
  textTimer = setTimeout(() => update(patch), 300)
}
function onText(field: keyof StoryNode, e: Event): void {
  const target = e.target as HTMLInputElement | HTMLTextAreaElement
  textUpdate({ [field]: target.value } as Partial<StoryNode>)
}

/* ---------------- 右键 AI（流式写入光标处） ----------------
 * 这里的两个多行文本框是「受控 + 300ms 防抖」的（上面 textUpdate），
 * 因此任何 AI 写入前都必须先 clearTimeout(textTimer)：
 * 否则那个在飞的定时器会把 IME 输入期的旧 target.value 写回 store，把 AI 结果盖掉（调查 E13）。
 * 流式期间不落库，先用 streamValue 顶替显示，流结束再一次性写 store。
 */
type AssistField = 'summary' | 'note'

const menuOpen = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const selection = ref<{ start: number; end: number }>({ start: 0, end: 0 })
const streamEl = ref<HTMLTextAreaElement | null>(null)
/** 当前正在被 AI 写入的字段；null 表示没有流式任务 */
const streamField = ref<AssistField | null>(null)
/** 流式期间的显示值（盖住 store 里的旧值，避免每个 chunk 压一条历史） */
const streamValue = ref<string | null>(null)
const assistDialog = ref<InstanceType<typeof AiAssistDialog> | null>(null)

let menuField: AssistField = 'summary'
let menuBaseText = ''
/** 右键那一刻的节点 id：流结束写库时以它为准，防止中途切节点把内容写错地方 */
let menuNodeId = ''

/** textarea 的当前显示值：流式期间优先用流式值 */
function fieldValue(field: AssistField): string {
  if (!node.value) return ''
  if (streamField.value === field && streamValue.value !== null) return streamValue.value
  return (node.value[field] as string | undefined) ?? ''
}

/** 吃掉在飞的防抖定时器：AI 写入 store 之前的必经一步 */
function cancelPendingText(): void {
  if (textTimer) {
    clearTimeout(textTimer)
    textTimer = undefined
  }
}

function onTextContextMenu(field: AssistField, e: Event): void {
  const target = e.target as HTMLTextAreaElement | null
  if (!target || typeof target.selectionStart !== 'number') return
  const mouse = e as MouseEvent
  menuField = field
  menuBaseText = target.value
  menuNodeId = node.value?.id ?? ''
  streamEl.value = target
  selection.value = { start: target.selectionStart, end: target.selectionEnd }
  menuX.value = mouse.clientX
  menuY.value = mouse.clientY
  menuOpen.value = true
}

function writeStream(value: string, caretPos: number): void {
  cancelPendingText()
  streamField.value = menuField
  streamValue.value = value
  void nextTick(() => streamEl.value?.setSelectionRange(caretPos, caretPos))
}

function settleStream(payload: { value: string; caretPos: number }): void {
  cancelPendingText()
  streamField.value = null
  streamValue.value = null
  const targetId = menuNodeId || node.value?.id
  if (targetId && store.nodes.some((n) => n.id === targetId)) {
    store.updateNode(targetId, { [menuField]: payload.value } as Partial<StoryNode>)
  }
  void nextTick(() => {
    const el = streamEl.value
    const pos = Math.min(payload.value.length, payload.caretPos)
    if (el) el.setSelectionRange(pos, pos)
  })
}

function onAssist(mode: AssistMode): void {
  const current = node.value
  if (!current) return
  // 先把用户刚打的字结算掉：否则那个定时器会在 AI 写入后把旧内容盖回来。
  // 这里不用「取消」而用「立即写」—— 万一 AI 起不来，用户已经打的字也不会丢。
  cancelPendingText()
  if (menuBaseText !== ((current[menuField] as string | undefined) ?? '')) {
    store.updateNode(current.id, { [menuField]: menuBaseText } as Partial<StoryNode>)
  }
  assistDialog.value?.open({
    mode,
    node: {
      // id 供 AI 注入按节点反查关联文档锚点（useAiAssist 用；不进提示词）
      id: current.id,
      title: current.title,
      summary: current.summary,
      content: current.content,
      characters: current.characters,
      location: current.location,
      timeLabel: current.timeLabel,
      chapter: current.chapter,
      kind: current.kind
    },
    neighbors: pickNeighbors(store.nodes, current.id),
    baseText: menuBaseText,
    selection: { ...selection.value },
    x: menuX.value,
    y: menuY.value,
    onUpdate: writeStream,
    onSettled: settleStream
  })
}

const kindOptions = NODE_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))
function onKindChange(value: unknown): void {
  update({ kind: value as NodeKind })
}

function onStatusChange(e: RadioChangeEvent): void {
  update({ status: e.target.value as NodeStatus })
}

/* 状态色族：复用 tokens.css 的六套节点主色（与画布卡片一一对应） */
const swatches: Array<{ key: string; label: string; cssVar: string }> = [
  { key: 'teal', label: '青', cssVar: '--nf-node-teal-bar' },
  { key: 'mist', label: '雾', cssVar: '--nf-node-mist-bar' },
  { key: 'gold', label: '金', cssVar: '--nf-node-gold-bar' },
  { key: 'clay', label: '陶', cssVar: '--nf-node-clay-bar' },
  { key: 'ink', label: '墨', cssVar: '--nf-node-ink-bar' },
  { key: 'sage', label: '苔', cssVar: '--nf-node-sage-bar' }
]
const customColor = ref('#4dd0d9')
const isCustomColor = computed(
  () => !!node.value && !swatches.some((s) => s.key === node.value!.color)
)
function pickColor(key: string): void {
  update({ color: key })
}
function applyCustomColor(): void {
  if (customColor.value) update({ color: customColor.value })
}

/* 人物 / 标签 */
function setCharacters(value: string[]): void {
  update({ characters: value })
}
function setTags(value: string[]): void {
  update({ tags: value })
}

/* 图像 */
function removeImage(): void {
  update({ image: undefined })
}

/* 底部操作 */
function duplicateNode(): void {
  if (node.value) store.duplicateNode(node.value.id)
}
function removeNode(): void {
  if (node.value) store.removeNode(node.value.id)
}
function openStory(): void {
  if (node.value) ui.openStoryEditor(node.value.id)
}

function collapse(): void {
  ui.inspectorOpen = false
}

function loadSample(): void {
  store.loadSampleGraph()
}
function addFirst(): void {
  store.addNode({ title: '新的事件' })
}
</script>

<template>
  <!-- 折叠态：仅留一条可重新展开的细轨 -->
  <button
    v-if="!ui.inspectorOpen"
    class="nf-inspector__reopen"
    title="展开属性检查器"
    @click="ui.inspectorOpen = true"
  >
    <svg viewBox="0 0 16 16" width="15" height="15">
      <path d="M10 3.4 L6 8 L10 12.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <span>属性</span>
  </button>

  <aside v-else class="nf-inspector" :class="{ 'is-collapsed': !ui.inspectorOpen }">
    <div class="nf-inspector__inner">
      <!-- ============ 画布总览态 ============ -->
      <div v-if="!node" class="nf-inspector__overview">
        <header class="nf-inspector__head">
          <span class="nf-inspector__head-title">画布总览</span>
          <button class="nf-inspector__collapse" title="折叠" @click="collapse">
            <svg viewBox="0 0 16 16" width="15" height="15">
              <path d="M6 3.4 L10 8 L6 12.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </header>

        <template v-if="totalNodes === 0">
          <div class="nf-inspector__empty">
            <svg class="nf-inspector__empty-art" viewBox="0 0 200 120" aria-hidden="true">
              <defs>
                <linearGradient id="nf-insp-ink" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="#4dd0d9" stop-opacity="0.9" />
                  <stop offset="100%" stop-color="#4dd0d9" stop-opacity="0.12" />
                </linearGradient>
              </defs>
              <path class="nf-inspector__empty-stroke" d="M20 18 C20 54, 44 54, 44 92 C44 116, 64 116, 64 138" stroke="url(#nf-insp-ink)" />
              <path class="nf-inspector__empty-stroke is-faint" d="M96 30 C116 56, 96 82, 116 110" />
              <circle cx="20" cy="18" r="5.5" class="nf-inspector__empty-dot" />
              <circle cx="44" cy="92" r="4.5" class="nf-inspector__empty-dot" />
              <circle cx="116" cy="110" r="4" class="nf-inspector__empty-dot is-branch" />
              <rect x="118" y="30" width="68" height="26" rx="9" class="nf-inspector__empty-card" />
            </svg>
            <p class="nf-inspector__empty-title">这条时间线还空着</p>
            <p class="nf-inspector__empty-desc">从一个事件起笔，或先载入一份示例故事看看结构。</p>
            <div class="nf-inspector__empty-actions">
              <AButton type="primary" @click="loadSample">载入示例故事</AButton>
              <AButton @click="addFirst">新建第一个节点</AButton>
            </div>
          </div>
        </template>

        <template v-else>
          <div class="nf-inspector__ring">
            <AProgress type="circle" :percent="donePercent" :size="132" :stroke-color="'#4dd0d9'" />
            <span class="nf-inspector__ring-label">已成稿</span>
          </div>
          <div class="nf-inspector__stats">
            <div class="nf-inspector__stat">
              <span class="nf-inspector__stat-num">{{ totalNodes }}</span>
              <span class="nf-inspector__stat-label">节点</span>
            </div>
            <div class="nf-inspector__stat">
              <span class="nf-inspector__stat-num">{{ branchCount }}</span>
              <span class="nf-inspector__stat-label">分支</span>
            </div>
            <div class="nf-inspector__stat">
              <span class="nf-inspector__stat-num">{{ laneCount }}</span>
              <span class="nf-inspector__stat-label">支线</span>
            </div>
            <div class="nf-inspector__stat">
              <span class="nf-inspector__stat-num">{{ wordCount.toLocaleString() }}</span>
              <span class="nf-inspector__stat-label">字数</span>
            </div>
            <!-- 一致性：整格可点，跳到控制台一致性面板；未检查时弱化提示 -->
            <button
              class="nf-inspector__stat nf-inspector__stat--cons"
              type="button"
              title="打开一致性检查"
              @click="ui.openControlCenter('consistency')"
            >
              <span class="nf-inspector__cons-line">
                <template v-if="consistency.report">
                  <span class="nf-cons-item is-error">
                    <i class="nf-cons-dot" /><span class="nf-cons-num">{{ consistency.report.counts.error }}</span>冲突
                  </span>
                  <span class="nf-cons-item is-warn">
                    <i class="nf-cons-dot" /><span class="nf-cons-num">{{ consistency.report.counts.warn }}</span>提醒
                  </span>
                  <span class="nf-cons-item is-info">
                    <i class="nf-cons-dot" /><span class="nf-cons-num">{{ consistency.report.counts.info }}</span>待补
                  </span>
                </template>
                <span v-else class="nf-inspector__cons-empty">未检查</span>
              </span>
              <span class="nf-inspector__stat-label">一致性</span>
            </button>
          </div>
          <p class="nf-inspector__hint">选中画布上的任意节点即可编辑它的属性与正文。</p>
          <div class="nf-inspector__empty-actions">
            <AButton @click="loadSample">载入示例故事</AButton>
          </div>
        </template>
      </div>

      <!-- ============ 节点编辑态 ============ -->
      <div v-else class="nf-inspector__node">
        <header class="nf-inspector__head">
          <span class="nf-inspector__kind" :class="`is-${node.kind}`">{{ KIND_LABEL[node.kind] }}</span>
          <span class="nf-inspector__head-title">节点属性</span>
          <button class="nf-inspector__collapse" title="折叠" @click="collapse">
            <svg viewBox="0 0 16 16" width="15" height="15">
              <path d="M6 3.4 L10 8 L6 12.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </header>

        <div class="nf-inspector__title">
          <AInput
            :value="node.title"
            size="large"
            placeholder="未命名节点"
            @change="onText('title', $event)"
          />
        </div>

        <!-- 一致性问题：仅当最近一次检查命中该节点时出现；未跑检查时完全不占位（避免噪音） -->
        <div v-if="nodeIssues.length" class="nf-inspector__cons">
          <span class="nf-inspector__cons-title">一致性问题</span>
          <div
            v-for="issue in nodeIssues"
            :key="issue.id"
            class="nf-inspector__cons-item"
            :class="`is-${issue.severity}`"
          >
            <i class="nf-cons-dot" />
            <div class="nf-inspector__cons-body">
              <p class="nf-inspector__cons-msg">{{ issue.message }}</p>
              <p v-if="issue.hint" class="nf-inspector__cons-hint">{{ issue.hint }}</p>
            </div>
          </div>
        </div>

        <ATabs class="nf-inspector__tabs" size="small">
          <!-- 故事 -->
          <ATabPane key="story" tab="故事">
            <div class="nf-field">
              <label class="nf-field__label">类型</label>
              <ASelect :value="node.kind" size="small" @change="onKindChange">
                <ASelectOption v-for="o in kindOptions" :key="o.value" :value="o.value">
                  {{ o.label }}
                </ASelectOption>
              </ASelect>
            </div>
            <div class="nf-field">
              <label class="nf-field__label">章节</label>
              <AInput :value="node.chapter" size="small" placeholder="如：第一章" @change="onText('chapter', $event)" />
            </div>
            <div class="nf-field">
              <label class="nf-field__label">故事内时间</label>
              <AInput :value="node.timeLabel" size="small" placeholder="如：雨夜 / 三年后" @change="onText('timeLabel', $event)" />
            </div>
          </ATabPane>

          <!-- 内容 -->
          <ATabPane key="content" tab="内容">
            <div class="nf-field">
              <label class="nf-field__label">摘要<span class="nf-field__tip">卡片上展示，限 2 行 · 右键可唤 AI</span></label>
              <ATextarea
                :value="fieldValue('summary')"
                :auto-size="{ minRows: 2, maxRows: 4 }"
                placeholder="一句话讲清这个节点发生了什么"
                @change="onText('summary', $event)"
                @contextmenu.prevent="onTextContextMenu('summary', $event)"
              />
            </div>
            <div class="nf-field">
              <label class="nf-field__label">备注<span class="nf-field__tip">AI 可写，作者补充 · 右键可唤 AI</span></label>
              <ATextarea
                :value="fieldValue('note')"
                :auto-size="{ minRows: 2, maxRows: 4 }"
                placeholder="伏笔、素材、写作提示…"
                @change="onText('note', $event)"
                @contextmenu.prevent="onTextContextMenu('note', $event)"
              />
            </div>
            <AButton block class="nf-inspector__write" @click="openStory">
              <span class="nf-inspector__write-icon">✎</span> 编写正文
            </AButton>
          </ATabPane>

          <!-- 要素 -->
          <ATabPane key="elements" tab="要素">
            <div class="nf-field">
              <label class="nf-field__label">地点</label>
              <AInput :value="node.location" size="small" placeholder="如：旧码头" @change="onText('location', $event)" />
            </div>
            <div class="nf-field">
              <label class="nf-field__label">人物<span class="nf-field__tip">回车增删</span></label>
              <TagInput :model-value="node.characters" placeholder="输入人物名后回车" @update:model-value="setCharacters" />
            </div>
            <div class="nf-field">
              <label class="nf-field__label">标签<span class="nf-field__tip">回车增删</span></label>
              <TagInput :model-value="node.tags" placeholder="输入标签后回车" @update:model-value="setTags" />
            </div>
          </ATabPane>

          <!-- 状态 -->
          <ATabPane key="status" tab="状态">
            <div class="nf-field">
              <label class="nf-field__label">写作进度</label>
              <ARadioGroup :value="node.status" class="nf-seg" @change="onStatusChange">
                <ARadioButton v-for="s in NODE_STATUSES" :key="s" :value="s">
                  {{ STATUS_LABEL[s] }}
                </ARadioButton>
              </ARadioGroup>
            </div>
            <div class="nf-field">
              <label class="nf-field__label">主色</label>
              <div class="nf-swatches">
                <button
                  v-for="s in swatches"
                  :key="s.key"
                  class="nf-swatch"
                  :class="{ 'is-active': node.color === s.key }"
                  :style="{ '--swatch': `var(${s.cssVar})` }"
                  :title="s.label"
                  @click="pickColor(s.key)"
                />
                <span
                  class="nf-swatch nf-swatch--custom"
                  :class="{ 'is-active': isCustomColor }"
                  :style="{ '--swatch': customColor }"
                  title="自定义"
                >
                  <input v-model="customColor" type="color" class="nf-swatch__picker" @input="applyCustomColor" />
                </span>
              </div>
            </div>
          </ATabPane>

          <!-- 图像 -->
          <ATabPane key="image" tab="图像">
            <div v-if="node.image?.url" class="nf-image">
              <img :src="node.image.url" alt="节点配图" class="nf-image__thumb" />
              <div class="nf-image__meta">
                <span class="nf-image__tip">已挂插图</span>
                <APopconfirm title="移除这张配图？" ok-text="移除" cancel-text="保留" @confirm="removeImage">
                  <AButton size="small" danger>移除图片</AButton>
                </APopconfirm>
              </div>
            </div>
            <div v-else class="nf-image nf-image--empty">
              <AEmpty description="还没有配图" />
            </div>
            <AButton block type="primary" class="nf-inspector__ai" @click="emit('open-ai-image')">
              <span class="nf-inspector__ai-icon">✦</span> AI 生图
            </AButton>
          </ATabPane>

          <!-- 关联：知识条目 / 文档（数据经 kbClient 按 nodeId 反查，事实源在 db） -->
          <ATabPane key="kb" tab="关联">
            <div class="nf-field">
              <label class="nf-field__label">关联知识<span class="nf-field__tip">去知识库面板可挂载 / 解绑</span></label>
              <div v-if="nodeLinks.entries.length" class="nf-kb-list">
                <div v-for="entry in nodeLinks.entries" :key="entry.id" class="nf-kb-link">
                  <span class="nf-kb-link__type">{{ ENTRY_TYPE_LABEL[entry.type] ?? '笔记' }}</span>
                  <span class="nf-kb-link__title" :title="entry.title">{{ entry.title }}</span>
                  <button class="nf-kb-link__remove" title="解除关联" @click="onUnlinkEntry(entry.id)">×</button>
                </div>
              </div>
              <p v-else class="nf-kb-empty">还没有关联的知识条目</p>
              <AButton block class="nf-inspector__write" @click="openKbPanel">浏览知识库</AButton>
            </div>
            <div class="nf-field">
              <label class="nf-field__label">关联文档<span class="nf-field__tip">划词建锚点见知识库面板</span></label>
              <div v-if="nodeLinks.docs.length" class="nf-kb-list">
                <div v-for="doc in nodeLinks.docs" :key="doc.id" class="nf-kb-link">
                  <span class="nf-kb-link__type">{{ doc.format.toUpperCase() }}</span>
                  <span class="nf-kb-link__title" :title="doc.title">{{ doc.title }}</span>
                  <button class="nf-kb-link__remove" title="解除关联" @click="onUnlinkDoc(doc.id)">×</button>
                </div>
              </div>
              <p v-else class="nf-kb-empty">还没有关联的文档</p>
            </div>
          </ATabPane>
        </ATabs>

        <!-- 底部：复制 / 删除 -->
        <footer class="nf-inspector__footer">
          <AButton block @click="duplicateNode">复制节点</AButton>
          <APopconfirm title="删除这个节点？连线会一并移除" ok-text="删除" cancel-text="取消" @confirm="removeNode">
            <AButton block danger>删除节点</AButton>
          </APopconfirm>
        </footer>
      </div>
    </div>
  </aside>

  <!-- 浮层由 Teleport 挂到 body，不影响检查器自身的布局流 -->
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
.nf-inspector__reopen {
  position: absolute;
  top: 50%;
  right: 0;
  transform: translateY(-50%);
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 30px;
  padding: 10px 0;
  border: 1px solid var(--nf-shell-line);
  border-right: none;
  border-radius: 12px 0 0 12px;
  background: var(--nf-shell-800);
  color: var(--nf-on-dark-soft);
  cursor: pointer;
  font-size: 11px;
  letter-spacing: 0.1em;
  writing-mode: vertical-rl;
  transition:
    color var(--nf-dur-fast) var(--nf-ease),
    background var(--nf-dur-fast) var(--nf-ease);
}
.nf-inspector__reopen:hover {
  color: var(--nf-teal);
  background: var(--nf-shell-700);
}

.nf-inspector {
  flex: none;
  width: 320px;
  height: 100%;
  background: var(--nf-shell-800);
  border-left: 1px solid var(--nf-shell-line);
  overflow: hidden;
  transition: width var(--nf-dur) var(--nf-ease);
}
.nf-inspector.is-collapsed {
  width: 0;
  border-left: none;
}
.nf-inspector__inner {
  width: 320px;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* ---------------- 头部 ---------------- */
.nf-inspector__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 14px 10px;
  border-bottom: 1px solid var(--nf-shell-line-soft);
}
.nf-inspector__head-title {
  font-size: var(--nf-fs-sm);
  font-weight: 600;
  color: var(--nf-on-dark-strong);
  letter-spacing: 0.02em;
}
.nf-inspector__kind {
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.06em;
  color: var(--nf-teal);
  background: rgba(77, 208, 217, 0.12);
  border-radius: var(--nf-r-chip);
  padding: 2px 8px;
}
.nf-inspector__kind.is-decision { color: var(--nf-gold); background: rgba(201, 162, 39, 0.14); }
.nf-inspector__kind.is-milestone { color: var(--nf-on-dark-soft); background: rgba(148, 172, 196, 0.14); }
.nf-inspector__collapse {
  margin-left: auto;
  appearance: none;
  border: none;
  background: transparent;
  color: var(--nf-on-dark-faint);
  width: 26px;
  height: 26px;
  border-radius: 7px;
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: color var(--nf-dur-fast) var(--nf-ease), background var(--nf-dur-fast) var(--nf-ease);
}
.nf-inspector__collapse:hover {
  color: var(--nf-teal);
  background: rgba(77, 208, 217, 0.1);
}

/* ---------------- 标题 ---------------- */
.nf-inspector__title {
  padding: 12px 14px 4px;
}

/* ---------------- 总览态 ---------------- */
.nf-inspector__overview {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}
.nf-inspector__ring {
  display: grid;
  place-items: center;
  padding: 18px 0 8px;
}
.nf-inspector__ring-num {
  font-size: 26px;
  font-weight: 700;
  color: var(--nf-on-dark-strong);
  font-variant-numeric: tabular-nums;
}
.nf-inspector__ring-num i {
  font-size: 13px;
  font-style: normal;
  margin-left: 1px;
  color: var(--nf-on-dark-soft);
}
.nf-inspector__ring-label {
  display: block;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--nf-on-dark-faint);
  margin-top: 2px;
}
.nf-inspector__stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  padding: 6px 14px 0;
}
.nf-inspector__stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 14px;
  border-radius: var(--nf-r-card-sm);
  background: var(--nf-shell-700);
  border: 1px solid var(--nf-shell-line-soft);
}
.nf-inspector__stat-num {
  font-size: 21px;
  font-weight: 700;
  color: var(--nf-on-dark-strong);
  font-variant-numeric: tabular-nums;
}
.nf-inspector__stat-label {
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.08em;
  color: var(--nf-on-dark-faint);
}

/* ---------------- 一致性：总览格 + 节点问题块 ---------------- */
/* 总览格：与其它统计格同 chrome，通栏放置 + 整格可点（跳控制台一致性面板） */
.nf-inspector__stat--cons {
  grid-column: 1 / -1;
  appearance: none;
  font: inherit;
  text-align: left;
  /* Chromium UA 给 button 设了 align-items: center，会盖掉统计格 flex 列布局的
     stretch 默认值，通栏格内容被水平居中；flex 子项不受 text-align 管辖，须显式重置 */
  align-items: stretch;
  cursor: pointer;
  transition:
    border-color var(--nf-dur-fast) var(--nf-ease),
    background var(--nf-dur-fast) var(--nf-ease);
}
.nf-inspector__stat--cons:hover {
  border-color: var(--nf-teal);
  background: color-mix(in srgb, var(--nf-teal) 7%, var(--nf-shell-700));
}
.nf-inspector__cons-line {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: var(--nf-fs-xs);
  color: var(--nf-on-dark-soft);
}
.nf-inspector__cons-empty {
  color: var(--nf-on-dark-faint);
  opacity: 0.72;
}
.nf-cons-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}
.nf-cons-num {
  font-size: var(--nf-fs-sm);
  font-weight: 700;
  color: var(--nf-on-dark-strong);
  font-variant-numeric: tabular-nums;
}
.nf-cons-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 999px;
}
.nf-cons-item.is-error .nf-cons-dot,
.nf-inspector__cons-item.is-error .nf-cons-dot {
  background: var(--nf-danger);
}
.nf-cons-item.is-warn .nf-cons-dot,
.nf-inspector__cons-item.is-warn .nf-cons-dot {
  background: var(--nf-gold);
}
.nf-cons-item.is-info .nf-cons-dot,
.nf-inspector__cons-item.is-info .nf-cons-dot {
  background: var(--nf-teal);
}

/* 节点问题块：紧凑列表，严重级色点 + message + hint（弱化小字） */
.nf-inspector__cons {
  margin: 10px 14px 0;
  padding: 10px 12px;
  border-radius: var(--nf-r-card-sm);
  background: var(--nf-shell-700);
  border: 1px solid var(--nf-shell-line-soft);
}
.nf-inspector__cons-title {
  display: block;
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.08em;
  color: var(--nf-on-dark-faint);
  margin-bottom: 6px;
}
.nf-inspector__cons-item {
  display: flex;
  gap: 8px;
  padding: 6px 0;
}
.nf-inspector__cons-item + .nf-inspector__cons-item {
  border-top: 1px solid var(--nf-shell-line-soft);
}
.nf-inspector__cons-item .nf-cons-dot {
  margin-top: 5px;
}
.nf-inspector__cons-body {
  min-width: 0;
}
.nf-inspector__cons-msg {
  margin: 0;
  font-size: var(--nf-fs-xs);
  line-height: 1.6;
  color: var(--nf-on-dark);
}
.nf-inspector__cons-hint {
  margin: 2px 0 0;
  font-size: var(--nf-fs-2xs);
  line-height: 1.6;
  color: var(--nf-on-dark-faint);
  opacity: 0.72;
}

.nf-inspector__hint {
  margin: 14px 14px 0;
  font-size: var(--nf-fs-2xs);
  line-height: 1.7;
  color: var(--nf-on-dark-faint);
}
.nf-inspector__empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  text-align: center;
}
.nf-inspector__empty-art {
  width: 190px;
  height: 114px;
  opacity: 0.95;
}
.nf-inspector__empty-stroke {
  fill: none;
  stroke-width: 2.4;
  stroke-linecap: round;
}
.nf-inspector__empty-stroke.is-faint {
  stroke: var(--nf-gold);
  stroke-width: 2;
  opacity: 0.42;
}
.nf-inspector__empty-dot { fill: var(--nf-teal); }
.nf-inspector__empty-dot.is-branch { fill: var(--nf-gold); }
.nf-inspector__empty-card {
  fill: rgba(34, 48, 63, 0.7);
  stroke: var(--nf-teal);
  stroke-width: 1.4;
}
.nf-inspector__empty-title {
  margin: 0;
  font-size: var(--nf-fs-lg);
  font-weight: 600;
  color: var(--nf-on-dark-strong);
}
.nf-inspector__empty-desc {
  margin: 0;
  max-width: 240px;
  font-size: var(--nf-fs-xs);
  line-height: 1.7;
  color: var(--nf-on-dark-soft);
}
.nf-inspector__empty-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

/* ---------------- 节点编辑态 ---------------- */
.nf-inspector__node {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.nf-inspector__tabs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0 14px;
}
.nf-inspector__tabs :deep(.ant-tabs-content-holder) {
  overflow-y: auto;
}
.nf-inspector__tabs :deep(.ant-tabs-nav) {
  margin-bottom: 12px;
}
.nf-inspector__tabs :deep(.ant-tabs-tab) {
  color: var(--nf-on-dark-faint);
  font-size: var(--nf-fs-xs);
}
.nf-inspector__tabs :deep(.ant-tabs-tab-active .ant-tabs-tab-btn) {
  color: var(--nf-teal) !important;
}
.nf-inspector__tabs :deep(.ant-tabs-ink-bar) {
  background: var(--nf-teal);
}

/* ---------------- 字段 ---------------- */
.nf-field {
  margin-bottom: 14px;
}
.nf-field__label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.06em;
  color: var(--nf-on-dark-faint);
  margin-bottom: 6px;
}
.nf-field__tip {
  font-size: 10px;
  letter-spacing: 0.02em;
  color: var(--nf-on-dark-faint);
  opacity: 0.7;
}

/* 状态分段控制 */
.nf-seg {
  display: flex;
  width: 100%;
}
.nf-seg :deep(.ant-radio-button-wrapper) {
  flex: 1;
  text-align: center;
  font-size: var(--nf-fs-xs);
}

/* 颜色色卡 */
.nf-swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.nf-swatch {
  appearance: none;
  border: 2px solid transparent;
  width: 26px;
  height: 26px;
  border-radius: 999px;
  background: var(--swatch);
  cursor: pointer;
  position: relative;
  box-shadow: 0 0 0 1px var(--nf-shell-line);
  transition: transform var(--nf-dur-fast) var(--nf-ease), box-shadow var(--nf-dur-fast) var(--nf-ease);
}
.nf-swatch:hover {
  transform: scale(1.08);
}
.nf-swatch.is-active {
  box-shadow: 0 0 0 2px var(--nf-shell-800), 0 0 0 4px var(--nf-teal);
}
.nf-swatch--custom {
  display: grid;
  place-items: center;
  overflow: hidden;
}
.nf-swatch__picker {
  width: 200%;
  height: 200%;
  border: none;
  background: transparent;
  cursor: pointer;
  opacity: 0;
}

/* 图像 */
.nf-image {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 8px;
  border-radius: var(--nf-r-card-sm);
  background: var(--nf-shell-700);
  border: 1px solid var(--nf-shell-line-soft);
}
.nf-image__thumb {
  width: 100%;
  height: 150px;
  object-fit: cover;
  border-radius: 10px;
}
.nf-image__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.nf-image__tip {
  font-size: var(--nf-fs-2xs);
  color: var(--nf-on-dark-soft);
}

.nf-inspector__write,
.nf-inspector__ai {
  margin-top: 4px;
}
.nf-inspector__write-icon,
.nf-inspector__ai-icon {
  margin-right: 4px;
  color: var(--nf-teal);
}
.nf-inspector__ai-icon {
  color: var(--nf-gold);
}

/* 底部操作 */
.nf-inspector__footer {
  display: flex;
  gap: 8px;
  padding: 12px 14px;
  border-top: 1px solid var(--nf-shell-line-soft);
}

/* ---------------- 关联（知识 / 文档） ---------------- */
.nf-kb-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}
.nf-kb-link {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
  border-radius: var(--nf-r-ctl);
  background: var(--nf-shell-700);
  border: 1px solid var(--nf-shell-line-soft);
  font-size: var(--nf-fs-xs);
  color: var(--nf-on-dark);
}
.nf-kb-link__type {
  flex: none;
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--nf-teal);
  background: rgba(77, 208, 217, 0.12);
  border-radius: var(--nf-r-chip);
  padding: 1px 6px;
}
.nf-kb-link__title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nf-kb-link__remove {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--nf-on-dark-faint);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 6px;
  transition: color var(--nf-dur-fast) var(--nf-ease), background var(--nf-dur-fast) var(--nf-ease);
}
.nf-kb-link__remove:hover {
  color: var(--nf-danger);
  background: rgba(200, 106, 99, 0.12);
}
.nf-kb-empty {
  margin: 0 0 8px;
  font-size: var(--nf-fs-2xs);
  color: var(--nf-on-dark-faint);
}
</style>
