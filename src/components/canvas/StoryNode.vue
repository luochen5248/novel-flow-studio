<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { StoryNode } from '@/types/graph'
import { STATUS_LABEL, KIND_LABEL } from '@/types/graph'
import NodeHandles from './NodeHandles.vue'
import { mountedNodes } from '@/core/characterRename'

const props = withDefaults(
  defineProps<{
    node: StoryNode
    selected?: boolean
    /** 入场动画的 stagger 序号 */
    index?: number
    dimmed?: boolean
    locked?: boolean
    /** 连线 / 人物卡片拖放时的吸附目标高亮 */
    snapping?: boolean
    /** 全图节点（供人物卡片统计「已挂载 N」）。默认空数组 ⇒ mountCount 恒 0 */
    allNodes?: StoryNode[]
  }>(),
  { selected: false, index: 0, dimmed: false, locked: false, snapping: false, allNodes: () => [] }
)

const emit = defineEmits<{
  (e: 'select', id: string, additive: boolean): void
  (e: 'drag-start', evt: PointerEvent, node: StoryNode): void
  (e: 'insert-after', id: string): void
  (e: 'insert-before', id: string): void
  (e: 'insert-branch', id: string, dir: 1 | -1): void
  (e: 'remove', id: string): void
  (e: 'open-story', id: string): void
  (e: 'port-down', evt: PointerEvent, node: StoryNode, side: 'top' | 'bottom' | 'left' | 'right'): void
  /** 点角色牌上的「已挂载 N」→ 选中并定位到这些节点 */
  (e: 'locate-character', id: string): void
  /** 角色牌就地改名（回车 / 失焦提交，Esc 取消） */
  (e: 'rename-character', id: string, name: string): void
}>()

const hovered = ref(false)
const renaming = ref(false)
const renameDraft = ref('')
const renameInput = ref<HTMLInputElement | null>(null)

/** foreignObject 会裁剪内容，留出内边距让柔阴影 / 外发光有地方呼吸 */
const PAD = 30

const colorClass = computed(() => `nf-node--${props.node.color || 'teal'}`)
const statusClass = computed(() => `is-${props.node.status}`)
const enterDelay = computed(() => `${Math.min(props.index, 24) * 30}ms`)
/** 人物卡片：更窄、clay 色系、走另一套内部排版，视觉上明显区别于事件卡 */
const isCharacter = computed(() => props.node.kind === 'character')

/**
 * 人物行的折叠标签：超过 3 人时不给卡片塞一串名字（角色牌已经够挤），
 * 改成「阿霁 · 小霁 等 4 人」，完整列表放进 title 悬浮。
 */
const charLabel = computed(() => {
  const cs = props.node.characters
  if (!cs.length) return ''
  if (cs.length <= 3) return cs.join(' · ')
  return `${cs.slice(0, 2).join(' · ')} 等 ${cs.length} 人`
})

/** 人物完整列表的悬浮文案 */
const charTitle = computed(() => (props.node.characters.length ? props.node.characters.join('、') : ''))

/**
 * 该人物已被挂到哪些节点上。
 *
 * 口径来自 `core/characterRename.mountedNodes` —— chip 统计、视口定位、
 * 级联改名三处共用同一个谓词，避免「这里按 trim 比、那里按精确比」的双份实现。
 */
const mounted = computed(() => mountedNodes(props.allNodes ?? [], props.node))
const mountCount = computed(() => mounted.value.length)
const mountNames = computed(() =>
  mounted.value.map((n) => n.title || '未命名节点').join('、')
)

function onCardDown(e: PointerEvent): void {
  // 阻止冒泡到 SVG 根，否则会顺带触发框选
  e.stopPropagation()
  emit('select', props.node.id, e.shiftKey || e.metaKey)
  if (!props.locked) emit('drag-start', e, props.node)
}

/**
 * 双击节点 → 打开右侧正文抽屉。
 *
 * 拖拽不会误触、也不会污染撤销栈：useNodeDrag 的 onMove 在位移小于 2px 时
 * 直接 return，走不到 `commit('移动节点')`，所以双击产生的两次按下不会压进历史。
 *
 * 人物卡片例外：双击不打开抽屉（正文对角色牌没意义），改为就地改名。
 */
function onCardDblClick(e: MouseEvent): void {
  e.stopPropagation()
  if (isCharacter.value) {
    beginRename()
    return
  }
  emit('open-story', props.node.id)
}

/** 进入就地改名：预填当前名、聚焦并全选 */
async function beginRename(): Promise<void> {
  renameDraft.value = props.node.title
  renaming.value = true
  await nextTick()
  renameInput.value?.focus()
  renameInput.value?.select()
}

