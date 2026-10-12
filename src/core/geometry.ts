import type { EdgeKind, Point, PortSide, Rect, StoryNode } from '@/types/graph'

/**
 * 几何工具：port 锚点 + 三次贝塞尔 S 曲线。
 *
 * 设计原则（对应视觉红线 8.1.2）：
 *  - 任何拐弯都是三次贝塞尔，绝不出正交直角折线；
 *  - 控制点偏移量恒 ≥ 两锚点间距的 40%（小间距时取 48px 下限），保证「大圆角」的松弛感；
 *  - 所有函数 O(1)，无递归，可安全地在 render 里逐帧调用。
 */

/** 端口锚点向外探出的呼吸间隙，避免线头贴死卡片 */
export const PORT_GAP = 6

export function getPortPoint(node: StoryNode, side: PortSide): Point {
  const { x, y, w, h } = node
  switch (side) {
    case 'top':
      return { x: x + w / 2, y: y - PORT_GAP }
    case 'bottom':
      return { x: x + w / 2, y: y + h + PORT_GAP }
    case 'left':
      return { x: x - PORT_GAP, y: y + h / 2 }
    case 'right':
    default:
      return { x: x + w + PORT_GAP, y: y + h / 2 }
  }
}

/** 若节点矩形在某侧更近，则选该侧（用于自动挑 port） */
export function nearestSide(from: StoryNode, to: StoryNode, axis: 'v' | 'h'): PortSide {
  if (axis === 'v') {
    return to.y >= from.y + from.h / 2 ? 'bottom' : 'top'
  }
  return to.x >= from.x + from.w / 2 ? 'right' : 'left'
}

export interface EdgePathOptions {
  direction?: 'vertical' | 'horizontal'
}

export interface EdgePath {
  d: string
  /** 起点（箭头在终点，倒叙线除外） */
  start: Point
  end: Point
  /** 曲线中点，用于放置「插入节点」的 + 按钮 */
  mid: Point
  /** 起点切线方向，用于摆放起始箭头 */
  startAngle: number
  endAngle: number
}

function fmt(n: number): string {
  return Math.round(n * 100) / 100 + ''
}

/** 三次贝塞尔取点 */
export function cubicPoint(
  p0: Point,
  c1: Point,
  c2: Point,
  p1: Point,
  t: number
): Point {
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const c = 3 * mt * t * t
  const d = t * t * t
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p1.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p1.y
  }
}

/** 三次贝塞尔切线角（弧度），用于箭头朝向 */
export function cubicAngle(p0: Point, c1: Point, c2: Point, p1: Point, t: number): number {
  const mt = 1 - t
  const x =
    3 * mt * mt * (c1.x - p0.x) + 6 * mt * t * (c2.x - c1.x) + 3 * t * t * (p1.x - c2.x)
  const y =
    3 * mt * mt * (c1.y - p0.y) + 6 * mt * t * (c2.y - c1.y) + 3 * t * t * (p1.y - c2.y)
  if (x === 0 && y === 0) return 0
  return Math.atan2(y, x)
}

interface Curve {
  p0: Point
  c1: Point
  c2: Point
  p1: Point
}

/** 纵向布局：主线自上而下 */
function verticalCurve(source: StoryNode, target: StoryNode, kind: EdgeKind): Curve {
  const dyRaw = target.y - (source.y + source.h)
  const dx = target.x - source.x

  if (kind === 'flashback') {
    // 倒叙：从左侧甩出一条外拱曲线，语义上「回到更早的地方」
    const p0 = getPortPoint(source, 'left')
    const p1 = getPortPoint(target, 'left')
    const span = Math.abs(p1.y - p0.y)
    // 外拱幅度刻意压小：倒叙线只要「绕出去一点」就够读，拱太大反而越过时间轨
    const bow = Math.min(Math.max(span * 0.14, 46), 96)
    return {
      p0,
      c1: { x: p0.x - bow, y: p0.y + Math.max(span * 0.1, 16) },
      c2: { x: p1.x - bow, y: p1.y - Math.max(span * 0.1, 16) },
      p1
    }
  }

  if (kind === 'branch') {
    // 分支：从主线侧面平滑甩出，再落进支线节点顶部
    const dirRight = target.x + target.w / 2 >= source.x + source.w / 2
    const p0 = getPortPoint(source, dirRight ? 'right' : 'left')
    const p1 = getPortPoint(target, 'top')
    const lead = Math.max(Math.abs(p1.x - p0.x) * 0.55, 64)
    const drop = Math.max(Math.abs(p1.y - p0.y) * 0.45, 52)
    return {
      p0,
      c1: { x: p0.x + (dirRight ? lead : -lead), y: p0.y + Math.min(drop * 0.25, 26) },
      c2: { x: p1.x, y: p1.y - drop },
      p1
    }
  }

  if (kind === 'jump') {
    // 跳跃：跨越较远，侧向鼓一个更大的肚子，视觉上区别于顺序线
    const p0 = getPortPoint(source, 'bottom')
    const p1 = getPortPoint(target, 'top')
    const dirRight = p1.x >= p0.x ? 1 : -1
    const belly = Math.max(Math.abs(dx) * 0.42, 72)
    const k = Math.max(Math.abs(dyRaw) * 0.42, 56)
    return {
      p0,
      c1: { x: p0.x + dirRight * belly * 0.5, y: p0.y + k },
      c2: { x: p1.x - dirRight * belly * 0.5, y: p1.y - k },
      p1
    }
  }

  // flow：标准 S 曲线，控制点偏移 = 纵向间距的 50%（≥40% 红线）
  const p0 = getPortPoint(source, 'bottom')
  const p1 = getPortPoint(target, 'top')
  const k = Math.max(Math.abs(dyRaw) * 0.5, Math.abs(dx) * 0.4, 48)
  return {
    p0,
    c1: { x: p0.x, y: p0.y + k },
    c2: { x: p1.x, y: p1.y - k },
    p1
  }
}

