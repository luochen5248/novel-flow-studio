/**
 * aiPrompt.spec.ts —— 测试 core/aiPrompt.ts 的纯逻辑层
 *
 * 覆盖（对照任务书 11 项）：
 *   1. buildAssistPrompt   提示词组装
 *      —— 重点回归：**continue / polish 任何参数组合都不得混入联网检索指令**
 *         （主进程曾出现过把 research 的检索提示词双拼进续写/润色 system 的 bug）
 *   2. applyInsertion      插入落点（replace/append + 反序 / 越界 / NaN / 非字符串边界）
 *   3. normalizeChatResponse / normalizeImageResponse   响应归一化与中文错误翻译
 *   4. normalizeBaseUrl / validateModelConfig / parseHeaderJson   配置校验与地址规整
 *   5. pickNeighbors       前后节点上下文（lane → order → id 排序）
 *   6. describeHttpStatus / describeTestResult / describeImageResult   中文文案
 *   7. AI_PROVIDER_PRESETS / findPreset   供应商预设数据
 */
import { describe, it, expect } from 'vitest'
import { createNode } from '@/core/model'
import type { ModelConfig } from '@/types/ai'
import type { AssistMode, AssistNeighbors, AssistNodeContext } from '@/core/aiPrompt'
import {
  AI_PROVIDER_PRESETS,
  DEFAULT_PRESET_KEY,
  RESEARCH_DISCLAIMER,
  applyInsertion,
  buildAssistPrompt,
  describeHttpStatus,
  describeImageResult,
  describeTestResult,
  findPreset,
  normalizeBaseUrl,
  normalizeChatResponse,
  normalizeImageResponse,
  parseHeaderJson,
  pickNeighbors,
  validateModelConfig
} from '@/core/aiPrompt'

/* ------------------------------------------------------------------ */
/* 公共 fixture                                                        */
/* ------------------------------------------------------------------ */

const NODE: AssistNodeContext = {
  title: '雨夜诀别',
  kind: 'event',
  chapter: '第七章',
  timeLabel: '景和三年 · 雨夜',
  location: '临安城外断桥',
  // 故意放一个空串人物：断言时顺带锁住 filter(Boolean) 行为
  characters: ['沈孤鸿', '', '阿蕊'],
  summary: '沈孤鸿与阿蕊在断桥诀别，剑与伞都留在了雨中。',
  content: '雨下了整夜，断桥上的灯一盏盏熄灭。'
}

const NEIGHBORS: AssistNeighbors = {
  prev: { title: '前节点甲', summary: '前节点甲摘要' },
  next: { title: '后节点乙', summary: '后节点乙摘要' }
}

/* ================================================================== */
/* 一、buildAssistPrompt · 提示词组装                                  */
/* ================================================================== */

