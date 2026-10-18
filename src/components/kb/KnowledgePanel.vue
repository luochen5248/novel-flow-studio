<script setup lang="ts">
/**
 * KnowledgePanel —— 知识库大面板（居中弹窗 1180×760，z-index 900 档）
 *
 * 形态与层级：照 ControlCenter 的弹窗骨架抄（Teleport + 遮罩 + Esc +
 * 焦点陷阱 + aria-modal + 焦点归还 + Tab 陷阱），**不再发明第二套**。
 * z-index 取 900（与 UpdateDialog / ApiConsole 同档）：从 ControlCenter
 * 打开时它先自关（openModelDialog 惯例），不会与本弹窗 950 同屏；
 * 从 NodeInspector「关联」TabPane 打开时也没有更高层弹层占用。
 *
 * 布局对标 WorkBuddy「资料库」：左栏（搜索框 + 分区导航 + 最近访问），
 * 右栏主区（标题行 + 显眼操作按钮 + 表格行列表 + 详情/编辑器）。
 *
 * 三个分区：
 *  - 知识条目：搜索 + 类型过滤 + 表格列表 + 编辑器（标题 / 类型 / 内容 / 标签）；
 *  - 参考文档：上传（桌面态 pickDoc / 浏览器态 hidden input）+ 表格列表 + 查看器
 *    （鼠标划词 → 「把选中段关联到当前节点」建锚点；锚点列表可解除）；
 *  - 作者记忆：只读表格列表 + 行内编辑 / 删除 + 轻量新建（完整管理在 ControlCenter）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useFlowStore } from '@/stores/useFlowStore'
import { useKbStore, type KbPanelSection } from '@/stores/useKbStore'
import { getDoc, hasKbBridge, listAnchors, pickDoc, readDoc } from '@/api/kbClient'
import type {
  DocAnchor,
  DocFormat,
  KbDocument,
  KnowledgeEntry,
  KnowledgeType,
  MemoryEntry,
  MemorySource,
  MemoryType
} from '@/core/kb/types'

const flowStore = useFlowStore()
const kbStore = useKbStore()

/* ---------------- 弹窗骨架（照 ControlCenter） ---------------- */

const panel = ref<HTMLElement | null>(null)
/** 打开前聚焦的元素，关闭时归还（模块级而非组件 ref：不需要响应式） */
let lastFocused: HTMLElement | null = null

const section = computed<KbPanelSection>(() => kbStore.panelSection)

const SECTIONS: Array<{ key: KbPanelSection; label: string; icon: string }> = [
  {
    key: 'entries',
    label: '知识条目',
    icon: 'M3.2 2.8 H10.2 L12.8 5.4 V13.2 H3.2 Z M5.6 7.4 H10 M5.6 9.8 H10 M5.6 12.2 H8'
  },
  {
    key: 'docs',
    label: '参考文档',
    icon: 'M4 2.4 H9.4 L12 5 V13.6 H4 Z M6 8.2 H10 M6 10.6 H10 M6 12.6 H8.4'
  },
  {
    key: 'memory',
    label: '作者记忆',
    icon: 'M8 2.6 A5.4 5.4 0 1 0 8 13.4 A4.2 4.2 0 0 1 8 2.6 Z M6.2 6.4 H9.8 M6.2 8.6 H9.8 M6.2 10.8 H8.4'
  }
]

/** 左栏「最近访问」里区分来源分区的短标签 */
const SECTION_SHORT: Record<KbPanelSection, string> = {
  entries: '条目',
  docs: '文档',
  memory: '记忆'
}

const navCounts = computed<Record<KbPanelSection, number>>(() => ({
  entries: kbStore.entries.length,
  docs: kbStore.docs.length,
  memory: kbStore.memories.length
}))

/** 右栏标题行：当前分区元信息 + 数量文案 */
const currentSection = computed(() => SECTIONS.find((s) => s.key === section.value) ?? SECTIONS[0])

const sectionCountText = computed(() => {
  const n = navCounts.value[section.value]
  return section.value === 'docs' ? `共 ${n} 份文档` : `共 ${n} 条`
})

function setSection(key: KbPanelSection): void {
  // 切分区时清空搜索：避免回到条目区时还套着上一个分区的查询条件
  if (kbStore.panelSection !== key) {
    clearSearch()
    focusMemoryId.value = ''
  }
  kbStore.panelSection = key
}

function close(): void {
  kbStore.closePanel()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}

/** 面板内可聚焦元素（Tab 陷阱用；同 ControlCenter 口径） */
function focusablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => el.tabIndex >= 0)
}

function onTrapKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Tab') return
  const root = panel.value
  if (!root) return
  const list = focusablesIn(root)
  if (!list.length) return
  const first = list[0]
  const last = list[list.length - 1]
  const active = document.activeElement
  if (!(active instanceof Node) || !root.contains(active)) {
    e.preventDefault()
    first.focus()
    return
  }
  if (e.shiftKey && active === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}

watch(
  () => kbStore.panelOpen,
  (value) => {
    if (value) {
      lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
      window.addEventListener('keydown', onKeydown, true)
      window.addEventListener('keydown', onTrapKeydown, true)
      void nextTick(() => {
        panel.value?.querySelector<HTMLElement>('.nf-kb__nav-item')?.focus()
      })
    } else {
      window.removeEventListener('keydown', onKeydown, true)
      window.removeEventListener('keydown', onTrapKeydown, true)
      if (lastFocused?.isConnected) lastFocused.focus()
      lastFocused = null
    }
  }
)

onMounted(() => {
  void kbStore.refresh()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('keydown', onTrapKeydown, true)
})

/* ---------------- 公共小工具 ---------------- */

function failText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const ENTRY_TYPE_LABEL: Record<KnowledgeType, string> = {
  note: '笔记',
  setting: '设定',
  character: '人物',
  plot: '情节',
  style: '风格'
}
const MEMORY_TYPE_LABEL: Record<MemoryType, string> = {
  preference: '偏好',
  fact: '事实',
  decision: '决定',
  background: '背景'
}
const MEMORY_SOURCE_LABEL: Record<MemorySource, string> = {
  manual: '手写',
  assist: 'AI 转存',
  auto: '整理升格'
}
const DOC_FORMAT_LABEL: Record<DocFormat, string> = {
  md: 'Markdown',
  txt: '纯文本',
  docx: 'Word 文档'
}

