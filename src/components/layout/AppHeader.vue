<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useFlowStore } from '@/stores/useFlowStore'
import { useUiStore } from '@/stores/useUiStore'
import ExportMenu from '@/components/toolbar/ExportMenu.vue'
import UpdateDialog from '@/components/common/UpdateDialog.vue'
import GrsaiKeyDialog from '@/components/common/GrsaiKeyDialog.vue'

const store = useFlowStore()
const ui = useUiStore()

/** 仅 Electron 桌面环境显示「检查更新」入口（浏览器里走不了 electron-updater） */
const isDesktop = !!(window as unknown as { electronAPI?: unknown }).electronAPI
const updateDialog = ref<InstanceType<typeof UpdateDialog> | null>(null)
const keyDialog = ref<InstanceType<typeof GrsaiKeyDialog> | null>(null)

const editing = ref(false)
const draft = ref('')
const input = ref<HTMLInputElement | null>(null)

watch(
  () => store.activeGraph?.id,
  () => {
    editing.value = false
  }
)

async function beginEdit(): Promise<void> {
  if (!store.activeGraph) return
  draft.value = store.activeGraph.name
  editing.value = true
  await nextTick()
  input.value?.focus()
  input.value?.select()
}

function commit(): void {
  if (!editing.value) return
  editing.value = false
  const name = draft.value.trim()
  if (name && store.activeGraph && name !== store.activeGraph.name) {
    store.renameGraph(store.activeGraph.id, name)
  }
}

const doneCount = computed(() => store.nodes.filter((n) => n.status === 'done').length)
</script>

<template>
  <header class="nf-header">
    <button
      class="nf-header__icon"
      :title="ui.sidebarCollapsed ? '展开故事线列表' : '收起故事线列表'"
      @click="ui.toggleSidebar()"
    >
      <svg viewBox="0 0 16 16" width="16" height="16">
        <path d="M2.6 3.4 H13.4 M2.6 8 H13.4 M2.6 12.6 H13.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      </svg>
    </button>

    <div class="nf-header__brand">
      <span class="nf-header__mark" aria-hidden="true" />
      <span class="nf-header__name">NovelFlow</span>
      <span class="nf-header__sub">小说时间线工坊</span>
    </div>

    <span class="nf-header__slash">/</span>

    <div class="nf-header__doc">
      <template v-if="editing">
        <input
          ref="input"
          v-model="draft"
          class="nf-header__input"
          @blur="commit"
          @keydown.enter.prevent="commit"
          @keydown.esc.prevent="editing = false"
        />
      </template>
      <button v-else class="nf-header__docname" @click="beginEdit">
        {{ store.activeGraph?.name ?? '未选择故事线' }}
      </button>
      <span class="nf-header__stats">
        {{ store.nodes.length }} 节点 · {{ store.edges.length }} 连线 · {{ doneCount }} 成稿
      </span>
    </div>

    <span class="nf-header__spacer" />

    <div class="nf-header__right">
      <span v-if="store.lastMessage" class="nf-header__flash">{{ store.lastMessage }}</span>

      <ExportMenu v-if="store.activeGraph" :graph="store.activeGraph" />

      <button
        v-if="isDesktop"
        class="nf-header__icon"
        title="检查更新（从 GitHub 拉取最新版本并自动安装）"
        @click="updateDialog?.open()"
      >
        <svg viewBox="0 0 16 16" width="16" height="16">
          <path d="M8 2.6 V9.4 M8 9.4 L5.2 6.6 M8 9.4 L10.8 6.6 M3 11.2 V12.6 A0.8 0.8 0 0 0 3.8 13.4 H12.2 A0.8 0.8 0 0 0 13 12.6 V11.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>

      <button
        v-if="isDesktop"
        class="nf-header__icon"
        title="AI 生图密钥设置（grsai，仅保存在本机）"
        @click="keyDialog?.open()"
      >
        <svg viewBox="0 0 16 16" width="16" height="16">
          <circle cx="5.4" cy="8" r="2.4" fill="none" stroke="currentColor" stroke-width="1.3" />
          <path d="M7.8 8 H13.4 M11.4 8 V10.2 M13 8 V9.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
      </button>

      <button
        class="nf-header__icon"
        :class="{ 'is-on': ui.devConsoleOpen }"
        title="开发者 / AI 控制台（window.NovelFlow 全部方法）"
        @click="ui.toggleDevConsole()"
      >
        <svg viewBox="0 0 16 16" width="16" height="16">
          <path d="M5.6 4.4 L3.4 8 L5.6 11.6 M10.4 4.4 L12.6 8 L10.4 11.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>

      <button
        class="nf-header__mode"
        :title="ui.canvasTheme === 'dark' ? '画布切到宣纸暖白' : '画布切到夜航深色'"
        @click="ui.toggleCanvasMode()"
      >
        <svg v-if="ui.canvasTheme === 'dark'" viewBox="0 0 16 16" width="15" height="15">
          <path d="M12.6 9.8 A5.2 5.2 0 0 1 6.2 3.4 A5.4 5.4 0 1 0 12.6 9.8 Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
        </svg>
        <svg v-else viewBox="0 0 16 16" width="15" height="15">
          <circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.3" />
          <path d="M8 1.8 V3.2 M8 12.8 V14.2 M1.8 8 H3.2 M12.8 8 H14.2 M3.6 3.6 L4.6 4.6 M11.4 11.4 L12.4 12.4 M12.4 3.6 L11.4 4.6 M4.6 11.4 L3.6 12.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
        <span>{{ ui.canvasTheme === 'dark' ? '夜航' : '宣纸' }}</span>
      </button>

      <button
        class="nf-header__icon"
        :title="ui.shellTheme === 'dark' ? '外壳切到浅色' : '外壳切到深色'"
        @click="ui.toggleTheme()"
      >
        <svg viewBox="0 0 16 16" width="16" height="16">
          <path d="M8 2.4 A5.6 5.6 0 1 0 8 13.6 A4.4 4.4 0 0 1 8 2.4 Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
        </svg>
      </button>
    </div>

    <UpdateDialog ref="updateDialog" />
    <GrsaiKeyDialog ref="keyDialog" />
  </header>
