<script setup lang="ts">
/**
 * 模块 7：/lab 实验室鉴定与管号对账
 * 实验室按测序批次出鉴定属名、置信度与鉴定人；失败后只在本侧重试，外业采集不动。
 * 三个页签：待鉴定 / 鉴定失败（本侧重试入口）、全部鉴定流水、按管号对账（含对不上的孤立鉴定）。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, DocumentCopy, RefreshRight, Search } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useReefStore } from '@/stores/reefStore'
import { useBeltStore } from '@/stores/beltStore'
import { useLabStore } from '@/stores/labStore'
import { COMMON_GENERA } from '@/types/coralRecord'
import type { IdStatus, CoralIdentification } from '@/types/identification'
import { ID_STATUSES, parseIdentificationPaste } from '@/types/identification'
import { initDatabase } from '@/utils/db'
import type { ResolvedSample } from '@/utils/reconcile'

const route = useRoute()
const reefStore = useReefStore()
const beltStore = useBeltStore()
const labStore = useLabStore()

const activeTab = ref<string>('pending')

const batchForm = reactive({
  batchNo: '',
  identifier: '',
  identifiedAt: new Date().toISOString().slice(0, 10),
  pasteText: ''
})
const pasteErrors = ref<string[]>([])

const dialogVisible = ref(false)
const retryTarget = ref<ResolvedSample | null>(null)
const submitting = ref(false)
const retryForm = reactive({
  batchNo: '',
  status: '成功' as IdStatus,
  genus: '',
  confidence: 0.95,
  identifier: '',
  identifiedAt: new Date().toISOString().slice(0, 10),
  note: ''
})

const beltFilter = ref<string>(typeof route.query.belt === 'string' ? route.query.belt : '')

/** 待鉴定 + 鉴定失败（暂定计入的管子） */
const pendingRows = computed(() =>
  labStore.resolvedSamples
    .filter((row) => row.resolveStatus !== '已鉴定')
    .filter((row) => !beltFilter.value || row.beltId === beltFilter.value)
    .sort((a, b) => {
      if (a.resolveStatus !== b.resolveStatus) return a.resolveStatus === '鉴定失败' ? -1 : 1
      return a.tubeNo.localeCompare(b.tubeNo, 'zh-Hans-CN')
    })
)

/** 全部鉴定流水（含失败重试），最新在前 */
const identificationRows = computed(() =>
  [...labStore.identifications]
    .filter((ident) => {
      if (!beltFilter.value) return true
      const sample = labStore.sampleByTube(ident.tubeNo)
      return sample?.beltId === beltFilter.value
    })
    .sort((a, b) => b.identifiedAt.localeCompare(a.identifiedAt) || b.createdAt - a.createdAt)
)

/** 对账列表：全部外业管 + 孤立鉴定标记 */
const reconciledRows = computed(() => {
  const rows = labStore.resolvedSamples
    .filter((row) => !beltFilter.value || row.beltId === beltFilter.value)
    .map((row) => {
      const belt = beltStore.beltById(row.beltId)
      const site = belt ? reefStore.siteById(belt.siteId) : null
      const reef = site ? reefStore.reefById(site.reefId) : null
      return {
        row,
        beltNo: belt?.no ?? '—',
        siteNo: site?.no ?? '—',
        reefName: reef?.name ?? '未知礁区'
      }
    })
  return rows.sort((a, b) => a.row.tubeNo.localeCompare(b.row.tubeNo, 'zh-Hans-CN'))
})

const orphanRows = computed(() => labStore.orphans)

const stats = computed(() => ({
  total: labStore.samples.length,
  pending: labStore.pendingCount,
  failed: labStore.failedCount,
  changed: labStore.genusChangedCount,
  orphan: labStore.orphanCount,
  idCount: labStore.identifications.length
}))

/** 样带筛选选项（全部样带） */
const beltOptions = computed(() =>
  beltStore.belts.map((belt) => {
    const site = reefStore.siteById(belt.siteId)
    const reef = site ? reefStore.reefById(site.reefId) : null
    return {
      value: belt.id,
      label: `${reef?.name ?? '未知礁区'} / ${site?.no ?? '—'} / 样带 ${belt.no}`
    }
  })
)

function previewPaste(): void {
  const parsed = parseIdentificationPaste(batchForm.pasteText)
  pasteErrors.value = parsed.errors
  if (parsed.rows.length === 0 && parsed.errors.length === 0) {
    ElMessage.warning('请先粘贴内容，每行「管号,测序批次,鉴定属名,置信度,鉴定人」，失败时属名填「失败」')
  }
}

