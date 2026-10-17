/**
 * NovelFlow MCP · stdio 服务组装（桥接实例）
 *
 * 职责：stdin 逐行读 JSON-RPC → 分发 → 需要 GUI 的先唤醒 → 经控制客户端
 * 转发到渲染层 window.NovelFlow → 结果包成 MCP content 写回 stdout。
 *
 * 纪律：
 *  - 本模块零 electron 依赖：node 下即可完整单测（main.cjs 只负责注入
 *    stdin/stdout/client/waker）；
 *  - stdout 只写 serialize() 产物；日志走注入的 logger（stderr）。
 */
'use strict'

const {
  createLineBuffer,
  parseLine,
  classify,
  makeResponse,
  makeError,
  serialize,
  DEFAULT_PROTOCOL_VERSION,
  SERVER_NOT_INITIALIZED,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR
} = require('./protocol.cjs')
const { parseToolCall, listTools } = require('./tools.cjs')

const SERVER_NAME = 'novelflow-mcp'

const MCP_RESOURCES = [
  {
    uri: 'novelflow://flows',
    name: '故事线列表',
    description: '全部故事线的 id / 名称 / 节点数 / 连线数',
    mimeType: 'application/json'
  },
  {
    uri: 'novelflow://outline',
    name: '当前故事线大纲',
    description: '当前故事线的 Markdown 大纲（含 YAML front matter）',
    mimeType: 'text/markdown'
  }
]

