import { onBeforeUnmount, onMounted } from 'vue'
import { message } from 'ant-design-vue'
import { useFlowStore } from '@/stores/useFlowStore'
import { useUiStore } from '@/stores/useUiStore'

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable
}

export interface ShortcutHooks {
  fitView(): void
  resetZoom(): void
}

/**
 * 全局快捷键。
 * Enter 下方插入 / Tab 插入子分支 / Delete 删除 / Ctrl+D 复制 /
 * Ctrl+Z·Ctrl+Y 撤销重做 / Ctrl+0 适应画布 / Ctrl+S 导出 JSON（交给 Max-B 的 window.NovelFlow）
 */
export function useShortcuts(hooks: ShortcutHooks): void {
  const store = useFlowStore()
  const ui = useUiStore()

  async function exportJson(): Promise<void> {
    // 导出实现由 Max-B 提供（window.NovelFlow.exportJSON / download）
    const api = window.NovelFlow
    if (!api || typeof api.exportJSON !== 'function') {
      message.info('导出模块尚未就绪，稍后再试')
      return
    }
    const res = await api.exportJSON()
    if (!res?.ok) {
      message.warning(String(res?.error ?? '导出失败'))
      return
    }
    const text = typeof res.data === 'string' ? res.data : ''
    if (!text) {
      message.warning('导出内容为空')
      return
    }
    try {
      const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${store.activeGraph?.name ?? 'novelflow'}.json`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      message.success('已导出 JSON')
    } catch {
      message.warning('导出失败')
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (isTyping(e.target)) return
    const mod = e.ctrlKey || e.metaKey
    const key = e.key

    if (mod && key.toLowerCase() === 's') {
      e.preventDefault()
      void exportJson()
      return
    }
    if (mod && key === '0') {
      e.preventDefault()
      hooks.fitView()
      return
    }
    if (mod && key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault()
      store.undo()
      return
    }
    if (mod && (key.toLowerCase() === 'y' || (key.toLowerCase() === 'z' && e.shiftKey))) {
      e.preventDefault()
      store.redo()
      return
    }
    if (mod && key.toLowerCase() === 'd') {
      e.preventDefault()
      const id = store.selectedIds[0]
      if (id) store.duplicateNode(id)
      return
    }
    if (mod && key.toLowerCase() === 'a') {
      e.preventDefault()
      store.select(store.nodes.map((n) => n.id))
      return
    }

    if (ui.locked) return

    if (key === 'Enter') {
      const id = store.selectedIds[0]
      if (!id) return
      e.preventDefault()
      store.insertNodeAfter(id)
      return
    }
    if (key === 'Tab') {
      const id = store.selectedIds[0]
      if (!id) return
      e.preventDefault()
      store.insertBranch(id)
      return
    }
    if (key === 'Delete' || key === 'Backspace') {
      // D5：边选中非空删边，节点选中非空删节点，两者都选中则两类都删。
      // isTyping（:59 整个 handler 的守卫）与 ui.locked（:95）双重守卫天然覆盖本分支。
      const ids = [...store.selectedIds]
      const edgeId = ui.selectedEdgeId
      if (!ids.length && !edgeId) return
      e.preventDefault()
      store.commit('删除所选')
      for (const id of ids) store.removeNode(id, { silent: true })
      if (edgeId) {
        store.removeEdge(edgeId, { silent: true })
        ui.clearEdgeSelection()
      }
      return
    }
    if (key === 'Escape') {
      store.clearSelection()
      // G7：与画布点背景清空边选中的行为对齐，Esc 同时清边选中
      ui.clearEdgeSelection()
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', onKeyDown)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeyDown)
  })
}
