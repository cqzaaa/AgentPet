import { getSecretVault } from './secret-vault'

export const EMBEDDING_SERVICE_TOKEN_SECRET_ID = 'agentpet.embedding-service.token'

export function getEmbeddingServiceToken(): string {
  return getSecretVault().getSecret(EMBEDDING_SERVICE_TOKEN_SECRET_ID)?.trim() || ''
}

export function setEmbeddingServiceToken(token: string): void {
  const normalized = token.trim()
  if (!normalized) throw new Error('EMBEDDING_SERVICE_TOKEN_EMPTY')
  getSecretVault().setSecret(
    EMBEDDING_SERVICE_TOKEN_SECRET_ID,
    normalized,
    'AgentPet BGE-M3 Embedding Service Token'
  )
}

export function hasEmbeddingServiceToken(): boolean {
  return Boolean(getEmbeddingServiceToken())
}
