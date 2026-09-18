import { randomUUID } from 'node:crypto'
import { getSecretVault } from './secret-vault'

const SSH_PASSWORD_REF = /^secret:\/\/agent-ssh-[0-9a-f-]{36}$/i

export function saveAgentSshPassword(password: string, existingRef?: string): string {
  if (typeof password !== 'string' || !password) throw new Error('请输入 SSH 登录密码')
  if (password.length > 4096) throw new Error('SSH 密码过长')
  if (existingRef && !SSH_PASSWORD_REF.test(existingRef)) throw new Error('SSH 密码引用无效')
  const ref = existingRef || `secret://agent-ssh-${randomUUID()}`
  getSecretVault().setSecret(ref.slice('secret://'.length), password, 'Agent 节点 SSH 密码')
  return ref
}

export function loadAgentSshPassword(ref: string): string {
  if (!SSH_PASSWORD_REF.test(ref)) throw new Error('SSH 密码引用无效')
  const password = getSecretVault().getSecret(ref.slice('secret://'.length))
  if (!password) throw new Error('已保存的 SSH 密码不存在，请重新输入并保存')
  return password
}
