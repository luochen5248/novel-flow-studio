import type { StoryNode } from '@/types/graph'
import type {
  ChatMessage,
  ImageResult,
  ModelConfig,
  ModelProtocol,
  TestResult
} from '@/types/ai'

/**
 * AI 助手的**纯逻辑层**（提示词 / 插入落点 / 响应归一化 / 配置校验脱敏）。
 *
 * 为什么放这里：项目测试约定只覆盖 `src/core/**` 与 `src/export/**`，
 * 而这几件事恰好全是「入参出参都是普通数据」的纯计算 —— 抽到 core 后
 * 提示词改写、插入位置、错误翻译都能被单测逐条断言，不需要挂 Electron 或 Pinia。
 *
 * 本文件**不碰网络、不碰 store、不碰 DOM**；调用方：
 *   - src/composables/useAiAssist.ts（提示词 + 插入落点）
 *   - src/components/common/AiModelDialog.vue（配置校验 + 脱敏 + 供应商预设）
 *   - src/api/aiClient.ts（响应归一化兜底）
 */

/* ================================================================== */
/* 一、供应商预设                                                       */
/* ================================================================== */

export interface ProviderPreset {
  key: string
  label: string
  protocol: ModelProtocol
  baseUrl: string
  /** 该端点的典型可用模型名（用户可改） */
  model: string
}

/**
 * 供应商预设：只做「填表加速器」，选完仍可任意改写地址与模型名。
 * 全部走 OpenAI 兼容协议（含本机 Ollama），grsai 是唯一的私有协议（提交+轮询）。
 */
