/**
 * mcp-tools.spec.ts —— 工具注册表单测
 *
 * 覆盖：49 工具注册完整性（字段/唯一性/方法都在 NovelFlow 白名单）、
 * 各工具参数校验（必填/枚举/长度/批量上限）、方法映射（args 形状）、
 * 不可序列化方法（exportPNG / download / subscribe）的拦截。
 *
 * 计数随 MCP 注册表演进，新增工具时同步此常量（TOOLS / NOVELFLOW_METHODS）。
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  NOVELFLOW_METHODS,
  NON_SERIALIZABLE_METHODS,
  TOOLS,
  listTools,
  findTool,
  parseToolCall
} = require('../../electron/mcp/tools.cjs')

describe('注册表完整性', () => {
  it('T1 恰好 49 个工具，名称唯一', () => {
    expect(TOOLS).toHaveLength(49)
    const names = TOOLS.map((t: { name: string }) => t.name)
    expect(new Set(names).size).toBe(49)
  })

  it('T2 每个工具都有中文 description 与 object 型 inputSchema', () => {
    for (const tool of TOOLS) {
      expect(typeof tool.description).toBe('string')
      expect(tool.description.length).toBeGreaterThan(2)
      expect(tool.inputSchema.type).toBe('object')
    }
  })

  it('T3 listTools 只外露 name/description/inputSchema（不泄露 parse）', () => {
    const list = listTools()
    expect(list).toHaveLength(49)
    for (const item of list) {
      expect(Object.keys(item).sort()).toEqual(['description', 'inputSchema', 'name'])
    }
  })

  it('T4 显式工具的 method 全部在 NovelFlow 白名单内', () => {
    for (const tool of TOOLS) {
      const call = tool.parse({})
      if (call.ok && call.kind === 'method') {
        expect(NOVELFLOW_METHODS).toContain(call.method)
      }
    }
  })

  it('T5 白名单覆盖 aiApi 全部 35 方法（含 3 个不可序列化）', () => {
    expect(NOVELFLOW_METHODS).toHaveLength(58)
    expect(NON_SERIALIZABLE_METHODS).toEqual(['exportPNG', 'download', 'subscribe'])
  })
})

describe('参数校验 · 节点类', () => {
  it('T6 add_node 缺 title 报错', () => {
    const r = parseToolCall('novelflow_add_node', {})
    expect(r.ok).toBe(false)
    expect(r.error).toContain('title')
  })

  it('T7 add_node kind 非法值报错并列出候选', () => {
    const r = parseToolCall('novelflow_add_node', { title: 'x', kind: 'boss' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('event')
  })

  it('T8 add_node 全字段合法 → 干净 input（未知键被剥掉）', () => {
    const r = parseToolCall('novelflow_add_node', {
      title: '雨夜初遇',
      kind: 'event',
      afterId: 'n1',
      timeLabel: '第一章 · 雨夜',
      summary: '两人相遇',
      characters: ['阿离', '老周'],
      tags: ['主线'],
      lane: 0,
      junk: 'x'
    })
    expect(r.ok).toBe(true)
    expect(r.call).toEqual({
      kind: 'method',
      method: 'addNode',
      args: [
        {
          title: '雨夜初遇',
          kind: 'event',
          afterId: 'n1',
          timeLabel: '第一章 · 雨夜',
          summary: '两人相遇',
          characters: ['阿离', '老周'],
          tags: ['主线'],
          lane: 0
        }
      ]
    })
  })

  it('T9 add_nodes 空数组 / 超 100 / 数组项坏 都报错', () => {
    expect(parseToolCall('novelflow_add_nodes', { nodes: [] }).error).toContain('非空数组')
    const many = Array.from({ length: 101 }, () => ({ title: 'x' }))
    expect(parseToolCall('novelflow_add_nodes', { nodes: many }).error).toContain('100')
    const bad = parseToolCall('novelflow_add_nodes', { nodes: [{ title: 'ok' }, { kind: 'nope' }] })
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('第 2 个节点')
  })

  it('T10 add_nodes 合法 → 批量映射', () => {
    const r = parseToolCall('novelflow_add_nodes', { nodes: [{ title: 'a' }, { title: 'b' }] })
    expect(r.call.method).toBe('addNodes')
    expect(r.call.args[0]).toEqual([{ title: 'a' }, { title: 'b' }])
  })

  it('T11 update_node 缺 patch 报错', () => {
    expect(parseToolCall('novelflow_update_node', { id: 'n1' }).error).toContain('patch')
  })
})

describe('参数校验 · 连边 / 批量 / 导出 / 逃生门', () => {
  it('T12 add_edge 缺端点报错；options 只收已知键', () => {
    expect(parseToolCall('novelflow_add_edge', { sourceId: 'a' }).error).toContain('targetId')
    const r = parseToolCall('novelflow_add_edge', {
      sourceId: 'a',
      targetId: 'b',
      options: { label: '然后', kind: 'branch', dashed: true, junk: 1 }
    })
    expect(r.call).toEqual({
      kind: 'method',
      method: 'addEdge',
      args: ['a', 'b', { label: '然后', kind: 'branch', dashed: true }]
    })
  })

  it('T13 add_edge kind 非法报错', () => {
    expect(parseToolCall('novelflow_add_edge', { sourceId: 'a', targetId: 'b', options: { kind: 'x' } }).error).toContain('kind')
  })

  it('T14 batch 命令项必须是 [方法名, ...参数]，且过白名单', () => {
    expect(parseToolCall('novelflow_batch', { commands: 'x' }).error).toContain('非空数组')
    expect(parseToolCall('novelflow_batch', { commands: [['nope']] }).error).toContain('白名单')
    expect(parseToolCall('novelflow_batch', { commands: [['addNode', { title: 'x' }]] }).ok).toBe(true)
  })

  it('T15 batch 里出现不可序列化方法被拦截', () => {
    const r = parseToolCall('novelflow_batch', { commands: [['exportPNG']] })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('不可序列化')
  })

  it('T16 export 格式枚举 + 方法映射', () => {
    expect(parseToolCall('novelflow_export', { format: 'pdf' }).error).toContain('format')
    const r = parseToolCall('novelflow_export', { format: 'markdown' })
    expect(r.call).toEqual({ kind: 'special', action: 'export', method: 'exportMarkdown', args: [] })
  })

  it('T17 api 逃生门：未知方法 / 不可序列化方法 / args 非数组 都被拒', () => {
    expect(parseToolCall('novelflow_api', { method: 'nope' }).error).toContain('不是 NovelFlow 方法')
    expect(parseToolCall('novelflow_api', { method: 'exportPNG' }).error).toContain('不可 JSON 序列化')
    expect(parseToolCall('novelflow_api', { method: 'addNode', args: 'x' }).error).toContain('数组')
    const ok = parseToolCall('novelflow_api', { method: 'setNodeImage', args: ['n1', 'https://x/y.png'] })
    expect(ok.call).toEqual({ kind: 'special', action: 'api', method: 'setNodeImage', args: ['n1', 'https://x/y.png'] })
  })

  it('T18 未知工具名 → 中文错误', () => {
    const r = parseToolCall('novelflow_nope', {})
    expect(r.ok).toBe(false)
    expect(r.error).toContain('未知工具')
  })

  it('T19 findTool 命中/未命中', () => {
    expect(findTool('novelflow_wake')?.name).toBe('novelflow_wake')
    expect(findTool('nope')).toBeNull()
  })

  it('T20 wake / status / help / undo 等无参工具 parse 直接通过', () => {
    for (const name of ['novelflow_wake', 'novelflow_status', 'novelflow_help', 'novelflow_undo', 'novelflow_redo', 'novelflow_get_state', 'novelflow_list_flows']) {
      expect(parseToolCall(name, undefined).ok).toBe(true)
    }
  })
})