async function submitBatch(): Promise<void> {
  if (!batchForm.identifier.trim()) {
    ElMessage.warning('请填写本批次鉴定人')
    return
  }
  const parsed = parseIdentificationPaste(batchForm.pasteText)
  pasteErrors.value = parsed.errors
  if (parsed.rows.length === 0) {
    ElMessage.warning('没有可录入的有效行')
    return
  }
  const fallbackBatch = batchForm.batchNo.trim()
  const rows = parsed.rows.map((row) => ({
    ...row,
    batchNo: row.batchNo || fallbackBatch,
    identifier: row.identifier || batchForm.identifier.trim()
  }))
  const result = await labStore.importIdentificationRows(rows, batchForm.identifiedAt)
  ElMessage.success(
    `批次已录入：新增 ${result.created} 条、更新 ${result.updated} 条；外业样本管未做任何改动`
  )
  batchForm.pasteText = ''
  pasteErrors.value = []
  activeTab.value = 'reconcile'
}

function openRetry(row: ResolvedSample): void {
  retryTarget.value = row
  const last = labStore.identificationsOfTube(row.tubeNo)[0]
  retryForm.batchNo = batchForm.batchNo.trim() || last?.batchNo || ''
  retryForm.status = '成功'
  retryForm.genus = row.fieldGenus
  retryForm.confidence = 0.95
  retryForm.identifier = batchForm.identifier.trim() || last?.identifier || ''
  retryForm.identifiedAt = batchForm.identifiedAt || new Date().toISOString().slice(0, 10)
  retryForm.note = ''
  dialogVisible.value = true
}

