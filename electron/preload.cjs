/**
 * NovelFlow Studio · Electron 预加载脚本
 *
 * 通过 contextBridge 向渲染进程暴露最小安全面：
 *  - 更新相关：检查 / 下载 / 安装 / 状态订阅 / 当前版本
 *  - 密钥相关：读写 grsai 密钥（存 userData/config.json，不进 git、不进 exe）
 *  - AI 相关：模型增删改查 / 测连 / 对话（含流式与取消）/ 生图；
 *    密钥与真实端点都留在主进程，这里只透传方法调用。
 *  - 知识库相关：条目 / 节点关联 / 文档 / 锚点 / 记忆 / 偏好 / 事件 /
 *    全量导入导出（userData/novelflow.db，sql.js）；只透传方法调用，
 *    不暴露 db 路径、export() 原始字节与任意 SQL。
 *  - 语义检索相关：语义检索 / 索引状态 / 重建索引（向量在**独立**的
 *    userData/novelflow-vectors.db；embedding 只走本机服务，密钥与原始响应
 *    同样不出主进程）。
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

  /* ---- 知识库 / 文档 / 记忆（userData/novelflow.db，sql.js）---- */
  kb: {
    /** 知识条目 */
    listEntries: () => ipcRenderer.invoke('kb:list-entries'),
    createEntry: (input) => ipcRenderer.invoke('kb:create-entry', input),
    updateEntry: (id, patch) => ipcRenderer.invoke('kb:update-entry', { id, patch }),
    removeEntry: (id) => ipcRenderer.invoke('kb:remove-entry', { id }),
    searchEntries: (query) => ipcRenderer.invoke('kb:search-entries', { query }),
    /** 节点关联：按 nodeId 反查 / 挂载 / 解绑（事实源在 db，节点上不存镜像字段） */
    listLinksForNode: (nodeId) => ipcRenderer.invoke('kb:list-node-links', { nodeId }),
    linkEntry: (entryId, nodeId) => ipcRenderer.invoke('kb:link-entry', { entryId, nodeId }),
    unlinkEntry: (entryId, nodeId) => ipcRenderer.invoke('kb:unlink-entry', { entryId, nodeId }),
    linkDoc: (docId, nodeId) => ipcRenderer.invoke('kb:link-doc', { docId, nodeId }),
    unlinkDoc: (docId, nodeId) => ipcRenderer.invoke('kb:unlink-doc', { docId, nodeId }),
    /** 文档（列表不带 content，内容走 getDoc） */
    listDocs: () => ipcRenderer.invoke('kb:list-docs'),
    getDoc: (id) => ipcRenderer.invoke('kb:get-doc', { id }),
    createDoc: (input) => ipcRenderer.invoke('kb:create-doc', input),
    updateDoc: (id, patch) => ipcRenderer.invoke('kb:update-doc', { id, patch }),
    removeDoc: (id) => ipcRenderer.invoke('kb:remove-doc', { id }),
    /** 文档选择与读取（两段式：dialog 只回路径，内容单独读并校验后缀 / 大小） */
    pickDoc: () => ipcRenderer.invoke('kb:pick-doc'),
    readDoc: (path) => ipcRenderer.invoke('kb:read-doc', { path }),
    /** 文档锚点 */
    listAnchors: (filter) => ipcRenderer.invoke('kb:list-anchors', filter),
    createAnchor: (input) => ipcRenderer.invoke('kb:create-anchor', input),
    updateAnchor: (id, patch) => ipcRenderer.invoke('kb:update-anchor', { id, patch }),
    removeAnchor: (id) => ipcRenderer.invoke('kb:remove-anchor', { id }),
    /** 作者记忆 */
    listMemories: () => ipcRenderer.invoke('kb:list-memories'),
    createMemory: (input) => ipcRenderer.invoke('kb:create-memory', input),
    updateMemory: (id, patch) => ipcRenderer.invoke('kb:update-memory', { id, patch }),
    removeMemory: (id) => ipcRenderer.invoke('kb:remove-memory', { id }),
    resetMemories: () => ipcRenderer.invoke('kb:reset-memories'),
    exportMemories: () => ipcRenderer.invoke('kb:export-memories'),
    importMemories: (json) => ipcRenderer.invoke('kb:import-memories', { json }),
    /** 偏好（两个记忆开关 + 工作背景） */
    getPreferences: () => ipcRenderer.invoke('kb:get-preferences'),
    setPreference: (key, value) => ipcRenderer.invoke('kb:set-preference', { key, value }),
    /** 工作过程事件 */
    listEvents: (limit) => ipcRenderer.invoke('kb:list-events', { limit }),
    logEvent: (kind, refId, summary) => ipcRenderer.invoke('kb:log-event', { kind, refId, summary }),
    curate: () => ipcRenderer.invoke('kb:curate'),
    /** 全量导入导出（JSON 备份） */
    exportAll: () => ipcRenderer.invoke('kb:export-all'),
    importAll: (json) => ipcRenderer.invoke('kb:import-all', { json }),
    /** 语义检索（向量索引；无本地 embedding 时主进程明说降级为关键词结果） */
    semanticSearch: (query, opts) => ipcRenderer.invoke('kb:semantic-search', { query, ...(opts ?? {}) }),
    /** 语义索引状态：块数 / 模型 / 维度 / 最近重建时间 / 本地 embedding 是否就绪 */
    indexStatus: () => ipcRenderer.invoke('kb:index-status'),
    /** 触发后台重建索引（立即返回 {ok, started}，进度查 indexStatus） */
    rebuildIndex: (opts) => ipcRenderer.invoke('kb:rebuild-index', opts ?? {})
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
