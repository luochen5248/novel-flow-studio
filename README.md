# NovelFlow Studio · 小说时间线工坊

给长篇小说作者用的**本地**故事脉络绘制工具。默认形态是自上而下的纵向时间轴，
每个节点是一段故事事件；可以从任意节点横向甩出并行支线（多视角 / 支线剧情）。

> 内核是自研 SVG 渲染（Vue 3 + TypeScript + SVG），不依赖任何图编辑库；
> 导出、AI 生图走同源的自研实现。桌面版基于 Electron，支持应用内自动更新。

## 下载安装（Windows 桌面版）

1. 打开 [Releases 页面](https://github.com/luochen5248/novel-flow-studio/releases)
2. 下载最新版本的 `NovelFlow-Studio-Setup-x.y.z.exe` 并安装
3. 首次运行如遇 SmartScreen 提示，点「更多信息 → 仍要运行」（个人开发未购买代码签名证书）

### 自动更新

「检查更新」入口在左下角**控制中心**（「关于」分组）：

- 点击后自动比对 GitHub Releases 上的最新版本
- 发现新版本 → 确认下载（显示进度条）→ 「立即安装并重启」
- 升级为 NSIS 静默替换安装，**故事线数据与 AI 模型配置全程保留**

### 控制中心与系统托盘（0.4.2 新增）

- **控制中心**：左下角常驻入口，点击弹出「设置中心」大弹窗（左栏分组导航 + 右栏说明与操作）。
  原先散落在右上角的检查更新、AI 模型管理、AI 生图密钥、开发者控制台、画布切换、外观切换
  六项全部收在这里；顶栏只保留导出菜单与文档信息
- **系统托盘**：点右上角关闭按钮不会退出，而是隐藏到系统托盘（首次隐藏有气泡提示）；
  单击托盘图标恢复窗口，右键菜单「显示主窗口 / 退出」，**只有托盘「退出」才真正退出**
- **启动即最大化**：每次启动默认最大化窗口，无需手动拉伸
- **新应用图标**：品牌图标由脚本生成（`scripts/generate-tray-icon.cjs` 托盘 32²、
  `scripts/generate-app-icon.cjs` 运行时 256²，源图 `build/icon.png` 1024² 供打包拾取）

## 功能亮点

### 时间轴画布

- 自上而下主时间轴 + 任意节点横向甩出并行支线
- 四向连接桩连线（上/下/左/右）、改写连线、线中插节点
- 撤销/重做（≥50 步）、框选、缩略图导航、时间轨锚点
- 导入/导出 JSON，画布双主题（宣纸暖白 / 夜航）

### AI 助手（0.3.0 新增）

- **模型管理**：自定义任意 OpenAI 兼容端点与密钥，支持 LLM 对话与生图两类模型；
  密钥只存在本机 `userData/config.json`，请求由主进程代发，**密钥永不离开本机**
- **对话辅助**：考据（资料核查）、续写、润色三种模式，结果可替换或追加到节点
- **AI 生图**：接入 grsai 生图 API，为节点配插图
- **右键菜单**：节点/编辑器内快捷唤起 AI 能力

### 人物卡片与画布增强（0.4.0 新增）

- **人物卡智能落位**：新建人物卡片自动排布在主线/支线内容的右侧空白网格，
  逐卡递进不叠压，也永远不会被时间线自动布局挪走
- **节点复制与拖拽增强**：复制行为更完整、拖拽交互更稳（配套 320 例单测覆盖）

### MCP 接入（AI 直接调用与唤醒，0.4.0 新增）

打包后的桌面版内置 MCP（Model Context Protocol）桥：WorkBuddy、Claude Desktop 等 AI
软件可以通过标准 MCP 协议**唤醒软件**并**调用 API 操作流程图**——新建故事线、增删改
节点、连边、批量编排、导出、撤销重做。所有调用最终走界面同一条 store 通路：改动
可见、可 `Ctrl+Z` 撤销、自动保存。

工作原理（**独立桥接进程**架构）：

- 桥接是零 electron 依赖的纯 Node 进程（`electron/mcp/standalone.cjs`），由 AI 软件
  按 stdio 方式拉起，随连接而生、断开而退；它读用户数据目录的 `control.json` 找到
  GUI 的控制服务器，把工具调用转发过去。GUI 未运行时负责唤醒主程序（spawn + 健康
  检查轮询），唤醒成功后 memo，后续调用走快路
- GUI 实例常驻本地控制服务器：仅监听 `127.0.0.1`，Bearer token 认证；端口与 token
  写在用户数据目录的 `control.json`（权限 0600）；主实例每 30 秒心跳刷新该文件，
  被外部篡改可自愈；退出时只删自己的条目（pid 守卫）
- 业务调用由渲染层 `window.NovelFlow.*` 执行（即浏览器控制台那套可编程 API）
- **为什么桥接必须是独立进程、而不是 exe 自己当 MCP 服务端**（Electron 44.7.0 实证，
  2026-10-17）：
  ① exe 无参数 + 管道 stdin → Node CLI 的 `eval_stdin` 劫持 stdin（JSON-RPC 帧被当
  JS 求值报 SyntaxError，app 根本不启动）；
  ② exe 带任何脚本参数（`-e` 或位置参数）→ 脚本模式，内置 `electron` 模块未注册，
  `require('electron')` 直接 Cannot find module；
  ③ 未知 `--` 长参数（`--mcp` 等）被二进制层 CLI 解析直接拒绝（`bad option` + exit 9），
  进程到不了 main.cjs——所以开发态兼容参数、打包态改用 `NOVELFLOW_MCP=1` 环境变量传令
  （仅对 exe 直启有效；独立桥接架构下已不需要）
  ④ 宿主（WorkBuddy 等）注入的 `ELECTRON_RUN_AS_NODE=1` 会让 GUI exe 退化成纯 node
  （秒退 / bad option 全是它）——桥接唤醒 GUI 前会剥离该变量与 `NODE_OPTIONS`

在 WorkBuddy 中接入（两种形态，任选其一）：

> 安装路径以实际为准：NSIS 为用户级安装（`perMachine: false`），默认在
> `%LOCALAPPDATA%\Programs\小说时间线工坊\`（即
> `C:\Users\<你>\AppData\Local\Programs\小说时间线工坊\`），安装时可自选目录；
> 主程序为 `小说时间线工坊.exe`。下例按默认路径书写，自行替换。

**形态 A · 开发 / 未重打包（项目目录可用时作备份）**：桥接用项目内文件，`NOVELFLOW_GUI_EXE`
指向安装版 exe：

```json
{
  "mcpServers": {
    "novelflow": {
      "type": "stdio",
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["D:\\小说\\AI流程图绘制小说时间线的电脑软件\\electron\\mcp\\standalone.cjs"],
      "env": {
        "NOVELFLOW_GUI_EXE": "C:\\Users\\<你>\\AppData\\Local\\Programs\\小说时间线工坊\\小说时间线工坊.exe"
      }
    }
  }
}
```

> `node` 路径以实际为准（`where node` 查看）；也可用 GUI exe 自身当 Node 运行时免装
> node：`"command": "<安装目录>\\小说时间线工坊.exe"` +
> `"args": ["-e", "require('<安装目录>/mcp/standalone.cjs').main()"]`
> （依赖宿主环境不带 `ELECTRON_RUN_AS_NODE` 时不成立，故仅作备选）。

**形态 B · 正式安装版 0.4.1 起（推荐）**：`package.json` 的
`extraFiles` 会把整个 `electron/mcp/` 投放为安装目录下的 `mcp/`（纯 Node 读不了
asar，桥接文件必须在 asar 之外）。发布走 GitHub Actions——推送 `v*` 标签即自动
构建（见文末「发版流程」），**从 0.4.1 起**安装目录带 `mcp/`，配置简化为：

```json
{
  "mcpServers": {
    "novelflow": {
      "type": "stdio",
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Users\\<你>\\AppData\\Local\\Programs\\小说时间线工坊\\mcp\\standalone.cjs"]
    }
  }
}
```

> 升级路径：装 0.4.1（Releases 页下载 `NovelFlow-Studio-Setup-0.4.1.exe`，或 app
> 内「检查更新」走自动更新）后，把 `mcp.json` 的 novelflow 条目换成形态 B 即可；
> 形态 A 在项目目录不变的前提下始终有效，可留作备份。低于 0.4.1 的安装版 asar
> 内是旧 main.cjs（无让位早退、无 control.json 心跳），边缘场景（主程序活着但
> 接入文件被污染）下唤醒会超时，升级后自愈。

> 共同注意：合并进 `mcpServers`，不要覆盖已有条目；配置文件是不带点前缀的 `mcp.json`；
> 保存后需到「连接器管理 → 自定义连接器」点击**「信任」**才生效（不自动激活）。

对 AI 说：「唤醒小说时间线工坊，新建故事线《锚点》，添加三个节点：雨夜初遇 / 旧账 / 抉择」——软件窗口自动弹出，节点上线并自动串联。

工具（49 个）：`wake` / `status` / `help` / `list_flows` / `add_flow` / `open_flow` /
`remove_flow` / `rename_flow` / `get_state` / `add_node` / `add_nodes` / `update_node` /
`remove_node` / `add_edge` / `remove_edge` / `update_edge` / `add_note` / `add_character` /
`add_tag` / `set_status` / `set_chapter` / `batch` / `undo` / `redo` / `export` /
`api`（白名单内任意 NovelFlow 方法的逃生门）/ `kb_add_entry` / `kb_update_entry` /
`kb_remove_entry` / `kb_list_entries` / `kb_search` / `kb_semantic_search` /
`kb_index_status` / `kb_rebuild_index` / `kb_link_node` / `kb_unlink_node` /
`kb_list_node_links` / `doc_add` / `doc_list` / `doc_get` / `doc_update` / `doc_remove` /
`doc_anchor` / `doc_link_node` / `doc_unlink_node` / `memory_add` / `memory_list` /
`memory_update` / `memory_remove`。资源：`novelflow://flows`、`novelflow://outline`。

安全说明：控制服务器只绑 127.0.0.1 回环、不涉入网规则；token 为 256 位随机值，与 AI
模型密钥同库（userData，0600）存放，请勿外传；AI 的全部操作都可 undo；`exportPNG` /
`download` / `subscribe` 等返回二进制或有 UI 副作用的方法不在白名单内。

### 知识库与记忆进化（0.5.0 新增，0.5.1 资料库式改版）

为长篇小说作者准备的**本机**知识库与写作依据系统，全部数据存在用户数据目录的
`novelflow.db`（sql.js 单文件数据库，不联网、不出本机）：

- **知识条目**：在左下角控制中心打开「知识库」面板，按 笔记 / 设定 / 人物 / 情节 / 风格
  分类沉淀素材，支持标题 / 标签 / 正文搜索（LIKE 预筛 + 渲染层相关性精排）
- **文档上传与段落锚点**：上传自己的 `.md` / `.txt` / `.docx`（docx 自动抽取纯文本）；
  在文档查看器里划选一段文字即可**关联到当前节点**——锚点随文档改动自动模糊重定位，不会错位
- **AI 三路注入**：右键唤起 AI 助手时，自动把「作者记忆 / 知识库参考 / 写作依据（关联
  文档段落）」拼进提示词；记忆块仅在「本地记忆与技能」开关打开时注入（隐私优先），
  检索失败则静默跳过，绝不阻断主链
- **记忆与进化**：控制中心「记忆与进化」面板可沉淀写作偏好与工作背景、回顾 AI 协助
  历史；两个开关默认关闭，打开后才记录工作过程事件
- **语义检索（0.5.2 新增）**：知识条目与文档可建**本地语义索引**（向量存独立的
  `userData/novelflow-vectors.db`）；embedding **只走本机 Ollama / LM Studio**
  （默认 `http://localhost:11434/v1`；端点与模型在知识库面板的索引状态行里配置，
  存本机知识库偏好，**正文绝不发往第三方**）；未配置 / 服务不可用时**明说降级为
  关键词检索**，绝不用「假向量」凑数；索引状态（块数 / 模型 / 维度 / 最近重建）
  与「重建索引」按钮同在该行，换过模型可全量重算
- **MCP 暴露**：新增 23 个知识库工具（`kb_*` / `doc_*` / `memory_*`），见上方「工具（49 个）」
- **资料库式改版（0.5.1）**：知识库面板重做为资料库式大面板——左栏搜索 + 分区导航（知识条目 /
  参考文档 / 作者记忆）+ 最近访问；右栏列表（名称 / 类型 / 位置 / 最近访问）+ 右上角「上传文档 /
  新建条目」入口；并修复早期版本「打开知识库无响应、无法上传文件」的问题

### 用 WorkBuddy 等 AI 管理知识库

接入配置同上方「MCP 接入」的**形态 B**（正式安装版 0.4.1 起，安装目录自带 `mcp/`，`mcp.json`
指向 `<安装目录>\mcp\standalone.cjs`，保存后到「连接器管理 → 自定义连接器」点「信任」）。
知识库相关工具共 23 个（`kb_*` / `doc_*` / `memory_*`，见上方「工具（49 个）」），全部经界面
同一条 store 通路执行：改动可见、可 `Ctrl+Z`、数据落 `userData/novelflow.db`。

能做什么：

- **读**：`kb_search`（关键词搜索，返回条目全文）/ `kb_list_entries` / `kb_list_node_links`
  （按节点反查关联的条目与文档）/ `doc_list`（列全部文档）/ `doc_get`（读文档全文）/ `memory_list`
- **语义检索**：`kb_semantic_search`（向量召回，返回条目全文 + 命中文档 id；结果里
  `mode="keyword"` 表示本机 embedding 不可用、已降级为关键词检索，附中文说明）/
  `kb_index_status`（查索引块数、模型、维度、最近重建时间、本机 embedding 是否就绪）/
  `kb_rebuild_index`（后台重建索引，立即返回；换过模型给 `full:true` 全量重算）
- **写**：`kb_add_entry`（条目 ≤2 万字符）/ `doc_add`（**带文档全文直接入库，≤20 万字符**，
  AI 生成内容入库就走它）/ `memory_add`（≤2000 字符）
- **改删**：`kb_update_entry` / `kb_remove_entry` / `doc_update` / `doc_remove` /
  `memory_update` / `memory_remove`
- **关联**：`kb_link_node` / `kb_unlink_node` / `doc_link_node` / `doc_unlink_node` /
  `doc_anchor`（给一段文字即可在文档内自动模糊定位建成锚点，定位不到会明确报错，绝不存错位锚点）

做不到的：

- **没有「AI 整理」类工具**：整理动作 = AI 自己读出来（`kb_search` / `doc_get` / `memory_list`）
  → 在 AI 侧归纳 → 再写回（`kb_add_entry` / `doc_add` / `memory_add`）
- **不能让 AI 上传本地文件**：上传走界面「上传文档」按钮（对话框 + 读文件都在主进程）；
  AI 只能把内容以文本形式 `doc_add` 进来
- 单次写入有硬上限（条目 2 万 / 文档 20 万 / 记忆 2000 字符），超大文档需拆篇多次 `doc_add`

示例指令（直接对 WorkBuddy 说）：

1. **存条目**：「用 kb_add_entry 存一条人物设定：标题『沈砚』，类型 character，content『……』」
2. **查重后存**：「先 kb_search 搜『沈砚』把结果念给我；没有重复再用 kb_add_entry 存这条：……」
3. **带全文建文档**：「用 doc_add 把下面全文存进知识库，标题《第三卷大纲》，format 用 md：……」+ 粘贴全文

### 时间线一致性检查（0.5.2 新增）

控制中心新增「故事检查 → 一致性检查」：对当前故事线跑一遍**纯本地规则**，
把冲突与遗漏摆到桌面上——不猜、不联网、不读正文：

- **13 条纯规则默认开**：悬空连线、顺序连线逆序、章节号重复、已成稿却无正文、
  支线未收束、空字段（标题 / 时间 / 摘要 / 章节）、人物与角色牌对不上等；
  年份只在两端都能解析时才比较（时间标签是自由文本，抽不出年份就跳过，不误报），
  跨支线不比顺序，人物卡按角色牌语义豁免部分规则
- **8 条 AI 语义项预留、默认关**：如跨支线并行冲突、人物动机断裂等需要 LLM 判定的
  检查；面板里可勾选登记，当前不真正调用 AI（接入模型后开放）
- **三处落点**：① 控制台「一致性检查」面板（打开即算，严重级计数 + 问题列表，
  点问题选中并跳到对应节点）；② 画布节点卡右上角角标（有问题才亮，悬浮看详情）；
  ③ 属性检查器「画布总览」的一致性格（三计数，点击直达检查面板）
- **快照语义**：检查在打开面板 / 点「重新检查」时现算，不随编辑自动重算——
  纯函数便宜到随手可跑，但跟着自动保存的防抖跑会让列表反复抖动

## 快速开始（开发）

```bash
npm install
npm run dev                  # http://127.0.0.1:5173
```

其他脚本：

| 命令 | 说明 |
|---|---|
| `npm run type-check` | `vue-tsc --noEmit` 全量类型检查 |
| `npm run test` | Vitest 单测（core / aiPrompt / export 纯逻辑） |
| `npm run build` | 类型检查 + 前端产物构建 |
| `npm run pack` | 本地打包 Windows 安装包（electron-builder，不发布） |

> 正式发布不走本地 pack，而是推送 `v*` 标签由 GitHub Actions 云端构建（见文末「发版流程」）。

> 密钥配置：浏览器开发态在 `.env.local` 里填 `GRSAI_API_KEY`（已在 .gitignore 中）；
> 桌面版直接在应用内设置（左下角控制中心 → AI 生图密钥 / AI 模型管理），无需环境变量。

### Electron 桌面壳

```
electron/
  main.cjs           窗口 · grsai 代理接管 · 自动更新 · AI 模型管理与请求代发 ·
                      系统托盘（关闭隐藏 / 托盘退出）/ 启动最大化 / 应用图标 ·
                      单例锁（让位实例早退，不污染 control.json）与 GUI 侧控制服务器调度
  assets/             app-icon.png（运行时窗口图标 256²）· tray-icon.png（托盘图标 32²）
  preload.cjs        contextBridge 最小安全面（更新 / AI / MCP IPC）
  control-server.cjs GUI 实例本地控制服务器（127.0.0.1 + Bearer token + 心跳刷新）
  mcp/               MCP stdio 桥：protocol（JSON-RPC 帧）· tools（49 工具注册表）·
                      control-client（HTTP 客户端）· wake（唤醒）· server（stdio 组装）·
                      standalone（独立桥接进程入口，打包态生产通路；经 extraFiles
                      投放为安装目录下的 mcp/）
scripts/             图标生成脚本（generate-tray-icon / generate-app-icon，零依赖幂等）
build/icon.png       应用图标源图 1024²（electron-builder 默认 buildResources，打包自动拾取）
```

主进程职责：加载 Vite 构建产物；打包后没有 dev server，由主进程 `webRequest`
把渲染层 `/api/grsai/*` 请求重定向到真实 API 并注入密钥；AI 对话流式输出与
取消也由主进程管理。开发态 `electron main.cjs --mcp` 可进入无窗口桥接模式
（跳过单例锁、日志全走 stderr、stdout 只承载 JSON-RPC 帧）；打包态生产通路是
独立桥接进程（见上「MCP 接入」）。

## 界面结构

```
┌──────────────────────────────────────────────┐
│ AppHeader   品牌 · 故事线（可改名）· 统计 · 导出 │
├────────┬─────────────────────────────────────┤
│ 侧栏    │ CanvasToolbar  撤销/整理/缩放/锁定    │
│ 故事线  ├─────────────────────────────────────┤
│ 列表    │ FlowCanvas     自研 SVG 画布          │
│ 搜索    │                 + 时间轨 / 缩略图     │
└────────┴─────────────────────────────────────┘
┌ 控制中心（左下角，侧栏折叠时降级为浮标）→ 设置中心弹窗 ┐
```

## 交互

| 操作 | 方式 |
|---|---|
| 平移 | 空白处拖动 / 空格 + 拖动 / 中键拖动 / 滚轮 |
| 缩放 | Ctrl + 滚轮 / 工具栏 ± / `Ctrl+0` 适应画布 |
| 选择 | 点击节点；`Shift` 加选；空白处拖动框选；`Ctrl+A` 全选 |
| 下方插入 | 节点底部连接桩，或 `Enter` |
| 插入支线 | 节点左右连接桩，或 `Tab` |
| 拉线连接 | 从任一连接桩拖到目标节点 |
| 改写连接 | 选中连线后拖动两端圆点 |
| 线中插节点 | 悬停连线，点中点的「+」 |
| 复制 / 删除 | `Ctrl+D` / `Delete` |
| 撤销 / 重做 | `Ctrl+Z` / `Ctrl+Y`（≥50 步，拖动只记一条） |
| 导出 JSON | `Ctrl+S`（由 `window.NovelFlow.exportJSON()` 提供） |

## 数据

- 浏览器版：一切存在 `localStorage` 的 `novelflow.workspace.v1` 键下，自动保存（写入失败会降级并告警，不白屏）。
- 桌面版：故事线数据同上；AI 模型配置与密钥存 `userData/config.json`，仅本机可读。
- 知识库数据存 `userData/novelflow.db`（sql.js 单文件），含知识条目、文档、段落锚点、作者记忆与偏好；与故事线数据相互独立存储。
- 侧栏支持单图 JSON 导入 / 导出。
- 数据契约唯一事实源：`src/types/graph.ts`；AI 相关类型：`src/types/ai.ts`。

## 发版流程

```bash
# 1. 修改 package.json 的 version，提交
git commit -am "chore: 版本升至 x.y.z"
# 2. 打标签推送 → GitHub Actions 自动云端构建并上传 Release 草稿
git tag vx.y.z && git push origin main --tags
# 3. 到 Releases 页面把草稿 Publish（发布后旧版客户端「检查更新」即可收到推送）
```

构建流水线：`.github/workflows/release.yml`（Windows 云端构建，类型检查 + 前端构建 +
electron-builder 打包发布，产物为安装包 exe + latest.yml 更新元数据 + blockmap 差量文件）。

## 目录

```
electron/            桌面壳（main.cjs · preload.cjs · control-server.cjs · mcp/ · kb/（store.cjs/docx.cjs 主进程知识库））
src/
  types/             graph.ts 数据契约 · ai.ts AI 模型类型
  core/              id / model / layout / geometry / history / storage / aiPrompt / characterSlot / kb（types/sanitize/search/anchor/inject）
  api/               aiClient（AI 请求客户端）· kbClient（知识库客户端：桌面 IPC 与浏览器 IndexedDB 双通路）· kbIdb（浏览器态 IndexedDB 孪生）
  mcp/               rendererBridge（MCP → window.NovelFlow 渲染层调用桥）
  stores/            useFlowStore（图数据）· useUiStore（界面偏好）· useAiStore（AI 模型）· useKbStore（知识库）
  composables/       useViewport / useNodeDrag / useSelection / useShortcuts / useAiAssist
  components/
    layout/           AppShell · AppHeader · ControlCenter（控制中心 / 设置中心弹窗）
    sidebar/          FlowSidebar · FlowListItem
    canvas/           FlowCanvas · CanvasGrid · TimeRail · EdgeLayer
                      StoryNode · NodeHandles · SelectionBox · Minimap
    toolbar/          CanvasToolbar · ExportMenu
    ai/               AiAssistDialog · AiImageDialog
    common/           AiModelDialog · AiContextMenu · GrsaiKeyDialog
                      UpdateDialog · TagInput · ApiConsole(dev)
    inspector/        NodeInspector
    kb/               KnowledgePanel（知识库大面板）
    story/            StoryEditorDrawer
  styles/             tokens.css（设计令牌）· global.css
tests/
  unit/               aiPrompt 等纯逻辑单测
```

## 视觉基调

- 外壳深墨蓝 `#0F1720 / #131C26 / #1B2634`；画布双模式：宣纸暖白 `#FAF8F4` 与夜航 `#0B1218`。
- 主色青 `#4DD0D9`，辅金 `#C9A227`；语义色一律去饱和。
- 卡片圆角 18、左侧 4px 主色导条、柔和渐层底 + 双层柔阴影；选中是主色描边 + 外发光，绝不用虚线蚂蚁框。
- 连线一律三次贝塞尔 S 曲线（控制点偏移 ≥ 间距 40%），禁止正交折线。
- 主线左侧贯穿「时间轨道」，锚点为同心圆环 + 呼吸光晕。
- 动效 150–250ms，`cubic-bezier(.2,0,0,1)`，节点入场 stagger 30ms。
