import { computed, ref } from 'vue'
import { chatStream, type ChatStreamHandle } from '@/api/aiClient'
import { useAiStore } from '@/stores/useAiStore'
import {
  applyInsertion,
  buildAssistPrompt,
  type AssistMode,
  type AssistNeighbors,
  type AssistNodeContext
} from '@/core/aiPrompt'

/**
 * 编辑器右键 AI 的**编排层**：一段请求从选区到落笔的完整生命周期。
 *
 * 关键取舍（已在机读 brief 里确认过）：AI 结果**直接写进光标处**，边流式边打字机式地长出来，
 * 不另起一个「预览 → 确认」弹窗；所以这里每次都从**基文本**重算整段值再还给宿主，
 * 而不是把 delta 往现有 textarea 上追加 ——
 * 这样「换落点（光标处 ⇄ 文末）」「重新生成」都只是换参数重算，不需要宿主维护撤销态。
 *
 * 宿主职责（StoryEditorDrawer / NodeInspector）：
 *   - onUpdate：把整段值写回本地文本态并同步光标（流式中不落库，避免逐 chunk 压历史）
 *   - onSettled：清防抖定时器 → 写 store → 恢复光标（仅此一次进历史）
 */

export type { AssistMode }

export type AssistAnchor = 'caret' | 'end'

export interface AiAssistRequest {
  mode: AssistMode
  /** 组装提示词用的节点上下文快照 */
  node: AssistNodeContext
  neighbors?: AssistNeighbors
  /** 本次写入的基文本（流未开始时的原文） */
  baseText: string
  /** 右键时的选区；空选区即光标位置 */
  selection: { start: number; end: number }
  /** 额外指令 */
  instruction?: string
  onUpdate: (value: string, caretPos: number) => void
  onSettled: (payload: { value: string; caretPos: number; cancelled: boolean }) => void
}

/** 不同任务的采样参数：资料要稳、续写要活、润色居中 */
const SAMPLING: Record<AssistMode, { temperature: number; maxTokens: number }> = {
  research: { temperature: 0.4, maxTokens: 1200 },
  continue: { temperature: 0.9, maxTokens: 1400 },
  polish: { temperature: 0.6, maxTokens: 1400 }
}

