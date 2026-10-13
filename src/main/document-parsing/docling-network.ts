import { session } from 'electron'

export async function doclingNetworkEnv(): Promise<NodeJS.ProcessEnv> {
  const env = { ...process.env }
  if (!env.HTTPS_PROXY && !env.https_proxy) {
    const proxy = await session.defaultSession.resolveProxy('https://huggingface.co')
    const address = /^PROXY\s+([^;\s]+)/i.exec(proxy)?.[1]
    if (address) env.HTTPS_PROXY = `http://${address}`
  }
  return env
}
