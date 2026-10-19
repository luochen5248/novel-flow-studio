/**
 * mcp-bridge.spec.ts —— 唤醒逻辑 + stdio 服务端到端 + 渲染层桥
 *
 * 三块：
 *  A. wake.cjs：已运行不 spawn / 未运行 spawn+退避轮询 / 超时中文错误 /
 *     失败不 memo（可重试）/ spawn 自身失败；
 *  B. server.cjs 端到端（PassThrough 假管道 + 假控制客户端，electron-free）：
 *     initialize 门禁、协议版本回弹、通知不应答、tools/list、tools/call
 *     （含唤醒触发与错误路径）、resources、坏行 -32700；
 *  C. rendererBridge.ts（jsdom）：正常回包 / 方法不存在 / 抛异常归一 /
 *     NovelFlow 未就绪 / 无 electronAPI 静默跳过；
 *  D. standalone.cjs：userData/exe 路径解析、版本提取、GUI spawn 环境清洗
 *     （ELECTRON_RUN_AS_NODE/NODE_OPTIONS 剥离，2026-10-17 实测根因）与
 *     spawner 的存在性预检 / error 兜底；
 *  E. control-server.cjs：control.json 心跳自愈与 removeControlFile 的 pid 守卫。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createWaker } = require('../../electron/mcp/wake.cjs')
const { createMcpServer } = require('../../electron/mcp/server.cjs')
const {
  resolveUserDataDir,
  resolveGuiExe,
  parseVersionFromYml,
  buildGuiSpawnEnv,
  createGuiSpawner,
  GUI_EXE_NAME
} = require('../../electron/mcp/standalone.cjs')
const { createControlServer } = require('../../electron/control-server.cjs')
const { PassThrough } = require('node:stream')
const { EventEmitter } = require('node:events')
const nodeFs = require('node:fs')
const nodeOs = require('node:os')
const nodePath = require('node:path')

const silent = { log() {}, error() {} }

/* ================================================================== */
/* A · 唤醒逻辑                                                         */
/* ================================================================== */

describe('wake · 唤醒逻辑', () => {
  it('W1 已运行：不 spawn，直接放行', async () => {
    let spawned = 0
    const waker = createWaker({
      client: { health: async () => ({ ok: true, version: '1.0.0' }) },
      spawnGui: () => {
        spawned += 1
      },
      sleepImpl: async () => {},
      timeoutMs: 5000,
      logger: silent
    })
    const r = await waker.ensureGui()
    expect(r).toEqual({ ok: true, spawned: false })
    expect(spawned).toBe(0)
  })

  it('W2 未运行：spawn 一次 + 指数退避轮询（300 → 600），就绪后放行', async () => {
    let spawned = 0
    const delays: number[] = []
    let healthCalls = 0
    const waker = createWaker({
      client: {
        health: async () => {
          healthCalls += 1
          return healthCalls >= 3 ? { ok: true, version: '1.0.0' } : { ok: false, error: 'x' }
        }
      },
      spawnGui: () => {
        spawned += 1
      },
      sleepImpl: async (ms: number) => {
        delays.push(ms)
      },
      timeoutMs: 5000,
      logger: silent
    })
    const r = await waker.ensureGui()
    expect(r).toEqual({ ok: true, spawned: true })
    expect(spawned).toBe(1)
    expect(delays).toEqual([300, 600])
  })

  it('W3 超时：中文错误，且失败不 memo（下次可重试）', async () => {
    let spawned = 0
    const waker = createWaker({
      client: { health: async () => ({ ok: false, error: 'x' }) },
      spawnGui: () => {
        spawned += 1
      },
      sleepImpl: async () => {},
      timeoutMs: 800,
      logger: silent
    })
    const r1 = await waker.ensureGui()
    expect(r1.ok).toBe(false)
    expect(r1.error).toContain('超时')
    const r2 = await waker.ensureGui()
    expect(r2.ok).toBe(false)
    expect(spawned).toBe(2)
  })

  it('W4 spawn 自身抛错：归一为中文错误', async () => {
    const waker = createWaker({
      client: { health: async () => ({ ok: false, error: 'x' }) },
      spawnGui: () => {
        throw new Error('EACCES')
      },
      sleepImpl: async () => {},
      timeoutMs: 5000,
      logger: silent
    })
    const r = await waker.ensureGui()
    expect(r).toEqual({ ok: false, error: '唤醒主程序失败：EACCES' })
  })

  it('W5 成功后 memo：并发第二个调用不重复 spawn', async () => {
    let spawned = 0
    let healthCalls = 0
    const waker = createWaker({
      client: {
        health: async () => {
          healthCalls += 1
          return healthCalls >= 2 ? { ok: true, version: '1.0.0' } : { ok: false, error: 'x' }
        }
      },
      spawnGui: () => {
        spawned += 1
      },
      sleepImpl: async () => {},
      timeoutMs: 5000,
      logger: silent
    })
    const [a, b] = await Promise.all([waker.ensureGui(), waker.ensureGui()])
    expect(a.ok && b.ok).toBe(true)
    expect(spawned).toBe(1)
  })
})

