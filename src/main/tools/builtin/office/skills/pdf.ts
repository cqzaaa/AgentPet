/* eslint-disable @typescript-eslint/no-explicit-any */

import * as fs from 'fs'
import { extname } from 'path'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'

import type { ToolContext, ToolResult } from '../../../core/types'
import { resolveSessionPath } from '../../../utils/paths'
import { officeExecutor } from '../executor'
import { convertPdfOrImages } from './conversion'
import { renderOfficeArtifact } from './rendering'
import type { OfficeSkill, OfficeSkillAction, OfficeSkillDescriptor } from './types'
import {
  attachVisiblePreviewValidation,
  jsonResult,
  normalizeOutputName,
  readToolResultState,
  resolveRequiredSource,
  skillError,
  writeGeneratedFile
} from './shared'

const descriptor: OfficeSkillDescriptor = {
  name: 'pdf',
  title: 'PDF 文档 Skill',
  description: '创建、检查、页面级修改和验证 PDF；适合固定版式覆盖、合并、旋转和表单填写。',
  extensions: ['.pdf'],
  instructions: [
    'PDF 是固定布局，不能像 Word 一样可靠地重排任意已有段落。',
    '坐标原点位于页面左下角，单位为 PDF point。',
    '修改默认另存为新文件，不覆盖源文件。',
    '语义级大改优先修改原 DOCX/PPTX 后重新导出 PDF。'
  ],
  operations: {
    create: {
      description: '从文本创建新的 PDF。',
      inputSchema: {
        type: 'object',
        properties: {
          output_name: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['output_name', 'content']
      }
    },
    inspect: {
      description: '检查页数、页面尺寸、元数据和表单字段。',
      inputSchema: {
        type: 'object',
        properties: { source_path: { type: 'string' } },
        required: ['source_path']
      }
    },
    modify: {
      description:
        '执行 add_text、add_image、rotate_page、remove_page、append_pdf、fill_form、set_metadata。',
      inputSchema: {
        type: 'object',
        properties: {
          source_path: { type: 'string' },
          output_name: { type: 'string' },
          operations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                op: {
                  type: 'string',
                  enum: [
                    'add_text',
                    'add_image',
                    'rotate_page',
                    'remove_page',
                    'append_pdf',
                    'fill_form',
                    'set_metadata'
                  ]
                },
                page: { type: 'number', description: '从 1 开始的页码' },
                x: { type: 'number' },
                y: { type: 'number' },
                text: { type: 'string' },
                size: { type: 'number' },
                color: { type: 'string', description: '#RRGGBB' },
                font_path: {
                  type: 'string',
                  description: '可选 TTF/OTF；中文会在 Windows 自动尝试 simhei.ttf'
                },
                image_path: { type: 'string' },
                width: { type: 'number' },
                height: { type: 'number' },
                angle: { type: 'number' },
                pdf_path: { type: 'string' },
                fields: { type: 'object' },
                metadata: { type: 'object' }
              },
              required: ['op']
            }
          }
        },
        required: ['source_path', 'output_name', 'operations']
      }
    },
    validate: {
      description: '重新载入 PDF 并检查页面与表单结构。',
      inputSchema: {
        type: 'object',
        properties: { source_path: { type: 'string' } },
        required: ['source_path']
      }
    },
    convert: {
      description:
        '在 PDF、图片和 Office 之间转换。目标为 DOCX/PPTX 时固定使用 PaddleOCR 生成可编辑内容；目标为 PNG/JPG 时导出页面图片。',
      inputSchema: {
        type: 'object',
        properties: {
          source_path: { type: 'string', minLength: 1 },
          image_paths: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: { type: 'string', minLength: 1 }
          },
          target_format: { type: 'string', enum: ['pdf', 'png', 'jpg', 'pptx', 'docx'] },
          output_name: { type: 'string', minLength: 1 },
          pages: { type: 'string', minLength: 1, description: '例如 1-3,5；仅用于 PDF 转图片' },
          dpi: { type: 'number', minimum: 36, maximum: 300 },
          quality: { type: 'number', minimum: 1, maximum: 100 },
          page_size: { type: 'string', enum: ['original', 'a4'] },
          input_dpi: { type: 'number', minimum: 36, maximum: 600 },
          margin: { type: 'number', minimum: 0, maximum: 144 },
          timeout_seconds: { type: 'number', minimum: 10, maximum: 300 }
        },
        required: ['target_format']
      }
    },
    render: {
      description: '在右侧用 open-file-viewer 打开 PDF，并截取可见预览供模型视觉检查。',
      inputSchema: {
        type: 'object',
        properties: {
          source_path: { type: 'string' },
          max_frames: { type: 'number', description: '最多截取 1-12 个预览视口，默认 8' }
        },
        required: ['source_path']
      }
    }
  }
}

