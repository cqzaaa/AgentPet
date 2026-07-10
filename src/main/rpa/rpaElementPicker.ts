import { chromium, Browser, BrowserContext, Page } from 'playwright-core'

export class RpaElementPicker {
  /**
   * 启动浏览器，访问指定 URL 并允许用户点击选取元素。
   * @param url 要抓取的网页地址
   * @returns 用户点选的元素的 CSS Selector。如果用户关闭浏览器，则返回 null。
   */
  public static async pick(url: string): Promise<string | null> {
    let browser: Browser | null = null
    let context: BrowserContext | null = null
    let page: Page | null = null

    return new Promise(async (resolve) => {
      let isResolved = false

      const finish = async (result: string | null) => {
        if (isResolved) return
        isResolved = true
        resolve(result)

        // 延迟关闭，让用户感知到点击完成了
        setTimeout(async () => {
          if (page) try { await page.close() } catch (_) {}
          if (context) try { await context.close() } catch (_) {}
          if (browser) try { await browser.close() } catch (_) {}
        }, 300)
      }

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
        page = await context.newPage()

        // 监听浏览器窗口关闭，以防用户手动关掉
        page.on('close', () => finish(null))

        // 暴露回调函数供网页内部拾取器调用
        await page.exposeFunction('rpaPickerCallback', (selector: string) => {
          finish(selector)
        })

        // 在新页面加载完毕时注入脚本
        page.on('load', async () => {
          if (!page) return
          try {
            await page.evaluate(() => {
              // 防重复注入
              if ((window as any).__rpaPickerInjected) return
              ;(window as any).__rpaPickerInjected = true

              const overlayId = 'rpa-picker-highlight-overlay'
              let overlay = document.getElementById(overlayId)
              if (!overlay) {
                overlay = document.createElement('div')
                overlay.id = overlayId
                overlay.style.cssText = 'position:fixed; z-index:9999999; pointer-events:none; border:2px dashed #ff0000; background:rgba(255,0,0,0.1); transition:all 0.1s; display:none;'
                document.body.appendChild(overlay)
              }

              // 显示当前选择器的提示框
              let tooltip = document.getElementById('rpa-picker-tooltip')
              if (!tooltip) {
                tooltip = document.createElement('div')
                tooltip.id = 'rpa-picker-tooltip'
                tooltip.style.cssText = 'position:fixed; z-index:9999999; pointer-events:none; background:#252526; color:#fff; padding:6px 10px; font-size:12px; border-radius:4px; border:1px solid #454545; display:none; max-width:400px; word-wrap:break-word;'
                document.body.appendChild(tooltip)
              }

              let currentTarget: Element | null = null

              function getCssSelector(el: Element): string {
                if (!(el instanceof Element)) return ''
                const path: string[] = []
                let current = el
                while (current && current.nodeType === Node.ELEMENT_NODE) {
                  // 如果遇到 html/body 就可以停止，不一定非要追溯到 document
                  if (current.nodeName.toLowerCase() === 'html') break
                  
                  let selector = current.nodeName.toLowerCase()
                  if (current.id) {
                    // ID 通常是全局唯一，可直接作为根节点中断
                    selector += '#' + current.id
                    path.unshift(selector)
                    break 
                  } else {
                    let sib = current
                    let nth = 1
                    while ((sib = sib.previousElementSibling as Element)) {
                      if (sib.nodeName.toLowerCase() === selector) nth++
                    }
                    
                    // 为了让选择器更美观、健壮，提取有效的类名
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

              const mouseMoveHandler = (e: MouseEvent) => {
                if (e.target && e.target instanceof Element && e.target !== overlay && e.target !== tooltip) {
                  currentTarget = e.target
                  const rect = currentTarget.getBoundingClientRect()
                  
                  if (overlay) {
                    overlay.style.top = rect.top + 'px'
                    overlay.style.left = rect.left + 'px'
                    overlay.style.width = rect.width + 'px'
                    overlay.style.height = rect.height + 'px'
                    overlay.style.display = 'block'
                  }

                  if (tooltip) {
                    const selectorText = getCssSelector(currentTarget)
                    tooltip.innerHTML = `<span style="color:#4ade80">🎯 点击拾取</span> <br/> ${selectorText}`
                    tooltip.style.left = (e.clientX + 15) + 'px'
                    tooltip.style.top = (e.clientY + 15) + 'px'
                    tooltip.style.display = 'block'
                  }
                }
              }

              const clickHandler = (e: MouseEvent) => {
                if (currentTarget) {
                  e.preventDefault()
                  e.stopPropagation()
                  const selector = getCssSelector(currentTarget)
                  
                  // 给出视觉反馈，闪烁绿色
                  if (overlay) {
                    overlay.style.border = '2px solid #10b981'
                    overlay.style.background = 'rgba(16,185,129,0.3)'
                  }
                  if (tooltip) {
                    tooltip.style.display = 'none'
                  }

                  // 卸载事件以防后续误触
                  document.removeEventListener('mousemove', mouseMoveHandler, true)
                  document.removeEventListener('click', clickHandler, true)
                  
                  // 传回主进程
                  if (typeof (window as any).rpaPickerCallback === 'function') {
                    ;(window as any).rpaPickerCallback(selector)
                  }
                }
              }

              // 捕获阶段绑定，防止目标元素的冒泡停止
              document.addEventListener('mousemove', mouseMoveHandler, true)
              document.addEventListener('click', clickHandler, true)
            })
          } catch (e) {
            // console.error('Inject failed', e)
          }
        })

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
        
        // 发送系统通知（可选）或在这里简单打印
        console.log(`[RPA Element Picker] 已经拉起网页，正在等待用户点选元素：${url}`)
        
      } catch (e) {
        console.error('RPA Picker error:', e)
        finish(null)
      }
    })
  }
}
