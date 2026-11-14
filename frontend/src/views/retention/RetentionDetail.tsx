import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import {
  activeVersion,
  confirmThresholdVersion,
  displayBaseline,
  getBenchmarkRow,
  getRetentionRow,
  listThresholdVersions,
  pendingVersions,
  proposeObservationDays,
  rejectThresholdVersion,
  retentionGap,
  winningTicket,
} from '@/api/freeze-service'
import type { EntryRow, FreezeTicket, ThresholdVersion } from '@/data/types'
import { fmtDateTime, fmtPercent } from '@/utils/format'

const infoFields = ['方案名称', '初始事件', '回访事件', '群组粒度', '关联产品', '关联对标']

export default function RetentionDetail() {
  const params = useParams<{ code: string }>()
  const code = decodeURIComponent(params.code ?? '')
  const navigate = useNavigate()
  const [row, setRow] = useState<EntryRow | null>(null)
  const [versions, setVersions] = useState<ThresholdVersion[]>([])
  const [daysInput, setDaysInput] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')

  const reload = useCallback(() => {
    setErrorMessage('')
    const current = getRetentionRow(code)
    if (!current) {
      setRow(null)
      setVersions([])
      return
    }
    setRow(current)
    setVersions(listThresholdVersions(code))
  }, [code])

  useEffect(() => {
    reload()
  }, [reload])

  const active = useMemo(() => activeVersion(code), [code, versions])
  const drafts = useMemo(() => pendingVersions(code), [code, versions])
  const ticket: FreezeTicket | undefined = useMemo(
    () => (row ? winningTicket(String(row['关联对标'] ?? '')) : undefined),
    [row, versions],
  )
  const benchmark = useMemo(
    () => (row ? getBenchmarkRow(String(row['关联对标'] ?? '')) : undefined),
    [row],
  )

  if (!row) {
    return (
      <section className="page detail-page">
        <p className="error-text">没有找到留存方案 {code}，可能已被重置。</p>
        <Link className="btn" to="/retention">返回留存列表</Link>
      </section>
    )
  }

  function submitDays() {
    setErrorMessage('')
    setNotice('')
    const days = Number(daysInput)
    if (!Number.isInteger(days) || days <= 0) {
      setErrorMessage('观察天数必须是正整数')
      return
    }
    const result = proposeObservationDays(code, days)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setDaysInput('')
    setNotice(result.message)
    reload()
  }

  function confirmVersion(versionId: number) {
    const result = confirmThresholdVersion(versionId)
    if (!result.ok) {
      setErrorMessage(result.message)
    } else {
      setNotice(result.message)
    }
    reload()
  }

  function rejectVersion(versionId: number) {
    const result = rejectThresholdVersion(versionId)
    if (!result.ok) {
      setErrorMessage(result.message)
    } else {
      setNotice(result.message)
    }
    reload()
  }

  const activeGap = active ? retentionGap(active) : null
  const linkedCode = String(row['关联对标'] ?? '')

  return (
    <section className="page detail-page" data-module="retention">
      <header className="page-head">
        <div>
          <h2>留存方案详情 · {code}</h2>
          <p className="page-desc">阈值按版本管理：已生效版本只读，调整观察天数只会生成新的待确认草案。</p>
        </div>
        <div className="page-actions">
          <button className="btn ghost" type="button" onClick={() => navigate('/retention')}>返回留存列表</button>
        </div>
      </header>

      <div className="detail-grid">
        <article className="detail-card">
          <h3>方案信息</h3>
          <dl className="detail-list">
            <div><dt>当前状态</dt><dd><span className="status-pill status-frozen">{row.status}</span></dd></div>
            {infoFields.map((field) => (
              <div key={field}>
                <dt>{field}</dt>
                <dd>
                  {field === '关联对标' && linkedCode ? (
                    <Link to={`/benchmark/${encodeURIComponent(linkedCode)}`}>{linkedCode}</Link>
                  ) : (row[field] ?? '—')}
                </dd>
              </div>
            ))}
            <div>
              <dt>当前观察天数</dt>
              <dd>{active ? `${active.observationDays} 天` : `${row['观察天数'] ?? '—'} 天`}</dd>
            </div>
            <div>
              <dt>已生效留存阈值</dt>
              <dd className="value-frozen">
                {active ? `${fmtPercent(active.threshold)}（v${active.version}，只读）` : '—'}
              </dd>
            </div>
            <div>
              <dt>冻结时间（随冻结凭据）</dt>
              <dd>{ticket ? fmtDateTime(ticket.frozenAt) : '—'}</dd>
            </div>
          </dl>
        </article>

        <article className="detail-card">
          <h3>冻结版本读取口径</h3>
          {ticket ? (
            <dl className="detail-list">
              <div><dt>冻结单号</dt><dd>{ticket.ticketNo}</dd></div>
              <div><dt>对比指标 / 适用周期</dt><dd>{ticket.frozenMetric} / {ticket.applicablePeriod}</dd></div>
              <div>
                <dt>冻结基准值（固定）</dt>
                <dd className="value-frozen">{fmtPercent(ticket.frozenBaseline)}</dd>
              </div>
              <div><dt>差距阈值快照</dt><dd>{fmtPercent(ticket.frozenGapThreshold)}</dd></div>
              <div><dt>冻结时间</dt><dd>{fmtDateTime(ticket.frozenAt)}</dd></div>
              {benchmark && String(benchmark.status) === '已冻结' && (
                <div>
                  <dt>对标当前基准值（不参与计算）</dt>
                  <dd className="value-live">{fmtPercent(benchmark['基准值'])}</dd>
                </div>
              )}
            </dl>
          ) : (
            <p className="empty-state">
              关联对标 {linkedCode || '（空）'} 尚无有效冻结凭据，留存方案暂无可读取的冻结版本。
            </p>
          )}
          {benchmark && (
            <p className="action-hint">
              列表展示基准：{fmtPercent(displayBaseline(benchmark))}；该值与本页冻结基准
              {ticket && displayBaseline(benchmark) === ticket.frozenBaseline ? '一致。' : '不同时以冻结凭据为准。'}
            </p>
          )}
        </article>
      </div>

      <article className="detail-card">
        <h3>调整观察天数（生成新阈值草案）</h3>
        <p className="page-desc">
          已启用方案改观察天数不会覆盖现行阈值：系统按冻结基准 {ticket ? fmtPercent(ticket.frozenBaseline) : '—'}
          与差距阈值 {ticket ? fmtPercent(ticket.frozenGapThreshold) : '—'} 派生新草案，待确认后才生效。
        </p>
        <div className="inline-form">
          <input
            aria-label="新观察天数"
            placeholder="输入新的观察天数，如 14"
            value={daysInput}
            onChange={(event) => setDaysInput(event.target.value)}
          />
          <button className="btn primary" type="button" disabled={String(row.status) !== '已启用'} onClick={submitDays}>
            生成待确认版本
          </button>
        </div>
        {drafts.length > 0 && (
          <p className="action-hint">
            当前已有 {drafts.length} 个待确认版本：{drafts.map((draft) => `v${draft.version}（${draft.observationDays}天/${fmtPercent(draft.threshold)}）`).join('、')}
          </p>
        )}
      </article>

      <article className="detail-card">
        <h3>阈值版本时间线</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>版本</th>
              <th>状态</th>
              <th>留存阈值</th>
              <th>冻结基准</th>
              <th>留存差距</th>
              <th>观察天数</th>
              <th>来源</th>
              <th>冻结单号</th>
              <th>冻结时间</th>
              <th>说明</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((version) => {
              const gap = retentionGap(version)
              return (
                <tr key={version.id}>
                  <td>v{version.version}</td>
                  <td><span className={`status-pill version-${version.status}`}>{version.status}</span></td>
                  <td className={version.status === '已生效' ? 'value-frozen' : ''}>{fmtPercent(version.threshold)}</td>
                  <td>{version.baseline === null ? '—' : fmtPercent(version.baseline)}</td>
                  <td>{gap === null ? '—' : fmtPercent(gap)}</td>
                  <td>{version.observationDays} 天</td>
                  <td>{version.source}</td>
                  <td>{version.freezeTicketNo ?? '—'}</td>
                  <td>{fmtDateTime(version.frozenAt)}</td>
                  <td>{version.reason}</td>
                  <td className="row-actions">
                    {version.status === '待确认' && (
                      <>
                        <button className="link" type="button" onClick={() => confirmVersion(version.id)}>确认生效</button>
                        <button className="link danger" type="button" onClick={() => rejectVersion(version.id)}>驳回</button>
                      </>
                    )}
                  </td>
                </tr>
              )
            })}
            {versions.length === 0 && (
              <tr><td className="empty-state" colSpan={11}>暂无阈值版本</td></tr>
            )}
          </tbody>
        </table>
        {active && (
          <p className="action-hint">
            当前已生效：v{active.version} 阈值 {fmtPercent(active.threshold)}
            {activeGap !== null ? `，留存差距 ${fmtPercent(activeGap)}` : ''}
            ；已生效版本与冻结时间不会被观察天数调整改动。
          </p>
        )}
      </article>

      <footer className="page-foot">
        {errorMessage && <span className="error-text">{errorMessage}</span>}
        {!errorMessage && notice && <span className="notice-text">{notice}</span>}
      </footer>
    </section>
  )
}
