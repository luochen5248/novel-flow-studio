/**
 * NovelFlow MCP · 唤醒逻辑（桥接实例侧）
 *
 * health 不通就 spawn GUI 实例，再指数退避轮询等待它就绪。
 * 成功结果 memo（后续调用走快路）；失败不 memo（下次允许重试）。
 * 零 electron 依赖，spawn/sleep 全部可注入，可单测。
 */
'use strict'

function createWaker({ client, spawnGui, sleepImpl, timeoutMs = 20_000, logger } = {}) {
  const sleep = sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const log = logger || { log() {} }
  let memo = null

  async function ensureGui() {
    if (memo) return memo
    const attempt = (async () => {
      const first = await client.health()
      if (first.ok) return { ok: true, spawned: false }

      log.log('[mcp] 主程序未运行，尝试唤醒…')
      try {
        spawnGui()
      } catch (err) {
        return { ok: false, error: `唤醒主程序失败：${err?.message || err}` }
      }

      const deadline = Date.now() + timeoutMs
      let delay = 300
      for (;;) {
        await sleep(delay)
        const health = await client.health()
        if (health.ok) return { ok: true, spawned: true }
        if (Date.now() >= deadline) break
        delay = Math.min(delay * 2, 2400)
      }
      return {
        ok: false,
        error: `主程序启动超时（${Math.round(timeoutMs / 1000)} 秒）。请手动打开「小说时间线工坊」后重试；若软件已在运行，请升级到包含 MCP 功能的版本`
      }
    })()

    memo = attempt.then(
      (result) => {
        if (!result.ok) memo = null // 失败不 memo：放行下一次重试
        return result
      },
      (err) => {
        memo = null
        throw err
      }
    )
    return memo
  }

  return { ensureGui }
}

module.exports = { createWaker }
