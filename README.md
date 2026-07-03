# 🐾 AgentPet — 智能桌面Agent助手

<div align="center">

[![GitHub License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-v39.2-47848F?logo=electron)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-v19.2-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-v5.9-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-Welcome-brightgreen.svg)](https://github.com/cheer-com/agentpet/pulls)

**一款集灵动交互、大模型自主规划与强大办公工具箱于一体的下一代智能桌面虚拟伴侣。**

[🏠 项目主页](http://cheer472.cloud:3031/) · [🐛 报告问题](http://cheer472.cloud:3031/) · [💡 贡献代码](http://cheer472.cloud:3031/)

</div>

---

## 🌟 简介

**AgentPet** 是一款基于 Electron + React + TypeScript 打造的桌面智能 AI 宠物助手。它不仅拥有精致、生动的 **Live2D 动态拟人化外观**，更拥有一个聪明的 **自主决策 Agent 引擎**。

借助内置的 **工具箱 (Built-in Toolset)** 和 **MCP (Model Context Protocol)** 协议，AgentPet 可以自主拆解并执行你交代的复杂任务（如网页搜索、终端操作、Office 文档解析与生成等）。无论是无聊时与你闲聊，还是在工作时作为你的生产力助手，它都能完美胜任。

---

## ✨ 核心特性

### 🎭 1. 拟人化 Live2D 动态互动
- **生动渲染**：基于 PixiJS v6 动画引擎，完美渲染高帧率 Live2D 模型。
- **物理反馈**：支持鼠标跟随、拖拽位移、重力碰撞以及触碰不同部位触发的特有物理反馈。
- **生动微表情**：提供多套丰富表情与动作组，配合悬浮气泡框，实现温暖、拟人化的桌面陪伴。
- **多端语音**：内置 Edge-TTS，提供高品质、低延迟的自然语音合成。

### 🧠 2. 自主决策 Agent 引擎
- **全自动规划 (Planning)**：接收复杂指令后，Agent 能够自主进行多步规划与分解。
- **记忆机制 (Memory)**：支持长期记忆与工作上下文关联，越用越懂你。
- **工具调用 (Tool Calling)**：无缝桥接大模型思维与系统本地的执行能力。
- **透明执行日志**：拥有可视化控制台，任务执行链（思考、调用工具、观察、总结）一目了然。

### 🛠️ 3. 强大的 Built-in 内置工具箱
- **Office 办公文档处理**：
  - 支持 `.docx`（Word）解析与动态预览。
  - 支持 `.xlsx` / `.csv`（Excel）的读取、深度处理与表格生成，并带有内置的 Electron 高性能电子表格在线视口。
  - 支持 PDF 解析与 PDF 报告的动态生成。
  - 支持 PPT 幻灯片自动排版与输出。
- **系统与终端交互**：
  - **终端工具**：内置安全终端，支持本地命令行执行及 SSH 远程服务器安全连接。
  - **文件系统**：支持本地文件的高效检索、读写与深度文本解析（基于 `ripgrep` 等高性能引擎）。
- **网页与搜索**：
  - 支持互联网搜索引擎检索、网页 HTML 内容抓取及自适应正文抽取。

### 🔌 4. 开放的 MCP (Model Context Protocol) 协议
- 支持动态配置和连接外部 MCP 服务器（SSE / Streamable HTTP 等）。
- 开发者可以通过编写符合 MCP 规范的标准服务，无限拓宽 AgentPet 的功能边界。

### 🖥️ 5. 精妙的“四窗口”协作架构
- **桌宠悬浮视口**：超轻量无边框视口，支持鼠标穿透，不遮挡任何日常操作。
- **快捷输入窗口**：支持全局热键唤醒，可一键挂载**屏幕截图**进行多模态视觉解析。
- **Agent 工作台控制中心**：大尺寸后台任务面板，展示会话详情、工具管理、安全授权、大模型参数微调等。
- **全屏截图剪切窗**：支持多显示器的高清截屏与框选裁剪，为 Agent 交互提供视觉上下文。

### ⚡ 6. 针对桌宠场景的极致物理优化
- **内存自动修剪**：独创针对 Windows 平台的物理内存定期修剪技术（通过底层 API 主动释放未活跃页）。
- **激进 GC 回收**：在 Live2D 纹理更新、窗口切换等空闲节点强制触发 V8 垃圾回收，彻底根治 Electron 进程常年占用大内存的痛点。

---

## 🛠️ 技术栈

| 模块 | 技术选型 | 备注 |
| --- | --- | --- |
| **应用外壳 (Shell)** | Electron 39 / Electron-Vite | 现代化跨平台桌面客户端容器 |
| **视图层 (View)** | React 19 / TypeScript 5 / Less | 响应式组件与高严谨类型系统 |
| **渲染层 (Graphics)** | Pixi.js v6 / Pixi-Live2D-Display | 高性能 WebGL 渲染 Live2D 模型 |
| **智能体 (Agent)** | @modelcontextprotocol/sdk | 行业标准智能体协议 / 自研 Runtime 执行器 |
| **本地存储 (DB)** | SQLite 3 / sqlite | 轻量级关系数据库，保障会话与任务存储 |
| **语音合成 (TTS)** | Node-Edge-TTS | 微软高仿真文本转语音引擎 |
| **文档处理 (Office)** | exceljs / docx / mammoth / pdfkit / pptxgenjs | 完整的办公系列格式套件 |

---

## 🚀 快速开始

### 运行环境准备
- 请确保您的操作系统已安装 [Node.js](https://nodejs.org/)（推荐使用 LTS v20.x 或以上版本）。

### 1. 克隆项目并安装依赖

```bash
git clone https://github.com/your-username/agentpet.git
cd agentpet
npm install
```

### 2. 配置文件

在项目根目录下创建一个 `.env` 环境变量文件，填入您的硅基流动 API Key 以启用高精度的文本/向量模型嵌入服务：

```env
# 硅基流动 SiliconFlow API Key
SILICONFLOW_API_KEY=sk-your-siliconflow-api-key-here
```

### 3. 开发环境调试

启动开发模式，支持代码热重载（HMR）：

```bash
npm run dev
```

### 4. 生产包打包发布

项目预置了多平台的 Electron-Builder 配置，你可以根据自身平台一键打包：

```bash
# 构建 Windows 包 (便携版/安装版)
npm run build:win

# 构建 macOS 包
npm run build:mac

# 构建 Linux 包
npm run build:linux
```
打包输出后的应用程序及安装包均位于项目根目录的 `dist/` 下。

---

## 💾 数据存储与便携模式 (Portable Mode)

AgentPet 默认提供极佳的**便携特性**：
1. **优先便携目录**：对于打包后的生产应用，默认会在 **可执行文件 (`exe`/`app`) 的同级目录** 下自动创建 `data/` 目录。所有的 SQLite 数据库、全局配置文件、缓存、任务运行日志均会落地于此。这极大方便了用户在不同电脑间备份或迁移桌宠数据，且不会污染系统的 `C` 盘 AppData。
2. **自定义路径**：你可以通过在 `.env` 中指定 `USER_DATA_PATH` 环境变量来直接重写全局数据存放路径。
3. **安全后备**：若当前目录无写入权限（如在 C:\Program Files 下），应用将安全退回到系统默认的 `AppData/Local` 目录。

---

## 🔒 安全与授权机制

智能 Agent 在为你处理本地文件、执行终端命令时，其安全防护至关重要：
- **操作沙箱**：Agent 所调用的本地 Shell 和 SSH 命令均在严格的虚拟进程上下文或受限连接中执行。
- **动态权限授权**：针对高敏感度工具操作（如删除本地文件、修改系统配置、执行写操作等），系统前端会弹出**授权确认浮窗**。只有在用户明确授权后，Agent 才能继续前行，实现真正的“人机协同，安全可控”。

---

## 📄 许可证

本项目开源协议为 [MIT License](LICENSE)。欢迎提交 Issue、PR 共同完善项目！
