<script setup lang="ts">
import { computed, ref } from 'vue'
import { message } from 'ant-design-vue'
import type { FlowGraph } from '@/types/graph'
import { useFlowStore } from '@/stores/useFlowStore'
import { useUiStore } from '@/stores/useUiStore'
import { downloadText, parseGraphFile, serializeGraph } from '@/core/storage'
import FlowListItem from './FlowListItem.vue'

const store = useFlowStore()
const ui = useUiStore()

const fileInput = ref<HTMLInputElement | null>(null)

/** 收藏置顶，其余按更新时间倒序 */
const ordered = computed<FlowGraph[]>(() => {
  const fav = new Set(store.favorites)
  return [...store.graphs].sort((a, b) => {
    const fa = fav.has(a.id) ? 0 : 1
    const fb = fav.has(b.id) ? 0 : 1
    if (fa !== fb) return fa - fb
    return b.updatedAt - a.updatedAt
  })
})

const filtered = computed<FlowGraph[]>(() => {
  const q = ui.search.trim().toLowerCase()
  if (!q) return ordered.value
  return ordered.value.filter(
    (g) =>
      g.name.toLowerCase().includes(q) ||
      g.nodes.some(
        (n) =>
          n.title.toLowerCase().includes(q) ||
          n.summary.toLowerCase().includes(q) ||
          n.tags.some((t) => t.toLowerCase().includes(q))
      )
  )
})

function onCreate(): void {
  const g = store.createGraph(`未命名故事线 ${store.graphs.length + 1}`)
  message.success(`已新建「${g.name}」`)
}

function onExport(id: string): void {
  const g = store.graphs.find((x) => x.id === id)
  if (!g) return
  downloadText(`${g.name}.novelflow.json`, serializeGraph(g))
  message.success('已导出 JSON')
}

function pickFile(): void {
  fileInput.value?.click()
}

async function onFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const text = await file.text()
  const graph = parseGraphFile(text)
  if (!graph) {
    message.error('这个文件不是有效的 NovelFlow 故事图')
    return
  }
  store.importGraph(graph)
  message.success(`已导入「${graph.name}」`)
  input.value = ''
}
</script>

<template>
  <aside class="nf-sidebar" :class="{ 'is-collapsed': ui.sidebarCollapsed }">
    <header class="nf-sidebar__head">
      <div class="nf-sidebar__title">
        <span class="nf-mono-label">故事线</span>
        <span class="nf-sidebar__count">{{ store.graphs.length }}</span>
      </div>
      <button class="nf-sidebar__icon-btn" title="新建故事线" @click="onCreate">
        <svg viewBox="0 0 16 16" width="15" height="15">
          <path d="M8 3.4 V12.6 M3.4 8 H12.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </button>
      <button class="nf-sidebar__icon-btn" title="导入 JSON" @click="pickFile">
        <svg viewBox="0 0 16 16" width="15" height="15">
          <path d="M8 10 V3.2 M8 3.2 L5.2 6 M8 3.2 L10.8 6 M2.8 10.6 V12.6 A1.2 1.2 0 0 0 4 13.8 H12 A1.2 1.2 0 0 0 13.2 12.6 V10.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <input ref="fileInput" type="file" accept=".json,application/json" hidden @change="onFile" />
    </header>

    <div class="nf-sidebar__search">
      <svg class="nf-sidebar__search-icon" viewBox="0 0 16 16" width="13" height="13">
        <circle cx="7.2" cy="7.2" r="4.2" fill="none" stroke="currentColor" stroke-width="1.3" />
        <path d="M10.4 10.4 L13.4 13.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
      </svg>
      <input v-model="ui.search" placeholder="搜索故事线 / 节点" />
      <button v-if="ui.search" class="nf-sidebar__clear" @click="ui.search = ''">×</button>
    </div>

    <ul class="nf-sidebar__list nf-scroll">
      <FlowListItem
        v-for="g in filtered"
        :key="g.id"
        :graph="g"
        :active="g.id === store.activeId"
        :favorite="store.favorites.includes(g.id)"
        @select="store.setActiveGraph"
        @rename="store.renameGraph"
        @duplicate="store.duplicateGraph"
        @remove="store.removeGraph"
        @toggle-favorite="store.toggleFavorite"
        @export="onExport"
      />
      <li v-if="!filtered.length" class="nf-sidebar__empty">
        {{ ui.search ? '没有匹配的故事线' : '还没有故事线，点上方 + 新建' }}
      </li>
    </ul>

    <!--
      底部条带的高度在这里占位（分隔线 + 文案由 AppShell 里的 ControlCenter 覆盖渲染）：
      控制中心必须挂在侧栏之外，否则侧栏折叠（width:0 + overflow:hidden）会把入口一起裁掉。
    -->
    <footer class="nf-sidebar__foot" aria-hidden="true" />
  </aside>