export const AI_PROVIDER_PRESETS: ProviderPreset[] = [
  { key: 'openai', label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { key: 'deepseek', label: 'DeepSeek 深度求索', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { key: 'qwen', label: '阿里通义千问', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { key: 'zhipu', label: '智谱 BigModel', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { key: 'moonshot', label: 'Moonshot 月之暗面', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { key: 'siliconflow', label: '硅基流动', protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
  { key: 'ollama', label: 'Ollama（本机）', protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
  { key: 'grsai', label: 'grsai（内置生图）', protocol: 'grsai', baseUrl: 'https://grsai.dakka.com.cn', model: 'nano-banana-fast' },
  { key: 'custom', label: '自定义 / 其它兼容端点', protocol: 'openai', baseUrl: '', model: '' }
]

export const DEFAULT_PRESET_KEY = 'openai'

export function findPreset(key: string): ProviderPreset | undefined {
  return AI_PROVIDER_PRESETS.find((p) => p.key === key)
}

/* ================================================================== */
/* 二、配置校验与脱敏（密钥永不以明文离开主进程）                        */
/* ================================================================== */

export interface ValidationResult {
  ok: boolean
  /** 出错字段名，供表单定位 */
  field?: string
  message?: string
}

/** 去掉结尾斜杠与空白，避免拼出 `https://x//chat/completions` */
export function normalizeBaseUrl(url?: string | null): string {
  return (url ?? '').trim().replace(/\/+$/, '')
}

export interface ValidateOptions {
  /** 是否要求填写 API Key。编辑已配置过的模型时传 false（留空 = 保留原值） */
  requireKey?: boolean
}

/**
 * 模型配置校验。
 *
 * 只做「本地就能判断」的检查（必填 / 协议 / 地址格式），不通网络 ——
 * 端点是否真的可用由主进程 `ai:test-model` 负责，两者错误信息不混。
 */
export function validateModelConfig(
  cfg: Partial<ModelConfig> | null | undefined,
  options: ValidateOptions = {}
): ValidationResult {
  if (!cfg) return { ok: false, field: 'name', message: '请先填写模型配置' }

  if (!(cfg.name ?? '').trim()) return { ok: false, field: 'name', message: '请给这个模型起个名字' }
  if (cfg.type !== 'llm' && cfg.type !== 'image') {
    return { ok: false, field: 'type', message: '请选择模型用途：文本 / 生图' }
  }
  if (cfg.protocol !== 'openai' && cfg.protocol !== 'grsai') {
    return { ok: false, field: 'protocol', message: '请选择接口协议' }
  }

  const baseUrl = normalizeBaseUrl(cfg.baseUrl)
  if (!baseUrl) return { ok: false, field: 'baseUrl', message: '请填写接口地址' }
  if (!/^https?:\/\/\S+/i.test(baseUrl)) {
    return { ok: false, field: 'baseUrl', message: '接口地址需以 http:// 或 https:// 开头' }
  }

  if (!(cfg.model ?? '').trim()) return { ok: false, field: 'model', message: '请填写模型名称' }

  // 内置模型沿用主进程既有密钥（旧 grsai），渲染层拿不到也不该要求再填一次
  const requireKey = options.requireKey !== false && cfg.builtin !== true
  if (requireKey && !(cfg.apiKey ?? '').trim()) {
    return { ok: false, field: 'apiKey', message: '请填写 API Key' }
  }

  return { ok: true }
}

export interface HeaderParseResult {
  ok: boolean
  headers?: Record<string, string>
  error?: string
}

/** 高级配置里的自定义请求头：JSON 对象形态，例如 `{"X-Title":"NovelFlow"}` */
export function parseHeaderJson(text?: string | null): HeaderParseResult {
  const raw = (text ?? '').trim()
  if (!raw) return { ok: true, headers: undefined }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: '请求头需是 JSON 对象，例如 {"X-Title":"NovelFlow"}' }
    }
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === undefined || value === null) continue
      headers[key] = String(value)
    }
    return { ok: true, headers }
  } catch {
    return { ok: false, error: '请求头不是合法 JSON' }
  }
}

/* ================================================================== */
/* 三、编辑器上下文（前后节点）                                          */
/* ================================================================== */

export interface AssistNeighbor {
  title?: string
  summary?: string
}

export interface AssistNeighbors {
  prev?: AssistNeighbor
  next?: AssistNeighbor
}

/**
 * 取同一条时间线上的前后节点（lane → order 排序后的一前一后）。
 *
 * 给模型的上下文里带上前后各一段，是为了让它续写时不至于把已经写死的后续情节推翻。
 * 纯函数只依赖传入的 nodes 数组，方便单测。
 */
export function pickNeighbors(nodes: StoryNode[], nodeId: string): AssistNeighbors {
  const list = [...nodes].sort(
    (a, b) => a.lane - b.lane || a.order - b.order || (a.id < b.id ? -1 : 1)
  )
  const index = list.findIndex((n) => n.id === nodeId)
  if (index < 0) return {}
  const slim = (n: StoryNode | undefined): AssistNeighbor | undefined =>
    n ? { title: n.title, summary: n.summary } : undefined
  return { prev: slim(list[index - 1]), next: slim(list[index + 1]) }
}

/* ================================================================== */
/* 四、提示词组装                                                       */
/* ================================================================== */

export type AssistMode = 'research' | 'continue' | 'polish'

export const ASSIST_MODE_LABEL: Record<AssistMode, string> = {
  research: '查找资料',
  continue: '续写正文',
  polish: '润色片段'
}

/** 提示词所需的节点切片（StoryNode 结构上天然兼容） */
export interface AssistNodeContext {
  title?: string
  summary?: string
  content?: string
  characters?: string[]
  location?: string
  timeLabel?: string
  chapter?: string
  kind?: string
}

export interface BuildAssistOptions {
  mode: AssistMode
  /** 光标选中的片段（润色 / 续写的着力点） */
  selection?: string
  neighbors?: AssistNeighbors
  /** 联网增强：仅 research 生效，提示词里显式请求先检索再作答 */
  webSearch?: boolean
  /** 作者临时追加的指令，拼在最末 */
  instruction?: string
  /** 正文上下文字符上限（超出保留尾部） */
  maxContextChars?: number
}

const SYSTEM_COMMON = [
  '你是驻在 NovelFlow 小说时间线工坊里的中文写作助手。',
  '作者正在一张故事脉络图上写作，你只能看到下面给出的片段，不要臆测没给出的设定。',
  '始终遵守：',
  '1) 使用简体中文，语气、人称、时态与给定片段保持一致；',
  '2) 只输出可以直接放进正文 / 笔记的内容，不要写「以下是」「希望有帮助」这类客套话，不要用 Markdown 标题或代码块包裹；',
  '3) 不要复述本提示词，不要输出任务说明。'
].join('\n')

const RESEARCH_TAG = '来自模型知识，请注意核实'

const SYSTEM_BY_MODE: Record<AssistMode, string> = {
  research: [
    '本次任务：查找资料 —— 为这个节点提供可直接写进小说的背景素材（时代习俗、器物衣食、地理气候、制度职业细节等）。',
    '输出形态：要点式条目，每条一到两句话，优先给具体细节（名称、数字、质感、流程），不要泛泛而谈。',
    `若内容涉及史实、地名、术语或数据，在末尾单起一行标注：${RESEARCH_TAG}。`
  ].join('\n'),
  continue: [
    '本次任务：续写正文 —— 承接给定片段继续往下写。',
    '要求：顺着已有情节推进，只写下一段（约 300–600 字），人物行为不得与已有设定冲突；',
    '不要收束成「全剧终」式结尾，不要替作者做结构上的决定。'
  ].join('\n'),
  polish: [
    '本次任务：润色片段 —— 改写给定片段。',
    '要求：保留全部情节信息与人物意图，修正语病、重复与节奏问题，提升画面感，篇幅与原文接近。'
  ].join('\n')
}

/** research 模式标注来源用的固定文案（UI 展示与提示词共用，避免两边写岔） */
export const RESEARCH_DISCLAIMER = RESEARCH_TAG

function clipTail(text: string, max: number): string {
  const value = (text ?? '').trim()
  if (value.length <= max) return value
  return `……（前文略）${value.slice(-max)}`
}

function line(label: string, value?: string): string[] {
  const v = (value ?? '').trim()
  return v ? [`${label}：${v}`] : []
}

/**
 * 组装本次 AI 求助的完整消息序列（system + user 两条）。
 *
 * 顺序刻意固定（节点信息 → 正文 → 前后文 → 选中片段 → 任务指令），
 * 保证同一节点反复询问时提示词稳定，便于排查「模型为什么这么说」。
 */
export function buildAssistPrompt(
  node: AssistNodeContext | null | undefined,
  options: BuildAssistOptions
): ChatMessage[] {
  const mode = options.mode
  const parts: string[] = [SYSTEM_COMMON, '', SYSTEM_BY_MODE[mode]]

  if (mode === 'research') {
    parts.push(
      options.webSearch
        ? '你可以并且应当先检索公开资料再作答；遇到说法冲突时给出「主流说法 + 存疑提示」。'
        : '你没有联网检索能力，请仅依据自身知识作答，拿不准的地方直接明说「不确定」。'
    )
  }

  const system = parts.join('\n')

  const blocks: string[] = []
  if (node) {
    const nodeLines: string[] = [
      ...line('标题', node.title),
      ...line('节点类型', node.kind),
      ...line('章节', node.chapter),
      ...line('故事内时间', node.timeLabel),
      ...line('地点', node.location),
      ...(node.characters?.filter(Boolean).length
        ? [`出场人物：${node.characters.filter(Boolean).join('、')}`]
        : []),
      ...line('摘要', node.summary)
    ]
    if (nodeLines.length) blocks.push(['## 当前节点', ...nodeLines].join('\n'))
  }

  const max = Math.max(200, options.maxContextChars ?? 2000)
  const content = clipTail(node?.content ?? '', max)
  if (content) blocks.push(`## 已有正文\n${content}`)

  const nb = options.neighbors
  if (nb?.prev?.title) {
    blocks.push(
      ['## 前一个节点（已发生）', `标题：${nb.prev.title}`, ...line('摘要', nb.prev.summary)].join('\n')
    )
  }
  if (nb?.next?.title) {
    blocks.push(
      ['## 后一个节点（后续走向）', `标题：${nb.next.title}`, ...line('摘要', nb.next.summary)].join('\n')
    )
  }

  const selection = (options.selection ?? '').trim()
  if (selection) {
    blocks.push(`## 光标选中的片段\n${clipTail(selection, max)}`)
  }

  const instruction = (options.instruction ?? '').trim()
  if (instruction) blocks.push(`## 作者的额外要求\n${instruction}`)

  const tail: Record<AssistMode, string> = {
    research: '请给出与上面这个节点直接相关的资料要点。',
    continue: selection ? '请从「光标选中的片段」末尾接着往下写。' : '请从「已有正文」末尾接着往下写。',
    polish: selection ? '请改写「光标选中的片段」。' : '请改写这段正文。'
  }
  blocks.push(tail[mode])

  return [
    { role: 'system', content: system },
    { role: 'user', content: blocks.join('\n\n') }
  ]
}

/* ================================================================== */
/* 五、插入落点计算                                                     */
/* ================================================================== */

export type InsertMode = 'replace' | 'append'

export interface InsertionResult {
  value: string
  /** 插入后光标应落到的位置（append 落在文末） */
  caretPos: number
}

/**
 * 把 AI 正文落进现有文本。
 *
 * - `replace`：替换 [selStart, selEnd) 这段选区（选区为空即「插在光标处」）；
 * - `append`：追加到文末 —— 原文非空且不以换行结尾时补一个换行，避免连成一段。
 *
 * 入参来自 DOM 的 selectionStart/End，所以这里一律先夹紧到 [0, length] 并纠正反序，
 * 越界也不会切出半个字符。
 */
export function applyInsertion(
  text: string,
  selStart: number,
  selEnd: number,
  insertion: string,
  mode: InsertMode = 'replace'
): InsertionResult {
  const base = typeof text === 'string' ? text : ''
  const last = base.length
  const clamp = (n: number, fallback: number): number => {
    if (typeof n !== 'number' || Number.isNaN(n)) return fallback
    return Math.min(Math.max(Math.trunc(n), 0), last)
  }
  let start = clamp(selStart, last)
  let end = clamp(selEnd, last)
  if (end < start) {
    const swap = start
    start = end
    end = swap
  }

  if (mode === 'append') {
    if (!base) return { value: insertion, caretPos: insertion.length }
    const value = base.endsWith('\n') ? base + insertion : `${base}\n${insertion}`
    return { value, caretPos: value.length }
  }

  const value = base.slice(0, start) + insertion + base.slice(end)
  return { value, caretPos: start + insertion.length }
}

/* ================================================================== */
/* 六、响应归一化（含中文错误翻译）                                      */
/* ================================================================== */

export interface ChatUsage {
  promptTokens?: number
  completionTokens?: number
}

export interface NormalizedChat {
  ok: boolean
  text?: string
  usage?: ChatUsage
  error?: string
}

export interface NormalizedImage {
  ok: boolean
  urls?: string[]
  error?: string
}

/** HTTP 状态码的中文解释（对标 aiImage.ts 的 describeApiError，但面向通用端点） */
export function describeHttpStatus(status?: number | null): string {
  switch (status) {
    case 400:
      return '请求被拒绝（400）：模型名或参数不被接受'
    case 401:
      return 'API Key 无效或缺失（401）'
    case 403:
      return '没有该模型的访问权限（403）'
    case 404:
      return '接口地址或模型不存在（404）'
    case 408:
      return '请求超时（408）'
    case 409:
      return '请求冲突（409）'
    case 422:
      return '参数不合规范（422）'
    case 429:
      return '触发限流或余额不足（429），请稍后再试'
    case 500:
      return '服务端内部错误（500）'
    case 502:
      return '网关错误（502）'
    case 503:
      return '服务暂时不可用（503）'
    case 504:
      return '服务端响应超时（504）'
    default:
      return typeof status === 'number' ? `请求失败（HTTP ${status}）` : '请求失败'
  }
}

function readNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
      return Number(value)
    }
  }
  return undefined
}

