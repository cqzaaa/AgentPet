import { loadOfficeSkill } from '../tools/builtin/office/skills/registry'
import type { OfficeSkillName } from '../tools/builtin/office/skills/types'
import { DESKTOP_CONTROL_INSTRUCTIONS } from '../tools/builtin/computer/policy'
import agentPetCodingSkill from '../tools/builtin/agentpet-coding/SKILL.md?raw'

export interface BuiltinSkillDefinition {
  id: string
  name: string
  description: string
  triggers: string[]
  allowedTools: string[]
  sections?: string[]
  estimatedTokens: number
  loadInstructions: (sections?: string[]) => Promise<string>
}

type StaticSkillInput = Omit<BuiltinSkillDefinition, 'estimatedTokens' | 'loadInstructions'> & {
  instructions: string
}

function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length
  return Math.max(1, Math.ceil(cjk + (text.length - cjk) / 4))
}

function staticSkill(input: StaticSkillInput): BuiltinSkillDefinition {
  return {
    ...input,
    estimatedTokens: estimateTokens(input.instructions),
    loadInstructions: async () => input.instructions
  }
}

function describeOfficeOperations(name: OfficeSkillName, skill: Awaited<ReturnType<typeof loadOfficeSkill>>): object {
  return {
    skill: name,
    title: skill.descriptor.title,
    description: skill.descriptor.description,
    instructions: skill.descriptor.instructions,
    operations: Object.entries(skill.descriptor.operations).map(([action, operation]) => ({
      action,
      description: operation?.description || '',
      inputSchema: operation?.inputSchema || { type: 'object', properties: {} }
    }))
  }
}

const OFFICE_SECTIONS: OfficeSkillName[] = ['pdf', 'docx', 'xlsx', 'pptx']

function officeSkill(): BuiltinSkillDefinition {
  return {
    id: 'office',
    name: 'Office documents',
    description: 'Read, create, edit, convert, render, and validate PDF, Word DOCX, Excel XLSX, and PowerPoint PPTX files. Use for document text, formatting, tables, slides, forms, layout, or file-format conversion; managed Python and native Office conversion engines run internally.',
    triggers: ['office', 'pdf', 'docx', 'word', 'xlsx', 'excel', 'pptx', 'powerpoint', '文档', '文件格式', '标题', '字体', '表格', '幻灯片', '转换'],
    allowedTools: ['run_office_skill'],
    sections: [...OFFICE_SECTIONS],
    estimatedTokens: 2500,
    loadInstructions: async (sections = []) => {
      const selected = OFFICE_SECTIONS.filter(name => sections.includes(name))
      const skills = await Promise.all(selected.map(async name => ({
        name,
        skill: await loadOfficeSkill(name)
      })))
      const overview = [
        '# Office documents',
        'Use run_office_skill for PDF, DOCX, XLSX, and PPTX work. Load all format sections needed for the current workflow in one request after the file type is known: pdf, docx, xlsx, or pptx. Do not load an Office overview first.',
        'Pass run_office_skill.input as a JSON object, never as a JSON-encoded string. Keep user text inside normal JSON string values so quotes are escaped by the tool-call serializer.',
        'The Office runtime already owns its managed Python packages, document converters, OCR helpers, and native Office export engines. Never request terminal, inspect pip, install packages, or write ad-hoc Python for an operation described here.',
        'Use files only when a path must first be found or inspected. Do not use generic file writes for Office edits: run_office_skill writes the generated artifact itself.',
        '',
        'For semantic edits to existing PDF text or formatting, PDF fixed-layout operations are insufficient. Convert PDF to editable DOCX with skill=pdf/action=convert, inspect and modify it with skill=docx, then export with skill=docx/action=convert when PDF output is required. Validate or render the final artifact before claiming success.',
        'For page-level PDF overlays, rotation, removal, append, forms, or metadata, use skill=pdf/action=modify directly.'
      ]
      if (selected.length === 0) {
        return [
          ...overview,
          '',
          'No format section was requested. Call request_skill again for the same office Skill with only the needed sections, for example skills:[{id:"office",sections:["pdf","docx"]}]. Re-requesting sections of an already loaded Skill does not consume another Skill slot.'
        ].join('\n')
      }
      const examples: string[] = []
      if (selected.includes('docx')) {
        examples.push(
          'DOCX style example (use modifications and nest formatting under style; never use operations, op, font_color, or a top-level color):',
          '{"skill":"docx","action":"modify","input":{"source_path":"C:/input.docx","output_name":"output.docx","modifications":[{"search":"Existing title","style":{"color":"FF0000"}}]}}'
        )
      }
      if (selected.includes('pdf') && selected.includes('docx')) {
        examples.push('PDF semantic formatting workflow: pdf.convert(target_format="docx") -> docx.modify -> docx.convert(target_format="pdf").')
      }
      return [
        ...overview,
        '',
        `Loaded format sections: ${selected.join(', ')}`,
        ...examples,
        '',
        JSON.stringify({ formats: skills.map(({ name, skill }) => describeOfficeOperations(name, skill)) }, null, 2)
      ].join('\n')
    }
  }
}