function createMcpServer({ stdin, stdout, client, waker, logger, version = '0.0.0' }) {
  const log = logger || { log() {}, error() {} }
  const buffer = createLineBuffer()
  let initialized = false
  let closed = false

  function write(message) {
    if (closed) return
    try {
      stdout.write(serialize(message))
    } catch (err) {
      log.error('[mcp] stdout 写出失败', err?.message || err)
    }
  }

  /** MCP tools/call 的内容包装：失败时 isError:true + 中文错误文本 */
  function textResult(text, isError = false) {
    const content = [{ type: 'text', text }]
    return isError ? { content, isError: true } : { content }
  }

  function stringifyData(data) {
    return typeof data === 'string' ? data : JSON.stringify(data ?? null, null, 2)
  }

  /** 确保 GUI 就绪；返回 null 或中文错误串 */
  async function ensureGuiOrError() {
    const result = await waker.ensureGui()
    return result.ok ? null : result.error
  }

  /** 经控制服务器调渲染层 NovelFlow */
  async function callNovelFlow(method, args) {
    const guiError = await ensureGuiOrError()
    if (guiError) return { ok: false, error: guiError }
    return client.call(method, args)
  }

  async function handleToolsCall(id, params) {
    const name = params?.name
    if (typeof name !== 'string' || !name) {
      write(makeError(id, INVALID_PARAMS, 'tools/call 缺少参数「name」'))
      return
    }
    const parsed = parseToolCall(name, params.arguments)
    if (!parsed.ok) {
      // 未知工具 / 参数非法：按 MCP 惯例走 isError 内容而非 JSON-RPC 错误，
      // 让 AI 客户端能读到中文原因并自我纠正
      write(makeResponse(id, textResult(parsed.error, true)))
      return
    }
    const { call } = parsed

    if (call.kind === 'special') {
      if (call.action === 'wake') {
        const guiError = await ensureGuiOrError()
        if (guiError) {
          write(makeResponse(id, textResult(guiError, true)))
          return
        }
        const focusRes = await client.focus()
        const payload = {
          ok: true,
          windowFocused: focusRes.ok !== false,
          hint: focusRes.ok ? '主程序已唤醒并聚焦' : '主程序已唤醒，但窗口聚焦失败，请手动切换'
        }
        write(makeResponse(id, textResult(JSON.stringify(payload, null, 2))))
        return
      }
      if (call.action === 'status') {
        const health = await client.health()
        if (!health.ok) {
          write(
            makeResponse(
              id,
              textResult(
                JSON.stringify(
                  { running: false, hint: '主程序未运行，可调用 novelflow_wake 唤醒' },
                  null,
                  2
                )
              )
            )
          )
          return
        }
        const flows = await client.call('listFlows', [])
        const payload = {
          running: true,
          version: health.version ?? null,
          flows: flows.ok ? flows.data : null,
          ...(flows.ok ? {} : { flowsError: flows.error })
        }
        write(makeResponse(id, textResult(JSON.stringify(payload, null, 2))))
        return
      }
      // export / api 都是「先确保 GUI，再转发」
      const result = await callNovelFlow(call.method, call.args)
      if (!result.ok) {
        write(makeResponse(id, textResult(`调用失败：${result.error}`, true)))
        return
      }
      write(makeResponse(id, textResult(stringifyData(result.data))))
      return
    }

    // kind === 'method'：显式工具 → NovelFlow 方法
    const result = await callNovelFlow(call.method, call.args)
    if (!result.ok) {
      write(makeResponse(id, textResult(`调用失败：${result.error}`, true)))
      return
    }
    write(makeResponse(id, textResult(stringifyData(result.data))))
  }

  async function handleResourcesRead(id, params) {
    const uri = params?.uri
    if (typeof uri !== 'string' || !uri) {
      write(makeError(id, INVALID_PARAMS, 'resources/read 缺少参数「uri」'))
      return
    }
    let method = null
    if (uri === 'novelflow://flows') method = 'listFlows'
    else if (uri === 'novelflow://outline') method = 'exportMarkdown'
    if (!method) {
      write(makeError(id, INVALID_PARAMS, `未知资源「${uri}」，可调用 resources/list 查看全部资源`))
      return
    }
    const result = await callNovelFlow(method, [])
    if (!result.ok) {
      write(makeError(id, INTERNAL_ERROR, `读取资源失败：${result.error}`))
      return
    }
    const mimeType = method === 'listFlows' ? 'application/json' : 'text/markdown'
    const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? null, null, 2)
    write(makeResponse(id, { contents: [{ uri, mimeType, text }] }))
  }

  function handleInitialize(id, params) {
    const requested = params?.protocolVersion
    const protocolVersion =
      typeof requested === 'string' && requested.trim() ? requested.trim() : DEFAULT_PROTOCOL_VERSION
    initialized = true
    write(
      makeResponse(id, {
        protocolVersion,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: SERVER_NAME, title: '小说时间线工坊 MCP 桥', version }
      })
    )
  }

  async function handleMessage(msg) {
    const classified = classify(msg)
    if (!classified.ok) {
      write(makeError(msg?.id ?? null, classified.code, classified.message))
      return
    }
    const { kind, id, method, params } = classified
    if (kind === 'notification') return // 通知一律不应答（initialized / cancelled 等）

    if (!initialized && method !== 'initialize' && method !== 'ping') {
      write(makeError(id, SERVER_NOT_INITIALIZED, '请先发送 initialize 再调用其他方法'))
      return
    }

    try {
      switch (method) {
        case 'initialize':
          return handleInitialize(id, params)
        case 'ping':
          return write(makeResponse(id, {}))
        case 'tools/list':
          return write(makeResponse(id, { tools: listTools() }))
        case 'tools/call':
          return await handleToolsCall(id, params)
        case 'resources/list':
          return write(makeResponse(id, { resources: MCP_RESOURCES }))
        case 'resources/read':
          return await handleResourcesRead(id, params)
        default:
          return write(makeError(id, METHOD_NOT_FOUND, `未知方法「${method}」`))
      }
    } catch (err) {
      log.error('[mcp] 消息处理异常', err)
      write(makeError(id, INTERNAL_ERROR, `服务内部错误：${err?.message || err}`))
    }
  }

  function onLine(line) {
    const parsed = parseLine(line)
    if (!parsed.ok) {
      write(makeError(null, parsed.code, parsed.message))
      return
    }
    void handleMessage(parsed.message)
  }

  function start() {
    stdin.on('data', (chunk) => {
      for (const line of buffer.push(chunk)) onLine(line)
    })
    stdin.on('end', () => {
      for (const line of buffer.flush()) onLine(line)
      close()
    })
    stdin.on('error', () => close())
    log.log(`[mcp] stdio 服务已启动（${SERVER_NAME} v${version}），等待 initialize`)
  }

  function close() {
    closed = true
  }

  return { start, close }
}

module.exports = { createMcpServer }
