/**
 * 样本管（外业采集层）
 * 外业队下水采样时按管编号，记管号、所属样带与采样覆盖长度及暂定属名；
 * 实验室鉴定结果挂在 identifications 表，按管号对账，不改外业采集记录。
 */
import type { BleachLevel, CoralForm } from '@/types/coralRecord'

/** 样本管：外业采集的一管珊瑚样品 */
export interface CoralSample {
  id: string
  /** 管号（外业管壁编号，全局唯一，两边对账主键） */
  tubeNo: string
  /** 所属样带 */
  beltId: string
  /** 外业暂定属名，如 鹿角珊瑚属；鉴定未回前汇总暂按此归并 */
  fieldGenus: string
  /** 形态 */
  form: CoralForm
  /** 采样覆盖长度（cm） */
  coverCm: number
  /** 白化等级 */
  bleachLevel: BleachLevel
  /** 采样人 */
  collector: string
  /** 备注（病敌害、断枝等） */
  remark: string
  createdAt: number
  updatedAt: number
}

/** 样本管草稿（珊瑚采样页表单） */
export interface SampleDraft {
  tubeNo: string
  fieldGenus: string
  form: CoralForm
  coverCm: number
  bleachLevel: BleachLevel
  collector: string
  remark: string
}

export function createEmptySampleDraft(tubeNo = '', collector = ''): SampleDraft {
  return {
    tubeNo,
    fieldGenus: '',
    form: '枝状',
    coverCm: 100,
    bleachLevel: '无',
    collector,
    remark: ''
  }
}

/** 批量粘贴解析出的一行样本管 */
export interface SamplePasteRow {
  tubeNo: string
  fieldGenus: string
  form: CoralForm
  coverCm: number
  bleachLevel: BleachLevel
}
