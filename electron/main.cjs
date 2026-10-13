/**
 * NovelFlow Studio · Electron 主进程
 *
 * 职责：
 *  1. 桌面窗口：加载 Vite 构建产物（dist/index.html）；开发模式可加载 dev server。
 *  2. grsai 代理接管：打包后没有 Vite dev server，主进程用 webRequest 把
 *     渲染层发出的 `/api/grsai/*` 重定向到真实 API 并注入 Authorization。
 *     密钥只存本地（userData/config.json，或开发态回落 .env.local），不进 git、不进 exe。
 *  3. 自动更新：electron-updater + GitHub Releases；用户点击「检查更新」→
 *     询问是否下载 → 下载完提示「立即安装重启」→ NSIS 静默替换升级。
 *
 * 约定：本文件为 CommonJS（.cjs），与 package.json 的 "type": "module" 隔离，避免 ESM 坑。
 */
const { app, BrowserWindow, Menu, ipcMain, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

/** grsai 真实 API 地址（与 vite.config.ts 的代理 target 保持同源） */
const GRSAI_TARGET = 'https://grsai.dakka.com.cn'
/** 渲染层使用的前缀（与 src/api/aiImage.ts 的 GRSAI_BASE 一致） */
const GRSAI_PREFIX = '/api/grsai'

/* ------------------------------------------------------------------ */
/* 单实例锁：避免更新安装 / 重复启动时出现多窗口                                        */
/* ------------------------------------------------------------------ */
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

/* ------------------------------------------------------------------ */
/* grsai 密钥：userData/config.json 优先，开发态回落 .env.local                        */
/* ------------------------------------------------------------------ */

/** 缓存：避免每个请求都读盘 */
let grsaiKeyCache = undefined

function configPath() {
  return path.join(app.getPath('userData'), 'config.json')
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf-8'))
  } catch {
    return {}
  }
}

function resolveGrsaiKey() {
  if (grsaiKeyCache !== undefined) return grsaiKeyCache
  const fromConfig = readConfig().grsaiKey
  if (fromConfig) {
    grsaiKeyCache = fromConfig
    return fromConfig
  }
  // 开发态回落：项目根的 .env.local（与 vite 代理同一份密钥，不会进 git）
  if (!app.isPackaged) {
    try {
      const envLocal = fs.readFileSync(path.join(app.getAppPath(), '.env.local'), 'utf-8')
      const match = envLocal.match(/^\s*GRSAI_API_KEY\s*=\s*"?([^"\r\n]+)"?\s*$/m)
      if (match?.[1]) {
        grsaiKeyCache = match[1].trim()
        return grsaiKeyCache
      }
    } catch {
      /* 没有密钥就让请求裸发，grsai 会返回 401，界面可提示 */
    }
  }
  grsaiKeyCache = ''
  return ''
}

function writeGrsaiKey(key) {
  const config = { ...readConfig(), grsaiKey: key }
  fs.mkdirSync(path.dirname(configPath()), { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf-8')
  grsaiKeyCache = key
}

/* ------------------------------------------------------------------ */
/* grsai 代理：file:// 下的 /api/grsai/* → 真实 API + 注入密钥 + 补 CORS               */
/* ------------------------------------------------------------------ */

function setupGrsaiProxy() {
  const ses = session.defaultSession

  // 1) 重定向：file:///api/grsai/xxx → https://grsai.dakka.com.cn/xxx
  //    （生产模式 loadFile 是 file:// 协议，根相对路径 fetch 会落到 file:///api/grsai/...）
  //    用 JS 过滤而不是 match-pattern：file 协议的通配 host 不可靠，逐条判断最稳。
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (!details.url.startsWith('file://')) {
      callback({})
      return
    }
    const index = details.url.indexOf(GRSAI_PREFIX)
    if (index < 0) {
      callback({})
      return
    }
    const rest = details.url.slice(index + GRSAI_PREFIX.length)
    callback({ redirectURL: `${GRSAI_TARGET}${rest}` })
  })

  // 2) 注入密钥 + 抹掉 file:// 的 Origin（避免服务端风控/校验）
  //    OPTIONS 预检不注入：部分服务端对带 Authorization 的预检会直接拒答，导致预检失败
  ses.webRequest.onBeforeSendHeaders(
    { urls: [`${GRSAI_TARGET}/*`] },
    (details, callback) => {
      const headers = { ...details.requestHeaders }
      const key = resolveGrsaiKey()
      if (key && details.method !== 'OPTIONS') headers['Authorization'] = `Bearer ${key}`
      delete headers['Origin']
      delete headers['Referer']
      callback({ requestHeaders: headers })
    }
  )

  // 3) 补 CORS 头：file:// 页面的跨源 fetch 需要显式放行（含 OPTIONS 预检）
  ses.webRequest.onHeadersReceived(
    { urls: [`${GRSAI_TARGET}/*`] },
    (details, callback) => {
      const headers = { ...details.responseHeaders }
      headers['Access-Control-Allow-Origin'] = ['*']
      headers['Access-Control-Allow-Headers'] = ['Content-Type, Authorization']
      headers['Access-Control-Allow-Methods'] = ['GET, POST, OPTIONS']
      callback({ responseHeaders: headers })
    }
  )
}

