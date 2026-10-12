import type { FlowGraph } from '@/types/graph'
import { deepClone } from './model'

/**
 * 撤销 / 重做栈
 *
 * - 容量 60（≥50 的红线要求）
 * - 存深快照，不存 diff：图规模在千节点以内时，JSON 深拷贝开销远低于维护双向 patch 的复杂度，
 *   且撤销结果绝对可复现（diff 路线在批量操作下极易算错逆操作）
 * - 节流合并：同一个 key（如 drag:nodeId）在 400ms 内的连续提交只留一条记录，
 *   拖动过程因此不会产生上百条历史
 */

export const HISTORY_LIMIT = 60
export const MERGE_WINDOW = 400

interface Snapshot {
  graph: FlowGraph
  label: string
  key: string
  at: number
}

export class HistoryStack {
  private past: Snapshot[] = []
  private future: Snapshot[] = []
  private lastKey = ''
  private lastAt = 0

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  get depth(): number {
    return this.past.length
  }

  reset(): void {
    this.past = []
    this.future = []
    this.lastKey = ''
    this.lastAt = 0
  }

  /**
   * 提交一次变更前的快照。
   * @param graph 变更「前」的图（调用方负责传变更前状态）
   * @param label 人类可读标签，便于调试
   * @param mergeKey 同 key 且在时间窗内 ⇒ 合并（只保留最早那条）
   */
  push(graph: FlowGraph, label = 'edit', mergeKey = ''): void {
    const now = Date.now()
    const snap: Snapshot = { graph: deepClone(graph), label, key: mergeKey, at: now }
    if (mergeKey && mergeKey === this.lastKey && now - this.lastAt < MERGE_WINDOW) {
      this.lastAt = now
      this.future = []
      return
    }
    this.past.push(snap)
    if (this.past.length > HISTORY_LIMIT) this.past.shift()
    this.future = []
    this.lastKey = mergeKey
    this.lastAt = now
  }

  undo(current: FlowGraph): FlowGraph | null {
    const snap = this.past.pop()
    if (!snap) return null
    this.future.push({ graph: deepClone(current), label: snap.label, key: snap.key, at: Date.now() })
    this.lastKey = ''
    this.lastAt = 0
    return snap.graph
  }

  redo(current: FlowGraph): FlowGraph | null {
    const snap = this.future.pop()
    if (!snap) return null
    this.past.push({ graph: deepClone(current), label: snap.label, key: snap.key, at: Date.now() })
    if (this.past.length > HISTORY_LIMIT) this.past.shift()
    this.lastKey = ''
    this.lastAt = 0
    return snap.graph
  }

  /** 供 UI 显示：下一条可撤销的操作名 */
  peekLabel(): string {
    return this.past[this.past.length - 1]?.label ?? ''
  }
}

export const history = new HistoryStack()
