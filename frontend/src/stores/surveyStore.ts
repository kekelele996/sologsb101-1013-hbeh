/**
 * 普查 store：维护鱼类计数、覆盖度筛选条件与覆盖度派生值。
 * 覆盖 /belts/:id/fishes 与 /coverage 两页；珊瑚侧样本管 / 鉴定在 labStore，
 * 本 store 只读 labStore 的对账结果（有效属名口径）做汇总。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { BleachLevel } from '@/types/coralRecord'
import type { CountCategory, FishCount, SizeClass } from '@/types/fishCount'
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import type { ResolvedSample } from '@/utils/reconcile'
import { bleachGrade, bleachIndex, bleachedSharePct, coralCoveragePct, fishDensity, round } from '@/utils/bleach'
import { useLabStore } from '@/stores/labStore'

/** 覆盖度汇总页筛选条件 */
export interface SurveyFilterState {
  keyword: string
  reefIds: string[]
  bleachLevels: BleachLevel[]
  /** 是否只看白化指数高于阈值的样带 */
  onlyBleached: boolean
}

export function createEmptySurveyFilter(): SurveyFilterState {
  return {
    keyword: '',
    reefIds: [],
    bleachLevels: [],
    onlyBleached: false
  }
}

/** 覆盖度汇总行 */
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
  /** 其中按外业暂定属名计入（待鉴定 / 鉴定失败）的管数 */
  provisionalCount: number
  coverCmTotal: number
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
  const fishes = ref<FishCount[]>([])
  const reefs = ref<Reef[]>([])
  const sites = ref<Site[]>([])
  const belts = ref<Belt[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const filter = ref<SurveyFilterState>(createEmptySurveyFilter())
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
    watchTable<FishCount>(() => db.fishes).subscribe((rows) => {
      fishes.value = rows
      ready.value = true
      error.value = null
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

  /** 已按管号对账的样本管（有效属名口径，与导出一致） */
  const resolvedSamples = computed<ResolvedSample[]>(() => labStore.resolvedSamples)

  /** 某样带的鱼类/无脊椎动物计数 */
  function fishesOfBelt(beltId: string | null | undefined): FishCount[] {
    if (!beltId) return []
    return fishes.value
      .filter((fish) => fish.beltId === beltId)
      .sort((a, b) => b.count - a.count)
  }

  /** 样带 id → 样本管数 / 鱼类记录数（样带列表回显用） */
  const beltRecordCounts = computed<Record<string, { sampleCount: number; fishCount: number }>>(() => {
    const counts: Record<string, { sampleCount: number; fishCount: number }> = {}
    belts.value.forEach((belt) => {
      counts[belt.id] = {
        sampleCount: resolvedSamples.value.filter((sample) => sample.beltId === belt.id).length,
        fishCount: fishes.value.filter((fish) => fish.beltId === belt.id).length
      }
    })
    return counts
  })

  /** 覆盖度汇总行（全部样带）：覆盖长度与白化指数按有效属名口径的样本管累计 */
  const coverageRows = computed<CoverageSummaryRow[]>(() =>
    belts.value
      .map((belt) => {
        const site = sites.value.find((item) => item.id === belt.siteId)
        const reef = site ? reefs.value.find((item) => item.id === site.reefId) : undefined
        const beltSamples = resolvedSamples.value.filter((sample) => sample.beltId === belt.id)
        const beltFishes = fishes.value.filter((fish) => fish.beltId === belt.id)
        const coverCmTotal = round(
          beltSamples.reduce((sum, sample) => sum + sample.coverCm, 0),
          1
        )
        const distribution: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
        ;(['无', '轻', '中', '重', '死亡'] as BleachLevel[]).forEach((level) => {
          distribution[level] = round(
            beltSamples.filter((sample) => sample.bleachLevel === level).reduce((sum, sample) => sum + sample.coverCm, 0),
            1
          )
        })
        const index = bleachIndex(beltSamples)
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
          provisionalCount: beltSamples.filter((sample) => sample.provisional).length,
          coverCmTotal,
          coveragePct: coralCoveragePct(coverCmTotal, belt.lengthM),
          bleachIndex: index,
          grade: bleachGrade(index),
          bleachedSharePct: bleachedSharePct(beltSamples),
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
      return true
    })
  )

  const hasFilter = computed<boolean>(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.reefIds.length > 0 ||
      filter.value.bleachLevels.length > 0 ||
      filter.value.onlyBleached
  )

  /** 全局白化等级分布与总体指数（样本管有效属名口径） */
  const globalStats = computed(() => {
    const distribution: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
    ;(['无', '轻', '中', '重', '死亡'] as BleachLevel[]).forEach((level) => {
      distribution[level] = round(
        resolvedSamples.value.filter((sample) => sample.bleachLevel === level).reduce((sum, sample) => sum + sample.coverCm, 0),
        1
      )
    })
    const index = bleachIndex(resolvedSamples.value)
    return {
      sampleCount: resolvedSamples.value.length,
      provisionalCount: resolvedSamples.value.filter((sample) => sample.provisional).length,
      fishCount: fishes.value.length,
      coverCmTotal: round(
        resolvedSamples.value.reduce((sum, sample) => sum + sample.coverCm, 0),
        1
      ),
      bleachIndex: index,
      grade: bleachGrade(index),
      bleachedSharePct: bleachedSharePct(resolvedSamples.value),
      distribution
    }
  })

  function patchFilter(patch: Partial<SurveyFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptySurveyFilter()
  }

  function patchFishDraft(patch: Partial<typeof fishDraft.value>): void {
    fishDraft.value = { ...fishDraft.value, ...patch }
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
    resolvedSamples,
    fishes,
    reefs,
    sites,
    belts,
    ready,
    error,
    filter,
    fishDraft,
    beltRecordCounts,
    coverageRows,
    filteredCoverageRows,
    hasFilter,
    globalStats,
    start,
    fishesOfBelt,
    fishSummaryOfBelt,
    patchFilter,
    resetFilter,
    patchFishDraft,
    createFish,
    updateFish,
    removeFish,
    importFishRows
  }
})