/* ================================================================== */
/* B · stdio 服务端到端                                                  */
/* ================================================================== */

describe('server · stdio 端到端（假管道 + 假控制客户端）', () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let stdoutRaw = ''
  const clientCalls: Array<{ method: string; params: unknown[] }> = []
  let focusCount = 0
  let healthOk = false

  beforeAll(() => {
    stdout.on('data', (chunk: Buffer) => {
      stdoutRaw += String(chunk)
    })
    const client = {
      health: async () => (healthOk ? { ok: true, version: '9.9.9' } : { ok: false, error: 'x' }),
      focus: async () => {
        focusCount += 1
        return { ok: true }
      },
      call: async (method: string, params: unknown[]) => {
        clientCalls.push({ method, params })
        if (method === 'addNode') return { ok: true, data: { id: 'n1', title: '雨夜' } }
        if (method === 'listFlows') return { ok: true, data: [{ id: 'f1', name: '锚点', nodes: 3, edges: 2 }] }
        if (method === 'exportMarkdown') return { ok: true, data: '# 锚点大纲' }
        if (method === 'reset') return { ok: false, error: '渲染层出错了' }
        return { ok: true, data: null }
      }
    }
    const waker = createWaker({
      client,
      spawnGui: () => {
        healthOk = true // 假 spawn：唤醒后 health 转通
      },
      sleepImpl: async () => {},
      timeoutMs: 5000,
      logger: silent
    })
    const server = createMcpServer({ stdin, stdout, client, waker, logger: silent, version: '9.9.9' })
    server.start()
  })

  function send(obj: unknown) {
    stdin.write(JSON.stringify(obj) + '\n')
  }

  async function nextResponse(index: number, timeout = 2000): Promise<any> {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const lines = stdoutRaw.split('\n').filter(Boolean)
      if (lines.length > index) return JSON.parse(lines[index])
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error(`等待第 ${index + 1} 条响应超时；当前输出：${stdoutRaw}`)
  }

  it('E1 initialize 之前发业务请求 → -32002 门禁', async () => {
    send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'novelflow_help', arguments: {} } })
    const res = await nextResponse(0)
    expect(res.error.code).toBe(-32002)
  })

  it('E2 initialize：协议版本回弹 + capabilities + serverInfo', async () => {
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
    })
    const res = await nextResponse(1)
    expect(res.id).toBe(2)
    expect(res.result.protocolVersion).toBe('2025-06-18')
    expect(res.result.capabilities.tools).toBeDefined()
    expect(res.result.serverInfo.name).toBe('novelflow-mcp')
    expect(res.result.serverInfo.version).toBe('9.9.9')
  })

  it('E3 notifications/initialized 不应答', async () => {
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    await new Promise((r) => setTimeout(r, 60))
    expect(stdoutRaw.split('\n').filter(Boolean)).toHaveLength(2)
  })

  it('E4 tools/list：49 个工具', async () => {
    send({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    const res = await nextResponse(2)
    expect(res.result.tools).toHaveLength(49)
    expect(res.result.tools.map((t: { name: string }) => t.name)).toContain('novelflow_add_node')
  })

  it('E5 tools/call add_node：自动唤醒 → 转发 addNode → 文本结果', async () => {
    send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'novelflow_add_node', arguments: { title: '雨夜', kind: 'event' } }
    })
    const res = await nextResponse(3)
    expect(res.result.isError).toBeUndefined()
    expect(res.result.content[0].text).toContain('"id": "n1"')
    expect(clientCalls.at(-1)).toEqual({ method: 'addNode', params: [{ title: '雨夜', kind: 'event' }] })
  })

  it('E6 tools/call 参数非法 → isError + 中文原因', async () => {
    send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'novelflow_add_node', arguments: {} } })
    const res = await nextResponse(4)
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0].text).toContain('title')
  })

  it('E7 tools/call 未知工具 → isError', async () => {
    send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'novelflow_nope', arguments: {} } })
    const res = await nextResponse(5)
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0].text).toContain('未知工具')
  })

  it('E8 渲染层失败 → isError 透传中文错误', async () => {
    send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'novelflow_api', arguments: { method: 'reset', args: [] } } })
    const res = await nextResponse(6)
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0].text).toContain('渲染层出错了')
  })

  it('E9 ping → 空 result', async () => {
    send({ jsonrpc: '2.0', id: 8, method: 'ping' })
    const res = await nextResponse(7)
    expect(res.result).toEqual({})
  })

  it('E10 resources/list：两个资源', async () => {
    send({ jsonrpc: '2.0', id: 9, method: 'resources/list' })
    const res = await nextResponse(8)
    expect(res.result.resources.map((r: { uri: string }) => r.uri)).toEqual([
      'novelflow://flows',
      'novelflow://outline'
    ])
  })

  it('E11 resources/read novelflow://flows → JSON 内容', async () => {
    send({ jsonrpc: '2.0', id: 10, method: 'resources/read', params: { uri: 'novelflow://flows' } })
    const res = await nextResponse(9)
    expect(res.result.contents[0].mimeType).toBe('application/json')
    expect(res.result.contents[0].text).toContain('锚点')
  })

  it('E12 resources/read 未知 URI → -32602', async () => {
    send({ jsonrpc: '2.0', id: 11, method: 'resources/read', params: { uri: 'novelflow://bogus' } })
    const res = await nextResponse(10)
    expect(res.error.code).toBe(-32602)
  })

  it('E13 未知方法 → -32601', async () => {
    send({ jsonrpc: '2.0', id: 12, method: 'prompts/list' })
    const res = await nextResponse(11)
    expect(res.error.code).toBe(-32601)
  })

  it('E14 坏行 → -32700 且 id 为 null', async () => {
    stdin.write('this is not json\n')
    const res = await nextResponse(12)
    expect(res.error.code).toBe(-32700)
    expect(res.id).toBeNull()
  })

  it('E15 tools/call novelflow_wake：已就绪 → 聚焦窗口', async () => {
    send({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'novelflow_wake', arguments: {} } })
    const res = await nextResponse(13)
    expect(res.result.isError).toBeUndefined()
    expect(res.result.content[0].text).toContain('windowFocused')
    expect(focusCount).toBe(1)
  })

  it('E16 tools/call novelflow_status：运行中 + 故事线概览（不唤醒）', async () => {
    send({ jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'novelflow_status', arguments: {} } })
    const res = await nextResponse(14)
    expect(res.result.content[0].text).toContain('"running": true')
    expect(res.result.content[0].text).toContain('锚点')
  })

  it('E17 tools/call novelflow_export markdown → 文本直出', async () => {
    send({ jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'novelflow_export', arguments: { format: 'markdown' } } })
    const res = await nextResponse(15)
    expect(res.result.content[0].text).toBe('# 锚点大纲')
  })

  it('E18 空行被忽略，不产生任何响应', async () => {
    const before = stdoutRaw.split('\n').filter(Boolean).length
    stdin.write('\n\n')
    await new Promise((r) => setTimeout(r, 60))
    expect(stdoutRaw.split('\n').filter(Boolean)).toHaveLength(before)
  })
})

