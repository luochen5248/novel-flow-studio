/**
 * ⚠️ 双写红线：本文件的纯函数（chunkText / contentHash / cosine / topKByCosine）
 * 与 `src/core/kb/vec.ts` **同构双写**（主进程是 CommonJS，require 不到 TS），
 * 任一侧改动必须同步另一侧 —— Tess 有等价性用例锁住漂移。
 *
 * NovelFlow Studio · 语义索引向量库（sql.js，独立 db 文件）
 *
 * 职责：把知识条目 / 文档的**语义块向量**存进 `userData/novelflow-vectors.db`，
 * 并在主进程内存里缓存已解码的 Float32Array 供纯 JS 余弦检索。
 *
 * ---------------------------------------------------------------------------
 * 为什么必须是一个**独立库文件**（不是加一张表进 novelflow.db）：
 *   sql.js 没有增量写，`store.cjs` 的 flushNow() 是「整库 db.export() +
 *   整文件重写」，内容变更走 2s 防抖。向量天然是几十 MB 级（1 万条 768 维
 *   ≈ 39MB db），一旦混进主库，作者每敲几秒字就要重写一遍几十 MB 文件。
 *   独立库只在「建完索引」时落盘一次，主库照旧轻量。
 * ---------------------------------------------------------------------------
 * 为什么是 BLOB + 纯 JS 余弦（不是 sqlite-vec / hnswlib）：
 *   实测 `pragma compile_options` 里有 `OMIT_LOAD_EXTENSION`，
 *   `load_extension()` 函数根本不存在 —— sql.js 是纯 WASM 静态编译，
 *   任何 SQLite 扩展都装不上。而实测纯 JS 全量余弦：1 万条×768 维 6.9ms、
 *   5 万条 37.8ms，瓶颈全在 `SELECT` 全量取出（53/269ms）而不在 CPU，
 *   所以架构定为「SELECT 全量一次 → 内存缓存 → 之后纯内存比对」。
 * ---------------------------------------------------------------------------
 * 为什么可以长期持有 Float32Array 引用：
 *   实测 sql.js 返回的每个 blob 都是一个**独立分配的 ArrayBuffer 副本**
 *   （byteOffset 恒为 0），后续再跑 200 次查询也不会改写已取出的数组。
 *   这是缓存方案成立的前提；下面 decodeVec 仍保留对齐兜底，防换版本翻车。
 *
 * ⚠️ 双写约定：本文件里的 chunkText / contentHash / cosine / topKByCosine
 * 是 `src/core/kb/vec.ts` 的 CJS 同构实现（主进程是 CommonJS，require 不到
 * TS）。改一边必须同步另一边，并在两边注释里互指。
 */
'use strict'

const path = require('node:path')
const fs = require('node:fs')
// app 只在 initVecStore 的 GUI 分支里真正用到（MCP_MODE 早退），顶层 require 安全
const { app } = require('electron')

/** 与 main.cjs:45 / store.cjs:35 同源的 MCP_MODE 判定（桥接实例不碰业务数据） */
const MCP_MODE = process.argv.includes('--mcp') || process.env.NOVELFLOW_MCP === '1'

/** 落盘文件名：与主库 novelflow.db 并列在 userData（都在 asar 之外，零打包风险） */
const DB_FILE_NAME = 'novelflow-vectors.db'
/** 内容变更的落盘防抖窗口（与 store.cjs 同口径；向量写入主要靠重建末尾的 flushNow） */
const FLUSH_DEBOUNCE_MS = 2000

/* ---- 切分常量：与 src/core/kb/vec.ts 的同名常量逐项相等（双写纪律） ---- */
const CHUNK_TARGET_CHARS = 400
const CHUNK_MAX_CHARS = 800
const CHUNK_OVERLAP_CHARS = 80
const CHUNK_MIN_MERGE_CHARS = 60

/* ------------------------------------------------------------------ */
/* 纯函数（vec.ts 的 CJS 同构实现，逐行对应）                            */
/* ------------------------------------------------------------------ */

