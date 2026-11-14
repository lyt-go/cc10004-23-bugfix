import { MODULE_BY_KEY } from '@/data/modules'
import { SEED_ALL } from '@/data/seed'
import { allRows, listRows, resetRows, saveMany, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult, ThresholdVersion } from '@/data/types'
import { freezeBenchmark } from './freeze-service'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 写入边界相关的四个聚合，重置时一起回到播种态。
const FREEZE_DOMAIN_KEYS = ['benchmark', 'retention', 'freezeTickets', 'thresholdVersions']

// 评审门禁：只有列出的源状态才允许执行该动作，未列出的动作沿用通用顺序流转。
const TRANSITION_GUARDS: Record<string, Record<string, string[]>> = {
  benchmark: {
    提交方案评审: ['草稿'],
    启用方案: ['方案评审中'],
    冻结方案: ['已启用'],
  },
  retention: {
    提交方案评审: ['草稿'],
    启用方案: ['方案评审中'],
    归档方案: ['已启用'],
  },
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }

  // 冻结是跨聚合写事务，交给冻结领域服务统一收口（含连续冻结/相撞复核）。
  if (key === 'benchmark' && action === '冻结方案') {
    return freezeBenchmark(id)
  }

  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  // 评审门禁：对标/留存必须按 草稿 -> 评审中 -> 已启用 的顺序推进。
  const allowedFrom = TRANSITION_GUARDS[key]?.[action]
  if (allowedFrom && !allowedFrom.includes(current)) {
    return {
      ok: false,
      message: `${meta.entity}当前为「${current}」，「${action}」仅允许在「${allowedFrom.join('、')}」状态执行`,
    }
  }

  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }

  // 留存方案首次启用时，按当前阈值/观察天数登记一版手工设定的已生效版本，
  // 之后阈值只能通过版本机制演进，方案行不再是阈值的唯一事实来源。
  if (key === 'retention' && action === '启用方案') {
    const allThresholdVersions = (allRows().thresholdVersions as ThresholdVersion[] | undefined) ?? []
    const mine = allThresholdVersions.filter(
      (version) => version.retentionCode === String(updated['方案编号']),
    )
    if (!mine.some((version) => version.status === '已生效')) {
      const threshold = Number(updated['留存阈值'])
      const observationDays = Number(updated['观察天数'])
      const nextVersion: ThresholdVersion = {
        // id 必须在全量版本上递增，只按本方案过滤会和其它方案的版本撞 id。
        id: allThresholdVersions.reduce((max, version) => Math.max(max, version.id), 0) + 1,
        retentionCode: String(updated['方案编号']),
        version: mine.reduce((max, version) => Math.max(max, version.version), 0) + 1,
        status: '已生效',
        threshold: Number.isFinite(threshold) ? threshold : 0,
        baseline: null,
        gap: null,
        observationDays: Number.isFinite(observationDays) ? observationDays : 0,
        source: '手工设定',
        freezeTicketNo: null,
        frozenAt: null,
        applicablePeriod: null,
        reason: '方案启用时登记的初始阈值版本',
        createdAt: new Date().toISOString(),
      }
      const next = [...rows]
      next[index] = updated
      try {
        saveMany({
          [key]: next,
          thresholdVersions: [...allThresholdVersions, nextVersion],
        })
      } catch {
        return { ok: false, message: '留存方案启用写入失败，已整体退回' }
      }
      return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」，并登记初始阈值版本 v${nextVersion.version}` }
    }
  }

  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

/** 重置对标-留存写入边界涉及的四个聚合，保证重新演示时没有残留数据。 */
export function resetFreezeDomain(): PageResult {
  const patches: Record<string, unknown[]> = {}
  for (const domainKey of FREEZE_DOMAIN_KEYS) {
    patches[domainKey] = JSON.parse(JSON.stringify(SEED_ALL[domainKey] ?? []))
  }
  saveMany(patches)
  return listEntries('benchmark')
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = (rows[meta.key] as EntryRow[] | undefined) ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
