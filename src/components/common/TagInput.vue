<script setup lang="ts">
import { ref } from 'vue'
import { Tag as ATag, Input as AInput } from 'ant-design-vue'

/**
 * TagInput —— 回车增删的标签编辑器
 *
 * 用于检查器的「人物」「标签」两组字段：展示为可关闭的胶囊，
 * 输入框回车即新增（自动去重）。通过 v-model 与 store 解耦，
 * 父组件拿到新数组后自己走 updateNode。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string[]
    placeholder?: string
  }>(),
  { placeholder: '输入后回车' }
)

const emit = defineEmits<{ (e: 'update:modelValue', value: string[]): void }>()

const draft = ref('')

function add(): void {
  const value = draft.value.trim()
  if (!value) return
  if (!props.modelValue.includes(value)) {
    emit('update:modelValue', [...props.modelValue, value])
  }
  draft.value = ''
}

function remove(value: string): void {
  emit(
    'update:modelValue',
    props.modelValue.filter((item) => item !== value)
  )
}
</script>

<template>
  <div class="nf-taginput">
    <span v-for="item in modelValue" :key="item" class="nf-taginput__chip">
      <ATag closable :bordered="false" @close="remove(item)">{{ item }}</ATag>
    </span>
    <AInput
      v-model:value="draft"
      size="small"
      class="nf-taginput__input"
      :placeholder="placeholder"
      @press-enter="add"
    />
  </div>
</template>

<style scoped>
.nf-taginput {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.nf-taginput__chip {
  display: inline-flex;
}

.nf-taginput__input {
  flex: 1 1 96px;
  min-width: 96px;
}
</style>
