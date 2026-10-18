/**
 * kb-idb.spec.ts —— 浏览器态 IndexedDB 孪生实现（src/api/kbIdb.ts）
 *
 * 不引 fake-indexeddb：手写一份内存 fake 实现 kbIdb 用到的 IDB 子集接口
 * （open / onupgradeneeded / transaction / objectStore / get/put/add/getAll/
 * delete/clear / index.getAll），用它驱动真实 kbIdb 模块，断言接口形状与
 * put→get→delete→getAll 数据流。
 *
 * 另含 kbClient 的 hasKbBridge 分流：true 走 bridge 透传、false 走 IDB 孪生。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import * as idb from '@/api/kbIdb'
import * as kbClient from '@/api/kbClient'
import type { KbApi } from '@/types/ai'

/* ---------------- 手写内存 fake IndexedDB（子集） ---------------- */

class FakeIDBRequest {
  result: any
  onsuccess: (() => void) | null = null
  onerror: ((e?: any) => void) | null = null
  onupgradeneeded: (() => void) | null = null
  constructor(result: any) {
    this.result = result
  }
  _succeed() {
    const cb = this.onsuccess
    this.onsuccess = null
    if (cb) cb()
  }
}

class FakeStore {
  name: string
  keyPath: string | null
  autoIncrement: boolean
  records = new Map<any, any>()
  indexes = new Map<string, { keyPath: string }>()
  _seq = 0
  constructor(name: string, keyPath: string | null, autoIncrement: boolean) {
    this.name = name
    this.keyPath = keyPath
    this.autoIncrement = autoIncrement
  }
  createIndex(name: string, keyPath: string) {
    this.indexes.set(name, { keyPath })
  }
}

const FAKE_UPGRADE_TX = { pending: 0, _settle() {} } as unknown as FakeTx

class FakeTxStore {
  store: FakeStore
  tx: FakeTx
  constructor(store: FakeStore, tx: FakeTx) {
    this.store = store
    this.tx = tx
  }
  createIndex(name: string, keyPath: string) {
    this.store.createIndex(name, keyPath)
  }
  _op(fn: () => any): FakeIDBRequest {
    const req = new FakeIDBRequest(fn())
    this.tx.pending++
    Promise.resolve().then(() => {
      req._succeed()
      this.tx.pending--
      this.tx._settle()
    })
    return req
  }
  get(key: any) {
    return this._op(() => this.store.records.get(key))
  }
  getAll() {
    return this._op(() => [...this.store.records.values()])
  }
  put(value: any) {
    let key = this.store.keyPath ? value[this.store.keyPath] : undefined
    if (key === undefined && this.store.autoIncrement) {
      key = ++this.store._seq
      value = { ...value, id: key }
    }
    return this._op(() => {
      this.store.records.set(key, value)
      return value
    })
  }
  add(value: any) {
    let key = this.store.keyPath ? value[this.store.keyPath] : undefined
    if (key === undefined && this.store.autoIncrement) {
      key = ++this.store._seq
      value = { ...value, id: key }
    }
    return this._op(() => {
      this.store.records.set(key, value)
      return value
    })
  }
  delete(key: any) {
    return this._op(() => {
      this.store.records.delete(key)
    })
  }
  clear() {
    return this._op(() => {
      this.store.records.clear()
    })
  }
  index(name: string): FakeTxIndex {
    const idx = this.store.indexes.get(name)
    if (!idx) throw new Error(`no index ${name}`)
    return new FakeTxIndex(this.store, idx, this.tx)
  }
}

class FakeTxIndex {
  store: FakeStore
  idx: { keyPath: string }
  tx: FakeTx
  constructor(store: FakeStore, idx: { keyPath: string }, tx: FakeTx) {
    this.store = store
    this.idx = idx
    this.tx = tx
  }
  getAll(query?: any): FakeIDBRequest {
    const rows = [...this.store.records.values()].filter((r) => r[this.idx.keyPath] === query)
    const req = new FakeIDBRequest(rows)
    this.tx.pending++
    Promise.resolve().then(() => {
      req._succeed()
      this.tx.pending--
      this.tx._settle()
    })
    return req
  }
}

class FakeTx {
  mode: string
  storeNames: string[]
  db: FakeDB
  pending = 0
  _settled = false
  _oncomplete: (() => void) | null = null
  _onerror: ((e?: any) => void) | null = null
  _onabort: ((e?: any) => void) | null = null
  constructor(mode: string, storeNames: string[], db: FakeDB) {
    this.mode = mode
    this.storeNames = storeNames
    this.db = db
  }
  objectStore(name: string): FakeTxStore {
    const store = this.db.stores.get(name)
    if (!store) throw new Error(`no store ${name}`)
    return new FakeTxStore(store, this)
  }
  _settle() {
    if (this.pending === 0 && this._oncomplete && !this._settled) {
      this._settled = true
      setTimeout(() => {
        if (this._oncomplete) this._oncomplete()
      }, 0)
    }
  }
  set oncomplete(fn: (() => void) | null) {
    this._oncomplete = fn
    if (fn && this.pending === 0) this._settle()
  }
  get oncomplete() {
    return this._oncomplete
  }
}