/** 提交改名：空名直接忽略，Esc 走 cancelRename 不入这里 */
function commitRename(): void {
  if (!renaming.value) return
  renaming.value = false
  const name = renameDraft.value.trim()
  if (name && name !== props.node.title) {
    emit('rename-character', props.node.id, name)
  }
}

function cancelRename(): void {
  renaming.value = false
  renameDraft.value = ''
}
</script>

<template>
  <g
    :class="[
      'nf-story-node',
      colorClass,
      { 'is-selected': selected, 'is-dimmed': dimmed, 'is-snapping': snapping, 'is-character': isCharacter }
    ]"
    :transform="`translate(${node.x}, ${node.y})`"
    @pointerenter="hovered = true"
    @pointerleave="hovered = false"
  >
    <!-- 吸附目标提示：实线主色描边 + 克制外发光（虚线蚂蚁框被视觉红线禁用） -->
    <rect
      v-if="snapping && !selected"
      class="nf-node__snap"
      :x="-3"
      :y="-3"
      :width="node.w + 6"
      :height="node.h + 6"
      :rx="21"
    />

    <!-- 外发光（选中态）：不用虚线蚂蚁框，用主色描边 + 柔光 -->
    <rect
      v-if="selected"
      class="nf-node__halo"
      :x="-3"
      :y="-3"
      :width="node.w + 6"
      :height="node.h + 6"
      :rx="21"
    />

    <foreignObject
      :x="-PAD"
      :y="-PAD"
      :width="node.w + PAD * 2"
      :height="node.h + PAD * 2"
      class="nf-node__fo"
    >
      <div
        class="nf-card-wrap"
        :style="{ padding: `${PAD}px`, animationDelay: enterDelay }"
        @pointerdown="onCardDown"
        @dblclick="onCardDblClick"
      >
        <article class="nf-card" :class="[statusClass, { 'is-hover': hovered }]">
          <span class="nf-card__bar" aria-hidden="true" />

          <!-- 人物卡片：角色牌式排版（头像位 + 名字 + 一句身份），明显区别于事件卡 -->
          <template v-if="isCharacter">
            <div class="nf-char">
              <span class="nf-char__avatar" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="22" height="22">
                  <circle cx="12" cy="8.6" r="3.6" fill="none" stroke="currentColor" stroke-width="1.4" />
                  <path d="M4.8 19.4 C4.8 15.8 8 13.6 12 13.6 C16 13.6 19.2 15.8 19.2 19.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
                </svg>
              </span>
              <div class="nf-char__body">
                <h3 class="nf-char__name">{{ node.title || '未命名人物' }}</h3>
                <span class="nf-char__hint">拖到事件节点上挂载</span>
              </div>
              <!-- 已挂载节点数：点击选中并定位到它们 -->
              <button
                v-if="mountCount > 0"
                class="nf-char__mount"
                type="button"
                :title="`已挂到 ${mountCount} 个节点：${mountNames}`"
                @pointerdown.stop
                @dblclick.stop
                @click.stop="emit('locate-character', node.id)"
              >
                已挂载 {{ mountCount }}
              </button>
            </div>
            <p v-if="node.summary" class="nf-char__summary">{{ node.summary }}</p>
          </template>

          <template v-else>
            <header class="nf-card__head">
              <h3 class="nf-card__title">{{ node.title }}</h3>
              <span class="nf-card__kind">{{ KIND_LABEL[node.kind] }}</span>
            </header>

            <div class="nf-card__time">
              <span class="nf-card__dot" />
              <span class="nf-time-badge">{{ node.timeLabel || '未标时间' }}</span>
            </div>

            <p v-if="node.summary" class="nf-card__summary">{{ node.summary }}</p>
            <p v-else class="nf-card__summary is-empty">还没有写摘要 —— 双击节点展开正文。</p>

            <footer v-if="charLabel || node.location || node.tags.length" class="nf-card__foot">
              <span v-if="charLabel" class="nf-card__meta" :title="charTitle">{{ charLabel }}</span>
              <span v-if="node.location" class="nf-card__meta">{{ node.location }}</span>
              <span class="nf-card__spacer" />
              <span v-for="t in node.tags.slice(0, 2)" :key="t" class="nf-card__tag">{{ t }}</span>
              <span class="nf-card__status" :title="STATUS_LABEL[node.status]">
                <i />{{ STATUS_LABEL[node.status] }}
              </span>
            </footer>
          </template>

          <span v-if="node.image?.url" class="nf-card__image-flag" title="已配插图" />

          <!-- 就地改名浮层：双击角色牌出现，覆盖整张卡，Esc 取消 / 回车或失焦提交 -->
          <div
            v-if="isCharacter && renaming"
            class="nf-rename"
            @pointerdown.stop
            @dblclick.stop
            @click.stop
          >
            <input
              ref="renameInput"
              v-model="renameDraft"
              class="nf-rename__input"
              type="text"
              placeholder="人物名字"
              @blur="commitRename"
              @keydown.enter.prevent="commitRename"
              @keydown.esc.prevent="cancelRename"
            />
          </div>
        </article>
      </div>
    </foreignObject>

    <NodeHandles
      :node="node"
      :visible="hovered || selected"
      :locked="locked"
      @insert-after="emit('insert-after', node.id)"
      @insert-before="emit('insert-before', node.id)"
      @insert-branch="(dir) => emit('insert-branch', node.id, dir)"
      @remove="emit('remove', node.id)"
      @open-story="emit('open-story', node.id)"
      @port-down="(evt, side) => emit('port-down', evt, node, side)"
    />
  </g>
