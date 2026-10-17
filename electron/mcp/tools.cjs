/**
 * NovelFlow MCP · 工具注册表
 *
 * 26 个工具全部是 window.NovelFlow.*（src/api/aiApi.ts）的薄壳：
 * 本文件只做「参数校验 + 方法映射」，不碰业务；执行在 server.cjs /
 * control-server.cjs / 渲染层完成。
 *
 * 纪律：
 *  - 返回值不可 JSON 序列化或有 UI 副作用的方法（exportPNG / download /
 *    subscribe）禁止经逃生门触达，防止污染协议通道；
 *  - 改 src/api/aiApi.ts 的 api 对象时，同步下面的 NOVELFLOW_METHODS。
 */
'use strict'

/** NovelFlow 方法白名单（与 aiApi.ts 的 api 对象一一对应） */
const NOVELFLOW_METHODS = [
  'ready', 'getState', 'listFlows', 'addFlow', 'openFlow', 'removeFlow', 'renameFlow',
  'addNode', 'addNodes', 'addEdge', 'removeEdge', 'updateEdge',
  'addNote', 'addCharacter', 'addTag', 'updateNode', 'removeNode', 'setChapter', 'setStatus', 'setNodeImage',
  'layout', 'setSettings',
  'exportPNG', 'exportSVG', 'exportJSON', 'exportMermaid', 'exportDrawio', 'exportMarkdown', 'download',
  'undo', 'redo', 'reset', 'batch', 'subscribe', 'help'
]

/** 返回 Blob / 触发下载 / 返回函数：JSON 通道运不了，一律拒绝 */
const NON_SERIALIZABLE_METHODS = ['exportPNG', 'download', 'subscribe']

const NODE_KINDS = ['event', 'scene', 'decision', 'character', 'milestone', 'note']
const EDGE_KINDS = ['flow', 'branch', 'flashback', 'jump']
const NODE_STATUSES = ['planned', 'drafted', 'done']
const PORT_SIDES = ['top', 'bottom', 'left', 'right']
const EXPORT_FORMATS = ['markdown', 'mermaid', 'json', 'svg', 'drawio']

/** 批量上限：防 AI 一次塞爆协议通道 */
const MAX_NODES_PER_CALL = 100
const MAX_BATCH_COMMANDS = 50

/* ------------------------------------------------------------------ */
/* 迷你校验器（不引依赖；每个工具一个 parse，返回归一化调用描述）            */
/* ------------------------------------------------------------------ */

function fail(error) {
  return { ok: false, error }
}

function pickString(params, key, { required = false, oneOf = null, max = 500 } = {}) {
  const value = params?.[key]
  if (value === undefined || value === null || value === '') {
    return required ? fail(`参数「${key}」不能为空`) : { ok: true, value: undefined }
  }
  if (typeof value !== 'string') return fail(`参数「${key}」必须是字符串`)
  if (value.length > max) return fail(`参数「${key}」过长（上限 ${max} 字符）`)
  if (oneOf && !oneOf.includes(value)) return fail(`参数「${key}」只能是：${oneOf.join(' / ')}`)
  return { ok: true, value }
}

function pickStringArray(params, key, { required = false, max = 50 } = {}) {
  const value = params?.[key]
  if (value === undefined || value === null) {
    return required ? fail(`参数「${key}」不能为空`) : { ok: true, value: undefined }
  }
  if (!Array.isArray(value)) return fail(`参数「${key}」必须是字符串数组`)
  if (value.some((item) => typeof item !== 'string')) return fail(`参数「${key}」必须全部是字符串`)
  if (value.length > max) return fail(`参数「${key}」元素过多（上限 ${max} 个）`)
  return { ok: true, value }
}

function pickObject(params, key, { required = false } = {}) {
  const value = params?.[key]
  if (value === undefined || value === null) {
    return required ? fail(`参数「${key}」不能为空`) : { ok: true, value: undefined }
  }
  if (typeof value !== 'object' || Array.isArray(value)) return fail(`参数「${key}」必须是对象`)
  return { ok: true, value }
}

