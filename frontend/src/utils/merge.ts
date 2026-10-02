/**
 * 外业包增量合并（纯函数层，不触碰 Dexie）
 * - 当前档案与外业包都可以修改或作废记录；
 * - 同一条记录按修订时间（updatedAt，缺失时退回 createdAt）与作废标记（deletedAt）裁决保留哪版：
 *   修订时间新者胜出；时间相同时作废标记优先（删除粘性）；再相同则保留本端，避免覆盖站内新补内容；
 * - 校验（缺编号 / 关联古树缺失 / 包内编号重复）任一失败即整包拒绝，调用方保证现有档案保持原样；
 * - 合并后按已完成复壮措施重算每株古树的最近复壮日期。
 */
import type { Tree } from '../types/tree'
import type { Survey } from '../types/survey'
import type { Measure } from '../types/measure'
import type { Support } from '../types/support'
import type { Review } from '../types/review'

/** 可合并的五张表 */
export type MergeTableName = 'trees' | 'surveys' | 'measures' | 'supports' | 'reviews'

export const MERGE_TABLES: MergeTableName[] = ['trees', 'surveys', 'measures', 'supports', 'reviews']

/** 子记录表（挂在古树之下，需校验关联完整性并支持级联作废） */
export const MERGE_CHILD_TABLES: MergeTableName[] = ['surveys', 'measures', 'supports', 'reviews']

export const MERGE_TABLE_LABEL: Record<MergeTableName, string> = {
  trees: '古树档案',
  surveys: '树体检查',
  measures: '复壮措施',
  supports: '加固件',
  reviews: '长势复评',
}

/** 五表行集合（当前档案或外业包） */
export interface MergeTableRows {
  trees: Tree[]
  surveys: Survey[]
  measures: Measure[]
  supports: Support[]
  reviews: Review[]
}

/** 合并冲突 / 校验失败记录 */
export interface MergeFailure {
  /** 出问题的表；package 表示整包级问题（如存档版本超前） */
  table: MergeTableName | 'package'
  recordId: string
  reason: string
}

/** 单表本次处理数量 */
export interface MergeTableStat {
  /** 本端没有、外业包新增 */
  added: number
  /** 外业包修订时间更新，覆盖本端 */
  updated: number
  /** 作废生效（含级联作废） */
  voided: number
  /** 本端修订时间更新或相同，保留本端版本 */
  kept: number
}

/** 合并计划：校验通过时给出需要写回的胜出记录（含作废墓碑） */
export interface MergePlan {
  ok: boolean
  failures: MergeFailure[]
  winners: MergeTableRows
  stats: Record<MergeTableName, MergeTableStat>
  /** 外业包记录总数（本次处理数量） */
  totalIncoming: number
}

/** 一次合并的结果报告（成功或整包拒绝都会生成，供复评页展示） */
export interface MergeReport {
  ok: boolean
  message: string
  finishedAt: string
  totalIncoming: number
  stats: Record<MergeTableName, MergeTableStat>
  failures: MergeFailure[]
  /** 合并后重算最近复壮日期并发生回写的古树数 */
  rewrittenTrees: number
}

/** 记录是否在册（未作废）；兼容缺省字段的旧版本存档 */
export function isActiveRow(row: { deletedAt?: string }): boolean {
  return row.deletedAt === undefined || row.deletedAt === ''
}

export function emptyMergeStats(): Record<MergeTableName, MergeTableStat> {
  return {
    trees: { added: 0, updated: 0, voided: 0, kept: 0 },
    surveys: { added: 0, updated: 0, voided: 0, kept: 0 },
    measures: { added: 0, updated: 0, voided: 0, kept: 0 },
    supports: { added: 0, updated: 0, voided: 0, kept: 0 },
    reviews: { added: 0, updated: 0, voided: 0, kept: 0 },
  }
}

function emptyRows(): MergeTableRows {
  return { trees: [], surveys: [], measures: [], supports: [], reviews: [] }
}

/** 汇总各表处理数量 */
export function sumMergeStats(stats: Record<MergeTableName, MergeTableStat>): MergeTableStat {
  const total = { added: 0, updated: 0, voided: 0, kept: 0 }
  MERGE_TABLES.forEach((table) => {
    total.added += stats[table].added
    total.updated += stats[table].updated
    total.voided += stats[table].voided
    total.kept += stats[table].kept
  })
  return total
}

/** 取记录的修订时间：updatedAt → createdAt → 空串（视为最旧） */
function revisionTime(row: { updatedAt?: string; createdAt?: string }): string {
  if (typeof row.updatedAt === 'string' && row.updatedAt !== '') return row.updatedAt
  if (typeof row.createdAt === 'string' && row.createdAt !== '') return row.createdAt
  return ''
}

/** 裁决同一条记录保留哪版：修订时间新者胜；时间相同作废优先；再相同保留本端 */
function decideWinner(current: { updatedAt?: string; createdAt?: string; deletedAt?: string }, incoming: { updatedAt?: string; createdAt?: string; deletedAt?: string }): 'incoming' | 'current' {
  const currentTime = revisionTime(current)
  const incomingTime = revisionTime(incoming)
  if (incomingTime > currentTime) return 'incoming'
  if (incomingTime < currentTime) return 'current'
  if (!isActiveRow(incoming) && isActiveRow(current)) return 'incoming'
  return 'current'
}

/** 规范化外业包记录：补齐缺失的时间戳与作废标记（兼容 v1 / v2 存档） */
function normalizeRow<T>(row: T): T {
  const record = row as Record<string, unknown>
  return {
    ...row,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    deletedAt: typeof record.deletedAt === 'string' ? record.deletedAt : '',
  }
}