describe('buildAssistPrompt · 提示词组装', () => {
  it('research + webSearch:true → system 含「先检索公开资料」指令', () => {
    const [system] = buildAssistPrompt(NODE, { mode: 'research', webSearch: true })
    expect(system.content).toContain('先检索公开资料')
  })

  it('research + webSearch:false → system 含「没有联网检索能力」说明', () => {
    const [system] = buildAssistPrompt(NODE, { mode: 'research', webSearch: false })
    expect(system.content).toContain('没有联网检索能力')
  })

  it('回归：continue / polish 在任何 webSearch 取值下都不出现联网检索指令', () => {
    for (const mode of ['continue', 'polish'] as const) {
      for (const webSearch of [true, false, undefined]) {
        const [system] = buildAssistPrompt(NODE, { mode, webSearch })
        expect(system.content).not.toContain('检索')
        expect(system.content).not.toContain('联网')
      }
    }
  })

  it('「来自模型知识，请注意核实」只出现在 research 的 system 中', () => {
    const [researchSystem] = buildAssistPrompt(NODE, { mode: 'research', webSearch: true })
    expect(researchSystem.content).toContain(RESEARCH_DISCLAIMER)
    for (const mode of ['continue', 'polish'] as const) {
      const [system] = buildAssistPrompt(NODE, { mode })
      expect(system.content).not.toContain(RESEARCH_DISCLAIMER)
    }
  })

  it('恒返回 [system, user] 两条消息', () => {
    for (const mode of ['research', 'continue', 'polish'] as const) {
      const msgs = buildAssistPrompt(NODE, { mode })
      expect(msgs).toHaveLength(2)
      expect(msgs.map((m) => m.role)).toEqual(['system', 'user'])
    }
  })

  it('user 含节点标题 / 摘要 / 人物 / 地点 / 时间Label（章节与类型同行给出）', () => {
    const [, user] = buildAssistPrompt(NODE, { mode: 'continue' })
    expect(user.content).toContain('标题：雨夜诀别')
    expect(user.content).toContain('摘要：沈孤鸿与阿蕊在断桥诀别')
    expect(user.content).toContain('出场人物：沈孤鸿、阿蕊')
    expect(user.content).toContain('地点：临安城外断桥')
    expect(user.content).toContain('故事内时间：景和三年 · 雨夜')
    expect(user.content).toContain('章节：第七章')
    expect(user.content).toContain('节点类型：event')
  })

  it('前后节点块按传入顺序出现（前节点块在前）', () => {
    const [, user] = buildAssistPrompt(NODE, { mode: 'continue', neighbors: NEIGHBORS })
    const prevAt = user.content.indexOf('## 前一个节点（已发生）')
    const nextAt = user.content.indexOf('## 后一个节点（后续走向）')
    expect(prevAt).toBeGreaterThan(-1)
    expect(nextAt).toBeGreaterThan(-1)
    expect(prevAt).toBeLessThan(nextAt)
    expect(user.content).toContain('标题：前节点甲')
    expect(user.content).toContain('摘要：前节点甲摘要')
    expect(user.content).toContain('标题：后节点乙')
  })

  it('只传 prev（next 缺 title）时只有前节点块', () => {
    const [, user] = buildAssistPrompt(NODE, {
      mode: 'continue',
      neighbors: { prev: { title: '前节点甲' }, next: { summary: '没有标题就不成块' } }
    })
    expect(user.content).toContain('## 前一个节点（已发生）')
    expect(user.content).not.toContain('## 后一个节点（后续走向）')
  })

  it('selection 非空时出现「光标选中的片段」块；纯空白视为未选', () => {
    const [, withSel] = buildAssistPrompt(NODE, { mode: 'polish', selection: '他握紧了伞。' })
    expect(withSel.content).toContain('## 光标选中的片段')
    expect(withSel.content).toContain('他握紧了伞。')
    const [, blank] = buildAssistPrompt(NODE, { mode: 'polish', selection: '   ' })
    expect(blank.content).not.toContain('## 光标选中的片段')
  })

  it('instruction 非空时追加「作者的额外要求」块；空白不出现', () => {
    const [, withIns] = buildAssistPrompt(NODE, { mode: 'polish', instruction: '语气再冷一些' })
    expect(withIns.content).toContain('## 作者的额外要求')
    expect(withIns.content).toContain('语气再冷一些')
    const [, blank] = buildAssistPrompt(NODE, { mode: 'polish', instruction: ' \n ' })
    expect(blank.content).not.toContain('## 作者的额外要求')
  })

  it('maxContextChars 截断正文：加「前文略」前缀且保留尾部', () => {
    const long = 'x'.repeat(249) + '尾'
    const [, user] = buildAssistPrompt({ ...NODE, content: long }, { mode: 'continue', maxContextChars: 200 })
    expect(user.content).toContain('……（前文略）')
    expect(user.content).toContain('尾')
    expect(user.content).not.toContain(long)
  })

  it('selection 超限时同样按 maxContextChars 截断', () => {
    const long = '选'.repeat(300)
    const [, user] = buildAssistPrompt(NODE, { mode: 'polish', selection: long, maxContextChars: 200 })
    expect(user.content).toContain('……（前文略）')
    expect(user.content).not.toContain(long)
  })

  it('maxContextChars 低于 200 时按 200 下限截断（不会把上下文削到 10 字）', () => {
    const long = 'x'.repeat(249) + '尾'
    const [, user] = buildAssistPrompt({ ...NODE, content: long }, { mode: 'continue', maxContextChars: 10 })
    expect(user.content).toContain('……（前文略）')
    expect(user.content).toContain(long.slice(-100))
  })

  it('正文未超限时原样出现，不加「前文略」', () => {
    const [, user] = buildAssistPrompt(NODE, { mode: 'continue' })
    expect(user.content).toContain(NODE.content!)
    expect(user.content).not.toContain('……（前文略）')
  })

  it('node 为空时跳过「当前节点」块，仍返回两条消息', () => {
    const [, user] = buildAssistPrompt(null, { mode: 'continue' })
    expect(user.content).not.toContain('## 当前节点')
    expect(user.content).toContain('请从「已有正文」末尾接着往下写。')
  })

  it('收尾句随 mode 与 selection 切换', () => {
    const userOf = (mode: AssistMode, selection?: string): string =>
      buildAssistPrompt(NODE, { mode, selection })[1].content
    expect(userOf('research')).toContain('请给出与上面这个节点直接相关的资料要点。')
    expect(userOf('continue')).toContain('请从「已有正文」末尾接着往下写。')
    expect(userOf('continue', '选中片段')).toContain('请从「光标选中的片段」末尾接着往下写。')
    expect(userOf('polish')).toContain('请改写这段正文。')
    expect(userOf('polish', '选中片段')).toContain('请改写「光标选中的片段」。')
  })
})

