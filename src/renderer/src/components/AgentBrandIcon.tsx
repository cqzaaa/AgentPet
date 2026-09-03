import React from 'react'
import agentPet from '../assets/icon.png'
import antigravity from '@lobehub/icons-static-svg/icons/antigravity-color.svg'
import claudeCode from '@lobehub/icons-static-svg/icons/claudecode-color.svg'
import codex from '@lobehub/icons-static-svg/icons/codex-color.svg'
import geminiCli from '@lobehub/icons-static-svg/icons/geminicli-color.svg'
import lobehub from '@lobehub/icons-static-svg/icons/lobehub-color.svg'

const ICONS: Record<string, string> = {
  agentpet: agentPet,
  'claude-code': claudeCode,
  'gemini-cli': geminiCli,
  codex,
  antigravity
}

export function getAgentIcon(agentId: string): string {
  return ICONS[String(agentId || '').toLowerCase()] || lobehub
}

export function AgentBrandIcon({ agentId, className = '' }: { agentId: string; className?: string }): React.JSX.Element {
  return (
    <img
      className={`agent-brand-icon-img ${className}`}
      src={getAgentIcon(agentId)}
      alt=""
      aria-hidden="true"
      style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
    />
  )
}
