/**
 * NovelFlow Studio · 知识库数据库层（sql.js）
 *
 * 职责：知识条目 / 节点关联 / 文档 / 文档锚点 / 作者记忆 / 偏好 / 工作过程事件
 * 的统一持久化。全部数据落在 userData/novelflow.db 一个文件里，与 localStorage
 * 工作区（故事线）完全隔离 —— 知识库是跨故事线的「作者资产」，不进故事 JSON。
 *
 * sql.js 是 SQLite 的 wasm 构建，两条硬约束决定了本文件的写法：
 *  1. **没有增量写**：每次 flush 都是 `db.export()` 整库序列化 + 整文件替换。
 *     所以落盘策略 = 结构变更（建表 / 删条目 / 全量导入）立即 flush，内容变更
 *     走 2s 防抖（FLUSH_DEBOUNCE_MS），退出前三处强制 flush 由 main.cjs 挂。
 *  2. **官方预编译构建无 FTS5，且 unicode61 分词器不切中文**（CJK 整串一个
 *     token）—— 检索主路径是「标题 / 标签 LIKE 预筛 + 相关性精排放到渲染层
 *     `src/core/kb/search.ts` 纯函数」，这里不建任何 FTS 虚拟表。
 *
 * 三条纪律：
 *  - 所有查询一律 `db.exec(sql, params)` / `db.run(sql, params)` 绑定参数，
 *    **禁字符串拼 SQL**（入口是 IPC，防注入）；
 *  - 本模块只在 GUI 实例初始化（main.cjs 的 whenReady GUI 分支调用
 *    `initKbStore()`）；MCP 桥接实例（MCP_MODE）是无窗口 stdio 进程，
 *    这里再加一层注释性守卫双保险；
 *  - 损坏降级照 readConfig 的哲学：旧文件备份成 .bak 后重建空库，
 *    「一个坏库不能让整个知识库功能不可用」。
 */
'use strict'

const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
// app 只在 initKbStore 的 GUI 分支里真正用到（MCP_MODE 早退），但顶层 require
// 是安全的：本模块只会被 Electron 主进程加载
const { app } = require('electron')

/** 与 main.cjs:37 同源的 MCP_MODE 判定（main.cjs 早退 + 这里守卫，双保险） */
const MCP_MODE = process.argv.includes('--mcp') || process.env.NOVELFLOW_MCP === '1'

/** 内容变更的落盘防抖窗口：连续编辑不反复重写全库，最多丢一个窗口（退出前会强制 flush） */
const FLUSH_DEBOUNCE_MS = 2000
/** 工作事件表保留条数上限（防 db 无界膨胀） */
const EVENT_KEEP_LIMIT = 500
/** 同 kind + refId 的事件合并窗口（拖一下鼠标不该刷出几十条） */
const EVENT_MERGE_WINDOW_MS = 60_000
/** 每插入这么多次事件清理一次旧数据（避免每次 INSERT 都跑一遍 DELETE） */
const EVENT_TRIM_EVERY = 50

/** 知识条目类型白名单（UI 过滤标签与主进程校验共用） */
const ENTRY_TYPES = ['note', 'setting', 'character', 'plot', 'style']
/** 作者记忆类型白名单 */
const MEMORY_TYPES = ['preference', 'fact', 'decision', 'background']
/** 记忆来源：manual = 作者手写 / assist = AI 结果转存 / auto = 整理升格 */
const MEMORY_SOURCES = ['manual', 'assist', 'auto']
/** 文档格式白名单（kb:read-doc 的后缀过滤与此一致） */
const DOC_FORMATS = ['md', 'txt', 'docx']