function parseColor(value: unknown): ReturnType<typeof rgb> {
  const normalized = typeof value === 'string' ? value.replace(/^#/, '') : '000000'
  const valid = /^[0-9a-fA-F]{6}$/.test(normalized) ? normalized : '000000'
  return rgb(
    Number.parseInt(valid.slice(0, 2), 16) / 255,
    Number.parseInt(valid.slice(2, 4), 16) / 255,
    Number.parseInt(valid.slice(4, 6), 16) / 255
  )
}

async function inspectPdf(sourcePath: string): Promise<Record<string, any>> {
  const bytes = await fs.promises.readFile(sourcePath)
  const document = await PDFDocument.load(bytes)
  const formFields = document
    .getForm()
    .getFields()
    .map((field) => ({
      name: field.getName(),
      type: field.constructor.name
    }))

  return {
    status: 'success',
    skill: 'pdf',
    source_path: sourcePath,
    size_bytes: bytes.length,
    page_count: document.getPageCount(),
    pages: document.getPages().map((page, index) => ({
      page: index + 1,
      width: Math.round(page.getWidth() * 100) / 100,
      height: Math.round(page.getHeight() * 100) / 100,
      rotation: page.getRotation().angle
    })),
    metadata: {
      title: document.getTitle() || null,
      author: document.getAuthor() || null,
      subject: document.getSubject() || null,
      creator: document.getCreator() || null,
      producer: document.getProducer() || null
    },
    form_fields: formFields
  }
}

async function addPdfValidation(
  result: ToolResult,
  context: ToolContext,
  focus: { mode: 'overview' | 'changes'; texts?: string[]; pages?: number[] } = {
    mode: 'overview'
  }
): Promise<ToolResult> {
  if (!result.success) return result
  const state = readToolResultState(result)
  if (typeof state.file_path !== 'string') return result
  const summary = await inspectPdf(state.file_path)
  return attachVisiblePreviewValidation(
    jsonResult({
      ...state,
      skill: 'pdf',
      validation: {
        valid: summary.page_count > 0,
        page_count: summary.page_count,
        checks: ['pdf_load', 'page_tree', 'page_dimensions', 'form_structure']
      }
    }),
    context,
    focus
  )
}

function getPage(document: PDFDocument, rawPage: unknown): ReturnType<PDFDocument['getPage']> {
  const pageNumber = Number(rawPage)
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.getPageCount()) {
    throw new Error(`页码无效：${String(rawPage)}`)
  }
  return document.getPage(pageNumber - 1)
}

