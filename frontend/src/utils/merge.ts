/**
 * 外业包增量合并引擎（纯函数）
 *
 * 场景：外业人员用平板离线记录古树检查与养护数据，回站后把外业包合并进站内档案。
 * 站内档案与外业包都可能修改或作废同一条记录，按「修订时间（updatedAt）+ 作废标记」
 * 决定保留哪一版，避免用外业旧内容覆盖站内新补的内容。
 *
 * 整包拒绝（fatal）条件，命中任意一条都不写入、现有档案保持原样：
 * - schema-ahead：存档结构版本超前于本站；
 * - missing-id：包内记录缺少编号（id）；
 * - duplicate-id：同一张表内编号重复（无法判断对应关系）；
 * - missing-tree：子记录关联的古树在站内与包内都不存在。
 *
 * 非致命冲突（warning）：
 * - stale-skipped：外业记录修订时间早于站内现行版本，已跳过以保护站内新补内容。
 */
import type { DatabaseSnapshot } from './db'
import { DB_SCHEMA_VERSION } from './db'

/** 五张业务表在快照中的字段名 */
export type CollectionKey = 'trees' | 'surveys' | 'measures' | 'supports' | 'reviews'

export const COLLECTION_KEYS: CollectionKey[] = ['trees', 'surveys', 'measures', 'supports', 'reviews']

export const COLLECTION_LABEL: Record<CollectionKey, string> = {
  trees: '古树档案',
  surveys: '树体检查',
  measures: '复壮措施',
  supports: '加固件',
  reviews: '长势复评',
}

/** 需要关联古树的子记录表 */
const CHILD_COLLECTIONS: CollectionKey[] = ['surveys', 'measures', 'supports', 'reviews']

/** 合并问题级别：fatal 整包拒绝；warning 可合并但需告知 */
export type MergeIssueLevel = 'fatal' | 'warning'

export type MergeIssueCode =
  | 'schema-ahead'
  | 'missing-id'
  | 'duplicate-id'
  | 'missing-tree'
  | 'stale-skipped'

export const MERGE_ISSUE_LABEL: Record<MergeIssueCode, string> = {
  'schema-ahead': '存档版本超前',
  'missing-id': '记录缺编号',
  'duplicate-id': '编号重复',
  'missing-tree': '关联古树缺失',
  'stale-skipped': '旧版已跳过',
}

export interface MergeIssue {
  level: MergeIssueLevel
  code: MergeIssueCode
  collection: CollectionKey | 'package'
  /** 表内序号（从 0 开始），包级问题为 -1 */
  index: number
  /** 记录编号；缺编号或包级问题时为空 */
  id: string
  /** 关联的古树 id（missing-tree 时使用） */
  treeId?: string
  message: string
}

/** 单条记录的裁决动作 */
export type RowAction =
  | 'added' // 站内没有，新增
  | 'updated' // 外业较新，覆盖
  | 'voided' // 外业作废版较新，作废站内现行记录
  | 'restored' // 站内已作废、外业有效版较新，恢复
  | 'skipped' // 站内较新或同级，保持原样（不计入处理量）

export interface CollectionMergeStat {
  /** 包内收到条数 */
  received: number
  added: number
  updated: number
  voided: number
  restored: number
  skipped: number
}

export interface MergeReport {
  ok: boolean
  /** 外业包文件名（如有） */
  sourceName: string
  mergedAt: string
  schemaVersion: number | null
  fatalCount: number
  warningCount: number
  issues: MergeIssue[]
  stats: Record<CollectionKey, CollectionMergeStat>
  /** 合并后重算最近复壮日期的古树株数 */
  recomputedTrees: number
  /** 汇总消息 */
  message: string
}

/** 一张表的合并结果：最终行集合（已含墓碑）与逐条裁决 */
interface CollectionPlan {
  rows: Array<Record<string, unknown>>
  actions: RowAction[]
}

export interface MergePlan {
  reports: Record<CollectionKey, CollectionPlan>
  report: MergeReport
}

interface MergeableRow {
  id: string
  treeId?: unknown
  updatedAt?: unknown
  voided?: unknown
  [key: string]: unknown
}

function emptyStats(): Record<CollectionKey, CollectionMergeStat> {
  const result = {} as Record<CollectionKey, CollectionMergeStat>
  COLLECTION_KEYS.forEach((key) => {
    result[key] = { received: 0, added: 0, updated: 0, voided: 0, restored: 0, skipped: 0 }
  })
  return result
}

/** 把包内任意一行规范为合并内部使用的形态；返回 null 表示无法当作对象处理 */
function normalizeRow(raw: unknown): MergeableRow | null {
  if (typeof raw !== 'object' || raw === null) return null
  return raw as MergeableRow
}

