/* eslint-disable @typescript-eslint/no-explicit-any */

import * as fs from 'fs'
import { basename, extname, parse, resolve } from 'path'

import { createCanvas, loadImage } from '@napi-rs/canvas'
import { PDFDocument } from 'pdf-lib'

import type { ToolContext, ToolResult } from '../../../../core/types'
import { officeRuntimeManager } from '../../../../interaction/office-runtime-manager'
import { getAllowedFileRoots, isPathWithinRoots, resolveSessionPath } from '../../../../utils/paths'
import { jsonResult, normalizeOutputName, writeGeneratedFile } from '../shared'
import {
  assertOfficeConversionSupported,
  formatFromPath,
  listOfficeConversionCapabilities,
  normalizeConversionFormat,
  type OfficeConversionFormat,
  type OfficeConversionTargetFormat
} from './capabilities'
import { createConversionRuntime } from './runtime'
import { convertPdfWithPaddle } from './paddle-pdf-converter'
import {
  classifyPdfForEditableConversion,
  convertDigitalPdfWithPdf2Docx
} from './pdf2docx-converter'
import { convertPdfToMarkdownOrText } from './pdf-text-converter'
import { convertPdfToXlsx } from './pdf-xlsx-converter'

const MAX_INPUT_FILES = 100
const MAX_RENDER_PIXELS = 50_000_000
const PDF_POINTS_PER_INCH = 72
const DEFAULT_IMAGE_DPI = 96
const DEFAULT_RENDER_DPI = 144
const A4_PORTRAIT: readonly [number, number] = [595.28, 841.89]

interface ResolvedInputFile {
  path: string
  format: OfficeConversionFormat
}

function resolveInputFile(rawPath: unknown, context: ToolContext): ResolvedInputFile {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new Error('转换输入路径不能为空')
  }

  const localPath = resolve(resolveSessionPath(rawPath.trim(), context.sessionId))
  if (!fs.existsSync(localPath)) throw new Error(`转换输入文件不存在：${localPath}`)
  const realPath = fs.realpathSync(localPath)
  if (!fs.statSync(realPath).isFile()) throw new Error(`转换输入不是文件：${realPath}`)
  if (!isPathWithinRoots(realPath, getAllowedFileRoots(context))) {
    throw new Error(`转换输入路径不在允许范围内：${realPath}`)
  }

  const format = formatFromPath(realPath)
  if (!format) {
    throw new Error(`不支持的转换输入格式：${extname(realPath) || '无扩展名'}`)
  }
  return { path: realPath, format }
}

