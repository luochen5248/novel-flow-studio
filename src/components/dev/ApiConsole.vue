<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  Drawer as ADrawer,
  Button as AButton,
  Input as AInput,
  Tag as ATag,
  Empty as AEmpty,
  message
} from 'ant-design-vue'
import { api as novelFlow, type ApiResult, type HelpItem } from '@/api/aiApi'
import { useUiStore } from '@/stores/useUiStore'

/**
 * 开发者 / AI 控制台
 *
 * 一个给「AI 与高级用户」用的调试门面：
 *  - 上半：window.NovelFlow 全部方法的中文清单（直接来自 help()，不会与实现脱节），点一条即填入命令行；
 *  - 下半：迷你命令行，回车执行 `NovelFlow.xxx(...)` 并打印 JSON 结果。
 *
 * 刻意做成抽屉而不是居中弹窗，符合「弹层用抽屉」的视觉约定。
 *
 * 开合状态挂在 uiStore.devConsoleOpen：顶栏「开发者」按钮与右下角 FAB 共用同一个开关。
 */

interface LogEntry {
  id: number
  type: 'in' | 'out' | 'err'
  text: string
}

const ui = useUiStore()
const keyword = ref('')
const command = ref('')
const logs = ref<LogEntry[]>([])
const items = ref<HelpItem[]>([])
let logSeq = 0

onMounted(() => {
  const result = novelFlow.help()
  if (result.ok && result.data) items.value = result.data
})

const filtered = computed<HelpItem[]>(() => {
  const key = keyword.value.trim().toLowerCase()
  if (!key) return items.value
  return items.value.filter(
    (item) =>
      item.name.toLowerCase().includes(key) ||
      item.signature.toLowerCase().includes(key) ||
      item.desc.includes(keyword.value.trim())
  )
})

function push(type: LogEntry['type'], text: string): void {
  logSeq += 1
  logs.value.push({ id: logSeq, type, text })
  // 日志上限，避免长时间调试把内存吃掉
  if (logs.value.length > 80) logs.value.splice(0, logs.value.length - 80)
}

/** 点清单里的一条 → 填进命令行 */
function useItem(item: HelpItem): void {
  command.value = `NovelFlow.${item.name}(`
}