async function submitRetry(): Promise<void> {
  const target = retryTarget.value
  if (!target) return
  if (!retryForm.batchNo.trim()) {
    ElMessage.warning('请填写测序批次号')
    return
  }
  if (retryForm.status === '成功' && !retryForm.genus.trim()) {
    ElMessage.warning('鉴定成功时必须填写鉴定属名')
    return
  }
  if (retryForm.confidence < 0 || retryForm.confidence > 1) {
    ElMessage.warning('置信度应为 0 ~ 1 之间的小数')
    return
  }
  submitting.value = true
  try {
    await labStore.retryIdentification(target.tubeNo, {
      batchNo: retryForm.batchNo.trim(),
      status: retryForm.status,
      genus: retryForm.status === '成功' ? retryForm.genus.trim() : '',
      confidence: retryForm.status === '成功' ? retryForm.confidence : 0,
      identifier: retryForm.identifier.trim(),
      identifiedAt: retryForm.identifiedAt,
      note: retryForm.note.trim()
    })
    ElMessage.success(
      retryForm.status === '成功'
        ? `管 ${target.tubeNo} 重试成功，覆盖率改按实验室属名「${retryForm.genus.trim()}」归并`
        : `管 ${target.tubeNo} 已再次登记失败（仅实验室侧重试，外业采集不动）`
    )
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeIdentification(ident: CoralIdentification): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除 ${ident.tubeNo} 在批次 ${ident.batchNo} 的${ident.status === '成功' ? '鉴定' : '失败'}记录？外业样本管不受影响。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await labStore.removeIdentification(ident.id)
  ElMessage.success('鉴定记录已删除')
}

onMounted(() => {
  if (reefStore.reefs.length === 0) void initDatabase()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">实验室鉴定与管号对账</h2>
        <p class="gb-hint">
          按测序批次录入鉴定属名、置信度与鉴定人，两边按管号对账。
          覆盖率 / 白化指数已鉴定按实验室属名归并；<strong>未出鉴定或失败先按外业暂定属名计入并标注</strong>；
          鉴定失败只在本侧重试，外业采集记录不动。
        </p>
      </div>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="样本管" :value="stats.total" suffix="管" icon="Histogram" />
      <StatBadge label="待鉴定" :value="stats.pending" suffix="管" tone="info" icon="Clock" />
      <StatBadge label="鉴定失败" :value="stats.failed" suffix="管" tone="warning" icon="WarningFilled" />
      <StatBadge label="属名被更正" :value="stats.changed" suffix="管" tone="success" icon="Switch" />
      <StatBadge label="对不上的管号" :value="stats.orphan" suffix="条" tone="warning" icon="Warning" />
      <StatBadge label="鉴定记录" :value="stats.idCount" suffix="条" icon="Document" />
    </div>

    <el-card shadow="never" class="gb-panel">
      <el-tabs v-model="activeTab">
        <!-- 批次录入 -->
        <el-tab-pane name="entry">
          <template #label>
            <span><el-icon><DocumentCopy /></el-icon> 批次录入</span>
          </template>
          <el-form label-width="110px" class="lab-form">
            <div class="lab-form__row">
              <el-form-item label="测序批次号">
                <el-input v-model="batchForm.batchNo" placeholder="如：B2026-10B（粘贴行内也可逐行写）" maxlength="30" />
              </el-form-item>
              <el-form-item label="鉴定人">
                <el-input v-model="batchForm.identifier" placeholder="如：沈知微" maxlength="20" />
              </el-form-item>
              <el-form-item label="鉴定日期">
                <el-date-picker v-model="batchForm.identifiedAt" type="date" value-format="YYYY-MM-DD" />
              </el-form-item>
            </div>
            <el-form-item label="鉴定结果">
              <el-input
                v-model="batchForm.pasteText"
                type="textarea"
                :rows="9"
                placeholder="管号,测序批次,鉴定属名,置信度,鉴定人&#10;QL01-A04,B2026-10B,软珊瑚属,0.94,何其芳&#10;QL02-A02,B2026-10B,失败,0,何其芳"
              />
            </el-form-item>
            <div class="gb-hint">
              每行一条：成功填鉴定属名与 0~1 置信度；<strong>鉴定失败属名填「失败」、置信度填 0</strong>，
              该管继续按外业暂定属名计入并在「待鉴定 / 失败」页签里提供重试。同管号同批次重复提交会覆盖更新，不新增。
            </div>
            <div v-if="pasteErrors.length > 0" class="page__errors">
              <el-alert v-for="(error, index) in pasteErrors" :key="index" type="warning" :title="error" :closable="false" show-icon />
            </div>
            <el-form-item>
              <el-button @click="previewPaste">解析预览</el-button>
              <el-button type="primary" :icon="Search" @click="submitBatch">录入本批次</el-button>
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <!-- 待鉴定 / 失败重试 -->
        <el-tab-pane name="pending">
          <template #label>
            <span>
              <el-icon><Clock /></el-icon> 待鉴定 / 失败
              <el-badge v-if="stats.pending + stats.failed > 0" :value="stats.pending + stats.failed" class="lab-badge" />
            </span>
          </template>
          <EmptyPanel
            v-if="pendingRows.length === 0"
            title="没有待鉴定或鉴定失败的样本管"
            description="所有外业样本管都已有成功鉴定，覆盖率正全部按实验室属名归并。"
            compact
          />
          <el-table v-else :data="pendingRows" border stripe class="gb-table-compact">
            <el-table-column label="管号" width="120">
              <template #default="{ row }"><span class="gb-mono"><strong>{{ row.tubeNo }}</strong></span></template>
            </el-table-column>
            <el-table-column label="状态" width="150">
              <template #default="{ row }">
                <el-tag v-if="row.resolveStatus === '待鉴定'" size="small" type="info" effect="plain">待鉴定·暂定</el-tag>
                <el-tag v-else size="small" type="danger" effect="plain">鉴定失败·暂定</el-tag>
                <div v-if="row.batchNo" class="gb-hint gb-mono">最近批次 {{ row.batchNo }}</div>
              </template>
            </el-table-column>
            <el-table-column label="外业暂定属名（当前计入）" min-width="200">
              <template #default="{ row }">
                {{ row.fieldGenus }}
                <div class="gb-hint">
                  {{ row.form }} · 覆盖 {{ row.coverCm }} cm · {{ row.collector || '采样人未填' }}
                </div>
              </template>
            </el-table-column>
            <el-table-column label="覆盖 / 白化" width="150">
              <template #default="{ row }">
                <span class="gb-mono">{{ row.coverCm }} cm</span>
                <div class="gb-hint">{{ row.bleachLevel }}</div>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="150" fixed="right">
              <template #default="{ row }">
                <el-button size="small" type="primary" :icon="RefreshRight" @click="openRetry(row)">
                  {{ row.resolveStatus === '鉴定失败' ? '重试鉴定' : '录入鉴定' }}
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <!-- 对账 -->
        <el-tab-pane name="reconcile">
          <template #label>
            <span>
              <el-icon><Connection /></el-icon> 按管号对账
              <el-badge v-if="stats.orphan > 0" :value="stats.orphan" type="warning" class="lab-badge" />
            </span>
          </template>

          <div class="lab-filter">
            <el-select v-model="beltFilter" placeholder="全部样带" clearable filterable style="width: 340px">
              <el-option v-for="option in beltOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
            <span class="gb-hint">已鉴定按实验室属名归并；标「暂定」的管子按外业暂定属名计入。</span>
          </div>

          <el-alert
            v-if="orphanRows.length > 0"
            class="lab-orphan-alert"
            type="warning"
            show-icon
            :closable="false"
            :title="`有 ${orphanRows.length} 个管号实验室出了鉴定、外业样本里找不到（管号誊抄错误或外业漏采），已单列在下方等实验室核对补录，不计入任何覆盖率。`"
          />

          <el-table :data="reconciledRows" border stripe class="gb-table-compact">
            <el-table-column label="管号" width="120">
              <template #default="{ row }"><span class="gb-mono"><strong>{{ row.row.tubeNo }}</strong></span></template>
            </el-table-column>
            <el-table-column label="礁区 / 站位 / 样带" min-width="200">
              <template #default="{ row }">
                {{ row.reefName }}
                <div class="gb-hint">站位 {{ row.siteNo }} · 样带 {{ row.beltNo }}</div>
              </template>
            </el-table-column>
            <el-table-column label="外业暂定属名" min-width="130">
              <template #default="{ row }">{{ row.row.fieldGenus }}</template>
            </el-table-column>
            <el-table-column label="实验室鉴定" min-width="200">
              <template #default="{ row }">
                <template v-if="row.row.labGenus">
                  <strong :class="{ 'lab-changed': row.row.genusChanged }">{{ row.row.labGenus }}</strong>
                  <el-tag v-if="row.row.genusChanged" size="small" type="success" effect="plain">已更正</el-tag>
                  <div class="gb-hint gb-mono">
                    置信度 {{ row.row.confidence !== null ? row.row.confidence.toFixed(2) : '—' }}
                    · {{ row.row.identifier }} · {{ row.row.batchNo }}
                  </div>
                </template>
                <el-tag v-else-if="row.row.resolveStatus === '鉴定失败'" size="small" type="danger" effect="plain">
                  失败·暂定（{{ row.row.batchNo ?? '—' }}）
                </el-tag>
                <el-tag v-else size="small" type="info" effect="plain">待鉴定·暂定</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="覆盖 (cm)" width="100" align="right">
              <template #default="{ row }"><span class="gb-mono">{{ row.row.coverCm }}</span></template>
            </el-table-column>
            <el-table-column label="计入口径" width="130">
              <template #default="{ row }">
                <el-tag v-if="row.row.provisional" size="small" type="warning" effect="plain">暂定属名</el-tag>
                <el-tag v-else size="small" type="success" effect="plain">实验室属名</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="130">
              <template #default="{ row }">
                <el-button
                  v-if="row.row.resolveStatus !== '已鉴定'"
                  size="small"
                  :icon="RefreshRight"
                  @click="openRetry(row.row)"
                >
                  {{ row.row.resolveStatus === '鉴定失败' ? '重试' : '鉴定' }}
                </el-button>
                <span v-else class="gb-hint">—</span>
              </template>
            </el-table-column>
          </el-table>

          <h3 class="lab-sub">对不上的鉴定（实验室有、外业没有，等实验室补）</h3>
          <EmptyPanel
            v-if="orphanRows.length === 0"
            title="没有对不上的管号"
            description="实验室鉴定管号与外业样本管全部匹配。"
            compact
          />
          <el-table v-else :data="orphanRows" border stripe class="gb-table-compact">
            <el-table-column label="管号" width="140">
              <template #default="{ row }"><span class="gb-mono"><strong>{{ row.tubeNo }}</strong></span></template>
            </el-table-column>
            <el-table-column label="最近批次 / 日期" min-width="180">
              <template #default="{ row }">
                {{ row.latest.batchNo }}
                <div class="gb-hint gb-mono">{{ row.latest.identifiedAt }} · 共 {{ row.recordCount }} 条</div>
              </template>
            </el-table-column>
            <el-table-column label="鉴定属名" min-width="160">
              <template #default="{ row }">
                <strong v-if="row.successGenus">{{ row.successGenus }}</strong>
                <el-tag v-else size="small" type="danger" effect="plain">仅失败记录</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="鉴定人" width="120">
              <template #default="{ row }">{{ row.latest.identifier }}</template>
            </el-table-column>
            <el-table-column label="处理" min-width="220">
              <template #default>
                <span class="gb-hint">请核对管号是否誊抄错误，或联系外业补采；核对前不参与覆盖率。</span>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <!-- 鉴定流水 -->
        <el-tab-pane name="log">
          <template #label>
            <span><el-icon><List /></el-icon> 鉴定流水</span>
          </template>
          <el-table :data="identificationRows" border stripe class="gb-table-compact">
            <el-table-column label="管号" width="130">
              <template #default="{ row }"><span class="gb-mono"><strong>{{ row.tubeNo }}</strong></span></template>
            </el-table-column>
            <el-table-column label="测序批次" width="140">
              <template #default="{ row }"><span class="gb-mono">{{ row.batchNo }}</span></template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="row.status === '成功' ? 'success' : 'danger'" size="small" effect="plain">{{ row.status }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="鉴定属名" min-width="150">
              <template #default="{ row }">{{ row.genus || '—' }}</template>
            </el-table-column>
            <el-table-column label="置信度" width="90" align="right">
              <template #default="{ row }">{{ row.status === '成功' ? row.confidence.toFixed(2) : '—' }}</template>
            </el-table-column>
            <el-table-column label="次数" width="70" align="center">
              <template #default="{ row }">{{ row.attempt }}</template>
            </el-table-column>
            <el-table-column label="鉴定人" width="110">
              <template #default="{ row }">{{ row.identifier }}</template>
            </el-table-column>
            <el-table-column label="鉴定日期" width="120">
              <template #default="{ row }"><span class="gb-mono">{{ row.identifiedAt }}</span></template>
            </el-table-column>
            <el-table-column prop="note" label="备注" min-width="150" show-overflow-tooltip />
            <el-table-column label="操作" width="90" fixed="right">
              <template #default="{ row }">
                <el-button size="small" type="danger" plain :icon="Delete" @click="removeIdentification(row)" />
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- 单管鉴定 / 重试弹窗：只写实验室侧 -->
    <el-dialog
      v-model="dialogVisible"
      :title="retryTarget?.resolveStatus === '鉴定失败' ? `管 ${retryTarget?.tubeNo} 失败重试（仅实验室侧）` : `为管 ${retryTarget?.tubeNo} 录入鉴定`"
      width="520px"
      :close-on-click-modal="false"
    >
      <p v-if="retryTarget" class="gb-hint">
        外业暂定属名「{{ retryTarget.fieldGenus }}」（{{ retryTarget.form }}，覆盖 {{ retryTarget.coverCm }} cm）。
        实验室只重试本管鉴定，外业采样记录不会改动；鉴定成功后覆盖率自动改按实验室属名归并。
      </p>
      <el-form label-width="100px">
        <el-form-item label="测序批次" required>
          <el-input v-model="retryForm.batchNo" placeholder="如：B2026-10B" maxlength="30" />
        </el-form-item>
        <el-form-item label="鉴定结果" required>
          <el-radio-group v-model="retryForm.status">
            <el-radio-button v-for="status in ID_STATUSES" :key="status" :value="status">{{ status }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="retryForm.status === '成功'" label="鉴定属名" required>
          <el-input v-model="retryForm.genus" list="genus-options" placeholder="实验室鉴定属名" maxlength="30" />
          <datalist id="genus-options">
            <option v-for="genus in COMMON_GENERA" :key="genus" :value="genus"></option>
          </datalist>
        </el-form-item>
        <el-form-item v-if="retryForm.status === '成功'" label="置信度" required>
          <el-input-number v-model="retryForm.confidence" :min="0" :max="1" :step="0.01" :precision="2" controls-position="right" />
        </el-form-item>
        <el-form-item label="鉴定人" required>
          <el-input v-model="retryForm.identifier" maxlength="20" />
        </el-form-item>
        <el-form-item label="鉴定日期" required>
          <el-date-picker v-model="retryForm.identifiedAt" type="date" value-format="YYYY-MM-DD" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="retryForm.note" placeholder="失败原因 / 复测说明" maxlength="60" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitRetry">
          {{ retryForm.status === '成功' ? '提交鉴定' : '登记失败（继续暂定计入）' }}
        </el-button>
      </template>
    </el-dialog>
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
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0b5d5a;
}

.lab-form__row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 0 20px;
}

.lab-badge {
  margin-left: 6px;
}

.lab-filter {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.lab-orphan-alert {
  margin-bottom: 12px;
}

.lab-sub {
  margin: 20px 0 8px;
  font-size: 15px;
  color: #0b5d5a;
}

.lab-changed {
  color: #1e8449;
}

.page__errors {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 8px 0;
  max-height: 180px;
  overflow: auto;
}
</style>
