<script setup lang="ts">
/**
 * 模块 4：/belts/:id/samples 外业采样管录入
 * 外业队按管采样：记管号、所属样带、暂定属名、形态、采样覆盖长度与白化等级。
 * 汇总视图的属名一律按实验室鉴定口径归并（成功鉴定属名优先，否则暂定并标注）。
 * 支持批量粘贴与批量改白化等级；深链访问时样带不存在给出友好空态。
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
import type { CoralSample } from '@/types/sample'
import { parseSamplePaste } from '@/types/sample'
import {
  BLEACH_BG,
  BLEACH_COLOR,
  bleachGrade,
  bleachIndex,
  bleachedSharePct,
  coralCoveragePct,
  groupByForm,
  round
} from '@/utils/bleach'
import { initDatabase } from '@/utils/db'
import type { EffectiveCoralRecord } from '@/utils/reconcile'

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
  provisionalGenus: '',
  form: '枝状' as CoralForm,
  coverCm: 100,
  bleachLevel: '无' as BleachLevel,
  remark: ''
})

const samples = computed(() => surveyStore.samplesOfBelt(beltId.value))
const effectiveCorals = computed<EffectiveCoralRecord[]>(() => surveyStore.effectiveCoralsOfBelt(beltId.value))
const byTube = computed(() => surveyStore.reconciliation.byTube)

/** 表格行：采样管 + 实验室归并结果 */
const rows = computed(() =>
  samples.value.map((sample) => {
    const resolved = byTube.value.get(sample.tubeNo)
    return {
      sample,
      effectiveGenus: resolved?.effectiveGenus ?? sample.provisionalGenus,
      genusSource: resolved?.genusSource ?? '暂定',
      latest: resolved?.latest ?? null,
      confirmed: resolved?.confirmed ?? null,
      attemptCount: resolved?.attemptCount ?? 0
    }
  })
)

/** 按实验室有效属名分组汇总（暂定覆盖单列） */
const genusGroups = computed(() => {
  const map = new Map<string, { coverCm: number; provisionalCoverCm: number; tubes: number }>()
  effectiveCorals.value.forEach((coral) => {
    const bucket = map.get(coral.genus) ?? { coverCm: 0, provisionalCoverCm: 0, tubes: 0 }
    bucket.coverCm += coral.coverCm
    bucket.tubes += 1
    if (coral.genusSource === '暂定') bucket.provisionalCoverCm += coral.coverCm
    map.set(coral.genus, bucket)
  })
  const listForIndex = effectiveCorals.value
  return Array.from(map.entries())
    .map(([genus, value]) => {
      const inGenus = listForIndex.filter((coral) => coral.genus === genus)
      const index = bleachIndex(inGenus)
      return {
        genus,
        coverCm: round(value.coverCm, 1),
        provisionalCoverCm: round(value.provisionalCoverCm, 1),
        tubes: value.tubes,
        bleachIndex: index,
        grade: bleachGrade(index)
      }
    })
    .sort((a, b) => b.coverCm - a.coverCm)
})

const formGroups = computed(() => groupByForm(effectiveCorals.value))

const stats = computed(() => {
  const list = effectiveCorals.value
  const coverCmTotal = list.reduce((sum, coral) => sum + coral.coverCm, 0)
  const provisionalCoverCm = list
    .filter((coral) => coral.genusSource === '暂定')
    .reduce((sum, coral) => sum + coral.coverCm, 0)
  const provisionalTubes = new Set(
    list.filter((coral) => coral.genusSource === '暂定').map((coral) => coral.tubeNo)
  )
  const index = bleachIndex(list)
  return {
    sampleCount: samples.value.length,
    confirmedCount: samples.value.length - provisionalTubes.size,
    provisionalCount: provisionalTubes.size,
    coverCmTotal,
    provisionalCoverCm: round(provisionalCoverCm, 1),
    coveragePct: belt.value ? coralCoveragePct(coverCmTotal, belt.value.lengthM) : 0,
    bleachIndex: index,
    grade: bleachGrade(index),
    bleachedSharePct: bleachedSharePct(list),
    maxCoverCm: samples.value.length ? Math.max(...samples.value.map((sample) => sample.coverCm)) : 0
  }
})

const distribution = computed<Record<BleachLevel, number>>(() => {
  const result: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
  BLEACH_LEVELS.forEach((level) => {
    result[level] = effectiveCorals.value
      .filter((coral) => coral.bleachLevel === level)
      .reduce((sum, coral) => sum + coral.coverCm, 0)
  })
  return result
})

function barPercent(value: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '0%'
  return `${Math.min(100, (value / total) * 100).toFixed(1)}%`
}

