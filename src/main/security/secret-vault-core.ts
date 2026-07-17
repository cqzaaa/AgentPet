import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { randomUUID } from 'crypto'
import { dirname } from 'path'

export interface SecretCipher {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(ciphertext: Buffer): string
}

interface SecretEntry {
  ciphertext: string
  createdAt: string
  updatedAt: string
  label?: string
}

interface VaultDocument {
  version: 1
  entries: Record<string, SecretEntry>
}

const EMPTY_VAULT: VaultDocument = { version: 1, entries: {} }
const SECRET_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export class SecretVaultUnavailableError extends Error {
  constructor() {
    super('Operating-system secret encryption is unavailable')
    this.name = 'SecretVaultUnavailableError'
  }
}

export class SecretVaultCorruptedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretVaultCorruptedError'
  }
}

export function writeTextAtomically(filePath: string, content: string): void {
  const directory = dirname(filePath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })

  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  let fileDescriptor: number | undefined
  try {
    fileDescriptor = openSync(temporaryPath, 'wx', 0o600)
    writeFileSync(fileDescriptor, content, 'utf8')
    fsyncSync(fileDescriptor)
    closeSync(fileDescriptor)
    fileDescriptor = undefined
    renameSync(temporaryPath, filePath)
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor)
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
  }
}

export class SecretVault {
  constructor(
    private readonly filePath: string,
    private readonly cipher: SecretCipher,
    private readonly now: () => Date = () => new Date()
  ) {}

  isAvailable(): boolean {
    return this.cipher.isEncryptionAvailable()
  }

  hasSecret(id: string): boolean {
    this.validateSecretId(id)
    return Boolean(this.readDocument().entries[id])
  }

  getSecret(id: string): string | null {
    this.validateSecretId(id)
    const entry = this.readDocument().entries[id]
    if (!entry) return null
    this.assertAvailable()

    try {
      return this.cipher.decryptString(Buffer.from(entry.ciphertext, 'base64'))
    } catch {
      throw new SecretVaultCorruptedError(`Secret entry "${id}" could not be decrypted`)
    }
  }

  setSecret(id: string, plaintext: string, label?: string): void {
    this.validateSecretId(id)
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
      throw new TypeError('Secret plaintext must be a non-empty string')
    }
    this.assertAvailable()

    const document = this.readDocument()
    const timestamp = this.now().toISOString()
    const existing = document.entries[id]
    const ciphertext = this.cipher.encryptString(plaintext).toString('base64')
    document.entries[id] = {
      ciphertext,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...(label ? { label } : existing?.label ? { label: existing.label } : {})
    }
    this.writeDocument(document)
  }

  deleteSecret(id: string): boolean {
    this.validateSecretId(id)
    const document = this.readDocument()
    if (!document.entries[id]) return false
    delete document.entries[id]
    this.writeDocument(document)
    return true
  }

  private assertAvailable(): void {
    if (!this.isAvailable()) throw new SecretVaultUnavailableError()
  }

  private validateSecretId(id: string): void {
    if (!SECRET_ID_PATTERN.test(id)) throw new TypeError('Invalid secret identifier')
  }

  private readDocument(): VaultDocument {
    if (!existsSync(this.filePath)) return { ...EMPTY_VAULT, entries: {} }

    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch {
      throw new SecretVaultCorruptedError('Secret vault is not valid JSON')
    }

    if (!this.isValidDocument(parsed)) {
      throw new SecretVaultCorruptedError('Secret vault has an unsupported or invalid structure')
    }
    return parsed
  }

  private isValidDocument(value: unknown): value is VaultDocument {
    if (!value || typeof value !== 'object') return false
    const candidate = value as Partial<VaultDocument>
    if (candidate.version !== 1 || !candidate.entries || typeof candidate.entries !== 'object')
      return false

    return Object.entries(candidate.entries).every(([id, entry]) => {
      if (!SECRET_ID_PATTERN.test(id) || !entry || typeof entry !== 'object') return false
      const item = entry as Partial<SecretEntry>
      return (
        typeof item.ciphertext === 'string' &&
        item.ciphertext.length > 0 &&
        BASE64_PATTERN.test(item.ciphertext) &&
        typeof item.createdAt === 'string' &&
        typeof item.updatedAt === 'string' &&
        (item.label === undefined || typeof item.label === 'string')
      )
    })
  }

  private writeDocument(document: VaultDocument): void {
    writeTextAtomically(this.filePath, `${JSON.stringify(document, null, 2)}\n`)
  }
}
