import React from 'react'
import { Bot, Database, LayoutDashboard, MessageSquare, Monitor, Settings } from 'lucide-react'
// ── Icon Components (inline SVGs) ────────────────────────────

export const OverviewIcon = (): React.JSX.Element => (
  <LayoutDashboard size={16} strokeWidth={2} className="menu-icon" aria-hidden="true" />
)

export const ChatIcon = (): React.JSX.Element => (
  <MessageSquare size={16} strokeWidth={2} className="menu-icon" aria-hidden="true" />
)

export const SettingsIcon = (): React.JSX.Element => (
  <Settings size={16} strokeWidth={2} className="menu-icon" aria-hidden="true" />
)

export const SkillsIcon = (): React.JSX.Element => (
  <Bot size={16} strokeWidth={2} className="menu-icon" aria-hidden="true" />
)

export const CacheIcon = (): React.JSX.Element => (
  <Database size={16} strokeWidth={2} className="menu-icon" aria-hidden="true" />
)

export const PCIcon = (): React.JSX.Element => (
  <Monitor size={16} strokeWidth={2} className="menu-icon" aria-hidden="true" />
)
