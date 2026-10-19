import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { checkGraph, type ConsistencyReport, type ConsistencyIssue } from '@/core/consistency'
import { useFlowStore } from './useFlowStore'
import type { FlowGraph } from '@/types/graph'

/**
 * 时间线一致性检查的**共享快照**。
 *
 * 为什么单独成 store 而不是各组件各算一份：ControlCenter 写（打开面板 / 点「重新检查」）、
 * StoryNode 画布角标与 NodeInspector 检查器读（issuesFor / byNode），三处必须看到
 * **同一份报告** —— 各算一份会出现「面板说没问题、角标说有」的分裂，用户无法信任任何一处。
 * 且检查是 O(n+e) 纯计算，共享快照 = 一次计算多处消费，不增加额外成本。
 *
 * 触发时机刻意放在 UI 层（打开控制中心 / 点重新检查），不在此处 watch 图数据：
 * persist 是 260ms 防抖、检查器文本字段还有 300ms 防抖，跟着数据自动重算会在打字期间
 * 反复重算并让列表抖动。
 */
export const useConsistencyStore = defineStore('consistency', () => {
  const flow = useFlowStore()

  /** 最近一次检查报告；`null` = 本会话还没跑过。刻意不做数据 watch 自动重算（防抖期间会反复重算） */
  const report = ref<ConsistencyReport | null>(null)

  /** nodeId → 该节点问题（查表用；报告为空时是空对象） */
  const byNode = computed<Record<string, ConsistencyIssue[]>>(() => report.value?.byNode ?? {})

  /** 现算一次；缺省对当前活动图 */
  function runCheck(graph?: FlowGraph): void {
    report.value = checkGraph(graph ?? flow.activeGraph)
  }

  /** 单节点问题（画布角标 / 检查器读它；没有报告返回空数组） */
  function issuesFor(nodeId: string): ConsistencyIssue[] {
    return report.value?.byNode[nodeId] ?? []
  }

  return { report, byNode, runCheck, issuesFor }
})
