<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PortSide, StoryNode } from '@/types/graph'
import { useFlowStore } from '@/stores/useFlowStore'
import { useUiStore } from '@/stores/useUiStore'
import { useViewport } from '@/composables/useViewport'
import { useNodeDrag } from '@/composables/useNodeDrag'
import { useSelection } from '@/composables/useSelection'
import { boundsOf, buildEdgeGeom } from '@/core/geometry'
import CanvasGrid from './CanvasGrid.vue'
import TimeRail from './TimeRail.vue'
import EdgeLayer from './EdgeLayer.vue'
import StoryNodeCard from './StoryNode.vue'
import SelectionBox from './SelectionBox.vue'
import Minimap from './Minimap.vue'
import { isAttachable, isCharacterCard } from './characterCard'
import { mountedNodes } from '@/core/characterRename'
import { centerOf, nearestNode, snapTolerance } from './snap'

const store = useFlowStore()
const ui = useUiStore()
const viewport = useViewport()

const wrap = ref<HTMLElement | null>(null)
const svgRef = ref<SVGSVGElement | null>(null)

const drag = useNodeDrag(svgRef, viewport)
const selection = useSelection(svgRef, viewport)

const spaceDown = ref(false)
const panning = ref(false)
const selectedEdgeId = ref<string | null>(null)

/** 正在拉线：从某个 port 出发 */
const pending = ref<{
  sourceId: string
  side: PortSide
  x: number
  y: number
  moved: boolean
} | null>(null)

/** 正在改写连线端点 */
const reconnect = ref<{ edgeId: string; end: 'source' | 'target'; x: number; y: number } | null>(
  null
)

const canvasMode = computed(() => ui.canvasTheme)
const graph = computed(() => store.activeGraph)
const hasNodes = computed(() => store.nodes.length > 0)
const worldBounds = computed(() => boundsOf(store.nodes, 120))

/* ---------------- 尺寸同步 ---------------- */

let ro: ResizeObserver | null = null
onMounted(() => {
  const el = wrap.value
  if (!el) return
  const sync = () => viewport.setSize(el.clientWidth, el.clientHeight)
  sync()
  ro = new ResizeObserver(sync)
  ro.observe(el)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  // 首屏自动适应
  requestAnimationFrame(() => fitView())
})
onBeforeUnmount(() => {
  ro?.disconnect()
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
})

function fitView(): void {
  viewport.fit(worldBounds.value, 90)
}

defineExpose({ fitView })

/* ---------------- 缩放 / 平移 ---------------- */

function onWheel(e: WheelEvent): void {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault()
    const factor = Math.exp(-e.deltaY * 0.0016)
    viewport.zoomAt(factor, e.clientX, e.clientY)
  } else {
    e.preventDefault()
    // 普通滚轮 = 平移（触控板两指也是这个分支）
    viewport.panBy(e.shiftKey ? -e.deltaY : -e.deltaX, e.shiftKey ? 0 : -e.deltaY)
  }
}

let panOrigin = { x: 0, y: 0 }

function startPan(e: PointerEvent): void {
  panning.value = true
  panOrigin = { x: e.clientX, y: e.clientY }
  window.addEventListener('pointermove', onPanMove)
  window.addEventListener('pointerup', endPan)
}

function onPanMove(e: PointerEvent): void {
  viewport.panBy(e.clientX - panOrigin.x, e.clientY - panOrigin.y)
  panOrigin = { x: e.clientX, y: e.clientY }
}

function endPan(): void {
  panning.value = false
  window.removeEventListener('pointermove', onPanMove)
  window.removeEventListener('pointerup', endPan)
}

function onBackgroundDown(e: PointerEvent): void {
  selectedEdgeId.value = null
  if (e.button === 1 || spaceDown.value || e.button === 2) {
    e.preventDefault()
    startPan(e)
    return
  }
  if (e.button === 0) {
    selection.startMarquee(e)
  }
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.code === 'Space' && !(e.target as HTMLElement)?.tagName?.match(/INPUT|TEXTAREA/)) {
    if (!spaceDown.value) {
      spaceDown.value = true
      e.preventDefault()
    }
  }
}
function onKeyUp(e: KeyboardEvent): void {
  if (e.code === 'Space') spaceDown.value = false
}

/* ---------------- 连接 / 改写连接 ---------------- */

function svgPoint(clientX: number, clientY: number): { x: number; y: number } {
  return viewport.clientToSvg(clientX, clientY, svgRef.value)
}

