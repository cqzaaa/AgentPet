import type { TaskStep } from './types'

export function listTaskStepReferences(steps: TaskStep[]) {
  return [...steps]
    .sort((left, right) => left.sequence - right.sequence)
    .map(step => ({
      id: step.id,
      title: step.title,
      status: step.status
    }))
}

export function buildUnknownTaskStepFeedback(requestedStepId: string, steps: TaskStep[]) {
  const currentStepId = steps.find(step => step.status === 'running')?.id
  return {
    error: 'unknown_task_step',
    requestedStepId,
    ...(currentStepId ? { currentStepId } : {}),
    validSteps: listTaskStepReferences(steps),
    message: 'Retry update_task_step with one exact id from validSteps. Do not call update_task_plan again.'
  }
}
