import { SEED_ALL } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// v2：引入冻结单/阈值版本两类聚合，旧版本 localStorage 结构不兼容，直接重新播种。
const STORAGE_KEY = 'data-product-ops:entries:v2'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type StoreData = Record<string, unknown>

function readStorage(): StoreData {
  const fallback = clone(SEED_ALL)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as StoreData
    // 结构校验：缺聚合就整体回到播种数据，避免页面读到半套数据后报错、残留。
    const keys = Object.keys(fallback)
    const complete = keys.every((key) => Array.isArray(parsed[key]))
    if (!complete) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
      return fallback
    }
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: StoreData | null = null

export function allRows(): StoreData {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  const rows = allRows()[key]
  return Array.isArray(rows) ? (rows as EntryRow[]) : []
}

/** 冻结单、阈值版本等强类型聚合的统一读取入口，始终返回数组，杜绝页面读到 undefined 报错。 */
export function listCollection<T>(key: string): T[] {
  const rows = allRows()[key]
  return Array.isArray(rows) ? (rows as T[]) : []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

/**
 * 多聚合同步写入：冻结记录与留存阈值版本必须一起落库。
 * 持久化抛错时把内存缓存整体回滚到写入前快照，保证两边不会出现半成功状态。
 */
export function saveMany(patches: Record<string, unknown[]>): void {
  const snapshot = cache ? clone(cache) : null
  const next: StoreData = { ...allRows(), ...patches }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch (error) {
      if (snapshot) {
        cache = snapshot
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
      }
      throw error
    }
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone((SEED_ALL[key] as EntryRow[] | undefined) ?? [])
  saveRows(key, rows)
  return rows
}

/** 重置整个数据域：对标、留存、冻结单、阈值版本一起回到播种态。 */
export function resetAll(): StoreData {
  const fallback = clone(SEED_ALL)
  cache = fallback
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
  }
  return fallback
}

export function storageKey(): string {
  return STORAGE_KEY
}
