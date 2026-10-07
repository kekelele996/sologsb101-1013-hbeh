/**
 * useCoverage：按样带或站位汇总珊瑚覆盖率、白化占比与鱼类密度。
 * 属名一律使用 utils/reconcile 的统一口径：实验室成功鉴定属名优先，否则外业暂定（标暂定）。
 * 被外业采样页（/belts/:id/samples）、鱼类计数页（/belts/:id/fishes）
 * 与覆盖度汇总页（/coverage）消费。
 */
import { computed, type ComputedRef } from 'vue'
import { storeToRefs } from 'pinia'
import { useReefStore } from '@/stores/reefStore'
import { useBeltStore } from '@/stores/beltStore'
import { useSurveyStore } from '@/stores/surveyStore'
import type { BleachLevel, CoralForm } from '@/types/coralRecord'
import { BLEACH_LEVELS } from '@/types/coralRecord'
import type { FishCount } from '@/types/fishCount'
import type { GenusSource } from '@/utils/reconcile'
import {
  bleachGrade,
  bleachIndex,
  bleachedSharePct,
  coralCoveragePct,
  fishDensity,
  groupByForm,
  groupByGenus,
  round
} from '@/utils/bleach'

/** 单条样带的覆盖度成果 */
export interface BeltCoverage {
  beltId: string
  beltNo: string
  siteId: string
  siteNo: string
  reefId: string
  reefName: string
  lengthM: number
  orientation: string
  surveyDate: string
  observer: string
  sampleCount: number
  confirmedCount: number
  provisionalCount: number
  coverCmTotal: number
  /** 暂定属名管子覆盖长度合计 */
  provisionalCoverCm: number
  coveragePct: number
  bleachIndex: number
  grade: BleachLevel
  bleachedSharePct: number
  distribution: Record<BleachLevel, number>
  /** 按实验室有效属名分组的覆盖长度 */
  byGenus: Array<{ genus: string; coverCm: number; provisionalCoverCm: number }>
  byForm: Array<{ form: CoralForm; coverCm: number }>
  fishTotal: number
  invertebrateTotal: number
  fishDensity: number
}

/** 单个站位的覆盖度汇总 */
export interface SiteCoverage {
  siteId: string
  siteNo: string
  reefId: string
  reefName: string
  depthM: number
  beltCount: number
  sampleCount: number
  provisionalCount: number
  coverCmTotal: number
  avgCoveragePct: number
  avgBleachIndex: number
  grade: BleachLevel
  bleachedSharePct: number
  fishTotal: number
  invertebrateTotal: number
  fishDensity: number
}

/** 按白化等级排序的采样管行（外业采样页表格用） */
export interface SampleRow {
  tubeNo: string
  genus: string
  genusSource: GenusSource
  /** 占样带长度比例（%） */
  coverSharePct: number
  /** 外业暂定属名（genusSource=鉴定 时与 genus 可能不同） */
  provisionalGenus: string
  form: CoralForm
  coverCm: number
  bleachLevel: BleachLevel
  confidence: number | null
  identifier: string
  batchNo: string
}

export interface UseCoverageResult {
  beltCoverage: (beltId: string | null | undefined) => ComputedRef<BeltCoverage | null>
  siteCoverage: (siteId: string | null | undefined) => ComputedRef<SiteCoverage | null>
  allBeltCoverages: ComputedRef<BeltCoverage[]>
  allSiteCoverages: ComputedRef<SiteCoverage[]>
  globalDistribution: ComputedRef<Record<BleachLevel, number>>
  sampleRows: (beltId: string | null | undefined) => ComputedRef<SampleRow[]>
  fishRows: (beltId: string | null | undefined) => ComputedRef<Array<{ record: FishCount; density: number }>>
}

const BLEACH_WEIGHT_ORDER: Record<BleachLevel, number> = {
  无: 0,
  轻: 1,
  中: 2,
  重: 3,
  死亡: 4
}

const EMPTY_DISTRIBUTION = (): Record<BleachLevel, number> => ({ 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 })

