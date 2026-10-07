<script setup lang="ts">
/**
 * 模块 4：/belts/:id/corals 外业采样（样本管）
 * 外业队采样本管：记管号、所属样带、采样覆盖长度与暂定属名、白化等级。
 * 归并属名以实验室鉴定为准；尚未出鉴定 / 鉴定失败的管子先按暂定属名计入并明确标注。
 * 支持批量粘贴与批量改白化等级，深链访问时样带不存在给出友好空态。
 * 复用 <BleachTag>、<StatBadge>。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, DocumentCopy, Edit, Plus } from '@element-plus/icons-vue'
import BleachTag from '@/components/common/BleachTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import RouteMissingPanel from '@/components/common/RouteMissingPanel.vue'
import { useReefStore } from '@/stores/reefStore'
import { useBeltStore } from '@/stores/beltStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useLabStore } from '@/stores/labStore'
import { BLEACH_LEVELS, COMMON_GENERA, CORAL_FORMS } from '@/types/coralRecord'
import type { BleachLevel, CoralForm } from '@/types/coralRecord'
import { parseSamplePaste } from '@/types/identification'
import {
  BLEACH_BG,
  BLEACH_COLOR,
  bleachGrade,
  bleachIndex,
  bleachedSharePct,
  coralCoveragePct,
  groupByForm
} from '@/utils/bleach'
import { groupResolvedByGenus } from '@/utils/reconcile'
import { initDatabase } from '@/utils/db'
import type { ResolvedSample } from '@/utils/reconcile'

const route = useRoute()
const router = useRouter()
const reefStore = useReefStore()
const beltStore = useBeltStore()
const surveyStore = useSurveyStore()
const labStore = useLabStore()

const beltId = computed(() => String(route.params.id ?? ''))
const belt = computed(() => beltStore.beltById(beltId.value))
const site = computed(() => (belt.value ? reefStore.siteById(belt.value.siteId) : null))
const reef = computed(() => (site.value ? reefStore.reefById(site.value.reefId) : null))

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const pasteVisible = ref(false)
const pasteText = ref('')
const pasteErrors = ref<string[]>([])
const selectedIds = ref<string[]>([])
const form = reactive({
  tubeNo: '',
  fieldGenus: '',
  form: '枝状' as CoralForm,
  coverCm: 100,
  bleachLevel: '无' as BleachLevel,
  collector: '',
  remark: ''
})

/** 该样带的样本管对账行（有效属名口径） */
const rows = computed(() =>
  labStore.resolvedOfBelt(beltId.value).sort((a, b) => a.tubeNo.localeCompare(b.tubeNo, 'zh-Hans-CN'))
)

/** 按有效属名分组汇总（已鉴定按实验室属名，暂定按外业属名） */
const genusGroups = computed(() =>
  groupResolvedByGenus(rows.value).map((group) => {
    const list = rows.value.filter((row) => row.effectiveGenus === group.genus)
    const index = bleachIndex(list)
    return { ...group, bleachIndex: index, grade: bleachGrade(index) }
  })
)

const formGroups = computed(() => groupByForm(rows.value))

const stats = computed(() => {
  const list = rows.value
  const coverCmTotal = list.reduce((sum, row) => sum + row.coverCm, 0)
  const index = bleachIndex(list)
  return {
    sampleCount: list.length,
    pendingCount: list.filter((row) => row.resolveStatus === '待鉴定').length,
    failedCount: list.filter((row) => row.resolveStatus === '鉴定失败').length,
    changedCount: list.filter((row) => row.genusChanged).length,
    provisionalCount: list.filter((row) => row.provisional).length,
    coverCmTotal,
    coveragePct: belt.value ? coralCoveragePct(coverCmTotal, belt.value.lengthM) : 0,
    bleachIndex: index,
    grade: bleachGrade(index),
    bleachedSharePct: bleachedSharePct(list),
    maxCoverCm: list.length ? Math.max(...list.map((row) => row.coverCm)) : 0
  }
})

const distribution = computed<Record<BleachLevel, number>>(() => {
  const result: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
  BLEACH_LEVELS.forEach((level) => {
    result[level] = rows.value
      .filter((row) => row.bleachLevel === level)
      .reduce((sum, row) => sum + row.coverCm, 0)
  })
  return result
})

function barPercent(value: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '0%'
  return `${Math.min(100, (value / total) * 100).toFixed(1)}%`
}

function openCreate(): void {
  editingId.value = null
  form.tubeNo = labStore.suggestTubeNo(beltId.value)
  form.fieldGenus = ''
  form.form = '枝状'
  form.coverCm = 100
  form.bleachLevel = '无'
  form.collector = belt.value?.observer ?? rows.value[0]?.collector ?? ''
  form.remark = ''
  dialogVisible.value = true
}

