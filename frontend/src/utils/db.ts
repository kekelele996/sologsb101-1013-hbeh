/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbcoralbelt，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（礁区 → 站位 → 样带 → 采样管 / 鉴定 / 鱼类计数）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import type { CoralSample } from '@/types/sample'
import type { Identification } from '@/types/identification'
import type { FishCount } from '@/types/fishCount'
import { migrateLegacyCoralsToSamples } from '@/utils/migration'

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbcoralbelt'

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbcoralbelt:db-version',
  lastBackupAt: 'gbcoralbelt:last-backup-at',
  lastReefId: 'gbcoralbelt:last-reef-id'
} as const

/** 备份文件结构，供 utils/export.ts 与覆盖度汇总页使用 */
export interface BackupPayload {
  app: 'gbcoralbelt'
  dbVersion: number
  exportedAt: string
  reefs: Reef[]
  sites: Site[]
  belts: Belt[]
  samples: CoralSample[]
  identifications: Identification[]
  fishes: FishCount[]
}

export class CoralBeltDatabase extends Dexie {
  reefs!: Table<Reef, string>
  sites!: Table<Site, string>
  belts!: Table<Belt, string>
  samples!: Table<CoralSample, string>
  identifications!: Table<Identification, string>
  fishes!: Table<FishCount, string>

  constructor() {
    super(DB_NAME)

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      reefs: 'id, name, protectStatus',
      sites: 'id, reefId, no',
      belts: 'id, siteId, no, surveyDate',
      corals: 'id, beltId, genus, form',
      fishes: 'id, beltId, family, sizeClass'
    })

    // v2：补齐筛选与统计需要的索引（位置/面积、经纬度/水深、样带长度与朝向、白化等级、类别）
    this.version(2).stores({
      reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
      sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
      belts: 'id, siteId, no, lengthM, orientation, surveyDate, observer, updatedAt',
      corals: 'id, beltId, genus, form, coverCm, bleachLevel, updatedAt',
      fishes: 'id, beltId, family, count, sizeClass, category, updatedAt'
    })

    // v3：建立样本层 —— 外业采样管 samples + 实验室鉴定 identifications（按管号对账）；
    // 旧 corals 表在升级时按样带与属名补成「待鉴定」采样管后删除。
    this.version(DB_VERSION)
      .stores({
        reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
        sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
        belts: 'id, siteId, no, lengthM, orientation, surveyDate, observer, updatedAt',
        samples: 'id, tubeNo, beltId, provisionalGenus, form, coverCm, bleachLevel, updatedAt',
        identifications: 'id, tubeNo, batchNo, status, genus, identifier, identifiedAt, updatedAt',
        fishes: 'id, beltId, family, count, sizeClass, category, updatedAt'
      })
      .upgrade(async (tx) => {
        // v2 迁移兜底：历史数据补齐时间戳与必填字段
        const defaults: Array<[string, () => Record<string, unknown>]> = [
          ['reefs', () => ({ manager: '', areaKm2: 0 })],
          ['sites', () => ({ lat: 0, lng: 0, depthM: 5, substrate: '珊瑚礁石' })],
          ['belts', () => ({ lengthM: 50, orientation: '北', observer: '' })],
          ['fishes', () => ({ count: 0, sizeClass: '11-20cm', category: '鱼类' })]
        ]
        for (const [tableName, factory] of defaults) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const now = Date.now()
              if (typeof row.createdAt !== 'number') row.createdAt = now
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
              Object.assign(row, factory())
            })
        }

        // 旧珊瑚记录没有管号：corals 表在 v3 被删除，迁移工具经底层原生
        // IDBTransaction 读旧表，按样带与属名补出待鉴定采样管，随后由 Dexie 删除对象库
        await migrateLegacyCoralsToSamples(tx)
      })
  }
}

export const db = new CoralBeltDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 订阅单表变化（liveQuery），返回取消订阅函数 */
export function watchTable<T>(table: () => Table<T, string>): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray())
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([])
      })
      return () => subscription.unsubscribe()
    }
  }
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedSample {
  id: string
  tubeNo: string
  beltId: string
  provisionalGenus: string
  form: CoralSample['form']
  coverCm: number
  bleachLevel: CoralSample['bleachLevel']
  remark: string
}

