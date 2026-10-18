<script setup lang="ts">
/**
 * ControlCenter —— 控制中心（左下角入口 + 设置式居中弹窗）
 *
 * 为什么要有这个组件：原先「检查更新 / AI 生图密钥 / AI 模型管理 / 开发者控制台 /
 * 画布切换 / 外观切换」六个入口散落在 AppHeader 右上角，既挤占了文档名与统计信息
 * 的空间，也让「设置类」与「文档操作类」混在一起。这里统一收进左下角的控制中心
 * 入口，顶栏只保留导出、提示消息与侧栏折叠。
 *
 * 为什么弹的是居中大弹窗而不是小浮层菜单：六项里有三项（模型管理 / 生图密钥 /
 * 检查更新）点下去还要再开一层对话框，两层浮层叠着既挤也说不清当前状态；改成
 * 「左导航 + 右详情」的设置中心后，外观 / 画布 / 控制台这三项可以直接在这儿即时
 * 切换并当场看到状态，另外三项也能先读一句说明再决定要不要打开。
 *
 * 挂载位置：AppShell 的 body 区（侧栏之外），不在侧栏 footer 里 —— 侧栏折叠是
 * width:0 + overflow:hidden，挂进去会被一起裁掉。
 *
 * 组件自包含：入口按钮 + 弹窗 + 三个对话框（UpdateDialog / GrsaiKeyDialog /
 * AiModelDialog）都在这里，宿主只要放一个 `<ControlCenter />` 即可，避免三个
 * 对话框被多处挂载。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useUiStore } from '@/stores/useUiStore'
import { useKbStore } from '@/stores/useKbStore'
import { downloadText } from '@/core/storage'
import type { MemoryEntry, MemoryType } from '@/core/kb/types'
import UpdateDialog from '@/components/common/UpdateDialog.vue'
import GrsaiKeyDialog from '@/components/common/GrsaiKeyDialog.vue'
import AiModelDialog from '@/components/common/AiModelDialog.vue'

const ui = useUiStore()
const kbStore = useKbStore()

/** 仅 Electron 桌面环境才显示依赖 electronAPI 的几项（浏览器里走不了主进程） */
const isDesktop = !!(window as unknown as { electronAPI?: unknown }).electronAPI

const updateDialog = ref<InstanceType<typeof UpdateDialog> | null>(null)
const keyDialog = ref<InstanceType<typeof GrsaiKeyDialog> | null>(null)
/** AI 模型管理：统一的 LLM + 生图入口（含内置 grsai） */
const modelDialog = ref<InstanceType<typeof AiModelDialog> | null>(null)

/** 弹窗开关 */
const open = ref(false)
/** 左栏当前选中的设置项 */
const activeKey = ref('')
/** 弹窗面板 DOM（Tab 陷阱与初始聚焦用） */
const panel = ref<HTMLElement | null>(null)
/** 打开弹窗前聚焦的元素，关闭时归还（模块级而非组件 ref：不需要响应式） */
let lastFocused: HTMLElement | null = null
/** 右栏说明段落的 id，供 aria-describedby 引用 */
const descId = 'nf-cc-modal-desc'
/** 侧栏折叠态：入口要缩成浮在画布左下角的胶囊，否则设置入口会随侧栏一起消失 */
const collapsed = computed(() => ui.sidebarCollapsed)

interface SettingItem {
  key: string
  /** 左栏分组标题 */
  group: string
  /** 左栏导航项名称 */
  label: string
  /** 16px 图标的 path d */
  icon: string
  /** 右栏标题 */
  title: string
  /** 右栏一句话说明 */
  desc: string
  /** 右栏状态文字（随 store 联动，切换后当场更新） */
  state: string
  /** 状态生效中（如控制台已开）时用青色点出 */
  active?: boolean
  /** 右栏主按钮文案 */
  actionLabel: string
  run: () => void
  /** 右栏专属渲染分支（记忆与进化：开关 + 工作背景 + 管理区，不用标准 action 骨架） */
  panel?: 'memory'
}

/**
 * 先关自己，再开业务对话框。
 *
 * ⚠️ 注意这里只是「不留两层模态」，并不是防穿透的手段：本弹窗 950 层不被 900/1200/
 * 1400/1500 那些上层弹层穿透，真正挡住入口的是**高层弹层自带的那层 mask 物理盖住了
 * 屏幕**（点不到入口，自然也没法从入口再开一层）。将来若有人给 Drawer / 模型管理
 * 设置 `mask:false`，这个物理前提就没了 —— 到那时要么把本弹窗的层级降到对应弹层之下，
 * 要么在打开路径上加互斥判断，不能只靠「先关自己」。
 */
