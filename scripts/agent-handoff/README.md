# Agent Handoff 自动任务桥

该服务把外部 Agent 生成的文档目录转换成 Codex CLI 任务，并把执行结果写回文件系统。

## 快速开始

先提交一个本地测试任务：

```powershell
npm run handoff:submit -- "阅读 README.md，并给出不修改文件的项目概览"
```

验证任务解析和安全检查，不实际调用 Codex：

```powershell
npm run handoff:dry-run
```

持续监听并自动执行：

```powershell
npm run handoff:watch
```

## 外部 Agent 提交协议

外部 Agent 应先在 `.agent-handoff/staging/<task-id>` 写完所有文件，再把整个目录原子重命名为 `.agent-handoff/incoming/<task-id>`。不要直接向 `incoming` 中逐个写文件。

最小 `manifest.json`：

```json
{
  "version": 1,
  "id": "task-20260729-001",
  "workspace": "D:\\Electron\\AgentPet",
  "instruction": "根据 design.md 实现功能并运行测试",
  "inputs": ["design.md"],
  "acceptance": ["类型检查通过", "不修改公开接口"]
}
```

任务生命周期：

```text
staging -> incoming -> running -> completed | failed
```

结果目录包含：

- `result.json`：机器可读状态；
- `output.md`：Codex 最终回复；
- `runner.stdout.log` 和 `runner.stderr.log`：执行日志；
- 原始任务文档和附件。

## 安全边界

- 允许的工作目录只由 `handoff.config.json` 中的 `allowedWorkspaces` 决定。
- 外部任务不能指定执行器或命令行参数。
- `inputs` 必须是任务目录内的相对路径，禁止 `..` 和绝对路径。
- 默认串行消费任务，避免多个 Agent 同时修改同一工作区。
- 建议使用专用 Git 分支，并在自动执行前确保工作区没有无关改动。

## 执行器配置

默认配置调用：

```text
codex exec --full-auto -C {workspace} -o {outputFile} -
```

如果本机 Codex CLI 的路径或参数不同，可修改 `handoff.config.json`，或设置：

```powershell
$env:HANDOFF_RUNNER_COMMAND = 'codex'
$env:HANDOFF_RUNNER_ARGS_JSON = '["exec","--full-auto","-C","{workspace}","-o","{outputFile}","-"]'
```

支持的占位符为 `{workspace}`、`{taskDir}` 和 `{outputFile}`。
