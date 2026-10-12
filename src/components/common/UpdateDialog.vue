<script setup lang="ts">
/**
 * 检查更新弹窗 —— 仅在 Electron 桌面环境可用（浏览器里入口按钮直接隐藏）。
 *
 * 状态机（与 electron/main.cjs 的 update:status 推送一一对应）：
 *   idle → checking → available / not-available
 *          available → downloading → downloaded → 「立即安装并重启」
 *          任一步失败 → error（展示主进程回传的原因）
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

interface UpdateStatusPayload {
  phase: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  error?: string
  percent?: number
  info?: { version?: string }
}

interface ElectronAPI {
  getAppVersion: () => Promise<string>
  checkForUpdates: () => Promise<{ ok: boolean; version?: string; error?: string }>
  downloadUpdate: () => Promise<{ ok: boolean; error?: string }>
  installUpdate: () => void
  onUpdateStatus: (cb: (payload: UpdateStatusPayload) => void) => () => void
}

const api = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI

const visible = ref(false)
const status = ref<UpdateStatusPayload | null>(null)
const currentVersion = ref('')
const busy = ref(false)

const phase = computed(() => status.value?.phase ?? 'idle')

const title = computed(() => {
  switch (phase.value) {
    case 'checking':
      return '正在检查更新…'
    case 'available':
      return `发现新版本 v${status.value?.info?.version ?? ''}`
    case 'not-available':
      return '已是最新版本'
    case 'downloading':
      return '正在下载更新…'
    case 'downloaded':
      return '更新已就绪'
    case 'error':
      return '更新失败'
    default:
      return '检查更新'
  }
})

const message = computed(() => {
  switch (phase.value) {
    case 'available':
      return `新版本 v${status.value?.info?.version ?? ''} 已发布，当前版本 v${currentVersion.value}。更新不会影响你的故事线数据。`
    case 'not-available':
      return `当前版本 v${currentVersion.value} 已是最新，无需更新。`
    case 'error':
      return status.value?.error ?? '网络异常或 GitHub 无法访问，请稍后再试。'
    default:
      return ''
  }
})

let unsubscribe: (() => void) | null = null

onMounted(() => {
  if (!api) return
  unsubscribe = api.onUpdateStatus((payload) => {
    status.value = payload
    if (payload.phase !== 'downloading') busy.value = false
  })
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
})

async function open(): Promise<void> {
  if (!api) return
  visible.value = true
  if (!currentVersion.value) currentVersion.value = await api.getAppVersion()
  void check()
}

async function check(): Promise<void> {
  if (!api) return
  busy.value = true
  status.value = { phase: 'checking' }
  const res = await api.checkForUpdates()
  // 事件流正常时以事件为准（available / not-available 会先到）；invoke 失败才兜底报错
  if (!res?.ok && phase.value === 'checking') {
    status.value = { phase: 'error', error: res?.error ?? '检查失败，请检查网络后重试' }
    busy.value = false
  }
}

async function download(): Promise<void> {
  if (!api) return
  busy.value = true
  const res = await api.downloadUpdate()
  if (!res?.ok && phase.value === 'downloading') {
    status.value = { phase: 'error', error: res?.error ?? '下载失败，请稍后再试' }
    busy.value = false
  }
}

function install(): void {
  api?.installUpdate()
}

function close(): void {
  // 下载中允许关窗（autoInstallOnAppQuit 兜底：退出时自动安装）
  visible.value = false
}

defineExpose({ open })
</script>

<template>
  <Teleport to="body">
    <Transition name="nf-update-fade">
      <div v-if="visible" class="nf-update" @click.self="close">
        <div class="nf-update__panel">
          <div class="nf-update__head">
            <span class="nf-update__mark" aria-hidden="true" />
            <h3 class="nf-update__title">{{ title }}</h3>
            <button class="nf-update__close" title="关闭" @click="close">
              <svg viewBox="0 0 16 16" width="14" height="14">
                <path d="M4 4 L12 12 M12 4 L4 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
              </svg>
            </button>
          </div>

          <div class="nf-update__body">
            <p v-if="message" class="nf-update__msg" :class="{ 'is-error': phase === 'error' }">
              {{ message }}
            </p>

            <div v-if="phase === 'downloading'" class="nf-update__progress">
              <div class="nf-update__bar">
                <div
                  class="nf-update__bar-fill"
                  :style="{ width: `${Math.max(3, Math.min(100, status?.percent ?? 0))}%` }"
                />
              </div>
              <span class="nf-update__percent">{{ Math.round(status?.percent ?? 0) }}%</span>
            </div>

            <p v-if="currentVersion && phase !== 'downloading'" class="nf-update__version">
              当前版本 v{{ currentVersion }}
            </p>
          </div>

          <div class="nf-update__foot">
            <button v-if="phase === 'downloaded'" class="nf-update__primary" @click="install">
              立即安装并重启
            </button>
            <button
              v-else-if="phase === 'available'"
              class="nf-update__primary"
              :disabled="busy"
              @click="download"
            >
              下载更新
            </button>
            <button
              v-else-if="phase === 'not-available' || phase === 'error'"
              class="nf-update__primary"
              :disabled="busy"
              @click="check"
            >
              重新检查
            </button>
            <span v-else-if="phase === 'checking'" class="nf-update__hint">请稍候…</span>
            <span v-else-if="phase === 'downloading'" class="nf-update__hint">
              下载完成后会自动提示安装
            </span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.nf-update {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: grid;
  place-items: center;
  background: rgba(6, 10, 15, 0.55);
  backdrop-filter: blur(4px);
}

.nf-update__panel {
  width: 400px;
  max-width: calc(100vw - 48px);
  background: var(--nf-shell-800);
  border: 1px solid var(--nf-shell-line);
  border-radius: var(--nf-r-card-sm);
  box-shadow: var(--nf-shadow-pop);
  padding: 18px 20px 16px;
}

.nf-update__head {
  display: flex;
  align-items: center;
  gap: 9px;
}
.nf-update__mark {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: linear-gradient(135deg, #6fdde4 0%, #2aa6b0 100%);
  box-shadow: 0 0 0 3px rgba(77, 208, 217, 0.16);
  flex: none;
}
.nf-update__title {
  flex: 1;
  margin: 0;
  font-size: var(--nf-fs-md);
  font-weight: 600;
  color: var(--nf-on-dark-strong);
  letter-spacing: 0.02em;
}
.nf-update__close {
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
.nf-update__close:hover {
  color: var(--nf-on-dark-strong);
  background: rgba(148, 172, 196, 0.12);
}

.nf-update__body {
  margin-top: 12px;
}
.nf-update__msg {
  margin: 0;
  font-size: var(--nf-fs-sm);
  line-height: var(--nf-lh-body);
  color: var(--nf-on-dark);
}
.nf-update__msg.is-error {
  color: var(--nf-danger);
}
.nf-update__version {
  margin: 10px 0 0;
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.08em;
  color: var(--nf-on-dark-faint);
}

.nf-update__progress {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
}
.nf-update__bar {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: rgba(148, 172, 196, 0.14);
  overflow: hidden;
}
.nf-update__bar-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--nf-teal-deep) 0%, var(--nf-teal) 100%);
  box-shadow: 0 0 8px rgba(77, 208, 217, 0.45);
  transition: width var(--nf-dur) var(--nf-ease);
}
.nf-update__percent {
  font-size: var(--nf-fs-xs);
  color: var(--nf-teal);
  font-variant-numeric: tabular-nums;
  min-width: 38px;
  text-align: right;
}

.nf-update__foot {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  margin-top: 16px;
  min-height: 30px;
}
.nf-update__hint {
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.06em;
  color: var(--nf-on-dark-faint);
}
.nf-update__primary {
  appearance: none;
  border: 1px solid rgba(77, 208, 217, 0.45);
  background: linear-gradient(180deg, rgba(77, 208, 217, 0.18) 0%, rgba(42, 166, 176, 0.14) 100%);
  color: var(--nf-teal);
  height: 30px;
  padding: 0 14px;
  border-radius: var(--nf-r-chip);
  font-size: var(--nf-fs-xs);
  letter-spacing: 0.05em;
  cursor: pointer;
  transition:
    filter var(--nf-dur-fast) var(--nf-ease),
    transform var(--nf-dur-fast) var(--nf-ease);
}
.nf-update__primary:hover:not(:disabled) {
  filter: brightness(1.18);
}
.nf-update__primary:active:not(:disabled) {
  transform: translateY(1px);
}
.nf-update__primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.nf-update-fade-enter-active,
.nf-update-fade-leave-active {
  transition: opacity var(--nf-dur) var(--nf-ease);
}
.nf-update-fade-enter-active .nf-update__panel,
.nf-update-fade-leave-active .nf-update__panel {
  transition: transform var(--nf-dur) var(--nf-ease);
}
.nf-update-fade-enter-from,
.nf-update-fade-leave-to {
  opacity: 0;
}
.nf-update-fade-enter-from .nf-update__panel,
.nf-update-fade-leave-to .nf-update__panel {
  transform: translateY(8px) scale(0.98);
}
</style>