/** 建表 DDL：与任务书逐字一致（IF NOT EXISTS，重复初始化安全） */
const DDL = [
  `CREATE TABLE IF NOT EXISTS kb_entries (id TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'note', content TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS kb_links (id INTEGER PRIMARY KEY AUTOINCREMENT, entryId TEXT NOT NULL, nodeId TEXT NOT NULL, flowId TEXT, createdAt INTEGER NOT NULL);`,
  `CREATE INDEX IF NOT EXISTS idx_kb_links_node ON kb_links(nodeId);`,
  `CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, format TEXT NOT NULL, content TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS doc_links (id INTEGER PRIMARY KEY AUTOINCREMENT, docId TEXT NOT NULL, nodeId TEXT NOT NULL, flowId TEXT, createdAt INTEGER NOT NULL);`,
  `CREATE INDEX IF NOT EXISTS idx_doc_links_node ON doc_links(nodeId);`,
  `CREATE TABLE IF NOT EXISTS doc_anchors (id TEXT PRIMARY KEY, docId TEXT NOT NULL, nodeId TEXT, quote TEXT NOT NULL, startOffset INTEGER NOT NULL, endOffset INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', createdAt INTEGER NOT NULL);`,
  `CREATE INDEX IF NOT EXISTS idx_doc_anchors_doc ON doc_anchors(docId);`,
  `CREATE INDEX IF NOT EXISTS idx_doc_anchors_node ON doc_anchors(nodeId);`,
  `CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual', pinned INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt INTEGER NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS kb_events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, refId TEXT, summary TEXT, createdAt INTEGER NOT NULL);`,
  `CREATE INDEX IF NOT EXISTS idx_kb_events_created_at ON kb_events(createdAt);`
]

/* ------------------------------------------------------------------ */
/* 内部状态                                                             */
/* ------------------------------------------------------------------ */

let db = null
let dbPath = ''
let flushTimer = null
let insertSinceTrim = 0
let initPromise = null

