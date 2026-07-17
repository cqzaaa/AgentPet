import { toolRegistry } from '../core/tool-registry'

import { terminalManifest } from './terminal/manifest'
import { terminalExecutor } from './terminal/executor'

import { fileManifest } from './file/manifest'
import { fileExecutor } from './file/executor'

import { searchManifest } from './search/manifest'
import { searchExecutor } from './search/executor'

import { webManifest } from './web/manifest'
import { webExecutor } from './web/executor'

import { officeManifest } from './office/manifest'
import { officeExecutor } from './office/executor'

import { systemManifest } from './system/manifest'
import { systemExecutor } from './system/executor'

import { computerManifest } from './computer/manifest'
import { computerExecutor } from './computer/executor'

import { rpaManifest } from './rpa/manifest'
import { rpaToolExecutor } from './rpa/executor'

export function registerBuiltinTools(): void {
  toolRegistry.register(terminalManifest, terminalExecutor)
  toolRegistry.register(fileManifest, fileExecutor)
  toolRegistry.register(searchManifest, searchExecutor)
  toolRegistry.register(webManifest, webExecutor)
  toolRegistry.register(officeManifest, officeExecutor)
  toolRegistry.register(systemManifest, systemExecutor)
  toolRegistry.register(computerManifest, computerExecutor)
  toolRegistry.register(rpaManifest, rpaToolExecutor)
}
