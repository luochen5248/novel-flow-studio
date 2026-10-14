<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  Modal as AModal,
  Button as AButton,
  Input as AInput,
  Select as ASelect,
  SelectOption as ASelectOption,
  Switch as ASwitch,
  Tag as ATag,
  Popconfirm as APopconfirm,
  Empty as AEmpty,
  InputPassword,
  message
} from 'ant-design-vue'
import type { ModelConfig, ModelProtocol, ModelType, ModelView } from '@/types/ai'
import { useAiStore } from '@/stores/useAiStore'
import { uid } from '@/core/id'
import {
  AI_PROVIDER_PRESETS,
  DEFAULT_PRESET_KEY,
  describeTestResult,
  findPreset,
  normalizeBaseUrl,
  parseHeaderJson,
  validateModelConfig
} from '@/core/aiPrompt'

/**
 * AiModelDialog —— 多模态模型管理（列表 / 添加 / 编辑 / 删除 / 测试连接 / 切换启用）
 *
 * 三条硬约束：
 *  1. **API Key 只进不出**：表单永远是空的输入框（已配置时只换占位符，对齐 GrsaiKeyDialog 的做法），
 *     列表里展示的是主进程回传的 keyHint；组件从不持有明文。
 *  2. **内置模型不可删除**（grsai 沿用了旧的 grsaiKey 配置，删了老用户就断供）。
 *  3. 所有请求走 aiClient → 主进程代发，这里没有任何 fetch。
 *
 * 触发方式与 GrsaiKeyDialog 完全一致：`defineExpose({ open })`，宿主 `ref + open()`。
 */

const store = useAiStore()

const visible = ref(false)
const formOpen = ref(false)
const editingId = ref<string | null>(null)
const busy = ref(false)
const formError = ref('')
const saved = ref(false)

const TYPE_LABEL: Record<ModelType, string> = { llm: '文本', image: '生图' }
const PROTOCOL_LABEL: Record<ModelProtocol, string> = { openai: 'OpenAI 兼容', grsai: 'grsai 私有' }

interface FormState {
  presetKey: string
  name: string
  type: ModelType
  protocol: ModelProtocol
  baseUrl: string
  apiKey: string
  model: string
  headersText: string
  enabled: boolean
  webSearch: boolean
}

function emptyForm(): FormState {
  const preset = findPreset(DEFAULT_PRESET_KEY)
  return {
    presetKey: DEFAULT_PRESET_KEY,
    name: '',
    type: 'llm',
    protocol: preset?.protocol ?? 'openai',
    baseUrl: preset?.baseUrl ?? '',
    apiKey: '',
    model: preset?.model ?? '',
    headersText: '',
    enabled: true,
    webSearch: false
  }
}

const form = ref<FormState>(emptyForm())

/** 编辑既有模型时手头没有明文密钥：留空 = 保留主进程里那份 */
const apiKeyPlaceholder = computed(() => {
  if (!editingId.value) return '粘贴服务商提供的 API Key'
  const current = store.models.find((m) => m.id === editingId.value)
  return current?.hasKey ? '已配置（输入新值可覆盖）' : '尚未配置，请粘贴 API Key'
})

const sortedModels = computed(() =>
  [...store.models].sort((a, b) => {
    if (!!b.builtin !== !!a.builtin) return b.builtin ? 1 : -1
    return a.createdAt - b.createdAt
  })
)

function isActive(view: ModelView): boolean {
  return store.activeIds[view.type] === view.id
}

/** 连接状态点：测试结果 > 是否启用 > 是否配了密钥 */
function dotClass(view: ModelView): string {
  const result = store.testResults[view.id]
  if (result) return result.ok ? 'is-ok' : 'is-bad'
  if (!!store.testing[view.id]) return 'is-testing'
  if (view.enabled === false) return 'is-off'
  return view.hasKey ? 'is-idle' : 'is-warn'
}

/** 状态点的悬浮说明（列表里不额外占一行） */
function dotTitle(view: ModelView): string {
  const result = store.testResults[view.id]
  if (result) return `连接测试：${describeTestResult(result)}`
  if (store.testing[view.id]) return '正在测试连接…'
  if (view.enabled === false) return '已停用'
  return view.hasKey ? '已配置密钥' : '尚未配置密钥'
}

function open(): Promise<void> | void {
  visible.value = true
  formOpen.value = false
  editingId.value = null
  formError.value = ''
  saved.value = false
  return store.refresh()
}

function close(): void {
  visible.value = false
}

