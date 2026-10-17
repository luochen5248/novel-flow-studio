/**
 * NovelFlow MCP · 独立桥接进程（打包态生产通路）
 *
 * 背景（Electron 44.7.0 实测结论，2026-10-17，勿删勿改回 --mcp 参数方案）：
 *  ① exe 无参数 + 管道 stdin → Node CLI 的 eval_stdin 劫持 stdin（JSON-RPC 帧被当
 *     JS 求值报 SyntaxError，app 根本不启动）；
 *  ② exe 带任何脚本参数（-e 或位置参数）→ 脚本模式，内置 electron 模块未注册，
 *     main.cjs 的 require('electron') 直接 Cannot find module；
 *  ③ 结论：GUI exe 无法自己充当 MCP stdio 服务端，桥接必须是独立进程。
 *  ④ 宿主环境注入的 ELECTRON_RUN_AS_NODE=1 会让 GUI exe 退化为纯 node（连双击
 *     启动都复现不了的秒退/bad option 全是它）——spawn GUI 前必须剥离，详见
 *     buildGuiSpawnEnv。
 *
 * 本文件零 electron 依赖（只用 node 内置），两条运行方式（任选其一）：
 *  ① node mcp/standalone.cjs                        （需 node 在 PATH，推荐）
 *  ② "小说时间线工坊.exe" -e "require('<安装目录>/mcp/standalone.cjs').main()"
 *     （免 node-in-PATH，exe 自身即 node 24 运行时；前提：宿主 env 不带
 *     ELECTRON_RUN_AS_NODE=1，否则 exe 不会以 node 身份执行 -e 脚本，见 ④）
 * 需要 GUI 时由 wake.cjs spawn GUI exe（stdio:'ignore' 非管道 → 正常引导启动）。
 *
 * 部署：package.json 的 extraFiles 把整个 electron/mcp/ 投放到安装目录的 mcp/ 下，
 * 桥接与 protocol/tools/control-client/wake/server 同目录，相对 require 自洽。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

/** = package.json 的 name —— Electron userData 目录名（实测 %APPDATA%/novelflow-studio） */
const APP_DIR_NAME = 'novelflow-studio'
const GUI_EXE_NAME = '小说时间线工坊.exe'

/**
 * 解析 GUI 的 userData 目录（control.json 所在）。纯函数，可测。
 * 与 Electron 的 app.getPath('userData') 对齐：win=%APPDATA%/<name>，
 * mac=~/Library/Application Support/<name>，linux=~/.config/<name>。
 */
function resolveUserDataDir({ env = process.env, platform = process.platform } = {}) {
  if (env.NOVELFLOW_USERDATA) return env.NOVELFLOW_USERDATA
  if (platform === 'win32') {
    const appData =
      env.APPDATA || path.join(env.USERPROFILE || env.HOME || '.', 'AppData', 'Roaming')
    return path.join(appData, APP_DIR_NAME)
  }
  if (platform === 'darwin') {
    return path.join(env.HOME || '.', 'Library', 'Application Support', APP_DIR_NAME)
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || '.', '.config'), APP_DIR_NAME)
}

/**
 * 解析 GUI exe 路径。纯函数，可测。
 * 优先级：env.NOVELFLOW_GUI_EXE > execPath（-e 方式下即 GUI 自身）> 桥接同目录。
 */
function resolveGuiExe({ env = process.env, execPath = process.execPath, moduleDir = __dirname } = {}) {
  if (env.NOVELFLOW_GUI_EXE) return env.NOVELFLOW_GUI_EXE
  if (path.basename(execPath).toLowerCase() === GUI_EXE_NAME.toLowerCase()) return execPath
  return path.join(moduleDir, GUI_EXE_NAME)
}

/** 从 app-update.yml 提取版本号（安装目录 resources/ 下）；失败回 '0.0.0' */
function parseVersionFromYml(text) {
  const m = /^version:\s*(\S+)\s*$/m.exec(text || '')
  return m ? m[1] : '0.0.0'
}

function readInstalledVersion(moduleDir) {
  try {
    const yml = fs.readFileSync(path.join(moduleDir, '..', 'resources', 'app-update.yml'), 'utf-8')
    return parseVersionFromYml(yml)
  } catch {
    return '0.0.0'
  }
}

/**
 * 构造 spawn GUI 用的环境：剥离宿主（WorkBuddy 等 AI 宿主）注入的 node 专用变量。
 * 纯函数，可测。
 *
 * 实测（2026-10-17）：桥接进程被宿主 spawn 时环境里带着
 *   ELECTRON_RUN_AS_NODE=1 —— GUI exe 会因此退化成纯 node：无参数+管道 stdin 被
 *   eval_stdin 当 JS 求值、stdio:'ignore' 读空 stdin 当空脚本秒退（exit 0），
 *   表现为「怎么都唤不醒」。用户从资源管理器双击时环境里没有它，故一直正常。
 *   NODE_OPTIONS=--require=<宿主语言 shim> —— 打包态 Electron 明确不支持，
 *   启动日志刷 "Most NODE_OPTIONs are not supported in packaged apps" 警告。
 * 两者对桥接自身（node）无害，对 GUI（Electron）致命，故只清 spawn 目标的环境。
 */