function collectInputFiles(input: Record<string, any>, context: ToolContext): ResolvedInputFile[] {
  const rawPaths = [
    ...(typeof input.source_path === 'string' ? [input.source_path] : []),
    ...(Array.isArray(input.image_paths) ? input.image_paths : [])
  ]
  if (rawPaths.length === 0) throw new Error('必须提供 source_path 或 image_paths')
  if (rawPaths.length > MAX_INPUT_FILES) {
    throw new Error(`单次最多转换 ${MAX_INPUT_FILES} 个输入文件`)
  }

  const seen = new Set<string>()
  return rawPaths
    .map((rawPath) => resolveInputFile(rawPath, context))
    .filter((file) => {
      const key = process.platform === 'win32' ? file.path.toLowerCase() : file.path
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function resolveTargetFormat(input: Record<string, any>): OfficeConversionTargetFormat {
  const format = normalizeConversionFormat(input.target_format)
  if (format && format !== 'webp') return format
  throw new Error(`不支持的目标格式：${String(input.target_format || '')}`)
}

function parsePageSelection(value: unknown, pageCount: number): number[] {
  if (typeof value !== 'string' || !value.trim()) {
    return Array.from({ length: pageCount }, (_, index) => index + 1)
  }

  const pages = new Set<number>()
  for (const token of value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(token)
    if (range) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (start > end) throw new Error(`页码范围无效：${token}`)
      for (let page = start; page <= end; page++) pages.add(page)
      continue
    }

    if (!/^\d+$/.test(token)) throw new Error(`页码格式无效：${token}`)
    pages.add(Number(token))
  }

  const selected = [...pages].sort((a, b) => a - b)
  if (selected.length === 0) throw new Error('没有选择任何 PDF 页面')
  const invalidPage = selected.find((page) => page < 1 || page > pageCount)
  if (invalidPage !== undefined) {
    throw new Error(`页码 ${invalidPage} 超出范围，PDF 共 ${pageCount} 页`)
  }
  return selected
}

function fitInside(
  sourceWidth: number,
  sourceHeight: number,
  availableWidth: number,
  availableHeight: number
): { width: number; height: number } {
  const scale = Math.min(availableWidth / sourceWidth, availableHeight / sourceHeight)
  return { width: sourceWidth * scale, height: sourceHeight * scale }
}

async function imageBytesForPdf(file: ResolvedInputFile): Promise<{
  bytes: Buffer
  format: 'png' | 'jpg'
  width: number
  height: number
}> {
  const sourceBytes = await fs.promises.readFile(file.path)
  const image = await loadImage(sourceBytes)
  if (!image.width || !image.height) throw new Error(`无法读取图片尺寸：${file.path}`)

  if (file.format === 'png' || file.format === 'jpg') {
    return { bytes: sourceBytes, format: file.format, width: image.width, height: image.height }
  }

  const canvas = createCanvas(image.width, image.height)
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0)
  return {
    bytes: canvas.toBuffer('image/png'),
    format: 'png',
    width: image.width,
    height: image.height
  }
}

async function imagesToPdf(
  files: ResolvedInputFile[],
  input: Record<string, any>,
  context: ToolContext
): Promise<ToolResult> {
  for (const file of files) {
    assertOfficeConversionSupported(file.format, 'pdf')
  }
  const runtime = createConversionRuntime(input, context, '图片 → PDF')

  const document = await PDFDocument.create()
  const inputDpi = Number(input.input_dpi ?? DEFAULT_IMAGE_DPI)
  const margin = Number(input.margin ?? 0)
  const pageSize = input.page_size === 'a4' ? 'a4' : 'original'

  for (let index = 0; index < files.length; index++) {
    const file = files[index]
    runtime.report(index, files.length, `正在处理图片 ${index + 1}/${files.length}`)
    const imageData = await imageBytesForPdf(file)
    runtime.check()
    const embeddedImage =
      imageData.format === 'png'
        ? await document.embedPng(imageData.bytes)
        : await document.embedJpg(imageData.bytes)

    const originalWidth = (imageData.width * PDF_POINTS_PER_INCH) / inputDpi
    const originalHeight = (imageData.height * PDF_POINTS_PER_INCH) / inputDpi
    let pageWidth: number
    let pageHeight: number
    if (pageSize === 'a4') {
      const landscape = imageData.width > imageData.height
      ;[pageWidth, pageHeight] = landscape
        ? [A4_PORTRAIT[1], A4_PORTRAIT[0]]
        : [A4_PORTRAIT[0], A4_PORTRAIT[1]]
    } else {
      pageWidth = originalWidth + margin * 2
      pageHeight = originalHeight + margin * 2
    }

    if (pageWidth > 14_400 || pageHeight > 14_400) {
      throw new Error(`图片页面尺寸过大：${basename(file.path)}，请提高 input_dpi`)
    }
    const availableWidth = pageWidth - margin * 2
    const availableHeight = pageHeight - margin * 2
    if (availableWidth <= 0 || availableHeight <= 0) {
      throw new Error('margin 超过页面可用尺寸')
    }

    const rendered = fitInside(imageData.width, imageData.height, availableWidth, availableHeight)
    const page = document.addPage([pageWidth, pageHeight])
    page.drawImage(embeddedImage, {
      x: (pageWidth - rendered.width) / 2,
      y: (pageHeight - rendered.height) / 2,
      width: rendered.width,
      height: rendered.height
    })
  }

  const output = await writeGeneratedFile(
    await document.save(),
    input.output_name,
    'images.pdf',
    '.pdf',
    context
  )
  runtime.report(files.length, files.length, 'PDF 已生成')
  return jsonResult({
    status: 'success',
    skill: 'pdf',
    action: 'convert',
    conversion: { source_format: 'image', target_format: 'pdf', mode: 'visual' },
    file_path: output.filePath,
    file_name: output.fileName,
    source_paths: files.map((file) => file.path),
    page_count: files.length,
    validation: { valid: files.length > 0, page_count: files.length },
    progress: { status: 'completed', completed: files.length, total: files.length }
  })
}

async function pdfToImages(
  file: ResolvedInputFile,
  targetFormat: 'png' | 'jpg',
  input: Record<string, any>,
  context: ToolContext
): Promise<ToolResult> {
  assertOfficeConversionSupported(file.format, targetFormat)
  const runtime = createConversionRuntime(input, context, `PDF → ${targetFormat.toUpperCase()}`)
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const bytes = await fs.promises.readFile(file.path)
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    disableWorker: true,
    useSystemFonts: true
  } as any)
  const document = await loadingTask.promise

  try {
    const selectedPages = parsePageSelection(input.pages, document.numPages)
    const dpi = Number(input.dpi ?? DEFAULT_RENDER_DPI)
    const scale = dpi / PDF_POINTS_PER_INCH
    const quality = Number(input.quality ?? 90) / 100
    const extension = `.${targetFormat}`
    const requestedName = normalizeOutputName(
      input.output_name,
      `${basename(file.path, extname(file.path))}${extension}`,
      extension
    )
    const requestedParts = parse(requestedName)
    const outputFiles: Array<{ page: number; file_path: string; file_name: string }> = []

    for (let index = 0; index < selectedPages.length; index++) {
      const pageNumber = selectedPages[index]
      runtime.report(index, selectedPages.length, `正在渲染第 ${pageNumber} 页`)
      const page = await document.getPage(pageNumber)
      try {
        const viewport = page.getViewport({ scale })
        const width = Math.ceil(viewport.width)
        const height = Math.ceil(viewport.height)
        if (width * height > MAX_RENDER_PIXELS) {
          throw new Error(`第 ${pageNumber} 页渲染尺寸过大，请降低 dpi`)
        }

        const canvas = createCanvas(width, height)
        const canvasContext = canvas.getContext('2d')
        await page.render({
          canvas: canvas as any,
          canvasContext: canvasContext as any,
          viewport,
          background: '#FFFFFF'
        }).promise
        runtime.check()

        const outputBytes =
          targetFormat === 'png'
            ? canvas.toBuffer('image/png')
            : canvas.toBuffer('image/jpeg', quality)
        const pageName =
          selectedPages.length === 1
            ? requestedName
            : `${requestedParts.name}-page-${String(pageNumber).padStart(3, '0')}${extension}`
        const output = await writeGeneratedFile(outputBytes, pageName, pageName, extension, context)
        outputFiles.push({
          page: pageNumber,
          file_path: output.filePath,
          file_name: output.fileName
        })

        canvas.width = 1
        canvas.height = 1
      } finally {
        page.cleanup()
      }
    }

    runtime.report(selectedPages.length, selectedPages.length, '图片已生成')

    return jsonResult({
      status: 'success',
      skill: 'pdf',
      action: 'convert',
      conversion: { source_format: 'pdf', target_format: targetFormat, mode: 'visual' },
      source_path: file.path,
      source_page_count: document.numPages,
      converted_pages: selectedPages,
      output_count: outputFiles.length,
      files: outputFiles,
      file_path: outputFiles.length === 1 ? outputFiles[0].file_path : undefined,
      file_name: outputFiles.length === 1 ? outputFiles[0].file_name : undefined,
      imagePaths: outputFiles.map((item) => item.file_path),
      validation: { valid: outputFiles.length === selectedPages.length },
      progress: { status: 'completed', completed: outputFiles.length, total: selectedPages.length }
    })
  } finally {
    await document.destroy()
  }
}