function startCreate(): void {
  editingId.value = null
  form.value = emptyForm()
  formError.value = ''
  saved.value = false
  formOpen.value = true
}

function startEdit(view: ModelView): void {
  editingId.value = view.id
  form.value = {
    presetKey: findPresetByConfig(view) ?? 'custom',
    name: view.name,
    type: view.type,
    protocol: view.protocol,
    baseUrl: view.baseUrl,
    apiKey: '',
    model: view.model,
    headersText: view.headers ? JSON.stringify(view.headers, null, 2) : '',
    enabled: view.enabled !== false,
    webSearch: view.webSearch === true
  }
  formError.value = ''
  saved.value = false
  formOpen.value = true
}

/** 反查列表项落在哪个预设上（只为回填下拉的选中态） */
function findPresetByConfig(view: ModelView): string | null {
  const hit = AI_PROVIDER_PRESETS.find(
    (p) => p.protocol === view.protocol && normalizeBaseUrl(p.baseUrl) === normalizeBaseUrl(view.baseUrl)
  )
  return hit ? hit.key : null
}

function onPresetChange(key: string): void {
  const preset = findPreset(key)
  if (!preset) return
  form.value.presetKey = key
  form.value.protocol = preset.protocol
  form.value.baseUrl = preset.baseUrl
  if (preset.model) form.value.model = preset.model
  // 选到内置生图供应商时顺手把用途切到生图，少一步操作
  if (preset.protocol === 'grsai') form.value.type = 'image'
  if (!form.value.name && preset.key !== 'custom') form.value.name = preset.label
}

/** 表单 → 完整 ModelConfig（新建会给一个新 id，编辑沿用原 id） */
function buildConfig(): ModelConfig {
  const headers = parseHeaderJson(form.value.headersText)
  if (!headers.ok) {
    formError.value = headers.error ?? '自定义请求头格式有误'
    throw new Error(formError.value)
  }
  const current = editingId.value ? store.models.find((m) => m.id === editingId.value) : undefined
  return {
    id: editingId.value ?? uid('model'),
    name: form.value.name.trim(),
    type: form.value.type,
    protocol: form.value.protocol,
    baseUrl: normalizeBaseUrl(form.value.baseUrl),
    apiKey: form.value.apiKey.trim(),
    model: form.value.model.trim(),
    headers: headers.headers,
    enabled: form.value.enabled,
    webSearch: form.value.type === 'llm' ? form.value.webSearch : undefined,
    builtin: current?.builtin,
    // 编辑时沿用原 createdAt：否则每次改字段这条都会在列表里窜到最后创建的位置
    createdAt: current?.createdAt ?? Date.now()
  }
}

/** 新建必须带 Key；编辑已配过的可以留空（保留原值）；内置模型不强求 */
const requireKey = computed(() => {
  if (!editingId.value) return true
  const current = store.models.find((m) => m.id === editingId.value)
  if (current?.builtin) return false
  return current?.hasKey !== true
})

async function save(): Promise<void> {
  formError.value = ''
  let config: ModelConfig
  try {
    config = buildConfig()
  } catch {
    return
  }
  const check = validateModelConfig(config, { requireKey: requireKey.value })
  if (!check.ok) {
    formError.value = check.message ?? '模型配置不完整'
    return
  }
  busy.value = true
  const ok = await store.persistModel(config)
  busy.value = false
  if (!ok) {
    formError.value = store.error || '保存失败'
    return
  }
  saved.value = true
  message.success(editingId.value ? '模型已更新' : '模型已添加')
  if (!store.activeIds[config.type]) await store.activate(config.type, config.id)
  if (store.error) formError.value = store.error
}

async function testConnection(): Promise<void> {
  formError.value = ''
  let config: ModelConfig
  try {
    config = buildConfig()
  } catch {
    return
  }
  const check = validateModelConfig(config, { requireKey: false })
  if (!check.ok) {
    formError.value = check.message ?? '请先补全接口地址与模型名'
    return
  }
  busy.value = true
  const result = await store.testConnection(config)
  busy.value = false
  if (result.ok) message.success(describeTestResult(result))
  else message.error(describeTestResult(result))
}

/** 列表行上的测试：用既有配置（留空 apiKey = 用主进程那份） */
async function testExisting(view: ModelView): Promise<void> {
  const result = await store.testConnection(store.viewToConfig(view, {}))
  if (result.ok) message.success(`「${view.name}」${describeTestResult(result)}`)
  else message.error(`「${view.name}」${describeTestResult(result)}`)
}

