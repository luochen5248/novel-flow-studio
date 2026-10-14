<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useAiAssist, type AiAssistRequest } from '@/composables/useAiAssist'
import { ASSIST_MODE_LABEL, RESEARCH_DISCLAIMER } from '@/core/aiPrompt'

/**
 * AiAssistDialog —— AI 流式写作的**控制台**（不是预览弹窗）
 *
 * 与「预览 → 确认」不同：正文是一边流式一边**直接写进编辑器光标处**的（用户决策 3），
 * 所以这里刻意做成**无遮罩、不抢焦点**的小浮层：作者眼看着文字在光标处长出来，
 * 随手可以叫停、换落点、重生成。为此：
 *   - 容器 `@mousedown.prevent` 阻止点按钮时把焦点从 textarea 抢走；
 *   - z-index 取 1500，压在 antd Drawer（1000）之上；
 *   - 组件自己持有 useAiAssist，宿主只要 `run(request)` 传一次上下文与写入回调。
 */

const assist = useAiAssist()

const visible = ref(false)
const copied = ref(false)
const scrollBox = ref<HTMLElement | null>(null)

/** 浮层锚点：默认贴在触发点右下，越界自动回推 */
const pos = ref({ left: 0, top: 0 })

const title = computed(() => ASSIST_MODE_LABEL[assist.mode.value])
const statusText = computed(() => {
  if (assist.running.value) return '正在写入光标处…'
  if (assist.error.value) return '生成中断'
  if (assist.finished.value) return `已写入 ${assist.charCount.value} 字 · ${assist.elapsedText.value}`
  return '准备中…'
})

watch(
  () => assist.received.value,
  async () => {
    await nextTick()
    const box = scrollBox.value
    if (box) box.scrollTop = box.scrollHeight
  }
)

interface OpenOptions extends AiAssistRequest {
  /** 触发点视口坐标（右键位置） */
  x: number
  y: number
}

function clampPosition(x: number, y: number): { left: number; top: number } {
  const width = 380
  const height = 300
  const margin = 12
  const left = Math.min(Math.max(margin, x + 8), Math.max(margin, window.innerWidth - width - margin))
  const top = Math.min(Math.max(margin, y + 8), Math.max(margin, window.innerHeight - height - margin))
  return { left, top }
}

function open(options: OpenOptions): void {
  pos.value = clampPosition(options.x, options.y)
  visible.value = true
  copied.value = false
  void assist.run(options)
}

function close(): void {
  // 关闭即结算：还在流式就先中止，已写进编辑器的片段照常落库，不会白写
  assist.reset()
  visible.value = false
}

/** Esc 关闭：与 AiContextMenu 同一套 capture + stopPropagation 范式，且不会顺带触发抽屉 Esc（m5） */
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  e.stopPropagation()
  close()
}

