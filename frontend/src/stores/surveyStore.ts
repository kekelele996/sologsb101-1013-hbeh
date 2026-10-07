/**
 * 普查 store：维护外业采样管与鱼类计数、录入草稿与覆盖度派生值。
 * 覆盖 /belts/:id/samples、/belts/:id/fishes、/lab 与 /coverage 四页。
 * 属名归并一律经 utils/reconcile 的统一口径：实验室成功鉴定属名优先，否则外业暂定属名（标暂定）。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { BleachLevel, CoralForm } from '@/types/coralRecord'
import type { CoralSample } from '@/types/sample'
import { BLEACH_LEVELS } from '@/types/coralRecord'
import type { CountCategory, FishCount, SizeClass } from '@/types/fishCount'
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import {
  effectiveRecords,
  reconcileSamples,
  type EffectiveCoralRecord,
  type Reconciliation
} from '@/utils/reconcile'
import { useLabStore } from '@/stores/labStore'
import { bleachGrade, bleachIndex, bleachedSharePct, coralCoveragePct, fishDensity, round } from '@/utils/bleach'

/** 覆盖度汇总页筛选条件 */
export interface SurveyFilterState {
  keyword: string
  reefIds: string[]
  bleachLevels: BleachLevel[]
  /** 是否只看白化指数高于阈值的样带 */
  onlyBleached: boolean
  /** 是否只看含暂定属名（未拿到实验室成功鉴定）的样带 */
  onlyProvisional: boolean
}

export function createEmptySurveyFilter(): SurveyFilterState {
  return {
    keyword: '',
    reefIds: [],
    bleachLevels: [],
    onlyBleached: false,
    onlyProvisional: false
  }
}

/** 覆盖度汇总行（属名一律为实验室口径归并后的有效属名） */
export interface CoverageSummaryRow {
  beltId: string
  beltNo: string
  reefId: string
  reefName: string
  siteId: string
  siteNo: string
  lengthM: number
  orientation: string
  surveyDate: string
  observer: string
  sampleCount: number
  /** 其中已拿到实验室成功鉴定的管数 */
  confirmedCount: number
  /** 仍按外业暂定属名计入的管数 */
  provisionalCount: number
  coverCmTotal: number
  /** 暂定属名管子的覆盖长度合计 */
  provisionalCoverCm: number
  coveragePct: number
  bleachIndex: number
  grade: BleachLevel
  bleachedSharePct: number
  distribution: Record<BleachLevel, number>
  fishTotal: number
  invertebrateTotal: number
  fishDensity: number
}

