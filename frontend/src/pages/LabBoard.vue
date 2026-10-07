<script setup lang="ts">
/**
 * 模块 7：/lab 实验室鉴定与管号对账
 * 实验室按测序批次录入鉴定结果（管号、批次、成功/失败、鉴定属名、置信度、鉴定人）；
 * 鉴定失败只在本侧重试（追加记录），外业采样管不改动。
 * 对账按管号：待鉴定管（外业有、实验室没成功）与对不上的孤儿鉴定（实验室有、外业没有）分别列出。
 * 复用 <BleachTag>、<StatBadge>、<EmptyPanel>。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, DocumentCopy, Plus, RefreshRight, Search } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useSurveyStore } from '@/stores/surveyStore'
import { useLabStore } from '@/stores/labStore'
import { COMMON_GENERA } from '@/types/coralRecord'
import { ID_STATUSES } from '@/types/identification'
import type { IdStatus, Identification } from '@/types/identification'
import { parseIdentificationPaste } from '@/types/identification'
import { initDatabase } from '@/utils/db'
import type { ResolvedSample } from '@/utils/reconcile'

const route = useRoute()
const surveyStore = useSurveyStore()
const labStore = useLabStore()

const dialogVisible = ref(false)
const pasteVisible = ref(false)
const submitting = ref(false)
const pasteText = ref('')
const pasteErrors = ref<string[]>([])
const pasteBatchNo = ref('')
const pasteDate = ref(new Date().toISOString().slice(0, 10))
const detailTube = ref<string | null>(null)

/** 筛选 */
const keyword = ref(typeof route.query.kw === 'string' ? route.query.kw : '')
const batchFilter = ref('')
const statusTab = ref<'all' | 'pending' | 'changed' | 'failed'>(
  (route.query.tab as 'all' | 'pending' | 'changed' | 'failed') ?? 'all'
)
const focusBeltId = ref(typeof route.query.belt === 'string' ? route.query.belt : '')

const form = reactive({
  tubeNo: '',
  batchNo: '',
  status: '成功' as IdStatus,
  genus: '',
  confidence: 95,
  identifier: '',
  note: '',
  identifiedAt: new Date().toISOString().slice(0, 10)
})

const reconciliation = computed(() => surveyStore.reconciliation)

/** 待鉴定管（外业有、实验室没有成功鉴定） */
const pendingSamples = computed<ResolvedSample[]>(() => reconciliation.value.pendingSamples)

/** 对不上的孤儿鉴定（实验室有、外业没有） */
const orphanIdentifications = computed(() => reconciliation.value.orphanIdentifications)

/** 已归并的采样管（表格主数据） */
const beltNoById = computed(() => new Map(surveyStore.belts.map((belt) => [belt.id, belt.no])))
const rows = computed(() => {
  const kw = keyword.value.trim()
  return reconciliation.value.resolved
    .filter((item) => {
      if (focusBeltId.value && item.beltId !== focusBeltId.value) return false
      if (batchFilter.value && item.confirmed?.batchNo !== batchFilter.value && item.latest?.batchNo !== batchFilter.value) {
        return false
      }
      if (statusTab.value === 'pending' && item.confirmed) return false
      if (statusTab.value === 'failed' && item.latest?.status !== '失败') return false
      if (statusTab.value === 'changed' && !item.genusChanged) return false
      if (kw) {
        const haystack = `${item.tubeNo}${item.sample.provisionalGenus}${item.effectiveGenus}${
          item.confirmed?.identifier ?? ''
        }${beltNoById.value.get(item.beltId) ?? ''}`
        if (!haystack.includes(kw)) return false
      }
      return true
    })
    .sort((a, b) => a.tubeNo.localeCompare(b.tubeNo, 'zh-Hans-CN'))
})

const stats = computed(() => {
  const c = reconciliation.value.counts
  return {
    sampleTotal: c.sampleTotal,
    confirmedCount: c.confirmedCount,
    pendingCount: c.pendingCount,
    failedAttemptTubes: c.failedAttemptTubes,
    genusChangedCount: c.genusChangedCount,
    orphanTubeCount: c.orphanTubeCount
  }
})

