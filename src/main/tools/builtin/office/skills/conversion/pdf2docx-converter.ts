/* eslint-disable @typescript-eslint/no-explicit-any */

import { spawn } from 'child_process'
import * as fs from 'fs'
import { basename, extname, join } from 'path'

import JSZip from 'jszip'

import type { ToolContext, ToolResult } from '../../../../core/types'
import { officeRuntimeManager, type OfficeRuntimeInfo } from '../../../../interaction/office-runtime-manager'
import { getSessionFilesDir } from '../../../../utils/paths'
import { writeGeneratedFile } from '../shared'
import { createConversionRuntime } from './runtime'

export type PdfDocumentKind = 'digital' | 'scanned' | 'mixed'

export interface PdfClassification {
  kind: PdfDocumentKind
  pageCount: number
  selectedPages: number[]
  digitalPages: number[]
  scannedPages: number[]
  pageMetrics: Array<{
    page: number
    textChars: number
    validTextRatio: number
    positionedRuns: number
    reliableTextLayer: boolean
  }>
}

export function parsePdfPageSelection(value: unknown, pageCount: number): number[] {
  if (typeof value !== 'string' || !value.trim()) {
    return Array.from({ length: pageCount }, (_, index) => index + 1)
  }

  const pages = new Set<number>()
  for (const token of value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(token)
    if (range) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (start > end) throw new Error(`页码范围无效：${token}`)
      for (let page = start; page <= end; page += 1) pages.add(page)
      continue
    }
    if (!/^\d+$/.test(token)) throw new Error(`页码格式无效：${token}`)
    pages.add(Number(token))
  }

  const selected = [...pages].sort((left, right) => left - right)
  if (selected.length === 0) throw new Error('没有选择任何 PDF 页面')
  const invalidPage = selected.find(page => page < 1 || page > pageCount)
  if (invalidPage !== undefined) {
    throw new Error(`页码 ${invalidPage} 超出范围，PDF 共 ${pageCount} 页`)
  }
  return selected
}

export async function classifyPdfForEditableConversion(
  sourcePath: string,
  pages?: unknown
): Promise<PdfClassification> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const bytes = await fs.promises.readFile(sourcePath)
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    disableWorker: true,
    useSystemFonts: true
  } as any)
  const document = await loadingTask.promise
  const pageCount = document.numPages
  const selectedPages = parsePdfPageSelection(pages, pageCount)
  const pageMetrics: PdfClassification['pageMetrics'] = []
  try {
    for (const pageNumber of selectedPages) {
      const page = await document.getPage(pageNumber)
      try {
        const content = await page.getTextContent()
        const items = (content.items as any[]).filter(item => typeof item?.str === 'string')
        const text = items.map(item => item.str).join('')
        const compact = text.replace(/\s/g, '')
        const validChars = [...compact].filter(character =>
          /[\p{L}\p{N}\p{P}\p{S}]/u.test(character)
        ).length
        const positionedRuns = items.filter(item =>
          Array.isArray(item.transform) &&
          Number.isFinite(Number(item.transform[4])) &&
          Number.isFinite(Number(item.transform[5]))
        ).length
        const validTextRatio = compact.length > 0 ? validChars / compact.length : 0
        const reliableTextLayer =
          compact.length >= 40 && validTextRatio >= 0.85 && positionedRuns >= 3
        pageMetrics.push({
          page: pageNumber,
          textChars: compact.length,
          validTextRatio: Math.round(validTextRatio * 1000) / 1000,
          positionedRuns,
          reliableTextLayer
        })
      } finally {
        page.cleanup()
      }
    }
  } finally {
    await document.destroy()
  }

  const digitalPages = pageMetrics.filter(page => page.reliableTextLayer).map(page => page.page)
  const scannedPages = pageMetrics.filter(page => !page.reliableTextLayer).map(page => page.page)
  const kind: PdfDocumentKind =
    digitalPages.length === pageMetrics.length
      ? 'digital'
      : scannedPages.length === pageMetrics.length
        ? 'scanned'
        : 'mixed'
  return {
    kind,
    pageCount,
    selectedPages,
    digitalPages,
    scannedPages,
    pageMetrics
  }
}