function openModelDialog(): void {
  open.value = false
  modelDialog.value?.open()
}
function openKeyDialog(): void {
  open.value = false
  keyDialog.value?.open()
}
function openUpdateDialog(): void {
  open.value = false
  updateDialog.value?.open()
}

/* ---------------- 记忆与进化（右栏专属分支的状态与动作） ---------------- */

/** 记忆行内编辑：点「改」把该行换成 textarea（完整管理也在这里，面板只给快捷入口） */
const editingMemoryId = ref('')
const editingMemoryText = ref('')
/** 重置要防手滑：第一次点进入待确认，第二次才真删 */
const resetArmed = ref(false)
const memFileInput = ref<HTMLInputElement | null>(null)

const MEMORY_TYPE_LABEL: Record<MemoryType, string> = {
  preference: '偏好',
  fact: '事实',
  decision: '决定',
  background: '背景'
}

function onBackgroundInput(e: Event): void {
  // 草稿直接进 store，保存由 store 的 800ms 防抖负责
  kbStore.setWorkBackgroundDraft((e.target as HTMLTextAreaElement).value)
}

async function onChatMemoryChange(e: Event): Promise<void> {
  const checked = (e.target as HTMLInputElement).checked
  try {
    await kbStore.setChatMemory(checked)
  } catch (err) {
    message.error(err instanceof Error ? err.message : '保存开关失败')
  }
}

async function onLocalMemoryChange(e: Event): Promise<void> {
  const checked = (e.target as HTMLInputElement).checked
  try {
    await kbStore.setLocalMemory(checked)
  } catch (err) {
    message.error(err instanceof Error ? err.message : '保存开关失败')
  }
}

function onEditMemory(m: MemoryEntry): void {
  editingMemoryId.value = m.id
  editingMemoryText.value = m.content
}

function onCancelMemoryEdit(): void {
  editingMemoryId.value = ''
  editingMemoryText.value = ''
}

async function onSaveMemoryEdit(): Promise<void> {
  const text = editingMemoryText.value.trim()
  if (!text) {
    message.warning('记忆内容不能为空')
    return
  }
  try {
    await kbStore.updateMemoryAction(editingMemoryId.value, { content: text })
    editingMemoryId.value = ''
  } catch (err) {
    message.error(err instanceof Error ? err.message : '保存记忆失败')
  }
}

async function onRemoveMemory(id: string): Promise<void> {
  try {
    await kbStore.removeMemoryAction(id)
  } catch (err) {
    message.error(err instanceof Error ? err.message : '删除记忆失败')
  }
}

function onResetMemories(): void {
  if (!resetArmed.value) {
    resetArmed.value = true
    message.info('再点一次「重置」确认清空全部记忆')
    return
  }
  resetArmed.value = false
  kbStore
    .resetMemoriesAction()
    .then(() => message.success('已清空全部记忆'))
    .catch((err) => message.error(err instanceof Error ? err.message : '重置失败'))
}

async function onCurateMemories(): Promise<void> {
  try {
    const report = await kbStore.curate()
    message.success(report.merged ? `整理完成：合并 ${report.merged} 条重复记忆` : '整理完成：没有发现重复记忆')
  } catch (err) {
    message.error(err instanceof Error ? err.message : '整理失败')
  }
}

function onExportMemories(): void {
  kbStore
    .exportMemoriesAction()
    .then((json) => {
      downloadText('novelflow-memories.json', json)
      message.success('已导出记忆 JSON')
    })
    .catch((err) => message.error(err instanceof Error ? err.message : '导出失败'))
}

function onImportMemories(): void {
  memFileInput.value?.click()
}

async function onMemFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const imported = await kbStore.importMemoriesAction(await file.text())
    message.success(`已导入 ${imported} 条记忆`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : '导入失败')
  } finally {
    input.value = ''
  }
}