/** 条目类型小图标（装饰性，aria-hidden；stroke 风格与分区图标保持一致） */
const ENTRY_TYPE_ICON: Record<KnowledgeType, string> = {
  note: 'M3.4 2.6 H10.2 L12.6 5 V13.4 H3.4 Z M5.6 7.4 H10.4 M5.6 9.8 H10.4 M5.6 12.2 H8.2',
  setting: 'M8 2.8 L13.2 5.2 V10.8 L8 13.2 L2.8 10.8 V5.2 Z M8 5.9 A2.1 2.1 0 1 0 8 10.1 A2.1 2.1 0 0 0 8 5.9',
  character: 'M8 3.1 A2.2 2.2 0 1 0 8 7.5 A2.2 2.2 0 0 0 8 3.1 Z M3.4 13.4 C3.4 10.9 5.4 9.5 8 9.5 C10.6 9.5 12.6 10.9 12.6 13.4',
  plot: 'M3 3.4 V12.6 H13 M5.4 10.2 L7.8 6.6 L10.4 8.6 L13 4.4',
  style: 'M3 13.2 L4.4 9.4 L11 2.8 L13.2 5 L6.6 11.6 Z M11 2.8 L13.2 5'
}

/* ---------------- 左栏：搜索 + 最近访问 ---------------- */

const searchQuery = ref('')
const searchResults = ref<KnowledgeEntry[] | null>(null)

/** 左栏搜索框对条目走 IPC 检索（既有逻辑）；文档 / 记忆无检索通道，走客户端子串过滤 */
const displayDocs = computed<KbDocument[]>(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return kbStore.docs
  return kbStore.docs.filter((d) => d.title.toLowerCase().includes(q))
})

const displayMemories = computed<MemoryEntry[]>(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return kbStore.memories
  return kbStore.memories.filter((m) => m.content.toLowerCase().includes(q))
})

async function onSearch(): Promise<void> {
  const q = searchQuery.value.trim()
  if (!q) {
    searchResults.value = null
    return
  }
  if (section.value !== 'entries') return // 文档 / 记忆已由 computed 实时过滤
  try {
    searchResults.value = await kbStore.searchAction(q)
  } catch (e) {
    message.error(failText(e))
  }
}

function clearSearch(): void {
  searchQuery.value = ''
  searchResults.value = null
}

interface RecentItem {
  kind: KbPanelSection
  id: string
  title: string
  updatedAt: number
}

/** 左栏「最近访问」：跨分区取 updatedAt 最新的若干条混合展示 */
const RECENT_LIMIT = 6
const recentItems = computed<RecentItem[]>(() => {
  const mixed: RecentItem[] = [
    ...kbStore.entries.map((e) => ({
      kind: 'entries' as const,
      id: e.id,
      title: e.title,
      updatedAt: e.updatedAt
    })),
    ...kbStore.docs.map((d) => ({
      kind: 'docs' as const,
      id: d.id,
      title: d.title,
      updatedAt: d.updatedAt
    })),
    ...kbStore.memories.map((m) => ({
      kind: 'memory' as const,
      id: m.id,
      title: m.content.slice(0, 40) || '（空记忆）',
      updatedAt: m.updatedAt
    }))
  ]
  return mixed
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, RECENT_LIMIT)
})

/** 最近访问点击：跳到对应分区并选中该项（条目→编辑器 / 文档→查看器 / 记忆→高亮滚动） */
async function openRecent(item: RecentItem): Promise<void> {
  setSection(item.kind)
  if (item.kind === 'entries') {
    const hit = kbStore.entries.find((e) => e.id === item.id)
    if (hit) onEditEntry(hit)
  } else if (item.kind === 'docs') {
    await onOpenDoc(item.id)
  } else {
    focusMemoryId.value = item.id
    await nextTick()
    panel.value
      ?.querySelector<HTMLElement>('.nf-kb__tr--mem.is-focus')
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
}

/* ---------------- 分区一：知识条目 ---------------- */

const typeFilter = ref<KnowledgeType | ''>('')

const TYPE_OPTIONS: Array<{ value: KnowledgeType; label: string }> = [
  { value: 'note', label: '笔记' },
  { value: 'setting', label: '设定' },
  { value: 'character', label: '人物' },
  { value: 'plot', label: '情节' },
  { value: 'style', label: '风格' }
]

const displayEntries = computed<KnowledgeEntry[]>(() => {
  const base = searchResults.value ?? kbStore.entries
  return typeFilter.value ? base.filter((e) => e.type === typeFilter.value) : base
})

/** 编辑器草稿：editingEntryId 为空 = 新建 */
const editingEntryId = ref('')
const entryDraft = ref<{ title: string; type: KnowledgeType; content: string; tags: string }>({
  title: '',
  type: 'note',
  content: '',
  tags: ''
})
const entryTitleInput = ref<HTMLInputElement | null>(null)

function resetEntryDraft(): void {
  editingEntryId.value = ''
  entryDraft.value = { title: '', type: 'note', content: '', tags: '' }
}

function onEditEntry(entry: KnowledgeEntry): void {
  editingEntryId.value = entry.id
  entryDraft.value = {
    title: entry.title,
    type: entry.type,
    content: entry.content,
    tags: entry.tags.join('，')
  }
}

/** 标题行「新建条目」：重置草稿并把焦点送到标题输入框（修复「找不到新建入口」） */
function newEntryFromCta(): void {
  resetEntryDraft()
  void nextTick(() => entryTitleInput.value?.focus())
}

async function onSaveEntry(): Promise<void> {
  const title = entryDraft.value.title.trim()
  if (!title) {
    message.warning('标题不能为空')
    return
  }
  const tags = entryDraft.value.tags
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean)
  try {
    if (editingEntryId.value) {
      await kbStore.updateEntryAction(editingEntryId.value, {
        title,
        type: entryDraft.value.type,
        content: entryDraft.value.content,
        tags
      })
    } else {
      await kbStore.createEntryAction({
        title,
        type: entryDraft.value.type,
        content: entryDraft.value.content,
        tags
      })
    }
    message.success('已保存')
    resetEntryDraft()
  } catch (e) {
    message.error(failText(e))
  }
}

async function onDeleteEntry(id: string): Promise<void> {
  try {
    await kbStore.removeEntryAction(id)
    if (editingEntryId.value === id) resetEntryDraft()
  } catch (e) {
    message.error(failText(e))
  }
}

/* ---------------- 分区二：文档 ---------------- */

