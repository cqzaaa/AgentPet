import { BrowserWindow, screen } from 'electron'

export interface RpaRunControllerHandle {
  window: BrowserWindow
  updateStep: (input: { label: string; index: number; total: number; surface?: string; state: string }) => void
  setPaused: (paused: boolean, canResume?: boolean) => void
  setResult: (status: 'success' | 'failed' | 'stopped', message?: string) => void
  close: () => void
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character] || character)
}

export async function createRpaRunController(input: {
  taskName: string
  totalSteps: number
  onPause: () => void
  onResume: () => void
  onStop: () => Promise<void>
}): Promise<RpaRunControllerHandle> {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const width = Math.min(680, display.workArea.width - 24)
  const height = 62
  const window = new BrowserWindow({
    width,
    height,
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

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;color:#20201e;font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif}body{padding:6px}.bar{height:50px;display:flex;align-items:center;gap:10px;padding:0 8px 0 14px;border:1px solid rgba(32,32,30,.16);border-radius:14px;background:rgba(255,255,253,.96);box-shadow:0 10px 34px rgba(24,24,22,.2);backdrop-filter:blur(18px);-webkit-app-region:drag}.state{display:flex;align-items:center;gap:8px;flex:none;font-size:11px;font-weight:650;color:#494944}.dot{width:8px;height:8px;border-radius:50%;background:#20a36a;box-shadow:0 0 0 4px rgba(32,163,106,.12);animation:pulse 1.6s ease-in-out infinite}.divider{width:1px;height:22px;background:#e2e2dd;flex:none}.step{flex:none;padding:4px 7px;border-radius:7px;background:#f0f0ed;color:#65655f;font:650 9px/1 ui-monospace,SFMono-Regular,Consolas,monospace}.label{min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#555550;font-size:10.5px}.surface{flex:none;color:#8a8a84;font:650 9px/1 ui-monospace,SFMono-Regular,Consolas,monospace;text-transform:uppercase}.timer{flex:none;font:650 11px/1 ui-monospace,SFMono-Regular,Consolas,monospace;color:#65655f}.control{height:34px;padding:0 11px;border:1px solid #d8d8d3;border-radius:9px;background:#fff;color:#3f3f3b;font-size:10.5px;font-weight:650;cursor:pointer;-webkit-app-region:no-drag}.control:hover{background:#f1f1ee}.control.stop{border-color:#efd1d2;color:#b23a3e;background:#fff7f7}.control:disabled{cursor:wait;opacity:.62}.spinner{width:14px;height:14px;border:2px solid #d2d2cd;border-top-color:#343431;border-radius:50%;animation:spin .72s linear infinite}@keyframes pulse{50%{opacity:.45;transform:scale(.88)}}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.dot,.spinner{animation:none}}
</style></head><body><section class="bar"><div class="state"><b class="dot" id="dot"></b><span id="status">运行中</span></div><i class="divider"></i><span class="step" id="step">0/${Math.max(1, input.totalSteps)}</span><span class="label" id="label" title="${escapeHtml(input.taskName)}">${escapeHtml(input.taskName)} · 准备执行</span><span class="surface" id="surface">SYSTEM</span><span class="timer" id="timer">00:00</span><button class="control" id="pause" onclick="window.open('https://rpa.local/toggle','_blank')">暂停</button><button class="control stop" id="stop" onclick="window.open('https://rpa.local/stop','_blank')">停止</button></section><script>const started=Date.now();setInterval(()=>{const seconds=Math.floor((Date.now()-started)/1000);document.getElementById('timer').textContent=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0')},250);window.updateStep=(v)=>{document.getElementById('step').textContent=v.index+'/'+v.total;document.getElementById('label').textContent=v.label;document.getElementById('label').title=v.label;document.getElementById('surface').textContent=v.surface||'SYSTEM'};window.setPaused=(paused,canResume=true)=>{document.getElementById('status').textContent=paused?(canResume?'已暂停':'等待确认'):'运行中';document.getElementById('dot').style.background=paused?'#d99a20':'#20a36a';const button=document.getElementById('pause');button.textContent=paused?(canResume?'继续':'等待确认'):'暂停';button.disabled=paused&&!canResume};window.setResult=(status,message)=>{const success=status==='success';document.getElementById('status').textContent=success?'已完成':status==='stopped'?'已停止':'运行失败';document.getElementById('dot').style.animation='none';document.getElementById('dot').style.background=success?'#20a36a':status==='stopped'?'#8a8a84':'#d64545';document.getElementById('label').textContent=message||document.getElementById('label').textContent;document.getElementById('pause').disabled=true;document.getElementById('stop').disabled=true}</script></body></html>`

  let paused = false
  let resumeLocked = false
  let stopping = false
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'https://rpa.local/toggle' && !stopping && !resumeLocked) {
      paused = !paused
      if (paused) input.onPause(); else input.onResume()
      void window.webContents.executeJavaScript(`window.setPaused(${paused})`).catch(() => undefined)
    } else if (url === 'https://rpa.local/stop' && !stopping) {
      stopping = true
      void window.webContents.executeJavaScript("document.getElementById('stop').disabled=true;document.getElementById('stop').textContent='停止中'").catch(() => undefined)
      void input.onStop()
    }
    return { action: 'deny' }
  })

  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  window.showInactive()

  const execute = (script: string): void => {
    if (!window.isDestroyed()) void window.webContents.executeJavaScript(script).catch(() => undefined)
  }
  return {
    window,
    updateStep: value => execute(`window.updateStep(${JSON.stringify(value)})`),
    setPaused: (value, canResume = true) => {
      paused = value
      resumeLocked = value && !canResume
      execute(`window.setPaused(${value},${canResume})`)
    },
    setResult: (status, message) => execute(`window.setResult(${JSON.stringify(status)},${JSON.stringify(message || '')})`),
    close: () => { if (!window.isDestroyed()) window.close() }
  }
}