async function runPdf2Docx(
  runtimeInfo: OfficeRuntimeInfo,
  sourcePath: string,
  outputPath: string,
  selectedPages: number[],
  signal?: AbortSignal
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      runtimeInfo.pythonPath,
      [
        runtimeInfo.converterScriptPath,
        sourcePath,
        outputPath,
        JSON.stringify(selectedPages.map(page => page - 1))
      ],
      {
        cwd: runtimeInfo.rootDir,
        windowsHide: true,
        shell: false,
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONNOUSERSITE: '1'
        }
      }
    )
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Office 文档转换超时'))
    }, 15 * 60 * 1000)
    const abort = (): void => {
      child.kill()
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', error => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) reject(new Error('PDF 转 DOCX 已取消'))
      else if (code === 0) resolvePromise()
      else {
        console.error('[OfficeConversion] 转换组件执行失败：', (stderr || stdout).slice(-4000))
        reject(new Error(`Office 文档转换组件执行失败（退出码 ${code}）`))
      }
    })
  })
}

export async function convertDigitalPdfWithPdf2Docx(
  sourcePath: string,
  input: Record<string, any>,
  context: ToolContext,
  runtimeInfo?: OfficeRuntimeInfo,
  classification?: PdfClassification
): Promise<ToolResult> {
  const runtime = createConversionRuntime(input, context, 'PDF → DOCX（Office 组件包）')
  runtime.report(0, 3, '正在准备 Office 组件包')
  const managedRuntime = runtimeInfo || await officeRuntimeManager.ensure(context)
  const effectiveClassification =
    classification || (await classifyPdfForEditableConversion(sourcePath, input.pages))
  runtime.report(1, 3, '正在分析并复刻 PDF 段落、表格和图片结构')

  const cacheDir = join(getSessionFilesDir(context.sessionId), '.agentpet-cache', 'pdf2docx')
  await fs.promises.mkdir(cacheDir, { recursive: true })
  const temporaryPath = join(cacheDir, `${Date.now()}-${process.pid}.docx`)
  try {
    const selectedPages = effectiveClassification.selectedPages
    await runPdf2Docx(
      managedRuntime,
      sourcePath,
      temporaryPath,
      selectedPages,
      context.abortSignal
    )
    runtime.report(2, 3, '正在验证可编辑 DOCX 结构')
    if (!fs.existsSync(temporaryPath)) throw new Error('Office 组件未生成输出文件')
    const bytes = await fs.promises.readFile(temporaryPath)
    const archive = await JSZip.loadAsync(bytes)
    if (!archive.file('word/document.xml')) throw new Error('生成结果不是有效 DOCX')
    const output = await writeGeneratedFile(
      bytes,
      input.output_name,
      `${basename(sourcePath, extname(sourcePath))}-editable.docx`,
      '.docx',
      context
    )
    runtime.report(3, 3, '高保真可编辑 DOCX 已生成')
    const state = {
      status: 'success',
      skill: 'pdf',
      action: 'convert',
      conversion: {
        source_format: 'pdf',
        target_format: 'docx',
        mode: 'editable',
        parser: 'pdf2docx'
      },
      converted_pages: selectedPages,
      source_path: sourcePath,
      file_path: output.filePath,
      file_name: output.fileName,
      editable: true,
      document_classification: effectiveClassification,
      office_components: {
        managed: true,
        python_version: managedRuntime.pythonVersion,
        pdf2docx_version: managedRuntime.pdf2docxVersion,
        install_path: managedRuntime.rootDir
      },
      validation: {
        valid: true,
        checks: ['office_package', 'editable_structure', 'pdf2docx_layout_reconstruction']
      },
      progress: { status: 'completed', completed: 3, total: 3 }
    }
    return {
      success: true,
      state,
      content: JSON.stringify(
        {
          status: 'success',
          message: 'PDF 已转换为可编辑 DOCX',
          file_path: output.filePath,
          file_name: output.fileName
        },
        null,
        2
      )
    }
  } finally {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}
