/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */

import * as fs from 'fs'

import type { ToolContext, ToolResult } from '../../../core/types'
import { officeExecutor } from '../executor'
import { renderOfficeArtifact } from './rendering'
import type { OfficeSkill, OfficeSkillAction, OfficeSkillDescriptor } from './types'
import {
  attachVisiblePreviewValidation,
  countMatches,
  decodeXmlText,
  escapeXmlText,
  jsonResult,
  normalizeOutputName,
  readToolResultState,
  resolveRequiredSource,
  skillError,
  writeGeneratedFile
} from './shared'

const descriptor: OfficeSkillDescriptor = {
  name: 'pptx',
  title: 'PowerPoint 演示文稿 Skill',
  description: '创建、检查、跨文本 run 修改和验证 PPTX；保留现有幻灯片及对象结构。',
  extensions: ['.pptx'],
  instructions: [
    '修改已有演示文稿前先 inspect，确认幻灯片编号和文本。',
    'replace_text 在单个段落内支持跨多个 a:t 文本 run 搜索。',
    '修改默认另存为新文件，不覆盖源文件。',
    '创建或修改后会自动在右侧用 open-file-viewer 打开，并将预览截图交给模型验收。'
  ],
  operations: {
    create: {
      description: '从 Markdown 风格文本创建 16:9 PPTX。',
      inputSchema: {
        type: 'object',
        properties: {
          output_name: { type: 'string' },
          content: { type: 'string', description: '# 开始新章节/幻灯片，普通行作为正文' }
        },
        required: ['output_name', 'content']
      }
    },
    inspect: {
      description: '检查幻灯片数量、形状、图片、图表和每页文本摘要。',
      inputSchema: {
        type: 'object',
        properties: { source_path: { type: 'string' } },
        required: ['source_path']
      }
    },
    modify: {
      description: '在指定幻灯片或全部幻灯片中替换文字。',
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
                op: { type: 'string', enum: ['replace_text'] },
                search: { type: 'string' },
                replace: { type: 'string' },
                slide: { type: 'number', description: '可选，从 1 开始；省略表示全部幻灯片' },
                replace_all: { type: 'boolean', description: '默认 true' }
              },
              required: ['op', 'search', 'replace']
            }
          }
        },
        required: ['source_path', 'output_name', 'operations']
      }
    },
    validate: {
      description: '重新打开 PPTX，检查演示文稿、幻灯片和关系部件。',
      inputSchema: {
        type: 'object',
        properties: { source_path: { type: 'string' } },
        required: ['source_path']
      }
    },
    render: {
      description: '在右侧用 open-file-viewer 打开幻灯片，并截取可见预览供模型视觉检查。',
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

function slideNumberFromPath(path: string): number {
  return Number(path.match(/slide(\d+)\.xml$/)?.[1] || 0)
}

function getSlidePaths(zip: any): string[] {
  return Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumberFromPath(a) - slideNumberFromPath(b))
}

function extractSlideText(xml: string): string {
  return [...xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
    .map((match) => decodeXmlText(match[1]))
    .join(' ')
}

function replaceWithinTextNodes(
  xml: string,
  search: string,
  replacement: string,
  replaceAll: boolean
): { xml: string; count: number } {
  const nodes = [...xml.matchAll(/<a:t(\b[^>]*)>([\s\S]*?)<\/a:t>/g)]
  if (nodes.length === 0) return { xml, count: 0 }

  const sourceText = nodes.map((node) => decodeXmlText(node[2])).join('')
  let count = 0
  let cursor = 0
  while (true) {
    const index = sourceText.indexOf(search, cursor)
    if (index < 0) break
    count++
    cursor = index + Math.max(search.length, 1)
    if (!replaceAll) break
  }
  if (count === 0) return { xml, count: 0 }

  const updatedText = replaceAll
    ? sourceText.split(search).join(replacement)
    : sourceText.replace(search, replacement)
  const originalLengths = nodes.map((node) => decodeXmlText(node[2]).length)
  let textOffset = 0
  let nodeIndex = 0
  const updatedXml = xml.replace(/<a:t(\b[^>]*)>([\s\S]*?)<\/a:t>/g, (_match, attributes) => {
    const isLast = nodeIndex === originalLengths.length - 1
    const length = isLast ? updatedText.length - textOffset : originalLengths[nodeIndex]
    const value = updatedText.slice(textOffset, textOffset + Math.max(length, 0))
    textOffset += Math.max(length, 0)
    nodeIndex++
    return `<a:t${attributes}>${escapeXmlText(value)}</a:t>`
  })

  return { xml: updatedXml, count }
}

function replaceSlideText(
  xml: string,
  search: string,
  replacement: string,
  replaceAll: boolean
): { xml: string; count: number } {
  let total = 0
  let foundParagraph = false
  const updated = xml.replace(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/g, (paragraph) => {
    foundParagraph = true
    if (!replaceAll && total > 0) return paragraph
    const result = replaceWithinTextNodes(paragraph, search, replacement, replaceAll)
    total += result.count
    return result.xml
  })
  if (foundParagraph) return { xml: updated, count: total }
  return replaceWithinTextNodes(xml, search, replacement, replaceAll)
}

async function inspectPptx(sourcePath: string): Promise<Record<string, any>> {
  const JSZip = require('jszip')
  const bytes = await fs.promises.readFile(sourcePath)
  const zip = await JSZip.loadAsync(bytes)
  if (!zip.file('ppt/presentation.xml')) throw new Error('PPTX 结构无效：缺少 ppt/presentation.xml')

  const slidePaths = getSlidePaths(zip)
  if (slidePaths.length === 0) throw new Error('PPTX 结构无效：没有幻灯片')
  const slides = await Promise.all(
    slidePaths.map(async (path) => {
      const xml = await zip.file(path).async('string')
      const text = extractSlideText(xml)
      return {
        slide: slideNumberFromPath(path),
        shapes: countMatches(xml, /<p:sp\b/g),
        pictures: countMatches(xml, /<p:pic\b/g),
        graphic_frames: countMatches(xml, /<p:graphicFrame\b/g),
        charts: countMatches(xml, /<c:chart\b/g),
        text_preview: text.slice(0, 1000),
        text_truncated: text.length > 1000
      }
    })
  )

  return {
    status: 'success',
    skill: 'pptx',
    source_path: sourcePath,
    size_bytes: bytes.length,
    slide_count: slides.length,
    has_theme: Object.keys(zip.files).some((name) => /^ppt\/theme\/theme\d+\.xml$/.test(name)),
    has_notes: Object.keys(zip.files).some((name) =>
      /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)
    ),
    slides
  }
}

