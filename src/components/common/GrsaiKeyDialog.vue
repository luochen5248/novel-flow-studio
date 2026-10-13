<script setup lang="ts">
/**
 * grsai 密钥设置弹窗 —— 仅 Electron 桌面环境。
 *
 * 桌面版没有 Vite dev server 代理，主进程从 userData/config.json 读密钥注入请求；
 * 这里提供唯一的图形化设置入口。密钥只存本地，不上传。
 */
import { ref } from 'vue'

interface ElectronAPI {
  getGrsaiKey: () => Promise<string>
  setGrsaiKey: (key: string) => Promise<{ ok: boolean }>
}

const api = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI

const visible = ref(false)
const draft = ref('')
const saved = ref(false)

async function open(): Promise<void> {
  if (!api) return
  visible.value = true
  saved.value = false
  const current = await api.getGrsaiKey()
  // 已配置时只改占位符提示，不回显明文
  draft.value = ''
  draftPlaceholder.value = current ? '已配置（输入新值可覆盖）' : '粘贴 grsai 的 API Key'
}

const draftPlaceholder = ref('粘贴 grsai 的 API Key')

async function save(): Promise<void> {
  if (!api) return
  const key = draft.value.trim()
  if (!key) return
  await api.setGrsaiKey(key)
  saved.value = true
  draft.value = ''
  draftPlaceholder.value = '已配置（输入新值可覆盖）'
}

function close(): void {
  visible.value = false
}

defineExpose({ open })
</script>

<template>
  <Teleport to="body">
    <Transition name="nf-key-fade">
      <div v-if="visible" class="nf-key" @click.self="close">
        <div class="nf-key__panel">
          <div class="nf-key__head">
            <span class="nf-key__mark" aria-hidden="true" />
            <h3 class="nf-key__title">AI 生图密钥（grsai）</h3>
            <button class="nf-key__close" title="关闭" @click="close">
              <svg viewBox="0 0 16 16" width="14" height="14">
                <path d="M4 4 L12 12 M12 4 L4 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
              </svg>
            </button>
          </div>

          <div class="nf-key__body">
            <p class="nf-key__msg">
              桌面版在本地直接调用 grsai 接口，需要在这里粘贴一次 API Key
              （与浏览器开发模式的 <code>.env.local</code> 同一份，可随时覆盖）。
              密钥只保存在本机，不会上传。
            </p>
            <div class="nf-key__row">
              <input
                v-model="draft"
                class="nf-key__input"
                type="password"
                autocomplete="off"
                :placeholder="draftPlaceholder"
                @keydown.enter.prevent="save"
              />
              <button class="nf-key__save" :disabled="!draft.trim()" @click="save">保存</button>
            </div>
            <p v-if="saved" class="nf-key__saved">已保存，AI 生图即刻生效。</p>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.nf-key {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: grid;
  place-items: center;
  background: rgba(6, 10, 15, 0.55);
  backdrop-filter: blur(4px);
}

.nf-key__panel {
  width: 420px;
  max-width: calc(100vw - 48px);
  background: var(--nf-shell-800);
  border: 1px solid var(--nf-shell-line);
  border-radius: var(--nf-r-card-sm);
  box-shadow: var(--nf-shadow-pop);
  padding: 18px 20px 16px;
}

.nf-key__head {
  display: flex;
  align-items: center;
  gap: 9px;
}
.nf-key__mark {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: linear-gradient(135deg, #e0c464 0%, #a9881d 100%);
  box-shadow: 0 0 0 3px rgba(201, 162, 39, 0.16);
  flex: none;
}
.nf-key__title {
  flex: 1;
  margin: 0;
  font-size: var(--nf-fs-md);
  font-weight: 600;
  color: var(--nf-on-dark-strong);
  letter-spacing: 0.02em;
}
.nf-key__close {
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
.nf-key__close:hover {
  color: var(--nf-on-dark-strong);
  background: rgba(148, 172, 196, 0.12);
}

.nf-key__body {
  margin-top: 12px;
}
.nf-key__msg {
  margin: 0;
  font-size: var(--nf-fs-sm);
  line-height: var(--nf-lh-body);
  color: var(--nf-on-dark);
}
.nf-key__msg code {
  font-size: var(--nf-fs-xs);
  color: var(--nf-teal);
  background: rgba(77, 208, 217, 0.1);
  border-radius: 5px;
  padding: 1px 5px;
}

.nf-key__row {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.nf-key__input {
  flex: 1;
  height: 32px;
  background: rgba(8, 14, 19, 0.5);
  border: 1px solid var(--nf-shell-line);
  border-radius: var(--nf-r-ctl);
  padding: 0 10px;
  color: var(--nf-on-dark-strong);
  font-size: var(--nf-fs-sm);
  outline: none;
  transition: border-color var(--nf-dur-fast) var(--nf-ease);
}
.nf-key__input::placeholder {
  color: var(--nf-on-dark-faint);
}
.nf-key__input:focus {
  border-color: rgba(77, 208, 217, 0.45);
}
.nf-key__save {
  appearance: none;
  border: 1px solid rgba(77, 208, 217, 0.45);
  background: linear-gradient(180deg, rgba(77, 208, 217, 0.18) 0%, rgba(42, 166, 176, 0.14) 100%);
  color: var(--nf-teal);
  height: 32px;
  padding: 0 14px;
  border-radius: var(--nf-r-ctl);
  font-size: var(--nf-fs-xs);
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: filter var(--nf-dur-fast) var(--nf-ease);
}
.nf-key__save:hover:not(:disabled) {
  filter: brightness(1.18);
}
.nf-key__save:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.nf-key__saved {
  margin: 8px 0 0;
  font-size: var(--nf-fs-2xs);
  color: var(--nf-ok);
}

.nf-key-fade-enter-active,
.nf-key-fade-leave-active {
  transition: opacity var(--nf-dur) var(--nf-ease);
}
.nf-key-fade-enter-active .nf-key__panel,
.nf-key-fade-leave-active .nf-key__panel {
  transition: transform var(--nf-dur) var(--nf-ease);
}
.nf-key-fade-enter-from,
.nf-key-fade-leave-to {
  opacity: 0;
}
.nf-key-fade-enter-from .nf-key__panel,
.nf-key-fade-leave-to .nf-key__panel {
  transform: translateY(8px) scale(0.98);
}
</style>
