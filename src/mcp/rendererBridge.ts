/**
 * MCP 渲染层调用桥
 *
 * 完整通路：外部 MCP 客户端 → exe(--mcp 桥接实例) → GUI 实例控制服务器 →
 * 本模块 → window.NovelFlow[method]（src/api/aiApi.ts，统一 {ok,data?,error}）。
 *
 * 设计纪律（与 aiApi 对齐）：
 *  - 永不把异常抛回 IPC：任何失败都归一成 {ok:false,error} 回传主进程；
 *  - 浏览器 / 非 Electron 环境静默跳过（window.electronAPI 不存在时）；
 *  - 模块 import 即安装，与 './api/aiApi' 的副作用导入风格一致。
 */

/** 主进程 → 渲染层的调用载荷（与 electron/main.cjs 的 mcp:invoke 一致） */
export interface McpInvokePayload {
  callId: string
  method: string
  params: unknown[]
}

/**
 * preload.cjs 注入的 mcp 桥。
 * 形状在本文件本地声明：不动 src/types/ai.ts 的既有 ElectronApi 契约
 * （与 aiClient.ts 的局部 cast 策略一致，避免双份全局声明打架）。
 */
interface McpBridge {
  onInvoke: (callback: (payload: McpInvokePayload) => void) => () => void
  reply: (callId: string, result: unknown) => void
}

function readBridge(): McpBridge | undefined {
  if (typeof window === 'undefined') return undefined
  const holder = window as unknown as { electronAPI?: { mcp?: McpBridge } }
  const bridge = holder.electronAPI?.mcp
  return bridge && typeof bridge.onInvoke === 'function' && typeof bridge.reply === 'function'
    ? bridge
    : undefined
}

async function handleInvoke(bridge: McpBridge, payload: McpInvokePayload): Promise<void> {
  const method = String(payload?.method ?? '')
  const args = Array.isArray(payload?.params) ? payload.params : []
  let result: unknown
  const api = window.NovelFlow as unknown as
    | Record<string, ((...a: unknown[]) => unknown) | undefined>
    | undefined
  if (!api) {
    // 与「方法不存在」区分开：渲染层没加载完（aiApi 未挂载）时重试有意义
    result = { ok: false, error: 'NovelFlow API 尚未就绪（渲染层可能未加载完成），请稍候重试' }
  } else if (typeof api[method] !== 'function') {
    result = { ok: false, error: `NovelFlow 没有方法「${method}」` }
  } else {
    try {
      // await：exportMarkdown 等可能异步；同步方法 await 直通也无副作用
      result = await api[method]!.apply(api, args)
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  try {
    bridge.reply(payload.callId, result)
  } catch {
    /* 桥接进程可能已断开：回复失败不影响渲染层 */
  }
}

export function installMcpBridge(): void {
  const bridge = readBridge()
  if (!bridge) return
  bridge.onInvoke((payload) => {
    void handleInvoke(bridge, payload)
  })
}

installMcpBridge()
