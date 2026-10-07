/**
 * 实验室 / 样本 store：维护外业样本管与实验室鉴定两张表，
 * 并按管号实时对账，产出汇总与导出共用的「有效属名」口径（见 utils/reconcile.ts）。
 * - 外业：采样本管，记管号、所属样带、采样覆盖长度与暂定属名。
 * - 实验室：按测序批次出鉴定属名、置信度与鉴定人；鉴定失败只在本侧重试。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { CoralSample } from '@/types/sample'
import type { SamplePasteRow } from '@/types/sample'
import type { CoralIdentification } from '@/types/identification'
import type { IdentificationPasteRow } from '@/types/identification'
import {
  reconcileSamples,
  resolveSample,
  type OrphanIdentification,
  type ResolvedSample
} from '@/utils/reconcile'

export const useLabStore = defineStore('lab', () => {
  const samples = ref<CoralSample[]>([])
  const identifications = ref<CoralIdentification[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<CoralSample>(() => db.samples).subscribe((rows) => {
      samples.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<CoralIdentification>(() => db.identifications).subscribe((rows) => {
      identifications.value = rows
    })
  }

  /* ------------------------------ 派生：对账 ------------------------------ */

  /** 全量对账结果（页面汇总与 JSON 导出共用） */
  const reconciliation = computed(() => reconcileSamples(samples.value, identifications.value))

  /** 全部样本管的对账行 */
  const resolvedSamples = computed<ResolvedSample[]>(() => reconciliation.value.resolved)

  /** 实验室多出、外业没有的孤立鉴定（等实验室补） */
  const orphans = computed<OrphanIdentification[]>(() => reconciliation.value.orphans)

  /** 待鉴定管数 */
  const pendingCount = computed(() => resolvedSamples.value.filter((row) => row.resolveStatus === '待鉴定').length)
  /** 鉴定失败待重试管数 */
  const failedCount = computed(() => resolvedSamples.value.filter((row) => row.resolveStatus === '鉴定失败').length)
  /** 属名被实验室更正的管数 */
  const genusChangedCount = computed(() => resolvedSamples.value.filter((row) => row.genusChanged).length)
  /** 对不上的孤立鉴定条数（按管号） */
  const orphanCount = computed(() => orphans.value.length)

  /** 对账角标总数（实验室 / 导航用） */
  const attentionCount = computed(() => pendingCount.value + failedCount.value + orphanCount.value)

  function sampleById(id: string | null | undefined): CoralSample | null {
    if (!id) return null
    return samples.value.find((sample) => sample.id === id) ?? null
  }

  function sampleByTube(tubeNo: string): CoralSample | null {
    return samples.value.find((sample) => sample.tubeNo === tubeNo.trim()) ?? null
  }

  function identificationsOfTube(tubeNo: string): CoralIdentification[] {
    return identifications.value
      .filter((ident) => ident.tubeNo === tubeNo)
      .sort((a, b) => b.identifiedAt.localeCompare(a.identifiedAt) || b.createdAt - a.createdAt)
  }

  /** 某样带下样本管的对账行（鉴定时间倒序在外层页面处理，这里保持管号顺序） */
  function resolvedOfBelt(beltId: string | null | undefined): ResolvedSample[] {
    if (!beltId) return []
    return resolvedSamples.value.filter((row) => row.beltId === beltId)
  }

  /** 单管对账行（实验室页详情用） */
  function resolveByTube(tubeNo: string): ResolvedSample | null {
    const sample = sampleByTube(tubeNo)
    if (!sample) return null
    return resolveSample(sample, identificationsOfTube(tubeNo))
  }

  /** 管号是否已被占用（编辑时排除自身） */
  function tubeNoExists(tubeNo: string, exceptId?: string): boolean {
    const target = tubeNo.trim()
    return samples.value.some((sample) => sample.tubeNo === target && sample.id !== exceptId)
  }

  /** 建议下一个管号：取该样带已有管号尾号 +1 */
  function suggestTubeNo(beltId: string): string {
    const used = samples.value
      .filter((sample) => sample.beltId === beltId)
      .map((sample) => Number(sample.tubeNo.replace(/[^0-9]+$/g, '')))
      .filter((value) => Number.isFinite(value) && value > 0)
    const next = used.length === 0 ? 1 : Math.max(...used) + 1
    return String(next).padStart(2, '0')
  }

  /* ------------------------------ 外业样本管 ------------------------------ */

  async function createSample(
    beltId: string,
    payload: Omit<CoralSample, 'id' | 'createdAt' | 'updatedAt' | 'beltId'>
  ): Promise<CoralSample> {
    const now = Date.now()
    const row: CoralSample = { ...payload, beltId, id: createId('smp'), createdAt: now, updatedAt: now }
    await db.samples.put(row)
    return row
  }

  async function updateSample(id: string, patch: Partial<CoralSample>): Promise<void> {
    await db.samples.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeSample(id: string): Promise<void> {
    // 只删外业样本管；该管号的鉴定记录保留，自动落到「孤立鉴定」列表等实验室核对补录，
    // 绝不静默抹掉实验室侧数据。
    await db.samples.delete(id)
  }

  /** 批量导入外业粘贴行（替换该样带原有样本管） */
  async function importSampleRows(beltId: string, rows: SamplePasteRow[], collector: string): Promise<number> {
    const now = Date.now()
    const records: CoralSample[] = rows.map((row, index) => ({
      id: createId('smp'),
      tubeNo: row.tubeNo.trim(),
      beltId,
      fieldGenus: row.fieldGenus.trim(),
      form: row.form,
      coverCm: row.coverCm,
      bleachLevel: row.bleachLevel,
      collector,
      remark: '',
      createdAt: now + index,
      updatedAt: now + index
    }))
    await db.transaction('rw', [db.samples], async () => {
      await db.samples.where('beltId').equals(beltId).delete()
      if (records.length > 0) await db.samples.bulkPut(records)
    })
    return records.length
  }

  /** 批量改写白化等级（外业复核） */
  async function bulkSetBleachLevel(ids: string[], bleachLevel: CoralSample['bleachLevel']): Promise<number> {
    const now = Date.now()
    await db.samples
      .where('id')
      .anyOf(ids)
      .modify((sample) => {
        sample.bleachLevel = bleachLevel
        sample.updatedAt = now
      })
    return ids.length
  }

  /* ------------------------------ 实验室鉴定 ------------------------------ */

  async function createIdentification(
    payload: Omit<CoralIdentification, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<CoralIdentification> {
    const now = Date.now()
    const row: CoralIdentification = { ...payload, id: createId('idn'), createdAt: now, updatedAt: now }
    await db.identifications.put(row)
    return row
  }

  async function updateIdentification(id: string, patch: Partial<CoralIdentification>): Promise<void> {
    await db.identifications.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeIdentification(id: string): Promise<void> {
    await db.identifications.delete(id)
  }

  /** 某管号当前鉴定次数（用于失败重试时自动 +1） */
  function nextAttempt(tubeNo: string): number {
    return identificationsOfTube(tubeNo).length + 1
  }

  /**
   * 按测序批次批量录入鉴定（实验室主入口）。
   * 同管号同批次重复提交时覆盖该条，不新增；失败行 genus 留空。
   * 只写实验室侧，绝不改动外业样本管。
   */
  async function importIdentificationRows(
    rows: IdentificationPasteRow[],
    defaultDate: string
  ): Promise<{ created: number; updated: number }> {
    const now = Date.now()
    let created = 0
    let updated = 0
    // 同一粘贴批次里同管号可能出现多次，用本批计数补齐 attempt，避免都记成 1
    const createdInBatch = new Map<string, number>()
    await db.transaction('rw', [db.identifications], async () => {
      for (const row of rows) {
        const existing = identifications.value.find(
          (item) => item.tubeNo === row.tubeNo && item.batchNo === row.batchNo
        )
        if (existing) {
          await db.identifications.update(existing.id, {
            status: row.status,
            genus: row.genus,
            confidence: row.confidence,
            identifier: row.identifier,
            updatedAt: now
          } as never)
          updated += 1
        } else {
          const knownCount = identifications.value.filter((item) => item.tubeNo === row.tubeNo).length
          const attempt = knownCount + (createdInBatch.get(row.tubeNo) ?? 0) + 1
          createdInBatch.set(row.tubeNo, (createdInBatch.get(row.tubeNo) ?? 0) + 1)
          await db.identifications.put({
            id: createId('idn'),
            tubeNo: row.tubeNo,
            batchNo: row.batchNo,
            status: row.status,
            genus: row.genus,
            confidence: row.confidence,
            identifier: row.identifier,
            attempt,
            identifiedAt: defaultDate,
            note: '',
            createdAt: now,
            updatedAt: now
          })
          created += 1
        }
      }
    })
    return { created, updated }
  }

  /** 鉴定失败后只在本侧重试：基于上一条登记一次新的鉴定尝试 */
  async function retryIdentification(
    tubeNo: string,
    payload: Pick<CoralIdentification, 'batchNo' | 'status' | 'genus' | 'confidence' | 'identifier' | 'identifiedAt' | 'note'>
  ): Promise<CoralIdentification> {
    const attempt = nextAttempt(tubeNo)
    return createIdentification({ tubeNo, attempt, ...payload })
  }

  return {
    samples,
    identifications,
    ready,
    error,
    reconciliation,
    resolvedSamples,
    orphans,
    pendingCount,
    failedCount,
    genusChangedCount,
    orphanCount,
    attentionCount,
    start,
    sampleById,
    sampleByTube,
    identificationsOfTube,
    resolvedOfBelt,
    resolveByTube,
    tubeNoExists,
    suggestTubeNo,
    createSample,
    updateSample,
    removeSample,
    importSampleRows,
    bulkSetBleachLevel,
    createIdentification,
    updateIdentification,
    removeIdentification,
    nextAttempt,
    importIdentificationRows,
    retryIdentification
  }
})
