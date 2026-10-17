/**
 * control-server.spec.ts —— GUI 侧本地控制服务器单测
 *
 * 真起 http 服务（随机端口）+ 真实 fetch：token 鉴权、三个端点路由、
 * control.json 落盘内容、异常与体量上限、stop 清理。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { createControlServer } = require('../../electron/control-server.cjs')

let userDataDir: string
let server: any
let port = 0
let token = ''
const invoked: Array<{ method: string; params: unknown[] }> = []
let focusCount = 0

beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelflow-mcp-'))
  server = createControlServer({
    userDataDir,
    port: 0,
    version: '9.9.9',
    invoke: async (method: string, params: unknown[]) => {
      invoked.push({ method, params })
      if (method === 'boom') throw new Error('渲染层炸了')
      return { ok: true, data: { echo: method } }
    },
    focus: () => {
      focusCount += 1
    },
    logger: { log() {}, error() {} }
  })
  const info = await server.start()
  port = info.port
  token = info.token
})

afterAll(() => {
  server.stop()
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

function api(pathname: string, init?: RequestInit, auth = true) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers: {
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {})
    }
  })
}

describe('控制服务器 · control.json 与健康检查', () => {
  it('C1 control.json 落盘：端口/令牌/pid/version 齐全，令牌 64 hex', () => {
    const raw = fs.readFileSync(path.join(userDataDir, 'control.json'), 'utf-8')
    const json = JSON.parse(raw)
    expect(json.port).toBe(port)
    expect(json.token).toMatch(/^[0-9a-f]{64}$/)
    expect(typeof json.pid).toBe('number')
    expect(json.version).toBe('9.9.9')
    expect(typeof json.startedAt).toBe('number')
  })

  it('C2 GET /health 带 token → 应用信息', async () => {
    const res = await api('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, app: 'novelflow', version: '9.9.9' })
  })
})

describe('控制服务器 · 鉴权', () => {
  it('C3 无 token → 401', async () => {
    const res = await api('/health', undefined, false)
    expect(res.status).toBe(401)
    expect((await res.json()).ok).toBe(false)
  })

  it('C4 错 token → 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: 'Bearer wrong' }
    })
    expect(res.status).toBe(401)
  })
})

describe('控制服务器 · 调用路由', () => {
  it('C5 POST /call 转发到 invoke 并原样回传结果', async () => {
    const res = await api('/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'addNode', params: [{ title: 'x' }] })
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, data: { echo: 'addNode' } })
    expect(invoked.at(-1)).toEqual({ method: 'addNode', params: [{ title: 'x' }] })
  })

  it('C6 /call 缺 method → 400', async () => {
    const res = await api('/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: [] })
    })
    expect(res.status).toBe(400)
  })

  it('C7 /call 体非 JSON → 400', async () => {
    const res = await api('/call', { method: 'POST', body: 'not-json' })
    expect(res.status).toBe(400)
  })

  it('C8 invoke 抛异常 → 500 且不泄内部细节给协议层以外', async () => {
    const res = await api('/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'boom', params: [] })
    })
    expect(res.status).toBe(500)
    expect((await res.json()).ok).toBe(false)
  })

  it('C9 params 缺省按空数组处理', async () => {
    const res = await api('/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'listFlows' })
    })
    expect(res.status).toBe(200)
    expect(invoked.at(-1)).toEqual({ method: 'listFlows', params: [] })
  })
})

describe('控制服务器 · 路由与方法不匹配', () => {
  it('C10 GET /call → 405', async () => {
    const res = await api('/call')
    expect(res.status).toBe(405)
  })

  it('C11 未知路径 → 404', async () => {
    const res = await api('/nope')
    expect(res.status).toBe(404)
  })
})

describe('控制服务器 · 体量上限与窗口聚焦', () => {
  it('C12 请求体超 10MB → 413', async () => {
    const huge = JSON.stringify({ method: 'addNode', params: [{ title: 'x'.repeat(11 * 1024 * 1024) }] })
    const res = await api('/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: huge
    })
    expect(res.status).toBe(413)
  })

  it('C13 POST /focus → 触发聚焦回调', async () => {
    const res = await api('/focus', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(focusCount).toBe(1)
  })
})

describe('控制服务器 · 清理', () => {
  it('C14 stop 后 control.json 删除、端口拒绝连接', async () => {
    server.stop()
    expect(fs.existsSync(path.join(userDataDir, 'control.json'))).toBe(false)
    await expect(api('/health')).rejects.toThrow()
  })
})