function hitNode(clientX: number, clientY: number): StoryNode | null {
  const p = svgPoint(clientX, clientY)
  const found = [...store.nodes]
    .reverse()
    .find((n) => p.x >= n.x && p.x <= n.x + n.w && p.y >= n.y && p.y <= n.y + n.h)
  return found ?? null
}

function onPortDown(e: PointerEvent, node: StoryNode, side: PortSide): void {
  if (ui.locked) return
  const p = svgPoint(e.clientX, e.clientY)
  pending.value = { sourceId: node.id, side, x: p.x, y: p.y, moved: false }
  window.addEventListener('pointermove', onPendingMove)
  window.addEventListener('pointerup', onPendingUp)
}

function onPendingMove(e: PointerEvent): void {
  const p = svgPoint(e.clientX, e.clientY)
  const cur = pending.value
  if (!cur) return
  if (Math.abs(p.x - cur.x) + Math.abs(p.y - cur.y) > 6) {
    cur.moved = true
  }
  cur.x = p.x
  cur.y = p.y
  // 最近邻吸附：靠近任意卡片即高亮并把线头吸到其中心，无需精准压住
  const near = nearestNode(p.x, p.y, store.nodes, {
    excludeId: cur.sourceId,
    tolerance: currentTolerance()
  })
  linkSnapTargetId.value = near ? near.id : null
  if (near) {
    const c = centerOf(near)
    cur.x = c.x
    cur.y = c.y
  }
}

function onPendingUp(e: PointerEvent): void {
  const cur = pending.value
  window.removeEventListener('pointermove', onPendingMove)
  window.removeEventListener('pointerup', onPendingUp)
  pending.value = null
  const snapped = linkSnapTargetId.value
  linkSnapTargetId.value = null
  if (!cur) return

  // 优先连到吸附目标
  if (cur.moved && snapped && snapped !== cur.sourceId) {
    const kind = cur.side === 'left' || cur.side === 'right' ? 'branch' : 'flow'
    store.connectNodes(cur.sourceId, snapped, kind)
    ui.notify('已连线')
    return
  }
  if (cur.moved) {
    // 无吸附目标时退回「精确压住」的原有命中逻辑
    const target = hitNode(e.clientX, e.clientY)
    if (target && target.id !== cur.sourceId) {
      const kind = cur.side === 'left' || cur.side === 'right' ? 'branch' : 'flow'
      store.connectNodes(cur.sourceId, target.id, kind)
      ui.notify('已连线')
    }
    return
  }
  // 没拖动 ⇒ 视作「快速插入」
  if (cur.side === 'bottom') store.insertNodeAfter(cur.sourceId)
  else if (cur.side === 'top') store.insertNodeBefore(cur.sourceId)
  else store.insertBranch(cur.sourceId, {}, cur.side === 'right' ? 1 : -1)
}

function onReconnectStart(e: PointerEvent, id: string, end: 'source' | 'target'): void {
  const p = svgPoint(e.clientX, e.clientY)
  reconnect.value = { edgeId: id, end, x: p.x, y: p.y }
  window.addEventListener('pointermove', onReconnectMove)
  window.addEventListener('pointerup', onReconnectUp)
}

function onReconnectMove(e: PointerEvent): void {
  const p = svgPoint(e.clientX, e.clientY)
  if (reconnect.value) {
    reconnect.value.x = p.x
    reconnect.value.y = p.y
  }
}

function onReconnectUp(e: PointerEvent): void {
  const cur = reconnect.value
  window.removeEventListener('pointermove', onReconnectMove)
  window.removeEventListener('pointerup', onReconnectUp)
  reconnect.value = null
  if (!cur) return
  const target = hitNode(e.clientX, e.clientY)
  if (target) store.reconnectEdge(cur.edgeId, cur.end, target.id)
}

/** 拉线预览曲线 */
const pendingPath = computed(() => {
  const cur = pending.value
  if (!cur) return null
  const node = store.nodes.find((n) => n.id === cur.sourceId)
  if (!node) return null
  const ghost: StoryNode = {
    ...node,
    id: '__ghost__',
    x: cur.x - 12,
    y: cur.y - 8,
    w: 24,
    h: 16
  }
  const kind = cur.side === 'left' || cur.side === 'right' ? 'branch' : 'flow'
  return buildEdgeGeom(node, ghost, kind, {
    direction: graph.value?.settings.direction ?? 'vertical'
  }).d
})

