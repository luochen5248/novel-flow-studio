/**
 * vec.spec.ts —— 语义检索纯函数（src/core/kb/vec.ts）+ 双写等价性
 *
 * 覆盖：
 *  - `chunkText`：空输入 / 短文本 / 段落边界优先 / 短段合并 / 超长段硬切 /
 *    句子边界优先 / overlap 是否生效 / overlap = 0 / \r\n 归一 / target 生效。
 *  - `contentHash`：纯函数可复现 / 16 位 hex / 空串定值 / 单字符差异即变。
 *  - `cosine`：同向 1 / 缩放不变 / 正交 0 / 反向 -1 / 零向量 0 / 维度不一致 0。
 *  - `topKByCosine`：降序 / k 截断 / k=0 / 空候选 / minScore 过滤 / 同分稳定。
 *  - **双写等价性**：`src/core/kb/vec.ts` 与 `electron/kb/vecstore.cjs` 里的
 *    chunkText / contentHash / cosine / topKByCosine 是「逐行同构」的 CJS 双写
 *    （主进程 require 不到 TS）。本文件对同批样本断言两侧输出**完全一致**，
 *    任一侧改了另一侧没跟，这条会立刻红。
 *
 * 断言口径：全部按**实测真实行为**书写（见文件内注释标注的实测值），不臆想。
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import {
  CHUNK_TARGET_CHARS,
  CHUNK_MAX_CHARS,
  CHUNK_OVERLAP_CHARS,
  CHUNK_MIN_MERGE_CHARS,
  chunkText,
  contentHash,
  cosine,
  topKByCosine
} from '@/core/kb/vec'

/* ------------------------------------------------------------------ */
/* 双写侧：electron/kb/vecstore.cjs（CJS 同构实现）                      */
/* ------------------------------------------------------------------ */

const nodeRequire = createRequire(import.meta.url)

/**
 * `vecstore.cjs` 顶层有一句 `const { app } = require('electron')`。
 * vitest 里真 require('electron') 会去联网下载二进制并抛错，所以这里**在测试侧**
 * 把 electron 入口塞进 require 缓存，让它拿到一个假 app（不执行真正的 index.js）。
 * 这是纯测试桩 —— **没有修改任何实现文件**，且 vecstore 的纯函数不依赖 app。
 */
const electronEntry = nodeRequire.resolve('electron')
nodeRequire.cache[electronEntry] = {
  id: electronEntry,
  filename: electronEntry,
  loaded: true,
  exports: { app: { getPath: () => '/tmp/novelflow-vec-probe' } },
  children: [],
  paths: []
} as unknown as NodeModule

interface VecStorePure {
  chunkText(text: string, options?: Record<string, number>): string[]
  contentHash(text: string): string
  cosine(a: ArrayLike<number>, b: ArrayLike<number>): number
  topKByCosine(
    query: ArrayLike<number>,
    candidates: ArrayLike<ArrayLike<number>>,
    k: number,
    minScore?: number
  ): Array<{ index: number; score: number }>
}

const vecstore = nodeRequire('../../electron/kb/vecstore.cjs') as VecStorePure

/* ------------------------------------------------------------------ */
/* chunkText                                                           */
/* ------------------------------------------------------------------ */

describe('chunkText · 常量', () => {
  it('四个具名常量的取值与实现报告一致（400 / 800 / 80 / 60）', () => {
    expect(CHUNK_TARGET_CHARS).toBe(400)
    expect(CHUNK_MAX_CHARS).toBe(800)
    expect(CHUNK_OVERLAP_CHARS).toBe(80)
    expect(CHUNK_MIN_MERGE_CHARS).toBe(60)
  })
})

describe('chunkText · 空与短文本', () => {
  it('空串 → 空数组', () => {
    expect(chunkText('')).toEqual([])
  })

  it('纯空白（空格 / 换行 / 制表）→ 空数组', () => {
    expect(chunkText('   ')).toEqual([])
    expect(chunkText('\n\n\n')).toEqual([])
    expect(chunkText(' \t \r\n ')).toEqual([])
  })

  it('短于目标长度的整段 → 单元素数组，内容原样返回（不补 overlap）', () => {
    expect(chunkText('一句话。')).toEqual(['一句话。'])
  })

  it('null / undefined 走 String() 兜底 → 空数组，不抛异常', () => {
    expect(chunkText(null as unknown as string)).toEqual([])
    expect(chunkText(undefined as unknown as string)).toEqual([])
  })
})

