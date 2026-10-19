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
 *  4. AI 模型管理：用户自定义 OpenAI 兼容端点 / 密钥存 userData/config.json，
 *     由主进程用原生 fetch 代发（含流式与取消），**密钥永不出主进程**；
 *     内置 grsai 生图纳入统一管理（复用旧 grsaiKey 字段，老 webRequest 链路保留不动）。
 *  5. 语义索引（task-001）：embedding 只走本机 Ollama / LM Studio，向量存独立的
 *     userData/novelflow-vectors.db；无本地服务时明说降级到关键词检索。
 *
 * 约定：本文件为 CommonJS（.cjs），与 package.json 的 "type": "module" 隔离，避免 ESM 坑。
 */
const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, session, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
// worker_threads：.docx 解析挪出主进程用（Node 内置，零新增依赖；见 extractDocxTextViaWorker）
const { Worker } = require('node:worker_threads')

// 知识库数据库（sql.js）与 .docx 纯文本抽取：只被 GUI 实例使用
// （initKbStore 内部对 MCP_MODE 有注释性守卫；store.cjs 顶层不碰 sql.js，
//  真正 require('sql.js') 发生在 initKbStore 里，桥接实例零成本）
const kbStore = require('./kb/store.cjs')
// 语义索引向量库：独立 db 文件（userData/novelflow-vectors.db），见文件头
const vecStore = require('./kb/vecstore.cjs')
const { extractDocxText } = require('./kb/docx.cjs')

/** grsai 真实 API 地址（与 vite.config.ts 的代理 target 保持同源） */
const GRSAI_TARGET = 'https://grsai.dakka.com.cn'
/** 渲染层使用的前缀（与 src/api/aiImage.ts 的 GRSAI_BASE 一致） */
const GRSAI_PREFIX = '/api/grsai'

/* ------------------------------------------------------------------ */
/* 启动模式：无窗口 MCP 桥接实例（必须在单例锁之前判断）                                */
/* 判定入口二选一：                                                                */
/*   ① process.env.NOVELFLOW_MCP === '1' —— 打包态唯一可用方式。                           */
/*      Electron 44 起 Windows exe 的 CLI 解析为 Node 风格，未知 -- 长参数直接               */
/*      「bad option」+ exit 9（实验实证：electron=44.7.0/node=24.21.0，--mcp/--dev 均被    */
/*      二进制层拒绝，进程到不了 main.cjs）。MCP 客户端（如 WorkBuddy mcp.json 的 env 字段）  */
/*      只能走环境变量传令。                                                            */
/*   ② process.argv.includes('--mcp') —— 开发态兼容：npm run dev:electron 一类             */
/*      「electron main.cjs --mcp」中 --mcp 位于 script 参数位，Node CLI 原样透传。          */
/* ------------------------------------------------------------------ */
const MCP_MODE = process.argv.includes('--mcp') || process.env.NOVELFLOW_MCP === '1'

/**
 * 单例锁归属（GUI 实例专用；MCP 桥接实例不参与抢锁）。
 * 让位实例必须在 whenReady 里早退——详见该处注释（2026-10-17 实测 bug 修复）。
 */
let HAS_SINGLE_INSTANCE_LOCK = true

if (MCP_MODE) {
  // MCP 客户端每次连接都会 spawn 一个新进程：若照抢单例锁，GUI 已在运行时会
  // 把桥接实例自己挡退。桥接无窗口、不碰业务数据，与 GUI 实例必须能共存。
} else {
  HAS_SINGLE_INSTANCE_LOCK = app.requestSingleInstanceLock()
  if (!HAS_SINGLE_INSTANCE_LOCK) app.quit()
}

/* ------------------------------------------------------------------ */
/* grsai 密钥：userData/config.json 优先，开发态回落 .env.local                        */
/* ------------------------------------------------------------------ */

/** 缓存：避免每个请求都读盘（写入后由 writeConfig 置 undefined 失效） */
let grsaiKeyCache = undefined
/** 模型列表缓存：含 apiKey，**只活在主进程**；写入后由 writeConfig 置 null 失效 */
let aiModelsCache = null

function configPath() {
  return path.join(app.getPath('userData'), 'config.json')
}

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf-8'))
    // 坏 JSON / 非对象内容一律静默降级成 {}：一个坏字段不能让整个 AI 功能不可用
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

