<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { StoryNode } from '@/types/graph'
import {
  Modal as AModal,
  Button as AButton,
  RadioGroup as ARadioGroup,
  RadioButton as ARadioButton,
  Select as ASelect,
  SelectOption as ASelectOption,
  Progress as AProgress,
  Image as AImage,
  Tag as ATag,
  Input,
  message
} from 'ant-design-vue'
import {
  ASPECT_RATIOS,
  IMAGE_STYLES,
  PROVIDER_LIST,
  STYLE_LIST,
  buildStoryPrompt,
  type AspectRatio,
  type ImageProvider,
  type ImageSize,
  type ImageStyleKey
} from '@/api/aiImage'
import { useGrsai } from '@/composables/useGrsai'
import { image as aiImage } from '@/api/aiClient'
import { useAiStore } from '@/stores/useAiStore'
import { describeImageResult } from '@/core/aiPrompt'

/**
 * AI 生图弹窗
 *
 * 流程：展示节点摘要 → 可编辑 prompt → 选风格 / 比例 → 生成（进度条带中文状态）
 *      → 结果网格可多选 → 「应用到节点」（只把远端 URL 存进节点）。
 *
 * 视觉：跟随暗色外壳（不用 antd 默认白底弹窗），圆角、克制的阴影、青金点缀。
 */

const props = defineProps<{
  /** 是否显示（v-model:open） */
  open: boolean
  /** 目标节点 */
  node: StoryNode | null
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'applied', url: string): void
}>()

const ATextarea = Input.TextArea

const { loading, error, percent, progressText, queue, generate, applyToNode, clear } = useGrsai()

const ai = useAiStore()

const styleKey = ref<ImageStyleKey>('anime')
const aspectRatio = ref<AspectRatio>('16:9')
const imageSize = ref<ImageSize>('1K')
const count = ref<number>(1)
const prompt = ref('')
const selected = ref<string[]>([])

/** 两条链路的结果统一收在这里：旧 grsai 直连 与 新「模型管理里的生图模型」 */
const generated = ref<string[]>([])
const aiBusy = ref(false)
const aiError = ref('')
const busy = computed(() => loading.value || aiBusy.value)
const activeError = computed(() => aiError.value || error.value)

/** 生图通道：`model:<id>` 走统一模型管理`（含内置 grsai）`，`legacy:<provider>` 走旧直连链路作为兜底 */
const channel = ref('')
const channelOptions = computed<Array<{ value: string; label: string; modelId?: string; provider?: ImageProvider }>>(() => {
  const list: Array<{ value: string; label: string; modelId?: string; provider?: ImageProvider }> = []
  for (const m of ai.imageModels) {
    list.push({ value: `model:${m.id}`, label: m.builtin ? `${m.name}（内置）` : m.name, modelId: m.id })
  }
  for (const p of PROVIDER_LIST) {
    list.push({ value: `legacy:${p.key}`, label: `${p.label}（旧直连）`, provider: p.key })
  }
  return list
})

/** 打开弹窗时拉一次模型列表（可能刚在模型管理里改过） */
watch(
  () => props.open,
  (open) => {
    if (open) {
      void ai.refresh()
    }
  },
  { immediate: true }
)

/** 默认选中「统一管理里激活的生图模型」；用户手选过就尊重手选 */
watch(
  channelOptions,
  (options) => {
    if (!options.length) return
    const active = ai.activeIds.image
    const preferred = active ? `model:${active}` : options[0].value
    if (!options.some((o) => o.value === channel.value)) channel.value = preferred
  },
  { immediate: true }
)

watch(
  () => ai.activeIds.image,
  (id) => {
    if (id && channelOptions.value.some((o) => o.value === `model:${id}`)) channel.value = `model:${id}`
  }
)

/** OpenAI 兼容生图的 size 参数（grsai 由主进程换算成比例）；'auto' 不传，交给模型自己定 */
const SIZE_BY_RATIO: Partial<Record<AspectRatio, string>> = {
  '1:1': '1024x1024',
  '16:9': '1536x864',
  '9:16': '864x1536',
  '4:3': '1184x864'
}

/** 节点变化时按节点内容重新组装默认提示词（用户随后可自由编辑） */
watch(
  () => props.node?.id,
  () => {
    clear()
    generated.value = []
    aiError.value = ''
    selected.value = []
    if (props.node) {
      prompt.value = buildStoryPrompt(props.node, styleKey.value)
    }
  },
  { immediate: true }
)

/** 切换风格时保留用户已改写的部分：只在 prompt 仍是「自动生成版本」时才重算 */
watch(styleKey, (next, prev) => {
  if (!props.node) return
  const autoPrev = buildStoryPrompt(props.node, prev)
  const autoNext = buildStoryPrompt(props.node, next)
  if (!prompt.value.trim() || prompt.value.trim() === autoPrev.trim()) {
    prompt.value = autoNext
  }
  // 顺带把比例切到该风格的推荐值
  aspectRatio.value = IMAGE_STYLES[next].aspectRatio
})

