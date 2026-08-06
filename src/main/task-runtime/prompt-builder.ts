import type { SubagentRole, TaskRun, TaskStep } from './types'

export const SUBAGENT_ROLE_PROMPTS: Record<SubagentRole, string> = {
  general: 'Act as a dependable general-purpose agent. Complete the assigned scope and report concrete evidence.',
  researcher: 'Act as a research agent. Gather and verify evidence, distinguish facts from inference, and cite sources or file paths.',
  coder: 'Act as an implementation agent. Inspect existing code, make only scoped changes, and verify them with the requested checks.',
  reviewer: 'Act as a review agent. Look for correctness, regressions, missing tests, and acceptance-criteria gaps. Do not modify files unless explicitly asked.'
}

export function buildTaskStepPrompt(run: TaskRun, step: TaskStep, completedSteps: TaskStep[]): string {
  const role = step.agentRole || 'general'
  const priorResults = completedSteps.length
    ? completedSteps.map(item => `- ${item.title}: ${item.resultSummary || item.detail || 'completed'}`).join('\n')
    : '- None'
  return [
    SUBAGENT_ROLE_PROMPTS[role],
    '',
    `Parent task: ${run.title}`,
    `Assigned step: ${step.title}`,
    `Goal: ${step.prompt || step.goal || step.title}`,
    step.acceptanceCriteria ? `Acceptance criteria: ${step.acceptanceCriteria}` : '',
    '',
    'Completed dependency results:',
    priorResults,
    '',
    'Work only on this assigned step. Return a concise result summary and list each artifact as an absolute path on a line prefixed with "ARTIFACT:".'
  ].filter(Boolean).join('\n')
}

export function extractExecutionResult(response: string): { resultSummary: string; artifactPaths: string[] } {
  const artifactPaths = response.split(/\r?\n/)
    .map(line => line.match(/^ARTIFACT:\s*(.+)$/i)?.[1]?.trim())
    .filter((value): value is string => !!value)
  const resultSummary = response.replace(/^ARTIFACT:\s*.+$/gim, '').trim()
  return { resultSummary: resultSummary || 'Step completed.', artifactPaths: [...new Set(artifactPaths)] }
}
