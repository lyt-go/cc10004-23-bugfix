/** 展示层统一格式化：百分比、日期时间都走这里，避免各页面各写一套导致口径对不上。 */

/** 0.42 -> "42%"，null/undefined/非数字 -> "—" */
export function fmtPercent(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '—'
  }
  const num = Number(value)
  if (!Number.isFinite(num)) {
    return '—'
  }
  return `${round2(num * 100)}%`
}

/** 留存差距的唯一计算口径：基准值 - 留存阈值，入参为小数。 */
export function computeGap(baseline: unknown, threshold: unknown): number | null {
  const base = Number(baseline)
  const th = Number(threshold)
  if (!Number.isFinite(base) || !Number.isFinite(th)) {
    return null
  }
  return round4(base - th)
}

/** ISO 字符串 -> "2026-11-14 10:20" */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) {
    return '—'
  }
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return '—'
  }
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

/** 解析用户输入的百分比：支持 42 与 0.42 两种写法，返回小数；非法返回 null。 */
export function parsePercentInput(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return null
  }
  const num = Number(trimmed)
  if (!Number.isFinite(num) || num < 0) {
    return null
  }
  const fraction = num > 1 ? num / 100 : num
  if (fraction > 1) {
    return null
  }
  return round4(fraction)
}