const docFileInput = ref<HTMLInputElement | null>(null)
const currentDoc = ref<KbDocument | null>(null)
const docAnchors = ref<DocAnchor[]>([])
/** 正文区最近一次划词（mouseup / keyup 时算；white-space: pre-wrap 保证 DOM 文本长 = 字符串长） */
const pendingSelection = ref<{ start: number; end: number; quote: string } | null>(null)
const docBody = ref<HTMLElement | null>(null)

/** 上传入口：桌面态走 dialog 两段式；浏览器态只能 hidden input（md/txt） */
async function onUploadDoc(): Promise<void> {
  if (!hasKbBridge()) {
    docFileInput.value?.click()
    return
  }
  try {
    const pick = await pickDoc()
    if (pick.canceled || !pick.path) return
    const doc = await readDoc(pick.path)
    await kbStore.createDocAction({ title: doc.title, format: doc.format, content: doc.content })
    message.success(`已导入《${doc.title}》`)
  } catch (e) {
    message.error(failText(e))
  }
}

async function onDocFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const ext = file.name.split('.').pop()?.toLowerCase()
    const format: DocFormat = ext === 'md' ? 'md' : 'txt'
    // 归一化与桌面态 kb:read-doc 一致：剥 BOM + \r\n → \n（锚点偏移量前提）
    const content = (await file.text()).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
    await kbStore.createDocAction({ title: file.name, format, content })
    message.success(`已导入《${file.name}》`)
  } catch (err) {
    message.error(failText(err))
  } finally {
    input.value = ''
  }
}

async function onOpenDoc(id: string): Promise<void> {
  try {
    const doc = await getDoc(id)
    currentDoc.value = doc
    docAnchors.value = doc ? await listAnchors({ docId: doc.id }) : []
    pendingSelection.value = null
  } catch (e) {
    message.error(failText(e))
  }
}

async function onDeleteDoc(id: string): Promise<void> {
  try {
    await kbStore.removeDocAction(id)
    if (currentDoc.value?.id === id) {
      currentDoc.value = null
      docAnchors.value = []
    }
  } catch (e) {
    message.error(failText(e))
  }
}

/** 划词 → 记录偏移量（只在正文区内的选区才算） */
function onDocSelection(): void {
  const root = docBody.value
  const sel = window.getSelection()
  if (!root || !sel || sel.isCollapsed || !sel.rangeCount) {
    pendingSelection.value = null
    return
  }
  const range = sel.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) {
    pendingSelection.value = null
    return
  }
  const pre = range.cloneRange()
  pre.selectNodeContents(root)
  pre.setEnd(range.startContainer, range.startOffset)
  const start = pre.toString().length
  const quote = range.toString()
  pendingSelection.value = quote ? { start, end: start + quote.length, quote } : null
}

async function onAnchorSelection(): Promise<void> {
  const sel = pendingSelection.value
  const doc = currentDoc.value
  if (!sel || !doc) return
  const nodeId = flowStore.currentNode?.id
  if (!nodeId) {
    message.warning('请先在画布上选中一个节点，再把段落关联上去')
    return
  }
  try {
    await kbStore.createAnchorAction({
      docId: doc.id,
      nodeId,
      quote: sel.quote,
      startOffset: sel.start,
      endOffset: sel.end
    })
    docAnchors.value = await listAnchors({ docId: doc.id })
    window.getSelection()?.removeAllRanges()
    pendingSelection.value = null
    message.success('已把选中段关联到当前节点')
  } catch (e) {
    message.error(failText(e))
  }
}

async function onRemoveAnchor(id: string): Promise<void> {
  try {
    await kbStore.removeAnchorAction(id)
    docAnchors.value = docAnchors.value.filter((a) => a.id !== id)
  } catch (e) {
    message.error(failText(e))
  }
}

/* ---------------- 分区三：记忆 ---------------- */

const newMemoryText = ref('')
const newMemoryType = ref<MemoryType>('preference')
const editingMemoryId = ref('')
const editingMemoryText = ref('')
/** 左栏「最近访问」跳转到记忆时的高亮目标（无「打开」语义，用高亮 + 滚动代替） */
const focusMemoryId = ref('')
const memoryInput = ref<HTMLTextAreaElement | null>(null)

/** 标题行「新建记忆」：焦点送到轻量新建输入框（完整管理在 ControlCenter） */
function focusMemoryInput(): void {
  memoryInput.value?.focus()
}

async function onSaveNewMemory(): Promise<void> {
  const text = newMemoryText.value.trim()
  if (!text) {
    message.warning('记忆内容不能为空')
    return
  }
  try {
    await kbStore.createMemoryAction({ type: newMemoryType.value, content: text })
    newMemoryText.value = ''
    message.success('已保存')
  } catch (e) {
    message.error(failText(e))
  }
}

function onEditMemory(m: { id: string; content: string }): void {
  editingMemoryId.value = m.id
  editingMemoryText.value = m.content
}

async function onSaveMemoryEdit(): Promise<void> {
  const text = editingMemoryText.value.trim()
  if (!text) {
    message.warning('记忆内容不能为空')
    return
  }
  try {
    await kbStore.updateMemoryAction(editingMemoryId.value, { content: text })
    editingMemoryId.value = ''
  } catch (e) {
    message.error(failText(e))
  }
}