class FakeDB {
  name = ''
  version = 0
  stores = new Map<string, FakeStore>()
  get objectStoreNames() {
    return { contains: (n: string) => this.stores.has(n) }
  }
  createObjectStore(name: string, opts: { keyPath?: string | null; autoIncrement?: boolean } = {}) {
    let s = this.stores.get(name)
    if (!s) {
      s = new FakeStore(name, opts.keyPath ?? null, opts.autoIncrement ?? false)
      this.stores.set(name, s)
    }
    return new FakeTxStore(s, FAKE_UPGRADE_TX)
  }
  transaction(names: string | string[], mode: IDBTransactionMode): FakeTx {
    const list = Array.isArray(names) ? names : [names]
    return new FakeTx(mode, list, this)
  }
}

class FakeIndexedDB {
  databases = new Map<string, FakeDB>()
  open(name: string, version: number): FakeIDBRequest {
    let db = this.databases.get(name)
    const isNew = !db
    if (!db) {
      db = new FakeDB()
      db.name = name
      db.version = version
      this.databases.set(name, db)
    }
    const req = new FakeIDBRequest(db)
    setTimeout(() => {
      if (isNew && req.onupgradeneeded) req.onupgradeneeded()
      if (req.onsuccess) req.onsuccess()
    }, 0)
    return req
  }
  reset() {
    for (const db of this.databases.values()) {
      for (const store of db.stores.values()) store.records.clear()
    }
  }
}

/* ---------------- 安装 fake IDB ---------------- */

let fakeIDB: FakeIndexedDB

function installFakeIDB() {
  fakeIDB = new FakeIndexedDB()
  try {
    Object.defineProperty(globalThis, 'indexedDB', { value: fakeIDB, configurable: true, writable: true })
  } catch {
    ;(globalThis as any).indexedDB = fakeIDB
  }
}
function uninstallFakeIDB() {
  try {
    delete (globalThis as any).indexedDB
  } catch {
    /* ignore */
  }
}

beforeAll(() => {
  installFakeIDB()
})

afterAll(() => {
  uninstallFakeIDB()
})

beforeEach(() => {
  fakeIDB.reset()
  // 浏览器态默认：无 electronAPI.kb → 走 IDB 孪生实现
  ;(window as any).electronAPI = {}
})

/* ---------------- kbIdb · 接口形状与数据流 ---------------- */

