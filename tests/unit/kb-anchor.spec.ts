/**
 * kb-anchor.spec.ts —— 文档锚点模糊重定位（src/core/kb/anchor.ts）
 *
 * 覆盖（调查报告 Q12 清单逐条）：精确命中 / quote 改一字（Dice 模糊救回）/
 * quote 前插入文本致 offset 失效（模糊救回）/ hint 过期错位（回落 hint）/
 * quote 跨段落 / 空 quote / quote 长于 content / \r\n 混排归一化 /
 * 置信度分级 exact·fuzzy·hint·none / sliceAround 半径边界。
 * 另含 diceCoefficient 直接断言。
 */
import { describe, it, expect } from 'vitest'
import { relocateAnchor, diceCoefficient, sliceAround, type AnchorHint } from '@/core/kb/anchor'

describe('relocateAnchor · 五级短路', () => {
  it('精确命中：quote 原样存在 → exact，score=1', () => {
    const content = '剑与伞都留在了雨中，从此再无相见。'
    const quote = '剑与伞都留在了雨中'
    const r = relocateAnchor(content, quote)
    expect(r.confidence).toBe('exact')
    expect(r.score).toBe(1)
    expect(r.start).toBe(content.indexOf(quote))
    expect(r.end).toBe(content.indexOf(quote) + quote.length)
  })

  it('quote 被改一字：借 hint 窗口 Dice 模糊救回 → fuzzy', () => {
    const content = '在临安城外断桥，雨夜的临安城外，灯一盏盏熄灭。'
    const trueQuote = '雨夜的临安城外' // 8 字
    const changed = '雨夜的临安城边' // 末字「外」→「边」
    const hint: AnchorHint = { startOffset: content.indexOf(trueQuote), endOffset: content.indexOf(trueQuote) + trueQuote.length }
    const r = relocateAnchor(content, changed, hint)
    expect(r.confidence).toBe('fuzzy')
    expect(r.score).toBeGreaterThanOrEqual(0.55)
  })

  it('quote 前插入文本致 offset 失效（hint 指向旧偏移）+ 改一字 → 模糊救回', () => {
    const base = '断桥上的灯一盏盏熄灭，雨落满城。'
    const trueQuote = '断桥上的灯一盏盏' // 8 字
    const changed = '断桥上的灯一盖盖' // 「盏盏」→「盖盖」
    const content = '在很久很久以前，' + base // 在 quote 前插入文本
    const staleHint: AnchorHint = { startOffset: base.indexOf(trueQuote), endOffset: base.indexOf(trueQuote) + trueQuote.length }
    const r = relocateAnchor(content, changed, staleHint)
    expect(r.confidence).toBe('fuzzy')
    expect(r.score).toBeGreaterThanOrEqual(0.55)
  })

  it('hint 过期错位（quote 完全不在此处）→ 回落 hint，score=0.3', () => {
    const content = '正文很长的一段文字用于测试回落逻辑，这里没有任何异常，作者又补写了一段更长的补充说明文字让正文超过引用长度。'
    const strayQuote = '这是一段完全不相关的外部引用文本用于触发hint回落分支'
    const hint: AnchorHint = { startOffset: 0, endOffset: 5 }
    const r = relocateAnchor(content, strayQuote, hint)
    expect(r.confidence).toBe('hint')
    expect(r.score).toBe(0.3)
    expect(r.start).toBe(0)
    expect(r.end).toBe(5)
  })

  it('quote 跨段落（含空行）仍精确命中', () => {
    const content = '第一段文字。\n\n断桥上的灯一盏盏熄灭。\n\n第三段。'
    const quote = '灯一盏盏熄灭。\n\n第三段'
    const r = relocateAnchor(content, quote)
    expect(r.confidence).toBe('exact')
    expect(r.start).toBe(content.indexOf(quote))
  })

  it('空 quote → none，score=0', () => {
    const r = relocateAnchor('任意正文', '')
    expect(r.confidence).toBe('none')
    expect(r.score).toBe(0)
    expect(r.start).toBe(0)
    expect(r.end).toBe(0)
  })

  it('quote 长于 content → none', () => {
    const r = relocateAnchor('短', '这是一个很长的引用它比正文还长')
    expect(r.confidence).toBe('none')
    expect(r.score).toBe(0)
  })

  it('\\r\\n 混排归一化：存储内容按 \\n 归一后精确命中', () => {
    const content = 'a\r\nb\r\nc'
    const r = relocateAnchor(content, 'b')
    expect(r.confidence).toBe('exact')
    expect(r.start).toBe(2) // 归一后 'a\nb\nc' 中 b 的偏移
  })

  it('置信度 none：quote 不存在且无 hint', () => {
    const r = relocateAnchor('正文里没有这段', 'zzz')
    expect(r.confidence).toBe('none')
  })
})

describe('diceCoefficient · bigram Dice 系数', () => {
  it('相同串 → 1', () => {
    expect(diceCoefficient('雨夜的桥', '雨夜的桥')).toBe(1)
    expect(diceCoefficient('ab', 'ab')).toBe(1)
  })

  it('单字 / 空串 → 0', () => {
    expect(diceCoefficient('a', 'b')).toBe(0)
    expect(diceCoefficient('', '')).toBe(0)
  })

  it('改一字相似度下降但不为 0', () => {
    const d = diceCoefficient('abc', 'abd')
    expect(d).toBeGreaterThan(0)
    expect(d).toBeLessThan(1)
  })
})

describe('sliceAround · 上下文窗口', () => {
  const text = '0123456789' // 长度 10

  it('中段：前后都加省略号', () => {
    expect(sliceAround(text, 2, 4, 3)).toBe('0123456……')
  })

  it('靠近开头：无前缀省略号，有后缀省略号', () => {
    expect(sliceAround(text, 0, 2, 3)).toBe('01234……')
  })

  it('靠近结尾：有前缀省略号，无后缀省略号', () => {
    expect(sliceAround(text, 8, 10, 3)).toBe('……56789')
  })

  it('半径足够大时整段返回、无省略号', () => {
    expect(sliceAround(text, 2, 4, 100)).toBe('0123456789')
  })

  it('半径边界：start/end 越界被 clamp', () => {
    expect(sliceAround(text, 0, 1, 0)).toBe('0……')
    expect(sliceAround(text, 8, 10, 0)).toBe('……89')
    // 超大 start 被 clamp 到末尾，只剩前缀省略号
    expect(sliceAround(text, 50, 60, 2)).toBe('……')
  })

  it('\\r\\n 内容归一后再切片（含省略号）', () => {
    const r = sliceAround('x\r\n雨夜\r\nz', 2, 4, 1)
    expect(r).toContain('雨夜')
    expect(r.startsWith('……')).toBe(true)
    expect(r.endsWith('……')).toBe(true)
  })
})