/* ------------------------------------------------------------------ */
/* 自动更新：electron-updater + GitHub Releases                                        */
/* ------------------------------------------------------------------ */

function pushUpdateStatus(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('update:status', payload)
  }
}

function setupAutoUpdater() {
  // 开发态不初始化：electron-updater 在未打包环境必然报错
  if (!app.isPackaged) return

  const { autoUpdater } = require('electron-updater')
  autoUpdater.autoDownload = false // 用户在界面确认后才下载
  autoUpdater.autoInstallOnAppQuit = true // 下载完即使直接关软件，退出时也会装上
  autoUpdater.logger = console

  autoUpdater.on('checking-for-update', () => pushUpdateStatus({ phase: 'checking' }))
  autoUpdater.on('update-available', (info) => pushUpdateStatus({ phase: 'available', info }))
  autoUpdater.on('update-not-available', (info) =>
    pushUpdateStatus({ phase: 'not-available', info })
  )
  autoUpdater.on('download-progress', (progress) =>
    pushUpdateStatus({
      phase: 'downloading',
      percent: progress.percent,
      info: { bytesPerSecond: progress.bytesPerSecond }
    })
  )
  autoUpdater.on('update-downloaded', (info) => pushUpdateStatus({ phase: 'downloaded', info }))
  autoUpdater.on('error', (error) =>
    pushUpdateStatus({ phase: 'error', error: error?.message ?? String(error) })
  )

  ipcMain.handle('update:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates()
      return { ok: true, version: result?.updateInfo?.version ?? '' }
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) }
    }
  })
  ipcMain.handle('update:download', async () => {
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) }
    }
  })
  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall(false, true) // 不静默跑安装器，静默替换
  })
}

/* ------------------------------------------------------------------ */
/* 窗口与生命周期                                                       */
/* ------------------------------------------------------------------ */

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 640,
    title: '小说时间线工坊 · NovelFlow Studio',
    backgroundColor: '#0F1720',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  // 去掉英文默认菜单（File/Edit/View...），保持全中文观感
  Menu.setApplicationMenu(null)

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 开发模式：npm run dev:electron（主进程带 --dev 参数）→ 加载 dev server
  const isDev = process.argv.includes('--dev')
  if (isDev && !app.isPackaged) {
    mainWindow.loadURL('http://127.0.0.1:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

/* ------------------------------------------------------------------ */
/* IPC：应用信息 + 密钥读写                                             */
/* ------------------------------------------------------------------ */

ipcMain.handle('app:get-version', () => app.getVersion())
ipcMain.handle('app:get-platform', () => process.platform)
ipcMain.handle('app:get-grsai-key', () => resolveGrsaiKey())
ipcMain.handle('app:set-grsai-key', (_event, key) => {
  writeGrsaiKey(String(key ?? '').trim())
  return { ok: true }
})

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(() => {
  setupGrsaiProxy()
  setupAutoUpdater()
  createWindow()

  app.on('activate', () => {
    // macOS 关窗后点 dock 图标重建窗口
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