/* ------------------------------------------------------------------ */
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`
}

/** SELECT：返回普通对象数组（列名即键；sql.js 的 exec 已支持参数绑定） */
function queryAll(sql, params = []) {
  const res = db.exec(sql, params)
  if (!res.length) return []
  const cols = res[0].columns
  return res[0].values.map((row) => {
    const obj = {}
    cols.forEach((c, i) => {
      obj[c] = row[i]
    })
    return obj
  })
}

function queryOne(sql, params = []) {
  return queryAll(sql, params)[0] ?? null
}

/** LIKE 通配符转义：用户输入里的 % _ \ 不当通配符（配 ESCAPE '\' 使用） */
function escapeLike(text) {
  return String(text ?? '').replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

function parseTags(raw) {
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter((t) => typeof t === 'string')
  } catch {
    /* 坏 tags 字符串降级为空数组：一条脏数据不该让列表白屏 */
  }
  return []
}

function now() {
  return Date.now()
}

/* ---- 行 → 契约对象（与 src/core/kb/types.ts 逐字段对齐） ---- */

function rowToEntry(row) {
  return {
    id: row.id,
    title: row.title,
    type: ENTRY_TYPES.includes(row.type) ? row.type : 'note',
    content: row.content ?? '',
    tags: parseTags(row.tags),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function rowToDoc(row) {
  return {
    id: row.id,
    title: row.title,
    format: row.format,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...('content' in row ? { content: row.content ?? '' } : {})
  }
}

function rowToAnchor(row) {
  return {
    id: row.id,
    docId: row.docId,
    nodeId: typeof row.nodeId === 'string' ? row.nodeId : null,
    quote: row.quote ?? '',
    startOffset: row.startOffset ?? 0,
    endOffset: row.endOffset ?? 0,
    note: row.note ?? '',
    createdAt: row.createdAt
  }
}

function rowToMemory(row) {
  return {
    id: row.id,
    type: MEMORY_TYPES.includes(row.type) ? row.type : 'fact',
    content: row.content ?? '',
    source: MEMORY_SOURCES.includes(row.source) ? row.source : 'manual',
    pinned: row.pinned === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function rowToEvent(row) {
  return {
    id: row.id,
    kind: row.kind,
    refId: typeof row.refId === 'string' ? row.refId : null,
    summary: row.summary ?? '',
    createdAt: row.createdAt
  }
}

/* ------------------------------------------------------------------ */
/* 初始化与落盘                                                         */
/* ------------------------------------------------------------------ */

/**
 * 初始化数据库（幂等；并发调用共享同一个 Promise）。
 *
 * wasm 必须显式读 Buffer 喂 `initSqlJs({ wasmBinary })`：
 * emscripten 默认按 `__dirname` 定位 sql-wasm.wasm，本项目 dev 路径是
 * 「D:\小说\…」、产品名「小说时间线工坊」——含中文的 Windows 路径下
 * emscripten 的文件定位有失败 / 挂起实例。`fs.readFileSync` 走宽字符 API
 * 无此问题，且主进程的 fs 是 asar-aware 的（打包态读 app.asar 内文件
 * 透明解压，不需要 asarUnpack）——与托盘图标 createFromBuffer 同一教训
 * （main.cjs setupTray 的注释）。
 */
async function initKbStore() {
  if (initPromise) return initPromise
  initPromise = (async () => {
    // 注释性守卫：MCP 桥接实例（无窗口 stdio 进程）绝不初始化数据库。
    // main.cjs 的 whenReady 早退已天然保证，这里再挡一层防将来误调用。
    if (MCP_MODE) return
    if (db) return

    const initSqlJs = require('sql.js')
    const wasmPath = path.join(app.getAppPath(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
    const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) })

    dbPath = path.join(app.getPath('userData'), 'novelflow.db')
    let opened = null
    if (fs.existsSync(dbPath)) {
      try {
        opened = new SQL.Database(fs.readFileSync(dbPath))
      } catch (err) {
        // 损坏降级（照 readConfig 哲学）：旧文件备份为 .bak 后重建空库，
        // 宁可丢历史也不让知识库整个功能不可用
        try {
          fs.renameSync(dbPath, `${dbPath}.bak`)
        } catch {
          /* 备份失败也要继续：下面重建空库 */
        }
        console.error('[kb] 本地数据库损坏，已备份为 .bak 并重建空库：', err?.message ?? String(err))
      }
    }
    db = opened ?? new SQL.Database()

    for (const ddl of DDL) db.run(ddl)
    // 建表属于结构变更：立即落盘，保证「首次启动也有库文件」
    flushNow()
  })()
  return initPromise
}

function isKbReady() {
  return !!db
}

/** 原子落盘：先写 .tmp 再 renameSync —— 半截库比坏 JSON 致命，绝不让写一半的文件顶掉好库 */
function flushNow() {
  if (!db) return
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  fs.writeFileSync(`${dbPath}.tmp`, Buffer.from(db.export()))
  fs.renameSync(`${dbPath}.tmp`, dbPath)
}

/** 内容变更：2s 防抖（连续编辑合并成一次全量重写） */
function scheduleFlush() {
  if (!db) return
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    try {
      flushNow()
    } catch (err) {
      console.error('[kb] 防抖落盘失败：', err?.message ?? String(err))
    }
  }, FLUSH_DEBOUNCE_MS)
}

/* ------------------------------------------------------------------ */
/* 知识条目                                                             */
/* ------------------------------------------------------------------ */

function kbListEntries() {
  return queryAll('SELECT * FROM kb_entries ORDER BY updatedAt DESC').map(rowToEntry)
}

function kbGetEntry(id) {
  const row = queryOne('SELECT * FROM kb_entries WHERE id = ?', [id])
  return row ? rowToEntry(row) : null
}

function kbCreateEntry(input) {
  const id = newId('e')
  const ts = now()
  db.run(
    `INSERT INTO kb_entries (id, title, type, content, tags, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.title,
      input.type ?? 'note',
      input.content ?? '',
      JSON.stringify(input.tags ?? []),
      ts,
      ts
    ]
  )
  scheduleFlush()
  return kbGetEntry(id)
}

function kbUpdateEntry(id, patch) {
  const prev = kbGetEntry(id)
  if (!prev) return null
  const next = {
    title: patch.title ?? prev.title,
    type: patch.type ?? prev.type,
    content: patch.content ?? prev.content,
    tags: patch.tags ?? prev.tags
  }
  db.run('UPDATE kb_entries SET title = ?, type = ?, content = ?, tags = ?, updatedAt = ? WHERE id = ?', [
    next.title,
    next.type,
    next.content,
    JSON.stringify(next.tags),
    now(),
    id
  ])
  scheduleFlush()
  return kbGetEntry(id)
}

