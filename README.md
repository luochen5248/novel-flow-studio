# NovelFlow Studio · 小说时间线工坊

给长篇小说作者用的**本地**故事脉络绘制工具。默认形态是自上而下的纵向时间轴，
每个节点是一段故事事件；可以从任意节点横向甩出并行支线（多视角 / 支线剧情）。

> 内核是自研 SVG 渲染（Vue 3 + TypeScript + SVG），不依赖任何图编辑库；
> 导出、AI 生图走同源的自研实现。

## 快速开始

```bash
npm install
cp .env.example .env.local   # 填入 GRSAI_API_KEY（已在 .gitignore 中）
npm run dev                  # http://127.0.0.1:5173
```

其他脚本：

| 命令 | 说明 |
|---|---|
| `npm run type-check` | `vue-tsc --noEmit` 全量类型检查 |
| `npm run test` | Vitest 单测（core / export 纯逻辑） |

> 约定：仓库不执行 `npm run build`，打包由使用者本地触发。

## 界面结构

```
┌──────────────────────────────────────────────┐
│ AppHeader     品牌 · 当前故事线（可改名）· 统计 │
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

- 一切存在 `localStorage` 的 `novelflow.workspace.v1` 键下，自动保存（写入失败会降级并告警，不白屏）。
- 侧栏支持单图 JSON 导入 / 导出。
- 数据契约唯一事实源：`src/types/graph.ts`。

## 目录

```
src/
  types/graph.ts      数据契约
  core/               id / model / layout / geometry / history / storage / sample
  stores/             useFlowStore（图数据）· useUiStore（界面偏好）
  composables/        useViewport / useNodeDrag / useSelection / useShortcuts
  components/
    layout/           AppShell · AppHeader
    sidebar/          FlowSidebar · FlowListItem
    canvas/           FlowCanvas · CanvasGrid · TimeRail · EdgeLayer
                      StoryNode · NodeHandles · SelectionBox · Minimap
    toolbar/          CanvasToolbar
  styles/             tokens.css（设计令牌）· global.css
```

## 视觉基调

- 外壳深墨蓝 `#0F1720 / #131C26 / #1B2634`；画布双模式：宣纸暖白 `#FAF8F4` 与夜航 `#0B1218`。
- 主色青 `#4DD0D9`，辅金 `#C9A227`；语义色一律去饱和。
- 卡片圆角 18、左侧 4px 主色导条、柔和渐层底 + 双层柔阴影；选中是主色描边 + 外发光，绝不用虚线蚂蚁框。
- 连线一律三次贝塞尔 S 曲线（控制点偏移 ≥ 间距 40%），禁止正交折线。
- 主线左侧贯穿「时间轨道」，锚点为同心圆环 + 呼吸光晕。
- 动效 150–250ms，`cubic-bezier(.2,0,0,1)`，节点入场 stagger 30ms。
