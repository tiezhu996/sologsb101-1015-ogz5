/**
 * 长势复评状态管理（Pinia）
 * 维护长势筛选条件与复评结论派生值；长势为衰弱 / 濒危时强制填写后续措施。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Review, ReviewDraft, Trend, Vigor } from '../types/review'
import { VIGOR_NEED_FOLLOW_UP, VIGOR_OPTIONS } from '../types/review'
import { ROW_REVISION, db, initDatabase, putReview, removeReview, voidReview } from '../utils/db'
import type { MergeReport } from '../utils/merge'
import { nowIso, uuid } from '../utils/id'
import { useTreeStore } from './treeStore'

/** 最近一次外业包合并报告在 localStorage 的键 */
const MERGE_REPORT_KEY = 'gbheritagetree:lastMergeReport'

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

/** 读取上次合并报告（localStorage 持久化，刷新后仍可在复评页查看处理数量与冲突） */
function loadLastMergeReport(): MergeReport | null {
  try {
    const raw = window.localStorage.getItem(MERGE_REPORT_KEY)
    if (raw === null || raw === '') return null
    const parsed = JSON.parse(raw) as MergeReport
    return typeof parsed === 'object' && parsed !== null && typeof parsed.mergedAt === 'string' ? parsed : null
  } catch {
    return null
  }
}

export const useReviewStore = defineStore('review', () => {
  const filters = reactive<ReviewFilters>({ keyword: '', treeId: 'all', vigor: 'all', trend: 'all' })
  const selectedIds = ref<string[]>([])
  const lastMessage = ref('')
  const revision = ref(0)
  /** 最近一次外业包合并报告（成功含处理数量，失败含失败记录与冲突） */
  const lastMergeReport = ref<MergeReport | null>(loadLastMergeReport())

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
      voided: false,
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

  /** 作废复评记录（保留墓碑参与同步；复评待办按剩余最新记录重算） */
  async function voidReviewRecord(reviewId: string): Promise<void> {
    await voidReview(reviewId)
    selectedIds.value = selectedIds.value.filter((id) => id !== reviewId)
    revision.value += 1
  }

  /** 保存最近一次合并报告并持久化，供复评页展示处理数量 / 失败冲突 */
  function setMergeReport(report: MergeReport): void {
    lastMergeReport.value = report
    try {
      window.localStorage.setItem(MERGE_REPORT_KEY, JSON.stringify(report))
    } catch {
      /* 隐私模式下静默降级，仅内存中保留 */
    }
  }

  /** 清除最近一次合并报告 */
  function clearMergeReport(): void {
    lastMergeReport.value = null
    try {
      window.localStorage.removeItem(MERGE_REPORT_KEY)
    } catch {
      /* 忽略 */
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
    voidReviewRecord,
    setMergeReport,
    clearMergeReport,
    refreshCounts,
  }
})