</template>

<style scoped>
.nf-sidebar {
  width: var(--nf-sidebar-w, 268px);
  flex: none;
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, var(--nf-shell-800) 0%, var(--nf-shell-850) 100%);
  border-right: 1px solid var(--nf-shell-line-soft);
  transition: width var(--nf-dur) var(--nf-ease);
}
.nf-sidebar.is-collapsed {
  width: 0;
  overflow: hidden;
  border-right: none;
}

.nf-sidebar__head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 16px 14px 8px;
}

.nf-sidebar__title {
  flex: 1 1 auto;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.nf-sidebar__count {
  font-size: var(--nf-fs-2xs);
  color: var(--nf-on-dark-faint);
  background: rgba(148, 172, 196, 0.1);
  border-radius: var(--nf-r-chip);
  padding: 1px 7px;
}

.nf-sidebar__icon-btn {
  appearance: none;
  border: 1px solid var(--nf-shell-line);
  background: transparent;
  color: var(--nf-on-dark-soft);
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  cursor: pointer;
  transition:
    color var(--nf-dur-fast) var(--nf-ease),
    border-color var(--nf-dur-fast) var(--nf-ease),
    background var(--nf-dur-fast) var(--nf-ease);
}
.nf-sidebar__icon-btn:hover {
  color: var(--nf-teal);
  border-color: rgba(77, 208, 217, 0.45);
  background: rgba(77, 208, 217, 0.1);
}

.nf-sidebar__search {
  position: relative;
  margin: 4px 12px 10px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  height: 32px;
  border-radius: var(--nf-r-ctl);
  background: rgba(8, 14, 19, 0.42);
  border: 1px solid var(--nf-shell-line-soft);
  transition: border-color var(--nf-dur-fast) var(--nf-ease);
}
.nf-sidebar__search:focus-within {
  border-color: rgba(77, 208, 217, 0.42);
}
.nf-sidebar__search-icon {
  color: var(--nf-on-dark-faint);
  flex: none;
}
.nf-sidebar__search input {
  flex: 1 1 auto;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
  color: var(--nf-on-dark-strong);
  font-size: var(--nf-fs-xs);
}
.nf-sidebar__search input::placeholder {
  color: var(--nf-on-dark-faint);
}
.nf-sidebar__clear {
  border: none;
  background: transparent;
  color: var(--nf-on-dark-faint);
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  padding: 0 2px;
}

.nf-sidebar__list {
  flex: 1 1 auto;
  list-style: none;
  margin: 0;
  padding: 0 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nf-sidebar__empty {
  padding: 24px 12px;
  text-align: center;
  font-size: var(--nf-fs-xs);
  color: var(--nf-on-dark-faint);
}

/* 纯占位：高度须与 ControlCenter 展开态（10 + 28 + 14）一致，让覆盖层正好落在这条带上 */
.nf-sidebar__foot {
  flex: none;
  height: 52px;
}
</style>