describe('chunkText · 段落与边界', () => {
  /** 5 个 100 字段落，每个都以「。」收尾 */
  const paragraphs = Array.from({ length: 5 }, (_, i) => `第${i}段` + '内容'.repeat(48) + '。')
  const text = paragraphs.join('\n\n')

  it('按段落装箱：切点落在段落边界上，每块都以句号收尾（不在句中腰斩）', () => {
    const chunks = chunkText(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.endsWith('。')).toBe(true)
  })

  it('块内用 \\n 保留段落分隔，不拼接成一坨', () => {
    const chunks = chunkText(text)
    expect(chunks[0].includes('\n')).toBe(true)
  })

  it('短段落（< 60 字）会被并入相邻块，不单独成块', () => {
    const merged = chunkText('短。\n短二。\n短三。')
    expect(merged).toHaveLength(1)
    expect(merged[0].includes('短三')).toBe(true)
  })

  it('\\r\\n 归一为 \\n，结果里不含 \\r', () => {
    const chunks = chunkText('甲。\r\n\r\n乙。')
    expect(chunks.join('')).not.toContain('\r')
  })

  it('超长且无标点的段 → 被硬切成多块，首块长度不超过 max', () => {
    const chunks = chunkText('丙'.repeat(2000))
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].length).toBeLessThanOrEqual(CHUNK_MAX_CHARS)
  })

  it('硬切优先落在句子边界：含句号的长段，首块以「。」结尾', () => {
    const chunks = chunkText('这是一句完整的话。'.repeat(100))
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].endsWith('。')).toBe(true)
  })

  it('target 调小 → 块数变多（target 是装箱收口阈值，不是硬上限）', () => {
    const big = chunkText(text)
    const small = chunkText(text, { target: 120 })
    expect(small.length).toBeGreaterThan(big.length)
  })
})

describe('chunkText · overlap', () => {
  const a = '甲'.repeat(300)
  const b = '乙'.repeat(300)
  const text = `${a}\n\n${b}`

  it('默认生效：第 2 块开头 = 第 1 块末尾 80 字 + 换行', () => {
    const chunks = chunkText(text)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toBe(a)
    expect(chunks[1]).toBe(`${a.slice(-CHUNK_OVERLAP_CHARS)}\n${b}`)
  })

  it('overlap = 0 → 块与块之间完全不重叠', () => {
    const chunks = chunkText(text, { overlap: 0 })
    expect(chunks).toEqual([a, b])
  })

  it('overlap 大于上一块长度时整块兜上（不越界、不报错）', () => {
    const chunks = chunkText(text, { overlap: 10000 })
    expect(chunks[1]).toBe(`${a}\n${b}`)
  })

  it('只有一块时不加 overlap（首块永远原样）', () => {
    const chunks = chunkText('甲'.repeat(100))
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe('甲'.repeat(100))
  })
})

/* ------------------------------------------------------------------ */
/* contentHash                                                         */
/* ------------------------------------------------------------------ */

describe('contentHash', () => {
  it('纯函数：同一输入多次调用完全一致', () => {
    expect(contentHash('江雾渡 · 序章')).toBe(contentHash('江雾渡 · 序章'))
  })

  it('16 位十六进制（两遍 FNV-1a 拼 64 位）', () => {
    expect(contentHash('abc')).toMatch(/^[0-9a-f]{16}$/)
    expect(contentHash('abc')).toHaveLength(16)
  })

  it('空串的哈希是定值（锁定实现，换了算法会立刻报警，避免存量索引全失效）', () => {
    expect(contentHash('')).toBe('811c9dc59e3779b9')
  })

  it('不同文本 → 不同哈希；单字符差异也必须变', () => {
    expect(contentHash('abc')).not.toBe(contentHash('abd'))
    expect(contentHash('江雾渡')).not.toBe(contentHash('江雾'))
  })

  it('长文本同样稳定，且与短文本不同', () => {
    const long = '丙'.repeat(20000)
    expect(contentHash(long)).toBe(contentHash(long))
    expect(contentHash(long)).not.toBe(contentHash('丙'))
  })

  it('null / undefined 走 String() 兜底，与空串同值', () => {
    expect(contentHash(null as unknown as string)).toBe(contentHash(''))
    expect(contentHash(undefined as unknown as string)).toBe(contentHash(''))
  })
})

