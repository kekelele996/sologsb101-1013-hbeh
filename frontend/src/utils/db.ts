/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbcoralbelt，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（礁区 → 站位 → 样带 → 样本管/鉴定/鱼类计数）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import type { CoralRecord } from '@/types/coralRecord'
import type { CoralSample } from '@/types/sample'
import type { CoralIdentification } from '@/types/identification'
import type { FishCount } from '@/types/fishCount'

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
  /** v3 起为样本管（外业采集） */
  samples: CoralSample[]
  /** v3 起为实验室鉴定 */
  identifications: CoralIdentification[]
  fishes: FishCount[]
  /** v2 旧备份里的珊瑚记录（导入时迁移成样本管，正常导出恒为空数组） */
  corals?: CoralRecord[]
}

export class CoralBeltDatabase extends Dexie {
  reefs!: Table<Reef, string>
  sites!: Table<Site, string>
  belts!: Table<Belt, string>
  /** @deprecated v3 起由 samples 取代，保留声明仅为跨版本升级 */
  corals!: Table<CoralRecord, string>
  samples!: Table<CoralSample, string>
  identifications!: Table<CoralIdentification, string>
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

    // v3：样本层上线 —— 外业样本管（samples）与实验室鉴定（identifications）按管号对账。
    // 旧珊瑚记录（无管号）在升级时按样带 + 暂定属名补出「待鉴定」样本管。
    this.version(DB_VERSION)
      .stores({
        reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
        sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
        belts: 'id, siteId, no, lengthM, orientation, surveyDate, observer, updatedAt',
        samples: 'id, tubeNo, beltId, fieldGenus, form, coverCm, bleachLevel, updatedAt',
        identifications: 'id, tubeNo, batchNo, status, genus, identifier, updatedAt',
        fishes: 'id, beltId, family, count, sizeClass, category, updatedAt',
        corals: null
      })
      .upgrade(async (tx) => {
        // v1/v2 历史数据补齐必填字段（沿用 v2 的回填规则，覆盖更早版本）
        const legacyDefaults: Array<[string, () => Record<string, unknown>]> = [
          ['reefs', () => ({ manager: '', areaKm2: 0 })],
          ['sites', () => ({ lat: 0, lng: 0, depthM: 5, substrate: '珊瑚礁石' })],
          ['belts', () => ({ lengthM: 50, orientation: '北', observer: '' })]
        ]
        for (const [tableName, factory] of legacyDefaults) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now()
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
              Object.assign(row, factory())
            })
        }

        // 旧珊瑚记录 → 待鉴定样本管：按样带 + 暂定属名补管号
        const legacyCorals = (await tx.table<CoralRecord, string>('corals').toArray()) as CoralRecord[]
        if (legacyCorals.length > 0) {
          const now = Date.now()
          const samples: CoralSample[] = legacyCorals.map((coral, index) => {
            const genusSlug = (coral.genus || '未知属').replace(/[^0-9a-zA-Z一-龥]/g, '').slice(0, 6)
            return {
              id: `smp_legacy_${coral.id}`.slice(0, 60),
              tubeNo: `LEGACY-${coral.beltId.slice(-6)}-${genusSlug}-${index + 1}`,
              beltId: coral.beltId,
              fieldGenus: coral.genus || '未知属',
              form: coral.form,
              coverCm: coral.coverCm,
              bleachLevel: coral.bleachLevel,
              collector: '',
              remark: `旧数据迁移待鉴定管${coral.remark ? `（原备注：${coral.remark}）` : ''}`,
              createdAt: coral.createdAt ?? now,
              updatedAt: now
            }
          })
          await tx.table<CoralSample, string>('samples').bulkAdd(samples)
        }
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
  fieldGenus: string
  form: CoralSample['form']
  coverCm: number
  bleachLevel: CoralSample['bleachLevel']
  collector: string
  remark: string
}

interface SeedIdentification {
  id: string
  tubeNo: string
  batchNo: string
  status: CoralIdentification['status']
  genus: string
  confidence: number
  identifier: string
  attempt: number
  identifiedAt: string
  note: string
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
  identifications: SeedIdentification[]
  fishes: SeedFish[]
}

