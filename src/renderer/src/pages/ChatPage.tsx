/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-function-return-type, react-hooks/set-state-in-effect */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso'
import { getInternalClipboard, setInternalClipboard } from '../hooks/useAppStore'
import { useChatController } from '../hooks/useChatController'
import { ChatMessageItem } from '../components/ChatMessageItem'
import { getModelIcon } from '../utils/modelIcons'
import { estimateDraftTokens } from '../utils/contextBudget'
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Check,
  ChevronDown,
  Code2,
  FileKey2,
  FileText,
  FolderOpen,
  Globe2,
  KeyRound,
  Link,
  Monitor,
  Palette,
  Plug,
  Plus,
  Puzzle,
  Server,
  Settings2,
  ShieldAlert,
  Square,
  TriangleAlert,
  X
} from 'lucide-react'


// ── 模块级样式常量（避免每次渲染分配临时对象） ─────────────
const SEARCH_INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  padding: '5px 8px',
  fontSize: '11.5px',
  border: '1px solid var(--border-color, rgba(128,128,128,0.2))',
  borderRadius: '6px',
  background: 'var(--bg-input, rgba(128,128,128,0.04))',
  color: 'var(--text-color)',
  outline: 'none',
  boxSizing: 'border-box'
}

function ChatPageImpl(): React.JSX.Element {
  const {
    llmConfig,
    activeSessMessages,
    activeSessionId,
    currentAvatarName,
    isSending,
    inputValue, setInputValue,
    handleSendChat,
    availableModels,
    saveLlmConfig,
    attachedFiles,
    setAttachedFiles,
    handlePasteFiles,
    handleUploadFile,
    highlightedMessageId,
    setHighlightedMessageId,
    handleAbortLlm,
    isSessionSwitching,
    // SSH
    executionDevice,
    sshConnected,
    sshHost,
    sshUsername,
    handleUpdateExecutionDevice,
    handleConnectSsh,
    handleDisconnectSsh,
    showToast,
    // sandbox/permission
    activePermissionRequest,
    handleRespondPermission,
    // skills & mcp
    skillsList,
    disabledSkillNames,
    toggleSkillEnable,
    setActiveTab,
    setAgentSubTab,
    refreshSkillsAndStorage,
    refreshMcpServers,
    mcpConfig,
    saveMcpConfig,
    handlePreviewFile: previewFile,
    setShowFilePanel,
    currentContextTokens
  } = useChatController()

  const [previewImageSrc, setPreviewImageSrc] = useState<string | null>(null)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const messagesBoxRef = useRef<HTMLDivElement>(null)
  const virtuosoRef = useRef<VirtuosoHandle>(null)

  // 技能与 MCP Popover 状态与 Refs
  const [showSkillsPopover, setShowSkillsPopover] = useState(false)
  const [showMcpPopover, setShowMcpPopover] = useState(false)
  const [showModelPopover, setShowModelPopover] = useState(false)
  const [approvalDetailsExpanded, setApprovalDetailsExpanded] = useState(false)
  const [approvalMenuOpen, setApprovalMenuOpen] = useState(false)
  const skillsPopoverRef = useRef<HTMLDivElement>(null)
  const mcpPopoverRef = useRef<HTMLDivElement>(null)
  const modelPopoverRef = useRef<HTMLDivElement>(null)

  // 搜索过滤
  const [skillsSearchKey, setSkillsSearchKey] = useState('')
  const [mcpSearchKey, setMcpSearchKey] = useState('')
  const [modelSearchKey, setModelSearchKey] = useState('')

  // 列表溢出检测（仅溢出时显示搜索框）
  const skillsListRef = useRef<HTMLDivElement>(null)
  const mcpListRef = useRef<HTMLDivElement>(null)
  const [skillsOverflow, setSkillsOverflow] = useState(false)
  const [mcpOverflow, setMcpOverflow] = useState(false)

  // 检测列表是否溢出
  useEffect(() => {
    if (showSkillsPopover && skillsListRef.current) {
      const el = skillsListRef.current
      setSkillsOverflow(el.scrollHeight > el.clientHeight)
    } else {
      setSkillsSearchKey('')
    }
  }, [showSkillsPopover, skillsList])

  useEffect(() => {
    if (showMcpPopover && mcpListRef.current) {
      const el = mcpListRef.current
      setMcpOverflow(el.scrollHeight > el.clientHeight)
    } else {
      setMcpSearchKey('')
    }
  }, [showMcpPopover, mcpConfig])

  useEffect(() => {
    if (!showModelPopover) {
      setModelSearchKey('')
    }
  }, [showModelPopover])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (showSkillsPopover && skillsPopoverRef.current && !skillsPopoverRef.current.contains(event.target as Node)) {
        // 只有在点击非按钮（或者非 popover 内部）时才关闭，为了保证按钮点击切换正常，我们仅检查 popover 外部
        // 因为点击按钮时如果直接在 handleClickOutside 触发关闭，会和按钮本身的 onClick 冲突（按钮点击 -> handleClickOutside(由于非popover内) -> 关闭 -> 按钮onClick -> 打开。结果又打开了）
        // 实际上, 我们只要判断如果点击的 target 在 Popover 之外，且不在对应的 Button 内部，就将其关闭
        // 更好的办法是：如果点击了 Popover 以外的任何元素，关闭它
        const isClickOnBtn = (event.target as HTMLElement).closest('.toolbar-action-btn-skills')
        if (!isClickOnBtn) {
          setShowSkillsPopover(false)
        }
      }
      if (showMcpPopover && mcpPopoverRef.current && !mcpPopoverRef.current.contains(event.target as Node)) {
        const isClickOnBtn = (event.target as HTMLElement).closest('.toolbar-action-btn-mcp')
        if (!isClickOnBtn) {
          setShowMcpPopover(false)
        }
      }
      if (showModelPopover && modelPopoverRef.current && !modelPopoverRef.current.contains(event.target as Node)) {
        const isClickOnBtn = (event.target as HTMLElement).closest('.model-dropdown-container')
        if (!isClickOnBtn) {
          setShowModelPopover(false)
        }
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showSkillsPopover, showMcpPopover, showModelPopover])

  // 挂载时刷新技能与 MCP 状态
  useEffect(() => {
    refreshSkillsAndStorage()
    refreshMcpServers()
  }, [])

  // 搜索输入框公共样式 — 使用模块级常量
  const searchInputStyle = SEARCH_INPUT_STYLE

  // MCP 服务开关切换
  const toggleMcpServerEnable = useCallback((serverId: string) => {
    const newConfig = {
      ...mcpConfig,
      servers: mcpConfig.servers.map((s: any) =>
        s.id === serverId ? { ...s, enabled: !s.enabled } : s
      )
    }
    saveMcpConfig(newConfig)
  }, [mcpConfig, saveMcpConfig])

  // 全部 MCP 服务列表（用于 popover 展示，含未启用的）
  const allMcpServers: any[] = mcpConfig?.servers || []

  const renderSkillsPopover = () => {
    const filtered = skillsSearchKey
      ? skillsList.filter(s => s.name.toLowerCase().includes(skillsSearchKey.toLowerCase()))
      : skillsList
    return (
      <div
        ref={skillsPopoverRef}
        className="chat-popover-card"
        style={{
          position: 'absolute',
          bottom: 'calc(100% + 8px)',
          right: 0,
          width: '260px',
          background: 'var(--bg-card, #ffffff)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid var(--border-color, rgba(128,128,128,0.2))',
          borderRadius: '10px',
          boxShadow: '0 6px 20px rgba(0, 0, 0, 0.12)',
          zIndex: 1000,
          padding: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          animation: 'slideUpMenu 0.15s ease-out'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color, rgba(128,128,128,0.12))', paddingBottom: '6px' }}>
          <span style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--text-color)', display: 'inline-flex', alignItems: 'center' }}>
            <Puzzle size={15} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />
            已装载的技能包
          </span>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>勾选在会话中启用</span>
        </div>
        {/* 搜索框：仅在列表溢出时显示 */}
        {skillsOverflow && (
          <input
            style={searchInputStyle}
            placeholder="搜索技能..."
            value={skillsSearchKey}
            onChange={e => setSkillsSearchKey(e.target.value)}
            autoFocus
          />
        )}
        <div
          ref={skillsListRef}
          style={{ maxHeight: '180px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px', padding: '2px 0' }}
        >
          {filtered.length === 0 ? (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center', padding: '12px 0' }}>
              {skillsList.length === 0 ? '暂未安装任何技能扩展包' : '无匹配的技能'}
            </div>
          ) : (
            filtered.map(skill => {
              const isEnabled = !disabledSkillNames.includes(skill.name)
              return (
                <label
                  key={skill.name}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                    fontSize: '12.5px',
                    cursor: 'pointer',
                    padding: '4px 6px',
                    borderRadius: '4px',
                    transition: 'background 0.15s ease',
                    userSelect: 'none'
                  }}
                  onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--bg-menu-hover, rgba(128,128,128,0.04))'}
                  onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                >
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: isEnabled ? 'var(--text-color)' : 'var(--text-muted)',
                      fontWeight: isEnabled ? 500 : 400,
                      flex: 1
                    }}
                    title={skill.name}
                  >
                    {skill.name.replace(/\.zip$/i, '')}
                  </span>
                  {/* CSS Toggle Switch */}
                  <div style={{ position: 'relative', width: '28px', height: '16px', borderRadius: '8px', backgroundColor: isEnabled ? 'var(--accent-color, #4f8cff)' : 'var(--border-color, rgba(128,128,128,0.3))', transition: 'background-color 0.2s ease', flexShrink: 0 }}>
                    <div style={{
                      position: 'absolute',
                      top: '2px',
                      left: isEnabled ? '14px' : '2px',
                      width: '12px',
                      height: '12px',
                      backgroundColor: '#ffffff',
                      borderRadius: '50%',
                      transition: 'left 0.2s ease',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
                    }} />
                    <input
                      type="checkbox"
                      checked={isEnabled}
                      onChange={() => toggleSkillEnable(skill.name)}
                      style={{ opacity: 0, width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, margin: 0, cursor: 'pointer' }}
                    />
                  </div>
                </label>
              )
            })
          )}
        </div>
        <div style={{ borderTop: '1px solid var(--border-color, rgba(128,128,128,0.12))', paddingTop: '6px', marginTop: '4px' }}>
          <button
            style={{
              width: '100%',
              padding: '6px 0',
              fontSize: '11.5px',
              fontWeight: 600,
              color: 'var(--accent-color, #4f8cff)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '4px'
            }}
            onClick={() => {
              setShowSkillsPopover(false)
              setActiveTab('agent')
              setAgentSubTab('skills')
            }}
          >
            <Settings2 size={14} strokeWidth={2} aria-hidden="true" />
            前往管理技能包
          </button>
        </div>
      </div>
    )
  }

  const renderMcpPopover = () => {
    const filtered = mcpSearchKey
      ? allMcpServers.filter((s: any) => s.name.toLowerCase().includes(mcpSearchKey.toLowerCase()))
      : allMcpServers
    return (
      <div
        ref={mcpPopoverRef}
        className="chat-popover-card"
        style={{
          position: 'absolute',
          bottom: 'calc(100% + 8px)',
          right: 0,
          width: '260px',
          background: 'var(--bg-card, #ffffff)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid var(--border-color, rgba(128,128,128,0.2))',
          borderRadius: '10px',
          boxShadow: '0 6px 20px rgba(0, 0, 0, 0.12)',
          zIndex: 1000,
          padding: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          animation: 'slideUpMenu 0.15s ease-out'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color, rgba(128,128,128,0.12))', paddingBottom: '6px' }}>
          <span style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--text-color)', display: 'inline-flex', alignItems: 'center' }}>
            <Link size={15} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />
            MCP 服务
          </span>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>勾选启用服务</span>
        </div>
        {/* 搜索框：仅在列表溢出时显示 */}
        {mcpOverflow && (
          <input
            style={searchInputStyle}
            placeholder="搜索 MCP 服务..."
            value={mcpSearchKey}
            onChange={e => setMcpSearchKey(e.target.value)}
            autoFocus
          />
        )}
        <div
          ref={mcpListRef}
          style={{ maxHeight: '180px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px', padding: '2px 0' }}
        >
          {filtered.length === 0 ? (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center', padding: '12px 0' }}>
              {allMcpServers.length === 0 ? '暂未配置任何 MCP 服务' : '无匹配的 MCP 服务'}
            </div>
          ) : (
            filtered.map((server: any) => (
              <label
                key={server.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                  fontSize: '12.5px',
                  cursor: 'pointer',
                  padding: '4px 6px',
                  borderRadius: '4px',
                  transition: 'background 0.15s ease',
                  userSelect: 'none'
                }}
                onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--bg-menu-hover, rgba(128,128,128,0.04))'}
                onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
              >
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: server.enabled ? 'var(--text-color)' : 'var(--text-muted)',
                    fontWeight: server.enabled ? 500 : 400,
                    flex: 1
                  }}
                  title={server.name}
                >
                  {server.name}
                </span>
                {/* CSS Toggle Switch */}
                <div style={{ position: 'relative', width: '28px', height: '16px', borderRadius: '8px', backgroundColor: server.enabled ? 'var(--accent-color, #4f8cff)' : 'var(--border-color, rgba(128,128,128,0.3))', transition: 'background-color 0.2s ease', flexShrink: 0 }}>
                  <div style={{
                    position: 'absolute',
                    top: '2px',
                    left: server.enabled ? '14px' : '2px',
                    width: '12px',
                    height: '12px',
                    backgroundColor: '#ffffff',
                    borderRadius: '50%',
                    transition: 'left 0.2s ease',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
                  }} />
                  <input
                    type="checkbox"
                    checked={!!server.enabled}
                    onChange={() => toggleMcpServerEnable(server.id)}
                    style={{ opacity: 0, width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, margin: 0, cursor: 'pointer' }}
                  />
                </div>
              </label>
            ))
          )}
        </div>
        <div style={{ borderTop: '1px solid var(--border-color, rgba(128,128,128,0.12))', paddingTop: '6px', marginTop: '4px' }}>
          <button
            style={{
              width: '100%',
              padding: '6px 0',
              fontSize: '11.5px',
              fontWeight: 600,
              color: 'var(--accent-color, #4f8cff)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '4px'
            }}
            onClick={() => {
              setShowMcpPopover(false)
              setActiveTab('agent')
              setAgentSubTab('mcp')
            }}
          >
            <Settings2 size={14} strokeWidth={2} aria-hidden="true" />
            前往管理 MCP 服务
          </button>
        </div>
      </div>
    )
  }

  // 整合当前可选的所有模型列表（包含已有的 availableModels，以及当前正选中的自定义模型）
  const displayModels = useMemo(() => {
    const list = [...availableModels]
    if (llmConfig.model && !list.includes(llmConfig.model)) {
      list.push(llmConfig.model)
    }
    return list
  }, [availableModels, llmConfig.model])

  // 根据 modelSearchKey 过滤模型列表
  const filteredModels = useMemo(() => {
    if (!modelSearchKey) return displayModels
    return displayModels.filter(m => m.toLowerCase().includes(modelSearchKey.toLowerCase()))
  }, [displayModels, modelSearchKey])

  // 决定是否出现滑动条和搜索框（模型总数 >= 8）
  const isModelOverflow = displayModels.length >= 8

  const renderModelPopover = () => {
    return (
      <div
        ref={modelPopoverRef}
        className="chat-popover-card"
        style={{
          position: 'absolute',
          bottom: 'calc(100% + 8px)',
          left: 0,
          width: '240px',
          background: 'var(--bg-card, #ffffff)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid var(--border-color, rgba(128,128,128,0.2))',
          borderRadius: '10px',
          boxShadow: '0 6px 20px rgba(0, 0, 0, 0.12)',
          zIndex: 1000,
          padding: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          animation: 'slideUpMenu 0.15s ease-out'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color, rgba(128,128,128,0.12))', paddingBottom: '6px' }}>
          <span style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--text-color)' }}>选择模型</span>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>共 {displayModels.length} 个模型</span>
        </div>
        {/* 搜索框：仅在列表项数量 >= 8 时显示 */}
        {isModelOverflow && (
          <input
            style={searchInputStyle}
            placeholder="搜索模型..."
            value={modelSearchKey}
            onChange={e => setModelSearchKey(e.target.value)}
            autoFocus
          />
        )}
        <div
          style={{
            maxHeight: isModelOverflow ? '220px' : 'none',
            overflowY: isModelOverflow ? 'auto' : 'visible',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            padding: '2px 0'
          }}
        >
          {filteredModels.length === 0 ? (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center', padding: '12px 0' }}>
              无匹配的模型
            </div>
          ) : (
            filteredModels.map(modelName => {
              const isSelected = llmConfig.model === modelName
              return (
                <div
                  key={modelName}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                    fontSize: '12.5px',
                    cursor: 'pointer',
                    padding: '6px 8px',
                    borderRadius: '6px',
                    transition: 'background 0.15s ease, color 0.15s ease',
                    userSelect: 'none',
                    backgroundColor: isSelected ? 'var(--accent-color, #4f8cff)' : 'transparent',
                    color: isSelected ? '#ffffff' : 'var(--text-color)'
                  }}
                  onClick={() => {
                    saveLlmConfig({ ...llmConfig, model: modelName })
                    setShowModelPopover(false)
                  }}
                  onMouseEnter={e => {
                    if (!isSelected) {
                      e.currentTarget.style.backgroundColor = 'var(--bg-menu-hover, rgba(128,128,128,0.04))'
                    }
                  }}
                  onMouseLeave={e => {
                    if (!isSelected) {
                      e.currentTarget.style.backgroundColor = 'transparent'
                    }
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1, minWidth: 0 }}>
                    <img
                      src={getModelIcon(modelName, llmConfig.provider)}
                      alt=""
                      style={{
                        width: '14px',
                        height: '14px',
                        borderRadius: '3px',
                        flexShrink: 0,
                        objectFit: 'contain',
                        filter: isSelected ? 'brightness(1.1) drop-shadow(0 1px 2px rgba(255,255,255,0.25))' : 'none'
                      }}
                    />
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontWeight: isSelected ? 600 : 400,
                        flex: 1
                      }}
                      title={modelName}
                    >
                      {modelName}
                    </span>
                  </div>
                  {isSelected && (
                    <Check size={14} strokeWidth={2} aria-hidden="true" />
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>
    )
  }



  // 上下文安全额度环机制
  const [showContextTooltip, setShowContextTooltip] = useState(false)
  const contextLimit = Number((llmConfig as any).contextWindow) || 168000
  const estimatedContextTokens = useMemo(
    () => currentContextTokens + estimateDraftTokens(inputValue, attachedFiles),
    [attachedFiles, currentContextTokens, inputValue]
  )


  const contextPercent = useMemo(() => {
    return Math.min(100, (estimatedContextTokens / contextLimit) * 100)
  }, [contextLimit, estimatedContextTokens])

  const handleSendIntercept = () => {
    if (estimatedContextTokens >= contextLimit) {
      showToast('上下文额度已用满，请创建新会话以继续对话！', 'error')
      return
    }
    handleSendChat()
  }

  // SSH 弹窗控制本地状态
  const [showSshModal, setShowSshModal] = useState(false)
  const [sshForm, setSshForm] = useState(() => {
    try {
      const saved = localStorage.getItem('agentpet_last_ssh_config')
      if (saved) {
        return JSON.parse(saved)
      }
    } catch (e) {
      console.error('加载缓存的 SSH 配置失败', e)
    }
    return {
      host: '',
      port: '22',
      username: 'root',
      password: '',
      authType: 'password', // 'password' | 'privateKey'
      privateKey: ''
    }
  })
  const [testSshStatus, setTestSshStatus] = useState<{ type: 'idle' | 'testing' | 'success' | 'error'; message: string }>({ type: 'idle', message: '' })
  const [connectSshLoading, setConnectSshLoading] = useState(false)

  // 设备下拉菜单控制状态与 Ref
  const [showDeviceMenu, setShowDeviceMenu] = useState(false)
  const deviceMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (deviceMenuRef.current && !deviceMenuRef.current.contains(event.target as Node)) {
        setShowDeviceMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const getMenuItemStyle = (isActive: boolean) => ({
    padding: '8px 12px',
    cursor: 'pointer',
    fontSize: '12.5px',
    display: 'flex',
    alignItems: 'center',
    backgroundColor: 'transparent',
    color: isActive ? 'var(--accent-color, #4f8cff)' : 'var(--text-color)',
    fontWeight: isActive ? 600 : 400,
    transition: 'background 0.15s ease',
    userSelect: 'none' as const
  })

  const handleMenuItemMouseEnter = (e: React.MouseEvent<HTMLDivElement>) => {
    e.currentTarget.style.backgroundColor = 'var(--bg-menu-hover, rgba(128,128,128,0.06))'
  }

  const handleMenuItemMouseLeave = (e: React.MouseEvent<HTMLDivElement>) => {
    e.currentTarget.style.backgroundColor = 'transparent'
  }

  // 检测是否在底部附近（阈值 100px）
  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    setShowScrollToBottom(!atBottom)
  }, [])

  // 追踪 isSending 状态变化，在发送时和回复完成时滚动到底部
  const prevIsSendingRef = useRef(isSending)
  useEffect(() => {
    const wasSending = prevIsSendingRef.current
    prevIsSendingRef.current = isSending

    if (isSending && !wasSending) {
      // 用户刚发送消息 — 立即滚动到底部
      setTimeout(() => {
        virtuosoRef.current?.scrollToIndex({ index: activeSessMessages.length - 1, align: 'end', behavior: 'smooth' })
      }, 50)
    }

    if (!isSending && wasSending) {
      // AI 回复完成 — 滚动到底部，让用户看到完整回复
      setTimeout(() => {
        virtuosoRef.current?.scrollToIndex({ index: activeSessMessages.length - 1, align: 'end', behavior: 'smooth' })
      }, 100)
    }
  }, [isSending])

  const handlePreviewFile = useCallback((f: { name: string; path: string; size: number }) => {
    previewFile(f)
    setShowFilePanel(true)
  }, [previewFile, setShowFilePanel])

  // 切换会话时重置滚动状态
  useEffect(() => {
    setShowScrollToBottom(false)
  }, [activeSessionId])

  useEffect(() => {
    setApprovalDetailsExpanded(false)
    setApprovalMenuOpen(false)
  }, [activePermissionRequest])

  const scrollToBottom = () => {
    virtuosoRef.current?.scrollToIndex({ index: activeSessMessages.length - 1, align: 'end', behavior: 'smooth' })
  }

  const handleImageContextMenu = (e: React.MouseEvent, imgSrc: string) => {
    e.preventDefault()
    if (window.api && typeof window.api.showImageContextMenu === 'function') {
      window.api.showImageContextMenu(imgSrc)
    }
  }

  // 监听定位跳转事件，平滑滚动并高亮消息
  useEffect(() => {
    if (highlightedMessageId) {
      const timer = setTimeout(() => {
        const element = document.getElementById(`msg-${highlightedMessageId}`)
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' })
          // 闪烁 2.5 秒后清除高亮标记
          setTimeout(() => {
            setHighlightedMessageId(null)
          }, 2500)
        }
      }, 150)
      return () => clearTimeout(timer)
    }
    return () => { }
  }, [highlightedMessageId, setHighlightedMessageId])

  useEffect(() => {
    // 全局阻止浏览器默认的拖拽打开文件行为，防止不小心把文件拖到页面空白处导致应用跳转
    const preventDefault = (e: any) => e.preventDefault()
    window.addEventListener('dragover', preventDefault)
    window.addEventListener('drop', preventDefault)
    return () => {
      window.removeEventListener('dragover', preventDefault)
      window.removeEventListener('drop', preventDefault)
    }
  }, [])

  // Keep the virtual list data stable while only a message's streaming text is
  // changing. Virtuoso now tracks lightweight IDs instead of full messages.
  const messageIdsRef = useRef<Array<string | number>>([])
  const messageIds = useMemo(() => {
    const next = activeSessMessages.map((message: any) => message.id as string | number)
    const previous = messageIdsRef.current
    if (previous.length === next.length && previous.every((id, index) => id === next[index])) {
      return previous
    }
    messageIdsRef.current = next
    return next
  }, [activeSessMessages])

  // Build message and request relationships once per message update. This
  // replaces the previous slice(0, index).findLast(...) work performed by
  // every visible row during every streaming frame.
  const { messageById, requestMessageById } = useMemo(() => {
    const byId = new Map<string | number, any>()
    const requestById = new Map<string | number, any>()
    let latestUserMessage: any = undefined
    for (const message of activeSessMessages) {
      byId.set(message.id, message)
      if (message.sender === 'user') latestUserMessage = message
      else if (message.sender === 'agent' && latestUserMessage) requestById.set(message.id, latestUserMessage)
    }
    return { messageById: byId, requestMessageById: requestById }
  }, [activeSessMessages])

  const itemContent = useCallback((_index: number, messageId: string | number) => {
    const message = messageById.get(messageId)
    if (!message) return null
    return (
      <ChatMessageItem
        msg={message}
        currentAvatarName={currentAvatarName}
        requestMessage={requestMessageById.get(messageId)}
        highlightedMessageId={highlightedMessageId}
        onPreviewFile={handlePreviewFile}
      />
    )
  }, [messageById, requestMessageById, currentAvatarName, highlightedMessageId, handlePreviewFile])

  const computeMessageKey = useCallback((_index: number, messageId: string | number) => messageId, [])

  const approvalCommand = activePermissionRequest?.command || '内置 API 调用'
  const approvalWarning = (activePermissionRequest as any)?.warning || '这项操作需要你确认后才会继续执行。'
  const approvalIsDangerous = /删除|高危|rm\b|del\b|remove-item|delete/i.test(`${approvalCommand}\n${approvalWarning}`)
  const approvalLines = approvalCommand.split(/\r?\n/)
  const approvalHasMore = approvalLines.length > 6 || approvalCommand.length > 700
  const approvalPreview = approvalDetailsExpanded
    ? approvalCommand
    : approvalLines.slice(0, 6).join('\n').slice(0, 700)

  return (
    <div className="chat-split-container">
      <div
        className="chat-main"
        style={{ display: 'flex', flexDirection: 'column', height: '100%', flex: 1 }}
        onDragOver={e => e.preventDefault()}
        onDrop={e => {
          e.preventDefault()
          if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handlePasteFiles(e.dataTransfer.files)
          }
        }}
      >
        {/* 消息滚动列表 */}
        {/* 消息滚动列表 */}
        <div className="chat-messages-box" ref={messagesBoxRef}>
          {isSessionSwitching ? (
            <div className="chat-skeleton-container">
              <div className="skeleton-message agent">
                <div className="skeleton-header">
                  <div className="skeleton-avatar"></div>
                  <div className="skeleton-name"></div>
                </div>
                <div className="skeleton-bubble long"></div>
              </div>
              <div className="skeleton-message user">
                <div className="skeleton-header">
                  <div className="skeleton-avatar"></div>
                  <div className="skeleton-name"></div>
                </div>
                <div className="skeleton-bubble short"></div>
              </div>
              <div className="skeleton-message agent">
                <div className="skeleton-header">
                  <div className="skeleton-avatar"></div>
                  <div className="skeleton-name"></div>
                </div>
                <div className="skeleton-bubble medium"></div>
              </div>
            </div>
          ) : activeSessMessages.length === 0 ? (
            <div className="chat-empty-state">
              <h1 className="chat-empty-title">{currentAvatarName}, 我帮你</h1>
              <div className="chat-empty-suggestions">
                <div className="suggestion-chip" onClick={() => setInputValue('帮我处理一下这份文档的内容，提取关键信息')}>
                  <FileText size={20} strokeWidth={2} className="chip-icon" aria-hidden="true" />文档处理
                </div>
                <div className="suggestion-chip" onClick={() => setInputValue('帮我分析这组数据并生成一份可视化报告')}>
                  <BarChart3 size={20} strokeWidth={2} className="chip-icon" aria-hidden="true" />数据分析与可视化
                </div>
                <div className="suggestion-chip" onClick={() => setInputValue('请为我构思一个独特的UI设计方案')}>
                  <Palette size={20} strokeWidth={2} className="chip-icon" aria-hidden="true" />设计创意
                </div>
                <div className="suggestion-chip" onClick={() => setInputValue('用最佳实践编写这段代码功能')}>
                  <Code2 size={20} strokeWidth={2} className="chip-icon" aria-hidden="true" />代码开发
                </div>
              </div>
            </div>
          ) : (
            <Virtuoso
              key={activeSessionId}
              ref={virtuosoRef}
              style={{ height: '100%' }}
              data={messageIds}
              computeItemKey={computeMessageKey}
              // 流式 token 到达时使用即时跟随；反复启动 smooth 动画会让长回答滚动发飘。
              followOutput={(isAtBottom) => isAtBottom ? 'auto' : false}
              initialTopMostItemIndex={999999}
              atBottomStateChange={handleAtBottomStateChange}
              itemContent={itemContent}
            />
          )}
          {showScrollToBottom && (
            <button className="scroll-to-bottom-btn" onClick={scrollToBottom} title="回到最新">
              <ArrowDown size={16} strokeWidth={2} aria-hidden="true" />
              回到最新
            </button>
          )}
        </div>

        {/* 附件在输入框上方的实时预览 */}
        {attachedFiles && attachedFiles.length > 0 && (
          <div className="input-files-preview-container" style={{ display: 'flex', gap: '8px', padding: '0 16px 8px', flexWrap: 'wrap', overflowX: 'auto' }}>
            {attachedFiles.map((file, idx) => (
              <div key={idx} className="input-file-preview" style={{ margin: 0, position: 'relative', display: 'flex', alignItems: 'center', backgroundColor: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)', borderRadius: '8px', padding: '6px 12px' }}>
                {file.objectUrl ? (
                  <img
                    src={file.objectUrl}
                    alt={file.name}
                    style={{ width: '24px', height: '24px', objectFit: 'cover', borderRadius: '4px', marginRight: '8px', cursor: 'pointer' }}
                    onClick={() => setPreviewImageSrc(file.objectUrl || null)}
                  />
                ) : (
                  <FileText size={17} strokeWidth={2} className="preview-icon" style={{ marginRight: '6px' }} aria-hidden="true" />
                )}
                <span className="preview-name" title={file.name} style={{ maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '13px' }}>{file.name}</span>
                <button className="preview-remove-btn" onClick={() => setAttachedFiles(prev => prev.filter((_, i) => i !== idx))} title="移除文件" style={{ marginLeft: '8px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', padding: '2px' }}>
                  <X size={14} strokeWidth={2} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}

        {false && activePermissionRequest && (
          <div className="permission-approval-card" style={{
            margin: '0 16px 12px 16px',
            background: 'var(--bg-card, #ffffff)',
            border: '1.5px solid var(--border-color, rgba(128,128,128,0.25))',
            borderRadius: '12px',
            boxShadow: '0 8px 30px rgba(0, 0, 0, 0.08)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            animation: 'slideUpMenu 0.22s cubic-bezier(0.34, 1.56, 0.64, 1)'
          }}>
            {/* 头部标题区域 */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 16px',
              borderBottom: '1px solid var(--border-color, rgba(128,128,128,0.12))',
              backgroundColor: 'var(--bg-card-sub, rgba(128,128,128,0.03))'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13.5px', fontWeight: 700, color: 'var(--text-color)' }}>
                <ShieldAlert size={17} strokeWidth={2} aria-hidden="true" />
                <span>问题</span>
              </div>
              <span className="approval-status-pulse" style={{ fontSize: '12px', color: 'var(--accent-color, #4f8cff)', fontWeight: 600 }}>
                等待核对审批...
              </span>
            </div>

            {/* 内容区域 */}
            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ fontSize: '13px', lineHeight: 1.5, color: 'var(--text-color)' }}>
                {(activePermissionRequest as any).warning ? (
                  <div style={{ color: '#ef4444', fontWeight: 600, marginBottom: '8px', display: 'flex', alignItems: 'flex-start', gap: '4px' }}>
                    <TriangleAlert size={15} strokeWidth={2} style={{ transform: 'translateY(1px)' }} aria-hidden="true" />
                    <span>{(activePermissionRequest as any).warning}</span>
                  </div>
                ) : (
                  <div style={{ color: '#ef4444', fontWeight: 600, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <TriangleAlert size={15} strokeWidth={2} aria-hidden="true" />
                    检测到文件删除等敏感指令，系统默认不授予自动执行权限：
                  </div>
                )}

                <div style={{
                  background: 'var(--bg-card-sub, rgba(128,128,128,0.04))',
                  padding: '12px 14px',
                  borderRadius: '8px',
                  border: '1px dashed var(--border-color, rgba(128,128,128,0.25))',
                  fontFamily: 'Consolas, Monaco, monospace',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  fontSize: '12.5px',
                  color: 'var(--text-color-strong)'
                }}>
                  {activePermissionRequest.command || '内置 API: delete_file'}
                </div>

                {activePermissionRequest.execCwd && (
                  <div style={{ marginTop: '8px', color: 'var(--text-muted)', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <FolderOpen size={14} strokeWidth={2} aria-hidden="true" />
                    <span>执行路径:</span>
                    <span style={{ fontFamily: 'monospace' }}>{activePermissionRequest.execCwd}</span>
                  </div>
                )}
              </div>

              {/* 选项卡片 (类似用户截图中的 A、B 选项) */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div
                  onClick={() => handleRespondPermission(true)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '10px 14px',
                    borderRadius: '8px',
                    border: '1px solid var(--border-color, rgba(128,128,128,0.15))',
                    background: 'var(--bg-card-sub, rgba(128,128,128,0.03))',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    fontSize: '13px',
                    fontWeight: 500,
                    userSelect: 'none'
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.borderColor = '#10b981'
                    e.currentTarget.style.backgroundColor = 'rgba(16,185,129,0.05)'
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.borderColor = 'var(--border-color, rgba(128,128,128,0.15))'
                    e.currentTarget.style.backgroundColor = 'var(--bg-card-sub, rgba(128,128,128,0.03))'
                  }}
                >
                  <div style={{
                    width: '18px',
                    height: '18px',
                    borderRadius: '4px',
                    border: '1px solid #10b981',
                    color: '#10b981',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '11px',
                    fontWeight: 'bold',
                    marginRight: '12px',
                    backgroundColor: 'rgba(16,185,129,0.08)'
                  }}>A</div>
                  <span style={{ color: 'var(--text-color)', fontWeight: 600 }}>确认允许执行</span>
                  <span style={{ marginLeft: 'auto', color: '#10b981', fontWeight: 'bold', fontSize: '14px' }}>&gt;</span>
                </div>

                <div
                  onClick={() => handleRespondPermission(false)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '10px 14px',
                    borderRadius: '8px',
                    border: '1px solid var(--border-color, rgba(128,128,128,0.15))',
                    background: 'var(--bg-card-sub, rgba(128,128,128,0.03))',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    fontSize: '13px',
                    fontWeight: 500,
                    userSelect: 'none'
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.borderColor = '#ef4444'
                    e.currentTarget.style.backgroundColor = 'rgba(239,68,68,0.05)'
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.borderColor = 'var(--border-color, rgba(128,128,128,0.15))'
                    e.currentTarget.style.backgroundColor = 'var(--bg-card-sub, rgba(128,128,128,0.03))'
                  }}
                >
                  <div style={{
                    width: '18px',
                    height: '18px',
                    borderRadius: '4px',
                    border: '1px solid #ef4444',
                    color: '#ef4444',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '11px',
                    fontWeight: 'bold',
                    marginRight: '12px',
                    backgroundColor: 'rgba(239,68,68,0.08)'
                  }}>B</div>
                  <span style={{ color: '#ef4444', fontWeight: 600 }}>取消并拦截</span>
                  <span style={{ marginLeft: 'auto', color: '#ef4444', fontWeight: 'bold', fontSize: '14px' }}>&gt;</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 现代卡片式输入控制面板 */}
        <div className="chat-control-card">
          {/* 人机协作安全核对面板：锚定在输入框上方 */}
          {activePermissionRequest && (
            <section className={`permission-approval-card compact ${approvalIsDangerous ? 'is-danger' : ''}`}>
              <div className="approval-card-head">
                <div className="approval-card-title">
                  <span className="approval-icon">⌁</span>
                  <div>
                    <div className="approval-kicker">{approvalIsDangerous ? '高风险操作' : '需要审批'}</div>
                    <div className="approval-title">是否允许执行这项操作？</div>
                  </div>
                </div>
                <span className="approval-status-pulse">等待确认</span>
              </div>

              <div className="approval-card-body">
                <p className="approval-reason">{approvalWarning}</p>

                <div className="approval-command-box">
                  <pre>{approvalPreview}{!approvalDetailsExpanded && approvalHasMore ? '\n...' : ''}</pre>
                  {approvalHasMore && (
                    <button
                      type="button"
                      className="approval-link-button"
                      onClick={() => setApprovalDetailsExpanded(prev => !prev)}
                    >
                      {approvalDetailsExpanded ? '收起详情' : '展开详情'}
                    </button>
                  )}
                </div>

                {activePermissionRequest.execCwd && (
                  <div className="approval-meta">
                    <span>目录</span>
                    <code>{activePermissionRequest.execCwd}</code>
                  </div>
                )}

                <div className="approval-actions">
                  <button
                    type="button"
                    className="approval-action reject"
                    onClick={() => handleRespondPermission(false)}
                  >
                    拒绝
                  </button>

                  <div className="approval-allow-group">
                    <button
                      type="button"
                      className="approval-action allow"
                      onClick={() => handleRespondPermission(true)}
                    >
                      允许一次
                    </button>
                    <button
                      type="button"
                      className="approval-action allow menu"
                      onClick={() => setApprovalMenuOpen(prev => !prev)}
                      aria-label="更多允许选项"
                      aria-expanded={approvalMenuOpen}
                    >
                      <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
                    </button>
                    {approvalMenuOpen && (
                      <div className="approval-menu">
                        <button
                          type="button"
                          onClick={() => handleRespondPermission(true, 'turn')}
                        >
                          本次提问全部允许
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </section>
          )}

          <textarea
            className="chat-textarea-field"
            rows={2}
            placeholder={
              estimatedContextTokens >= contextLimit
                ? '上下文额度已用满，请创建新会话以继续对话！'
                : isSending
                  ? `${currentAvatarName} 正在思考中...`
                  : `输入指令并发送给 ${currentAvatarName} ...`
            }
            value={inputValue}
            disabled={isSending || estimatedContextTokens >= contextLimit}
            onChange={e => setInputValue(e.target.value)}
            onPaste={async e => {
              // 优先检查内部剪贴板（从消息复制的文件+文本）
              const internalClip = getInternalClipboard()
              if (internalClip && internalClip.files.length > 0) {
                e.preventDefault()
                setInternalClipboard(null)
                // 先同步插入文本，避免等待文件复制/解析 IPC 期间输入框看不到粘贴内容
                if (internalClip.text) {
                  setInputValue(prev => prev ? prev + internalClip.text : internalClip.text)
                }
                // 异步将内部剪贴板文件转为附件（复制到当前会话目录确保路径有效），完成后追加到附件列表
                Promise.all(internalClip.files.map(async f => {
                  const ext = f.name.split('.').pop()?.toLowerCase() || ''
                  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg']
                  const isImage = imageExts.includes(ext)
                  // 将文件复制到当前会话目录，确保路径有效
                  let filePath = f.path
                  if (window.api.copyToChatFile) {
                    const result = await window.api.copyToChatFile(activeSessionId, f.path)
                    filePath = result.path
                  }
                  // 如果没有预加载内容，尝试解析文件内容
                  let content = f.content
                  if (!content && filePath) {
                    try {
                      content = await window.api.parseFileContent(filePath)
                    } catch { /* 忽略解析失败 */ }
                  }
                  return {
                    name: f.name,
                    path: filePath,
                    content,
                    objectUrl: isImage ? `local-file:///${filePath.replace(/\\/g, '/')}` : undefined
                  }
                })).then(newAttachments => {
                  setAttachedFiles(prev => [...prev, ...newAttachments])
                })
                return
              }
              // 系统剪贴板文件（图片等）
              if (e.clipboardData.files && e.clipboardData.files.length > 0) {
                e.preventDefault()
                handlePasteFiles(e.clipboardData.files)
              }
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSendIntercept()
              }
            }}
          />

          <div className="chat-control-toolbar">
            {/* 左侧：模型切换 */}
            <div className="toolbar-group-left" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <div className="custom-model-select-container" style={{ position: 'relative' }} ref={modelPopoverRef}>
                <div
                  className="model-dropdown-container"
                  onClick={() => {
                    if (!isSending) {
                      setShowModelPopover(!showModelPopover)
                    }
                  }}
                  style={{
                    opacity: isSending ? 0.6 : 1,
                    cursor: isSending ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px'
                  }}
                >
                  <img
                    src={getModelIcon(llmConfig.model || '', llmConfig.provider)}
                    className="model-select-btn-icon"
                    alt=""
                    style={{
                      width: '14px',
                      height: '14px',
                      borderRadius: '3px',
                      flexShrink: 0,
                      objectFit: 'contain'
                    }}
                  />
                  <span className="model-select-inline" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '85px' }}>
                      {llmConfig.model || '选择模型'}
                    </span>
                    <ChevronDown size={13} strokeWidth={2} style={{ opacity: 0.7 }} aria-hidden="true" />
                  </span>
                </div>
                {showModelPopover && renderModelPopover()}
              </div>

              {/* 执行设备选择 */}
              <div className="custom-device-select-container" style={{ position: 'relative' }} ref={deviceMenuRef}>
                <div
                  className={`toolbar-icon-btn custom-device-trigger ${showDeviceMenu ? 'active' : ''}`}
                  onClick={() => { if (!isSending) setShowDeviceMenu(!showDeviceMenu) }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: isSending ? 'not-allowed' : 'pointer',
                    userSelect: 'none',
                    transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)'
                  }}
                  title={`执行设备: ${executionDevice === 'ssh' && sshConnected ? `SSH (${sshUsername}@${sshHost})` : '本机执行'}`}
                >
                  {executionDevice === 'ssh'
                    ? <Globe2 size={17} strokeWidth={2} aria-hidden="true" />
                    : <Monitor size={17} strokeWidth={2} aria-hidden="true" />}
                </div>

                {showDeviceMenu && (
                  <div
                    className="custom-device-menu"
                    style={{
                      position: 'absolute',
                      bottom: 'calc(100% + 6px)',
                      left: 0,
                      background: 'var(--bg-card, #ffffff)',
                      border: '1px solid var(--border-color, rgba(128,128,128,0.18))',
                      borderRadius: '8px',
                      boxShadow: '0 4px 16px rgba(0, 0, 0, 0.12)',
                      zIndex: 999,
                      minWidth: '180px',
                      display: 'flex',
                      flexDirection: 'column',
                      overflow: 'hidden',
                      padding: '4px 0',
                      animation: 'slideUpMenu 0.15s ease-out'
                    }}
                  >
                    <div
                      className={`device-menu-item ${executionDevice === 'local' ? 'active' : ''}`}
                      onClick={async () => {
                        await handleUpdateExecutionDevice('local')
                        setShowDeviceMenu(false)
                      }}
                      style={getMenuItemStyle(executionDevice === 'local')}
                      onMouseEnter={handleMenuItemMouseEnter}
                      onMouseLeave={handleMenuItemMouseLeave}
                    >
                      <Monitor size={16} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />
                      <span>本机执行</span>
                      {executionDevice === 'local' && <Check size={16} strokeWidth={2} style={{ marginLeft: 'auto', color: 'var(--accent-color, #4f8cff)' }} aria-hidden="true" />}
                    </div>

                    {sshConnected ? (
                      <div
                        className={`device-menu-item ${executionDevice === 'ssh' ? 'active' : ''}`}
                        onClick={async () => {
                          await handleUpdateExecutionDevice('ssh')
                          setShowDeviceMenu(false)
                        }}
                        style={getMenuItemStyle(executionDevice === 'ssh')}
                        onMouseEnter={handleMenuItemMouseEnter}
                        onMouseLeave={handleMenuItemMouseLeave}
                      >
                        <Globe2 size={16} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '110px' }} title={`${sshUsername}@${sshHost}`}>
                          SSH: {sshUsername}@${sshHost}
                        </span>
                        {executionDevice === 'ssh' && <Check size={16} strokeWidth={2} style={{ marginLeft: 'auto', color: 'var(--accent-color, #4f8cff)' }} aria-hidden="true" />}
                      </div>
                    ) : null}

                    <div
                      className="device-menu-item"
                      onClick={() => {
                        setShowSshModal(true)
                        setShowDeviceMenu(false)
                      }}
                      style={getMenuItemStyle(false)}
                      onMouseEnter={handleMenuItemMouseEnter}
                      onMouseLeave={handleMenuItemMouseLeave}
                    >
                      <Settings2 size={16} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />
                      <span>{sshConnected ? '配置其它 SSH...' : '配置远程 SSH...'}</span>
                    </div>

                    {sshConnected && (
                      <>
                        <div style={{ height: '1px', background: 'var(--border-color, rgba(128,128,128,0.12))', margin: '4px 0' }} />
                        <div
                          className="device-menu-item disconnect"
                          onClick={async () => {
                            if (confirm('确认断开当前 SSH 连接并切换回本机执行吗？')) {
                              await handleDisconnectSsh()
                            }
                            setShowDeviceMenu(false)
                          }}
                          style={{
                            padding: '8px 12px',
                            cursor: 'pointer',
                            fontSize: '12px',
                            display: 'flex',
                            alignItems: 'center',
                            color: '#ef4444',
                            fontWeight: 500,
                            transition: 'background 0.15s ease'
                          }}
                          onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--bg-menu-hover, rgba(128,128,128,0.06))'}
                          onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                        >
                          <Plug size={16} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />
                          <span>断开连接</span>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* 右侧：文件上传与发送按钮 */}
            <div className="toolbar-group-right" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {/* SVG 额度环 */}
              <div
                style={{
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  cursor: 'pointer',
                  width: '22px',
                  height: '22px'
                }}
                onMouseEnter={() => setShowContextTooltip(true)}
                onMouseLeave={() => setShowContextTooltip(false)}
              >
                <svg width="22" height="22" viewBox="0 0 36 36">
                  <circle
                    cx="18"
                    cy="18"
                    r="15.9155"
                    fill="none"
                    stroke="var(--bg-menu-hover, rgba(128,128,128,0.12))"
                    strokeWidth="3.5"
                  />
                  <circle
                    cx="18"
                    cy="18"
                    r="15.9155"
                    fill="none"
                    stroke={contextPercent >= 100 ? '#ef4444' : contextPercent > 75 ? '#f59e0b' : '#3b82f6'}
                    strokeWidth="3.5"
                    strokeDasharray={`${contextPercent} ${100 - contextPercent}`}
                    strokeDashoffset="25"
                    strokeLinecap="round"
                    style={{ transition: 'stroke-dasharray 0.35s ease' }}
                  />
                </svg>

                {showContextTooltip && (
                  <div
                    style={{
                      position: 'absolute',
                      bottom: 'calc(100% + 10px)',
                      right: '-30px',
                      backgroundColor: 'var(--bg-card, #ffffff)',
                      border: '1.5px solid var(--border-color, rgba(128,128,128,0.25))',
                      borderRadius: '8px',
                      padding: '6px 12px',
                      fontSize: '11px',
                      fontWeight: 600,
                      color: 'var(--text-color, #1e293b)',
                      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
                      whiteSpace: 'nowrap',
                      textAlign: 'center',
                      lineHeight: 1.55,
                      zIndex: 1000,
                      animation: 'slideUpMenu 0.15s ease-out'
                    }}
                  >
                    <div style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>背景信息窗口：</div>
                    <div style={{ fontSize: '12px' }}>{`${Math.round(contextPercent)}% 已用`}</div>
                    <div>{`已用 ${Math.round(estimatedContextTokens / 1000)}k 标记，共 ${Math.round(contextLimit / 1000)}k`}</div>
                  </div>
                )}
              </div>

              {/* 技能快捷开关按钮与 Popover */}
              <div style={{ position: 'relative' }}>
                <div
                  className={`toolbar-icon-btn toolbar-action-btn-skills ${showSkillsPopover ? 'active' : ''}`}
                  onClick={() => {
                    const next = !showSkillsPopover
                    setShowSkillsPopover(next)
                    setShowMcpPopover(false)
                    if (next) {
                      refreshSkillsAndStorage()
                    }
                  }}
                  title={`管理与启用技能扩展包 (当前启用: ${skillsList.filter(s => !disabledSkillNames.includes(s.name)).length}/${skillsList.length})`}
                >
                  <Puzzle size={18} strokeWidth={2} aria-hidden="true" />
                </div>
                {showSkillsPopover && renderSkillsPopover()}
              </div>

              {/* MCP 快捷查看按钮与 Popover */}
              <div style={{ position: 'relative' }}>
                <div
                  className={`toolbar-icon-btn toolbar-action-btn-mcp ${showMcpPopover ? 'active' : ''}`}
                  onClick={() => {
                    const next = !showMcpPopover
                    setShowMcpPopover(next)
                    setShowSkillsPopover(false)
                    if (next) {
                      refreshMcpServers()
                    }
                  }}
                  title={`管理与启用 MCP 服务 (当前启用: ${allMcpServers.filter((s: any) => s.enabled).length}/${allMcpServers.length})`}
                >
                  <Link size={17} strokeWidth={2} aria-hidden="true" />
                </div>
                {showMcpPopover && renderMcpPopover()}
              </div>

              {/* 上传文件按钮 */}
              <button
                className="toolbar-icon-btn toolbar-action-btn upload"
                onClick={handleUploadFile}
                disabled={isSending || estimatedContextTokens >= contextLimit}
                title={estimatedContextTokens >= contextLimit ? '上下文额度已用满' : '上传文件进行分析'}
              >
                <Plus size={18} strokeWidth={2} aria-hidden="true" />
              </button>

              {isSending ? (
                <button
                  className="toolbar-send-btn stop"
                  onClick={handleAbortLlm}
                  title="停止生成"
                >
                  <Square size={11} strokeWidth={0} fill="currentColor" aria-hidden="true" />
                </button>
              ) : (
                <button
                  className="toolbar-send-btn"
                  onClick={handleSendIntercept}
                  title="发送消息"
                  disabled={(!inputValue.trim() && attachedFiles.length === 0) || estimatedContextTokens >= contextLimit}
                >
                  <ArrowUp size={16} strokeWidth={2.5} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {previewImageSrc && (
        <div
          className="fullscreen-image-preview"
          style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', backgroundColor: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out' }}
          onClick={() => setPreviewImageSrc(null)}
          onContextMenu={(e) => {
            e.preventDefault()
            handleImageContextMenu(e, previewImageSrc)
          }}
        >
          <img src={previewImageSrc} style={{ maxWidth: '90%', maxHeight: '90%', objectFit: 'contain', borderRadius: '8px', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }} />
        </div>
      )}

      {showSshModal && (
        <div className="ssh-modal-overlay" style={{
          position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
          backgroundColor: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
          zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center'
        }} onClick={() => { setShowSshModal(false); setTestSshStatus({ type: 'idle', message: '' }) }}>
          <div className="ssh-modal-card" style={{
            width: '420px', background: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, rgba(128,128,128,0.2))',
            borderRadius: '16px', boxShadow: '0 12px 40px rgba(0,0,0,0.15)', display: 'flex', flexDirection: 'column',
            overflow: 'hidden', padding: '24px'
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' }}>
              <span style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-color)', display: 'inline-flex', alignItems: 'center' }}>
                <Server size={18} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />
                远程 SSH 连接配置
              </span>
              <button disabled={connectSshLoading} onClick={() => { setShowSshModal(false); setTestSshStatus({ type: 'idle', message: '' }) }} style={{ background: 'none', border: 'none', fontSize: '18px', cursor: 'pointer', color: 'var(--text-muted)' }} title="关闭">
                <X size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ display: 'flex', gap: '12px' }}>
                <div style={{ flex: 2 }}>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>主机地址 (Host)</label>
                  <input type="text" className="form-input" style={{ width: '100%', boxSizing: 'border-box' }} placeholder="192.168.1.100" value={sshForm.host} onChange={e => setSshForm(prev => ({ ...prev, host: e.target.value }))} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>端口 (Port)</label>
                  <input type="number" className="form-input" style={{ width: '100%', boxSizing: 'border-box' }} placeholder="22" value={sshForm.port} onChange={e => setSshForm(prev => ({ ...prev, port: e.target.value }))} />
                </div>
              </div>

              <div>
                <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>用户名 (Username)</label>
                <input type="text" className="form-input" style={{ width: '100%', boxSizing: 'border-box' }} placeholder="root" value={sshForm.username} onChange={e => setSshForm(prev => ({ ...prev, username: e.target.value }))} />
              </div>

              <div>
                <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>认证方式</label>
                <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                  <button type="button" onClick={() => setSshForm(prev => ({ ...prev, authType: 'password' }))} style={{ flex: 1, padding: '8px', borderRadius: '6px', border: sshForm.authType === 'password' ? '1.5px solid var(--accent-color, #4f8cff)' : '1px solid var(--border-color, rgba(128,128,128,0.2))', background: sshForm.authType === 'password' ? 'rgba(79,140,255,0.08)' : 'transparent', color: sshForm.authType === 'password' ? 'var(--accent-color, #4f8cff)' : 'var(--text-muted)', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>
                    <KeyRound size={15} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />密码认证
                  </button>
                  <button type="button" onClick={() => setSshForm(prev => ({ ...prev, authType: 'privateKey' }))} style={{ flex: 1, padding: '8px', borderRadius: '6px', border: sshForm.authType === 'privateKey' ? '1.5px solid var(--accent-color, #4f8cff)' : '1px solid var(--border-color, rgba(128,128,128,0.2))', background: sshForm.authType === 'privateKey' ? 'rgba(79,140,255,0.08)' : 'transparent', color: sshForm.authType === 'privateKey' ? 'var(--accent-color, #4f8cff)' : 'var(--text-muted)', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>
                    <FileKey2 size={15} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />私钥认证
                  </button>
                </div>
              </div>

              {sshForm.authType === 'password' ? (
                <div>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>密码 (Password)</label>
                  <input type="password" className="form-input" style={{ width: '100%', boxSizing: 'border-box' }} placeholder="输入连接密码" value={sshForm.password} onChange={e => setSshForm(prev => ({ ...prev, password: e.target.value }))} />
                </div>
              ) : (
                <div>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>PEM 私钥内容 (Private Key)</label>
                  <textarea rows={4} className="form-input" style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: '11px', resize: 'vertical' }} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..." value={sshForm.privateKey} onChange={e => setSshForm(prev => ({ ...prev, privateKey: e.target.value }))} />
                </div>
              )}
            </div>

            {testSshStatus.type !== 'idle' && (
              <div style={{
                fontSize: '12.5px', padding: '10px 12px', borderRadius: '8px', marginTop: '14px',
                color: testSshStatus.type === 'success' ? '#10b981' : testSshStatus.type === 'testing' ? '#6b7280' : '#ef4444',
                background: testSshStatus.type === 'success' ? 'rgba(16,185,129,0.06)' : testSshStatus.type === 'testing' ? 'rgba(107,114,128,0.06)' : 'rgba(239,68,68,0.06)',
                border: `1px solid ${testSshStatus.type === 'success' ? 'rgba(16,185,129,0.2)' : testSshStatus.type === 'testing' ? 'rgba(107,114,128,0.2)' : 'rgba(239,68,68,0.2)'}`
              }}>
                {testSshStatus.message}
              </div>
            )}

            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '20px' }}>
              <button
                disabled={connectSshLoading || testSshStatus.type === 'testing'}
                onClick={async () => {
                  if (!sshForm.host.trim() || !sshForm.username.trim()) {
                    setTestSshStatus({ type: 'error', message: '主机和用户名不能为空' })
                    return
                  }
                  setTestSshStatus({ type: 'testing', message: '正在测试 SSH 连接...' })
                  try {
                    const res = await window.api.testSshConnection({
                      host: sshForm.host.trim(),
                      port: parseInt(sshForm.port) || 22,
                      username: sshForm.username.trim(),
                      password: sshForm.password || undefined,
                      privateKey: sshForm.privateKey || undefined
                    })
                    if (res.success) {
                      setTestSshStatus({ type: 'success', message: '连接测试成功！' })
                    } else {
                      setTestSshStatus({ type: 'error', message: `测试失败: ${res.message || '未知错误'}` })
                    }
                  } catch (e: any) {
                    setTestSshStatus({ type: 'error', message: `异常: ${e.message || String(e)}` })
                  }
                }}
                className="btn-secondary"
                style={{ fontSize: '13px', padding: '6px 14px', borderRadius: '6px' }}
              >
                测试连接
              </button>
              <button
                disabled={connectSshLoading || testSshStatus.type === 'testing'}
                onClick={async () => {
                  if (!sshForm.host.trim() || !sshForm.username.trim()) {
                    setTestSshStatus({ type: 'error', message: '主机和用户名不能为空' })
                    return
                  }
                  setConnectSshLoading(true)
                  setTestSshStatus({ type: 'testing', message: '正在建立 SSH 连接...' })
                  try {
                    const res = await handleConnectSsh({
                      host: sshForm.host.trim(),
                      port: parseInt(sshForm.port) || 22,
                      username: sshForm.username.trim(),
                      password: sshForm.password || undefined,
                      privateKey: sshForm.privateKey || undefined
                    })
                    if (res.success) {
                      localStorage.setItem('agentpet_last_ssh_config', JSON.stringify(sshForm))
                      showToast('成功连接远程服务器，已启用 SSH 执行！', 'success')
                      setShowSshModal(false)
                      setTestSshStatus({ type: 'idle', message: '' })
                    } else {
                      setTestSshStatus({ type: 'error', message: `连接失败: ${res.message || '连接超时'}` })
                    }
                  } catch (e: any) {
                    setTestSshStatus({ type: 'error', message: `异常: ${e.message || String(e)}` })
                  } finally {
                    setConnectSshLoading(false)
                  }
                }}
                className="btn-primary"
                style={{ fontSize: '13px', padding: '6px 14px', borderRadius: '6px' }}
              >
                {connectSshLoading ? '连接中...' : '连接并激活'}
              </button>
            </div>
          </div>
        </div>
      )}
      <style>{`
        @keyframes slideUpMenu {
          from { opacity: 0; transform: translateY(6px) scale(0.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .approval-status-pulse {
          animation: pulseGlow 2s infinite ease-in-out;
        }
        .permission-approval-card.compact {
          position: absolute;
          left: -1px;
          right: -1px;
          bottom: calc(100% + 9px);
          z-index: 40;
          width: auto;
          margin: 0;
          border: 1px solid rgba(15, 23, 42, 0.1);
          border-radius: 18px;
          background: var(--bg-card, #fff);
          box-shadow: 0 18px 48px rgba(15, 23, 42, 0.18);
          color: var(--text-color, #111827);
          overflow: visible;
          animation: approvalRailIn 0.22s cubic-bezier(0.2, 0.9, 0.2, 1);
        }
        @keyframes approvalRailIn {
          from { opacity: 0; transform: translateY(10px) scale(0.99); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .approval-card-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
          padding: 18px 22px 10px;
        }
        .approval-card-title {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          min-width: 0;
        }
        .approval-icon {
          width: 24px;
          height: 24px;
          border-radius: 999px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: #6b7280;
          border: 1px solid rgba(15, 23, 42, 0.14);
          font-size: 15px;
          flex: 0 0 auto;
        }
        .approval-kicker {
          color: var(--text-muted, #6b7280);
          font-size: 12px;
          line-height: 1.2;
          margin-bottom: 6px;
        }
        .approval-title {
          font-size: 15px;
          line-height: 1.35;
          font-weight: 700;
        }
        .permission-approval-card.is-danger .approval-icon {
          color: #b42318;
          border-color: rgba(180, 35, 24, 0.22);
          background: rgba(180, 35, 24, 0.06);
        }
        .approval-card-body {
          padding: 8px 22px 18px;
        }
        .approval-reason {
          margin: 0 0 12px;
          color: var(--text-muted, #4b5563);
          font-size: 13px;
          line-height: 1.55;
        }
        .approval-command-box {
          border: 1px solid rgba(15, 23, 42, 0.1);
          border-radius: 12px;
          background: rgba(248, 250, 252, 0.9);
          overflow: hidden;
        }
        .approval-command-box pre {
          margin: 0;
          padding: 12px 14px;
          max-height: 180px;
          overflow: auto;
          white-space: pre-wrap;
          word-break: break-word;
          font-family: Consolas, Monaco, 'Courier New', monospace;
          font-size: 12px;
          line-height: 1.45;
          color: var(--text-color, #111827);
        }
        .approval-link-button {
          width: 100%;
          border: 0;
          border-top: 1px solid rgba(15, 23, 42, 0.08);
          padding: 8px 12px;
          background: transparent;
          color: var(--accent-color, #2563eb);
          cursor: pointer;
          font-size: 12px;
          text-align: left;
        }
        .approval-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
          margin-top: 10px;
          color: var(--text-muted, #6b7280);
          font-size: 12px;
        }
        .approval-meta code {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-family: Consolas, Monaco, 'Courier New', monospace;
          color: var(--text-color, #111827);
        }
        .approval-actions {
          display: flex;
          justify-content: flex-end;
          align-items: center;
          gap: 10px;
          margin-top: 16px;
        }
        .approval-action {
          height: 36px;
          border-radius: 999px;
          border: 1px solid rgba(15, 23, 42, 0.1);
          padding: 0 16px;
          font-size: 13px;
          font-weight: 650;
          cursor: pointer;
          transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
        }
        .approval-action:hover {
          transform: translateY(-1px);
        }
        .approval-action.reject {
          background: var(--bg-card, #fff);
          color: var(--text-color, #111827);
        }
        .approval-action.allow {
          background: var(--accent-color, #4f8cff);
          border-color: var(--accent-color, #4f8cff);
          color: #fff;
          box-shadow: 0 8px 18px rgba(79, 140, 255, 0.22);
        }
        .approval-allow-group {
          position: relative;
          display: inline-flex;
          align-items: stretch;
        }
        .approval-allow-group .approval-action.allow {
          border-radius: 999px 0 0 999px;
        }
        .approval-action.allow.menu {
          width: 38px;
          padding: 0;
          border-left-color: rgba(255, 255, 255, 0.18);
          border-radius: 0 999px 999px 0;
        }
        .approval-menu {
          position: absolute;
          right: 0;
          bottom: calc(100% + 8px);
          min-width: 178px;
          border: 1px solid rgba(15, 23, 42, 0.12);
          border-radius: 10px;
          background: var(--bg-card, #fff);
          box-shadow: 0 14px 34px rgba(15, 23, 42, 0.18);
          padding: 6px;
          z-index: 50;
        }
        .approval-menu button {
          width: 100%;
          border: 0;
          border-radius: 7px;
          background: transparent;
          color: var(--text-color, #111827);
          cursor: pointer;
          font-size: 13px;
          padding: 9px 10px;
          text-align: left;
        }
        .approval-menu button:hover {
          background: color-mix(in srgb, var(--accent-color, #4f8cff) 10%, transparent);
          color: var(--accent-color, #4f8cff);
        }
        @keyframes pulseGlow {
          0%, 100% { opacity: 0.6; }
          50% { opacity: 1; }
        }
        @media (max-width: 640px) {
          .permission-approval-card.compact {
            left: -1px;
            right: -1px;
            bottom: calc(100% + 7px);
          }
          .approval-card-head {
            padding: 15px 16px 8px;
          }
          .approval-card-body {
            padding: 8px 16px 16px;
          }
        }
      `}</style>
    </div>
  )
}

export const ChatPage = React.memo(ChatPageImpl)
