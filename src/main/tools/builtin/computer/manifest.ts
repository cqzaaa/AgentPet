import { ToolManifest } from '../../core/types'
import { DESKTOP_CONTROL_INSTRUCTIONS } from './policy'

export const computerManifest: ToolManifest = {
  identifier: 'agentpet-computer',
  category: 'computer',
  meta: {
    title: '电脑操控',
    description: '截图感知屏幕、控制鼠标键盘、切换窗口，让模型自主操作电脑',
    avatar: '🖥️'
  },
  api: [
    {
      name: 'screenshot',
      description:
        '截取屏幕或指定窗口并保存为 PNG。优先使用 mode="window" 配合 pid/title，结果包含窗口/显示器边界、DPI、坐标空间和视觉状态哈希。',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['screen', 'window'],
            description: '截图范围，默认 screen；操作应用时优先 window'
          },
          display_id: {
            type: 'number',
            description: '显示器序号或 Electron display id；不传则截取主显示器'
          },
          pid: {
            type: 'number',
            description: 'window 模式下的目标窗口进程 PID'
          },
          title: {
            type: 'string',
            description: 'window 模式下的窗口标题关键字'
          },
          process_name: {
            type: 'string',
            description: 'window 模式下的进程名'
          },
          max_width: {
            type: 'number',
            description: '截图最大宽度，默认 1920'
          },
          max_height: {
            type: 'number',
            description: '截图最大高度，默认 1080'
          },
          delay_ms: {
            type: 'number',
            description:
              '截图前等待毫秒数（最大 5000）。刚启动了新应用、打开了新页面，或需要等待加载动画时传入此参数（如 1500）。如果已调用过 focus_window，它内置了等待，无需再传此参数。'
          }
        },
        required: []
      }
    },
    {
      name: 'mouse_move',
      description: '将鼠标光标移动到屏幕上的指定坐标（像素），不产生点击。',
      hidden: true,
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: '目标 X 坐标（像素）' },
          y: { type: 'number', description: '目标 Y 坐标（像素）' }
        },
        required: ['x', 'y']
      }
    },
    {
      name: 'mouse_click',
      description: '在已确认的全局屏幕坐标执行鼠标点击。mouse_click 会自行移动鼠标，不要先调用 mouse_move；同一视觉状态下重复点击会被保护机制拦截。',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: '点击目标 X 坐标（像素）' },
          y: { type: 'number', description: '点击目标 Y 坐标（像素）' },
          button: {
            type: 'string',
            enum: ['left', 'right', 'middle'],
            description: '鼠标按键，默认 left（左键）'
          },
          double: {
            type: 'boolean',
            description: '是否双击，默认 false'
          },
          allow_repeat: {
            type: 'boolean',
            description: '明确允许在同一视觉状态下重复点击；仅用于确实需要双次独立点击的场景'
          }
        },
        required: ['x', 'y']
      }
    },
    {
      name: 'mouse_click_relative',
      description: '按窗口或显示器相对坐标点击，执行器会根据实时窗口边界、DPI 和多显示器布局转换为物理屏幕坐标。优先于绝对坐标。',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['window', 'display'],
            description: '相对坐标参照物'
          },
          relative_x: { type: 'number', description: '0 到 1 的水平相对位置' },
          relative_y: { type: 'number', description: '0 到 1 的垂直相对位置' },
          pid: { type: 'number', description: 'window scope 的目标窗口 PID' },
          title: { type: 'string', description: 'window scope 的窗口标题关键字' },
          process_name: { type: 'string', description: 'window scope 的进程名' },
          display_id: { type: 'number', description: 'display scope 的显示器 id 或序号' },
          button: { type: 'string', enum: ['left', 'right'], description: '鼠标按键，默认 left' },
          double: { type: 'boolean', description: '是否双击，默认 false' },
          allow_repeat: { type: 'boolean', description: '明确允许重复点击，默认 false' }
        },
        required: ['scope', 'relative_x', 'relative_y']
      }
    },
    {
      name: 'mouse_scroll',
      description: '在指定坐标滚动鼠标滚轮。',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: '滚动位置 X 坐标（像素）' },
          y: { type: 'number', description: '滚动位置 Y 坐标（像素）' },
          direction: {
            type: 'string',
            enum: ['up', 'down'],
            description: '滚动方向：up 向上，down 向下'
          },
          amount: {
            type: 'number',
            description: '滚动格数，默认 3'
          }
        },
        required: ['x', 'y', 'direction']
      }
    },
    {
      name: 'type_text',
      description: '向当前焦点元素输入一段文字。默认使用剪贴板粘贴，适合中文、emoji 和复杂标点；仅在确需逐键模拟时使用 method="keyboard"。',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: '要输入的文字内容'
          },
          method: {
            type: 'string',
            enum: ['clipboard_paste', 'keyboard'],
            description: '输入方式，默认 clipboard_paste；中文和复杂文本不要使用 keyboard'
          }
        },
        required: ['text']
      }
    },
    {
      name: 'key_press',
      description:
        '按下一个或多个按键组合，例如 ["ctrl", "c"] 表示复制，["alt", "F4"] 表示关闭窗口。',
      parameters: {
        type: 'object',
        properties: {
          keys: {
            type: 'array',
            items: { type: 'string' },
            description:
              '按键名称列表，支持：ctrl/shift/alt/win/enter/escape/tab/backspace/delete/space/up/down/left/right/F1-F12 以及普通字母数字键'
          }
        },
        required: ['keys']
      }
    },
    {
      name: 'find_ui_elements',
      description: '在指定 Windows 窗口内查找可访问性元素，返回 name、automationId、controlType、边界和可复用定位字段。需要优先提供 PID。',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'number', description: '目标窗口进程 PID，优先提供' },
          process_name: { type: 'string', description: '目标进程名' },
          name_contains: { type: 'string', description: '元素名称包含的文字' },
          control_type: { type: 'string', description: 'UI Automation control type，例如 ControlType.Button' },
          limit: { type: 'number', description: '最多返回元素数量，默认 30，最大 80' }
        },
        required: []
      }
    },
    {
      name: 'click_ui_element',
      description: '通过 Windows UI Automation 的 automationId/name/processId/controlType 点击元素，优先于猜测屏幕坐标。',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'number', description: '目标进程 PID' },
          process_name: { type: 'string', description: '目标进程名' },
          name: { type: 'string', description: '元素可访问名称' },
          automation_id: { type: 'string', description: '元素 AutomationId' },
          control_type: { type: 'string', description: '元素 ControlType，例如 ControlType.Button' },
          button: { type: 'string', enum: ['left', 'right'], description: '鼠标按键，默认 left' },
          double: { type: 'boolean', description: '是否双击，默认 false' },
          allow_repeat: { type: 'boolean', description: '明确允许重复点击，默认 false' }
        },
        required: []
      }
    },
    {
      name: 'focus_ui_element',
      description: '通过 Windows UI Automation 将指定元素设为焦点，适合输入框；之后可直接调用 type_text。',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'number', description: '目标进程 PID' },
          process_name: { type: 'string', description: '目标进程名' },
          name: { type: 'string', description: '元素可访问名称' },
          automation_id: { type: 'string', description: '元素 AutomationId' }
        },
        required: []
      }
    },
    {
      name: 'perform_computer_actions',
      description: '顺序执行一组确定性的电脑动作，适合 click/type/Enter 等连续步骤；动作之间不产生模型往返。可选 verify_after=true 在结尾截取一次验证截图。',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'number', description: '默认目标窗口 PID' },
          title: { type: 'string', description: '默认目标窗口标题关键字' },
          process_name: { type: 'string', description: '默认目标进程名' },
          actions: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['focus_window', 'click', 'click_relative', 'click_ui', 'focus_ui', 'type', 'key', 'wait'] },
                x: { type: 'number' }, y: { type: 'number' },
                relative_x: { type: 'number' }, relative_y: { type: 'number' },
                scope: { type: 'string', enum: ['window', 'display'] },
                name: { type: 'string' }, automation_id: { type: 'string' }, control_type: { type: 'string' },
                text: { type: 'string' }, method: { type: 'string', enum: ['clipboard_paste', 'keyboard'] },
                keys: { type: 'array', items: { type: 'string' } },
                milliseconds: { type: 'number' },
                button: { type: 'string', enum: ['left', 'right', 'middle'] }, double: { type: 'boolean' },
                allow_repeat: { type: 'boolean' }
              },
              required: ['type']
            }
          },
          verify_after: { type: 'boolean', description: '是否在所有动作完成后追加一次目标窗口截图' }
        },
        required: ['actions']
      }
    },
    {
      name: 'get_windows',
      description: '获取当前所有可见窗口的列表（标题、进程名、PID），用于确定要操作的目标窗口。',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    {
      name: 'focus_window',
      description:
        '将指定窗口切换到前台并获得焦点。支持三种方式：(1) 窗口标题模糊匹配，(2) PID 精确匹配，(3) show_desktop=true 显示桌面。内置 800ms 等待，调用后可直接截图。',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: '窗口标题关键字（模糊匹配，不区分大小写）'
          },
          pid: {
            type: 'number',
            description: '进程 PID（精确匹配，优先于 title）'
          },
          show_desktop: {
            type: 'boolean',
            description:
              '传 true 则最小化所有窗口显示桌面（等同 Win+D），适合需要查看桌面图标或双击桌面应用的场景'
          }
        },
        required: []
      }
    }
  ],
  systemRole: `<tool_instructions>\n${DESKTOP_CONTROL_INSTRUCTIONS}\n</tool_instructions>`
}