/** 横向布局：主线自左向右（lane 变为纵向偏移） */
function horizontalCurve(source: StoryNode, target: StoryNode, kind: EdgeKind): Curve {
  const dxRaw = target.x - (source.x + source.w)
  const dy = target.y - source.y

  if (kind === 'flashback') {
    const p0 = getPortPoint(source, 'top')
    const p1 = getPortPoint(target, 'top')
    const span = Math.abs(p1.x - p0.x)
    const bow = Math.max(span * 0.22, 54)
    return {
      p0,
      c1: { x: p0.x + Math.max(span * 0.12, 18), y: p0.y - bow },
      c2: { x: p1.x - Math.max(span * 0.12, 18), y: p1.y - bow },
      p1
    }
  }

  if (kind === 'branch') {
    const below = target.y + target.h / 2 >= source.y + source.h / 2
    const p0 = getPortPoint(source, below ? 'bottom' : 'top')
    const p1 = getPortPoint(target, 'left')
    const lead = Math.max(Math.abs(p1.y - p0.y) * 0.55, 60)
    const run = Math.max(Math.abs(p1.x - p0.x) * 0.45, 52)
    return {
      p0,
      c1: { x: p0.x + Math.min(run * 0.25, 26), y: p0.y + (below ? lead : -lead) },
      c2: { x: p1.x - run, y: p1.y },
      p1
    }
  }

  const p0 = getPortPoint(source, 'right')
  const p1 = getPortPoint(target, 'left')
  const k = Math.max(Math.abs(dxRaw) * 0.5, Math.abs(dy) * 0.4, 48)
  return {
    p0,
    c1: { x: p0.x + k, y: p0.y },
    c2: { x: p1.x - k, y: p1.y },
    p1
  }
}

export function buildEdgePath(
  source: StoryNode,
  target: StoryNode,
  kind: EdgeKind = 'flow',
  opts: EdgePathOptions = {}
): string {
  return buildEdgeGeom(source, target, kind, opts).d
}

export function buildEdgeGeom(
  source: StoryNode,
  target: StoryNode,
  kind: EdgeKind = 'flow',
  opts: EdgePathOptions = {}
): EdgePath {
  const curve =
    opts.direction === 'horizontal'
      ? horizontalCurve(source, target, kind)
      : verticalCurve(source, target, kind)

  const { p0, c1, c2, p1 } = curve
  const d = `M ${fmt(p0.x)} ${fmt(p0.y)} C ${fmt(c1.x)} ${fmt(c1.y)}, ${fmt(c2.x)} ${fmt(
    c2.y
  )}, ${fmt(p1.x)} ${fmt(p1.y)}`

  return {
    d,
    start: p0,
    end: p1,
    mid: cubicPoint(p0, c1, c2, p1, 0.5),
    startAngle: cubicAngle(p0, c1, c2, p1, 0) + Math.PI,
    endAngle: cubicAngle(p0, c1, c2, p1, 1)
  }
}

/* ------------------------------------------------------------------ */
/* 包围盒 / 命中检测                                                    */
/* ------------------------------------------------------------------ */

export function nodeRect(node: StoryNode): Rect {
  return { x: node.x, y: node.y, w: node.w, h: node.h }
}

export function boundsOf(nodes: StoryNode[], padding = 80): Rect | null {
  if (!nodes.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    if (n.x < minX) minX = n.x
    if (n.y < minY) minY = n.y
    if (n.x + n.w > maxX) maxX = n.x + n.w
    if (n.y + n.h > maxY) maxY = n.y + n.h
  }
  return {
    x: minX - padding,
    y: minY - padding,
    w: maxX - minX + padding * 2,
    h: maxY - minY + padding * 2
  }
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y)
}

export function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
}

/** 屏幕坐标 → SVG 坐标（逆变换），拖拽必需 */
export function toSvgPoint(
  clientX: number,
  clientY: number,
  svgRect: { left: number; top: number; width: number; height: number },
  viewBox: Rect
): Point {
  const ratio = svgRect.width / viewBox.w || 1
  return {
    x: viewBox.x + (clientX - svgRect.left) / ratio,
    y: viewBox.y + (clientY - svgRect.top) / (svgRect.height / viewBox.h || 1)
  }
}

/** 网格吸附 */
export function snap(v: number, step: number): number {
  return Math.round(v / step) * step
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}