function kbRemoveEntry(id) {
  // 删条目是结构变更：立即 flush；关联的 kb_links 行一并清掉（不留悬空链接）
  db.run('DELETE FROM kb_links WHERE entryId = ?', [id])
  db.run('DELETE FROM kb_entries WHERE id = ?', [id])
  flushNow()
  return true
}

/**
 * 检索主路径：标题 / 标签 LIKE 预筛，ORDER BY 里按字段加权
 * （标题命中 ×3 > 标签命中 ×2 > 正文命中 ×1），同分按更新时间倒序。
 * 中文相关性精排（标题优先 + 时间衰减）在渲染层 search.ts 纯函数做。
 */
function kbSearchEntries(query, limit = 50) {
  const q = String(query ?? '').trim()
  if (!q) return kbListEntries().slice(0, limit)
  const like = `%${escapeLike(q)}%`
  const rows = queryAll(
    `SELECT * FROM kb_entries
     WHERE title LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
     ORDER BY (title LIKE ? ESCAPE '\\') * 3 + (tags LIKE ? ESCAPE '\\') * 2 + (content LIKE ? ESCAPE '\\') DESC, updatedAt DESC
     LIMIT ?`,
    [like, like, like, like, like, like, limit]
  )
  return rows.map(rowToEntry)
}

/* ------------------------------------------------------------------ */
/* 节点关联（kb_links / doc_links）                                      */
/* ------------------------------------------------------------------ */

/** 按 nodeId 反查：知识条目 + 关联文档（文档不带 content，列表要保持轻） */
function kbListNodeLinks(nodeId) {
  const entries = queryAll(
    `SELECT e.* FROM kb_links l JOIN kb_entries e ON e.id = l.entryId
     WHERE l.nodeId = ? ORDER BY l.id DESC`,
    [nodeId]
  ).map(rowToEntry)
  const docs = queryAll(
    `SELECT d.id, d.title, d.format, d.createdAt, d.updatedAt
     FROM doc_links l JOIN documents d ON d.id = l.docId
     WHERE l.nodeId = ? ORDER BY l.id DESC`,
    [nodeId]
  ).map(rowToDoc)
  return { entries, docs }
}

function kbLinkEntry(entryId, nodeId, flowId = null) {
  const exists = queryOne('SELECT id FROM kb_links WHERE entryId = ? AND nodeId = ?', [entryId, nodeId])
  if (exists) return true
  db.run('INSERT INTO kb_links (entryId, nodeId, flowId, createdAt) VALUES (?, ?, ?, ?)', [
    entryId,
    nodeId,
    flowId,
    now()
  ])
  scheduleFlush()
  return true
}

function kbUnlinkEntry(entryId, nodeId) {
  db.run('DELETE FROM kb_links WHERE entryId = ? AND nodeId = ?', [entryId, nodeId])
  scheduleFlush()
  return true
}

function kbLinkDoc(docId, nodeId, flowId = null) {
  const exists = queryOne('SELECT id FROM doc_links WHERE docId = ? AND nodeId = ?', [docId, nodeId])
  if (exists) return true
  db.run('INSERT INTO doc_links (docId, nodeId, flowId, createdAt) VALUES (?, ?, ?, ?)', [
    docId,
    nodeId,
    flowId,
    now()
  ])
  scheduleFlush()
  return true
}

function kbUnlinkDoc(docId, nodeId) {
  db.run('DELETE FROM doc_links WHERE docId = ? AND nodeId = ?', [docId, nodeId])
  scheduleFlush()
  return true
}

/* ------------------------------------------------------------------ */
/* 文档                                                                 */
/* ------------------------------------------------------------------ */

/** 列表不带 content（大文本不进列表通道；内容走 kbGetDoc） */
function kbListDocs() {
  return queryAll(
    'SELECT id, title, format, createdAt, updatedAt FROM documents ORDER BY updatedAt DESC'
  ).map(rowToDoc)
}

function kbGetDoc(id) {
  const row = queryOne('SELECT * FROM documents WHERE id = ?', [id])
  return row ? rowToDoc(row) : null
}

function kbCreateDoc(input) {
  const id = newId('d')
  const ts = now()
  db.run('INSERT INTO documents (id, title, format, content, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)', [
    id,
    input.title,
    input.format,
    input.content ?? '',
    ts,
    ts
  ])
  scheduleFlush()
  return kbGetDoc(id)
}

