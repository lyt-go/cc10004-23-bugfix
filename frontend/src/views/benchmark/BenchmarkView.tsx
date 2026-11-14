import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  resetFreezeDomain,
  runAction as applyAction,
} from '@/api/local-service'
import { displayBaseline, listFreezeTickets } from '@/api/freeze-service'
import type { EntryRow, FreezeTicket } from '@/data/types'
import { fmtDateTime, fmtPercent } from '@/utils/format'

const meta = moduleMeta('benchmark')
const columns = [
  '方案编号',
  '对标对象',
  '对比指标',
  '数据来源',
  '采集周期',
  '差距阈值',
]
const statuses = ['草稿', '方案评审中', '已启用', '已冻结']

export default function BenchmarkView() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const filterFields = useMemo(() => ['方案编号', '对标对象', '对比指标'], [])
  // 冻结单单独加载一次并按编号索引，列表不重复渲染凭据。
  const [ticketByCode, setTicketByCode] = useState<Map<string, FreezeTicket>>(new Map())

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
      const map = new Map<string, FreezeTicket>()
      for (const ticket of listFreezeTickets()) {
        if (ticket.status === '有效' && !map.has(ticket.benchmarkCode)) {
          map.set(ticket.benchmarkCode, ticket)
        }
      }
      setTicketByCode(map)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '竞品对标列表读取失败')
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
    { label: '对标方案总数', value: rows.length },
    { label: '已启用方案', value: rows.filter((row) => row.status === '已启用').length },
    { label: '方案评审中', value: rows.filter((row) => row.status === '方案评审中').length },
    { label: '已冻结方案', value: rows.filter((row) => row.status === '已冻结').length },
  ]

  return (
    <section className="page" data-module="benchmark">
      <header className="page-head">
        <div>
          <h2>竞品对标管理</h2>
          <p className="page-desc">对标方案通过评审后才能启用；冻结后基准值随冻结凭据固定，留存方案只读取冻结版本。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('对标方案登记入口尚未接入审批流')}>
            登记对标方案
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出竞品对标清单
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
            <th>当前基准值</th>
            <th>冻结基准值</th>
            <th>冻结单号 / 冻结时间</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const ticket = ticketByCode.get(String(row['方案编号']))
            const frozen = String(row.status) === '已冻结'
            return (
              <tr
                key={String(row.id)}
                className="clickable-row"
                onClick={() => navigate(`/benchmark/${encodeURIComponent(String(row['方案编号']))}`)}
              >
                {columns.map((column) => {
                  if (column === '差距阈值') {
                    return <td key={column}>{fmtPercent(row[column])}</td>
                  }
                  return <td key={column}>{row[column] ?? '—'}</td>
                })}
                {/* 当前基准值随对标详情变化；冻结后冻结基准值固定，两列分开展示避免“基准已更新”误读 */}
                <td>{fmtPercent(row['基准值'])}</td>
                <td>{frozen ? fmtPercent(displayBaseline(row)) : '—'}</td>
                <td>
                  {ticket ? (
                    <span>
                      {ticket.ticketNo}
                      <br />
                      <small>{fmtDateTime(ticket.frozenAt)}（{ticket.applicablePeriod}）</small>
                    </span>
                  ) : '—'}
                </td>
                <td>
                  <span className={`status-pill status-${frozen ? 'frozen' : 'normal'}`}>{row.status}</span>
                </td>
                <td className="row-actions" onClick={(event) => event.stopPropagation()}>
                  <button
                    className="link"
                    type="button"
                    onClick={() => runAction('提交方案评审', row)}
                  >
                    提交方案评审
                  </button>
                  <button
                    className="link"
                    type="button"
                    onClick={() => runAction('启用方案', row)}
                  >
                    启用方案
                  </button>
                  <button
                    className="link"
                    type="button"
                    title={frozen ? '再次冻结将进入复核，以首个冻结单号为准，不写留存' : undefined}
                    onClick={() => runAction('冻结方案', row)}
                  >
                    冻结方案
                  </button>
                </td>
              </tr>
            )
          })}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 5}>暂无竞品对标数据，可先登记对标方案</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条竞品对标记录（点击行查看对标详情）</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
        {!errorMessage && notice && <span className="notice-text">{notice}</span>}
      </footer>
    </section>
  )
}
