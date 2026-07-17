import { app, safeStorage } from 'electron'
import { join } from 'path'
import { SecretVault, type SecretCipher } from './secret-vault-core'

const electronSecretCipher: SecretCipher = {
  isEncryptionAvailable: () => {
    if (!safeStorage.isEncryptionAvailable()) return false
    if (process.platform !== 'linux') return true

    // Electron can fall back to "basic_text" when no Linux secret store is
    // available. Treat that backend as unavailable instead of persisting
    // reversibly encoded credentials.
    const backend = safeStorage.getSelectedStorageBackend()
    return backend !== 'basic_text' && backend !== 'unknown'
  },
  encryptString: (plaintext) => safeStorage.encryptString(plaintext),
  decryptString: (ciphertext) => safeStorage.decryptString(ciphertext)
}

let vault: SecretVault | null = null
let vaultUserDataPath = ''

export function getSecretVault(): SecretVault {
  const userDataPath = app.getPath('userData')
  if (!vault || vaultUserDataPath !== userDataPath) {
    vault = new SecretVault(join(userDataPath, 'secrets.v1.json'), electronSecretCipher)
    vaultUserDataPath = userDataPath
  }
  return vault
}
