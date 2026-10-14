import type {
  AiApi,
  AiChunk,
  AiModelsPayload,
  ChatRequest,
  ChatResult,
  ImageRequest,
  ImageResult,
  ModelConfig,
  SetActivePayload,
  TestResult
} from '@/types/ai'
import { normalizeChatResponse, normalizeImageResponse } from '@/core/aiPrompt'

/**
 * AI 能力在渲染层的**唯一出口**。
 *
 * 组件禁止直接 fetch 第三方端点：请求一律由主进程代发（密钥不出主进程），
 * 这里只做 IPC 封装 + 降级提示 + 流式事件的分发。
 * 参考 `AppHeader.vue:13` 的桌面端判定：`window.electronAPI` 不存在即为浏览器开发态。
 *
 * 跨进程契约与 IPC 通道定义见 `.agent-runs/…/brief-implementer.md` A2 节。
 */

export const AI_DESKTOP_ONLY = 'AI 能力仅在桌面端可用（浏览器开发模式不支持）'

/** 浏览器开发态下所有 AI 入口都要能被识别并给出提示，故只判读一次 */
export function hasAiBridge(): boolean {
  if (typeof window === 'undefined') return false
  return !!(window as unknown as { electronAPI?: { ai?: AiBridge } }).electronAPI?.ai
}

/**
 * preload 注入的 `window.electronAPI.ai`（形状见 `src/types/ai.ts` 的 `AiApi`）。
 * 这里刻意用 `unknown` 再断言：既不依赖 `declare global` 是否生效，
 * 也不新增第二份全仓 `window.electronAPI` 全局声明（避免与 types/ai.ts 打架）。
 */
type AiBridge = AiApi

function bridge(): AiBridge {
  const api = (window as unknown as { electronAPI?: { ai?: AiBridge } }).electronAPI?.ai
  if (!api) throw new Error(AI_DESKTOP_ONLY)
  return api
}

/* ---------------- 模型管理 ---------------- */

export async function listModels(): Promise<AiModelsPayload> {
  const payload = await bridge().listModels()
  return {
    models: Array.isArray(payload?.models) ? payload.models : [],
    activeIds: {
      llm: payload?.activeIds?.llm ?? null,
      image: payload?.activeIds?.image ?? null
    }
  }
}

export async function saveModel(config: ModelConfig): Promise<void> {
  const result = await bridge().saveModel(config)
  if (result && result.ok === false) throw new Error(result.error || '保存模型失败')
}

export async function removeModel(id: string): Promise<void> {
  const result = await bridge().removeModel(id)
  if (result && result.ok === false) throw new Error(result.error || '删除模型失败')
}

export async function setActive(ids: SetActivePayload): Promise<void> {
  const result = await bridge().setActive(ids)
  if (result && result.ok === false) throw new Error(result.error || '切换模型失败')
}

export async function testModel(config: ModelConfig): Promise<TestResult> {
  try {
    return await bridge().testModel(config)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/* ---------------- 文本对话 ---------------- */

export async function chat(payload: ChatRequest): Promise<ChatResult> {
  const result = await bridge().chat(payload)
  // 兜底归一化：主进程已保证返回 {ok,text,usage,error}，万一某条路径漏网带回
  // 原始 OpenAI 响应（含 choices），这里补一层标准化，调用方永远只见到统一形状
  if (result && typeof result === 'object' && 'choices' in result) {
    return normalizeChatResponse(result)
  }
  return result
}

export interface ChatStreamOptions {
  onChunk?: (delta: string) => void
  onDone?: () => void
  onError?: (message: string) => void
}

export interface ChatStreamHandle {
  requestId: string
  /** 中止生成：已收到的片段会保留在编辑器里 */
  cancel: () => void
}

/**
 * 流式对话。
 *
 * 主进程用 `ai:chunk` 事件增量推送 `{requestId, delta|done|error}`（范式同 `update:status`），
 * 这里按 requestId 过滤后回调给调用方，并返回一个可用于中止的句柄。
 */
export async function chatStream(
  payload: ChatRequest,
  options: ChatStreamOptions = {}
): Promise<ChatStreamHandle> {
  const api = bridge()
  const started = await api.chatStream(payload)
  if (!started?.ok || !started.requestId) {
    throw new Error(started?.error || '流式请求未能启动')
  }
  const requestId = started.requestId
  let settled = false
  let unsubscribe: (() => void) | undefined

  const finish = (fn?: () => void): void => {
    if (settled) return
    settled = true
    try {
      unsubscribe?.()
    } catch {
      /* preload 已经下线时无需处理 */
    }
    fn?.()
  }

  unsubscribe = api.onAiChunk((chunk: AiChunk) => {
    if (!chunk || chunk.requestId !== requestId) return
    if (chunk.error) {
      finish(() => options.onError?.(chunk.error as string))
      return
    }
    if (chunk.done) {
      finish(() => options.onDone?.())
      return
    }
    if (chunk.delta) options.onChunk?.(chunk.delta)
  })

  return {
    requestId,
    cancel: () => {
      // 先在本地结算再通知主进程，避免残余 chunk 继续往编辑器里写字
      finish()
      void api.cancelChat(requestId).catch(() => undefined)
    }
  }
}

/* ---------------- 生图 ---------------- */

export async function image(payload: ImageRequest): Promise<ImageResult> {
  const result = await bridge().image(payload)
  // 兜底归一化：主进程正常返回 {ok,urls}；若漏网带回原始 images 响应（含 data）则标准化
  if (result && typeof result === 'object' && 'data' in result) {
    return normalizeImageResponse(result)
  }
  return result
}