async function applyPdfOperations(
  sourcePath: string,
  operations: any[],
  outputName: unknown,
  context: ToolContext
): Promise<ToolResult> {
  const sourceBytes = await fs.promises.readFile(sourcePath)
  const document = await PDFDocument.load(sourceBytes)
  document.registerFontkit(fontkit)
  const standardFont = await document.embedFont(StandardFonts.Helvetica)
  const embeddedFonts = new Map<string, any>()
  let applied = 0

  const resolveTextFont = async (operation: any): Promise<any> => {
    const text = String(operation.text ?? '')
    const hasNonAsciiText = [...text].some((character) => character.charCodeAt(0) > 127)
    let fontPath =
      typeof operation.font_path === 'string'
        ? resolveSessionPath(operation.font_path, context.sessionId)
        : ''
    if (!fontPath && hasNonAsciiText && process.platform === 'win32') {
      const windowsCjkFont = 'C:/Windows/Fonts/simhei.ttf'
      if (fs.existsSync(windowsCjkFont)) fontPath = windowsCjkFont
    }
    if (!fontPath) {
      if (hasNonAsciiText) {
        throw new Error('PDF 中文文字需要可用的 TTF/OTF 字体，请在 add_text 中提供 font_path')
      }
      return standardFont
    }
    if (!fs.existsSync(fontPath)) throw new Error(`字体文件不存在：${fontPath}`)
    const cached = embeddedFonts.get(fontPath)
    if (cached) return cached
    const embedded = await document.embedFont(await fs.promises.readFile(fontPath), {
      subset: true
    })
    embeddedFonts.set(fontPath, embedded)
    return embedded
  }

  for (const operation of operations) {
    switch (operation?.op) {
      case 'add_text': {
        const page = getPage(document, operation.page)
        const font = await resolveTextFont(operation)
        page.drawText(String(operation.text ?? ''), {
          x: Number(operation.x ?? 0),
          y: Number(operation.y ?? 0),
          size: Number(operation.size ?? 12),
          color: parseColor(operation.color),
          font
        })
        applied++
        break
      }
      case 'add_image': {
        const page = getPage(document, operation.page)
        const imagePath = resolveSessionPath(String(operation.image_path || ''), context.sessionId)
        if (!imagePath || !fs.existsSync(imagePath)) throw new Error(`图片不存在：${imagePath}`)
        const imageBytes = await fs.promises.readFile(imagePath)
        const extension = extname(imagePath).toLowerCase()
        const image =
          extension === '.png'
            ? await document.embedPng(imageBytes)
            : await document.embedJpg(imageBytes)
        const dimensions = image.scale(1)
        page.drawImage(image, {
          x: Number(operation.x ?? 0),
          y: Number(operation.y ?? 0),
          width: Number(operation.width ?? dimensions.width),
          height: Number(operation.height ?? dimensions.height)
        })
        applied++
        break
      }
      case 'rotate_page':
        getPage(document, operation.page).setRotation(degrees(Number(operation.angle ?? 0)))
        applied++
        break
      case 'remove_page': {
        const pageNumber = Number(operation.page)
        if (
          !Number.isInteger(pageNumber) ||
          pageNumber < 1 ||
          pageNumber > document.getPageCount()
        ) {
          throw new Error(`页码无效：${String(operation.page)}`)
        }
        document.removePage(pageNumber - 1)
        applied++
        break
      }
      case 'append_pdf': {
        const appendPath = resolveSessionPath(String(operation.pdf_path || ''), context.sessionId)
        if (!appendPath || !fs.existsSync(appendPath))
          throw new Error(`追加 PDF 不存在：${appendPath}`)
        const appendDocument = await PDFDocument.load(await fs.promises.readFile(appendPath))
        const pages = await document.copyPages(appendDocument, appendDocument.getPageIndices())
        for (const page of pages) document.addPage(page)
        applied++
        break
      }
      case 'fill_form': {
        const fields =
          operation.fields && typeof operation.fields === 'object' ? operation.fields : {}
        const form = document.getForm()
        for (const [name, value] of Object.entries(fields)) {
          const field: any = form.getField(name)
          if (typeof field.setText === 'function') field.setText(String(value ?? ''))
          else if (typeof field.select === 'function') field.select(String(value ?? ''))
          else if (typeof field.check === 'function') {
            if (value) field.check()
            else if (typeof field.uncheck === 'function') field.uncheck()
          }
        }
        applied++
        break
      }
      case 'set_metadata': {
        const metadata = operation.metadata || {}
        if (metadata.title !== undefined) document.setTitle(String(metadata.title))
        if (metadata.author !== undefined) document.setAuthor(String(metadata.author))
        if (metadata.subject !== undefined) document.setSubject(String(metadata.subject))
        if (metadata.keywords !== undefined) {
          const keywords = Array.isArray(metadata.keywords)
            ? metadata.keywords.map(String)
            : [String(metadata.keywords)]
          document.setKeywords(keywords)
        }
        applied++
        break
      }
      default:
        throw new Error(`不支持的 PDF 操作：${String(operation?.op)}`)
    }
  }

  const output = await writeGeneratedFile(
    await document.save(),
    outputName,
    'modified.pdf',
    '.pdf',
    context
  )
  const validation = await inspectPdf(output.filePath)
  return jsonResult({
    status: 'success',
    skill: 'pdf',
    action: 'modify',
    file_path: output.filePath,
    file_name: output.fileName,
    operations_applied: applied,
    validation: { valid: true, page_count: validation.page_count }
  })
}

export const pdfSkill: OfficeSkill = {
  descriptor,

  async execute(
    action: OfficeSkillAction,
    input: Record<string, any>,
    context: ToolContext
  ): Promise<ToolResult> {
    try {
      if (action === 'create') {
        const result = await officeExecutor.execute(
          'generate_file',
          {
            file_name: normalizeOutputName(
              input.output_name || input.file_name,
              'document.pdf',
              '.pdf'
            ),
            content: input.content,
            file_type: 'pdf'
          },
          context
        )
        return addPdfValidation(result, context)
      }

      if (action === 'convert') {
        const result = await convertPdfOrImages(input, context)
        const state = readToolResultState(result)
        if (state.conversion?.target_format === 'pdf') {
          return addPdfValidation(result, context)
        }
        return result
      }

      const sourcePath = resolveRequiredSource(input, '.pdf', context)
      if (action === 'render') return renderOfficeArtifact('pdf', sourcePath, input, context)
      if (action === 'modify') {
        if (!Array.isArray(input.operations) || input.operations.length === 0) {
          throw new Error('PDF modify 至少需要一个 operations 操作')
        }
        const result = await applyPdfOperations(
          sourcePath,
          input.operations,
          input.output_name,
          context
        )
        const focusPages = input.operations
          .map((operation: any) => Number(operation?.page))
          .filter((value: number) => Number.isInteger(value) && value > 0)
        const focusTexts = input.operations
          .flatMap((operation: any) => [operation?.text, ...Object.values(operation?.fields || {})])
          .filter((value: unknown) => value !== undefined && value !== null)
          .map(String)
        return addPdfValidation(result, context, {
          mode: 'changes',
          pages: focusPages,
          texts: focusTexts
        })
      }

      const summary = await inspectPdf(sourcePath)
      if (action === 'validate') {
        return jsonResult({
          ...summary,
          validation: {
            valid: summary.page_count > 0,
            checks: ['pdf_load', 'page_tree', 'page_dimensions', 'form_structure']
          }
        })
      }
      return jsonResult(summary)
    } catch (error) {
      return skillError(error)
    }
  }
}
