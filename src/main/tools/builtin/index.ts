import { toolRegistry } from '../core/tool-registry'
import { BOOTSTRAP_TOOL_NAMES } from '../../agent-runtime/skill-tool-routing'
import { listBuiltinSkills } from '../../skills/builtin-skills'

import { terminalManifest } from './terminal/manifest'
import { terminalExecutor } from './terminal/executor'

import { fileManifest } from './file/manifest'
import { fileExecutor } from './file/executor'

import { searchManifest } from './search/manifest'
import { searchExecutor } from './search/executor'

import { webManifest } from './web/manifest'
import { webExecutor } from './web/executor'

import { officeSkillManifest } from './office/skills/manifest'
import { officeSkillExecutor } from './office/skills/executor'

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
  toolRegistry.register(officeSkillManifest, officeSkillExecutor)
  toolRegistry.register(systemManifest, systemExecutor)
  toolRegistry.register(computerManifest, computerExecutor)
  toolRegistry.register(rpaManifest, rpaToolExecutor)

  const classifiedToolNames = new Set([
    ...BOOTSTRAP_TOOL_NAMES,
    ...listBuiltinSkills().flatMap(skill => skill.allowedTools)
  ])
  const unclassified = Object.keys(toolRegistry.getAllToolsInfo())
    .filter(toolName => !classifiedToolNames.has(toolName))
  if (unclassified.length > 0) {
    throw new Error(`Built-in tools missing a Skill classification: ${unclassified.join(', ')}`)
  }
}
