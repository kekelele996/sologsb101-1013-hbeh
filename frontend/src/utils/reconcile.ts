/**
 * 外业采样管 × 实验室鉴定 的对账与归并（全应用唯一口径）。
 *
 * 口径（汇总与导出共用，不允许页面各算各的）：
 * - 有效属名 effectiveGenus：该管最近一条「成功」鉴定的鉴定属名；否则取外业暂定属名。
 * - 未出鉴定（含从未鉴定、仅失败、最近只失败）的管子：先按外业暂定属名计入，genusSource 标「暂定」。
 * - 鉴定重试只追加鉴定记录，外业采样管不改动；同管多条成功记录取 identifiedAt/createdAt 最新一条。
 * - 对账按管号：
 *   - orphanIdentifications：实验室有鉴定记录、外业没有对应采样管（列出等外业/实验室核对补录）。
 *   - pendingSamples：外业有采样管、实验室没有「成功」鉴定（列出等实验室补鉴定）。
 */
import type { BleachLevel, CoralForm } from '@/types/coralRecord'
import type { CoralSample } from '@/types/sample'
import type { Identification } from '@/types/identification'

/** 属名来源：实验室确认 / 外业暂定 */
export type GenusSource = '鉴定' | '暂定'

/** 归并到采样管上的有效结果（汇总、导出、各页面统一消费） */
export interface ResolvedSample {
  sample: CoralSample
  /** 管号 */
  tubeNo: string
  beltId: string
  /** 有效属名：实验室成功鉴定属名优先，否则外业暂定属名 */
  effectiveGenus: string
  /** 属名来源 */
  genusSource: GenusSource
  form: CoralForm
  coverCm: number
  bleachLevel: BleachLevel
  /** 该管最近一条成功鉴定（无则 null） */
  confirmed: Identification | null
  /** 该管最近一条鉴定（成功或失败，无则 null） */
  latest: Identification | null
  /** 该管累计鉴定次数（含失败重试） */
  attemptCount: number
  /** 实验室属名与外业暂定属名是否不一致 */
  genusChanged: boolean
}

/** 对账结果 */
export interface Reconciliation {
  /** 已归并有效结果的采样管（每管一行） */
  resolved: ResolvedSample[]
  /** 管号 → 归并结果 */
  byTube: Map<string, ResolvedSample>
  /** 实验室有、外业没有的鉴定（按管号聚成一组） */
  orphanIdentifications: Array<{ tubeNo: string; identifications: Identification[] }>
  /** 外业有、实验室没有成功鉴定的采样管 */
  pendingSamples: ResolvedSample[]
  /** 各状态计数 */
  counts: {
    sampleTotal: number
    confirmedCount: number
    pendingCount: number
    failedAttemptTubes: number
    genusChangedCount: number
    orphanTubeCount: number
  }
}

/** 取一管最新一条成功鉴定（按鉴定日期，再按创建时间） */
export function latestSuccessful(identifications: Identification[]): Identification | null {
  const success = identifications
    .filter((item) => item.status === '成功' && !!item.genus)
    .sort((a, b) => tieKey(b) - tieKey(a))
  return success[0] ?? null
}

/** 取一管最新一条鉴定（不限状态） */
export function latestIdentification(identifications: Identification[]): Identification | null {
  const sorted = [...identifications].sort((a, b) => tieKey(b) - tieKey(a))
  return sorted[0] ?? null
}

function tieKey(item: Identification): number {
  const day = Date.parse(`${item.identifiedAt}T00:00:00Z`)
  const datePart = Number.isFinite(day) ? day : 0
  return datePart * 1000 + (item.createdAt % 1000)
}

/**
 * 对账与归并：输入外业采样管与实验室鉴定记录，输出统一口径结果。
 */
export function reconcileSamples(
  samples: CoralSample[],
  identifications: Identification[]
): Reconciliation {
  const idByTube = new Map<string, Identification[]>()
  identifications.forEach((item) => {
    const list = idByTube.get(item.tubeNo) ?? []
    list.push(item)
    idByTube.set(item.tubeNo, list)
  })

  const resolved: ResolvedSample[] = samples.map((sample) => {
    const list = idByTube.get(sample.tubeNo) ?? []
    const confirmed = latestSuccessful(list)
    const latest = latestIdentification(list)
    const effectiveGenus = confirmed ? confirmed.genus : sample.provisionalGenus
    return {
      sample,
      tubeNo: sample.tubeNo,
      beltId: sample.beltId,
      effectiveGenus,
      genusSource: confirmed ? '鉴定' : '暂定',
      form: sample.form,
      coverCm: sample.coverCm,
      bleachLevel: sample.bleachLevel,
      confirmed,
      latest,
      attemptCount: list.length,
      genusChanged: !!confirmed && confirmed.genus !== sample.provisionalGenus
    }
  })

  const byTube = new Map(resolved.map((item) => [item.tubeNo, item]))
  const sampleTubes = new Set(samples.map((sample) => sample.tubeNo))

  const orphanIdentifications = Array.from(idByTube.entries())
    .filter(([tubeNo]) => !sampleTubes.has(tubeNo))
    .map(([tubeNo, list]) => ({
      tubeNo,
      identifications: [...list].sort((a, b) => tieKey(b) - tieKey(a))
    }))
    .sort((a, b) => a.tubeNo.localeCompare(b.tubeNo, 'zh-Hans-CN'))

  const pendingSamples = resolved
    .filter((item) => !item.confirmed)
    .sort((a, b) => a.tubeNo.localeCompare(b.tubeNo, 'zh-Hans-CN'))

  const counts = {
    sampleTotal: samples.length,
    confirmedCount: resolved.filter((item) => item.confirmed).length,
    pendingCount: pendingSamples.length,
    failedAttemptTubes: resolved.filter((item) => item.latest?.status === '失败').length,
    genusChangedCount: resolved.filter((item) => item.genusChanged).length,
    orphanTubeCount: orphanIdentifications.length
  }

  return { resolved, byTube, orphanIdentifications, pendingSamples, counts }
}

/** 归并后用于覆盖率 / 白化指数计算的最小记录结构 */
export interface EffectiveCoralRecord {
  tubeNo: string
  beltId: string
  genus: string
  genusSource: GenusSource
  form: CoralForm
  coverCm: number
  bleachLevel: BleachLevel
}

/** 取全部有效记录（可直接喂给 bleach.ts 的覆盖率 / 白化指数算法） */
export function effectiveRecords(reconciliation: Reconciliation): EffectiveCoralRecord[] {
  return reconciliation.resolved.map((item) => ({
    tubeNo: item.tubeNo,
    beltId: item.beltId,
    genus: item.effectiveGenus,
    genusSource: item.genusSource,
    form: item.form,
    coverCm: item.coverCm,
    bleachLevel: item.bleachLevel
  }))
}

/** 某样带的有效记录 */
export function effectiveRecordsOfBelt(
  reconciliation: Reconciliation,
  beltId: string
): EffectiveCoralRecord[] {
  return effectiveRecords(reconciliation).filter((item) => item.beltId === beltId)
}

/** 暂定覆盖长度合计（未拿到实验室成功鉴定的管子覆盖长度） */
export function provisionalCoverCm(records: Array<{ genusSource: GenusSource; coverCm: number }>): number {
  return records
    .filter((item) => item.genusSource === '暂定')
    .reduce((sum, item) => sum + item.coverCm, 0)
}