function openCreate(): void {
  editingId.value = null
  form.tubeNo = nextTubeNo()
  form.provisionalGenus = ''
  form.form = '枝状'
  form.coverCm = 100
  form.bleachLevel = '无'
  form.remark = ''
  dialogVisible.value = true
}

/** 生成下一个建议管号：样带序号 + 两位流水号 */
function nextTubeNo(): string {
  if (!belt.value) return ''
  const prefix = `${reef.value?.name?.slice(0, 1) ?? 'X'}${site.value?.no.replace(/[^0-9]/g, '') ?? '0'}${belt.value.no.replace(
    /[^0-9]/g,
    ''
  )}`
  const used = new Set(samples.value.map((sample) => sample.tubeNo))
  for (let i = samples.value.length + 1; i < 100; i += 1) {
    const candidate = `${prefix}-${String(i).padStart(2, '0')}`
    if (!used.has(candidate)) return candidate
  }
  return ''
}

function openEdit(record: CoralSample): void {
  editingId.value = record.id
  form.tubeNo = record.tubeNo
  form.provisionalGenus = record.provisionalGenus
  form.form = record.form
  form.coverCm = record.coverCm
  form.bleachLevel = record.bleachLevel
  form.remark = record.remark
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.tubeNo.trim()) {
    ElMessage.warning('请填写采样管管号')
    return
  }
  if (!form.provisionalGenus.trim()) {
    ElMessage.warning('请填写外业暂定属名（实验室鉴定回来前先按此计入）')
    return
  }
  if (!Number.isFinite(form.coverCm) || form.coverCm < 0) {
    ElMessage.warning('采样覆盖长度应为非负数字（cm）')
    return
  }
  if (belt.value && form.coverCm > belt.value.lengthM * 100) {
    ElMessage.warning(`覆盖长度不应超过样带长度（${belt.value.lengthM * 100} cm）`)
    return
  }
  if (surveyStore.tubeNoExists(form.tubeNo.trim(), editingId.value)) {
    ElMessage.warning(`管号「${form.tubeNo.trim()}」已存在，管号必须全局唯一，两边按它对账`)
    return
  }
  submitting.value = true
  try {
    const payload = {
      tubeNo: form.tubeNo.trim(),
      provisionalGenus: form.provisionalGenus.trim(),
      form: form.form,
      coverCm: form.coverCm,
      bleachLevel: form.bleachLevel,
      remark: form.remark.trim()
    }
    if (editingId.value) {
      // 管号是对账主键，编辑时不允许改（改了实验室结果就对不上），只更新其余字段
      const { tubeNo: _tubeNo, ...editable } = payload
      void _tubeNo
      await surveyStore.updateSample(editingId.value, editable)
      ElMessage.success('采样管已更新')
    } else {
      await surveyStore.createSample(beltId.value, payload)
      ElMessage.success('采样管已登记，覆盖率与白化占比已重算')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeRecord(record: CoralSample): Promise<void> {
  const related = byTube.value.get(record.tubeNo)
  const warning = related?.attemptCount
    ? `该管已有 ${related.attemptCount} 条实验室鉴定记录，删管会同时删掉这些鉴定结果。`
    : ''
  try {
    await ElMessageBox.confirm(
      `删除采样管「${record.tubeNo} · ${record.provisionalGenus}（${record.form}）」覆盖 ${record.coverCm} cm 的记录？${warning}`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  // 单管删除时同步清理本管鉴定记录（实验室侧对账记录）
  if (related?.attemptCount) {
    await Promise.all(
      labStore.identifications.filter((item) => item.tubeNo === record.tubeNo).map((item) => labStore.removeIdentification(item.id))
    )
  }
  await surveyStore.removeSample(record.id)
  selectedIds.value = selectedIds.value.filter((id) => id !== record.id)
  ElMessage.success('采样管已删除')
}

function toggleSelect(id: string): void {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id]
}

function toggleSelectAll(): void {
  selectedIds.value =
    selectedIds.value.length === samples.value.length ? [] : samples.value.map((sample) => sample.id)
}

async function bulkSetLevel(level: BleachLevel): Promise<void> {
  if (selectedIds.value.length === 0) {
    ElMessage.warning('请先勾选要批量改级的采样管')
    return
  }
  const count = await surveyStore.bulkSetBleachLevel(selectedIds.value, level)
  ElMessage.success(`已批量将 ${count} 根采样管的白化等级改为「${level}」`)
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
  try {
    await ElMessageBox.confirm(
      `将用 ${parsed.rows.length} 行数据覆盖该样带现有 ${samples.value.length} 根采样管，确认导入？`,
      '批量导入确认',
      { type: 'warning', confirmButtonText: '覆盖导入', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const result = await surveyStore.importSampleRows(beltId.value, parsed.rows)
  pasteVisible.value = false
  if (result.duplicated.length > 0) {
    ElMessage.warning(`已导入 ${result.count} 根采样管；管号 ${Array.from(new Set(result.duplicated)).join('、')} 与其他管重复，请核对`)
  } else {
    ElMessage.success(`已导入 ${result.count} 根采样管`)
  }
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
          label: `样带 ${item.no} 的采样管`,
          path: `/belts/${item.id}/samples`
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
            <el-breadcrumb-item>外业采样管</el-breadcrumb-item>
          </el-breadcrumb>
          <h2 class="page__title">
            样带 {{ belt.no }} · 外业采样管登记
            <el-tag size="small" effect="plain">{{ belt.orientation }}向</el-tag>
            <el-tag size="small" type="info" effect="plain">长 {{ belt.lengthM }} m</el-tag>
            <el-tag size="small" type="info" effect="plain">{{ belt.surveyDate }}</el-tag>
          </h2>
          <p class="gb-hint">
            下水采样按管登记管号、暂定属名与采样覆盖长度；实验室鉴定回来后覆盖率按鉴定属名归并，未出鉴定的管子先按暂定属名计入并标「暂定」。
          </p>
        </div>
        <div class="page__actions">
          <el-button @click="gotoLab">实验室鉴定 / 对账 →</el-button>
          <el-button :icon="DocumentCopy" @click="openPaste">批量粘贴</el-button>
          <el-button @click="gotoFishes">鱼类计数 →</el-button>
          <el-button type="primary" :icon="Plus" @click="openCreate">新增采样管</el-button>
        </div>
      </div>

      <div class="gb-stats-row">
        <StatBadge label="采样管" :value="stats.sampleCount" suffix="管" icon="Histogram" />
        <StatBadge
          label="已鉴定 / 暂定"
          :value="`${stats.confirmedCount} / ${stats.provisionalCount}`"
          suffix="管"
          tone="info"
          icon="DataLine"
        />
        <StatBadge label="采样覆盖合计" :value="stats.coverCmTotal" suffix="cm" tone="success" icon="Odometer" />
        <StatBadge label="珊瑚覆盖率" :value="stats.coveragePct" suffix="%" :percent="Math.min(100, stats.coveragePct)" tone="success" icon="PieChart" />
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
        :closable="false"
        show-icon
        :title="`有 ${stats.provisionalCount} 根管（覆盖 ${stats.provisionalCoverCm} cm）尚未拿到实验室成功鉴定，当前按外业暂定属名计入并已标「暂定」；鉴定回来后自动改判，汇总与导出口径一致。`"
      />

      <el-card v-if="samples.length > 0" shadow="never" class="gb-panel">
        <div class="gb-panel-title">
          <h3>汇总视图（按实验室鉴定属名归并）</h3>
          <div class="page__bulk">
            <span class="gb-hint">批量改白化等级：</span>
            <el-button v-for="level in BLEACH_LEVELS" :key="level" size="small" @click="bulkSetLevel(level)">
              {{ level }}
            </el-button>
          </div>
        </div>
        <div class="page__grid">
          <div>
            <h4 class="page__sub">按有效属名分组（覆盖长度 cm）</h4>
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
                  {{ group.coverCm }} cm · {{ group.tubes }} 管
                  <el-tag v-if="group.provisionalCoverCm > 0" size="small" type="warning" effect="plain">
                    暂定 {{ group.provisionalCoverCm }} cm
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
        v-if="samples.length === 0"
        title="该样带还没有采样管"
        description="外业队下水按管登记管号、暂定属名与采样覆盖长度；也可以批量粘贴导入整段摸底数据。"
        action-text="新增采样管"
        secondary-text="批量粘贴导入"
        @action="openCreate"
        @secondary="openPaste"
      />

      <el-table v-else :data="rows" border stripe class="gb-table-compact">
        <el-table-column label="选择" width="60" align="center">
          <template #default="{ row }">
            <el-checkbox :model-value="selectedIds.includes(row.sample.id)" @change="() => toggleSelect(row.sample.id)" />
          </template>
        </el-table-column>
        <el-table-column label="管号" width="120">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.sample.tubeNo }}</span>
          </template>
        </el-table-column>
        <el-table-column label="归并属名" min-width="150">
          <template #default="{ row }">
            <span>{{ row.effectiveGenus }}</span>
            <el-tag
              v-if="row.genusSource === '暂定'"
              size="small"
              type="warning"
              effect="plain"
              style="margin-left: 6px"
            >暂定</el-tag>
            <el-tag v-else size="small" type="success" effect="plain" style="margin-left: 6px">已鉴定</el-tag>
            <div v-if="row.confirmed && row.confirmed.genus !== row.sample.provisionalGenus" class="gb-hint">
              外业暂定：{{ row.sample.provisionalGenus }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="实验室鉴定" min-width="170">
          <template #default="{ row }">
            <template v-if="row.confirmed">
              <div class="gb-mono">{{ row.confirmed.batchNo }} · 置信度 {{ row.confirmed.confidence }}%</div>
              <div class="gb-hint">{{ row.confirmed.identifier }} · {{ row.confirmed.identifiedAt }}</div>
            </template>
            <el-tag v-else-if="row.latest?.status === '失败'" size="small" type="danger" effect="plain">
              鉴定失败 ×{{ row.attemptCount }}，待实验室重试
            </el-tag>
            <el-tag v-else size="small" type="info" effect="plain">待鉴定</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="sample.form" label="形态" width="90" />
        <el-table-column label="覆盖长度 (cm)" width="130" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.sample.coverCm }}</span>
            <div class="gb-hint gb-mono">
              占样带 {{ belt.lengthM > 0 ? ((row.sample.coverCm / (belt.lengthM * 100)) * 100).toFixed(1) : '0.0' }}%
            </div>
          </template>
        </el-table-column>
        <el-table-column label="白化等级" width="150">
          <template #default="{ row }">
            <BleachTag :level="row.sample.bleachLevel" size="small" :plain="true" />
          </template>
        </el-table-column>
        <el-table-column prop="sample.remark" label="备注" min-width="150" show-overflow-tooltip />
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="Edit" @click="openEdit(row.sample)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeRecord(row.sample)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyPanel title="暂无采样管" description="点击右上角「新增采样管」开始登记。" compact />
        </template>
      </el-table>

      <p v-if="samples.length > 0" class="gb-hint">
        <el-button size="small" text type="primary" @click="toggleSelectAll">
          {{ selectedIds.length === samples.length ? '取消全选' : '全选本页' }}
        </el-button>
        已选 {{ selectedIds.length }} 根；最大单管覆盖长度 {{ stats.maxCoverCm }} cm；管号是与实验室对账的唯一主键，登记后不可修改。
      </p>
    </template>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑采样管' : '新增采样管'" width="560px" :close-on-click-modal="false">
      <el-form label-width="120px">
        <el-form-item label="管号" required>
          <el-input
            v-model="form.tubeNo"
            placeholder="如：QL01A-01"
            maxlength="30"
            :disabled="!!editingId"
          />
          <div class="gb-hint">外业手写管号，全局唯一；实验室按此管号回鉴定结果</div>
        </el-form-item>
        <el-form-item label="暂定属名" required>
          <el-input v-model="form.provisionalGenus" list="genus-options" placeholder="如：鹿角珊瑚属" maxlength="30" />
          <datalist id="genus-options">
            <option v-for="genus in COMMON_GENERA" :key="genus" :value="genus"></option>
          </datalist>
        </el-form-item>
        <el-form-item label="形态" required>
          <el-radio-group v-model="form.form">
            <el-radio-button v-for="item in CORAL_FORMS" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="采样覆盖长度" required>
          <el-input-number v-model="form.coverCm" :min="0" :max="belt ? belt.lengthM * 100 : 10000" :step="10" controls-position="right" />
          <span class="page__unit">cm（样带全长 {{ belt ? belt.lengthM * 100 : 0 }} cm）</span>
        </el-form-item>
        <el-form-item label="白化等级" required>
          <el-radio-group v-model="form.bleachLevel">
            <el-radio-button v-for="level in BLEACH_LEVELS" :key="level" :value="level">
              {{ level }}
            </el-radio-button>
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
        <el-form-item label="备注">
          <el-input v-model="form.remark" placeholder="如：局部褪色 / 台风扰动后白化" maxlength="60" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '登记采样管' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="pasteVisible" title="批量粘贴导入采样管" width="640px">
      <p class="gb-hint">
        每行一管，格式「管号,暂定属名,形态,覆盖长度(cm)[,白化等级]」，逗号 / 制表符 / 分号均可。示例：<br />
        <span class="gb-mono">QL01A-01,鹿角珊瑚属,枝状,860,无</span><br />
        <span class="gb-mono">QL01A-02;杯形珊瑚属;枝状;540;轻</span><br />
        <span class="gb-mono">QL01A-03,滨珊瑚属,块状,1120</span>
      </p>
      <el-input v-model="pasteText" type="textarea" :rows="8" placeholder="QL01A-01,鹿角珊瑚属,枝状,860,无" />
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
