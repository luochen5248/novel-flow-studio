/**
 * kb-sanitize.spec.ts —— 知识库脏数据兜底（src/core/kb/sanitize.ts）
 *
 * 覆盖：entries / documents / anchors / memories 四类实体的脏数据兜底，
 * 以及 normalizeTags。重点：缺字段 / 错类型 / 超长 / tags 非数组 /
 * SQL 注入味内容只当普通文本 / 旧数据（无新字段）兼容 / 非对象入参归 null。
 */
import { describe, it, expect } from 'vitest'
import {
  sanitizeEntry,
  sanitizeDoc,
  sanitizeAnchor,
  sanitizeMemory,
  normalizeTags
} from '@/core/kb/sanitize'
import type { DocAnchor, KnowledgeEntry, KbDocument, MemoryEntry } from '@/core/kb/types'

describe('sanitizeEntry · 条目兜底', () => {
  it('合法条目：trim 标题、默认 type=note、tags 收敛、时间戳为数字', () => {
    const e = sanitizeEntry({
      id: 'e1',
      title: '  雨夜诀别  ',
      type: 'character',
      content: '剑与伞留在雨中',
      tags: [' 主角 ', '配角'],
      createdAt: 100,
      updatedAt: 200
    }) as KnowledgeEntry
    expect(e).not.toBeNull()
    expect(e.id).toBe('e1')
    expect(e.title).toBe('雨夜诀别')
    expect(e.type).toBe('character')
    expect(e.content).toBe('剑与伞留在雨中')
    expect(e.tags).toEqual(['主角', '配角'])
    expect(e.createdAt).toBe(100)
    expect(e.updatedAt).toBe(200)
  })

  it('缺失 id → null', () => {
    expect(sanitizeEntry({ title: 'x' })).toBeNull()
    expect(sanitizeEntry({ id: '', title: 'x' })).toBeNull()
  })

  it('标题为空（trim 后） → null', () => {
    expect(sanitizeEntry({ id: 'e', title: '   ' })).toBeNull()
    expect(sanitizeEntry({ id: 'e', title: '' })).toBeNull()
  })

  it('非法 type 回落 note；非法 tags（非数组）回落空数组', () => {
    const e = sanitizeEntry({ id: 'e', title: 't', type: 'bogus', tags: 'not-array' }) as KnowledgeEntry
    expect(e.type).toBe('note')
    expect(e.tags).toEqual([])
  })

  it('SQL 注入味内容只当普通文本原样存（不解析、不报错）', () => {
    const malicious = "'; DROP TABLE kb_entries; -- "
    const e = sanitizeEntry({ id: 'e', title: 't', content: malicious }) as KnowledgeEntry
    expect(e.content).toBe(malicious)
    expect(sanitizeEntry({ id: 'e', title: 't', tags: [malicious] })?.tags).toEqual([malicious.trim()])
  })

  it('缺时间戳 → 用 Date.now() 兜底（数字且 > 0）', () => {
    const e = sanitizeEntry({ id: 'e', title: 't' }) as KnowledgeEntry
    expect(typeof e.createdAt).toBe('number')
    expect(typeof e.updatedAt).toBe('number')
    expect(e.createdAt).toBeGreaterThan(0)
    expect(e.updatedAt).toBeGreaterThan(0)
  })

  it('旧数据无新字段（type/tags/createdAt/updatedAt 缺失）兼容不白屏', () => {
    const legacy = { id: 'e', title: 'legacy' }
    const e = sanitizeEntry(legacy) as KnowledgeEntry
    expect(e).not.toBeNull()
    expect(e.title).toBe('legacy')
    expect(e.type).toBe('note')
    expect(e.tags).toEqual([])
  })

  it('非对象 / 数组 / null → null', () => {
    expect(sanitizeEntry(null)).toBeNull()
    expect(sanitizeEntry(undefined)).toBeNull()
    expect(sanitizeEntry('string')).toBeNull()
    expect(sanitizeEntry(42)).toBeNull()
    expect(sanitizeEntry(['a'])).toBeNull()
  })
})