function pickNumber(params, key, { min = -1000, max = 1000 } = {}) {
  const value = params?.[key]
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail(`参数「${key}」必须是数字`)
  if (value < min || value > max) return fail(`参数「${key}」超出范围（${min} ~ ${max}）`)
  return { ok: true, value }
}

function pickBoolean(params, key) {
  const value = params?.[key]
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (typeof value !== 'boolean') return fail(`参数「${key}」必须是布尔值`)
  return { ok: true, value }
}

/** 把校验通过的字段收成干净对象（只收已知键，undefined 不落键）；
 *  任一字段校验失败立即整体返回该失败（绝不静默吞掉） */
function collect(entries) {
  const out = {}
  for (const [key, checked] of entries) {
    if (!checked.ok) return checked
    if (checked.value !== undefined) out[key] = checked.value
  }
  return { ok: true, value: out }
}

/* ------------------------------------------------------------------ */
/* JSON Schema（给 MCP 客户端里的 AI 看的参数说明）                        */
/* ------------------------------------------------------------------ */

function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

function enumOf(values, description) {
  return { type: 'string', enum: values, description }
}

function stringArray(description) {
  return { type: 'array', items: { type: 'string' }, description }
}

/** addNode 的入参校验（add_node 与 add_nodes 的数组项共用） */
function parseNodeInput(params) {
  const title = pickString(params, 'title', { required: true, max: 200 })
  if (!title.ok) return title
  const collected = collect([
    ['title', title],
    ['summary', pickString(params, 'summary', { max: 500 })],
    ['kind', pickString(params, 'kind', { oneOf: NODE_KINDS })],
    ['afterId', pickString(params, 'afterId', { max: 100 })],
    ['branchOf', pickString(params, 'branchOf', { max: 100 })],
    ['timeLabel', pickString(params, 'timeLabel', { max: 200 })],
    ['content', pickString(params, 'content', { max: 20000 })],
    ['characters', pickStringArray(params, 'characters')],
    ['tags', pickStringArray(params, 'tags')],
    ['location', pickString(params, 'location', { max: 200 })],
    ['chapter', pickString(params, 'chapter', { max: 100 })],
    ['status', pickString(params, 'status', { oneOf: NODE_STATUSES })],
    ['lane', pickNumber(params, 'lane', { min: -100, max: 1000 })],
    ['note', pickString(params, 'note', { max: 5000 })],
    ['color', pickString(params, 'color', { max: 50 })]
  ])
  if (!collected.ok) return collected
  return { ok: true, value: collected.value }
}

const NODE_INPUT_SCHEMA = schema({
  title: { type: 'string', description: '节点标题（必填）' },
  summary: { type: 'string', description: '卡片上的简短描述' },
  kind: enumOf(NODE_KINDS, '节点类型，缺省 event'),
  afterId: { type: 'string', description: '插到该节点之后（自动连线 + 自动让位）' },
  branchOf: { type: 'string', description: '作为该节点的横向分支' },
  timeLabel: { type: 'string', description: '故事内时间，如「第一章 · 雨夜」' },
  content: { type: 'string', description: '完整故事正文' },
  characters: stringArray('涉及人物'),
  tags: stringArray('标签'),
  location: { type: 'string', description: '地点' },
  chapter: { type: 'string', description: '章节' },
  status: enumOf(NODE_STATUSES, '写作状态'),
  lane: { type: 'number', description: '分支列：0 = 主线，±1 / ±2 为分支；不传由布局决定' },
  note: { type: 'string', description: '备注' },
  color: { type: 'string', description: '卡片主色（token 名或 hex）' }
}, ['title'])

const EDGE_OPTIONS_SCHEMA = schema({
  label: { type: 'string', description: '连线文字' },
  kind: enumOf(EDGE_KINDS, '连线类型，缺省 flow'),
  dashed: { type: 'boolean', description: '是否虚线' },
  sourceHandle: enumOf(PORT_SIDES, '起端锚点，缺省按 kind 规则推断'),
  targetHandle: enumOf(PORT_SIDES, '末端锚点，同上')
})