async function onRemoveMemory(id: string): Promise<void> {
  try {
    await kbStore.removeMemoryAction(id)
    if (editingMemoryId.value === id) editingMemoryId.value = ''
  } catch (e) {
    message.error(failText(e))
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="kbStore.panelOpen" class="nf-kb-modal" @click.self="close">
      <div
        ref="panel"
        class="nf-kb-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-label="知识库"
      >
        <header class="nf-kb__head">
          <span class="nf-kb__mark" aria-hidden="true" />
          <h2 class="nf-kb__title">知识库</h2>
          <span class="nf-kb__sub nf-mono-label">本机数据库 · novelflow.db</span>
          <button class="nf-kb__close" title="关闭（Esc）" @click="close">
            <svg viewBox="0 0 16 16" width="14" height="14">
              <path d="M4 4 L12 12 M12 4 L4 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </svg>
          </button>
        </header>

        <div class="nf-kb__body">
          <!-- 左栏：搜索 + 分区导航 + 最近访问（仿「我的资料库」） -->
          <nav class="nf-kb__nav">
            <div class="nf-kb__searchbar">
              <svg class="nf-kb__searchbar-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <path
                  d="M7 2.8 A4.2 4.2 0 1 0 7 11.2 A4.2 4.2 0 0 0 7 2.8 M10.2 10.2 L13.4 13.4"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linecap="round"
                />
              </svg>
              <input
                v-model="searchQuery"
                class="nf-kb__nav-search"
                placeholder="搜索知识库"
                @keyup.enter="onSearch"
              />
              <div class="nf-kb__searchbar-actions">
                <button class="nf-kb__searchbar-btn" title="搜索（回车也可）" @click="onSearch">
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                    <path
                      d="M7 2.8 A4.2 4.2 0 1 0 7 11.2 A4.2 4.2 0 0 0 7 2.8 M10.2 10.2 L13.4 13.4"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.4"
                      stroke-linecap="round"
                    />
                  </svg>
                </button>
                <button v-if="searchQuery" class="nf-kb__searchbar-btn" title="清除搜索" @click="clearSearch">
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                    <path d="M4 4 L12 12 M12 4 L4 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
                  </svg>
                </button>
              </div>
            </div>

            <button
              v-for="s in SECTIONS"
              :key="s.key"
              class="nf-kb__nav-item"
              :class="{ 'is-active': section === s.key }"
              @click="setSection(s.key)"
            >
              <svg class="nf-kb__nav-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                <path
                  :d="s.icon"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <span>{{ s.label }}</span>
              <span class="nf-kb__nav-count">{{ navCounts[s.key] }}</span>
            </button>

            <div class="nf-kb__nav-sep" aria-hidden="true" />
            <p class="nf-kb__nav-group">最近访问</p>
            <ul class="nf-kb__recent nf-scroll">
              <li
                v-for="r in recentItems"
                :key="r.kind + r.id"
                class="nf-kb__recent-item"
                :title="`${SECTION_SHORT[r.kind]} · ${r.title}`"
                @click="openRecent(r)"
              >
                <span class="nf-kb__recent-kind">{{ SECTION_SHORT[r.kind] }}</span>
                <span class="nf-kb__recent-title">{{ r.title }}</span>
              </li>
              <li v-if="!recentItems.length" class="nf-kb__recent-empty">暂无记录</li>
            </ul>
          </nav>

          <!-- 右栏主区：标题行（分区名 + 显眼操作按钮）+ 表格列表 + 详情/编辑器 -->
          <main class="nf-kb__main">
            <div class="nf-kb__main-top">
              <header class="nf-kb__main-head">
                <div class="nf-kb__main-title">
                  <h2 class="nf-kb__main-name">{{ currentSection.label }}</h2>
                  <span class="nf-kb__main-count">{{ sectionCountText }}</span>
                </div>
                <!-- 右上角主色填充操作按钮：修复「上传 / 新建找不到」的体验 -->
                <button
                  v-if="section === 'entries'"
                  class="nf-kb__cta"
                  title="新建一条知识条目"
                  @click="newEntryFromCta"
                >
                  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                    <path d="M8 3.2 V12.8 M3.2 8 H12.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                  </svg>
                  <span>新建条目</span>
                </button>
                <button
                  v-else-if="section === 'docs'"
                  class="nf-kb__cta"
                  :title="`上传文档（支持 md / txt${hasKbBridge() ? ' / docx' : ''}）`"
                  @click="onUploadDoc"
                >
                  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                    <path
                      d="M8 10.6 V3.4 M5.4 6 L8 3.4 L10.6 6 M3.4 10.4 V12.6 H12.6 V10.4"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.6"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                  <span>上传文档</span>
                </button>
                <button v-else class="nf-kb__cta" title="新建一条作者记忆" @click="focusMemoryInput">
                  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                    <path d="M8 3.2 V12.8 M3.2 8 H12.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                  </svg>
                  <span>新建记忆</span>
                </button>
              </header>
              <div v-if="section === 'entries'" class="nf-kb__filters">
                <button
                  class="nf-kb__chip"
                  :class="{ 'is-active': typeFilter === '' }"
                  @click="typeFilter = ''"
                >
                  全部
                </button>
                <button
                  v-for="t in TYPE_OPTIONS"
                  :key="t.value"
                  class="nf-kb__chip"
                  :class="{ 'is-active': typeFilter === t.value }"
                  @click="typeFilter = t.value"
                >
                  {{ t.label }}
                </button>
              </div>
            </div>

            <!-- ============ 知识条目 ============ -->
            <div v-if="section === 'entries'" class="nf-kb__split">
              <div class="nf-kb__col nf-kb__col--list">
                <ul class="nf-kb__table nf-scroll">
                  <li class="nf-kb__tr nf-kb__tr--head" aria-hidden="true">
                    <span class="nf-kb__th">名称</span>
                    <span class="nf-kb__th">类型</span>
                    <span class="nf-kb__th">位置</span>
                    <span class="nf-kb__th nf-kb__th--end">最近访问</span>
                  </li>
                  <li
                    v-for="e in displayEntries"
                    :key="e.id"
                    class="nf-kb__tr"
                    :class="{ 'is-active': editingEntryId === e.id }"
                    :title="e.title"
                    @click="onEditEntry(e)"
                  >
                    <span class="nf-kb__td nf-kb__td--name">
                      <svg class="nf-kb__type-icon" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                        <path
                          :d="ENTRY_TYPE_ICON[e.type]"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.3"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        />
                      </svg>
                      <span class="nf-kb__tr-title">{{ e.title }}</span>
                    </span>
                    <span class="nf-kb__td nf-kb__td--type">
                      <span class="nf-kb__tag">{{ ENTRY_TYPE_LABEL[e.type] }}</span>
                    </span>
                    <!-- 位置列：条目没有独立的「目录」概念，用标签当作来源信息 -->
                    <span class="nf-kb__td nf-kb__td--loc">
                      {{
                        e.tags.length
                          ? e.tags.slice(0, 2).join(' · ') + (e.tags.length > 2 ? ` +${e.tags.length - 2}` : '')
                          : '—'
                      }}
                    </span>
                    <span class="nf-kb__td nf-kb__td--date">{{ formatDate(e.updatedAt) }}</span>
                  </li>
                  <li v-if="!displayEntries.length" class="nf-kb__empty">
                    {{ searchResults ? '没有匹配的条目' : '还没有条目，点右上角「新建条目」开始' }}
                  </li>
                </ul>
              </div>

              <div class="nf-kb__col nf-kb__col--editor">
                <div class="nf-kb__detail-head">
                  <span class="nf-kb__detail-title">{{ editingEntryId ? '编辑条目' : '新建条目' }}</span>
                  <span v-if="editingEntryId" class="nf-kb__detail-sub">{{ entryDraft.title }}</span>
                </div>
                <input
                  ref="entryTitleInput"
                  v-model="entryDraft.title"
                  class="nf-kb__title-input"
                  placeholder="条目标题"
                />
                <div class="nf-kb__editor-row">
                  <select v-model="entryDraft.type" class="nf-kb__select">
                    <option v-for="t in TYPE_OPTIONS" :key="t.value" :value="t.value">
                      {{ t.label }}
                    </option>
                  </select>
                  <input
                    v-model="entryDraft.tags"
                    class="nf-kb__tags-input"
                    placeholder="标签，用逗号分隔"
                  />
                </div>
                <textarea
                  v-model="entryDraft.content"
                  class="nf-kb__content"
                  placeholder="条目正文（设定、细节、参考…）"
                />
                <div class="nf-kb__editor-actions">
                  <button class="nf-kb__mini is-primary" @click="onSaveEntry">保存</button>
                  <button
                    v-if="editingEntryId"
                    class="nf-kb__mini is-danger"
                    @click="onDeleteEntry(editingEntryId)"
                  >
                    删除
                  </button>
                  <button class="nf-kb__mini" @click="resetEntryDraft">新建</button>
                </div>
              </div>
            </div>

            <!-- ============ 参考文档 ============ -->
            <div v-else-if="section === 'docs'" class="nf-kb__split">
              <div class="nf-kb__col nf-kb__col--list">
                <!-- 浏览器态上传入口：仅 .md / .txt（docx 解析仅桌面端）；桌面态走 pickDoc 对话框 -->
                <input ref="docFileInput" type="file" accept=".md,.txt" hidden @change="onDocFile" />
                <ul class="nf-kb__table nf-scroll">
                  <li class="nf-kb__tr nf-kb__tr--head" aria-hidden="true">
                    <span class="nf-kb__th">名称</span>
                    <span class="nf-kb__th">类型</span>
                    <span class="nf-kb__th">位置</span>
                    <span class="nf-kb__th nf-kb__th--end">最近访问</span>
                  </li>
                  <li
                    v-for="d in displayDocs"
                    :key="d.id"
                    class="nf-kb__tr"
                    :class="{ 'is-active': currentDoc && currentDoc.id === d.id }"
                    :title="d.title"
                    @click="onOpenDoc(d.id)"
                  >
                    <span class="nf-kb__td nf-kb__td--name">
                      <span class="nf-kb__fmt">{{ d.format.toUpperCase() }}</span>
                      <span class="nf-kb__tr-title">{{ d.title }}</span>
                    </span>
                    <span class="nf-kb__td nf-kb__td--type">
                      <span class="nf-kb__tag">{{ DOC_FORMAT_LABEL[d.format] }}</span>
                    </span>
                    <!-- 位置列：文档统一来自本机导入，展示格式来源 -->
                    <span class="nf-kb__td nf-kb__td--loc">本机导入</span>
                    <span class="nf-kb__td nf-kb__td--date">{{ formatDate(d.updatedAt) }}</span>
                  </li>
                  <li v-if="!displayDocs.length" class="nf-kb__empty">
                    {{ searchQuery ? '没有匹配的文档' : '还没有文档，点右上角「上传文档」导入' }}
                  </li>
                </ul>
              </div>

              <div class="nf-kb__col nf-kb__col--viewer">
                <template v-if="currentDoc">
                  <div class="nf-kb__viewer-head">
                    <span class="nf-kb__viewer-title">{{ currentDoc.title }}</span>
                    <button
                      class="nf-kb__mini is-primary"
                      :disabled="!pendingSelection"
                      title="先在正文里用鼠标划选一段文字"
                      @click="onAnchorSelection"
                    >
                      把选中段关联到当前节点
                    </button>
                    <button class="nf-kb__mini is-danger" @click="onDeleteDoc(currentDoc.id)">
                      删除文档
                    </button>
                  </div>
                  <div
                    ref="docBody"
                    v-text="currentDoc.content"
                    class="nf-kb__doc nf-scroll"
                    @mouseup="onDocSelection"
                    @keyup="onDocSelection"
                  />
                  <div class="nf-kb__anchors">
                    <p class="nf-kb__anchors-title">锚点（{{ docAnchors.length }}）</p>
                    <ul v-if="docAnchors.length" class="nf-kb__anchor-list nf-scroll">
                      <li v-for="a in docAnchors" :key="a.id" class="nf-kb__anchor">
                        <span class="nf-kb__anchor-quote">{{ a.quote }}</span>
                        <button class="nf-kb__mini is-danger" @click="onRemoveAnchor(a.id)">
                          解除
                        </button>
                      </li>
                    </ul>
                    <p v-else class="nf-kb__empty">
                      在正文里划选一段，点「把选中段关联到当前节点」建成锚点（需先在画布选中节点）
                    </p>
                  </div>
                </template>
                <p v-else class="nf-kb__empty nf-kb__empty--center">从左边选一个文档查看</p>
              </div>
            </div>

            <!-- ============ 作者记忆 ============ -->
            <div v-else class="nf-kb__col nf-kb__col--memory">
              <div class="nf-kb__toolbar--memory">
                <textarea
                  ref="memoryInput"
                  v-model="newMemoryText"
                  class="nf-kb__content nf-kb__content--sm"
                  rows="2"
                  placeholder="新建一条作者记忆（偏好 / 事实 / 决定 / 背景）…"
                />
                <select v-model="newMemoryType" class="nf-kb__select">
                  <option v-for="(label, key) in MEMORY_TYPE_LABEL" :key="key" :value="key">
                    {{ label }}
                  </option>
                </select>
                <button class="nf-kb__mini is-primary" @click="onSaveNewMemory">保存</button>
              </div>
              <ul class="nf-kb__table nf-kb__table--mem nf-scroll">
                <li class="nf-kb__tr nf-kb__tr--head" aria-hidden="true">
                  <span class="nf-kb__th">名称</span>
                  <span class="nf-kb__th">类型</span>
                  <span class="nf-kb__th">位置</span>
                  <span class="nf-kb__th nf-kb__th--end">最近访问</span>
                </li>
                <li
                  v-for="m in displayMemories"
                  :key="m.id"
                  class="nf-kb__tr nf-kb__tr--mem"
                  :class="{ 'is-focus': focusMemoryId === m.id }"
                >
                  <template v-if="editingMemoryId === m.id">
                    <span class="nf-kb__td nf-kb__td--name">
                      <textarea
                        v-model="editingMemoryText"
                        class="nf-kb__mem-edit"
                        rows="2"
                      />
                    </span>
                    <span class="nf-kb__td nf-kb__td--type">
                      <span class="nf-kb__tag">{{ MEMORY_TYPE_LABEL[m.type] }}</span>
                    </span>
                    <span class="nf-kb__td nf-kb__td--loc">{{ MEMORY_SOURCE_LABEL[m.source] }}</span>
                    <span class="nf-kb__td nf-kb__td--date">
                      <button class="nf-kb__mini" @click="onSaveMemoryEdit">保存</button>
                      <button class="nf-kb__mini" @click="editingMemoryId = ''">取消</button>
                    </span>
                  </template>
                  <template v-else>
                    <span class="nf-kb__td nf-kb__td--name" :title="m.content">
                      <svg class="nf-kb__type-icon" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                        <path
                          d="M8 2.6 A5.4 5.4 0 1 0 8 13.4 A4.2 4.2 0 0 1 8 2.6 Z M6.2 6.4 H9.8 M6.2 8.6 H9.8 M6.2 10.8 H8.4"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.3"
                          stroke-linecap="round"
                        />
                      </svg>
                      <span class="nf-kb__tr-title">{{ m.content }}</span>
                    </span>
                    <span class="nf-kb__td nf-kb__td--type">
                      <span class="nf-kb__tag">{{ MEMORY_TYPE_LABEL[m.type] }}</span>
                    </span>
                    <span class="nf-kb__td nf-kb__td--loc">{{ MEMORY_SOURCE_LABEL[m.source] }}</span>
                    <span class="nf-kb__td nf-kb__td--date">
                      <span class="nf-kb__row-date">{{ formatDate(m.updatedAt) }}</span>
                      <!-- 改 / 删直接做日期格的 flex 子项（与编辑态的保存 / 取消同构），间距复用格内 gap -->
                      <button class="nf-kb__mini" @click="onEditMemory(m)">改</button>
                      <button class="nf-kb__mini is-danger" @click="onRemoveMemory(m.id)">删</button>
                    </span>
                  </template>
                </li>
                <li v-if="!displayMemories.length" class="nf-kb__empty">
                  {{ searchQuery ? '没有匹配的记忆' : '还没有记忆。AI 结果可在写作浮层里「存为记忆」。' }}
                </li>
              </ul>
              <p class="nf-kb__hint">导入 / 导出 / 重置在左下角「控制中心 → 记忆与进化」。</p>
            </div>
          </main>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/*
 * z-index 900：业务弹层档（UpdateDialog / ApiConsole 同档）。从 ControlCenter
 * （950）打开时它先自关，不同屏；NodeInspector 打开时无更高层占用。
 * 视觉纪律：全部 --nf-* token，禁纯黑 / 霓虹渐变 / 等宽字体 / 直角 / 回弹 /
 * 虚线边框；动效 ease-out（--nf-ease，150-250ms 档）。
 */
.nf-kb-modal {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: grid;
  place-items: center;
  background: rgba(6, 10, 15, 0.55);
  backdrop-filter: blur(4px);
  animation: nf-kb-fade var(--nf-dur) var(--nf-ease) both;
}

.nf-kb-modal__panel {
  /* 资料库级大面板：viewport 收窄时按比例收缩，不再写死 960×680 */
  width: min(1180px, 94vw);
  height: min(760px, 88vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: linear-gradient(180deg, var(--nf-shell-800) 0%, var(--nf-shell-900) 100%);
  border: 1px solid var(--nf-shell-line);
  border-radius: var(--nf-r-card);
  box-shadow: var(--nf-shadow-pop);
  /* 入场只有淡入 + 轻微放大，禁回弹 */
  animation: nf-kb-in var(--nf-dur) var(--nf-ease) both;
}

/* ---------------- 头部 ---------------- */
.nf-kb__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 14px 18px 12px;
  border-bottom: 1px solid var(--nf-shell-line-soft);
}
.nf-kb__mark {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: linear-gradient(135deg, #6fdde4 0%, #2aa6b0 100%);
  box-shadow: 0 0 0 4px rgba(77, 208, 217, 0.14);
}
.nf-kb__title {
  margin: 0;
  font-size: var(--nf-fs-lg);
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--nf-on-dark-strong);
}
.nf-kb__sub {
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.06em;
  color: var(--nf-on-dark-faint);
}
.nf-kb__close {
  margin-left: auto;
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
.nf-kb__close:hover {
  color: var(--nf-teal);
  background: rgba(77, 208, 217, 0.1);
}

/* ---------------- 身体（左导航 + 右内容） ---------------- */
.nf-kb__body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
}

/* ---------------- 左栏（仿「我的资料库」） ---------------- */
.nf-kb__nav {
  flex: none;
  width: 240px;
  padding: 14px 12px 16px;
  border-right: 1px solid var(--nf-shell-line-soft);
  display: flex;
  flex-direction: column;
}

/* 左栏搜索框：图标 + 输入 + 搜索 / 清除两个小按钮 */
.nf-kb__searchbar {
  position: relative;
  display: flex;
  align-items: center;
  margin-bottom: 12px;
}
.nf-kb__nav-search {
  width: 100%;
  height: 32px;
  padding: 0 62px 0 30px;
  border-radius: var(--nf-r-ctl);
  border: 1px solid var(--nf-shell-line);
  background: rgba(8, 14, 19, 0.4);
  color: var(--nf-on-dark);
  font-size: var(--nf-fs-xs);
  transition: border-color var(--nf-dur-fast) var(--nf-ease);
}
.nf-kb__nav-search:focus {
  outline: none;
  border-color: rgba(77, 208, 217, 0.45);
}
.nf-kb__nav-search::placeholder {
  color: var(--nf-on-dark-faint);
}
.nf-kb__searchbar-icon {
  position: absolute;
  left: 10px;
  color: var(--nf-on-dark-faint);
  pointer-events: none;
}
.nf-kb__searchbar-actions {
  position: absolute;
  right: 5px;
  display: flex;
  align-items: center;
  gap: 2px;
}
.nf-kb__searchbar-btn {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--nf-on-dark-soft);
  width: 24px;
  height: 24px;
  border-radius: 7px;
  display: grid;
  place-items: center;
  cursor: pointer;
  transition:
    color var(--nf-dur-fast) var(--nf-ease),
    background var(--nf-dur-fast) var(--nf-ease);
}
.nf-kb__searchbar-btn:hover {
  color: var(--nf-teal);
  background: rgba(77, 208, 217, 0.1);
}

.nf-kb__nav-item {
  appearance: none;
  border: none;
  background: transparent;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 10px;
  border-radius: var(--nf-r-ctl);
  cursor: pointer;
  text-align: left;
  font-size: var(--nf-fs-sm);
  color: var(--nf-on-dark);
  transition:
    color var(--nf-dur-fast) var(--nf-ease),
    background var(--nf-dur-fast) var(--nf-ease);
}
.nf-kb__nav-item:hover {
  color: var(--nf-on-dark-strong);
  background: rgba(148, 172, 196, 0.08);
}
.nf-kb__nav-item.is-active {
  color: var(--nf-teal);
  background: rgba(77, 208, 217, 0.12);
}
.nf-kb__nav-icon {
  flex: none;
  color: currentColor;
  opacity: 0.85;
}
.nf-kb__nav-count {
  margin-left: auto;
  font-size: var(--nf-fs-2xs);
  color: var(--nf-on-dark-faint);
  font-variant-numeric: tabular-nums;
}

/* 左栏「最近访问」分组：跨分区混合，点击跳转并选中 */
.nf-kb__nav-sep {
  flex: none;
  height: 1px;
  background: var(--nf-shell-line-soft);
  margin: 12px 4px 10px;
}
.nf-kb__nav-group {
  flex: none;
  margin: 0 0 4px;
  padding: 0 10px;
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.06em;
  color: var(--nf-on-dark-faint);
}
.nf-kb__recent {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nf-kb__recent-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 10px;
  border-radius: var(--nf-r-ctl);
  cursor: pointer;
  font-size: var(--nf-fs-xs);
  color: var(--nf-on-dark);
  transition:
    color var(--nf-dur-fast) var(--nf-ease),
    background var(--nf-dur-fast) var(--nf-ease);
}
.nf-kb__recent-item:hover {
  color: var(--nf-on-dark-strong);
  background: rgba(148, 172, 196, 0.08);
}
.nf-kb__recent-kind {
  flex: none;
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--nf-teal);
  background: rgba(77, 208, 217, 0.12);
  border-radius: var(--nf-r-chip);
  padding: 1px 6px;
}
.nf-kb__recent-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nf-kb__recent-empty {
  padding: 6px 10px;
  font-size: var(--nf-fs-2xs);
  color: var(--nf-on-dark-faint);
}