describe('sanitizeDoc · 文档兜底', () => {
  it('合法文档带 content 时保留 content', () => {
    const d = sanitizeDoc({
      id: 'd1',
      title: '大纲',
      format: 'md',
      content: '第一章……',
      createdAt: 1,
      updatedAt: 2
    }) as KbDocument
    expect(d.id).toBe('d1')
    expect(d.title).toBe('大纲')
    expect(d.format).toBe('md')
    expect(d.content).toBe('第一章……')
  })

  it('列表通道（无 content）→ 不带 content 字段', () => {
    const d = sanitizeDoc({ id: 'd1', title: '大纲', format: 'txt' }) as KbDocument
    expect(d.content).toBeUndefined()
  })

  it('缺 id → null；缺 title → 未命名文档；非法 format → md', () => {
    expect(sanitizeDoc({ title: 'x' })).toBeNull()
    const noTitle = sanitizeDoc({ id: 'd', format: 'pdf' }) as KbDocument
    expect(noTitle.title).toBe('未命名文档')
    expect(noTitle.format).toBe('md')
  })
})

describe('sanitizeAnchor · 锚点兜底', () => {
  const base = { id: 'a1', docId: 'd1', quote: '断桥上的灯', startOffset: 5, endOffset: 10 }

  it('合法锚点原样收敛', () => {
    const a = sanitizeAnchor(base) as DocAnchor
    expect(a.id).toBe('a1')
    expect(a.docId).toBe('d1')
    expect(a.quote).toBe('断桥上的灯')
    expect(a.startOffset).toBe(5)
    expect(a.endOffset).toBe(10)
  })

  it('缺 docId 或 quote → null', () => {
    expect(sanitizeAnchor({ id: 'a', quote: 'q' })).toBeNull()
    expect(sanitizeAnchor({ id: 'a', docId: 'd' })).toBeNull()
    expect(sanitizeAnchor({ id: 'a', docId: 'd', quote: '' })).toBeNull()
  })

  it('负 / 非数字偏移量被夹紧：start 取 0、end 不低于 start', () => {
    const a = sanitizeAnchor({ id: 'a', docId: 'd', quote: 'q', startOffset: -5, endOffset: -2 }) as DocAnchor
    expect(a.startOffset).toBe(0)
    expect(a.endOffset).toBe(0)
    const b = sanitizeAnchor({ id: 'a', docId: 'd', quote: 'q', startOffset: 10, endOffset: 3 }) as DocAnchor
    expect(b.endOffset).toBe(10)
  })

  it('nodeId 缺省 → null（不挂到任何节点）', () => {
    const a = sanitizeAnchor({ id: 'a', docId: 'd', quote: 'q' }) as DocAnchor
    expect(a.nodeId).toBeNull()
  })
})

describe('sanitizeMemory · 记忆兜底', () => {
  it('合法记忆：默认 type=fact、source=manual、pinned 布尔化', () => {
    const m = sanitizeMemory({
      id: 'm1',
      type: 'preference',
      content: ' 喜欢短句 ',
      source: 'assist',
      pinned: true,
      createdAt: 1,
      updatedAt: 2
    }) as MemoryEntry
    expect(m.type).toBe('preference')
    expect(m.content).toBe('喜欢短句')
    expect(m.source).toBe('assist')
    expect(m.pinned).toBe(true)
  })

  it('缺 id / 空 content → null；非法 type/source 回落默认', () => {
    expect(sanitizeMemory({ content: 'x' })).toBeNull()
    expect(sanitizeMemory({ id: 'm', content: '   ' })).toBeNull()
    const m = sanitizeMemory({ id: 'm', content: 'x', type: 'weird', source: 'ghost' }) as MemoryEntry
    expect(m.type).toBe('fact')
    expect(m.source).toBe('manual')
  })

  it('pinned 非 true → false', () => {
    const m = sanitizeMemory({ id: 'm', content: 'x', pinned: 'yes' }) as MemoryEntry
    expect(m.pinned).toBe(false)
  })
})

describe('normalizeTags · 标签收敛', () => {
  it('非数组 → 空数组', () => {
    expect(normalizeTags(undefined)).toEqual([])
    expect(normalizeTags(null)).toEqual([])
    expect(normalizeTags('x')).toEqual([])
    expect(normalizeTags(42)).toEqual([])
  })

  it('trim + 去重 + 滤空', () => {
    expect(normalizeTags([' a ', 'a', '', '  b', 'b', '  '])).toEqual(['a', 'b'])
  })
})
