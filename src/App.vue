<script setup lang="ts">
import { computed } from 'vue'
import { ConfigProvider, theme } from 'ant-design-vue'
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import AppShell from '@/components/layout/AppShell.vue'
import { useUiStore } from '@/stores/useUiStore'

const ui = useUiStore()

/** antd 弹层随外壳明暗响应式变化，避免「深壳 + 白弹窗」的割裂感 */
const antdTheme = computed(() => ({
  algorithm: ui.shellTheme === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
  token: {
    colorPrimary: '#2aa6b0',
    colorBgContainer: ui.shellTheme === 'dark' ? '#1b2634' : '#ffffff',
    colorBorder: 'rgba(148,172,196,0.18)',
    borderRadius: 10,
    fontFamily:
      'system-ui, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
    fontSize: 13
  }
}))
</script>

<template>
  <ConfigProvider :locale="zhCN" :theme="antdTheme">
    <AppShell />
  </ConfigProvider>
</template>
