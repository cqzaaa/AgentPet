import { join } from 'path'
import { getActiveStorageDir } from '../../tools/utils/paths'
import type { RpaRunRepository } from './run-repository'
import { SqliteRpaRunRepository } from './sqlite-run-repository'

const repositories = new Map<string, SqliteRpaRunRepository>()

export function getRpaRunRepository(): RpaRunRepository {
  const filename = join(getActiveStorageDir(), 'rpa', 'runs.sqlite')
  let repository = repositories.get(filename)
  if (!repository) {
    repository = new SqliteRpaRunRepository(filename)
    repositories.set(filename, repository)
  }
  return repository
}

export async function closeAllRpaRepositories(): Promise<void> {
  const activeRepositories = [...repositories.values()]
  repositories.clear()
  await Promise.allSettled(activeRepositories.map((repository) => repository.close()))
}
