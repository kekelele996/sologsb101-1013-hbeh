/**
 * 实验室 store：维护测序批次鉴定结果与对账派生。
 * 鉴定失败只在本侧重试（追加新鉴定记录），外业采样管不改动；
 * 属名归并口径统一在 utils/reconcile，页面与导出不得自行解释。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { IdStatus, Identification } from '@/types/identification'

export const useLabStore = defineStore('lab', () => {
  const identifications = ref<Identification[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Identification>(() => db.identifications).subscribe((rows) => {
      identifications.value = rows
      ready.value = true
      error.value = null
    })
  }

  /** 测序批次选项（去重，按批次号排序） */
  const batchNos = computed<string[]>(() =>
    Array.from(new Set(identifications.value.map((item) => item.batchNo).filter((v) => !!v))).sort((a, b) =>
      a.localeCompare(b, 'zh-Hans-CN')
    )
  )

  /** 某管号的全部鉴定记录（时间倒序） */
  function identificationsOfTube(tubeNo: string | null | undefined): Identification[] {
    if (!tubeNo) return []
    return identifications.value
      .filter((item) => item.tubeNo === tubeNo)
      .sort((a, b) => Date.parse(b.identifiedAt) - Date.parse(a.identifiedAt) || b.createdAt - a.createdAt)
  }

  /** 新增一条鉴定记录（成功或失败重试都走这里，只追加本侧记录） */
  async function createIdentification(
    payload: Omit<Identification, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<Identification> {
    const now = Date.now()
    const row: Identification = { ...payload, id: createId('idn'), createdAt: now, updatedAt: now }
    await db.identifications.put(row)
    return row
  }

  /** 批量导入鉴定行（追加，不去重；同管多条由对账取最近成功一条） */
  async function importIdentificationRows(
    rows: Array<{
      tubeNo: string
      batchNo: string
      status: IdStatus
      genus: string
      confidence: number
      identifier: string
    }>,
    identifiedAt: string
  ): Promise<number> {
    const now = Date.now()
    const records: Identification[] = rows.map((row, index) => ({
      id: createId('idn'),
      tubeNo: row.tubeNo,
      batchNo: row.batchNo,
      status: row.status,
      genus: row.genus,
      confidence: row.confidence,
      identifier: row.identifier,
      note: '',
      identifiedAt,
      createdAt: now + index,
      updatedAt: now + index
    }))
    await db.identifications.bulkPut(records)
    return records.length
  }

  async function removeIdentification(id: string): Promise<void> {
    await db.identifications.delete(id)
  }

  return {
    identifications,
    ready,
    error,
    batchNos,
    start,
    identificationsOfTube,
    createIdentification,
    importIdentificationRows,
    removeIdentification
  }
})
