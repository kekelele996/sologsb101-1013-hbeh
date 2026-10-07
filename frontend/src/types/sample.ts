/**
 * 外业采样管（样本层）：
 * 外业队下水时按管采集，一管记录管号、所属样带、暂定属名、形态、采样覆盖长度与白化等级。
 * 实验室鉴定结果在 identifications 表中按管号对账，采样管本身不随鉴定重试改动。
 */
import { BLEACH_LEVELS, CORAL_FORMS, type BleachLevel, type CoralForm } from '@/types/coralRecord'

/** 外业采样管 */
export interface CoralSample {
  id: string
  /** 采样管管号（外业手写管号，全局唯一，两边对账主键） */
  tubeNo: string
  /** 所属样带 */
  beltId: string
  /** 外业暂定属名（实验室鉴定回来前按此计入并标暂定） */
  provisionalGenus: string
  /** 形态 */
  form: CoralForm
  /** 采样覆盖长度（cm） */
  coverCm: number
  /** 白化等级（外业现场判定） */
  bleachLevel: BleachLevel
  /** 采样备注（病敌害、断枝等；旧数据补管时写迁移来源） */
  remark: string
  createdAt: number
  updatedAt: number
}

/** 采样管草稿（存于 surveyStore） */
export interface SampleDraft {
  tubeNo: string
  provisionalGenus: string
  form: CoralForm
  coverCm: number
  bleachLevel: BleachLevel
  remark: string
}

export function createEmptySampleDraft(tubeNo = ''): SampleDraft {
  return {
    tubeNo,
    provisionalGenus: '',
    form: '枝状',
    coverCm: 100,
    bleachLevel: '无',
    remark: ''
  }
}

/** 批量粘贴解析出的一行采样管 */
export interface SamplePasteRow {
  tubeNo: string
  provisionalGenus: string
  form: CoralForm
  coverCm: number
  bleachLevel: BleachLevel
}

/**
 * 解析批量粘贴文本：每行「管号,暂定属名,形态,覆盖长度[,白化等级]」。
 * 逗号 / 制表符 / 分号可作分隔（属名常含空格，不用空格定界）。
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
    const form = cells[2] as CoralForm
    if (!CORAL_FORMS.includes(form)) {
      errors.push(`第 ${index + 1} 行形态「${cells[2]}」不在 ${CORAL_FORMS.join(' / ')} 之内`)
      return
    }
    const coverCm = Number(cells[3])
    if (!Number.isFinite(coverCm) || coverCm < 0) {
      errors.push(`第 ${index + 1} 行覆盖长度应为非负数字（cm）`)
      return
    }
    const bleachLevel = (cells.length >= 5 ? cells[4] : '无') as BleachLevel
    if (!BLEACH_LEVELS.includes(bleachLevel)) {
      errors.push(`第 ${index + 1} 行白化等级「${cells[4]}」不在 ${BLEACH_LEVELS.join(' / ')} 之内`)
      return
    }
    rows.push({
      tubeNo: cells[0],
      provisionalGenus: cells[1],
      form,
      coverCm: Number(coverCm.toFixed(1)),
      bleachLevel
    })
  })
  return { rows, errors }
}
