/**
 * kb-search.spec.ts —— 知识库相关性精排（src/core/kb/search.ts）
 *
 * 覆盖：标题命中 > 标签命中 > 正文命中（权重序）；内容重复命中加分上限（cap）；
 * 空 query / 无结果 / 大小写 / 时间衰减（同分 updatedAt 新在前）/ 不截断返回全量。
 */
import { describe, it, expect } from 'vitest'
import { scoreEntry, rankEntries, buildNodeQuery, type NodeQuerySource } from '@/core/kb/search'
import type { KnowledgeEntry } from '@/core/kb/types'

function entry(p: Partial<KnowledgeEntry>): KnowledgeEntry {
  return {
    id: p.id ?? 'e',
    title: p.title ?? '',
    type: p.type ?? 'note',
    content: p.content ?? '',
    tags: p.tags ?? [],
    createdAt: p.createdAt ?? 0,
    updatedAt: p.updatedAt ?? 0
  }
}

describe('scoreEntry · 字段权重', () => {
  it('标题命中 > 标签命中 > 正文命中', () => {
    const q = '雨夜'
    const titleHit = scoreEntry(entry({ title: '雨夜诀别' }), q)
    const tagHit = scoreEntry(entry({ tags: ['雨夜'] }), q)
    const contentHit = scoreEntry(entry({ content: '那是一个雨夜' }), q)
    expect(titleHit).toBeGreaterThan(tagHit)
    expect(tagHit).toBeGreaterThan(contentHit)
  })

  it('标题前缀命中额外 +20', () => {
    const prefix = scoreEntry(entry({ title: '雨夜的桥' }), '雨夜')
    const mid = scoreEntry(entry({ title: '那座雨夜的桥' }), '雨夜')
    expect(prefix).toBeGreaterThan(mid)
  })

  it('正文重复命中加分有上限（cap = 10 次额外的 ×2，6 次即触顶）', () => {
    const two = scoreEntry(entry({ content: '雨夜'.repeat(2) }), '雨夜')
    const six = scoreEntry(entry({ content: '雨夜'.repeat(6) }), '雨夜')
    const hundred = scoreEntry(entry({ content: '雨夜'.repeat(100) }), '雨夜')
    // 2 次未触顶，6 次与 100 次都已触顶，得分相同
    expect(two).toBeLessThan(six)
    expect(six).toBe(hundred)
  })

  it('空 query → 0 分', () => {
    expect(scoreEntry(entry({ title: '雨夜' }), '')).toBe(0)
    expect(scoreEntry(entry({ title: '雨夜' }), '   ')).toBe(0)
  })
})

describe('rankEntries · 排序与边界', () => {
  const now = 1_000_000_000_000

  it('相关性降序：标题命中排最前，正文命中排最后', () => {
    const list = [
      entry({ id: 'a', content: '雨夜降临' }), // 正文
      entry({ id: 'b', title: '雨夜诀别' }), // 标题
      entry({ id: 'c', tags: ['雨夜'] }) // 标签
    ]
    const ranked = rankEntries(list, '雨夜', { now })
    expect(ranked.map((e) => e.id)).toEqual(['b', 'c', 'a'])
  })

  it('空 query → 零分全滤掉，返回空数组', () => {
    const list = [entry({ id: 'a', title: '雨夜' }), entry({ id: 'b' })]
    expect(rankEntries(list, '', { now })).toEqual([])
  })

  it('无命中 → 空数组', () => {
    const list = [entry({ id: 'a', title: '晴天' }), entry({ id: 'b', content: '阳光' })]
    expect(rankEntries(list, '雨夜', { now })).toEqual([])
  })

  it('大小写不敏感', () => {
    const list = [entry({ id: 'a', content: 'Rainy night' })]
    const ranked = rankEntries(list, 'RAINY', { now })
    expect(ranked).toHaveLength(1)
    expect(ranked[0].id).toBe('a')
  })

  it('不截断：所有命中条目都返回（limit 由调用方控制）', () => {
    const list = Array.from({ length: 10 }, (_, i) => entry({ id: `e${i}`, title: '雨夜' }))
    expect(rankEntries(list, '雨夜', { now })).toHaveLength(10)
  })

  it('时间衰减：同分条目 updatedAt 新的排前面', () => {
    const q = '雨夜'
    const old = entry({ id: 'old', title: '雨夜', updatedAt: now - 365 * 86_400_000 })
    const fresh = entry({ id: 'fresh', title: '雨夜', updatedAt: now - 86_400_000 })
    const ranked = rankEntries([old, fresh], q, { now })
    expect(ranked[0].id).toBe('fresh')
    expect(ranked[1].id).toBe('old')
  })
})

describe('buildNodeQuery · 节点 → 检索词', () => {
  it('标题 + 人物 + 地点 + 标签 拼成检索串', () => {
    const node: NodeQuerySource = {
      title: '雨夜诀别',
      characters: ['沈孤鸿', '', '阿蕊'],
      location: '临安',
      tags: ['主线', '悲剧']
    }
    expect(buildNodeQuery(node)).toBe('雨夜诀别 沈孤鸿 阿蕊 临安 主线 悲剧')
  })

  it('空 / null 节点 → 空串', () => {
    expect(buildNodeQuery(null)).toBe('')
    expect(buildNodeQuery(undefined)).toBe('')
    expect(buildNodeQuery({})).toBe('')
  })
})
