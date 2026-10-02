/**
 * 古树（Tree）
 * 一树一档：编号、树种、保护级别、树龄、位置与管护单位。
 */

/** 保护级别：一级 / 二级 / 三级 */
export type ProtectLevel = '一级' | '二级' | '三级'

export const PROTECT_LEVEL_OPTIONS: ProtectLevel[] = ['一级', '二级', '三级']

/** 常见古树树种候选（可在表单中自由填写其他树种） */
export const TREE_SPECIES_CANDIDATES: string[] = ['国槐', '银杏', '侧柏', '香樟', '皂荚', '圆柏', '油松', '朴树']

export interface Tree {
  id: string
  /** 古树编号，如 京-01-0007 */
  code: string
  /** 树种 */
  species: string
  /** 保护级别 */
  protectLevel: ProtectLevel
  /** 树龄（年） */
  ageYears: number
  /** 位置 */
  location: string
  /** 管护单位 */
  owner: string
  /** 最近一次复壮措施完成日期（措施完成时回写） */
  lastMeasureDate: string
  createdAt: string
  updatedAt: string
  /** 数据行结构修订号，便于后续按行迁移 */
  revision: number
  /** 作废标记：作废记录保留为墓碑参与同步，正常列表与统计中隐藏（老数据与外业包可能缺省，按未作废处理） */
  voided?: boolean
}

/** 新建 / 编辑古树档案的表单草稿 */
export interface TreeDraft {
  code: string
  species: string
  protectLevel: ProtectLevel
  ageYears: number
  location: string
  owner: string
}
