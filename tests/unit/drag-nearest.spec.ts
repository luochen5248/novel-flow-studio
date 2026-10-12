/**
 * drag-nearest.spec.ts —— 「带距离容差的最近邻查找」契约测试
 *
 * 与 FlowCanvas.vue 的 hitNode() 不同：hitNode 要求指针落在矩形内；最近的邻算法要允许
 * 「指针在卡片之间 / 边缘外一点」按距离命中。
 *
 * ✅ 已落地：Max-C 已把这套算法抽成纯模块并 export —— src/components/canvas/snap.ts
 *    （零语义变更搬迁，FlowCanvas.vue 已改为 import 复用并删掉本地私有定义）。
 *    落点选 canvas/ 而非 core/ 是为遵守本轮 allowed scope、不侵入 core，属合理取舍。
 *
 * 约定签名（对齐 FlowCanvas.vue 现有实现语义）：
 *   nearestNode(px, py, nodes, opts?: { excludeId?, tolerance?, accept? }): StoryNode | null
 *   - 距离 = 点到矩形最短距离 distToRect（落在矩形内为 0）；px/py 与 nodes 同为 SVG(世界)坐标；
 *   - 默认容差 tolerance = SNAP_RADIUS(120)，命中条件为严格 d < tolerance（等于则不命中）；
 *   - 跳过 excludeId 指定节点与 accept 判定为假的节点；返回最近命中，否则 null。
 *   - client→svg 的缩放换算由调用方（viewport）负责，函数本身与缩放无关。
 */
import { describe, it, expect } from 'vitest'
import * as snap from '@/components/canvas/snap'
import { createNode } from '@/core/model'
import type { StoryNode } from '@/types/graph'

interface NearestOpts {
  excludeId?: string
  tolerance?: number
  accept?: (n: StoryNode) => boolean
}
type NearestFn = (
  px: number,
  py: number,
  nodes: StoryNode[],
  opts?: NearestOpts
) => StoryNode | null

// 绑定到抽出的纯模块（保持 namespace 取值：静态 import 不存在的导出会让整个文件加载失败）
const nearestNode = (snap as unknown as { nearestNode?: NearestFn }).nearestNode

// 直接引用模块常量，避免测试里硬编码 120 与实现漂移
const SNAP_RADIUS = snap.SNAP_RADIUS

function rect(id: string, x: number, y: number, w = 100, h = 50, kind: StoryNode['kind'] = 'event') {
  return createNode({ id, x, y, w, h, kind })
}

describe('nearestNode · 最近邻吸附契约', () => {
  it('契约：nearestNode 已抽成可导入的纯函数（snap.ts）', () => {
    expect(typeof nearestNode).toBe('function')
  })

  it('指针在两卡之间 → 取更近的那张', () => {
    const a = rect('a', 0, 0) // x 0..100
    const b = rect('b', 200, 0) // x 200..300
    // p=(160,25)：距 a 右边缘 60，距 b 左边缘 40 → b 更近
    expect(nearestNode!(160, 25, [a, b], { tolerance: SNAP_RADIUS })!.id).toBe('b')
    // p=(120,25)：距 a 20，距 b 80 → a 更近
    expect(nearestNode!(120, 25, [a, b], { tolerance: SNAP_RADIUS })!.id).toBe('a')
  })

  it('指针落在矩形内部 → 距离为 0，命中', () => {
    const a = rect('a', 0, 0)
    expect(nearestNode!(50, 25, [a], { tolerance: SNAP_RADIUS })!.id).toBe('a')
  })

  it('超出容差 → null；恰好等于容差 → null（严格小于）；容差内 → 命中', () => {
    const a = rect('a', 0, 0) // x 0..100
    // p 距 a 右边缘 121 > 120 → null
    expect(nearestNode!(221, 25, [a], { tolerance: SNAP_RADIUS })).toBeNull()
    // 恰好 120：严格 d < 120 不成立 → null
    expect(nearestNode!(220, 25, [a], { tolerance: SNAP_RADIUS })).toBeNull()
    // 119 < 120 → 命中
    expect(nearestNode!(219, 25, [a], { tolerance: SNAP_RADIUS })!.id).toBe('a')
  })

  it('excludeId 排除自身；accept 过滤类型', () => {
    const a = rect('a', 0, 0)
    const b = rect('b', 200, 0)
    // p=(160,25)：a 距 60，b 距 40
    expect(nearestNode!(160, 25, [a, b], { tolerance: SNAP_RADIUS, excludeId: 'b' })!.id).toBe('a')
    expect(nearestNode!(160, 25, [a, b], { tolerance: SNAP_RADIUS, excludeId: 'a' })!.id).toBe('b')

    // accept 只接受 event → 过滤掉 scene（b 改为 scene 类型）
    const s = rect('s', 200, 0, 100, 50, 'scene')
    expect(
      nearestNode!(160, 25, [a, s], { tolerance: SNAP_RADIUS, accept: (n) => n.kind === 'event' })!.id
    ).toBe('a')
  })

  it('distToRect：矩形内为 0；四边外为最短边距；角落为斜距', () => {
    const a = rect('a', 0, 0, 100, 50)
    // 内部（含边界上）→ 0
    expect(snap.distToRect(50, 25, a)).toBe(0)
    expect(snap.distToRect(0, 0, a)).toBe(0)
    // 正右方 → 只算 x 方向边距
    expect(snap.distToRect(130, 25, a)).toBe(30)
    // 正下方 → 只算 y 方向边距
    expect(snap.distToRect(50, 80, a)).toBe(30)
    // 右下角外 → 斜距 hypot(30,30)
    expect(snap.distToRect(130, 80, a)).toBeCloseTo(Math.hypot(30, 30), 6)
  })

  it('缩放一致性：世界整体缩放、容差同比缩放 → 命中结果不变', () => {
    // 距离按 SVG 空间线性计算，未混用屏幕像素；client→svg 的缩放换算由调用方负责。
    for (const s of [1, 2, 0.5]) {
      const a = rect('a', 0, 0, 100 * s, 50 * s)
      const b = rect('b', 200 * s, 0, 100 * s, 50 * s)
      expect(nearestNode!(160 * s, 25 * s, [a, b], { tolerance: SNAP_RADIUS * s })!.id).toBe('b')
      expect(nearestNode!(120 * s, 25 * s, [a, b], { tolerance: SNAP_RADIUS * s })!.id).toBe('a')
    }
  })
})
