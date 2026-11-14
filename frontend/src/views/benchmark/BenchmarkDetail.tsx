import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { runAction as applyAction } from '@/api/local-service'
import {
  confirmThresholdVersion,
  displayBaseline,
  freezeBenchmark,
  getBenchmarkRow,
  getRetentionRow,
  listFreezeTickets,
  listThresholdVersions,
  rejectThresholdVersion,
  retentionGap,
  updateBenchmarkBaseline,
} from '@/api/freeze-service'
import type { EntryRow, FreezeTicket, ThresholdVersion } from '@/data/types'
import { fmtDateTime, fmtPercent, parsePercentInput } from '@/utils/format'

const infoFields = ['对标对象', '对比指标', '数据来源', '采集周期', '目标值', '差距阈值']

export default function BenchmarkDetail() {
  const params = useParams<{ code: string }>()
  const code = decodeURIComponent(params.code ?? '')
  const navigate = useNavigate()
  const [row, setRow] = useState<EntryRow | null>(null)
  const [tickets, setTickets] = useState<FreezeTicket[]>([])
  const [linked, setLinked] = useState<{ retention: EntryRow; versions: ThresholdVersion[] }[]>([])
  const [baselineInput, setBaselineInput] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')

  const reload = useCallback(() => {
    setErrorMessage('')
    const current = getBenchmarkRow(code)
    if (!current) {
      setRow(null)
      return
    }
    setRow(current)
    setTickets(listFreezeTickets(code))
    const links = listThresholdVersions()
      .filter((version) => {
        const retention = getRetentionRow(version.retentionCode)
        return retention && String(retention['关联对标'] ?? '') === code
      })
      .reduce<Map<string, ThresholdVersion[]>>((map, version) => {
        const list = map.get(version.retentionCode) ?? []
        list.push(version)
        map.set(version.retentionCode, list)
        return map
      }, new Map())
    setLinked(
      [...links.entries()].map(([retentionCode, versions]) => ({
        retention: getRetentionRow(retentionCode) as EntryRow,
        versions,
      })),
    )
  }, [code])

  useEffect(() => {
    reload()
  }, [reload])

  const winning = useMemo(() => tickets.find((ticket) => ticket.status === '有效' && ticket.winning), [tickets])
  const reviews = useMemo(() => tickets.filter((ticket) => ticket.status === '复核中'), [tickets])
  const frozen = row ? String(row.status) === '已冻结' : false

  if (!row) {
    return (
      <section className="page detail-page">
        <p className="error-text">没有找到对标方案 {code}，可能已被重置。</p>
        <Link className="btn" to="/benchmark">返回对标列表</Link>
      </section>
    )
  }

  function freeze() {
    setErrorMessage('')
    setNotice('')
    const result = freezeBenchmark(code)
    if (!result.ok) {
      setErrorMessage(result.message)
    } else {
      setNotice(result.message)
    }
    reload()
  }

  function generic(action: string) {
    setErrorMessage('')
    setNotice('')
    const result = applyAction('benchmark', Number(row!.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
    } else {
      setNotice(result.message)
    }
    reload()
  }

  function saveBaseline() {
    setErrorMessage('')
    setNotice('')
    const value = parsePercentInput(baselineInput)
    if (value === null) {
      setErrorMessage('基准值格式不正确，请输入 0 ~ 100 的百分比（如 45 或 0.45）')
      return
    }
    const result = updateBenchmarkBaseline(code, value)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setBaselineInput('')
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

  return (
    <section className="page detail-page" data-module="benchmark">
      <header className="page-head">
        <div>
          <h2>对标方案详情 · {code}</h2>
          <p className="page-desc">冻结凭据是留存方案的唯一读取来源；冻结后修改基准值只影响当前值，不影响冻结版本。</p>
        </div>
        <div className="page-actions">
          <button className="btn ghost" type="button" onClick={() => navigate('/benchmark')}>返回对标列表</button>
        </div>
      </header>

      <div className="detail-grid">
        <article className="detail-card">
          <h3>对标详情</h3>
          <dl className="detail-list">
            <div><dt>当前状态</dt><dd><span className={`status-pill status-${frozen ? 'frozen' : 'normal'}`}>{row.status}</span></dd></div>
            {infoFields.map((field) => (
              <div key={field}>
                <dt>{field}</dt>
                <dd>{field === '目标值' || field === '差距阈值' ? fmtPercent(row[field]) : (row[field] ?? '—')}</dd>
              </div>
            ))}
            <div>
              <dt>当前基准值</dt>
              <dd className={frozen ? 'value-live' : ''}>{fmtPercent(row['基准值'])}（随对标详情变化）</dd>
            </div>
            <div>
              <dt>冻结基准值</dt>
              <dd className="value-frozen">
                {frozen ? `${fmtPercent(displayBaseline(row))}（随冻结凭据固定）` : '—'}
              </dd>
            </div>
          </dl>
          <div className="detail-actions">
            <button className="btn" type="button" disabled={String(row.status) !== '草稿'} onClick={() => generic('提交方案评审')}>
              提交方案评审
            </button>
            <button className="btn" type="button" disabled={String(row.status) !== '方案评审中'} onClick={() => generic('启用方案')}>
              启用方案
            </button>
            <button className="btn primary" type="button" title={frozen ? '再次冻结将进入复核，以首个冻结单号为准，不写留存' : undefined} onClick={freeze}>
              {frozen ? '再次冻结（进入复核）' : '冻结方案'}
            </button>
          </div>
          <p className="action-hint">
            {String(row.status) === '草稿' && '下一步：提交方案评审，评审通过后才能启用。'}
            {String(row.status) === '方案评审中' && '下一步：启用方案，已启用的对标方案才允许冻结。'}
            {String(row.status) === '已启用' && '下一步：冻结方案。冻结会同时生成冻结凭据与关联留存的待确认阈值草案。'}
            {frozen && '方案已冻结：冻结凭据不再变化，再次发起冻结将进入复核且不写留存。'}
          </p>
        </article>

        <article className="detail-card">
          <h3>更新当前基准值</h3>
          <p className="page-desc">用于验证冻结边界：已冻结方案修改这里，冻结基准值与留存阈值保持不变。</p>
          <div className="inline-form">
            <input
              aria-label="新基准值"
              placeholder="输入百分比，如 45 或 0.45"
              value={baselineInput}
              onChange={(event) => setBaselineInput(event.target.value)}
            />
            <button className="btn primary" type="button" onClick={saveBaseline}>保存当前基准值</button>
          </div>
          <dl className="detail-list">
            <div>
              <dt>当前值 / 冻结值</dt>
              <dd>
                <span className="value-live">{fmtPercent(row['基准值'])}</span>
                <span> / </span>
                <span className="value-frozen">{frozen ? fmtPercent(displayBaseline(row)) : '—'}</span>
              </dd>
            </div>
          </dl>
        </article>
      </div>

      <article className="detail-card">
        <h3>冻结凭据</h3>
        {winning ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>冻结单号</th>
                <th>冻结基准值</th>
                <th>差距阈值</th>
                <th>对比指标</th>
                <th>适用周期</th>
                <th>冻结时间</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              <tr key={winning.id}>
                <td>{winning.ticketNo}</td>
                <td className="value-frozen">{fmtPercent(winning.frozenBaseline)}</td>
                <td>{fmtPercent(winning.frozenGapThreshold)}</td>
                <td>{winning.frozenMetric}</td>
                <td>{winning.applicablePeriod}</td>
                <td>{fmtDateTime(winning.frozenAt)}</td>
                <td><span className="status-pill status-frozen">{winning.status}（首单为准）</span></td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p className="empty-state">尚未生成有效冻结凭据。</p>
        )}
        {reviews.length > 0 && (
          <>
            <h4 className="sub-title">复核中的相撞请求（未写入留存阈值）</h4>
            <table className="data-table">
              <thead>
                <tr>
                  <th>冻结单号</th>
                  <th>请求基准值</th>
                  <th>适用周期</th>
                  <th>请求时间</th>
                  <th>指向首单</th>
                  <th>相撞原因</th>
                </tr>
              </thead>
              <tbody>
                {reviews.map((ticket) => (
                  <tr key={ticket.id}>
                    <td>{ticket.ticketNo}</td>
                    <td>{fmtPercent(ticket.frozenBaseline)}</td>
                    <td>{ticket.applicablePeriod}</td>
                    <td>{fmtDateTime(ticket.frozenAt)}</td>
                    <td>{ticket.relatedTicketNo ?? '—'}</td>
                    <td>{ticket.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </article>

      <article className="detail-card">
        <h3>关联留存方案的阈值版本</h3>
        {linked.length === 0 ? (
          <p className="empty-state">当前没有留存方案关联本对标。</p>
        ) : (
          linked.map(({ retention, versions }) => (
            <div key={String(retention.id)} className="version-block">
              <h4 className="sub-title">
                <Link to={`/retention/${encodeURIComponent(String(retention['方案编号']))}`}>
                  {retention['方案编号']} · {retention['方案名称']}
                </Link>
              </h4>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>版本</th>
                    <th>状态</th>
                    <th>阈值</th>
                    <th>冻结基准</th>
                    <th>留存差距</th>
                    <th>观察天数</th>
                    <th>来源</th>
                    <th>冻结单号/冻结时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.map((version) => (
                    <tr key={version.id}>
                      <td>v{version.version}</td>
                      <td><span className={`status-pill version-${version.status}`}>{version.status}</span></td>
                      <td>{fmtPercent(version.threshold)}</td>
                      <td>{version.baseline === null ? '—' : fmtPercent(version.baseline)}</td>
                      <td>{retentionGap(version) === null ? '—' : fmtPercent(retentionGap(version))}</td>
                      <td>{version.observationDays} 天</td>
                      <td>{version.source}</td>
                      <td>
                        {version.freezeTicketNo ? (
                          <span>{version.freezeTicketNo}<br /><small>{fmtDateTime(version.frozenAt)}</small></span>
                        ) : '—'}
                      </td>
                      <td className="row-actions">
                        {version.status === '待确认' && (
                          <>
                            <button className="link" type="button" onClick={() => confirmVersion(version.id)}>确认生效</button>
                            <button className="link danger" type="button" onClick={() => rejectVersion(version.id)}>驳回</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))
        )}
      </article>

      <footer className="page-foot">
        {errorMessage && <span className="error-text">{errorMessage}</span>}
        {!errorMessage && notice && <span className="notice-text">{notice}</span>}
      </footer>
    </section>
  )
}
