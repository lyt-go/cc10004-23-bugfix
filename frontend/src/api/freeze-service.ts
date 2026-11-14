import { listCollection, listRows, saveMany } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  FreezeTicket,
  ThresholdVersion,
} from '@/data/types'
import { computeGap, round4 } from '@/utils/format'

/**
 * 冻结对标 -> 留存方案 的写入边界收口。
 *
 * 边界规则：
 * 1. 对标方案通过评审（草稿 -> 方案评审中 -> 已启用）后才能冻结；
 * 2. 冻结时把基准值、差距阈值、对比指标、采集周期、冻结时点快照进冻结凭据，
 *    之后对标详情再怎么改，凭据上的基准值都不动；
 * 3. 留存方案只通过冻结单号读取冻结版本，且任何新阈值都只能生成新的待确认版本，
 *    已生效版本不允许原地修改；
 * 4. 连续冻结 / 两版更新相撞：以首个冻结单号对应的版本为准，后到的请求只生成
 *    「复核中」冻结单，不写留存阈值；
 * 5. 冻结记录与留存阈值版本通过 saveMany 一次提交，持久化失败整体回滚。
 */

const BENCHMARK_KEY = 'benchmark'
const RETENTION_KEY = 'retention'
const TICKET_KEY = 'freezeTickets'
const VERSION_KEY = 'thresholdVersions'

const BENCHMARK_FINAL_STATUS = '已冻结'
const BENCHMARK_ENABLED_STATUS = '已启用'
const RETENTION_ENABLED_STATUS = '已启用'

function fail(message: string): ActionResult {
  return { ok: false, message }
}

function ok(message: string): ActionResult {
  return { ok: true, message }
}

