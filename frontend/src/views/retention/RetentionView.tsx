import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  resetFreezeDomain,
  runAction as applyAction,
} from '@/api/local-service'
import {
  activeVersion,
  displayRetentionThreshold,
  listThresholdVersions,
  pendingVersions,
  retentionGap,
  winningTicket,
} from '@/api/freeze-service'
import type { EntryRow, ThresholdVersion } from '@/data/types'
import { fmtPercent } from '@/utils/format'

const meta = moduleMeta('retention')
const columns = [
  '方案编号',
  '方案名称',
  '初始事件',
  '回访事件',
  '群组粒度',
  '关联产品',
  '关联对标',
]
const statuses = ['草稿', '方案评审中', '已启用', '已归档']

export default function RetentionView() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [versionMap, setVersionMap] = useState<Map<string, ThresholdVersion[]>>(new Map())
  const filterFields = useMemo(() => ['方案编号', '方案名称', '关联产品'], [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
      const map = new Map<string, ThresholdVersion[]>()
      for (const version of listThresholdVersions()) {
        const list = map.get(version.retentionCode) ?? []
        list.push(version)
        map.set(version.retentionCode, list)
      }
      setVersionMap(map)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '留存分析列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    setNotice('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setNotice(result.message)
    reload()
  }

  function resetDomain() {
    setErrorMessage('')
    resetFreezeDomain()
    setNotice('对标与留存写入边界数据已重置为播种态')
    reload()
  }

  const stats = [
    { label: '留存方案总数', value: rows.length },
    { label: '已启用方案', value: rows.filter((row) => row.status === '已启用').length },
    { label: '方案评审中', value: rows.filter((row) => row.status === '方案评审中').length },
    { label: '待确认阈值版本', value: rows.reduce((sum, row) => sum + pendingVersions(String(row['方案编号'])).length, 0) },
  ]

  return (
    <section className="page" data-module="retention">
      <header className="page-head">
        <div>
          <h2>留存分析管理</h2>
          <p className="page-desc">留存方案只读取对标冻结版本；新阈值必须形成待确认版本，已生效阈值与冻结时间不被原地修改。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('留存方案登记入口尚未接入审批流')}>
            登记留存方案
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出留存分析清单
          </button>
          <button className="btn ghost" type="button" onClick={resetDomain}>
            重置边界数据
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <p className="status-legend">
        {statuses.map((status) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>观察天数</th>
            <th>已生效阈值</th>
            <th>冻结基准 / 留存差距</th>
            <th>待确认草案</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const code = String(row['方案编号'])
            const versions = versionMap.get(code) ?? []
            const active = activeVersion(code)
            const ticket = winningTicket(String(row['关联对标'] ?? ''))
            const drafts = pendingVersions(code)
            const gap = active ? retentionGap(active) : null
            return (
              <tr
                key={String(row.id)}
                className="clickable-row"
                onClick={() => navigate(`/retention/${encodeURIComponent(code)}`)}
              >
                {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
                <td>{active ? `${active.observationDays} 天` : `${row['观察天数'] ?? '—'} 天`}</td>
                {/* 阈值只认已生效版本，避免残留冻结前/被替代的阈值 */}
                <td className="value-frozen">{fmtPercent(displayRetentionThreshold(row))}</td>
                <td>
                  {ticket ? (
                    <span>
                      {fmtPercent(ticket.frozenBaseline)}
                      <br />
                      <small>差距 {gap === null ? '—' : fmtPercent(gap)}</small>
                    </span>
                  ) : '—'}
                </td>
                <td>
                  {drafts.length > 0 ? (
                    drafts.map((draft) => (
                      <span key={draft.id} className="draft-chip">
                        v{draft.version}：{fmtPercent(draft.threshold)}（{draft.observationDays}天）
                      </span>
                    ))
                  ) : '—'}
                </td>
                <td><span className={`status-pill status-${row.status === '已启用' ? 'frozen' : 'normal'}`}>{row.status}</span></td>
                <td className="row-actions" onClick={(event) => event.stopPropagation()}>
                  <button className="link" type="button" onClick={() => runAction('提交方案评审', row)}>
                    提交方案评审
                  </button>
                  <button className="link" type="button" onClick={() => runAction('启用方案', row)}>
                    启用方案
                  </button>
                  <button className="link" type="button" onClick={() => runAction('归档方案', row)}>
                    归档方案
                  </button>
                </td>
              </tr>
            )
          })}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 5}>暂无留存分析数据，可先登记留存方案</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条留存分析记录（点击行查看留存详情与版本）</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
        {!errorMessage && notice && <span className="notice-text">{notice}</span>}
      </footer>
    </section>
  )
}