/**
 * 播种演示数据：3 个礁区 → 4 个站位 → 5 条样带 → 样本管 + 实验室鉴定 + 12 条鱼类计数，
 * 覆盖 已鉴定（含属名被实验室更正）/ 待鉴定 / 鉴定失败重试 / 孤立鉴定 全部对账状态，
 * 以及 无 / 轻 / 中 / 重 / 死亡 全部白化等级。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const today = new Date(now).toISOString().slice(0, 10)
  const labDate = new Date(now - 3 * 86400000).toISOString().slice(0, 10)

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
    { id: 'site_ql_01', reefId: 'reef_ql01', no: 'S-01', lat: 19.5621, lng: 110.7924, depthM: 4.2, substrate: '珊瑚礁石' },
    { id: 'site_ql_02', reefId: 'reef_ql01', no: 'S-02', lat: 19.5487, lng: 110.8103, depthM: 8.6, substrate: '礁砂' },
    { id: 'site_yr_01', reefId: 'reef_yr02', no: 'S-01', lat: 16.8342, lng: 112.3286, depthM: 12.4, substrate: '砾石' },
    { id: 'site_dz_01', reefId: 'reef_dz03', no: 'S-01', lat: 18.6712, lng: 110.4913, depthM: 6.8, substrate: '岩礁' }
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
        { id: 'smp_ql01a_1', tubeNo: 'QL01-A01', beltId: 'belt_ql01_a', fieldGenus: '鹿角珊瑚属', form: '枝状', coverCm: 860, bleachLevel: '无', collector: '林之遥', remark: '长势良好' },
        { id: 'smp_ql01a_2', tubeNo: 'QL01-A02', beltId: 'belt_ql01_a', fieldGenus: '杯形珊瑚属', form: '枝状', coverCm: 540, bleachLevel: '轻', collector: '林之遥', remark: '局部褪色' },
        { id: 'smp_ql01a_3', tubeNo: 'QL01-A03', beltId: 'belt_ql01_a', fieldGenus: '滨珊瑚属', form: '块状', coverCm: 1120, bleachLevel: '无', collector: '林之遥', remark: '' },
        { id: 'smp_ql01a_4', tubeNo: 'QL01-A04', beltId: 'belt_ql01_a', fieldGenus: '软珊瑚属', form: '软珊瑚', coverCm: 380, bleachLevel: '轻', collector: '林之遥', remark: '' }
      ],
      identifications: [
        // 外业暂定「杯形珊瑚属」，实验室更正为「鹿角珊瑚属」（属名被更正的典型）
        { id: 'idn_ql01a_1', tubeNo: 'QL01-A01', batchNo: 'B2026-09A', status: '成功', genus: '鹿角珊瑚属', confidence: 0.98, identifier: '沈知微', attempt: 1, identifiedAt: labDate, note: '' },
        { id: 'idn_ql01a_2', tubeNo: 'QL01-A02', batchNo: 'B2026-09A', status: '成功', genus: '鹿角珊瑚属', confidence: 0.91, identifier: '沈知微', attempt: 1, identifiedAt: labDate, note: '外业误定为杯形珊瑚属' },
        { id: 'idn_ql01a_3', tubeNo: 'QL01-A03', batchNo: 'B2026-09A', status: '成功', genus: '滨珊瑚属', confidence: 0.99, identifier: '沈知微', attempt: 1, identifiedAt: labDate, note: '' }
        // QL01-A04 尚未出鉴定 → 待鉴定，按外业暂定「软珊瑚属」计入并标暂定
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
        { id: 'smp_ql01b_1', tubeNo: 'QL01-B01', beltId: 'belt_ql01_b', fieldGenus: '蔷薇珊瑚属', form: '叶状', coverCm: 720, bleachLevel: '中', collector: '林之遥', remark: '边缘白化明显' },
        { id: 'smp_ql01b_2', tubeNo: 'QL01-B02', beltId: 'belt_ql01_b', fieldGenus: '蜂巢珊瑚属', form: '块状', coverCm: 980, bleachLevel: '轻', collector: '林之遥', remark: '' },
        { id: 'smp_ql01b_3', tubeNo: 'QL01-B03', beltId: 'belt_ql01_b', fieldGenus: '鹿角珊瑚属', form: '枝状', coverCm: 430, bleachLevel: '重', collector: '林之遥', remark: '大面积白化，部分死亡' }
      ],
      identifications: [
        { id: 'idn_ql01b_1', tubeNo: 'QL01-B01', batchNo: 'B2026-09A', status: '成功', genus: '蔷薇珊瑚属', confidence: 0.96, identifier: '沈知微', attempt: 1, identifiedAt: labDate, note: '' },
        { id: 'idn_ql01b_2', tubeNo: 'QL01-B02', batchNo: 'B2026-09A', status: '成功', genus: '蜂巢珊瑚属', confidence: 0.93, identifier: '沈知微', attempt: 1, identifiedAt: labDate, note: '' },
        // B03 首检失败、重试成功（实验室只重试本侧，外业不动）
        { id: 'idn_ql01b_3f', tubeNo: 'QL01-B03', batchNo: 'B2026-09A', status: '失败', genus: '', confidence: 0, identifier: '沈知微', attempt: 1, identifiedAt: labDate, note: 'DNA 降解，扩增失败' },
        { id: 'idn_ql01b_3', tubeNo: 'QL01-B03', batchNo: 'B2026-10B', status: '成功', genus: '鹿角珊瑚属', confidence: 0.88, identifier: '何其芳', attempt: 2, identifiedAt: today, note: '复测成功' }
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
        { id: 'smp_ql02a_1', tubeNo: 'QL02-A01', beltId: 'belt_ql02_a', fieldGenus: '滨珊瑚属', form: '块状', coverCm: 1240, bleachLevel: '无', collector: '周渝', remark: '' },
        { id: 'smp_ql02a_2', tubeNo: 'QL02-A02', beltId: 'belt_ql02_a', fieldGenus: '陀螺珊瑚属', form: '块状', coverCm: 260, bleachLevel: '死亡', collector: '周渝', remark: '仅存骨骼，附着藻类' }
      ],
      identifications: [
        { id: 'idn_ql02a_1', tubeNo: 'QL02-A01', batchNo: 'B2026-09A', status: '成功', genus: '滨珊瑚属', confidence: 0.97, identifier: '沈知微', attempt: 1, identifiedAt: labDate, note: '' },
        // A02 鉴定失败，尚未重试 → 按外业暂定「陀螺珊瑚属」计入并标失败
        { id: 'idn_ql02a_2f', tubeNo: 'QL02-A02', batchNo: 'B2026-10B', status: '失败', genus: '', confidence: 0, identifier: '何其芳', attempt: 1, identifiedAt: today, note: '样本污染，需重测' }
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
        { id: 'smp_yr01a_1', tubeNo: 'YR01-A01', beltId: 'belt_yr01_a', fieldGenus: '星珊瑚属', form: '块状', coverCm: 1580, bleachLevel: '轻', collector: '陈立群', remark: '' },
        { id: 'smp_yr01a_2', tubeNo: 'YR01-A02', beltId: 'belt_yr01_a', fieldGenus: '柳珊瑚属', form: '软珊瑚', coverCm: 640, bleachLevel: '中', collector: '陈立群', remark: '水流较强区域' },
        { id: 'smp_yr01a_3', tubeNo: 'YR01-A03', beltId: 'belt_yr01_a', fieldGenus: '石芝珊瑚属', form: '叶状', coverCm: 480, bleachLevel: '无', collector: '陈立群', remark: '' }
      ],
      identifications: [
        { id: 'idn_yr01a_1', tubeNo: 'YR01-A01', batchNo: 'B2026-08X', status: '成功', genus: '星珊瑚属', confidence: 0.95, identifier: '何其芳', attempt: 1, identifiedAt: labDate, note: '' },
        { id: 'idn_yr01a_2', tubeNo: 'YR01-A02', batchNo: 'B2026-08X', status: '成功', genus: '柳珊瑚属', confidence: 0.9, identifier: '何其芳', attempt: 1, identifiedAt: labDate, note: '' }
        // YR01-A03 尚未出鉴定 → 待鉴定
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
        { id: 'smp_dz01a_1', tubeNo: 'DZ01-A01', beltId: 'belt_dz01_a', fieldGenus: '杯形珊瑚属', form: '枝状', coverCm: 520, bleachLevel: '重', collector: '陈立群', remark: '受台风扰动后白化' },
        { id: 'smp_dz01a_2', tubeNo: 'DZ01-A02', beltId: 'belt_dz01_a', fieldGenus: '蜂巢珊瑚属', form: '块状', coverCm: 310, bleachLevel: '中', collector: '陈立群', remark: '' }
      ],
      identifications: [
        { id: 'idn_dz01a_1', tubeNo: 'DZ01-A01', batchNo: 'B2026-08X', status: '成功', genus: '杯形珊瑚属', confidence: 0.92, identifier: '何其芳', attempt: 1, identifiedAt: labDate, note: '' }
        // DZ01-A02 尚未出鉴定 → 待鉴定
      ],
      fishes: [
        { id: 'fsh_dz01a_1', beltId: 'belt_dz01_a', family: '雀鲷科', count: 34, sizeClass: '0-10cm', category: '鱼类' },
        { id: 'fsh_dz01a_2', beltId: 'belt_dz01_a', family: '海星科', count: 5, sizeClass: '11-20cm', category: '无脊椎动物' }
      ]
    }
  ]

  // 孤立鉴定：实验室录了外业没有的管号（管号誊抄错误），对账时列出等实验室补
  const orphanIdentifications: SeedIdentification[] = [
    { id: 'idn_orphan_1', tubeNo: 'QL01-A99', batchNo: 'B2026-10B', status: '成功', genus: '鹿角珊瑚属', confidence: 0.86, identifier: '何其芳', attempt: 1, identifiedAt: today, note: '管号待与外业核对' }
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
          const { samples, identifications, fishes, ...rest } = belt
          void samples
          void identifications
          void fishes
          return { ...rest, ...stamp(200 + index) }
        })
      )
      await db.samples.bulkPut(
        belts.flatMap((belt, beltIndex) =>
          belt.samples.map((sample, sampleIndex) => ({ ...sample, ...stamp(300 + beltIndex * 100 + sampleIndex) }))
        )
      )
      await db.identifications.bulkPut(
        belts.flatMap((belt, beltIndex) =>
          belt.identifications.map((ident, identIndex) => ({
            ...ident,
            ...stamp(350 + beltIndex * 100 + identIndex)
          }))
        ).concat(orphanIdentifications.map((ident, index) => ({ ...ident, ...stamp(390 + index) })))
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
