/**
 * ⚠️ 双写红线：本文件的纯函数（chunkText / contentHash / cosine / topKByCosine）
 * 与 `electron/kb/vecstore.cjs` **同构双写**（主进程是 CommonJS，require 不到
 * TS），任一侧改动必须同步另一侧 —— Tess 有等价性用例锁住漂移。
 *
 * 语义检索纯函数层（零依赖，可单测）。
 *
 * 为什么单独成层：向量检索的难点在「切分 / 去重 / 相似度」这三块**纯计算**，
 * 它们与 sql.js、IPC、UI 全都无关。抽成纯函数后 Tess 可以直接喂字符串断言，
 * 不必起 Electron 或造 db。
 *
 * 三条设计取舍（都要写清楚「为什么」）：
 *  1. **切分按段落边界优先**，不在任意字符位置硬切：中文语义检索的甜点位在
 *     256-512 字，但一句话被劈成两半会让这一块的向量失去意义，所以先按空行
 *     / 换行聚成段，段太长才退到句子边界，最后才硬切。
 *  2. **overlap 用「上一块的尾巴」而不是滑窗**：滑动窗口会让块数翻倍（10 万字
 *     从 312 块变 600+ 块），而相邻块末尾 80 字的重叠已经足以兜住跨边界的
 *     关键句 —— 成本减半，召回几乎不变。
 *  3. **contentHash 用两遍 FNV-1a 拼 64 位**：单遍 32 位（约 42 亿）在几万条
 *     chunk 上去重，碰撞概率已经可感知；换初始基跑第二遍把碰撞率压到 64 位
 *     量级，代价只是多一遍遍历（几万字的文本几十微秒）。
 *
 * ⚠️ 双写约定：主进程 `electron/kb/vecstore.cjs` 里有一份**逐行同构**的 CJS
 * 实现（chunkText / contentHash / cosine / topKByCosine），因为主进程是
 * CommonJS、require 不到 TS。改本文件必须同步改那边，反之亦然 —— 与
 * `electron/mcp/tools.cjs` 顶部「CJS 引不到 TS，只能双写并在注释里互指」
 * 是同一条纪律。
 */

/** 切分目标长度（字）：中文语义检索甜点位 256-512 的中值 */
export const CHUNK_TARGET_CHARS = 400
/** 切分硬上限（字）：超过就强制切开，防止一个超长段把整块撑爆 */
export const CHUNK_MAX_CHARS = 800
/** 相邻块的重叠长度（字）：兜住被切在边界上的关键句 */
export const CHUNK_OVERLAP_CHARS = 80
/** 短段合并阈值（字）：比这还短的段落单独成块语义太弱，并进相邻块 */
export const CHUNK_MIN_MERGE_CHARS = 60

/** 切分可选参数 */
export interface ChunkOptions {
  /** 目标长度，缺省 CHUNK_TARGET_CHARS */
  target?: number
  /** 硬上限，缺省 CHUNK_MAX_CHARS */
  max?: number
  /** 重叠长度，缺省 CHUNK_OVERLAP_CHARS；传 0 表示不重叠 */
  overlap?: number
}

/** 向量：只读的数值序列（Float32Array / number[] 都能传，单测好造） */
export type Vec = ArrayLike<number>

/** 余弦命中项：index 指回 candidates 的下标，由调用方映射回业务对象 */
export interface CosineHit {
  index: number
  score: number
}

/**
 * FNV-1a 32 位。
 *
 * 用 Math.imul 而不是 `h * 0x01000193`：后者会先转成双精度浮点再做位运算，
 * 超过 2^53 后精度丢失，哈希结果不可复现（contentHash 必须是纯函数）。
 */
