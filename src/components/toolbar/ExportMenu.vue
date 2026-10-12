<script setup lang="ts">
import { ref } from 'vue'
import type { FlowGraph } from '@/types/graph'
import {
  Dropdown as ADropdown,
  Menu as AMenu,
  MenuItem as AMenuItem,
  SubMenu as ASubMenu,
  Switch as ASwitch,
  Button as AButton,
  message
} from 'ant-design-vue'
import { doExport, downloadBlob, type ExportFormat, type PngScale } from '@/export'

/**
 * 导出菜单
 *
 * 六项导出：PNG（1x / 2x / 4x + 透明背景开关）、SVG、JSON、Markdown、Mermaid、draw.io XML。
 * 菜单里只做「选择」，真正的产物生成全部下沉到 @/export（纯函数、可单测）。
 *
 * 推荐挂载位置：AppHeader 右侧工具栏（与画布工具按钮同排），
 * 或 AppShell 顶栏的操作区。用法：
 *
 * ```vue
 * <ExportMenu :graph="activeGraph" />
 * ```
 *
 * 只要传入当前激活的 FlowGraph 即可，组件自身不读 store —— 便于在测试里直接喂数据。
 */

const props = defineProps<{
  /** 当前要导出的流程图 */
  graph: FlowGraph
}>()

const emit = defineEmits<{
  (e: 'exported', payload: { format: ExportFormat; filename: string }): void
}>()

const exporting = ref(false)
const transparent = ref(false)

/** 统一的导出 + 下载 + 提示 */
async function run(format: ExportFormat, scale?: PngScale): Promise<void> {
  if (!props.graph) {
    message.warning('还没有可导出的故事线')
    return
  }
  if (exporting.value) return
  exporting.value = true
  try {
    const result = await doExport(props.graph, format, {
      scale,
      transparent: transparent.value
    })
    downloadBlob(result.blob, result.filename)
    message.success(`已导出 ${result.filename}`)
    emit('exported', { format, filename: result.filename })
  } catch (e) {
    message.error(e instanceof Error ? e.message : `导出失败：${String(e)}`)
  } finally {
    exporting.value = false
  }
}

const SCALES: PngScale[] = [1, 2, 4]
</script>

<template>
  <ADropdown :trigger="['click']" placement="bottomRight">
    <AButton size="small" :loading="exporting">
      导出
      <span class="nf-export__caret">▾</span>
    </AButton>
    <template #overlay>
      <AMenu class="nf-export__menu">
        <ASubMenu key="png" title="PNG 图片">
          <AMenuItem v-for="s in SCALES" :key="`png-${s}`" @click="run('png', s)">
            {{ s }}x{{ s === 2 ? '（推荐）' : '' }}
          </AMenuItem>
        </ASubMenu>
        <AMenuItem key="svg" @click="run('svg')">SVG 矢量图</AMenuItem>
        <AMenuItem key="json" @click="run('json')">JSON 数据</AMenuItem>
        <AMenuItem key="markdown" @click="run('markdown')">Markdown 大纲</AMenuItem>
        <AMenuItem key="mermaid" @click="run('mermaid')">Mermaid 流程图</AMenuItem>
        <AMenuItem key="drawio" @click="run('drawio')">draw.io XML</AMenuItem>
        <AMenuItem key="__transparent" class="nf-export__switch">
          <span>透明背景</span>
          <ASwitch v-model:checked="transparent" size="small" @click.stop />
        </AMenuItem>
      </AMenu>
    </template>
  </ADropdown>
</template>

<style scoped>
.nf-export__caret {
  margin-left: 4px;
  font-size: 10px;
  opacity: 0.7;
}
</style>

<style>
.nf-export__menu {
  min-width: 200px;
  border-radius: 14px;
  overflow: hidden;
}

.nf-export__switch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  cursor: default;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

/* 开关行不该有菜单项的高亮反馈 */
.nf-export__switch:hover {
  background: transparent;
}
</style>
