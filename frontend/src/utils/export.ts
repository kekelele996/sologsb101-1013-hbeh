/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入；
 * 按礁区/样带汇总覆盖度结论，并按实验室鉴定属名（待鉴定按外业暂定属名）归并。
 * 汇总口径与页面一致，统一走 utils/reconcile.ts。
 * 兼容 v2 旧备份（corals 表）：导入时把旧珊瑚记录迁移成「待鉴定」样本管。
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
import type { CoralRecord } from '@/types/coralRecord'
import type { CoralSample } from '@/types/sample'
import {
  BLEACH_LEVELS,
  type BleachLevel
} from '@/types/coralRecord'
import type { ResolvedSample } from '@/utils/reconcile'
import { groupResolvedByGenus, reconcileSamples } from '@/utils/reconcile'
import { bleachGrade, bleachIndex, bleachedSharePct, coralCoveragePct, fishDensity, round } from '@/utils/bleach'

/** 备份集合键名（v3 七张逻辑表） */
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
 * 把 v2 旧备份里的珊瑚记录迁移成「待鉴定」样本管：按样带 + 暂定属名补管号。
 * 与 db.ts v3 升级迁移同一规则。
 */
export function legacyCoralsToSamples(corals: CoralRecord[]): CoralSample[] {
  const now = Date.now()
  return corals.map((coral, index) => {
    const genusSlug = (coral.genus || '未知属').replace(/[^0-9a-zA-Z一-龥]/g, '').slice(0, 6)
    return {
      id: createId('smp'),
      tubeNo: `LEGACY-${coral.beltId.slice(-6)}-${genusSlug}-${index + 1}`,
      beltId: coral.beltId,
      fieldGenus: coral.genus || '未知属',
      form: coral.form,
      coverCm: coral.coverCm,
      bleachLevel: coral.bleachLevel,
      collector: '',
      remark: `旧备份导入待鉴定管${coral.remark ? `（原备注：${coral.remark}）` : ''}`,
      createdAt: coral.createdAt ?? now,
      updatedAt: now
    }
  })
}

/** 校验外部 JSON 是否为本站可识别的备份文件（v2/v3 均可） */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload>
  if (obj.app !== undefined && obj.app !== 'gbcoralbelt') {
    errors.push('app 字段应为 gbcoralbelt，文件来源不明')
  }
  for (const key of ['reefs', 'sites', 'belts', 'fishes'] as const) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  // v3 备份应有 samples / identifications；v2 备份用 corals
  const isV3 = Array.isArray(obj.samples) || Array.isArray(obj.identifications)
  const isV2 = Array.isArray(obj.corals)
  if (!isV3 && !isV2) {
    errors.push('缺少 samples/identifications（v3）或 corals（v2）数据，无法识别备份版本')
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }

  const samples = Array.isArray(obj.samples)
    ? obj.samples
    : legacyCoralsToSamples((obj.corals as CoralRecord[] | undefined) ?? [])
  const payload: BackupPayload = {
    app: 'gbcoralbelt',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    reefs: obj.reefs ?? [],
    sites: obj.sites ?? [],
    belts: obj.belts ?? [],
    samples,
    identifications: Array.isArray(obj.identifications) ? obj.identifications : [],
    fishes: obj.fishes ?? []
  }
  return { ok: true, errors, payload }
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

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案；管号保留（对账主键） */
export function remapIds(payload: BackupPayload): BackupPayload {
  const reefMap = new Map<string, string>()
  const siteMap = new Map<string, string>()
  const beltMap = new Map<string, string>()

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
  const samples = payload.samples.map((sample) => ({
    ...sample,
    id: createId('smp'),
    beltId: beltMap.get(sample.beltId) ?? sample.beltId
    // tubeNo 故意保留：实验室鉴定按管号对账
  }))
  const identifications = payload.identifications.map((ident) => ({
    ...ident,
    id: createId('idn')
  }))
  const fishes = payload.fishes.map((fish) => ({
    ...fish,
    id: createId('fsh'),
    beltId: beltMap.get(fish.beltId) ?? fish.beltId
  }))
  return { ...payload, reefs, sites, belts, samples, identifications, fishes }
}

export type BleachDistribution = Record<BleachLevel, number>

/** 覆盖度结论行：按样带汇总，属名按有效口径归并 */
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
  provisionalCount: number
  coverCmTotal: number
  coveragePct: number
  bleachIndex: number
  grade: BleachLevel
  bleachedSharePct: number
  distribution: BleachDistribution
  fishTotal: number
  invertebrateTotal: number
  fishDensity: number
  conclusion: string
}

