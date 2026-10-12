/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

/*
 * 注：window.NovelFlow 的类型由 src/api/aiApi.ts（Max-B）以 declare global 声明，
 * 这里不再重复声明，避免 TS2717「后续属性声明必须具有相同的类型」。
 */
