import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { SecretVault, writeTextAtomically } from './secret-vault-core'

type JsonObject = Record<string, unknown>

export interface RuntimeMcpServerConfig extends JsonObject {
  id: string
  name: string
  url: string
  apiKey: string
  hasApiKey: boolean
  enabled: boolean
}

export interface RuntimeMcpConfig extends JsonObject {
  servers: RuntimeMcpServerConfig[]
  secretMigrationPending?: boolean
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function secretIdForServer(serverId: string): string {
  const digest = createHash('sha256').update(serverId, 'utf8').digest('hex').slice(0, 32)
  return `mcp-server-${digest}`
}

function secretRefForServer(serverId: string): string {
  return `secret://${secretIdForServer(serverId)}`
}

function sanitizeServerForDisk(server: JsonObject): JsonObject {
  const sanitized = { ...server }
  delete sanitized.apiKey
  delete sanitized.hasApiKey
  delete sanitized.clearApiKey
  delete sanitized.tools
  return sanitized
}

function validateServers(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) throw new TypeError('MCP configuration servers must be an array')
  const ids = new Set<string>()
  return value.map((server) => {
    if (!isJsonObject(server) || typeof server.id !== 'string' || server.id.length === 0) {
      throw new TypeError('Every MCP server must have a non-empty string id')
    }
    if (ids.has(server.id)) throw new TypeError(`Duplicate MCP server id: ${server.id}`)
    ids.add(server.id)
    return server
  })
}

export class McpConfigStore {
  constructor(
    private readonly configPath: string,
    private readonly vault: SecretVault
  ) {}

  load(): RuntimeMcpConfig {
    const stored = this.readStoredConfig()
    const storedServers = validateServers(stored.servers ?? [])
    let migrationPending = false
    let migrationRequired = false
    const migratedServers: JsonObject[] = []
    const runtimeServers: RuntimeMcpServerConfig[] = []

    for (const server of storedServers) {
      const serverId = server.id as string
      const expectedRef = secretRefForServer(serverId)
      const legacyApiKey = typeof server.apiKey === 'string' ? server.apiKey : ''
      let apiKey = ''
      let apiKeyRef = server.apiKeyRef === expectedRef ? expectedRef : undefined

      if (legacyApiKey) {
        try {
          this.vault.setSecret(
            secretIdForServer(serverId),
            legacyApiKey,
            `MCP server: ${String(server.name || serverId)}`
          )
          apiKey = legacyApiKey
          apiKeyRef = expectedRef
          migrationRequired = true
        } catch {
          apiKey = legacyApiKey
          migrationPending = true
        }
      } else if (apiKeyRef) {
        try {
          apiKey = this.vault.getSecret(secretIdForServer(serverId)) ?? ''
        } catch {
          migrationPending = true
        }
      }

      const diskServer = sanitizeServerForDisk(server)
      delete diskServer.apiKeyRef
      if (apiKeyRef) diskServer.apiKeyRef = apiKeyRef
      migratedServers.push(diskServer)
      runtimeServers.push({
        ...diskServer,
        id: serverId,
        name: typeof server.name === 'string' ? server.name : '',
        url: typeof server.url === 'string' ? server.url : '',
        enabled: server.enabled === true,
        apiKey,
        hasApiKey: apiKey.length > 0
      })
    }

    if (migrationRequired && !migrationPending) {
      this.writeStoredConfig({ ...stored, servers: migratedServers })
    }

    return {
      ...stored,
      servers: runtimeServers,
      ...(migrationPending ? { secretMigrationPending: true } : {})
    }
  }

  save(input: JsonObject): RuntimeMcpConfig {
    if (!isJsonObject(input)) throw new TypeError('MCP configuration must be an object')
    const incomingServers = validateServers(input.servers ?? [])
    const stored = this.readStoredConfig()
    const currentServers = validateServers(stored.servers ?? [])
    const currentById = new Map(currentServers.map((server) => [server.id as string, server]))
    const nextServers: JsonObject[] = []
    const retainedSecretIds = new Set<string>()

    for (const server of incomingServers) {
      const serverId = server.id as string
      const secretId = secretIdForServer(serverId)
      const expectedRef = secretRefForServer(serverId)
      const current = currentById.get(serverId)
      const incomingApiKey =
        typeof server.apiKey === 'string' && server.apiKey.length > 0 ? server.apiKey : ''
      const legacyApiKey =
        typeof current?.apiKey === 'string' && current.apiKey.length > 0 ? current.apiKey : ''
      const shouldClear = server.clearApiKey === true
      let apiKeyRef = current?.apiKeyRef === expectedRef ? expectedRef : undefined

      if (!shouldClear) {
        const keyToPersist = incomingApiKey || legacyApiKey
        if (keyToPersist) {
          this.vault.setSecret(
            secretId,
            keyToPersist,
            `MCP server: ${String(server.name || serverId)}`
          )
          apiKeyRef = expectedRef
        }
      } else {
        apiKeyRef = undefined
      }

      const diskServer = sanitizeServerForDisk(server)
      delete diskServer.apiKeyRef
      if (apiKeyRef) {
        diskServer.apiKeyRef = apiKeyRef
        retainedSecretIds.add(secretId)
      }
      nextServers.push(diskServer)
    }

    const nextStored: JsonObject = { ...input, servers: nextServers }
    delete nextStored.secretMigrationPending
    this.writeStoredConfig(nextStored)

    for (const current of currentServers) {
      const secretId = secretIdForServer(current.id as string)
      if (!retainedSecretIds.has(secretId)) this.vault.deleteSecret(secretId)
    }

    return this.load()
  }

  toRenderer(config: RuntimeMcpConfig): RuntimeMcpConfig {
    const sanitizedRoot = { ...config }
    delete sanitizedRoot.secretMigrationPending
    return {
      ...sanitizedRoot,
      servers: config.servers.map((server) => {
        const sanitized = sanitizeServerForDisk(server)
        delete sanitized.apiKeyRef
        return {
          ...sanitized,
          id: server.id,
          name: server.name,
          url: server.url,
          enabled: server.enabled,
          apiKey: '',
          hasApiKey: server.apiKey.length > 0
        } as RuntimeMcpServerConfig
      })
    }
  }

  private readStoredConfig(): JsonObject {
    if (!existsSync(this.configPath)) return { servers: [] }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.configPath, 'utf8'))
    } catch {
      throw new Error('System MCP configuration is not valid JSON')
    }
    if (!isJsonObject(parsed)) throw new Error('System MCP configuration must be a JSON object')
    return parsed
  }

  private writeStoredConfig(config: JsonObject): void {
    writeTextAtomically(this.configPath, `${JSON.stringify(config, null, 2)}\n`)
  }
}