const reconnectPath = computed(() => {
  const cur = reconnect.value
  if (!cur) return null
  const edge = store.edges.find((e) => e.id === cur.edgeId)
  if (!edge) return null
  const anchorId = cur.end === 'source' ? edge.target : edge.source
  const anchor = store.nodes.find((n) => n.id === anchorId)
  if (!anchor) return null
  const ghost: StoryNode = { ...anchor, id: '__ghost__', x: cur.x - 10, y: cur.y - 8, w: 20, h: 16 }
  return cur.end === 'source'
    ? buildEdgeGeom(ghost, anchor, edge.kind).d
    : buildEdgeGeom(anchor, ghost, edge.kind).d
})

/* ---------------- 节点事件 ---------------- */

function onSelect(id: string, additive: boolean): void {
  if (additive) store.toggleSelect(id)
  else if (!store.selectedIds.includes(id)) store.select([id])
}

function onRemove(id: string): void {
  store.removeNode(id)
}

/** 小地图点击 → 视口中心移过去 */
function jumpTo(x: number, y: number): void {
  viewport.viewBox.value = {
    ...viewport.viewBox.value,
    x: x - viewport.viewBox.value.w / 2,
    y: y - viewport.viewBox.value.h / 2
  }
}

/* ---------------- 最近邻吸附（连线 + 人物卡片挂载共用） ---------------- */
/* 纯函数已抽到 ./snap.ts，便于单测直接覆盖，改半径不会再「测不到」 */

/**
 * 连线时的吸附目标 id。
 *
 * 与下面的 mountSnapTargetId **刻意分开**：两条路径的候选集不同
 * （连线可连任意卡片，人物挂载只接受事件/场景类），
 * 若共用一个变量，临界点（两卡片距离几乎相同）高亮会在两者间跳变。
 */
const linkSnapTargetId = ref<string | null>(null)

/** 人物挂载时的吸附目标 id */
const mountSnapTargetId = ref<string | null>(null)

/** 模板只关心「有没有卡片处于吸附高亮」，不关心是哪条路径 */
const snapTargetId = computed(
  () => linkSnapTargetId.value ?? mountSnapTargetId.value
)

/** 缩放归一后的世界坐标容差：屏幕上「约 120px」内吸住，不随画布缩放变松/变紧 */
function currentTolerance(): number {
  return snapTolerance(viewport.scale.value)
}

/* ---------------- 人物卡片：拖放到事件/场景节点上 ---------------- */

/** 正在被拖动的人物卡片 id（拖的是普通节点时为 null） */
const draggingCharacterId = ref<string | null>(null)

/**
 * 拖动人物卡片**之前**它自己的位置。
 *
 * 用途：挂载成功后把人物卡片本体放回这里，而不是让它停在目标卡片上
 * （否则角色牌会与事件卡视觉重叠，见 P1-3）。
 */
let characterOrigin: { x: number; y: number } | null = null

/** 摘掉人物挂载的 window 监听并清空挂载态（松手 / Esc / 卸载都走这里，保证只清一次） */
function endCharacterDrag(): void {
  window.removeEventListener('pointermove', onCharacterDragMove)
  window.removeEventListener('pointerup', onCharacterDragUp)
  draggingCharacterId.value = null
  mountSnapTargetId.value = null
  characterOrigin = null
}

/**
 * 跟随 useNodeDrag 的拖拽生命周期。
 *
 * 注意 `id` 为 null 的分支**不能省**：用户拖到一半按 Esc 时，
 * useNodeDrag 的 onEsc 会把 draggingId 置空并还原坐标，但它只清自己的监听，
 * 人物挂载的 window 监听仍挂着。若不在这儿清掉，用户随后松手就会
 * 触发一次「明明已取消」的挂载 —— Esc 取消必须同时取消挂载意图。
 */
watch(
  () => drag.draggingId.value,
  (id, prev) => {
    if (!id || id === prev) {
      if (!id) endCharacterDrag()
      return
    }
    const node = store.nodes.find((n) => n.id === id)
    if (node && isCharacterCard(node)) {
      draggingCharacterId.value = id
    } else {
      endCharacterDrag()
    }
  }
)

/** 拖动人物卡片时实时找挂载目标并高亮 */
function onCharacterDragMove(e: PointerEvent): void {
  const id = draggingCharacterId.value
  if (!id) return
  const p = svgPoint(e.clientX, e.clientY)
  const near = nearestNode(p.x, p.y, store.nodes, {
    excludeId: id,
    tolerance: currentTolerance(),
    accept: isAttachable
  })
  mountSnapTargetId.value = near ? near.id : null
}

