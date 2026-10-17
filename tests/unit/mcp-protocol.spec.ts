/**
 * mcp-protocol.spec.ts —— stdio 协议层（JSON-RPC 2.0 帧）单测
 *
 * 覆盖：行缓冲（chunk 切分 / \r\n / 空行 / 半行 flush）、解析错误码、
 * 请求/通知判定、响应与错误帧形状、序列化单行性（协议生死线：
 * 一帧一行，JSON.stringify 会把内容里的换行转义掉）。
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  createLineBuffer,
  parseLine,
  classify,
  makeResponse,
  makeError,
  serialize,
  PARSE_ERROR,
  INVALID_REQUEST,
  SERVER_NOT_INITIALIZED
} = require('../../electron/mcp/protocol.cjs')

describe('createLineBuffer · 行缓冲', () => {
  it('P1 一行被拆成两个 chunk：先不吐，拼齐才吐', () => {
    const buf = createLineBuffer()
    expect(buf.push('{"a":1}\n{"b"')).toEqual(['{"a":1}'])
    expect(buf.push(':2}\n')).toEqual(['{"b":2}'])
  })

  it('P2 一个 chunk 里多行一次性吐出', () => {
    const buf = createLineBuffer()
    expect(buf.push('{"a":1}\n{"b":2}\n{"c":3}\n')).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
  })

  it('P3 \r\n 与空行：换行符剥掉，空行丢弃', () => {
    const buf = createLineBuffer()
    expect(buf.push('{"a":1}\r\n\n\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('P4 flush：流结束时的半行非空则吐出，空则闭嘴', () => {
    const buf = createLineBuffer()
    buf.push('{"a":1}\n{"half"')
    expect(buf.flush()).toEqual(['{"half"'])
    expect(buf.flush()).toEqual([])
  })
})

describe('parseLine · 解析', () => {
  it('P5 合法 JSON 对象', () => {
    const r = parseLine('{"jsonrpc":"2.0","id":1,"method":"ping"}')
    expect(r.ok).toBe(true)
    expect(r.message.method).toBe('ping')
  })

  it('P6 坏 JSON → PARSE_ERROR(-32700)', () => {
    const r = parseLine('{oops')
    expect(r).toEqual({ ok: false, code: PARSE_ERROR, message: 'JSON 解析失败' })
  })

  it('P7 合法 JSON 但不是对象（数组/标量）→ INVALID_REQUEST(-32600)', () => {
    expect(parseLine('[1,2]').code).toBe(INVALID_REQUEST)
    expect(parseLine('42').code).toBe(INVALID_REQUEST)
  })
})

describe('classify · 请求/通知判定', () => {
  it('P8 带 id → request', () => {
    const r = classify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })
    expect(r).toEqual({ ok: true, kind: 'request', id: 7, method: 'tools/list', params: undefined })
  })

  it('P9 id 为 0 / 空串也是 request（falsy 但合法）', () => {
    expect(classify({ id: 0, method: 'ping' }).kind).toBe('request')
    expect(classify({ id: '', method: 'ping' }).kind).toBe('request')
  })

  it('P10 不带 id → notification（initialized / cancelled 等）', () => {
    expect(classify({ method: 'notifications/initialized' }).kind).toBe('notification')
  })

  it('P11 缺 method → INVALID_REQUEST', () => {
    expect(classify({ id: 1 }).code).toBe(INVALID_REQUEST)
    expect(classify({ id: 1, method: 42 }).code).toBe(INVALID_REQUEST)
  })

  it('P12 错误 jsonrpc 版本号 → INVALID_REQUEST', () => {
    expect(classify({ jsonrpc: '1.0', id: 1, method: 'ping' }).code).toBe(INVALID_REQUEST)
  })
})

describe('帧构造 · makeResponse / makeError / serialize', () => {
  it('P13 响应帧形状', () => {
    expect(makeResponse(3, { tools: [] })).toEqual({ jsonrpc: '2.0', id: 3, result: { tools: [] } })
  })

  it('P14 错误帧形状（含可选 data）', () => {
    expect(makeError(3, SERVER_NOT_INITIALIZED, '先 initialize')).toEqual({
      jsonrpc: '2.0',
      id: 3,
      error: { code: SERVER_NOT_INITIALIZED, message: '先 initialize' }
    })
    expect(makeError(null, PARSE_ERROR, '坏', { hint: 'x' }).error.data).toEqual({ hint: 'x' })
  })

  it('P15 id 缺省按协议归一为 null', () => {
    expect(makeResponse(undefined, {}).id).toBeNull()
    expect(makeError(undefined, PARSE_ERROR, 'x').id).toBeNull()
  })

  it('P16 serialize 一帧一行：内容里的换行必须被转义（协议生死线）', () => {
    const line = serialize(makeResponse(1, { text: '第一行\n第二行' }))
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
    expect(JSON.parse(line).result.text).toBe('第一行\n第二行')
  })
})
