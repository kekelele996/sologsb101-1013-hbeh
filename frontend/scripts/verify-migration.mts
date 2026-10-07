/**
 * v2 → v3 迁移与对账口径验证（Node + fake-indexeddb，不入构建产物）。
 * 覆盖：旧数据补待鉴定管、暂定计入、鉴定失败只重试本侧、成功改判、孤儿鉴定列出。
 *
 * 用原生 indexedDB API 构造一个 verno=2 的旧库（避免两个 Dexie 实例的连接关闭时序
 * 干扰升级事件），再用真实应用模块 db.ts 打开触发 v3 upgrade。
 */
import 'fake-indexeddb/auto'

function assertEq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    console.error(`✗ ${label}\n  expected ${e}\n  actual   ${a}`)
    process.exitCode = 1
  } else {
    console.log(`✓ ${label}`)
  }
}

const DB_NAME = 'gbcoralbelt'

/**
 * 用原生 API 在单例打开后重建一个 verno=2、含旧珊瑚记录的库。
 * 真实浏览器升级即「同一个 db 连接发生 versionchange」：先 open 到当前版本、delete 还原、
 * 原生造 v2 数据、再用同一单例 reopen 触发 v3 upgrade（Dexie 的升级事件依赖该连接生命周期）。
 */
async function recreateV2OnSingleton(
  db: { open(): Promise<unknown>; delete(): Promise<unknown>; close(): Promise<void> },
  corals: Array<Record<string, unknown>>
): Promise<void> {
  await db.open()
  await db.delete()
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2)
    req.onupgradeneeded = () => {
      const idb = req.result
      for (const name of ['reefs', 'sites', 'belts', 'corals', 'fishes']) {
        if (!idb.objectStoreNames.contains(name)) idb.createObjectStore(name, { keyPath: 'id' })
      }
      const tx = req.transaction!
      tx.objectStore('belts').put({ id: 'b1', siteId: 's1' })
      corals.forEach((coral) => tx.objectStore('corals').put(coral))
      tx.oncomplete = () => {
        idb.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    }
    req.onerror = () => reject(req.error)
  })
}

async function main(): Promise<void> {
  const { db, createId } = await import('../src/utils/db.ts')
  await recreateV2OnSingleton(db, [
    { id: 'c1', beltId: 'b1', genus: '鹿角珊瑚属', form: '枝状', coverCm: 800, bleachLevel: '无', remark: '', createdAt: 1, updatedAt: 1 },
    { id: 'c2', beltId: 'b1', genus: '滨珊瑚属', form: '块状', coverCm: 200, bleachLevel: '中', remark: '', createdAt: 2, updatedAt: 2 }
  ])
  console.log('✓ 已在同一连接上还原含 2 条旧珊瑚记录的 v2 库，重新打开触发 v3 升级')

  await db.open()

  const samples = await db.table('samples').toArray()
  assertEq(samples.length, 2, '旧 2 条珊瑚记录补成 2 根待鉴定采样管')
  assertEq(
    samples.map((s) => s.tubeNo),
    ['LEGACY-000001', 'LEGACY-000002'],
    '补出的管号为 LEGACY 顺序号且全局唯一'
  )
  assertEq(
    samples.map((s) => s.provisionalGenus),
    ['鹿角珊瑚属', '滨珊瑚属'],
    '暂定属名继承旧属名'
  )
  assertEq(
    samples.map((s) => s.coverCm),
    [800, 200],
    '覆盖长度原样继承'
  )

  // 对账：未鉴定时全部暂定、按暂定属名归并
  const { reconcileSamples } = await import('../src/utils/reconcile.ts')
  let rec = reconcileSamples(samples, [])
  assertEq(rec.counts.pendingCount, 2, '两管均待鉴定')
  assertEq(rec.resolved.map((r) => r.genusSource), ['暂定', '暂定'], '未出鉴定先按外业暂定属名计入并标暂定')

  // 第一管失败一次再成功改判；另出一条外业没有的孤儿鉴定
  const now = Date.now()
  await db.table('identifications').bulkPut([
    { id: createId('idn'), tubeNo: 'LEGACY-000001', batchNo: 'B1', status: '失败', genus: '', confidence: 0, identifier: '乙', note: '扩增失败', identifiedAt: '2026-10-01', createdAt: now, updatedAt: now },
    { id: createId('idn'), tubeNo: 'LEGACY-000001', batchNo: 'B2', status: '成功', genus: '杯形珊瑚属', confidence: 96.4, identifier: '乙', note: '重试成功', identifiedAt: '2026-10-05', createdAt: now + 1, updatedAt: now + 1 },
    { id: createId('idn'), tubeNo: 'GHOST-9', batchNo: 'B2', status: '成功', genus: '鹿角珊瑚属', confidence: 88, identifier: '丙', note: '', identifiedAt: '2026-10-05', createdAt: now + 2, updatedAt: now + 2 }
  ])
  rec = reconcileSamples(await db.table('samples').toArray(), await db.table('identifications').toArray())
  const first = rec.byTube.get('LEGACY-000001')
  assertEq(first?.effectiveGenus, '杯形珊瑚属', '失败后重试成功：按最近成功鉴定属名归并（覆盖暂定属名）')
  assertEq(first?.genusSource, '鉴定', '重试成功后属名来源为鉴定')
  assertEq(first?.attemptCount, 2, '该管保留 2 次鉴定尝试（失败留痕，外业采样未动）')
  assertEq(first?.genusChanged, true, '实验室属名与外业暂定不一致时标改判')
  const second = rec.byTube.get('LEGACY-000002')
  assertEq(second?.effectiveGenus, '滨珊瑚属', '仍未成功鉴定的管继续按暂定属名计入')
  assertEq(rec.counts.pendingCount, 1, '剩 1 管待鉴定')
  assertEq(
    rec.orphanIdentifications.map((o) => o.tubeNo),
    ['GHOST-9'],
    '实验室有、外业没有的管号列入对不上的孤儿鉴定'
  )

  // 覆盖率按有效属名归并：杯形珊瑚属 800 + 滨珊瑚属 200；暂定覆盖只有滨珊瑚 200
  const { effectiveRecords } = await import('../src/utils/reconcile.ts')
  const records = effectiveRecords(rec)
  const byGenus = new Map<string, { total: number; provisional: number }>()
  records.forEach((r) => {
    const b = byGenus.get(r.genus) ?? { total: 0, provisional: 0 }
    b.total += r.coverCm
    if (r.genusSource === '暂定') b.provisional += r.coverCm
    byGenus.set(r.genus, b)
  })
  assertEq(
    Object.fromEntries(Array.from(byGenus.entries()).map(([g, v]) => [g, v.total])),
    { 杯形珊瑚属: 800, 滨珊瑚属: 200 },
    '覆盖率按实验室鉴定属名归并（旧暂定属名不再串到鹿角珊瑚属）'
  )
  assertEq(
    Object.fromEntries(Array.from(byGenus.entries()).map(([g, v]) => [g, v.provisional])),
    { 杯形珊瑚属: 0, 滨珊瑚属: 200 },
    '暂定覆盖长度只落在仍待鉴定的属上'
  )

  await db.close()
  await new Promise<void>((resolve) => {
    indexedDB.deleteDatabase(DB_NAME).onsuccess = () => resolve()
  })
  console.log(process.exitCode ? 'FAILED' : 'ALL PASSED')
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
