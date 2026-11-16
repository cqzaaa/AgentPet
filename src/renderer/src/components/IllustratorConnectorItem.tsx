import { useCallback, useEffect, useState } from 'react'
import { useAppStoreRaw } from '../hooks/useAppStore'
import { Tooltip } from './Tooltip'
import {
  ILLUSTRATOR_CONNECTOR_ID,
  isIllustratorConnector,
  type LocalConnectorDetection
} from '../../../preload/illustrator-connector'
import './IllustratorConnectorItem.css'

interface ConnectorServerItem {
  id?: string
  args?: string[]
  enabled?: boolean
  status?: string
}

interface Props {
  config: { servers?: ConnectorServerItem[] } | null | undefined
  refreshMcpServers: () => Promise<void>
  showToast: (message: string, type: 'success' | 'error') => void
  onManage: () => void
}

function IllustratorMark(): React.JSX.Element {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect
        x="2.5"
        y="2.5"
        width="19"
        height="19"
        rx="4.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M7.6 16.5L10.35 7.8H11.85L14.6 16.5M8.55 13.7H13.65"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M16.65 11.15V16.5"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
      />
      <circle cx="16.65" cy="8.35" r="0.95" fill="currentColor" />
    </svg>
  )
}

function ConnectorSettingsGlyph(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 7H13M17 7H20M4 17H7M11 17H20"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
      />
      <circle cx="15" cy="7" r="2" stroke="currentColor" strokeWidth="1.55" />
      <circle cx="9" cy="17" r="2" stroke="currentColor" strokeWidth="1.55" />
    </svg>
  )
}

export function IllustratorConnectorItem({
  config,
  refreshMcpServers,
  showToast,
  onManage
}: Props): React.JSX.Element {
  const [detecting, setDetecting] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [detection, setDetection] = useState<LocalConnectorDetection | null>(null)
  const activeServers = useAppStoreRaw(state => state.activeMcpServers)

  const server = config?.servers?.find(isIllustratorConnector)
  const connected = Boolean(
    server?.enabled &&
      activeServers.some(
        (item: ConnectorServerItem) => item.id === server.id && item.status === 'connected'
      )
  )

  const runDetect = useCallback(async (announce = false): Promise<LocalConnectorDetection | null> => {
    if (detecting) return detection
    setDetecting(true)
    try {
      const result = await window.api.detectLocalConnector(ILLUSTRATOR_CONNECTOR_ID)
      setDetection(result)
      if (announce) {
        if (!result.platformSupported) {
          showToast('当前系统暂不支持本地 Illustrator 连接器', 'error')
        } else if (!result.installed) {
          showToast('未检测到本机 Adobe Illustrator', 'error')
        } else {
          const detail = [
            result.versionLabel ? `Adobe Illustrator ${result.versionLabel}` : 'Adobe Illustrator',
            result.running ? '运行中' : '已安装',
            result.nodeReady ? `隔离 Node v${result.nodeVersion}` : '隔离 Node 待就绪'
          ].join(' · ')
          showToast(detail, 'success')
        }
      }
      return result
    } catch (error) {
      if (announce) {
        showToast(`检测本机 Illustrator 失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      }
      return null
    } finally {
      setDetecting(false)
    }
  }, [detecting, detection, showToast])

  useEffect(() => {
    let cancelled = false
    window.api
      .detectLocalConnector(ILLUSTRATOR_CONNECTOR_ID)
      .then((result) => {
        if (!cancelled) setDetection(result)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const toggleConnector = async (): Promise<void> => {
    if (connecting || detecting) return
    setConnecting(true)
    try {
      const action = server?.enabled ? 'disable' : 'enable'
      const res = await window.api.connectLocalConnector(ILLUSTRATOR_CONNECTOR_ID, action)
      if (res.detection) setDetection(res.detection)
      await refreshMcpServers()

      if (res.code === 'DISABLED') {
        showToast('Illustrator 连接器已停用', 'success')
      } else if (res.code === 'CONNECTED') {
        const count = res.detection?.toolsCount || 0
        showToast(count > 0 ? `Illustrator 已连接（${count} 个工具）` : 'Illustrator 连接器已连接', 'success')
      } else if (res.code === 'APP_NOT_INSTALLED') {
        showToast('未检测到本机 Adobe Illustrator，请先安装后再连接', 'error')
      } else if (res.code === 'NODE_RUNTIME_CANCELLED') {
        showToast('已取消隔离 Node 运行时安装', 'error')
      } else {
        showToast(res.error || 'Illustrator 连接失败，请在 MCP 管理中测试连接', 'error')
      }
    } catch (error) {
      showToast(`操作失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      setConnecting(false)
    }
  }

  const busy = detecting || connecting
  const statusState = detecting
    ? 'detecting'
    : connecting
      ? 'connecting'
      : connected
        ? 'connected'
        : detection && !detection.installed
          ? 'missing'
          : detection?.running
            ? 'running'
            : detection?.installed
              ? 'installed'
              : 'idle'

  const pillLabel = detecting
    ? '检测中'
    : connecting
      ? '连接中'
      : connected
        ? '已连接'
        : server?.enabled
          ? '未连接'
          : detection
            ? (!detection.installed ? '未安装' : detection.running ? '运行中' : '已安装')
            : '待检测'

  const pillTone = busy
    ? 'busy'
    : connected
      ? 'connected'
      : detection && !detection.installed
        ? 'missing'
        : detection?.running
          ? 'running'
          : detection?.installed
            ? 'installed'
            : 'idle'

  const iconTooltip = detection
    ? (detection.installed
        ? `${detection.appName}${detection.versionLabel ? ` ${detection.versionLabel}` : ''} · ${detection.running ? '运行中' : '已安装'}（点击重新检测）`
        : '未检测到本机 Adobe Illustrator（点击重新检测）')
    : '点击检测本机 Adobe Illustrator'

  return (
    <div className="connector-section">
      <div className="connector-row">
        <Tooltip content={iconTooltip} placement="top">
          <button
            type="button"
            className={`connector-icon-bezel ${detecting ? 'is-detecting' : ''}`}
            disabled={busy}
            onClick={() => void runDetect(true)}
            aria-label="检测本机 Adobe Illustrator"
          >
            <span className="connector-icon-core">
              <IllustratorMark />
            </span>
            <span className={`connector-icon-beacon state-${statusState}`} aria-hidden="true" />
          </button>
        </Tooltip>

        <button
          type="button"
          className="connector-main-trigger"
          disabled={busy}
          onClick={() => void toggleConnector()}
          title={server?.enabled ? '点击停用 Illustrator 连接器' : '点击连接本地 Illustrator'}
        >
          <span className="connector-title">Illustrator</span>
          <span className={`connector-pill tone-${pillTone}`}>{pillLabel}</span>
        </button>

        <Tooltip content="MCP 管理" placement="top">
          <button
            type="button"
            className="connector-manage-btn"
            onClick={onManage}
            aria-label="打开 MCP 管理"
          >
            <ConnectorSettingsGlyph />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