/* ================================================================== */
/* C · 渲染层桥（jsdom）                                                */
/* ================================================================== */

describe('rendererBridge · 渲染层调用桥', () => {
  const replies: Array<{ callId: string; result: unknown }> = []
  const seen: unknown[] = []
  let invoke: ((payload: { callId: string; method: string; params: unknown[] }) => void) | null = null

  beforeAll(async () => {
    ;(window as any).electronAPI = {
      mcp: {
        onInvoke: (cb: (payload: unknown) => void) => {
          invoke = cb as typeof invoke
          return () => {}
        },
        reply: (callId: string, result: unknown) => replies.push({ callId, result })
      }
    }
    ;(window as any).NovelFlow = {
      addNode: (input: unknown) => {
        seen.push(input)
        return { ok: true, data: { id: 'n1' } }
      },
      boom: () => {
        throw new Error('炸了')
      },
      slow: async () => ({ ok: true, data: 'late' })
    }
    await import('@/mcp/rendererBridge')
  })

  it('R1 安装后 onInvoke 已注册', () => {
    expect(typeof invoke).toBe('function')
  })

  it('R2 正常调用：参数透传 + 结果原样回包', async () => {
    invoke!({ callId: 'c1', method: 'addNode', params: [{ title: 'x' }] })
    await vi.waitFor(() => expect(replies.at(-1)).toEqual({ callId: 'c1', result: { ok: true, data: { id: 'n1' } } }))
    expect(seen.at(-1)).toEqual({ title: 'x' })
  })

  it('R3 异步方法：await 后再回包', async () => {
    invoke!({ callId: 'c2', method: 'slow', params: [] })
    await vi.waitFor(() => expect(replies.at(-1)).toEqual({ callId: 'c2', result: { ok: true, data: 'late' } }))
  })

  it('R4 方法抛异常 → 归一 {ok:false,error}', async () => {
    invoke!({ callId: 'c3', method: 'boom', params: [] })
    await vi.waitFor(() => expect(replies.at(-1)).toEqual({ callId: 'c3', result: { ok: false, error: '炸了' } }))
  })

  it('R5 方法不存在 → 归一 {ok:false,error}', async () => {
    invoke!({ callId: 'c4', method: 'nope', params: [] })
    await vi.waitFor(() => {
      expect(replies.at(-1)?.result).toMatchObject({ ok: false })
      expect((replies.at(-1)?.result as { error: string }).error).toContain('没有方法')
    })
  })

  it('R6 NovelFlow 未就绪 → 归一 {ok:false,error}', async () => {
    delete (window as any).NovelFlow
    invoke!({ callId: 'c5', method: 'addNode', params: [] })
    await vi.waitFor(() => {
      expect((replies.at(-1)?.result as { error: string }).error).toContain('尚未就绪')
    })
    ;(window as any).NovelFlow = { addNode: (input: unknown) => ({ ok: true, data: input }) }
  })

  it('R7 无 electronAPI 的环境：重复 import 不炸、不注册', async () => {
    vi.resetModules()
    delete (window as any).electronAPI
    await expect(import('@/mcp/rendererBridge')).resolves.toBeDefined()
    // 还原环境，避免影响后续（无更多用例，仅为整洁）
    ;(window as any).electronAPI = { mcp: { onInvoke: () => () => {}, reply: () => {} } }
  })
})

