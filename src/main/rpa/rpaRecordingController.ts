import { BrowserWindow, screen } from 'electron'

export type RecordingControllerMode = 'browser' | 'desktop'

export interface RecordingControllerHandle {
  window: BrowserWindow
  processId: number
  setFinalizing: () => void
  closeSilently: () => void
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character] || character)
}

export async function createRecordingController(input: {
  mode: RecordingControllerMode
  targetLabel: string
  onFinish: () => void
}): Promise<RecordingControllerHandle> {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const width = Math.min(560, display.workArea.width - 24)
  const window = new BrowserWindow({
    width,
    height: 62,
    x: display.workArea.x + Math.round((display.workArea.width - width) / 2),
    y: display.workArea.y + 8,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  window.setAlwaysOnTop(true, 'screen-saver')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  const modeLabel = input.mode === 'browser' ? '浏览器录制' : '电脑录制'
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;color:#20201e;font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif}body{padding:6px}.bar{height:50px;display:flex;align-items:center;gap:10px;padding:0 8px 0 14px;border:1px solid rgba(32,32,30,.16);border-radius:14px;background:rgba(255,255,253,.96);box-shadow:0 10px 34px rgba(24,24,22,.2);backdrop-filter:blur(18px);-webkit-app-region:drag}.state{display:flex;align-items:center;gap:8px;flex:none;font-size:11px;font-weight:650;color:#494944}.dot{width:8px;height:8px;border-radius:50%;background:#e5484d;box-shadow:0 0 0 4px rgba(229,72,77,.12);animation:pulse 1.6s ease-in-out infinite}.divider{width:1px;height:22px;background:#e2e2dd;flex:none}.mode{flex:none;padding:4px 7px;border-radius:7px;background:#f0f0ed;color:#65655f;font:650 9px/1 ui-monospace,SFMono-Regular,Consolas,monospace}.target{min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#777772;font-size:10.5px}.timer{flex:none;font:650 11px/1 ui-monospace,SFMono-Regular,Consolas,monospace;color:#65655f}.finish{height:34px;padding:0 13px;border:0;border-radius:9px;background:#20201e;color:#fff;font-size:11px;font-weight:650;cursor:pointer;-webkit-app-region:no-drag}.finish:hover{background:#000}.finish:disabled{cursor:wait;background:#343431}.spinner{width:14px;height:14px;flex:none;border:2px solid #d2d2cd;border-top-color:#343431;border-radius:50%;animation:spin .72s linear infinite}@keyframes pulse{50%{opacity:.45;transform:scale(.88)}}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.dot,.spinner{animation:none}}
</style></head><body><section class="bar"><div class="state"><b class="dot" id="status-dot"></b><span id="status-label">正在录制</span></div><i class="divider"></i><span class="mode" id="mode-label">${escapeHtml(modeLabel)}</span><span class="target" id="target-label" title="${escapeHtml(input.targetLabel)}">${escapeHtml(input.targetLabel)}</span><span class="timer" id="timer">00:00</span><button class="finish" id="finish-button">结束</button></section><script>
const started=Date.now();
const timer=document.getElementById('timer');
const updateTimer=()=>{const seconds=Math.floor((Date.now()-started)/1000);timer.textContent=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0')};
const timerId=setInterval(updateTimer,250);
let timerStopped=false;
const stopTimer=()=>{if(timerStopped)return;timerStopped=true;updateTimer();clearInterval(timerId)};
document.getElementById('finish-button').onclick=()=>{stopTimer();window.open('https://rpa.local/finish','_blank')};
window.setFinalizing=()=>{stopTimer();document.getElementById('status-dot').outerHTML='<span class="spinner" id="status-dot"></span>';document.getElementById('status-label').textContent='正在生成流程';document.getElementById('mode-label').style.display='none';document.getElementById('target-label').textContent='正在整理操作并保存节点，请稍候…';const button=document.getElementById('finish-button');button.disabled=true;button.textContent='生成中'}
</script></body></html>`
  let silent = false
  let finishSent = false
  const setFinalizing = (): void => {
    if (!window.isDestroyed()) void window.webContents.executeJavaScript('window.setFinalizing?.()').catch(() => undefined)
  }
  const finish = (): void => {
    if (finishSent) return
    finishSent = true
    setFinalizing()
    input.onFinish()
  }
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'https://rpa.local/finish') finish()
    return { action: 'deny' }
  })
  window.on('close', () => { if (!silent && !finishSent) input.onFinish() })
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  window.showInactive()
  return {
    window,
    processId: window.webContents.getOSProcessId(),
    setFinalizing,
    closeSilently: () => { silent = true; if (!window.isDestroyed()) window.close() }
  }
}