function nextId(rows: { id: number }[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function toNumber(value: unknown): number | null {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

/** 对比指标适用周期：月度取冻结当月，季度取所在季度，年度取年份，其它回退到冻结日期。 */
export function resolveApplicablePeriod(collectCycle: string, frozenAt: Date): string {
  const year = frozenAt.getFullYear()
  const month = frozenAt.getMonth() + 1
  const pad = (n: number) => String(n).padStart(2, '0')
  if (collectCycle.includes('月')) {
    return `${year}-${pad(month)}`
  }
  if (collectCycle.includes('季')) {
    return `${year}Q${Math.ceil(month / 3)}`
  }
  if (collectCycle.includes('年')) {
    return String(year)
  }
  if (collectCycle.includes('周')) {
    return `${year}-W${pad(weekOfYear(frozenAt))}`
  }
  return `${year}-${pad(month)}-${pad(frozenAt.getDate())}`
}

function weekOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 1)
  const diff = date.getTime() - start.getTime()
  return Math.ceil((diff / 86400000 + start.getDay() + 1) / 7)
}

function nextTicketNo(tickets: FreezeTicket[]): string {
  const seq = tickets.reduce((max, ticket) => {
    const match = /FROZ-(\d+)/.exec(ticket.ticketNo)
    return match ? Math.max(max, Number(match[1])) : max
  }, 0) + 1
  return `FROZ-${String(seq).padStart(4, '0')}`
}

export function listFreezeTickets(benchmarkCode?: string): FreezeTicket[] {
  const tickets = listCollection<FreezeTicket>(TICKET_KEY)
  const sorted = [...tickets].sort((a, b) => a.id - b.id)
  return benchmarkCode ? sorted.filter((ticket) => ticket.benchmarkCode === benchmarkCode) : sorted
}

export function listThresholdVersions(retentionCode?: string): ThresholdVersion[] {
  const versions = listCollection<ThresholdVersion>(VERSION_KEY)
  const sorted = [...versions].sort((a, b) => a.id - b.id)
  return retentionCode
    ? sorted.filter((version) => version.retentionCode === retentionCode)
    : sorted
}

export function getBenchmarkRow(code: string): EntryRow | undefined {
  return listRows(BENCHMARK_KEY).find((row) => String(row['方案编号']) === code)
}

export function getRetentionRow(code: string): EntryRow | undefined {
  return listRows(RETENTION_KEY).find((row) => String(row['方案编号']) === code)
}

/** 首单（有效凭据）：一个对标方案至多一张，冻结后留存只认它。 */
export function winningTicket(benchmarkCode: string): FreezeTicket | undefined {
  return listFreezeTickets(benchmarkCode).find((ticket) => ticket.status === '有效' && ticket.winning)
}

export function activeVersion(retentionCode: string): ThresholdVersion | undefined {
  return listThresholdVersions(retentionCode).find((version) => version.status === '已生效')
}

export function pendingVersions(retentionCode: string): ThresholdVersion[] {
  return listThresholdVersions(retentionCode).filter((version) => version.status === '待确认')
}

/** 列表/详情展示基准值的唯一入口：冻结后展示冻结快照，未冻结展示当前基准值。 */
export function displayBaseline(row: EntryRow): number | null {
  if (String(row.status) === BENCHMARK_FINAL_STATUS) {
    const frozen = toNumber(row['冻结基准值'])
    if (frozen !== null) {
      return frozen
    }
  }
  return toNumber(row['基准值'])
}

/** 留存差距的读取入口：优先取版本快照，没有快照时按统一口径现算，保证两处差距一致。 */
export function retentionGap(version: ThresholdVersion): number | null {
  if (version.gap !== null) {
    return version.gap
  }
  if (version.baseline !== null) {
    return computeGap(version.baseline, version.threshold)
  }
  return null
}

/** 留存列表展示阈值的唯一入口：取已生效版本，避免残留已被替代的旧阈值。 */
export function displayRetentionThreshold(row: EntryRow): number | null {
  const code = String(row['方案编号'])
  const active = activeVersion(code)
  if (active) {
    return active.threshold
  }
  return toNumber(row['留存阈值'])
}

function linkedRetentions(benchmarkCode: string): EntryRow[] {
  return listRows(RETENTION_KEY).filter((row) => String(row['关联对标'] ?? '') === benchmarkCode)
}

/**
 * 冻结对标方案。
 * @param idOrCode 对标行 id 或方案编号
 */
export function freezeBenchmark(idOrCode: number | string): ActionResult {
  const rows = listRows(BENCHMARK_KEY)
  const index = rows.findIndex((row) =>
    typeof idOrCode === 'number' ? Number(row.id) === idOrCode : String(row['方案编号']) === idOrCode,
  )
  if (index < 0) {
    return fail('没有找到该对标方案')
  }
  const row = rows[index]
  const code = String(row['方案编号'])
  const status = String(row.status)
  const tickets = listFreezeTickets(code)
  const frozenAt = new Date()
  const iso = frozenAt.toISOString()
  const baseline = toNumber(row['基准值'])
  const gapThreshold = toNumber(row['差距阈值'])
  const metric = String(row['对比指标'] ?? '')
  const collectCycle = String(row['采集周期'] ?? '')
  const applicablePeriod = resolveApplicablePeriod(collectCycle, frozenAt)

  // 所有校验都在写入前完成，保证失败时不留下任何半成品数据。
  if (status !== BENCHMARK_ENABLED_STATUS && status !== BENCHMARK_FINAL_STATUS) {
    return fail(`对标方案当前为「${status}」，需通过评审并启用后才能冻结`)
  }
  if (baseline === null || gapThreshold === null) {
    return fail('对标方案的基准值或差距阈值不是有效数值，无法冻结')
  }

  const firstTicket = tickets[0]

  // 相撞分支 A：已经冻结过又来一次冻结（连续冻结），首单为准，本次进复核。
  // 相撞分支 B：关联留存已存在同一适用周期的待确认版本（两版更新相撞），同样进复核。
  const collisionReason = detectCollision(code, status, applicablePeriod)
  if (collisionReason) {
    const reviewTicket: FreezeTicket = {
      id: nextId(listCollection<FreezeTicket>(TICKET_KEY)),
      ticketNo: nextTicketNo(listCollection<FreezeTicket>(TICKET_KEY)),
      benchmarkCode: code,
      status: '复核中',
      winning: false,
      frozenBaseline: baseline,
      frozenGapThreshold: gapThreshold,
      frozenMetric: metric,
      collectCycle,
      applicablePeriod,
      frozenAt: iso,
      relatedTicketNo: firstTicket ? firstTicket.ticketNo : null,
      note: collisionReason,
    }
    // 复核单独立落库：不动对标状态，也不写任何留存阈值。
    saveMany({ [TICKET_KEY]: [...listCollection<FreezeTicket>(TICKET_KEY), reviewTicket] })
    return ok(`检测到${collisionReason}，以首个冻结单号「${firstTicket ? firstTicket.ticketNo : '—'}」对应的版本为准，本请求（${reviewTicket.ticketNo}）已进入复核，未写入留存阈值`)
  }

  const ticketNo = nextTicketNo(listCollection<FreezeTicket>(TICKET_KEY))
  const ticket: FreezeTicket = {
    id: nextId(listCollection<FreezeTicket>(TICKET_KEY)),
    ticketNo,
    benchmarkCode: code,
    status: '有效',
    winning: true,
    frozenBaseline: baseline,
    frozenGapThreshold: gapThreshold,
    frozenMetric: metric,
    collectCycle,
    applicablePeriod,
    frozenAt: iso,
    relatedTicketNo: null,
    note: '首个冻结凭据，留存阈值以此版本为准',
  }

  const allVersions = listCollection<ThresholdVersion>(VERSION_KEY)
  const newVersions: ThresholdVersion[] = []
  for (const retention of linkedRetentions(code)) {
    const retentionCode = String(retention['方案编号'])
    const active = activeVersion(retentionCode)
    const observationDays = active
      ? active.observationDays
      : (toNumber(retention['观察天数']) ?? 0)
    // 新阈值 = 冻结基准 - 差距阈值；只生成待确认草案，绝不覆盖已生效版本。
    const draftThreshold = round4(baseline - gapThreshold)
    const versionSeq = listThresholdVersions(retentionCode).reduce(
      (max, version) => Math.max(max, version.version),
      0,
    ) + 1
    newVersions.push({
      id: nextId([...allVersions, ...newVersions]),
      retentionCode,
      version: versionSeq,
      status: '待确认',
      threshold: draftThreshold,
      baseline,
      gap: computeGap(baseline, draftThreshold),
      observationDays,
      source: '冻结单',
      freezeTicketNo: ticketNo,
      frozenAt: iso,
      applicablePeriod,
      reason: `对标 ${code} 冻结（${ticketNo}）派生的阈值草案`,
      createdAt: iso,
    })
  }

  const frozenRow: EntryRow = {
    ...row,
    status: BENCHMARK_FINAL_STATUS,
    pending: false,
    abnormal: false,
    冻结单号: ticketNo,
    冻结基准值: baseline,
    冻结时间: iso,
    适用周期: applicablePeriod,
  }
  const nextBenchmarkRows = [...rows]
  nextBenchmarkRows[index] = frozenRow

  try {
    // 冻结凭据 + 留存阈值版本 + 对标状态一次提交，任一失败整体退回。
    saveMany({
      [BENCHMARK_KEY]: nextBenchmarkRows,
      [TICKET_KEY]: [...listCollection<FreezeTicket>(TICKET_KEY), ticket],
      [VERSION_KEY]: [...allVersions, ...newVersions],
    })
  } catch {
    return fail('冻结记录与留存阈值写入失败，已整体退回，数据保持冻结前状态')
  }

  const linkedText = newVersions.length
    ? `，并为 ${newVersions.map((version) => version.retentionCode).join('、')} 生成待确认阈值草案`
    : '，当前没有关联的留存方案'
  return ok(`对标 ${code} 已冻结，冻结单号 ${ticketNo}，基准值固定为 ${(baseline * 100).toFixed(0)}%（适用周期 ${applicablePeriod}）${linkedText}`)
}

function detectCollision(
  benchmarkCode: string,
  status: string,
  applicablePeriod: string,
): string | null {
  if (status === BENCHMARK_FINAL_STATUS) {
    return '连续冻结请求'
  }
  for (const retention of linkedRetentions(benchmarkCode)) {
    const hit = pendingVersions(String(retention['方案编号'])).find(
      (version) => version.applicablePeriod === applicablePeriod,
    )
    if (hit) {
      return `两版更新相撞（${retention['方案编号']} 在 ${applicablePeriod} 已存在待确认版本 v${hit.version}）`
    }
  }
  return null
}

/** 修改对标详情中的当前基准值：冻结后只改「当前值」，冻结快照保持不变。 */
export function updateBenchmarkBaseline(idOrCode: number | string, rawPercent: number): ActionResult {
  const rows = listRows(BENCHMARK_KEY)
  const index = rows.findIndex((row) =>
    typeof idOrCode === 'number' ? Number(row.id) === idOrCode : String(row['方案编号']) === idOrCode,
  )
  if (index < 0) {
    return fail('没有找到该对标方案')
  }
  if (!Number.isFinite(rawPercent) || rawPercent < 0 || rawPercent > 1) {
    return fail('基准值必须是 0% ~ 100% 之间的数值')
  }
  const row = rows[index]
  const nextRows = [...rows]
  nextRows[index] = { ...row, 基准值: round4(rawPercent) }
  saveMany({ [BENCHMARK_KEY]: nextRows })
  const frozenNote = String(row.status) === BENCHMARK_FINAL_STATUS
    ? '；方案已冻结，冻结基准值保持不变，仅当前基准值更新'
    : ''
  return ok(`对标 ${String(row['方案编号'])} 的当前基准值已更新为 ${(rawPercent * 100).toFixed(0)}%${frozenNote}`)
}

/**
 * 修改已启用留存方案的观察天数：
 * 不动已生效阈值与观察天数，只基于冻结版本派生一个新的待确认阈值版本。
 */
export function proposeObservationDays(retentionCode: string, nextDays: number): ActionResult {
  const row = getRetentionRow(retentionCode)
  if (!row) {
    return fail('没有找到该留存方案')
  }
  if (String(row.status) !== RETENTION_ENABLED_STATUS) {
    return fail(`留存方案当前为「${String(row.status)}」，仅已启用方案可调整观察天数`)
  }
  if (!Number.isInteger(nextDays) || nextDays <= 0) {
    return fail('观察天数必须是正整数')
  }
  const currentDays = toNumber(row['观察天数'])
  if (currentDays === nextDays) {
    return fail(`观察天数仍是 ${nextDays} 天，没有变化`)
  }
  const benchmarkCode = String(row['关联对标'] ?? '')
  const ticket = winningTicket(benchmarkCode)
  if (!ticket) {
    return fail(`关联对标 ${benchmarkCode || '（空）'} 尚未形成有效冻结凭据，留存方案只读取冻结版本`)
  }
  const duplicate = pendingVersions(retentionCode).find(
    (version) => version.observationDays === nextDays,
  )
  if (duplicate) {
    return fail(`已存在观察天数 ${nextDays} 天的待确认版本 v${duplicate.version}，请勿重复提交`)
  }

  const active = activeVersion(retentionCode)
  const allVersions = listCollection<ThresholdVersion>(VERSION_KEY)
  const versionSeq = listThresholdVersions(retentionCode).reduce(
    (max, version) => Math.max(max, version.version),
    0,
  ) + 1
  const draftThreshold = round4(ticket.frozenBaseline - ticket.frozenGapThreshold)
  const draft: ThresholdVersion = {
    id: nextId(allVersions),
    retentionCode,
    version: versionSeq,
    status: '待确认',
    threshold: draftThreshold,
    baseline: ticket.frozenBaseline,
    gap: computeGap(ticket.frozenBaseline, draftThreshold),
    observationDays: nextDays,
    source: '观察天数调整',
    freezeTicketNo: ticket.ticketNo,
    frozenAt: ticket.frozenAt,
    applicablePeriod: ticket.applicablePeriod,
    reason: `观察天数 ${currentDays ?? '—'} 天调整为 ${nextDays} 天，依据冻结单 ${ticket.ticketNo} 派生`,
    createdAt: new Date().toISOString(),
  }
  saveMany({ [VERSION_KEY]: [...allVersions, draft] })
  return ok(`已生成待确认版本 v${versionSeq}：阈值草案 ${(draftThreshold * 100).toFixed(0)}%、观察 ${nextDays} 天；原已生效阈值${active ? `（${(active.threshold * 100).toFixed(0)}%）` : ''}与冻结时间保持不变`)
}

/** 确认阈值草案：草案生效、旧生效版本转失效、方案行同步，三者一次提交。 */
export function confirmThresholdVersion(versionId: number): ActionResult {
  const allVersions = listCollection<ThresholdVersion>(VERSION_KEY)
  const target = allVersions.find((version) => Number(version.id) === Number(versionId))
  if (!target) {
    return fail('没有找到该阈值版本')
  }
  if (target.status !== '待确认') {
    return fail(`版本 v${target.version} 当前为「${target.status}」，只有待确认版本可以确认`)
  }
  const nextVersions = allVersions.map((version) => {
    if (version.id === target.id) {
      return { ...version, status: '已生效' as const }
    }
    if (version.retentionCode === target.retentionCode && version.status === '已生效') {
      return { ...version, status: '已失效' as const }
    }
    return version
  })
  const retentionRows = listRows(RETENTION_KEY)
  const rowIndex = retentionRows.findIndex(
    (row) => String(row['方案编号']) === target.retentionCode,
  )
  if (rowIndex < 0) {
    return fail(`阈值版本关联的留存方案 ${target.retentionCode} 不存在，已退回确认操作`)
  }
  const nextRetentionRows = [...retentionRows]
  nextRetentionRows[rowIndex] = {
    ...retentionRows[rowIndex],
    留存阈值: target.threshold,
    观察天数: target.observationDays,
  }
  try {
    saveMany({
      [VERSION_KEY]: nextVersions,
      [RETENTION_KEY]: nextRetentionRows,
    })
  } catch {
    return fail('阈值版本确认写入失败，已整体退回')
  }
  return ok(`版本 v${target.version} 已生效，${target.retentionCode} 当前阈值 ${(target.threshold * 100).toFixed(0)}%、观察 ${target.observationDays} 天`)
}

/** 驳回阈值草案：只改这一张版本，不触碰已生效版本。 */
export function rejectThresholdVersion(versionId: number): ActionResult {
  const allVersions = listCollection<ThresholdVersion>(VERSION_KEY)
  const target = allVersions.find((version) => Number(version.id) === Number(versionId))
  if (!target) {
    return fail('没有找到该阈值版本')
  }
  if (target.status !== '待确认') {
    return fail(`版本 v${target.version} 当前为「${target.status}」，只有待确认版本可以驳回`)
  }
  const nextVersions = allVersions.map((version) =>
    version.id === target.id ? { ...version, status: '已驳回' as const } : version,
  )
  saveMany({ [VERSION_KEY]: nextVersions })
  return ok(`版本 v${target.version} 已驳回，已生效阈值不受影响`)
}
