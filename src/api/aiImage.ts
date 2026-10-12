import type { StoryNode } from '@/types/graph'

/**
 * grsai · Nano Banana 生图（走 Vite 代理 /api/grsai，前端绝不出现密钥）
 *
 * 三条硬性纪律（来自 grsai-nano-banana 技能的实测结论）：
 *  1. **并发上限 3**：同一账号同时 in-flight 的任务数 > 3 会被服务端直接判 failed，
 *     所以这里内置信号量队列，超出的排队而不是硬闯。
 *  2. **失败必须重试**：单张失败按指数退避最多重试 5 次（并发超限 / 风控都是偶发的，重试通常能过）。
 *  3. **轮询取结果**：webHook 传 "-1"，提交后拿 data.id 轮询 /v1/draw/result，
 *     轮询间隔 3s、总超时 240s。
 *
 * 代理由 Vite dev server 配置（vite.config.ts，Max-A 负责），
 * 服务端注入 Authorization，因此本文件里没有任何密钥。
 *
 * 通道抽象：默认 provider = 'nano-banana'（已实测的 /v1/draw/nano-banana + 轮询）。
 * 另预留 'gpt-image-2.5'（/v1/api/generate，body 含 replyType:"json"，返回 {id,status,results:[{url}]}），
 * 通过 GenerateOptions.provider 切换，两条通道走同一套信号量 / 重试 / 轮询骨架。
 */

/** 基地址：Vite 代理前缀（路径透传，不在此改写） */
export const GRSAI_BASE = '/api/grsai'
/** 同一账号同时生成上限（实测硬限制，不要改大） */
export const MAX_CONCURRENT = 3
/** 轮询间隔 */
export const POLL_INTERVAL = 3000
/** 单张轮询总超时 */
export const POLL_TIMEOUT = 240_000
/** 单张最大重试次数（不含首次提交） */
export const MAX_RETRY = 5
/** 默认模型：nano-banana（高质量）在 grsai 后台常被直接判 failed，fast 更稳 */
export const DEFAULT_MODEL = 'nano-banana-fast'

/* ------------------------------------------------------------------ */
/* 风格 / 比例                                                         */
/* ------------------------------------------------------------------ */

export type ImageStyleKey = 'anime' | 'realistic' | 'ink' | 'cyber'

export interface ImageStyle {
  key: ImageStyleKey
  label: string
  /** 拼在 prompt 最前面的风格前缀 */
  prefix: string
  /** 该风格推荐的比例 */
  aspectRatio: AspectRatio
  /** 该风格推荐的画质档 */
  imageSize: ImageSize
}

export const ASPECT_RATIOS = ['16:9', '1:1', '9:16', '4:3', 'auto'] as const
export type AspectRatio = (typeof ASPECT_RATIOS)[number]

export type ImageSize = '1K' | '2K' | '4K'

export const IMAGE_STYLES: Record<ImageStyleKey, ImageStyle> = {
  anime: {
    key: 'anime',
    label: '日系动漫',
    prefix: '日系动漫风格插画，干净线稿，柔和渐变上色，电影感构图，柔和自然光',
    aspectRatio: '16:9',
    imageSize: '1K'
  },
  realistic: {
    key: 'realistic',
    label: '写实厚涂',
    prefix: '写实厚涂数字绘画，细腻笔触，体积光与真实材质，电影级打光',
    aspectRatio: '16:9',
    imageSize: '1K'
  },
  ink: {
    key: 'ink',
    label: '水墨国风',
    prefix: '中国水墨国风，留白构图，淡彩渲染，宣纸质感，气韵生动',
    aspectRatio: '4:3',
    imageSize: '1K'
  },
  cyber: {
    key: 'cyber',
    label: '赛博霓虹',
    prefix: '赛博朋克场景，霓虹反射，冷暖对比强，雨后湿滑地面，电影感广角',
    aspectRatio: '16:9',
    imageSize: '1K'
  }
}

export const STYLE_LIST: ImageStyle[] = [
  IMAGE_STYLES.anime,
  IMAGE_STYLES.realistic,
  IMAGE_STYLES.ink,
  IMAGE_STYLES.cyber
]

/* ------------------------------------------------------------------ */
/* prompt 组装                                                         */
/* ------------------------------------------------------------------ */

export interface BuildPromptOptions {
  style?: ImageStyleKey
  /** 用户额外补充的描述，拼在最后 */
  extra?: string
}

