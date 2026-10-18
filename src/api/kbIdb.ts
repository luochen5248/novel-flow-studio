/**
 * 浏览器态 IndexedDB 降层（手写原生封装，不引 dexie / fake-indexeddb）。
 *
 * 存在理由：AI / MCP 链路本就只在桌面态存在（useAiAssist 在 !available 时
 * 直接报错），浏览器开发态只需要知识库 / 文档 / 记忆面板的 CRUD 能跑。
 * 桌面态的事实源是 userData/novelflow.db（sql.js），这里是同签名的浏览器
 * 孪生实现 —— kbClient 按 hasKbBridge() 分流，两边接口逐对对齐。
 *
 * store 清单（任务书写 5 个，实际 6 个）：entries / links / documents /
 * doc_anchors / memories / preferences。preferences 单独拆出来的原因：
 * 它与 memories 的 keyPath 不同（key vs id），合成一个 store 就没法用
 * 主键直接读写了。links 用 kind 判别字段合并「条目关联 / 文档关联」。
 *
 * jsdom 不实现 IndexedDB（测试用手写内存 fake 断言接口形状，见 Q7），
 * 因此本模块顶层绝不触碰 indexedDB 全局 —— openDb 只在首次调用时执行。
 */
import { uid } from '@/core/id'
import { sanitizeAnchor, sanitizeDoc, sanitizeEntry, sanitizeMemory } from '@/core/kb/sanitize'
import { rankEntries } from '@/core/kb/search'
import type {
  CreateAnchorInput,
  CreateDocInput,
  CreateEntryInput,
  CreateMemoryInput,
  CurateReport,
  DocAnchor,
  KbDocument,
  KnowledgeEntry,
  MemoryEntry,
  PrefKey,
  UpdateAnchorInput,
  UpdateDocInput,
  UpdateEntryInput,
  UpdateMemoryInput
} from '@/core/kb/types'

const DB_NAME = 'novelflow-kb'
const DB_VERSION = 1

/** links store 的行：kind 判别「条目关联 / 文档关联」，nodeId 建索引供反查 */
interface LinkRow {
  id?: number
  kind: 'entry' | 'doc'
  refId: string
  nodeId: string
  flowId: string | null
  createdAt: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains('entries')) {
          db.createObjectStore('entries', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('links')) {
          const store = db.createObjectStore('links', { keyPath: 'id', autoIncrement: true })
          store.createIndex('nodeId', 'nodeId', { unique: false })
        }
        if (!db.objectStoreNames.contains('documents')) {
          db.createObjectStore('documents', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('doc_anchors')) {
          const store = db.createObjectStore('doc_anchors', { keyPath: 'id' })
          store.createIndex('docId', 'docId', { unique: false })
          store.createIndex('nodeId', 'nodeId', { unique: false })
        }
        if (!db.objectStoreNames.contains('memories')) {
          db.createObjectStore('memories', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('preferences')) {
          db.createObjectStore('preferences', { keyPath: 'key' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('本地存储打开失败'))
    })
  }
  return dbPromise
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('本地存储操作失败'))
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('本地存储事务失败'))
    tx.onabort = () => reject(tx.error ?? new Error('本地存储事务中断'))
  })
}

/** 事务包裹：fn 内的请求全部发完后再等事务提交（写操作的持久化保证） */
async function withStore<T>(
  name: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T
): Promise<T> {
  const db = await openDb()
  const tx = db.transaction(name, mode)
  const result = await fn(tx.objectStore(name))
  await txDone(tx)
  return result
}

function byUpdatedDesc(a: { updatedAt: number }, b: { updatedAt: number }): number {
  return b.updatedAt - a.updatedAt
}

function now(): number {
  return Date.now()
}

/* ---------------- 知识条目 ---------------- */

export async function idbListEntries(): Promise<KnowledgeEntry[]> {
  const rows = await withStore('entries', 'readonly', (s) => done(s.getAll()))
  return (rows.map(sanitizeEntry).filter((e): e is KnowledgeEntry => !!e)).sort(byUpdatedDesc)
}

export async function idbCreateEntry(input: CreateEntryInput): Promise<KnowledgeEntry> {
  const ts = now()
  const entry: KnowledgeEntry = {
    id: uid('e'),
    title: input.title.trim(),
    type: input.type ?? 'note',
    content: input.content ?? '',
    tags: [...new Set((input.tags ?? []).map((t) => t.trim()).filter(Boolean))],
    createdAt: ts,
    updatedAt: ts
  }
  await withStore('entries', 'readwrite', (s) => done(s.put(entry)))
  return entry
}