/**
 * 生成合并计划（纯函数）。
 * 返回 ok = false 时 winners 为空，调用方不得写库，现有档案保持原样。
 */
export function planMerge(current: MergeTableRows, incoming: MergeTableRows): MergePlan {
  const failures: MergeFailure[] = []
  const stats = emptyMergeStats()
  const winnerMaps: Record<MergeTableName, Map<string, Tree | Survey | Measure | Support | Review>> = {
    trees: new Map(),
    surveys: new Map(),
    measures: new Map(),
    supports: new Map(),
    reviews: new Map(),
  }
  let totalIncoming = 0

  // ---------- 1) 校验编号并逐条裁决 ----------
  MERGE_TABLES.forEach((table) => {
    const currentById = new Map<string, Tree | Survey | Measure | Support | Review>(
      current[table].map((row) => [row.id, row]),
    )
    const seen = new Set<string>()
    incoming[table].forEach((raw) => {
      totalIncoming += 1
      if (typeof raw !== 'object' || raw === null) {
        failures.push({ table, recordId: '（无法识别）', reason: '记录格式不正确：不是对象。' })
        return
      }
      const row = normalizeRow(raw)
      const id = (row as { id?: unknown }).id
      if (typeof id !== 'string' || id.trim() === '') {
        failures.push({ table, recordId: '（缺编号）', reason: '记录缺编号，无法与本端档案对应。' })
        return
      }
      if (seen.has(id)) {
        failures.push({ table, recordId: id, reason: '外业包内记录编号重复。' })
        return
      }
      seen.add(id)
      if (table === 'trees') {
        const code = (row as Tree).code
        if (typeof code !== 'string' || code.trim() === '') {
          failures.push({ table, recordId: id, reason: '古树缺编号（code），无法建档。' })
          return
        }
      }
      const existing = currentById.get(id)
      if (existing === undefined) {
        winnerMaps[table].set(id, row)
        if (isActiveRow(row)) stats[table].added += 1
        else stats[table].voided += 1
        return
      }
      if (decideWinner(existing, row) === 'incoming') {
        winnerMaps[table].set(id, row)
        if (isActiveRow(row)) stats[table].updated += 1
        else stats[table].voided += 1
      } else {
        stats[table].kept += 1
      }
    })
  })

  // ---------- 2) 合并后的在档古树集合 ----------
  const finalTrees = new Map<string, Tree>(current.trees.map((row) => [row.id, row]))
  winnerMaps.trees.forEach((row, id) => finalTrees.set(id, row as Tree))
  const activeTreeIds = new Set([...finalTrees.values()].filter(isActiveRow).map((row) => row.id))

  // ---------- 3) 关联完整性：外业包写入的在册子记录必须挂在在档古树下 ----------
  MERGE_CHILD_TABLES.forEach((table) => {
    winnerMaps[table].forEach((row, id) => {
      if (!isActiveRow(row)) return
      const treeId = (row as Survey).treeId
      if (typeof treeId !== 'string' || !activeTreeIds.has(treeId)) {
        failures.push({
          table,
          recordId: id,
          reason: `关联古树缺失（treeId = ${String(treeId)}），整包拒绝。`,
        })
      }
    })
  })

  if (failures.length > 0) {
    return { ok: false, failures, winners: emptyRows(), stats, totalIncoming }
  }

  // ---------- 4) 级联作废：本端在档古树被外业包作废时，其在册子记录一并作废 ----------
  const voidedTreeIds = new Set(
    [...winnerMaps.trees.values()].filter((row) => !isActiveRow(row)).map((row) => row.id),
  )
  if (voidedTreeIds.size > 0) {
    MERGE_CHILD_TABLES.forEach((table) => {
      const currentChildren = current[table] as Array<Survey | Measure | Support | Review>
      currentChildren.forEach((row) => {
        if (!isActiveRow(row)) return
        if (!voidedTreeIds.has(row.treeId)) return
        if (winnerMaps[table].has(row.id)) return
        const tree = finalTrees.get(row.treeId)
        winnerMaps[table].set(row.id, {
          ...row,
          deletedAt: tree !== undefined && !isActiveRow(tree) ? tree.deletedAt : row.deletedAt,
          updatedAt: tree !== undefined ? tree.updatedAt : row.updatedAt,
        })
        stats[table].voided += 1
      })
    })
  }

  const winners: MergeTableRows = {
    trees: [...winnerMaps.trees.values()] as Tree[],
    surveys: [...winnerMaps.surveys.values()] as Survey[],
    measures: [...winnerMaps.measures.values()] as Measure[],
    supports: [...winnerMaps.supports.values()] as Support[],
    reviews: [...winnerMaps.reviews.values()] as Review[],
  }
  return { ok: true, failures, winners, stats, totalIncoming }
}

/**
 * 按已完成复壮措施重算每株在档古树的最近复壮日期：
 * 取该株全部在册「已完成」措施的最大实施日期，没有则为空串。
 */
export function recomputeLastMeasureDates(trees: Tree[], measures: Measure[]): Map<string, string> {
  const latest = new Map<string, string>()
  measures.filter(isActiveRow).forEach((row) => {
    if (row.state !== '已完成') return
    const previous = latest.get(row.treeId) ?? ''
    if (row.date > previous) latest.set(row.treeId, row.date)
  })
  const result = new Map<string, string>()
  trees.filter(isActiveRow).forEach((tree) => {
    result.set(tree.id, latest.get(tree.id) ?? '')
  })
  return result
}
