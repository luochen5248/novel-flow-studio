/**
 * NovelFlow MCP · stdio 协议层（JSON-RPC 2.0 帧）
 *
 * 纯函数、零依赖、electron-free：可在 node / vitest 下单测。
 * 纪律：stdout 只允许出现本模块 serialize() 产出的行——日志一律走 stderr
 * （main.cjs 的 --mcp 分支负责把 console 全量改道）。
 */
'use strict'

const JSONRPC_VERSION = '2.0'

/* JSON-RPC 2.0 标准错误码 + MCP 扩展码 */
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603
/** MCP：客户端未先 initialize 就发业务请求 */
const SERVER_NOT_INITIALIZED = -32002

/**
 * 默认协议版本。客户端 initialize 时带了 protocolVersion 就原样回弹
 * （ spec 允许服务端回退自身最新版；回弹客户端版本对兼容性最友好，
 *   本服务只用到 tools/resources 两个能力，各版本间无行为差异）。
 */
const DEFAULT_PROTOCOL_VERSION = '2025-06-18'

/**
 * 逐行缓冲：管道 chunk 可能把一行切成两半，也可能把多行拼在一起；
 * 空行直接丢弃（stdio 上的心跳/空白行很常见）。
 */
function createLineBuffer() {
  let tail = ''
  return {
    /** 吃进一段原始数据，返回其中完整的行（不含换行符）；不足一行留在缓冲 */
    push(chunk) {
      tail += String(chunk ?? '')
      const lines = []
      let idx
      while ((idx = tail.indexOf('\n')) >= 0) {
        const line = tail.slice(0, idx).replace(/\r$/, '')
        tail = tail.slice(idx + 1)
        if (line.trim()) lines.push(line)
      }
      return lines
    },
    /** 流结束时若还剩半行且非空，作为最后一行吐出 */
    flush() {
      const rest = tail.replace(/\r$/, '')
      tail = ''
      return rest.trim() ? [rest] : []
    }
  }
}

/** 解析一行 JSON；失败返回错误码（按协议 id 用 null，由调用方补） */
function parseLine(line) {
  try {
    const msg = JSON.parse(line)
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return { ok: false, code: INVALID_REQUEST, message: '消息必须是 JSON 对象' }
    }
    return { ok: true, message: msg }
  } catch {
    return { ok: false, code: PARSE_ERROR, message: 'JSON 解析失败' }
  }
}

/** 判定请求 / 通知并做最小校验；返回归一化形状或错误码 */
function classify(msg) {
  const method = msg?.method
  if (typeof method !== 'string' || !method) {
    return { ok: false, code: INVALID_REQUEST, message: '缺少 method 字段' }
  }
  if (msg.jsonrpc !== undefined && msg.jsonrpc !== JSONRPC_VERSION) {
    return { ok: false, code: INVALID_REQUEST, message: `不支持的 jsonrpc 版本：${String(msg.jsonrpc)}` }
  }
  const hasId = msg.id !== undefined && msg.id !== null
  if (hasId) {
    return { ok: true, kind: 'request', id: msg.id, method, params: msg.params }
  }
  return { ok: true, kind: 'notification', method, params: msg.params }
}

function makeResponse(id, result) {
  return { jsonrpc: JSONRPC_VERSION, id: id ?? null, result }
}

function makeError(id, code, message, data) {
  const error = { code, message }
  if (data !== undefined) error.data = data
  return { jsonrpc: JSONRPC_VERSION, id: id ?? null, error }
}

/** 序列化：单行 JSON + 换行符（协议帧单位） */
function serialize(message) {
  return JSON.stringify(message) + '\n'
}

module.exports = {
  JSONRPC_VERSION,
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
  SERVER_NOT_INITIALIZED,
  DEFAULT_PROTOCOL_VERSION,
  createLineBuffer,
  parseLine,
  classify,
  makeResponse,
  makeError,
  serialize
}