function isVoided(row: MergeableRow): boolean {
  return row.voided === true
}

function revisionStamp(row: MergeableRow): string {
  return typeof row.updatedAt === 'string' && row.updatedAt !== '' ? row.updatedAt : ''
}

/**
 * 两条同 id 记录的裁决：返回应保留的一方与动作类型。
 * 规则：修订时间新者胜；修订时间相同，作废版胜（作废优先，防止误覆盖作废指令）；
 * 时间相同且作废状态一致，保留站内版本（保护站内新补内容）。
 */
function decideWinner(local: MergeableRow, incoming: MergeableRow): { winner: MergeableRow; action: RowAction } {
  const localTime = revisionStamp(local)
  const incomingTime = revisionStamp(incoming)
  const localVoided = isVoided(local)
  const incomingVoided = isVoided(incoming)

  if (incomingTime > localTime) {
    return { winner: incoming, action: incomingVoided ? 'voided' : localVoided ? 'restored' : 'updated' }
  }
  if (incomingTime < localTime) {
    return { winner: local, action: 'skipped' }
  }
  // 修订时间相同：作废版胜
  if (incomingVoided && !localVoided) {
    return { winner: incoming, action: 'voided' }
  }
  // 同为新版或站内已作废：保留站内
  return { winner: local, action: 'skipped' }
}

/**
 * 规划整包合并（不落库）。
 * @param local 站内当前快照
 * @param incoming 外业包（已通过基础 JSON 结构解析）
 * @param mergedAt 合并时刻 ISO
 * @param sourceName 外业包来源名（文件名）
 */