export async function idbUpdateEntry(id: string, patch: UpdateEntryInput): Promise<KnowledgeEntry | null> {
  const prev = await withStore('entries', 'readonly', (s) => done(s.get(id)))
  const current = sanitizeEntry(prev)
  if (!current) return null
  const next: KnowledgeEntry = {
    ...current,
    title: patch.title ?? current.title,
    type: patch.type ?? current.type,
    content: patch.content ?? current.content,
    tags: patch.tags ?? current.tags,
    updatedAt: now()
  }
  await withStore('entries', 'readwrite', (s) => done(s.put(next)))
  return next
}

export async function idbRemoveEntry(id: string): Promise<boolean> {
  await withStore('entries', 'readwrite', (s) => done(s.delete(id)))
  // 关联的 links 一并清掉（不留悬空链接；桌面态由主进程级联，这里对齐行为）
  const rows = await withStore('links', 'readonly', (s) => done(s.getAll()))
  for (const row of rows as LinkRow[]) {
    if (row.kind === 'entry' && row.refId === id) {
      await withStore('links', 'readwrite', (s) => done(s.delete(row.id as number)))
    }
  }
  return true
}

export async function idbSearchEntries(query: string): Promise<KnowledgeEntry[]> {
  const all = await idbListEntries()
  const q = query.trim().toLowerCase()
  if (!q) return all.slice(0, 50)
  // 与桌面态同口径：LIKE 粗筛（标题 / 标签 / 正文子串）+ 渲染层精排
  const hits = all.filter(
    (e) =>
      e.title.toLowerCase().includes(q) ||
      e.tags.some((t) => t.toLowerCase().includes(q)) ||
      e.content.toLowerCase().includes(q)
  )
  return rankEntries(hits, query).slice(0, 50)
}

/* ---------------- 节点关联 ---------------- */

export async function idbListLinksForNode(nodeId: string): Promise<{ entries: KnowledgeEntry[]; docs: KbDocument[] }> {
  const db = await openDb()
  const tx = db.transaction(['links', 'entries', 'documents'], 'readonly')
  // 反查必须先拿到 linkRows（依赖），但拿到后要在「同一激活窗口」内**同步**
  // 发起所有 entries/documents 读取并收集 promise，**不在发起下一个前 await** ——
  // 否则真机浏览器中事务因无 pending 请求自动提交，后续请求抛 TransactionInactiveError。
  const linkRows = (await done(tx.objectStore('links').index('nodeId').getAll(nodeId))) as LinkRow[]
  const entryPromises: Array<Promise<KnowledgeEntry | null>> = []
  const docPromises: Array<Promise<KbDocument | null>> = []
  for (const row of linkRows) {
    if (row.kind === 'entry') {
      entryPromises.push(done(tx.objectStore('entries').get(row.refId)).then(sanitizeEntry))
    } else {
      docPromises.push(done(tx.objectStore('documents').get(row.refId)).then(sanitizeDoc))
    }
  }
  const [entryRows, docRows] = await Promise.all([Promise.all(entryPromises), Promise.all(docPromises)])
  await txDone(tx)
  const entries: KnowledgeEntry[] = []
  const docs: KbDocument[] = []
  for (const entry of entryRows) {
    if (entry) entries.push(entry)
  }
  for (const doc of docRows) {
    if (doc) {
      // 列表通道不带 content（与桌面态一致）
      delete doc.content
      docs.push(doc)
    }
  }
  return { entries, docs }
}

async function putLink(row: Omit<LinkRow, 'id'>): Promise<void> {
  const rows = (await withStore('links', 'readonly', (s) => done(s.getAll()))) as LinkRow[]
  const dup = rows.some((r) => r.kind === row.kind && r.refId === row.refId && r.nodeId === row.nodeId)
  if (dup) return
  await withStore('links', 'readwrite', (s) => done(s.add(row)))
}

async function dropLink(kind: LinkRow['kind'], refId: string, nodeId: string): Promise<void> {
  const rows = (await withStore('links', 'readonly', (s) => done(s.getAll()))) as LinkRow[]
  for (const row of rows) {
    if (row.kind === kind && row.refId === refId && row.nodeId === nodeId) {
      await withStore('links', 'readwrite', (s) => done(s.delete(row.id as number)))
    }
  }
}

export async function idbLinkEntry(entryId: string, nodeId: string): Promise<boolean> {
  await putLink({ kind: 'entry', refId: entryId, nodeId, flowId: null, createdAt: now() })
  return true
}

