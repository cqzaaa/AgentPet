import { ToolManifest } from '../../core/types'
import browserAutomationSkill from './SKILL.md?raw'

export const webManifest: ToolManifest = {
  identifier: 'agentpet-web',
  category: 'search',
  meta: {
    title: '网页检索',
    description: '联网搜索关键词，或抓取指定网页的全文正文内容',
    avatar: '🌐'
  },
  api: [
    {
      name: 'browser_connect',
      description:
        '连接 AgentPet 的隔离浏览器自动化配置（CDP 端口 9222）。若只有一个标签页会自动选中；存在多个标签页时必须使用 browser_tabs 和 browser_select_tab 明确选择。',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'browser_tabs',
      description:
        '列出当前自动化浏览器中的全部可操作标签页及稳定 tab_id。用于多标签页时精确选择目标，禁止凭标题或顺序猜测。',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'browser_select_tab',
      description:
        '使用 browser_tabs 返回的 tab_id 精确选择一个浏览器标签页，并立即返回该标签页的新 DOM 快照。',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'string', description: 'browser_tabs 返回的稳定 tab_id，例如 tab-2' }
        },
        required: ['tab_id']
      }
    },
    {
      name: 'browser_navigate',
      description:
        '在已连接的真实 Edge/Chrome 页面中打开 URL，并在页面加载后返回完整 Element 层级结构、属性、可见性、交互状态及稳定 DOM ref。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'http 或 https URL' } },
        required: ['url']
      }
    },
    {
      name: 'browser_search',
      description:
        '在已连接的真实 Edge/Chrome 页面中使用必应进行 DOM 搜索，并返回按 DOM 顺序排列的搜索结果。此工具只搜索，绝不会点击任何结果；要打开第一条必须再调用 browser_click(target="search_result", index=1)。除非用户明确指定其他搜索引擎，搜索任务必须使用此工具。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索关键词' } },
        required: ['query']
      }
    },
    {
      name: 'browser_snapshot',
      description:
        '返回当前页面经过脱敏和大小限制的 Element 层级结构，包含可见节点、普通 div、交互状态、iframe、开放 Shadow DOM，以及仅供下一次 browser_click_ref 使用的快照 ref。密码、隐藏输入值、表单值、凭据和 URL 查询参数不会进入输出。',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'browser_click',
      description:
        '按 DOM 顺序或可见文本点击自动化浏览器中的元素。搜索结果必须 target="search_result"。链接在新标签页打开，按钮保留原生同页行为。工具会在动作后自动刷新并返回新快照；可能提交、发送、删除、购买、授权或修改外部状态的控件会在动作发生前强制请求用户确认。',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            enum: ['search_result', 'link', 'button'],
            description: 'DOM 元素类别'
          },
          index: { type: 'number', minimum: 1, description: '该类别中的第几个元素，默认 1' },
          text: { type: 'string', description: '可选，按包含文本过滤后再取 index' }
        },
        required: ['target']
      }
    },
    {
      name: 'browser_click_ref',
      description:
        '使用最近一次 browser_snapshot 返回的 DOM ref 点击任意 Element。ref 严格绑定快照、页面和 URL，且动作后立即失效；页面变化或再次快照后必须使用新 ref。可能改变外部状态的动作会在点击前强制请求用户确认。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'browser_snapshot 输出中的 ref，例如 ap-1-0-25' }
        },
        required: ['ref']
      }
    },
    {
      name: 'web_search',
      description: '在互联网上搜索指定关键词，返回相关的网页标题、链接及正文片段。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '要搜索的关键词'
          },
          max_results: {
            type: 'number',
            minimum: 1,
            maximum: 15,
            description: '可选。返回结果数量，默认为 8，最多 15。'
          },
          timeout_seconds: {
            type: 'number',
            minimum: 5,
            maximum: 120,
            description: '可选。搜索超时秒数，默认为 30 秒。'
          }
        },
        required: ['query']
      }
    },
    {
      name: 'web_fetch',
      description: '使用 Electron 本地隐藏浏览器抓取网页正文，清理后提取为 Markdown 文本。',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '要抓取的网页 URL'
          },
          timeout_seconds: {
            type: 'number',
            minimum: 5,
            maximum: 120,
            description:
              '可选。网络抓取的最长超时秒数（遇到连接较慢或复杂网页渲染时可设置，默认为 30 秒）。'
          },
          cache_ttl_seconds: {
            type: 'number',
            minimum: 0,
            maximum: 86400,
            description:
              '可选。相同 URL 的本地缓存有效期，默认为 1800 秒；设为 0 表示强制重新抓取。'
          }
        },
        required: ['url']
      }
    }
  ],
  systemRole: browserAutomationSkill
}