export function planMerge(
  local: DatabaseSnapshot,
  incoming: DatabaseSnapshot,
  mergedAt: string,
  sourceName = '',
): MergePlan {
  const issues: MergeIssue[] = []
  const stats = emptyStats()

  // ---------- 整包级校验：结构版本超前 ----------
  if (typeof incoming.schemaVersion === 'number' && incoming.schemaVersion > DB_SCHEMA_VERSION) {
    issues.push({
      level: 'fatal',
      code: 'schema-ahead',
      collection: 'package',
      index: -1,
      id: '',
      message: `外业包数据结构版本 v${incoming.schemaVersion} 超前于本站 v${DB_SCHEMA_VERSION}，请先升级本系统后再合并。`,
    })
  }

  // ---------- 逐表收集：缺编号 / 编号重复 ----------
  const accepted = {} as Record<CollectionKey, MergeableRow[]>
  COLLECTION_KEYS.forEach((key) => {
    const rawList = Array.isArray(incoming[key]) ? (incoming[key] as unknown[]) : []
    stats[key].received = rawList.length
    const list: MergeableRow[] = []
    const seen = new Set<string>()
    rawList.forEach((raw, index) => {
      const row = normalizeRow(raw)
      if (row === null) {
        issues.push({
          level: 'fatal',
          code: 'missing-id',
          collection: key,
          index,
          id: '',
          message: `${COLLECTION_LABEL[key]}第 ${index + 1} 条不是有效的记录对象。`,
        })
        return
      }
      const id = typeof row.id === 'string' ? row.id.trim() : ''
      if (id === '') {
        issues.push({
          level: 'fatal',
          code: 'missing-id',
          collection: key,
          index,
          id: '',
          message: `${COLLECTION_LABEL[key]}第 ${index + 1} 条缺少记录编号（id），无法定位对应档案。`,
        })
        return
      }
      if (seen.has(id)) {
        issues.push({
          level: 'fatal',
          code: 'duplicate-id',
          collection: key,
          index,
          id,
          message: `${COLLECTION_LABEL[key]}中编号「${id}」在包内重复出现，无法判断以哪条为准。`,
        })
        return
      }
      seen.add(id)
      list.push(row)
    })
    accepted[key] = list
  })

  // ---------- 子记录关联古树必须存在（站内或包内古树集合，含作废古树） ----------
  const treeIdSet = new Set<string>()
  ;(local.trees as unknown as MergeableRow[]).forEach((row) => {
    if (typeof row.id === 'string') treeIdSet.add(row.id)
  })
  accepted.trees.forEach((row) => treeIdSet.add(row.id))

  CHILD_COLLECTIONS.forEach((key) => {
    accepted[key].forEach((row, index) => {
      const treeId = typeof row.treeId === 'string' ? row.treeId.trim() : ''
      if (treeId === '' || !treeIdSet.has(treeId)) {
        issues.push({
          level: 'fatal',
          code: 'missing-tree',
          collection: key,
          index,
          id: row.id,
          treeId,
          message: `${COLLECTION_LABEL[key]}「${row.id}」关联的古树${
            treeId === '' ? '编号为空' : `「${treeId}」在站内与外业包中均不存在`
          }。`,
        })
      }
    })
  })

  const fatalCount = issues.filter((issue) => issue.level === 'fatal').length
  const warningCount = issues.filter((issue) => issue.level === 'warning').length

  // ---------- 存在致命问题：整包拒绝，不生成写入计划 ----------
  if (fatalCount > 0) {
    const report: MergeReport = {
      ok: false,
      sourceName,
      mergedAt,
      schemaVersion: typeof incoming.schemaVersion === 'number' ? incoming.schemaVersion : null,
      fatalCount,
      warningCount,
      issues,
      stats,
      recomputedTrees: 0,
      message: `外业包校验未通过：${fatalCount} 条致命问题，整包拒绝，现有档案保持原样。`,
    }
    return {
      reports: {
        trees: { rows: [], actions: [] },
        surveys: { rows: [], actions: [] },
        measures: { rows: [], actions: [] },
        supports: { rows: [], actions: [] },
        reviews: { rows: [], actions: [] },
      },
      report,
    }
  }

  // ---------- 逐表裁决 ----------
  const plans = {} as Record<CollectionKey, CollectionPlan>
  COLLECTION_KEYS.forEach((key) => {
    const localRows = (local[key] as unknown as MergeableRow[]).map((row) => ({ ...row }))
    const byId = new Map<string, number>()
    localRows.forEach((row, index) => byId.set(row.id, index))

    const actions: RowAction[] = []
    accepted[key].forEach((incomingRow, incomingIndex) => {
      const localIndex = byId.get(incomingRow.id)
      if (localIndex === undefined) {
        // 站内没有：整行新增（含外业已作废的墓碑，保持同步一致性）
        localRows.push({ ...incomingRow })
        actions[incomingIndex] = 'added'
        stats[key].added += 1
        return
      }
      const { winner, action } = decideWinner(localRows[localIndex], incomingRow)
      localRows[localIndex] = { ...winner }
      actions[incomingIndex] = action
      if (action !== 'skipped') {
        stats[key][action] += 1
      } else {
        stats[key].skipped += 1
        const localTime = revisionStamp(localRows[localIndex])
        const incomingTime = revisionStamp(incomingRow)
        // 外业修订时间更早被跳过：记录为冲突提示；同级跳过不算冲突
        if (incomingTime !== '' && incomingTime < localTime) {
          issues.push({
            level: 'warning',
            code: 'stale-skipped',
            collection: key,
            index: incomingIndex,
            id: incomingRow.id,
            message: `${COLLECTION_LABEL[key]}「${incomingRow.id}」外业修订时间 ${incomingTime} 早于站内 ${localTime}，已保留站内新补内容。`,
          })
        }
      }
    })

    plans[key] = { rows: localRows, actions }
  })

  // ---------- 作废古树的级联一致性：最终为作废状态的古树，其下子记录在落库计划中也全部作废 ----------
  // 与站内「作废古树档案」的事务级联语义保持一致；子记录修订时间不变，仅补作废标记。
  const voidedTreeIds = new Set(
    plans.trees.rows.filter((row) => row.voided === true).map((row) => row.id),
  )
  CHILD_COLLECTIONS.forEach((key) => {
    plans[key].rows.forEach((row) => {
      if (typeof row.treeId === 'string' && voidedTreeIds.has(row.treeId)) {
        row.voided = true
      }
    })
  })

  const totalChanged = COLLECTION_KEYS.reduce(
    (sum, key) => sum + stats[key].added + stats[key].updated + stats[key].voided + stats[key].restored,
    0,
  )
  const finalWarningCount = issues.filter((issue) => issue.level === 'warning').length
  const report: MergeReport = {
    ok: true,
    sourceName,
    mergedAt,
    schemaVersion: typeof incoming.schemaVersion === 'number' ? incoming.schemaVersion : null,
    fatalCount: 0,
    warningCount: finalWarningCount,
    issues,
    stats,
    recomputedTrees: 0,
    message:
      `外业包合并完成：共处理 ${totalChanged} 条（新增 ${sumStat(stats, 'added')}、更新 ${sumStat(
        stats,
        'updated',
      )}、作废 ${sumStat(stats, 'voided')}、恢复 ${sumStat(stats, 'restored')}），` +
      `跳过 ${sumStat(stats, 'skipped')} 条站内较新记录。` +
      (finalWarningCount > 0 ? `另有 ${finalWarningCount} 条冲突已保留站内版本。` : ''),
  }

  return { reports: plans, report }
}

function sumStat(stats: Record<CollectionKey, CollectionMergeStat>, field: keyof CollectionMergeStat): number {
  return COLLECTION_KEYS.reduce((sum, key) => sum + (stats[key][field] as number), 0)
}
