<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ASSIST_MODE_LABEL, type AssistMode } from '@/core/aiPrompt'

/**
 * AiContextMenu —— 编辑器右键唤起的 AI 菜单
 *
 * 为什么自建而不用 antd Dropdown：两个编辑器都住在 Drawer / aside 里，
 * antd Drawer 的默认层级是 1000，Dropdown 的 portal 层级不够可控；
 * 这里 `Teleport to="body"` + fixed 定位，z-index 取 1400，稳定压在抽屉之上。
 *
 * 交互：点外部关闭 / Esc 关闭 / 贴边自动翻转（右下溢出时向左上翻）。
 * 组件本身不发请求，只把用户选的任务模型 `emit('select')` 给宿主。
 */

const props = defineProps<{
  open: boolean
  /** 视口坐标（clientX / clientY） */
  x: number
  y: number
  /** 当前是否有选区：决定「润色片段」是否可用 */
  hasSelection?: boolean
  /** 有 AI 正在流式写入时锁掉菜单项 */
  busy?: boolean
}>()

const emit = defineEmits<{
  (e: 'select', mode: AssistMode): void
  (e: 'close'): void
}>()

interface MenuItem {
  key: AssistMode
  label: string
  hint: string
  icon: string
  disabled: boolean
}

const items = computed<MenuItem[]>(() => [
  {
    key: 'research',
    label: ASSIST_MODE_LABEL.research,
    hint: '背景素材 · 可联网',
    icon: 'M8 2.6 A5.4 5.4 0 1 0 8 13.4 A5.4 5.4 0 1 0 8 2.6 M8 6 V10.4 M8 11.6 V12.4',
    disabled: props.busy === true
  },
  {
    key: 'continue',
    label: ASSIST_MODE_LABEL.continue,
    hint: '从光标处接着写',
    icon: 'M3.4 12.6 H12.6 M9.4 3.4 H12.6 V6.6 M12.6 3.4 L6.6 9.4',
    disabled: props.busy === true
  },
  {
    key: 'polish',
    label: ASSIST_MODE_LABEL.polish,
    hint: props.hasSelection ? '改写选中片段' : '需先选中文字',
    icon: 'M10.6 3.4 L12.6 5.4 M3.4 12.6 L4.4 9.8 L9.4 4.8 L11.2 6.6 L6.2 11.6 L3.4 12.6',
    disabled: props.busy === true || props.hasSelection !== true
  }
])

const panel = ref<HTMLElement | null>(null)
const placed = ref(false)

/** 贴边翻转：先按原始坐标量一次，溢出就往回推 */
function place(): void {
  const el = panel.value
  if (!el) return
  const margin = 8
  const rect = el.getBoundingClientRect()
  const width = rect.width || 200
  const height = rect.height || 160
  let left = props.x
  let top = props.y
  if (left + width + margin > window.innerWidth) left = Math.max(margin, props.x - width)
  if (top + height + margin > window.innerHeight) top = Math.max(margin, props.y - height)
  el.style.left = `${left}px`
  el.style.top = `${top}px`
  el.style.visibility = 'visible'
  placed.value = true
}

function onPointerDown(e: PointerEvent): void {
  const el = panel.value
  if (!el) return
  if (e.target instanceof Node && el.contains(e.target)) return
  emit('close')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    emit('close')
  }
}

function pick(item: MenuItem): void {
  if (item.disabled) return
  emit('select', item.key)
  emit('close')
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      placed.value = false
      void nextTick(place)
      window.addEventListener('pointerdown', onPointerDown, true)
      window.addEventListener('keydown', onKeydown, true)
      window.addEventListener('resize', emitClose)
      window.addEventListener('wheel', emitClose, { passive: true })
    } else {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeydown, true)
      window.removeEventListener('resize', emitClose)
      window.removeEventListener('wheel', emitClose)
    }
  }
)

function emitClose(): void {
  emit('close')
}

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onPointerDown, true)
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('resize', emitClose)
  window.removeEventListener('wheel', emitClose)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="panel"
      class="nf-aicm"
      :style="{ left: `${x}px`, top: `${y}px`, visibility: placed ? 'visible' : 'hidden' }"
      role="menu"
    >
      <div class="nf-aicm__head">AI 助手</div>
      <button
        v-for="item in items"
        :key="item.key"
        class="nf-aicm__item"
        :class="{ 'is-disabled': item.disabled }"
        role="menuitem"
        :disabled="item.disabled"
        @click="pick(item)"
      >
        <svg class="nf-aicm__icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path :d="item.icon" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="nf-aicm__text">
          <span class="nf-aicm__label">{{ item.label }}</span>
          <span class="nf-aicm__hint">{{ item.hint }}</span>
        </span>
      </button>
      <p class="nf-aicm__foot">生成的内容会直接写在光标处，可随时取消</p>
    </div>
  </Teleport>
</template>

<style scoped>
/* z-index 必须高于 antd Drawer（默认 1000），否则抽屉里的右键菜单会被面板盖住 */
.nf-aicm {
  position: fixed;
  z-index: 1400;
  min-width: 196px;
  padding: 6px;
  background: var(--nf-shell-800);
  border: 1px solid var(--nf-shell-line);
  border-radius: var(--nf-r-card-sm);
  box-shadow: var(--nf-shadow-pop);
  animation: nf-aicm-in var(--nf-dur-fast) var(--nf-ease) both;
}

.nf-aicm__head {
  padding: 5px 10px 7px;
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.12em;
  color: var(--nf-on-dark-faint);
}

.nf-aicm__item {
  appearance: none;
  border: none;
  background: transparent;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 10px;
  border-radius: var(--nf-r-ctl);
  cursor: pointer;
  text-align: left;
  color: var(--nf-on-dark);
  transition:
    color var(--nf-dur-fast) var(--nf-ease),
    background var(--nf-dur-fast) var(--nf-ease);
}
.nf-aicm__item:hover:not(.is-disabled) {
  color: var(--nf-on-dark-strong);
  background: rgba(77, 208, 217, 0.1);
}
.nf-aicm__item.is-disabled {
  opacity: 0.42;
  cursor: not-allowed;
}

.nf-aicm__icon {
  flex: none;
  color: var(--nf-teal);
}
.nf-aicm__item.is-disabled .nf-aicm__icon {
  color: var(--nf-on-dark-faint);
}

.nf-aicm__text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.nf-aicm__label {
  font-size: var(--nf-fs-sm);
  color: inherit;
}
.nf-aicm__hint {
  font-size: 10px;
  letter-spacing: 0.02em;
  color: var(--nf-on-dark-faint);
}

.nf-aicm__foot {
  margin: 6px 4px 2px;
  padding-top: 6px;
  border-top: 1px solid var(--nf-shell-line-soft);
  font-size: 10px;
  line-height: 1.6;
  color: var(--nf-on-dark-faint);
}

@keyframes nf-aicm-in {
  from {
    opacity: 0;
    transform: translateY(-4px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
