<div align="center">

<img src="resources/icon.png" width="140" alt="AgentPet Logo" />

# AgentPet 2.0

[简体中文](README.md) | [English](README_EN.md)

**住在桌面上的 AI 助手，也是你的多 Agent 工作台。**

把对话、任务编排、代码协作、知识检索和办公自动化，放进同一个桌面应用。

![Electron](https://img.shields.io/badge/Electron-39-47848F?logo=electron)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)
![Platform](https://img.shields.io/badge/Platform-Windows-0078D4)

[项目仓库](https://github.com/cqzaaa/AgentPet) · [问题反馈](https://github.com/cqzaaa/AgentPet/issues) · [参与贡献](https://github.com/cqzaaa/AgentPet/pulls)

</div>

---

## 🌟 简介

**AgentPet** 是一款基于 Electron + React + TypeScript 打造的桌面智能 AI 宠物助手。它拥有生动的 **Live2D 动态外观**、**TTS 语音合成支持**与**自主决策 Agent 引擎**，同时支持 **SSH 远程连接与管理**，将桌面陪伴与任务执行融为一体。

借助内置工具箱与 MCP 协议，AgentPet 可以完成网页搜索、代码开发、终端操作和 Office 文档处理，并基于 ACP 协议支持多 Agent 本地、远程调度。

当前项目版本为 **AgentPet 2.0**。

## 核心能力

### 多 Agent 编排

- 在可视化画布中配置任务节点、Agent、模型、Prompt 和依赖关系。
- 按依赖调度任务，通过并发设置控制独立节点的执行。
- 查看任务状态、节点输出、执行事件及生成文件。
- 支持暂停、恢复、取消和失败节点重试；应用重启后可恢复中断任务的记录，等待后续处理。
- 编排记录持久化到当前会话。后续聊天组装上下文时，会合并任务要求、节点回复、执行状态和产物路径，并遵循上下文轮数限制。

### 内置 Agent 与外部 CLI

| Agent           | 接入方式                                  | 使用前提                       |
| --------------- | ----------------------------------------- | ------------------------------ |
| AgentPet        | 内置 Agent Runtime                        | 配置可用的模型接口             |
| Claude Code     | 本机 CLI，经内置 Bridge 接入              | 本机已安装并完成相应登录或配置 |
| Codex           | 本机 CLI / app-server，经内置 Bridge 接入 | 本机已安装并完成相应登录或配置 |
| Antigravity CLI | 本机 `agy` CLI，经内置 Bridge 接入        | 本机具备可用 CLI 与相应配置    |

外部 Agent 使用各自的运行环境和认证配置，不会因为填写了 AgentPet 的模型 API Key 就自动完成登录。是否可用，以应用中的检测结果和实际 CLI 环境为准。

### 模型配置与连续对话

- 支持多个模型配置档案，保存并切换服务地址、API Key、模型名称、温度和输出上限。
- 内置 OpenAI、Gemini、DeepSeek、Ollama 和自定义 OpenAI 兼容服务配置。
- 支持获取模型列表、手动输入模型名称和测试连接。
- 支持流式回答、思考内容展示、文件与图片附件，以及执行中的追加指引。
- 支持历史摘要和执行上下文压缩；可检查发送给模型的 Prompt 与相关调用信息。

模型列表接口与对话接口是不同请求。无法获取列表时，仍可手动填写服务商提供的模型 ID，再测试对话连接。

### Skills 与 MCP 扩展

Skills 描述任务的执行方法，工具提供实际操作能力。内置技能覆盖代码开发、任务规划、本地文件、终端、网页检索、浏览器操作、桌面控制、Office、RPA、定时任务和记忆管理。

- 按任务加载相关 Skill，再开放对应工具。
- 提供技能管理、技能目录和受管技能运行环境。
- 支持通过 SSE / Streamable HTTP 连接外部 MCP 服务，扩展工具能力。

### 知识库与记忆

- 导入文档并进行内容解析，在聊天中选择知识库检索。
- 将命中的正文、结构信息和引用编号带入当前问题。
- 支持多步检索规划，展示相关检索证据。
- 维护人物画像、历史经验召回与会话摘要，为后续任务提供背景。

### 文件、代码与办公工具

| 场景         | 已实现的能力                                                        |
| ------------ | ------------------------------------------------------------------- |
| 本地项目     | 绑定会话工作区、文件读写、路径检索、文本搜索                        |
| 终端与运维   | 本地命令、后台进程监控、SSH 连接与远程命令                          |
| 网页与浏览器 | 网页搜索、内容抓取、浏览器导航及元素操作                            |
| 桌面操作     | Windows 截图、鼠标、键盘及窗口操作                                  |
| Office       | Word、Excel、PDF、PowerPoint 的读取、生成及部分编辑、转换和渲染流程 |
| RPA          | 浏览器与桌面流程录制、保存、执行和运行记录                          |
| 定时任务     | 配置周期任务并查看执行日志                                          |

文档转换、渲染、浏览器控制等能力可能需要额外运行组件或本机软件，按应用提示完成配置。支持某种文件格式，不代表所有转换路径都无需外部依赖。

### 桌宠与辅助入口

- 基于 PixiJS 和 Live2D 的桌宠渲染，支持模型、表情、动作及交互配置。
- 悬浮输入、截图入口与独立工作台。
- Edge TTS 语音合成。
- 微信机器人接入模块，以及本地会议录音、转写相关运行模块；使用时需配置对应服务或组件。

## 快速开始

### 环境准备

当前开发脚本包含 Windows 的 `chcp` 命令，桌面控制也包含 Windows 专用实现，建议先在 **Windows** 环境开发和运行。

- **Node.js 22.12+**；当前 Vite 依赖的 Node 版本范围为 `^20.19.0 || >=22.12.0`。
- npm 与 Git。
- 一个可用的模型 API，或本机运行的 Ollama。
- 可选：外部 Agent CLI、SSH 服务、MCP 服务及办公转换组件。

### 安装与启动

```powershell
git clone https://github.com/cqzaaa/AgentPet.git
cd AgentPet
npm ci
npm run dev
```

依赖安装会执行 Electron 原生依赖安装流程。若原生模块安装失败，请保留安装日志，核对 Node、Electron 和本机编译环境。

### 配置第一个模型

1. 打开工作台的设置页面，添加模型配置。
2. 选择服务商，填写 API Key 和 Base URL；本地 Ollama 按实际服务配置填写。
3. 点击“获取模型”，或直接输入模型 ID。
4. 测试连接，保存并启用该配置。
5. 返回聊天页发送消息；需要文件或代码操作时，为会话绑定工作文件夹。

内置默认地址：

| 服务商   | Base URL                                                  |
| -------- | --------------------------------------------------------- |
| OpenAI   | `https://api.openai.com/v1`                               |
| Gemini   | `https://generativelanguage.googleapis.com/v1beta/openai` |
| DeepSeek | `https://api.deepseek.com/v1`                             |
| Ollama   | `http://localhost:11434/v1`                               |
| 自定义   | 服务商提供的 OpenAI 兼容 API 地址                         |

这里的 Gemini 使用 OpenAI 兼容接口。自定义地址应填写 API 基础路径，不是服务商网页或完整的 `/chat/completions` 地址。Claude Code 属于外部 Agent 接入，不等同于内置 Anthropic 原生 API 服务商。

### 执行一次多 Agent 任务

1. 为当前会话绑定存在的本地工作文件夹。
2. 确认需要使用的外部 Agent 在本机可运行。
3. 打开聊天中的编排入口，添加节点并设置任务要求。
4. 配置依赖关系和并发数，启动执行。
5. 点击节点查看状态、输出和文件；按需处理授权或失败重试。
6. 返回同一会话继续提问，例如：“刚才各节点完成了什么？根据检查结果继续修改。”

可从“检查项目 → 实现修改 → 审查结果”这样的依赖链开始，也可以让多个研究节点并行工作，再由后续节点汇总。

## 开发与构建

| 命令                   | 用途                               |
| ---------------------- | ---------------------------------- |
| `npm run dev`          | 启动开发环境                       |
| `npm run typecheck`    | 检查主进程和前端类型               |
| `npm run lint`         | 执行 ESLint 检查                   |
| `npm run format`       | 格式化项目，会修改文件             |
| `npm run build`        | 类型检查并构建主进程、预加载和前端 |
| `npm run start`        | 预览已构建应用，需先构建           |
| `npm run build:unpack` | 生成未封装的应用目录               |
| `npm run build:win`    | 构建 Windows 安装包                |

开发构建产物位于 `out/`，Electron Builder 打包产物默认位于 `dist/`。Windows 配置包含可选择安装目录的 NSIS 安装器。

仓库也提供 `build:mac`、`build:linux` 脚本和对应打包配置，但不代表所有桌面功能已完成跨平台验证。移植时需要检查平台命令、原生模块、桌面控制和系统权限；macOS 当前未启用公证。

发布前应核对 `package.json` 的版本，以及 `electron-builder.yml` 中的应用标识、签名和发布地址。当前自动更新地址仍为示例值。

## 代码导航

```text
src/
├─ main/
│  ├─ index.ts             # 应用窗口、IPC 与模块装配
│  ├─ agent-runtime/       # Agent 执行循环、工具路由、上下文压缩
│  ├─ model-runtime/       # 模型接口、流式输出、工具调用解析
│  ├─ external-agents/     # CLI 检测、Bridge、ACP 与进程管理
│  ├─ task-runtime/        # 任务依赖调度、子 Agent、状态持久化
│  ├─ session-events/      # 会话事件与执行轨迹
│  ├─ skills/              # 技能注册、安装与受管运行环境
│  ├─ tools/               # 内置工具、MCP、授权与执行检查
│  ├─ api/                 # 记忆、知识库与检索
│  ├─ rpa/                 # 流程录制、执行与存储
│  └─ security/            # 凭据及安全配置相关模块
├─ preload/                # Electron 主进程与前端 API 桥接
└─ renderer/src/
   ├─ pages/               # 聊天、设置、Agent、知识库、轨迹等页面
   ├─ components/          # 桌宠、编排画布、任务卡片和文件预览
   ├─ hooks/               # 会话状态、消息发送和工具事件处理
   └─ utils/               # 上下文合并与前端辅助逻辑
```

主要技术：Electron 39、React 19、TypeScript 5、Electron Vite、Zustand、React Virtuoso、React Flow、SQLite、PixiJS、MCP SDK 和 ACP SDK。文档处理按格式使用 `docx`、`exceljs`、`mammoth`、`pdfkit`、`pptxgenjs` 等库。

## 数据存储与迁移

应用数据目录的选择顺序为：

1. 设置了 `USER_DATA_PATH` 时，优先用该路径作为 Electron `userData`。
2. 打包应用尝试在可执行文件同级目录创建 `data/`。
3. 创建失败时，保留 Electron 默认用户数据目录；开发环境未指定路径时也使用默认目录。

应用设置还支持自定义业务数据存储路径。因此，备份时请确认设置中的实际路径，不要只复制安装目录。

Windows 开发环境示例：

```powershell
$env:USER_DATA_PATH = 'D:\AgentPetData'
npm run dev
```

迁移前先退出应用，备份实际数据目录中的数据库、配置与相关资源；会话绑定的外部工作区和文件产物应另行保留。迁移到其他设备后，外部 CLI 登录、本机运行环境和部分凭据可能需要重新配置。

## 授权与执行边界

AgentPet 包含命令检查、工具审计和授权交互，可根据具体操作请求单次或本轮授权。任务过程中也可向用户请求补充信息或凭据。

这些机制属于应用层检查，不能等同于操作系统级隔离沙箱。文件、终端、SSH 和桌面工具会影响实际环境，请使用明确的工作目录和合适的账号权限。

配置、数据库及执行记录可能包含 API Key、Prompt、文件路径或其他敏感内容。不要直接把数据目录、`.env` 或未脱敏的运行日志提交到仓库；也不要假定所有配置字段都经过加密。

## 常见问题

**能对话，但获取不到模型列表？**

服务商可能没有开放模型列表接口，或该接口权限不同。检查 Base URL 和错误提示，手动输入正确的模型 ID 后测试连接。

**外部 Agent 显示不可用？**

先在本机终端确认对应 CLI 可以启动并完成登录，再检查应用中的可执行文件配置。内置模型设置与外部 CLI 认证是两套配置。

**编排完成后，模型仍不知道刚才做了什么？**

确认后续提问位于同一会话，并使用包含编排上下文合并逻辑的代码版本。已保存、未删除的编排记录会在发送时读取；当前任务查询最多返回最近更新的 50 条记录，最终历史还受上下文轮数限制。

**安装后 Office、转写或浏览器功能仍需要配置？**

这些能力可能依赖额外运行组件、本机软件或外部服务。按对应功能的提示完成安装和配置，再执行任务。

## 参与贡献

欢迎通过 Issue 提交可复现问题，或通过 Pull Request 改进功能与文档。反馈时建议提供操作系统、Node/Electron 版本、复现步骤和脱敏日志。

代码提交前运行与改动相关的类型检查、Lint 和测试。`package.json` 中包含多个专项测试脚本，运行前请确认当前检出版本包含其引用的测试文件。

当前仓库未提供 `LICENSE` 文件，因此本 README 不声明 MIT 或其他开源许可。第三方依赖、Live2D 模型及其他资源应分别遵循其授权条款。
