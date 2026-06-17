import React, { useState, useEffect } from 'react'
import type { AppStore } from '../hooks/useAppStore'
import { ChatMessageItem } from '../components/ChatMessageItem'


interface ChatPageProps {
  store: AppStore
}

export function ChatPage({ store }: ChatPageProps): React.JSX.Element {
  const {
    llmConfig,
    activeSessMessages,
    activeSession,
    currentAvatarName,
    isSending,
    inputValue, setInputValue,
    chatEndRef,
    handleSendChat,
    availableModels,
    saveLlmConfig,
    workspacePath,
    handleSelectWorkspace,
    handleClearWorkspace,
    attachedFiles,
    setAttachedFiles,
    handlePasteFiles,
    handleUploadFile,
    highlightedMessageId,
    setHighlightedMessageId,
    handleAbortLlm,
    isSessionSwitching
  } = store

  const [previewImageSrc, setPreviewImageSrc] = useState<string | null>(null)

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
    return () => {}
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

  const isOllama = llmConfig.provider === 'ollama'
  const hasKey = isOllama || !!llmConfig.apiKey

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
        <div className="chat-messages-box">
          {!hasKey && (
            <div className="api-warn-banner">
              <span>⚠️ 未配置大模型 API Key。当前处于『演示模式』，{currentAvatarName} 将使用内置模拟语句回复您。请前往『设置 {"->"} 本地存储』配置大模型以开启真实交互。</span>
            </div>
          )}
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
                <div className="suggestion-chip" onClick={() => store.setInputValue('帮我处理一下这份文档的内容，提取关键信息')}>
                  <span className="chip-icon">📄</span>文档处理
                </div>
                <div className="suggestion-chip" onClick={() => store.setInputValue('帮我分析这组数据并生成一份可视化报告')}>
                  <span className="chip-icon">📊</span>数据分析与可视化
                </div>
                <div className="suggestion-chip" onClick={() => store.setInputValue('请为我构思一个独特的UI设计方案')}>
                  <span className="chip-icon">🎨</span>设计创意
                </div>
                <div className="suggestion-chip" onClick={() => store.setInputValue('用最佳实践编写这段代码功能')}>
                  <span className="chip-icon">💻</span>代码开发
                </div>
              </div>
            </div>
          ) : (
            <>
              {activeSessMessages.map(msg => (
                <ChatMessageItem 
                  key={msg.id} 
                  msg={msg} 
                  currentAvatarName={currentAvatarName} 
                  highlightedMessageId={highlightedMessageId}
                />
              ))}
              <div ref={chatEndRef} />
            </>
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
                  <span className="preview-icon" style={{ marginRight: '6px' }}>📄</span>
                )}
                <span className="preview-name" style={{ maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '13px' }}>{file.name}</span>
                <button className="preview-remove-btn" onClick={() => setAttachedFiles(prev => prev.filter((_, i) => i !== idx))} title="移除文件" style={{ marginLeft: '8px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', padding: '2px' }}>✕</button>
              </div>
            ))}
          </div>
        )}

        {/* 现代卡片式输入控制面板 */}
        <div className="chat-control-card">
          <textarea
            className="chat-textarea-field"
            rows={2}
            placeholder={isSending ? `${currentAvatarName} 正在思考中...` : `输入指令并发送给 ${currentAvatarName} ... (支持 Shift + Enter 换行，支持 Ctrl+V 粘贴文件/截图)`}
            value={inputValue}
            disabled={isSending}
            onChange={e => setInputValue(e.target.value)}
            onPaste={e => {
              if (e.clipboardData.files && e.clipboardData.files.length > 0) {
                e.preventDefault()
                handlePasteFiles(e.clipboardData.files)
              }
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSendChat()
              }
            }}
          />
          
          <div className="chat-control-toolbar">
            {/* 左侧：模型切换与工作空间选择 */}
            <div className="toolbar-group-left">
              <div className="model-dropdown-container">
                <span className="toolbar-lbl-icon">🤖</span>
                <select
                  className="model-select-inline"
                  value={llmConfig.model}
                  onChange={e => saveLlmConfig({ ...llmConfig, model: e.target.value })}
                  disabled={isSending}
                >
                  {availableModels.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                  {!availableModels.includes(llmConfig.model) && llmConfig.model && (
                    <option value={llmConfig.model}>{llmConfig.model} (自定义)</option>
                  )}
                  {availableModels.length === 0 && !llmConfig.model && (
                    <option value="">未加载模型</option>
                  )}
                </select>
              </div>

              <button 
                className={`workspace-btn-inline ${workspacePath ? 'selected' : ''}`}
                onClick={handleSelectWorkspace}
                title={workspacePath ? `当前项目目录: ${workspacePath}` : '配置本地电脑工作区'}
              >
                📁 {workspacePath ? `项目: ${workspacePath.split(/[\\/]/).pop()}` : '选择工作空间'}
                {workspacePath && (
                  <span 
                    className="clear-workspace-btn" 
                    onClick={handleClearWorkspace}
                    title="清除工作空间"
                  >
                    ✕
                  </span>
                )}
              </button>
            </div>

            {/* 右侧：文件上传与发送按钮 */}
            <div className="toolbar-group-right">
              <button
                className="toolbar-action-btn upload"
                onClick={handleUploadFile}
                disabled={isSending}
                title="上传文本文件以分析"
              >
                ➕ 上传文件
              </button>
              
              {isSending ? (
                <button
                  className="toolbar-send-btn stop"
                  onClick={handleAbortLlm}
                  title="停止生成"
                  style={{ background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)', boxShadow: '0 2px 8px rgba(239, 68, 68, 0.2)' }}
                >
                  停止
                </button>
              ) : (
                <button
                  className="toolbar-send-btn"
                  onClick={handleSendChat}
                  disabled={!inputValue.trim() && attachedFiles.length === 0}
                >
                  发送
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
        >
          <img src={previewImageSrc} style={{ maxWidth: '90%', maxHeight: '90%', objectFit: 'contain', borderRadius: '8px', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }} />
        </div>
      )}
    </div>
  )
}