function fnv1a(text, seed) {
  let hash = seed >>> 0
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function contentHash(text) {
  const input = String(text ?? '')
  const low = fnv1a(input, 0x811c9dc5)
  const high = fnv1a(input, 0x9e3779b9)
  return low.toString(16).padStart(8, '0') + high.toString(16).padStart(8, '0')
}

const SENTENCE_BREAKS = ['。', '！', '？', '；', '\n', '，', '、']

function hardSplit(text, max) {
  const out = []
  let rest = text
  while (rest.length > max) {
    let cut = -1
    const window = rest.slice(0, max)
    for (const mark of SENTENCE_BREAKS) {
      const index = window.lastIndexOf(mark)
      if (index > max * 0.5) {
        cut = index + mark.length
        break
      }
    }
    if (cut <= 0) cut = max
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) out.push(rest)
  return out
}

function chunkText(text, options = {}) {
  const target = Math.max(1, Math.trunc(options.target ?? CHUNK_TARGET_CHARS))
  const max = Math.max(target, Math.trunc(options.max ?? CHUNK_MAX_CHARS))
  const overlap = Math.max(0, Math.trunc(options.overlap ?? CHUNK_OVERLAP_CHARS))

  const source = String(text ?? '').replace(/\r\n?/g, '\n')
  if (!source.trim()) return []

  let paragraphs = source
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (!paragraphs.length) return []

  const merged = []
  let buffer = ''
  for (const paragraph of paragraphs) {
    if (buffer.length < CHUNK_MIN_MERGE_CHARS) {
      buffer = buffer ? `${buffer}\n${paragraph}` : paragraph
      continue
    }
    merged.push(buffer)
    buffer = paragraph
  }
  if (buffer) {
    // 尾巴上的短段并入上一段（与 vec.ts 同构）
    if (merged.length && buffer.length < CHUNK_MIN_MERGE_CHARS) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}\n${buffer}`
    } else {
      merged.push(buffer)
    }
  }
  paragraphs = merged

  const units = []
  for (const paragraph of paragraphs) {
    if (paragraph.length > max) units.push(...hardSplit(paragraph, max))
    else units.push(paragraph)
  }

  const packed = []
  let current = ''
  for (const unit of units) {
    if (!current) {
      current = unit
      continue
    }
    if (current.length + unit.length + 1 > target) {
      packed.push(current)
      current = unit
    } else {
      current = `${current}\n${unit}`
    }
  }
  if (current) packed.push(current)

  if (overlap === 0 || packed.length < 2) return packed
  return packed.map((chunk, index) => {
    if (index === 0) return chunk
    const prev = packed[index - 1]
    const head = prev.length > overlap ? prev.slice(prev.length - overlap) : prev
    return `${head}\n${chunk}`
  })
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

function topKByCosine(queryVec, candidates, k, minScore = 0) {
  const cap = Math.max(0, Math.trunc(k))
  if (!queryVec || !queryVec.length || !Array.isArray(candidates) || cap === 0) return []
  const scored = []
  for (let i = 0; i < candidates.length; i += 1) {
    const score = cosine(queryVec, candidates[i])
    if (score < minScore) continue
    scored.push({ index: i, score })
  }
  scored.sort((x, y) => y.score - x.score || x.index - y.index)
  return scored.slice(0, cap)
}

/* ------------------------------------------------------------------ */
/* DDL                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 表结构。
 *
 * `model` 与 `dim` 逐行冗余（而不是只存一份全局 meta）：换 embedding 模型
 * 后新旧向量**不在同一空间**，逐行记录才能让检索时按 dim 过滤、按 model
 * 判定「这块要不要重算」。
 */
const DDL = [
  `CREATE TABLE IF NOT EXISTS vec_chunks (
     id          TEXT PRIMARY KEY,
     refType     TEXT NOT NULL,
     refId       TEXT NOT NULL,
     chunkIndex  INTEGER NOT NULL,
     contentHash TEXT NOT NULL,
     model       TEXT NOT NULL,
     dim         INTEGER NOT NULL,
     vec         BLOB NOT NULL,
     updatedAt   INTEGER NOT NULL
   );`,
  // 按 (refType, refId) 前缀收窄：clearForRef / 按来源统计都走它
  `CREATE INDEX IF NOT EXISTS idx_vec_chunks_ref ON vec_chunks(refType, refId);`,
  // 唯一键：同来源同序号只允许一行，upsert 才有幂等性
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_vec_chunks_ref_chunk ON vec_chunks(refType, refId, chunkIndex);`,
  // 内容指纹：增量判定「这块内容是否已在库里」
  `CREATE INDEX IF NOT EXISTS idx_vec_chunks_hash ON vec_chunks(contentHash);`
]

/** 允许的来源类型（与重建索引时喂进来的 refType 一一对应） */
const REF_TYPES = ['entry', 'doc', 'memory']

/* ------------------------------------------------------------------ */
/* 内部状态                                                             */
/* ------------------------------------------------------------------ */

let db = null
let dbPath = ''
let flushTimer = null
let initPromise = null
/** 全量解码后的向量缓存（loadAll 的惰性产物；任何写操作都会置 null 失效） */
let cache = null

/* ------------------------------------------------------------------ */
/* 编码 / 解码                                                          */
/* ------------------------------------------------------------------ */

/** Float32Array | number[] → 可直接绑定为 BLOB 的 Uint8Array */
function encodeVec(vec) {
  const f = vec instanceof Float32Array ? vec : new Float32Array(vec)
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength)
}

