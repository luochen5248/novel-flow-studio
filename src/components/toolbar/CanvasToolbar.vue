<script setup lang="ts">
import { computed } from 'vue'
import { Tooltip } from 'ant-design-vue'
import { useFlowStore } from '@/stores/useFlowStore'
import { useUiStore } from '@/stores/useUiStore'
import { useViewport } from '@/composables/useViewport'
import { boundsOf } from '@/core/geometry'
import { CHARACTER_LANE, CHARACTER_NODE_W } from '@/components/canvas/characterCard'
import { nextCharacterSlot } from '@/core/characterSlot'

const store = useFlowStore()
const ui = useUiStore()
const viewport = useViewport()

const zoomText = computed(() => `${Math.round(viewport.zoom.value * 100)}%`)

function fit(): void {
  viewport.fit(boundsOf(store.nodes, 110), 90)
}
function zoomIn(): void {
  viewport.zoomAt(1.2)
}
function zoomOut(): void {
  viewport.zoomAt(1 / 1.2)
}
function resetZoom(): void {
  viewport.setZoom(1)
}
function center(): void {
  viewport.center()
}
function toggleLayoutMode(): void {
  store.setSettings({
    layoutMode: store.activeGraph?.settings.layoutMode === 'timeline' ? 'free' : 'timeline'
  })
}

/**
 * 新增一张人物卡片（角色牌）。
 *
 * 固定丢到 CHARACTER_LANE 这条「保留道」——它不属于主线推进序列，
 * 所以点「整理布局」也不会被塞进主线里打乱剧情顺序。
 *
 * R5-1（P1）：标题**自增去重**（新人物 / 新人物 2 / 新人物 3…）。
 * 人物名是全图认亲的唯一键（挂载、chip 统计、级联改名都按名字匹配），
 * 若允许重名，后建的那张牌会把先建那张的挂载关系一起认走、改名时还会被
 * 「已有同名人物」拒绝而无法自救。从源头保证不存在同名角色牌。
 * 手法与 useFlowStore.insertBranch 找空位一致。
 *
 * 落位：必须**显式给坐标**。人物卡片被 `isLayoutExempt` 永久剔出布局集合，
 * `layoutTimeline` 永远不会再给它排一次位；若留给 `createNode` 兜底 (0, 0)，
 * 新建的第 2 张起就会与前一张叠成一坨，用户得先手动扒开才能用。
 * 规则统一走 core 纯函数 `nextCharacterSlot`（4 列一行网格错位），便于单测。
 */
function addCharacterCard(): void {
  const used = store.nodes.filter((n) => n.kind === 'character').map((n) => n.title)
  let title = '新人物'
  let i = 2
  while (used.includes(title)) title = `新人物 ${i++}`
  const slot = nextCharacterSlot(store.nodes)
  const node = store.addNode({
    kind: 'character',
    title,
    color: 'clay',
    lane: CHARACTER_LANE,
    w: CHARACTER_NODE_W,
    x: slot.x,
    y: slot.y
  })
  if (!node) return
  ui.notify('已添加人物卡片：拖到事件 / 场景节点上即可挂载为该节点人物')
}
</script>