/* ================================================================== */
/* D · standalone.cjs 路径解析 / 版本提取 / GUI spawn 环境清洗            */
/* ================================================================== */

describe('standalone · 路径与版本解析', () => {
  it('S1 resolveUserDataDir：win32 取 %APPDATA%/<name>', () => {
    expect(
      resolveUserDataDir({
        env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming', NOVELFLOW_USERDATA: undefined },
        platform: 'win32'
      })
    ).toBe('C:\\Users\\x\\AppData\\Roaming\\novelflow-studio')
  })

  it('S2 resolveUserDataDir：darwin / linux 分支', () => {
    expect(resolveUserDataDir({ env: { HOME: '/home/x' }, platform: 'darwin' })).toBe(
      nodePath.join('/home/x', 'Library', 'Application Support', 'novelflow-studio')
    )
    expect(resolveUserDataDir({ env: { HOME: '/home/x' }, platform: 'linux' })).toBe(
      nodePath.join('/home/x', '.config', 'novelflow-studio')
    )
  })

  it('S3 resolveUserDataDir：env 覆盖优先（测试注入口）', () => {
    expect(resolveUserDataDir({ env: { NOVELFLOW_USERDATA: 'D:/tmp/ud' }, platform: 'win32' })).toBe('D:/tmp/ud')
  })

  it('S4 resolveGuiExe：env 覆盖 > execPath 自识别 > 桥接同目录', () => {
    expect(resolveGuiExe({ env: { NOVELFLOW_GUI_EXE: 'D:/x.exe' }, execPath: 'C:/node.exe', moduleDir: 'D:/mcp' })).toBe(
      'D:/x.exe'
    )
    expect(
      resolveGuiExe({ env: {}, execPath: 'C:/Program Files/novelflow-studio/小说时间线工坊.exe', moduleDir: 'D:/mcp' })
    ).toBe('C:/Program Files/novelflow-studio/小说时间线工坊.exe')
    expect(resolveGuiExe({ env: {}, execPath: 'C:/node.exe', moduleDir: 'D:/mcp' })).toBe(
      nodePath.join('D:/mcp', GUI_EXE_NAME)
    )
  })

  it('S5 parseVersionFromYml：提取 / 缺失 / 损坏', () => {
    expect(parseVersionFromYml('version: 0.4.0\nfoo: bar')).toBe('0.4.0')
    expect(parseVersionFromYml('')).toBe('0.0.0')
    expect(parseVersionFromYml('no version here')).toBe('0.0.0')
  })
})