/**
 * BLOB → Float32Array。
 *
 * 正常路径是零拷贝 view：sql.js 返回的 blob 是独立 ArrayBuffer 且 byteOffset
 * 恒为 0，长期持有引用安全（见文件头实测结论）。偏移量不是 4 的倍数时（换
 * sql.js 版本可能出现）退到「拷一份对齐的」，宁可多一次拷贝也不读错数据。
 */
function decodeVec(blob) {
  if (!blob) return null
  const u = blob instanceof Uint8Array ? blob : new Uint8Array(blob)
  if (!u.byteLength || u.byteLength % 4 !== 0) return null
  if (u.byteOffset % 4 === 0 && u.buffer.byteLength >= u.byteOffset + u.byteLength) {
    return new Float32Array(u.buffer, u.byteOffset, u.byteLength / 4)
  }
  return new Float32Array(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength))
}

/* ------------------------------------------------------------------ */
/* 基础查询                                                             */
/* ------------------------------------------------------------------ */

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

function now() {
  return Date.now()
}

/* ------------------------------------------------------------------ */
/* 初始化与落盘                                                         */
/* ------------------------------------------------------------------ */

/**
 * 初始化（幂等；并发调用共享同一个 Promise）。
 *
 * wasm 必须显式读 Buffer 喂 `initSqlJs({ wasmBinary })`：项目路径含中文
 * （D:\小说\…），emscripten 默认按 __dirname 定位 wasm 在中文路径下会失败
 * 或挂起 —— 与 store.cjs:191-201 同一条教训。
 */
async function initVecStore() {
  if (initPromise) return initPromise
  initPromise = (async () => {
    // 注释性守卫：MCP 桥接实例（无窗口 stdio 进程）绝不初始化向量库
    if (MCP_MODE) return
    if (db) return

    const initSqlJs = require('sql.js')
    const wasmPath = path.join(app.getAppPath(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
    const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) })

    dbPath = path.join(app.getPath('userData'), DB_FILE_NAME)
    let opened = null
    if (fs.existsSync(dbPath)) {
      try {
        opened = new SQL.Database(fs.readFileSync(dbPath))
      } catch (err) {
        // 损坏降级（照 store.cjs 的哲学）：向量是**可由内容重算**的派生数据，
        // 坏了就备份 + 重建空库，绝不让主程序起不来
        try {
          fs.renameSync(dbPath, `${dbPath}.bak`)
        } catch {
          /* 备份失败也要继续：下面重建空库 */
        }
        console.error('[vec] 向量库损坏，已备份为 .bak 并重建空库：', err?.message ?? String(err))
      }
    }
    db = opened ?? new SQL.Database()

    for (const ddl of DDL) db.run(ddl)
    // 建表属于结构变更：立即落盘，保证首次启动也有库文件
    flushNow()
  })()
  return initPromise
}

function isVecReady() {
  return !!db
}

/** 原子落盘：先写 .tmp 再 renameSync —— 半截库比坏 JSON 致命 */
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

/** 内容变更：2s 防抖（批量写入时合并成一次整库重写） */
function scheduleFlush() {
  if (!db) return
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    try {
      flushNow()
    } catch (err) {
      console.error('[vec] 防抖落盘失败：', err?.message ?? String(err))
    }
  }, FLUSH_DEBOUNCE_MS)
}