function kbUpdateDoc(id, patch) {
  const prev = kbGetDoc(id)
  if (!prev) return null
  const next = {
    title: patch.title ?? prev.title,
    content: patch.content ?? prev.content
  }
  db.run('UPDATE documents SET title = ?, content = ?, updatedAt = ? WHERE id = ?', [
    next.title,
    next.content,
    now(),
    id
  ])
  scheduleFlush()
  return kbGetDoc(id)
}

function kbRemoveDoc(id) {
  // 删文档是结构变更：立即 flush；锚点与节点关联一并清掉
  db.run('DELETE FROM doc_anchors WHERE docId = ?', [id])
  db.run('DELETE FROM doc_links WHERE docId = ?', [id])
  db.run('DELETE FROM documents WHERE id = ?', [id])
  flushNow()
  return true
}

/* ------------------------------------------------------------------ */
/* 文档锚点                                                             */
/* ------------------------------------------------------------------ */

function kbListAnchorsByDoc(docId) {
  return queryAll('SELECT * FROM doc_anchors WHERE docId = ? ORDER BY startOffset ASC', [docId]).map(
    rowToAnchor
  )
}

function kbListAnchorsByNode(nodeId) {
  return queryAll('SELECT * FROM doc_anchors WHERE nodeId = ? ORDER BY createdAt DESC', [nodeId]).map(
    rowToAnchor
  )
}

function kbCreateAnchor(input) {
  const id = newId('a')
  db.run(
    `INSERT INTO doc_anchors (id, docId, nodeId, quote, startOffset, endOffset, note, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.docId,
      input.nodeId ?? null,
      input.quote,
      input.startOffset,
      input.endOffset,
      input.note ?? '',
      now()
    ]
  )
  scheduleFlush()
  const row = queryOne('SELECT * FROM doc_anchors WHERE id = ?', [id])
  return rowToAnchor(row)
}

function kbUpdateAnchor(id, patch) {
  const prev = queryOne('SELECT * FROM doc_anchors WHERE id = ?', [id])
  if (!prev) return null
  const next = {
    nodeId: 'nodeId' in patch ? patch.nodeId : prev.nodeId,
    quote: patch.quote ?? prev.quote,
    startOffset: patch.startOffset ?? prev.startOffset,
    endOffset: patch.endOffset ?? prev.endOffset,
    note: patch.note ?? prev.note
  }
  db.run('UPDATE doc_anchors SET nodeId = ?, quote = ?, startOffset = ?, endOffset = ?, note = ? WHERE id = ?', [
    next.nodeId ?? null,
    next.quote,
    next.startOffset,
    next.endOffset,
    next.note,
    id
  ])
  scheduleFlush()
  const row = queryOne('SELECT * FROM doc_anchors WHERE id = ?', [id])
  return rowToAnchor(row)
}

function kbRemoveAnchor(id) {
  db.run('DELETE FROM doc_anchors WHERE id = ?', [id])
  scheduleFlush()
  return true
}

/* ------------------------------------------------------------------ */
/* 作者记忆                                                             */
/* ------------------------------------------------------------------ */

function kbListMemories() {
  return queryAll('SELECT * FROM memories ORDER BY pinned DESC, updatedAt DESC').map(rowToMemory)
}

function kbCreateMemory(input) {
  const id = newId('m')
  const ts = now()
  db.run(
    `INSERT INTO memories (id, type, content, source, pinned, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.type, input.content, input.source ?? 'manual', input.pinned ? 1 : 0, ts, ts]
  )
  scheduleFlush()
  const row = queryOne('SELECT * FROM memories WHERE id = ?', [id])
  return rowToMemory(row)
}

function kbUpdateMemory(id, patch) {
  const prev = queryOne('SELECT * FROM memories WHERE id = ?', [id])
  if (!prev) return null
  const next = {
    type: patch.type ?? prev.type,
    content: patch.content ?? prev.content,
    pinned: 'pinned' in patch ? patch.pinned : prev.pinned === 1
  }
  db.run('UPDATE memories SET type = ?, content = ?, pinned = ?, updatedAt = ? WHERE id = ?', [
    next.type,
    next.content,
    next.pinned ? 1 : 0,
    now(),
    id
  ])
  scheduleFlush()
  const row = queryOne('SELECT * FROM memories WHERE id = ?', [id])
  return rowToMemory(row)
}

