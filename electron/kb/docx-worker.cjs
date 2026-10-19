/**
 * NovelFlow Studio · .docx 解析 worker（electron/kb/docx-worker.cjs）
 *
 * 为什么单独起一个 worker：.docx 的 zlib.inflateRawSync 同步解压 + 全量 XML
 * 正则扫描是同步重计算，放在主进程里跑会霸占事件循环（10MB 档数百 ms~数秒，
 * 期间窗口无响应）。同步计算无法切片 yield，setTimeout 让步对它无效——挪出
 * 主线程是唯一正解。读盘 + 抽取都在本线程完成，只把纯文本回传主进程。
 *
 * 与主进程的契约（kb:read-doc → extractDocxTextViaWorker）：
 *  进：workerData.filePath（.docx 绝对路径）
 *  出：{ ok: true, text } 或 { ok: false, error }
 * 异常一律转 { ok:false } 回传，不在 worker 内抛未捕获异常——未捕获异常会走
 * 'error' 事件，主进程侧按「worker 不可用」回落同步路径，错误信息反而绕一圈。
 */
'use strict'

const fs = require('node:fs')
const { parentPort, workerData } = require('node:worker_threads')

const { extractDocxText } = require('./docx.cjs')

// parentPort 只在 worker 作用域内存在；直接 node 执行本文件属误用，明确报错
if (!parentPort) {
  throw new Error('docx-worker.cjs 只能由 worker_threads 拉起，不能直接执行')
}

const filePath = workerData?.filePath
if (typeof filePath !== 'string' || !filePath) {
  parentPort.postMessage({ ok: false, error: 'docx worker 缺少文件路径参数' })
} else {
  try {
    // 读盘也放在 worker 里：大文件同步读若留在主进程，同样阻塞事件循环
    const text = extractDocxText(fs.readFileSync(filePath))
    parentPort.postMessage({ ok: true, text })
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err?.message || String(err) || 'docx 解析失败' })
  }
}
