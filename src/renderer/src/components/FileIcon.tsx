import React from 'react'

export interface FileIconProps extends React.SVGProps<SVGSVGElement> {
  fileName?: string
  fileType?: string
  size?: number
  className?: string
  style?: React.CSSProperties
}

/**
 * 标准专业级文件扩展名图标组件
 * 专为代码与文档文件打造高辨识度矢量图标（支持 TS, TSX, CSS, JSON, PDF, Python, HTML 等）
 */
export function FileIcon({
  fileName = '',
  fileType = '',
  size = 16,
  className = '',
  style,
  ...rest
}: FileIconProps): React.JSX.Element {
  // 提取文件扩展名（优先使用 fileName，其次 fileType）
  let ext = ''
  if (fileName) {
    const parts = fileName.split(/[\\/]/).pop()?.split('.') || []
    if (parts.length > 1) {
      ext = parts.pop()?.toLowerCase() || ''
    }
  }
  if (!ext && fileType) {
    ext = fileType.replace(/^\./, '').toLowerCase().trim()
  }

  const combinedClass = `app-file-icon ${className}`.trim()
  const baseProps = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    className: combinedClass,
    style: { display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style },
    'aria-hidden': true,
    ...rest
  }

  // 1. React / TSX / JSX 文件（正规 React 原子轨道图标，科技蓝）
  if (['tsx', 'jsx'].includes(ext)) {
    return (
      <svg {...baseProps}>
        {/* React 原子轨道三环 */}
        <ellipse cx="12" cy="12" rx="9.2" ry="3.8" stroke="#00d8ff" strokeWidth="1.35" opacity="0.95" />
        <ellipse
          cx="12"
          cy="12"
          rx="9.2"
          ry="3.8"
          stroke="#00d8ff"
          strokeWidth="1.35"
          transform="rotate(60 12 12)"
          opacity="0.95"
        />
        <ellipse
          cx="12"
          cy="12"
          rx="9.2"
          ry="3.8"
          stroke="#00d8ff"
          strokeWidth="1.35"
          transform="rotate(120 12 12)"
          opacity="0.95"
        />
        <circle cx="12" cy="12" r="1.65" fill="#00d8ff" />
      </svg>
    )
  }

  // 2. TypeScript 文件（正规官方蓝底白字 TS 方块）
  if (['ts', 'mts', 'cts'].includes(ext)) {
    return (
      <svg {...baseProps}>
        <rect x="2.5" y="2.5" width="19" height="19" rx="3.2" fill="#3178c6" />
        {/* 字母 T */}
        <path d="M5.5 8h6.4v2.1H9.8v6.7H7.6v-6.7H5.5V8z" fill="#ffffff" />
        {/* 字母 S */}
        <path
          d="M13.6 14.8c.6.5 1.4.8 2.2.8.9 0 1.4-.4 1.4-.9 0-.6-.5-.8-1.5-1.1-1.5-.4-2.5-1-2.5-2.2 0-1.4 1.1-2.4 2.8-2.4 1.1 0 1.9.3 2.6.8l-.6 1.8c-.6-.4-1.3-.6-1.9-.6-.7 0-1.1.3-1.1.7 0 .5.4.7 1.4 1 1.6.5 2.6 1.1 2.6 2.3 0 1.5-1.2 2.4-3.1 2.4-1.3 0-2.3-.4-3-.9l.7-1.7z"
          fill="#ffffff"
        />
      </svg>
    )
  }

  // 3. CSS / SCSS / SASS / LESS 文件（正规官方 CSS3 盾牌与立体光泽）
  if (['css', 'scss', 'sass', 'less'].includes(ext)) {
    return (
      <svg {...baseProps}>
        {/* CSS3 盾牌主体 */}
        <path d="M3.5 2.5l1.6 17.5 6.9 2 6.9-2 1.6-17.5H3.5z" fill="#264de4" />
        {/* 右半边浅色立体光泽 */}
        <path d="M12 4.2v16l5.5-1.6 1.3-14.4H12z" fill="#2965f1" />
        {/* 徽标内白色的 3 字图形 */}
        <path
          d="M7.4 7.2h9.2l-.3 3.2H12v2.2h3.9l-.4 4.5-3.5 1-3.5-1-.2-2.5h2.2l.1 1.4 1.4.4 1.4-.4.2-2H8l-.3-3.6H12V7.2z"
          fill="#ffffff"
        />
      </svg>
    )
  }

  // 4. JavaScript 文件（正规官方黄底黑字 JS 方块）
  if (['js', 'mjs', 'cjs'].includes(ext)) {
    return (
      <svg {...baseProps}>
        <rect x="2.5" y="2.5" width="19" height="19" rx="3.2" fill="#f7df1e" />
        {/* 字母 J */}
        <path d="M6.2 14.2l1.8-1c.4.6.8 1.1 1.4 1.1.7 0 1.1-.4 1.1-1.3V7.5H12v5.4c0 2-1.1 2.9-2.8 2.9-1.3 0-2.3-.7-3-1.6z" fill="#000000" />
        {/* 字母 S */}
        <path
          d="M13.2 14.7l1.7-1c.5.8 1.1 1.3 2 1.3.8 0 1.4-.4 1.4-1 0-.6-.5-.9-1.5-1.3l-.6-.2c-1.7-.7-2.8-1.5-2.8-3.1 0-1.6 1.3-2.9 3.2-2.9 1.4 0 2.4.5 3.1 1.7l-1.6 1c-.4-.6-.8-.9-1.5-.9-.7 0-1.1.4-1.1.9 0 .5.4.8 1.3 1.1l.6.2c1.9.8 3 1.6 3 3.3 0 1.8-1.4 3-3.6 3-1.9 0-3.1-.9-3.6-2.1z"
          fill="#000000"
        />
      </svg>
    )
  }

  // 5. JSON 文件（正规花括号 { } 样式，天蓝/青色，还原用户图2）
  if (ext === 'json') {
    return (
      <svg {...baseProps}>
        {/* 左花括号 { */}
        <path
          d="M8.2 4.5c-1.8 0-2.8 1-2.8 2.6v2.2c0 1.2-.7 1.8-1.6 2.2.9.4 1.6 1 1.6 2.2v2.2c0 1.6 1 2.6 2.8 2.6"
          stroke="#38bdf8"
          strokeWidth="2.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* 右花括号 } */}
        <path
          d="M15.8 4.5c1.8 0 2.8 1 2.8 2.6v2.2c0 1.2.7 1.8 1.6 2.2-.9.4-1.6 1-1.6 2.2v2.2c0 1.6-1 2.6-2.8 2.6"
          stroke="#38bdf8"
          strokeWidth="2.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }

  // 6. PDF 文件（白底折角纸张 + 红色圆角卡片 + 白色 Acrobat 双环曲线，准确还原用户图1）
  if (ext === 'pdf') {
    return (
      <svg {...baseProps}>
        {/* 白色折角文档外壳 */}
        <path d="M4.5 2.5h9.5l5.5 5.5v13.5a1.5 1.5 0 0 1-1.5 1.5h-12a1.5 1.5 0 0 1-1.5-1.5V4a1.5 1.5 0 0 1 1.5-1.5z" fill="#f8fafc" stroke="#94a3b8" strokeWidth="1.2" />
        {/* 折角阴影与折痕 */}
        <path d="M14 2.5v5.5h5.5" fill="#e2e8f0" stroke="#94a3b8" strokeWidth="1.2" strokeLinejoin="round" />
        {/* 红色徽标圆角方块 */}
        <rect x="6.5" y="8" width="11" height="11.5" rx="2.4" fill="#ef4444" />
        {/* 内部白色的 Acrobat / PDF 经典双环与连线，完全对齐用户图1的视觉特征 */}
        <path
          d="M8.6 15.6c.7 0 1.4-.7 1.9-1.6.5.9 1.2 1.6 2 1.6.9 0 1.5-.7 1.5-1.6 0-1-.8-1.8-1.7-2-.6-.2-1.2-.3-1.7-.4-.3-.1-.6-.2-.8-.3-.3-.1-.4-.3-.4-.5 0-.3.3-.5.7-.5.6 0 1.1.3 1.2.8"
          stroke="#ffffff"
          strokeWidth="1.1"
          strokeLinecap="round"
        />
        <circle cx="9.6" cy="14.8" r="0.9" fill="#ffffff" />
        <circle cx="14.4" cy="14.8" r="0.9" fill="#ffffff" />
      </svg>
    )
  }

  // 7. HTML 文件（HTML5 经典橙色盾牌）
  if (['html', 'htm'].includes(ext)) {
    return (
      <svg {...baseProps}>
        <path d="M3.5 2.5l1.6 17.5 6.9 2 6.9-2 1.6-17.5H3.5z" fill="#e44d26" />
        <path d="M12 4.2v16l5.5-1.6 1.3-14.4H12z" fill="#f16529" />
        {/* 白色 5 徽标 */}
        <path
          d="M7.4 7.2h9.2l-.3 3.2H10l.2 2.2h6.1l-.4 4.5-3.9 1-3.9-1-.2-2.5h2.2l.1 1.4 1.8.5 1.8-.5.2-2H7.6l-.2-6.3z"
          fill="#ffffff"
        />
      </svg>
    )
  }

  // 8. Python 文件（Python 官方蓝黄双蛇徽标）
  if (['py', 'pyw', 'ipynb'].includes(ext)) {
    return (
      <svg {...baseProps}>
        {/* 蓝蛇 */}
        <path
          d="M11.9 2.5c-3.1 0-3 .9-3 2.1v2.1h6.1v.7H6.5c-1.2 0-2.2 1-2.2 3.1 0 2.2 1 3.1 2.2 3.1h1.5v-2.1c0-1.2 1-2.2 2.2-2.2h6.1c1 0 1.8-.8 1.8-1.8V4.6c0-1.2-1.2-2.1-6.3-2.1zm-1.8 1.4a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6z"
          fill="#3776ab"
        />
        {/* 黄蛇 */}
        <path
          d="M12.1 21.5c3.1 0 3-.9 3-2.1v-2.1H9v-.7h8.5c1.2 0 2.2-1 2.2-3.1 0-2.2-1-3.1-2.2-3.1H16v2.1c0 1.2-1 2.2-2.2 2.2H7.7c-1 0-1.8.8-1.8 1.8v3.1c0 1.2 1.2 2.1 6.2 2.1zm1.8-1.4a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6z"
          fill="#ffd43b"
        />
      </svg>
    )
  }

  // 9. Markdown 文件（官方 Markdown 图标 M + 向下箭头）
  if (['md', 'mdx', 'markdown'].includes(ext)) {
    return (
      <svg {...baseProps}>
        <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" fill="#1e293b" stroke="#38bdf8" strokeWidth="1.2" />
        {/* M */}
        <path d="M5.5 15V9h2l1.8 2.5L11 9h2v6h-1.8v-3.5L9.6 13.6h-.7l-1.6-2.1V15H5.5z" fill="#38bdf8" />
        {/* 箭头 ↓ */}
        <path d="M16.5 9v3.8h1.6l-2.6 3-2.6-3h1.6V9h2z" fill="#38bdf8" />
      </svg>
    )
  }

  // 10. Word 文件（Microsoft Word 蓝底 W 徽标）
  if (['doc', 'docx'].includes(ext)) {
    return (
      <svg {...baseProps}>
        {/* 蓝底卡片 */}
        <rect x="3" y="3" width="18" height="18" rx="3.5" fill="#185abd" />
        {/* 经典白色 W */}
        <path
          d="M6.5 7.5h2.2l1.6 6 1.7-6h1.9l1.7 6 1.6-6h2.2l-2.6 9h-2.1l-1.7-6.2L11 16.5H8.9l-2.4-9z"
          fill="#ffffff"
        />
      </svg>
    )
  }

  // 11. Excel / CSV 表格（Microsoft Excel 绿底 X 徽标）
  if (['xls', 'xlsx', 'csv'].includes(ext)) {
    return (
      <svg {...baseProps}>
        {/* 绿底卡片 */}
        <rect x="3" y="3" width="18" height="18" rx="3.5" fill="#107c41" />
        {/* 经典白色 X */}
        <path
          d="M7.5 7.5h3l2.2 3.8 2.2-3.8h2.9l-3.6 5 3.8 5.2h-3L12.7 13.8 10.4 17.7H7.4l3.8-5.2-3.7-5z"
          fill="#ffffff"
        />
      </svg>
    )
  }

  // 12. PowerPoint 幻灯片（Microsoft PPT 橙红底 P 徽标）
  if (['ppt', 'pptx'].includes(ext)) {
    return (
      <svg {...baseProps}>
        {/* 橙红底卡片 */}
        <rect x="3" y="3" width="18" height="18" rx="3.5" fill="#c43e1c" />
        {/* 经典白色 P */}
        <path
          d="M8.5 7.5h4.6c2.4 0 3.8 1.2 3.8 3.2 0 2-1.4 3.3-3.8 3.3H11V16.5H8.5V7.5zm2.5 4.5h2c1 0 1.6-.5 1.6-1.3 0-.8-.6-1.2-1.6-1.2H11V12z"
          fill="#ffffff"
        />
      </svg>
    )
  }

  // 13. 图片文件（彩色照片微缩，太阳与山峰）
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(ext)) {
    return (
      <svg {...baseProps}>
        <rect x="3" y="3.5" width="18" height="17" rx="3" fill="#8b5cf6" opacity="0.15" />
        <rect x="3" y="3.5" width="18" height="17" rx="3" stroke="#a855f7" strokeWidth="1.4" />
        <circle cx="8" cy="8.5" r="1.8" fill="#ec4899" />
        <path d="M4.5 17.5l4.5-4.5 3 3 4.5-5.5 3.5 4v2a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5v-.5z" fill="#a855f7" />
      </svg>
    )
  }

  // 14. 压缩包文件（紫罗兰色带拉链盒子）
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) {
    return (
      <svg {...baseProps}>
        <path d="M4.5 3A1.5 1.5 0 0 1 6 1.5h8.5l5 5V21a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4.5 21V3z" fill="#7c3aed" opacity="0.15" stroke="#8b5cf6" strokeWidth="1.3" />
        <path d="M14.5 1.5V6a.5.5 0 0 0 .5.5h4.5" fill="#8b5cf6" opacity="0.3" stroke="#8b5cf6" strokeWidth="1.2" />
        {/* 拉链齿 */}
        <rect x="10.5" y="8" width="3" height="2" fill="#8b5cf6" />
        <rect x="10.5" y="11" width="3" height="2" fill="#8b5cf6" />
        <rect x="10.5" y="14" width="3" height="2" fill="#8b5cf6" />
        <rect x="10" y="17" width="4" height="3" rx="1" fill="#f59e0b" />
      </svg>
    )
  }

  // 15. 音频文件（薄荷绿 / 青色音符）
  if (['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a'].includes(ext)) {
    return (
      <svg {...baseProps}>
        <rect x="3" y="3" width="18" height="18" rx="4" fill="#0d9488" opacity="0.18" stroke="#14b8a6" strokeWidth="1.3" />
        <path d="M9 15.5a2 2 0 1 1-1.5-1.9V7.5l8-1.5v6.5a2 2 0 1 1-1.5-1.9V8.5L9 9.8v5.7z" fill="#14b8a6" />
      </svg>
    )
  }

  // 16. 视频文件（玫粉色胶卷/视频）
  if (['mp4', 'avi', 'mkv', 'mov', 'webm', 'flv'].includes(ext)) {
    return (
      <svg {...baseProps}>
        <rect x="3" y="3.5" width="18" height="17" rx="3.5" fill="#be185d" opacity="0.18" stroke="#ec4899" strokeWidth="1.3" />
        <path d="M10 8.5l6 3.5-6 3.5V8.5z" fill="#ec4899" />
      </svg>
    )
  }

  // 17. 数据库文件（SQL / SQLite / DB，立体圆柱筒）
  if (['sql', 'sqlite', 'db', 'prisma'].includes(ext)) {
    return (
      <svg {...baseProps}>
        <ellipse cx="12" cy="6" rx="7.5" ry="3" fill="#336791" stroke="#60a5fa" strokeWidth="1.2" />
        <path d="M4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6" stroke="#60a5fa" strokeWidth="1.2" />
        <path d="M4.5 12v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" stroke="#60a5fa" strokeWidth="1.2" />
      </svg>
    )
  }

  // 18. 终端与脚本（Shell / Bash / CMD / PowerShell，黑底控制台卡片）
  if (['sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1'].includes(ext)) {
    return (
      <svg {...baseProps}>
        <rect x="2.5" y="3.5" width="19" height="17" rx="3.5" fill="#0f172a" stroke="#475569" strokeWidth="1.2" />
        <path d="M6.5 8.5l3.5 3.5-3.5 3.5" stroke="#22c55e" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12.5 15.5h5" stroke="#22c55e" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    )
  }

  // 19. 配置文件（YAML / TOML / XML / INI / ENV，琥珀金配置齿轮）
  if (['yaml', 'yml', 'toml', 'xml', 'ini', 'env', 'conf', 'config'].includes(ext)) {
    return (
      <svg {...baseProps}>
        <rect x="3" y="3" width="18" height="18" rx="3.5" fill="#f59e0b" opacity="0.15" stroke="#f59e0b" strokeWidth="1.3" />
        <circle cx="12" cy="12" r="3" stroke="#f59e0b" strokeWidth="1.6" />
        <path
          d="M12 4v2m0 12v2M4 12h2m12 0h2m-3.3-6.7l-1.4 1.4m-6.6 6.6l-1.4 1.4m0-9.4l1.4 1.4m6.6 6.6l1.4 1.4"
          stroke="#f59e0b"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    )
  }

  // 20. 普通代码文件（Java, C++, Go, Rust, PHP 等）
  if (['java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'php', 'swift', 'kt', 'dart', 'vue'].includes(ext)) {
    return (
      <svg {...baseProps}>
        <rect x="3" y="3" width="18" height="18" rx="3.5" fill="#6366f1" opacity="0.15" stroke="#6366f1" strokeWidth="1.3" />
        <path d="M8.5 8.5L5 12l3.5 3.5M15.5 8.5L19 12l-3.5 3.5M13.5 7l-3 10" stroke="#6366f1" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }

  // 21. 纯文本 / 日志文件（TXT / LOG）
  if (['txt', 'log'].includes(ext)) {
    return (
      <svg {...baseProps}>
        <path d="M4.5 2.5h9.5l5.5 5.5v13.5a1.5 1.5 0 0 1-1.5 1.5h-12a1.5 1.5 0 0 1-1.5-1.5V4a1.5 1.5 0 0 1 1.5-1.5z" fill="#f8fafc" stroke="#94a3b8" strokeWidth="1.2" />
        <path d="M14 2.5v5.5h5.5" fill="#e2e8f0" stroke="#94a3b8" strokeWidth="1.2" strokeLinejoin="round" />
        <path d="M8 11.5h8M8 15h8M8 18.5h5" stroke="#64748b" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    )
  }

  // 22. 默认通用文件图标（精致折角文档）
  return (
    <svg {...baseProps}>
      <path d="M4.5 2.5h9.5l5.5 5.5v13.5a1.5 1.5 0 0 1-1.5 1.5h-12a1.5 1.5 0 0 1-1.5-1.5V4a1.5 1.5 0 0 1 1.5-1.5z" fill="#f8fafc" stroke="#94a3b8" strokeWidth="1.2" />
      <path d="M14 2.5v5.5h5.5" fill="#e2e8f0" stroke="#94a3b8" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}
