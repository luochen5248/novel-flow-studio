/**
 * NovelFlow Studio · Electron 预加载脚本
 *
 * 通过 contextBridge 向渲染进程暴露最小安全面：
 *  - 更新相关：检查 / 下载 / 安装 / 状态订阅 / 当前版本
 *  - 密钥相关：读写 grsai 密钥（存 userData/config.json，不进 git、不进 exe）
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
  }
})