/**
 * 松手：把人物名挂进目标节点的 characters，并让角色牌本体回到自己的原位。
 *
 * 关键约定（挂载交互与「移动角色牌本体」解耦）：
 *  - 拖动过程里 useNodeDrag 会照常把卡片本体移到指针下 —— 这是拖拽的通用语义，
 *    不能因为「这次拖动最终会变成一次挂载」就中途禁用，否则卡片会粘手。
 *  - 挂载成功的那一刻，把 x/y 还原到 `characterOrigin`，角色牌就弹回原位，
 *    不再压在目标卡片上。还原同时打 pinned，用户之后自由摆放它不会被布局吸回。
 *  - 挂载失败（无目标 / 空名）则不做还原：用户就是想移动它，位置应当保留。
 */
function onCharacterDragUp(): void {
  const cid = draggingCharacterId.value
  const targetId = mountSnapTargetId.value
  const origin = characterOrigin
  endCharacterDrag()
  if (!cid) return
  const card = store.nodes.find((n) => n.id === cid)
  const name = (card?.title ?? '').trim()
  const target = targetId ? store.nodes.find((n) => n.id === targetId) : undefined

  if (!name || !target) {
    // 没挂上：保留用户拖出来的位置
    if (name && !target && origin) ui.notify('没有可挂载的节点 —— 已保留人物卡片的新位置')
    return
  }
  if (target.characters.includes(name)) {
    ui.notify(`「${name}」已在该节点的人物里`)
    return
  }
  store.addCharacter(target.id, name)
  // 角色牌弹回自己的原位并打 pinned：挂载 ≠ 搬家
  if (origin) {
    store.updateNode(cid, { x: origin.x, y: origin.y, pinned: true }, { silent: true })
  }
  ui.notify(`「${name}」已挂到「${target.title}」`)
}

function onCharacterDragStart(node: StoryNode): void {
  if (!isCharacterCard(node)) return
  draggingCharacterId.value = node.id
  characterOrigin = { x: node.x, y: node.y }
  window.addEventListener('pointermove', onCharacterDragMove)
  window.addEventListener('pointerup', onCharacterDragUp)
}

onBeforeUnmount(() => {
  endCharacterDrag()
})

function onOpenStory(id: string): void {
  ui.openStoryEditor(id)
}

/* ---------------- 人物卡片：挂载点定位 + 就地改名 ---------------- */

/**
 * 点角色牌上的「已挂载 N」→ 选中这些节点并把视口移到它们身上。
 *
 * 定位用 `fit` 而不是 `center`：挂载点可能散在画布上下两端，
 * fit 能一次把它们都框进取景框，用户立刻看清「这人出现在哪几处」。
 *
 * R5-7：bounds 把角色牌自己也带上。选中集合仍只含挂载点（不污染多选状态），
 * 但视口要包含卡片本身，否则点完 chip 卡片被挤出屏幕，用户「回不去」。
 */
function onLocateCharacter(id: string): void {
  const card = store.nodes.find((n) => n.id === id)
  if (!card) return
  const mounted = mountedNodes(store.nodes, card)
  if (!mounted.length) return
  store.select(mounted.map((n) => n.id))
  viewport.fit(boundsOf([card, ...mounted], 140), 90)
}

/**
 * 角色牌就地改名：**必须级联**。
 *
 * 人物名是字符串存在各节点 `characters` 数组里的，没有独立角色实体，
 * 所以只改卡片标题会让「卡片叫新名、事件卡里还写旧名」的数据撕裂。
 *
 * 决策与应用已下沉：规则在 `core/characterRename.ts`（纯函数可单测），
 * 多节点一次性落库在 `useFlowStore.renameCharacter`（共享 merge key ⇒ 一条历史）。
 * 这里只做「把结果翻译成用户语言」。
 *
 * 静默 / 提示的取舍：empty-name / no-card / unchanged 都是「用户没做成事」，
 * 不该弹提示打扰；clash 是用户**做错了**且不说明就完全无法自救，必须告知。
 */
function onRenameCharacter(id: string, name: string): void {
  const plan = store.renameCharacter(id, name)
  if (!plan.ok) {
    if (plan.reason === 'clash') ui.notify(`已有同名人物「${name.trim()}」—— 请换个名字`)
    return
  }
  ui.notify(`「${plan.prev}」已改名为「${plan.next}」`)
}

function onInsertBranch(id: string, dir: 1 | -1): void {
  store.insertBranch(id, {}, dir)
}