const canGenerate = computed(() => !!props.node && prompt.value.trim().length > 0 && !busy.value)
const nodeSummary = computed(() => {
  const n = props.node
  if (!n) return ''
  return [n.summary, n.location, n.characters.join('、')].filter(Boolean).join(' · ')
})

async function handleGenerate(): Promise<void> {
  if (!props.node) return
  selected.value = []
  generated.value = []
  aiError.value = ''
  const option = channelOptions.value.find((o) => o.value === channel.value)

  // 新链路：走统一模型管理（含内置 grsai），由主进程代发，密钥不出渲染层
  if (option?.modelId) {
    aiBusy.value = true
    try {
      const size = SIZE_BY_RATIO[aspectRatio.value]
      const result = await aiImage({
        modelId: option.modelId,
        prompt: prompt.value,
        size,
        n: count.value
      })
      if (result?.ok && result.urls?.length) {
        generated.value = result.urls
        selected.value = [result.urls[0]]
      } else {
        aiError.value = describeImageResult(result ?? { ok: false })
      }
    } catch (e) {
      aiError.value = e instanceof Error ? e.message : String(e)
    } finally {
      aiBusy.value = false
    }
    if (aiError.value) message.error(aiError.value)
    return
  }

  // 旧链路兜底：渲染层直连 grsai（浏览器 dev 也走得通）
  clear()
  const urls = await generate({
    prompt: prompt.value,
    aspectRatio: aspectRatio.value,
    imageSize: imageSize.value,
    provider: option?.provider,
    count: count.value
  })
  generated.value = urls
  if (urls.length) selected.value = [urls[0]]
  if (error.value) message.error(error.value)
}

function toggleSelect(url: string): void {
  const index = selected.value.indexOf(url)
  if (index >= 0) selected.value.splice(index, 1)
  else selected.value.push(url)
}

/** 应用到节点：只存远端 URL，不转 base64（避免撑爆 localStorage） */
function handleApply(): void {
  if (!props.node) return
  if (!selected.value.length) {
    message.warning('请先选择一张图')
    return
  }
  const url = selected.value[0]
  if (applyToNode(props.node.id, url, prompt.value)) {
    message.success('已应用到节点')
    emit('applied', url)
    emit('update:open', false)
  } else {
    message.error(activeError.value || '应用失败')
  }
}

function handleClose(): void {
  emit('update:open', false)
}
</script>

<template>
  <AModal
    :open="props.open"
    title="AI 生图"
    :width="760"
    :mask-closable="!busy"
    :closable="!busy"
    :footer="null"
    wrap-class-name="nf-ai-modal"
    @cancel="handleClose"
  >
    <div class="nf-ai">
      <!-- 节点摘要 -->
      <section class="nf-ai__brief">
        <div class="nf-ai__brief-title">{{ props.node?.title || '未选择节点' }}</div>
        <div class="nf-ai__brief-sub">{{ nodeSummary || '这个节点还没有摘要，可在右侧检查器补充' }}</div>
      </section>

      <!-- 提示词 -->
      <section class="nf-ai__block">
        <label class="nf-ai__label">画面描述</label>
        <ATextarea
          v-model:value="prompt"
          :rows="4"
          placeholder="描述你想看到的画面：人物、动作、光线、氛围…"
          class="nf-ai__textarea"
        />
        <div class="nf-ai__hint">提示词会自动带上节点标题 / 摘要 / 人物 / 地点，可随意改写</div>
      </section>

      <!-- 风格与比例 -->
      <section class="nf-ai__block">
        <label class="nf-ai__label">风格</label>
        <ARadioGroup v-model:value="styleKey" button-style="solid" size="small">
          <ARadioButton v-for="item in STYLE_LIST" :key="item.key" :value="item.key">
            {{ item.label }}
          </ARadioButton>
        </ARadioGroup>
      </section>

      <section class="nf-ai__row">
        <div>
          <label class="nf-ai__label">生图通道</label>
          <ASelect v-model:value="channel" size="small" class="nf-ai__channel">
            <ASelectOption v-for="o in channelOptions" :key="o.value" :value="o.value">
              {{ o.label }}
            </ASelectOption>
          </ASelect>
          <div v-if="!ai.imageModels.length" class="nf-ai__hint">
            还没有纳入统一管理的生图模型，可在顶栏「模型管理」里添加（当前走旧直连链路）
          </div>
        </div>
        <div>
          <label class="nf-ai__label">比例</label>
          <ARadioGroup v-model:value="aspectRatio" button-style="solid" size="small">
            <ARadioButton v-for="r in ASPECT_RATIOS" :key="r" :value="r">{{ r }}</ARadioButton>
          </ARadioGroup>
        </div>
        <div>
          <label class="nf-ai__label">张数</label>
          <ARadioGroup v-model:value="count" button-style="solid" size="small">
            <ARadioButton :value="1">1 张</ARadioButton>
            <ARadioButton :value="2">2 张</ARadioButton>
            <ARadioButton :value="3">3 张</ARadioButton>
          </ARadioGroup>
        </div>
      </section>

      <!-- 进度 -->
      <section v-if="busy || activeError" class="nf-ai__progress">
        <AProgress :percent="percent" :status="activeError ? 'exception' : 'active'" size="small" />
        <div class="nf-ai__progress-text">
          {{ activeError || progressText }}
          <span v-if="queue.pending > 0" class="nf-ai__queue">
            队列 {{ queue.running }}/{{ queue.limit }} 占用中
          </span>
        </div>
      </section>

      <!-- 结果网格 -->
      <section v-if="generated.length" class="nf-ai__results">
        <label class="nf-ai__label">生成结果（点击选择）</label>
        <div class="nf-ai__grid">
          <div
            v-for="url in generated"
            :key="url"
            class="nf-ai__cell"
            :class="{ 'is-selected': selected.includes(url) }"
            @click="toggleSelect(url)"
          >
            <AImage :src="url" :preview="false" class="nf-ai__img" />
            <ATag v-if="selected.includes(url)" color="cyan" class="nf-ai__badge">已选</ATag>
          </div>
        </div>
      </section>

      <!-- 操作 -->
      <footer class="nf-ai__footer">
        <AButton :disabled="!canGenerate" type="primary" :loading="busy" @click="handleGenerate">
          {{ busy ? '生成中…' : '开始生成' }}
        </AButton>
        <AButton :disabled="!selected.length || busy" @click="handleApply">应用到节点</AButton>
        <AButton type="text" @click="handleClose">关闭</AButton>
      </footer>
    </div>
  </AModal>