function openCreate(tubeNo = '', status: IdStatus = '成功'): void {
  form.tubeNo = tubeNo
  form.batchNo = labStore.batchNos[0] ?? ''
  form.status = status
  form.genus = ''
  form.confidence = 95
  form.identifier = ''
  form.note = status === '失败' ? '扩增失败，需重试' : ''
  form.identifiedAt = new Date().toISOString().slice(0, 10)
  dialogVisible.value = true
}

/** 某管重试鉴定：外业采样管不动，只追加一条本侧鉴定记录 */
function openRetry(item: ResolvedSample): void {
  openCreate(item.tubeNo, '成功')
  form.genus = item.sample.provisionalGenus
  form.note = item.latest?.status === '失败' ? `上次失败：${item.latest.note}` : ''
}

async function submitForm(): Promise<void> {
  if (!form.tubeNo.trim()) {
    ElMessage.warning('请填写采样管管号')
    return
  }
  if (!form.batchNo.trim()) {
    ElMessage.warning('请填写测序批次号')
    return
  }
  if (form.status === '成功' && !form.genus.trim()) {
    ElMessage.warning('鉴定成功需填写鉴定属名')
    return
  }
  if (!Number.isFinite(form.confidence) || form.confidence < 0 || form.confidence > 100) {
    ElMessage.warning('置信度应为 0 ~ 100 的数字')
    return
  }
  if (!form.identifier.trim()) {
    ElMessage.warning('请填写鉴定人')
    return
  }
  submitting.value = true
  try {
    await labStore.createIdentification({
      tubeNo: form.tubeNo.trim(),
      batchNo: form.batchNo.trim(),
      status: form.status,
      genus: form.status === '成功' ? form.genus.trim() : '',
      confidence: form.status === '成功' ? form.confidence : 0,
      identifier: form.identifier.trim(),
      note: form.note.trim(),
      identifiedAt: form.identifiedAt
    })
    ElMessage.success(
      form.status === '成功'
        ? `管 ${form.tubeNo.trim()} 鉴定成功，覆盖率归并口径已按「${form.genus.trim()}」更新`
        : `管 ${form.tubeNo.trim()} 已登记鉴定失败，外业采样照旧，可继续在本侧重试`
    )
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeIdentification(record: Identification): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除管 ${record.tubeNo} 在批次 ${record.batchNo} 的${record.status}鉴定记录？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await labStore.removeIdentification(record.id)
  ElMessage.success('鉴定记录已删除')
}

function openPaste(): void {
  pasteText.value = ''
  pasteErrors.value = []
  pasteBatchNo.value = labStore.batchNos[0] ?? ''
  pasteVisible.value = true
}

function previewPaste(): void {
  const parsed = parseIdentificationPaste(pasteText.value)
  pasteErrors.value = parsed.errors
  if (parsed.rows.length === 0 && parsed.errors.length === 0) {
    ElMessage.warning('请先粘贴内容，每行「管号,批次,结果,属名,置信度,鉴定人」')
  }
}

async function importPaste(): Promise<void> {
  const parsed = parseIdentificationPaste(pasteText.value)
  pasteErrors.value = parsed.errors
  if (parsed.rows.length === 0) {
    ElMessage.warning('没有可导入的有效行')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将追加导入 ${parsed.rows.length} 条鉴定结果（同管多条按最近成功一条归并），确认导入？`,
      '批量导入确认',
      { type: 'warning', confirmButtonText: '追加导入', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const count = await labStore.importIdentificationRows(parsed.rows, pasteDate.value)
  pasteVisible.value = false
  ElMessage.success(`已追加 ${count} 条鉴定记录`)
}

const detailList = computed(() => (detailTube.value ? labStore.identificationsOfTube(detailTube.value) : []))

onMounted(() => {
  if (surveyStore.reefs.length === 0) void initDatabase()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <el-breadcrumb separator="/">
          <el-breadcrumb-item :to="{ path: '/coverage' }">覆盖度汇总</el-breadcrumb-item>
          <el-breadcrumb-item>实验室鉴定与管号对账</el-breadcrumb-item>
        </el-breadcrumb>
        <h2 class="page__title">实验室测序鉴定 · 管号对账</h2>
        <p class="gb-hint">
          按测序批次录入鉴定属名、置信度与鉴定人；鉴定失败只在本侧重试（追加记录），外业采样管不改动。
          汇总与导出统一口径：最近成功鉴定属名优先，未出鉴定先按外业暂定属名计入并标「暂定」。
        </p>
      </div>
      <div class="page__actions">
        <el-button :icon="DocumentCopy" @click="openPaste">批量录入</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate()">录入鉴定结果</el-button>
      </div>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="采样管总数" :value="stats.sampleTotal" suffix="管" icon="Histogram" />
      <StatBadge label="已确认属名" :value="stats.confirmedCount" suffix="管" tone="success" icon="CircleCheckFilled" />
      <StatBadge label="待鉴定" :value="stats.pendingCount" suffix="管" tone="warning" icon="Clock" />
      <StatBadge label="鉴定失败待重试" :value="stats.failedAttemptTubes" suffix="管" tone="danger" icon="WarningFilled" />
      <StatBadge label="属名改判" :value="stats.genusChangedCount" suffix="管" tone="info" icon="Switch" />
      <StatBadge label="对不上的管号" :value="stats.orphanTubeCount" suffix="个" tone="danger" icon="QuestionFilled" />
    </div>

    <el-alert
      v-if="stats.orphanTubeCount > 0"
      type="error"
      show-icon
      :closable="false"
      :title="`有 ${stats.orphanTubeCount} 个管号实验室出了鉴定、外业采样里查无此管，已在下方「对不上的鉴定」列出，请外业核对补采样记录。`"
    />

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>待实验室补鉴定的采样管（{{ pendingSamples.length }}）</h3>
        <span class="gb-hint">外业已采样、实验室尚无成功鉴定；覆盖率当前按外业暂定属名计入并标暂定</span>
      </div>
      <el-table :data="pendingSamples" border stripe size="small" class="gb-table-compact">
        <el-table-column prop="tubeNo" label="管号" width="130">
          <template #default="{ row }"><span class="gb-mono">{{ row.tubeNo }}</span></template>
        </el-table-column>
        <el-table-column label="样带" width="100">
          <template #default="{ row }">{{ beltNoById.get(row.beltId) ?? '—' }}</template>
        </el-table-column>
        <el-table-column prop="sample.provisionalGenus" label="暂定属名" min-width="130" />
        <el-table-column prop="form" label="形态" width="90" />
        <el-table-column label="覆盖长度" width="100" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.coverCm }} cm</span></template>
        </el-table-column>
        <el-table-column label="状态" width="170">
          <template #default="{ row }">
            <el-tag v-if="row.latest?.status === '失败'" size="small" type="danger" effect="plain">
              鉴定失败 ×{{ row.attemptCount }}
            </el-tag>
            <el-tag v-else size="small" type="warning" effect="plain">尚未鉴定</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="latest.note" label="最近说明" min-width="160" show-overflow-tooltip />
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" :icon="RefreshRight" @click="openRetry(row)">
              {{ row.latest?.status === '失败' ? '重试鉴定' : '录入鉴定' }}
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyPanel title="没有待鉴定的采样管" description="全部采样管都已拿到实验室成功鉴定。" compact />
        </template>
      </el-table>
    </el-card>

    <el-card v-if="orphanIdentifications.length > 0" shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>对不上的鉴定（实验室有、外业无，{{ orphanIdentifications.length }}）</h3>
        <span class="gb-hint">等外业核对管号 / 补采样记录；在补齐前这些鉴定不计入任何样带覆盖率</span>
      </div>
      <el-table :data="orphanIdentifications" border stripe size="small" class="gb-table-compact">
        <el-table-column prop="tubeNo" label="管号" width="140">
          <template #default="{ row }"><span class="gb-mono">{{ row.tubeNo }}</span></template>
        </el-table-column>
        <el-table-column label="最近批次 / 结果" min-width="170">
          <template #default="{ row }">
            <div class="gb-mono">{{ row.identifications[0]?.batchNo }}</div>
            <div class="gb-hint">
              {{ row.identifications[0]?.status }}
              <template v-if="row.identifications[0]?.status === '成功'">
                · {{ row.identifications[0]?.genus }} · {{ row.identifications[0]?.confidence }}%
              </template>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="鉴定人 / 日期" width="160">
          <template #default="{ row }">
            <div>{{ row.identifications[0]?.identifier }}</div>
            <div class="gb-hint gb-mono">{{ row.identifications[0]?.identifiedAt }}</div>
          </template>
        </el-table-column>
        <el-table-column label="鉴定次数" width="90" align="center">
          <template #default="{ row }">{{ row.identifications.length }}</template>
        </el-table-column>
        <el-table-column prop="identifications[0].note" label="备注" min-width="180" show-overflow-tooltip />
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>采样管鉴定归并台账（{{ rows.length }}）</h3>
        <div class="page__filters">
          <el-input
            v-model="keyword"
            placeholder="管号 / 属名 / 鉴定人 / 样带"
            clearable
            :prefix-icon="Search"
            style="width: 230px"
          />
          <el-select v-model="batchFilter" placeholder="测序批次" clearable style="width: 170px">
            <el-option v-for="batch in labStore.batchNos" :key="batch" :label="batch" :value="batch" />
          </el-select>
          <el-radio-group v-model="statusTab" size="small">
            <el-radio-button value="all">全部</el-radio-button>
            <el-radio-button value="pending">待鉴定</el-radio-button>
            <el-radio-button value="failed">失败待重试</el-radio-button>
            <el-radio-button value="changed">属名改判</el-radio-button>
          </el-radio-group>
        </div>
      </div>

      <el-table :data="rows" border stripe size="small" class="gb-table-compact">
        <el-table-column prop="tubeNo" label="管号" width="120">
          <template #default="{ row }"><span class="gb-mono">{{ row.tubeNo }}</span></template>
        </el-table-column>
        <el-table-column label="样带" width="80">
          <template #default="{ row }">{{ beltNoById.get(row.beltId) ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="外业暂定 → 有效属名" min-width="210">
          <template #default="{ row }">
            <span class="gb-hint">{{ row.sample.provisionalGenus }}</span>
            <span v-if="row.confirmed" style="margin: 0 6px">→</span>
            <strong v-if="row.confirmed">{{ row.effectiveGenus }}</strong>
            <el-tag size="small" :type="row.genusSource === '暂定' ? 'warning' : 'success'" effect="plain" style="margin-left: 6px">
              {{ row.genusSource === '暂定' ? '暂定' : '鉴定' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="最近批次" width="120">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.confirmed?.batchNo ?? row.latest?.batchNo ?? '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="结果 / 置信度" width="130">
          <template #default="{ row }">
            <el-tag v-if="row.confirmed" size="small" type="success" effect="plain">
              {{ row.confirmed.confidence }}%
            </el-tag>
            <el-tag v-else-if="row.latest?.status === '失败'" size="small" type="danger" effect="plain">失败</el-tag>
            <el-tag v-else size="small" type="info" effect="plain">待鉴定</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="鉴定人 / 日期" min-width="150">
          <template #default="{ row }">
            <div>{{ row.confirmed?.identifier ?? row.latest?.identifier ?? '—' }}</div>
            <div class="gb-hint gb-mono">{{ row.confirmed?.identifiedAt ?? row.latest?.identifiedAt ?? '' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="尝试次数" width="80" align="center">
          <template #default="{ row }">
            <el-button text size="small" type="primary" @click="detailTube = row.tubeNo">{{ row.attemptCount }}</el-button>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button v-if="!row.confirmed || row.latest?.status === '失败'" size="small" type="primary" :icon="RefreshRight" @click="openRetry(row)">重试</el-button>
            <el-button v-else size="small" :icon="Plus" @click="openCreate(row.tubeNo, '成功')">追加</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="form.status === '失败' ? '登记鉴定失败（本侧重试留痕）' : '录入鉴定结果'" width="560px" :close-on-click-modal="false">
      <el-form label-width="110px">
        <el-form-item label="管号" required>
          <el-input v-model="form.tubeNo" placeholder="如：QL01A-02（须与外业管号一致）" maxlength="30" />
        </el-form-item>
        <el-form-item label="测序批次" required>
          <el-input v-model="form.batchNo" list="batch-options" placeholder="如：SEQ-2026-10" maxlength="30" />
          <datalist id="batch-options">
            <option v-for="batch in labStore.batchNos" :key="batch" :value="batch"></option>
          </datalist>
        </el-form-item>
        <el-form-item label="结果" required>
          <el-radio-group v-model="form.status">
            <el-radio-button v-for="item in ID_STATUSES" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="form.status === '成功'" label="鉴定属名" required>
          <el-input v-model="form.genus" list="id-genus-options" placeholder="如：鹿角珊瑚属" maxlength="30" />
          <datalist id="id-genus-options">
            <option v-for="genus in COMMON_GENERA" :key="genus" :value="genus"></option>
          </datalist>
        </el-form-item>
        <el-form-item v-if="form.status === '成功'" label="置信度" required>
          <el-slider v-model="form.confidence" :min="0" :max="100" :step="0.1" show-input input-size="small" />
        </el-form-item>
        <el-form-item label="鉴定人" required>
          <el-input v-model="form.identifier" placeholder="如：苏岩" maxlength="20" />
        </el-form-item>
        <el-form-item label="鉴定日期" required>
          <el-date-picker v-model="form.identifiedAt" type="date" value-format="YYYY-MM-DD" placeholder="选择鉴定日期" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" type="textarea" :rows="2" placeholder="失败原因 / 引物 / 改判说明" maxlength="100" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ form.status === '失败' ? '登记失败' : '提交鉴定' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="pasteVisible" title="批量录入鉴定结果（追加）" width="660px">
      <p class="gb-hint">
        每行一条「管号,批次,结果(成功/失败),属名,置信度,鉴定人」；失败行属名与置信度可留 0。示例：<br />
        <span class="gb-mono">QL01A-02,SEQ-2026-10,成功,鹿角珊瑚属,96.5,苏岩</span><br />
        <span class="gb-mono">QL01B-03,SEQ-2026-10,失败,,0,何鉴</span>
      </p>
      <el-input v-model="pasteText" type="textarea" :rows="8" />
      <el-form label-width="90px" style="margin-top: 10px">
        <el-form-item label="鉴定日期">
          <el-date-picker v-model="pasteDate" type="date" value-format="YYYY-MM-DD" />
          <span class="gb-hint" style="margin-left: 10px">批量行统一使用该日期</span>
        </el-form-item>
      </el-form>
      <div v-if="pasteErrors.length > 0" class="page__errors">
        <el-alert v-for="(error, index) in pasteErrors" :key="index" type="warning" :title="error" :closable="false" show-icon />
      </div>
      <template #footer>
        <el-button @click="pasteVisible = false">取消</el-button>
        <el-button @click="previewPaste">解析预览</el-button>
        <el-button type="primary" @click="importPaste">追加导入</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="detailTube" :title="`管 ${detailTube ?? ''} 的鉴定记录`" size="420px">
      <el-timeline>
        <el-timeline-item
          v-for="record in detailList"
          :key="record.id"
          :type="record.status === '成功' ? 'success' : 'danger'"
          :timestamp="`${record.identifiedAt} · ${record.batchNo}`"
        >
          <div>
            <el-tag size="small" :type="record.status === '成功' ? 'success' : 'danger'" effect="plain">
              {{ record.status }}
            </el-tag>
            <strong v-if="record.status === '成功'" style="margin-left: 8px">{{ record.genus }}（{{ record.confidence }}%）</strong>
          </div>
          <div class="gb-hint">鉴定人：{{ record.identifier }}</div>
          <div v-if="record.note" class="gb-hint">{{ record.note }}</div>
          <el-button size="small" type="danger" plain :icon="Delete" style="margin-top: 6px" @click="removeIdentification(record)">
            删除该条
          </el-button>
        </el-timeline-item>
      </el-timeline>
      <el-empty v-if="detailList.length === 0" description="暂无鉴定记录" />
    </el-drawer>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  margin: 8px 0 4px;
  font-size: 19px;
  color: #0b5d5a;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.page__errors {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
  max-height: 160px;
  overflow: auto;
}
</style>
