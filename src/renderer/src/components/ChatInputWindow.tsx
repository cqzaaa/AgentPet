import React, { useEffect, useState, useRef } from 'react'
import {
  Bot,
  Camera,
  ChevronDown,
  ExternalLink,
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Globe2,
  GripVertical,
  History,
  Lightbulb,
  MessageSquare,
  Plus,
  Presentation,
  Send,
  Settings2,
  Trash2,
  User,
  X
} from 'lucide-react'

export function ChatInputWindow(): React.JSX.Element {
  const [text, setText] = useState('')
  const [screenshotImages, setScreenshotImages] = useState<{ path: string; base64: string; width: number; height: number }[]>([]);
  const [pastedFiles, setPastedFiles] = useState<{ path: string; name: string; isImage: boolean; base64?: string }[]>([]);
  const [messages, setMessages] = useState<{ sender: 'user' | 'agent'; text: string }[]>([])
  const [isThinking, setIsThinking] = useState(false)
  const [showChat, setShowChat] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // 监听截图提问发送的截图图片并追加到数组中
  useEffect(() => {
    if (!window.api.onSetScreenshotImage) return
    const unsubscribe = window.api.onSetScreenshotImage((imgInfo) => {
      setScreenshotImages(prev => [...prev, imgInfo])
      setShowDropdown(false)
    })
    return () => {
      unsubscribe()
    }
  }, [])
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const isDraggingRef = useRef(false)
  const lastXRef = useRef(0)
  const lastYRef = useRef(0)

  // 历史会话管理状态
  const [sessions, setSessions] = useState<any[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string>('')
  const [showDropdown, setShowDropdown] = useState(false)
  const [isLoadingHistory, setIsLoadingHistory] = useState(false)
  const loadingTimerRef = useRef<NodeJS.Timeout | null>(null)
  const shouldScrollRef = useRef<'smooth' | 'auto' | false>(false)

  // 组件卸载时清理定时器
  useEffect(() => {
    return () => {
      if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current)
    }
  }, [])

  // 绑定全局鼠标拖拽移动事件，确保透明无边框窗口可由鼠标自由拖动
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent): void => {
      if (!isDraggingRef.current) return
      const dx = e.screenX - lastXRef.current
      const dy = e.screenY - lastYRef.current
      lastXRef.current = e.screenX
      lastYRef.current = e.screenY
      window.api.moveWindow(dx, dy)
    }
    const handleMouseUp = (): void => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false
        window.api.endDrag()
      }
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  const handleMouseDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return // 只响应鼠标左键
    isDraggingRef.current = true
    lastXRef.current = e.screenX
    lastYRef.current = e.screenY
    window.api.startDrag()
  }

  // 绑定全局点击事件以实现 Click Outside 关闭下拉菜单
  useEffect(() => {
    const handleGlobalClick = () => {
      setShowDropdown(false)
    }
    window.addEventListener('click', handleGlobalClick)
    return () => {
      window.removeEventListener('click', handleGlobalClick)
    }
  }, [])

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus()
    }
  }, [])

  // 辅助函数：格式化会话时间显示
  const formatSessionTime = (timeStr: string) => {
    if (!timeStr) return ''
    try {
      const now = new Date()
      const year = now.getFullYear()
      const month = String(now.getMonth() + 1).padStart(2, '0')
      const day = String(now.getDate()).padStart(2, '0')
      const todayStr = `${year}-${month}-${day}`

      if (timeStr.startsWith(todayStr)) {
        const parts = timeStr.split(' ')
        if (parts[1]) {
          return parts[1].substring(0, 5)
        }
      } else {
        const parts = timeStr.split(' ')
        const datePart = parts[0]
        if (datePart.startsWith(`${year}-`)) {
          return datePart.substring(5)
        }
        return datePart
      }
    } catch (e) { }
    return timeStr.substring(0, 10)
  }

  // 读取本地会话列表并进行初始化
  const loadSessions = () => {
    const saved = localStorage.getItem('agentself_sessions') || localStorage.getItem('agentpet_sessions')
    let parsed: any[] = []
    if (saved) {
      try {
        parsed = JSON.parse(saved)
      } catch (e) {
        console.error('解析历史会话失败', e)
      }
    }
    const activeId = localStorage.getItem('agentself_active_session_id') || localStorage.getItem('agentpet_active_session_id') || ''

    const sorted = [...parsed].sort((a, b) => {
      const t1 = a.createdAt || a.time || ''
      const t2 = b.createdAt || b.time || ''
      return t2.localeCompare(t1)
    })
    setSessions(sorted)
    setCurrentSessionId(activeId)

    const activeSession = parsed.find(s => s.id === activeId)
    if (activeSession) {
      if (activeSession.messages && activeSession.messages.length > 0) {
        setShowChat(true)
        window.api.setWindowSize(400, 400, 'top')
        setIsLoadingHistory(true)
        if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current)
        loadingTimerRef.current = setTimeout(() => {
          shouldScrollRef.current = 'auto'
          setMessages(activeSession.messages || [])
          setIsLoadingHistory(false)
        }, 350)
      } else {
        setMessages([])
        setIsLoadingHistory(false)
        setShowChat(false)
        window.api.setWindowSize(400, 90, 'top')
      }
    } else {
      setMessages([])
      setIsLoadingHistory(false)
      setShowChat(false)
      window.api.setWindowSize(400, 90, 'top')
    }
  }

  // 初始化加载
  useEffect(() => {
    loadSessions()
  }, [])

  // 监听大模型的回复
  useEffect(() => {
    if (!window.api.onPetReplyResponse) return
    const unsubscribe = window.api.onPetReplyResponse((replyText: string) => {
      shouldScrollRef.current = 'smooth'
      setMessages(prev => [...prev, { sender: 'agent', text: replyText }])
      setIsThinking(false)
      // 延时加载一下，确保 PetWidget 已将最新的 response 序列化存储在 localStorage
      setTimeout(() => {
        const saved = localStorage.getItem('agentself_sessions') || localStorage.getItem('agentpet_sessions')
        if (saved) {
          try {
            const parsed = JSON.parse(saved)
            const sorted = [...parsed].sort((a, b) => {
              const t1 = a.createdAt || a.time || ''
              const t2 = b.createdAt || b.time || ''
              return t2.localeCompare(t1)
            })
            setSessions(sorted)
          } catch (e) { }
        }
      }, 150)
    })
    return () => {
      unsubscribe()
    }
  }, [])

  // 监听下拉菜单和聊天框的展开状态，自适应调节 Electron 窗口大小以防止裁剪
  useEffect(() => {
    const hasAttachments = screenshotImages.length > 0 || pastedFiles.length > 0
    const extraH = hasAttachments ? 60 : 0
    if (showDropdown) {
      if (!showChat) {
        window.api.setWindowSize(400, 240 + extraH, 'top')
      }
    } else {
      if (!showChat) {
        window.api.setWindowSize(400, 90 + extraH, 'top')
      } else {
        window.api.setWindowSize(400, 400 + extraH, 'top')
      }
    }
  }, [showDropdown, showChat, screenshotImages.length, pastedFiles.length])

  // 自动滚动到底部 (新消息平滑滚动，历史会话瞬间直达底部无滚动动画)
  useEffect(() => {
    if (!messagesEndRef.current) return

    let cleanup: (() => void) | undefined = undefined

    if (shouldScrollRef.current === 'smooth') {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' })
      shouldScrollRef.current = false
    } else if (shouldScrollRef.current === 'auto') {
      const timer = setTimeout(() => {
        const list = document.querySelector('.mini-chat-list')
        if (list) {
          list.scrollTop = list.scrollHeight
        }
      }, 30) // 延迟 30ms 确保真实 DOM 渲染完毕，瞬间定格在最底端
      shouldScrollRef.current = false
      cleanup = () => clearTimeout(timer)
    }

    return cleanup
  }, [messages, isThinking])

  // 切换历史会话
  const handleSwitchSession = (sessionId: string) => {
    localStorage.setItem('agentself_active_session_id', sessionId)
    localStorage.setItem('agentpet_active_session_id', sessionId)
    if (window.electron && window.electron.ipcRenderer) {
      window.electron.ipcRenderer.send('api:wechat-session-updated', sessionId)
    }

    const saved = localStorage.getItem('agentself_sessions') || localStorage.getItem('agentpet_sessions')
    let parsed: any[] = []
    if (saved) {
      try { parsed = JSON.parse(saved) } catch (e) { }
    }

    const selected = parsed.find(s => s.id === sessionId)
    if (selected) {
      setCurrentSessionId(sessionId)
      setShowDropdown(false)

      if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current)

      if (selected.messages && selected.messages.length > 0) {
        setShowChat(true)
        window.api.setWindowSize(400, 400, 'top')
        setIsLoadingHistory(true)
        loadingTimerRef.current = setTimeout(() => {
          shouldScrollRef.current = 'auto'
          setMessages(selected.messages || [])
          setIsLoadingHistory(false)
        }, 350)
      } else {
        setMessages([])
        setIsLoadingHistory(false)
        setShowChat(false)
        window.api.setWindowSize(400, 90, 'top')
      }
    }
  }

  // 新建会话
  const handleCreateNewSession = () => {
    const newId = 'agent:session:' + Date.now()
    localStorage.setItem('agentself_active_session_id', newId)
    localStorage.setItem('agentpet_active_session_id', newId)
    if (window.electron && window.electron.ipcRenderer) {
      window.electron.ipcRenderer.send('api:wechat-session-updated', newId)
    }

    // 同步写入数据库，确保 Agent 窗口打开时能加载到新会话
    try {
      const saved = localStorage.getItem('agentself_sessions') || localStorage.getItem('agentpet_sessions')
      let parsed: any[] = []
      if (saved) { try { parsed = JSON.parse(saved) } catch (e) { } }
      const timeStr = new Date().toISOString().replace('T', ' ').substring(0, 19)
      const newSession = { id: newId, name: '(未命名)', time: timeStr, createdAt: timeStr, messages: [] }
      const updated = [...parsed, newSession]
      localStorage.setItem('agentpet_sessions', JSON.stringify(updated))
      
      // 增量写入数据库
      window.api.createSession(newSession).catch(() => { })
    } catch (e) { }

    if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current)
    setMessages([])
    setIsLoadingHistory(false)
    setCurrentSessionId(newId)
    setShowChat(false)
    window.api.setWindowSize(400, 90, 'top')
    setShowDropdown(false)

    setTimeout(() => {
      if (inputRef.current) inputRef.current.focus()
    }, 50)
  }

  const handleSend = () => {
    if (!text.trim() && screenshotImages.length === 0 && pastedFiles.length === 0) return
    const userText = text.trim()

    // 组装并发送待处理的输入到 Agent 窗口（实现弹框跳转到主 chat 页面）
    const payload: any = {}
    const allFiles: { path: string; name: string }[] = []
    if (screenshotImages.length > 0) {
      screenshotImages.forEach(img => {
        allFiles.push({ path: img.path, name: `screenshot_${Date.now()}.png` })
      })
    }
    if (pastedFiles.length > 0) {
      pastedFiles.forEach(f => {
        allFiles.push({ path: f.path, name: f.name })
      })
    }
    if (allFiles.length > 0) {
      payload.files = allFiles
    }
    if (userText) {
      payload.text = userText
    }

    if (allFiles.length > 0) {
      window.api.sendPendingInput(JSON.stringify(payload))
      window.api.openAgentWindow()
      window.api.closeInputWindow()
    } else {
      // 纯文本普通提问直接在小窗口内交互，不弹窗跳转
      shouldScrollRef.current = 'smooth'
      setMessages(prev => [...prev, { sender: 'user', text: userText }])
      setIsThinking(true)
      setShowChat(true)
      if (window.api.sendChatToPet) {
        window.api.sendChatToPet(userText)
      }
    }

    setText('')
    setScreenshotImages([])
    setPastedFiles([])
  }

  const handleClearAll = () => {
    const newId = 'agent:session:' + Date.now()
    localStorage.setItem('agentself_active_session_id', newId)
    localStorage.setItem('agentpet_active_session_id', newId)
    if (window.electron && window.electron.ipcRenderer) {
      window.electron.ipcRenderer.send('api:wechat-session-updated', newId)
    }

    // 同步写入数据库
    try {
      const saved = localStorage.getItem('agentself_sessions') || localStorage.getItem('agentpet_sessions')
      let parsed: any[] = []
      if (saved) { try { parsed = JSON.parse(saved) } catch (e) { } }
      const timeStr = new Date().toISOString().replace('T', ' ').substring(0, 19)
      const newSession = { id: newId, name: '(未命名)', time: timeStr, createdAt: timeStr, messages: [] }
      const updated = [...parsed, newSession]
      localStorage.setItem('agentpet_sessions', JSON.stringify(updated))
      
      // 增量写入数据库
      window.api.createSession(newSession).catch(() => { })
    } catch (e) { }

    if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current)
    setMessages([])
    setIsLoadingHistory(false)
    setShowChat(false)
    setIsThinking(false)
    window.api.setWindowSize(400, 90, 'top')
    setCurrentSessionId(newId)

    setTimeout(() => {
      loadSessions()
    }, 100)
    setTimeout(() => {
      if (inputRef.current) inputRef.current.focus()
    }, 50)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSend()
    } else if (e.key === 'Escape') {
      window.api.closeInputWindow()
    }
  }

  // 辅助：根据文件扩展名返回分类图标
  const getFileIcon = (name: string): React.JSX.Element => {
    const ext = name.split('.').pop()?.toLowerCase() || ''
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']
    const iconProps = { size: 18, strokeWidth: 2, 'aria-hidden': true } as const
    if (imageExts.includes(ext)) return <FileImage {...iconProps} />
    if (['pdf', 'doc', 'docx', 'txt', 'md', 'log'].includes(ext)) return <FileText {...iconProps} />
    if (['xls', 'xlsx', 'csv'].includes(ext)) return <FileSpreadsheet {...iconProps} />
    if (['ppt', 'pptx'].includes(ext)) return <Presentation {...iconProps} />
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return <FileArchive {...iconProps} />
    if (['mp3', 'wav', 'flac', 'ogg'].includes(ext)) return <FileAudio {...iconProps} />
    if (['mp4', 'avi', 'mkv', 'mov'].includes(ext)) return <FileVideo {...iconProps} />
    if (['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'go', 'rs'].includes(ext)) return <FileCode2 {...iconProps} />
    if (['json', 'xml', 'yaml', 'yml', 'ini', 'toml'].includes(ext)) return <Settings2 {...iconProps} />
    if (['html', 'css', 'scss'].includes(ext)) return <Globe2 {...iconProps} />
    return <File {...iconProps} />
  }

  // 辅助：将文件添加到粘贴文件预览列表（图片自动加载缩略图）
  const addPastedFile = async (filePath: string, fileName: string) => {
    const ext = fileName.split('.').pop()?.toLowerCase() || ''
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']
    const isImage = imageExts.includes(ext)
    let base64: string | undefined

    if (isImage) {
      try {
        const b64 = await window.api.readFileBase64(filePath)
        if (b64) base64 = `data:image/${ext === 'svg' ? 'svg+xml' : ext};base64,${b64}`
      } catch { /* 缩略图加载失败不影响 */ }
    }

    setPastedFiles(prev => [...prev, { path: filePath, name: fileName, isImage, base64 }])
  }

  // 粘贴文件/图片时处理：添加到预览列表，发送时再跳转
  const handlePaste = async (e: React.ClipboardEvent<HTMLInputElement>) => {
    // 阻止默认行为，我们将接管所有的粘贴逻辑，以确保在不同环境下都能正确提取系统剪贴板文件
    e.preventDefault()

    const plainText = e.clipboardData.getData('text/plain')
    const items = Array.from(e.clipboardData.items)
    const imageItem = items.find(item => item.type.startsWith('image/'))

    // 优先同步提取 HTML5 剪贴板中的纯图片（如浏览器中复制的图片），防止异步后数据丢失
    let fallbackDataUrl: string | null = null
    if (imageItem) {
      const blob = imageItem.getAsFile()
      if (blob) {
        fallbackDataUrl = await new Promise<string | null>(resolve => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result as string)
          reader.onerror = () => resolve(null)
          reader.readAsDataURL(blob)
        })
      }
    }

    let handledAsFile = false

    // 1. 优先尝试通过主进程读取真实文件（解决资源管理器复制文件的原名和绝对路径获取问题，兼顾所有文件类型）
    if (window.api.readClipboardFiles) {
      try {
        const result = await window.api.readClipboardFiles()
        if (result) {
          if (result.type === 'files' && result.paths.length > 0) {
            for (const fp of result.paths) {
              const name = fp.split(/[\\/]/).pop() || 'file'
              await addPastedFile(fp, name)
            }
            handledAsFile = true
          } else if (result.type === 'image') {
            // 主进程成功提取了系统剪贴板图片
            let base64: string | undefined
            try {
              const b64 = await window.api.readFileBase64(result.path)
              if (b64) base64 = `data:image/png;base64,${b64}`
            } catch { /* ignore */ }
            setPastedFiles(prev => [...prev, {
              path: result.path,
              name: result.name,
              isImage: true,
              base64
            }])
            handledAsFile = true
          }
        }
      } catch (err) {
        console.error('主进程读取剪贴板文件失败:', err)
      }
    }

    if (handledAsFile) return

    // 2. 如果主进程没能读取到真实文件，使用刚刚同步截获的纯图片 DataURL
    if (fallbackDataUrl) {
      try {
        const result = await window.api.saveClipboardImage(fallbackDataUrl)
        if (result) {
          setPastedFiles(prev => [...prev, {
            path: result.path,
            name: result.name,
            isImage: true,
            base64: fallbackDataUrl
          }])
        }
      } catch (err) {
        console.error('读取 fallback 图片失败:', err)
      }
      return
    }

    // 3. Fallback: 处理 HTML5 File API 提供的文件拖拽遗留逻辑
    const files = e.clipboardData.files
    if (files && files.length > 0) {
      let html5Handled = false
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const filePath = (file as any).path
        if (filePath) {
          await addPastedFile(filePath, file.name)
          html5Handled = true
        }
      }
      if (html5Handled) return
    }

    // 4. 如果以上都不是，说明纯粹是普通文本，我们手动将其插回输入框
    if (plainText) {
      const input = e.target as HTMLInputElement
      const start = input.selectionStart || 0
      const end = input.selectionEnd || 0

      setText(prev => {
        const newText = prev.substring(0, start) + plainText + prev.substring(end)
        // 使用 setTimeout 等待 React 更新 DOM 后再调整光标位置
        setTimeout(() => {
          input.setSelectionRange(start + plainText.length, start + plainText.length)
        }, 0)
        return newText
      })
    }
  }

  // 渲染 Markdown 加粗 + 图片语法 (与主 Chat 页面保持一致)
  const renderMessageText = (txt: string) => {
    const lines = txt.split('\n')
    const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g

    return lines.map((line, idx) => {
      // 先检测该行是否包含图片语法，分割为图片和文字段落
      const segments: React.ReactNode[] = []
      let lastIndex = 0
      let imgMatch
      imageRegex.lastIndex = 0

      while ((imgMatch = imageRegex.exec(line)) !== null) {
        // 图片前的文字部分
        if (imgMatch.index > lastIndex) {
          segments.push(renderBoldText(line.substring(lastIndex, imgMatch.index), `text-${idx}-${lastIndex}`))
        }
        // 图片本体 (迷你窗口内不支持缩放预览，使用普通 img)
        segments.push(
          <div key={`img-${idx}-${imgMatch.index}`} style={{ margin: '6px 0' }}>
            <img
              src={imgMatch[2]}
              alt={imgMatch[1]}
              style={{ maxWidth: '100%', maxHeight: '160px', borderRadius: '6px', display: 'block', objectFit: 'contain' }}
            />
          </div>
        )
        lastIndex = imageRegex.lastIndex
      }

      // 图片后的剩余文字
      if (lastIndex < line.length) {
        segments.push(renderBoldText(line.substring(lastIndex), `text-${idx}-tail`))
      }

      if (segments.length === 0) {
        // 空行保留最小高度
        return <div key={idx} style={{ minHeight: '1.2em' }} />
      }

      return (
        <div key={idx} style={{ margin: '3px 0', wordBreak: 'break-word' }}>
          {segments}
        </div>
      )
    })
  }

  // 辅助：对一段纯文本渲染加粗语法
  const renderBoldText = (text: string, keyPrefix: string): React.ReactNode => {
    const boldRegex = /\*\*(.*?)\*\*/g
    const parts: React.ReactNode[] = []
    let lastIndex = 0
    let match

    while ((match = boldRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(text.substring(lastIndex, match.index))
      }
      parts.push(
        <strong key={`${keyPrefix}-b${match.index}`} style={{ color: '#d97706', fontWeight: 'bold' }}>
          {match[1]}
        </strong>
      )
      lastIndex = boldRegex.lastIndex
    }
    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex))
    }
    return parts.length > 0 ? <>{parts}</> : text
  }

  // 根据当前会话名称动态显示 placeholder 提示
  const currentSession = sessions.find(s => s.id === currentSessionId)
  const sessionName = currentSession ? currentSession.name : ''
  const placeholderText = sessionName && sessionName !== '(未命名)' && sessionName !== '新会话'
    ? `在会话「${sessionName.length > 12 ? sessionName.substring(0, 12) + '...' : sessionName}」中继续提问...`
    : '今天要说点什么...'

  // 动态计算 wrapper 的高度，以提供平滑过渡的动效
  let wrapperHeight = '66px'
  const hasAttachments = screenshotImages.length > 0 || pastedFiles.length > 0
  const attachmentsHeaderHeight = 60 // 54px header + 6px gap

  if (showChat) {
    wrapperHeight = hasAttachments ? `${378 + attachmentsHeaderHeight}px` : '378px'
  } else if (showDropdown) {
    wrapperHeight = hasAttachments ? `${220 + attachmentsHeaderHeight}px` : '220px'
  } else {
    wrapperHeight = hasAttachments ? `${66 + attachmentsHeaderHeight}px` : '66px'
  }

  return (
    <div
      className="chat-input-window-wrapper"
      style={{ height: wrapperHeight }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          handleMouseDown(e)
        }
      }}
    >
      {(screenshotImages.length > 0 || pastedFiles.length > 0) && (
        <div className="screenshot-previews-container">
          {/* 截图预览 */}
          {screenshotImages.map((img, index) => (
            <div key={`ss-${index}`} className="screenshot-preview-item">
              <img src={img.base64} className="screenshot-preview-thumb" />
              <span className="screenshot-preview-meta">{img.width} × {img.height}</span>
              <button
                className="screenshot-preview-remove"
                onClick={(e) => {
                  e.stopPropagation()
                  setScreenshotImages(prev => prev.filter((_, i) => i !== index))
                }}
                title="移除图片"
              >
                <X size={13} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          ))}
          {/* 粘贴文件预览 */}
          {pastedFiles.map((file, index) => (
            <div key={`pf-${index}`} className="screenshot-preview-item pasted-file-item">
              {file.isImage && file.base64 ? (
                <img src={file.base64} className="screenshot-preview-thumb" />
              ) : (
                <span className="pasted-file-icon">{getFileIcon(file.name)}</span>
              )}
              <span className="screenshot-preview-meta pasted-file-name" title={file.name}>
                {file.name.length > 12 ? file.name.substring(0, 10) + '…' + file.name.split('.').pop() : file.name}
              </span>
              <button
                className="screenshot-preview-remove"
                onClick={(e) => {
                  e.stopPropagation()
                  setPastedFiles(prev => prev.filter((_, i) => i !== index))
                }}
                title="移除文件"
              >
                <X size={13} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          ))}
          {(screenshotImages.length > 0 || pastedFiles.length > 0) && (
            <button
              className="screenshot-preview-add-more"
              onClick={() => window.api.startScreenshot()}
              title="继续截图"
            >
              <Plus size={14} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />
              继续截图
            </button>
          )}
        </div>
      )}
      <style>{`
        .chat-input-window-wrapper {
          width: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: flex-start;
          box-sizing: border-box;
          padding: 8px 10px;
          overflow: visible; /* 必须是 visible，否则绝对定位的下拉列表在缩短高度时会被截断 */
          background: transparent;
          transition: height 0.35s cubic-bezier(0.25, 0.8, 0.25, 1);
        }

        .screenshot-previews-container {
          width: calc(100% - 4px);
          height: 54px;
          background: rgba(255, 255, 255, 0.85);
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          border: 1px solid rgba(255, 255, 255, 0.6);
          border-radius: 12px;
          margin-bottom: 8px;
          display: flex;
          align-items: center;
          padding: 0 10px;
          box-sizing: border-box;
          box-shadow: inset 0 1.5px 2px rgba(255, 255, 255, 0.85),
                      0 4px 12px rgba(0,0,0,0.04);
          -webkit-app-region: no-drag;
          align-self: stretch;
          gap: 8px;
          overflow-x: auto;
          animation: slideDown 0.28s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .screenshot-previews-container::-webkit-scrollbar {
          height: 3px;
        }
        .screenshot-previews-container::-webkit-scrollbar-thumb {
          background: rgba(0, 0, 0, 0.1);
          border-radius: 2px;
        }

        @keyframes slideDown {
          from { opacity: 0; transform: translateY(-8px) scale(0.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }

        .screenshot-preview-item {
          display: flex;
          align-items: center;
          background: rgba(0, 0, 0, 0.03);
          border: 1.2px solid rgba(0, 0, 0, 0.06);
          padding: 3px 6px 3px 4px;
          border-radius: 8px;
          gap: 6px;
          height: 36px;
          box-sizing: border-box;
          flex-shrink: 0;
          position: relative;
        }

        .screenshot-preview-thumb {
          width: 28px;
          height: 28px;
          border-radius: 4px;
          object-fit: cover;
          border: 1px solid rgba(0,0,0,0.08);
        }

        .screenshot-preview-meta {
          font-size: 9.5px;
          color: #64748b;
          font-weight: 500;
        }

        .screenshot-preview-remove {
          background: rgba(0, 0, 0, 0.06);
          border: none;
          color: #64748b;
          font-size: 11px;
          cursor: pointer;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s;
          padding: 0;
          line-height: 1;
        }

        .screenshot-preview-remove:hover {
          background: #ef4444;
          color: #ffffff;
        }

        .screenshot-preview-add-more {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 36px;
          padding: 0 10px;
          border-radius: 8px;
          border: 1px dashed rgba(59, 130, 246, 0.5);
          background: rgba(59, 130, 246, 0.03);
          color: #2563eb;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
          flex-shrink: 0;
        }

        .screenshot-preview-add-more:hover {
          background: rgba(59, 130, 246, 0.08);
          border-color: #2563eb;
        }

        .pasted-file-icon {
          width: 28px;
          height: 28px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 16px;
          flex-shrink: 0;
          background: rgba(0, 0, 0, 0.02);
          border-radius: 4px;
        }

        .pasted-file-name {
          max-width: 90px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 9px !important;
          letter-spacing: -0.2px;
        }

        @keyframes gradientMove {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }

        .chat-input-container {
          width: 100%;
          height: 50px;
          background: linear-gradient(135deg, rgba(246, 246, 248, 0.94), rgba(228, 232, 240, 0.88), rgba(255, 255, 255, 0.96));
          background-size: 200% 200%;
          animation: gradientMove 8s ease infinite;
          backdrop-filter: blur(30px) saturate(190%);
          -webkit-backdrop-filter: blur(30px) saturate(190%);
          border: 1px solid rgba(255, 255, 255, 0.6);
          border-radius: 999px;
          box-shadow: inset 0 1.5px 2px rgba(255, 255, 255, 0.85), 
                      inset 0 -1px 2px rgba(0, 0, 0, 0.04),
                      0 4px 16px rgba(0, 0, 0, 0.08);
          display: flex;
          align-items: center;
          padding: 0 10px 0 6px;
          box-sizing: border-box;
          transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
          -webkit-app-region: no-drag;
          position: relative;
        }

        .chat-input-container:focus-within {
          border-color: rgba(255, 255, 255, 0.8);
          box-shadow: inset 0 1.5px 2.5px rgba(255, 255, 255, 0.95),
                      inset 0 -1px 2px rgba(0, 0, 0, 0.04);
          background: linear-gradient(135deg, rgba(246, 246, 248, 0.97), rgba(230, 235, 243, 0.93), rgba(255, 255, 255, 0.98));
          background-size: 200% 200%;
        }

        .drag-handle {
          width: 18px;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: grab;
          -webkit-app-region: drag;
          user-select: none;
          opacity: 0.5;
          transition: opacity 0.2s;
        }

        .drag-handle:hover {
          opacity: 0.8;
        }

        .icon-wrapper {
          display: flex;
          align-items: center;
          justify-content: center;
          color: #475569;
          margin-right: 4px;
          opacity: 0.85;
          filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.05));
          -webkit-app-region: drag;
        }

        .chat-bubble-icon {
          animation: pulse 2s infinite ease-in-out;
        }

        @keyframes pulse {
          0% { transform: scale(1); opacity: 0.8; }
          50% { transform: scale(1.06); opacity: 1; }
          100% { transform: scale(1); opacity: 0.8; }
        }

        /* 历史下拉菜单触发按钮 */
        .history-dropdown-trigger {
          display: flex;
          align-items: center;
          gap: 1px;
          height: 28px;
          padding: 0 4px 0 6px;
          border-radius: 999px;
          border: none;
          background: rgba(0, 0, 0, 0.04);
          color: #475569;
          cursor: pointer;
          transition: all 0.2s ease;
          outline: none;
          -webkit-app-region: no-drag;
          margin-right: 6px;
          flex-shrink: 0;
        }

        .history-dropdown-trigger:hover {
          background: rgba(0, 0, 0, 0.08);
          color: #0f172a;
        }

        .history-dropdown-trigger.active {
          background: rgba(59, 130, 246, 0.1);
          color: #2563eb;
        }

        .dropdown-arrow {
          font-size: 10px;
          opacity: 0.7;
          transform: translateY(0.5px);
        }

        /* 历史会话下拉菜单样式 */
        .history-dropdown-menu {
          position: absolute;
          top: 60px;
          left: 36px;
          width: 328px;
          max-height: 145px;
          background: linear-gradient(135deg, rgba(255, 255, 255, 0.96), rgba(243, 244, 246, 0.94));
          backdrop-filter: blur(25px) saturate(180%);
          -webkit-backdrop-filter: blur(25px) saturate(180%);
          border: 1px solid rgba(255, 255, 255, 0.8);
          border-radius: 12px;
          box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 
                      0 8px 10px -6px rgba(0, 0, 0, 0.1),
                      inset 0 1px 1px rgba(255, 255, 255, 0.9);
          padding: 5px 0;
          box-sizing: border-box;
          overflow-y: auto;
          z-index: 1000;
          animation: dropdownFadeIn 0.22s cubic-bezier(0.16, 1, 0.3, 1);
          -webkit-app-region: no-drag;
        }

        @keyframes dropdownFadeIn {
          from { opacity: 0; transform: translateY(-6px) scale(0.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }

        .history-dropdown-menu::-webkit-scrollbar {
          width: 4px;
        }
        .history-dropdown-menu::-webkit-scrollbar-thumb {
          background: rgba(0, 0, 0, 0.08);
          border-radius: 2px;
        }

        .dropdown-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 7px 12px;
          font-size: 12px;
          font-weight: 600;
          color: #334155;
          cursor: pointer;
          transition: all 0.15s ease;
          gap: 12px;
          user-select: none;
        }

        .dropdown-item:hover {
          background: rgba(0, 0, 0, 0.04);
          color: #0f172a;
        }

        .dropdown-item.active {
          background: rgba(59, 130, 246, 0.08);
          color: #2563eb;
        }

        .screenshot-btn {
          width: 30px;
          height: 30px;
          border-radius: 50%;
          border: none;
          background: transparent;
          color: #64748b;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: all 0.2s;
          margin-right: 2px;
          flex-shrink: 0;
          -webkit-app-region: no-drag;
        }

        .screenshot-btn:hover {
          color: #3b82f6;
          background: rgba(59, 130, 246, 0.08);
        }

        .new-session-item {
          color: #2563eb;
          border-bottom: 1px solid rgba(0, 0, 0, 0.04);
          padding-bottom: 8px;
          margin-bottom: 3px;
        }
        
        .new-session-item:hover {
          background: rgba(59, 130, 246, 0.05);
          color: #1d4ed8;
        }

        .item-icon {
          font-size: 13px;
          font-weight: bold;
        }

        .session-title {
          flex: 1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .session-time {
          font-size: 10px;
          color: #94a3b8;
          font-weight: 500;
          flex-shrink: 0;
        }

        .chat-input-field {
          flex: 1;
          background: transparent;
          border: none;
          outline: none;
          color: #000000;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
          font-size: 13px;
          font-weight: 600;
          letter-spacing: 0.3px;
          height: 100%;
          padding: 0 4px;
          -webkit-app-region: no-drag;
        }

        .chat-input-field::placeholder {
          color: rgba(0, 0, 0, 0.38);
          font-size: 11.5px;
        }

        .send-btn {
          width: 30px;
          height: 30px;
          border-radius: 50%;
          border: none;
          background: transparent;
          color: rgba(0, 0, 0, 0.28);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: all 0.25s ease;
          -webkit-app-region: no-drag;
          outline: none;
          margin-left: 6px;
        }

        .send-btn.active {
          background: rgba(17, 24, 39, 0.85);
          color: #ffffff;
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
        }

        .send-btn.active:hover {
          background: rgba(17, 24, 39, 0.95);
          transform: scale(1.05);
        }

        .send-btn.active:active {
          transform: scale(0.95);
        }

        .close-window-btn {
          width: 28px;
          height: 28px;
          border-radius: 50%;
          border: none;
          background: transparent;
          color: rgba(0, 0, 0, 0.3);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          margin-left: 6px;
          transition: all 0.2s ease;
          -webkit-app-region: no-drag;
          outline: none;
        }

        .close-window-btn:hover {
          background: rgba(220, 50, 50, 0.15);
          color: #dc2626;
          transform: scale(1.05);
        }

        .close-window-btn:active {
          transform: scale(0.95);
        }

        /* 迷你 chat 框面板及动画 */
        .mini-chat-panel {
          width: 100%;
          margin-top: 8px;
          background: linear-gradient(135deg, rgba(246, 246, 248, 0.96), rgba(228, 232, 240, 0.92), rgba(255, 255, 255, 0.98));
          backdrop-filter: blur(30px) saturate(190%);
          -webkit-backdrop-filter: blur(30px) saturate(190%);
          border: 1px solid rgba(255, 255, 255, 0.6);
          border-radius: 16px;
          box-shadow: none;
          padding: 10px 12px 12px 12px;
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          height: 300px;
          -webkit-app-region: no-drag;
          opacity: 0;
          animation: miniChatFadeIn 0.3s cubic-bezier(0.25, 0.8, 0.25, 1) 0.1s forwards;
        }

        @keyframes miniChatFadeIn {
          from {
            opacity: 0;
            transform: translateY(-8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .mini-panel-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid rgba(0, 0, 0, 0.05);
          padding-bottom: 5px;
          margin-bottom: 6px;
          flex-shrink: 0;
          -webkit-app-region: no-drag;
        }

        .mini-panel-title {
          font-size: 11px;
          font-weight: 700;
          color: #64748b;
          letter-spacing: 0.5px;
        }

        .action-btn {
          border: none;
          background: transparent;
          font-size: 11px;
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 3.5px;
          cursor: pointer;
          padding: 2.5px 7px;
          border-radius: 6px;
          transition: all 0.2s ease;
          outline: none;
          -webkit-app-region: no-drag;
        }

        .chat-link-btn {
          color: #3b82f6;
        }

        .chat-link-btn:hover {
          background: rgba(59, 130, 246, 0.08);
          color: #2563eb;
        }

        .clear-chat-btn {
          border: none;
          background: transparent;
          color: #ef4444;
          font-size: 11px;
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 3px;
          cursor: pointer;
          padding: 2.5px 7px;
          border-radius: 6px;
          transition: all 0.2s;
          outline: none;
          -webkit-app-region: no-drag;
        }

        .clear-chat-btn:hover {
          background: rgba(239, 68, 68, 0.08);
        }

        .clear-chat-btn:active {
          transform: scale(0.95);
        }

        /* 迷你骨架屏样式 */
        .mini-skeleton-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
          width: 100%;
        }

        .mini-skeleton-item {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          animation: skeletonPulse 1.2s infinite ease-in-out;
        }

        .mini-skeleton-item .skeleton-avatar {
          width: 22px;
          height: 22px;
          border-radius: 50%;
          background: rgba(0, 0, 0, 0.05);
          flex-shrink: 0;
        }

        .mini-skeleton-item .skeleton-line {
          height: 14px;
          background: rgba(0, 0, 0, 0.05);
          border-radius: 4px;
          margin-top: 4px;
        }

        .mini-skeleton-item .skeleton-line.short {
          width: 80px;
        }

        .mini-skeleton-item .skeleton-line.medium {
          width: 160px;
        }

        .mini-skeleton-item .skeleton-line.long {
          width: 230px;
        }

        @keyframes skeletonPulse {
          0% { opacity: 0.55; }
          50% { opacity: 0.95; }
          100% { opacity: 0.55; }
        }

        .mini-chat-list {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 10px;
          overflow-y: auto;
          -webkit-app-region: no-drag;
        }

        .mini-chat-list::-webkit-scrollbar {
          width: 4px;
        }
        .mini-chat-list::-webkit-scrollbar-thumb {
          background: rgba(0, 0, 0, 0.08);
          border-radius: 2px;
        }

        .mini-chat-msg {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          animation: msgFadeIn 0.25s ease forwards;
        }

        @keyframes msgFadeIn {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .msg-avatar {
          width: 22px;
          height: 22px;
          border-radius: 50%;
          background: rgba(0, 0, 0, 0.05);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 11px;
          user-select: none;
          flex-shrink: 0;
          margin-top: 1px;
        }

        .msg-content {
          flex: 1;
          font-size: 12.5px;
          line-height: 1.5;
          color: #1e293b;
          font-weight: 500;
        }

        .mini-chat-msg.user .msg-content {
          color: #0f172a;
          font-weight: 600;
        }

        .mini-chat-msg.agent .msg-content {
          color: #334155;
        }

        .thinking-dots {
          display: inline-flex;
          gap: 3px;
          align-items: center;
          padding-top: 4px;
        }

        .thinking-dots span {
          width: 5px;
          height: 5px;
          background: #475569;
          border-radius: 50%;
          animation: dotBlink 1.4s infinite both;
        }

        .thinking-dots span:nth-child(2) {
          animation-delay: 0.2s;
        }

        .thinking-dots span:nth-child(3) {
          animation-delay: 0.4s;
        }

        @keyframes dotBlink {
          0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
          40% { transform: scale(1.2); opacity: 1; }
        }
      `}</style>

      <div className="chat-input-container">
        {/* 拖动把手，带有点阵图标 */}
        <div
          className="drag-handle"
          title="按住拖拽窗口"
          onMouseDown={handleMouseDown}
        >
          <GripVertical size={15} strokeWidth={2} aria-hidden="true" />
        </div>

        {/* 精致聊天泡泡图标 */}
        <div className="icon-wrapper">
          <MessageSquare size={18} strokeWidth={2} className="chat-bubble-icon" aria-hidden="true" />
        </div>

        {/* 历史下拉菜单触发按钮 */}
        <button
          className={`history-dropdown-trigger ${showDropdown ? 'active' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            setShowDropdown(!showDropdown)
          }}
          title="历史会话"
        >
          <History size={14} strokeWidth={2} aria-hidden="true" />
          <span className="dropdown-arrow"><ChevronDown size={11} strokeWidth={2} aria-hidden="true" /></span>
        </button>

        {/* 输入框 */}
        <input
          ref={inputRef}
          type="text"
          className="chat-input-field"
          placeholder={placeholderText}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />

        {/* 截图按钮 */}
        <button
          className="screenshot-btn"
          onClick={() => window.api.startScreenshot()}
          title="屏幕截图区域提问"
        >
          <Camera size={16} strokeWidth={2} aria-hidden="true" />
        </button>

        {/* 发送按钮 */}
        <button
          className={`send-btn ${(text.trim() || screenshotImages.length > 0 || pastedFiles.length > 0) ? 'active' : ''}`}
          onClick={handleSend}
          disabled={!text.trim() && screenshotImages.length === 0 && pastedFiles.length === 0}
        >
          <Send size={16} strokeWidth={2} aria-hidden="true" />
        </button>

        {/* 关闭窗口按钮 */}
        <button className="close-window-btn" onClick={() => window.api.closeInputWindow()} title="关闭">
          <X size={15} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      {/* 历史会话下拉菜单 */}
      {showDropdown && (
        <div className="history-dropdown-menu" onClick={(e) => e.stopPropagation()}>
          <div className="dropdown-item new-session-item" onClick={handleCreateNewSession}>
            <span className="item-icon"><Plus size={14} strokeWidth={2} aria-hidden="true" /></span> 新建会话
          </div>
          {sessions.length === 0 ? (
            <div style={{ padding: '10px 0', textAlign: 'center', fontSize: '11px', color: '#94a3b8' }}>
              无历史会话记录
            </div>
          ) : (
            sessions.map(session => (
              <div
                key={session.id}
                className={`dropdown-item ${session.id === currentSessionId ? 'active' : ''}`}
                onClick={() => handleSwitchSession(session.id)}
              >
                <span className="session-title" title={session.name}>{session.name}</span>
                <span className="session-time">
                  {session.createdAt || session.time ? formatSessionTime(session.createdAt || session.time) : ''}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      {/* 迷你 chat 对话面板 (在下方顺着滑出) */}
      {showChat && (
        <div className="mini-chat-panel">
          <div className="mini-panel-header">
            <span className="mini-panel-title"><Lightbulb size={15} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />快捷会话</span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                className="action-btn chat-link-btn"
                onClick={() => {
                  // 广播会话更新，确保 Agent 窗口加载最新数据
                  const activeId = localStorage.getItem('agentself_active_session_id') || localStorage.getItem('agentpet_active_session_id') || ''
                  if (window.electron && window.electron.ipcRenderer) {
                    window.electron.ipcRenderer.send('api:wechat-session-updated', activeId)
                  }
                  window.api.openAgentWindow()
                  window.api.closeInputWindow()
                }}
                title="在主窗口中打开该对话"
              >
                <ExternalLink size={13} strokeWidth={2} aria-hidden="true" />
                完整对话
              </button>

              <button className="clear-chat-btn" onClick={handleClearAll} title="清空当前对话并收起">
                <Trash2 size={12} strokeWidth={2} aria-hidden="true" />
                收起
              </button>
            </div>
          </div>

          <div className="mini-chat-list">
            {isLoadingHistory ? (
              <div className="mini-skeleton-list">
                <div className="mini-skeleton-item">
                  <div className="skeleton-avatar"></div>
                  <div className="skeleton-line short"></div>
                </div>
                <div className="mini-skeleton-item">
                  <div className="skeleton-avatar"></div>
                  <div className="skeleton-line long"></div>
                </div>
                <div className="mini-skeleton-item">
                  <div className="skeleton-avatar"></div>
                  <div className="skeleton-line medium"></div>
                </div>
              </div>
            ) : (
              messages.map((m, idx) => (
                <div key={idx} className={`mini-chat-msg ${m.sender}`}>
                  <div className="msg-avatar">
                    {m.sender === 'user'
                      ? <User size={16} strokeWidth={2} aria-hidden="true" />
                      : <Bot size={16} strokeWidth={2} aria-hidden="true" />}
                  </div>
                  <div className="msg-content">{renderMessageText(m.text)}</div>
                </div>
              ))
            )}
            {isThinking && (
              <div className="mini-chat-msg agent">
                <div className="msg-avatar"><Bot size={16} strokeWidth={2} aria-hidden="true" /></div>
                <div className="msg-content">
                  <div className="thinking-dots">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>
      )}
    </div>
  )
}