/**
 * 依据节点内容组装生图提示词。
 * 默认「动漫風格、电影感构图、柔和光」，再叠加标题 / 摘要 / 人物 / 地点 / 时间。
 * 顺序刻意固定（风格 → 场景 → 人物 → 地点 → 时间），保证同一节点反复生成时描述稳定。
 */
export function buildStoryPrompt(
  node: Pick<
    StoryNode,
    'title' | 'summary' | 'characters' | 'location' | 'timeLabel'
  >,
  style: ImageStyleKey = 'anime',
  options: BuildPromptOptions = {}
): string {
  const preset = IMAGE_STYLES[options.style ?? style] ?? IMAGE_STYLES.anime
  const parts: string[] = [preset.prefix]

  const title = (node.title ?? '').trim()
  if (title) parts.push(`画面主题：${title}`)

  const summary = (node.summary ?? '').trim()
  if (summary) parts.push(`情节：${summary}`)

  const cast = (node.characters ?? []).filter(Boolean)
  if (cast.length) parts.push(`出场人物：${cast.join('、')}`)

  const location = (node.location ?? '').trim()
  if (location) parts.push(`地点：${location}`)

  const time = (node.timeLabel ?? '').trim()
  if (time) parts.push(`故事时间：${time}`)

  parts.push('画面叙事感强，人物情绪明确，构图有层次，不要出现文字与水印')

  const extra = (options.extra ?? '').trim()
  if (extra) parts.push(extra)

  return parts.join('。') + '。'
}

/* ------------------------------------------------------------------ */
/* 并发信号量                                                          */
/* ------------------------------------------------------------------ */

/**
 * 计数信号量：把并发压在 MAX_CONCURRENT 以内。
 * 超出的任务在队列里等待，槽位一空立刻补上 —— 这正是「跑完一张再派发下一张」的语义。
 */
export class Semaphore {
  private active = 0
  private waiting: Array<() => void> = []

  constructor(private readonly limit: number = MAX_CONCURRENT) {}

  /** 当前正在跑的任务数 */
  get running(): number {
    return this.active
  }

  /** 还在排队等槽位的任务数 */
  get pending(): number {
    return this.waiting.length
  }

  /** 占用一个槽位，返回释放函数（必须调用，且只能调用一次） */
  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve)
      })
    }
    this.active += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
      const next = this.waiting.shift()
      if (next) next()
    }
  }
}

/** 全局共享的信号量：整个应用所有生图请求都走它 */
export const drawSemaphore = new Semaphore(MAX_CONCURRENT)

/* ------------------------------------------------------------------ */
/* 通道抽象（provider）                                                */
/* ------------------------------------------------------------------ */

export type ImageProvider = 'nano-banana' | 'gpt-image-2.5'

export const DEFAULT_PROVIDER: ImageProvider = 'nano-banana'

export const PROVIDER_LIST: { key: ImageProvider; label: string; defaultModel: string }[] = [
  { key: 'nano-banana', label: 'Nano Banana', defaultModel: DEFAULT_MODEL },
  { key: 'gpt-image-2.5', label: 'GPT-Image 2.5', defaultModel: 'gpt-image-2.5' }
]

/** 提交 / 轮询 / 响应归一化：每条通道各自的协议差异收在这里 */
interface ProviderSpec {
  submitPath: string
  resultPath: string
  buildSubmitBody(input: DrawInput): Record<string, unknown>
  buildResultBody(id: string): Record<string, unknown>
  /** 把各通道响应收成统一的 {code,msg,status,...}，status 取自 data 或顶层皆可 */
  normalize(json: RawResponse): NormalizedStatus
}

export interface DrawInput {
  model: string
  prompt: string
  aspectRatio: AspectRatio
  imageSize: ImageSize
  webHook: string
}

interface RawResponse {
  code?: number
  msg?: string
  id?: string
  data?: {
    id?: string
    status?: string
    progress?: number
    results?: Array<{ url?: string }>
    failure_reason?: string
  }
  status?: string
  progress?: number
  results?: Array<{ url?: string }>
  failure_reason?: string
}

interface NormalizedStatus {
  code?: number
  msg?: string
  status?: string
  progress?: number
  results?: Array<{ url?: string }>
  failure_reason?: string
}