interface SeedIdentification {
  id: string
  tubeNo: string
  batchNo: string
  status: Identification['status']
  genus: string
  confidence: number
  identifier: string
  note: string
  identifiedAt: string
}

interface SeedFish {
  id: string
  beltId: string
  family: string
  count: number
  sizeClass: FishCount['sizeClass']
  category: FishCount['category']
}

interface SeedBelt {
  id: string
  siteId: string
  no: string
  lengthM: number
  orientation: Belt['orientation']
  surveyDate: string
  observer: string
  samples: SeedSample[]
  fishes: SeedFish[]
}

const SEQ_B1 = 'SEQ-2026-09'
const SEQ_B2 = 'SEQ-2026-10'
const ID_DATE_1 = '2026-09-28'
const ID_DATE_2 = '2026-10-05'

/**
 * 播种演示数据：3 个礁区 → 4 个站位 → 5 条样带 → 14 根采样管 + 12 条鉴定（含失败重试、
 * 属名改判、待鉴定与对不上管号）+ 12 条鱼类计数，覆盖无 / 轻 / 中 / 重 / 死亡全部白化等级。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const today = new Date(now).toISOString().slice(0, 10)

  const reefs: Array<Omit<Reef, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'reef_ql01',
      name: '清澜湾珊瑚礁区',
      location: '海南文昌清澜湾东侧 3.5 km 海域',
      areaKm2: 18.6,
      protectStatus: '核心区',
      manager: '清澜湾海洋保护站'
    },
    {
      id: 'reef_yr02',
      name: '永兴岛西侧礁盘',
      location: '西沙永兴岛西侧礁盘外缘',
      areaKm2: 42.3,
      protectStatus: '缓冲区',
      manager: '西沙海洋环境监测中心'
    },
    {
      id: 'reef_dz03',
      name: '大洲岛南岸礁区',
      location: '万宁大洲岛南岸潮下带',
      areaKm2: 6.4,
      protectStatus: '实验区',
      manager: '大洲岛国家级自然保护区管理处'
    }
  ]

  const sites: Array<Omit<Site, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'site_ql_01',
      reefId: 'reef_ql01',
      no: 'S-01',
      lat: 19.5621,
      lng: 110.7924,
      depthM: 4.2,
      substrate: '珊瑚礁石'
    },
    {
      id: 'site_ql_02',
      reefId: 'reef_ql01',
      no: 'S-02',
      lat: 19.5487,
      lng: 110.8103,
      depthM: 8.6,
      substrate: '礁砂'
    },
    {
      id: 'site_yr_01',
      reefId: 'reef_yr02',
      no: 'S-01',
      lat: 16.8342,
      lng: 112.3286,
      depthM: 12.4,
      substrate: '砾石'
    },
    {
      id: 'site_dz_01',
      reefId: 'reef_dz03',
      no: 'S-01',
      lat: 18.6712,
      lng: 110.4913,
      depthM: 6.8,
      substrate: '岩礁'
    }
  ]

  const belts: SeedBelt[] = [
    {
      id: 'belt_ql01_a',
      siteId: 'site_ql_01',
      no: 'T-01',
      lengthM: 50,
      orientation: '北',
      surveyDate: today,
      observer: '林之遥',
      samples: [
        { id: 'smp_ql01a_1', tubeNo: 'QL01A-01', beltId: 'belt_ql01_a', provisionalGenus: '鹿角珊瑚属', form: '枝状', coverCm: 860, bleachLevel: '无', remark: '长势良好' },
        { id: 'smp_ql01a_2', tubeNo: 'QL01A-02', beltId: 'belt_ql01_a', provisionalGenus: '杯形珊瑚属', form: '枝状', coverCm: 540, bleachLevel: '轻', remark: '局部褪色，实验室改判' },
        { id: 'smp_ql01a_3', tubeNo: 'QL01A-03', beltId: 'belt_ql01_a', provisionalGenus: '滨珊瑚属', form: '块状', coverCm: 1120, bleachLevel: '无', remark: '首次扩增失败，重试成功' },
        { id: 'smp_ql01a_4', tubeNo: 'QL01A-04', beltId: 'belt_ql01_a', provisionalGenus: '软珊瑚属', form: '软珊瑚', coverCm: 380, bleachLevel: '轻', remark: '尚未送鉴定批次' }
      ],
      fishes: [
        { id: 'fsh_ql01a_1', beltId: 'belt_ql01_a', family: '雀鲷科', count: 46, sizeClass: '0-10cm', category: '鱼类' },
        { id: 'fsh_ql01a_2', beltId: 'belt_ql01_a', family: '蝴蝶鱼科', count: 18, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_ql01a_3', beltId: 'belt_ql01_a', family: '鹦嘴鱼科', count: 7, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_ql01a_4', beltId: 'belt_ql01_a', family: '海胆科', count: 12, sizeClass: '0-10cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_ql01_b',
      siteId: 'site_ql_01',
      no: 'T-02',
      lengthM: 50,
      orientation: '东',
      surveyDate: today,
      observer: '林之遥',
      samples: [
        { id: 'smp_ql01b_1', tubeNo: 'QL01B-01', beltId: 'belt_ql01_b', provisionalGenus: '蔷薇珊瑚属', form: '叶状', coverCm: 720, bleachLevel: '中', remark: '边缘白化明显' },
        { id: 'smp_ql01b_2', tubeNo: 'QL01B-02', beltId: 'belt_ql01_b', provisionalGenus: '蜂巢珊瑚属', form: '块状', coverCm: 980, bleachLevel: '轻', remark: '未出鉴定' },
        { id: 'smp_ql01b_3', tubeNo: 'QL01B-03', beltId: 'belt_ql01_b', provisionalGenus: '鹿角珊瑚属', form: '枝状', coverCm: 430, bleachLevel: '重', remark: '大面积白化，鉴定失败待重试' }
      ],
      fishes: [
        { id: 'fsh_ql01b_1', beltId: 'belt_ql01_b', family: '隆头鱼科', count: 22, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_ql01b_2', beltId: 'belt_ql01_b', family: '刺尾鱼科', count: 15, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_ql01b_3', beltId: 'belt_ql01_b', family: '砗磲科', count: 3, sizeClass: '>30cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_ql02_a',
      siteId: 'site_ql_02',
      no: 'T-01',
      lengthM: 30,
      orientation: '南',
      surveyDate: today,
      observer: '周渝',
      samples: [
        { id: 'smp_ql02a_1', tubeNo: 'QL02A-01', beltId: 'belt_ql02_a', provisionalGenus: '滨珊瑚属', form: '块状', coverCm: 1240, bleachLevel: '无', remark: '' },
        { id: 'smp_ql02a_2', tubeNo: 'QL02A-02', beltId: 'belt_ql02_a', provisionalGenus: '陀螺珊瑚属', form: '块状', coverCm: 260, bleachLevel: '死亡', remark: '仅存骨骼；实验室改判石芝珊瑚属' }
      ],
      fishes: [
        { id: 'fsh_ql02a_1', beltId: 'belt_ql02_a', family: '石斑鱼科', count: 4, sizeClass: '>30cm', category: '鱼类' },
        { id: 'fsh_ql02a_2', beltId: 'belt_ql02_a', family: '海参科', count: 6, sizeClass: '21-30cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_yr01_a',
      siteId: 'site_yr_01',
      no: 'T-01',
      lengthM: 100,
      orientation: '西',
      surveyDate: today,
      observer: '陈立群',
      samples: [
        { id: 'smp_yr01a_1', tubeNo: 'YR01A-01', beltId: 'belt_yr01_a', provisionalGenus: '星珊瑚属', form: '块状', coverCm: 1580, bleachLevel: '轻', remark: '' },
        { id: 'smp_yr01a_2', tubeNo: 'YR01A-02', beltId: 'belt_yr01_a', provisionalGenus: '柳珊瑚属', form: '软珊瑚', coverCm: 640, bleachLevel: '中', remark: '水流较强区域，未出鉴定' },
        { id: 'smp_yr01a_3', tubeNo: 'YR01A-03', beltId: 'belt_yr01_a', provisionalGenus: '石芝珊瑚属', form: '叶状', coverCm: 480, bleachLevel: '无', remark: '' }
      ],
      fishes: [
        { id: 'fsh_yr01a_1', beltId: 'belt_yr01_a', family: '笛鲷科', count: 28, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_yr01a_2', beltId: 'belt_yr01_a', family: '篮子鱼科', count: 11, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_yr01a_3', beltId: 'belt_yr01_a', family: '法螺科', count: 2, sizeClass: '>30cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_dz01_a',
      siteId: 'site_dz_01',
      no: 'T-01',
      lengthM: 25,
      orientation: '东',
      surveyDate: today,
      observer: '陈立群',
      samples: [
        { id: 'smp_dz01a_1', tubeNo: 'DZ01A-01', beltId: 'belt_dz01_a', provisionalGenus: '杯形珊瑚属', form: '枝状', coverCm: 520, bleachLevel: '重', remark: '受台风扰动后白化' },
        { id: 'smp_dz01a_2', tubeNo: 'DZ01A-02', beltId: 'belt_dz01_a', provisionalGenus: '蜂巢珊瑚属', form: '块状', coverCm: 310, bleachLevel: '中', remark: '未出鉴定' }
      ],
      fishes: [
        { id: 'fsh_dz01a_1', beltId: 'belt_dz01_a', family: '雀鲷科', count: 34, sizeClass: '0-10cm', category: '鱼类' },
        { id: 'fsh_dz01a_2', beltId: 'belt_dz01_a', family: '海星科', count: 5, sizeClass: '11-20cm', category: '无脊椎动物' }
      ]
    }
  ]

  /** 实验室鉴定：含同管失败后重试成功、属名改判、仅失败、未鉴定、以及外业对不上的孤儿管号 */
  const identifications: SeedIdentification[] = [
    { id: 'idn_ql01a_1', tubeNo: 'QL01A-01', batchNo: SEQ_B1, status: '成功', genus: '鹿角珊瑚属', confidence: 98.2, identifier: '苏岩', note: '', identifiedAt: ID_DATE_1 },
    { id: 'idn_ql01a_2', tubeNo: 'QL01A-02', batchNo: SEQ_B1, status: '成功', genus: '鹿角珊瑚属', confidence: 96.5, identifier: '苏岩', note: '外业暂定杯形珊瑚属，分子结果改判', identifiedAt: ID_DATE_1 },
    { id: 'idn_ql01a_3f', tubeNo: 'QL01A-03', batchNo: SEQ_B1, status: '失败', genus: '', confidence: 0, identifier: '苏岩', note: 'COI 扩增失败', identifiedAt: ID_DATE_1 },
    { id: 'idn_ql01a_3', tubeNo: 'QL01A-03', batchNo: SEQ_B2, status: '成功', genus: '滨珊瑚属', confidence: 97.1, identifier: '何鉴', note: '换引物重试成功', identifiedAt: ID_DATE_2 },
    { id: 'idn_ql01b_1', tubeNo: 'QL01B-01', batchNo: SEQ_B1, status: '成功', genus: '蔷薇珊瑚属', confidence: 95.4, identifier: '何鉴', note: '', identifiedAt: ID_DATE_1 },
    { id: 'idn_ql01b_3', tubeNo: 'QL01B-03', batchNo: SEQ_B2, status: '失败', genus: '', confidence: 0, identifier: '何鉴', note: '序列污染，需重新送样', identifiedAt: ID_DATE_2 },
    { id: 'idn_ql02a_1', tubeNo: 'QL02A-01', batchNo: SEQ_B1, status: '成功', genus: '滨珊瑚属', confidence: 99.0, identifier: '苏岩', note: '', identifiedAt: ID_DATE_1 },
    { id: 'idn_ql02a_2', tubeNo: 'QL02A-02', batchNo: SEQ_B1, status: '成功', genus: '石芝珊瑚属', confidence: 91.8, identifier: '何鉴', note: '外业暂定陀螺珊瑚属，改判', identifiedAt: ID_DATE_1 },
    { id: 'idn_yr01a_1', tubeNo: 'YR01A-01', batchNo: SEQ_B2, status: '成功', genus: '星珊瑚属', confidence: 97.7, identifier: '何鉴', note: '', identifiedAt: ID_DATE_2 },
    { id: 'idn_yr01a_3', tubeNo: 'YR01A-03', batchNo: SEQ_B2, status: '成功', genus: '石芝珊瑚属', confidence: 96.1, identifier: '何鉴', note: '', identifiedAt: ID_DATE_2 },
    { id: 'idn_dz01a_1', tubeNo: 'DZ01A-01', batchNo: SEQ_B2, status: '成功', genus: '杯形珊瑚属', confidence: 94.6, identifier: '苏岩', note: '', identifiedAt: ID_DATE_2 },
    { id: 'idn_orphan_1', tubeNo: 'LAB-9527', batchNo: SEQ_B2, status: '成功', genus: '鹿角珊瑚属', confidence: 88.2, identifier: '何鉴', note: '管号在送检清单中，外业采样记录缺失，待核对', identifiedAt: ID_DATE_2 }
  ]

  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.belts, db.samples, db.identifications, db.fishes],
    async () => {
      const stamp = (offset: number): { createdAt: number; updatedAt: number } => ({
        createdAt: now + offset,
        updatedAt: now + offset
      })

      await db.reefs.bulkPut(reefs.map((reef, index) => ({ ...reef, ...stamp(index) })))
      await db.sites.bulkPut(sites.map((site, index) => ({ ...site, ...stamp(100 + index) })))
      await db.belts.bulkPut(
        belts.map((belt, index) => {
          const { samples, fishes, ...rest } = belt
          void samples
          void fishes
          return { ...rest, ...stamp(200 + index) }
        })
      )
      await db.samples.bulkPut(
        belts.flatMap((belt, beltIndex) =>
          belt.samples.map((sample, sampleIndex) => ({
            ...sample,
            ...stamp(300 + beltIndex * 100 + sampleIndex)
          }))
        )
      )
      await db.identifications.bulkPut(
        identifications.map((identification, index) => ({ ...identification, ...stamp(500 + index) }))
      )
      await db.fishes.bulkPut(
        belts.flatMap((belt, beltIndex) =>
          belt.fishes.map((fish, fishIndex) => ({ ...fish, ...stamp(400 + beltIndex * 100 + fishIndex) }))
        )
      )
    }
  )
}

/** 打开数据库并幂等播种：仅当礁区表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  const count = await db.reefs.count()
  if (count === 0) {
    await seedDemoData()
  }
  stampDbVersion()
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.belts, db.samples, db.identifications, db.fishes],
    async () => {
      await Promise.all([
        db.reefs.clear(),
        db.sites.clear(),
        db.belts.clear(),
        db.samples.clear(),
        db.identifications.clear(),
        db.fishes.clear()
      ])
    }
  )
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDemoData()
}

/** 统计各表行数，供页脚概览与覆盖度页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [reefs, sites, belts, samples, identifications, fishes] = await Promise.all([
    db.reefs.count(),
    db.sites.count(),
    db.belts.count(),
    db.samples.count(),
    db.identifications.count(),
    db.fishes.count()
  ])
  return { reefs, sites, belts, samples, identifications, fishes }
}

/** 写入结构版本号到 localStorage，便于覆盖度页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion)
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
  } catch {
    return DB_VERSION
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso)
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function readLastReefId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastReefId)
  } catch {
    return null
  }
}

export function writeLastReefId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastReefId)
    else localStorage.setItem(LS_KEYS.lastReefId, id)
  } catch {
    // 忽略
  }
}