watch(
  () => store.activeId,
  () => {
    selectedEdgeId.value = null
    requestAnimationFrame(() => fitView())
  }
)
</script>

<template>
  <div
    ref="wrap"
    class="nf-canvas"
    :class="[
      `nf-canvas--${canvasMode}`,
      { 'is-panning': panning || spaceDown, 'is-locked': ui.locked }
    ]"
  >
    <svg
      v-if="graph"
      ref="svgRef"
      class="nf-canvas__svg"
      :viewBox="`${viewport.viewBox.value.x} ${viewport.viewBox.value.y} ${viewport.viewBox.value.w} ${viewport.viewBox.value.h}`"
      preserveAspectRatio="xMidYMid meet"
      @wheel="onWheel"
      @pointerdown="onBackgroundDown"
      @contextmenu.prevent
    >
      <CanvasGrid :view-box="viewport.viewBox.value" :mode="canvasMode" />

      <TimeRail
        v-if="hasNodes"
        :nodes="store.nodes"
        :settings="graph.settings"
        :mode="canvasMode"
      />

      <EdgeLayer
        :edges="store.edges"
        :nodes="store.nodes"
        :settings="graph.settings"
        :selected-id="selectedEdgeId"
        :mode="canvasMode"
        @select="selectedEdgeId = $event"
        @remove="store.removeEdge($event)"
        @insert-between="store.insertBetween($event)"
        @reconnect-start="onReconnectStart"
      />

      <StoryNodeCard
        v-for="(n, i) in store.nodes"
        :key="n.id"
        :node="n"
        :index="i"
        :all-nodes="store.nodes"
        :selected="store.selectedIds.includes(n.id)"
        :snapping="snapTargetId === n.id"
        :locked="ui.locked"
        @select="onSelect"
        @drag-start="(e, node) => { drag.start(e, node); onCharacterDragStart(node) }"
        @insert-after="store.insertNodeAfter($event)"
        @insert-before="store.insertNodeBefore($event)"
        @insert-branch="onInsertBranch"
        @remove="onRemove"
        @open-story="onOpenStory"
        @port-down="onPortDown"
        @locate-character="onLocateCharacter"
        @rename-character="onRenameCharacter"
      />

      <!-- 拉线 / 改线预览 -->
      <path v-if="pendingPath" class="nf-canvas__pending" :d="pendingPath" />
      <path v-if="reconnectPath" class="nf-canvas__pending is-reconnect" :d="reconnectPath" />
      <circle v-if="pending" class="nf-canvas__pending-dot" :cx="pending.x" :cy="pending.y" r="4" />

      <SelectionBox
        :box="selection.box.value"
        :guides="drag.guides.value"
        :bounds="viewport.viewBox.value"
      />
    </svg>

    <!-- 空状态：插画感引导 -->
    <div v-if="!hasNodes" class="nf-empty">
      <svg class="nf-empty__art" viewBox="0 0 220 150" aria-hidden="true">
        <defs>
          <linearGradient id="nf-empty-ink" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#4dd0d9" stop-opacity="0.9" />
            <stop offset="100%" stop-color="#4dd0d9" stop-opacity="0.15" />
          </linearGradient>
        </defs>
        <path
          class="nf-empty__stroke"
          d="M18 20 C18 62, 40 62, 40 104 C40 132, 62 132, 62 150"
          stroke="url(#nf-empty-ink)"
        />
        <path class="nf-empty__stroke is-faint" d="M92 32 C112 60, 92 88, 112 118 C124 136, 120 146, 118 150" />
        <circle cx="18" cy="20" r="6" class="nf-empty__dot" />
        <circle cx="40" cy="104" r="5" class="nf-empty__dot" />
        <circle cx="62" cy="150" r="4.5" class="nf-empty__dot" />
        <circle cx="112" cy="118" r="4" class="nf-empty__dot is-branch" />
        <rect x="128" y="34" width="76" height="30" rx="10" class="nf-empty__card" />
        <rect x="128" y="76" width="60" height="26" rx="9" class="nf-empty__card is-branch" />
      </svg>
      <h3 class="nf-empty__title">这条时间线还空着</h3>
      <p class="nf-empty__desc">
        从一个事件开始往下铺，或在任意节点右侧拉出一条支线。<br />
        不确定怎么起手？先载入一份示例故事看看结构。
      </p>
      <div class="nf-empty__actions">
        <button class="nf-btn nf-btn--primary" @click="store.loadSampleGraph()">
          载入示例故事
        </button>
        <button class="nf-btn" @click="store.addNode({ title: '新的事件' })">
          新建第一个节点
        </button>
      </div>
    </div>

    <Minimap
      v-if="ui.showMinimap && hasNodes"
      :nodes="store.nodes"
      :view-box="viewport.viewBox.value"
      @jump="jumpTo"
    />
  </div>