/* ================================================================== */
/* 二、applyInsertion · 插入落点计算                                   */
/* ================================================================== */

describe('applyInsertion · 插入落点计算', () => {
  it('replace：空选区 = 在光标处插入，caretPos = start + insertion.length', () => {
    expect(applyInsertion('甲乙丙', 1, 1, 'X', 'replace')).toEqual({ value: '甲X乙丙', caretPos: 2 })
  })

  it('replace：有选区 = 替换 [selStart, selEnd) 区间', () => {
    expect(applyInsertion('甲乙丙', 1, 2, 'XY', 'replace')).toEqual({ value: '甲XY丙', caretPos: 3 })
  })

  it('append：空文本直接得到 insertion，caretPos 在文末', () => {
    expect(applyInsertion('', 0, 0, '新段落', 'append')).toEqual({ value: '新段落', caretPos: 3 })
  })

  it('append：原文非空且不以换行结尾时补一个换行', () => {
    expect(applyInsertion('甲乙', 2, 2, '丙', 'append')).toEqual({ value: '甲乙\n丙', caretPos: 4 })
  })

  it('append：原文已以换行结尾时不补双换行', () => {
    expect(applyInsertion('甲乙\n', 3, 3, '丙', 'append')).toEqual({ value: '甲乙\n丙', caretPos: 4 })
  })

  it('selStart / selEnd 反序时自动纠正为升序', () => {
    expect(applyInsertion('甲乙丙', 3, 1, 'X', 'replace')).toEqual({ value: '甲X', caretPos: 2 })
  })

  it('越界值夹紧到 [0, length]（含负值）', () => {
    expect(applyInsertion('甲乙丙', 10, 20, 'X', 'replace')).toEqual({ value: '甲乙丙X', caretPos: 4 })
    expect(applyInsertion('甲乙丙', -5, -1, 'X', 'replace')).toEqual({ value: 'X甲乙丙', caretPos: 1 })
  })

  it('selStart / selEnd 为 NaN 时回落文末', () => {
    expect(applyInsertion('甲乙丙', NaN, NaN, 'X', 'replace')).toEqual({ value: '甲乙丙X', caretPos: 4 })
  })

  it('text 非字符串时不炸，按空文本处理', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(applyInsertion(bad as any, 0, 0, 'X', 'replace')).toEqual({ value: 'X', caretPos: 1 })
    }
  })

  it('mode 缺省时默认 replace', () => {
    expect(applyInsertion('甲乙丙', 1, 2, 'X')).toEqual({ value: '甲X丙', caretPos: 2 })
  })
})