watch(visible, (open) => {
  if (open) window.addEventListener('keydown', onKeydown, true)
  else window.removeEventListener('keydown', onKeydown, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
})

async function handleCopy(): Promise<void> {
  copied.value = await assist.copy()
}

function regenerate(): void {
  copied.value = false
  assist.regenerate()
}

function setAnchor(anchor: 'caret' | 'end'): void {
  assist.setAnchor(anchor)
}

/** 宿主可读的运行态与开关：`open(request)` 唤起，`running` 用于禁用右键菜单 */
defineExpose({ open, close, running: assist.running })
</script>

<template>
  <Teleport to="body">
    <Transition name="nf-assist-fade">
      <div
        v-if="visible"
        class="nf-assist"
        :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
        @mousedown.prevent
      >
        <header class="nf-assist__head">
          <span class="nf-assist__mark" :class="{ 'is-running': assist.running.value }" aria-hidden="true" />
          <span class="nf-assist__title">{{ title }}</span>
          <button class="nf-assist__close" title="关闭" @click="close">
            <svg viewBox="0 0 16 16" width="13" height="13">
              <path d="M4 4 L12 12 M12 4 L4 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </svg>
          </button>
        </header>

        <div class="nf-assist__status">
          <span>{{ statusText }}</span>
          <span v-if="assist.running.value" class="nf-assist__timer">{{ assist.elapsedText.value }}</span>
        </div>

        <!-- 联网增强：默认跟随模型配置里的开关，这里允许临时改一次 -->
        <label v-if="assist.mode.value === 'research'" class="nf-assist__opt">
          <input v-model="assist.webSearch.value" type="checkbox" :disabled="assist.running.value" />
          <span>联网增强（提示模型先检索再作答）</span>
        </label>

        <div ref="scrollBox" class="nf-assist__body">
          <p class="nf-assist__text">{{ assist.received.value }}</p>
          <span v-if="assist.running.value" class="nf-assist__caret" aria-hidden="true" />
        </div>

        <p v-if="assist.error.value" class="nf-assist__error">{{ assist.error.value }}</p>
        <p v-if="assist.mode.value === 'research'" class="nf-assist__note">{{ RESEARCH_DISCLAIMER }}</p>

        <footer class="nf-assist__foot">
          <template v-if="assist.running.value">
            <button class="nf-assist__btn is-danger" @click="assist.cancel()">停止生成</button>
          </template>
          <template v-else>
            <button
              class="nf-assist__btn"
              :class="{ 'is-on': assist.anchor.value === 'caret' }"
              :disabled="!assist.received.value"
              @click="setAnchor('caret')"
            >
              插在光标处
            </button>
            <button
              class="nf-assist__btn"
              :class="{ 'is-on': assist.anchor.value === 'end' }"
              :disabled="!assist.received.value"
              @click="setAnchor('end')"
            >
              追加到末尾
            </button>
            <span class="nf-assist__spacer" />
            <button class="nf-assist__btn" :disabled="!assist.received.value" @click="handleCopy">
              {{ copied ? '已复制' : '复制' }}
            </button>
            <button class="nf-assist__btn" @click="regenerate">重新生成</button>
          </template>
        </footer>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.nf-assist {
  position: fixed;
  z-index: 1500;
  width: 380px;
  max-width: calc(100vw - 24px);
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px 11px;
  background: var(--nf-shell-800);
  border: 1px solid var(--nf-shell-line);
  border-radius: var(--nf-r-card-sm);
  box-shadow: var(--nf-shadow-pop);
}

.nf-assist__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.nf-assist__mark {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: linear-gradient(135deg, #6fdde4 0%, #2aa6b0 100%);
  box-shadow: 0 0 0 3px rgba(77, 208, 217, 0.14);
  flex: none;
}
.nf-assist__mark.is-running {
  background: linear-gradient(135deg, #e0c464 0%, #a9881d 100%);
  box-shadow: 0 0 0 3px rgba(201, 162, 39, 0.18);
  animation: nf-assist-pulse 1.4s var(--nf-ease) infinite;
}
.nf-assist__title {
  flex: 1;
  margin: 0;
  font-size: var(--nf-fs-sm);
  font-weight: 600;
  color: var(--nf-on-dark-strong);
  letter-spacing: 0.02em;
}
.nf-assist__close {
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
  transition: color var(--nf-dur-fast) var(--nf-ease), background var(--nf-dur-fast) var(--nf-ease);
}
.nf-assist__close:hover {
  color: var(--nf-on-dark-strong);
  background: rgba(148, 172, 196, 0.12);
}

.nf-assist__status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.04em;
  color: var(--nf-on-dark-soft);
}
.nf-assist__timer {
  color: var(--nf-gold);
}

.nf-assist__opt {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.02em;
  color: var(--nf-on-dark-soft);
  cursor: pointer;
}
.nf-assist__opt input {
  accent-color: var(--nf-teal);
}

.nf-assist__body {
  max-height: 190px;
  overflow-y: auto;
  padding: 9px 10px;
  border-radius: var(--nf-r-ctl);
  background: rgba(8, 14, 19, 0.5);
  border: 1px solid var(--nf-shell-line-soft);
}
.nf-assist__text {
  margin: 0;
  font-size: var(--nf-fs-sm);
  line-height: 1.85;
  color: var(--nf-on-dark);
  white-space: pre-wrap;
  word-break: break-word;
}
.nf-assist__caret {
  display: inline-block;
  width: 6px;
  height: 1.05em;
  vertical-align: text-bottom;
  background: var(--nf-teal);
  animation: nf-assist-caret 1s steps(2, start) infinite;
}

.nf-assist__error {
  margin: 0;
  font-size: var(--nf-fs-2xs);
  line-height: 1.7;
  color: var(--nf-danger);
}
.nf-assist__note {
  margin: 0;
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.02em;
  color: var(--nf-warn);
}

.nf-assist__foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 2px;
}
.nf-assist__foot:first-child {
  margin-top: 0;
}
.nf-assist__spacer {
  flex: 1 1 auto;
}
.nf-assist__btn {
  appearance: none;
  border: 1px solid var(--nf-shell-line);
  background: rgba(8, 14, 19, 0.4);
  color: var(--nf-on-dark-soft);
  height: 28px;
  padding: 0 11px;
  border-radius: var(--nf-r-ctl);
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.04em;
  cursor: pointer;
  transition:
    color var(--nf-dur-fast) var(--nf-ease),
    border-color var(--nf-dur-fast) var(--nf-ease),
    background var(--nf-dur-fast) var(--nf-ease);
}
.nf-assist__btn:hover:not(:disabled) {
  color: var(--nf-teal);
  border-color: rgba(77, 208, 217, 0.42);
  background: rgba(77, 208, 217, 0.1);
}
.nf-assist__btn.is-on {
  color: var(--nf-teal);
  border-color: rgba(77, 208, 217, 0.45);
  background: rgba(77, 208, 217, 0.16);
}
.nf-assist__btn.is-danger {
  color: var(--nf-danger);
  border-color: rgba(200, 106, 99, 0.42);
}
.nf-assist__btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.nf-assist-fade-enter-active,
.nf-assist-fade-leave-active {
  transition: opacity var(--nf-dur) var(--nf-ease);
}
.nf-assist-fade-enter-from,
.nf-assist-fade-leave-to {
  opacity: 0;
}

@keyframes nf-assist-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
@keyframes nf-assist-caret {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.15;
  }
}
</style>
