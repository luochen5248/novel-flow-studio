import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

/**
 * NovelFlow Studio — 构建配置
 *
 * grsai 的密钥保存在 .env.local（已 gitignore），只在 dev server 进程内读取，
 * 通过 /api/grsai 代理转发时注入 Authorization 头，前端产物里不含任何密钥。
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'GRSAI_')
  const apiKey = env.GRSAI_API_KEY ?? ''

  return {
    plugins: [vue()],
    // 相对路径：Electron 用 file:// 协议加载 dist/index.html，绝对 '/' 会白屏
    base: './',
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    server: {
      port: 5173,
      host: '127.0.0.1',
      proxy: {
        '/api/grsai': {
          target: 'https://grsai.dakka.com.cn',
          changeOrigin: true,
          secure: true,
          rewrite: (path: string) => path.replace(/^\/api\/grsai/, ''),
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
        }
      }
    },
    build: {
      target: 'es2020',
      chunkSizeWarningLimit: 1200
    },
    test: {
      environment: 'jsdom',
      include: ['tests/**/*.spec.ts']
    }
  }
})
