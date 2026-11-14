/* 领域写入边界的端到端校验脚本（仅开发期使用，不打进前端产物）。
 * 在 Node 里模拟 localStorage，直接驱动 freeze-service / local-service，
 * 覆盖：评审门禁、冻结快照、基准值漂移隔离、观察天数调整草案、相撞复核、
 * 版本确认/驳回、事务整体回滚。
 */
import { freezeBenchmark, listFreezeTickets, listThresholdVersions, activeVersion, pendingVersions, displayBaseline, displayRetentionThreshold, retentionGap, updateBenchmarkBaseline, proposeObservationDays, confirmThresholdVersion, rejectThresholdVersion, getBenchmarkRow, getRetentionRow } from '@/api/freeze-service'
import { runAction, resetFreezeDomain } from '@/api/local-service'
import { listRows, allRows } from '@/data/local-store'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ✅ ${name}`)
  } else {
    failed += 1
    console.error(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

function findRow(key: string, code: string) {
  return listRows(key).find((row) => String(row['方案编号']) === code)!
}

console.log('\n[场景0] 播种数据完整性')
resetFreezeDomain()
for (const key of ['benchmark', 'retention', 'freezeTickets', 'thresholdVersions']) {
  check(`聚合 ${key} 是数组`, Array.isArray(allRows()[key]))
}
check('BENC-0002 初始为已启用且基准 42%', findRow('benchmark', 'BENC-0002').status === '已启用' && Number(findRow('benchmark', 'BENC-0002')['基准值']) === 0.42)
check('RETE-0002 初始已启用且关联 BENC-0002', findRow('retention', 'RETE-0002').status === '已启用' && String(findRow('retention', 'RETE-0002')['关联对标']) === 'BENC-0002')
const seedActive = activeVersion('RETE-0002')
check('RETE-0002 已存在手工设定的已生效 v1（35%/7天）', !!seedActive && seedActive.version === 1 && seedActive.threshold === 0.35 && seedActive.observationDays === 7 && seedActive.status === '已生效')
check('列表无重复行', new Set(listRows('benchmark').map((r) => r.id)).size === listRows('benchmark').length)

console.log('\n[场景1] 评审门禁：未通过评审不能启用/冻结')
const b1 = findRow('benchmark', 'BENC-0001')
const r1 = runAction('benchmark', Number(b1.id), '冻结方案')
check('草稿态冻结被拒绝', !r1.ok && r1.message.includes('通过评审'))
const r2 = runAction('benchmark', Number(b1.id), '启用方案')
check('草稿态启用被拒绝', !r2.ok && r2.message.includes('方案评审中'))
const r3 = runAction('benchmark', Number(findRow('benchmark', 'BENC-0002').id), '启用方案')
check('已启用重复启用被拒绝', !r3.ok)
const r4 = runAction('benchmark', Number(b1.id), '提交方案评审')
check('草稿可以提交评审', r4.ok && findRow('benchmark', 'BENC-0001').status === '方案评审中')
const r5 = runAction('benchmark', Number(b1.id), '启用方案')
check('评审通过后可以启用', r5.ok && findRow('benchmark', 'BENC-0001').status === '已启用')

console.log('\n[场景2] 冻结前调整观察天数被门禁拦截（留存只读冻结版本）')
const beforeFreeze = proposeObservationDays('RETE-0002', 14)
check('无冻结凭据时调整观察天数失败', !beforeFreeze.ok && beforeFreeze.message.includes('冻结凭据'))

console.log('\n[场景3] 冻结 BENC-0002：凭据固定 42%，RETE-0002 生成待确认草案，v1 不动')
const freeze = freezeBenchmark('BENC-0002')
check('冻结成功', freeze.ok, freeze.message)
const ticket = listFreezeTickets('BENC-0002').find((t) => t.status === '有效')
check('生成有效冻结单 FROZ-0001', !!ticket && ticket.ticketNo === 'FROZ-0001' && ticket.winning)
check('冻结基准固定为 42%', !!ticket && ticket.frozenBaseline === 0.42)
check('冻结快照含差距阈值 4%', !!ticket && ticket.frozenGapThreshold === 0.04)
check('适用周期按采集周期落到 2026-11（月度）', !!ticket && /^\d{4}-11$/.test(ticket.applicablePeriod))
check('对标行状态变为已冻结并回写冻结单号', findRow('benchmark', 'BENC-0002').status === '已冻结' && String(findRow('benchmark', 'BENC-0002')['冻结单号']) === 'FROZ-0001')
check('对标行冻结基准值快照 42%', Number(findRow('benchmark', 'BENC-0002')['冻结基准值']) === 0.42)
const draftsAfterFreeze = pendingVersions('RETE-0002')
const v2 = draftsAfterFreeze.find((v) => v.version === 2)
check('RETE-0002 新增待确认 v2 草案', !!v2 && v2.status === '待确认' && v2.freezeTicketNo === 'FROZ-0001')
check('v2 阈值=冻结基准-差距阈值=38%', !!v2 && v2.threshold === 0.38)
check('v2 留存差距快照=4%，与统一口径一致', !!v2 && v2.gap === retentionGap(v2) && v2.gap === 0.04)
check('v2 冻结时间来自冻结凭据', !!v2 && v2.frozenAt === ticket!.frozenAt)
check('v1 仍为已生效 35%/7天（原阈值保留）', seedActive && activeVersion('RETE-0002')!.id === seedActive.id && activeVersion('RETE-0002')!.threshold === 0.35)
check('列表已生效阈值仍展示 35%（不残留草案值）', displayRetentionThreshold(findRow('retention', 'RETE-0002')) === 0.35)

console.log('\n[场景4] 冻结后改动对标详情：当前值可变，冻结版本与留存完全不动')
const upd = updateBenchmarkBaseline('BENC-0002', 0.48)
check('当前基准值更新成功', upd.ok && Number(findRow('benchmark', 'BENC-0002')['基准值']) === 0.48)
check('列表展示基准仍取冻结快照 42%', displayBaseline(findRow('benchmark', 'BENC-0002')) === 0.42)
check('冻结凭据基准仍是 42%', listFreezeTickets('BENC-0002').find((t) => t.status === '有效')!.frozenBaseline === 0.42)
const v2Again = listThresholdVersions('RETE-0002').find((v) => v.version === 2)!
check('v2 草案未被联动改写（仍 38%）', v2Again.threshold === 0.38 && v2Again.gap === 0.04)
check('v1 阈值与冻结时间保持不变', activeVersion('RETE-0002')!.threshold === 0.35 && activeVersion('RETE-0002')!.frozenAt === null)

console.log('\n[场景5] 修改留存观察天数：只能产生新的待确认版本')
const frozenAtBefore = ticket!.frozenAt
const prop = proposeObservationDays('RETE-0002', 14)
check('调整观察天数成功', prop.ok, prop.message)
const v3 = listThresholdVersions('RETE-0002').find((v) => v.version === 3)
check('生成待确认 v3（14天/38%草案）', !!v3 && v3.status === '待确认' && v3.observationDays === 14 && v3.threshold === 0.38)
check('v3 引用同一张冻结单与同一冻结时间', !!v3 && v3.freezeTicketNo === 'FROZ-0001' && v3.frozenAt === frozenAtBefore)
check('v1 依旧已生效 35%/7天', activeVersion('RETE-0002')!.version === 1 && activeVersion('RETE-0002')!.observationDays === 7)
const dup = proposeObservationDays('RETE-0002', 14)
check('重复天数被拦截，不产生重复版本', !dup.ok && listThresholdVersions('RETE-0002').filter((v) => v.observationDays === 14).length === 1)
const sameDays = proposeObservationDays('RETE-0002', 7)
check('与现行天数相同被拦截', !sameDays.ok)

console.log('\n[场景6] 连续冻结相撞：首单为准，后单进复核且不写留存')
const secondFreeze = freezeBenchmark('BENC-0002')
check('第二次冻结返回复核提示', secondFreeze.ok && secondFreeze.message.includes('复核'))
const tickets = listFreezeTickets('BENC-0002')
const review = tickets.find((t) => t.status === '复核中')
check('生成复核中冻结单 FROZ-0002', !!review && review.ticketNo === 'FROZ-0002' && !review.winning)
check('复核单指向首单 FROZ-0001', !!review && review.relatedTicketNo === 'FROZ-0001')
check('复核单没有写入任何留存版本', listThresholdVersions('RETE-0002').filter((v) => v.freezeTicketNo === 'FROZ-0002').length === 0)
check('对标仍保持已冻结，首单仍有效', findRow('benchmark', 'BENC-0002').status === '已冻结' && tickets.filter((t) => t.status === '有效').length === 1)
const thirdFreeze = freezeBenchmark('BENC-0002')
check('第三次冻结同样进复核，不产生重复生效版本', thirdFreeze.ok && listFreezeTickets('BENC-0002').filter((t) => t.status === '复核中').length === 2)

console.log('\n[场景7] 草案确认生效：新版本生效、旧版本失效，差距口径一致')
const confirm = confirmThresholdVersion(v3!.id)
check('v3 确认成功', confirm.ok)
const afterConfirm = listThresholdVersions('RETE-0002')
check('v3 已生效 38%/14天', afterConfirm.find((v) => v.id === v3!.id)!.status === '已生效')
check('v1 转为已失效但历史保留', afterConfirm.find((v) => v.version === 1)!.status === '已失效')
check('v2 待确认草案不受影响', afterConfirm.find((v) => v.version === 2)!.status === '待确认')
const row2 = getRetentionRow('RETE-0002')!
check('留存行同步为新阈值 38%/14天', Number(row2['留存阈值']) === 0.38 && Number(row2['观察天数']) === 14)
check('列表阈值与详情口径一致（38%）', displayRetentionThreshold(row2) === 0.38)
const active38 = activeVersion('RETE-0002')!
check('两处留存差距一致：4%', retentionGap(active38) === 0.04 && v3!.gap === retentionGap(active38))
const reject = rejectThresholdVersion(v2Again.id)
check('驳回剩余草案 v2', reject.ok && listThresholdVersions('RETE-0002').find((v) => v.id === v2Again.id)!.status === '已驳回')
check('驳回不影响已生效 v3', activeVersion('RETE-0002')!.id === v3!.id)

console.log('\n[场景8] 驳回路径：重置后冻结再驳回，原生效阈值不动')
resetFreezeDomain()
freezeBenchmark('BENC-0002')
const draft = pendingVersions('RETE-0002')[0]
const rejectOnly = rejectThresholdVersion(draft.id)
check('草案可驳回', rejectOnly.ok)
check('驳回后原 v1 仍生效 35%', activeVersion('RETE-0002')!.version === 1 && activeVersion('RETE-0002')!.threshold === 0.35)
check('留存行阈值未被草案污染', Number(getRetentionRow('RETE-0002')!['留存阈值']) === 0.35)

console.log('\n[场景8.5] 多方案版本 id 全局唯一：两个留存方案各自启用不撞 id')
resetFreezeDomain()
// RETE-0001 从草稿走完整评审门禁到启用，会登记初始版本。
const r0001 = findRow('retention', 'RETE-0001')
check('RETE-0001 提交评审成功', runAction('retention', Number(r0001.id), '提交方案评审').ok)
check('RETE-0001 评审后启用成功', runAction('retention', Number(r0001.id), '启用方案').ok)
const allIds = listThresholdVersions().map((v) => v.id)
check('全部阈值版本 id 唯一，无重复', new Set(allIds).size === allIds.length, `ids=${allIds.join(',')}`)
check('RETE-0001 拿到独立的已生效版本', !!activeVersion('RETE-0001') && activeVersion('RETE-0001')!.retentionCode === 'RETE-0001')
check('RETE-0002 播种的 v1 仍然存在', activeVersion('RETE-0002')!.version === 1)

console.log('\n[场景9] 事务回滚：持久化失败时冻结记录与留存阈值整体退回')
resetFreezeDomain()
const ticketCountBefore = listFreezeTickets().length
const versionCountBefore = listThresholdVersions().length
const statusBefore = findRow('benchmark', 'BENC-0002').status
const storage: Record<string, string> = {}
;(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (k: string) => storage[k] ?? null,
    setItem: (k: string, v: string) => {
      storage[k] = v
      throw new Error('模拟配额不足，写入失败')
    },
  },
}
const rollbackFreeze = freezeBenchmark('BENC-0002')
;(globalThis as Record<string, unknown>).window = undefined
check('冻结返回整体退回提示', !rollbackFreeze.ok && rollbackFreeze.message.includes('整体退回'))
check('没有残留冻结单', listFreezeTickets().length === ticketCountBefore)
check('没有残留阈值版本', listThresholdVersions().length === versionCountBefore)
check('对标状态回到冻结前', findRow('benchmark', 'BENC-0002').status === statusBefore)

console.log(`\n结果：${passed} 通过，${failed} 失败\n`)
if (failed > 0) {
  process.exit(1)
}