/* ------------------------------------------------------------------ */
/* 写入                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 批量写入 / 更新 chunk（事务包裹，prepare 复用）。
 *
 * chunk 形状：`{ refType, refId, chunkIndex, contentHash, model, dim, vec }`。
 * 用 `INSERT ... ON CONFLICT(id) DO UPDATE`：同一块重新 embedding 后要覆盖
 * 旧向量，而不是留两条。
 *
 * @returns {{ inserted: number }}  实际写入 / 更新的行数
 */
function upsertChunks(chunks) {
  if (!db || !Array.isArray(chunks) || !chunks.length) return { inserted: 0 }
  const ts = now()
  const stmt = db.prepare(
    `INSERT INTO vec_chunks (id, refType, refId, chunkIndex, contentHash, model, dim, vec, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       contentHash = excluded.contentHash,
       model       = excluded.model,
       dim         = excluded.dim,
       vec         = excluded.vec,
       updatedAt   = excluded.updatedAt`
  )
  db.run('BEGIN')
  try {
    for (const chunk of chunks) {
      const vec = encodeVec(chunk.vec)
      stmt.run([
        chunkId(chunk.refType, chunk.refId, chunk.chunkIndex),
        chunk.refType,
        chunk.refId,
        Math.trunc(chunk.chunkIndex),
        String(chunk.contentHash ?? ''),
        String(chunk.model ?? ''),
        Math.trunc(chunk.dim ?? vec.length / 4),
        vec,
        ts
      ])
    }
    db.run('COMMIT')
  } catch (err) {
    try {
      db.run('ROLLBACK')
    } catch {
      /* 回滚失败也要把异常抛出去，让调用方给中文提示 */
    }
    throw err
  } finally {
    stmt.free()
  }
  // 缓存失效：库内容变了，内存里的 Float32Array 列表必须重取
  cache = null
  scheduleFlush()
  return { inserted: chunks.length }
}

/** chunk 主键：来源 + 来源 id + 块序号（与唯一索引同序） */
function chunkId(refType, refId, chunkIndex) {
  return `v_${refType}_${refId}_${chunkIndex}`
}

/** 删掉某个来源的全部 chunk（条目 / 文档被删除时级联清理） */
function clearForRef(refType, refId) {
  if (!db) return 0
  db.run('DELETE FROM vec_chunks WHERE refType = ? AND refId = ?', [refType, refId])
  cache = null
  scheduleFlush()
  return db.getRowsModified ? db.getRowsModified() : 0
}

/** 删掉某个来源序号 >= fromIndex 的尾巴（重建后块数变少时用） */
function trimRefFrom(refType, refId, fromIndex) {
  if (!db) return
  db.run('DELETE FROM vec_chunks WHERE refType = ? AND refId = ? AND chunkIndex >= ?', [
    refType,
    refId,
    Math.trunc(fromIndex)
  ])
  cache = null
  scheduleFlush()
}

/**
 * 取某个来源已有的块指纹（增量重建的判重依据）。
 * @returns {Map<number, { contentHash: string, model: string }>} chunkIndex → 指纹
 */
function getRefIndex(refType, refId) {
  const map = new Map()
  if (!db) return map
  const rows = queryAll(
    'SELECT chunkIndex, contentHash, model FROM vec_chunks WHERE refType = ? AND refId = ?',
    [refType, refId]
  )
  for (const row of rows) map.set(Number(row.chunkIndex), { contentHash: row.contentHash, model: row.model })
  return map
}

/** 库里现存的全部来源（用于清理「主库已删除、向量库还在」的孤儿） */
function listRefs() {
  if (!db) return []
  return queryAll('SELECT DISTINCT refType, refId FROM vec_chunks').map((row) => ({
    refType: row.refType,
    refId: row.refId
  }))
}

/* ------------------------------------------------------------------ */
/* 读取与检索                                                            */
/* ------------------------------------------------------------------ */

/**
 * 全量取出并解码（带缓存）。
 *
 * 为什么缓存而不是每次 SELECT：实测 1 万条取出 53ms、5 万条 269ms，而纯 JS
 * 余弦只要 7/38ms —— 取出的开销比比对还大一个量级，必须只做一次。
 * 写操作会把 cache 置 null，下次调用重取（一致性优先于性能）。
 */
