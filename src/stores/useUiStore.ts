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
    notify
  }
})
