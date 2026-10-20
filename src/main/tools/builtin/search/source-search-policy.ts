import { getCommandSegments } from '../../security/safety-checker'
import { relative } from 'path'

const GENERATED_DIRECTORIES = [
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.output', '.cache'
]
const GENERATED_SUFFIXES = ['.map', '.min.js', '.min.css', '.tsbuildinfo']
export const SOURCE_SEARCH_EXCLUDES = [
  ...GENERATED_DIRECTORIES.map(name => `**/${name}/**`),
  ...GENERATED_SUFFIXES.map(suffix => `**/*${suffix}`)
]

// ripgrep always searches explicitly named files, even if a glob excludes
// them. Check the selected scope too, so the opt-in has consistent semantics.
export function isGeneratedSearchTarget(target: string, workspaceRoot: string): boolean {
  const scope = relative(workspaceRoot, target).replace(/\\/g, '/').toLowerCase()
  return scope.split('/').some(part => GENERATED_DIRECTORIES.includes(part)) ||
    GENERATED_SUFFIXES.some(suffix => scope.endsWith(suffix))
}

export const SOURCE_SEARCH_GUIDANCE =
  '源码检索优先使用 grep_content，默认排除依赖、构建目录、source map 和压缩文件。' +
  '不要使用 Get-ChildItem -Recurse | Select-String 遍历全部文件；-Exclude node_modules,dist 不能可靠剪枝这些目录。' +
  'grep_content 未提供时先加载 agentpet-coding。确需研究生成文件时，用 grep_content 的 include_generated=true 并指定具体文件或子目录。'

// A performance guard for the known unbounded PowerShell content-search
// pattern, not a shell sandbox. Directory listings and direct file reads remain usable.
export function isRecursivePowerShellContentSearch(command: string, shell: string): boolean {
  if (shell !== 'powershell') return false
  const segments = getCommandSegments(command)
  const recursiveListing = segments.some(segment =>
    /^(?:get-childitem|gci|dir|ls)$/i.test(segment.command) &&
    /(?:^|\s)-(?:r|re|rec|recu|recur|recurs|recurse|depth)(?=\s|:|$)/i.test(segment.args))
  return recursiveListing && segments.some(segment => /^(?:select-string|sls)$/i.test(segment.command))
}
