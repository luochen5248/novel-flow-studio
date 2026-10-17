/**
 * NovelFlow MCP · 本地控制服务器（GUI 实例侧）
 *
 * 只绑 127.0.0.1 回环；所有端点要求 Bearer token（256 位随机，与端口一起
 * 写入 userData/control.json，mode 0600）。MCP 桥接实例凭该文件接入。
 *
 * 零 electron 依赖：invoke / focus / userDataDir 全部由 main.cjs 注入，
 * node 下起随机端口即可完整单测。
 */
'use strict'

const http = require('node:http')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

/** 默认端口；被占用时回退随机端口（实际值以 control.json 为准） */
const DEFAULT_PORT = 32117
const MAX_BODY_BYTES = 10 * 1024 * 1024

function createControlServer({ userDataDir, invoke, focus, version = '0.0.0', port = DEFAULT_PORT, logger } = {}) {
  const log = logger || { log() {}, error() {} }
  const token = crypto.randomBytes(32).toString('hex')
  const controlPath = path.join(userDataDir, 'control.json')
  let actualPort = port

  function writeControlFile() {
    const payload = {
      port: actualPort,
      token,
      pid: process.pid,
      version,
      startedAt: Date.now()
    }
    try {
      fs.mkdirSync(userDataDir, { recursive: true })
      fs.writeFileSync(controlPath, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 })
    } catch (err) {
      log.error('[mcp] 写入 control.json 失败', err?.message || err)
    }
  }

  function removeControlFile() {
    try {
      fs.unlinkSync(controlPath)
    } catch {
      /* 本就可能不存在（启动失败即被清理） */
    }
  }

  function sendJson(res, status, payload) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    res.end(JSON.stringify(payload))
  }

  function authorized(req) {
    return (req.headers['authorization'] || '') === `Bearer ${token}`
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      let tooLarge = false
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          // 超限不中途销毁连接（客户端会收到 reset 而不是 413）：
          // 继续排空剩余数据，收齐后再拒绝，保证 413 完整送达
          tooLarge = true
          chunks.length = 0
          return
        }
        if (!tooLarge) chunks.push(chunk)
      })
      req.on('end', () => {
        if (tooLarge) {
          reject(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }))
          return
        }
        resolve(Buffer.concat(chunks).toString('utf-8'))
      })
      req.on('error', reject)
    })
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (!authorized(req)) {
        sendJson(res, 401, { ok: false, error: 'token 校验失败：本服务仅允许本机已授权进程调用' })
        return
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, app: 'novelflow', version })
        return
      }
      if (req.method === 'POST' && url.pathname === '/focus') {
        try {
          focus?.()
        } catch (err) {
          log.error('[mcp] 聚焦窗口失败', err?.message || err)
        }
        sendJson(res, 200, { ok: true })
        return
      }
      if (req.method === 'POST' && url.pathname === '/call') {
        const raw = await readBody(req)
        let payload = null
        try {
          payload = JSON.parse(raw)
        } catch {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const method = payload?.method
        if (typeof method !== 'string' || !method) {
          sendJson(res, 400, { ok: false, error: '缺少「method」字段' })
          return
        }
        const params = Array.isArray(payload?.params) ? payload.params : []
        const result = await invoke(method, params)
        sendJson(res, 200, result && typeof result === 'object' ? result : { ok: true, data: result })
        return
      }
      const known = url.pathname === '/health' || url.pathname === '/call' || url.pathname === '/focus'
      sendJson(res, known ? 405 : 404, { ok: false, error: `路由不存在：${req.method} ${url.pathname}` })
    } catch (err) {
      if (err?.code === 'BODY_TOO_LARGE') {
        sendJson(res, 413, { ok: false, error: '请求体超过 10MB 上限' })
        return
      }
      log.error('[mcp] 控制服务器异常', err)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: '控制服务器内部错误' })
    }
  })

  async function start() {
    await new Promise((resolve, reject) => {
      let settled = false
      const done = (fn) => (arg) => {
        if (settled) return
        settled = true
        fn(arg)
      }
      const onError = (err) => {
        // 默认端口被占：回退随机端口（bridge 以 control.json 的实际端口为准）
        if (err?.code === 'EADDRINUSE' && port !== 0) {
          server.listen(0, '127.0.0.1')
          return
        }
        done(reject)(err)
      }
      server.on('error', onError)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError)
        done(resolve)()
      })
    })
    actualPort = server.address().port
    writeControlFile()
    log.log(`[mcp] 控制服务器已监听 127.0.0.1:${actualPort}（token 已写入 control.json）`)
    return { port: actualPort, token }
  }

  function stop() {
    removeControlFile()
    server.close()
  }

  return { start, stop, getToken: () => token, getPort: () => actualPort }
}

module.exports = { createControlServer, DEFAULT_PORT, MAX_BODY_BYTES }