/** 在快照上做一次全量对账（导出 / 结论与页面同源） */
export function resolvePayloadSamples(payload: BackupPayload): ResolvedSample[] {
  return reconcileSamples(payload.samples, payload.identifications).resolved
}

/** 按样带生成覆盖度结论行 */
export function buildCoverageLines(payload: BackupPayload): CoverageLine[] {
  const reefById = new Map(payload.reefs.map((reef) => [reef.id, reef]))
  const siteById = new Map(payload.sites.map((site) => [site.id, site]))
  const resolved = resolvePayloadSamples(payload)
  const samplesByBelt = new Map<string, ResolvedSample[]>()
  resolved.forEach((sample) => {
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
      const samples = samplesByBelt.get(belt.id) ?? []
      const fishes = fishesByBelt.get(belt.id) ?? []
      const coverCmTotal = round(
        samples.reduce((sum, sample) => sum + sample.coverCm, 0),
        1
      )
      const index = bleachIndex(samples)
      const grade = bleachGrade(index)
      const distribution: BleachDistribution = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
      BLEACH_LEVELS.forEach((level) => {
        distribution[level] = round(
          samples.filter((sample) => sample.bleachLevel === level).reduce((sum, sample) => sum + sample.coverCm, 0),
          1
        )
      })
      const fishTotal = fishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
      const invertebrateTotal = fishes
        .filter((fish) => fish.category === '无脊椎动物')
        .reduce((sum, fish) => sum + fish.count, 0)
      const provisionalCount = samples.filter((sample) => sample.provisional).length
      const coveragePct = coralCoveragePct(coverCmTotal, belt.lengthM)
      const share = bleachedSharePct(samples)
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
        sampleCount: samples.length,
        provisionalCount,
        coverCmTotal,
        coveragePct,
        bleachIndex: index,
        grade,
        bleachedSharePct: share,
        distribution,
        fishTotal,
        invertebrateTotal,
        fishDensity: fishDensity(fishTotal, belt.lengthM),
        conclusion:
          samples.length === 0
            ? '该样带尚未采集样本管'
            : grade === '无'
              ? `珊瑚覆盖率 ${coveragePct}%，未见白化`
              : `珊瑚覆盖率 ${coveragePct}%，白化指数 ${index}（${grade}），白化占比 ${share}%`
      }
    })
    .sort((a, b) => b.bleachIndex - a.bleachIndex)
}

/** 按有效属名归并的导出行（待鉴定 / 失败按外业暂定属名计入并标暂定） */
export interface GenusSummaryLine {
  genus: string
  coverCm: number
  count: number
  provisionalCount: number
  provisionalCoverCm: number
  /** 占全部样本覆盖长度比例（%） */
  sharePct: number
}

/** 全库按有效属名归并（导出口径） */
export function buildGenusSummary(payload: BackupPayload): GenusSummaryLine[] {
  const resolved = resolvePayloadSamples(payload)
  const totalCover = resolved.reduce((sum, sample) => sum + sample.coverCm, 0)
  return groupResolvedByGenus(resolved).map((bucket) => ({
    ...bucket,
    sharePct: totalCover > 0 ? round((bucket.coverCm / totalCover) * 100, 1) : 0
  }))
}

/** 按礁区汇总：站位/样带数量、平均白化指数与总体等级 */
export interface ReefSummary {
  reefId: string
  reefName: string
  protectStatus: string
  siteCount: number
  beltCount: number
  sampleCount: number
  provisionalCount: number
  coverCmTotal: number
  avgBleachIndex: number
  grade: BleachLevel
  fishTotal: number
}

export function buildReefSummaries(payload: BackupPayload, lines: CoverageLine[]): ReefSummary[] {
  const resolved = resolvePayloadSamples(payload)
  return payload.reefs.map((reef) => {
    const siteIds = new Set(payload.sites.filter((site) => site.reefId === reef.id).map((site) => site.id))
    const beltIds = new Set(payload.belts.filter((belt) => siteIds.has(belt.siteId)).map((belt) => belt.id))
    const samples = resolved.filter((sample) => beltIds.has(sample.beltId))
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
      sampleCount: samples.length,
      provisionalCount: samples.filter((sample) => sample.provisional).length,
      coverCmTotal: round(
        samples.reduce((sum, sample) => sum + sample.coverCm, 0),
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
