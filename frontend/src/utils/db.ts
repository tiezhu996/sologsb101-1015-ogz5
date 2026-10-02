/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbheritagetree
 * - 含数据结构版本号与 v1 → v2 → v3 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - 提供各表增删改查、整库快照导出与外业包增量合并
 * - 删除一律为软删除（写 deletedAt 作废标记），墓碑随快照导出，供增量合并裁决
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Tree } from '../types/tree'
import type { Survey } from '../types/survey'
import type { Measure, MeasureState } from '../types/measure'
import type { Support } from '../types/support'
import type { Review } from '../types/review'
import { nowIso, today } from './id'
import { seedDatabase } from './seed'
import {
  isActiveRow,
  planMerge,
  recomputeLastMeasureDates,
  sumMergeStats,
  type MergeReport,
  type MergeTableRows,
} from './merge'

/** 数据库名 */
export const DB_NAME = 'gbheritagetree'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3

/** 数据行结构修订号 */
export const ROW_REVISION = 3

class HeritageTreeDatabase extends Dexie {
  trees!: Table<Tree, string>
  surveys!: Table<Survey, string>
  measures!: Table<Measure, string>
  supports!: Table<Support, string>
  reviews!: Table<Review, string>

  constructor() {
    super(DB_NAME)

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      trees: 'id, code, species, protectLevel, ageYears, createdAt',
      surveys: 'id, treeId, date',
      measures: 'id, treeId, type, state, date',
      supports: 'id, treeId, type, installDate',
      reviews: 'id, treeId, date, vigor',
    })

    // ---------- v2：补齐索引与回写字段，并迁移历史数据 ----------
    this.version(2)
      .stores({
        trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
        // 复合索引 [treeId+date]：按古树 + 日期快速取检查记录
        surveys: 'id, treeId, [treeId+date], date, siteNote',
        measures: 'id, treeId, type, state, date, operator',
        supports: 'id, treeId, type, installDate, lastCheckDate',
        reviews: 'id, treeId, date, vigor, trend',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('trees'),
          tx.table('surveys'),
          tx.table('measures'),
          tx.table('supports'),
          tx.table('reviews'),
        ]
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso()
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt
          })
        }
        // 迁移 2：古树补齐「最近复壮日期」
        await tx.table('trees').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.lastMeasureDate !== 'string') row.lastMeasureDate = ''
        })
        // 迁移 3：复评补齐「后续措施」
        await tx.table('reviews').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.followUp !== 'string') row.followUp = ''
        })
        // 迁移 4：加固件补齐「最近检查日期」
        await tx.table('supports').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.lastCheckDate !== 'string') row.lastCheckDate = ''
          if (typeof row.checkCycleMon !== 'number') row.checkCycleMon = 12
        })
      })

    // ---------- v3：补作废标记（软删除 + 外业包增量合并），索引结构不变 ----------
    this.version(DB_SCHEMA_VERSION).upgrade(async (tx) => {
      const tables = [
        tx.table('trees'),
        tx.table('surveys'),
        tx.table('measures'),
        tx.table('supports'),
        tx.table('reviews'),
      ]
      for (const table of tables) {
        await table.toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.deletedAt !== 'string') row.deletedAt = ''
          row.revision = ROW_REVISION
        })
      }
    })
  }
}

export const db = new HeritageTreeDatabase()

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open()
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.trees.count()) === 0) {
        await seedDatabase()
      }
    })()
  }
  return initPromise
}

/* -------------------------------- 古树 -------------------------------- */

