export const BOOTSTRAP_TOOL_NAMES = new Set([
  'request_skill',
  'request_user_clarification',
  'update_task_plan',
  'update_task_step'
])

const DESKTOP_APPLICATION_PATTERN = /(?:微信|weixin|钉钉|dingtalk|qq|企业微信|word|excel|powerpoint|ppt|记事本|notepad|计算器|calculator|文件管理器|资源管理器|explorer|浏览器|chrome|edge)/i
const DESKTOP_SURFACE_PATTERN = /(?:当前屏幕|屏幕上|当前窗口|这个窗口|桌面上|任务栏|鼠标|键盘)/i
const DESKTOP_ACTION_PATTERN = /(?:打开|启动|切换|聚焦|点击|双击|输入|键入|发送|按下|滚动|拖动|关闭|最小化|最大化|截图|查看)/i

/**
 * Preload only high-confidence desktop-control requests. Generic engineering
 * discussions about mouse or screenshot code must continue through normal
 * Skill routing instead of unexpectedly exposing mutation tools.
 */
export function inferPreloadedSkillIds(userText: string): string[] {
  const text = String(userText || '').trim()
  if (!text || !DESKTOP_ACTION_PATTERN.test(text)) return []
  if (/(?:代码|源码|函数|模块|实现|优化|方案|测试|bug)/i.test(text) && !DESKTOP_APPLICATION_PATTERN.test(text)) return []
  if (DESKTOP_APPLICATION_PATTERN.test(text) || DESKTOP_SURFACE_PATTERN.test(text)) {
    return ['desktop-control']
  }
  return []
}

export function createInitialActiveToolNames(options: {
  forceAllTools?: boolean
  availableToolNames: Iterable<string>
  explicitlyRequestedToolNames?: Iterable<string>
}): Set<string> {
  const available = new Set(options.availableToolNames)
  if (options.forceAllTools) return available

  const active = new Set<string>()
  for (const name of BOOTSTRAP_TOOL_NAMES) {
    if (available.has(name)) active.add(name)
  }
  for (const name of options.explicitlyRequestedToolNames || []) {
    if (available.has(name)) active.add(name)
  }
  return active
}

export function activateAllowedTools(
  active: Set<string>,
  allowedToolNames: Iterable<string>,
  availableToolNames: Iterable<string>,
  blockedToolNames: Iterable<string> = []
): string[] {
  const available = new Set(availableToolNames)
  const blocked = new Set(blockedToolNames)
  const activated: string[] = []
  for (const rawName of allowedToolNames) {
    const name = String(rawName || '').trim()
    if (!name || blocked.has(name) || !available.has(name) || active.has(name)) continue
    active.add(name)
    activated.push(name)
  }
  return activated
}

export function filterToolDefinitions(
  definitions: any[],
  activeToolNames: Set<string>,
  blockedToolNames: Iterable<string> = []
): any[] {
  const blocked = new Set(blockedToolNames)
  return definitions.filter(tool => {
    const name = String(tool?.function?.name || '')
    return Boolean(name) && activeToolNames.has(name) && !blocked.has(name)
  })
}