describe('standalone · GUI spawn 环境清洗（2026-10-17 实测根因）', () => {
  it('S6 buildGuiSpawnEnv：剥离 ELECTRON_RUN_AS_NODE 与 NODE_OPTIONS，其余原样', () => {
    const input = {
      PATH: 'C:\\Windows',
      APPDATA: 'C:\\Users\\x\\AppData\\Roaming',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--require=C:/shim.cjs',
      NOVELFLOW_GUI_EXE: 'C:/app.exe'
    }
    const clean = buildGuiSpawnEnv(input)
    expect(clean.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(clean.NODE_OPTIONS).toBeUndefined()
    expect(clean.PATH).toBe('C:\\Windows')
    expect(clean.APPDATA).toBe(input.APPDATA)
    expect(clean.NOVELFLOW_GUI_EXE).toBe('C:/app.exe')
    // 不改调用方对象
    expect(input.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('S7 createGuiSpawner：exe 缺失 → 同步抛错并指路 NOVELFLOW_GUI_EXE', () => {
    const spawner = createGuiSpawner({
      guiExe: 'D:/nope/小说时间线工坊.exe',
      fsImpl: { existsSync: () => false }
    })
    expect(() => spawner()).toThrow(/NOVELFLOW_GUI_EXE/)
    expect(() => spawner()).toThrow(/未找到主程序可执行文件/)
  })

  it('S8 createGuiSpawner：spawn 参数/env 清洗/error 兜底/unref', () => {
    const child = new EventEmitter() as any
    child.unref = vi.fn()
    const spawnImpl = vi.fn(
      (
        _file: string,
        _args: string[],
        _opts: { detached?: boolean; stdio?: unknown; env: Record<string, string | undefined> }
      ) => child
    )
    const errors: unknown[] = []
    const spawner = createGuiSpawner({
      guiExe: 'C:/app/小说时间线工坊.exe',
      env: { PATH: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1' },
      spawnImpl,
      fsImpl: { existsSync: () => true },
      logger: { log() {}, error: (...a: unknown[]) => errors.push(a) }
    })
    spawner()
    expect(spawnImpl).toHaveBeenCalledTimes(1)
    const [file, args, opts] = spawnImpl.mock.calls[0]
    expect(file).toBe('C:/app/小说时间线工坊.exe')
    expect(args).toEqual([])
    expect(opts.detached).toBe(true)
    expect(opts.stdio).toBe('ignore')
    expect(opts.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(opts.env.PATH).toBe('C:\\Windows')
    expect(child.unref).toHaveBeenCalled()
    // 异步 error 不再以未捕获异常崩掉桥接，仅记录日志
    expect(() => child.emit('error', new Error('boom'))).not.toThrow()
    expect(errors.length).toBe(1)
    expect(String(errors[0])).toContain('boom')
  })
})

/* ================================================================== */
/* E · control-server.cjs 心跳自愈 / pid 守卫                            */
/* ================================================================== */

describe('controlServer · control.json 心跳与删除守卫', () => {
  let tmpDir: string

  function readControlFile(dir: string) {
    return JSON.parse(nodeFs.readFileSync(nodePath.join(dir, 'control.json'), 'utf-8'))
  }

  function writeControlFile(dir: string, payload: unknown) {
    nodeFs.writeFileSync(nodePath.join(dir, 'control.json'), JSON.stringify(payload), 'utf-8')
  }

  it('E-a 心跳：文件被外部篡改后一个周期内自我修正', async () => {
    tmpDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'nf-cs-hb-'))
    const server = createControlServer({
      userDataDir: tmpDir,
      invoke: async () => ({ ok: true }),
      focus: () => {},
      version: '9.9.9',
      port: 0,
      heartbeatMs: 40,
      logger: silent
    })
    await server.start()
    const own = readControlFile(tmpDir)
    expect(own.pid).toBe(process.pid)

    writeControlFile(tmpDir, { port: 1, token: 'stale', pid: 999999, version: '0.0.0', startedAt: 1 })
    await new Promise((r) => setTimeout(r, 120))
    const healed = readControlFile(tmpDir)
    expect(healed.token).toBe(own.token)
    expect(healed.port).toBe(own.port)
    expect(healed.pid).toBe(process.pid)

    server.stop()
  })

  it('E-b heartbeatMs=0：不起心跳，篡改不被修正', async () => {
    tmpDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'nf-cs-nohb-'))
    const server = createControlServer({
      userDataDir: tmpDir,
      invoke: async () => ({ ok: true }),
      focus: () => {},
      version: '9.9.9',
      port: 0,
      heartbeatMs: 0,
      logger: silent
    })
    await server.start()
    writeControlFile(tmpDir, { port: 1, token: 'stale', pid: 999999, version: '0.0.0', startedAt: 1 })
    await new Promise((r) => setTimeout(r, 80))
    expect(readControlFile(tmpDir).token).toBe('stale')
    server.stop()
  })

  it('E-c removeControlFile pid 守卫：外来条目不删，自己的条目才删', async () => {
    tmpDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'nf-cs-pid-'))
    const server = createControlServer({
      userDataDir: tmpDir,
      invoke: async () => ({ ok: true }),
      focus: () => {},
      version: '9.9.9',
      port: 0,
      heartbeatMs: 0,
      logger: silent
    })
    await server.start()
    const own = readControlFile(tmpDir)

    // 外来条目（模拟旧版让位实例覆盖 / 新主进程已接管）→ stop 不得删除
    writeControlFile(tmpDir, { ...own, pid: 999999, token: 'other' })
    server.stop()
    expect(nodeFs.existsSync(nodePath.join(tmpDir, 'control.json'))).toBe(true)

    // 自己的条目 → stop 删除（stop 已调用过一次，这里直接验证文件仍属外来条目）
    // 重新起一个实例验证「自己的条目被删」
    const server2 = createControlServer({
      userDataDir: tmpDir,
      invoke: async () => ({ ok: true }),
      focus: () => {},
      version: '9.9.9',
      port: 0,
      heartbeatMs: 0,
      logger: silent
    })
    await server2.start()
    server2.stop()
    expect(nodeFs.existsSync(nodePath.join(tmpDir, 'control.json'))).toBe(false)
  })
})