<template>
  <div class="nf-toolbar">
    <div class="nf-toolbar__group">
      <Tooltip title="撤销 (Ctrl+Z)">
        <button class="nf-tb" :disabled="!store.canUndo" @click="store.undo()">
          <svg viewBox="0 0 16 16" width="15" height="15">
            <path d="M6.2 4.4 L3.2 7.2 L6.2 10 M3.2 7.2 H9.6 A3.6 3.6 0 0 1 9.6 14.4 H8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </Tooltip>
      <Tooltip title="重做 (Ctrl+Y)">
        <button class="nf-tb" :disabled="!store.canRedo" @click="store.redo()">
          <svg viewBox="0 0 16 16" width="15" height="15">
            <path d="M9.8 4.4 L12.8 7.2 L9.8 10 M12.8 7.2 H6.4 A3.6 3.6 0 0 0 6.4 14.4 H8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </Tooltip>
    </div>

    <span class="nf-toolbar__sep" />

    <div class="nf-toolbar__group">
      <Tooltip title="整理布局（按 lane / order 重新收紧）">
        <button class="nf-tb" @click="store.tidyLayout()">
          <svg viewBox="0 0 16 16" width="15" height="15">
            <path d="M8 2.6 V13.4 M4 5.4 H12 M4 10.6 H12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            <circle cx="8" cy="2.6" r="1.5" fill="currentColor" />
            <circle cx="8" cy="8" r="1.5" fill="currentColor" />
            <circle cx="8" cy="13.4" r="1.5" fill="currentColor" />
          </svg>
        </button>
      </Tooltip>
      <Tooltip :title="store.activeGraph?.settings.layoutMode === 'timeline' ? '时间线布局（点击切换自由摆放）' : '自由摆放（点击回到时间线布局）'">
        <button class="nf-tb" :class="{ 'is-on': store.activeGraph?.settings.layoutMode === 'free' }" @click="toggleLayoutMode">
          <svg viewBox="0 0 16 16" width="15" height="15">
            <rect x="5.6" y="2.6" width="4.8" height="3.6" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3" />
            <rect x="5.6" y="9.8" width="4.8" height="3.6" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3" />
            <path d="M8 6.2 V9.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            <path d="M10.4 4.4 H13.2 M10.4 11.6 H13.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-dasharray="2 2" />
          </svg>
        </button>
      </Tooltip>
      <Tooltip :title="ui.snapEnabled ? '网格吸附：开' : '网格吸附：关'">
        <button class="nf-tb" :class="{ 'is-on': ui.snapEnabled }" @click="ui.toggleSnap()">
          <svg viewBox="0 0 16 16" width="15" height="15">
            <path d="M3 6 H13 M3 10 H13 M6 3 V13 M10 3 V13" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.75" />
          </svg>
        </button>
      </Tooltip>
      <Tooltip :title="ui.locked ? '画布已锁定' : '锁定画布'">
        <button class="nf-tb" :class="{ 'is-on': ui.locked }" @click="ui.toggleLock()">
          <svg viewBox="0 0 16 16" width="15" height="15">
            <rect x="3.8" y="7" width="8.4" height="6.2" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.3" />
            <path d="M5.8 7 V5.4 A2.2 2.2 0 0 1 10.2 5.4 V7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
        </button>
      </Tooltip>
      <Tooltip title="添加人物卡片（拖到事件 / 场景节点上挂载为该节点人物）">
        <button class="nf-tb" @click="addCharacterCard">
          <svg viewBox="0 0 16 16" width="15" height="15">
            <circle cx="6" cy="5.6" r="2.4" fill="none" stroke="currentColor" stroke-width="1.3" />
            <path d="M2.2 13.4 C2.2 11 3.9 9.8 6 9.8 C8.1 9.8 9.8 11 9.8 13.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            <path d="M12.4 7.4 V11.4 M10.4 9.4 H14.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
        </button>
      </Tooltip>
    </div>

    <span class="nf-toolbar__sep" />

    <div class="nf-toolbar__group">
      <button class="nf-tb" title="缩小" @click="zoomOut">
        <svg viewBox="0 0 16 16" width="15" height="15">
          <path d="M4 8 H12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </button>
      <button class="nf-tb nf-tb--zoom" title="恢复 100%" @click="resetZoom">{{ zoomText }}</button>
      <button class="nf-tb" title="放大" @click="zoomIn">
        <svg viewBox="0 0 16 16" width="15" height="15">
          <path d="M8 4 V12 M4 8 H12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </button>
      <Tooltip title="适应画布 (Ctrl+0)">
        <button class="nf-tb" @click="fit">
          <svg viewBox="0 0 16 16" width="15" height="15">
            <path d="M3 6 V3.6 A0.6 0.6 0 0 1 3.6 3 H6 M10 3 H12.4 A0.6 0.6 0 0 1 13 3.6 V6 M13 10 V12.4 A0.6 0.6 0 0 1 12.4 13 H10 M6 13 H3.6 A0.6 0.6 0 0 1 3 12.4 V10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </button>
      </Tooltip>
      <Tooltip title="居中">
        <button class="nf-tb" @click="center">
          <svg viewBox="0 0 16 16" width="15" height="15">
            <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.3" />
            <path d="M8 2 V3.6 M8 12.4 V14 M2 8 H3.6 M12.4 8 H14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
        </button>
      </Tooltip>
    </div>

    <span class="nf-toolbar__spacer" />

    <div class="nf-toolbar__group">
      <Tooltip :title="ui.showMinimap ? '隐藏缩略图' : '显示缩略图'">
        <button class="nf-tb" :class="{ 'is-on': ui.showMinimap }" @click="ui.toggleMinimap()">
          <svg viewBox="0 0 16 16" width="15" height="15">
            <rect x="2.4" y="2.6" width="11.2" height="10.8" rx="2" fill="none" stroke="currentColor" stroke-width="1.3" />
            <rect x="5.6" y="5.4" width="5.6" height="4.4" rx="1" fill="currentColor" opacity="0.7" />
          </svg>
        </button>
      </Tooltip>
      <Tooltip :title="ui.canvasTheme === 'dark' ? '画布切到宣纸暖白' : '画布切到夜航深色'">
        <button class="nf-tb" @click="ui.toggleCanvasMode()">
          <svg v-if="ui.canvasTheme === 'dark'" viewBox="0 0 16 16" width="15" height="15">
            <circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.3" />
            <path d="M8 1.8 V3.2 M8 12.8 V14.2 M1.8 8 H3.2 M12.8 8 H14.2 M3.6 3.6 L4.6 4.6 M11.4 11.4 L12.4 12.4 M12.4 3.6 L11.4 4.6 M4.6 11.4 L3.6 12.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
          <svg v-else viewBox="0 0 16 16" width="15" height="15">
            <path d="M12.6 9.8 A5.2 5.2 0 0 1 6.2 3.4 A5.4 5.4 0 1 0 12.6 9.8 Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
          </svg>
        </button>
      </Tooltip>
    </div>
  </div>