export async function listTrees(): Promise<Tree[]> {
  const rows = (await db.trees.toArray()).filter(isActiveRow)
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function getTree(id: string): Promise<Tree | undefined> {
  const row = await db.trees.get(id)
  return row !== undefined && isActiveRow(row) ? row : undefined
}

export async function putTree(row: Tree): Promise<void> {
  await db.trees.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 作废古树并级联作废其检查、措施、加固与复评记录（软删除，墓碑参与增量合并） */
export async function removeTree(id: string): Promise<void> {
  const stamp = nowIso()
  const tombstone = { deletedAt: stamp, updatedAt: stamp }
  await db.transaction('rw', db.trees, db.surveys, db.measures, db.supports, db.reviews, async () => {
    await db.surveys.where('treeId').equals(id).modify(tombstone)
    await db.measures.where('treeId').equals(id).modify(tombstone)
    await db.supports.where('treeId').equals(id).modify(tombstone)
    await db.reviews.where('treeId').equals(id).modify(tombstone)
    await db.trees.update(id, tombstone)
  })
}

/* ------------------------------ 树体检查 ------------------------------ */

export async function listSurveys(): Promise<Survey[]> {
  const rows = (await db.surveys.toArray()).filter(isActiveRow)
  return rows.sort((a, b) => a.treeId.localeCompare(b.treeId) || a.date.localeCompare(b.date))
}

export async function listSurveysByTree(treeId: string): Promise<Survey[]> {
  const rows = (await db.surveys.where('treeId').equals(treeId).toArray()).filter(isActiveRow)
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function putSurvey(row: Survey): Promise<void> {
  await db.surveys.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeSurvey(id: string): Promise<void> {
  const stamp = nowIso()
  await db.surveys.update(id, { deletedAt: stamp, updatedAt: stamp })
}

/* ------------------------------ 复壮措施 ------------------------------ */

export async function listMeasures(): Promise<Measure[]> {
  const rows = (await db.measures.toArray()).filter(isActiveRow)
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listMeasuresByTree(treeId: string): Promise<Measure[]> {
  const rows = (await db.measures.where('treeId').equals(treeId).toArray()).filter(isActiveRow)
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

/**
 * 写入复壮措施。
 * 措施状态为「已完成」时，回写古树的最近复壮日期（仅当本次日期更新时）。
 */
export async function putMeasure(row: Measure): Promise<void> {
  await db.transaction('rw', db.trees, db.measures, async () => {
    await db.measures.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
    if (row.state !== '已完成') return
    const tree = await db.trees.get(row.treeId)
    if (!tree) return
    if (tree.lastMeasureDate >= row.date) return
    await db.trees.update(tree.id, { lastMeasureDate: row.date, updatedAt: nowIso() })
  })
}

export async function removeMeasure(id: string): Promise<void> {
  const stamp = nowIso()
  await db.measures.update(id, { deletedAt: stamp, updatedAt: stamp })
}

/** 批量修改措施状态；改为「已完成」时同步回写古树最近复壮日期 */
export async function batchSetMeasureState(ids: string[], state: MeasureState): Promise<number> {
  if (ids.length === 0) return 0
  const rows = await db.measures.bulkGet(ids)
  const list = rows.filter((row): row is Measure => row !== undefined)
  for (const row of list) {
    await putMeasure({ ...row, state })
  }
  return list.length
}

/* ------------------------------ 加固件 ------------------------------ */

export async function listSupports(): Promise<Support[]> {
  const rows = (await db.supports.toArray()).filter(isActiveRow)
  return rows.sort((a, b) => a.installDate.localeCompare(b.installDate))
}

export async function listSupportsByTree(treeId: string): Promise<Support[]> {
  const rows = (await db.supports.where('treeId').equals(treeId).toArray()).filter(isActiveRow)
  return rows
}

export async function putSupport(row: Support): Promise<void> {
  await db.supports.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeSupport(id: string): Promise<void> {
  const stamp = nowIso()
  await db.supports.update(id, { deletedAt: stamp, updatedAt: stamp })
}

/** 登记本次检查：把最近检查日期置为给定日期（默认今天） */
export async function markSupportChecked(id: string, date = today()): Promise<void> {
  await db.supports.update(id, { lastCheckDate: date, updatedAt: nowIso() })
}

/* ------------------------------ 长势复评 ------------------------------ */

export async function listReviews(): Promise<Review[]> {
  const rows = (await db.reviews.toArray()).filter(isActiveRow)
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listReviewsByTree(treeId: string): Promise<Review[]> {
  const rows = (await db.reviews.where('treeId').equals(treeId).toArray()).filter(isActiveRow)
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function putReview(row: Review): Promise<void> {
  await db.reviews.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeReview(id: string): Promise<void> {
  const stamp = nowIso()
  await db.reviews.update(id, { deletedAt: stamp, updatedAt: stamp })
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  trees: Tree[]
  surveys: Survey[]
  measures: Measure[]
  supports: Support[]
  reviews: Review[]
}

/**
 * 导出整库快照（含已作废记录的墓碑）。
 * 外业包必须带上作废标记，回站增量合并时才能按修订时间与作废标记裁决。
 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [trees, surveys, measures, supports, reviews] = await Promise.all([
    db.trees.toArray(),
    db.surveys.toArray(),
    db.measures.toArray(),
    db.supports.toArray(),
    db.reviews.toArray(),
  ])
  return { name: DB_NAME, schemaVersion: DB_SCHEMA_VERSION, exportedAt: nowIso(), trees, surveys, measures, supports, reviews }
}

/**
 * 外业包增量合并：把平板离线记录的存档并入当前档案。
 * - 同一条记录按修订时间与作废标记裁决，避免覆盖站内新补内容；
 * - 校验失败（存档版本超前 / 记录缺编号 / 关联古树缺失）时整包拒绝，现有档案保持原样；
 * - 合并后按已完成复壮措施重算每株古树的最近复壮日期；
 * - 读取、裁决、写入在同一事务内完成，liveQuery 订阅会自动刷新超期提醒、历史时间线与复评待办。
 */
export async function mergeSnapshot(snapshot: DatabaseSnapshot): Promise<MergeReport> {
  return db.transaction('rw', db.trees, db.surveys, db.measures, db.supports, db.reviews, async () => {
    const current: MergeTableRows = {
      trees: await db.trees.toArray(),
      surveys: await db.surveys.toArray(),
      measures: await db.measures.toArray(),
      supports: await db.supports.toArray(),
      reviews: await db.reviews.toArray(),
    }
    const plan = planMerge(current, snapshot)
    if (!plan.ok) {
      // 未写入任何数据即返回：事务提交空变更，现有档案保持原样
      return {
        ok: false,
        message: `外业包校验未通过（${plan.failures.length} 处问题），已整包拒绝，现有档案保持原样。`,
        finishedAt: nowIso(),
        totalIncoming: plan.totalIncoming,
        stats: plan.stats,
        failures: plan.failures,
        rewrittenTrees: 0,
      }
    }
    let rewrittenTrees = 0
    await db.trees.bulkPut(plan.winners.trees)
    await db.surveys.bulkPut(plan.winners.surveys)
    await db.measures.bulkPut(plan.winners.measures)
    await db.supports.bulkPut(plan.winners.supports)
    await db.reviews.bulkPut(plan.winners.reviews)
    // 合并后按在册「已完成」复壮措施重算每株古树的最近复壮日期
    const trees = (await db.trees.toArray()).filter(isActiveRow)
    const measures = (await db.measures.toArray()).filter(isActiveRow)
    const expected = recomputeLastMeasureDates(trees, measures)
    const stamp = nowIso()
    for (const tree of trees) {
      const next = expected.get(tree.id) ?? ''
      if (tree.lastMeasureDate === next) continue
      await db.trees.update(tree.id, { lastMeasureDate: next, updatedAt: stamp })
      rewrittenTrees += 1
    }
    const total = sumMergeStats(plan.stats)
    return {
      ok: true,
      message:
        `合并完成：本次处理 ${plan.totalIncoming} 条（新增 ${total.added}、更新 ${total.updated}、` +
        `作废 ${total.voided}、保留本端 ${total.kept}），重算最近复壮日期回写 ${rewrittenTrees} 株。`,
      finishedAt: nowIso(),
      totalIncoming: plan.totalIncoming,
      stats: plan.stats,
      failures: [],
      rewrittenTrees,
    }
  })
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', db.trees, db.surveys, db.measures, db.supports, db.reviews, async () => {
    await Promise.all([
      db.trees.clear(),
      db.surveys.clear(),
      db.measures.clear(),
      db.supports.clear(),
      db.reviews.clear(),
    ])
  })
  await seedDatabase()
}

/** 各表在册行数统计（不含已作废墓碑） */
export async function countAll(): Promise<Record<string, number>> {
  const [trees, surveys, measures, supports, reviews] = await Promise.all([
    db.trees.filter(isActiveRow).count(),
    db.surveys.filter(isActiveRow).count(),
    db.measures.filter(isActiveRow).count(),
    db.supports.filter(isActiveRow).count(),
    db.reviews.filter(isActiveRow).count(),
  ])
  return { trees, surveys, measures, supports, reviews }
}