/* ================================================================== */
/* 三、normalizeChatResponse · 聊天响应归一化                          */
/* ================================================================== */

describe('normalizeChatResponse · 聊天响应归一化', () => {
  it('choices[0].message.content 为字符串时取出文本', () => {
    const r = normalizeChatResponse({ choices: [{ message: { content: '你好，世界' } }] })
    expect(r.ok).toBe(true)
    expect(r.text).toBe('你好，世界')
  })

  it('content 为 [{type:"text",text}] 数组时拼接取出', () => {
    const r = normalizeChatResponse({
      choices: [{ message: { content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] } }]
    })
    expect(r.ok).toBe(true)
    expect(r.text).toBe('第一段第二段')
  })

  it('choices 缺失时回落到 output_text', () => {
    const r = normalizeChatResponse({ output_text: '兜底文本' })
    expect(r.ok).toBe(true)
    expect(r.text).toBe('兜底文本')
  })

  it('error 为字符串时原样报出', () => {
    expect(normalizeChatResponse({ error: '上游炸了' })).toEqual({ ok: false, error: '上游炸了' })
  })

  it('error 为 {message, code} 对象时 code 拼进文案', () => {
    expect(normalizeChatResponse({ error: { message: '额度不足', code: 'insufficient_quota' } })).toEqual({
      ok: false,
      error: '额度不足（insufficient_quota）'
    })
  })

  it('error 对象没有 message 时给通用兜底', () => {
    const r = normalizeChatResponse({ error: { code: 'weird' } })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('服务端返回了错误')
  })

  it('error 伴随 status 时优先翻译 HTTP 状态码', () => {
    expect(normalizeChatResponse({ error: { message: 'raw message' }, status: 429 })).toEqual({
      ok: false,
      error: '触发限流或余额不足（429），请稍后再试'
    })
  })

  it('choices 为空数组时判定失败', () => {
    expect(normalizeChatResponse({ choices: [] })).toEqual({ ok: false, error: '模型没有返回任何内容' })
  })

  it('text 全是空白时判定失败', () => {
    expect(normalizeChatResponse({ choices: [{ message: { content: '  \n\t ' } }] })).toEqual({
      ok: false,
      error: '模型没有返回任何内容'
    })
  })

  it('usage 的 token 数为数字时正常读出', () => {
    const r = normalizeChatResponse({
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 12, completion_tokens: 34 }
    })
    expect(r.usage).toEqual({ promptTokens: 12, completionTokens: 34 })
  })

  it('usage 的 token 数为字符串时转成数字', () => {
    const r = normalizeChatResponse({
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: '12', completion_tokens: '34' }
    })
    expect(r.usage).toEqual({ promptTokens: 12, completionTokens: 34 })
  })

  it('无 usage 对象时从 payload 顶层读 token 数', () => {
    const r = normalizeChatResponse({
      choices: [{ message: { content: 'hi' } }],
      prompt_tokens: 7,
      completion_tokens: 9
    })
    expect(r.usage).toEqual({ promptTokens: 7, completionTokens: 9 })
  })

  it('入参不是对象时返回空内容错误', () => {
    expect(normalizeChatResponse(null)).toEqual({ ok: false, error: '模型返回内容为空' })
    expect(normalizeChatResponse('oops')).toEqual({ ok: false, error: '模型返回内容为空' })
  })
})

/* ================================================================== */
/* 四、normalizeImageResponse · 生图响应归一化                         */
/* ================================================================== */