describe('kbIdb · 接口形状与基本数据流', () => {
  it('put→get→delete→getAll：条目增删查全链路', async () => {
    const e1 = await idb.idbCreateEntry({ title: '雨夜诀别', type: 'character', content: '剑与伞', tags: ['主角'] })
    const e2 = await idb.idbCreateEntry({ title: '临安城', type: 'setting' })
    expect(e1.id).toBeTruthy()
    let all = await idb.idbListEntries()
    expect(all.map((e) => e.id)).toEqual(expect.arrayContaining([e1.id, e2.id]))

    await idb.idbRemoveEntry(e1.id)
    all = await idb.idbListEntries()
    expect(all.map((e) => e.id)).not.toContain(e1.id)
    expect(all.map((e) => e.id)).toContain(e2.id)
  })

  it('update：改写内容并刷新 updatedAt', async () => {
    const e = await idb.idbCreateEntry({ title: '旧标题', content: '旧内容' })
    const before = e.updatedAt
    const updated = await idb.idbUpdateEntry(e.id, { title: '新标题', content: '新内容' })
    expect(updated?.title).toBe('新标题')
    expect(updated?.content).toBe('新内容')
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(before)
    // 列表读取到的是更新后的值
    const list = await idb.idbListEntries()
    expect(list.find((x) => x.id === e.id)?.title).toBe('新标题')
  })

  it('文档：create 不返回 content，get 带 content，list 不带 content', async () => {
    const doc = await idb.idbCreateDoc({ title: '大纲', format: 'md', content: '第一章……' })
    expect(doc.content).toBeUndefined()
    const got = await idb.idbGetDoc(doc.id)
    expect(got?.content).toBe('第一章……')
    const list = await idb.idbListDocs()
    expect(list.find((d) => d.id === doc.id)?.content).toBeUndefined()
  })

  it('节点关联：link 去重，listLinksForNode 反查条目', async () => {
    const e = await idb.idbCreateEntry({ title: '关联条目' })
    await idb.idbLinkEntry(e.id, 'node-x')
    await idb.idbLinkEntry(e.id, 'node-x') // 重复 link 不应产生第二条
    const links = await idb.idbListLinksForNode('node-x')
    expect(links.entries).toHaveLength(1)
    expect(links.entries[0].id).toBe(e.id)
    await idb.idbUnlinkEntry(e.id, 'node-x')
    const after = await idb.idbListLinksForNode('node-x')
    expect(after.entries).toHaveLength(0)
  })

  it('锚点：create 后按 docId 反查', async () => {
    const a = await idb.idbCreateAnchor({ docId: 'd1', quote: '断桥上的灯', startOffset: 3, endOffset: 8 })
    const list = await idb.idbListAnchors({ docId: 'd1' })
    expect(list.map((x) => x.id)).toContain(a.id)
    expect(list[0].quote).toBe('断桥上的灯')
  })

  it('记忆：create / list（pinned 优先）/ update / remove', async () => {
    const m1 = await idb.idbCreateMemory({ type: 'preference', content: '喜欢短句' })
    const m2 = await idb.idbCreateMemory({ type: 'fact', content: '沈孤鸿是主角', pinned: true })
    expect(m1.id).toBeTruthy()
    let list = await idb.idbListMemories()
    expect(list[0].id).toBe(m2.id) // pinned 在前
    await idb.idbUpdateMemory(m1.id, { content: '改成中句' })
    list = await idb.idbListMemories()
    expect(list.find((m) => m.id === m1.id)?.content).toBe('改成中句')
    await idb.idbRemoveMemory(m1.id)
    list = await idb.idbListMemories()
    expect(list.map((m) => m.id)).not.toContain(m1.id)
  })

  it('偏好：set / get 往返', async () => {
    await idb.idbSetPreference('pref.chat_memory' as any, 'true')
    const prefs = await idb.idbGetPreferences()
    expect(prefs['pref.chat_memory']).toBe('true')
  })

  it('搜索：LIKE 粗筛 + 精排返回相关条目', async () => {
    await idb.idbCreateEntry({ title: '雨夜诀别', content: '临安城外' })
    await idb.idbCreateEntry({ title: '晴天', content: '阳光灿烂' })
    const hits = await idb.idbSearchEntries('雨夜')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].title).toBe('雨夜诀别')
    const none = await idb.idbSearchEntries('zzz不存在')
    expect(none).toEqual([])
  })

  it('整理：重复记忆被合并', async () => {
    await idb.idbCreateMemory({ type: 'fact', content: '同一句记忆' })
    await idb.idbCreateMemory({ type: 'fact', content: '同一句记忆' })
    const report = await idb.idbCurate()
    expect(report.before).toBe(2)
    expect(report.merged).toBe(1)
    expect(report.after).toBe(1)
  })

  it('导出/导入全量：round-trip 还原条目数', async () => {
    await idb.idbCreateEntry({ title: '条目A' })
    await idb.idbCreateEntry({ title: '条目B' })
    await idb.idbCreateDoc({ title: '文档C', format: 'md', content: '内容' })
    await idb.idbCreateMemory({ type: 'fact', content: '记忆D' })
    const json = await idb.idbExportAll()
    const parsed = JSON.parse(json)
    expect(parsed.entries).toHaveLength(2)
    expect(parsed.documents).toHaveLength(1)
    expect(parsed.memories).toHaveLength(1)

    fakeIDB.reset()
    const result = await idb.idbImportAll(json)
    expect(result).toEqual({ entries: 2, documents: 1, memories: 1 })
    expect(await idb.idbListEntries()).toHaveLength(2)
  })
})

/* ---------------- kbClient · hasKbBridge 分流 ---------------- */

describe('kbClient · hasKbBridge 桌面/浏览器分流', () => {
  it('hasKbBridge 随 window.electronAPI.kb 有无切换', () => {
    ;(window as any).electronAPI = {}
    expect(kbClient.hasKbBridge()).toBe(false)
    ;(window as any).electronAPI = { kb: {} as KbApi }
    expect(kbClient.hasKbBridge()).toBe(true)
  })

  it('无桥（浏览器态）→ 走 IDB 孪生实现，数据真实落 fake', async () => {
    ;(window as any).electronAPI = {}
    const created = await kbClient.createEntry({ title: '浏览器态条目', content: '正文' })
    const list = await kbClient.listEntries()
    expect(list.map((e) => e.id)).toContain(created.id)
  })

  it('有桥（桌面态）→ 走 bridge 透传，不落 IDB', async () => {
    const bridgeEntries = [
      { id: 'b1', title: '桥条目', type: 'note', content: '', tags: [], createdAt: 0, updatedAt: 0 }
    ]
    const kbMock: KbApi = {
      listEntries: vi.fn(async () => ({ ok: true, entries: bridgeEntries }))
    } as unknown as KbApi
    ;(window as any).electronAPI = { kb: kbMock }

    const list = await kbClient.listEntries()
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('桥条目')
    expect(kbMock.listEntries).toHaveBeenCalled()
    // IDB 不应被写入（fake 仍为空）
    expect(await idb.idbListEntries()).toHaveLength(0)
  })
})