const items = computed<SettingItem[]>(() => {
  const list: SettingItem[] = [
    {
      key: 'theme',
      group: '外观',
      label: '外观切换',
      icon: 'M8 2.4 A5.6 5.6 0 1 0 8 13.6 A4.4 4.4 0 0 1 8 2.4 Z',
      title: '外壳外观',
      desc: '切换界面外壳的深墨蓝 / 浅石墨两套配色，只影响侧栏与顶栏，画布配色由「画布切换」单独控制。',
      state: ui.shellTheme === 'dark' ? '当前：深色' : '当前：浅色',
      actionLabel: ui.shellTheme === 'dark' ? '切换到浅色' : '切换到深色',
      run: () => ui.toggleTheme()
    },
    {
      key: 'canvas',
      group: '外观',
      label: '画布切换',
      icon:
        ui.canvasTheme === 'dark'
          ? 'M12.6 9.8 A5.2 5.2 0 0 1 6.2 3.4 A5.4 5.4 0 1 0 12.6 9.8 Z'
          : 'M8 8 A3.2 3.2 0 1 0 8 8.001 M8 1.8 V3.2 M8 12.8 V14.2 M1.8 8 H3.2 M12.8 8 H14.2 M3.6 3.6 L4.6 4.6 M11.4 11.4 L12.4 12.4 M12.4 3.6 L11.4 4.6 M4.6 11.4 L3.6 12.4',
      title: '画布底色',
      desc: '宣纸是暖白纸感，适合长时间读稿；夜航是深蓝，适合夜间写。只换画布，不动外壳。',
      state: ui.canvasTheme === 'dark' ? '当前：夜航' : '当前：宣纸',
      actionLabel: ui.canvasTheme === 'dark' ? '切换到宣纸' : '切换到夜航',
      run: () => ui.toggleCanvasMode()
    },
    {
      key: 'dev',
      group: '功能',
      label: '开发者控制台',
      icon: 'M5.6 4.4 L3.4 8 L5.6 11.6 M10.4 4.4 L12.6 8 L10.4 11.6',
      title: '开发者 / AI 控制台',
      desc: '打开一个命令行面板，可以直接调用 window.NovelFlow 上的全部方法，用来批量改图或调试。',
      state: ui.devConsoleOpen ? '已开启' : '已关闭',
      active: ui.devConsoleOpen,
      actionLabel: ui.devConsoleOpen ? '关闭控制台' : '打开控制台',
      run: () => ui.toggleDevConsole()
    }
  ]

  // 这三项都依赖主进程（密钥存 userData/config.json、更新走 electron-updater），
  // 浏览器态下 open() 会直接 return，与其留死菜单不如沿用顶栏时的 isDesktop 门控
  if (isDesktop) {
    list.push(
      {
        key: 'model',
        group: '功能',
        label: 'AI 模型管理',
        icon:
          'M3.4 4.2 A1.5 1.5 0 1 0 3.4 4.201 M12.6 4.2 A1.5 1.5 0 1 0 12.6 4.201 M4.6 12.4 A1.5 1.5 0 1 0 4.6 12.401 M4.7 5.1 L6.4 6.7 M11.3 5.1 L9.6 6.7 M5.5 11.3 L6.8 9.6',
        title: 'AI 模型管理',
        desc: '统一配置文本与生图的模型端点，支持内置 grsai。密钥只写在本机，不会随故事线数据导出。',
        state: '在本机配置中',
        actionLabel: '打开模型管理',
        run: openModelDialog
      },
      {
        key: 'key',
        group: '功能',
        label: 'AI 生图密钥',
        icon: 'M5.4 8 A2.4 2.4 0 1 0 5.4 8.001 M7.8 8 H13.4 M11.4 8 V10.2 M13 8 V9.6',
        title: 'AI 生图密钥（grsai）',
        desc: '设置 grsai 的 API Key，用于节点配图。已配置时不会回显明文，只能整串覆盖。',
        state: '仅保存在本机',
        actionLabel: '打开密钥设置',
        run: openKeyDialog
      },
      {
        key: 'update',
        group: '关于',
        label: '检查更新',
        icon:
          'M8 2.6 V9.4 M8 9.4 L5.2 6.6 M8 9.4 L10.8 6.6 M3 11.2 V12.6 A0.8 0.8 0 0 0 3.8 13.4 H12.2 A0.8 0.8 0 0 0 13 12.6 V11.2',
        title: '检查更新',
        desc: '从 GitHub Releases 拉取最新版本，下载完成后可立即安装并重启。更新不会动你的故事线数据。',
        state: 'GitHub Releases',
        actionLabel: '检查更新',
        run: openUpdateDialog
      }
    )
  }

  // 知识库 + 记忆与进化两组。浏览器态走 IndexedDB 降层也能用面板 CRUD，
  // 故不做 isDesktop 门控（与上面三项依赖主进程的不同）。
  // 「浏览知识库」照 openModelDialog 惯例：先关自己再开大面板（900 档，
  // 与本弹窗 950 不同屏）；「记忆与进化」是右栏专属渲染分支（panel: 'memory'）。
  list.push(
    {
      key: 'kb',
      group: '知识库',
      label: '浏览知识库',
      icon:
        'M3.2 2.8 H10.2 L12.8 5.4 V13.2 H3.2 Z M5.6 7.4 H10 M5.6 9.8 H10 M5.6 12.2 H8',
      title: '知识库',
      desc: '跨故事线的作者资产：知识条目、参考文档与段落锚点。全部存在本机数据库（userData/novelflow.db），不随故事线 JSON 导出。',
      state: kbStore.entries.length ? `已收录 ${kbStore.entries.length} 条知识` : '还没有条目',
      actionLabel: '打开知识库',
      run: () => {
        open.value = false
        kbStore.openPanel('entries')
      }
    },
    {
      key: 'memory',
      group: '记忆与进化',
      label: '记忆与进化',
      icon:
        'M8 2.6 A5.4 5.4 0 1 0 8 13.4 A4.2 4.2 0 0 1 8 2.6 Z M6.2 6.4 H9.8 M6.2 8.6 H9.8 M6.2 10.8 H8.4',
      title: '记忆与进化',
      desc: '两个开关默认关闭（隐私优先）；「工作背景」与「管理记忆」始终可用，不受开关控制。',
      state: kbStore.chatMemory || kbStore.localMemory ? '有开关已开启' : '开关均关闭',
      active: kbStore.chatMemory || kbStore.localMemory,
      actionLabel: '',
      panel: 'memory',
      run: () => {}
    }
  )

  return list
})

