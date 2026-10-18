import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import * as kb from '@/api/kbClient'
import type {
  CreateAnchorInput,
  CreateDocInput,
  CreateEntryInput,
  CreateMemoryInput,
  CurateReport,
  DocAnchor,
  KbDocument,
  KbEvent,
  KnowledgeEntry,
  MemoryEntry,
  NodeLinks,
  UpdateAnchorInput,
  UpdateDocInput,
  UpdateEntryInput,
  UpdateMemoryInput
} from '@/core/kb/types'

/**
 * 知识库统一 store（条目 / 文档 / 记忆 / 偏好 / 事件 + 大面板开关）。
 *
 * 为什么**不放 useUiStore**：useUiStore 有个 watch 把 shellTheme 等同步进
 * flow.workspace.ui → localStorage。kb 态进去就会形成「db + localStorage」
 * 双源双写，且会随工作区 JSON 导出 —— 违背「知识库独立存储」的隔离。
 * 本 store 无持久化插件，状态以 db（桌面）/ IndexedDB（浏览器）为事实源。
 *
 * 两个记忆开关默认 false（隐私优先）：db 无记录时 computed 回落 false。
 */

/** 大面板左侧分区 */
export type KbPanelSection = 'entries' | 'docs' | 'memory'

/** 启动后防抖整理的延迟（不虚构定时任务：只跑一次，手动整理随时可点） */
const BOOT_CURATE_DELAY = 15_000
/** 工作背景保存防抖 */
const BACKGROUND_SAVE_DELAY = 800