export async function idbUnlinkEntry(entryId: string, nodeId: string): Promise<boolean> {
  await dropLink('entry', entryId, nodeId)
  return true
}

export async function idbLinkDoc(docId: string, nodeId: string): Promise<boolean> {
  await putLink({ kind: 'doc', refId: docId, nodeId, flowId: null, createdAt: now() })
  return true
}

export async function idbUnlinkDoc(docId: string, nodeId: string): Promise<boolean> {
  await dropLink('doc', docId, nodeId)
  return true
}

/* ---------------- 文档 ---------------- */

/** 列表不带 content（与桌面态 kb:list-docs 一致） */
export async function idbListDocs(): Promise<KbDocument[]> {
  const rows = await withStore('documents', 'readonly', (s) => done(s.getAll()))
  return rows
    .map(sanitizeDoc)
    .filter((d): d is KbDocument => !!d)
    .map((d) => {
      delete d.content
      return d
    })
    .sort(byUpdatedDesc)
}

export async function idbGetDoc(id: string): Promise<KbDocument | null> {
  const row = await withStore('documents', 'readonly', (s) => done(s.get(id)))
  return sanitizeDoc(row)
}

export async function idbCreateDoc(input: CreateDocInput): Promise<KbDocument> {
  const ts = now()
  const doc: KbDocument = {
    id: uid('d'),
    title: input.title.trim(),
    format: input.format,
    content: input.content,
    createdAt: ts,
    updatedAt: ts
  }
  await withStore('documents', 'readwrite', (s) => done(s.put(doc)))
  const { content: _content, ...rest } = doc
  return rest
}

export async function idbUpdateDoc(id: string, patch: UpdateDocInput): Promise<KbDocument | null> {
  const prev = await idbGetDoc(id)
  if (!prev) return null
  const next: KbDocument = {
    ...prev,
    title: patch.title ?? prev.title,
    content: patch.content ?? prev.content ?? '',
    updatedAt: now()
  }
  await withStore('documents', 'readwrite', (s) => done(s.put(next)))
  const { content: _content, ...rest } = next
  return rest
}

export async function idbRemoveDoc(id: string): Promise<boolean> {
  // 锚点与关联一并清掉（对齐桌面态级联删除）
  const db = await openDb()
  const tx = db.transaction(['documents', 'doc_anchors', 'links'], 'readwrite')
  tx.objectStore('documents').delete(id)
  // 同步发起两条读取，避免在事务内逐个 await 触发真机浏览器事务自动提交
  const anchorsReq = done(tx.objectStore('doc_anchors').getAll())
  const linksReq = done(tx.objectStore('links').getAll())
  const anchors = (await anchorsReq) as DocAnchor[]
  const links = (await linksReq) as LinkRow[]
  // 拿到结果后在同一个激活窗口内**同步**发起所有删除（不在发起下一个前 await）
  for (const anchor of anchors) {
    if (anchor.docId === id) tx.objectStore('doc_anchors').delete(anchor.id)
  }
  for (const link of links) {
    if (link.kind === 'doc' && link.refId === id) tx.objectStore('links').delete(link.id as number)
  }
  await txDone(tx)
  return true
}

/* ---------------- 锚点 ---------------- */

export async function idbListAnchors(filter: { docId?: string; nodeId?: string }): Promise<DocAnchor[]> {
  const db = await openDb()
  const tx = db.transaction('doc_anchors', 'readonly')
  const store = tx.objectStore('doc_anchors')
  const rows = filter.docId
    ? ((await done(store.index('docId').getAll(filter.docId))) as unknown[])
    : filter.nodeId
      ? ((await done(store.index('nodeId').getAll(filter.nodeId))) as unknown[])
      : ((await done(store.getAll())) as unknown[])
  await txDone(tx)
  return rows.map(sanitizeAnchor).filter((a): a is DocAnchor => !!a)
}

export async function idbCreateAnchor(input: CreateAnchorInput): Promise<DocAnchor> {
  const anchor: DocAnchor = {
    id: uid('a'),
    docId: input.docId,
    nodeId: input.nodeId ?? null,
    quote: input.quote,
    startOffset: input.startOffset,
    endOffset: input.endOffset,
    note: input.note ?? '',
    createdAt: now()
  }
  await withStore('doc_anchors', 'readwrite', (s) => done(s.put(anchor)))
  return anchor
}

