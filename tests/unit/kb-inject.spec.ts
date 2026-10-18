/**
 * kb-inject.spec.ts —— 三路注入块组装（src/core/kb/inject.ts）
 *
 * 覆盖：buildMemoryBlock / buildKbBlock / buildDocBlock 的字符预算、空输入返回空块、
 * 文案禁「检索」「联网」、文档锚点块带标题+段落标注、MEMORY_MAX_CHARS 预算
 * （超限先砍记忆条数保背景正文）。三路块顺序由调用方拼接，在 aiPrompt 扩展回归里验证。
 */
import { describe, it, expect } from 'vitest'
import {
  MEMORY_MAX_CHARS,
  KB_MAX_CHARS,
  DOC_MAX_CHARS,
  buildMemoryBlock,
  buildKbBlock,
  buildDocBlock
} from '@/core/kb/inject'
import type { DocAnchor, KnowledgeEntry, MemoryEntry } from '@/core/kb/types'

const FORBIDDEN = ['检索', '联网']
function assertNoForbidden(text: string) {
  for (const w of FORBIDDEN) expect(text).not.toContain(w)
}

const memory = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: over.id ?? 'm1',
  type: over.type ?? 'preference',
  content: over.content ?? '喜欢短句',
  source: over.source ?? 'manual',
  pinned: over.pinned ?? false,
  createdAt: over.createdAt ?? 0,
  updatedAt: over.updatedAt ?? 0
})

const entry = (over: Partial<KnowledgeEntry> = {}): KnowledgeEntry => ({
  id: over.id ?? 'e1',
  title: over.title ?? '雨夜诀别',
  type: over.type ?? 'character',
  content: over.content ?? '剑与伞留在雨中',
  tags: over.tags ?? ['主角'],
  createdAt: over.createdAt ?? 0,
  updatedAt: over.updatedAt ?? 0
})

const anchor = (over: Partial<DocAnchor> = {}): DocAnchor => ({
  id: over.id ?? 'a1',
  docId: over.docId ?? 'd1',
  nodeId: over.nodeId ?? null,
  quote: over.quote ?? '雨下了整夜',
  startOffset: over.startOffset ?? 0,
  endOffset: over.endOffset ?? 5,
  note: over.note ?? '',
  createdAt: over.createdAt ?? 0
})

describe('buildMemoryBlock · 作者记忆块', () => {
  it('空输入 → 空块（保证 aiPrompt 输出与无注入逐字节一致）', () => {
    expect(buildMemoryBlock('', [])).toBe('')
    expect(buildMemoryBlock(undefined as unknown as string, [])).toBe('')
  })

  it('背景 + 记忆 → 带「## 作者记忆」头与工作背景/记忆行', () => {
    const block = buildMemoryBlock('故事发生在临安', [memory(), memory({ type: 'decision', content: '第三章再揭真相' })])
    expect(block).toContain('## 作者记忆')
    expect(block).toContain('工作背景：故事发生在临安')
    expect(block).toContain('- 偏好：喜欢短句')
    expect(block).toContain('- 决定：第三章再揭真相')
  })

  it('文案禁「检索」「联网」', () => {
    assertNoForbidden(buildMemoryBlock('背景', [memory(), memory({ content: '长记忆' })]))
  })

  it('MEMORY_MAX_CHARS 预算：超限先砍记忆条数，工作背景保住', () => {
    expect(MEMORY_MAX_CHARS).toBe(1200)
    const bg = '背景'.repeat(500) // 会被 clip 到 400
    const many = Array.from({ length: 20 }, (_, i) => memory({ id: `m${i}`, content: `记忆条目内容填充${i}`.repeat(8) }))
    const block = buildMemoryBlock(bg, many)
    expect(block.length).toBeLessThanOrEqual(MEMORY_MAX_CHARS + 50)
    // 背景行不是「- 」行，永远不被砍
    expect(block).toContain('工作背景：')
    // 部分记忆被砍，最终条数少于输入
    const lines = block.split('\n').filter((l) => l.startsWith('- '))
    expect(lines.length).toBeLessThan(many.length)
  })
})

describe('buildKbBlock · 知识库参考块', () => {
  it('空输入 → 空块', () => {
    expect(buildKbBlock([])).toBe('')
  })

  it('条目 → 带「## 知识库参考」头与《标题》[类型]（标签：…）', () => {
    const block = buildKbBlock([entry(), entry({ title: '临安城', type: 'setting', tags: ['地点', '古都'] })])
    expect(block).toContain('## 知识库参考')
    expect(block).toContain('《雨夜诀别》[人物]')
    expect(block).toContain('（标签：地点、古都）')
  })

  it('文案禁「检索」「联网」', () => {
    assertNoForbidden(buildKbBlock([entry(), entry({ content: '很长的内容'.repeat(20) })]))
  })
})

describe('buildDocBlock · 写作依据（文档锚点）块', () => {
  const content = '在临安城外断桥，雨下了整夜，灯一盏盏熄灭。'

  it('空输入 → 空块', () => {
    expect(buildDocBlock([])).toBe('')
  })

  it('精确锚点 → 带文档标题 + 段落标注，内容为 relocate 后的上下文', () => {
    const quote = '雨下了整夜'
    const idx = content.indexOf(quote)
    const block = buildDocBlock([{ docTitle: '大纲.md', content, anchor: anchor({ quote, startOffset: idx, endOffset: idx + quote.length }) }])
    expect(block).toContain('## 写作依据（文档锚点）')
    expect(block).toContain('《大纲.md》')
    expect(block).toContain('相关段落：')
    // 上下文包含真实正文片段（断桥/灯）
    expect(block).toMatch(/断桥|灯/)
  })

  it('锚点定位失败（none）→ 回落 quote 原文作为依据', () => {
    const block = buildDocBlock([
      { docTitle: '大纲.md', content, anchor: anchor({ quote: '这段在文档里不存在', startOffset: -1, endOffset: -1 }) }
    ])
    expect(block).toContain('《大纲.md》')
    expect(block).toContain('这段在文档里不存在')
  })

  it('文案禁「检索」「联网」', () => {
    assertNoForbidden(buildDocBlock([{ docTitle: 'd.md', content, anchor: anchor() }]))
  })
})

describe('三路块预算常量自洽', () => {
  it('MEMORY / KB / DOC 预算均为正整数', () => {
    expect(KB_MAX_CHARS).toBeGreaterThan(0)
    expect(DOC_MAX_CHARS).toBeGreaterThan(0)
    expect(MEMORY_MAX_CHARS).toBeGreaterThan(KB_MAX_CHARS)
  })
})