export const useSurveyStore = defineStore('survey', () => {
  const labStore = useLabStore()
  const samples = ref<CoralSample[]>([])
  const fishes = ref<FishCount[]>([])
  const reefs = ref<Reef[]>([])
  const sites = ref<Site[]>([])
  const belts = ref<Belt[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const filter = ref<SurveyFilterState>(createEmptySurveyFilter())
  /** 采样管录入草稿（跨页面保留） */
  const sampleDraft = ref({
    tubeNo: '',
    provisionalGenus: '',
    form: '枝状' as CoralForm,
    coverCm: 100,
    bleachLevel: '无' as BleachLevel,
    remark: ''
  })
  /** 鱼类计数草稿 */
  const fishDraft = ref({
    family: '',
    count: 1,
    sizeClass: '11-20cm' as SizeClass,
    category: '鱼类' as CountCategory
  })

  let started = false

  function start(): void {
    if (started) return
    started = true
    labStore.start()
    watchTable<CoralSample>(() => db.samples).subscribe((rows) => {
      samples.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<FishCount>(() => db.fishes).subscribe((rows) => {
      fishes.value = rows
    })
    watchTable<Reef>(() => db.reefs).subscribe((rows) => {
      reefs.value = rows
    })
    watchTable<Site>(() => db.sites).subscribe((rows) => {
      sites.value = rows
    })
    watchTable<Belt>(() => db.belts).subscribe((rows) => {
      belts.value = rows
    })
  }

  /** 全库统一对账结果（汇总与导出共用同一口径） */
  const reconciliation = computed<Reconciliation>(() =>
    reconcileSamples(samples.value, labStore.identifications)
  )

  /** 归并后的有效珊瑚记录（有效属名 + 暂定/鉴定标记） */
  const effectiveCorals = computed<EffectiveCoralRecord[]>(() => effectiveRecords(reconciliation.value))

  /** 某样带的采样管（按白化等级降序、覆盖长度降序） */
  function samplesOfBelt(beltId: string | null | undefined): CoralSample[] {
    if (!beltId) return []
    const order: Record<BleachLevel, number> = { 无: 0, 轻: 1, 中: 2, 重: 3, 死亡: 4 }
    return samples.value
      .filter((sample) => sample.beltId === beltId)
      .sort((a, b) => {
        const diff = order[b.bleachLevel] - order[a.bleachLevel]
        if (diff !== 0) return diff
        return b.coverCm - a.coverCm
      })
  }

  /** 某样带归并后的有效记录 */
  function effectiveCoralsOfBelt(beltId: string | null | undefined): EffectiveCoralRecord[] {
    if (!beltId) return []
    return effectiveCorals.value.filter((item) => item.beltId === beltId)
  }

  /** 某样带的鱼类/无脊椎动物计数 */
  function fishesOfBelt(beltId: string | null | undefined): FishCount[] {
    if (!beltId) return []
    return fishes.value
      .filter((fish) => fish.beltId === beltId)
      .sort((a, b) => b.count - a.count)
  }

  /** 样带 id → 采样管数 / 鱼类记录数（样带列表回显用） */
  const beltRecordCounts = computed<Record<string, { coralCount: number; fishCount: number }>>(() => {
    const counts: Record<string, { coralCount: number; fishCount: number }> = {}
    belts.value.forEach((belt) => {
      counts[belt.id] = {
        coralCount: samples.value.filter((sample) => sample.beltId === belt.id).length,
        fishCount: fishes.value.filter((fish) => fish.beltId === belt.id).length
      }
    })
    return counts
  })

  /** 覆盖度汇总行（全部样带，属名按实验室口径归并） */
  const coverageRows = computed<CoverageSummaryRow[]>(() =>
    belts.value
      .map((belt) => {
        const site = sites.value.find((item) => item.id === belt.siteId)
        const reef = site ? reefs.value.find((item) => item.id === site.reefId) : undefined
        const beltCorals = effectiveCorals.value.filter((coral) => coral.beltId === belt.id)
        const beltSamples = samples.value.filter((sample) => sample.beltId === belt.id)
        const provisionalTubes = new Set(
          beltCorals.filter((coral) => coral.genusSource === '暂定').map((coral) => coral.tubeNo)
        )
        const beltFishes = fishes.value.filter((fish) => fish.beltId === belt.id)
        const coverCmTotal = round(
          beltCorals.reduce((sum, coral) => sum + coral.coverCm, 0),
          1
        )
        const provisionalCover = round(
          beltCorals
            .filter((coral) => coral.genusSource === '暂定')
            .reduce((sum, coral) => sum + coral.coverCm, 0),
          1
        )
        const distribution: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
        BLEACH_LEVELS.forEach((level) => {
          distribution[level] = round(
            beltCorals.filter((coral) => coral.bleachLevel === level).reduce((sum, coral) => sum + coral.coverCm, 0),
            1
          )
        })
        const index = bleachIndex(beltCorals)
        const fishTotal = beltFishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
        return {
          beltId: belt.id,
          beltNo: belt.no,
          reefId: reef?.id ?? '',
          reefName: reef?.name ?? '未知礁区',
          siteId: site?.id ?? '',
          siteNo: site?.no ?? '—',
          lengthM: belt.lengthM,
          orientation: belt.orientation,
          surveyDate: belt.surveyDate,
          observer: belt.observer,
          sampleCount: beltSamples.length,
          confirmedCount: beltSamples.length - provisionalTubes.size,
          provisionalCount: provisionalTubes.size,
          coverCmTotal,
          provisionalCoverCm: provisionalCover,
          coveragePct: coralCoveragePct(coverCmTotal, belt.lengthM),
          bleachIndex: index,
          grade: bleachGrade(index),
          bleachedSharePct: bleachedSharePct(beltCorals),
          distribution,
          fishTotal,
          invertebrateTotal: beltFishes
            .filter((fish) => fish.category === '无脊椎动物')
            .reduce((sum, fish) => sum + fish.count, 0),
          fishDensity: fishDensity(fishTotal, belt.lengthM)
        }
      })
      .sort((a, b) => b.bleachIndex - a.bleachIndex)
  )

  /** 按筛选条件过滤后的覆盖度行 */
  const filteredCoverageRows = computed<CoverageSummaryRow[]>(() =>
    coverageRows.value.filter((row) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${row.reefName}${row.siteNo}${row.beltNo}${row.observer}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.reefIds.length > 0 && !filter.value.reefIds.includes(row.reefId)) return false
      if (filter.value.bleachLevels.length > 0) {
        const matched = filter.value.bleachLevels.some((level) => row.distribution[level] > 0)
        if (!matched) return false
      }
      if (filter.value.onlyBleached && row.bleachedSharePct <= 0) return false
      if (filter.value.onlyProvisional && row.provisionalCount <= 0) return false
      return true
    })
  )

  const hasFilter = computed<boolean>(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.reefIds.length > 0 ||
      filter.value.bleachLevels.length > 0 ||
      filter.value.onlyBleached ||
      filter.value.onlyProvisional
  )

  /** 全局白化等级分布与总体指数（有效记录口径） */
  const globalStats = computed(() => {
    const records = effectiveCorals.value
    const distribution: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
    BLEACH_LEVELS.forEach((level) => {
      distribution[level] = round(
        records.filter((coral) => coral.bleachLevel === level).reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      )
    })
    const index = bleachIndex(records)
    return {
      sampleCount: samples.value.length,
      fishCount: fishes.value.length,
      confirmedCount: reconciliation.value.counts.confirmedCount,
      pendingCount: reconciliation.value.counts.pendingCount,
      coverCmTotal: round(
        records.reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      ),
      provisionalCoverCm: round(
        records.filter((coral) => coral.genusSource === '暂定').reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      ),
      bleachIndex: index,
      grade: bleachGrade(index),
      bleachedSharePct: bleachedSharePct(records),
      distribution
    }
  })

  function patchFilter(patch: Partial<SurveyFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptySurveyFilter()
  }

  function patchSampleDraft(patch: Partial<typeof sampleDraft.value>): void {
    sampleDraft.value = { ...sampleDraft.value, ...patch }
  }

  function patchFishDraft(patch: Partial<typeof fishDraft.value>): void {
    fishDraft.value = { ...fishDraft.value, ...patch }
  }

  /* ------------------------------ 采样管 ------------------------------ */

  /** 管号是否已存在（全局唯一） */
  function tubeNoExists(tubeNo: string, exceptId: string | null = null): boolean {
    return samples.value.some((sample) => sample.tubeNo === tubeNo && sample.id !== exceptId)
  }

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
    await db.samples.delete(id)
  }

  /** 批量导入粘贴行（替换该样带原有采样管）；重复管号在返回信息中提示 */
  async function importSampleRows(
    beltId: string,
    rows: Array<{ tubeNo: string; provisionalGenus: string; form: CoralForm; coverCm: number; bleachLevel: BleachLevel }>
  ): Promise<{ count: number; duplicated: string[] }> {
    const now = Date.now()
    const inBatch = new Set<string>()
    const duplicated: string[] = []
    const records: CoralSample[] = []
    rows.forEach((row, index) => {
      if (inBatch.has(row.tubeNo) || tubeNoExists(row.tubeNo)) duplicated.push(row.tubeNo)
      inBatch.add(row.tubeNo)
      records.push({
        id: createId('smp'),
        beltId,
        tubeNo: row.tubeNo,
        provisionalGenus: row.provisionalGenus,
        form: row.form,
        coverCm: row.coverCm,
        bleachLevel: row.bleachLevel,
        remark: '',
        createdAt: now + index,
        updatedAt: now + index
      })
    })
    await db.transaction('rw', [db.samples], async () => {
      await db.samples.where('beltId').equals(beltId).delete()
      if (records.length > 0) await db.samples.bulkPut(records)
    })
    return { count: records.length, duplicated }
  }

  /** 批量改写白化等级（外业现场动作，只动采样管） */
  async function bulkSetBleachLevel(ids: string[], bleachLevel: BleachLevel): Promise<number> {
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

  /* ------------------------------ 鱼类计数 ------------------------------ */

  async function createFish(
    beltId: string,
    payload: Omit<FishCount, 'id' | 'createdAt' | 'updatedAt' | 'beltId'>
  ): Promise<FishCount> {
    const now = Date.now()
    const row: FishCount = { ...payload, beltId, id: createId('fsh'), createdAt: now, updatedAt: now }
    await db.fishes.put(row)
    return row
  }

  async function updateFish(id: string, patch: Partial<FishCount>): Promise<void> {
    await db.fishes.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeFish(id: string): Promise<void> {
    await db.fishes.delete(id)
  }

  /** 批量导入粘贴行（替换该样带原有计数） */
  async function importFishRows(
    beltId: string,
    rows: Array<{ family: string; count: number; sizeClass: SizeClass; category: CountCategory }>
  ): Promise<number> {
    const now = Date.now()
    const records: FishCount[] = rows.map((row, index) => ({
      id: createId('fsh'),
      beltId,
      family: row.family,
      count: row.count,
      sizeClass: row.sizeClass,
      category: row.category,
      createdAt: now + index,
      updatedAt: now + index
    }))
    await db.transaction('rw', [db.fishes], async () => {
      await db.fishes.where('beltId').equals(beltId).delete()
      if (records.length > 0) await db.fishes.bulkPut(records)
    })
    return records.length
  }

  /** 按科名与体长段汇总某样带计数 */
  function fishSummaryOfBelt(beltId: string | null | undefined): Array<{
    family: string
    category: CountCategory
    total: number
    bySize: Record<SizeClass, number>
  }> {
    if (!beltId) return []
    const map = new Map<string, { family: string; category: CountCategory; total: number; bySize: Record<SizeClass, number> }>()
    fishesOfBelt(beltId).forEach((fish) => {
      const bucket =
        map.get(fish.family) ??
        { family: fish.family, category: fish.category, total: 0, bySize: { '0-10cm': 0, '11-20cm': 0, '21-30cm': 0, '>30cm': 0 } }
      bucket.total += fish.count
      bucket.bySize[fish.sizeClass] += fish.count
      map.set(fish.family, bucket)
    })
    return Array.from(map.values()).sort((a, b) => b.total - a.total)
  }

  return {
    samples,
    fishes,
    reefs,
    sites,
    belts,
    ready,
    error,
    filter,
    sampleDraft,
    fishDraft,
    reconciliation,
    effectiveCorals,
    beltRecordCounts,
    coverageRows,
    filteredCoverageRows,
    hasFilter,
    globalStats,
    start,
    samplesOfBelt,
    effectiveCoralsOfBelt,
    fishesOfBelt,
    fishSummaryOfBelt,
    tubeNoExists,
    patchFilter,
    resetFilter,
    patchSampleDraft,
    patchFishDraft,
    createSample,
    updateSample,
    removeSample,
    importSampleRows,
    bulkSetBleachLevel,
    createFish,
    updateFish,
    removeFish,
    importFishRows
  }
})