function buildGuiSpawnEnv(env = process.env) {
  const clean = { ...env }
  delete clean.ELECTRON_RUN_AS_NODE
  delete clean.NODE_OPTIONS
  return clean
}

/**
 * 生成 spawnGui 回调（wake.cjs 用）。依赖全部可注入，可测：
 *  - 存在性预检同步抛错 → wake.cjs 归一为中文错误（开发态项目目录无 exe 时指路
 *    NOVELFLOW_GUI_EXE）；
 *  - 异步 'error' 兜底监听 —— 未监听的 ChildProcess 'error' 会以未捕获异常崩掉
 *    整个桥接进程（2026-10-17 深探针实测：ENOENT 直接带走桥接）；
 *  - env 经 buildGuiSpawnEnv 清洗（见上）。
 */
function createGuiSpawner({ guiExe, env = process.env, spawnImpl = spawn, fsImpl = fs, logger } = {}) {
  return () => {
    if (!fsImpl.existsSync(guiExe)) {
      throw new Error(
        `未找到主程序可执行文件：${guiExe}。` +
          '若软件安装在其它位置，请设置环境变量 NOVELFLOW_GUI_EXE 指向「小说时间线工坊.exe」'
      )
    }
    // stdio:'ignore' 是关键：GUI 必须以非管道 stdin 启动才能正常引导
    // （管道 stdin 会触发 Node CLI 的 eval_stdin，见文件头结论①）
    const child = spawnImpl(guiExe, [], { detached: true, stdio: 'ignore', env: buildGuiSpawnEnv(env) })
    child.on('error', (err) => {
      logger?.error?.('[mcp] 唤醒主进程失败：', err?.message || err)
    })
    if (typeof child.unref === 'function') child.unref()
    return child
  }
}

/**
 * 组装桥接（依赖全部可注入，可单测）。
 * 返回 { server, client, waker, userDataDir, guiExe, start }。
 */
function createStandaloneBridge({
  stdin = process.stdin,
  stdout = process.stdout,
  env = process.env,
  execPath = process.execPath,
  moduleDir = __dirname,
  spawnImpl,
  fetchImpl,
  sleepImpl,
  logger
} = {}) {
  const { createControlClient } = require('./control-client.cjs')
  const { createWaker } = require('./wake.cjs')
  const { createMcpServer } = require('./server.cjs')

  const userDataDir = resolveUserDataDir({ env })
  const guiExe = resolveGuiExe({ env, execPath, moduleDir })

  const client = createControlClient({ userDataDir, fetchImpl, logger })
  const waker = createWaker({
    client,
    spawnGui: createGuiSpawner({ guiExe, env, spawnImpl, logger }),
    sleepImpl,
    logger
  })
  const server = createMcpServer({
    stdin,
    stdout,
    client,
    waker,
    logger,
    version: readInstalledVersion(moduleDir)
  })

  return { server, client, waker, userDataDir, guiExe, start: () => server.start() }
}

/** 生产入口：console 全量改道 stderr（stdout 只承载 JSON-RPC 帧） */
function main() {
  const toStderr = (...args) => process.stderr.write(args.map((a) => String(a)).join(' ') + '\n')
  for (const level of ['log', 'info', 'warn', 'debug']) {
    console[level] = toStderr
  }

  const bridge = createStandaloneBridge({ logger: { log: toStderr, error: toStderr } })
  bridge.start()

  // MCP 客户端断开管道（关会话 / 杀进程）→ 桥接进程退场，GUI 实例不受影响。
  // 注意：不能在 'end'/'close' 回调里同步 process.exit() —— 与半闭合 stdio 句柄
  // 竞态曾触发 libuv 断言（Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)）。
  // 改为置 exitCode + 延时一帧强制退场：无事可做时 node 自然退出，有在途调用时
  // 定时器兜底。
  const bye = () => {
    process.exitCode = 0
    const timer = setTimeout(() => process.exit(0), 50)
    if (typeof timer.unref === 'function') timer.unref()
  }
  process.stdin.on('end', bye)
  process.stdin.on('close', bye)
  process.stdin.on('error', bye)
}

if (require.main === module) main()

module.exports = {
  main,
  createStandaloneBridge,
  createGuiSpawner,
  buildGuiSpawnEnv,
  resolveUserDataDir,
  resolveGuiExe,
  parseVersionFromYml,
  APP_DIR_NAME,
  GUI_EXE_NAME
}
