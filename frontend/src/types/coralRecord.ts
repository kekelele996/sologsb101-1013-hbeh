/** 珊瑚形态 */
export type CoralForm = '枝状' | '块状' | '叶状' | '软珊瑚'

export const CORAL_FORMS: CoralForm[] = ['枝状', '块状', '叶状', '软珊瑚']

/** 白化等级 */
export type BleachLevel = '无' | '轻' | '中' | '重' | '死亡'

export const BLEACH_LEVELS: BleachLevel[] = ['无', '轻', '中', '重', '死亡']

/**
 * 旧版珊瑚记录（v2 及更早）。
 * v3 起采样拆成外业样本管（CoralSample）+ 实验室鉴定（CoralIdentification），
 * 本类型仅用于读取 v2 旧备份 / 升级迁移，业务代码不要再写入。
 */
export interface CoralRecord {
  id: string
  /** 所属样带 */
  beltId: string
  /** 属名（旧里外业自定，鉴定对不上的根源） */
  genus: string
  /** 形态 */
  form: CoralForm
  /** 覆盖长度（cm） */
  coverCm: number
  /** 白化等级 */
  bleachLevel: BleachLevel
  /** 备注（病敌害、断枝等） */
  remark: string
  createdAt: number
  updatedAt: number
}

/** 常见属名（表单联想用） */
export const COMMON_GENERA: string[] = [
  '鹿角珊瑚属',
  '杯形珊瑚属',
  '滨珊瑚属',
  '蜂巢珊瑚属',
  '蔷薇珊瑚属',
  '陀螺珊瑚属',
  '石芝珊瑚属',
  '软珊瑚属',
  '柳珊瑚属',
  '星珊瑚属'
]