const PROVIDERS: Record<ImageProvider, ProviderSpec> = {
  // 已实测：/v1/draw/nano-banana 提交，/v1/draw/result 轮询，任务状态在 data 里
  'nano-banana': {
    submitPath: '/v1/draw/nano-banana',
    resultPath: '/v1/draw/result',
    buildSubmitBody: (input) => ({
      model: input.model,
      prompt: input.prompt,
      aspectRatio: input.aspectRatio,
      imageSize: input.imageSize,
      webHook: input.webHook
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
  },
  // 预留：/v1/api/generate 一次返回 {id,status,results:[{url}]}，replyType 要求 json
  'gpt-image-2.5': {
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

/* ------------------------------------------------------------------ */
/* 错误码语义映射（关键：别把 -22 / -1 误读成余额不足）                 */
/* ------------------------------------------------------------------ */

/**
 * 把 grsai 的业务错误码翻译成对用户有指导意义的中文。
 * 重要：
 *  - code -22（result not exist）= 任务不存在 / 已过期，**不是**余额不足 → 重新生成即可；
 *  - code -1（apikey error）= 用的是「仪表盘用户中心 32 位令牌」不是 API Key，
 *    真正的 Key 以 sk- 开头，要去控制台 API Key 页复制。
 * 因此这里**绝不包含**「余额不足 / 请充值」之类基于错误判断的提示。
 */
export function describeApiError(code: number, msg?: string): string {
  if (code === -22) {
    return '任务不存在或已过期，请重新生成（错误码 -22）'
  }
  if (code === -1) {
    return 'API Key 无效（错误码 -1）——仪表盘用户中心显示的 32 位令牌不是 API Key，真正的 Key 以 sk- 开头，请在控制台 API Key 页复制'
  }
  return `生图接口返回错误 码 ${code}${msg ? `：${msg}` : ''}`
}

/* ------------------------------------------------------------------ */
/* 接口                                                                */
/* ------------------------------------------------------------------ */

export interface DrawTaskStatus {
  status?: string
  progress?: number
  results?: Array<{ url?: string; content?: string }>
  failure_reason?: string
}

/** 提交生成任务，返回任务 id（已按 error 码语义映射） */
export async function submitDraw(input: {
  provider?: ImageProvider
  model: string
  prompt: string
  aspectRatio: AspectRatio
  imageSize: ImageSize
  webHook?: string
}): Promise<string> {
  const provider = PROVIDERS[input.provider ?? DEFAULT_PROVIDER]
  const body = provider.buildSubmitBody({
    model: input.model,
    prompt: input.prompt,
    aspectRatio: input.aspectRatio,
    imageSize: input.imageSize,
    webHook: input.webHook ?? '-1'
  })
  const response = await fetch(`${GRSAI_BASE}${provider.submitPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!response.ok) {
    throw new Error(`生图提交失败：HTTP ${response.status}`)
  }
  const json = (await response.json()) as RawResponse
  if (typeof json.code === 'number' && json.code !== 0) {
    throw new Error(describeApiError(json.code, json.msg))
  }
  const id = json.data?.id ?? json.id
  if (!id) throw new Error('生图提交失败：响应里没有任务 id')
  return id
}

/** 查询一次任务状态（已按 error 码语义映射） */
export async function queryDraw(id: string, provider?: ImageProvider): Promise<DrawTaskStatus> {
  const spec = PROVIDERS[provider ?? DEFAULT_PROVIDER]
  const response = await fetch(`${GRSAI_BASE}${spec.resultPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec.buildResultBody(id))
  })
  if (!response.ok) {
    throw new Error(`查询生图结果失败：HTTP ${response.status}`)
  }
  const json = (await response.json()) as RawResponse
  if (typeof json.code === 'number' && json.code !== 0) {
    throw new Error(describeApiError(json.code, json.msg))
  }
  const n = spec.normalize(json)
  return {
    status: n.status,
    progress: n.progress,
    results: n.results as DrawTaskStatus['results'],
    failure_reason: n.failure_reason
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* ------------------------------------------------------------------ */
/* 进度回调                                                            */
/* ------------------------------------------------------------------ */

export type GenerateStage = 'queued' | 'submitting' | 'running' | 'retrying' | 'done' | 'error'

export interface GenerateProgress {
  stage: GenerateStage
  /** 排队位次（从 1 开始）与队列总长度，用于「排队中 2/3」 */
  queuePos?: number
  queueTotal?: number
  /** 0–100 */
  percent?: number
  /** 可直接展示给用户的文案 */
  message?: string
  /** 第几次尝试（从 1 开始） */
  attempt?: number
}

export type ProgressHandler = (progress: GenerateProgress) => void

export interface GenerateOptions {
  prompt: string
  aspectRatio?: AspectRatio
  imageSize?: ImageSize
  model?: string
  provider?: ImageProvider
  onProgress?: ProgressHandler
  /** 轮询间隔，默认 3s */
  pollInterval?: number
  /** 单张总超时，默认 240s */
  timeout?: number
  /** 最大重试次数，默认 5 */
  maxRetry?: number
  /** 外部注入的信号量（测试用） */
  semaphore?: Semaphore
}

/**
 * 生成一张（一批）图片，返回全部图片直链。
 *
 * 内部：取信号量槽位 → 提交 → 轮询 → 失败则退避重试，最多 MAX_RETRY 次。
 * 抛错时机：重试全部失败后才抛，让调用方能明确知道「这张图没生成出来」。
 */
export async function generateImages(options: GenerateOptions): Promise<string[]> {
  const {
    prompt,
    aspectRatio = '16:9',
    imageSize = '1K',
    onProgress,
    pollInterval = POLL_INTERVAL,
    timeout = POLL_TIMEOUT,
    maxRetry = MAX_RETRY,
    semaphore = drawSemaphore
  } = options

  const provider = options.provider ?? DEFAULT_PROVIDER
  const model = options.model ?? PROVIDER_LIST.find((p) => p.key === provider)?.defaultModel ?? DEFAULT_MODEL

  if (!prompt || !prompt.trim()) {
    throw new Error('生图失败：prompt 不能为空')
  }

  const release = await semaphore.acquire()
  const queueTotal = semaphore.running + semaphore.pending
  try {
    for (let attempt = 1; attempt <= maxRetry + 1; attempt++) {
      try {
        onProgress?.({
          stage: 'submitting',
          attempt,
          percent: 2,
          message: attempt === 1 ? '提交生成任务…' : `第 ${attempt} 次提交…`
        })
        const id = await submitDraw({
          provider,
          model,
          prompt,
          aspectRatio,
          imageSize,
          webHook: '-1'
        })
        const urls = await pollUntilDone(id, {
          pollInterval,
          timeout,
          onProgress,
          queueTotal,
          provider
        })
        onProgress?.({ stage: 'done', percent: 100, message: '生成完成' })
        return urls
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        if (attempt > maxRetry) {
          onProgress?.({ stage: 'error', attempt, message })
          throw new Error(`生图失败（已重试 ${maxRetry} 次）：${message}`)
        }
        // 指数退避：5s / 10s / 20s …，给服务端限流窗口留出恢复时间
        const delay = Math.min(5000 * 2 ** (attempt - 1), 60_000)
        onProgress?.({
          stage: 'retrying',
          attempt,
          message: `生成失败，${Math.round(delay / 1000)}s 后重试（${attempt}/${maxRetry}）：${message}`
        })
        await sleep(delay)
      }
    }
    throw new Error('生图失败：未知原因')
  } finally {
    release()
  }
}

/** 轮询直到 succeeded / failed */
async function pollUntilDone(
  id: string,
  opts: {
    pollInterval: number
    timeout: number
    onProgress?: ProgressHandler
    queueTotal?: number
    provider?: ImageProvider
  }
): Promise<string[]> {
  const started = Date.now()
  while (true) {
    const data = await queryDraw(id, opts.provider)
    const status = (data.status ?? '').toLowerCase()
    const percent = typeof data.progress === 'number' ? data.progress : undefined

    if (status === 'succeeded' || status === 'success') {
      const urls = (data.results ?? [])
        .map((item) => item?.url)
        .filter((url): url is string => typeof url === 'string' && url.length > 0)
      if (!urls.length) throw new Error('生图任务已完成，但结果里没有可用的图片地址')
      return urls
    }
    if (status === 'failed' || status === 'error') {
      throw new Error(data.failure_reason || '生图任务被服务端判定失败（可能是并发超限或提示词命中风控）')
    }
    if (Date.now() - started > opts.timeout) {
      throw new Error(`生图超时：${Math.round(opts.timeout / 1000)}s 内未完成`)
    }
    opts.onProgress?.({
      stage: 'running',
      percent: typeof percent === 'number' ? Math.max(5, percent) : undefined,
      queueTotal: opts.queueTotal,
      message: typeof percent === 'number' ? `生成中 ${percent}%` : '生成中…'
    })
    await sleep(opts.pollInterval)
  }
}

/**
 * 便捷入口：只取第一张图。
 * 适合「一键给节点配图」的场景。
 */
export async function generateImage(options: GenerateOptions): Promise<string> {
  const urls = await generateImages(options)
  return urls[0]
}