</template>

<style scoped>
.nf-story-node {
  transition: opacity var(--nf-dur) var(--nf-ease);
}
.nf-story-node.is-dimmed {
  opacity: 0.38;
}

.nf-node__fo {
  overflow: visible;
}

.nf-card-wrap {
  width: 100%;
  height: 100%;
  animation: nf-fade-up var(--nf-dur-slow) var(--nf-ease) both;
  cursor: grab;
}
.nf-card-wrap:active {
  cursor: grabbing;
}

/* ---------- 卡片本体 ---------- */
.nf-card {
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: var(--nf-r-card);
  background: var(--nf-card-bg);
  box-shadow: var(--nf-shadow-card);
  border: 1px solid var(--nf-card-hairline);
  padding: 14px 16px 12px 22px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transform: translateY(0);
  transition:
    transform var(--nf-dur-fast) var(--nf-ease),
    box-shadow var(--nf-dur-fast) var(--nf-ease),
    border-color var(--nf-dur-fast) var(--nf-ease);
}

.nf-card.is-hover {
  transform: translateY(-2px);
  box-shadow: var(--nf-shadow-card-hover);
}

/* 左侧 4px 主色导条 */
.nf-card__bar {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  background: var(--nf-card-bar);
  border-radius: var(--nf-r-card) 0 0 var(--nf-r-card);
  opacity: 0.92;
}

/* ---------- 第一层：标题 ---------- */
.nf-card__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 5px;
}

.nf-card__title {
  margin: 0;
  font-size: var(--nf-fs-md);
  line-height: var(--nf-lh-tight);
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--nf-card-title);
  flex: 1 1 auto;
  min-width: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.nf-card__kind {
  flex: none;
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.06em;
  color: var(--nf-card-ink);
  background: rgba(21, 34, 44, 0.07);
  background: color-mix(in srgb, var(--nf-card-ink) 10%, transparent);
  border-radius: var(--nf-r-chip);
  padding: 2px 7px;
  white-space: nowrap;
}

/* ---------- 第二层：时间徽标 ---------- */
.nf-card__time {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 2px 8px 2px 6px;
  margin-bottom: 6px;
  border-radius: var(--nf-r-chip);
  background: rgba(21, 34, 44, 0.06);
  background: color-mix(in srgb, var(--nf-card-ink) 9%, transparent);
  color: var(--nf-card-ink);
  max-width: 100%;
}

.nf-card__dot {
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: var(--nf-card-bar);
  box-shadow: 0 0 0 3px rgba(21, 34, 44, 0.08);
  flex: none;
}

