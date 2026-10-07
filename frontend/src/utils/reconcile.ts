/**
 * 对账与属名归一口径
 * 外业样本管与实验室鉴定按管号对账；归并属名的唯一口径在此定义，
 * 汇总（页面）与导出（JSON / 复制结论）必须走同一套函数，不允许各算各的。
 *
 * 口径：
 * - 已成功鉴定：按实验室鉴定属名归并（最近一次成功鉴定为准）。
 * - 尚未出鉴定 / 鉴定失败：先按外业暂定属名计入，并标「暂定」；
 *   鉴定失败只在实验室侧重试，外业采集记录不动。
 * - 实验室有、外业没有管号：孤立鉴定，列出等实验室补，不参与覆盖率。
 */
import type { CoralSample } from '@/types/sample'
import type { CoralIdentification } from '@/types/identification'
import { round } from '@/utils/bleach'

/** 单管对账后的鉴定状态 */
export type ResolveStatus = '已鉴定' | '待鉴定' | '鉴定失败'

/** 属名来源 */
export type GenusSource = '实验室' | '外业暂定'

/** 样本管挂上鉴定结果后的对账行（汇总/导出统一消费） */
export interface ResolvedSample extends CoralSample {
  /** 对账状态 */
  resolveStatus: ResolveStatus
  /** 归并用属名（有效属名）：成功鉴定取实验室属名，否则取外业暂定属名 */
  effectiveGenus: string
  /** 有效属名来源 */
  genusSource: GenusSource
  /** 是否按暂定属名计入（待鉴定 / 鉴定失败） */
  provisional: boolean
  /** 实验室最近一次成功鉴定属名（无则 null） */
  labGenus: string | null
  /** 置信度 0~1（无成功鉴定为 null） */
  confidence: number | null
  /** 最近一次鉴定批次号（成功 / 失败都可能有） */
  batchNo: string | null
  /** 鉴定人 */
  identifier: string | null
  /** 鉴定日期 */
  identifiedAt: string | null
  /** 实验室属名与外业暂定属名是否不一致（已鉴定时） */
  genusChanged: boolean
}

/** 实验室有、外业没有的管号（孤立鉴定，等实验室补） */
export interface OrphanIdentification {
  tubeNo: string
  latest: CoralIdentification
  successGenus: string | null
  recordCount: number
}

export interface ReconcileResult {
  /** 全部外业样本管的对账行 */
  resolved: ResolvedSample[]
  /** 孤立鉴定（管号在外业样本中不存在），按管号归并 */
  orphans: OrphanIdentification[]
}

/** 取某管号的鉴定记录：先按鉴定日期再按录入时间排序，最新在前 */
function sortedIdents(list: CoralIdentification[]): CoralIdentification[] {
  return [...list].sort((a, b) => {
    const dateDiff = b.identifiedAt.localeCompare(a.identifiedAt)
    if (dateDiff !== 0) return dateDiff
    return b.createdAt - a.createdAt
  })
}

/** 把一管样本与其鉴定记录对账成一行 */
export function resolveSample(sample: CoralSample, idents: CoralIdentification[]): ResolvedSample {
  const ordered = sortedIdents(idents)
  const latestSuccess = ordered.find((item) => item.status === '成功' && item.genus.trim().length > 0)
  const latestAny = ordered[0] ?? null

  if (latestSuccess) {
    const labGenus = latestSuccess.genus.trim()
    return {
      ...sample,
      resolveStatus: '已鉴定',
      effectiveGenus: labGenus,
      genusSource: '实验室',
      provisional: false,
      labGenus,
      confidence: latestSuccess.confidence,
      batchNo: latestSuccess.batchNo,
      identifier: latestSuccess.identifier,
      identifiedAt: latestSuccess.identifiedAt,
      genusChanged: labGenus !== sample.fieldGenus.trim()
    }
  }

  // 没有成功鉴定：鉴定失败（有失败批次）或待鉴定，都先按外业暂定属名计入并标暂定
  const failed = latestAny && latestAny.status === '失败'
  return {
    ...sample,
    resolveStatus: failed ? '鉴定失败' : '待鉴定',
    effectiveGenus: sample.fieldGenus.trim(),
    genusSource: '外业暂定',
    provisional: true,
    labGenus: null,
    confidence: null,
    batchNo: latestAny?.batchNo ?? null,
    identifier: latestAny?.identifier ?? null,
    identifiedAt: latestAny?.identifiedAt ?? null,
    genusChanged: false
  }
}

/** 全量对账：外业样本 × 实验室鉴定，按管号关联 */
export function reconcileSamples(samples: CoralSample[], identifications: CoralIdentification[]): ReconcileResult {
  const identsByTube = new Map<string, CoralIdentification[]>()
  identifications.forEach((ident) => {
    const list = identsByTube.get(ident.tubeNo) ?? []
    list.push(ident)
    identsByTube.set(ident.tubeNo, list)
  })

  const sampleTubes = new Set(samples.map((sample) => sample.tubeNo))
  const resolved = samples.map((sample) => resolveSample(sample, identsByTube.get(sample.tubeNo) ?? []))

  const orphans: OrphanIdentification[] = []
  identsByTube.forEach((list, tubeNo) => {
    if (sampleTubes.has(tubeNo)) return
    const ordered = sortedIdents(list)
    const success = ordered.find((item) => item.status === '成功' && item.genus.trim().length > 0) ?? null
    orphans.push({
      tubeNo,
      latest: ordered[0],
      successGenus: success ? success.genus.trim() : null,
      recordCount: list.length
    })
  })
  orphans.sort((a, b) => a.tubeNo.localeCompare(b.tubeNo, 'zh-Hans-CN'))

  return { resolved, orphans }
}

/** 按属名归并的桶（汇总视图与导出共用） */
export interface GenusBucket {
  genus: string
  coverCm: number
  count: number
  /** 其中按外业暂定属名计入的管数 */
  provisionalCount: number
  /** 其中按外业暂定属名计入的覆盖长度 */
  provisionalCoverCm: number
}

/**
 * 按有效属名归并覆盖长度：已鉴定按实验室属名，未鉴定 / 失败按外业暂定属名（计入 provisional）。
 */
export function groupResolvedByGenus(rows: ResolvedSample[]): GenusBucket[] {
  const map = new Map<string, GenusBucket>()
  rows.forEach((row) => {
    const bucket = map.get(row.effectiveGenus) ?? {
      genus: row.effectiveGenus,
      coverCm: 0,
      count: 0,
      provisionalCount: 0,
      provisionalCoverCm: 0
    }
    bucket.coverCm += row.coverCm
    bucket.count += 1
    if (row.provisional) {
      bucket.provisionalCount += 1
      bucket.provisionalCoverCm += row.coverCm
    }
    map.set(row.effectiveGenus, bucket)
  })
  return Array.from(map.values())
    .map((bucket) => ({
      ...bucket,
      coverCm: round(bucket.coverCm, 1),
      provisionalCoverCm: round(bucket.provisionalCoverCm, 1)
    }))
    .sort((a, b) => b.coverCm - a.coverCm)
}