describe('normalizeImageResponse · 生图响应归一化', () => {
  it('data 里 url 与 b64_json 混合时按序取出，b64 转 data URL', () => {
    expect(normalizeImageResponse({ data: [{ url: 'https://a.com/1.png' }, { b64_json: 'QUJD' }] })).toEqual({
      ok: true,
      urls: ['https://a.com/1.png', 'data:image/png;base64,QUJD']
    })
  })

  it('同一项同时有 url 与 b64_json 时 url 优先', () => {
    const r = normalizeImageResponse({ data: [{ url: 'https://a.com/1.png', b64_json: 'QUJD' }] })
    expect(r.urls).toEqual(['https://a.com/1.png'])
  })

  it('data 为空数组 / 非数组时判定失败', () => {
    expect(normalizeImageResponse({ data: [] })).toEqual({ ok: false, error: '生图结果为空' })
    expect(normalizeImageResponse({ data: { url: 'x' } })).toEqual({ ok: false, error: '生图结果为空' })
  })

  it('data 里没有可用图片时判定失败（脏数据项跳过）', () => {
    expect(normalizeImageResponse({ data: [{ revised_prompt: 'x' }, null, 'oops'] })).toEqual({
      ok: false,
      error: '生图结果里没有可用图片'
    })
  })

  it('error 字符串原样透出', () => {
    expect(normalizeImageResponse({ error: '提示词被拒' })).toEqual({ ok: false, error: '提示词被拒' })
  })

  it('error 对象取 message', () => {
    expect(normalizeImageResponse({ error: { message: '余额不足' } })).toEqual({ ok: false, error: '余额不足' })
  })

  it('入参不是对象时返回空内容错误', () => {
    expect(normalizeImageResponse(undefined)).toEqual({ ok: false, error: '生图返回内容为空' })
  })
})

/* ================================================================== */
/* 五、normalizeBaseUrl · 接口地址规整                                */
/* ================================================================== */

describe('normalizeBaseUrl · 接口地址规整', () => {
  it('去掉首尾空白与结尾斜杠', () => {
    expect(normalizeBaseUrl('  https://x.com/v1/  ')).toBe('https://x.com/v1')
  })

  it('多个结尾斜杠一次去掉', () => {
    expect(normalizeBaseUrl('https://x.com/v1///')).toBe('https://x.com/v1')
  })

  it('路径中间的斜杠不受影响', () => {
    expect(normalizeBaseUrl('https://x.com/a/b')).toBe('https://x.com/a/b')
  })

  it('空串 / null / undefined 安全返回空串', () => {
    expect(normalizeBaseUrl('')).toBe('')
    expect(normalizeBaseUrl(null)).toBe('')
    expect(normalizeBaseUrl(undefined)).toBe('')
  })
})

/* ================================================================== */
/* 六、validateModelConfig · 模型配置校验                              */
/* ================================================================== */

describe('validateModelConfig · 模型配置校验', () => {
  const BASE: ModelConfig = {
    id: 'm1',
    name: '测试模型',
    type: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test-key',
    model: 'gpt-4o-mini',
    enabled: true,
    createdAt: 0
  }

  it('完整配置通过（openai 与 grsai 协议均放行）', () => {
    expect(validateModelConfig(BASE)).toEqual({ ok: true })
    expect(validateModelConfig({ ...BASE, protocol: 'grsai' })).toEqual({ ok: true })
  })

  it('name 为空或纯空白时报错字段为 name', () => {
    for (const name of ['', '   ']) {
      const r = validateModelConfig({ ...BASE, name })
      expect(r.ok).toBe(false)
      expect(r.field).toBe('name')
    }
  })

  it('type 缺失或非法时报错字段为 type', () => {
    expect(validateModelConfig({ ...BASE, type: undefined }).field).toBe('type')
    expect(validateModelConfig({ ...BASE, type: 'video' as any }).field).toBe('type')
  })

  it('protocol 非法时报错字段为 protocol', () => {
    expect(validateModelConfig({ ...BASE, protocol: undefined }).field).toBe('protocol')
    expect(validateModelConfig({ ...BASE, protocol: 'anthropic' as any }).field).toBe('protocol')
  })

  it('baseUrl 为空 / 纯空白 / 仅斜杠时报错字段为 baseUrl', () => {
    for (const baseUrl of [undefined, '', '   ', '///']) {
      expect(validateModelConfig({ ...BASE, baseUrl }).field).toBe('baseUrl')
    }
  })

  it('baseUrl 不以 http(s):// 开头被拒', () => {
    for (const baseUrl of ['ftp://x.com/v1', 'api.example.com/v1']) {
      const r = validateModelConfig({ ...BASE, baseUrl })
      expect(r.field).toBe('baseUrl')
      expect(r.message).toContain('http')
    }
  })

  it('model 为空或纯空白时报错字段为 model', () => {
    for (const model of ['', '  ']) {
      expect(validateModelConfig({ ...BASE, model }).field).toBe('model')
    }
  })

  it('requireKey 默认 true 时缺 apiKey 报错', () => {
    const r = validateModelConfig({ ...BASE, apiKey: '' })
    expect(r.ok).toBe(false)
    expect(r.field).toBe('apiKey')
  })

  it('builtin: true 时免填 apiKey 放行', () => {
    expect(validateModelConfig({ ...BASE, apiKey: '', builtin: true })).toEqual({ ok: true })
  })

  it('options.requireKey = false 时缺 apiKey 通过', () => {
    expect(validateModelConfig({ ...BASE, apiKey: '' }, { requireKey: false })).toEqual({ ok: true })
  })

  it('cfg 为 null 时报错字段为 name', () => {
    const r = validateModelConfig(null)
    expect(r.ok).toBe(false)
    expect(r.field).toBe('name')
  })
})