function openEdit(row: ResolvedSample): void {
  editingId.value = row.id
  form.tubeNo = row.tubeNo
  form.fieldGenus = row.fieldGenus
  form.form = row.form
  form.coverCm = row.coverCm
  form.bleachLevel = row.bleachLevel
  form.collector = row.collector
  form.remark = row.remark
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.tubeNo.trim()) {
    ElMessage.warning('请填写管号')
    return
  }
  if (labStore.tubeNoExists(form.tubeNo, editingId.value ?? undefined)) {
    ElMessage.warning(`管号「${form.tubeNo.trim()}」已存在，管号是两边对账主键，不能重复`)
    return
  }
  if (!form.fieldGenus.trim()) {
    ElMessage.warning('请填写外业暂定属名')
    return
  }
  if (!Number.isFinite(form.coverCm) || form.coverCm < 0) {
    ElMessage.warning('覆盖长度应为非负数字（cm）')
    return
  }
  if (belt.value && form.coverCm > belt.value.lengthM * 100) {
    ElMessage.warning(`覆盖长度不应超过样带长度（${belt.value.lengthM * 100} cm）`)
    return
  }
  submitting.value = true
  try {
    const payload = {
      tubeNo: form.tubeNo.trim(),
      fieldGenus: form.fieldGenus.trim(),
      form: form.form,
      coverCm: form.coverCm,
      bleachLevel: form.bleachLevel,
      collector: form.collector.trim(),
      remark: form.remark.trim()
    }
    if (editingId.value) {
      await labStore.updateSample(editingId.value, payload)
      ElMessage.success('样本管已更新')
    } else {
      await labStore.createSample(beltId.value, payload)
      ElMessage.success('样本管已登记，待实验室按管号回填鉴定属名')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeRecord(row: ResolvedSample): Promise<void> {
  const idents = labStore.identificationsOfTube(row.tubeNo)
  try {
    await ElMessageBox.confirm(
      `删除样本管「${row.tubeNo}」？${idents.length > 0 ? `该管号已有 ${idents.length} 条实验室鉴定，删管后鉴定会留到实验室对账页的「对不上」列表等核对。` : ''}`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await labStore.removeSample(row.id)
  selectedIds.value = selectedIds.value.filter((id) => id !== row.id)
  ElMessage.success('样本管已删除')
}

function toggleSelect(id: string): void {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id]
}

function toggleSelectAll(): void {
  selectedIds.value =
    selectedIds.value.length === rows.value.length ? [] : rows.value.map((row) => row.id)
}

async function bulkSetLevel(level: BleachLevel): Promise<void> {
  if (selectedIds.value.length === 0) {
    ElMessage.warning('请先勾选要批量改级的样本管')
    return
  }
  const count = await labStore.bulkSetBleachLevel(selectedIds.value, level)
  ElMessage.success(`已批量将 ${count} 个样本管的白化等级改为「${level}」`)
  selectedIds.value = []
}

function openPaste(): void {
  pasteText.value = ''
  pasteErrors.value = []
  pasteVisible.value = true
}

function previewPaste(): void {
  const parsed = parseSamplePaste(pasteText.value)
  pasteErrors.value = parsed.errors
  if (parsed.rows.length === 0 && parsed.errors.length === 0) {
    ElMessage.warning('请先粘贴内容，每行格式「管号,暂定属名,形态,覆盖长度[,白化等级]」')
  }
}

async function importPaste(): Promise<void> {
  const parsed = parseSamplePaste(pasteText.value)
  pasteErrors.value = parsed.errors
  if (parsed.rows.length === 0) {
    ElMessage.warning('没有可导入的有效行')
    return
  }
  const duplicated = parsed.rows.filter((row) => labStore.tubeNoExists(row.tubeNo))
  if (duplicated.length > 0) {
    ElMessage.warning(`管号 ${duplicated.slice(0, 3).map((row) => row.tubeNo).join('、')} 等已存在，不能重复采集`)
    return
  }
  try {
    await ElMessageBox.confirm(
      `将用 ${parsed.rows.length} 行数据覆盖该样带现有 ${rows.value.length} 个样本管，确认导入？`,
      '批量导入确认',
      { type: 'warning', confirmButtonText: '覆盖导入', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const count = await labStore.importSampleRows(beltId.value, parsed.rows, belt.value?.observer ?? '')
  pasteVisible.value = false
  ElMessage.success(`已导入 ${count} 个样本管`)
}

function gotoFishes(): void {
  void router.push(`/belts/${beltId.value}/fishes`)
}

function gotoLab(): void {
  void router.push({ path: '/lab', query: { belt: beltId.value } })
}

onMounted(() => {
  if (reefStore.reefs.length === 0) void initDatabase()
  if (belt.value) beltStore.selectBelt(belt.value.id)
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <el-skeleton v-if="!beltStore.ready" :rows="5" animated />

    <RouteMissingPanel
      v-else-if="!belt"
      entity-label="样带"
      :missing-id="beltId"
      fallback-path="/reefs"
      fallback-text="返回礁区台账"
      :candidates="
        beltStore.belts.slice(0, 3).map((item) => ({
          id: item.id,
          label: `样带 ${item.no} 的采样`,
          path: `/belts/${item.id}/corals`
        }))
      "
    />

    <template v-else>
      <div class="page__head">
        <div>
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/reefs' }">礁区台账</el-breadcrumb-item>
            <el-breadcrumb-item v-if="reef" :to="{ path: `/reefs/${reef.id}/sites` }">{{ reef.name }} 站位</el-breadcrumb-item>
            <el-breadcrumb-item v-if="site" :to="{ path: `/sites/${site.id}/belts` }">站位 {{ site.no }} 样带</el-breadcrumb-item>
            <el-breadcrumb-item>外业采样</el-breadcrumb-item>
          </el-breadcrumb>
          <h2 class="page__title">
            样带 {{ belt.no }} · 外业采样（样本管）
            <el-tag size="small" effect="plain">{{ belt.orientation }}向</el-tag>
            <el-tag size="small" type="info" effect="plain">长 {{ belt.lengthM }} m</el-tag>
            <el-tag size="small" type="info" effect="plain">{{ belt.surveyDate }}</el-tag>
          </h2>
          <p class="gb-hint">
            外业下水按管号采样，记暂定属名、形态与覆盖长度；覆盖率 / 白化指数按实验室鉴定属名归并，
            <strong>未出鉴定或鉴定失败的管子先按暂定属名计入并打「暂定」标</strong>，鉴定失败只在实验室侧重试。
          </p>
        </div>
        <div class="page__actions">
          <el-button @click="gotoLab">实验室鉴定 →</el-button>
          <el-button :icon="DocumentCopy" @click="openPaste">批量粘贴</el-button>
          <el-button @click="gotoFishes">鱼类计数 →</el-button>
          <el-button type="primary" :icon="Plus" @click="openCreate">新增样本管</el-button>
        </div>
      </div>

      <div class="gb-stats-row">
        <StatBadge label="样本管" :value="stats.sampleCount" suffix="管" icon="Histogram" />
        <StatBadge label="待鉴定" :value="stats.pendingCount" suffix="管" tone="info" icon="Clock" />
        <StatBadge label="鉴定失败" :value="stats.failedCount" suffix="管" tone="warning" icon="WarningFilled" />
        <StatBadge label="覆盖长度合计" :value="stats.coverCmTotal" suffix="cm" tone="success" icon="Odometer" />
        <StatBadge label="珊瑚覆盖率" :value="stats.coveragePct" suffix="%" :percent="Math.min(100, stats.coveragePct)" icon="PieChart" />
        <StatBadge
          label="白化指数"
          :value="stats.bleachIndex"
          suffix="/ 4"
          :tone="stats.bleachIndex > 1 ? 'warning' : 'success'"
          :icon="stats.bleachIndex > 1 ? 'WarningFilled' : 'DataLine'"
        />
        <StatBadge label="白化占比" :value="stats.bleachedSharePct" suffix="%" tone="warning" icon="TrendCharts" />
      </div>

      <el-alert
        v-if="stats.provisionalCount > 0"
        type="info"
        show-icon
        :closable="false"
        :title="`当前 ${stats.provisionalCount} 个管子尚无成功鉴定，已按外业暂定属名计入覆盖率并在表中标「暂定」；其中待鉴定 ${stats.pendingCount} 管、鉴定失败 ${stats.failedCount} 管，鉴定回来后自动改按实验室属名归并。`"
      />

      <el-card v-if="rows.length > 0" shadow="never" class="gb-panel">
        <div class="gb-panel-title">
          <h3>汇总视图</h3>
          <div class="page__bulk">
            <span class="gb-hint">批量改白化等级：</span>
            <el-button v-for="level in BLEACH_LEVELS" :key="level" size="small" @click="bulkSetLevel(level)">
              {{ level }}
            </el-button>
          </div>
        </div>
        <div class="page__grid">
          <div>
            <h4 class="page__sub">按归并属名分组（有效口径，覆盖长度 cm）</h4>
            <div class="gb-bars">
              <div v-for="group in genusGroups" :key="group.genus" class="gb-bar">
                <span>{{ group.genus }}</span>
                <span class="gb-bar__track">
                  <span
                    class="gb-bar__fill"
                    :style="{ background: '#0b5d5a', width: barPercent(group.coverCm, stats.coverCmTotal) }"
                  ></span>
                </span>
                <span class="gb-mono">
                  {{ group.coverCm }} cm · {{ group.count }} 管
                  <el-tag v-if="group.provisionalCount > 0" size="small" type="warning" effect="plain">
                    暂定 {{ group.provisionalCount }}
                  </el-tag>
                  <BleachTag :level="group.grade" size="small" :plain="true" />
                </span>
              </div>
            </div>
          </div>
          <div>
            <h4 class="page__sub">按形态分组（覆盖长度 cm）</h4>
            <div class="gb-bars">
              <div v-for="group in formGroups" :key="group.form" class="gb-bar">
                <span>{{ group.form }}</span>
                <span class="gb-bar__track">
                  <span
                    class="gb-bar__fill"
                    :style="{ background: '#3f9ec4', width: barPercent(group.coverCm, stats.coverCmTotal) }"
                  ></span>
                </span>
                <span class="gb-mono">{{ group.coverCm }} cm</span>
              </div>
            </div>
          </div>
          <div>
            <h4 class="page__sub">白化等级分布（覆盖长度 cm）</h4>
            <div class="gb-bars">
              <div v-for="level in BLEACH_LEVELS" :key="`bar-${level}`" class="gb-bar">
                <span>{{ level }}</span>
                <span class="gb-bar__track">
                  <span
                    class="gb-bar__fill"
                    :style="{ background: BLEACH_COLOR[level], width: barPercent(distribution[level], stats.coverCmTotal) }"
                  ></span>
                </span>
                <span class="gb-mono">{{ distribution[level] }} cm</span>
              </div>
            </div>
          </div>
        </div>
      </el-card>

      <EmptyPanel
        v-if="rows.length === 0"
        title="该样带还没有样本管"
        description="下水采样时按管号登记暂定属名、形态与覆盖长度；鉴定结果回来后在实验室页按管号回填，覆盖率自动按实验室属名归并。"
        action-text="新增样本管"
        secondary-text="批量粘贴导入"
        @action="openCreate"
        @secondary="openPaste"
      />

      <el-table v-else :data="rows" border stripe class="gb-table-compact">
        <el-table-column label="选择" width="60" align="center">
          <template #default="{ row }">
            <el-checkbox :model-value="selectedIds.includes(row.id)" @change="() => toggleSelect(row.id)" />
          </template>
        </el-table-column>
        <el-table-column label="管号" width="120">
          <template #default="{ row }">
            <span class="gb-mono"><strong>{{ row.tubeNo }}</strong></span>
          </template>
        </el-table-column>
        <el-table-column label="鉴定状态" width="170">
          <template #default="{ row }">
            <el-tag v-if="row.resolveStatus === '已鉴定'" size="small" type="success" effect="plain">已鉴定</el-tag>
            <el-tag v-else-if="row.resolveStatus === '待鉴定'" size="small" type="info" effect="plain">待鉴定·暂定</el-tag>
            <el-tag v-else size="small" type="danger" effect="plain">鉴定失败·暂定</el-tag>
            <div v-if="row.genusChanged" class="gb-hint">实验室已更正属名</div>
            <div v-else-if="row.batchNo" class="gb-hint gb-mono">批次 {{ row.batchNo }}</div>
          </template>
        </el-table-column>
        <el-table-column label="外业暂定属名" min-width="130">
          <template #default="{ row }">
            <span>{{ row.fieldGenus }}</span>
            <div class="gb-hint">{{ row.form }} · {{ row.collector || '采样人未填' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="实验室鉴定属名" min-width="150">
          <template #default="{ row }">
            <template v-if="row.labGenus">
              <strong>{{ row.labGenus }}</strong>
              <div class="gb-hint gb-mono">
                置信度 {{ row.confidence !== null ? row.confidence.toFixed(2) : '—' }} · {{ row.identifier || '鉴定人未填' }}
              </div>
            </template>
            <span v-else class="gb-hint">
              {{ row.resolveStatus === '鉴定失败' ? `鉴定失败（${row.batchNo ?? '—'}），重试中` : '结果未回，按左列暂定属名计入' }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="覆盖长度 (cm)" width="130" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.coverCm }}</span>
            <div class="gb-hint gb-mono">
              占样带 {{ belt.lengthM > 0 ? ((row.coverCm / (belt.lengthM * 100)) * 100).toFixed(1) : '0.0' }}%
            </div>
          </template>
        </el-table-column>
        <el-table-column label="白化等级" width="140">
          <template #default="{ row }">
            <BleachTag :level="row.bleachLevel" size="small" :plain="true" />
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="150" show-overflow-tooltip />
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="Edit" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeRecord(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyPanel title="暂无样本管" description="点击右上角「新增样本管」开始采样登记。" compact />
        </template>
      </el-table>

      <p v-if="rows.length > 0" class="gb-hint">
        <el-button size="small" text type="primary" @click="toggleSelectAll">
          {{ selectedIds.length === rows.length ? '取消全选' : '全选本页' }}
        </el-button>
        已选 {{ selectedIds.length }} 管；最大单管覆盖长度 {{ stats.maxCoverCm }} cm；被实验室更正属名 {{ stats.changedCount }} 管。
      </p>
    </template>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑样本管' : '新增样本管（外业采样）'" width="560px" :close-on-click-modal="false">
      <el-form label-width="110px">
        <el-form-item label="管号" required>
          <el-input v-model="form.tubeNo" placeholder="如：QL01-A05，管号是两边对账主键" maxlength="30" />
        </el-form-item>
        <el-form-item label="暂定属名" required>
          <el-input v-model="form.fieldGenus" list="genus-options" placeholder="外业现场暂定，如：鹿角珊瑚属" maxlength="30" />
          <datalist id="genus-options">
            <option v-for="genus in COMMON_GENERA" :key="genus" :value="genus"></option>
          </datalist>
        </el-form-item>
        <el-form-item label="形态" required>
          <el-radio-group v-model="form.form">
            <el-radio-button v-for="item in CORAL_FORMS" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="覆盖长度" required>
          <el-input-number v-model="form.coverCm" :min="0" :max="belt ? belt.lengthM * 100 : 10000" :step="10" controls-position="right" />
          <span class="page__unit">cm（样带全长 {{ belt ? belt.lengthM * 100 : 0 }} cm）</span>
        </el-form-item>
        <el-form-item label="白化等级" required>
          <el-radio-group v-model="form.bleachLevel">
            <el-radio-button v-for="level in BLEACH_LEVELS" :key="level" :value="level">{{ level }}</el-radio-button>
          </el-radio-group>
          <div class="page__legend">
            <span
              v-for="level in BLEACH_LEVELS"
              :key="`legend-${level}`"
              class="page__legend-item"
              :style="{ background: BLEACH_BG[level], color: BLEACH_COLOR[level], borderColor: BLEACH_COLOR[level] }"
            >
              {{ level }}
            </span>
          </div>
        </el-form-item>
        <el-form-item label="采样人">
          <el-input v-model="form.collector" placeholder="如：林之遥" maxlength="20" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" placeholder="如：局部褪色 / 台风扰动后白化" maxlength="60" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '登记样本管' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="pasteVisible" title="批量粘贴导入样本管" width="640px">
      <p class="gb-hint">
        每行一管，格式「管号,暂定属名,形态,覆盖长度(cm)[,白化等级]」，逗号 / 制表符 / 分号均可。示例：<br />
        <span class="gb-mono">QL01-A05,鹿角珊瑚属,枝状,860,无</span><br />
        <span class="gb-mono">QL01-A06;蔷薇珊瑚属;叶状;720;中</span><br />
        <span class="gb-mono">QL01-A07,滨珊瑚属,块状,1120</span>
      </p>
      <el-input v-model="pasteText" type="textarea" :rows="8" placeholder="QL01-A05,鹿角珊瑚属,枝状,860,无" />
      <div v-if="pasteErrors.length > 0" class="page__errors">
        <el-alert v-for="(error, index) in pasteErrors" :key="index" type="warning" :title="error" :closable="false" show-icon />
      </div>
      <template #footer>
        <el-button @click="pasteVisible = false">取消</el-button>
        <el-button @click="previewPaste">解析预览</el-button>
        <el-button type="primary" @click="importPaste">覆盖导入</el-button>
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
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0 4px;
  font-size: 18px;
  color: #0b5d5a;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
}

.page__sub {
  margin: 0 0 8px;
  font-size: 13px;
  color: #4c6663;
}

.page__bulk {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #7c9995;
}

.page__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.page__legend-item {
  padding: 1px 8px;
  border: 1px solid;
  border-radius: 999px;
  font-size: 11px;
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
