import { ToolManifest } from '../../core/types'

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
        '截取当前屏幕并保存为 PNG 文件，返回文件路径。操作前后都应截图以感知界面状态。',
      parameters: {
        type: 'object',
        properties: {
          display_id: {
            type: 'number',
            description: '显示器序号（从 0 开始），不传则截取主显示器'
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
      description: '在指定坐标执行鼠标点击。可选左键/右键/中键，可双击。',
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
          }
        },
        required: ['x', 'y']
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
  systemRole: `<tool_instructions>
你有一组电脑操控工具，可以截图感知屏幕并控制鼠标键盘。

<core_workflow>
每次操作任务都应遵循以下循环：
1. 先调用 screenshot 截图，仔细分析当前界面状态
2. 根据截图确认目标元素的精确坐标（坐标系以屏幕左上角为原点）
3. 执行操作（点击、输入、快捷键等）
4. 再次截图验证操作结果，确认成功后继续下一步
</core_workflow>

<when_target_not_visible>
当目标应用或内容不在当前屏幕上时，根据情况选择对应流程：

【情况A】应用已打开，但被其他窗口遮挡：
  1. get_windows → 找到目标窗口的 PID 或标题
  2. focus_window(title/pid) → 内置800ms等待，窗口自动置顶
  3. screenshot → 直接截图即可看到目标界面

【情况B】需要查看桌面图标，或从桌面双击打开程序：
  1. focus_window(show_desktop: true) → 显示桌面（内置600ms等待）
  2. screenshot → 截图查看桌面
  3. mouse_click(double: true) → 双击目标图标

【情况C】应用已最小化到任务栏：
  1. focus_window(title: "应用标题关键字") → 自动还原并置顶
  2. screenshot → 截图

【情况D】应用未启动，需要先打开：
  1. 使用 terminal 工具执行启动命令（如 start notepad、start chrome 等）
  2. screenshot(delay_ms: 2000) → 等待2秒让应用启动完成再截图
  3. 之后正常操作
</when_target_not_visible>

<rules>
- 操作前必须先截图，不能盲目猜测坐标
- 输入文字前先点击目标输入框，确保焦点正确
- 遇到弹窗或意外界面时先截图再处理，不要强行继续
- focus_window 已内置等待，调用后直接 screenshot 即可
- delay_ms 仅在启动新程序或等待页面加载时使用
- 坐标单位是像素，以屏幕左上角为 (0, 0)
</rules>
</tool_instructions>`
}
