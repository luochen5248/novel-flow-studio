import type { EdgeKind, NodeKind } from '@/types/graph'
import { DEFAULT_NODE_H, DEFAULT_NODE_W } from '@/core/model'

/**
 * 导出层公共常量（PNG / SVG / drawio / Mermaid 共用）
 *
 * 这里的数值必须与运行时画布保持一致，否则「导出结果和屏幕上看到的不是一个东西」。
 * 尺寸默认值直接取自 @/core/model，避免两处硬编码漂移。
 */

/** 默认节点尺寸 */
export const NODE_W = DEFAULT_NODE_W
export const NODE_H = DEFAULT_NODE_H

/** timeline 布局默认间距（plan.md 第 4 节约定） */
export const ROW_GAP = 200
export const LANE_GAP = 320

/** 导出画布内边距 */
export const EXPORT_PADDING = 48
/** 顶部标题区预留高度（图名 + 生成时间） */
export const HEADER_HEIGHT = 56

/** 卡片圆角（视觉红线 8.1.1：rx=18） */
export const CARD_RADIUS = 18
/** 小节点（h < 104）时的圆角 */
export const CARD_RADIUS_SMALL = 14
/** 左侧主色导条宽度 */
export const ACCENT_BAR_W = 4

/** 卡片字号阶梯（1.25–1.6 模块化字阶） */
export const FONT_TITLE = 15
export const FONT_BADGE = 11
export const FONT_SUMMARY = 12.5
export const FONT_META = 11
export const FONT_HEADER = 20
export const FONT_HEADER_META = 12

/**
 * 系统字体栈：导出 SVG 内联在 <style> 里，栅格化时不需要下载 webfont，
 * 也就不会出现「导出 PNG 后字体丢失/变宋体」的坑。
 *
 * 注意：字体名一律用**单引号**。
 * 这个字符串会同时出现在 <style> 文本和根节点的 font-family 属性里，
 * 用双引号会提前闭合 XML 属性（font-family="…"Segoe UI"…"），直接让 SVG 变成非法文档。
 */
export const FONT_STACK =
  "system-ui, -apple-system, 'Segoe UI', 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif"

/** 导出画布主题（浅色宣纸 / 夜间墨色，对应视觉红线 8.1.4） */
export interface ExportTheme {
  /** 画布底色 */
  background: string
  /** 卡片渐层：上 → 下（柔和渐层，而非纯色块） */
  cardFrom: string
  cardTo: string
  /** 卡片描边 */
  cardBorder: string
  /** 主文字 */
  title: string
  /** 摘要正文 */
  body: string
  /** 辅助信息（时间徽标 / 页脚） */
  muted: string
  /** 时间徽标底 */
  badgeBg: string
  /** 时间徽标文字 */
  badgeText: string
  /** 时间轨道 */
  rail: string
  /** 阴影色 */
  shadow: string
}

export const LIGHT_THEME: ExportTheme = {
  background: '#FAF8F4',
  cardFrom: '#FFFFFF',
  cardTo: '#FBF8F2',
  cardBorder: '#E7E0D4',
  title: '#1B2634',
  body: '#55606C',
  muted: '#8A94A0',
  badgeBg: 'rgba(15,23,32,0.05)',
  badgeText: '#6B7683',
  rail: '#4DD0D9',
  shadow: '#0F1720'
}

export const DARK_THEME: ExportTheme = {
  background: '#0B1218',
  cardFrom: '#18232E',
  cardTo: '#141E28',
  cardBorder: '#24323F',
  title: '#E8EEF3',
  body: '#A7B4C0',
  muted: '#7C8A97',
  badgeBg: 'rgba(255,255,255,0.08)',
  badgeText: '#A7B4C0',
  rail: '#4DD0D9',
  shadow: '#05080B'
}

/**
 * token 名 → hex。
 * 节点 color 字段存的是 token 名（见 types/graph.ts 的 KIND_COLOR），
 * 导出时需要具体色值，故在此集中映射；若已经是 hex 则原样返回。
 */
export const TOKEN_COLORS: Record<string, string> = {
  teal: '#4DD0D9',
  mist: '#8AA9B8',
  gold: '#C9A227',
  clay: '#C08A6E',
  ink: '#5B6B7C',
  sage: '#8FA98A',
  accent: '#4DD0D9',
  goldAlt: '#C9A227'
}

/** 连线样式：粗细 2.5、圆头，拐弯全靠贝塞尔（视觉红线 8.1.2） */
export const EDGE_STYLE: Record<EdgeKind, { color: string; width: number; dash?: string }> = {
  flow: { color: '#4DD0D9', width: 2.5 },
  branch: { color: '#C9A227', width: 2.5 },
  flashback: { color: '#8A94A0', width: 2, dash: '6 6' },
  jump: { color: '#6F8BA3', width: 2.5, dash: '10 6' }
}

/** 节点类型中文名（导出文本格式用） */
export const KIND_TEXT: Record<NodeKind, string> = {
  event: '事件',
  scene: '场景',
  decision: '抉择',
  character: '人物',
  milestone: '里程碑',
  note: '备忘'
}

/** 状态中文名 */
export const STATUS_TEXT: Record<string, string> = {
  planned: '待写',
  drafted: '草稿',
  done: '已成稿'
}

/**
 * 解析节点主色：hex 直接返回；token 名查表；都不认识则按类型取默认色。
 * @param color 节点 color 字段（token 名或 hex）
 * @param kind 节点类型，用于兜底
 */
export function resolveColor(color: string | undefined, kind: NodeKind = 'event'): string {
  if (color && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) return color
  if (color && TOKEN_COLORS[color]) return TOKEN_COLORS[color]
  return TOKEN_COLORS[kind === 'decision' ? 'gold' : 'teal']
}
