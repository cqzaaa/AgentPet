import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname } from 'path'
import type { RpaSecretRef, RpaSurface } from '../domain/types'
import { isRpaSecretRef } from '../domain/secret-ref'
import { SecretVault, writeTextAtomically } from '../../security/secret-vault-core'

export interface RpaSecretMetadata {
  ref: RpaSecretRef
  label: string
  version: number
  status: 'active' | 'disabled'
  allowedWorkflowIds: string[]
  allowedSurfaces: RpaSurface[]
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
}

interface MetadataDocument {
  version: 1
  entries: Record<string, RpaSecretMetadata>
}

export interface RpaSecretAccessRequest {
  workflowId: string
  runId: string
  actionId: string
  surface: RpaSurface
}

export class RpaSecretAccessDeniedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RpaSecretAccessDeniedError'
  }
}

export class RpaSecretService {
  public constructor(
    private readonly metadataPath: string,
    private readonly auditPath: string,
    private readonly vault: SecretVault,
    private readonly now: () => number = Date.now
  ) {}

  public list(): RpaSecretMetadata[] {
    return Object.values(this.readDocument().entries)
      .map((entry) => ({ ...entry, allowedWorkflowIds: [...entry.allowedWorkflowIds], allowedSurfaces: [...entry.allowedSurfaces] }))
      .sort((left, right) => left.label.localeCompare(right.label))
  }

  public create(
    ref: RpaSecretRef,
    plaintext: string,
    options: Pick<RpaSecretMetadata, 'label' | 'allowedWorkflowIds' | 'allowedSurfaces'>
  ): RpaSecretMetadata {
    this.validateRef(ref)
    const document = this.readDocument()
    if (document.entries[ref]) throw new Error(`RPA secret already exists: ${ref}`)
    const timestamp = this.now()
    const metadata: RpaSecretMetadata = {
      ref,
      label: options.label.trim() || ref,
      version: 1,
      status: 'active',
      allowedWorkflowIds: this.unique(options.allowedWorkflowIds),
      allowedSurfaces: this.unique(options.allowedSurfaces),
      createdAt: timestamp,
      updatedAt: timestamp
    }
    this.vault.setSecret(this.vaultId(ref, 1), plaintext, metadata.label)
    document.entries[ref] = metadata
    this.writeDocument(document)
    this.audit('secret.created', ref, { result: 'success' })
    return { ...metadata }
  }

  public rotate(ref: RpaSecretRef, plaintext: string): RpaSecretMetadata {
    const document = this.readDocument()
    const current = this.requireMetadata(document, ref)
    const nextVersion = current.version + 1
    this.vault.setSecret(this.vaultId(ref, nextVersion), plaintext, current.label)
    const updated = { ...current, version: nextVersion, status: 'active' as const, updatedAt: this.now() }
    document.entries[ref] = updated
    this.writeDocument(document)
    this.audit('secret.rotated', ref, { result: 'success', version: nextVersion })
    return { ...updated }
  }

  public setStatus(ref: RpaSecretRef, status: 'active' | 'disabled'): RpaSecretMetadata {
    const document = this.readDocument()
    const current = this.requireMetadata(document, ref)
    const updated = { ...current, status, updatedAt: this.now() }
    document.entries[ref] = updated
    this.writeDocument(document)
    this.audit('secret.status_changed', ref, { result: 'success', status })
    return { ...updated }
  }

  public delete(ref: RpaSecretRef, referencedByWorkflowIds: string[] = []): boolean {
    if (referencedByWorkflowIds.length > 0) {
      throw new RpaSecretAccessDeniedError(
        `RPA secret is still referenced by workflows: ${referencedByWorkflowIds.join(', ')}`
      )
    }
    const document = this.readDocument()
    const current = document.entries[ref]
    if (!current) return false
    for (let version = 1; version <= current.version; version += 1) {
      this.vault.deleteSecret(this.vaultId(ref, version))
    }
    delete document.entries[ref]
    this.writeDocument(document)
    this.audit('secret.deleted', ref, { result: 'success' })
    return true
  }

  public resolve(ref: RpaSecretRef, request: RpaSecretAccessRequest): string {
    const document = this.readDocument()
    const metadata = this.requireMetadata(document, ref)
    const allowed =
      metadata.status === 'active' &&
      metadata.allowedWorkflowIds.includes(request.workflowId) &&
      metadata.allowedSurfaces.includes(request.surface)
    if (!allowed) {
      this.audit('secret.accessed', ref, { ...request, result: 'denied' })
      throw new RpaSecretAccessDeniedError(`Workflow is not authorized to use ${ref}`)
    }
    const plaintext = this.vault.getSecret(this.vaultId(ref, metadata.version))
    if (plaintext === null) {
      this.audit('secret.accessed', ref, { ...request, result: 'missing' })
      throw new Error(`Encrypted value is missing for ${ref}`)
    }
    document.entries[ref] = { ...metadata, lastUsedAt: this.now() }
    this.writeDocument(document)
    this.audit('secret.accessed', ref, { ...request, result: 'success', version: metadata.version })
    return plaintext
  }

  private vaultId(ref: RpaSecretRef, version: number): string {
    return `rpa.${ref}.v${version}`
  }

  private validateRef(ref: string): asserts ref is RpaSecretRef {
    if (!isRpaSecretRef(ref)) throw new TypeError('Invalid RPA secret reference')
  }

  private requireMetadata(document: MetadataDocument, ref: RpaSecretRef): RpaSecretMetadata {
    this.validateRef(ref)
    const metadata = document.entries[ref]
    if (!metadata) throw new Error(`RPA secret not found: ${ref}`)
    return metadata
  }

  private unique<T extends string>(values: T[]): T[] {
    return [...new Set(values.filter(Boolean))]
  }

  private readDocument(): MetadataDocument {
    if (!existsSync(this.metadataPath)) return { version: 1, entries: {} }
    const parsed = JSON.parse(readFileSync(this.metadataPath, 'utf8')) as MetadataDocument
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') {
      throw new Error('RPA secret metadata has an unsupported structure')
    }
    return parsed
  }

  private writeDocument(document: MetadataDocument): void {
    writeTextAtomically(this.metadataPath, `${JSON.stringify(document, null, 2)}\n`)
  }

  private audit(event: string, ref: RpaSecretRef, details: Record<string, unknown>): void {
    mkdirSync(dirname(this.auditPath), { recursive: true, mode: 0o700 })
    appendFileSync(
      this.auditPath,
      `${JSON.stringify({ timestamp: this.now(), event, secretRef: ref, ...details })}\n`,
      { encoding: 'utf8', mode: 0o600 }
    )
  }
}