function kbRemoveMemory(id) {
  db.run('DELETE FROM memories WHERE id = ?', [id])
  scheduleFlush()
  return true
}

/** 重置 = 全删（作者可随时清空；隐私优先，不做软删） */
function kbResetMemories() {
  db.run('DELETE FROM memories')
  flushNow()
  return true
}

/* ------------------------------------------------------------------ */
/* 偏好                                                                 */
/* ------------------------------------------------------------------ */

function kbGetPreferences() {
  const out = {}
  for (const row of queryAll('SELECT key, value FROM preferences')) out[row.key] = row.value
  return out
}

function kbSetPreference(key, value) {
  db.run(
    `INSERT INTO preferences (key, value, updatedAt) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
    [key, String(value), now()]
  )
  scheduleFlush()
  return true
}

/* ------------------------------------------------------------------ */
/* 工作过程事件（kb_events）                                             */
/* ------------------------------------------------------------------ */

/**
 * 记一条工作过程日志。同 kind + refId 在 60s 内合并为一条（摘要尾部计数
 * 「（×N）」），不新增行 —— 拖拽 / 连点不该把表刷爆。
 * 只存一行人类可读摘要，documents 大文本绝不进 event。
 */
function kbLogEvent(kind, refId, summary) {
  const ts = now()
  const last = queryOne(
    'SELECT id, summary, createdAt FROM kb_events WHERE kind = ? AND refId IS ? ORDER BY id DESC LIMIT 1',
    [kind, refId ?? null]
  )
  if (last && ts - last.createdAt <= EVENT_MERGE_WINDOW_MS) {
    const match = /（×(\d+)）$/.exec(last.summary ?? '')
    const count = match ? Number(match[1]) + 1 : 2
    const base = match ? last.summary.replace(/（×\d+）$/, '') : last.summary ?? summary
    db.run('UPDATE kb_events SET summary = ?, createdAt = ? WHERE id = ?', [
      `${base}（×${count}）`,
      ts,
      last.id
    ])
    scheduleFlush()
    return
  }
  db.run('INSERT INTO kb_events (kind, refId, summary, createdAt) VALUES (?, ?, ?, ?)', [
    kind,
    refId ?? null,
    summary,
    ts
  ])
  insertSinceTrim += 1
  if (insertSinceTrim >= EVENT_TRIM_EVERY) {
    trimEvents()
    insertSinceTrim = 0
  }
  scheduleFlush()
}

/** 表超上限删旧（每 EVENT_TRIM_EVERY 次插入跑一次，不每次 INSERT 都删） */
function trimEvents() {
  db.run('DELETE FROM kb_events WHERE id NOT IN (SELECT id FROM kb_events ORDER BY id DESC LIMIT ?)', [
    EVENT_KEEP_LIMIT
  ])
}

function kbListEvents(limit = 100) {
  const capped = Math.min(Math.max(1, Math.trunc(Number(limit) || 100), 1), EVENT_KEEP_LIMIT)
  return queryAll('SELECT * FROM kb_events ORDER BY id DESC LIMIT ?', [capped]).map(rowToEvent)
}

/**
 * 一键整理（kb:curate）：合并完全重复的作者记忆（同 type 同正文，保留最早
 * 一条、删除其后重复），返回整理报告。实现按 updatedAt ASC 取首条为基准，
 * 后续重复落入 dropIds 删除。UI 明说「启动时防抖整理 + 手动一键整理」——
 * 没有虚构的定时任务，启动那次由渲染层 useKbStore 防抖触发。
 */
function kbCurateEvents() {
  const before = queryOne('SELECT COUNT(*) AS n FROM memories')?.n ?? 0
  const rows = queryAll('SELECT id, type, content, updatedAt FROM memories ORDER BY updatedAt ASC')
  const seen = new Map()
  const dropIds = []
  for (const row of rows) {
    const key = `${row.type}\u0000${String(row.content ?? '').trim()}`
    if (seen.has(key)) dropIds.push(row.id)
    else seen.set(key, row.id)
  }
  for (const id of dropIds) db.run('DELETE FROM memories WHERE id = ?', [id])
  const after = queryOne('SELECT COUNT(*) AS n FROM memories')?.n ?? 0
  const byType = {}
  for (const row of queryAll('SELECT type, COUNT(*) AS n FROM memories GROUP BY type')) {
    byType[row.type] = row.n
  }
  if (dropIds.length) {
    kbLogEvent('kb_curate', null, `整理记忆：合并 ${dropIds.length} 条重复，剩余 ${after} 条`)
    // 有实际合并才落盘（启动时防抖整理不该无事写全库）
    flushNow()
  }
  return { merged: dropIds.length, before, after, byType }
}

/* ------------------------------------------------------------------ */
/* 全量导出 / 导入（JSON 备份）                                          */
/* ------------------------------------------------------------------ */

const EXPORT_KIND = 'novelflow.kb.all'
const EXPORT_VERSION = 1

function kbExportAll() {
  const payload = {
    kind: EXPORT_KIND,
    version: EXPORT_VERSION,
    exportedAt: now(),
    entries: kbListEntries(),
    links: queryAll('SELECT entryId, nodeId, flowId, createdAt FROM kb_links ORDER BY id ASC'),
    documents: queryAll('SELECT * FROM documents ORDER BY createdAt ASC').map(rowToDoc),
    docLinks: queryAll('SELECT docId, nodeId, flowId, createdAt FROM doc_links ORDER BY id ASC'),
    docAnchors: queryAll('SELECT * FROM doc_anchors ORDER BY createdAt ASC').map(rowToAnchor),
    memories: kbListMemories(),
    preferences: kbGetPreferences()
  }
  return JSON.stringify(payload, null, 2)
}

function kbImportAll(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('导入内容不是合法的 JSON 对象')
  }
  const entries = Array.isArray(data.entries) ? data.entries : []
  const links = Array.isArray(data.links) ? data.links : []
  const documents = Array.isArray(data.documents) ? data.documents : []
  const docLinks = Array.isArray(data.docLinks) ? data.docLinks : []
  const docAnchors = Array.isArray(data.docAnchors) ? data.docAnchors : []
  const memories = Array.isArray(data.memories) ? data.memories : []
  const preferences =
    data.preferences && typeof data.preferences === 'object' && !Array.isArray(data.preferences)
      ? data.preferences
      : {}

  // 事务包裹：导入一半失败就整体回滚，绝不留下「导了一半」的库
  db.run('BEGIN')
  try {
    db.run('DELETE FROM kb_links')
    db.run('DELETE FROM doc_links')
    db.run('DELETE FROM doc_anchors')
    db.run('DELETE FROM kb_entries')
    db.run('DELETE FROM documents')
    db.run('DELETE FROM memories')
    db.run('DELETE FROM preferences')

    const ts = now()
    for (const raw of entries) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) continue
      db.run(
        `INSERT INTO kb_entries (id, title, type, content, tags, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          raw.id,
          String(raw.title ?? '未命名条目'),
          ENTRY_TYPES.includes(raw.type) ? raw.type : 'note',
          String(raw.content ?? ''),
          JSON.stringify(Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string') : []),
          Number.isFinite(raw.createdAt) ? raw.createdAt : ts,
          Number.isFinite(raw.updatedAt) ? raw.updatedAt : ts
        ]
      )
    }
    for (const raw of links) {
      if (!raw || typeof raw !== 'object') continue
      if (typeof raw.entryId !== 'string' || typeof raw.nodeId !== 'string') continue
      db.run('INSERT INTO kb_links (entryId, nodeId, flowId, createdAt) VALUES (?, ?, ?, ?)', [
        raw.entryId,
        raw.nodeId,
        typeof raw.flowId === 'string' ? raw.flowId : null,
        Number.isFinite(raw.createdAt) ? raw.createdAt : ts
      ])
    }
    for (const raw of documents) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) continue
      db.run('INSERT INTO documents (id, title, format, content, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)', [
        raw.id,
        String(raw.title ?? '未命名文档'),
        DOC_FORMATS.includes(raw.format) ? raw.format : 'md',
        String(raw.content ?? ''),
        Number.isFinite(raw.createdAt) ? raw.createdAt : ts,
        Number.isFinite(raw.updatedAt) ? raw.updatedAt : ts
      ])
    }
    for (const raw of docLinks) {
      if (!raw || typeof raw !== 'object') continue
      if (typeof raw.docId !== 'string' || typeof raw.nodeId !== 'string') continue
      db.run('INSERT INTO doc_links (docId, nodeId, flowId, createdAt) VALUES (?, ?, ?, ?)', [
        raw.docId,
        raw.nodeId,
        typeof raw.flowId === 'string' ? raw.flowId : null,
        Number.isFinite(raw.createdAt) ? raw.createdAt : ts
      ])
    }
    for (const raw of docAnchors) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) continue
      if (typeof raw.docId !== 'string' || typeof raw.quote !== 'string') continue
      db.run(
        `INSERT INTO doc_anchors (id, docId, nodeId, quote, startOffset, endOffset, note, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          raw.id,
          raw.docId,
          typeof raw.nodeId === 'string' ? raw.nodeId : null,
          raw.quote,
          Number.isFinite(raw.startOffset) ? raw.startOffset : 0,
          Number.isFinite(raw.endOffset) ? raw.endOffset : 0,
          String(raw.note ?? ''),
          Number.isFinite(raw.createdAt) ? raw.createdAt : ts
        ]
      )
    }
    for (const raw of memories) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) continue
      if (typeof raw.content !== 'string' || !raw.content) continue
      db.run(
        `INSERT INTO memories (id, type, content, source, pinned, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          raw.id,
          MEMORY_TYPES.includes(raw.type) ? raw.type : 'fact',
          raw.content,
          MEMORY_SOURCES.includes(raw.source) ? raw.source : 'manual',
          raw.pinned === true || raw.pinned === 1 ? 1 : 0,
          Number.isFinite(raw.createdAt) ? raw.createdAt : ts,
          Number.isFinite(raw.updatedAt) ? raw.updatedAt : ts
        ]
      )
    }
    for (const [key, value] of Object.entries(preferences)) {
      if (typeof key !== 'string' || !key) continue
      db.run('INSERT INTO preferences (key, value, updatedAt) VALUES (?, ?, ?)', [
        key,
        String(value ?? ''),
        ts
      ])
    }
    db.run('COMMIT')
  } catch (err) {
    try {
      db.run('ROLLBACK')
    } catch {
      /* 回滚失败也要把异常抛出去，让 IPC 层给中文提示 */
    }
    throw err
  }
  // 全量导入是结构变更：立即 flush
  flushNow()
  return {
    entries: entries.length,
    documents: documents.length,
    memories: memories.length
  }
}

