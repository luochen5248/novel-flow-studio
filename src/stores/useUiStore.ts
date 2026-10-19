import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useFlowStore } from './useFlowStore'

export type ThemeMode = 'dark' | 'light'
export type CanvasMode = 'light' | 'dark'

/** 外壳 / 画布 / 交互偏好 —— 与图数据解耦，便于单独持久化 */
export const useUiStore = defineStore('ui', () => {
  const flow = useFlowStore()

  const shellTheme = ref<ThemeMode>((flow.workspace.ui.theme as ThemeMode) ?? 'dark')
  const canvasMode = ref<CanvasMode>('light')
  const sidebarCollapsed = ref<boolean>(!!flow.workspace.ui.sidebarCollapsed)
  const showMinimap = ref<boolean>(flow.workspace.ui.showMinimap !== false)
  const snapEnabled = ref<boolean>(flow.workspace.ui.snapEnabled !== false)
  const locked = ref(false)
  const search = ref('')
  const inspectorOpen = ref(false)
  const storyEditorId = ref<string | null>(null)
  const devConsoleOpen = ref(false)
  const connecting = ref<{ source: string; x: number; y: number } | null>(null)
  /** 当前选中的连线 id（快捷键删边 / Esc 清选中都要读它，故放 store 而非组件本地态） */
  const selectedEdgeId = ref<string | null>(null)
  /**
   * 控制中心外部打开意图：外部入口（NodeInspector 的「一致性」格）想直接跳到
   * 控制中心某个面板时先写这里，由 ControlCenter 的 watch 负责消费。
   * null = 无意图。刻意不复用弹窗内的 activeKey：意图可能早于弹窗打开产生，
   * 需要独立信箱缓存，否则「没开弹窗时点的跳转」会丢。
   * 联合类型随 ControlCenter 的专属面板分支扩展。
   */
  const controlCenterPanel = ref<'memory' | 'consistency' | null>(null)

  const canvasTheme = computed<CanvasMode>(() => {
    const mode = flow.activeGraph?.settings.canvasMode
    return mode === 'dark' || mode === 'light' ? mode : canvasMode.value
  })

  watch(canvasTheme, (v) => {
    canvasMode.value = v
  })

  watch(
    [shellTheme, sidebarCollapsed, showMinimap, snapEnabled],
    () => {
      flow.workspace.ui.theme = shellTheme.value
      flow.workspace.ui.sidebarCollapsed = sidebarCollapsed.value
      flow.workspace.ui.showMinimap = showMinimap.value
      flow.workspace.ui.snapEnabled = snapEnabled.value
    },
    { immediate: true }
  )

  function toggleTheme(): void {
    shellTheme.value = shellTheme.value === 'dark' ? 'light' : 'dark'
  }

  function setCanvasMode(mode: CanvasMode): void {
    canvasMode.value = mode
    flow.setSettings({ canvasMode: mode })
  }

  function toggleCanvasMode(): void {
    setCanvasMode(canvasTheme.value === 'dark' ? 'light' : 'dark')
  }

  function toggleSidebar(): void {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  function toggleMinimap(): void {
    showMinimap.value = !showMinimap.value
  }

  function toggleSnap(): void {
    snapEnabled.value = !snapEnabled.value
  }

  function toggleLock(): void {
    locked.value = !locked.value
  }

  function openStoryEditor(id: string): void {
    storyEditorId.value = id
  }

  function closeStoryEditor(): void {
    storyEditorId.value = null
  }

  function toggleDevConsole(): void {
    devConsoleOpen.value = !devConsoleOpen.value
  }

  /** 抽屉自身关闭（点 X / 遮罩 / Esc）时复位，避免顶栏按钮激活态残留 */
  function closeDevConsole(): void {
    devConsoleOpen.value = false
  }

  function selectEdge(id: string): void {
    selectedEdgeId.value = id
  }

  /** 清掉连线选中态（点背景 / 切图 / Esc；边被删时由 flow store 调） */
  function clearEdgeSelection(): void {
    selectedEdgeId.value = null
  }

  /** 外部跳转控制中心，可指定落在哪个面板（缺省 = 默认第一项） */
  function openControlCenter(panel?: 'memory' | 'consistency'): void {
    controlCenterPanel.value = panel ?? null
  }

  function notify(message: string): void {
    flow.lastMessage = message
  }

  return {
    shellTheme,
    canvasMode,
    canvasTheme,
    sidebarCollapsed,
    showMinimap,
    snapEnabled,
    locked,
    search,
    inspectorOpen,
    storyEditorId,
    devConsoleOpen,
    connecting,
    selectedEdgeId,
    controlCenterPanel,
    toggleTheme,
    setCanvasMode,
    toggleCanvasMode,
    toggleSidebar,
    toggleMinimap,
    toggleSnap,
    toggleLock,
    openStoryEditor,
    closeStoryEditor,
    toggleDevConsole,
    closeDevConsole,
    selectEdge,
    clearEdgeSelection,
    openControlCenter,
    notify
  }
})