/** 左栏分组：按 group 首次出现的顺序聚合，空分组（浏览器态的「关于」）不渲染 */
const groups = computed<{ title: string; items: SettingItem[] }[]>(() => {
  const list: { title: string; items: SettingItem[] }[] = []
  for (const item of items.value) {
    const hit = list.find((g) => g.title === item.group)
    if (hit) hit.items.push(item)
    else list.push({ title: item.group, items: [item] })
  }
  return list
})

/** 右栏当前项：找不到（理论上不会）就回落到第一项，避免右栏空白 */
const current = computed<SettingItem>(
  () => items.value.find((i) => i.key === activeKey.value) ?? items.value[0]
)

function toggle(): void {
  open.value = !open.value
}

function close(): void {
  open.value = false
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}

/** 面板内可聚焦元素（Tab 陷阱用） */
function focusablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => el.tabIndex >= 0)
}

/**
 * Tab 陷阱：既然宣告了 aria-modal="true"，就得真的把焦点锁在面板里。
 *
 * 为什么监听挂在 window 而不是面板：焦点一旦跑到面板外（刚打开、或点了遮罩），
 * 面板上的 @keydown 根本不会触发，陷阱就漏了。挂 window + capture 才能兜住。
 * 只处理 Tab，Esc 仍归 onKeydown，两者互不干扰。
 */
function onTrapKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Tab') return
  const root = panel.value
  if (!root) return
  const list = focusablesIn(root)
  if (!list.length) return
  const first = list[0]
  const last = list[list.length - 1]
  const active = document.activeElement

  // 焦点不在面板内（含刚打开还没聚焦的情况）：直接拉回第一项
  if (!(active instanceof Node) || !root.contains(active)) {
    e.preventDefault()
    first.focus()
    return
  }
  if (e.shiftKey && active === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}