module.exports = {
  ENTRY_TYPES,
  MEMORY_TYPES,
  MEMORY_SOURCES,
  DOC_FORMATS,
  DDL,
  initKbStore,
  isKbReady,
  flushNow,
  scheduleFlush,
  /* 知识条目 */
  kbListEntries,
  kbGetEntry,
  kbCreateEntry,
  kbUpdateEntry,
  kbRemoveEntry,
  kbSearchEntries,
  /* 节点关联 */
  kbListNodeLinks,
  kbLinkEntry,
  kbUnlinkEntry,
  kbLinkDoc,
  kbUnlinkDoc,
  /* 文档 */
  kbListDocs,
  kbGetDoc,
  kbCreateDoc,
  kbUpdateDoc,
  kbRemoveDoc,
  /* 锚点 */
  kbListAnchorsByDoc,
  kbListAnchorsByNode,
  kbCreateAnchor,
  kbUpdateAnchor,
  kbRemoveAnchor,
  /* 记忆 */
  kbListMemories,
  kbCreateMemory,
  kbUpdateMemory,
  kbRemoveMemory,
  kbResetMemories,
  /* 偏好 */
  kbGetPreferences,
  kbSetPreference,
  /* 事件 */
  kbListEvents,
  kbLogEvent,
  kbCurateEvents,
  /* 全量 */
  kbExportAll,
  kbImportAll
}