/* ------------------------------------------------------------------ */
/* cosine                                                              */
/* ------------------------------------------------------------------ */

describe('cosine', () => {
  it('相同向量 → 1（含浮点误差容差）', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 12)
  })

  it('正比例缩放 → 仍是 1（余弦只看方向）', () => {
    expect(cosine([1, 2], [2, 4])).toBeCloseTo(1, 12)
  })

  it('正交 → 0', () => {
    expect(cosine([1, 0], [0, 1])).toBe(0)
  })

  it('完全反向 → -1', () => {
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 12)
  })

  it('45° → √2/2', () => {
    expect(cosine([1, 0], [1, 1])).toBeCloseTo(Math.SQRT1_2, 12)
  })

  it('零向量按实现行为返回 0（不抛异常、不是 NaN）', () => {
    expect(cosine([0, 0], [1, 1])).toBe(0)
    expect(cosine([1, 1], [0, 0])).toBe(0)
    expect(cosine([0, 0], [0, 0])).toBe(0)
  })

  it('维度不一致 → 0（跨模型向量空间不可比，宁可判不相似）', () => {
    expect(cosine([1, 2], [1, 2, 3])).toBe(0)
  })

  it('空向量 → 0', () => {
    expect(cosine([], [])).toBe(0)
    expect(cosine([], [1])).toBe(0)
  })

  it('Float32Array 也能算（入库向量就是 Float32Array）', () => {
    const a = new Float32Array([1, 0])
    const b = new Float32Array([0, 1])
    expect(cosine(a, b)).toBe(0)
    expect(cosine(a, a)).toBeCloseTo(1, 6)
  })
})

/* ------------------------------------------------------------------ */
/* topKByCosine                                                        */
/* ------------------------------------------------------------------ */