async function toggleEnabled(view: ModelView, enabled: boolean): Promise<void> {
  await store.setEnabled(view, enabled)
  if (store.error) message.error(store.error)
}

async function setDefault(view: ModelView): Promise<void> {
  await store.activate(view.type, view.id)
  if (store.error) message.error(store.error)
}

async function removeModel(view: ModelView): Promise<void> {
  const ok = await store.deleteModel(view.id)
  if (!ok) {
    message.error(store.error || '删除失败')
    return
  }
  if (editingId.value === view.id) {
    editingId.value = null
    formOpen.value = false
  }
  message.success(`已删除「${view.name}」`)
}

defineExpose({ open, close })
</script>

<template>
  <AModal
    :open="visible"
    title="AI 模型管理"
    :width="760"
    :z-index="1200"
    :mask-closable="!busy"
    :closable="!busy"
    :footer="null"
    wrap-class-name="nf-model-modal"
    @cancel="close"
  >
    <div class="nf-mm">
      <!-- 浏览器开发态：入口仍有，但明确告知不可用 -->
      <p v-if="!store.available" class="nf-mm__offline">
        当前是浏览器开发模式，模型管理需要桌面端（Electron）才能读写本地配置。请用
        <code>npm run dev:electron</code> 启动。
      </p>

      <!-- 列表 -->
      <section class="nf-mm__block">
        <header class="nf-mm__block-head">
          <span class="nf-mm__block-title">已配置模型</span>
          <span class="nf-mm__block-sub">{{ store.models.length }} 个</span>
          <span class="nf-mm__grow" />
          <AButton size="small" type="primary" :disabled="!store.available" @click="startCreate">
            新增模型
          </AButton>
        </header>

        <AEmpty v-if="!store.models.length" description="还没有任何模型，先添加一个文本模型吧" />
        <ul v-else class="nf-mm__list">
          <li
            v-for="m in sortedModels"
            :key="m.id"
            class="nf-mm__row"
            :class="{ 'is-editing': m.id === editingId }"
          >
            <span class="nf-mm__dot" :class="dotClass(m)" :title="dotTitle(m)" />
            <div class="nf-mm__meta">
              <div class="nf-mm__line">
                <span class="nf-mm__name">{{ m.name }}</span>
                <ATag v-if="m.builtin" color="gold" class="nf-mm__tag">内置</ATag>
                <ATag class="nf-mm__tag">{{ TYPE_LABEL[m.type] }}</ATag>
                <ATag class="nf-mm__tag">{{ PROTOCOL_LABEL[m.protocol] }}</ATag>
                <ATag v-if="isActive(m)" color="cyan" class="nf-mm__tag">默认</ATag>
              </div>
              <div class="nf-mm__sub">
                {{ m.model }} · {{ m.baseUrl }} ·
                {{ m.hasKey ? `密钥 ${m.keyHint}` : '未配置密钥' }}
                <span v-if="m.type === 'llm' && m.webSearch" class="nf-mm__flag">联网增强</span>
              </div>
              <div v-if="store.testResults[m.id]" class="nf-mm__test">
                {{ describeTestResult(store.testResults[m.id]) }}
              </div>
            </div>
            <div class="nf-mm__ops">
              <!-- 启用开关：CheckedType 可能是 string / number，这里只认真布尔 -->
              <ASwitch
                size="small"
                :checked="m.enabled !== false"
                :disabled="!store.available"
                @change="(checked) => toggleEnabled(m, checked === true)"
              />
              <AButton size="small" type="text" :disabled="!store.available || isActive(m)" @click="setDefault(m)">
                {{ isActive(m) ? '默认' : '设为默认' }}
              </AButton>
              <AButton
                size="small"
                type="text"
                :loading="!!store.testing[m.id]"
                :disabled="!store.available"
                @click="testExisting(m)"
              >
                测连
              </AButton>
              <AButton size="small" type="text" :disabled="!store.available" @click="startEdit(m)">编辑</AButton>
              <APopconfirm
                v-if="!m.builtin"
                title="删除这个模型？"
                ok-text="删除"
                cancel-text="保留"
                @confirm="removeModel(m)"
              >
                <AButton size="small" type="text" danger>删除</AButton>
              </APopconfirm>
              <span v-else class="nf-mm__locked" title="内置模型不可删除">—</span>
            </div>
          </li>
        </ul>
      </section>

      <!-- 表单 -->
      <section v-if="formOpen" class="nf-mm__form">
        <header class="nf-mm__block-head">
          <span class="nf-mm__block-title">{{ editingId ? '编辑模型' : '新增模型' }}</span>
          <span class="nf-mm__grow" />
          <AButton size="small" type="text" @click="formOpen = false">收起</AButton>
        </header>

        <div class="nf-mm__grid">
          <label class="nf-mm__field">
            <span class="nf-mm__label">供应商预设</span>
            <ASelect :value="form.presetKey" size="small" @change="(value) => onPresetChange(String(value ?? ''))">
              <ASelectOption v-for="p in AI_PROVIDER_PRESETS" :key="p.key" :value="p.key">
                {{ p.label }}
              </ASelectOption>
            </ASelect>
          </label>

          <label class="nf-mm__field">
            <span class="nf-mm__label">名称</span>
            <AInput v-model:value="form.name" size="small" placeholder="如：主力小说模型" />
          </label>

          <label class="nf-mm__field">
            <span class="nf-mm__label">用途</span>
            <ASelect v-model:value="form.type" size="small">
              <ASelectOption value="llm">文本（对话 / 续写）</ASelectOption>
              <ASelectOption value="image">生图</ASelectOption>
            </ASelect>
          </label>

          <label class="nf-mm__field">
            <span class="nf-mm__label">接口协议</span>
            <ASelect v-model:value="form.protocol" size="small">
              <ASelectOption value="openai">OpenAI 兼容</ASelectOption>
              <ASelectOption value="grsai">grsai 私有（提交+轮询）</ASelectOption>
            </ASelect>
          </label>

          <label class="nf-mm__field is-wide">
            <span class="nf-mm__label">接口地址</span>
            <AInput v-model:value="form.baseUrl" size="small" placeholder="https://api.example.com/v1" />
          </label>

          <label class="nf-mm__field">
            <span class="nf-mm__label">模型名</span>
            <AInput v-model:value="form.model" size="small" placeholder="如：gpt-4o-mini" />
          </label>

          <label class="nf-mm__field is-wide">
            <span class="nf-mm__label">API Key<span class="nf-mm__tip">只进不出，保存后不再显示</span></span>
            <InputPassword
              v-model:value="form.apiKey"
              size="small"
              autocomplete="off"
              :placeholder="apiKeyPlaceholder"
            />
          </label>
        </div>

        <details class="nf-mm__adv">
          <summary class="nf-mm__adv-sum">高级配置</summary>
          <label class="nf-mm__switch">
            <ASwitch v-model:checked="form.webSearch" size="small" :disabled="form.type !== 'llm'" />
            <span>
              联网增强（查找资料时先检索再作答）
              <span class="nf-mm__tip">实际效果取决于模型自身是否支持联网</span>
            </span>
          </label>
          <label class="nf-mm__field is-wide">
            <span class="nf-mm__label">自定义请求头<span class="nf-mm__tip">JSON 对象，可选</span></span>
            <AInput
              v-model:value="form.headersText"
              size="small"
              placeholder='{"X-Title":"NovelFlow"}'
            />
          </label>
        </details>

        <p v-if="formError" class="nf-mm__error">{{ formError }}</p>
        <p v-if="saved" class="nf-mm__saved">已保存到本机配置。</p>

        <footer class="nf-mm__foot">
          <AButton size="small" :loading="busy" @click="testConnection">测试连接</AButton>
          <span class="nf-mm__grow" />
          <AButton size="small" type="text" @click="formOpen = false">取消</AButton>
          <AButton size="small" type="primary" :loading="busy" @click="save">保存</AButton>
        </footer>
      </section>
    </div>
  </AModal>
