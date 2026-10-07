/**
 * v2 → v3 迁移：旧珊瑚记录没有管号，升级时按样带与属名补出「待鉴定」采样管。
 * 每条旧记录补一根管（管号 LEGACY-<6 位序号>，全局唯一），暂定属名取旧属名，
 * 形态 / 覆盖长度 / 白化等级原样继承，备注写迁移来源；实验室鉴定回来后按管号对账改判。
 * 同时兼容旧版备份文件导入（payload 中的 corals 数组同样走这条补管逻辑）。
 *
 * 注意：corals 表在 v3 schema 中被删除，Dexie 的 Transaction.table() 在升级事务里
 * 无法拿到「被删除」的表（会在事务装配阶段抛错），必须用底层原生 IDBTransaction
 * （tx.idbtrans）的 objectStore('corals') 读取旧数据。
 */
import type { CoralSample } from '@/types/sample'
import type { BleachLevel, CoralForm } from '@/types/coralRecord'

/** 旧版珊瑚记录（v1 / v2） */
export interface LegacyCoralRecord {
  id?: string
  beltId: string
  genus: string
  form?: CoralForm
  coverCm?: number
  bleachLevel?: BleachLevel
  remark?: string
  createdAt?: number
  updatedAt?: number
}

/** 旧记录 → 待鉴定采样管（确定性管号，重复升级结果一致） */
export function legacyCoralsToSamples(
  corals: LegacyCoralRecord[],
  existingSamples: CoralSample[] = []
): CoralSample[] {
  const now = Date.now()
  const usedTubes = new Set(existingSamples.map((sample) => sample.tubeNo))
  let seq = existingSamples.length
  return corals.map((coral, index) => {
    let tubeNo = ''
    do {
      seq += 1
      tubeNo = `LEGACY-${String(seq).padStart(6, '0')}`
    } while (usedTubes.has(tubeNo))
    usedTubes.add(tubeNo)
    const createdAt = typeof coral.createdAt === 'number' ? coral.createdAt : now + index
    return {
      id: `smp_legacy_${String(index + 1).padStart(4, '0')}_${createdAt.toString(36)}`,
      tubeNo,
      beltId: coral.beltId,
      provisionalGenus: coral.genus,
      form: coral.form ?? '枝状',
      coverCm: typeof coral.coverCm === 'number' ? coral.coverCm : 0,
      bleachLevel: coral.bleachLevel ?? '无',
      remark: `升级补管：旧记录${coral.remark ? `（${coral.remark}）` : ''}，待实验室按管号鉴定`,
      createdAt,
      updatedAt: typeof coral.updatedAt === 'number' ? coral.updatedAt : createdAt
    }
  })
}

/** Dexie 升级事务的最小形状（仅依赖本模块用到的成员） */
export interface LegacyUpgradeTransaction {
  /** Dexie 包装的底层原生 IDBTransaction（被删除的表只能从这里取） */
  idbtrans?: IDBTransaction
  table(name: string): { bulkPut(rows: CoralSample[]): Promise<unknown> }
}

/**
 * Dexie 升级事务内执行：用原生 objectStore 读旧 corals 表，
 * 补成待鉴定采样管写入 samples（corals 对象库随后由 Dexie 按 v3 schema 删除）。
 */
export async function migrateLegacyCoralsToSamples(tx: LegacyUpgradeTransaction): Promise<number> {
  const native = tx.idbtrans
  if (!native || !Array.from(native.objectStoreNames).includes('corals')) return 0
  const corals = await new Promise<LegacyCoralRecord[]>((resolve, reject) => {
    const request = native.objectStore('corals').getAll()
    request.onsuccess = () => resolve((request.result as LegacyCoralRecord[]) ?? [])
    request.onerror = () => reject(request.error)
  })
  if (corals.length === 0) return 0
  const samples = legacyCoralsToSamples(corals, [])
  await tx.table('samples').bulkPut(samples)
  return samples.length
}
