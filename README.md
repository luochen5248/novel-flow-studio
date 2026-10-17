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

软件右上角有「检查更新」按钮（下载图标）：

- 点击后自动比对 GitHub Releases 上的最新版本
- 发现新版本 → 确认下载（显示进度条）→ 「立即安装并重启」
- 升级为 NSIS 静默替换安装，**故事线数据与 AI 模型配置全程保留**

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
- **节点复制与拖拽增强**：复制行为更完整、拖拽交互更稳（配套 309 例单测覆盖）

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

**形态 A · 开发 / 未重打包（当前可用）**：桥接用项目内文件，`NOVELFLOW_GUI_EXE`
指向安装版 exe：

```json
{
  "mcpServers": {
    "novelflow": {
      "type": "stdio",
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["D:\\小说\\AI流程图绘制小说时间线的电脑软件\\electron\\mcp\\standalone.cjs"],
      "env": {
        "NOVELFLOW_GUI_EXE": "C:\\Program Files\\novelflow-studio\\小说时间线工坊.exe"
      }
    }
  }
}
```

> `node` 路径以实际为准（`where node` 查看）；也可用 GUI exe 自身当 Node 运行时免装
> node：`"command": "<安装目录>\\小说时间线工坊.exe"` +
> `"args": ["-e", "require('<安装目录>/mcp/standalone.cjs').main()"]`
> （依赖宿主环境不带 `ELECTRON_RUN_AS_NODE` 时不成立，故仅作备选）。

**形态 B · 正式安装版（随 GitHub Release 发布，推荐）**：`package.json` 的
`extraFiles` 会把整个 `electron/mcp/` 投放为安装目录下的 `mcp/`（纯 Node 读不了
asar，桥接文件必须在 asar 之外）。发布走 GitHub Actions——推送 `v*` 标签即自动
构建（见文末「发版流程」），**从 0.4.1 起**安装目录带 `mcp/`，配置简化为：

```json
{
  "mcpServers": {
    "novelflow": {
      "type": "stdio",
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Program Files\\novelflow-studio\\mcp\\standalone.cjs"]
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

工具（26 个）：`wake` / `status` / `help` / `list_flows` / `add_flow` / `open_flow` /
`remove_flow` / `rename_flow` / `get_state` / `add_node` / `add_nodes` / `update_node` /
`remove_node` / `add_edge` / `remove_edge` / `update_edge` / `add_note` / `add_character` /
`add_tag` / `set_status` / `set_chapter` / `batch` / `undo` / `redo` / `export` /
`api`（白名单内任意 NovelFlow 方法的逃生门）。资源：`novelflow://flows`、`novelflow://outline`。

安全说明：控制服务器只绑 127.0.0.1 回环、不涉入网规则；token 为 256 位随机值，与 AI
模型密钥同库（userData，0600）存放，请勿外传；AI 的全部操作都可 undo；`exportPNG` /
`download` / `subscribe` 等返回二进制或有 UI 副作用的方法不在白名单内。

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
> 桌面版直接在应用内设置（右上角钥匙图标 / 模型管理弹窗），无需环境变量。

### Electron 桌面壳

```
electron/
  main.cjs           窗口 · grsai 代理接管 · 自动更新 · AI 模型管理与请求代发 ·
                      单例锁（让位实例早退，不污染 control.json）与 GUI 侧控制服务器调度
  preload.cjs        contextBridge 最小安全面（更新 / AI / MCP IPC）
  control-server.cjs GUI 实例本地控制服务器（127.0.0.1 + Bearer token + 心跳刷新）
  mcp/               MCP stdio 桥：protocol（JSON-RPC 帧）· tools（26 工具注册表）·
                      control-client（HTTP 客户端）· wake（唤醒）· server（stdio 组装）·
                      standalone（独立桥接进程入口，打包态生产通路；经 extraFiles
                      投放为安装目录下的 mcp/）
```

主进程职责：加载 Vite 构建产物；打包后没有 dev server，由主进程 `webRequest`
把渲染层 `/api/grsai/*` 请求重定向到真实 API 并注入密钥；AI 对话流式输出与
取消也由主进程管理。开发态 `electron main.cjs --mcp` 可进入无窗口桥接模式
（跳过单例锁、日志全走 stderr、stdout 只承载 JSON-RPC 帧）；打包态生产通路是
独立桥接进程（见上「MCP 接入」）。

## 界面结构

```
┌──────────────────────────────────────────────┐
│ AppHeader   品牌 · 故事线（可改名）· 统计 · AI · 更新 │
├────────┬─────────────────────────────────────┤
│ 侧栏    │ CanvasToolbar  撤销/整理/缩放/锁定    │
│ 故事线  ├─────────────────────────────────────┤
│ 列表    │ FlowCanvas     自研 SVG 画布          │
│ 搜索    │                 + 时间轨 / 缩略图     │
└────────┴─────────────────────────────────────┘
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
electron/            桌面壳（main.cjs · preload.cjs · control-server.cjs · mcp/）
src/
  types/             graph.ts 数据契约 · ai.ts AI 模型类型
  core/              id / model / layout / geometry / history / storage / aiPrompt / characterSlot
  api/               aiClient（AI 请求客户端）
  mcp/               rendererBridge（MCP → window.NovelFlow 渲染层调用桥）
  stores/            useFlowStore（图数据）· useUiStore（界面偏好）· useAiStore（AI 模型）
  composables/       useViewport / useNodeDrag / useSelection / useShortcuts / useAiAssist
  components/
    layout/           AppShell · AppHeader
    sidebar/          FlowSidebar · FlowListItem
    canvas/           FlowCanvas · CanvasGrid · TimeRail · EdgeLayer
                      StoryNode · NodeHandles · SelectionBox · Minimap
    toolbar/          CanvasToolbar · ExportMenu
    ai/               AiAssistDialog · AiImageDialog
    common/           AiModelDialog · AiContextMenu · GrsaiKeyDialog
                      UpdateDialog · TagInput · ApiConsole(dev)
    inspector/        NodeInspector
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