async function addPptxValidation(
  result: ToolResult,
  context: ToolContext,
  focus: { mode: 'overview' | 'changes'; texts?: string[]; pages?: number[] } = {
    mode: 'overview'
  }
): Promise<ToolResult> {
  if (!result.success) return result
  const state = readToolResultState(result)
  if (typeof state.file_path !== 'string') return result
  const summary = await inspectPptx(state.file_path)
  return attachVisiblePreviewValidation(
    jsonResult({
      ...state,
      skill: 'pptx',
      validation: {
        valid: summary.slide_count > 0,
        slide_count: summary.slide_count,
        checks: ['zip_package', 'ppt/presentation.xml', 'slide_parts', 'slide_xml']
      }
    }),
    context,
    focus
  )
}

async function modifyPptx(
  sourcePath: string,
  operations: any[],
  outputName: unknown,
  context: ToolContext
): Promise<ToolResult> {
  const JSZip = require('jszip')
  const zip = await JSZip.loadAsync(await fs.promises.readFile(sourcePath))
  const slidePaths = getSlidePaths(zip)
  let replacements = 0

  for (const operation of operations) {
    if (operation?.op !== 'replace_text') {
      throw new Error(`不支持的 PPTX 操作：${String(operation?.op)}`)
    }
    if (typeof operation.search !== 'string' || operation.search.length === 0) {
      throw new Error('replace_text.search 不能为空')
    }

    const selectedPaths =
      operation.slide === undefined
        ? slidePaths
        : slidePaths.filter((path) => slideNumberFromPath(path) === Number(operation.slide))
    if (selectedPaths.length === 0) throw new Error(`幻灯片不存在：${String(operation.slide)}`)

    for (const slidePath of selectedPaths) {
      const xml = await zip.file(slidePath).async('string')
      const result = replaceSlideText(
        xml,
        operation.search,
        String(operation.replace ?? ''),
        operation.replace_all !== false
      )
      if (result.count > 0) {
        zip.file(slidePath, result.xml)
        replacements += result.count
      }
    }
  }

  const output = await writeGeneratedFile(
    await zip.generateAsync({ type: 'nodebuffer' }),
    outputName,
    'modified.pptx',
    '.pptx',
    context
  )
  const validation = await inspectPptx(output.filePath)
  return jsonResult({
    status: 'success',
    skill: 'pptx',
    action: 'modify',
    file_path: output.filePath,
    file_name: output.fileName,
    replacements,
    validation: { valid: true, slide_count: validation.slide_count },
    warning: replacements === 0 ? '没有找到匹配文字，输出文件内容未发生文本变化。' : undefined
  })
}

export const pptxSkill: OfficeSkill = {
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
              'presentation.pptx',
              '.pptx'
            ),
            content: input.content,
            file_type: 'powerpoint'
          },
          context
        )
        return addPptxValidation(result, context)
      }

      const sourcePath = resolveRequiredSource(input, '.pptx')
      if (action === 'render') return renderOfficeArtifact('pptx', sourcePath, input, context)
      if (action === 'modify') {
        if (!Array.isArray(input.operations) || input.operations.length === 0) {
          throw new Error('PPTX modify 至少需要一个 operations 操作')
        }
        const result = await modifyPptx(sourcePath, input.operations, input.output_name, context)
        const focusTexts = input.operations
          .flatMap((operation: any) => [operation?.replace, operation?.search])
          .filter(
            (value: unknown): value is string => typeof value === 'string' && value.length > 0
          )
        const focusPages = input.operations
          .map((operation: any) => Number(operation?.slide))
          .filter((value: number) => Number.isInteger(value) && value > 0)
        return addPptxValidation(result, context, {
          mode: 'changes',
          texts: focusTexts,
          pages: focusPages
        })
      }

      const summary = await inspectPptx(sourcePath)
      if (action === 'validate') {
        return jsonResult({
          ...summary,
          validation: {
            valid: summary.slide_count > 0,
            checks: ['zip_package', 'ppt/presentation.xml', 'slide_parts', 'slide_xml']
          }
        })
      }
      return jsonResult(summary)
    } catch (error) {
      return skillError(error)
    }
  }
}
