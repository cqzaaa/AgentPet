import { ToolManifest } from '../../core/types'

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
      name: 'web_search',
      description: '在互联网上搜索指定关键词，返回相关的网页标题、链接及正文片段。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '要搜索的关键词'
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
            description: '可选。网络抓取的最长超时秒数（遇到连接较慢或复杂网页渲染时可设置，默认为 30 秒）。'
          }
        },
        required: ['url']
      }
    }
  ]
}