/* ---------------- 右栏主区 ---------------- */
.nf-kb__main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* 标题行 + 过滤条（合在一起加下边线，与表格区分隔） */
.nf-kb__main-top {
  flex: none;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--nf-shell-line-soft);
}
.nf-kb__main-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px 8px;
}
.nf-kb__main-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.nf-kb__main-name {
  margin: 0;
  font-size: var(--nf-fs-md);
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--nf-on-dark-strong);
}
.nf-kb__main-count {
  font-size: var(--nf-fs-2xs);
  color: var(--nf-on-dark-faint);
  font-variant-numeric: tabular-nums;
}

/* 右上角主色填充操作按钮：全面板视觉重心，修复「上传 / 新建找不到」 */
.nf-kb__cta {
  margin-left: auto;
  appearance: none;
  border: none;
  height: 32px;
  padding: 0 14px;
  border-radius: var(--nf-r-ctl);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--nf-teal);
  color: var(--nf-shell-900);
  font-size: var(--nf-fs-sm);
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  white-space: nowrap;
  transition:
    filter var(--nf-dur-fast) var(--nf-ease),
    box-shadow var(--nf-dur-fast) var(--nf-ease);
}
.nf-kb__cta:hover {
  filter: brightness(1.08);
  box-shadow: 0 0 0 3px rgba(77, 208, 217, 0.18);
}