</template>

<style scoped>
.nf-header {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 54px;
  padding: 0 14px;
  background: var(--nf-shell-900);
  border-bottom: 1px solid var(--nf-shell-line-soft);
}

.nf-header__icon {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--nf-on-dark-soft);
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  cursor: pointer;
  transition:
    color var(--nf-dur-fast) var(--nf-ease),
    background var(--nf-dur-fast) var(--nf-ease);
}
.nf-header__icon:hover {
  color: var(--nf-teal);
  background: rgba(77, 208, 217, 0.1);
}
.nf-header__icon.is-on {
  color: var(--nf-teal);
  background: rgba(77, 208, 217, 0.16);
  box-shadow: inset 0 0 0 1px rgba(77, 208, 217, 0.32);
}

.nf-header__brand {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.nf-header__mark {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: linear-gradient(135deg, #6fdde4 0%, #2aa6b0 100%);
  box-shadow: 0 0 0 4px rgba(77, 208, 217, 0.14);
  align-self: center;
}
.nf-header__name {
  font-size: var(--nf-fs-lg);
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--nf-on-dark-strong);
}
.nf-header__sub {
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.14em;
  color: var(--nf-on-dark-faint);
}

.nf-header__slash {
  color: var(--nf-shell-line);
  font-size: 18px;
}

.nf-header__doc {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.nf-header__docname {
  appearance: none;
  border: none;
  background: transparent;
  padding: 0;
  text-align: left;
  font-size: var(--nf-fs-md);
  color: var(--nf-on-dark);
  cursor: text;
  max-width: 340px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color var(--nf-dur-fast) var(--nf-ease);
}
.nf-header__docname:hover {
  color: var(--nf-teal);
}

.nf-header__input {
  background: rgba(8, 14, 19, 0.5);
  border: 1px solid rgba(77, 208, 217, 0.45);
  border-radius: 7px;
  padding: 2px 7px;
  color: var(--nf-on-dark-strong);
  font-size: var(--nf-fs-md);
  outline: none;
  min-width: 220px;
}

.nf-header__stats {
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.06em;
  color: var(--nf-on-dark-faint);
}

.nf-header__spacer {
  flex: 1 1 auto;
}

.nf-header__right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.nf-header__flash {
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.08em;
  color: var(--nf-teal);
  padding: 3px 9px;
  border-radius: var(--nf-r-chip);
  background: rgba(77, 208, 217, 0.1);
  animation: nf-fade-in var(--nf-dur) var(--nf-ease) both;
}

/* 画布双模式切换：明显的两态胶囊（暗色外壳常驻，切换的是画布宣纸 / 夜航） */
.nf-header__mode {
  appearance: none;
  border: 1px solid var(--nf-shell-line);
  background: var(--nf-shell-700);
  color: var(--nf-on-dark-soft);
  height: 30px;
  padding: 0 11px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: var(--nf-fs-xs);
  letter-spacing: 0.04em;
  transition:
    color var(--nf-dur-fast) var(--nf-ease),
    border-color var(--nf-dur-fast) var(--nf-ease),
    background var(--nf-dur-fast) var(--nf-ease);
}
.nf-header__mode:hover {
  color: var(--nf-teal);
  border-color: rgba(77, 208, 217, 0.4);
  background: rgba(77, 208, 217, 0.08);
}
</style>