function fnv1a(text: string, seed: number): number {
  let hash = seed >>> 0
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * 内容指纹（16 位十六进制 = 64 位）。
 *
 * 用途：`vec_chunks.contentHash` 的增量判定 —— 同 refId 同 chunkIndex
 * 且 hash 未变 → 跳过不重新 embedding。纯函数：同输入永远同输出。
 */
export function contentHash(text: string): string {
  const input = String(text ?? '')
  const low = fnv1a(input, 0x811c9dc5)
  // 第二遍换初始基（黄金比例常数的低 32 位），让两遍的结果相互独立
  const high = fnv1a(input, 0x9e3779b9)
  return low.toString(16).padStart(8, '0') + high.toString(16).padStart(8, '0')
}

/** 句子 / 语气边界（按优先级尝试，越靠前越优先在该处断句） */
const SENTENCE_BREAKS = ['。', '！', '？', '；', '\n', '，', '、']

/**
 * 硬切一个超长段：优先在句子边界断，实在没有标点才按长度硬切。
 *
 * 为什么要求断点落在后半段（`> max * 0.5`）：只切掉末尾一两个字会产生大量
 * 碎片块，碎片块向量化后是噪声。
 */
function hardSplit(text: string, max: number): string[] {
  const out: string[] = []
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

/**
 * 把长文本切成语义块。
 *
 * 流程：归一换行 → 按空行/换行分段 → 过短的段并入下一段 → 过长的段硬切
 * → 按目标长度贪心装箱 → 给每块（除首块）补上一块尾巴的 overlap。
 *
 * 边界：空白/空串返回 `[]`；整段短于目标长度返回单元素数组（不加重叠）。
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const target = Math.max(1, Math.trunc(options.target ?? CHUNK_TARGET_CHARS))
  const max = Math.max(target, Math.trunc(options.max ?? CHUNK_MAX_CHARS))
  const overlap = Math.max(0, Math.trunc(options.overlap ?? CHUNK_OVERLAP_CHARS))

  const source = String(text ?? '').replace(/\r\n?/g, '\n')
  if (!source.trim()) return []

  /* 1) 分段：空行优先，单个换行也算分段（md 正文常是单换行硬回车） */
  let paragraphs = source
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (!paragraphs.length) return []

  /* 2) 短段并入下一段：单独一句「他愣住了。」成块没有语义价值 */
  const merged: string[] = []
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
    // 尾巴上的短段并入上一段：单独一句「他愣住了。」单独成块没有语义价值，
    // 而且会多出一次 embedding 请求
    if (merged.length && buffer.length < CHUNK_MIN_MERGE_CHARS) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}\n${buffer}`
    } else {
      merged.push(buffer)
    }
  }
  paragraphs = merged

  /* 3) 超长段硬切（先切再装箱，避免装箱时被迫在句中腰斩） */
  const units: string[] = []
  for (const paragraph of paragraphs) {
    if (paragraph.length > max) units.push(...hardSplit(paragraph, max))
    else units.push(paragraph)
  }

  /* 4) 贪心装箱：装到接近 target 就收口，不把下一整段硬塞进来 */
  const packed: string[] = []
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

  /* 5) 补 overlap：第 i 块前面接上第 i-1 块的末尾 overlap 字 */
  if (overlap === 0 || packed.length < 2) return packed
  return packed.map((chunk, index) => {
    if (index === 0) return chunk
    const prev = packed[index - 1]
    const head = prev.length > overlap ? prev.slice(prev.length - overlap) : prev
    return `${head}\n${chunk}`
  })
}

/**
 * 余弦相似度（[-1, 1]）。
 *
 * 为什么不预先 L2 归一化后只算点积：预归一化确实能省 20-30%，但那要求
 * **入库时**就归一化，一旦以后换了「不归一化入库」的路径（或混进旧数据）
 * 结果会静默出错。这里每次现算模长，正确性优先 —— 1 万条 768 维实测 7ms，
 * 这点开销换不来正确性风险。
 *
 * 维度不一致 / 空向量 / 零向量一律返回 0：跨模型的向量空间不可比，宁可
 * 判定「不相似」，也不要抛异常打断一次检索。
 */
export function cosine(a: Vec, b: Vec): number {
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

/**
 * 取余弦 Top-K（降序）。
 *
 * `minScore` 默认 0：负相关的块对「找相似素材」没有意义，直接滤掉。
 * 同分按 index 升序（稳定排序），保证单测与线上结果都可复现。
 */
export function topKByCosine(
  queryVec: Vec,
  candidates: ArrayLike<Vec>,
  k: number,
  minScore = 0
): CosineHit[] {
  const cap = Math.max(0, Math.trunc(k))
  if (!queryVec || !queryVec.length || !candidates || cap === 0) return []
  const scored: CosineHit[] = []
  for (let i = 0; i < candidates.length; i += 1) {
    const score = cosine(queryVec, candidates[i])
    if (score < minScore) continue
    scored.push({ index: i, score })
  }
  scored.sort((x, y) => y.score - x.score || x.index - y.index)
  return scored.slice(0, cap)
}