function readErrorMessage(payload: Record<string, unknown>): string | undefined {
  const raw = payload.error
  if (!raw) return undefined
  if (typeof raw === 'string') return raw.trim() || undefined
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    const code = typeof obj.code === 'string' || typeof obj.code === 'number' ? `（${obj.code}）` : ''
    const message =
      (typeof obj.message === 'string' && obj.message.trim()) ||
      (typeof obj.msg === 'string' && obj.msg.trim()) ||
      ''
    if (message) return `${message}${code}`
  }
  return '服务端返回了错误'
}

/** 兼容字符串、数组两种 content 形态（部分网关给 `[{type:'text',text:'…'}]`） */
function readChoiceText(choice: unknown): string {
  if (!choice || typeof choice !== 'object') return ''
  const record = choice as Record<string, unknown>
  const message = record.message
  if (message && typeof message === 'object') {
    const content = (message as Record<string, unknown>).content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === 'string') return item
          if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string') {
            return (item as Record<string, unknown>).text as string
          }
          return ''
        })
        .join('')
    }
  }
  if (typeof record.text === 'string') return record.text
  return ''
}

/**
 * OpenAI 兼容 chat.completions 响应 → 统一形态。
 * 主进程已经处理了大部分错误（已脱敏），这里只是第二道保险 + 补一层中文翻译。
 */
