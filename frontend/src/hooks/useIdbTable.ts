/**
 * Dexie 单表增删改查 + liveQuery 响应式订阅封装（Vue 版）
 * 页面统一通过它读写 IndexedDB，避免组件内部直接触碰 Dexie 实例。
 * 已作废（deletedAt 非空）的记录对页面透明：查询自动过滤，删除一律软删除。
 */
import { liveQuery, type Table } from 'dexie'
import { onScopeDispose, ref, shallowRef, type Ref } from 'vue'
import { ROW_REVISION } from '../utils/db'
import { nowIso, uuid } from '../utils/id'
import { isActiveRow } from '../utils/merge'

/** 所有持久化实体共有的行结构 */
export interface IdbRow {
  id: string
  createdAt: string
  updatedAt: string
  revision: number
  /** 作废时间（ISO），空串 = 在册 */
  deletedAt: string
}

/** 新增记录入参：id / 时间戳 / 修订号 / 作废标记由封装层补齐 */
export type NewRow<T extends IdbRow> = Omit<T, 'id' | 'createdAt' | 'updatedAt' | 'revision' | 'deletedAt'> & {
  id?: string
}

export interface UseIdbTableOptions<T extends IdbRow> {
  /** 是否按 updatedAt 倒序，默认 true */
  sortByUpdatedAt?: boolean
  onChange?: (rows: T[]) => void
}

export interface UseIdbTableResult<T extends IdbRow> {
  rows: Ref<T[]>
  loading: Ref<boolean>
  /** 是否已完成首次载入：用于区分「数据为空」与「尚未读取」 */
  ready: Ref<boolean>
  error: Ref<string>
  refresh: () => Promise<void>
  getById: (id: string) => Promise<T | undefined>
  create: (payload: NewRow<T>, idPrefix?: string) => Promise<T>
  update: (id: string, patch: Partial<T>) => Promise<void>
  upsert: (row: T) => Promise<void>
  remove: (id: string) => Promise<void>
  bulkPut: (rows: T[]) => Promise<void>
  clear: () => Promise<void>
}

export function useIdbTable<T extends IdbRow>(
  table: Table<T, string>,
  options: UseIdbTableOptions<T> = {}
): UseIdbTableResult<T> {
  const { sortByUpdatedAt = true, onChange } = options

  const rows = ref([]) as Ref<T[]>
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const subscription = shallowRef<{ unsubscribe: () => void } | null>(null)

  const applySort = (list: T[]): T[] => {
    const active = list.filter(isActiveRow)
    if (!sortByUpdatedAt) return active
    return active.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  }

  const refresh = async (): Promise<void> => {
    loading.value = true
    try {
      const list = applySort(await table.toArray())
      rows.value = list
      ready.value = true
      error.value = ''
      onChange?.(list)
    } catch (err) {
      error.value = err instanceof Error ? err.message : '读取本地数据失败'
    } finally {
      loading.value = false
    }
  }

  const stop = (): void => {
    subscription.value?.unsubscribe()
    subscription.value = null
  }

  const observable = liveQuery(async () => applySort(await table.toArray()))
  subscription.value = observable.subscribe({
    next: (list) => {
      rows.value = list as T[]
      ready.value = true
      loading.value = false
      error.value = ''
      onChange?.(list as T[])
    },
    error: (err: unknown) => {
      error.value = err instanceof Error ? err.message : '订阅本地数据失败'
      loading.value = false
    },
  })
  void refresh()

  onScopeDispose(stop)

  const create = async (payload: NewRow<T>, idPrefix = 'row'): Promise<T> => {
    const stamp = nowIso()
    const record = {
      ...(payload as object),
      id: payload.id ?? uuid(idPrefix),
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
      deletedAt: '',
    } as T
    await table.put(record)
    return record
  }

  const update = async (id: string, patch: Partial<T>): Promise<void> => {
    await table.update(id, { ...patch, updatedAt: nowIso() } as never)
  }

  const upsert = async (row: T): Promise<void> => {
    await table.put({ ...row, updatedAt: nowIso() })
  }

  /** 软删除：写作废标记，墓碑随快照导出参与增量合并 */
  const remove = async (id: string): Promise<void> => {
    const stamp = nowIso()
    await table.update(id, { deletedAt: stamp, updatedAt: stamp } as never)
  }

  const bulkPut = async (list: T[]): Promise<void> => {
    await table.bulkPut(list)
  }

  const clear = async (): Promise<void> => {
    await table.clear()
  }

  return {
    rows,
    loading,
    ready,
    error,
    refresh,
    stop,
    getById: (id: string) => table.get(id),
    create,
    update,
    upsert,
    remove,
    bulkPut,
    clear,
  } as UseIdbTableResult<T> & { stop: () => void }
}