.nf-kb__filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 18px 0;
}

/* ---------------- 两栏布局（表格列表 / 编辑或查看） ---------------- */
.nf-kb__split {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
}
.nf-kb__col {
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 12px 18px 16px;
}
.nf-kb__col--list {
  flex: none;
  width: 520px;
  /* 窄窗口下不让列表把详情区挤没 */
  max-width: 56%;
  border-right: 1px solid var(--nf-shell-line-soft);
}
.nf-kb__col--editor,
.nf-kb__col--viewer,
.nf-kb__col--memory {
  flex: 1 1 auto;
  min-width: 0;
}

/* ---------------- 表格行列表（仿资料库列表） ---------------- */
.nf-kb__table {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
/* 四列网格：名称（弹性）/ 类型 / 位置 / 最近访问（右对齐） */
.nf-kb__tr {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 76px 108px 84px;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: var(--nf-r-ctl);
  cursor: pointer;
  font-size: var(--nf-fs-xs);
  color: var(--nf-on-dark);
  transition:
    background var(--nf-dur-fast) var(--nf-ease),
    color var(--nf-dur-fast) var(--nf-ease);
}
.nf-kb__tr--head {
  cursor: default;
  padding: 2px 12px 8px;
  border-radius: 0;
  border-bottom: 1px solid var(--nf-shell-line-soft);
  margin-bottom: 4px;
}
.nf-kb__tr:not(.nf-kb__tr--head):hover {
  background: rgba(148, 172, 196, 0.08);
}
.nf-kb__tr.is-active,
.nf-kb__tr.is-focus {
  background: rgba(77, 208, 217, 0.1);
}
.nf-kb__tr--mem {
  cursor: default;
  align-items: center;
}
/* 记忆行末列要同时放日期 + 改 / 删（或保存 / 取消）两个小按钮，比其他表格宽 */
.nf-kb__table--mem .nf-kb__tr {
  grid-template-columns: minmax(0, 1fr) 72px 92px 152px;
}
.nf-kb__th {
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.06em;
  color: var(--nf-on-dark-faint);
}
.nf-kb__th--end {
  text-align: right;
}
.nf-kb__td {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nf-kb__td--name {
  display: flex;
  align-items: center;
  gap: 8px;
}
.nf-kb__td--type {
  overflow: visible;
}
.nf-kb__td--loc {
  color: var(--nf-on-dark-soft);
}
.nf-kb__td--date {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  color: var(--nf-on-dark-faint);
  font-variant-numeric: tabular-nums;
}
.nf-kb__row-date {
  flex: none;
}
.nf-kb__tr-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nf-kb__type-icon {
  flex: none;
  color: var(--nf-teal);
  opacity: 0.85;
}

/* ---------------- 控件 ---------------- */
.nf-kb__chip {
  appearance: none;
  border: 1px solid var(--nf-shell-line);
  background: transparent;
  color: var(--nf-on-dark-soft);
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  cursor: pointer;
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.04em;
  transition:
    color var(--nf-dur-fast) var(--nf-ease),
    border-color var(--nf-dur-fast) var(--nf-ease),
    background var(--nf-dur-fast) var(--nf-ease);
}
.nf-kb__chip:hover,
.nf-kb__chip.is-active {
  color: var(--nf-teal);
  border-color: rgba(77, 208, 217, 0.45);
  background: rgba(77, 208, 217, 0.12);
}

.nf-kb__mini {
  appearance: none;
  border: 1px solid var(--nf-shell-line);
  background: rgba(8, 14, 19, 0.4);
  color: var(--nf-on-dark-soft);
  height: 26px;
  padding: 0 10px;
  border-radius: 7px;
  cursor: pointer;
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.04em;
  white-space: nowrap;
  transition:
    color var(--nf-dur-fast) var(--nf-ease),
    border-color var(--nf-dur-fast) var(--nf-ease),
    background var(--nf-dur-fast) var(--nf-ease);
}
.nf-kb__mini:hover:not(:disabled) {
  color: var(--nf-teal);
  border-color: rgba(77, 208, 217, 0.42);
}
.nf-kb__mini.is-primary {
  color: var(--nf-teal);
  border-color: rgba(77, 208, 217, 0.42);
  background: rgba(77, 208, 217, 0.14);
}
.nf-kb__mini.is-danger:hover:not(:disabled) {
  color: var(--nf-danger);
  border-color: rgba(200, 106, 99, 0.42);
}
.nf-kb__mini:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* 表格内的类型徽标 / 文档格式徽标 */
.nf-kb__tag,
.nf-kb__fmt {
  flex: none;
  font-size: 10px;
  letter-spacing: 0.06em;
  border-radius: var(--nf-r-chip);
  padding: 1px 7px;
}
.nf-kb__tag {
  color: var(--nf-teal);
  background: rgba(77, 208, 217, 0.12);
}
.nf-kb__fmt {
  color: var(--nf-on-dark-soft);
  background: rgba(148, 172, 196, 0.14);
}

.nf-kb__title-input,
.nf-kb__tags-input,
.nf-kb__select {
  height: 30px;
  padding: 0 10px;
  border-radius: var(--nf-r-ctl);
  border: 1px solid var(--nf-shell-line);
  background: rgba(8, 14, 19, 0.4);
  color: var(--nf-on-dark);
  font-size: var(--nf-fs-sm);
}
.nf-kb__title-input:focus,
.nf-kb__tags-input:focus,
.nf-kb__select:focus,
.nf-kb__content:focus,
.nf-kb__nav-search:focus,
.nf-kb__mem-edit:focus {
  outline: none;
  border-color: rgba(77, 208, 217, 0.45);
}

/* ---------------- 详情列头（编辑器 / 查看器） ---------------- */
.nf-kb__detail-head {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 10px;
  min-width: 0;
}
.nf-kb__detail-title {
  font-size: var(--nf-fs-sm);
  font-weight: 600;
  color: var(--nf-on-dark-strong);
}
.nf-kb__detail-sub {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--nf-fs-2xs);
  color: var(--nf-on-dark-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------------- 条目编辑器 ---------------- */
.nf-kb__editor-row {
  display: flex;
  gap: 8px;
  margin: 10px 0;
}
.nf-kb__tags-input {
  flex: 1 1 auto;
  min-width: 0;
}
.nf-kb__content {
  flex: 1 1 auto;
  min-height: 120px;
  resize: none;
  padding: 9px 11px;
  border-radius: var(--nf-r-ctl);
  border: 1px solid var(--nf-shell-line);
  background: rgba(8, 14, 19, 0.4);
  color: var(--nf-on-dark);
  font-size: var(--nf-fs-sm);
  line-height: 1.85;
}
.nf-kb__content--sm {
  min-height: 0;
  resize: vertical;
  font-size: var(--nf-fs-xs);
  line-height: 1.7;
}
.nf-kb__editor-actions {
  margin-top: 10px;
  display: flex;
  gap: 6px;
}

/* ---------------- 文档查看器 ---------------- */
.nf-kb__viewer-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.nf-kb__viewer-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--nf-fs-sm);
  font-weight: 600;
  color: var(--nf-on-dark-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nf-kb__doc {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
  border-radius: var(--nf-r-ctl);
  background: rgba(8, 14, 19, 0.5);
  border: 1px solid var(--nf-shell-line-soft);
  /* pre-wrap：划选偏移量按字符长度算，必须保持空白与换行 */
  white-space: pre-wrap;
  word-break: break-word;
  font-size: var(--nf-fs-sm);
  line-height: 1.9;
  color: var(--nf-on-dark);
}
.nf-kb__doc ::selection {
  background: rgba(77, 208, 217, 0.32);
}
.nf-kb__anchors {
  flex: none;
  margin-top: 10px;
}
.nf-kb__anchors-title {
  margin: 0 0 6px;
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.06em;
  color: var(--nf-on-dark-faint);
}
.nf-kb__anchor-list {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 120px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.nf-kb__anchor {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  border-radius: var(--nf-r-ctl);
  background: var(--nf-shell-700);
  border: 1px solid var(--nf-shell-line-soft);
  font-size: var(--nf-fs-2xs);
  color: var(--nf-on-dark);
}
.nf-kb__anchor-quote {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--nf-on-dark-soft);
}

/* ---------------- 记忆 ---------------- */
.nf-kb__toolbar--memory {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
  align-items: flex-start;
}
.nf-kb__toolbar--memory .nf-kb__content--sm {
  flex: 1 1 auto;
}
.nf-kb__mem-edit {
  width: 100%;
  resize: vertical;
  padding: 6px 9px;
  border-radius: var(--nf-r-ctl);
  border: 1px solid var(--nf-shell-line);
  background: rgba(8, 14, 19, 0.4);
  color: var(--nf-on-dark);
  font-size: var(--nf-fs-xs);
  line-height: 1.6;
}

.nf-kb__empty {
  padding: 14px 10px;
  font-size: var(--nf-fs-2xs);
  line-height: 1.7;
  color: var(--nf-on-dark-faint);
}
.nf-kb__empty--center {
  margin: auto;
  text-align: center;
}
.nf-kb__hint {
  flex: none;
  margin: 10px 0 0;
  font-size: var(--nf-fs-2xs);
  color: var(--nf-on-dark-faint);
}

@keyframes nf-kb-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes nf-kb-in {
  from {
    opacity: 0;
    transform: scale(0.98);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
