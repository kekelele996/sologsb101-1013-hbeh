/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入；
 * 按样带 / 礁区的覆盖度结论与 CSV 导出；以及旧版（v2，含 corals 表）备份的兼容升级。
 * 属名归并一律经 utils/reconcile 的统一口径（实验室成功鉴定属名优先，否则外业暂定并标暂定）。
 */
import {
  db,
  DB_NAME,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'
import { BLEACH_LEVELS, type BleachLevel } from '@/types/coralRecord'
import type { CoralSample } from '@/types/sample'
import type { Identification } from '@/types/identification'
import {
  effectiveRecords,
  reconcileSamples,
  type EffectiveCoralRecord
} from '@/utils/reconcile'
import { legacyCoralsToSamples, type LegacyCoralRecord } from '@/utils/migration'
import { bleachGrade, bleachIndex, bleachedSharePct, coralCoveragePct, fishDensity, round } from '@/utils/bleach'

/** 备份集合键名（v3 六张表） */
export const BACKUP_KEYS = ['reefs', 'sites', 'belts', 'samples', 'identifications', 'fishes'] as const
export type BackupKey = (typeof BACKUP_KEYS)[number]

export type CountMap = Record<BackupKey, number>

/** 组装当前本地数据的完整快照 */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [reefs, sites, belts, samples, identifications, fishes] = await Promise.all([
    db.reefs.toArray(),
    db.sites.toArray(),
    db.belts.toArray(),
    db.samples.toArray(),
    db.identifications.toArray(),
    db.fishes.toArray()
  ])
  return {
    app: 'gbcoralbelt',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    reefs,
    sites,
    belts,
    samples,
    identifications,
    fishes
  }
}

/**
 * 校验外部 JSON 是否为本站可识别的备份文件。
 * v2 旧备份没有 samples / identifications、但有 corals 表：校验通过并在导入时补成待鉴定采样管。
 */
export function validateBackup(input: unknown): {
  ok: boolean
  errors: string[]
  payload: BackupPayload | null
  legacy: boolean
} {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null, legacy: false }
  }
  const obj = input as Partial<BackupPayload> & { corals?: LegacyCoralRecord[] }
  if (obj.app !== undefined && obj.app !== 'gbcoralbelt') {
    errors.push('app 字段应为 gbcoralbelt，文件来源不明')
  }
  for (const key of ['reefs', 'sites', 'belts', 'fishes'] as const) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  const legacy = !Array.isArray(obj.samples) && Array.isArray(obj.corals)
  if (!Array.isArray(obj.samples) && !legacy) errors.push('samples 字段缺失或不是数组')
  if (errors.length > 0) return { ok: false, errors, payload: null, legacy: false }

  const migratedSamples: CoralSample[] = legacy
    ? legacyCoralsToSamples(obj.corals ?? [], [])
    : (obj.samples ?? [])
  const payload: BackupPayload = {
    app: 'gbcoralbelt',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    reefs: obj.reefs ?? [],
    sites: obj.sites ?? [],
    belts: obj.belts ?? [],
    samples: migratedSamples,
    identifications: Array.isArray(obj.identifications) ? obj.identifications : [],
    fishes: obj.fishes ?? []
  }
  return { ok: true, errors, payload, legacy }
}