export function useCoverage(): UseCoverageResult {
  const reefStore = useReefStore()
  const beltStore = useBeltStore()
  const surveyStore = useSurveyStore()

  const { reefs, sites } = storeToRefs(reefStore)
  const { belts } = storeToRefs(beltStore)
  const { samples, fishes, effectiveCorals, reconciliation } = storeToRefs(surveyStore)

  const siteOf = (siteId: string) => sites.value.find((site) => site.id === siteId) ?? null
  const reefOf = (reefId: string) => reefs.value.find((reef) => reef.id === reefId) ?? null

  function buildBeltCoverage(beltId: string): BeltCoverage | null {
    const belt = belts.value.find((item) => item.id === beltId)
    if (!belt) return null
    const site = siteOf(belt.siteId)
    const reef = site ? reefOf(site.reefId) : null
    const beltCorals = effectiveCorals.value.filter((coral) => coral.beltId === belt.id)
    const beltSamples = samples.value.filter((sample) => sample.beltId === belt.id)
    const beltFishes = fishes.value.filter((fish) => fish.beltId === belt.id)
    const provisionalRecords = beltCorals.filter((coral) => coral.genusSource === '暂定')
    const provisionalTubes = new Set(provisionalRecords.map((coral) => coral.tubeNo))
    const coverCmTotal = round(
      beltCorals.reduce((sum, coral) => sum + coral.coverCm, 0),
      1
    )
    const provisionalCover = round(
      provisionalRecords.reduce((sum, coral) => sum + coral.coverCm, 0),
      1
    )
    const index = bleachIndex(beltCorals)
    const distribution = EMPTY_DISTRIBUTION()
    BLEACH_LEVELS.forEach((level) => {
      distribution[level] = round(
        beltCorals.filter((coral) => coral.bleachLevel === level).reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      )
    })
    const genusAgg = new Map<string, { coverCm: number; provisionalCoverCm: number }>()
    groupByGenus(beltCorals).forEach((group) => {
      const provisional = round(
        beltCorals
          .filter((coral) => coral.genus === group.genus && coral.genusSource === '暂定')
          .reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      )
      genusAgg.set(group.genus, { coverCm: group.coverCm, provisionalCoverCm: provisional })
    })
    const fishTotal = beltFishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
    const invertebrateTotal = beltFishes
      .filter((fish) => fish.category === '无脊椎动物')
      .reduce((sum, fish) => sum + fish.count, 0)
    return {
      beltId: belt.id,
      beltNo: belt.no,
      siteId: site?.id ?? '',
      siteNo: site?.no ?? '—',
      reefId: reef?.id ?? '',
      reefName: reef?.name ?? '未知礁区',
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
      byGenus: Array.from(genusAgg.entries()).map(([genus, value]) => ({ genus, ...value })),
      byForm: groupByForm(beltCorals),
      fishTotal,
      invertebrateTotal,
      fishDensity: fishDensity(fishTotal, belt.lengthM)
    }
  }

  function beltCoverage(beltId: string | null | undefined): ComputedRef<BeltCoverage | null> {
    return computed(() => (beltId ? buildBeltCoverage(beltId) : null))
  }

  const allBeltCoverages = computed<BeltCoverage[]>(() =>
    belts.value
      .map((belt) => buildBeltCoverage(belt.id))
      .filter((item): item is BeltCoverage => item !== null)
      .sort((a, b) => b.bleachIndex - a.bleachIndex)
  )

  function buildSiteCoverage(siteId: string): SiteCoverage | null {
    const site = siteOf(siteId)
    if (!site) return null
    const reef = reefOf(site.reefId)
    const siteBelts = belts.value.filter((belt) => belt.siteId === site.id)
    const beltIds = new Set(siteBelts.map((belt) => belt.id))
    const siteCorals = effectiveCorals.value.filter((coral) => beltIds.has(coral.beltId))
    const siteSamples = samples.value.filter((sample) => beltIds.has(sample.beltId))
    const siteFishes = fishes.value.filter((fish) => beltIds.has(fish.beltId))
    const provisionalTubes = new Set(
      siteCorals.filter((coral) => coral.genusSource === '暂定').map((coral) => coral.tubeNo)
    )
    const coverCmTotal = round(
      siteCorals.reduce((sum, coral) => sum + coral.coverCm, 0),
      1
    )
    const coverages = siteBelts.map((belt) => {
      const beltCorals = siteCorals.filter((coral) => coral.beltId === belt.id)
      return coralCoveragePct(
        beltCorals.reduce((sum, coral) => sum + coral.coverCm, 0),
        belt.lengthM
      )
    })
    const indices = siteBelts.map((belt) => bleachIndex(siteCorals.filter((coral) => coral.beltId === belt.id)))
    const avgBleachIndex =
      indices.length === 0 ? 0 : round(indices.reduce((sum, value) => sum + value, 0) / indices.length, 2)
    const fishTotal = siteFishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
    const totalBeltLength = siteBelts.reduce((sum, belt) => sum + belt.lengthM, 0)
    return {
      siteId: site.id,
      siteNo: site.no,
      reefId: reef?.id ?? '',
      reefName: reef?.name ?? '未知礁区',
      depthM: site.depthM,
      beltCount: siteBelts.length,
      sampleCount: siteSamples.length,
      provisionalCount: provisionalTubes.size,
      coverCmTotal,
      avgCoveragePct:
        coverages.length === 0 ? 0 : round(coverages.reduce((sum, value) => sum + value, 0) / coverages.length, 2),
      avgBleachIndex,
      grade: bleachGrade(avgBleachIndex),
      bleachedSharePct: bleachedSharePct(siteCorals),
      fishTotal,
      invertebrateTotal: siteFishes
        .filter((fish) => fish.category === '无脊椎动物')
        .reduce((sum, fish) => sum + fish.count, 0),
      fishDensity: fishDensity(fishTotal, totalBeltLength)
    }
  }

  function siteCoverage(siteId: string | null | undefined): ComputedRef<SiteCoverage | null> {
    return computed(() => (siteId ? buildSiteCoverage(siteId) : null))
  }

  const allSiteCoverages = computed<SiteCoverage[]>(() =>
    sites.value
      .map((site) => buildSiteCoverage(site.id))
      .filter((item): item is SiteCoverage => item !== null)
      .sort((a, b) => b.avgBleachIndex - a.avgBleachIndex)
  )

  const globalDistribution = computed<Record<BleachLevel, number>>(() => {
    const distribution = EMPTY_DISTRIBUTION()
    BLEACH_LEVELS.forEach((level) => {
      distribution[level] = round(
        effectiveCorals.value
          .filter((coral) => coral.bleachLevel === level)
          .reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      )
    })
    return distribution
  })

  function sampleRows(beltId: string | null | undefined): ComputedRef<SampleRow[]> {
    return computed(() => {
      if (!beltId) return []
      const belt = belts.value.find((item) => item.id === beltId)
      const beltLengthCm = belt ? belt.lengthM * 100 : 0
      const byTube = reconciliation.value.byTube
      return samples.value
        .filter((sample) => sample.beltId === beltId)
        .map((sample) => {
          const resolved = byTube.get(sample.tubeNo)
          return {
            tubeNo: sample.tubeNo,
            genus: resolved?.effectiveGenus ?? sample.provisionalGenus,
            genusSource: resolved?.genusSource ?? '暂定',
            provisionalGenus: sample.provisionalGenus,
            form: sample.form,
            coverCm: sample.coverCm,
            bleachLevel: sample.bleachLevel,
            confidence: resolved?.confirmed?.confidence ?? null,
            identifier: resolved?.confirmed?.identifier ?? '',
            batchNo: resolved?.confirmed?.batchNo ?? '',
            coverSharePct: beltLengthCm > 0 ? round((sample.coverCm / beltLengthCm) * 100, 1) : 0
          }
        })
        .sort((a, b) => {
          const weightDiff = BLEACH_WEIGHT_ORDER[b.bleachLevel] - BLEACH_WEIGHT_ORDER[a.bleachLevel]
          if (weightDiff !== 0) return weightDiff
          return b.coverCm - a.coverCm
        })
    })
  }

  function fishRows(beltId: string | null | undefined): ComputedRef<Array<{ record: FishCount; density: number }>> {
    return computed(() => {
      if (!beltId) return []
      const belt = belts.value.find((item) => item.id === beltId)
      const lengthM = belt?.lengthM ?? 0
      return fishes.value
        .filter((fish) => fish.beltId === beltId)
        .map((record) => ({ record, density: fishDensity(record.count, lengthM) }))
        .sort((a, b) => b.record.count - a.record.count)
    })
  }

  return {
    beltCoverage,
    siteCoverage,
    allBeltCoverages,
    allSiteCoverages,
    globalDistribution,
    sampleRows,
    fishRows
  }
}