</template>

<style scoped>
.nf-mm {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-height: 62vh;
  overflow-y: auto;
}

.nf-mm__offline {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--nf-r-ctl);
  font-size: var(--nf-fs-xs);
  line-height: 1.7;
  color: var(--nf-warn);
  background: rgba(201, 162, 39, 0.1);
  border: 1px solid rgba(201, 162, 39, 0.28);
}
.nf-mm__offline code {
  color: var(--nf-teal);
  font-size: var(--nf-fs-2xs);
}

.nf-mm__block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.nf-mm__block-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.nf-mm__block-title {
  font-size: var(--nf-fs-sm);
  font-weight: 600;
  color: var(--nf-on-dark-strong);
}
.nf-mm__block-sub,
.nf-mm__tip {
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.04em;
  color: var(--nf-on-dark-faint);
}
.nf-mm__grow {
  flex: 1 1 auto;
}

/* ---------- 列表 ---------- */
.nf-mm__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.nf-mm__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: var(--nf-r-card-sm);
  background: var(--nf-shell-700);
  border: 1px solid var(--nf-shell-line-soft);
  transition: border-color var(--nf-dur-fast) var(--nf-ease);
}
.nf-mm__row:hover {
  border-color: var(--nf-shell-line);
}
.nf-mm__row.is-editing {
  border-color: rgba(77, 208, 217, 0.42);
}