</template>

<style scoped>
.nf-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 46px;
  padding: 0 12px;
  background: linear-gradient(180deg, var(--nf-shell-800) 0%, var(--nf-shell-850) 100%);
  border-bottom: 1px solid var(--nf-shell-line-soft);
}

.nf-toolbar__group {
  display: flex;
  align-items: center;
  gap: 2px;
}

.nf-toolbar__sep {
  width: 1px;
  height: 20px;
  margin: 0 6px;
  background: var(--nf-shell-line);
}

.nf-toolbar__spacer {
  flex: 1 1 auto;
}

.nf-tb {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--nf-on-dark-soft);
  min-width: 30px;
  height: 30px;
  padding: 0 7px;
  border-radius: 8px;
  display: inline-grid;
  place-items: center;
  cursor: pointer;
  font-size: var(--nf-fs-xs);
  font-variant-numeric: tabular-nums;
  transition:
    color var(--nf-dur-fast) var(--nf-ease),
    background var(--nf-dur-fast) var(--nf-ease),
    box-shadow var(--nf-dur-fast) var(--nf-ease);
}
.nf-tb:hover:not(:disabled) {
  color: var(--nf-on-dark-strong);
  background: rgba(148, 172, 196, 0.12);
}
.nf-tb.is-on {
  color: #062028;
  background: linear-gradient(180deg, #58d7df 0%, #2aa6b0 100%);
  box-shadow: 0 2px 8px rgba(77, 208, 217, 0.28);
}
.nf-tb:disabled {
  opacity: 0.34;
  cursor: not-allowed;
}
.nf-tb--zoom {
  min-width: 52px;
  letter-spacing: 0.02em;
}
</style>
