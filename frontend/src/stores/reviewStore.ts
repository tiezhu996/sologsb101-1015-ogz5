/**
 * 长势复评状态管理（Pinia）
 * 维护长势筛选条件与复评结论派生值；长势为衰弱 / 濒危时强制填写后续措施。
 * 同时负责外业包增量合并：解析存档、执行合并、留存本次合并报告供复评页展示。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Review, ReviewDraft, Trend, Vigor } from '../types/review'
import { VIGOR_NEED_FOLLOW_UP, VIGOR_OPTIONS } from '../types/review'
import { ROW_REVISION, db, initDatabase, mergeSnapshot, putReview, removeReview } from '../utils/db'
import { emptyMergeStats, type MergeReport } from '../utils/merge'
import { parseSnapshot } from '../utils/export'
import { nowIso, uuid } from '../utils/id'
import { useTreeStore } from './treeStore'

/** 长势复评筛选条件 */
export interface ReviewFilters {
  keyword: string
  treeId: string | 'all'
  vigor: Vigor | 'all'
  trend: Trend | 'all'
}

/** 复评结论校验结果 */
export interface ReviewValidation {
  ok: boolean
  message: string
}

export const useReviewStore = defineStore('review', () => {
  const filters = reactive<ReviewFilters>({ keyword: '', treeId: 'all', vigor: 'all', trend: 'all' })
  const selectedIds = ref<string[]>([])
  const lastMessage = ref('')
  const revision = ref(0)
  /** 最近一次外业包增量合并的报告（成功或整包拒绝），供复评页展示 */
  const lastMergeReport = ref<MergeReport | null>(null)
  const merging = ref(false)

  /** 长势分布统计，供复评页徽标使用 */
  const vigorStats = computed<Record<Vigor, number>>(() => {
    const result = { 旺盛: 0, 一般: 0, 衰弱: 0, 濒危: 0 } as Record<Vigor, number>
    const treeStore = useTreeStore()
    VIGOR_OPTIONS.forEach((vigor) => {
      result[vigor] = treeStore.reviews.filter((row) => row.vigor === vigor).length
    })
    return result
  })

  /** 长势为衰弱 / 濒危且未填写后续措施的古树数量 */
  const followUpMissing = computed<number>(() => {
    const treeStore = useTreeStore()
    return treeStore.trees.filter((tree) => {
      const list = treeStore.reviews
        .filter((row) => row.treeId === tree.id)
        .sort((a, b) => a.date.localeCompare(b.date))
      const latest = list.length > 0 ? list[list.length - 1] : null
      if (latest === null) return false
      return VIGOR_NEED_FOLLOW_UP.includes(latest.vigor) && latest.followUp.trim() === ''
    }).length
  })

  /** 需要填写后续措施的长势等级 */
  const requireFollowUp = (vigor: Vigor): boolean => VIGOR_NEED_FOLLOW_UP.includes(vigor)

  /** 校验复评表单：衰弱 / 濒危必须填写后续措施 */
  function validate(draft: ReviewDraft): ReviewValidation {
    if (requireFollowUp(draft.vigor) && draft.followUp.trim() === '') {
      return { ok: false, message: `长势为「${draft.vigor}」时必须填写后续措施，否则无法保存。` }
    }
    if (draft.conclusion.trim() === '') {
      return { ok: false, message: '请填写复评结论。' }
    }
    return { ok: true, message: '' }
  }

  async function init(): Promise<void> {
    await initDatabase()
    revision.value += 1
  }

  function setFilters(patch: Partial<ReviewFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    filters.keyword = ''
    filters.treeId = 'all'
    filters.vigor = 'all'
    filters.trend = 'all'
    selectedIds.value = []
  }

  function setSelectedIds(ids: string[]): void {
    selectedIds.value = [...ids]
  }

  async function createReview(draft: ReviewDraft): Promise<Review | null> {
    const check = validate(draft)
    if (!check.ok) {
      lastMessage.value = check.message
      return null
    }
    const stamp = nowIso()
    const row: Review = {
      id: uuid('review'),
      treeId: draft.treeId,
      date: draft.date,
      vigor: draft.vigor,
      trend: draft.trend,
      conclusion: draft.conclusion.trim(),
      followUp: draft.followUp.trim(),
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
      deletedAt: '',
    }
    await putReview(row)
    revision.value += 1
    lastMessage.value = `已登记 ${row.date} 长势复评：${row.vigor}（${row.trend}）`
    return row
  }

  async function updateReview(reviewId: string, draft: ReviewDraft): Promise<ReviewValidation> {
    const check = validate(draft)
    if (!check.ok) {
      lastMessage.value = check.message
      return check
    }
    const existing = await db.reviews.get(reviewId)
    if (!existing) return { ok: false, message: '复评记录不存在' }
    await putReview({
      ...existing,
      treeId: draft.treeId,
      date: draft.date,
      vigor: draft.vigor,
      trend: draft.trend,
      conclusion: draft.conclusion.trim(),
      followUp: draft.followUp.trim(),
    })
    revision.value += 1
    lastMessage.value = '复评记录已更新'
    return { ok: true, message: '' }
  }

  async function deleteReview(reviewId: string): Promise<void> {
    await removeReview(reviewId)
    selectedIds.value = selectedIds.value.filter((id) => id !== reviewId)
    revision.value += 1
  }

  /**
   * 导入外业包并执行增量合并。
   * 解析或校验失败时整包拒绝（现有档案保持原样），报告写入 lastMergeReport 供复评页列出失败记录；
   * 成功后刷新统计，liveQuery 订阅会自动刷新超期提醒、历史时间线与复评待办。
   */
  async function mergePackage(text: string): Promise<MergeReport> {
    merging.value = true
    try {
      const parsed = parseSnapshot(text)
      if (!parsed.ok || parsed.snapshot === null) {
        const report: MergeReport = {
          ok: false,
          message: `外业包已整包拒绝：${parsed.message}`,
          finishedAt: nowIso(),
          totalIncoming: 0,
          stats: emptyMergeStats(),
          failures: [{ table: 'package', recordId: '—', reason: parsed.message }],
          rewrittenTrees: 0,
        }
        lastMergeReport.value = report
        lastMessage.value = report.message
        return report
      }
      const report = await mergeSnapshot(parsed.snapshot)
      lastMergeReport.value = report
      lastMessage.value = report.message
      if (report.ok) {
        await useTreeStore().refreshCounts()
        revision.value += 1
      }
      return report
    } finally {
      merging.value = false
    }
  }

  async function refreshCounts(): Promise<void> {
    await useTreeStore().refreshCounts()
  }

  return {
    filters,
    selectedIds,
    lastMessage,
    revision,
    lastMergeReport,
    merging,
    vigorStats,
    followUpMissing,
    requireFollowUp,
    validate,
    init,
    setFilters,
    resetFilters,
    setSelectedIds,
    createReview,
    updateReview,
    deleteReview,
    mergePackage,
    refreshCounts,
  }
})
