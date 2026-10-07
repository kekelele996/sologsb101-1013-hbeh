/**
 * 实验室分子鉴定结果（样本层）：
 * 实验室按测序批次对采样管出鉴定属名、置信度与鉴定人；鉴定失败只在本侧重试，
 * 即追加新的鉴定记录，外业采样管（samples）不改动。
 */

/** 鉴定结果状态 */
export type IdStatus = '成功' | '失败'

export const ID_STATUSES: IdStatus[] = ['成功', '失败']

/** 一条实验室鉴定记录（一管可重试多条） */
export interface Identification {
  id: string
  /** 采样管管号（对账主键，与外业 samples.tubeNo 对齐） */
  tubeNo: string
  /** 测序批次号，如 SEQ-2026-09 */
  batchNo: string
  /** 鉴定结果：成功 / 失败 */
  status: IdStatus
  /** 鉴定属名（status=失败 时留空） */
  genus: string
  /** 置信度（0 ~ 100，百分比） */
  confidence: number
  /** 鉴定人 */
  identifier: string
  /** 备注（失败原因、引物、重试说明等） */
  note: string
  /** 鉴定日期 */
  identifiedAt: string
  createdAt: number
  updatedAt: number
}

/** 鉴定记录草稿（存于 labStore） */
export interface IdentificationDraft {
  tubeNo: string
  batchNo: string
  status: IdStatus
  genus: string
  confidence: number
  identifier: string
  note: string
  identifiedAt: string
}

export function createEmptyIdentificationDraft(tubeNo = ''): IdentificationDraft {
  return {
    tubeNo,
    batchNo: '',
    status: '成功',
    genus: '',
    confidence: 95,
    identifier: '',
    note: '',
    identifiedAt: new Date().toISOString().slice(0, 10)
  }
}

/** 批量粘贴解析出的一行鉴定结果 */
export interface IdentificationPasteRow {
  tubeNo: string
  batchNo: string
  status: IdStatus
  genus: string
  confidence: number
  identifier: string
}

/**
 * 解析批量粘贴文本：每行「管号,批次,结果,属名,置信度,鉴定人」。
 * 结果列填 成功 / 失败；失败行属名与置信度可留空。
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
    if (cells.length < 6) {
      errors.push(`第 ${index + 1} 行「${line}」需要「管号,批次,结果(成功/失败),属名,置信度,鉴定人」六列`)
      return
    }
    const status = cells[2] as IdStatus
    if (!ID_STATUSES.includes(status)) {
      errors.push(`第 ${index + 1} 行结果「${cells[2]}」应为 成功 / 失败`)
      return
    }
    if (status === '成功' && !cells[3]) {
      errors.push(`第 ${index + 1} 行鉴定成功但未填鉴定属名`)
      return
    }
    const confidence = Number(cells[4] || '0')
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
      errors.push(`第 ${index + 1} 行置信度应为 0 ~ 100 的数字`)
      return
    }
    if (!cells[5]) {
      errors.push(`第 ${index + 1} 行未填鉴定人`)
      return
    }
    rows.push({
      tubeNo: cells[0],
      batchNo: cells[1],
      status,
      genus: status === '成功' ? cells[3] : '',
      confidence: Number(confidence.toFixed(1)),
      identifier: cells[5]
    })
  })
  return { rows, errors }
}