.nf-mm__dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--nf-on-dark-faint);
}
.nf-mm__dot.is-idle {
  background: var(--nf-teal);
  box-shadow: 0 0 0 3px rgba(77, 208, 217, 0.16);
}
.nf-mm__dot.is-ok {
  background: var(--nf-ok);
  box-shadow: 0 0 0 3px rgba(111, 174, 127, 0.18);
}
.nf-mm__dot.is-bad {
  background: var(--nf-danger);
  box-shadow: 0 0 0 3px rgba(200, 106, 99, 0.18);
}
.nf-mm__dot.is-warn {
  background: var(--nf-warn);
  box-shadow: 0 0 0 3px rgba(201, 162, 39, 0.18);
}
.nf-mm__dot.is-off {
  background: var(--nf-on-dark-faint);
}
.nf-mm__dot.is-testing {
  background: var(--nf-gold);
  animation: nf-mm-pulse 1.2s var(--nf-ease) infinite;
}

.nf-mm__meta {
  flex: 1 1 auto;
  min-width: 0;
}
.nf-mm__line {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.nf-mm__name {
  font-size: var(--nf-fs-sm);
  color: var(--nf-on-dark-strong);
}
.nf-mm__tag {
  margin: 0;
  font-size: 10px;
}
.nf-mm__sub {
  margin-top: 3px;
  font-size: var(--nf-fs-2xs);
  line-height: 1.6;
  color: var(--nf-on-dark-faint);
  word-break: break-all;
}
.nf-mm__flag {
  margin-left: 6px;
  padding: 1px 7px;
  border-radius: var(--nf-r-chip);
  color: var(--nf-teal);
  background: rgba(77, 208, 217, 0.12);
}
.nf-mm__test {
  margin-top: 3px;
  font-size: var(--nf-fs-2xs);
  color: var(--nf-teal);
}

.nf-mm__ops {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
}
.nf-mm__locked {
  width: 40px;
  text-align: center;
  color: var(--nf-on-dark-faint);
}

/* ---------- 表单 ---------- */
.nf-mm__form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-radius: var(--nf-r-card-sm);
  border: 1px solid var(--nf-shell-line);
  background: rgba(8, 14, 19, 0.35);
}
.nf-mm__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 14px;
}
.nf-mm__field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.nf-mm__field.is-wide {
  grid-column: 1 / -1;
}
.nf-mm__label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.06em;
  color: var(--nf-on-dark-soft);
}

.nf-mm__adv {
  border-top: 1px solid var(--nf-shell-line-soft);
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.nf-mm__adv-sum {
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.08em;
  color: var(--nf-on-dark-soft);
  cursor: pointer;
}
.nf-mm__switch {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: var(--nf-fs-xs);
  color: var(--nf-on-dark);
}
.nf-mm__switch .nf-mm__tip {
  display: block;
}

.nf-mm__error {
  margin: 0;
  font-size: var(--nf-fs-2xs);
  color: var(--nf-danger);
}
.nf-mm__saved {
  margin: 0;
  font-size: var(--nf-fs-2xs);
  color: var(--nf-ok);
}
.nf-mm__foot {
  display: flex;
  align-items: center;
  gap: 8px;
}

@keyframes nf-mm-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}
</style>

<style>
/* 少量暗色微调：App.vue 的 ConfigProvider 已经给了暗色算法，这里只压一层 z-index 与面板底色 */
.nf-model-modal .ant-modal-content {
  background: var(--nf-shell-800);
  border-radius: var(--nf-r-card);
  border: 1px solid var(--nf-shell-line);
}
.nf-model-modal .ant-modal-header {
  background: transparent;
  border-bottom: 1px solid var(--nf-shell-line-soft);
}
.nf-model-modal .ant-modal-title {
  color: var(--nf-on-dark-strong);
  font-weight: 600;
}
.nf-model-modal .ant-modal-close-x {
  color: var(--nf-on-dark-soft);
}
</style>