.nf-time-badge {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 第三层：摘要 ---------- */
.nf-card__summary {
  margin: 0;
  font-size: var(--nf-fs-xs);
  line-height: var(--nf-lh-body);
  color: var(--nf-card-body);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.nf-card__summary.is-empty {
  color: var(--nf-card-meta);
  font-style: italic;
  opacity: 0.72;
}

/* ---------- 页脚：人物 / 地点 / 标签 / 状态 ---------- */
.nf-card__foot {
  margin-top: auto;
  padding-top: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.nf-card__meta {
  font-size: var(--nf-fs-2xs);
  color: var(--nf-card-meta);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.nf-card__spacer {
  flex: 1 1 auto;
}

.nf-card__tag {
  flex: none;
  font-size: var(--nf-fs-2xs);
  color: var(--nf-card-ink);
  border: 1px solid rgba(21, 34, 44, 0.16);
  border-radius: var(--nf-r-chip);
  padding: 1px 6px;
  white-space: nowrap;
}

.nf-card__status {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--nf-fs-2xs);
  color: var(--nf-card-meta);
}

.nf-card__status i {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--nf-card-meta);
}
.is-drafted .nf-card__status i {
  background: var(--nf-gold);
}
.is-done .nf-card__status i {
  background: var(--nf-ok);
}

.nf-card__image-flag {
  position: absolute;
  right: 10px;
  bottom: 10px;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--nf-teal);
  box-shadow: 0 0 0 3px var(--nf-teal-mist);
}

/* ---------- 选中：主色 2px 描边 + 8px 外发光 ---------- */
.nf-node__halo {
  fill: none;
  stroke: var(--nf-card-ring);
  stroke-width: 2;
  filter: drop-shadow(0 0 8px var(--nf-card-ring));
  animation: nf-fade-in var(--nf-dur-fast) var(--nf-ease) both;
  pointer-events: none;
}

/* ---------- 吸附目标提示（连线 / 人物拖放）---------- */
/* 实线主色描边 + 克制外发光。
   与选中态 halo 的区分靠「更细的描边 + 更冷的青色调 + 更轻的辉光」，不用虚线
   —— plan.md 第 8 节明令禁止虚线蚂蚁框。 */
.nf-node__snap {
  fill: none;
  stroke: var(--nf-teal);
  stroke-width: 1.5px;
  opacity: 0.85;
  filter: drop-shadow(0 0 5px var(--nf-teal-mist));
  animation: nf-fade-in var(--nf-dur-fast) var(--nf-ease) both;
  pointer-events: none;
}
.nf-story-node.is-character .nf-node__snap {
  stroke: var(--nf-node-clay-ring);
  filter: drop-shadow(0 0 5px var(--nf-node-clay-ring));
}

/* ---------- 人物卡片（角色牌）---------- */
/* 与事件卡明显区分：窄、矮、无左侧导条强调、clay 色系、大圆角 */
.nf-story-node.is-character .nf-card {
  padding: 12px 14px;
  border-radius: var(--nf-r-card-sm);
  border-width: 1.5px;
  border-style: solid;
  border-color: var(--nf-node-clay-ring);
}
.nf-story-node.is-character .nf-card__bar {
  display: none;
}

.nf-char {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.nf-char__avatar {
  flex: none;
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  color: var(--nf-node-clay-ink);
  background: color-mix(in srgb, var(--nf-node-clay-ink) 12%, transparent);
}

.nf-char__body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nf-char__name {
  margin: 0;
  font-size: var(--nf-fs-sm);
  font-weight: 600;
  line-height: var(--nf-lh-tight);
  color: var(--nf-node-clay-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nf-char__hint {
  font-size: var(--nf-fs-2xs);
  color: var(--nf-card-meta);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nf-char__summary {
  margin: 8px 0 0;
  font-size: var(--nf-fs-xs);
  line-height: var(--nf-lh-body);
  color: var(--nf-card-body);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* 已挂载数：小尺寸 chip，克制 —— 不当红点 / badge 堆叠 */
.nf-char__mount {
  appearance: none;
  flex: none;
  margin-left: auto;
  font-size: var(--nf-fs-2xs);
  line-height: 1;
  color: var(--nf-node-clay-ink);
  background: color-mix(in srgb, var(--nf-node-clay-ink) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--nf-node-clay-ink) 22%, transparent);
  border-radius: var(--nf-r-chip);
  padding: 4px 8px;
  cursor: pointer;
  white-space: nowrap;
  transition:
    background var(--nf-dur-fast) var(--nf-ease),
    border-color var(--nf-dur-fast) var(--nf-ease),
    color var(--nf-dur-fast) var(--nf-ease);
}
.nf-char__mount:hover {
  background: color-mix(in srgb, var(--nf-node-clay-ink) 18%, transparent);
  border-color: var(--nf-node-clay-ring);
}

/* 就地改名浮层：覆盖整张卡片，输入框走卡片级圆角与描边 */
.nf-rename {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 8px;
  background: var(--nf-card-bg);
  border-radius: var(--nf-r-card-sm);
  z-index: 2;
}
.nf-rename__input {
  appearance: none;
  width: 100%;
  font-size: var(--nf-fs-sm);
  font-weight: 600;
  font-family: inherit;
  color: var(--nf-node-clay-ink);
  background: color-mix(in srgb, var(--nf-node-clay-ink) 6%, transparent);
  border: 1.5px solid var(--nf-node-clay-ring);
  border-radius: var(--nf-r-ctl);
  padding: 6px 9px;
  outline: none;
  text-align: center;
}
.nf-rename__input:focus {
  border-color: var(--nf-node-clay-ink);
}

.nf-story-node.is-selected .nf-card {
  box-shadow: var(--nf-shadow-card-hover);
}
</style>