/* ================================================================== */
/* 七、parseHeaderJson · 自定义请求头解析                              */
/* ================================================================== */

describe('parseHeaderJson · 自定义请求头解析', () => {
  it('空文本返回 ok 且 headers 为 undefined', () => {
    for (const text of [undefined, null, '', '   ']) {
      expect(parseHeaderJson(text)).toEqual({ ok: true, headers: undefined })
    }
  })

  it('合法 JSON 对象解析出头表（数字值转字符串）', () => {
    expect(parseHeaderJson('{"X-Title":"NovelFlow","Retry":3}')).toEqual({
      ok: true,
      headers: { 'X-Title': 'NovelFlow', Retry: '3' }
    })
  })

  it('值为 null 的键被过滤', () => {
    expect(parseHeaderJson('{"Keep":"1","Drop":null}')).toEqual({ ok: true, headers: { Keep: '1' } })
  })

  it('非法 JSON 返回 ok:false', () => {
    const r = parseHeaderJson('{oops}')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('请求头不是合法 JSON')
  })

  it('JSON 数组返回 ok:false', () => {
    const r = parseHeaderJson('[{"a":"1"}]')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('JSON 对象')
  })

  it('非对象 JSON（字符串 / 数字 / 布尔 / null 字面量）返回 ok:false', () => {
    for (const text of ['"str"', '123', 'true', 'null']) {
      expect(parseHeaderJson(text).ok).toBe(false)
    }
  })
})

/* ================================================================== */
/* 八、pickNeighbors · 前后节点上下文                                  */
/* ================================================================== */

describe('pickNeighbors · 前后节点上下文', () => {
  const nodes = [
    createNode({ id: 'a', title: '节点甲', summary: '甲摘要', lane: 0, order: 0 }),
    createNode({ id: 'b', title: '节点乙', summary: '乙摘要', lane: 0, order: 1 }),
    createNode({ id: 'c', title: '节点丙', summary: '丙摘要', lane: 0, order: 2 })
  ]

  it('中间节点取前后各一，且只带 title/summary', () => {
    expect(pickNeighbors(nodes, 'b')).toEqual({
      prev: { title: '节点甲', summary: '甲摘要' },
      next: { title: '节点丙', summary: '丙摘要' }
    })
  })

  it('目标在首位时只有 next', () => {
    const r = pickNeighbors(nodes, 'a')
    expect(r.prev).toBeUndefined()
    expect(r.next).toEqual({ title: '节点乙', summary: '乙摘要' })
  })

  it('目标在末位时只有 prev', () => {
    const r = pickNeighbors(nodes, 'c')
    expect(r.prev).toEqual({ title: '节点乙', summary: '乙摘要' })
    expect(r.next).toBeUndefined()
  })

  it('找不到目标返回空对象', () => {
    expect(pickNeighbors(nodes, 'zzz')).toEqual({})
  })

  it('按 lane → order 排序后取邻居（与传入顺序无关）', () => {
    const messy = [
      createNode({ id: 'branch', title: '支线节点', summary: '支线摘要', lane: 1, order: 0 }),
      createNode({ id: 'b2', title: '节点乙', summary: '乙摘要', lane: 0, order: 1 }),
      createNode({ id: 'a2', title: '节点甲', summary: '甲摘要', lane: 0, order: 0 })
    ]
    expect(pickNeighbors(messy, 'b2')).toEqual({
      prev: { title: '节点甲', summary: '甲摘要' },
      next: { title: '支线节点', summary: '支线摘要' }
    })
  })

  it('lane / order 全同时按 id 升序排', () => {
    const tie = [
      createNode({ id: 'm', title: '阿M', summary: '', lane: 0, order: 5 }),
      createNode({ id: 'k', title: '阿K', summary: '', lane: 0, order: 5 }),
      createNode({ id: 't', title: '目标点', summary: '', lane: 0, order: 5 })
    ]
    expect(pickNeighbors(tie, 't').prev).toEqual({ title: '阿M', summary: '' })
  })
})

