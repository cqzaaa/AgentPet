import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Download, ExternalLink, Home, LoaderCircle, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { useAppStoreRaw } from '../hooks/useAppStore'
import './SkillHubPage.css'

const SKILLHUB_HOME = 'https://www.skillhub.cn/'

type SkillHubInstallState = {
  status: 'downloading' | 'validating' | 'installed' | 'failed'
  filename: string
  receivedBytes?: number
  totalBytes?: number
  skillName?: string
  error?: string
}

function formatMegabytes(bytes = 0): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function SkillHubPage(): React.JSX.Element {
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const [loading, setLoading] = useState(true)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [currentUrl, setCurrentUrl] = useState(SKILLHUB_HOME)
  const [loadError, setLoadError] = useState('')
  const [installState, setInstallState] = useState<SkillHubInstallState | null>(null)
  const setSkillsList = useAppStoreRaw(state => state.setSkillsList)
  const setDisabledSkillNames = useAppStoreRaw(state => state.setDisabledSkillNames)

  const syncNavigation = useCallback(() => {
    const webview = webviewRef.current
    if (!webview) return
    setCanGoBack(webview.canGoBack())
    setCanGoForward(webview.canGoForward())
    setCurrentUrl(webview.getURL() || SKILLHUB_HOME)
  }, [])

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return undefined

    const handleStart = (): void => { setLoading(true); setLoadError('') }
    const handleStop = (): void => { setLoading(false); syncNavigation() }
    const handleNavigate = (): void => syncNavigation()
    const handleFail = (event: Event): void => {
      const detail = event as Event & { errorCode?: number; errorDescription?: string }
      if (detail.errorCode === -3) return
      setLoading(false)
      setLoadError(detail.errorDescription || 'SkillHub 页面暂时无法加载')
    }

    webview.addEventListener('did-start-loading', handleStart)
    webview.addEventListener('did-stop-loading', handleStop)
    webview.addEventListener('did-navigate', handleNavigate)
    webview.addEventListener('did-navigate-in-page', handleNavigate)
    webview.addEventListener('did-fail-load', handleFail)
    return () => {
      webview.removeEventListener('did-start-loading', handleStart)
      webview.removeEventListener('did-stop-loading', handleStop)
      webview.removeEventListener('did-navigate', handleNavigate)
      webview.removeEventListener('did-navigate-in-page', handleNavigate)
      webview.removeEventListener('did-fail-load', handleFail)
    }
  }, [syncNavigation])

  useEffect(() => window.api.onSkillHubInstallEvent((event) => {
    setInstallState(event)
    if (event.status === 'installed') {
      void window.api.getSkillsList().then(list => {
        setSkillsList(list)
        setDisabledSkillNames(list.filter((skill: any) => !skill.enabled).map((skill: any) => skill.name))
      }).catch(console.error)
    }
  }), [setDisabledSkillNames, setSkillsList])

  const goHome = (): void => {
    setLoadError('')
    webviewRef.current?.loadURL(SKILLHUB_HOME)
  }

  return (
    <section className="skillhub-page" aria-label="腾讯 SkillHub 技能市场">
      <header className="skillhub-toolbar">
        <div className="skillhub-source">
          <span className="skillhub-source-mark">S</span>
          <span><strong>SkillHub</strong><small>腾讯第三方服务</small></span>
        </div>

        <nav className="skillhub-nav" aria-label="网页导航">
          <button type="button" disabled={!canGoBack} onClick={() => webviewRef.current?.goBack()} title="后退"><ArrowLeft size={15} /></button>
          <button type="button" disabled={!canGoForward} onClick={() => webviewRef.current?.goForward()} title="前进"><ArrowRight size={15} /></button>
          <button type="button" onClick={() => webviewRef.current?.reload()} title="刷新"><RefreshCw className={loading ? 'is-spinning' : ''} size={14} /></button>
          <button type="button" onClick={goHome} title="返回市场首页"><Home size={14} /></button>
        </nav>

        <div className="skillhub-location" title={currentUrl}>
          <ShieldCheck size={13} />
          <span>{currentUrl.replace(/^https:\/\//, '')}</span>
        </div>

        <button className="skillhub-external" type="button" onClick={() => window.api.openExternalUrl(currentUrl)} title="在默认浏览器中打开">
          <ExternalLink size={14} /><span>浏览器打开</span>
        </button>
      </header>

      <div className={`skillhub-loading-line ${loading ? 'is-visible' : ''}`} aria-hidden="true"><span /></div>

      <div className="skillhub-viewport">
        {loadError && (
          <div className="skillhub-error" role="alert">
            <span><LoaderCircle size={18} /></span>
            <strong>无法打开 SkillHub</strong>
            <p>{loadError}</p>
            <button type="button" onClick={goHome}>重新加载</button>
          </div>
        )}
        <webview
          ref={webviewRef as React.RefObject<Electron.WebviewTag>}
          src={SKILLHUB_HOME}
          partition="persist:skillhub-market"
          className="skillhub-webview"
        />
        {installState && (
          <aside className={`skillhub-install-toast is-${installState.status}`} role="status" aria-live="polite">
            <span className="skillhub-install-icon">
              {installState.status === 'downloading' && <Download size={16} />}
              {installState.status === 'validating' && <LoaderCircle className="is-spinning" size={16} />}
              {installState.status === 'installed' && <CheckCircle2 size={16} />}
              {installState.status === 'failed' && <AlertTriangle size={16} />}
            </span>
            <div className="skillhub-install-copy">
              <strong>
                {installState.status === 'downloading' && '正在下载 Skill'}
                {installState.status === 'validating' && '正在校验并安装'}
                {installState.status === 'installed' && 'Skill 已安装'}
                {installState.status === 'failed' && '安装失败'}
              </strong>
              <small>
                {installState.status === 'downloading' && `${installState.filename} · ${formatMegabytes(installState.receivedBytes)}${installState.totalBytes ? ` / ${formatMegabytes(installState.totalBytes)}` : ''}`}
                {installState.status === 'validating' && '检查来源、压缩包路径和 SKILL.md'}
                {installState.status === 'installed' && `${installState.skillName || installState.filename} 已加入本地技能`}
                {installState.status === 'failed' && (installState.error || '无法安装该 ZIP 包')}
              </small>
              {installState.status === 'downloading' && installState.totalBytes && installState.totalBytes > 0 ? (
                <span className="skillhub-install-progress"><i style={{ width: `${Math.min(100, installState.receivedBytes! / installState.totalBytes * 100)}%` }} /></span>
              ) : null}
            </div>
            {(installState.status === 'installed' || installState.status === 'failed') && (
              <button type="button" onClick={() => setInstallState(null)} title="关闭提示"><X size={14} /></button>
            )}
          </aside>
        )}
      </div>

      <footer className="skillhub-trust-note">
        <ShieldCheck size={12} />网页运行在隔离环境中；点击下载 Zip 后由 AgentPet 校验并安装到本地技能目录。
      </footer>
    </section>
  )
}