const builtinSkills: BuiltinSkillDefinition[] = [
  staticSkill({
    id: 'agentpet-coding',
    name: 'AgentPet coding',
    description: 'Inspect, create, understand, modify, debug, refactor, test, and review code. Use for source-code repositories, feature implementation, bug fixes, configuration, engineering verification, or creating an application, website, game, component, API, program, or script from scratch.',
    triggers: ['code', 'coding', 'repository', 'repo', 'implement', 'debug', 'bug', 'fix', 'refactor', 'test', 'lint', 'typecheck', 'build', 'diff', 'source', 'app', 'website', 'game', 'script', '代码', '编码', '源码', '仓库', '项目', '实现', '开发', '调试', '修复', '重构', '测试', '构建', '应用', '网站', '网页', '游戏', '程序', '脚本'],
    allowedTools: [
      'read_file', 'list_directory', 'get_file_metadata', 'find_files', 'grep_content',
      'write_file', 'edit_file', 'move_file', 'delete_file',
      'run_terminal_command', 'run_command', 'get_command_output', 'kill_command', 'run_python'
    ],
    instructions: agentPetCodingSkill
  }),
  staticSkill({
    id: 'agent-workflow',
    name: 'Agent workflow',
    description: 'Plan substantial work and delegate independent or dependency-linked subtasks.',
    triggers: ['plan', 'delegate', 'subagent', 'task plan', '规划', '计划', '委派', '子任务', '并行'],
    allowedTools: ['update_task_plan', 'update_task_step', 'delegate_tasks'],
    instructions: `# Agent workflow\nNever plan a single-file, single-mutation, low-risk task. For substantial work, call update_task_plan once, keep its structure immutable, and use update_task_step for all later progress. Complete or block the current step before another begins; the runtime starts the next ready step and closes successful work automatically. Use delegate_tasks only for concrete independent or dependency-linked subtasks.`
  }),
  staticSkill({
    id: 'files',
    name: 'Local files',
    description: 'Find, list, inspect, search, read, create, edit, move, or delete local files and folders in authorized locations. Use for filesystem content and organization; use office instead for PDF/DOCX/XLSX/PPTX formatting or conversion.',
    triggers: ['file', 'folder', 'read', 'find', 'grep', 'write', 'edit', 'move', 'delete', '文件', '目录', '读取', '查找', '写入', '编辑', '移动', '删除'],
    allowedTools: ['read_file', 'list_directory', 'get_file_metadata', 'find_files', 'grep_content', 'write_file', 'edit_file', 'move_file', 'delete_file'],
    instructions: `# Local files\nStay inside authorized workspace and session paths. Use find_files for names, grep_content for text, get_file_metadata before expensive reads when useful, and read_file in bounded ranges for large files. When the user says desktop, documents, or downloads, pass the matching find_files location directly; never ask for a Windows username or use terminal commands to discover a standard system folder. find_files auto matching accepts a filename without its extension. Inspect relevant existing content before editing, preserve unrelated user changes, and prefer targeted edits over full rewrites. Treat move and delete as destructive operations and follow approval and workspace boundary checks. Use office, not generic text writes, for Office/PDF formatting or conversion.`
  }),
  staticSkill({
    id: 'terminal',
    name: 'Terminal commands',
    description: 'Run and monitor PowerShell, cmd, bash, SSH, and other terminal commands.',
    triggers: ['terminal', 'command', 'shell', 'powershell', 'cmd', 'bash', 'ssh', 'python', '命令', '终端', '脚本'],
    allowedTools: ['run_terminal_command', 'run_command', 'get_command_output', 'kill_command', 'run_python'],
    instructions: `# Terminal commands\nUse run_terminal_command with an explicit working directory and appropriate shell. Use run_python for Python code or scripts so AgentPet can supply its managed embedded runtime without depending on a system Python installation. Poll durable commands with get_command_output and stop only the exact intended command with kill_command. Do not use shell commands to bypass file safety or approval controls.`
  }),
  staticSkill({
    id: 'web-research',
    name: 'Web research',
    description: 'Search the public web and fetch pages as readable Markdown.',
    triggers: ['web', 'internet', 'latest', 'current', 'search online', '网页', '联网', '最新', '搜索网络'],
    allowedTools: ['web_search', 'web_fetch'],
    instructions: `# Web research\nSearch before answering unstable or current questions. Fetch the most relevant primary pages, distinguish publication time from event time, and cite source URLs. Avoid repeating identical searches or fetches.`
  }),
  staticSkill({
    id: 'browser-automation',
    name: 'Browser automation',
    description: 'Connect to the local browser and navigate, inspect, search, and click DOM elements.',
    triggers: ['browser', 'website', 'open page', 'click link', '浏览器', '网站', '网页操作', '点击'],
    allowedTools: ['browser_connect', 'browser_tabs', 'browser_select_tab', 'browser_navigate', 'browser_search', 'browser_snapshot', 'browser_click', 'browser_click_ref'],
    instructions: `# Browser automation\nPrefer DOM snapshots and stable element references over screen coordinates. Connect before interacting, select the intended tab, inspect after navigation, and verify state after clicks. Use browser_search for ordinary web searches.`
  }),
  staticSkill({
    id: 'desktop-control',
    name: 'Desktop control',
    description: 'Observe and control Windows applications with screenshots, mouse, keyboard, and window focus.',
    triggers: ['desktop', 'window', 'mouse', 'keyboard', 'screenshot', '桌面', '窗口', '鼠标', '键盘', '截图'],
    allowedTools: [
      'screenshot', 'mouse_move', 'mouse_click', 'mouse_click_relative', 'mouse_scroll',
      'type_text', 'key_press', 'get_windows', 'focus_window', 'find_ui_elements',
      'click_ui_element', 'focus_ui_element', 'perform_computer_actions'
    ],
    instructions: DESKTOP_CONTROL_INSTRUCTIONS
  }),
  staticSkill({
    id: 'rpa-run',
    name: 'Run saved RPA workflows',
    description: 'Search, inspect, run, monitor, and cancel saved RPA workflows.',
    triggers: ['rpa', 'workflow', 'automation flow', '运行流程', '自动化流程', '工作流'],
    allowedTools: ['rpa_search_workflows', 'rpa_describe_workflow', 'rpa_run_workflow', 'rpa_get_run_status', 'rpa_cancel_run'],
    instructions: `# Run saved RPA workflows\nSearch before selecting a workflow and never invent a workflow id. Describe the selected workflow before running it, obtain missing inputs from the user, and distinguish started from completed. Use status polling for completion and cancel only the intended run.`
  }),
  staticSkill({
    id: 'rpa-recording',
    name: 'Record RPA workflows',
    description: 'Create, pause, resume, review, finish, or cancel an RPA recording session.',
    triggers: ['record rpa', 'record workflow', '录制', '录制流程', '录制自动化'],
    allowedTools: ['rpa_start_recording', 'rpa_pause_recording', 'rpa_resume_recording', 'rpa_get_recording_status', 'rpa_finish_recording', 'rpa_bind_recording_secret', 'rpa_cancel_recording'],
    instructions: `# Record RPA workflows\nUse guided mode by default. A missing start URL may remain in preparing state until the user provides it. Never pass plaintext credentials; bind an existing secret reference during review. Finish only after required secret bindings are complete.`
  }),
  staticSkill({
    id: 'system-info',
    name: 'System information',
    description: 'Read local system status or request the current physical location.',
    triggers: ['cpu', 'memory', 'system status', 'location', '系统状态', '内存', '定位', '位置'],
    allowedTools: ['get_system_status', 'get_location'],
    instructions: `# System information\nUse get_system_status for local hardware and runtime facts. Use get_location only when physical location is necessary and explain operating-system permission failures without guessing coordinates.`
  }),
  staticSkill({
    id: 'scheduled-tasks',
    name: 'Scheduled tasks',
    description: 'Create or delete recurring background tasks.',
    triggers: ['schedule', 'cron', 'recurring', 'reminder', '定时', '周期任务', '提醒'],
    allowedTools: ['manage_cron_task'],
    instructions: `# Scheduled tasks\nConfirm the intended action, interval, and task content. Use create only with a meaningful name and action. Delete only the exact task id the user intends to remove.`
  }),
  staticSkill({
    id: 'memory-management',
    name: 'Memory management',
    description: 'Save an explicit durable summary or trigger long-term memory consolidation.',
    triggers: ['remember', 'memory', 'save summary', '记住', '长期记忆', '保存总结'],
    allowedTools: ['trigger_memory_purify', 'append_memory_summary'],
    instructions: `# Memory management\nPersist information only when the user explicitly asks or when the configured workflow requires a durable summary. Keep summaries factual, scoped, and free of secrets that should not be stored.`
  }),
  officeSkill()
]

export function listBuiltinSkills(): BuiltinSkillDefinition[] {
  return builtinSkills.map(skill => ({
    ...skill,
    triggers: [...skill.triggers],
    allowedTools: [...skill.allowedTools],
    sections: skill.sections ? [...skill.sections] : undefined
  }))
}

export function getBuiltinSkill(id: string): BuiltinSkillDefinition | undefined {
  return builtinSkills.find(skill => skill.id === id)
}