watch(open, (value) => {
  if (value) {
    // 每次打开都回到第一项，不保留上次的选中态（设置项少，回到起点更好找）
    activeKey.value = items.value[0]?.key ?? ''
    // 知识库 / 记忆数据回拉一次（右栏状态文字与管理列表都读 store）
    void kbStore.refresh()
    // 记下打开前聚焦的元素，关闭时还回去（通常是左下角入口按钮）
    lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    window.addEventListener('keydown', onKeydown, true)
    window.addEventListener('keydown', onTrapKeydown, true)
    void nextTick(() => {
      // 打开就把焦点移进弹窗，否则 Tab 会把背景所有控件摸一遍，aria-modal 就成了谎言
      panel.value?.querySelector<HTMLElement>('.nf-cc-modal__nav-item')?.focus()
    })
  } else {
    window.removeEventListener('keydown', onKeydown, true)
    window.removeEventListener('keydown', onTrapKeydown, true)
    // isConnected 判断：元素若已被卸载就别强塞焦点
    if (lastFocused?.isConnected) lastFocused.focus()
    lastFocused = null
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('keydown', onTrapKeydown, true)
})
</script>

<template>
  <div class="nf-cc" :class="{ 'is-collapsed': collapsed }">
    <button
      class="nf-cc__trigger"
      :class="{ 'is-on': open }"
      title="控制中心"
      aria-haspopup="dialog"
      :aria-expanded="open"
      @click="toggle"
    >
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <rect x="2.4" y="2.4" width="4.4" height="4.4" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.3" />
        <rect x="9.2" y="2.4" width="4.4" height="4.4" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.3" />
        <rect x="2.4" y="9.2" width="4.4" height="4.4" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.3" />
        <rect x="9.2" y="9.2" width="4.4" height="4.4" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.3" />
      </svg>
      <span class="nf-cc__trigger-text">控制中心</span>
    </button>

    <!-- 自动保存说明只在侧栏展开时露出来：折叠态那点地方只放得下入口本身 -->
    <span v-if="!collapsed" class="nf-cc__storage nf-mono-label">本地存储 · 自动保存</span>

    <Teleport to="body">
      <div v-if="open" class="nf-cc-modal" @click.self="close">
        <div
          ref="panel"
          class="nf-cc-modal__panel"
          role="dialog"
          aria-modal="true"
          aria-label="设置中心"
          :aria-describedby="descId"
        >
          <header class="nf-cc-modal__head">
            <span class="nf-cc-modal__mark" aria-hidden="true" />
            <h2 class="nf-cc-modal__title">设置中心</h2>
            <button class="nf-cc-modal__close" title="关闭" @click="close">
              <svg viewBox="0 0 16 16" width="14" height="14">
                <path d="M4 4 L12 12 M12 4 L4 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
              </svg>
            </button>
          </header>

          <div class="nf-cc-modal__body">
            <nav class="nf-cc-modal__nav">
              <template v-for="group in groups" :key="group.title">
                <p class="nf-cc-modal__nav-title">{{ group.title }}</p>
                <button
                  v-for="item in group.items"
                  :key="item.key"
                  class="nf-cc-modal__nav-item"
                  :class="{ 'is-active': item.key === activeKey }"
                  @click="activeKey = item.key"
                >
                  <svg class="nf-cc-modal__nav-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                    <path
                      :d="item.icon"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.3"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                  <span>{{ item.label }}</span>
                </button>
              </template>
            </nav>

            <section class="nf-cc-modal__content">
              <!-- 记忆与进化：专属渲染分支（开关 + 工作背景 + 管理区）。
                   列表区 max-height + 内部滚动，别把 760×500 的弹窗撑爆 -->
              <template v-if="current.panel === 'memory'">
                <h3 class="nf-cc-modal__content-title">记忆与进化</h3>
                <p class="nf-cc-modal__desc">
                  「对话记忆」打开后，AI 求助会带上下面的工作背景与作者记忆；「本地记忆与技能」打开后，软件会记录工作过程（新建节点 / 导出 / AI
                  协助）供统计与整理。两个开关默认关闭。
                </p>

                <div class="nf-cc-mem__switches">
                  <label class="nf-cc-mem__switch">
                    <input
                      type="checkbox"
                      :checked="kbStore.chatMemory"
                      @change="onChatMemoryChange"
                    />
                    <span>对话记忆（AI 求助时带上作者记忆与工作背景）</span>
                  </label>
                  <label class="nf-cc-mem__switch">
                    <input
                      type="checkbox"
                      :checked="kbStore.localMemory"
                      @change="onLocalMemoryChange"
                    />
                    <span>本地记忆与技能（记录工作过程，用于统计与整理）</span>
                  </label>
                </div>

                <div class="nf-cc-mem__block">
                  <label class="nf-cc-mem__label">工作背景（始终可用；自动保存，进提示词时最多 400 字）</label>
                  <textarea
                    class="nf-cc-mem__textarea"
                    rows="3"
                    placeholder="如：本书是民国背景的推理长篇，主角口癖是短句，忌讳形容词堆砌……"
                    :value="kbStore.workBackgroundDraft"
                    @input="onBackgroundInput"
                  />
                </div>

                <div class="nf-cc-mem__block">
                  <div class="nf-cc-mem__manage-head">
                    <span class="nf-cc-mem__label">管理记忆（{{ kbStore.memories.length }} 条）</span>
                    <span class="nf-cc-mem__manage-actions">
                      <button class="nf-cc-mem__mini" @click="onCurateMemories">一键整理</button>
                      <button class="nf-cc-mem__mini" @click="onExportMemories">导出</button>
                      <button class="nf-cc-mem__mini" @click="onImportMemories">导入</button>
                      <button
                        class="nf-cc-mem__mini is-danger"
                        @click="onResetMemories"
                      >
                        {{ resetArmed ? '确认重置？' : '重置' }}
                      </button>
                    </span>
                  </div>
                  <ul v-if="kbStore.memories.length" class="nf-cc-mem__list nf-scroll">
                    <li v-for="m in kbStore.memories" :key="m.id" class="nf-cc-mem__item">
                      <template v-if="editingMemoryId === m.id">
                        <textarea
                          v-model="editingMemoryText"
                          class="nf-cc-mem__edit"
                          rows="2"
                        />
                        <span class="nf-cc-mem__item-actions">
                          <button class="nf-cc-mem__mini" @click="onSaveMemoryEdit">保存</button>
                          <button class="nf-cc-mem__mini" @click="onCancelMemoryEdit">取消</button>
                        </span>
                      </template>
                      <template v-else>
                        <span class="nf-cc-mem__item-type">{{ MEMORY_TYPE_LABEL[m.type] ?? '记忆' }}</span>
                        <span class="nf-cc-mem__item-text">{{ m.content }}</span>
                        <span class="nf-cc-mem__item-actions">
                          <button class="nf-cc-mem__mini" @click="onEditMemory(m)">改</button>
                          <button class="nf-cc-mem__mini is-danger" @click="onRemoveMemory(m.id)">删</button>
                        </span>
                      </template>
                    </li>
                  </ul>
                  <p v-else class="nf-cc-mem__empty">
                    还没有记忆。AI 结果可在写作浮层里「存为记忆」，也可在知识库面板的记忆区快捷新建。
                  </p>
                </div>

                <p class="nf-cc-mem__privacy">记忆内容仅保存在本机（userData/novelflow.db），可随时导出或删除。</p>
                <input ref="memFileInput" type="file" accept=".json,application/json" hidden @change="onMemFile" />
              </template>

              <!-- 标准设置项骨架 -->
              <template v-else>
                <h3 class="nf-cc-modal__content-title">{{ current.title }}</h3>
                <p :id="descId" class="nf-cc-modal__desc">{{ current.desc }}</p>
                <div class="nf-cc-modal__action">
                  <button class="nf-cc-modal__primary" @click="current.run()">
                    {{ current.actionLabel }}
                  </button>
                  <span class="nf-cc-modal__state" :class="{ 'is-active': current.active }">
                    {{ current.state }}
                  </span>
                </div>
              </template>
            </section>
          </div>
        </div>
      </div>
    </Teleport>

    <UpdateDialog ref="updateDialog" />
    <GrsaiKeyDialog ref="keyDialog" />
    <AiModelDialog ref="modelDialog" />
  </div>
</template>

<style scoped>
/*
 * 入口位置：AppShell 的 body 区（侧栏之外），绝对定位到左下角。
 *   - 展开态：宽度对齐侧栏，透明底 + 上分隔线，视觉上就是原来的 footer 条带；
 *   - 折叠态：缩成浮在画布左下角的胶囊，永远可点。
 */
.nf-cc {
  position: absolute;
  left: 0;
  bottom: 0;
  z-index: 30; /* 高于画布浮层（2 / 20），远低于抽屉（1000）与各类弹层 */
  width: var(--nf-sidebar-w, 268px);
  padding: 10px 14px 14px;
  border-top: 1px solid var(--nf-shell-line-soft);
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 折叠态：脱离侧栏那一条的位置，浮到左下角（缩略图在右下角，不会打架） */
.nf-cc.is-collapsed {
  left: 12px;
  bottom: 12px;
  width: auto;
  padding: 0;
  border-top: none;
}

/* 自动保存说明：入口在左、文案在右；侧栏收窄时先让文案收省略号 */
.nf-cc__storage {
  margin-left: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 入口按钮：与侧栏 nf-sidebar__icon-btn 同族，只是拉长成带文字的一条 */
.nf-cc__trigger {
  appearance: none;
  border: 1px solid transparent;
  background: transparent;
  color: var(--nf-on-dark-soft);
  height: 28px;
  padding: 0 9px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: var(--nf-fs-xs);
  letter-spacing: 0.04em;
  white-space: nowrap;
  transition:
    color var(--nf-dur-fast) var(--nf-ease),
    border-color var(--nf-dur-fast) var(--nf-ease),
    background var(--nf-dur-fast) var(--nf-ease);
}
.nf-cc__trigger:hover,
.nf-cc__trigger.is-on {
  color: var(--nf-teal);
  border-color: rgba(77, 208, 217, 0.45);
  background: rgba(77, 208, 217, 0.1);
}

/* 折叠态落在画布上，必须有自己的底与描边，否则会糊在画布里看不清 */
.nf-cc.is-collapsed .nf-cc__trigger {
  border-color: var(--nf-shell-line);
  background: var(--nf-shell-800);
  box-shadow: var(--nf-shadow-panel);
}
.nf-cc.is-collapsed .nf-cc__trigger:hover,
.nf-cc.is-collapsed .nf-cc__trigger.is-on {
  background: rgba(77, 208, 217, 0.12);
  border-color: rgba(77, 208, 217, 0.45);
}

/* 侧栏很窄时优先牺牲文案，保住图标入口 */
.nf-cc__trigger-text {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ------------------------------------------------------------------ */
/* 设置式弹窗                                                          */
/* ------------------------------------------------------------------ */

/*
 * z-index 950：压住业务弹窗之外的界面，又低于它们——
 * 业务弹层分别是 900（UpdateDialog / GrsaiKeyDialog / ApiConsole）、
 * 1200（模型管理）、1400（AiContextMenu）、1500（AiAssistDialog）。
 * 本弹窗打开业务对话框前会先关自己，所以实际不会同屏并存。
 */
.nf-cc-modal {
  position: fixed;
  inset: 0;
  z-index: 950;
  display: grid;
  place-items: center;
  background: rgba(6, 10, 15, 0.55);
  backdrop-filter: blur(4px);
  animation: nf-cc-modal-fade var(--nf-dur) var(--nf-ease) both;
}

.nf-cc-modal__panel {
  width: 760px;
  height: 500px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: linear-gradient(180deg, var(--nf-shell-800) 0%, var(--nf-shell-900) 100%);
  border: 1px solid var(--nf-shell-line);
  border-radius: var(--nf-r-card);
  box-shadow: var(--nf-shadow-pop);
  /* 入场只有淡入 + 轻微放大，禁回弹 */
  animation: nf-cc-modal-in var(--nf-dur) var(--nf-ease) both;
}

.nf-cc-modal__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 16px 18px 14px;
  border-bottom: 1px solid var(--nf-shell-line-soft);
}
.nf-cc-modal__mark {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: linear-gradient(135deg, #6fdde4 0%, #2aa6b0 100%);
  box-shadow: 0 0 0 4px rgba(77, 208, 217, 0.14);
}
.nf-cc-modal__title {
  margin: 0;
  flex: 1 1 auto;
  font-size: var(--nf-fs-lg);
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--nf-on-dark-strong);
}
.nf-cc-modal__close {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--nf-on-dark-soft);
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  cursor: pointer;
  transition:
    color var(--nf-dur-fast) var(--nf-ease),
    background var(--nf-dur-fast) var(--nf-ease);
}
.nf-cc-modal__close:hover {
  color: var(--nf-teal);
  background: rgba(77, 208, 217, 0.1);
}

.nf-cc-modal__body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
}

/* ---------- 左栏：导航 ---------- */
.nf-cc-modal__nav {
  flex: none;
  width: 196px;
  padding: 12px 10px 16px;
  border-right: 1px solid var(--nf-shell-line-soft);
  overflow-y: auto;
}

.nf-cc-modal__nav-title {
  margin: 12px 8px 5px;
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.12em;
  color: var(--nf-on-dark-faint);
}
.nf-cc-modal__nav-title:first-child {
  margin-top: 2px;
}

.nf-cc-modal__nav-item {
  appearance: none;
  border: none;
  background: transparent;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 10px;
  border-radius: var(--nf-r-ctl);
  cursor: pointer;
  text-align: left;
  font-size: var(--nf-fs-sm);
  color: var(--nf-on-dark);
  transition:
    color var(--nf-dur-fast) var(--nf-ease),
    background var(--nf-dur-fast) var(--nf-ease);
}
.nf-cc-modal__nav-item:hover {
  color: var(--nf-on-dark-strong);
  background: rgba(148, 172, 196, 0.08);
}
/* 选中项：青色 + 微底色，不用描边，免得跟 hover 打架 */
.nf-cc-modal__nav-item.is-active {
  color: var(--nf-teal);
  background: rgba(77, 208, 217, 0.12);
}

.nf-cc-modal__nav-icon {
  flex: none;
  color: currentColor;
  opacity: 0.85;
}

/* ---------- 右栏：详情 ---------- */
.nf-cc-modal__content {
  flex: 1 1 auto;
  min-width: 0;
  padding: 22px 26px;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.nf-cc-modal__content-title {
  margin: 0;
  font-size: var(--nf-fs-md);
  font-weight: 600;
  color: var(--nf-on-dark-strong);
}

.nf-cc-modal__desc {
  margin: 8px 0 0;
  font-size: var(--nf-fs-sm);
  line-height: var(--nf-lh-body);
  color: var(--nf-on-dark-soft);
  max-width: 46em;
}

/* 控件区：主按钮 + 状态说明并排，状态跟着 store 走，切换后当场变 */
.nf-cc-modal__action {
  margin-top: 22px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.nf-cc-modal__primary {
  appearance: none;
  border: 1px solid rgba(77, 208, 217, 0.42);
  background: rgba(77, 208, 217, 0.14);
  color: var(--nf-teal);
  height: 34px;
  padding: 0 16px;
  border-radius: var(--nf-r-ctl);
  cursor: pointer;
  font-size: var(--nf-fs-sm);
  letter-spacing: 0.02em;
  transition:
    background var(--nf-dur-fast) var(--nf-ease),
    border-color var(--nf-dur-fast) var(--nf-ease);
}
.nf-cc-modal__primary:hover {
  background: rgba(77, 208, 217, 0.22);
  border-color: rgba(77, 208, 217, 0.6);
}

.nf-cc-modal__state {
  font-size: var(--nf-fs-xs);
  letter-spacing: 0.04em;
  color: var(--nf-on-dark-faint);
}
/* 状态生效中（控制台已开）用青色点出来 */
.nf-cc-modal__state.is-active {
  color: var(--nf-teal);
}

/* ---------- 记忆与进化（右栏专属分支） ---------- */
/* 弹窗是 760×500：右栏整体可滚动，记忆列表再套一层 max-height + 内部滚动，
   两级滚动分担高度，绝不把面板撑爆 */
.nf-cc-mem__switches {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.nf-cc-mem__switch {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--nf-fs-sm);
  color: var(--nf-on-dark);
  cursor: pointer;
}
.nf-cc-mem__switch input {
  accent-color: var(--nf-teal);
}

.nf-cc-mem__block {
  margin-top: 16px;
}
.nf-cc-mem__label {
  display: block;
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.06em;
  color: var(--nf-on-dark-faint);
  margin-bottom: 6px;
}
.nf-cc-mem__textarea {
  width: 100%;
  resize: vertical;
  min-height: 64px;
  padding: 8px 10px;
  border-radius: var(--nf-r-ctl);
  border: 1px solid var(--nf-shell-line);
  background: rgba(8, 14, 19, 0.4);
  color: var(--nf-on-dark);
  font-size: var(--nf-fs-sm);
  line-height: 1.7;
}
.nf-cc-mem__textarea:focus {
  outline: none;
  border-color: rgba(77, 208, 217, 0.45);
}

.nf-cc-mem__manage-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.nf-cc-mem__manage-actions {
  display: flex;
  gap: 6px;
}
.nf-cc-mem__mini {
  appearance: none;
  border: 1px solid var(--nf-shell-line);
  background: rgba(8, 14, 19, 0.4);
  color: var(--nf-on-dark-soft);
  height: 24px;
  padding: 0 9px;
  border-radius: 7px;
  cursor: pointer;
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.04em;
  transition:
    color var(--nf-dur-fast) var(--nf-ease),
    border-color var(--nf-dur-fast) var(--nf-ease),
    background var(--nf-dur-fast) var(--nf-ease);
}
.nf-cc-mem__mini:hover {
  color: var(--nf-teal);
  border-color: rgba(77, 208, 217, 0.42);
}
.nf-cc-mem__mini.is-danger:hover {
  color: var(--nf-danger);
  border-color: rgba(200, 106, 99, 0.42);
}

.nf-cc-mem__list {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  max-height: 148px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.nf-cc-mem__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border-radius: var(--nf-r-ctl);
  background: var(--nf-shell-700);
  border: 1px solid var(--nf-shell-line-soft);
  font-size: var(--nf-fs-xs);
  color: var(--nf-on-dark);
}
.nf-cc-mem__item-type {
  flex: none;
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--nf-teal);
  background: rgba(77, 208, 217, 0.12);
  border-radius: var(--nf-r-chip);
  padding: 1px 6px;
}
.nf-cc-mem__item-text {
  flex: 1 1 auto;
  min-width: 0;
  line-height: 1.6;
  /* 记忆可能很长：列表里最多三行，完整内容进编辑器看 */
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.nf-cc-mem__item-actions {
  flex: none;
  display: flex;
  gap: 4px;
}
.nf-cc-mem__edit {
  flex: 1 1 auto;
  resize: vertical;
  min-height: 40px;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid rgba(77, 208, 217, 0.45);
  background: rgba(8, 14, 19, 0.5);
  color: var(--nf-on-dark);
  font-size: var(--nf-fs-xs);
  line-height: 1.6;
}
.nf-cc-mem__empty {
  margin: 8px 0 0;
  font-size: var(--nf-fs-2xs);
  line-height: 1.7;
  color: var(--nf-on-dark-faint);
}
.nf-cc-mem__privacy {
  margin: 14px 0 0;
  font-size: var(--nf-fs-2xs);
  letter-spacing: 0.02em;
  color: var(--nf-on-dark-faint);
}

@keyframes nf-cc-modal-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes nf-cc-modal-in {
  from {
    opacity: 0;
    transform: scale(0.98);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
