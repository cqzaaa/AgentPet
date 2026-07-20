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
  skillError
} from './shared'

const descriptor: OfficeSkillDescriptor = {
  name: 'docx',
  title: 'Word 文档 Skill',
  description: '创建、检查、局部修改和验证 DOCX；普通内容使用文档对象，复杂修改使用 OOXML。',
  extensions: ['.docx'],
  instructions: [
    '修改默认另存为新文件，不覆盖源文件。',
    '文字替换支持跨 Word run 搜索，并尽量保留原样式。',
    '先 inspect 确认结构和文本，再 modify；完成后调用 validate。',
    '创建或修改后会自动在右侧用 open-file-viewer 打开，并将预览截图交给模型验收。'
  ],
  operations: {
    create: {
      description: '从 Markdown 风格文本创建 DOCX。',
      inputSchema: {
        type: 'object',
        properties: {
          output_name: { type: 'string', description: '输出文件名，建议以 .docx 结尾' },
          content: { type: 'string', description: '正文；支持 # 标题和 Markdown 图片语法' }
        },
        required: ['output_name', 'content']
      }
    },
    inspect: {
      description: '读取 DOCX 的段落、表格、图片、页眉页脚和文本摘要。',
      inputSchema: {
        type: 'object',
        properties: { source_path: { type: 'string' } },
        required: ['source_path']
      }
    },
    modify: {
      description: '替换文字、调整文字样式或用图片替换占位文字。',
      inputSchema: {
        type: 'object',
        properties: {
          source_path: { type: 'string' },
          output_name: { type: 'string' },
          modifications: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                search: { type: 'string' },
                replace: { type: 'string' },
                paragraphStyle: { type: 'string' },
                style: { type: 'object' }
              },
              required: ['search']
            }
          },
          images: { type: 'array', items: { type: 'object' } }
        },
        required: ['source_path', 'output_name']
      }
    },
    validate: {
      description: '重新打开 DOCX，检查必要 OOXML 部件和基本结构。',
      inputSchema: {
        type: 'object',
        properties: { source_path: { type: 'string' } },
        required: ['source_path']
      }
    },
    render: {
      description: '在右侧用 open-file-viewer 打开 DOCX，并截取可见预览供模型视觉检查。',
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

async function inspectDocx(sourcePath: string): Promise<Record<string, any>> {
  const JSZip = require('jszip')
  const buffer = await fs.promises.readFile(sourcePath)
  const zip = await JSZip.loadAsync(buffer)
  const documentPart = zip.file('word/document.xml')
  if (!documentPart) throw new Error('DOCX 结构无效：缺少 word/document.xml')

  const partNames = Object.keys(zip.files)
  const textPartNames = partNames.filter(
    (name) => name === 'word/document.xml' || /^word\/(header|footer)\d+\.xml$/.test(name)
  )

  const partXml = await Promise.all(
    textPartNames.map(async (name) => ({ name, xml: await zip.file(name)!.async('string') }))
  )
  const allText = partXml
    .flatMap((part) => [...part.xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)])
    .map((match) => decodeXmlText(match[1]))
    .join('')
  const documentXml = await documentPart.async('string')

  return {
    status: 'success',
    skill: 'docx',
    source_path: sourcePath,
    size_bytes: buffer.length,
    paragraphs: countMatches(documentXml, /<w:p\b/g),
    tables: countMatches(documentXml, /<w:tbl\b/g),
    text_runs: countMatches(documentXml, /<w:t\b/g),
    images: partNames.filter((name) => name.startsWith('word/media/') && !zip.files[name].dir)
      .length,
    headers: partNames.filter((name) => /^word\/header\d+\.xml$/.test(name)).length,
    footers: partNames.filter((name) => /^word\/footer\d+\.xml$/.test(name)).length,
    has_styles: Boolean(zip.file('word/styles.xml')),
    has_numbering: Boolean(zip.file('word/numbering.xml')),
    text_preview: allText.slice(0, 4000),
    text_truncated: allText.length > 4000
  }
}

async function addDocxValidation(
  result: ToolResult,
  context: ToolContext,
  focus: { mode: 'overview' | 'changes'; texts?: string[] } = { mode: 'overview' }
): Promise<ToolResult> {
  if (!result.success) return result
  const state = readToolResultState(result)
  if (typeof state.file_path !== 'string') return result
  const summary = await inspectDocx(state.file_path)
  return attachVisiblePreviewValidation(
    jsonResult({
      ...state,
      skill: 'docx',
      validation: {
        valid: true,
        paragraphs: summary.paragraphs,
        tables: summary.tables,
        images: summary.images,
        checks: ['zip_package', 'word/document.xml', 'document_structure']
      }
    }),
    context,
    focus
  )
}

export const docxSkill: OfficeSkill = {
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
              'document.docx',
              '.docx'
            ),
            content: input.content,
            file_type: 'word'
          },
          context
        )
        return addDocxValidation(result, context)
      }

      if (action === 'modify') {
        const rawModifications = input.modifications || input.operations
        const modifications = Array.isArray(rawModifications)
          ? rawModifications.map((modification) => ({
              ...modification,
              search:
                typeof modification.search === 'string'
                  ? escapeXmlText(modification.search)
                  : modification.search,
              replace:
                typeof modification.replace === 'string'
                  ? escapeXmlText(modification.replace)
                  : modification.replace
            }))
          : rawModifications
        const images = Array.isArray(input.images)
          ? input.images.map((image) => ({
              ...image,
              search_text:
                typeof image.search_text === 'string'
                  ? escapeXmlText(image.search_text)
                  : image.search_text
            }))
          : input.images
        const result = await officeExecutor.execute(
          'modify_docx_file',
          {
            source_path: input.source_path || input.file_path,
            output_name: normalizeOutputName(input.output_name, 'modified.docx', '.docx'),
            modifications,
            images
          },
          context
        )
        const focusTexts = [
          ...(Array.isArray(rawModifications)
            ? rawModifications.flatMap((item) => [item?.replace, item?.search])
            : []),
          ...(Array.isArray(input.images) ? input.images.map((item) => item?.search_text) : [])
        ].filter((value): value is string => typeof value === 'string' && value.length > 0)
        return addDocxValidation(result, context, { mode: 'changes', texts: focusTexts })
      }

      const sourcePath = resolveRequiredSource(input, '.docx')
      if (action === 'render') return renderOfficeArtifact('docx', sourcePath, input, context)
      const summary = await inspectDocx(sourcePath)
      if (action === 'validate') {
        return jsonResult({
          ...summary,
          validation: {
            valid: true,
            checks: ['zip_package', 'word/document.xml', 'document_structure']
          }
        })
      }
      return jsonResult(summary)
    } catch (error) {
      return skillError(error)
    }
  }
}