function loadAll() {
  if (!db) return []
  if (cache) return cache
  const rows = queryAll(
    'SELECT id, refType, refId, chunkIndex, contentHash, model, dim, vec FROM vec_chunks ORDER BY refType, refId, chunkIndex'
  )
  const out = []
  for (const row of rows) {
    const vec = decodeVec(row.vec)
    // 坏行（长度不是 4 的倍数 / 空 blob）直接跳过：一条脏数据不该让整个检索失败
    if (!vec) continue
    out.push({
      id: row.id,
      refType: row.refType,
      refId: row.refId,
      chunkIndex: Number(row.chunkIndex),
      contentHash: row.contentHash,
      model: row.model,
      dim: Number(row.dim),
      vec
    })
  }
  cache = out
  return cache
}

/** 总块数 */
function count() {
  if (!db) return 0
  return Number(queryOne('SELECT COUNT(*) AS n FROM vec_chunks')?.n ?? 0)
}

/** 按来源类型分组的块数（索引状态面板用） */
function countByRefType() {
  const out = {}
  if (!db) return out
  for (const row of queryAll('SELECT refType, COUNT(*) AS n FROM vec_chunks GROUP BY refType')) {
    out[row.refType] = Number(row.n)
  }
  return out
}

/** 库里主导的 model / dim（模型换了就必须整库重建，这里给状态面板显示） */
function describeModel() {
  if (!db) return { model: '', dim: 0 }
  const row = queryOne(
    `SELECT model, dim, COUNT(*) AS n FROM vec_chunks
     GROUP BY model, dim ORDER BY n DESC LIMIT 1`
  )
  return { model: row?.model ?? '', dim: Number(row?.dim ?? 0) }
}

/** 最近一次写入时间（重建时间显示用） */
function lastUpdatedAt() {
  if (!db) return null
  const row = queryOne('SELECT MAX(updatedAt) AS t FROM vec_chunks')
  return row?.t ?? null
}

/**
 * 余弦 Top-K 检索（纯内存，走缓存）。
 *
 * @param {Float32Array} queryVec 查询向量
 * @param {{ k?: number, minScore?: number, refTypes?: string[] }} options
 * @returns {Array<{ refType: string, refId: string, chunkIndex: number, score: number }>}
 */
function searchTopK(queryVec, options = {}) {
  const rows = loadAll()
  if (!rows.length) return []
  const k = Math.max(1, Math.trunc(options.k ?? 10))
  const minScore = typeof options.minScore === 'number' ? options.minScore : 0
  const refTypes = Array.isArray(options.refTypes) && options.refTypes.length
    ? new Set(options.refTypes)
    : null

  // 先在 SQL 之外按来源类型收窄（本产品主场景是「按条目 / 按文档」分别查），
  // 再只比对子集 —— 命中子集通常只有全量的 1/10
  const candidates = []
  const origin = []
  for (const row of rows) {
    if (refTypes && !refTypes.has(row.refType)) continue
    // 维度不一致 = 换过 embedding 模型，这块与新查询不在同一空间，必须排除
    if (row.vec.length !== queryVec.length) continue
    origin.push(row)
    candidates.push(row.vec)
  }
  if (!candidates.length) return []

  return topKByCosine(queryVec, candidates, k, minScore).map((hit) => ({
    refType: origin[hit.index].refType,
    refId: origin[hit.index].refId,
    chunkIndex: origin[hit.index].chunkIndex,
    score: hit.score
  }))
}

/** 清空整库（用户想彻底重来时用；正常重建走增量，不调这个） */
function clearAll() {
  if (!db) return
  db.run('DELETE FROM vec_chunks')
  cache = null
  flushNow()
}

module.exports = {
  REF_TYPES,
  DB_FILE_NAME,
  /* 纯函数（vec.ts 的 CJS 同构实现） */
  contentHash,
  chunkText,
  cosine,
  topKByCosine,
  /* 编码 / 解码（单测可直接断言往返） */
  encodeVec,
  decodeVec,
  /* 生命周期 */
  initVecStore,
  isVecReady,
  flushNow,
  scheduleFlush,
  /* 写入 */
  upsertChunks,
  chunkId,
  clearForRef,
  trimRefFrom,
  clearAll,
  /* 读取 */
  getRefIndex,
  listRefs,
  loadAll,
  count,
  countByRefType,
  describeModel,
  lastUpdatedAt,
  searchTopK
}
