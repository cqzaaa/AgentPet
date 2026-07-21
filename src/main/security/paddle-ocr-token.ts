import { getSecretVault } from './secret-vault'

export const PADDLE_OCR_TOKEN_SECRET_ID = 'integration-paddleocr-api-access-token'

export function getPaddleOcrToken(): string {
  const vault = getSecretVault()
  return vault.getSecret(PADDLE_OCR_TOKEN_SECRET_ID)?.trim() || ''
}

export function setPaddleOcrToken(token: string): void {
  const normalized = token.trim()
  if (!normalized) throw new Error('PADDLEOCR_TOKEN_EMPTY')
  const vault = getSecretVault()
  vault.setSecret(PADDLE_OCR_TOKEN_SECRET_ID, normalized, 'PaddleOCR API Access Token')
}

export function clearPaddleOcrToken(): boolean {
  const vault = getSecretVault()
  return vault.deleteSecret(PADDLE_OCR_TOKEN_SECRET_ID)
}

export function hasPaddleOcrToken(): boolean {
  return Boolean(getPaddleOcrToken())
}
