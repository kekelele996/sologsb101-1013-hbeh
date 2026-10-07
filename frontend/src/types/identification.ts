/**
 * 实验室鉴定层
 * 实验室按测序批次对样本管出鉴定属名、置信度与鉴定人；
 * 一行 = 某管号在某测序批次的一次鉴定（含失败重试），与外业样本管按管号对账。
 */
import { BLEACH_LEVELS, CORAL_FORMS } from '@/types/coralRecord'
import type { BleachLevel, CoralForm } from '@/types/coralRecord'
import type { SamplePasteRow } from '@/types/sample'

/** 鉴定状态：成功 / 失败（失败后只在本侧重试，外业采集不动） */
export type IdStatus = '成功' | '失败'

export const ID_STATUSES: IdStatus[] = ['成功', '失败']

/** 一条实验室鉴定记录 */
export interface CoralIdentification {
  id: string
  /** 管号（对账外业样本管，可能暂时对不上 → 孤立鉴定，等实验室补） */
  tubeNo: string
  /** 测序批次号，如 B2026-09 */
  batchNo: string
  /** 鉴定状态 */
  status: IdStatus
  /** 鉴定属名；成功时必填，失败时留空 */
  genus: string
  /** 置信度 0 ~ 1，失败时为 0 */
  confidence: number
  /** 鉴定人 */
  identifier: string
  /** 第几次鉴定（首检 1，失败重试递增） */
  attempt: number
  /** 鉴定日期 */
  identifiedAt: string
  /** 失败原因 / 备注 */
  note: string
  createdAt: number
  updatedAt: number
}

/** 鉴定录入草稿（实验室页表单） */
export interface IdentificationDraft {
  tubeNo: string
  batchNo: string
  status: IdStatus
  genus: string
  confidence: number
  identifier: string
  attempt: number
  identifiedAt: string
  note: string
}

export function createEmptyIdentificationDraft(batchNo = '', identifier = ''): IdentificationDraft {
  return {
    tubeNo: '',
    batchNo,
    status: '成功',
    genus: '',
    confidence: 0.95,
    identifier,
    attempt: 1,
    identifiedAt: new Date().toISOString().slice(0, 10),
    note: ''
  }
}

/** 批量粘贴解析出的一行鉴定 */
export interface IdentificationPasteRow {
  tubeNo: string
  batchNo: string
  status: IdStatus
  genus: string
  confidence: number
  identifier: string
}

/**
 * 解析实验室批量粘贴：每行「管号,测序批次,鉴定属名,置信度,鉴定人」。
 * 鉴定属名填「失败」或置信度 ≤ 0 时视为该批次鉴定失败。
 */
export function parseIdentificationPaste(text: string): {
  rows: IdentificationPasteRow[]
  errors: string[]
} {
  const rows: IdentificationPasteRow[] = []
  const errors: string[] = []
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  lines.forEach((line, index) => {
    const cells = line.split(/[,，\t;；]+/).map((cell) => cell.trim())
    if (cells.length < 5) {
      errors.push(`第 ${index + 1} 行「${line}」至少需要「管号,测序批次,鉴定属名,置信度,鉴定人」五列`)
      return
    }
    const [tubeNo, batchNo, genusRaw, confidenceRaw, identifier] = cells
    if (!tubeNo || !batchNo) {
      errors.push(`第 ${index + 1} 行管号与测序批次不能为空`)
      return
    }
    const failed = genusRaw === '失败' || genusRaw === '未测出' || genusRaw === '失败重试'
    const confidence = Number(confidenceRaw)
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      errors.push(`第 ${index + 1} 行置信度「${confidenceRaw}」应为 0 ~ 1 之间的小数（如 0.95）`)
      return
    }
    if (!failed && !genusRaw) {
      errors.push(`第 ${index + 1} 行鉴定属名不能为空（鉴定失败请填「失败」）`)
      return
    }
    rows.push({
      tubeNo,
      batchNo,
      status: failed ? '失败' : '成功',
      genus: failed ? '' : genusRaw,
      confidence: failed ? 0 : Number(confidence.toFixed(2)),
      identifier
    })
  })
  return { rows, errors }
}

/**
 * 解析外业批量粘贴：每行「管号,暂定属名,形态,覆盖长度[,白化等级]」。
 */
export function parseSamplePaste(text: string): { rows: SamplePasteRow[]; errors: string[] } {
  const rows: SamplePasteRow[] = []
  const errors: string[] = []
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  lines.forEach((line, index) => {
    const cells = line.split(/[,，\t;；]+/).map((cell) => cell.trim())
    if (cells.length < 4) {
      errors.push(`第 ${index + 1} 行「${line}」至少需要「管号,暂定属名,形态,覆盖长度(cm)」四列`)
      return
    }
    const [tubeNo, fieldGenus, formRaw, coverRaw] = cells
    if (!tubeNo) {
      errors.push(`第 ${index + 1} 行管号不能为空`)
      return
    }
    const form = formRaw as CoralForm
    if (!CORAL_FORMS.includes(form)) {
      errors.push(`第 ${index + 1} 行形态「${formRaw}」不在 ${CORAL_FORMS.join(' / ')} 之内`)
      return
    }
    const coverCm = Number(coverRaw)
    if (!Number.isFinite(coverCm) || coverCm < 0) {
      errors.push(`第 ${index + 1} 行覆盖长度应为非负数字（cm）`)
      return
    }
    const bleachLevel = (cells.length >= 5 ? cells[4] : '无') as BleachLevel
    if (!BLEACH_LEVELS.includes(bleachLevel)) {
      errors.push(`第 ${index + 1} 行白化等级「${cells[4]}」不在 ${BLEACH_LEVELS.join(' / ')} 之内`)
      return
    }
    rows.push({ tubeNo, fieldGenus, form, coverCm: Number(coverCm.toFixed(1)), bleachLevel })
  })
  return { rows, errors }
}
