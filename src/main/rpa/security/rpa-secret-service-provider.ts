import { app } from 'electron'
import { join } from 'path'
import { getSecretVault } from '../../security/secret-vault'
import { RpaSecretService } from './rpa-secret-service'

let service: RpaSecretService | undefined
let servicePath = ''

export function getRpaSecretService(): RpaSecretService {
  const rpaDirectory = join(app.getPath('userData'), 'rpa')
  if (!service || servicePath !== rpaDirectory) {
    service = new RpaSecretService(
      join(rpaDirectory, 'secret-metadata.v1.json'),
      join(rpaDirectory, 'secret-audit.jsonl'),
      getSecretVault()
    )
    servicePath = rpaDirectory
  }
  return service
}