/** 统计快照各表行数 */
export function countPayload(payload: BackupPayload): CountMap {
  return {
    reefs: payload.reefs.length,
    sites: payload.sites.length,
    belts: payload.belts.length,
    samples: payload.samples.length,
    identifications: payload.identifications.length,
    fishes: payload.fishes.length
  }
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(): Promise<{ fileName: string; counts: CountMap }> {
  const payload = await buildBackupPayload()
  const fileName = `${DB_NAME}-backup-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  stampBackupTime(payload.exportedAt)
  return { fileName, counts: countPayload(payload) }
}

/** 读取用户选择的备份文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/** 导入快照：overwrite=true 先清空全部表，否则按主键合并 */
export async function importBackup(payload: BackupPayload, overwrite: boolean): Promise<CountMap> {
  if (overwrite) await clearAllTables()
  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.belts, db.samples, db.identifications, db.fishes],
    async () => {
      await db.reefs.bulkPut(payload.reefs)
      await db.sites.bulkPut(payload.sites)
      await db.belts.bulkPut(payload.belts)
      await db.samples.bulkPut(payload.samples)
      await db.identifications.bulkPut(payload.identifications)
      await db.fishes.bulkPut(payload.fishes)
    }
  )
  return countPayload(payload)
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案；鉴定记录按管号跟随重映射 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const reefMap = new Map<string, string>()
  const siteMap = new Map<string, string>()
  const beltMap = new Map<string, string>()
  const tubeMap = new Map<string, string>()

  const reefs = payload.reefs.map((reef) => {
    const id = createId('reef')
    reefMap.set(reef.id, id)
    return { ...reef, id }
  })
  const sites = payload.sites.map((site) => {
    const id = createId('site')
    siteMap.set(site.id, id)
    return { ...site, id, reefId: reefMap.get(site.reefId) ?? site.reefId }
  })
  const belts = payload.belts.map((belt) => {
    const id = createId('belt')
    beltMap.set(belt.id, id)
    return { ...belt, id, siteId: siteMap.get(belt.siteId) ?? belt.siteId }
  })
  const samples = payload.samples.map((sample) => {
    const id = createId('smp')
    const tubeNo = `${sample.tubeNo}-X${Date.now().toString(36).slice(-4)}${Math.random()
      .toString(36)
      .slice(2, 5)}`
    tubeMap.set(sample.tubeNo, tubeNo)
    return {
      ...sample,
      id,
      tubeNo,
      beltId: beltMap.get(sample.beltId) ?? sample.beltId
    }
  })
  const identifications = payload.identifications.map((identification) => ({
    ...identification,
    id: createId('idn'),
    tubeNo: tubeMap.get(identification.tubeNo) ?? identification.tubeNo
  }))
  const fishes = payload.fishes.map((fish) => ({
    ...fish,
    id: createId('fsh'),
    beltId: beltMap.get(fish.beltId) ?? fish.beltId
  }))
  return { ...payload, reefs, sites, belts, samples, identifications, fishes }
}

/** 白化等级分布：各等级累计覆盖长度 */
export type BleachDistribution = Record<BleachLevel, number>

/** 覆盖度结论行：按样带汇总珊瑚覆盖率、白化占比与鱼类密度（有效属名口径） */
export interface CoverageLine {
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
  confirmedCount: number
  provisionalCount: number
  coverCmTotal: number
  /** 暂定属名管子覆盖长度合计 */
  provisionalCoverCm: number
  coveragePct: number
  bleachIndex: number
  grade: BleachLevel
  bleachedSharePct: number
  distribution: BleachDistribution
  /** 按实验室有效属名归并的覆盖长度 */
  byGenus: Array<{ genus: string; coverCm: number; provisionalCoverCm: number }>
  fishTotal: number
  invertebrateTotal: number
  fishDensity: number
  conclusion: string
}

function emptyDistribution(): BleachDistribution {
  return { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
}

/** 快照归并：采样管 + 鉴定 → 每管有效记录（与页面同一口径） */
export function resolvePayloadRecords(payload: BackupPayload): EffectiveCoralRecord[] {
  return effectiveRecords(reconcileSamples(payload.samples, payload.identifications))
}

/** 按样带生成覆盖度结论行（汇总与导出同一口径） */
export function buildCoverageLines(payload: BackupPayload): CoverageLine[] {
  const reefById = new Map(payload.reefs.map((reef) => [reef.id, reef]))
  const siteById = new Map(payload.sites.map((site) => [site.id, site]))
  const resolved = resolvePayloadRecords(payload)
  const coralsByBelt = new Map<string, EffectiveCoralRecord[]>()
  resolved.forEach((coral) => {
    const list = coralsByBelt.get(coral.beltId) ?? []
    list.push(coral)
    coralsByBelt.set(coral.beltId, list)
  })
  const samplesByBelt = new Map<string, CoralSample[]>()
  payload.samples.forEach((sample) => {
    const list = samplesByBelt.get(sample.beltId) ?? []
    list.push(sample)
    samplesByBelt.set(sample.beltId, list)
  })
  const fishesByBelt = new Map<string, typeof payload.fishes>()
  payload.fishes.forEach((fish) => {
    const list = fishesByBelt.get(fish.beltId) ?? []
    list.push(fish)
    fishesByBelt.set(fish.beltId, list)
  })

  return payload.belts
    .map((belt) => {
      const site = siteById.get(belt.siteId)
      const reef = site ? reefById.get(site.reefId) : undefined
      const corals = coralsByBelt.get(belt.id) ?? []
      const beltSamples = samplesByBelt.get(belt.id) ?? []
      const fishes = fishesByBelt.get(belt.id) ?? []
      const provisionalRecords = corals.filter((coral) => coral.genusSource === '暂定')
      const provisionalCount = new Set(provisionalRecords.map((coral) => coral.tubeNo)).size
      const coverCmTotal = round(
        corals.reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      )
      const provisionalCover = round(
        provisionalRecords.reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      )
      const index = bleachIndex(corals)
      const grade = bleachGrade(index)
      const coveragePct = coralCoveragePct(coverCmTotal, belt.lengthM)
      const sharePct = bleachedSharePct(corals)
      const distribution = emptyDistribution()
      BLEACH_LEVELS.forEach((level) => {
        distribution[level] = round(
          corals.filter((coral) => coral.bleachLevel === level).reduce((sum, coral) => sum + coral.coverCm, 0),
          1
        )
      })
      const genusMap = new Map<string, { coverCm: number; provisionalCoverCm: number }>()
      corals.forEach((coral) => {
        const bucket = genusMap.get(coral.genus) ?? { coverCm: 0, provisionalCoverCm: 0 }
        bucket.coverCm += coral.coverCm
        if (coral.genusSource === '暂定') bucket.provisionalCoverCm += coral.coverCm
        genusMap.set(coral.genus, bucket)
      })
      const byGenus = Array.from(genusMap.entries())
        .map(([genus, value]) => ({
          genus,
          coverCm: round(value.coverCm, 1),
          provisionalCoverCm: round(value.provisionalCoverCm, 1)
        }))
        .sort((a, b) => b.coverCm - a.coverCm)
      const fishTotal = fishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
      const invertebrateTotal = fishes
        .filter((fish) => fish.category === '无脊椎动物')
        .reduce((sum, fish) => sum + fish.count, 0)
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
        confirmedCount: beltSamples.length - provisionalCount,
        provisionalCount,
        coverCmTotal,
        provisionalCoverCm: provisionalCover,
        coveragePct,
        bleachIndex: index,
        grade,
        bleachedSharePct: sharePct,
        distribution,
        byGenus,
        fishTotal,
        invertebrateTotal,
        fishDensity: fishDensity(fishTotal, belt.lengthM),
        conclusion:
          beltSamples.length === 0
            ? '该样带尚未采集样本管'
            : `珊瑚覆盖率 ${coveragePct}%，白化指数 ${index}（${grade}），白化占比 ${sharePct}%；已鉴定 ${
                beltSamples.length - provisionalCount
              } 管 / 暂定 ${provisionalCount} 管`
      }
    })
    .sort((a, b) => b.bleachIndex - a.bleachIndex)
}

/** 按礁区汇总：站位/样带数量、平均白化指数与总体等级（有效属名口径） */
export interface ReefSummary {
  reefId: string
  reefName: string
  protectStatus: string
  siteCount: number
  beltCount: number
  sampleCount: number
  confirmedCount: number
  provisionalCount: number
  coverCmTotal: number
  avgBleachIndex: number
  grade: BleachLevel
  fishTotal: number
}

export function buildReefSummaries(payload: BackupPayload, lines: CoverageLine[]): ReefSummary[] {
  const reconciliation = reconcileSamples(payload.samples, payload.identifications)
  return payload.reefs.map((reef) => {
    const siteIds = new Set(payload.sites.filter((site) => site.reefId === reef.id).map((site) => site.id))
    const beltIds = new Set(payload.belts.filter((belt) => siteIds.has(belt.siteId)).map((belt) => belt.id))
    const reefSamples = payload.samples.filter((sample) => beltIds.has(sample.beltId))
    const provisionalTubeNos = new Set(
      reconciliation.resolved
        .filter((item) => beltIds.has(item.beltId) && item.genusSource === '暂定')
        .map((item) => item.tubeNo)
    )
    const lines4Reef = lines.filter((line) => line.reefId === reef.id)
    const avgBleachIndex =
      lines4Reef.length === 0
        ? 0
        : round(lines4Reef.reduce((sum, line) => sum + line.bleachIndex, 0) / lines4Reef.length, 2)
    return {
      reefId: reef.id,
      reefName: reef.name,
      protectStatus: reef.protectStatus,
      siteCount: siteIds.size,
      beltCount: beltIds.size,
      sampleCount: reefSamples.length,
      confirmedCount: reefSamples.length - provisionalTubeNos.size,
      provisionalCount: provisionalTubeNos.size,
      coverCmTotal: round(
        reefSamples.reduce((sum, sample) => sum + sample.coverCm, 0),
        1
      ),
      avgBleachIndex,
      grade: bleachGrade(avgBleachIndex),
      fishTotal: payload.fishes
        .filter((fish) => beltIds.has(fish.beltId))
        .reduce((sum, fish) => sum + fish.count, 0)
    }
  })
}

/** 字段值转 CSV 单元格（含逗号 / 引号 / 换行时加引号转义） */
function csvCell(value: string | number): string {
  const text = String(value)
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

/** 下载文本文件（CSV 导出共用） */
function downloadText(fileName: string, text: string): void {
  const blob = new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/**
 * 导出两张 CSV：
 * 1) 样带覆盖度结论（属名为实验室口径归并后的有效属名，暂定覆盖单列）；
 * 2) 采样管 × 鉴定对账明细（含待鉴定、鉴定失败、改判与对不上的管号）。
 */
export function exportCoverageCsv(payload: BackupPayload, lines: CoverageLine[]): {
  coverageFile: string
  tubeFile: string
} {
  const stamp = payload.exportedAt.slice(0, 19).replace(/[:T]/g, '')

  const coverageHeader = [
    '礁区',
    '站位',
    '样带',
    '朝向',
    '样带长度(m)',
    '调查日期',
    '调查人',
    '样本管数',
    '已鉴定管数',
    '暂定管数',
    '覆盖长度合计(cm)',
    '其中暂定覆盖(cm)',
    '覆盖率(%)',
    '白化指数',
    '总体等级',
    '白化占比(%)',
    '鱼类(尾)',
    '无脊椎动物(个)',
    '鱼类密度(尾/100m2)'
  ]
  const coverageRows = lines.map((line) =>
    [
      line.reefName,
      line.siteNo,
      line.beltNo,
      line.orientation,
      line.lengthM,
      line.surveyDate,
      line.observer,
      line.sampleCount,
      line.confirmedCount,
      line.provisionalCount,
      line.coverCmTotal,
      line.provisionalCoverCm,
      line.coveragePct,
      line.bleachIndex,
      line.grade,
      line.bleachedSharePct,
      line.fishTotal,
      line.invertebrateTotal,
      line.fishDensity
    ]
      .map(csvCell)
      .join(',')
  )
  const coverageFile = `${DB_NAME}-coverage-${stamp}.csv`
  downloadText(coverageFile, [coverageHeader.join(','), ...coverageRows].join('\n'))

  const beltById = new Map(payload.belts.map((belt) => [belt.id, belt]))
  const reconciliation = reconcileSamples(payload.samples, payload.identifications)
  const tubeHeader = [
    '管号',
    '样带',
    '外业暂定属名',
    '有效属名(归并口径)',
    '属名来源',
    '形态',
    '覆盖长度(cm)',
    '白化等级',
    '鉴定批次',
    '鉴定属名',
    '置信度(%)',
    '鉴定人',
    '鉴定日期',
    '鉴定次数',
    '是否改判',
    '备注'
  ]
  const tubeRows = reconciliation.resolved
    .slice()
    .sort((a, b) => a.tubeNo.localeCompare(b.tubeNo, 'zh-Hans-CN'))
    .map((item) =>
      [
        item.tubeNo,
        beltById.get(item.beltId)?.no ?? item.beltId,
        item.sample.provisionalGenus,
        item.effectiveGenus,
        item.genusSource,
        item.form,
        item.coverCm,
        item.bleachLevel,
        item.confirmed?.batchNo ?? (item.latest?.batchNo ?? ''),
        item.confirmed?.genus ?? '',
        item.confirmed?.confidence ?? '',
        item.confirmed?.identifier ?? (item.latest?.identifier ?? ''),
        item.confirmed?.identifiedAt ?? (item.latest?.identifiedAt ?? ''),
        item.attemptCount,
        item.genusChanged ? '是' : '否',
        item.sample.remark
      ]
        .map(csvCell)
        .join(',')
    )
  const orphanRows = reconciliation.orphanIdentifications.map((group) => {
    const latest = group.identifications[0]
    return [
      group.tubeNo,
      '外业无此管（待核对）',
      '',
      latest?.genus ?? '',
      '孤儿鉴定',
      '',
      '',
      '',
      latest?.batchNo ?? '',
      latest?.genus ?? '',
      latest?.confidence ?? '',
      latest?.identifier ?? '',
      latest?.identifiedAt ?? '',
      group.identifications.length,
      '否',
      latest?.note ?? ''
    ]
      .map(csvCell)
      .join(',')
  })
  const tubeFile = `${DB_NAME}-tube-reconciliation-${stamp}.csv`
  downloadText(tubeFile, [tubeHeader.join(','), ...tubeRows, ...orphanRows].join('\n'))

  return { coverageFile, tubeFile }
}

/** 鉴定记录表（导入导出类型占位引用，确保树摇保留类型） */
export type { Identification }
