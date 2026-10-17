/**
 * NovelFlow Studio · Electron 预加载脚本
 *
 * 通过 contextBridge 向渲染进程暴露最小安全面：
 *  - 更新相关：检查 / 下载 / 安装 / 状态订阅 / 当前版本
 *  - 密钥相关：读写 grsai 密钥（存 userData/config.json，不进 git、不进 exe）
 *  - AI 相关：模型增删改查 / 测连 / 对话（含流式与取消）/ 生图；
 *    密钥与真实端点都留在主进程，这里只透传方法调用。
 * 其余 Node 能力一律不暴露。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  /** 是否运行在 Electron 桌面环境（浏览器里为 undefined，前端据此降级） */
  isDesktop: true,

  /* ---- 应用信息 ---- */
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  getPlatform: () => ipcRenderer.invoke('app:get-platform'),

  /* ---- grsai 密钥（存本地 userData，永不上传） ---- */
  getGrsaiKey: () => ipcRenderer.invoke('app:get-grsai-key'),
  setGrsaiKey: (key) => ipcRenderer.invoke('app:set-grsai-key', key),

  /* ---- 自动更新 ---- */
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  /** 订阅更新状态推送：{ phase, info?, error?, percent? } */
  onUpdateStatus: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('update:status', listener)
    return () => ipcRenderer.removeListener('update:status', listener)
  },

  /* ---- AI 模型（密钥全程留在主进程，渲染层只拿到脱敏视图） ---- */
  ai: {
    /** 脱敏模型列表 + 当前激活项 */
    listModels: () => ipcRenderer.invoke('ai:list-models'),
    saveModel: (cfg) => ipcRenderer.invoke('ai:save-model', cfg),
    removeModel: (id) => ipcRenderer.invoke('ai:remove-model', id),
    setActive: (patch) => ipcRenderer.invoke('ai:set-active', patch),
    /** 主进程代发最小请求；返回里不含任何密钥信息 */
    testModel: (cfg) => ipcRenderer.invoke('ai:test-model', cfg),
    chat: (req) => ipcRenderer.invoke('ai:chat', req),
    /** 立即拿到 requestId，正文走 onAiChunk 增量推送 */
    chatStream: (req) => ipcRenderer.invoke('ai:chat-stream', req),
    cancelChat: (requestId) => ipcRenderer.invoke('ai:cancel-chat', requestId),
    image: (req) => ipcRenderer.invoke('ai:image', req),
    /** 订阅流式增量：{ requestId, delta?, done?, error? }；返回取消订阅函数 */
    onAiChunk: (callback) => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('ai:chunk', listener)
      return () => ipcRenderer.removeListener('ai:chunk', listener)
    }
  },

  /* ---- MCP 调用桥：主进程控制服务器 ↔ 渲染层 window.NovelFlow ---- */
  mcp: {
    /** 订阅调用载荷 { callId, method, params }；返回取消订阅函数 */
    onInvoke: (callback) => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('mcp:invoke', listener)
      return () => ipcRenderer.removeListener('mcp:invoke', listener)
    },
    /** 回传执行结果（形状与 NovelFlow 的 { ok, data?, error? } 一致） */
    reply: (callId, result) => ipcRenderer.send('mcp:result', { callId, result })
  }
})
