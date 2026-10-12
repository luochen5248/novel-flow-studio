<script setup lang="ts">
import { computed, ref } from 'vue'
import { useUiStore } from '@/stores/useUiStore'
import { useViewport } from '@/composables/useViewport'
import { useShortcuts } from '@/composables/useShortcuts'
import { boundsOf } from '@/core/geometry'
import { useFlowStore } from '@/stores/useFlowStore'
import type { StoryNode } from '@/types/graph'
import AppHeader from './AppHeader.vue'
import FlowSidebar from '@/components/sidebar/FlowSidebar.vue'
import CanvasToolbar from '@/components/toolbar/CanvasToolbar.vue'
import FlowCanvas from '@/components/canvas/FlowCanvas.vue'
import NodeInspector from '@/components/inspector/NodeInspector.vue'
import StoryEditorDrawer from '@/components/story/StoryEditorDrawer.vue'
import AiImageDialog from '@/components/ai/AiImageDialog.vue'
import ApiConsole from '@/components/dev/ApiConsole.vue'

const ui = useUiStore()
const store = useFlowStore()
const viewport = useViewport()

function fitView(): void {
  viewport.fit(boundsOf(store.nodes, 110), 90)
}

useShortcuts({ fitView, resetZoom: () => viewport.setZoom(1) })

const shellClass = computed(() => `nf-shell--${ui.shellTheme}`)

/* AI 生图弹窗：由检查器「AI 生图」按钮触发；关闭时清空目标节点以便下次重开重置 */
const aiOpen = ref(false)
const aiNode = ref<StoryNode | null>(null)

function openAiImage(): void {
  const current = store.currentNode
  if (!current) return
  aiNode.value = current
  aiOpen.value = true
}

function onAiOpenChange(value: boolean): void {
  aiOpen.value = value
  if (!value) aiNode.value = null
}
</script>

<template>
  <div class="nf-shell" :class="shellClass">
    <AppHeader />
    <div class="nf-shell__body">
      <FlowSidebar />
      <main class="nf-shell__main">
        <CanvasToolbar />
        <div class="nf-shell__work">
          <FlowCanvas />
          <NodeInspector @open-ai-image="openAiImage" />
        </div>
      </main>
    </div>

    <!-- 全局浮层：抽屉 / 弹窗 / 控制台均由 antd portal 渲染，挂载在此即可 -->
    <StoryEditorDrawer />
    <AiImageDialog :open="aiOpen" :node="aiNode" @update:open="onAiOpenChange" />
    <ApiConsole />
  </div>
</template>

<style scoped>
.nf-shell {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--nf-shell-900);
  color: var(--nf-on-dark);
}

.nf-shell__body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
}

.nf-shell__main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.nf-shell__work {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  position: relative;
}
</style>