export async function idbUpdateAnchor(id: string, patch: UpdateAnchorInput): Promise<DocAnchor | null> {
  const row = await withStore('doc_anchors', 'readonly', (s) => done(s.get(id)))
  const prev = sanitizeAnchor(row)
  if (!prev) return null
  const next: DocAnchor = {
    ...prev,
    nodeId: 'nodeId' in patch ? patch.nodeId ?? null : prev.nodeId,
    quote: patch.quote ?? prev.quote,
    startOffset: patch.startOffset ?? prev.startOffset,
    endOffset: patch.endOffset ?? prev.endOffset,
    note: patch.note ?? prev.note
  }
  await withStore('doc_anchors', 'readwrite', (s) => done(s.put(next)))
  return next
}

export async function idbRemoveAnchor(id: string): Promise<boolean> {
  await withStore('doc_anchors', 'readwrite', (s) => done(s.delete(id)))
  return true
}

/* ---------------- 作者记忆 ---------------- */

export async function idbListMemories(): Promise<MemoryEntry[]> {
  const rows = await withStore('memories', 'readonly', (s) => done(s.getAll()))
  return rows
    .map(sanitizeMemory)
    .filter((m): m is MemoryEntry => !!m)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
}

export async function idbCreateMemory(input: CreateMemoryInput): Promise<MemoryEntry> {
  const ts = now()
  const memory: MemoryEntry = {
    id: uid('m'),
    type: input.type,
    content: input.content.trim(),
    source: input.source ?? 'manual',
    pinned: input.pinned === true,
    createdAt: ts,
    updatedAt: ts
  }
  await withStore('memories', 'readwrite', (s) => done(s.put(memory)))
  return memory
}

export async function idbUpdateMemory(id: string, patch: UpdateMemoryInput): Promise<MemoryEntry | null> {
  const row = await withStore('memories', 'readonly', (s) => done(s.get(id)))
  const prev = sanitizeMemory(row)
  if (!prev) return null
  const next: MemoryEntry = {
    ...prev,
    type: patch.type ?? prev.type,
    content: patch.content ?? prev.content,
    pinned: 'pinned' in patch ? patch.pinned === true : prev.pinned,
    updatedAt: now()
  }
  await withStore('memories', 'readwrite', (s) => done(s.put(next)))
  return next
}

export async function idbRemoveMemory(id: string): Promise<boolean> {
  await withStore('memories', 'readwrite', (s) => done(s.delete(id)))
  return true
}

export async function idbResetMemories(): Promise<boolean> {
  await withStore('memories', 'readwrite', (s) => done(s.clear()))
  return true
}

export async function idbExportMemories(): Promise<string> {
  const memories = await idbListMemories()
  return JSON.stringify({ kind: 'novelflow.kb.memories', version: 1, memories }, null, 2)
}

export async function idbImportMemories(json: string): Promise<number> {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    throw new Error('导入内容不是合法 JSON')
  }
  const list = Array.isArray(data) ? data : (data as { memories?: unknown })?.memories
  if (!Array.isArray(list)) throw new Error('导入内容里找不到记忆数组')
  let imported = 0
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (typeof r.content !== 'string' || !r.content.trim()) continue
    await idbCreateMemory({
      type: r.type as MemoryEntry['type'],
      content: r.content,
      source: r.source as MemoryEntry['source'],
      pinned: r.pinned === true
    })
    imported += 1
  }
  return imported
}

/* ---------------- 偏好 ---------------- */

export async function idbGetPreferences(): Promise<Record<string, string>> {
  const rows = (await withStore('preferences', 'readonly', (s) => done(s.getAll()))) as Array<{
    key: string
    value: string
  }>
  const out: Record<string, string> = {}
  for (const row of rows) out[row.key] = row.value
  return out
}

export async function idbSetPreference(key: PrefKey, value: string): Promise<boolean> {
  await withStore('preferences', 'readwrite', (s) => done(s.put({ key, value, updatedAt: now() })))
  return true
}

/* ---------------- 工作过程事件 ---------------- */

/**
 * 浏览器态不落事件：IDB 没有事件 store（桌面态 kb_events 由主进程管），
 * 且浏览器态没有 AI / 结构性操作的统计诉求。保持接口签名对齐，
 * 调用方（useFlowStore / useAiAssist）无需分辨环境。
 */
export async function idbLogEvent(): Promise<boolean> {
  return true
}

export async function idbListEvents(): Promise<[]> {
  return []
}