/* ------------------------------------------------------------------ */
/* 工具注册表                                                           */
/* ------------------------------------------------------------------ */

const TOOLS = [
  {
    name: 'novelflow_wake',
    description: '唤醒「小说时间线工坊」：未运行则启动，已运行则聚焦窗口',
    inputSchema: schema({}),
    parse: () => ({ ok: true, kind: 'special', action: 'wake' })
  },
  {
    name: 'novelflow_status',
    description: '查看主程序运行状态与故事线概览（不唤醒软件）',
    inputSchema: schema({}),
    parse: () => ({ ok: true, kind: 'special', action: 'status' })
  },
  {
    name: 'novelflow_help',
    description: '返回 NovelFlow 可编程 API 的帮助清单（方法签名与说明）',
    inputSchema: schema({}),
    parse: () => ({ ok: true, kind: 'method', method: 'help', args: [] })
  },
  {
    name: 'novelflow_list_flows',
    description: '列出全部故事线（id / 名称 / 节点数 / 连线数）',
    inputSchema: schema({}),
    parse: () => ({ ok: true, kind: 'method', method: 'listFlows', args: [] })
  },
  {
    name: 'novelflow_add_flow',
    description: '新建一条故事线并切换过去',
    inputSchema: schema({ name: { type: 'string', description: '故事线名称' } }, ['name']),
    parse: (params) => {
      const name = pickString(params, 'name', { required: true, max: 100 })
      if (!name.ok) return name
      return { ok: true, kind: 'method', method: 'addFlow', args: [name.value] }
    }
  },
  {
    name: 'novelflow_open_flow',
    description: '按 id 或名称打开某条故事线',
    inputSchema: schema({ idOrName: { type: 'string', description: '故事线 id 或名称' } }, ['idOrName']),
    parse: (params) => {
      const idOrName = pickString(params, 'idOrName', { required: true, max: 200 })
      if (!idOrName.ok) return idOrName
      return { ok: true, kind: 'method', method: 'openFlow', args: [idOrName.value] }
    }
  },
  {
    name: 'novelflow_remove_flow',
    description: '删除指定的故事线',
    inputSchema: schema({ id: { type: 'string', description: '故事线 id' } }, ['id']),
    parse: (params) => {
      const id = pickString(params, 'id', { required: true, max: 100 })
      if (!id.ok) return id
      return { ok: true, kind: 'method', method: 'removeFlow', args: [id.value] }
    }
  },
  {
    name: 'novelflow_rename_flow',
    description: '重命名当前故事线',
    inputSchema: schema({ name: { type: 'string', description: '新名称' } }, ['name']),
    parse: (params) => {
      const name = pickString(params, 'name', { required: true, max: 100 })
      if (!name.ok) return name
      return { ok: true, kind: 'method', method: 'renameFlow', args: [name.value] }
    }
  },
  {
    name: 'novelflow_get_state',
    description: '返回当前故事线的完整数据深拷贝（nodes / edges / settings）',
    inputSchema: schema({}),
    parse: () => ({ ok: true, kind: 'method', method: 'getState', args: [] })
  },
  {
    name: 'novelflow_add_node',
    description: '新增节点：给 afterId 插到其后并连线；给 branchOf 拉横向分支；都不给则追加到主线末尾。人物卡（kind:"character"）不支持 afterId/branchOf，自动落人物保留道',
    inputSchema: NODE_INPUT_SCHEMA,
    parse: (params) => {
      const input = parseNodeInput(params)
      if (!input.ok) return input
      return { ok: true, kind: 'method', method: 'addNode', args: [input.value] }
    }
  },
  {
    name: 'novelflow_add_nodes',
    description: '批量新增节点，按数组顺序自动串联成一条链；人物卡不参与链',
    inputSchema: schema(
      { nodes: { type: 'array', items: NODE_INPUT_SCHEMA, description: `节点数组（1 ~ ${MAX_NODES_PER_CALL} 个）` } },
      ['nodes']
    ),
    parse: (params) => {
      const list = params?.nodes
      if (!Array.isArray(list) || list.length === 0) return fail('参数「nodes」必须是非空数组')
      if (list.length > MAX_NODES_PER_CALL) return fail(`参数「nodes」一次最多 ${MAX_NODES_PER_CALL} 个`)
      const out = []
      for (let i = 0; i < list.length; i++) {
        const item = parseNodeInput(list[i])
        if (!item.ok) return fail(`第 ${i + 1} 个节点：${item.error}`)
        out.push(item.value)
      }
      return { ok: true, kind: 'method', method: 'addNodes', args: [out] }
    }
  },
  {
    name: 'novelflow_update_node',
    description: '更新节点任意字段（id 不可改）；改 lane/order 会自动重排',
    inputSchema: schema(
      {
        id: { type: 'string', description: '节点 id' },
        patch: { type: 'object', description: '要修改的字段（Partial<StoryNode>）' }
      },
      ['id', 'patch']
    ),
    parse: (params) => {
      const id = pickString(params, 'id', { required: true, max: 100 })
      if (!id.ok) return id
      const patch = pickObject(params, 'patch', { required: true })
      if (!patch.ok) return patch
      return { ok: true, kind: 'method', method: 'updateNode', args: [id.value, patch.value] }
    }
  },
  {
    name: 'novelflow_remove_node',
    description: '删除节点，并连带删除挂在它上面的连线',
    inputSchema: schema({ id: { type: 'string', description: '节点 id' } }, ['id']),
    parse: (params) => {
      const id = pickString(params, 'id', { required: true, max: 100 })
      if (!id.ok) return id
      return { ok: true, kind: 'method', method: 'removeNode', args: [id.value] }
    }
  },
  {
    name: 'novelflow_add_edge',
    description: '新增连线（source → target）',
    inputSchema: schema(
      {
        sourceId: { type: 'string', description: '起点节点 id' },
        targetId: { type: 'string', description: '终点节点 id' },
        options: EDGE_OPTIONS_SCHEMA
      },
      ['sourceId', 'targetId']
    ),
    parse: (params) => {
      const sourceId = pickString(params, 'sourceId', { required: true, max: 100 })
      if (!sourceId.ok) return sourceId
      const targetId = pickString(params, 'targetId', { required: true, max: 100 })
      if (!targetId.ok) return targetId
      const collected = collect([
        ['label', pickString(params.options, 'label', { max: 200 })],
        ['kind', pickString(params.options, 'kind', { oneOf: EDGE_KINDS })],
        ['dashed', pickBoolean(params.options, 'dashed')],
        ['sourceHandle', pickString(params.options, 'sourceHandle', { oneOf: PORT_SIDES })],
        ['targetHandle', pickString(params.options, 'targetHandle', { oneOf: PORT_SIDES })]
      ])
      if (!collected.ok) return collected
      return { ok: true, kind: 'method', method: 'addEdge', args: [sourceId.value, targetId.value, collected.value] }
    }
  },
  {
    name: 'novelflow_remove_edge',
    description: '删除指定连线',
    inputSchema: schema({ id: { type: 'string', description: '连线 id' } }, ['id']),
    parse: (params) => {
      const id = pickString(params, 'id', { required: true, max: 100 })
      if (!id.ok) return id
      return { ok: true, kind: 'method', method: 'removeEdge', args: [id.value] }
    }
  },
  {
    name: 'novelflow_update_edge',
    description: '修改连线的 label / kind / dashed / 锚点（不可改 id 与端点）',
    inputSchema: schema(
      {
        id: { type: 'string', description: '连线 id' },
        patch: { type: 'object', description: '要修改的字段（Partial<StoryEdge>）' }
      },
      ['id', 'patch']
    ),
    parse: (params) => {
      const id = pickString(params, 'id', { required: true, max: 100 })
      if (!id.ok) return id
      const patch = pickObject(params, 'patch', { required: true })
      if (!patch.ok) return patch
      return { ok: true, kind: 'method', method: 'updateEdge', args: [id.value, patch.value] }
    }
  },
  {
    name: 'novelflow_add_note',
    description: '给节点追加备注（多次调用换行拼接，不覆盖）',
    inputSchema: schema(
      { nodeId: { type: 'string', description: '节点 id' }, text: { type: 'string', description: '备注内容' } },
      ['nodeId', 'text']
    ),
    parse: (params) => {
      const nodeId = pickString(params, 'nodeId', { required: true, max: 100 })
      if (!nodeId.ok) return nodeId
      const text = pickString(params, 'text', { required: true, max: 5000 })
      if (!text.ok) return text
      return { ok: true, kind: 'method', method: 'addNote', args: [nodeId.value, text.value] }
    }
  },
  {
    name: 'novelflow_add_character',
    description: '给节点追加人物（自动去重）',
    inputSchema: schema(
      { nodeId: { type: 'string', description: '节点 id' }, name: { type: 'string', description: '人物名' } },
      ['nodeId', 'name']
    ),
    parse: (params) => {
      const nodeId = pickString(params, 'nodeId', { required: true, max: 100 })
      if (!nodeId.ok) return nodeId
      const name = pickString(params, 'name', { required: true, max: 100 })
      if (!name.ok) return name
      return { ok: true, kind: 'method', method: 'addCharacter', args: [nodeId.value, name.value] }
    }
  },
  {
    name: 'novelflow_add_tag',
    description: '给节点追加标签（自动去重）',
    inputSchema: schema(
      { nodeId: { type: 'string', description: '节点 id' }, tag: { type: 'string', description: '标签' } },
      ['nodeId', 'tag']
    ),
    parse: (params) => {
      const nodeId = pickString(params, 'nodeId', { required: true, max: 100 })
      if (!nodeId.ok) return nodeId
      const tag = pickString(params, 'tag', { required: true, max: 50 })
      if (!tag.ok) return tag
      return { ok: true, kind: 'method', method: 'addTag', args: [nodeId.value, tag.value] }
    }
  },
  {
    name: 'novelflow_set_status',
    description: '设置节点写作状态',
    inputSchema: schema(
      { nodeId: { type: 'string', description: '节点 id' }, status: enumOf(NODE_STATUSES, '写作状态') },
      ['nodeId', 'status']
    ),
    parse: (params) => {
      const nodeId = pickString(params, 'nodeId', { required: true, max: 100 })
      if (!nodeId.ok) return nodeId
      const status = pickString(params, 'status', { required: true, oneOf: NODE_STATUSES })
      if (!status.ok) return status
      return { ok: true, kind: 'method', method: 'setStatus', args: [nodeId.value, status.value] }
    }
  },
  {
    name: 'novelflow_set_chapter',
    description: '设置节点章节',
    inputSchema: schema(
      { nodeId: { type: 'string', description: '节点 id' }, chapter: { type: 'string', description: '章节' } },
      ['nodeId', 'chapter']
    ),
    parse: (params) => {
      const nodeId = pickString(params, 'nodeId', { required: true, max: 100 })
      if (!nodeId.ok) return nodeId
      const chapter = pickString(params, 'chapter', { required: true, max: 100 })
      if (!chapter.ok) return chapter
      return { ok: true, kind: 'method', method: 'setChapter', args: [nodeId.value, chapter.value] }
    }
  },
  {
    name: 'novelflow_batch',
    description: '顺序执行多条 NovelFlow 命令，单条失败不中断，收集全部结果',
    inputSchema: schema(
      {
        commands: {
          type: 'array',
          description: `命令数组，每项为 [方法名, ...参数]（1 ~ ${MAX_BATCH_COMMANDS} 条）`,
          items: { type: 'array' }
        }
      },
      ['commands']
    ),
    parse: (params) => {
      const commands = params?.commands
      if (!Array.isArray(commands) || commands.length === 0) return fail('参数「commands」必须是非空数组')
      if (commands.length > MAX_BATCH_COMMANDS) return fail(`参数「commands」一次最多 ${MAX_BATCH_COMMANDS} 条`)
      for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i]
        if (!Array.isArray(cmd) || cmd.length === 0) return fail(`第 ${i + 1} 条命令必须是 [方法名, ...参数] 形式的数组`)
        const name = cmd[0]
        if (typeof name !== 'string' || !NOVELFLOW_METHODS.includes(name)) {
          return fail(`第 ${i + 1} 条命令的方法名「${String(name)}」不在 NovelFlow 白名单内`)
        }
        if (NON_SERIALIZABLE_METHODS.includes(name)) {
          return fail(`第 ${i + 1} 条命令的「${name}」返回值不可序列化，禁止经 MCP 调用`)
        }
      }
      return { ok: true, kind: 'method', method: 'batch', args: [commands] }
    }
  },
  {
    name: 'novelflow_undo',
    description: '撤销一步（优先 store 历史，否则 API 自带栈）',
    inputSchema: schema({}),
    parse: () => ({ ok: true, kind: 'method', method: 'undo', args: [] })
  },
  {
    name: 'novelflow_redo',
    description: '重做一步',
    inputSchema: schema({}),
    parse: () => ({ ok: true, kind: 'method', method: 'redo', args: [] })
  },
  {
    name: 'novelflow_export',
    description: '导出当前故事线为文本（markdown / mermaid / json / svg / drawio）',
    inputSchema: schema({ format: enumOf(EXPORT_FORMATS, '导出格式') }, ['format']),
    parse: (params) => {
      const format = pickString(params, 'format', { required: true, oneOf: EXPORT_FORMATS })
      if (!format.ok) return format
      const methodByFormat = {
        markdown: 'exportMarkdown',
        mermaid: 'exportMermaid',
        json: 'exportJSON',
        svg: 'exportSVG',
        drawio: 'exportDrawio'
      }
      return { ok: true, kind: 'special', action: 'export', method: methodByFormat[format.value], args: [] }
    }
  },
  {
    name: 'novelflow_api',
    description: '通用逃生门：调用白名单内任意 NovelFlow 方法（help() 可查清单）。exportPNG / download / subscribe 除外',
    inputSchema: schema(
      {
        method: { type: 'string', description: 'NovelFlow 方法名，如 addNode' },
        args: { type: 'array', description: '位置参数数组', items: {} }
      },
      ['method']
    ),
    parse: (params) => {
      const method = pickString(params, 'method', { required: true, max: 100 })
      if (!method.ok) return method
      if (!NOVELFLOW_METHODS.includes(method.value)) {
        return fail(`「${method.value}」不是 NovelFlow 方法，可用 novelflow_help 查看清单`)
      }
      if (NON_SERIALIZABLE_METHODS.includes(method.value)) {
        return fail(`「${method.value}」返回值不可 JSON 序列化，禁止经 MCP 调用`)
      }
      const args = params?.args
      if (args !== undefined && args !== null && !Array.isArray(args)) return fail('参数「args」必须是数组')
      return { ok: true, kind: 'special', action: 'api', method: method.value, args: Array.isArray(args) ? args : [] }
    }
  }
]

/* ------------------------------------------------------------------ */
/* 对外面                                                               */
/* ------------------------------------------------------------------ */

function listTools() {
  return TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
}

function findTool(name) {
  return TOOLS.find((tool) => tool.name === name) ?? null
}

/** 解析一次 tools/call：未知工具 / 参数非法都归为 {ok:false, error} */
function parseToolCall(name, params) {
  const tool = findTool(name)
  if (!tool) return { ok: false, error: `未知工具「${name}」，可调用 tools/list 查看全部工具` }
  const parsed = tool.parse(params && typeof params === 'object' && !Array.isArray(params) ? params : {})
  if (!parsed.ok) return parsed
  // 剥掉 ok：call 只描述「怎么调」，成功与否由 parseToolCall 的 ok 表达
  const call = { ...parsed }
  delete call.ok
  return { ok: true, tool, call }
}

module.exports = {
  NOVELFLOW_METHODS,
  NON_SERIALIZABLE_METHODS,
  MAX_NODES_PER_CALL,
  MAX_BATCH_COMMANDS,
  TOOLS,
  listTools,
  findTool,
  parseToolCall
}