</template>

<style scoped>
.nf-ai {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.nf-ai__brief {
  padding: 14px 16px;
  border-radius: 14px;
  background: linear-gradient(180deg, rgba(77, 208, 217, 0.1), rgba(77, 208, 217, 0.03));
  border: 1px solid rgba(77, 208, 217, 0.22);
}

.nf-ai__brief-title {
  font-size: 15px;
  font-weight: 600;
  color: #e8eef3;
  letter-spacing: 0.01em;
}

.nf-ai__brief-sub {
  margin-top: 4px;
  font-size: 12.5px;
  line-height: 1.6;
  color: #93a1ae;
}

.nf-ai__block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.nf-ai__row {
  display: flex;
  gap: 28px;
  flex-wrap: wrap;
}

.nf-ai__label {
  font-size: 11px;
  letter-spacing: 0.08em;
  color: #7c8a97;
}

.nf-ai__hint {
  font-size: 11.5px;
  color: #6f7d8a;
}

.nf-ai__channel {
  min-width: 190px;
}
.nf-ai__row .nf-ai__hint {
  margin-top: 6px;
  max-width: 220px;
  line-height: 1.6;
}

.nf-ai__textarea {
  font-size: 13px;
  line-height: 1.7;
}

.nf-ai__progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.nf-ai__progress-text {
  font-size: 12px;
  color: #93a1ae;
  display: flex;
  gap: 10px;
  align-items: center;
}

.nf-ai__queue {
  color: #6f7d8a;
}

.nf-ai__results {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.nf-ai__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
}

.nf-ai__cell {
  position: relative;
  border-radius: 14px;
  overflow: hidden;
  cursor: pointer;
  border: 1px solid rgba(255, 255, 255, 0.08);
  transition: transform 150ms cubic-bezier(0.2, 0, 0, 1), box-shadow 150ms cubic-bezier(0.2, 0, 0, 1);
}

.nf-ai__cell:hover {
  transform: translateY(-2px);
}

.nf-ai__cell.is-selected {
  border-color: #4dd0d9;
  box-shadow: 0 0 0 1px rgba(77, 208, 217, 0.5), 0 8px 24px rgba(77, 208, 217, 0.16);
}

.nf-ai__img {
  display: block;
  width: 100%;
}

.nf-ai__badge {
  position: absolute;
  top: 8px;
  right: 8px;
}

.nf-ai__footer {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  padding-top: 4px;
}
</style>

<style>
/* antd 弹窗默认是白底亮色面板，这里整体改成暗色外壳观感 */
.nf-ai-modal .ant-modal-content {
  background: #131c26;
  border-radius: 18px;
  box-shadow: 0 1px 2px rgba(5, 8, 11, 0.4), 0 18px 48px rgba(5, 8, 11, 0.45);
  padding: 20px 22px;
}

.nf-ai-modal .ant-modal-header {
  background: transparent;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  padding-bottom: 14px;
}

.nf-ai-modal .ant-modal-title {
  color: #e8eef3;
  font-weight: 600;
}

.nf-ai-modal .ant-modal-close-x {
  color: #93a1ae;
}

.nf-ai-modal textarea,
.nf-ai-modal .ant-input {
  background: #0f1720;
  border-color: #24323f;
  color: #e8eef3;
}

.nf-ai-modal .ant-radio-button-wrapper {
  background: #0f1720;
  border-color: #24323f;
  color: #a7b4c0;
}

.nf-ai-modal .ant-radio-button-wrapper-checked {
  background: #4dd0d9;
  border-color: #4dd0d9;
  color: #0b1218;
}
</style>
