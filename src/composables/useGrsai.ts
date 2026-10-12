import { computed, ref } from 'vue'
import {
  MAX_CONCURRENT,
  drawSemaphore,
  generateImages,
  type AspectRatio,
  type GenerateProgress,
  type ImageProvider,
  type ImageSize,
  type ImageStyleKey
} from '@/api/aiImage'
import { api as novelFlow } from '@/api/aiApi'

/**
 * useGrsai —— 把 grsai 生图能力包装成 Vue 响应式状态
 *
 * 组件只关心三件事：进度文案、结果列表、出错原因；
 * 并发控制 / 重试 / 轮询全部留在 @/api/aiImage 里，这里不做任何策略决策。
 */

export interface GenerateInput {
  prompt: string
  style?: ImageStyleKey
  aspectRatio?: AspectRatio
  imageSize?: ImageSize
  /** 生图通道：默认 nano-banana，可切到预留的 gpt-image-2.5 */
  provider?: ImageProvider
  /** 一次生成几张（串行提交，仍受全局并发上限保护） */
  count?: number
}

export function useGrsai() {
  const loading = ref(false)
  const error = ref('')
  const results = ref<string[]>([])
  const progress = ref<GenerateProgress | null>(null)

  /** 进度条百分比：排队 / 提交阶段给一个「在动」的下限值，避免进度条卡在 0 */
  const percent = computed<number>(() => {
    const p = progress.value
    if (!p) return 0
    if (p.stage === 'done') return 100
    if (typeof p.percent === 'number') return Math.min(99, Math.max(2, p.percent))
    if (p.stage === 'queued') return 6
    if (p.stage === 'submitting') return 12
    return 30
  })

  /** 直接展示给用户的中文进度文案 */
  const progressText = computed<string>(() => {
    const p = progress.value
    if (!p) return ''
    switch (p.stage) {
      case 'queued': {
        const total = p.queueTotal ?? MAX_CONCURRENT
        return `排队中 ${p.queuePos ?? 1}/${Math.max(total, MAX_CONCURRENT)}`
      }
      case 'submitting':
        return '提交生成任务…'
      case 'running':
        return typeof p.percent === 'number' ? `生成中 ${p.percent}%` : '生成中…'
      case 'retrying':
        return p.message ?? '生成失败，准备重试…'
      case 'done':
        return '生成完成'
      case 'error':
        return p.message ?? '生成失败'
      default:
        return ''
    }
  })

  /** 全局队列快照：running / pending，用于界面提示「当前有几张在跑」 */
  const queue = computed(() => ({
    running: drawSemaphore.running,
    pending: drawSemaphore.pending,
    limit: MAX_CONCURRENT
  }))

  /**
   * 触发生成。count > 1 时串行提交多张（并发仍被信号量压在 3 以内）。
   * 失败只写 error，不抛异常 —— 弹窗要能继续用。
   */
  async function generate(input: GenerateInput): Promise<string[]> {
    error.value = ''
    if (!input.prompt || !input.prompt.trim()) {
      error.value = '请先填写画面描述'
      return []
    }
    loading.value = true
    const produced: string[] = []
    const count = Math.max(1, Math.min(4, input.count ?? 1))
    try {
      for (let i = 0; i < count; i++) {
        // 并发已满时先给一句排队提示，避免界面看起来「点了没反应」
        if (drawSemaphore.running >= MAX_CONCURRENT) {
          const pos = drawSemaphore.pending + 1
          const total = Math.max(drawSemaphore.running + drawSemaphore.pending, MAX_CONCURRENT)
          progress.value = {
            stage: 'queued',
            queuePos: pos,
            queueTotal: total,
            message: `排队中 ${pos}/${total}`
          }
        }
        // 提示词已由 buildStoryPrompt 拼好（含风格前缀），这里只负责提交与轮询
        const urls = await generateImages({
          prompt: input.prompt,
          aspectRatio: input.aspectRatio,
          imageSize: input.imageSize,
          provider: input.provider,
          onProgress: (p) => {
            progress.value = p
          }
        })
        produced.push(...urls)
        results.value.push(...urls)
      }
      return produced
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return produced
    } finally {
      loading.value = false
    }
  }

  /** 把某张图应用到节点：走 AI API 的 setNodeImage（只存远端 URL） */
  function applyToNode(nodeId: string, url: string, prompt?: string): boolean {
    const result = novelFlow.setNodeImage(nodeId, url, prompt)
    if (!result.ok) {
      error.value = result.error ?? '应用图片失败'
      return false
    }
    return true
  }

  function clear(): void {
    results.value = []
    progress.value = null
    error.value = ''
  }

  return {
    loading,
    error,
    results,
    progress,
    percent,
    progressText,
    queue,
    generate,
    applyToNode,
    clear
  }
}
