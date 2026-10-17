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
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

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
  startControlServer()

  app.on('activate', () => {
    // macOS 关窗后点 dock 图标重建窗口
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('quit', () => {
  stopControlServer()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
