import { delimiter, join } from 'path'

export interface ManagedNodeRuntimeInfo {
  rootDir: string
  nodeDir: string
  nodePath: string
  npmPath: string
  prefixDir: string
  cacheDir: string
  nodeVersion: string
}

/** Build a process environment that keeps Node executables, packages and npm cache inside AgentPet. */
export function buildManagedNodeEnvironment(
  info: ManagedNodeRuntimeInfo,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  let inheritedPath = ''
  for (const [key, value] of Object.entries(source)) {
    if (key.toLocaleLowerCase() === 'path') inheritedPath = value || ''
    else environment[key] = value
  }

  environment.PATH = [info.nodeDir, info.prefixDir, inheritedPath].filter(Boolean).join(delimiter)
  environment.NODE_PATH = join(info.prefixDir, 'node_modules')
  environment.npm_config_prefix = info.prefixDir
  environment.npm_config_cache = info.cacheDir
  environment.npm_config_update_notifier = 'false'
  environment.npm_config_fund = 'false'
  environment.npm_config_audit = 'false'
  environment.COREPACK_HOME = join(info.rootDir, 'corepack')
  return environment
}