export async function idbCurate(): Promise<CurateReport> {
  const memories = await idbListMemories()
  const seen = new Map<string, string>()
  const dropIds: string[] = []
  for (const m of [...memories].reverse()) {
    const key = `${m.type}\u0000${m.content.trim()}`
    if (seen.has(key)) dropIds.push(m.id)
    else seen.set(key, m.id)
  }
  for (const id of dropIds) await idbRemoveMemory(id)
  const after = await idbListMemories()
  const byType: Record<string, number> = {}
  for (const m of after) byType[m.type] = (byType[m.type] ?? 0) + 1
  return { merged: dropIds.length, before: memories.length, after: after.length, byType }
}

/* ---------------- 全量导入导出 ---------------- */

export async function idbExportAll(): Promise<string> {
  const [entries, docs, memories, preferences] = await Promise.all([
    idbListEntries(),
    withStore('documents', 'readonly', (s) => done(s.getAll())),
    idbListMemories(),
    idbGetPreferences()
  ])
  const db = await openDb()
  const tx = db.transaction(['links', 'doc_anchors'], 'readonly')
  // 同步发起 links / doc_anchors 两条读取，避免在事务内逐个 await 触发真机浏览器事务自动提交
  const linksReq = done(tx.objectStore('links').getAll())
  const anchorsReq = done(tx.objectStore('doc_anchors').getAll())
  const links = (await linksReq) as LinkRow[]
  const anchors = (await anchorsReq) as DocAnchor[]
  await txDone(tx)
  return JSON.stringify(
    {
      kind: 'novelflow.kb.all',
      version: 1,
      exportedAt: now(),
      entries,
      links: links.map(({ kind, refId, nodeId, flowId, createdAt }) => ({ kind, refId, nodeId, flowId, createdAt })),
      documents: docs.map(sanitizeDoc).filter((d): d is KbDocument => !!d),
      docLinks: links
        .filter((l) => l.kind === 'doc')
        .map(({ refId, nodeId, flowId, createdAt }) => ({ docId: refId, nodeId, flowId, createdAt })),
      docAnchors: anchors,
      memories,
      preferences
    },
    null,
    2
  )
}

export async function idbImportAll(json: string): Promise<{ entries: number; documents: number; memories: number }> {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(json) as Record<string, unknown>
  } catch {
    throw new Error('导入内容不是合法 JSON')
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('导入内容不是合法的 JSON 对象')
  }
  const entries = (Array.isArray(data.entries) ? data.entries : []).map(sanitizeEntry).filter((e): e is KnowledgeEntry => !!e)
  const documents = (Array.isArray(data.documents) ? data.documents : []).map(sanitizeDoc).filter((d): d is KbDocument => !!d)
  const memories = (Array.isArray(data.memories) ? data.memories : [])
    .map(sanitizeMemory)
    .filter((m): m is MemoryEntry => !!m)
  // 事务内先清空再灌入（任一步失败整体回滚，不留「导了一半」的库）
  const db = await openDb()
  const tx = db.transaction(
    ['entries', 'links', 'documents', 'doc_anchors', 'memories', 'preferences'],
    'readwrite'
  )
  for (const name of ['entries', 'links', 'documents', 'doc_anchors', 'memories', 'preferences']) {
    tx.objectStore(name).clear()
  }
  for (const entry of entries) tx.objectStore('entries').put(entry)
  for (const doc of documents) tx.objectStore('documents').put(doc)
  for (const memory of memories) tx.objectStore('memories').put(memory)
  for (const link of Array.isArray(data.links) ? data.links : []) {
    const row = link as Record<string, unknown>
    if (row.kind === 'entry' && typeof row.refId === 'string' && typeof row.nodeId === 'string') {
      tx.objectStore('links').add({ kind: 'entry', refId: row.refId, nodeId: row.nodeId, flowId: null, createdAt: now() })
    }
  }
  for (const link of Array.isArray(data.docLinks) ? data.docLinks : []) {
    const row = link as Record<string, unknown>
    if (typeof row.docId === 'string' && typeof row.nodeId === 'string') {
      tx.objectStore('links').add({ kind: 'doc', refId: row.docId, nodeId: row.nodeId, flowId: null, createdAt: now() })
    }
  }
  for (const anchor of (Array.isArray(data.docAnchors) ? data.docAnchors : []).map(sanitizeAnchor).filter((a): a is DocAnchor => !!a)) {
    tx.objectStore('doc_anchors').put(anchor)
  }
  const preferences = data.preferences
  if (preferences && typeof preferences === 'object' && !Array.isArray(preferences)) {
    for (const [key, value] of Object.entries(preferences as Record<string, unknown>)) {
      tx.objectStore('preferences').put({ key, value: String(value ?? ''), updatedAt: now() })
    }
  }
  await txDone(tx)
  return { entries: entries.length, documents: documents.length, memories: memories.length }
}
