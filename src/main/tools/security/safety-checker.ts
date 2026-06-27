// 判定是否为只读或无害查询命令，用于免弹窗自动放行
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  
  // 只读或版本检测命令的正则匹配
  const safePatterns = [
    /^(git\s+(status|diff|log|show|branch|remote|tag|config\s+--list|config\s+-l))\b/,
    /^(ls|dir|pwd|echo|whoami|hostname|uname|date|time)\b/,
    /^(cat|type|head|tail|grep|more|less)\s+/,
    /^(node|npm|npx|yarn|pnpm|git|python|pip|tsc|go|rustc|cargo|docker|java)\s+(-v|--version)\b/
  ];

  // 检查是否完全符合至少一个安全模式
  return safePatterns.some(pattern => pattern.test(trimmed));
}

// 检查终端命令安全性 (返回警告文案而非硬性直接拦截)
export function checkCommandSafety(command: string): { safe: boolean; warning?: string } {
  const trimmed = command.trim().toLowerCase();
  
  // 1. 磁盘格式化/低级操作
  if (/\b(format)\b/.test(trimmed) || /\b(mkfs|dd if=)\b/.test(trimmed)) {
    return { safe: false, warning: '检测到磁盘格式化或底层硬盘扇区写入操作，此操作极其危险，可能导致不可逆的数据丢失。' }
  }
  
  // 2. 系统关机/重启
  if (/\b(shutdown|reboot|init 0|init 6)\b/.test(trimmed)) {
    return { safe: false, warning: '检测到关机、重启系统的指令，运行此命令将导致本应用及当前的桌面助理服务中断。' }
  }

  // 3. 用户及权限管理
  if (/\bnet\s+user\b/.test(trimmed) || /\bnet\s+localgroup\b/.test(trimmed) || /\b(useradd|userdel|groupadd|groupdel)\b/.test(trimmed)) {
    return { safe: false, warning: '检测到涉及添加、修改或删除本地系统账户/特权组的安全敏感命令。' }
  }

  // 4. 注册表高危修改
  if (/\breg\s+(add|delete|import)\b/.test(trimmed)) {
    return { safe: false, warning: '检测到修改 Windows 注册表的操作，误删或误改关键注册表项可能导致系统崩溃或功能异常。' }
  }

  // 5. 试图删除整盘或系统关键路径 (Linux/Unix)
  if (/\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(\/|\/\*|\/etc|\/var|\/usr|\/bin|\/boot)\b/.test(trimmed)) {
    return { safe: false, warning: '检测到尝试强制递归删除 Linux 系统根目录或系统关键路径 (rm -rf /) 的毁灭性高危操作！' }
  }

  // 6. 试图删除整盘或关键路径 (Windows)
  if (/\bdel\b.*\b(c:|d:)\\\s*(\*|\/s)/.test(trimmed) || /\bdel\b.*\b\\\s*\/s/.test(trimmed)) {
    return { safe: false, warning: '检测到尝试递归删除系统盘根目录文件或整盘数据 (del /s) 的高危操作！' }
  }

  // 7. 绕过脚本执行策略
  if (/-executionpolicy\s+bypass\b/.test(trimmed) || /-ep\s+bypass\b/.test(trimmed)) {
    return { safe: false, warning: '检测到尝试绕过系统 PowerShell 脚本安全执行策略 (Bypass) 的行为。' }
  }

  return { safe: true }
}