export function useAiAssist() {
  const store = useAiStore()

  const mode = ref<AssistMode>('continue')
  const anchor = ref<AssistAnchor>('caret')
  const webSearch = ref(false)
  const running = ref(false)
  const finished = ref(false)
  const error = ref('')
  const received = ref('')
  const elapsedMs = ref(0)

  let request: AiAssistRequest | null = null
  let handle: ChatStreamHandle | null = null
  /** IPC 握手还没回来时用户就点了 stopping —— 拿到句柄后立刻中止 */
  let cancelPending = false
  /** settle 幂等守卫：握手期取消 + 握手又失败会触发两次 settle，只认第一次 */
  let settled = false
  let tick: ReturnType<typeof setInterval> | undefined
  let startedAt = 0

  const charCount = computed(() => received.value.length)
  const elapsedText = computed(() =>
    elapsedMs.value < 1000 ? `${elapsedMs.value}ms` : `${(elapsedMs.value / 1000).toFixed(1)}s`
  )
  /** 「资源电力不足」的友好提示：没有可用文本模型时按钮该是灰的 */
  const ready = computed(() => store.available && store.llmReady)

  function stopTimer(): void {
    if (tick) {
      clearInterval(tick)
      tick = undefined
    }
  }

  /** 从基文本重算当前应写入的整段文本 */
  function compose(): { value: string; caretPos: number } {
    if (!request) return { value: '', caretPos: 0 }
    return applyInsertion(
      request.baseText,
      request.selection.start,
      request.selection.end,
      received.value,
      anchor.value === 'caret' ? 'replace' : 'append'
    )
  }

  function pushUpdate(): void {
    if (!request) return
    const snapshot = compose()
    request.onUpdate(snapshot.value, snapshot.caretPos)
  }

  function settle(cancelled: boolean): void {
    if (settled) return
    settled = true
    stopTimer()
    running.value = false
    finished.value = true
    const finishedId = handle?.requestId
    handle = null
    // 按 requestId 核对后再清：握手失败（finishedId 为空）时清的是占位，必须放行
    store.endStream(finishedId)
    if (request) {
      const snapshot = compose()
      request.onSettled({ value: snapshot.value, caretPos: snapshot.caretPos, cancelled })
    }
  }

  async function run(next: AiAssistRequest): Promise<void> {
    request = next
    mode.value = next.mode
    anchor.value = 'caret'
    received.value = ''
    finished.value = false
    error.value = ''
    elapsedMs.value = 0
    cancelPending = false
    settled = false

    if (store.streaming) {
      error.value = '还有一段 AI 正在写，请先等它写完或取消'
      return
    }
    if (!store.available) {
      error.value = 'AI 能力仅在桌面端可用'
      return
    }
    const model = store.activeLlm
    if (!model) {
      error.value = '请先在「模型管理」里添加一个文本模型'
      return
    }
    if (model.enabled === false) {
      error.value = `模型「${model.name}」已停用，请先在「模型管理」里启用`
      return
    }

    // 联网增强：默认跟随模型的 webSearch 开关
    const useSearch = next.mode === 'research' && (webSearch.value || model.webSearch === true)
    const messages = buildAssistPrompt(next.node, {
      mode: next.mode,
      selection: next.baseText.slice(next.selection.start, next.selection.end),
      neighbors: next.neighbors,
      webSearch: useSearch,
      instruction: next.instruction
    })

    running.value = true
    // 握手前先占位：IPC 往返窗口内 ai.streaming 已为 true，另一个编辑器开不了第二路（M1）
    store.beginStream('')
    startedAt = Date.now()
    tick = setInterval(() => {
      elapsedMs.value = Date.now() - startedAt
    }, 100)

    try {
      const sampling = SAMPLING[next.mode]
      const started = await chatStream(
        {
          modelId: model.id,
          messages,
          temperature: sampling.temperature,
          maxTokens: sampling.maxTokens
        },
        {
          onChunk: (delta) => {
            received.value += delta
            pushUpdate()
          },
          onDone: () => settle(false),
          onError: (message) => {
            error.value = message
            settle(true)
          }
        }
      )
      handle = started
      if (cancelPending) {
        // 握手期间用户已经按了停止：立刻中止，不必再登记「正在流式」
        started.cancel()
        return
      }
      store.beginStream(started.requestId)
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      settle(true)
    }
  }

  /** 取消生成：已经写进编辑器的片段保留（用户中途叫停也算草稿） */
  function cancel(): void {
    if (!running.value) return
    cancelPending = true
    handle?.cancel()
    handle = null
    stopTimer()
    elapsedMs.value = startedAt ? Date.now() - startedAt : 0
    settle(true)
  }

  /** 换落点（光标处 ⇄ 文末）；流式过程中立即生效，结束后会再落一次库 */
  function setAnchor(next: AssistAnchor): void {
    if (anchor.value === next) return
    anchor.value = next
    pushUpdate()
    if (finished.value) settle(false)
  }

  /** 重新生成：清掉已写内容后原样再跑一次提示词 */
  function regenerate(): void {
    if (!request || running.value) return
    const again: AiAssistRequest = { ...request }
    received.value = ''
    finished.value = false
    error.value = ''
    void run(again)
  }

  function reset(): void {
    cancel()
    stopTimer()
    request = null
    handle = null
    received.value = ''
    finished.value = false
    error.value = ''
    elapsedMs.value = 0
    anchor.value = 'caret'
    webSearch.value = false
    settled = false
  }

  async function copy(): Promise<boolean> {
    if (!received.value) return false
    try {
      await navigator.clipboard.writeText(received.value)
      return true
    } catch {
      return false
    }
  }

  return {
    mode,
    anchor,
    webSearch,
    running,
    finished,
    error,
    received,
    elapsedMs,
    elapsedText,
    charCount,
    ready,
    run,
    cancel,
    setAnchor,
    regenerate,
    reset,
    copy
  }
}
