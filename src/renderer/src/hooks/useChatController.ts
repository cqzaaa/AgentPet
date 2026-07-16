/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-explicit-any, react-hooks/refs */
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef } from 'react'
import type { PropsWithChildren, ReactElement } from 'react'
import { useAppStoreRaw } from './useAppStore'

type ChatActions = Record<string, (...args: any[]) => any>
type GetChatActions = () => ChatActions

const ChatActionsContext = createContext<GetChatActions | null>(null)
const EMPTY_MESSAGES: any[] = []

/** Keeps legacy commands available while the send pipeline is migrated out of useAppStore. */
export function ChatControllerProvider({ actions, children }: PropsWithChildren<{ actions: ChatActions }>): ReactElement {
  const actionsRef = useRef<ChatActions>(actions)
  useEffect(() => {
    actionsRef.current = actions
  }, [actions, actionsRef])
  const getActions = useCallback(() => actionsRef.current, [])
  return createElement(ChatActionsContext.Provider, { value: getActions }, children)
}

function useChatAction(name: string): (...args: any[]) => any {
  const getActions = useContext(ChatActionsContext)
  if (!getActions) throw new Error('useChatController must be used inside ChatControllerProvider')
  return useCallback((...args: any[]) => getActions()[name](...args), [getActions, name])
}

/**
 * Chat-only state subscriptions. A streaming update therefore re-renders this
 * consumer without making it depend on the aggregate AppStore object.
 */
export function useChatController() {
  const llmConfig = useAppStoreRaw(state => state.llmConfig)
  const activeSessionId = useAppStoreRaw(state => state.activeSessionId)
  const activeSession = useAppStoreRaw(state => state.sessions.find((session: any) => session.id === state.activeSessionId))
  const activeSessMessages = activeSession?.messages || EMPTY_MESSAGES
  const currentContextTokens = useAppStoreRaw(state => state.contextTokenUsageBySession[state.activeSessionId] || 1500)
  const isSending = useAppStoreRaw(state => !!state.sendingSessionIds[state.activeSessionId])
  const inputValue = useAppStoreRaw(state => state.inputValue)
  const availableModels = useAppStoreRaw(state => state.availableModels)
  const attachedFiles = useAppStoreRaw(state => state.attachedFiles)
  const highlightedMessageId = useAppStoreRaw(state => state.highlightedMessageId)
  const isSessionSwitching = useAppStoreRaw(state => state.isSessionSwitching)
  const executionDevice = useAppStoreRaw(state => state.executionDevice)
  const sshConnected = useAppStoreRaw(state => state.sshConnected)
  const sshHost = useAppStoreRaw(state => state.sshHost)
  const sshUsername = useAppStoreRaw(state => state.sshUsername)
  const activePermissionRequest = useAppStoreRaw(state => state.activePermissionRequest)
  const skillsList = useAppStoreRaw(state => state.skillsList)
  const disabledSkillNames = useAppStoreRaw(state => state.disabledSkillNames)
  const mcpConfig = useAppStoreRaw(state => state.mcpConfig)
  const avatarList = useAppStoreRaw(state => state.avatarList)
  const customModelDir = useAppStoreRaw(state => state.customModelDir)
  const customModelFile = useAppStoreRaw(state => state.customModelFile)

  const currentAvatarName = useMemo(() => {
    const avatar = avatarList.find((item: any) => (customModelDir ? item.dir === customModelDir : item.isDefault))
    return avatar?.name || (customModelFile ? customModelFile.replace(/\.model3\.json$/i, '') : 'Mao')
  }, [avatarList, customModelDir, customModelFile])

  return {
    llmConfig, activeSessionId, activeSessMessages, currentContextTokens, currentAvatarName, isSending,
    inputValue, availableModels, attachedFiles, highlightedMessageId, isSessionSwitching,
    executionDevice, sshConnected, sshHost, sshUsername, activePermissionRequest,
    skillsList, disabledSkillNames, mcpConfig,
    setInputValue: useChatAction('setInputValue'),
    handleSendChat: useChatAction('handleSendChat'),
    saveLlmConfig: useChatAction('saveLlmConfig'),
    setAttachedFiles: useChatAction('setAttachedFiles'),
    handlePasteFiles: useChatAction('handlePasteFiles'),
    handleUploadFile: useChatAction('handleUploadFile'),
    setHighlightedMessageId: useChatAction('setHighlightedMessageId'),
    handleAbortLlm: useChatAction('handleAbortLlm'),
    handleUpdateExecutionDevice: useChatAction('handleUpdateExecutionDevice'),
    handleConnectSsh: useChatAction('handleConnectSsh'),
    handleDisconnectSsh: useChatAction('handleDisconnectSsh'),
    showToast: useChatAction('showToast'),
    handleRespondPermission: useChatAction('handleRespondPermission'),
    toggleSkillEnable: useChatAction('toggleSkillEnable'),
    setActiveTab: useChatAction('setActiveTab'),
    setAgentSubTab: useChatAction('setAgentSubTab'),
    refreshSkillsAndStorage: useChatAction('refreshSkillsAndStorage'),
    refreshMcpServers: useChatAction('refreshMcpServers'),
    saveMcpConfig: useChatAction('saveMcpConfig'),
    handlePreviewFile: useChatAction('handlePreviewFile'),
    setShowFilePanel: useChatAction('setShowFilePanel')
  }
}
