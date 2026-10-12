/**
 * geometry.spec.ts —— 测试 core/geometry.ts 的端口锚点与贝塞尔连线
 */
import { describe, it, expect } from 'vitest'
import { createNode } from '@/core/model'
import { getPortPoint, buildEdgePath, buildEdgeGeom, PORT_GAP } from '@/core/geometry'

describe('getPortPoint · 端口锚点坐标', () => {
  const node = createNode({ x: 100, y: 200, w: 268, h: 132 })

  it('top：上边中心，y 向外探 PORT_GAP', () => {
    expect(getPortPoint(node, 'top')).toEqual({ x: 100 + 268 / 2, y: 200 - PORT_GAP })
  })

  it('bottom：下边中心，y 向外探 PORT_GAP', () => {
    expect(getPortPoint(node, 'bottom')).toEqual({ x: 100 + 268 / 2, y: 200 + 132 + PORT_GAP })
  })

  it('left：左边中心，x 向外探 PORT_GAP', () => {
    expect(getPortPoint(node, 'left')).toEqual({ x: 100 - PORT_GAP, y: 200 + 132 / 2 })
  })

  it('right：右边中心，x 向外探 PORT_GAP', () => {
    expect(getPortPoint(node, 'right')).toEqual({ x: 100 + 268 + PORT_GAP, y: 200 + 132 / 2 })
  })
})

describe('buildEdgePath / buildEdgeGeom · 三次贝塞尔连线', () => {
  const source = createNode({ x: 0, y: 0, w: 268, h: 132, lane: 0 })
  const target = createNode({ x: 0, y: 400, w: 268, h: 132, lane: 0 })

  it('返回的 path d 以 M 开头且包含 C（三次贝塞尔）', () => {
    const d = buildEdgePath(source, target, 'flow')
    expect(typeof d).toBe('string')
    expect(d.startsWith('M')).toBe(true)
    expect(d).toContain('C')
  })

  it('四种 kind（flow/branch/flashback/jump）均生成含 C 的贝塞尔', () => {
    for (const kind of ['flow', 'branch', 'flashback', 'jump'] as const) {
      const d = buildEdgePath(source, target, kind)
      expect(d.startsWith('M')).toBe(true)
      expect(d).toContain('C')
    }
  })

  it('buildEdgeGeom 的 start/end 与两端 port 严格对应', () => {
    const geom = buildEdgeGeom(source, target, 'flow')
    expect(geom.start).toEqual(getPortPoint(source, 'bottom'))
    expect(geom.end).toEqual(getPortPoint(target, 'top'))
  })
})
