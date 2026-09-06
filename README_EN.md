<div align="center">

<img src="resources/icon.png" width="140" alt="AgentPet Logo" />

# AgentPet 2.0

[简体中文](README.md) | [English](README_EN.md)

**An AI assistant that lives on your desktop—and your multi-agent workspace.**

Bring conversations, task orchestration, coding, knowledge retrieval, and office automation into one desktop app.

![Electron](https://img.shields.io/badge/Electron-39-47848F?logo=electron)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)
![Platform](https://img.shields.io/badge/Platform-Windows-0078D4)

[Repository](https://github.com/cqzaaa/AgentPet) · [Issues](https://github.com/cqzaaa/AgentPet/issues) · [Contributing](https://github.com/cqzaaa/AgentPet/pulls)

</div>

---

## 🌟 Overview

**AgentPet** is a desktop AI pet assistant built with Electron, React, and TypeScript. It combines an animated **Live2D avatar**, **TTS voice synthesis**, an **autonomous agent runtime**, and **SSH-based remote access and management**.

With its built-in toolset and MCP integration, AgentPet can search the web, develop code, operate terminals, and process Office documents. Based on ACP, it also supports local and remote multi-agent scheduling.

The current project version is **AgentPet 2.0**.

## Core capabilities

### Multi-agent orchestration

- Configure task nodes, agents, models, prompts, and dependencies on a visual canvas.
- Schedule tasks by dependency and control independent work with concurrency settings.
- Inspect task status, node output, execution events, and generated artifacts.
- Pause, resume, cancel, and retry failed nodes. Interrupted task records survive application restarts.
- Orchestration records are persisted in the current session. Later chat turns receive task requirements, node responses, execution states, and artifact paths within the configured context limit.

### Built-in agent and external CLIs

| Agent           | Integration                                      | Requirement                             |
| --------------- | ------------------------------------------------ | --------------------------------------- |
| AgentPet        | Built-in Agent Runtime                           | A configured model endpoint             |
| Claude Code     | Local CLI through the built-in Bridge            | CLI installed and authenticated locally |
| Codex           | Local CLI/app-server through the built-in Bridge | CLI installed and authenticated locally |
| Antigravity CLI | Local `agy` CLI through the built-in Bridge      | A working local CLI configuration       |

External agents use their own runtimes and authentication. Adding an API key to AgentPet does not sign in an external CLI automatically. Availability depends on the app's detection result and the actual local CLI environment.

### Model profiles and continuous conversations

- Create multiple profiles containing the endpoint, API key, model name, temperature, and output limit.
- Built-in profiles for OpenAI, Gemini, DeepSeek, Ollama, and custom OpenAI-compatible services.
- Fetch available models, enter model IDs manually, and test connections.
- Stream responses and reasoning, attach files and images, and steer work while it is running.
- Summarize older history and compact execution context; inspect prompts and related call details.

The model-list endpoint and chat endpoint are separate requests. If model discovery fails, you can still enter a valid model ID manually and test the chat connection.

### Skills and MCP extensions

Skills describe how a task should be performed, while tools provide the actual operations. Built-in skills cover coding, task planning, local files, terminals, web research, browser automation, desktop control, Office documents, RPA, scheduled tasks, and memory management.

- Load task-specific Skills before exposing their tools.
- Manage installed Skills, catalogs, and managed Skill runtimes.
- Connect external MCP services through SSE or Streamable HTTP.

### Knowledge base and memory

- Import and parse documents, then select a knowledge base during chat.
- Add matched passages, document structure, and citation identifiers to the current request.
- Plan multi-step retrieval and expose supporting evidence.
- Maintain a user profile, reusable experience memory, and session summaries.

### Files, code, and productivity tools

| Scenario                | Implemented capabilities                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Local projects          | Bind a workspace to a session, read and write files, locate paths, and search text                                   |
| Terminal and operations | Local commands, background process monitoring, SSH connections, and remote commands                                  |
| Web and browser         | Web search, content extraction, browser navigation, and element interaction                                          |
| Desktop control         | Windows screenshots, mouse, keyboard, and window operations                                                          |
| Office                  | Read and generate Word, Excel, PDF, and PowerPoint files, with selected editing, conversion, and rendering workflows |
| RPA                     | Record, save, execute, and inspect browser and desktop workflows                                                     |
| Scheduled tasks         | Configure recurring tasks and inspect execution logs                                                                 |

Document conversion, rendering, and browser control may require additional runtime components or local applications. Support for a file format does not mean every conversion path works without external dependencies.

### Desktop pet and companion interfaces

- PixiJS and Live2D rendering with configurable models, expressions, motions, and interactions.
- Floating input, screenshot entry points, and a dedicated workspace.
- Edge TTS speech synthesis.
- A WeChat bot integration module and local meeting recording/transcription runtime; these features require their corresponding services or components.

## Quick start

### Requirements

The current development scripts use the Windows `chcp` command, and desktop control includes Windows-specific implementations. **Windows** is therefore the recommended development and runtime environment.

- **Node.js 22.12+**. The current Vite dependency supports `^20.19.0 || >=22.12.0`.
- npm and Git.
- A working model API, or a local Ollama instance.
- Optional: external agent CLIs, SSH services, MCP services, and Office conversion components.

### Install and run

```powershell
git clone https://github.com/cqzaaa/AgentPet.git
cd AgentPet
npm ci
npm run dev
```

Dependency installation also runs the Electron native dependency setup. If a native module fails to install, keep the installation log and verify your Node, Electron, and local build environment.

### Configure your first model

1. Open Settings in the workspace and add a model profile.
2. Choose a provider and enter its API key and Base URL. For Ollama, use your actual local service address.
3. Select **Fetch models**, or enter a model ID manually.
4. Test the connection, save the profile, and activate it.
5. Return to Chat and send a message. Bind a working folder when the task requires file or code access.

Default endpoints:

| Provider | Base URL                                                   |
| -------- | ---------------------------------------------------------- |
| OpenAI   | `https://api.openai.com/v1`                                |
| Gemini   | `https://generativelanguage.googleapis.com/v1beta/openai`  |
| DeepSeek | `https://api.deepseek.com/v1`                              |
| Ollama   | `http://localhost:11434/v1`                                |
| Custom   | An OpenAI-compatible API base URL supplied by the provider |

Gemini uses its OpenAI-compatible endpoint. A custom endpoint should be an API base path, not a provider website or a complete `/chat/completions` URL. Claude Code is an external agent integration rather than a built-in Anthropic API provider.

### Run a multi-agent task

1. Bind an existing local working folder to the current session.
2. Confirm that each external agent you want to use can run locally.
3. Open the orchestration entry point in Chat, add nodes, and define their tasks.
4. Configure dependencies and concurrency, then start the run.
5. Select a node to inspect its status, output, and files. Handle permission requests or retry failures when needed.
6. Return to the same session and continue with a question such as: “What did the nodes complete? Continue based on the review results.”

A useful first workflow is **Inspect project → Implement changes → Review result**. You can also run several research nodes in parallel and pass their findings to a downstream synthesis node.

## Development and builds

| Command                | Purpose                                                      |
| ---------------------- | ------------------------------------------------------------ |
| `npm run dev`          | Start the development environment                            |
| `npm run typecheck`    | Type-check the main process and renderer                     |
| `npm run lint`         | Run ESLint                                                   |
| `npm run format`       | Format the repository; modifies files                        |
| `npm run build`        | Type-check and build the main process, preload, and renderer |
| `npm run start`        | Preview an existing build                                    |
| `npm run build:unpack` | Generate an unpacked application directory                   |
| `npm run build:win`    | Build the Windows installer                                  |

Development output is written to `out/`; Electron Builder output is written to `dist/` by default. The Windows configuration uses an NSIS installer that allows users to choose an installation directory.

The repository also provides `build:mac` and `build:linux` scripts and packaging configuration. This does not mean every desktop feature has been verified across platforms. Porting requires reviewing platform commands, native modules, desktop control, and operating-system permissions. macOS notarization is currently disabled.

Before publishing, review the version in `package.json` and the application ID, signing, and publishing settings in `electron-builder.yml`. The current auto-update URL is still a placeholder.

## Code map

```text
src/
├─ main/
│  ├─ index.ts             # Windows, IPC, and module assembly
│  ├─ agent-runtime/       # Agent loop, tool routing, and context compaction
│  ├─ model-runtime/       # Model APIs, streaming, and tool-call parsing
│  ├─ external-agents/     # CLI discovery, Bridges, ACP, and process management
│  ├─ task-runtime/        # Dependency scheduling, subagents, and persisted state
│  ├─ session-events/      # Session events and execution traces
│  ├─ skills/              # Skill registry, installation, and managed runtimes
│  ├─ tools/               # Built-in tools, MCP, authorization, and validation
│  ├─ api/                 # Memory, knowledge bases, and retrieval
│  ├─ rpa/                 # Workflow recording, execution, and storage
│  └─ security/            # Credentials and secure configuration modules
├─ preload/                # Bridge between Electron main and the renderer
└─ renderer/src/
   ├─ pages/               # Chat, Settings, Agents, Knowledge Base, and Trace pages
   ├─ components/          # Pet, orchestration canvas, task cards, and file previews
   ├─ hooks/               # Session state, message sending, and tool events
   └─ utils/               # Context merging and renderer helpers
```

Core technologies include Electron 39, React 19, TypeScript 5, Electron Vite, Zustand, React Virtuoso, React Flow, SQLite, PixiJS, the MCP SDK, and the ACP SDK. Document processing uses libraries such as `docx`, `exceljs`, `mammoth`, `pdfkit`, and `pptxgenjs` according to format.

## Data storage and migration

The application selects its data directory in this order:

1. If `USER_DATA_PATH` is set, it becomes Electron's `userData` path.
2. A packaged application attempts to create and use a `data/` directory next to the executable.
3. If that fails, Electron's default user-data directory remains active. Development builds also use the default location unless a path is specified.

The app settings can also define a custom business-data directory. Check the effective path in Settings before making a backup; copying only the installation directory may be insufficient.

Windows development example:

```powershell
$env:USER_DATA_PATH = 'D:\AgentPetData'
npm run dev
```

Before migrating, exit the app and back up the effective data directory, including databases, configuration, and related resources. Preserve bound external workspaces and generated artifacts separately. External CLI authentication, local runtimes, and some credentials may need to be configured again on another device.

## Authorization and execution boundaries

AgentPet includes command checks, tool auditing, and authorization prompts. Operations can request one-time or current-turn permission, and tasks can request additional information or credentials.

These are application-level controls rather than an operating-system isolation sandbox. File, terminal, SSH, and desktop tools affect the real environment, so use explicit working directories and suitably restricted accounts.

Configuration, databases, and execution records may contain API keys, prompts, file paths, or other sensitive information. Do not commit data directories, `.env` files, or unredacted logs. Do not assume that every configuration field is encrypted.

## FAQ

**Chat works, but model discovery fails. Why?**

The provider may not expose a model-list endpoint, or that endpoint may use different permissions. Check the Base URL and displayed error, enter the correct model ID manually, and test the connection.

**Why is an external agent unavailable?**

Confirm in a local terminal that the corresponding CLI starts and is authenticated, then check its executable configuration in AgentPet. Built-in model profiles and external CLI authentication are separate configurations.

**Why does the model not remember a completed orchestration run?**

Continue in the same session and use a version containing orchestration-context merging. Saved, undeleted orchestration records are loaded when a message is sent. The task query currently returns up to the 50 most recently updated records, and final history is also constrained by the configured context rounds.

**Why do Office, transcription, or browser features still require setup?**

These capabilities may depend on extra runtime components, local applications, or external services. Follow the relevant in-app setup guidance before running a task.

## Contributing

Reproducible bug reports and pull requests are welcome. Include the operating system, Node/Electron versions, reproduction steps, and redacted logs when reporting an issue.

Before submitting code, run the relevant type checks, lint rules, and tests. `package.json` contains several focused test scripts; confirm that your checkout includes each referenced test file before running them.

This repository currently has no `LICENSE` file, so this README does not claim an MIT or other open-source license. Third-party dependencies, Live2D models, and other resources remain subject to their respective licenses.
