import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  hasAiBridge,
  listModels,
  removeModel,
  saveModel,
  setActive,
  testModel
} from '@/api/aiClient'
import type { ModelConfig, ModelView, TestResult } from '@/types/ai'

/**
 * 模型列表的**渲染层缓存**。
 *
 * 真实配置永远躺在主进程的 `userData/config.json`，这里只持有脱敏后的 `ModelView`
 * （`hasKey` / `keyHint`，没有 apiKey 字段）—— 所以任何 UI 都不可能在这里读到明文密钥。
 *
 * 为什么不用 `workspace.ui` 持久化：模型列表含激活项、地址、开关，全是非敏感数据，
 * 跟着 config.json 走即可保持单一事实源，避免两处状态打架（见调查 F15）。
 */

export type ActiveKind = 'llm' | 'image'

export const useAiStore = defineStore('ai', () => {
  /** 浏览器开发态为 false：UI 据此降级并提示「桌面端可用」 */
  const available = ref(hasAiBridge())
  const models = ref<ModelView[]>([])
  const activeIds = ref<{ llm: string | null; image: string | null }>({ llm: null, image: null })

  const loading = ref(false)
  const error = ref('')

  /** 测试连接的进行中与结果（仅内存，刷新列表不保留） */
  const testing = ref<Record<string, boolean>>({})
  const testResults = ref<Record<string, TestResult>>({})

  /** 当前是否有流正在写编辑器（同一时刻只允许一路，避免互相覆盖） */
  const streaming = ref(false)
  const activeRequestId = ref<string | null>(null)

  const llmModels = computed(() => models.value.filter((m) => m.type === 'llm'))
  const imageModels = computed(() => models.value.filter((m) => m.type === 'image'))

  const activeModel = (kind: ActiveKind): ModelView | null => {
    const id = activeIds.value[kind]
    if (!id) return null
    return models.value.find((m) => m.id === id && m.type === kind) ?? null
  }
  const activeLlm = computed(() => activeModel('llm'))
  const activeImage = computed(() => activeModel('image'))

  /** 可以直接开跑的前提：有可用模型且该模型被启用 */
  const llmReady = computed(() => !!activeLlm.value && activeLlm.value.enabled !== false)
  const imageReady = computed(() => !!activeImage.value && activeImage.value.enabled !== false)

  async function refresh(): Promise<void> {
    if (!available.value) return
    loading.value = true
    error.value = ''
    try {
      const payload = await listModels()
      models.value = payload.models
      activeIds.value = payload.activeIds
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  /** 保存成功立刻回拉一次列表（主进程可能注入 / 归一化了字段） */
  async function persistModel(config: ModelConfig): Promise<boolean> {
    error.value = ''
    try {
      await saveModel(config)
      await refresh()
      return true
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return false
    }
  }

  async function deleteModel(id: string): Promise<boolean> {
    error.value = ''
    try {
      await removeModel(id)
      await refresh()
      return true
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return false
    }
  }

  /**
   * 只改 enabled 这样的开关位：apiKey 留空交给主进程「空值 = 保留原值」语义，
   * 渲染层本来就看不到密钥，这样比要求用户重填一次合理得多。
   */
  function viewToConfig(view: ModelView, patch: Partial<ModelConfig> = {}): ModelConfig {
    return {
      id: view.id,
      name: view.name,
      type: view.type,
      protocol: view.protocol,
      baseUrl: view.baseUrl,
      apiKey: patch.apiKey ?? '',
      model: view.model,
      headers: patch.headers ?? view.headers,
      enabled: patch.enabled ?? view.enabled,
      webSearch: patch.webSearch ?? view.webSearch,
      builtin: view.builtin,
      createdAt: view.createdAt
    }
  }

  async function setEnabled(view: ModelView, enabled: boolean): Promise<boolean> {
    return await persistModel(viewToConfig(view, { enabled }))
  }

  async function setWebSearch(view: ModelView, webSearch: boolean): Promise<boolean> {
    return await persistModel(viewToConfig(view, { webSearch }))
  }

  async function activate(kind: ActiveKind, id: string | null): Promise<boolean> {
    error.value = ''
    try {
      await setActive(kind === 'llm' ? { llm: id } : { image: id })
      activeIds.value = { ...activeIds.value, [kind]: id }
      return true
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return false
    }
  }

  /** 测试连接：请求由主进程代发，这里只负责转圈与展示结果 */
  async function testConnection(config: ModelConfig): Promise<TestResult> {
    const id = config.id
    if (id) testing.value = { ...testing.value, [id]: true }
    try {
      const result = await testModel(config)
      if (id) testResults.value = { ...testResults.value, [id]: result }
      return result
    } finally {
      if (id) {
        const next = { ...testing.value }
        delete next[id]
        testing.value = next
      }
    }
  }

  function beginStream(requestId: string): void {
    streaming.value = true
    activeRequestId.value = requestId
  }

  function endStream(requestId?: string): void {
    // 带参核对：只有当前活跃请求才允许清理，防止第二路流误清 flag（M1 的幂等兜底）
    if (requestId && activeRequestId.value && activeRequestId.value !== requestId) return
    streaming.value = false
    activeRequestId.value = null
  }

  return {
    available,
    models,
    activeIds,
    loading,
    error,
    testing,
    testResults,
    streaming,
    activeRequestId,
    llmModels,
    imageModels,
    activeLlm,
    activeImage,
    llmReady,
    imageReady,
    viewToConfig,
    refresh,
    persistModel,
    deleteModel,
    setEnabled,
    setWebSearch,
    activate,
    testConnection,
    beginStream,
    endStream
  }
})
