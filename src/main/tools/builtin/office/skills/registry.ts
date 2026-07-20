import type { OfficeSkill, OfficeSkillName } from './types'

const skillIndex: Array<{
  name: OfficeSkillName
  title: string
  description: string
  extensions: string[]
}> = [
  {
    name: 'docx',
    title: 'Word 文档',
    description: '创建、检查、局部修改和验证 Word DOCX。',
    extensions: ['.docx']
  },
  {
    name: 'xlsx',
    title: 'Excel 工作簿',
    description: '创建、检查、计算结构修改和验证 Excel XLSX。',
    extensions: ['.xlsx']
  },
  {
    name: 'pdf',
    title: 'PDF 文档',
    description: '创建、检查、页面级修改和验证 PDF。',
    extensions: ['.pdf']
  },
  {
    name: 'pptx',
    title: 'PowerPoint 演示文稿',
    description: '创建、检查、文字修改和验证 PowerPoint PPTX。',
    extensions: ['.pptx']
  }
]

const loaders: Record<OfficeSkillName, () => Promise<OfficeSkill>> = {
  docx: async () => (await import('./docx')).docxSkill,
  xlsx: async () => (await import('./xlsx')).xlsxSkill,
  pdf: async () => (await import('./pdf')).pdfSkill,
  pptx: async () => (await import('./pptx')).pptxSkill
}

const loadedSkills = new Map<OfficeSkillName, OfficeSkill>()

export function listOfficeSkills(): typeof skillIndex {
  return skillIndex.map((item) => ({ ...item }))
}

export function normalizeOfficeSkillName(value: unknown): OfficeSkillName | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase().replace(/^\./, '')
  const aliases: Record<string, OfficeSkillName> = {
    doc: 'docx',
    docx: 'docx',
    word: 'docx',
    xls: 'xlsx',
    xlsx: 'xlsx',
    excel: 'xlsx',
    pdf: 'pdf',
    ppt: 'pptx',
    pptx: 'pptx',
    powerpoint: 'pptx'
  }
  return aliases[normalized] || null
}

export async function loadOfficeSkill(value: unknown): Promise<OfficeSkill> {
  const name = normalizeOfficeSkillName(value)
  if (!name) throw new Error(`未知 Office Skill：${String(value)}`)
  const cached = loadedSkills.get(name)
  if (cached) return cached
  const skill = await loaders[name]()
  loadedSkills.set(name, skill)
  return skill
}

export function getLoadedOfficeSkillNames(): OfficeSkillName[] {
  return [...loadedSkills.keys()]
}