export async function convertPdfOrImages(
  input: Record<string, any>,
  context: ToolContext
): Promise<ToolResult> {
  const files = collectInputFiles(input, context)
  const targetFormat = resolveTargetFormat(input)

  if (targetFormat === 'pdf') return imagesToPdf(files, input, context)
  if (files.length !== 1) throw new Error('PDF 转换只允许一个 source_path')

  const source = files[0]
  assertOfficeConversionSupported(source.format, targetFormat)
  if (targetFormat === 'pptx') return convertPdfWithPaddle(source.path, 'pptx', input, context)
  if (targetFormat === 'markdown' || targetFormat === 'txt') {
    return convertPdfToMarkdownOrText(source.path, targetFormat, input, context)
  }
  if (targetFormat === 'xlsx') return convertPdfToXlsx(source.path, input, context)
  if (targetFormat === 'docx') {
    const officeRuntime = await officeRuntimeManager.ensure(context)
    const classification = await classifyPdfForEditableConversion(source.path, input.pages)
    if (classification.kind === 'digital') {
      try {
        return await convertDigitalPdfWithPdf2Docx(
          source.path,
          input,
          context,
          officeRuntime,
          classification
        )
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        context.event?.sender.send('api:llm-tool-event', {
          type: 'tool_progress',
          name: 'PDF → DOCX（自动回退）',
          detail: `Office 组件转换未完成，正在改用兼容模式：${detail}`,
          progress: 0,
          timestamp: Date.now(),
          messageId: context.messageId,
          sessionId: context.sessionId
        })
      }
    }
    return convertPdfWithPaddle(source.path, 'docx', {
      ...input,
      document_classification: classification.kind
    }, context)
  }
  if (targetFormat !== 'png' && targetFormat !== 'jpg') {
    throw new Error(`PDF 不支持转换为 ${targetFormat}`)
  }
  return pdfToImages(source, targetFormat, input, context)
}

export const pdfImageConversionCapabilities = listOfficeConversionCapabilities()
