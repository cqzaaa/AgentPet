import type { ExternalAgentDefinition } from './types'

export const BUILTIN_EXTERNAL_AGENTS: ExternalAgentDefinition[] = [
  {
    id: 'agentpet',
    name: 'AgentPet',
    description: 'AgentPet 内置默认 Agent',
    source: 'builtin',
    protocol: 'internal',
    executable: '',
    args: [],
    enabled: true
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: '使用用户本机 Claude Code CLI（stream-json）',
    source: 'builtin',
    protocol: 'claude-stream-json',
    executable: 'claude',
    args: [],
    executableAliases: ['claude.cmd'],
    enabled: true
  },
  {
    id: 'codex',
    name: 'Codex',
    description: '使用用户本机 Codex CLI 原生 App Server',
    source: 'builtin',
    protocol: 'codex-app-server',
    executable: 'codex',
    args: ['app-server'],
    executableAliases: ['codex.exe', 'codex.cmd'],
    enabled: true
  },
  {
    id: 'antigravity',
    name: 'Antigravity CLI',
    description: '使用用户本机 agy CLI（JSON 非交互模式）',
    source: 'builtin',
    protocol: 'antigravity-json',
    executable: 'agy',
    args: [],
    executableAliases: ['agy.exe'],
    enabled: true
  }
]