describe('topKByCosine', () => {
  const query = [1, 0]
  const candidates = [
    [0, 1], // 0.0   正交
    [1, 0], // 1.0   同向
    [0.5, 0.5], // ≈0.707
    [-1, 0], // -1.0  反向
    [1, 0] // 1.0   与 index 1 同分
  ]

  it('按分数降序返回', () => {
    const hits = topKByCosine(query, candidates, 5)
    const scores = hits.map((h) => h.score)
    expect(scores).toEqual([...scores].sort((x, y) => y - x))
  })

  it('index 指回 candidates 的原始下标', () => {
    const hits = topKByCosine(query, candidates, 1)
    expect(hits[0].index).toBe(1)
  })

  it('同分按 index 升序（稳定排序，线上与单测结果一致）', () => {
    const hits = topKByCosine(query, candidates, 2)
    expect(hits.map((h) => h.index)).toEqual([1, 4])
  })

  it('k 小于候选数 → 截断到 k', () => {
    expect(topKByCosine(query, candidates, 2)).toHaveLength(2)
  })

  it('k 大于候选数 → 返回全部达标项，不补空位', () => {
    // 默认 minScore = 0 会滤掉反向的 index 3，但正交的 index 0（score 0）会留下
    expect(topKByCosine(query, candidates, 99)).toHaveLength(4)
  })

  it('k = 0 / 负数 → 空数组', () => {
    expect(topKByCosine(query, candidates, 0)).toEqual([])
    expect(topKByCosine(query, candidates, -3)).toEqual([])
  })

  it('空候选 → 空数组', () => {
    expect(topKByCosine(query, [], 3)).toEqual([])
  })

  it('默认 minScore = 0：负相关项被滤掉', () => {
    const hits = topKByCosine(query, candidates, 99)
    expect(hits.some((h) => h.index === 3)).toBe(false)
  })

  it('minScore 提高 → 低分项被滤掉', () => {
    const hits = topKByCosine(query, candidates, 99, 0.7)
    expect(hits.map((h) => h.index)).toEqual([1, 4, 2])
  })

  it('minScore = -1 → 负分项保留并排最后', () => {
    const hits = topKByCosine(query, candidates, 99, -1)
    expect(hits).toHaveLength(5)
    expect(hits[hits.length - 1].index).toBe(3)
  })

  it('空 query 向量 → 空数组', () => {
    expect(topKByCosine([], candidates, 3)).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* 双写等价性：vec.ts ↔ vecstore.cjs                                     */
/* ------------------------------------------------------------------ */

describe('双写等价性 · vec.ts ↔ electron/kb/vecstore.cjs', () => {
  const samples: Array<[string, string]> = [
    ['空串', ''],
    ['纯空白', '   \n\t  '],
    ['单句', '一句话。'],
    ['多段', '第一段。\n\n第二段。\n\n第三段。'],
    ['多个短段', '短。\n短二。\n短三。'],
    ['CRLF', '甲。\r\n\r\n乙。'],
    ['超长无标点', '丙'.repeat(2000)],
    ['长段含句号', '这是一句完整的话。'.repeat(100)],
    [
      '长篇多段',
      Array.from({ length: 12 }, (_, i) => `第${i}段` + '内容'.repeat(90)).join('\n\n')
    ],
    ['中文混排', '江雾渡 序章 · 雨夜 2026年 三年后 「船还在，人未归。」']
  ]

  it('vecstore.cjs 能被加载且导出了四个纯函数（同构双写存在）', () => {
    expect(typeof vecstore.chunkText).toBe('function')
    expect(typeof vecstore.contentHash).toBe('function')
    expect(typeof vecstore.cosine).toBe('function')
    expect(typeof vecstore.topKByCosine).toBe('function')
  })

  it('chunkText 默认参数：逐样本输出完全一致', () => {
    for (const [label, text] of samples) {
      expect(vecstore.chunkText(text), `样本「${label}」两侧切分不一致`).toEqual(chunkText(text))
    }
  })

  it('chunkText 自定义参数：逐样本输出完全一致', () => {
    const options: Record<string, number> = { target: 120, max: 300, overlap: 20 }
    for (const [label, text] of samples) {
      expect(
        vecstore.chunkText(text, options),
        `样本「${label}」自定义参数下两侧不一致`
      ).toEqual(chunkText(text, options))
    }
  })

  it('contentHash 逐样本输出完全一致（含空串与长文本）', () => {
    for (const [label, text] of samples) {
      expect(vecstore.contentHash(text), `样本「${label}」哈希不一致`).toBe(contentHash(text))
    }
  })

  it('cosine 逐对输出完全一致（含零向量 / 维度不一致 / 反向）', () => {
    const pairs: Array<[ArrayLike<number>, ArrayLike<number>]> = [
      [[1, 2, 3], [1, 2, 3]],
      [[1, 0], [0, 1]],
      [[1, 0], [-1, 0]],
      [[0, 0], [1, 1]],
      [[1, 2], [1, 2, 3]],
      [[], []],
      [new Float32Array([1, 0]), new Float32Array([1, 1])]
    ]
    for (const [a, b] of pairs) {
      expect(vecstore.cosine(a, b)).toBe(cosine(a, b))
    }
  })

  it('topKByCosine 输出完全一致（含 k 边界 / minScore 过滤 / 同分稳定）', () => {
    const query = [0.3, 0.9]
    const candidates: number[][] = [
      [1, 0],
      [0, 1],
      [0.5, 0.5],
      [-1, 0],
      [0.3, 0.9],
      [0, 0]
    ]
    for (const k of [0, 1, 3, 99]) {
      for (const minScore of [-1, 0, 0.5]) {
        expect(vecstore.topKByCosine(query, candidates, k, minScore)).toEqual(
          topKByCosine(query, candidates, k, minScore)
        )
      }
    }
  })
})
