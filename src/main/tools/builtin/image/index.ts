import { realpath } from 'fs/promises'
import { generateImage } from '../../../image-gen/service'
import type { IToolExecutor, ToolManifest } from '../../core/types'
import { getAllowedFileRoots, isPathWithinRoots, resolveSessionPath } from '../../utils/paths'

export function buildImageToolInstructions(availableImageModels: string[] = []): string {
  const modelsSection = availableImageModels.length > 0
    ? `当前通过正则过滤出的可用生图模型列表如下（首个为默认推荐）：
${availableImageModels.map((m, idx) => `- ${m}${idx === 0 ? ' (默认首选推荐)' : ''}`).join('\n')}`
    : '当前尚未检测到特定命名的生图模型，请优先使用配置的生图模型，严禁猜测全局兜底模型。'

  return `图片生成是默认工具能力。用户要求生成图片或修改参考图时，使用 generate_image。
${modelsSection}

【生图模型选择与提示卡片交互规则】：
1. 当用户要求生成图片或修改参考图，且未在当前对话中明确指明具体生图模型时：
   必须先调用 request_user_clarification 弹出模型选择提示卡片，将上述正则过滤出的可用生图模型作为 options 提供给用户选择（id 使用 "image_model"，首个模型设为推荐选项）。
2. 用户在提示卡片中做出选择后，以用户选择的模型作为参数调用 generate_image。
3. 若用户跳过、提交空答案或表示任意/未指定，则默认使用正则过滤后的第一个模型（${availableImageModels[0] || '首个可用模型'}），严禁使用全局兜底模型（如 dall-e-3 等未获支持的模型）。
4. 仅当用户在初始要求中已明确指定了生图模型名时，才直接使用该模型调用 generate_image，无需重复弹出卡片。
5. 生成图片时，根据对话整理出完整的画面提示词（主体、构图、风格、光线及细节），调用工具后图片卡片会自动在界面展示，简短告知用户结果即可。`
}

export const IMAGE_TOOL_INSTRUCTIONS = buildImageToolInstructions()

export const imageManifest: ToolManifest = {
  identifier: 'agentpet-image',
  category: 'image',
  meta: { title: '图片生成', description: '调用已配置的图片模型生成或编辑图片', avatar: '🎨' },
  systemRole: IMAGE_TOOL_INSTRUCTIONS,
  api: [{
    name: 'generate_image',
    description: '生成图片或修改本地参考图。根据用户意图整理完整画面提示词后调用；结果自动展示为图片卡片。默认使用正则过滤后的首个生图模型，绝不使用全局硬编码兜底。',
    timeout: 600000,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '完整画面描述，保留用户要求的细节和文字' },
        imagePath: { type: 'string', description: '可选：用户提供的本地参考图路径，用于编辑图片' },
        model: { type: 'string', description: '可选：用户明确指定或选择的生图模型；未指定时默认使用正则过滤后的第一个模型' },
        size: { type: 'string', description: '可选：图片尺寸，例如 1024x1024' }
      },
      required: ['prompt'],
      additionalProperties: false
    }
  }]
}

export const imageExecutor: IToolExecutor = {
  getApiNames: () => ['generate_image'],
  async execute(_api, args, context) {
    let imagePath: string | undefined
    if (args.imagePath) {
      imagePath = await realpath(resolveSessionPath(args.imagePath, context.sessionId, context.workspacePath))
      if (!isPathWithinRoots(imagePath, getAllowedFileRoots(context))) {
        throw new Error('参考图片不在当前会话已授权的文件夹内，请先上传图片或授权该文件夹。')
      }
    }
    const result = await generateImage({ prompt: args.prompt, imagePath, model: args.model, size: args.size }, context.abortSignal)
    // Keep binary data out of model context and durable tool-event storage.
    const { dataUrl: _dataUrl, ...metadata } = result
    return { success: result.success, content: JSON.stringify(metadata), error: result.error ? { message: result.error } : undefined }
  }
}
