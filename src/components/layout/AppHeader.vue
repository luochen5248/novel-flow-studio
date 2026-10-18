<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useFlowStore } from '@/stores/useFlowStore'
import { useUiStore } from '@/stores/useUiStore'
import ExportMenu from '@/components/toolbar/ExportMenu.vue'

const store = useFlowStore()
const ui = useUiStore()

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
    </div>
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
</style>