/** 结果序列化：Blob 打标签、循环引用兜底 */
function format(value: unknown): string {
  if (value && typeof value === 'object' && 'ok' in (value as Record<string, unknown>)) {
    const r = value as ApiResult
    const data =
      typeof Blob !== 'undefined' && r.data instanceof Blob
        ? `<Blob ${r.data.type || 'binary'} ${r.data.size} bytes>`
        : r.data
    const payload: Record<string, unknown> = { ok: r.ok }
    if (r.error !== undefined) payload.error = r.error
    if (data !== undefined) payload.data = data
    return JSON.stringify(payload, null, 2)
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * 执行命令行。
 * 用 new Function 把 `NovelFlow` 作为自由变量注入，等价于控制台里直接敲，
 * 因此能覆盖「AI 在控制台里能做的事」的全部语法。
 */
function run(): void {
  let code = command.value.trim()
  if (!code) return
  push('in', code)
  command.value = ''

  // 允许省略前缀：直接敲 addNode({...}) 也能跑
  const head = code.replace(/^await\s+/, '').split('(')[0].trim()
  if (!code.includes('NovelFlow') && items.value.some((i) => i.name === head)) {
    code = `NovelFlow.${code}`
  }

  let out: unknown
  try {
    const fn = new Function('NovelFlow', `"use strict"; return (${code})`)
    out = fn(novelFlow)
  } catch (e) {
    push('err', e instanceof Error ? e.message : String(e))
    return
  }

  if (out && typeof (out as Promise<unknown>).then === 'function') {
    push('out', '（异步执行中，结果稍后打印…）')
    Promise.resolve(out)
      .then((v) => push('out', format(v)))
      .catch((e: unknown) => push('err', e instanceof Error ? e.message : String(e)))
    return
  }
  push('out', format(out))
}

async function copyLast(): Promise<void> {
  const last = [...logs.value].reverse().find((l) => l.type === 'out')
  if (!last) {
    message.info('还没有输出结果')
    return
  }
  try {
    await navigator.clipboard.writeText(last.text)
    message.success('已复制')
  } catch {
    message.warning('当前环境不允许访问剪贴板')
  }
}
</script>

<template>
  <!-- 备用入口：常驻右下角，低调但可见（顶栏「开发者」按钮为首选入口） -->
  <AButton class="nf-console__fab" size="small" @click="ui.toggleDevConsole()">AI 控制台</AButton>

  <ADrawer
    :open="ui.devConsoleOpen"
    title="开发者 / AI 控制台"
    placement="right"
    :width="620"
    class="nf-console"
    @close="ui.closeDevConsole()"
  >
    <div class="nf-console__wrap">
      <!-- 上半：API 清单 -->
      <section class="nf-console__panel">
        <header class="nf-console__panel-head">
          <span>可用命令（{{ filtered.length }}）</span>
          <AInput
            v-model:value="keyword"
            placeholder="搜索：addNode / 导出 / 备注…"
            size="small"
            allow-clear
            class="nf-console__search"
          />
        </header>
        <div class="nf-console__list">
          <AEmpty v-if="!filtered.length" description="没有匹配的命令" />
          <button
            v-for="item in filtered"
            :key="item.name"
            class="nf-console__item"
            @click="useItem(item)"
          >
            <code class="nf-console__sig">{{ item.signature }}</code>
            <span class="nf-console__desc">{{ item.desc }}</span>
          </button>
        </div>
      </section>

      <!-- 下半：迷你命令行 -->
      <section class="nf-console__panel nf-console__panel--cli">
        <header class="nf-console__panel-head">
          <span>命令行</span>
          <ATag color="cyan" class="nf-console__tag">window.NovelFlow</ATag>
        </header>
        <AInput
          v-model:value="command"
          placeholder="NovelFlow.addNode({title:'雨夜初遇'})  —— 回车执行"
          size="small"
          @press-enter="run"
        />
        <div class="nf-console__actions">
          <AButton size="small" type="primary" @click="run">执行</AButton>
          <AButton size="small" @click="copyLast">复制结果</AButton>
          <AButton size="small" type="text" @click="logs = []">清空</AButton>
        </div>
        <div class="nf-console__log">
          <div v-if="!logs.length" class="nf-console__log-empty">
            试试：NovelFlow.help() · NovelFlow.getState() · NovelFlow.addNode({"title":"追车"})
          </div>
          <div
            v-for="log in logs"
            :key="log.id"
            class="nf-console__line"
            :class="`is-${log.type}`"
          >
            <span class="nf-console__prefix">{{ log.type === 'in' ? '›' : log.type === 'err' ? '✕' : '‹' }}</span>
            <pre class="nf-console__text">{{ log.text }}</pre>
          </div>
        </div>
      </section>
    </div>
  </ADrawer>
</template>

<style scoped>
.nf-console__fab {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 900;
  border-radius: 999px;
  background: #131c26;
  border-color: #24323f;
  color: #a7b4c0;
}

.nf-console__wrap {
  display: flex;
  flex-direction: column;
  gap: 18px;
  height: 100%;
}

.nf-console__panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.nf-console__panel--cli {
  flex: 1;
}

.nf-console__panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: #7c8a97;
}

.nf-console__search {
  width: 220px;
}

.nf-console__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 40vh;
  overflow: auto;
  padding-right: 4px;
}

.nf-console__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 12px;
  border: 1px solid transparent;
  background: rgba(255, 255, 255, 0.02);
  cursor: pointer;
  text-align: left;
  transition: background 150ms cubic-bezier(0.2, 0, 0, 1);
}

.nf-console__item:hover {
  background: rgba(77, 208, 217, 0.08);
  border-color: rgba(77, 208, 217, 0.25);
}

.nf-console__sig {
  font-size: 12px;
  color: #4dd0d9;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.nf-console__desc {
  font-size: 12px;
  color: #93a1ae;
  line-height: 1.6;
}

.nf-console__tag {
  font-size: 10px;
}

.nf-console__actions {
  display: flex;
  gap: 8px;
}

.nf-console__log {
  flex: 1;
  min-height: 160px;
  overflow: auto;
  padding: 10px 12px;
  border-radius: 14px;
  background: #0b1218;
  border: 1px solid #1b2634;
}

.nf-console__log-empty {
  font-size: 12px;
  color: #6f7d8a;
  line-height: 1.7;
}

.nf-console__line {
  display: flex;
  gap: 8px;
  padding: 4px 0;
  border-bottom: 1px dashed rgba(255, 255, 255, 0.05);
}

.nf-console__prefix {
  color: #6f7d8a;
  font-size: 12px;
  line-height: 1.7;
}

.nf-console__text {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #a7b4c0;
}

.nf-console__line.is-in .nf-console__text {
  color: #c9a227;
}

.nf-console__line.is-err .nf-console__text {
  color: #e08b7a;
}
</style>

<style>
/* 抽屉整体改成暗色外壳观感 */
.nf-console .ant-drawer-content {
  background: #131c26;
}

.nf-console .ant-drawer-header {
  background: transparent;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}

.nf-console .ant-drawer-title {
  color: #e8eef3;
  font-weight: 600;
}

.nf-console .ant-drawer-close {
  color: #93a1ae;
}

.nf-console .ant-input {
  background: #0f1720;
  border-color: #24323f;
  color: #e8eef3;
}
</style>
