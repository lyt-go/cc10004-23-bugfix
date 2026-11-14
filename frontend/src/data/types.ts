/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 冻结单状态：有效=首个冻结凭据；复核中=相撞后等待人工复核，不参与留存写入。 */
export type FreezeTicketStatus = '有效' | '复核中'

/**
 * 对标冻结凭据：冻结动作发生时快照对标详情，基准值随凭据固定，
 * 之后对标详情怎么改都不会影响这张凭据上的基准。
 */
export type FreezeTicket = {
  id: number
  /** 冻结单号，例如 FROZ-0001 */
  ticketNo: string
  benchmarkCode: string
  status: FreezeTicketStatus
  /** 是否为首单（首单对应的版本为准） */
  winning: boolean
  /** 冻结时点固定下来的基准值（小数，0.42 表示 42%） */
  frozenBaseline: number
  /** 冻结时点固定下来的差距阈值 */
  frozenGapThreshold: number
  /** 冻结时点的对比指标，例如 7日留存率 */
  frozenMetric: string
  /** 采集周期快照，例如 月度 */
  collectCycle: string
  /** 对比指标适用周期：采集周期为月度时取冻结当月，例如 2026-11 */
  applicablePeriod: string
  /** 冻结时点（ISO 字符串），留存侧引用后不再变化 */
  frozenAt: string
  /** 相撞时指向首个冻结单号 */
  relatedTicketNo: string | null
  note: string
}

/** 留存阈值版本状态：待确认草案、已生效、被新版本替代、已驳回。 */
export type ThresholdVersionStatus = '待确认' | '已生效' | '已失效' | '已驳回'

export type ThresholdVersionSource = '手工设定' | '冻结单' | '观察天数调整'

/**
 * 留存阈值版本：留存方案只保存版本化的阈值，已生效版本不允许原地修改，
 * 任何新阈值都必须形成新的待确认版本，确认后旧版本转为已失效并保留历史。
 */
export type ThresholdVersion = {
  id: number
  retentionCode: string
  version: number
  status: ThresholdVersionStatus
  /** 阈值（小数，0.38 表示 38%） */
  threshold: number
  /** 推导该版本所用的冻结基准值快照；手工设定版本为 null */
  baseline: number | null
  /** 留存差距快照 = 基准值 - 阈值；手工设定版本为 null */
  gap: number | null
  /** 该版本对应的观察天数 */
  observationDays: number
  source: ThresholdVersionSource
  /** 关联冻结单号，留存侧只通过它读取冻结版本 */
  freezeTicketNo: string | null
  /** 冻结时点副本：与冻结单保持一致，不随后续编辑变化 */
  frozenAt: string | null
  /** 对比指标适用周期副本 */
  applicablePeriod: string | null
  reason: string
  createdAt: string
}