/** 写配置：合并式落盘，并让所有内存缓存失效。mode 0600：config.json 含 apiKey，只允许本用户读 */
function writeConfig(patch) {
  const config = { ...readConfig(), ...patch }
  fs.mkdirSync(path.dirname(configPath()), { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 })
  aiModelsCache = null
  return config
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
  writeConfig({ grsaiKey: key })
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
/* AI 模型管理：userData 配置 + 主进程代发（密钥永不出主进程）                    */
/* ------------------------------------------------------------------ */

/** 内置 grsai 生图模型的固定 id（builtin 不可删除） */
const BUILTIN_GRSAI_ID = 'builtin-grsai-nano-banana'

/** grsai 私有协议常量：照抄 src/api/aiImage.ts 的实测结论（不 import 渲染层模块） */
const GRSAI_MAX_CONCURRENT = 3 // 同账号并发上限，超过会被服务端判 failed
const GRSAI_POLL_INTERVAL = 3000
const GRSAI_POLL_TIMEOUT = 240_000
const GRSAI_MAX_RETRY = 5
const GRSAI_DEFAULT_MODEL = 'nano-banana-fast'

/** 网络兜底超时 */
const AI_TEST_TIMEOUT = 15_000
const AI_CHAT_TIMEOUT = 120_000

/* ---- 脱敏 / 日志：console 只打状态码与脱敏 URL，绝不打请求头与响应体 ---- */

/** 剔除文本里的密钥痕迹（Authorization、URL query 里的 key、裸 sk- 串、JSON 体里的敏感键值） */
function redactSecrets(text) {
  return String(text ?? '')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1***')
    .replace(/([?&](?:api[-_]?key|key|access[-_]?token|token|secret|password|auth)=)[^&\s"']+/gi, '$1***')
    .replace(/"(api[-_]?key|token|secret|password)"\s*:\s*"[^"]*"/gi, '"$1":"***"')
    .replace(/\bsk-[A-Za-z0-9._-]{4,}/g, (m) => `sk-…${m.slice(-4)}`)
}

/** 只保留 protocol://host/path，query（可能带 key）一律丢掉 */
function safeUrl(raw) {
  try {
    const url = new URL(String(raw ?? ''))
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return redactSecrets(String(raw ?? ''))
  }
}

function logAiCall(method, url, status) {
  console.log(`[ai] ${method} ${safeUrl(url)} -> ${status ?? '-'}`)
}

/** 密钥脱敏：'sk-xxxx…ab12'；太短的串只留两位，避免反向猜出原文 */
function maskKey(key) {
  const k = String(key ?? '').trim()
  if (!k) return ''
  if (k.length <= 8) return `${k.slice(0, 2)}…***`
  return `${k.slice(0, 3)}…${k.slice(-4)}`
}

/* ---- 配置：坏字段静默容错 ---- */

/** 把任意来源（磁盘 / IPC）的模型对象收成合法 ModelConfig；非法返回 null */
function sanitizeModel(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const protocol = raw.protocol === 'grsai' ? 'grsai' : 'openai'
  const type =
    raw.type === 'image' ? 'image' : raw.type === 'llm' ? 'llm' : protocol === 'grsai' ? 'image' : 'llm'
  const id =
    typeof raw.id === 'string' && raw.id.trim()
      ? raw.id.trim()
      : `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const baseUrl = String(raw.baseUrl ?? '').trim() || (protocol === 'grsai' ? GRSAI_TARGET : '')
  const modelName = String(raw.model ?? '').trim()
  const headers = {}
  if (raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
    for (const [k, v] of Object.entries(raw.headers)) {
      if (typeof k === 'string' && typeof v === 'string' && k.trim()) headers[k.trim()] = v
    }
  }
  return {
    id,
    name: String(raw.name ?? '').trim() || (type === 'image' ? '未命名生图模型' : '未命名对话模型'),
    type,
    protocol,
    baseUrl,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
    model: modelName,
    headers,
    enabled: raw.enabled !== false,
    webSearch: raw.webSearch === true,
    builtin: raw.builtin === true,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now()
  }
}

/** 读取模型列表（带缓存）；首次读取时自动注入内置 grsai 生图模型 */
function loadAiModels() {
  if (Array.isArray(aiModelsCache)) return aiModelsCache
  const raw = readConfig().aiModels
  const list = Array.isArray(raw) ? raw.map(sanitizeModel).filter(Boolean) : []
  if (!list.some((m) => m.builtin && m.protocol === 'grsai' && m.type === 'image')) {
    // 内置项不落盘也能用：每次重建缓存时按需注入，密钥沿用旧字段 grsaiKey
    list.unshift({
      id: BUILTIN_GRSAI_ID,
      name: 'grsai · Nano Banana（内置）',
      type: 'image',
      protocol: 'grsai',
      baseUrl: GRSAI_TARGET,
      apiKey: '',
      model: GRSAI_DEFAULT_MODEL,
      headers: {},
      enabled: true,
      webSearch: false,
      builtin: true,
      createdAt: Date.now()
    })
  }
  aiModelsCache = list
  return list
}

/** 当前激活项；生图未指定时默认落回内置 grsai */
function getActiveIds() {
  const raw = readConfig().activeIds
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const list = loadAiModels()
  const pick = (value, type) => {
    const id = typeof value === 'string' ? value : ''
    return list.some((m) => m.id === id && m.type === type) ? id : null
  }
  let image = pick(source.image, 'image')
  if (!image) {
    const builtin = list.find((m) => m.builtin && m.type === 'image')
    image = builtin ? builtin.id : null
  }
  return { llm: pick(source.llm, 'llm'), image }
}

function getModelById(id) {
  if (!id) return null
  return loadAiModels().find((m) => m.id === id) ?? null
}

/** 取实际生效的密钥：内置 grsai 沿用旧 grsaiKey 字段（向后兼容） */
function resolveModelKey(model) {
  if (!model) return ''
  if (model.builtin && model.protocol === 'grsai') return resolveGrsaiKey()
  return model.apiKey ?? ''
}

/** 渲染层唯一可见形态：剥掉 apiKey，只留 hasKey + 脱敏提示 */
function toModelView(model) {
  const key = resolveModelKey(model)
  return {
    id: model.id,
    name: model.name,
    type: model.type,
    protocol: model.protocol,
    baseUrl: model.baseUrl,
    model: model.model,
    headers: model.headers,
    enabled: model.enabled,
    webSearch: model.webSearch,
    builtin: model.builtin,
    createdAt: model.createdAt,
    hasKey: !!key,
    keyHint: maskKey(key)
  }
}

/* ---- 请求构造 ---- */

function joinUrl(base, pathname) {
  const b = String(base ?? '').trim().replace(/\/+$/, '')
  if (!b) return ''
  return b + (pathname.startsWith('/') ? pathname : `/${pathname}`)
}

function authHeaders(model) {
  const headers = { 'Content-Type': 'application/json', ...(model.headers ?? {}) }
  const key = resolveModelKey(model)
  if (key) headers['Authorization'] = `Bearer ${key}`
  return headers
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return []
  return messages
    .filter((m) => m && typeof m === 'object')
    .map((m) => ({
      role: m.role === 'system' || m.role === 'assistant' ? m.role : 'user',
      content: typeof m.content === 'string' ? m.content : String(m.content ?? '')
    }))
    .filter((m) => m.content.length > 0)
}

/**
 * 发往模型前的消息清洗入口。
 *
 * 注意：**不在这里追加任何提示词**。system/user 序列（含联网增强提示）
 * 一律由渲染层 `src/core/aiPrompt.ts` 的 buildAssistPrompt 按模式组装 ——
 * 主进程看不到「research / continue / polish」模式，若在此按 model.webSearch
 * 无条件追加，续写/润色会被诱导在正文末尾附「参考来源」，污染写进编辑器的文本。
 * 主进程只负责角色白名单与空消息过滤。
 */
function buildChatMessages(messages) {
  return sanitizeMessages(messages)
}

/** HTTP 状态码 → 对用户有指导意义的中文（不回传原始响应体） */
function describeHttpError(status, detail) {
  const known = {
    400: '请求被服务端拒绝（HTTP 400），请检查模型名与参数',
    401: 'API Key 无效或已过期（HTTP 401）',
    403: '无权限访问该模型（HTTP 403）',
    404: '接口地址不存在（HTTP 404），请检查接口地址是否正确',
    422: '请求参数不被接受（HTTP 422），请检查模型名',
    429: '请求过于频繁或额度不足（HTTP 429）'
  }
  if (known[status]) return known[status]
  if (typeof status === 'number' && status >= 500) return `服务端错误（HTTP ${status}）`
  return `请求失败（HTTP ${status}）${detail ? `：${detail}` : ''}`
}

/** fetch 异常归一：超时 / 取消 / DNS / 证书各自给中文，且不含密钥 */
function normalizeFetchError(error) {
  if (error?.name === 'TimeoutError') return '请求超时，请检查网络或接口地址后重试'
  if (error?.name === 'AbortError') return '请求已取消'
  // 先过 safeUrl：消息里嵌完整 URL 时剥掉 query（可能带 key），再统一脱敏
  const msg = redactSecrets(safeUrl(error?.message ?? String(error)))
  if (/ECONNREFUSED/i.test(msg)) return '接口地址拒绝连接，请检查地址与端口'
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return '无法解析接口地址，请检查域名是否正确'
  if (/CERT|certificate/i.test(msg)) return '接口证书校验失败，请确认地址使用 https 且证书有效'
  if (/fetch failed/i.test(msg)) return '无法连接接口地址，请检查网络与代理设置'
  return msg || '请求失败'
}

async function readErrorDetail(response) {
  const text = await response.text().catch(() => '')
  return describeHttpError(response.status, redactSecrets(text).slice(0, 300))
}

/* ---- OpenAI 兼容：对话 ---- */

async function callChat(model, req) {
  const url = joinUrl(model.baseUrl, '/chat/completions')
  const body = {
    model: model.model,
    messages: buildChatMessages(req.messages),
    temperature: typeof req.temperature === 'number' ? req.temperature : 0.7,
    max_tokens: typeof req.maxTokens === 'number' ? req.maxTokens : 2048,
    stream: false
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: authHeaders(model),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AI_CHAT_TIMEOUT)
  })
  logAiCall('POST', url, response.status)
  if (!response.ok) throw new Error(await readErrorDetail(response))
  const json = await response.json().catch(() => null)
  const choice = json?.choices?.[0] ?? {}
  const text = choice?.message?.content ?? choice?.text ?? ''
  const usage = json?.usage ?? undefined
  return {
    ok: true,
    text: typeof text === 'string' ? text : String(text ?? ''),
    usage: usage
      ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }
      : undefined
  }
}

/* ---- OpenAI 兼容：流式对话（SSE → ai:chunk 增量推送） ---- */

/** requestId → AbortController，供 ai:cancel-chat 取消 */
const chatControllers = new Map()

function pushChunk(sender, payload) {
  try {
    if (!sender || sender.isDestroyed?.()) return
    sender.send('ai:chunk', payload)
  } catch {
    /* 窗口已关闭/已销毁：推送失败不影响主进程 */
  }
}

/** 从一行 SSE 里取出 data 载荷（忽略 event:/注释/心跳行） */
function parseSseData(line) {
  const trimmed = line.trim()
  if (!trimmed || !trimmed.startsWith('data:')) return ''
  return trimmed.slice(5).trim()
}

async function runChatStream(sender, requestId, model, req, controller) {
  const url = joinUrl(model.baseUrl, '/chat/completions')
  try {
    const body = {
      model: model.model,
      messages: buildChatMessages(req.messages),
      temperature: typeof req.temperature === 'number' ? req.temperature : 0.7,
      max_tokens: typeof req.maxTokens === 'number' ? req.maxTokens : 2048,
      stream: true
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: authHeaders(model),
      body: JSON.stringify(body),
      signal: controller.signal
    })
    logAiCall('POST(stream)', url, response.status)
    if (!response.ok) throw new Error(await readErrorDetail(response))
    if (!response.body) throw new Error('服务端未返回流式响应体')

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const payload = parseSseData(line)
        if (!payload || payload === '[DONE]') continue
        let json
        try {
          json = JSON.parse(payload)
        } catch {
          continue // 心跳或非 JSON 行直接跳过
        }
        const delta = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.text ?? ''
        if (typeof delta === 'string' && delta) pushChunk(sender, { requestId, delta })
      }
    }
    pushChunk(sender, { requestId, done: true })
  } catch (error) {
    // 用户主动取消：视为流正常结束（不发 error，避免界面弹「失败」）
    if (error?.name === 'AbortError') {
      pushChunk(sender, { requestId, done: true })
    } else {
      pushChunk(sender, { requestId, error: normalizeFetchError(error) })
    }
  } finally {
    chatControllers.delete(requestId)
  }
}

/* ---- OpenAI 兼容：生图（同步返回） ---- */

async function generateOpenAiImages(model, req) {
  const url = joinUrl(model.baseUrl, '/images/generations')
  const body = {
    model: model.model,
    prompt: String(req.prompt ?? ''),
    n: clampCount(req.n),
    ...(req.size ? { size: String(req.size) } : {})
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: authHeaders(model),
    body: JSON.stringify(body)
  })
  logAiCall('POST', url, response.status)
  if (!response.ok) throw new Error(await readErrorDetail(response))
  const json = await response.json().catch(() => null)
  const data = Array.isArray(json?.data) ? json.data : []
  const urls = data
    .map((item) => {
      if (item?.url) return String(item.url)
      if (item?.b64_json) return `data:image/png;base64,${String(item.b64_json)}`
      return ''
    })
    .filter(Boolean)
  if (!urls.length) throw new Error('生图接口已返回，但结果里没有可用的图片地址')
  return urls
}

/* ---- grsai：提交 + 轮询 ---- */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 计数信号量：把 grsai 并发压在 GRSAI_MAX_CONCURRENT 以内 */
function createSemaphore(limit) {
  let active = 0
  const waiting = []
  return {
    async acquire() {
      if (active >= limit) await new Promise((resolve) => waiting.push(resolve))
      active += 1
      let released = false
      return () => {
        if (released) return
        released = true
        active -= 1
        const next = waiting.shift()
        if (next) next()
      }
    }
  }
}

const grsaiDrawSemaphore = createSemaphore(GRSAI_MAX_CONCURRENT)

/**
 * grsai 两条通道的协议差异（同 src/api/aiImage.ts 的 PROVIDERS）：
 *  - nano-banana：/v1/draw/nano-banana 提交 → /v1/draw/result 轮询，状态在 data 里；
 *  - gpt-image  ：/v1/api/generate 提交与查询同路径，body 需 replyType:"json"，状态在顶层。
 */
function grsaiSpec(modelName) {
  const name = String(modelName ?? '').toLowerCase()
  if (name.includes('gpt-image')) {
    return {
      submitPath: '/v1/api/generate',
      resultPath: '/v1/api/generate',
      buildSubmitBody: (input) => ({
        model: input.model,
        prompt: input.prompt,
        aspectRatio: input.aspectRatio,
        imageSize: input.imageSize,
        replyType: 'json'
      }),
      buildResultBody: (id) => ({ id, replyType: 'json' }),
      normalize: (json) => ({
        code: json.code,
        msg: json.msg,
        status: json.status,
        progress: json.progress,
        results: json.results,
        failure_reason: json.failure_reason
      })
    }
  }
  return {
    submitPath: '/v1/draw/nano-banana',
    resultPath: '/v1/draw/result',
    buildSubmitBody: (input) => ({
      model: input.model,
      prompt: input.prompt,
      aspectRatio: input.aspectRatio,
      imageSize: input.imageSize,
      webHook: '-1'
    }),
    buildResultBody: (id) => ({ id }),
    normalize: (json) => {
      const d = json.data ?? {}
      return {
        code: json.code,
        msg: json.msg,
        status: d.status,
        progress: d.progress,
        results: d.results,
        failure_reason: d.failure_reason
      }
    }
  }
}

/** grsai 业务错误码 → 中文（绝不猜测「余额不足」） */
function describeGrsaiError(code, msg) {
  if (code === -22) return '任务不存在或已过期，请重新生成（错误码 -22）'
  if (code === -1) {
    return 'API Key 无效（错误码 -1）——仪表盘用户中心显示的 32 位令牌不是 API Key，真正的 Key 以 sk- 开头，请在控制台 API Key 页复制'
  }
  return `生图接口返回错误 码 ${code}${msg ? `：${msg}` : ''}`
}

/** '1024x1024' → grsai 的比例档位；解析不了就用 16:9 */
function sizeToAspect(size) {
  const match = String(size ?? '').match(/(\d+)\s*[x×*]\s*(\d+)/i)
  if (!match) return { aspectRatio: '16:9', imageSize: '1K' }
  const w = Number(match[1])
  const h = Number(match[2])
  if (!w || !h) return { aspectRatio: '16:9', imageSize: '1K' }
  const ratio = w / h
  let aspectRatio = '4:3'
  if (ratio >= 1.6) aspectRatio = '16:9'
  else if (ratio <= 0.7) aspectRatio = '9:16'
  else if (ratio >= 0.85 && ratio <= 1.2) aspectRatio = '1:1'
  return { aspectRatio, imageSize: w >= 2048 ? '2K' : '1K' }
}

function clampCount(n) {
  const value = Number(n)
  if (!Number.isFinite(value)) return 1
  return Math.min(4, Math.max(1, Math.round(value)))
}

async function grsaiPost(model, pathname, body) {
  const url = joinUrl(model.baseUrl || GRSAI_TARGET, pathname)
  const response = await fetch(url, {
    method: 'POST',
    headers: authHeaders(model),
    body: JSON.stringify(body)
  })
  logAiCall('POST', url, response.status)
  if (!response.ok) throw new Error(await readErrorDetail(response))
  const json = await response.json().catch(() => null)
  if (!json || typeof json !== 'object') throw new Error('生图接口返回了无法解析的内容')
  if (typeof json.code === 'number' && json.code !== 0) {
    throw new Error(describeGrsaiError(json.code, json.msg))
  }
  return json
}

async function grsaiSubmit(model, spec, req) {
  const { aspectRatio, imageSize } = sizeToAspect(req.size)
  const json = await grsaiPost(
    model,
    spec.submitPath,
    spec.buildSubmitBody({
      model: model.model || GRSAI_DEFAULT_MODEL,
      prompt: String(req.prompt ?? ''),
      aspectRatio,
      imageSize
    })
  )
  const id = json?.data?.id ?? json?.id
  if (!id) throw new Error('生图提交失败：响应里没有任务 id')
  return id
}

async function grsaiPoll(model, spec, id) {
  const started = Date.now()
  while (true) {
    const json = await grsaiPost(model, spec.resultPath, spec.buildResultBody(id))
    const n = spec.normalize(json)
    const status = String(n.status ?? '').toLowerCase()
    if (status === 'succeeded' || status === 'success') {
      const urls = (n.results ?? [])
        .map((item) => item?.url)
        .filter((url) => typeof url === 'string' && url.length > 0)
      if (!urls.length) throw new Error('生图任务已完成，但结果里没有可用的图片地址')
      return urls
    }
    if (status === 'failed' || status === 'error') {
      throw new Error(
        n.failure_reason || '生图任务被服务端判定失败（可能是并发超限或提示词命中风控）'
      )
    }
    if (Date.now() - started > GRSAI_POLL_TIMEOUT) {
      throw new Error(`生图超时：${Math.round(GRSAI_POLL_TIMEOUT / 1000)}s 内未完成`)
    }
    await sleep(GRSAI_POLL_INTERVAL)
  }
}

/** 单张：提交 → 轮询；失败按指数退避最多重试 GRSAI_MAX_RETRY 次 */
async function generateGrsaiOnce(model, req) {
  const spec = grsaiSpec(model.model)
  for (let attempt = 1; attempt <= GRSAI_MAX_RETRY + 1; attempt++) {
    try {
      const id = await grsaiSubmit(model, spec, req)
      return await grsaiPoll(model, spec, id)
    } catch (error) {
      const message = normalizeFetchError(error)
      if (attempt > GRSAI_MAX_RETRY) {
        throw new Error(`生图失败（已重试 ${GRSAI_MAX_RETRY} 次）：${message}`)
      }
      // 指数退避：5s / 10s / 20s …（上限 60s），给服务端限流窗口留恢复时间
      await sleep(Math.min(5000 * 2 ** (attempt - 1), 60_000))
    }
  }
  throw new Error('生图失败：未知原因')
}

/** grsai 生图：逐张取信号量槽位，并发不超过 3 */
async function generateGrsaiImages(model, req) {
  const urls = []
  for (let i = 0; i < clampCount(req.n); i++) {
    const release = await grsaiDrawSemaphore.acquire()
    try {
      urls.push(...(await generateGrsaiOnce(model, req)))
    } finally {
      release()
    }
  }
  return urls
}

/* ---- 测试连接（主进程代发，错误信息不含密钥） ---- */

async function testModelConfig(cfg) {
  const model = sanitizeModel(cfg)
  if (!model) return { ok: false, error: '模型配置无法识别' }
  if (model.protocol !== 'grsai' && !model.baseUrl) {
    return { ok: false, error: '请先填写接口地址' }
  }
  const started = Date.now()
  const latency = () => Date.now() - started
  try {
    if (model.protocol === 'grsai') {
      const key = resolveModelKey(model)
      if (!key) return { ok: false, error: '未配置 grsai API Key（旧密钥入口设置的值会自动沿用）' }
      // 用不存在的任务 id 探一次：不消耗额度即可验证 Key 是否被接受
      const json = await grsaiPost(model, '/v1/draw/result', { id: '__probe__' }).catch(
        (error) => ({ __error: error })
      )
      if (json && json.__error) {
        // code -22 = 任务不存在，说明鉴权已通过；其余按错误码翻译
        const message = normalizeFetchError(json.__error)
        if (/错误码 -22/.test(message)) return { ok: true, latencyMs: latency() }
        return { ok: false, latencyMs: latency(), error: message }
      }
      return { ok: true, latencyMs: latency() }
    }

    const modelsUrl = joinUrl(model.baseUrl, '/models')
    const response = await fetch(modelsUrl, {
      method: 'GET',
      headers: authHeaders(model),
      signal: AbortSignal.timeout(AI_TEST_TIMEOUT)
    })
    logAiCall('GET', modelsUrl, response.status)
    if (!response.ok) {
      // 部分网关不开放 /models（404/405/401）→ 退回极短 chat 请求再判一次
      const chatUrl = joinUrl(model.baseUrl, '/chat/completions')
      const probe = await fetch(chatUrl, {
        method: 'POST',
        headers: authHeaders(model),
        body: JSON.stringify({
          model: model.model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1
        }),
        signal: AbortSignal.timeout(AI_TEST_TIMEOUT)
      })
      logAiCall('POST(probe)', chatUrl, probe.status)
      if (!probe.ok) return { ok: false, latencyMs: latency(), error: await readErrorDetail(probe) }
      return { ok: true, latencyMs: latency() }
    }
    const json = await response.json().catch(() => null)
    const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : null
    return { ok: true, latencyMs: latency(), modelCount: list ? list.length : undefined }
  } catch (error) {
    return { ok: false, latencyMs: latency(), error: normalizeFetchError(error) }
  }
}

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

/** 托盘图标（仅 GUI 实例持有；MCP 桥接实例与让位实例绝不创建） */
let tray = null
/** 「已最小化到托盘」气泡只提示第一次，之后再隐藏到托盘不再打扰 */
let trayHintShown = false

/**
 * close 事件的放行开关。
 *
 * 为什么放在 before-quit 而不是各处手动置位：quit 的路径不止一条——
 * 托盘菜单「退出」、window-all-closed、autoUpdater.quitAndInstall（检查更新后
 * 安装）都会走到 app 的退出流程，只有 before-quit 是它们的公共前哨。漏掉任何
 * 一条，窗口都会在 close 时被下面这段 hide 逻辑拦下来，表现为点了退出却退不掉。
 */
app.isQuitting = false

function createWindow() {
  // 窗口图标：主要服务开发态（npm run dev:electron）。
  // 打包后 Windows 的任务栏 / 标题栏用的是 exe 内嵌图标，electron-builder 会自动
  // 从 build/icon.png 取，不需要在这里再指一次，也不用改 package.json。
  // 加 existsSync 守卫：图标文件还没落盘时不能直接把启动搞挂。
  const appIconPath = path.join(__dirname, 'assets', 'app-icon.png')

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 640,
    title: '小说时间线工坊 · NovelFlow Studio',
    backgroundColor: '#0F1720',
    icon: fs.existsSync(appIconPath) ? appIconPath : undefined,
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

  // 首次露面就铺满屏幕（任务栏仍然可见，不是 setFullScreen 的无边框全屏）
  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.maximize()
    mainWindow.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  /**
   * 关闭 = 隐藏到托盘。
   * 只有真正退出（before-quit 已把 app.isQuitting 置 true）时才放行关闭事件，
   * 否则一律 preventDefault + hide，让应用在后台继续活着（MCP 控制服务器照常服务）。
   */
  mainWindow.on('close', (event) => {
    // 托盘没建起来（图标缺失 / 初始化失败）时不能拦关闭：否则窗口会被藏起来却无处唤回
    if (app.isQuitting || !tray) return
    event.preventDefault()
    mainWindow?.hide()
    // 只在第一次隐藏时说明「去哪了」，之后不再重复（Windows 才有 balloons）
    if (process.platform === 'win32' && !trayHintShown) {
      trayHintShown = true
      tray.displayBalloon({
        title: '小说时间线工坊',
        content: '已最小化到系统托盘，点击托盘图标可恢复窗口'
      })
    }
  })

  setupTray()

  // 开发模式：npm run dev:electron（主进程带 --dev 参数）→ 加载 dev server
  const isDev = process.argv.includes('--dev')
  if (isDev && !app.isPackaged) {
    mainWindow.loadURL('http://127.0.0.1:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

/**
 * 托盘：显示主窗口 / 退出。
 *
 * 只在 createWindow 的成功路径里调用，天然屏蔽三种不该出现托盘的场景：
 * MCP_MODE 桥接实例（无窗口）、单例让位实例、创建窗口失败。
 * 再加一道显式兜底，防止将来有人在别处误调用。
 */
function setupTray() {
  if (MCP_MODE || !HAS_SINGLE_INSTANCE_LOCK) return
  // macOS 的 activate 会重建窗口，此时旧托盘还在，不能重复 new Tray
  if (tray) return
  try {
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png')
    // 为什么用 createFromBuffer 而不是 createFromPath：
    // electron-builder 默认 asar 打包，__dirname 落在 app.asar 内部，而
    // nativeImage.createFromPath 对 asar 内路径有长期未修的缺陷（electron/electron#24221，
    // 典型报错场景正是 Tray）：它**返回空图而不抛异常**，于是下面的 isEmpty() 会让托盘
    // 静默失效——开发态（无 asar）却完全正常，本地怎么测都测不出来。
    // 主进程的 node fs 是 asar-aware 的，先读成 Buffer 再构造，对 dev 与打包版都成立。
    const icon = nativeImage.createFromBuffer(fs.readFileSync(iconPath))
    // 图标缺失 / 初始化失败就退化为「无托盘 + 关闭即退出」，宁可少个入口，
    // 也不能让窗口藏进一个唤不回来的地方
    if (icon.isEmpty()) {
      console.error('[tray] 托盘图标读取失败（空图），已跳过托盘初始化')
      return
    }
    tray = new Tray(icon)
  } catch (error) {
    // 读盘失败 / 构造失败都落到这里：同样按「无托盘」降级
    console.error('[tray] 托盘初始化失败：', error?.message ?? String(error))
    return
  }

  tray.setToolTip('小说时间线工坊 · NovelFlow Studio')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: focusMainWindow },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          app.isQuitting = true
          app.quit()
        }
      }
    ])
  )
  // 单击托盘图标（Windows 语义）直接唤回窗口
  tray.on('click', focusMainWindow)
}

/* ------------------------------------------------------------------ */
/* IPC：应用信息 + 密钥读写 + AI 模型管理                                 */
/* ------------------------------------------------------------------ */

ipcMain.handle('app:get-version', () => app.getVersion())
ipcMain.handle('app:get-platform', () => process.platform)
ipcMain.handle('app:get-grsai-key', () => resolveGrsaiKey())
ipcMain.handle('app:set-grsai-key', (_event, key) => {
  writeGrsaiKey(String(key ?? '').trim())
  return { ok: true }
})

/* ---- AI 模型：列表 / 保存 / 删除 / 激活 ---- */

/** 只回脱敏视图，完整 apiKey 永不跨 IPC 边界 */
ipcMain.handle('ai:list-models', () => ({
  models: loadAiModels().map(toModelView),
  activeIds: getActiveIds()
}))

ipcMain.handle('ai:save-model', (_event, cfg) => {
  const incoming = sanitizeModel(cfg)
  if (!incoming) return { ok: false, error: '模型配置无法识别' }
  if (incoming.protocol !== 'grsai' && !incoming.baseUrl) {
    return { ok: false, error: '请先填写接口地址' }
  }
  if (!incoming.model) return { ok: false, error: '请先填写模型名' }

  const list = loadAiModels()
  const index = list.findIndex((m) => m.id === incoming.id)
  let saved
  if (index >= 0) {
    const prev = list[index]
    saved = { ...prev, ...incoming }
    // 表单里密钥留空 = 保留原值（与「已配置（输入新值可覆盖）」的交互一致）
    if (!incoming.apiKey) saved.apiKey = prev.apiKey
    if (prev.builtin) {
      // 内置项的身份字段不允许被改
      saved.builtin = true
      saved.protocol = prev.protocol
      saved.type = prev.type
      saved.id = prev.id
    }
    list[index] = saved
  } else {
    saved = incoming
    list.push(saved)
  }

  // 内置 grsai 的密钥同时写回旧字段 grsaiKey，让 webRequest 老链路继续可用
  if (saved.builtin && saved.protocol === 'grsai' && saved.apiKey) {
    writeGrsaiKey(saved.apiKey)
  }
  writeConfig({ aiModels: list })
  return { ok: true }
})

ipcMain.handle('ai:remove-model', (_event, id) => {
  const list = loadAiModels()
  const target = list.find((m) => m.id === id)
  if (!target) return { ok: false, error: '模型不存在' }
  if (target.builtin) return { ok: false, error: '内置模型不可删除' }
  const next = list.filter((m) => m.id !== id)
  const active = getActiveIds()
  writeConfig({
    aiModels: next,
    activeIds: {
      llm: active.llm === id ? null : active.llm,
      image: active.image === id ? null : active.image
    }
  })
  return { ok: true }
})

ipcMain.handle('ai:set-active', (_event, patch) => {
  const next = { ...getActiveIds() }
  const source = patch && typeof patch === 'object' ? patch : {}
  for (const type of ['llm', 'image']) {
    if (!(type in source)) continue
    const value = source[type]
    // 清空：生图留空会由 getActiveIds 自动落回内置 grsai
    if (value === null || value === undefined || value === '') {
      next[type] = null
      continue
    }
    const model = getModelById(String(value))
    if (!model || model.type !== type) {
      return { ok: false, error: `指定的${type === 'llm' ? '对话' : '生图'}模型不存在` }
    }
    next[type] = model.id
  }
  writeConfig({ activeIds: next })
  return { ok: true }
})

ipcMain.handle('ai:test-model', async (_event, cfg) => {
  const incoming = sanitizeModel(cfg)
  if (!incoming) return { ok: false, error: '模型配置无法识别' }
  // 空密钥 = 沿用已存模型的那把（与 ai:save-model「空值保留原值」语义一致）。
  // 渲染层只持脱敏视图、拿不到明文，回落只能发生在主进程这一侧。
  if (!incoming.apiKey && incoming.id) {
    const stored = getModelById(incoming.id)
    if (stored) incoming.apiKey = resolveModelKey(stored)
  }
  return testModelConfig(incoming)
})

/* ---- AI 调用：对话 / 流式 / 取消 / 生图 ---- */

/** 解析要用的模型：显式 modelId 优先，否则用当前激活项 */
function resolveChatModel(modelId) {
  if (modelId) return { model: getModelById(String(modelId)), error: '未找到该模型，请先在模型管理中保存' }
  const active = getActiveIds()
  const model = active.llm ? getModelById(active.llm) : null
  return { model, error: '还没有可用的对话模型，请先在模型管理中添加并激活' }
}

ipcMain.handle('ai:chat', async (_event, req) => {
  const request = req && typeof req === 'object' ? req : {}
  const { model, error } = resolveChatModel(request.modelId)
  if (!model) return { ok: false, error }
  if (model.type !== 'llm') return { ok: false, error: '该模型不是对话模型' }
  if (!model.enabled) return { ok: false, error: '该模型已停用，请先在模型管理中启用' }
  if (model.protocol !== 'openai') return { ok: false, error: '内置 grsai 通道仅支持生图' }
  try {
    return await callChat(model, request)
  } catch (err) {
    return { ok: false, error: normalizeFetchError(err) }
  }
})

/** 立即返回 requestId，正文通过 ai:chunk 事件增量推送 */
ipcMain.handle('ai:chat-stream', (event, req) => {
  const request = req && typeof req === 'object' ? req : {}
  const { model, error } = resolveChatModel(request.modelId)
  if (!model) return { ok: false, error }
  if (model.type !== 'llm') return { ok: false, error: '该模型不是对话模型' }
  if (!model.enabled) return { ok: false, error: '该模型已停用，请先在模型管理中启用' }
  if (model.protocol !== 'openai') return { ok: false, error: '内置 grsai 通道仅支持生图' }

  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const controller = new AbortController()
  chatControllers.set(requestId, controller)
  // 不 await：流在后台跑，推送走 event.sender
  void runChatStream(event.sender, requestId, model, request, controller)
  return { ok: true, requestId }
})

ipcMain.handle('ai:cancel-chat', (_event, requestId) => {
  const controller = chatControllers.get(String(requestId ?? ''))
  if (!controller) return { ok: false, error: '该请求已结束或不存在' }
  controller.abort()
  chatControllers.delete(String(requestId))
  return { ok: true }
})

ipcMain.handle('ai:image', async (_event, req) => {
  const request = req && typeof req === 'object' ? req : {}
  const id = request.modelId || getActiveIds().image
  const model = getModelById(id)
  if (!model) return { ok: false, error: '还没有可用的生图模型，请先在模型管理中添加并激活' }
  if (model.type !== 'image') return { ok: false, error: '该模型不是生图模型' }
  if (!model.enabled) return { ok: false, error: '该模型已停用，请先在模型管理中启用' }
  if (!String(request.prompt ?? '').trim()) return { ok: false, error: '生图提示词不能为空' }
  try {
    const urls = model.protocol === 'grsai'
      ? await generateGrsaiImages(model, request)
      : await generateOpenAiImages(model, request)
    return { ok: true, urls }
  } catch (err) {
    return { ok: false, error: normalizeFetchError(err) }
  }
})

/* ------------------------------------------------------------------ */
/* Embedding（语义索引用）：只走本机 Ollama / LM Studio                   */
/*                                                                     */
/* 隐私口径由用户拍板：**正文绝不发往第三方**。所以这里比 AI 对话多一道    */
/* 硬校验 —— baseUrl 的主机名必须是环回地址，否则直接拒绝。              */
/*                                                                     */
/* 配置面刻意放在**知识库偏好表**（preferences）而不是 config.json：       */
/* 读写走 task-002 已有的 `kb:get-preferences` / `kb:set-preference`      */
/* 两条通道，`KbApi` 里早就有类型声明，于是**不必新增任何 IPC、也不必动    */
/* src/types/ai.ts 那个「前端禁改」的契约红线文件** —— 这是「折中先行」    */
/* 能落地的关键：用户可以在界面里配端点，而契约文件一个字都不改。          */
/* ------------------------------------------------------------------ */

/** 本机预设：Ollama 默认端口（LM Studio 常用 http://localhost:1234/v1） */
const EMBED_DEFAULT_BASE_URL = 'http://localhost:11434/v1'
/** 本机常用中文 embedding 模型名（缺省值只是指引，用户可在知识库偏好里改） */
const EMBED_DEFAULT_MODEL = 'nomic-embed-text'
/** 偏好键：本地 embedding 端点（与 src/api/kbClient.ts 的同名常量同源） */
const PREF_EMBEDDING_BASE_URL = 'pref.embedding_base_url'
/** 偏好键：本地 embedding 模型名 */
const PREF_EMBEDDING_MODEL = 'pref.embedding_model'
/** embedding 请求超时：本地 CPU 推理可能较慢，给到 60s */
const AI_EMBED_TIMEOUT = 60_000
/** 一批最多 embedding 多少块：本地服务一次吃太多会排队很久，也方便失败只丢一批 */
const EMBED_BATCH_SIZE = 16
/** 单次重建的块数硬上限：防一篇超长文档把重建拖到几十分钟 */
const VEC_REBUILD_MAX_CHUNKS = 4000
/** 允许的环回主机名（IPv6 一并放行；new URL 对 IPv6 会保留方括号，两种写法都收） */
const LOCAL_EMBED_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]', '0:0:0:0:0:0:0:1']
/** 非本机地址的统一中文错误（用户拍板的原话口径） */
const EMBED_LOCAL_ONLY_ERROR = '仅支持本地 embedding 服务（Ollama / LM Studio），请填写本机地址'

/**
 * 读 embedding 配置（事实源 = 知识库 preferences 表）。
 *
 * 为什么从 kbStore 读而不是 readConfig()：配置必须能被用户在界面里改，
 * 而能改的通道只有「偏好」这一条（preload 不能新增通道，因为类型在红线
 * 文件里）。config.json 里那套 `embedding` 字段已废弃、不再作为事实源 ——
 * 双源必然漂移，宁可只留一个。
 *
 * 缺字段就填本机预设，绝不因为「没配过」而卡住整个功能；维度不在这里配，
 * 由首次 embedding 返回的向量长度自动推断（用户手填容易错，且换模型就失效）。
 */
function getEmbeddingConfig() {
  let prefs = {}
  if (kbStore.isKbReady()) {
    try {
      prefs = kbStore.kbGetPreferences() ?? {}
    } catch {
      // 偏好读失败按「未配置」处理：下面是本机预设 + 本地强校验，不会发往第三方
      prefs = {}
    }
  }
  return {
    baseUrl: String(prefs[PREF_EMBEDDING_BASE_URL] ?? '').trim() || EMBED_DEFAULT_BASE_URL,
    model: String(prefs[PREF_EMBEDDING_MODEL] ?? '').trim() || EMBED_DEFAULT_MODEL
  }
}

/**
 * 本机强校验：通过返回 null，否则返回中文 error。
 *
 * 为什么必须在主进程校验：渲染层拿到的 baseUrl 可能被 MCP / 控制台调用者
 * 间接改到，而「正文发往第三方」是不可逆的隐私事故 —— 校验必须落在真正
 * 发请求的那一侧。
 */
function checkLocalEmbedding(baseUrl) {
  let host = ''
  try {
    host = new URL(String(baseUrl ?? '')).hostname
  } catch {
    return 'embedding 接口地址不合法，请填写完整地址（例如 http://localhost:11434/v1）'
  }
  if (!LOCAL_EMBED_HOSTS.includes(host.toLowerCase())) return EMBED_LOCAL_ONLY_ERROR
  return null
}

/**
 * 主进程代发一次 OpenAI 兼容的 `/embeddings`（Ollama / LM Studio 都吃这个形状）。
 *
 * 只回 `number[][]`：原始响应体一律不出口（与 toModelView 剥 key 同一条纪律）。
 *
 * **不发 Authorization 头**：端点已被强校验成环回地址，本机 Ollama / LM Studio
 * 都是免密的；既然配置面只有端点与模型名两个键，也就不存在「密钥从哪来」的
 * 问题 —— 少一条密钥存储路径，就少一处泄露面。
 */
async function embedTexts(texts) {
  const cfg = getEmbeddingConfig()
  const localError = checkLocalEmbedding(cfg.baseUrl)
  if (localError) throw new Error(localError)

  const url = joinUrl(cfg.baseUrl, '/embeddings')
  const response = await fetch(url, {
    method: 'POST',
    // 头必须显式内联：顶层没有 `headers` 变量（其他 AI 调用写的是
    // `headers: authHeaders(model)` 显式键），这里曾误用对象简写 `headers,`
    // 引用未定义变量 → ReferenceError，向量检索永远降级、索引永远建不出
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, input: texts }),
    signal: AbortSignal.timeout(AI_EMBED_TIMEOUT)
  })
  logAiCall('POST', url, response.status)
  if (!response.ok) throw new Error(await readErrorDetail(response))

  const json = await response.json().catch(() => null)
  const list = Array.isArray(json?.data) ? json.data : []
  if (!list.length) {
    throw new Error('embedding 服务没有返回向量，请确认模型名是 embedding 模型（如 nomic-embed-text）')
  }
  // 按输入顺序回填：OpenAI 约定 data[i].index 是原始下标，个别网关不返该字段时
  // 按返回顺序兜底 —— 顺序错了等于把 A 块的向量存到 B 块上，静默污染整个索引
  const byIndex = new Array(texts.length)
  let cursor = 0
  for (const item of list) {
    const raw = item?.embedding
    if (!Array.isArray(raw) || !raw.length) continue
    const index = Number.isFinite(item?.index) ? Number(item.index) : cursor
    if (index >= 0 && index < texts.length) byIndex[index] = raw.map((n) => Number(n))
    cursor += 1
  }
  const vectors = []
  for (let i = 0; i < texts.length; i += 1) {
    if (!byIndex[i]) throw new Error('embedding 服务返回的向量数量与输入不一致')
    vectors.push(byIndex[i])
  }
  return vectors
}

/*
 * 这里**故意不再注册 `ai:embed` IPC 通道**（曾注册过，已按队长裁决删除）。
 *
 * 理由：`src/types/ai.ts` 是「前端禁改」的跨进程契约红线文件，渲染层拿不到
 * `embed` 的类型声明，preload 也就不能合法露出这条通道 —— 注册了必然是
 * 「已注册无调用方」的死通道，徒增安全面。
 *
 * embedding 能力目前只由**主进程自己**消费（建索引 / 语义检索，见下方
 * `kb:rebuild-index` 与 `kb:semantic-search`），配置走知识库偏好，因此没有
 * 对外通道也完全可用。
 *
 * ⚠️ 若将来要把 embedding 对外暴露（例如给渲染层做「配置自检」按钮），
 * **必须先获授权修改 `src/types/ai.ts`**（在 `AiApi` 里加签名），再按
 * `ai:*` 的既有范式补 preload + 客户端。未经授权不得绕过红线。
 */

/* ------------------------------------------------------------------ */
/* 知识库（kb:*）：sql.js 本机数据库的唯一 IPC 面                          */
/*                                                                     */
/* 形状照 ai:*：前置校验（参数形状 / 长度上限 / 必填）→ 失败中文 error；  */
/* async 包 try/catch；IPC 边界永不抛异常（渲染层 kbClient 再按          */
/* result.ok === false 抛）。安全面最小化：只暴露 list/get/create/       */
/* update/remove/link/unlink/search/export/import + doc 系列 + 偏好读写； */
/* 不暴露 db 路径、export() 原始字节、任意 SQL。                          */
/* ------------------------------------------------------------------ */

/** 文档大小上限：10MB（再大的文档应拆篇；sql.js 是全量导出式持久化） */
const KB_DOC_MAX_BYTES = 10 * 1024 * 1024
/** 偏好键白名单（与渲染层 PrefKey 一一对应） */
const KB_PREF_KEYS = [
  'pref.chat_memory',
  'pref.local_memory',
  'pref.work_background',
  // 语义检索（task-001）：本地 embedding 端点与模型名。配置面走偏好而不是
  // config.json，正是为了「不新增 IPC、不动 src/types/ai.ts 红线」也能让用户配
  'pref.embedding_base_url',
  'pref.embedding_model'
]
/** 自由文本型偏好键：这几个不是 true/false 开关，不套开关值校验 */
const KB_PREF_TEXT_KEYS = [
  'pref.work_background',
  'pref.embedding_base_url',
  'pref.embedding_model'
]

/**
 * kb:* 统一包装：handler 内抛出的任何异常都归一成 {ok:false, error}，
 * 与 aiClient 的「IPC 边界永不抛」契约对齐。
 */
function kbHandle(channel, handler) {
  ipcMain.handle(channel, async (event, payload) => {
    try {
      return await handler(payload)
    } catch (err) {
      // 全 || 链：?? 与 || 混用必须加括号，这里统一用 ||（空 message 也会落到下一级）
      return { ok: false, error: err?.message || String(err) || '知识库操作失败' }
    }
  })
}

/** 字符串校验小工具：通过返回 null，失败返回中文 error（照 tools.cjs 迷你校验器风格） */
function kbCheckString(value, key, { required = false, max = 200, oneOf = null } = {}) {
  if (value === undefined || value === null || value === '') {
    return required ? `参数「${key}」不能为空` : null
  }
  if (typeof value !== 'string') return `参数「${key}」必须是字符串`
  if (value.length > max) return `参数「${key}」过长（上限 ${max} 字符）`
  if (oneOf && !oneOf.includes(value)) return `参数「${key}」只能是：${oneOf.join(' / ')}`
  return null
}

/** 标签数组校验：元素全字符串、条数 / 单项长度上限 */
function kbCheckTags(value, key) {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) return `参数「${key}」必须是字符串数组`
  if (value.some((t) => typeof t !== 'string')) return `参数「${key}」必须全部是字符串`
  if (value.length > 20) return `参数「${key}」条数过多（上限 20 个）`
  if (value.some((t) => t.length > 50)) return `参数「${key}」单项过长（上限 50 字符）`
  return null
}

/** 布尔校验（严格布尔，不接受 truthy 字符串） */
function kbCheckBoolean(value, key) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'boolean') return `参数「${key}」必须是布尔值`
  return null
}

/* ---- 知识条目 ---- */

kbHandle('kb:list-entries', () => ({ ok: true, entries: kbStore.kbListEntries() }))

kbHandle('kb:create-entry', (payload) => {
  const p = payload && typeof payload === 'object' ? payload : {}
  const errs = [
    kbCheckString(p.title, 'title', { required: true, max: 200 }),
    kbCheckString(p.type, 'type', { max: 50, oneOf: kbStore.ENTRY_TYPES }),
    kbCheckString(p.content, 'content', { max: 200000 }),
    kbCheckTags(p.tags, 'tags')
  ].filter(Boolean)
  if (errs.length) return { ok: false, error: errs[0] }
  return {
    ok: true,
    entry: kbStore.kbCreateEntry({
      title: p.title.trim(),
      type: p.type ?? 'note',
      content: p.content ?? '',
      tags: Array.isArray(p.tags) ? p.tags.map((t) => t.trim()).filter(Boolean) : []
    })
  }
})

kbHandle('kb:update-entry', (payload) => {
  const p = payload && typeof payload === 'object' ? payload : {}
  const idErr = kbCheckString(p.id, 'id', { required: true, max: 100 })
  if (idErr) return { ok: false, error: idErr }
  const patch = p.patch && typeof p.patch === 'object' ? p.patch : {}
  const errs = [
    kbCheckString(patch.title, 'title', { max: 200 }),
    kbCheckString(patch.type, 'type', { max: 50, oneOf: kbStore.ENTRY_TYPES }),
    kbCheckString(patch.content, 'content', { max: 200000 }),
    kbCheckTags(patch.tags, 'tags')
  ].filter(Boolean)
  if (errs.length) return { ok: false, error: errs[0] }
  const entry = kbStore.kbUpdateEntry(p.id, patch)
  if (!entry) return { ok: false, error: '条目不存在或已被删除' }
  return { ok: true, entry }
})

kbHandle('kb:remove-entry', (payload) => {
  const idErr = kbCheckString(payload?.id, 'id', { required: true, max: 100 })
  if (idErr) return { ok: false, error: idErr }
  kbStore.kbRemoveEntry(payload.id)
  return { ok: true }
})

kbHandle('kb:search-entries', (payload) => {
  const query = typeof payload === 'string' ? payload : payload?.query
  const err = kbCheckString(query, 'query', { max: 200 })
  if (err) return { ok: false, error: err }
  const limit = Number.isFinite(payload?.limit) ? Math.min(Math.max(1, payload.limit), 100) : 50
  return { ok: true, entries: kbStore.kbSearchEntries(query ?? '', limit) }
})

/* ---- 节点关联（按 nodeId 反查 / 挂载 / 解绑） ---- */

kbHandle('kb:list-node-links', (payload) => {
  const nodeErr = kbCheckString(payload?.nodeId, 'nodeId', { required: true, max: 100 })
  if (nodeErr) return { ok: false, error: nodeErr }
  const { entries, docs } = kbStore.kbListNodeLinks(payload.nodeId)
  return { ok: true, entries, docs }
})

kbHandle('kb:link-entry', (payload) => {
  const p = payload && typeof payload === 'object' ? payload : {}
  const errs = [
    kbCheckString(p.entryId, 'entryId', { required: true, max: 100 }),
    kbCheckString(p.nodeId, 'nodeId', { required: true, max: 100 })
  ].filter(Boolean)
  if (errs.length) return { ok: false, error: errs[0] }
  if (!kbStore.kbGetEntry(p.entryId)) return { ok: false, error: '知识条目不存在，无法关联' }
  kbStore.kbLinkEntry(p.entryId, p.nodeId)
  return { ok: true }
})

kbHandle('kb:unlink-entry', (payload) => {
  const p = payload && typeof payload === 'object' ? payload : {}
  const errs = [
    kbCheckString(p.entryId, 'entryId', { required: true, max: 100 }),
    kbCheckString(p.nodeId, 'nodeId', { required: true, max: 100 })
  ].filter(Boolean)
  if (errs.length) return { ok: false, error: errs[0] }
  kbStore.kbUnlinkEntry(p.entryId, p.nodeId)
  return { ok: true }
})

kbHandle('kb:link-doc', (payload) => {
  const p = payload && typeof payload === 'object' ? payload : {}
  const errs = [
    kbCheckString(p.docId, 'docId', { required: true, max: 100 }),
    kbCheckString(p.nodeId, 'nodeId', { required: true, max: 100 })
  ].filter(Boolean)
  if (errs.length) return { ok: false, error: errs[0] }
  if (!kbStore.kbGetDoc(p.docId)) return { ok: false, error: '文档不存在，无法关联' }
  kbStore.kbLinkDoc(p.docId, p.nodeId)
  return { ok: true }
})

kbHandle('kb:unlink-doc', (payload) => {
  const p = payload && typeof payload === 'object' ? payload : {}
  const errs = [
    kbCheckString(p.docId, 'docId', { required: true, max: 100 }),
    kbCheckString(p.nodeId, 'nodeId', { required: true, max: 100 })
  ].filter(Boolean)
  if (errs.length) return { ok: false, error: errs[0] }
  kbStore.kbUnlinkDoc(p.docId, p.nodeId)
  return { ok: true }
})

/* ---- 文档 ---- */

kbHandle('kb:list-docs', () => ({ ok: true, docs: kbStore.kbListDocs() }))

kbHandle('kb:get-doc', (payload) => {
  const idErr = kbCheckString(payload?.id, 'id', { required: true, max: 100 })
  if (idErr) return { ok: false, error: idErr }
  const doc = kbStore.kbGetDoc(payload.id)
  if (!doc) return { ok: false, error: '文档不存在或已被删除' }
  return { ok: true, doc }
})

kbHandle('kb:create-doc', (payload) => {
  const p = payload && typeof payload === 'object' ? payload : {}
  const errs = [
    kbCheckString(p.title, 'title', { required: true, max: 200 }),
    kbCheckString(p.format, 'format', { required: true, max: 10, oneOf: kbStore.DOC_FORMATS }),
    kbCheckString(p.content, 'content', { required: true, max: 2000000 })
  ].filter(Boolean)
  if (errs.length) return { ok: false, error: errs[0] }
  return {
    ok: true,
    doc: kbStore.kbCreateDoc({ title: p.title.trim(), format: p.format, content: p.content })
  }
})

kbHandle('kb:update-doc', (payload) => {
  const p = payload && typeof payload === 'object' ? payload : {}
  const idErr = kbCheckString(p.id, 'id', { required: true, max: 100 })
  if (idErr) return { ok: false, error: idErr }
  const patch = p.patch && typeof p.patch === 'object' ? p.patch : {}
  const errs = [
    kbCheckString(patch.title, 'title', { max: 200 }),
    kbCheckString(patch.content, 'content', { max: 2000000 })
  ].filter(Boolean)
  if (errs.length) return { ok: false, error: errs[0] }
  const doc = kbStore.kbUpdateDoc(p.id, patch)
  if (!doc) return { ok: false, error: '文档不存在或已被删除' }
  return { ok: true, doc }
})

kbHandle('kb:remove-doc', (payload) => {
  const idErr = kbCheckString(payload?.id, 'id', { required: true, max: 100 })
  if (idErr) return { ok: false, error: idErr }
  kbStore.kbRemoveDoc(payload.id)
  return { ok: true }
})

/**
 * 选择文档（两段式第一段）：只回路径，内容走 kb:read-doc 单独读。
 * 理由：大内容过 IPC 前先校验后缀与大小，错误信息才对用户有意义。
 */
kbHandle('kb:pick-doc', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择要导入的文档',
    properties: ['openFile'],
    filters: [{ name: '文档', extensions: ['md', 'txt', 'docx'] }]
  })
  if (result.canceled || !result.filePaths?.[0]) return { ok: true, canceled: true }
  return { ok: true, canceled: false, path: result.filePaths[0] }
})

/**
 * .docx 抽文本：优先 worker_threads，失败回落同步 extractDocxText。
 *
 * 为什么必须 worker：inflateRawSync + 全量 XML 正则扫描是同步重计算，放主进程
 * 会霸占事件循环（10MB 档数百 ms~数秒，UI 无响应）；同步计算无法切片 yield，
 * setTimeout 让步对它无效，挪出主线程是唯一正解（与 P0 方案评估一致）。
 *
 * 为什么留同步回落：asar 内等场景 worker 可能起不来（spawn 失败 / 进程崩溃 /
 * 环境差异导致 worker 内模块加载失败）——功能不退化优先，同步路径是兜底，
 * docx.cjs 对坏文件本就有完整中文错误。代价：worker 任何失败信号都会同步重跑
 * 一遍，损坏文件会多解析一次（纯函数、结果一致），但功能永远可用。
 */
async function extractDocxTextViaWorker(filePath) {
  let worker = null
  try {
    worker = new Worker(path.join(__dirname, 'kb', 'docx-worker.cjs'), { workerData: { filePath } })
    return await new Promise((resolve, reject) => {
      worker.on('message', (msg) => {
        if (msg && msg.ok) resolve(msg.text)
        else reject(new Error(msg?.error || 'docx 解析失败'))
      })
      // 进程级错误（脚本加载失败 / 未捕获异常 / OOM）：worker 机制本身不可用
      worker.on('error', reject)
      // 异常退出或静默退出（没等到 message 就退了）：按不可用处理，防 Promise 永挂
      worker.on('exit', (code) => {
        reject(new Error(code === 0 ? 'docx worker 未返回结果' : `docx worker 异常退出（code ${code}）`))
      })
    })
  } catch {
    // 回落：读盘 + 抽取都在主进程同步跑——最坏退回 worker 化之前的行为
    return extractDocxText(fs.readFileSync(filePath))
  } finally {
    if (worker) worker.terminate().catch(() => {})
  }
}

/** 读取文档内容（两段式第二段）：后缀白名单 + 10MB 上限 + 防目录穿越 */
kbHandle('kb:read-doc', async (payload) => {
  const raw = typeof payload === 'string' ? payload : payload?.path
  const pathErr = kbCheckString(raw, 'path', { required: true, max: 1000 })
  if (pathErr) return { ok: false, error: pathErr }
  // 防目录穿越双保险：显式拒掉 .. 段（dialog 已限定目录，这里是纵深防御）
  if (raw.includes('..')) return { ok: false, error: '文件路径不合法（包含 .. 目录段）' }
  const resolved = path.resolve(raw)
  const ext = path.extname(resolved).toLowerCase()
  if (!['.md', '.txt', '.docx'].includes(ext)) {
    return { ok: false, error: '只支持 .md / .txt / .docx 三种格式' }
  }
  let stat
  try {
    // 异步 stat + 读前拦截：10MB 上限在读文件之前就拦掉，不搞「读完才拒」。
    // 口径说明：read 阶段按字节 10MB，create 阶段按字符 200 万（kb:create-doc）；
    // 10MB 中文文档约 330 万字符会越过后者，读前拦能让用户立刻看到拆分指引，
    // 而不是白等整个读取时间后才看到费解的参数超长错误。
    stat = await fs.promises.stat(resolved)
  } catch {
    return { ok: false, error: '文件不存在或无法读取' }
  }
  if (!stat.isFile()) return { ok: false, error: '选中的不是文件' }
  if (stat.size > KB_DOC_MAX_BYTES) {
    return { ok: false, error: `文件超过 ${Math.floor(KB_DOC_MAX_BYTES / 1024 / 1024)}MB 上限，请拆分后上传` }
  }
  const format = ext.slice(1)
  const title = path.basename(resolved, ext)
  if (format === 'docx') {
    // docx 抽文本走 worker（同步重计算挪出主进程），worker 不可用时回落同步
    return { ok: true, title, format, content: await extractDocxTextViaWorker(resolved) }
  }
  // utf-8 异步读取：剥 BOM（\uFEFF 会让锚点偏移量整体 +1）+ \r\n 归一
  // （存储内容的偏移量与 relocateAnchor 的归一化前提保持一致）
  const content = (await fs.promises.readFile(resolved, 'utf-8')).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  return { ok: true, title, format, content }
})

/* ---- 文档锚点 ---- */

kbHandle('kb:list-anchors', (payload) => {
  const p = payload && typeof payload === 'object' ? payload : {}
  const docErr = kbCheckString(p.docId, 'docId', { max: 100 })
  const nodeErr = kbCheckString(p.nodeId, 'nodeId', { max: 100 })
  if (docErr || nodeErr) return { ok: false, error: docErr ?? nodeErr ?? '' }
  if (!p.docId && !p.nodeId) return { ok: false, error: '参数「docId」与「nodeId」至少给一个' }
  const anchors = p.docId ? kbStore.kbListAnchorsByDoc(p.docId) : kbStore.kbListAnchorsByNode(p.nodeId)
  return { ok: true, anchors }
})

kbHandle('kb:create-anchor', (payload) => {
  const p = payload && typeof payload === 'object' ? payload : {}
  const errs = [
    kbCheckString(p.docId, 'docId', { required: true, max: 100 }),
    kbCheckString(p.nodeId, 'nodeId', { max: 100 }),
    kbCheckString(p.quote, 'quote', { required: true, max: 2000 }),
    kbCheckString(p.note, 'note', { max: 500 })
  ].filter(Boolean)
  if (errs.length) return { ok: false, error: errs[0] }
  if (!Number.isFinite(p.startOffset) || !Number.isFinite(p.endOffset)) {
    return { ok: false, error: '参数「startOffset / endOffset」必须是数字' }
  }
  if (p.startOffset < 0 || p.endOffset <= p.startOffset) {
    return { ok: false, error: '锚点区间不合法（endOffset 必须大于 startOffset）' }
  }
  if (!kbStore.kbGetDoc(p.docId)) return { ok: false, error: '文档不存在，无法建锚点' }
  return {
    ok: true,
    anchor: kbStore.kbCreateAnchor({
      docId: p.docId,
      nodeId: p.nodeId ?? null,
      quote: p.quote,
      startOffset: Math.trunc(p.startOffset),
      endOffset: Math.trunc(p.endOffset),
      note: p.note ?? ''
    })
  }
})

kbHandle('kb:update-anchor', (payload) => {
  const p = payload && typeof payload === 'object' ? payload : {}
  const idErr = kbCheckString(p.id, 'id', { required: true, max: 100 })
  if (idErr) return { ok: false, error: idErr }
  const patch = p.patch && typeof p.patch === 'object' ? p.patch : {}
  const errs = [
    kbCheckString(patch.quote, 'quote', { max: 2000 }),
    kbCheckString(patch.note, 'note', { max: 500 })
  ].filter(Boolean)
  if (errs.length) return { ok: false, error: errs[0] }
  const anchor = kbStore.kbUpdateAnchor(p.id, patch)
  if (!anchor) return { ok: false, error: '锚点不存在或已被删除' }
  return { ok: true, anchor }
})

kbHandle('kb:remove-anchor', (payload) => {
  const idErr = kbCheckString(payload?.id, 'id', { required: true, max: 100 })
  if (idErr) return { ok: false, error: idErr }
  kbStore.kbRemoveAnchor(payload.id)
  return { ok: true }
})

/* ---- 作者记忆 ---- */

kbHandle('kb:list-memories', () => ({ ok: true, memories: kbStore.kbListMemories() }))

kbHandle('kb:create-memory', (payload) => {
  const p = payload && typeof payload === 'object' ? payload : {}
  const errs = [
    kbCheckString(p.type, 'type', { required: true, max: 50, oneOf: kbStore.MEMORY_TYPES }),
    kbCheckString(p.content, 'content', { required: true, max: 2000 }),
    kbCheckString(p.source, 'source', { max: 50, oneOf: kbStore.MEMORY_SOURCES }),
    kbCheckBoolean(p.pinned, 'pinned')
  ].filter(Boolean)
  if (errs.length) return { ok: false, error: errs[0] }
  return {
    ok: true,
    memory: kbStore.kbCreateMemory({
      type: p.type,
      content: p.content.trim(),
      source: p.source ?? 'manual',
      pinned: p.pinned === true
    })
  }
})

kbHandle('kb:update-memory', (payload) => {
  const p = payload && typeof payload === 'object' ? payload : {}
  const idErr = kbCheckString(p.id, 'id', { required: true, max: 100 })
  if (idErr) return { ok: false, error: idErr }
  const patch = p.patch && typeof p.patch === 'object' ? p.patch : {}
  const errs = [
    kbCheckString(patch.type, 'type', { max: 50, oneOf: kbStore.MEMORY_TYPES }),
    kbCheckString(patch.content, 'content', { max: 2000 }),
    kbCheckBoolean(patch.pinned, 'pinned')
  ].filter(Boolean)
  if (errs.length) return { ok: false, error: errs[0] }
  const memory = kbStore.kbUpdateMemory(p.id, patch)
  if (!memory) return { ok: false, error: '记忆不存在或已被删除' }
  return { ok: true, memory }
})

kbHandle('kb:remove-memory', (payload) => {
  const idErr = kbCheckString(payload?.id, 'id', { required: true, max: 100 })
  if (idErr) return { ok: false, error: idErr }
  kbStore.kbRemoveMemory(payload.id)
  return { ok: true }
})

kbHandle('kb:reset-memories', () => {
  kbStore.kbResetMemories()
  return { ok: true }
})

kbHandle('kb:export-memories', () => {
  const memories = kbStore.kbListMemories()
  return {
    ok: true,
    json: JSON.stringify({ kind: 'novelflow.kb.memories', version: 1, memories }, null, 2)
  }
})

kbHandle('kb:import-memories', (payload) => {
  const jsonErr = kbCheckString(payload?.json, 'json', { required: true, max: 5000000 })
  if (jsonErr) return { ok: false, error: jsonErr }
  let data
  try {
    data = JSON.parse(payload.json)
  } catch {
    return { ok: false, error: '导入内容不是合法 JSON' }
  }
  const list = Array.isArray(data) ? data : data?.memories
  if (!Array.isArray(list)) return { ok: false, error: '导入内容里找不到记忆数组' }
  let imported = 0
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    if (typeof raw.content !== 'string' || !raw.content.trim()) continue
    kbStore.kbCreateMemory({
      type: kbStore.MEMORY_TYPES.includes(raw.type) ? raw.type : 'fact',
      content: raw.content.trim().slice(0, 2000),
      source: kbStore.MEMORY_SOURCES.includes(raw.source) ? raw.source : 'manual',
      pinned: raw.pinned === true
    })
    imported += 1
  }
  return { ok: true, imported }
})

/* ---- 偏好 ---- */

kbHandle('kb:get-preferences', () => ({ ok: true, preferences: kbStore.kbGetPreferences() }))

kbHandle('kb:set-preference', (payload) => {
  const p = payload && typeof payload === 'object' ? payload : {}
  const keyErr = kbCheckString(p.key, 'key', { required: true, max: 100, oneOf: KB_PREF_KEYS })
  if (keyErr) return { ok: false, error: keyErr }
  const valueErr = kbCheckString(p.value, 'value', { required: true, max: 20000 })
  if (valueErr) return { ok: false, error: valueErr }
  // 开关类只接受 'true' / 'false'；工作背景与 embedding 两键是自由文本
  if (!KB_PREF_TEXT_KEYS.includes(p.key) && p.value !== 'true' && p.value !== 'false') {
    return { ok: false, error: '开关值只能是 true / false' }
  }
  // embedding 端点多一道本机强校验：偏好是渲染层可写的，环回校验必须落在写入侧，
  // 否则「先存一个外网地址、再由建索引时拒绝」会让用户看到莫名其妙的失败
  if (p.key === 'pref.embedding_base_url') {
    const localError = checkLocalEmbedding(p.value)
    if (localError) return { ok: false, error: localError }
  }
  if (p.key === 'pref.embedding_model' && !p.value.trim()) {
    return { ok: false, error: 'embedding 模型名不能为空' }
  }
  kbStore.kbSetPreference(p.key, p.value)
  return { ok: true }
})

/* ---- 工作过程事件 ---- */

kbHandle('kb:list-events', (payload) => {
  const limit = Number.isFinite(payload?.limit) ? Math.min(Math.max(1, payload.limit), 500) : 100
  return { ok: true, events: kbStore.kbListEvents(limit) }
})

kbHandle('kb:log-event', (payload) => {
  const p = payload && typeof payload === 'object' ? payload : {}
  const errs = [
    kbCheckString(p.kind, 'kind', { required: true, max: 50 }),
    kbCheckString(p.refId, 'refId', { max: 100 }),
    kbCheckString(p.summary, 'summary', { required: true, max: 200 })
  ].filter(Boolean)
  if (errs.length) return { ok: false, error: errs[0] }
  kbStore.kbLogEvent(p.kind, p.refId ?? null, p.summary)
  return { ok: true }
})

kbHandle('kb:curate', () => ({ ok: true, report: kbStore.kbCurateEvents() }))

/* ---- 全量导出 / 导入 ---- */

kbHandle('kb:export-all', () => ({ ok: true, json: kbStore.kbExportAll() }))

kbHandle('kb:import-all', (payload) => {
  const jsonErr = kbCheckString(payload?.json, 'json', { required: true, max: 50000000 })
  if (jsonErr) return { ok: false, error: jsonErr }
  let data
  try {
    data = JSON.parse(payload.json)
  } catch {
    return { ok: false, error: '导入内容不是合法 JSON' }
  }
  const counts = kbStore.kbImportAll(data)
  return { ok: true, ...counts }
})

/* ---- 语义检索（向量索引；无本地 embedding 时**明说**降级到关键词） ---- */

/** 语义检索默认返回条数 / 上限 */
const VEC_SEARCH_DEFAULT_LIMIT = 10
const VEC_SEARCH_MAX_LIMIT = 50
/** 默认相似度下限：低于这个分数的块基本是噪声，不如直接落到关键词 */
const VEC_SEARCH_DEFAULT_MIN_SCORE = 0.2
/** 索引为空时的降级提示 */
const VEC_EMPTY_NOTICE = '语义索引为空（尚未建立本地 embedding 索引）'

/** 数字夹取：IPC 传来的可能是 NaN / 越界值，一律收进合法区间 */
function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * 尝试一次语义检索。**永不抛异常**：返回 `{ok:true, hits}` 或 `{ok:false, reason}`，
 * 由调用方决定「给向量结果」还是「明说降级到关键词」。
 */
async function tryVectorSearch(query, limit, minScore, refTypes) {
  try {
    await vecStore.initVecStore()
  } catch (err) {
    return { ok: false, reason: `语义索引不可用（${err?.message || String(err)}）` }
  }
  if (!vecStore.isVecReady()) return { ok: false, reason: '语义索引不可用' }
  if (vecStore.count() === 0) return { ok: false, reason: VEC_EMPTY_NOTICE }

  const localError = checkLocalEmbedding(getEmbeddingConfig().baseUrl)
  if (localError) return { ok: false, reason: localError }

  let vectors
  try {
    vectors = await embedTexts([query])
  } catch (err) {
    return { ok: false, reason: `本地 embedding 服务未响应（${normalizeFetchError(err)}）` }
  }
  // 多取一些再按 refId 去重：同一条目可能有多块命中，只留最好的那块
  const hits = vecStore.searchTopK(new Float32Array(vectors[0]), {
    k: limit * 3,
    minScore,
    refTypes
  })
  if (!hits.length) return { ok: false, reason: '语义索引里没有相似度达标的块' }
  return { ok: true, hits }
}

kbHandle('kb:semantic-search', async (payload) => {
  const p = payload && typeof payload === 'object' ? payload : {}
  const qErr = kbCheckString(p.query, 'query', { required: true, max: 200 })
  if (qErr) return { ok: false, error: qErr }
  const query = String(p.query).trim()
  const limit = Math.trunc(clampNumber(p.limit, 1, VEC_SEARCH_MAX_LIMIT, VEC_SEARCH_DEFAULT_LIMIT))
  const minScore = clampNumber(p.minScore, -1, 1, VEC_SEARCH_DEFAULT_MIN_SCORE)
  const refTypes = Array.isArray(p.refTypes)
    ? p.refTypes.filter((t) => vecStore.REF_TYPES.includes(t))
    : null

  const vec = await tryVectorSearch(query, limit, minScore, refTypes)
  if (vec.ok) {
    const entries = []
    const docs = []
    const seenEntries = new Set()
    const seenDocs = new Set()
    for (const hit of vec.hits) {
      if (hit.refType === 'entry') {
        if (seenEntries.has(hit.refId)) continue
        // 条目可能已被删除而向量还没清：跳过而不是抛错（检索永远不该炸）
        const entry = kbStore.kbGetEntry(hit.refId)
        if (!entry) continue
        seenEntries.add(hit.refId)
        entries.push(entry)
        if (entries.length >= limit) break
      } else if (hit.refType === 'doc') {
        if (seenDocs.has(hit.refId) || docs.length >= limit) continue
        const doc = kbStore.kbGetDoc(hit.refId)
        if (!doc) continue
        seenDocs.add(hit.refId)
        // 只回 id / 标题 / 分数：正文要另外 docGet（向量库不冗余正文，省一半磁盘）
        docs.push({ id: doc.id, title: doc.title, score: Number(hit.score.toFixed(4)) })
      }
    }
    return { ok: true, mode: 'vector', entries, docs }
  }

  // 降级：**明说**这是关键词结果，绝不伪造向量分数。
  // 理由（调查报告最强的一条负面建议）：哈希 / 关键词产出的「假向量」与语义
  // embedding 不在同一向量空间，混进余弦只会让分数变成噪声，看起来有分其实
  // 是随机排序 —— 宁可降级，也不要伪装成语义。
  return {
    ok: true,
    mode: 'keyword',
    notice: `${vec.reason}，当前为关键词检索结果`,
    entries: kbStore.kbSearchEntries(query, limit),
    docs: []
  }
})

/**
 * 重建索引的运行态。**后台跑而非 await**：一次全量重建在本地 CPU 上可能要
 * 几分钟，而 MCP → 渲染层的 invokeRenderer 有 30s 超时，抱着等必然超时。
 * 所以这里只「点火」并立刻回报，进度走 kb:index-status 轮询。
 */
let rebuildJob = null
/** 最近一次重建的结果快照：UI 要展示「上次重建」而不是只看到「进行中」 */
let lastRebuildReport = null

kbHandle('kb:index-status', async () => {
  // 索引库起不来也要能看状态：失败按空索引报，让 UI 有东西可显示
  try {
    await vecStore.initVecStore()
  } catch {
    /* 状态通道永不因初始化失败而炸 */
  }
  const cfg = getEmbeddingConfig()
  const localError = checkLocalEmbedding(cfg.baseUrl)
  const modelInfo = vecStore.describeModel()
  return {
    ok: true,
    ready: vecStore.isVecReady(),
    total: vecStore.count(),
    byRefType: vecStore.countByRefType(),
    model: modelInfo.model,
    dim: modelInfo.dim,
    lastBuiltAt: vecStore.lastUpdatedAt(),
    building: !!rebuildJob,
    progress: rebuildJob ? { ...rebuildJob } : null,
    lastRebuild: lastRebuildReport ? { ...lastRebuildReport } : null,
    embedding: {
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      // 只回「是否通过本机校验」与中文原因：apiKey 绝不回传渲染层
      ready: !localError,
      error: localError ?? ''
    }
  }
})

kbHandle('kb:rebuild-index', async (payload) => {
  const p = payload && typeof payload === 'object' ? payload : {}
  if (rebuildJob) return { ok: false, error: '重建索引正在进行中，请稍后查看状态' }
  if (!kbStore.isKbReady()) return { ok: false, error: '知识库尚未就绪，请稍候重试' }
  const localError = checkLocalEmbedding(getEmbeddingConfig().baseUrl)
  if (localError) return { ok: false, error: localError }
  if (p.full === true) {
    // 手动整库重建：先清空（换模型后旧向量不可比，必须全丢）
    try {
      await vecStore.initVecStore()
      vecStore.clearAll()
    } catch {
      /* 清空失败不阻断：下面增量流程照跑 */
    }
  }
  void runRebuildIndex()
  return { ok: true, started: true }
})

/** 后台重建：增量（内容没变的块不重新 embedding）+ 失败不清库 */
async function runRebuildIndex() {
  const cfg = getEmbeddingConfig()
  rebuildJob = {
    startedAt: Date.now(),
    scanned: 0,
    indexed: 0,
    skipped: 0,
    failed: 0,
    capped: false,
    error: ''
  }
  try {
    await vecStore.initVecStore()

    /* 1) 收集待索引来源：知识条目 + 文档（记忆太短，整体语义最强，不切块入库） */
    const sources = []
    for (const entry of kbStore.kbListEntries()) {
      sources.push({ refType: 'entry', refId: entry.id, text: `标题：${entry.title}\n${entry.content ?? ''}` })
    }
    for (const doc of kbStore.kbListDocs()) {
      const full = kbStore.kbGetDoc(doc.id)
      if (!full) continue
      sources.push({ refType: 'doc', refId: full.id, text: `标题：${full.title}\n${full.content ?? ''}` })
    }

    /* 2) 清孤儿：主库已删、向量库还在的行 */
    const alive = new Set(sources.map((s) => `${s.refType}:${s.refId}`))
    for (const ref of vecStore.listRefs()) {
      if (!alive.has(`${ref.refType}:${ref.refId}`)) vecStore.clearForRef(ref.refType, ref.refId)
    }

    /* 3) 切块 + 按 contentHash 判重，只把「新增 / 变过」的块送进 embedding */
    const pending = []
    for (const source of sources) {
      if (pending.length >= VEC_REBUILD_MAX_CHUNKS) {
        rebuildJob.capped = true
        break
      }
      const chunks = vecStore.chunkText(source.text)
      const existing = vecStore.getRefIndex(source.refType, source.refId)
      // 块数变少（文档被删章节）：删掉多出来的尾巴
      if (chunks.length < existing.size) vecStore.trimRefFrom(source.refType, source.refId, chunks.length)
      for (let i = 0; i < chunks.length; i += 1) {
        if (pending.length >= VEC_REBUILD_MAX_CHUNKS) {
          rebuildJob.capped = true
          break
        }
        rebuildJob.scanned += 1
        const hash = vecStore.contentHash(chunks[i])
        const prev = existing.get(i)
        // 内容没变 + 还是同一个模型 → 跳过（换模型则整块重算，因为向量空间不可比）
        if (prev && prev.contentHash === hash && prev.model === cfg.model) {
          rebuildJob.skipped += 1
          continue
        }
        pending.push({
          refType: source.refType,
          refId: source.refId,
          chunkIndex: i,
          contentHash: hash,
          text: chunks[i]
        })
      }
    }

    /* 4) 分批 embedding：串行（本地服务并发反而更慢），失败只丢这一批之后的部分 */
    for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
      const batch = pending.slice(i, i + EMBED_BATCH_SIZE)
      let vectors
      try {
        vectors = await embedTexts(batch.map((b) => b.text))
      } catch (err) {
        // 服务中断：已建好的块保留，缺口下次重建再补（**失败不清库**）
        rebuildJob.failed += batch.length
        rebuildJob.error = normalizeFetchError(err)
        break
      }
      const dim = vectors[0]?.length ?? 0
      vecStore.upsertChunks(
        batch.map((b, j) => ({
          ...b,
          model: cfg.model,
          dim,
          vec: new Float32Array(vectors[j])
        }))
      )
      rebuildJob.indexed += batch.length
    }

    // 收尾落盘一次：中途靠防抖，避免每批都重写几十 MB 文件
    vecStore.flushNow()
  } catch (err) {
    rebuildJob.error = err?.message || String(err) || '重建索引失败'
  } finally {
    rebuildJob.finishedAt = Date.now()
    lastRebuildReport = rebuildJob
    rebuildJob = null
  }
}

/* ------------------------------------------------------------------ */
/* MCP：stdio 桥接实例（--mcp）与 GUI 实例的本地控制服务器                            */
/* ------------------------------------------------------------------ */

/** 唤醒用的默认 spawn：打包态直接跑 exe；开发态带上 main.cjs 与 --dev */
function defaultSpawnGui() {
  const args = app.isPackaged
    ? []
    : [path.join(app.getAppPath(), 'electron', 'main.cjs'), '--dev']
  const child = require('node:child_process').spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
}

/**
 * --mcp 模式入口。stdout 只允许出现 JSON-RPC 帧（MCP 协议生死线），
 * 因此本模式下 console.log/info/warn/debug 全部改道 stderr。
 */
function startMcpStdioServer() {
  const toStderr = (...args) => process.stderr.write(args.map((a) => String(a)).join(' ') + '\n')
  for (const level of ['log', 'info', 'warn', 'debug']) {
    console[level] = toStderr
  }

  const { createControlClient } = require('./mcp/control-client.cjs')
  const { createWaker } = require('./mcp/wake.cjs')
  const { createMcpServer } = require('./mcp/server.cjs')

  const logger = { log: toStderr, error: toStderr }
  const client = createControlClient({ userDataDir: app.getPath('userData'), logger })
  const waker = createWaker({ client, spawnGui: defaultSpawnGui, logger })
  const server = createMcpServer({
    stdin: process.stdin,
    stdout: process.stdout,
    client,
    waker,
    logger,
    version: app.getVersion()
  })
  server.start()

  // MCP 客户端断开管道（关会话 / 杀进程）→ 桥接实例退场，GUI 实例不受影响
  const bye = () => app.exit(0)
  process.stdin.on('end', bye)
  process.stdin.on('close', bye)
  process.stdin.on('error', bye)
}

/* ---- GUI 实例：本地控制服务器（MCP 数据通路） ---- */

let controlServer = null
/** callId → { resolve, timer }：渲染层回包的中转表 */
const mcpPending = new Map()

function startControlServer() {
  const { createControlServer } = require('./control-server.cjs')
  controlServer = createControlServer({
    userDataDir: app.getPath('userData'),
    version: app.getVersion(),
    invoke: (method, params) => invokeRenderer(method, params),
    focus: focusMainWindow,
    logger: console
  })
  controlServer.start().catch((err) => console.error('[mcp] 控制服务器启动失败', err))
}

function stopControlServer() {
  if (!controlServer) return
  try {
    controlServer.stop()
  } catch {
    /* 退出路径容错 */
  }
  controlServer = null
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** 控制服务器 → 渲染层：发 mcp:invoke，等 mcp:result 回包（30s 超时） */
function invokeRenderer(method, params) {
  return new Promise((resolve) => {
    const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null
    if (!wc || wc.isLoading()) {
      resolve({ ok: false, error: '主程序界面尚未就绪，请稍候重试' })
      return
    }
    const callId = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const timer = setTimeout(() => {
      mcpPending.delete(callId)
      resolve({ ok: false, error: '渲染层响应超时（30 秒），请重试' })
    }, 30_000)
    mcpPending.set(callId, { resolve, timer })
    wc.send('mcp:invoke', { callId, method, params })
  })
}

ipcMain.on('mcp:result', (_event, payload) => {
  const callId = payload?.callId
  const pending = mcpPending.get(callId)
  if (!pending) return
  clearTimeout(pending.timer)
  mcpPending.delete(callId)
  pending.resolve(payload?.result)
})

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

app.on('second-instance', () => {
  // 窗口可能已「关闭」到托盘里（隐藏态），这时只有 focusMainWindow 的 show 能把它带回前台
  focusMainWindow()
})

// 所有退出路径的公共前哨：越早置位越好，保证上面那些 close 拦截不会被卡住
app.on('before-quit', () => {
  app.isQuitting = true
  // 第三处强制 flush（before-quit / session-end / quit 三处全覆盖）
  flushKbSafe()
})

// Windows 关机 / 注销 / 重启：系统发的是 WM_QUERYENDSESSION，不一定走 before-quit，
// 若不在这里放开，close 的 preventDefault 会让 Windows 判定「本应用阻止你关机」。
// 所以把这条当作 before-quit 之外的第二道放行闸。
app.on('session-end', () => {
  app.isQuitting = true
  // 关机放行闸 = 最后的安全网：db 此刻必须落盘（session-end 不一定还有后续 quit）
  flushKbSafe()
})

/**
 * 知识库强制落盘（退出路径专用）。
 * sql.js 是全量导出式持久化，防抖窗口里没来得及写的内容靠这里补；
 * 落盘失败（磁盘满等）只记日志，绝不禁退出流程。
 */
function flushKbSafe() {
  try {
    kbStore.flushNow()
  } catch (err) {
    console.error('[kb] 强制落盘失败：', err?.message ?? String(err))
  }
  // 向量库同样要在退出前补一次落盘（它是独立 db 文件，防抖窗口里可能有
  // 刚建完的索引）。失败同样只记日志：向量可由内容重算，绝不挡退出。
  try {
    vecStore.flushNow()
  } catch (err) {
    console.error('[vec] 强制落盘失败：', err?.message ?? String(err))
  }
}

app.whenReady().then(() => {
  if (MCP_MODE) {
    startMcpStdioServer()
    return
  }
  if (!HAS_SINGLE_INSTANCE_LOCK) {
    // 让位实例早退（2026-10-17 实测修复）：app.quit() 在 ready 前调用会被 Electron
    // 推迟，whenReady 回调仍会完整跑完——若不在此拦截，让位实例会建窗并启动控制
    // 服务器，把 userData/control.json 覆盖成自己（随即退出）的死进程信息，
    // 主实例的接入文件被污染，MCP 桥接随即连不上真正存活的主程序。
    app.exit(0)
    return
  }
  setupGrsaiProxy()
  setupAutoUpdater()
  createWindow()
  // 知识库数据库（sql.js）：只挂 GUI 分支 —— MCP_MODE 桥接实例在上面已早退，
  // 它是个无窗口 stdio 进程，不碰业务数据。初始化失败不阻塞窗口：
  // 面板打开时会再见到错误提示，主界面照常可用。
  void kbStore.initKbStore().catch((err) =>
    console.error('[kb] 数据库初始化失败：', err?.message ?? String(err))
  )
  startControlServer()

  app.on('activate', () => {
    // macOS 关窗后点 dock 图标重建窗口
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('quit', () => {
  // 数据安全第一：先 flush 知识库，再停控制服务器 / 销毁托盘
  flushKbSafe()
  stopControlServer()
  // 必须显式 destroy：不销毁的话部分 Windows 环境里进程退出后托盘图标会残留在通知区，
  // 要等鼠标划过才消失。destroy 本身可能抛（托盘已被系统回收），不能让它挡住退出流程。
  try {
    tray?.destroy()
  } catch {
    /* 销毁失败无需阻塞退出 */
  }
  tray = null
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