export function normalizeChatResponse(json: unknown): NormalizedChat {
  if (!json || typeof json !== 'object') {
    return { ok: false, error: '模型返回内容为空' }
  }
  const payload = json as Record<string, unknown>

  const errorMessage = readErrorMessage(payload)
  if (errorMessage) {
    const status = readNumber(payload, ['status', 'statusCode', 'code'])
    return { ok: false, error: typeof status === 'number' ? describeHttpStatus(status) : errorMessage }
  }

  let text = ''
  const choices = payload.choices
  if (Array.isArray(choices) && choices.length) {
    text = readChoiceText(choices[0])
  } else if (typeof payload.output_text === 'string') {
    text = payload.output_text
  }

  const usageSource =
    payload.usage && typeof payload.usage === 'object'
      ? (payload.usage as Record<string, unknown>)
      : payload
  const usage: ChatUsage = {
    promptTokens: readNumber(usageSource, ['prompt_tokens', 'input_tokens', 'promptTokens']),
    completionTokens: readNumber(usageSource, ['completion_tokens', 'output_tokens', 'completionTokens'])
  }

  if (!text.trim()) return { ok: false, error: '模型没有返回任何内容' }
  return { ok: true, text: text.trim(), usage }
}

/** images/generations 响应 → URL 列表（b64 就地转成 data URL） */
export function normalizeImageResponse(json: unknown): NormalizedImage {
  if (!json || typeof json !== 'object') return { ok: false, error: '生图返回内容为空' }
  const payload = json as Record<string, unknown>

  const errorMessage = readErrorMessage(payload)
  if (errorMessage) return { ok: false, error: errorMessage }

  const data = payload.data
  if (!Array.isArray(data) || !data.length) return { ok: false, error: '生图结果为空' }

  const urls: string[] = []
  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.url === 'string' && record.url) urls.push(record.url)
    else if (typeof record.b64_json === 'string' && record.b64_json) {
      urls.push(`data:image/png;base64,${record.b64_json}`)
    }
  }
  if (!urls.length) return { ok: false, error: '生图结果里没有可用图片' }
  return { ok: true, urls }
}

/** 测试连接结果的中文描述（UI 只显示这一句） */
export function describeTestResult(result: Pick<TestResult, 'ok' | 'latencyMs' | 'error'>): string {
  if (result.ok) {
    const ms = typeof result.latencyMs === 'number' ? `${result.latencyMs}ms` : '已连通'
    return `连接正常 · ${ms}`
  }
  return result.error || '连接失败'
}

/** 生图结果的中文描述，供弹窗提示复用（失败时只给一句人话） */
export function describeImageResult(result: Pick<ImageResult, 'ok' | 'error'>): string {
  if (result.ok) return ''
  return result.error || '生图失败，请检查模型配置'
}
