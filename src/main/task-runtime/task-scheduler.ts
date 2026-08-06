import type { TaskStep } from './types'

export function getReadyPendingSteps(steps: TaskStep[]): TaskStep[] {
  const completedIds = new Set(steps.filter(step => step.status === 'completed').map(step => step.id))
  return steps.filter(step =>
    step.status === 'pending' && (step.dependencies || []).every(dependency => completedIds.has(dependency))
  )
}

export function validateTaskDependencies(steps: Array<Pick<TaskStep, 'id' | 'dependencies'>>): string[] {
  const ids = new Set(steps.map(step => step.id))
  const errors: string[] = []
  for (const step of steps) {
    for (const dependency of step.dependencies || []) {
      if (dependency === step.id) errors.push(`${step.id} cannot depend on itself`)
      else if (!ids.has(dependency)) errors.push(`${step.id} depends on unknown step ${dependency}`)
    }
  }
  return errors
}
