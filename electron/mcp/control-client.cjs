/**
 * NovelFlow MCP · 控制服务器客户端（桥接实例侧）
 *
 * 读 userData/control.json 拿端口与 token，向 GUI 实例的本地控制服务器
 * 发 HTTP 请求。零 electron 依赖（只用 node 内置 + 全局 fetch），可单测。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const HEALTH_TIMEOUT = 5_000
const CALL_TIMEOUT = 40_000 // 渲染层超时 30s + 网络余量
const FOCUS_TIMEOUT = 8_000

function createControlClient({ userDataDir, fetchImpl, logger } = {}) {
  const doFetch = fetchImpl || globalThis.fetch
  const log = logger || { log() {}, error() {} }

  function controlPath() {
    return path.join(userDataDir, 'control.json')
  }

  /** 读控制文件；缺失/损坏/缺字段都视为 null（GUI 没起来过或已被清） */
  function readControl() {
    try {
      const parsed = JSON.parse(fs.readFileSync(controlPath(), 'utf-8'))
      if (!parsed || typeof parsed !== 'object' || !parsed.port || !parsed.token) return null
      return parsed
    } catch {
      return null
    }
  }

  async function request(pathname, { method = 'GET', body, timeout } = {}) {
    const control = readControl()
    if (!control) {
      return { ok: false, error: '读取不到主程序的控制文件（control.json），请先打开一次「小说时间线工坊」' }
    }
    const url = `http://127.0.0.1:${control.port}${pathname}`
    try {
      const res = await doFetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${control.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout)
      })
      const text = await res.text()
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        /* 非 JSON 响应：下面统一按错误处理 */
      }
      if (res.status === 401) return { ok: false, error: '控制服务器 token 校验失败，请重启主程序后重试' }
      if (!res.ok) return { ok: false, error: `控制服务器返回 HTTP ${res.status}` }
      if (!json || typeof json !== 'object') return { ok: false, error: '控制服务器返回了无法解析的内容' }
      return json
    } catch (err) {
      if (err?.name === 'TimeoutError') return { ok: false, error: '主程序响应超时，请稍候重试' }
      const code = err?.cause?.code || err?.code
      log.error('[mcp] 控制服务器请求失败', code || err?.message || err)
      return { ok: false, error: `无法连接主程序控制服务器（${code || '网络错误'}）` }
    }
  }

  return {
    readControl,
    health: () => request('/health', { timeout: HEALTH_TIMEOUT }),
    focus: () => request('/focus', { method: 'POST', timeout: FOCUS_TIMEOUT }),
    call: (method, params) =>
      request('/call', { method: 'POST', body: { method, params }, timeout: CALL_TIMEOUT })
  }
}

module.exports = { createControlClient }
