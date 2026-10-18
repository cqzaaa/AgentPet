import { doclingNetworkEnv } from './docling-network'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { join } from 'path'
import type { WebContents } from 'electron'
import { officeRuntimeManager } from '../tools/interaction/office-runtime-manager'
import type { CanonicalKnowledgeNode, StructuredPdfResult } from './legal-pdf-parser'
import { DOCLING_SCRIPT } from './docling-script'
import { textCorruptionRatio } from './text-quality'

export const DOCLING_PARSER = 'docling-2.60.0+rapidocr-v3'

interface DoclingOutput {
  pageCount: number
  status: string
  forcedOcrPages?: number[]
  fullPageOcr?: boolean
  confidence?: { mean_score?: number | null; layout_score?: number | null; ocr_score?: number | null; table_score?: number | null }
  blocks: Array<{ label: string; level: number; text: string; ref: string; sources: Array<{ page: number; bbox: number[]; coordOrigin: string }> }>
}

export function normalizeDocling(output: DoclingOutput, title: string): StructuredPdfResult {
  if (!Array.isArray(output.blocks) || !output.blocks.length) throw new Error('Docling 未提取到可用内容')
  if (output.status !== 'success') throw new Error(`Docling 未完整解析文档：${output.status}`)
  const nodes: CanonicalKnowledgeNode[] = [{
    id: randomUUID(), parentId: null, type: 'document', level: 0, title, headingPath: [title], content: '',
    orderIndex: 0, pageStart: 1, pageEnd: output.pageCount, tokenCount: 0, confidence: 0.8, sourceMeta: {}
  }]
  const headings: CanonicalKnowledgeNode[] = []
  for (const block of output.blocks) {
    const isHeading = block.label === 'section_header' || block.label === 'title'
    const level = Math.max(1, Number(block.level) || 1)
    if (isHeading) while (headings.length && headings[headings.length - 1].level >= level) headings.pop()
    const parent = headings[headings.length - 1] || nodes[0]
    const pages = block.sources.map(source => source.page)
    const node: CanonicalKnowledgeNode = {
      id: randomUUID(), parentId: parent.id,
      type: isHeading ? 'section' : block.label === 'table' ? 'table' : block.label === 'list_item' ? 'list' : block.label === 'caption' ? 'caption' : block.label === 'footnote' ? 'footnote' : 'paragraph',
      level: isHeading ? level : parent.level + 1,
      title: isHeading ? block.text : '', headingPath: isHeading ? [...parent.headingPath, block.text] : parent.headingPath,
      content: block.text, orderIndex: nodes.length, pageStart: pages.length ? Math.min(...pages) : null,
      pageEnd: pages.length ? Math.max(...pages) : null, tokenCount: Math.ceil(block.text.length / 3), confidence: 0.8,
      sourceMeta: { parser: 'docling', label: block.label, ref: block.ref, sources: block.sources }
    }
    nodes.push(node)
    if (isHeading) headings.push(node)
  }
  const characterCount = output.blocks.reduce((sum, block) => sum + block.text.length, 0)
  const corruptionRatio = textCorruptionRatio(output.blocks.map(block => block.text).join('\n'))
  const coveredPages = new Set(output.blocks.flatMap(block => block.sources.map(source => source.page))).size
  const pageCoverage = coveredPages / Math.max(1, output.pageCount)
  const measured = output.confidence?.mean_score
  const baseScore = typeof measured === 'number' && Number.isFinite(measured) ? Math.max(0, Math.min(1, measured)) : 0.7
  const incompleteTables = output.blocks.filter(block => block.label === 'table' &&
    block.text.split('\n').find(line => line.trim().startsWith('|'))?.split('|').slice(1, -1).some(cell => !cell.trim())).length
  const qualityScore = Math.min(baseScore, characterCount >= 80 ? 1 : 0.4,
    corruptionRatio > 0.02 ? 0.35 : 1, pageCoverage < 0.8 || incompleteTables > 0 ? 0.55 : 1)
  const warnings: string[] = []
  if (characterCount < 80) warnings.push('提取文字较少，请对照原文检查。')
  if (corruptionRatio > 0.02) warnings.push('解析结果仍包含乱码，请对照原页核验，暂不提取乱码段落的实体。')
  if (pageCoverage < 0.8) warnings.push('部分页面未提取到正文，请检查扫描页或纯图片页。')
  if (incompleteTables) warnings.push(`${incompleteTables} 个表格含空白或合并表头，请对照原页核验列对应关系。`)
  if (qualityScore < 0.6 && !warnings.length) warnings.push('版面或文字识别置信度偏低，请对照原文核验。')
  return {
    nodes, parser: DOCLING_PARSER, characterCount, qualityScore,
    warning: warnings.join(' '),
    profile: { kind: 'structured-pdf', pageCount: output.pageCount, parserVersion: 3,
      backend: 'pypdfium2', fullPageOcr: output.fullPageOcr || false, forcedOcrPages: output.forcedOcrPages || [],
      corruptionRatio, pageCoverage, incompleteTables, confidence: output.confidence || {} }
  }
}

export async function parseDoclingPdf(filePath: string, title: string, context: { event?: { sender: WebContents } }): Promise<StructuredPdfResult> {
  const runtime = await officeRuntimeManager.ensureDocling(context)
  const networkEnv = await doclingNetworkEnv()
  const output = await new Promise<DoclingOutput>((resolve, reject) => {
    const child = spawn(runtime.pythonPath, ['-c', DOCLING_SCRIPT, runtime.packagesPath, filePath], {
      windowsHide: true, shell: false,
      env: { ...networkEnv, PYTHONUTF8: '1', PYTHONNOUSERSITE: '1', HF_HUB_OFFLINE: '1', HF_HUB_CACHE: join(runtime.packagesPath, 'model-cache', 'hub') }
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('Docling 解析超时（30 分钟），请拆分文档后重试。')) }, 30 * 60_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', value => {
      stdout += value
      if (stdout.length > 64 * 1024 * 1024) { child.kill(); reject(new Error('文档解析结果过大，请拆分后重试。')) }
    })
    child.stderr.on('data', value => { stderr = (stderr + value).slice(-4000) })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`Docling 解析失败：${stderr}`))
      try { resolve(JSON.parse(stdout) as DoclingOutput) } catch { reject(new Error('Docling 返回无效结果')) }
    })
  })
  return normalizeDocling(output, title)
}
