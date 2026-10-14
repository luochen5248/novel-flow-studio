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
| `npm run dist` | 打包 Windows 安装包（electron-builder） |

> 密钥配置：浏览器开发态在 `.env.local` 里填 `GRSAI_API_KEY`（已在 .gitignore 中）；
> 桌面版直接在应用内设置（右上角钥匙图标 / 模型管理弹窗），无需环境变量。

### Electron 桌面壳

```
electron/
  main.cjs     窗口 · grsai 代理接管 · 自动更新 · AI 模型管理与请求代发
  preload.cjs  contextBridge 最小安全面（更新 / AI IPC）
```

主进程职责：加载 Vite 构建产物；打包后没有 dev server，由主进程 `webRequest`
把渲染层 `/api/grsai/*` 请求重定向到真实 API 并注入密钥；AI 对话流式输出与
取消也由主进程管理。

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
electron/            桌面壳（main.cjs · preload.cjs）
src/
  types/             graph.ts 数据契约 · ai.ts AI 模型类型
  core/              id / model / layout / geometry / history / storage / aiPrompt
  api/               aiClient（AI 请求客户端）
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