/* ================================================================== */
/* 九、describeHttpStatus · HTTP 状态码中文文案                        */
/* ================================================================== */

describe('describeHttpStatus · HTTP 状态码中文文案', () => {
  it('已知状态码返回固定中文文案', () => {
    const table: Array<[number, string]> = [
      [400, '请求被拒绝（400）：模型名或参数不被接受'],
      [401, 'API Key 无效或缺失（401）'],
      [404, '接口地址或模型不存在（404）'],
      [429, '触发限流或余额不足（429），请稍后再试'],
      [503, '服务暂时不可用（503）']
    ]
    for (const [status, expected] of table) {
      expect(describeHttpStatus(status)).toBe(expected)
    }
  })

  it('未知状态码兜底为「请求失败（HTTP xxx）」', () => {
    expect(describeHttpStatus(418)).toBe('请求失败（HTTP 418）')
  })

  it('undefined / null 兜底为「请求失败」', () => {
    expect(describeHttpStatus(undefined)).toBe('请求失败')
    expect(describeHttpStatus(null)).toBe('请求失败')
  })
})

/* ================================================================== */
/* 十、describeTestResult / describeImageResult · 结果中文描述         */
/* ================================================================== */

describe('describeTestResult / describeImageResult · 结果中文描述', () => {
  it('测试连接成功时带延迟毫秒数', () => {
    expect(describeTestResult({ ok: true, latencyMs: 123 })).toBe('连接正常 · 123ms')
  })

  it('测试连接成功但无延迟数据时显示「已连通」', () => {
    expect(describeTestResult({ ok: true })).toBe('连接正常 · 已连通')
  })

  it('测试连接失败优先展示 error，无 error 时给通用文案', () => {
    expect(describeTestResult({ ok: false, error: '401 未授权' })).toBe('401 未授权')
    expect(describeTestResult({ ok: false })).toBe('连接失败')
  })

  it('生图成功返回空串（无需提示）', () => {
    expect(describeImageResult({ ok: true })).toBe('')
  })

  it('生图失败优先展示 error，无 error 时给通用文案', () => {
    expect(describeImageResult({ ok: false, error: '生图超时' })).toBe('生图超时')
    expect(describeImageResult({ ok: false })).toBe('生图失败，请检查模型配置')
  })
})

/* ================================================================== */
/* 十一、AI_PROVIDER_PRESETS / findPreset · 供应商预设                 */
/* ================================================================== */

describe('AI_PROVIDER_PRESETS / findPreset · 供应商预设', () => {
  it('默认指向 openai，findPreset 按 key 命中 / miss', () => {
    expect(DEFAULT_PRESET_KEY).toBe('openai')
    expect(findPreset('openai')?.baseUrl).toBe('https://api.openai.com/v1')
    expect(findPreset('grsai')?.protocol).toBe('grsai')
    expect(findPreset('no-such-provider')).toBeUndefined()
  })

  it('预设 key 唯一且都带 label', () => {
    const keys = AI_PROVIDER_PRESETS.map((p) => p.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(AI_PROVIDER_PRESETS.every((p) => p.label.length > 0)).toBe(true)
  })
})
