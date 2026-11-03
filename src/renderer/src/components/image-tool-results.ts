import type { ImageGenState } from './ImageGenerationCard'

/** Derive cards from the same persisted tool events used by the activity panel. */
export function imageToolCards(steps: any[], running: boolean): Array<{ id: string; imageGen: ImageGenState }> {
  return steps.filter(step => step.type === 'call' && step.name === 'generate_image').map(call => {
    const args = typeof call.detail === 'object' && call.detail ? call.detail : {}
    const result = steps.find(step => step.type === 'result' && step.name === 'generate_image' && step.callId === call.callId)
    let metadata: any
    if (result) {
      try { metadata = typeof result.detail === 'string' ? JSON.parse(result.detail) : result.detail } catch { /* Permission errors are plain text. */ }
    }
    return {
      id: call.id || call.callId,
      imageGen: {
        prompt: args.prompt || '',
        referenceImagePath: args.imagePath,
        model: metadata?.model || args.model,
        status: metadata?.success && metadata?.imagePath ? 'success' : result || !running ? 'error' : 'generating',
        imagePath: metadata?.imagePath,
        revisedPrompt: metadata?.revisedPrompt,
        error: metadata?.error || (result ? String(result.detail) : !running ? '图像生成已中断，请重新尝试。' : undefined)
      }
    }
  })
}
