import { chromium, Browser, BrowserContext, Page } from 'playwright-core'
import type { BrowserRecordedAction } from './domain/types'

export type RecordedAction = BrowserRecordedAction

export class RpaBrowserRecorder {
  private static sessions = new Map<string, { paused: boolean; finish: () => Promise<void> }>()

  public static pause(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.paused = true
    return true
  }

  public static resume(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.paused = false
    return true
  }

  public static async finish(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    await session.finish()
    return true
  }
  /**
   * 启动浏览器，访问指定 URL 并录制用户的操作行为。
   * @param url 起始网页地址
   * @returns 录制的操作步骤数组。
   */
  public static async record(url: string, sessionId?: string): Promise<RecordedAction[]> {
    let browser: Browser | null = null
    let context: BrowserContext | null = null
    let page: Page | null = null

    const actions: RecordedAction[] = []

    // 记录初始打开网页的操作
    actions.push({ type: 'open_url', url })

    return new Promise(async (resolve) => {
      let isResolved = false

      const finish = async () => {
        if (isResolved) return
        isResolved = true
        resolve(actions)

        if (page) try { await page.close() } catch (_) {}
        if (context) try { await context.close() } catch (_) {}
        if (browser) try { await browser.close() } catch (_) {}
        if (sessionId) this.sessions.delete(sessionId)
      }

      if (sessionId) this.sessions.set(sessionId, { paused: false, finish })

      try {
        let launchOptions = {
          headless: false,
          channel: 'chrome',
          viewport: null, // 最大化
          args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
        }

        try {
          browser = await chromium.launch(launchOptions)
        } catch (chromeErr) {
          launchOptions.channel = 'msedge'
          browser = await chromium.launch(launchOptions)
        }

        context = await browser.newContext({ viewport: null })

        // 暴露回调函数，并在 context 级别注册，自动应用到所有新建页面与导航页面
        await context.addInitScript(() => {
          // 防重复注入
          if ((window as any).__rpaRecorderInjected) return
          ;(window as any).__rpaRecorderInjected = true

          let stepsCount = 1

          function getCssSelector(el: Element): string {
            if (!(el instanceof Element)) return ''
            const path: string[] = []
            let current = el
            while (current && current.nodeType === Node.ELEMENT_NODE) {
              if (current.nodeName.toLowerCase() === 'html') break
              
              let selector = current.nodeName.toLowerCase()
              if (current.id) {
                selector += '#' + current.id
                path.unshift(selector)
                break 
              } else {
                let sib = current
                let nth = 1
                while ((sib = sib.previousElementSibling as Element)) {
                  if (sib.nodeName.toLowerCase() === selector) nth++
                }
                
                let classPart = ''
                if (current.className && typeof current.className === 'string') {
                  const classes = current.className.split(/\s+/).filter(c => c && !c.includes(':') && !c.includes('['))
                  if (classes.length > 0) {
                    classPart = '.' + classes.join('.')
                  }
                }
                
                if (nth !== 1) {
                  selector += classPart + `:nth-of-type(${nth})`
                } else {
                  selector += classPart
                }
              }
              path.unshift(selector)
              current = current.parentNode as Element
            }
            return path.join(" > ")
          }

          function recordAction(action: any) {
            stepsCount++
            const stepSpan = document.getElementById('rpa-recorder-steps')
            if (stepSpan) {
              stepSpan.textContent = `已记录 ${stepsCount} 步`
            }
            if (typeof (window as any).rpaNotifyMainRecorder === 'function') {
              ;(window as any).rpaNotifyMainRecorder(action)
            }
          }

          // 1. 监听高亮与提示框鼠标移动事件 (立即绑定，不依赖 document.body)
          document.addEventListener('mousemove', (e) => {
            const el = e.target as Element
            if (!el) return

            const overlay = document.getElementById('rpa-recorder-status')
            const highlight = document.getElementById('rpa-recorder-highlight')
            const tooltip = document.getElementById('rpa-recorder-tooltip')

            // 排除状态面板、高亮覆盖条和提示框本身
            if (el === overlay || el.closest('#rpa-recorder-status') || el === highlight || el === tooltip) {
              if (highlight) highlight.style.display = 'none'
              if (tooltip) tooltip.style.display = 'none'
              return
            }

            const rect = el.getBoundingClientRect()
            if (highlight) {
              highlight.style.top = rect.top + 'px'
              highlight.style.left = rect.left + 'px'
              highlight.style.width = rect.width + 'px'
              highlight.style.height = rect.height + 'px'
              highlight.style.display = 'block'
            }

            if (tooltip) {
              const isInput = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
              const actionType = isInput ? '✍️ 输入记录' : '🖱️ 点击记录'
              const label = el.textContent ? el.textContent.trim().substring(0, 20) : ''
              tooltip.innerHTML = `<span style="color:#a855f7;font-weight:bold;">${actionType}</span> ${label ? `<br/>文本: ${label}` : ''}`
              tooltip.style.left = (e.clientX + 15) + 'px'
              tooltip.style.top = (e.clientY + 15) + 'px'
              tooltip.style.display = 'block'
            }
          }, true)

          document.addEventListener('mouseleave', () => {
            const highlight = document.getElementById('rpa-recorder-highlight')
            const tooltip = document.getElementById('rpa-recorder-tooltip')
            if (highlight) highlight.style.display = 'none'
            if (tooltip) tooltip.style.display = 'none'
          })

          // 2. 监听点击事件
          document.addEventListener('click', (e) => {
            const el = e.target as Element
            if (!el) return
            
            const overlay = document.getElementById('rpa-recorder-status')
            if (el === overlay || el.closest('#rpa-recorder-status')) return

            const highlight = document.getElementById('rpa-recorder-highlight')
            if (highlight) {
              // 点击时快速闪烁绿色反馈
              highlight.style.border = '2px solid #52c41a'
              highlight.style.background = 'rgba(82, 196, 26, 0.25)'
              setTimeout(() => {
                highlight.style.border = '2px dashed #1677ff'
                highlight.style.background = 'rgba(22, 119, 255, 0.08)'
              }, 150)
            }

            const selector = getCssSelector(el)
            const label = el.textContent ? el.textContent.trim().substring(0, 30) : ''
            
            recordAction({
              type: 'click',
              selector,
              label
            })
          }, true)

          // 3. 监听输入失焦(blur)和修改(change)事件以记录输入，使用 Map 去重
          const lastValues = new Map<string, string>()

          function handleInputEvent(e: Event) {
            const el = e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
            if (!el) return
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
              const selector = getCssSelector(el)
              const value = el.value
              if (lastValues.get(selector) !== value) {
                lastValues.set(selector, value)
                const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase()
                const identity = `${el.getAttribute('name') || ''} ${el.id || ''}`
                const sensitive =
                  (el instanceof HTMLInputElement && el.type === 'password') ||
                  /current-password|new-password|one-time-code|username/.test(autocomplete) ||
                  /pass(word)?|secret|token|api.?key|credential|user(name)?/i.test(identity)
                recordAction(sensitive
                  ? { type: 'fill', selector, sensitive: true }
                  : { type: 'fill', selector, value })
              }
            }
          }

          document.addEventListener('blur', handleInputEvent, true)
          document.addEventListener('change', handleInputEvent, true)

          // 4. 创建 UI 控件 (如果 body 没准备好，循环重试)
          function showOverlay() {
            if (!document.body) {
              setTimeout(showOverlay, 50)
              return
            }

            // A. 控制面板
            const overlayId = 'rpa-recorder-status'
            let overlay = document.getElementById(overlayId)
            if (!overlay) {
              overlay = document.createElement('div')
              overlay.id = overlayId
              overlay.style.cssText = 'position:fixed; bottom:20px; right:20px; z-index:9999999; background:rgba(22,119,255,0.95); color:#fff; padding:12px 18px; font-size:13px; border-radius:10px; box-shadow:0 6px 20px rgba(0,0,0,0.3); font-family:system-ui, -apple-system, sans-serif; border:1px solid rgba(255,255,255,0.2); line-height:1.5; text-align:left; font-weight:500; display:flex; flex-direction:column; gap:8px; pointer-events: auto;'
              
              const textSpan = document.createElement('span')
              textSpan.innerHTML = '🔴 RPA 正在录制网页操作...<br/><span id="rpa-recorder-steps" style="color:#fff;font-weight:bold;font-size:11px;opacity:0.95;">已记录 1 步</span>'
              overlay.appendChild(textSpan)

              const btn = document.createElement('button')
              btn.textContent = '✅ 完成录制'
              btn.style.cssText = 'background:#52c41a; color:#fff; border:none; border-radius:6px; padding:6px 12px; font-size:12px; font-weight:bold; cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.15); transition:background 0.2s; outline:none; pointer-events: auto; text-align:center; display:block; width:100%;'
              btn.onmouseover = () => { btn.style.background = '#73d13d' }
              btn.onmouseout = () => { btn.style.background = '#52c41a' }
              
              // 点击完成录制，阻止事件冒泡和默认行为，避免在自身录制到点击
              btn.addEventListener('click', (e) => {
                e.stopPropagation()
                e.preventDefault()
                if (typeof (window as any).rpaNotifyMainRecorder === 'function') {
                  ;(window as any).rpaNotifyMainRecorder({ type: 'finish' })
                }
              }, true)

              overlay.appendChild(btn)
              document.body.appendChild(overlay)
            }

            // B. 高亮指示覆盖层
            const highlightId = 'rpa-recorder-highlight'
            let highlight = document.getElementById(highlightId)
            if (!highlight) {
              highlight = document.createElement('div')
              highlight.id = highlightId
              highlight.style.cssText = 'position:fixed; z-index:9999998; pointer-events:none; border:2px dashed #1677ff; background:rgba(22,119,255,0.08); transition:all 0.05s; display:none;'
              document.body.appendChild(highlight)
            }

            // C. 提示浮层
            const tooltipId = 'rpa-recorder-tooltip'
            let tooltip = document.getElementById(tooltipId)
            if (!tooltip) {
              tooltip = document.createElement('div')
              tooltip.id = tooltipId
              tooltip.style.cssText = 'position:fixed; z-index:9999998; pointer-events:none; background:#252526; color:#fff; padding:6px 10px; font-size:11px; border-radius:4px; border:1px solid #454545; display:none; max-width:300px; word-wrap:break-word; font-family:system-ui, sans-serif;'
              document.body.appendChild(tooltip)
            }
          }

          showOverlay()
        })

        // 新建网页时自动暴露出回调
        context.on('page', async (newPage) => {
          newPage.on('close', () => {
            // 如果所有页面都关闭了，结束录制
            setTimeout(() => {
              if (context && context.pages().length === 0) {
                finish()
              }
            }, 100)
          })

          await newPage.exposeFunction('rpaNotifyMainRecorder', (action: any) => {
            if (action && action.type === 'finish') {
              finish()
            } else {
              if (!sessionId || !this.sessions.get(sessionId)?.paused) actions.push(action)
              console.log('[RPA Recorder] Recorded action on page:', {
                type: action?.type,
                selector: action?.selector,
                sensitive: Boolean(action?.sensitive)
              })
            }
          })
        })

        page = await context.newPage()
        
        // 暴露出回调给主页面
        await page.exposeFunction('rpaNotifyMainRecorder', (action: any) => {
          if (action && action.type === 'finish') {
            finish()
          } else {
            if (!sessionId || !this.sessions.get(sessionId)?.paused) actions.push(action)
            console.log('[RPA Recorder] Recorded action:', {
              type: action?.type,
              selector: action?.selector,
              sensitive: Boolean(action?.sensitive)
            })
          }
        })

        // 监听主页面关闭
        page.on('close', () => {
          finish()
        })

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
        console.log(`[RPA Recorder] 已开启网页：${url}，开始录制操作步骤。`)
        
      } catch (e) {
        console.error('[RPA Recorder] Failed to start recorder:', e)
        finish()
      }
    })
  }
}