</template>

<style scoped>
.nf-canvas {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  background: var(--nf-paper);
  transition: background var(--nf-dur-slow) var(--nf-ease);
}
.nf-canvas--dark {
  background: var(--nf-night);
}

.nf-canvas__svg {
  width: 100%;
  height: 100%;
  display: block;
  touch-action: none;
  cursor: default;
}
.nf-canvas.is-panning .nf-canvas__svg {
  cursor: grab;
}
.nf-canvas.is-panning.is-locked .nf-canvas__svg,
.nf-canvas.is-locked .nf-canvas__svg {
  cursor: not-allowed;
}

/* 拉线预览：实线 + 稍低 opacity。
   它表达的是「正在拉的这条线」，实线比虚线更清晰；
   虚线在 plan.md 第 8 节被明令禁用（虚线蚂蚁框）。 */
.nf-canvas__pending {
  fill: none;
  stroke: var(--nf-teal);
  stroke-width: 2.5;
  stroke-linecap: round;
  opacity: 0.72;
  pointer-events: none;
}
.nf-canvas__pending.is-reconnect {
  stroke: var(--nf-gold);
}
.nf-canvas__pending-dot {
  fill: var(--nf-teal);
  pointer-events: none;
}

/* ---------------- 空状态 ---------------- */
.nf-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px;
  text-align: center;
  pointer-events: none;
}
.nf-empty > * {
  pointer-events: auto;
}

.nf-empty__art {
  width: 240px;
  height: 164px;
  margin-bottom: 4px;
  opacity: 0.95;
}
.nf-empty__stroke {
  fill: none;
  stroke-width: 2.5;
  stroke-linecap: round;
}
.nf-empty__stroke.is-faint {
  stroke: var(--nf-gold);
  stroke-width: 2;
  opacity: 0.42;
}
.nf-empty__dot {
  fill: var(--nf-teal);
}
.nf-empty__dot.is-branch {
  fill: var(--nf-gold);
}
.nf-empty__card {
  fill: rgba(255, 255, 255, 0.72);
  stroke: var(--nf-teal);
  stroke-width: 1.4;
}
.nf-empty__card.is-branch {
  fill: rgba(255, 253, 246, 0.72);
  stroke: var(--nf-gold);
}
.nf-canvas--dark .nf-empty__card {
  fill: rgba(30, 44, 56, 0.72);
}

.nf-empty__title {
  margin: 0;
  font-size: var(--nf-fs-xl);
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--nf-ink-strong);
}
.nf-canvas--dark .nf-empty__title {
  color: var(--nf-on-dark-strong);
}

.nf-empty__desc {
  margin: 0;
  max-width: 420px;
  font-size: var(--nf-fs-sm);
  line-height: var(--nf-lh-body);
  color: var(--nf-ink-soft);
}
.nf-canvas--dark .nf-empty__desc {
  color: var(--nf-on-dark-soft);
}

.nf-empty__actions {
  display: flex;
  gap: 10px;
  margin-top: 6px;
}

/* 通用按钮（外壳里也复用） */
.nf-btn {
  appearance: none;
  border: 1px solid var(--nf-shell-line);
  background: rgba(255, 255, 255, 0.7);
  color: var(--nf-ink);
  border-radius: var(--nf-r-ctl);
  padding: 7px 15px;
  font-size: var(--nf-fs-sm);
  cursor: pointer;
  transition:
    transform var(--nf-dur-fast) var(--nf-ease),
    box-shadow var(--nf-dur-fast) var(--nf-ease),
    background var(--nf-dur-fast) var(--nf-ease);
}
.nf-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(15, 23, 32, 0.1);
}
.nf-btn--primary {
  background: linear-gradient(180deg, #58d7df 0%, #2aa6b0 100%);
  border-color: transparent;
  color: #062028;
  font-weight: 600;
}
.nf-canvas--dark .nf-btn {
  background: rgba(34, 48, 63, 0.8);
  color: var(--nf-on-dark);
}
.nf-canvas--dark .nf-btn--primary {
  background: linear-gradient(180deg, #58d7df 0%, #2aa6b0 100%);
  color: #062028;
}
</style>
