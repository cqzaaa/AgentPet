import { doclingNetworkEnv } from './docling-network'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { join } from 'path'
import type { WebContents } from 'electron'
import { officeRuntimeManager } from '../tools/interaction/office-runtime-manager'
import type { CanonicalKnowledgeNode, StructuredPdfResult } from './legal-pdf-parser'
import { DOCLING_SCRIPT } from './docling-script'

interface DoclingOutput {
  pageCount: number
  status: string
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
  return {
    nodes, parser: 'docling-2.60.0+rapidocr', characterCount, qualityScore: characterCount >= 80 ? 0.8 : 0.4,
    warning: characterCount >= 80 ? '' : '提取文字较少，请对照原文检查。',
    profile: { kind: 'structured-pdf', pageCount: output.pageCount, parserVersion: 1 }
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