export const useKbStore = defineStore('kb', () => {
  /* ---------------- 面板状态 ---------------- */
  const panelOpen = ref(false)
  const panelSection = ref<KbPanelSection>('entries')

  /* ---------------- 数据 ---------------- */
  const entries = ref<KnowledgeEntry[]>([])
  const docs = ref<KbDocument[]>([])
  const memories = ref<MemoryEntry[]>([])
  const events = ref<KbEvent[]>([])
  const preferences = ref<Record<string, string>>({})
  /** NodeInspector「关联」TabPane 的按节点反查结果 */
  const nodeLinks = ref<(NodeLinks & { nodeId: string }) | null>(null)
  const loading = ref(false)
  const error = ref('')

  /* ---------------- 偏好（默认 false = 隐私优先） ---------------- */
  const chatMemory = computed(() => preferences.value['pref.chat_memory'] === 'true')
  const localMemory = computed(() => preferences.value['pref.local_memory'] === 'true')
  const workBackground = computed(() => preferences.value['pref.work_background'] ?? '')
  /** 工作背景草稿（多行编辑器 v-model）；保存走防抖（见下方 setWorkBackgroundDraft / saveWorkBackground） */
  const workBackgroundDraft = ref('')

  /* ---------------- 面板 ---------------- */

  function openPanel(section: KbPanelSection = 'entries'): void {
    panelSection.value = section
    panelOpen.value = true
  }

  function closePanel(): void {
    panelOpen.value = false
  }

  /* ---------------- 读取 ---------------- */

  async function refresh(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      // 各路单独 catch：偏好读失败不该连带条目列表也空
      const [entryList, docList, memoryList, eventList, prefMap] = await Promise.all([
        kb.listEntries().catch(() => [] as KnowledgeEntry[]),
        kb.listDocs().catch(() => [] as KbDocument[]),
        kb.listMemories().catch(() => [] as MemoryEntry[]),
        kb.listEvents().catch(() => [] as KbEvent[]),
        kb.getPreferences().catch(() => ({}) as Record<string, string>)
      ])
      entries.value = entryList
      docs.value = docList
      memories.value = memoryList
      events.value = eventList
      preferences.value = prefMap
      workBackgroundDraft.value = workBackground.value
      scheduleBootCurate()
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
  }

  async function refreshNodeLinks(nodeId: string): Promise<void> {
    if (!nodeId) {
      nodeLinks.value = null
      return
    }
    try {
      const links = await kb.listLinksForNode(nodeId)
      nodeLinks.value = { nodeId, ...links }
    } catch {
      // 反查失败不弹错：关联区显示空列表，主链路不受影响
      nodeLinks.value = { nodeId, entries: [], docs: [] }
    }
  }

  /* ---------------- 条目 ---------------- */

  async function createEntryAction(input: CreateEntryInput): Promise<KnowledgeEntry> {
    const created = await kb.createEntry(input)
    entries.value = [created, ...entries.value]
    return created
  }

  async function updateEntryAction(id: string, patch: UpdateEntryInput): Promise<KnowledgeEntry | null> {
    const updated = await kb.updateEntry(id, patch)
    if (updated) {
      entries.value = entries.value.map((e) => (e.id === id ? updated : e))
    }
    return updated
  }

  async function removeEntryAction(id: string): Promise<void> {
    await kb.removeEntry(id)
    entries.value = entries.value.filter((e) => e.id !== id)
    if (nodeLinks.value?.nodeId) void refreshNodeLinks(nodeLinks.value.nodeId)
  }

  async function searchAction(query: string): Promise<KnowledgeEntry[]> {
    return kb.searchEntries(query)
  }

  /* ---------------- 节点关联 ---------------- */

  async function linkEntryAction(entryId: string, nodeId: string): Promise<void> {
    await kb.linkEntry(entryId, nodeId)
    await refreshNodeLinks(nodeId)
  }

  async function unlinkEntryAction(entryId: string, nodeId: string): Promise<void> {
    await kb.unlinkEntry(entryId, nodeId)
    await refreshNodeLinks(nodeId)
  }

  async function linkDocAction(docId: string, nodeId: string): Promise<void> {
    await kb.linkDoc(docId, nodeId)
    await refreshNodeLinks(nodeId)
  }

  async function unlinkDocAction(docId: string, nodeId: string): Promise<void> {
    await kb.unlinkDoc(docId, nodeId)
    await refreshNodeLinks(nodeId)
  }

  /* ---------------- 文档 ---------------- */

  async function createDocAction(input: CreateDocInput): Promise<KbDocument> {
    const created = await kb.createDoc(input)
    docs.value = [created, ...docs.value]
    return created
  }

  async function updateDocAction(id: string, patch: UpdateDocInput): Promise<KbDocument | null> {
    const updated = await kb.updateDoc(id, patch)
    if (updated) {
      docs.value = docs.value.map((d) => (d.id === id ? updated : d))
    }
    return updated
  }

  async function removeDocAction(id: string): Promise<void> {
    await kb.removeDoc(id)
    docs.value = docs.value.filter((d) => d.id !== id)
    if (nodeLinks.value?.nodeId) void refreshNodeLinks(nodeLinks.value.nodeId)
  }

  /* ---------------- 锚点（面板内直接走 kbClient，store 只提供便捷包装） ---------------- */

  async function createAnchorAction(input: CreateAnchorInput): Promise<DocAnchor> {
    return kb.createAnchor(input)
  }

  async function updateAnchorAction(id: string, patch: UpdateAnchorInput): Promise<DocAnchor | null> {
    return kb.updateAnchor(id, patch)
  }

  async function removeAnchorAction(id: string): Promise<void> {
    await kb.removeAnchor(id)
  }

  /* ---------------- 记忆 ---------------- */

  async function createMemoryAction(input: CreateMemoryInput): Promise<MemoryEntry> {
    const created = await kb.createMemory(input)
    memories.value = [created, ...memories.value]
    return created
  }

  async function updateMemoryAction(id: string, patch: UpdateMemoryInput): Promise<MemoryEntry | null> {
    const updated = await kb.updateMemory(id, patch)
    if (updated) {
      memories.value = memories.value.map((m) => (m.id === id ? updated : m))
    }
    return updated
  }

  async function removeMemoryAction(id: string): Promise<void> {
    await kb.removeMemory(id)
    memories.value = memories.value.filter((m) => m.id !== id)
  }

  async function resetMemoriesAction(): Promise<void> {
    await kb.resetMemories()
    memories.value = []
  }

  async function exportMemoriesAction(): Promise<string> {
    return kb.exportMemories()
  }

  async function importMemoriesAction(json: string): Promise<number> {
    const imported = await kb.importMemories(json)
    await refresh()
    return imported
  }

  /* ---------------- 偏好写入 ---------------- */

  async function setChatMemory(value: boolean): Promise<void> {
    await kb.setPreference('pref.chat_memory', value ? 'true' : 'false')
    preferences.value = { ...preferences.value, 'pref.chat_memory': value ? 'true' : 'false' }
  }

  async function setLocalMemory(value: boolean): Promise<void> {
    await kb.setPreference('pref.local_memory', value ? 'true' : 'false')
    preferences.value = { ...preferences.value, 'pref.local_memory': value ? 'true' : 'false' }
  }

  let bgTimer: ReturnType<typeof setTimeout> | null = null

  function setWorkBackgroundDraft(text: string): void {
    workBackgroundDraft.value = text
    if (bgTimer) clearTimeout(bgTimer)
    bgTimer = setTimeout(() => {
      bgTimer = null
      void saveWorkBackground().catch(() => undefined)
    }, BACKGROUND_SAVE_DELAY)
  }

  async function saveWorkBackground(): Promise<void> {
    if (bgTimer) {
      clearTimeout(bgTimer)
      bgTimer = null
    }
    await kb.setPreference('pref.work_background', workBackgroundDraft.value)
    preferences.value = {
      ...preferences.value,
      'pref.work_background': workBackgroundDraft.value
    }
  }

  /* ---------------- 工作过程事件 ---------------- */

  /**
   * 记一条工作事件（useFlowStore 结构性动作 / useAiAssist.settle 调用）。
   * **仅「本地记忆与技能」开关打开才记**；开关关闭时静默跳过。
   * 浏览器态 idbLogEvent 是 no-op，签名对齐无需调用方分辨环境。
   */
  async function logWorkEvent(kind: string, refId: string | null, summary: string): Promise<void> {
    if (!localMemory.value) return
    try {
      await kb.logEvent(kind, refId, summary)
    } catch {
      /* 事件是附属品：失败静默 */
    }
  }

  /* ---------------- 整理（启动防抖 + 手动） ---------------- */

  let bootCurateTimer: ReturnType<typeof setTimeout> | null = null
  let bootCurateDone = false

  function scheduleBootCurate(): void {
    if (bootCurateDone || bootCurateTimer) return
    bootCurateTimer = setTimeout(() => {
      bootCurateTimer = null
      bootCurateDone = true
      // UI 明说「启动时防抖整理 + 手动一键整理」：这里就是启动那一次，
      // 没有虚构的定时任务；没有记忆可整时连整理都不跑。
      if (!memories.value.length) return
      void curate().catch(() => undefined)
    }, BOOT_CURATE_DELAY)
  }

  async function curate(): Promise<CurateReport> {
    const report = await kb.curate()
    memories.value = await kb.listMemories().catch(() => memories.value)
    return report
  }

  /* ---------------- 全量导入导出 ---------------- */

  async function exportAllAction(): Promise<string> {
    return kb.exportAll()
  }

  async function importAllAction(json: string): Promise<void> {
    await kb.importAll(json)
    await refresh()
  }

  return {
    // 面板
    panelOpen,
    panelSection,
    openPanel,
    closePanel,
    // 数据
    entries,
    docs,
    memories,
    events,
    preferences,
    nodeLinks,
    loading,
    error,
    // 偏好
    chatMemory,
    localMemory,
    workBackground,
    workBackgroundDraft,
    setChatMemory,
    setLocalMemory,
    setWorkBackgroundDraft,
    saveWorkBackground,
    // 读取
    refresh,
    refreshNodeLinks,
    // 条目
    createEntryAction,
    updateEntryAction,
    removeEntryAction,
    searchAction,
    // 关联
    linkEntryAction,
    unlinkEntryAction,
    linkDocAction,
    unlinkDocAction,
    // 文档
    createDocAction,
    updateDocAction,
    removeDocAction,
    // 锚点
    createAnchorAction,
    updateAnchorAction,
    removeAnchorAction,
    // 记忆
    createMemoryAction,
    updateMemoryAction,
    removeMemoryAction,
    resetMemoriesAction,
    exportMemoriesAction,
    importMemoriesAction,
    // 事件 / 整理
    logWorkEvent,
    curate,
    // 全量
    exportAllAction,
    importAllAction
  }
})
