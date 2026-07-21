import { app, BrowserWindow, ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { spawn } from 'child_process'
import * as fs from 'fs'
import { dirname, join, resolve } from 'path'

import JSZip from 'jszip'

const PYTHON_VERSION = '3.11.9'
const PDF2DOCX_VERSION = '0.5.8'
const OFFICE_PYTHON_PACKAGES = [
  `pdf2docx==${PDF2DOCX_VERSION}`,
  'PyMuPDF==1.24.10',
  'python-docx==1.1.2',
  'fonttools==4.54.1',
  'numpy==1.26.4',
  'opencv-python-headless==4.10.0.84',
  'fire==0.7.1'
] as const
const RUNTIME_SCHEMA_VERSION = 1
const PYTHON_EMBED_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py'
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000

export interface OfficeRuntimeInfo {
  rootDir: string
  pythonPath: string
  converterScriptPath: string
  tableExtractorScriptPath: string
  pythonVersion: string
  pdf2docxVersion: string
}

interface PendingRequest {
  resolve: (approved: boolean) => void
  timer: NodeJS.Timeout
  sessionId?: string
}

interface InstallEventContext {
  requestId: number
  sessionId?: string
  messageId?: number
  target: BrowserWindow
}

function runtimeRoot(): string {
  return join(app.getPath('userData'), 'runtimes', 'office-components')
}

function runtimeInfo(): OfficeRuntimeInfo {
  const rootDir = runtimeRoot()
  const pythonDir = join(rootDir, `python-${PYTHON_VERSION}`)
  return {
    rootDir,
    pythonPath: join(pythonDir, 'python.exe'),
    converterScriptPath: join(rootDir, 'scripts', 'pdf_to_docx.py'),
    tableExtractorScriptPath: join(rootDir, 'scripts', 'pdf_tables.py'),
    pythonVersion: PYTHON_VERSION,
    pdf2docxVersion: PDF2DOCX_VERSION
  }
}

function sendInstallEvent(
  eventContext: InstallEventContext,
  type: 'office_runtime_progress' | 'office_runtime_complete' | 'office_runtime_error',
  detail: string,
  progress: number
): void {
  if (eventContext.target.isDestroyed()) return
  eventContext.target.webContents.send('api:llm-tool-event', {
    type,
    requestId: eventContext.requestId,
    detail,
    progress: Math.max(0, Math.min(100, Math.round(progress))),
    timestamp: Date.now(),
    messageId: eventContext.messageId,
    sessionId: eventContext.sessionId
  })
}

async function runProcess(
  executable: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal; timeoutMs?: number }
): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONNOUSERSITE: '1',
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
        PIP_NO_INPUT: '1'
      }
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Office 组件安装命令超时：${executable}`))
    }, options.timeoutMs || INSTALL_TIMEOUT_MS)
    const abort = (): void => {
      child.kill()
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', error => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (options.signal?.aborted) {
        reject(new Error('Office 组件包安装已取消'))
      } else if (code === 0) {
        resolvePromise(stdout.trim())
      } else {
        reject(new Error((stderr || stdout || `进程退出码 ${code}`).slice(-4000)))
      }
    })
  })
}

async function downloadBuffer(
  url: string,
  signal: AbortSignal | undefined,
  onProgress: (ratio: number) => void
): Promise<Buffer> {
  const response = await fetch(url, { signal })
  if (!response.ok || !response.body) {
    throw new Error(`下载失败（HTTP ${response.status}）：${url}`)
  }
  const total = Number(response.headers.get('content-length') || 0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    received += value.byteLength
    if (total > 0) onProgress(received / total)
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
}

async function extractPythonArchive(archiveBytes: Buffer, destination: string): Promise<void> {
  const archive = await JSZip.loadAsync(archiveBytes)
  const destinationRoot = resolve(destination)
  for (const entry of Object.values(archive.files)) {
    const normalizedName = entry.name.replace(/\\/g, '/')
    const target = resolve(destination, normalizedName)
    if (target !== destinationRoot && !target.startsWith(`${destinationRoot}\\`)) {
      throw new Error(`Python 压缩包包含非法路径：${entry.name}`)
    }
    if (entry.dir) {
      await fs.promises.mkdir(target, { recursive: true })
      continue
    }
    await fs.promises.mkdir(dirname(target), { recursive: true })
    await fs.promises.writeFile(target, await entry.async('nodebuffer'))
  }
}

async function configureEmbeddedPython(pythonDir: string): Promise<void> {
  const pthName = (await fs.promises.readdir(pythonDir)).find(name => /^python\d+\._pth$/i.test(name))
  if (!pthName) throw new Error('便携 Python 缺少 ._pth 配置文件')
  const pthPath = join(pythonDir, pthName)
  const current = await fs.promises.readFile(pthPath, 'utf8')
  const configured = current
    .replace(/^#import site$/m, 'import site')
    .replace(/^import site$/m, 'Lib\\site-packages\nimport site')
  await fs.promises.mkdir(join(pythonDir, 'Lib', 'site-packages'), { recursive: true })
  await fs.promises.writeFile(pthPath, configured, 'utf8')
}

async function writeConverterScript(info: OfficeRuntimeInfo): Promise<void> {
  await fs.promises.mkdir(dirname(info.converterScriptPath), { recursive: true })
  await fs.promises.writeFile(
    info.converterScriptPath,
    [
      'import sys',
      'import math',
      'import json',
      'import fitz',
      'from pdf2docx import Converter',
      'from docx import Document',
      'from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT',
      'from docx.oxml import OxmlElement',
      'from docx.oxml.ns import qn',
      'from docx.oxml import parse_xml',
      'from xml.sax.saxutils import escape',
      '',
      "VML_NAMESPACES = 'xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:v=\"urn:schemas-microsoft-com:vml\" xmlns:o=\"urn:schemas-microsoft-com:office:office\"'",
      '',
      'def ruled_table_count(pdf_path, selected_pages):',
      '    document = fitz.open(pdf_path)',
      '    try:',
      '        return sum(len(document[index].find_tables().tables) for index in selected_pages)',
      '    finally:',
      '        document.close()',
      '',
      'def apply_table_borders(table):',
      '    table.autofit = False',
      '    table_properties = table._tbl.tblPr',
      "    borders = table_properties.first_child_found_in('w:tblBorders')",
      '    if borders is None:',
      "        borders = OxmlElement('w:tblBorders')",
      '        table_properties.append(borders)',
      "    for edge in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):",
      "        tag = 'w:' + edge",
      '        element = borders.find(qn(tag))',
      '        if element is None:',
      '            element = OxmlElement(tag)',
      '            borders.append(element)',
      "        element.set(qn('w:val'), 'single')",
      "        element.set(qn('w:sz'), '6')",
      "        element.set(qn('w:space'), '0')",
      "        element.set(qn('w:color'), '000000')",
      '    for row in table.rows:',
      '        for cell in row.cells:',
      '            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER',
      '',
      'def dominant_watermark(pdf_path, selected_pages):',
      '    document = fitz.open(pdf_path)',
      '    grouped = {}',
      '    try:',
      '        for selected_index, page_index in enumerate(selected_pages):',
      '            page = document[page_index]',
      "            content = page.get_text('dict')",
      "            for block in content.get('blocks', []):",
      "                for line in block.get('lines', []):",
      "                    direction = line.get('dir', (1.0, 0.0))",
      '                    if abs(float(direction[1])) <= 0.08:',
      '                        continue',
      "                    spans = [span for span in line.get('spans', []) if str(span.get('text', '')).strip()]",
      '                    if not spans:',
      '                        continue',
      "                    text = ''.join(str(span.get('text', '')) for span in spans).strip()",
      '                    if not text:',
      '                        continue',
      '                    angle = math.degrees(math.atan2(float(direction[1]), float(direction[0])))',
      "                    sizes = [float(span.get('size', 12)) for span in spans]",
      "                    bbox = line.get('bbox') or spans[0].get('bbox')",
      '                    if not bbox:',
      '                        continue',
      '                    key = (text, round(angle, 1), round(max(sizes) if sizes else 12, 1))',
      "                    item = grouped.setdefault(key, {'count': 0, 'positions': [], 'pageWidth': float(page.rect.width), 'pageHeight': float(page.rect.height)})",
      "                    item['count'] += 1",
      '                    if selected_index == 0:',
      "                        item['positions'].append([float(value) for value in bbox])",
      '    finally:',
      '        document.close()',
      '    candidates = [(key, value) for key, value in grouped.items() if value[\'count\'] >= 2]',
      '    if not candidates:',
      '        return None',
      "    key, value = max(candidates, key=lambda item: item[1]['count'])",
      '    return {',
      "        'text': key[0],",
      "        'angle': key[1],",
      "        'fontSize': key[2],",
      "        'count': value['count'],",
      "        'positions': value['positions'],",
      "        'pageWidth': value['pageWidth'],",
      "        'pageHeight': value['pageHeight'],",
      '    }',
      '',
      'def watermark_shape_xml(watermark, position, shape_id, include_shape_type=False):',
      '    x0, y0, x1, y1 = position',
      "    text = escape(watermark['text'], {'\"': '&quot;'})",
      "    angle = float(watermark['angle'])",
      "    font_size = max(10.0, min(42.0, float(watermark['fontSize'])))",
      '    width = max(90.0, min(320.0, max(x1 - x0, len(watermark[\'text\']) * font_size * 0.9)))',
      '    height = max(24.0, min(80.0, font_size * 1.8))',
      '    style = (',
      "        f'position:absolute;margin-left:{x0:.2f}pt;margin-top:{y0:.2f}pt;'",
      "        f'width:{width:.2f}pt;height:{height:.2f}pt;rotation:{angle:.1f};'",
      "        'z-index:-251654144;mso-position-horizontal-relative:page;'",
      "        'mso-position-vertical-relative:page;mso-wrap-edited:f'",
      '    )',
      "    shape_type = '''<v:shapetype id=\"_x0000_t136\" coordsize=\"1600,21600\" o:spt=\"136\" adj=\"10800\"",
      "      path=\"m@7,l@8,m@5,21600l@6,21600e\">",
      "      <v:formulas>",
      "        <v:f eqn=\"sum #0 0 10800\"/><v:f eqn=\"prod #0 2 1\"/>",
      "        <v:f eqn=\"sum 21600 0 @1\"/><v:f eqn=\"sum 0 0 @2\"/>",
      "        <v:f eqn=\"sum 21600 0 @3\"/><v:f eqn=\"if @0 @3 0\"/>",
      "        <v:f eqn=\"if @0 21600 @1\"/><v:f eqn=\"if @0 0 @2\"/>",
      "        <v:f eqn=\"if @0 @4 21600\"/><v:f eqn=\"mid @5 @6\"/>",
      "        <v:f eqn=\"mid @8 @5\"/><v:f eqn=\"mid @7 @8\"/>",
      "        <v:f eqn=\"mid @6 @7\"/><v:f eqn=\"sum @6 0 @5\"/>",
      "      </v:formulas>",
      "      <v:path textpathok=\"t\" o:connecttype=\"custom\"",
      "        o:connectlocs=\"@9,0;@10,10800;@11,21600;@12,10800\" o:connectangles=\"270,180,90,0\"/>",
      "      <v:textpath on=\"t\" fitshape=\"t\"/>",
      "      <v:handles><v:h position=\"#0,bottomRight\" xrange=\"6629,14971\"/></v:handles>",
      "      <o:lock v:ext=\"edit\" text=\"t\" shapetype=\"t\"/>",
      "    </v:shapetype>''' if include_shape_type else ''",
      "    return f'''<w:pict {VML_NAMESPACES}>",
      "      {shape_type}",
      "      <v:shape id=\"AgentPetWatermark{shape_id}\" o:spid=\"_x0000_s{shape_id}\"",
      "        type=\"#_x0000_t136\" style=\"{style}\" fillcolor=\"#E8E8E8\" stroked=\"f\" o:allowincell=\"f\">",
      "        <v:textpath style=\"font-family:'Microsoft YaHei';font-size:{font_size:.1f}pt\" string=\"{text}\"/>",
      "      </v:shape>",
      "    </w:pict>'''",
      '',
      'def apply_word_watermark(document, watermark):',
      '    if not watermark:',
      '        return',
      "    positions = watermark.get('positions') or []",
      '    if not positions:',
      '        return',
      '    processed_parts = set()',
      '    for section in document.sections:',
      '        header = section.header',
      '        part_name = str(header.part.partname)',
      '        if part_name in processed_parts:',
      '            continue',
      '        processed_parts.add(part_name)',
      '        paragraph = header.paragraphs[0] if header.paragraphs else header.add_paragraph()',
      '        run = paragraph.add_run()',
      '        for index, position in enumerate(positions, start=1):',
      '            run._r.append(parse_xml(watermark_shape_xml(watermark, position, 2000 + index, index == 1)))',
      '',
      'source_path = sys.argv[1]',
      'output_path = sys.argv[2]',
      'selected_pages = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None',
      'if selected_pages is None:',
      '    source_document = fitz.open(source_path)',
      '    try:',
      '        selected_pages = list(range(source_document.page_count))',
      '    finally:',
      '        source_document.close()',
      'source_table_count = ruled_table_count(source_path, selected_pages)',
      'source_watermark = dominant_watermark(source_path, selected_pages)',
      'converter = Converter(source_path)',
      'try:',
      '    converter.convert(output_path, pages=selected_pages, multi_processing=False)',
      'finally:',
      '    converter.close()',
      'if source_table_count > 0 or source_watermark:',
      '    document = Document(output_path)',
      '    if source_table_count > 0:',
      '        for table in document.tables:',
      '            apply_table_borders(table)',
      '    apply_word_watermark(document, source_watermark)',
      '    document.save(output_path)',
      ''
    ].join('\n'),
    'utf8'
  )
}

async function writeTableExtractorScript(info: OfficeRuntimeInfo): Promise<void> {
  await fs.promises.mkdir(dirname(info.tableExtractorScriptPath), { recursive: true })
  await fs.promises.writeFile(
    info.tableExtractorScriptPath,
    [
      'import json',
      'import math',
      'import sys',
      'import fitz',
      '',
      'def close(a, b, tolerance=1.5):',
      '    return abs(float(a) - float(b)) <= tolerance',
      '',
      'def unique_sorted(values):',
      '    result = []',
      '    for value in sorted(float(item) for item in values):',
      '        if not result or not close(result[-1], value):',
      '            result.append(value)',
      '    return result',
      '',
      'def boundary_index(boundaries, value):',
      '    return min(range(len(boundaries)), key=lambda index: abs(boundaries[index] - float(value)))',
      '',
      'def horizontal_text(page, bbox):',
      '    rect = fitz.Rect(bbox)',
      '    rect.x0 += 0.8',
      '    rect.y0 += 0.8',
      '    rect.x1 -= 0.8',
      '    rect.y1 -= 0.8',
      "    content = page.get_text('dict', clip=rect)",
      '    lines = []',
      "    for block in content.get('blocks', []):",
      "        for line in block.get('lines', []):",
      "            direction = line.get('dir', (1.0, 0.0))",
      '            if abs(float(direction[0]) - 1.0) > 0.08 or abs(float(direction[1])) > 0.08:',
      '                continue',
      "            spans = [span for span in line.get('spans', []) if str(span.get('text', '')).strip()]",
      '            if not spans:',
      '                continue',
      "            spans.sort(key=lambda span: float(span.get('bbox', (0, 0, 0, 0))[0]))",
      "            text = ''.join(str(span.get('text', '')) for span in spans).strip()",
      '            if text:',
      "                y = min(float(span.get('bbox', (0, 0, 0, 0))[1]) for span in spans)",
      "                x = min(float(span.get('bbox', (0, 0, 0, 0))[0]) for span in spans)",
      '                lines.append((y, x, text))',
      '    lines.sort(key=lambda item: (item[0], item[1]))',
      "    return '\\n'.join(item[2] for item in lines)",
      '',
      'def page_watermarks(page):',
      "    content = page.get_text('dict')",
      '    grouped = {}',
      "    for block in content.get('blocks', []):",
      "        for line in block.get('lines', []):",
      "            direction = line.get('dir', (1.0, 0.0))",
      '            if abs(float(direction[1])) <= 0.08:',
      '                continue',
      "            text = ''.join(str(span.get('text', '')) for span in line.get('spans', [])).strip()",
      '            if not text:',
      '                continue',
      "            sizes = [float(span.get('size', 12)) for span in line.get('spans', [])]",
      '            angle = math.degrees(math.atan2(float(direction[1]), float(direction[0])))',
      '            key = (text, round(angle, 1), round(max(sizes) if sizes else 12, 1))',
      '            grouped[key] = grouped.get(key, 0) + 1',
      '    return [',
      "        {'text': key[0], 'angle': key[1], 'fontSize': key[2], 'count': count}",
      '        for key, count in sorted(grouped.items(), key=lambda item: item[1], reverse=True)',
      '    ]',
      '',
      'def extract_table(page, table, table_index):',
      '    row_boxes = [cell for row in table.rows for cell in row.cells if cell is not None]',
      '    x_boundaries = unique_sorted([value for cell in row_boxes for value in (cell[0], cell[2])])',
      '    y_boundaries = unique_sorted([value for cell in row_boxes for value in (cell[1], cell[3])])',
      '    cells = []',
      '    seen = set()',
      '    for row in table.rows:',
      '        for cell in row.cells:',
      '            if cell is None:',
      '                continue',
      '            key = tuple(round(float(value), 2) for value in cell)',
      '            if key in seen:',
      '                continue',
      '            seen.add(key)',
      '            start_col = boundary_index(x_boundaries, cell[0])',
      '            end_col = boundary_index(x_boundaries, cell[2])',
      '            start_row = boundary_index(y_boundaries, cell[1])',
      '            end_row = boundary_index(y_boundaries, cell[3])',
      '            cells.append({',
      "                'row': start_row,",
      "                'col': start_col,",
      "                'rowSpan': max(1, end_row - start_row),",
      "                'colSpan': max(1, end_col - start_col),",
      "                'text': horizontal_text(page, cell),",
      "                'bbox': [float(value) for value in cell],",
      '            })',
      '    return {',
      "        'index': table_index,",
      "        'bbox': [float(value) for value in table.bbox],",
      "        'rowCount': max(1, len(y_boundaries) - 1),",
      "        'colCount': max(1, len(x_boundaries) - 1),",
      "        'columnWidths': [x_boundaries[index + 1] - x_boundaries[index] for index in range(len(x_boundaries) - 1)],",
      "        'rowHeights': [y_boundaries[index + 1] - y_boundaries[index] for index in range(len(y_boundaries) - 1)],",
      "        'cells': cells,",
      '    }',
      '',
      'source_path = sys.argv[1]',
      'output_path = sys.argv[2]',
      'selected_pages = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None',
      'document = fitz.open(source_path)',
      'result = {"pages": [], "tables": []}',
      'try:',
      '    if selected_pages is None:',
      '        selected_pages = list(range(document.page_count))',
      '    for page_index in selected_pages:',
      '        page = document[page_index]',
      '        page_tables = page.find_tables().tables',
      '        extracted_tables = []',
      '        for table_index, table in enumerate(page_tables):',
      '            extracted = extract_table(page, table, table_index + 1)',
      "            extracted['page'] = page_index + 1",
      '            extracted_tables.append(extracted)',
      '            result["tables"].append(extracted)',
      '        result["pages"].append({',
      '            "page": page_index + 1,',
      '            "width": float(page.rect.width),',
      '            "height": float(page.rect.height),',
      '            "tableCount": len(extracted_tables),',
      '            "text": horizontal_text(page, page.rect),',
      '            "watermarks": page_watermarks(page),',
      '        })',
      'finally:',
      '    document.close()',
      "with open(output_path, 'w', encoding='utf-8') as output_file:",
      '    json.dump(result, output_file, ensure_ascii=False, indent=2)',
      ''
    ].join('\n'),
    'utf8'
  )
}

async function writeOfficeRuntimeScripts(info: OfficeRuntimeInfo): Promise<void> {
  await Promise.all([writeConverterScript(info), writeTableExtractorScript(info)])
}

async function validateRuntime(info: OfficeRuntimeInfo): Promise<boolean> {
  if (
    !fs.existsSync(info.pythonPath) ||
    !fs.existsSync(info.converterScriptPath) ||
    !fs.existsSync(info.tableExtractorScriptPath)
  ) return false
  try {
    await runProcess(
      info.pythonPath,
      [
        '-c',
        `import pdf2docx, fitz, docx; from importlib.metadata import version; assert version('pdf2docx') == '${PDF2DOCX_VERSION}'`
      ],
      { cwd: info.rootDir, timeoutMs: 30_000 }
    )
    return true
  } catch {
    return false
  }
}

class OfficeRuntimeManager {
  private pending = new Map<number, PendingRequest>()
  private nextRequestId = 1
  private installPromise: Promise<OfficeRuntimeInfo> | null = null

  constructor() {
    ipcMain.on('api:office-runtime-response', (_event, data) => {
      const requestId = Number(data?.requestId)
      const pending = this.pending.get(requestId)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(requestId)
      pending.resolve(Boolean(data?.approved))
    })
  }

  public async ensure(
    context: { sessionId?: string; messageId?: number; event?: { sender: WebContents }; abortSignal?: AbortSignal }
  ): Promise<OfficeRuntimeInfo> {
    if (process.platform !== 'win32' || process.arch !== 'x64') {
      throw new Error('当前 Office 组件包安装器暂仅支持 Windows x64')
    }
    const info = runtimeInfo()
    if (fs.existsSync(info.pythonPath)) {
      await writeOfficeRuntimeScripts(info)
      if (await validateRuntime(info)) return info
    }

    const target = context.event?.sender
      ? BrowserWindow.fromWebContents(context.event.sender)
      : BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    if (!target || target.isDestroyed()) throw new Error('无法显示 Office 组件包安装卡片')

    const requestId = this.nextRequestId++
    const approved = await new Promise<boolean>(resolvePromise => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolvePromise(false)
      }, 10 * 60 * 1000)
      this.pending.set(requestId, { resolve: resolvePromise, timer, sessionId: context.sessionId })
      target.webContents.send('api:llm-tool-event', {
        type: 'office_runtime_request',
        requestId,
        request: {
          title: '安装 Office 组件包',
          description:
            '用于增强 Office 文档转换与排版能力。组件安装在 AgentPet 独立目录中，不修改系统环境，不需要管理员权限。',
          downloadSize: '预计下载 120–180 MB，安装后约占用 350–500 MB',
          installPath: info.rootDir
        },
        timestamp: Date.now(),
        messageId: context.messageId,
        sessionId: context.sessionId
      })
    })
    if (!approved) throw new Error('OFFICE_RUNTIME_INSTALL_CANCELLED: 用户取消了 Office 组件包安装')

    const eventContext: InstallEventContext = {
      requestId,
      sessionId: context.sessionId,
      messageId: context.messageId,
      target
    }
    if (!this.installPromise) {
      this.installPromise = this.install(info, eventContext, context.abortSignal).finally(() => {
        this.installPromise = null
      })
    }
    return await this.installPromise
  }

  public cancelPending(sessionId?: string): void {
    for (const [requestId, pending] of this.pending.entries()) {
      if (sessionId && pending.sessionId !== sessionId) continue
      clearTimeout(pending.timer)
      this.pending.delete(requestId)
      pending.resolve(false)
    }
  }

  private async install(
    info: OfficeRuntimeInfo,
    eventContext: InstallEventContext,
    signal?: AbortSignal
  ): Promise<OfficeRuntimeInfo> {
    const pythonDir = dirname(info.pythonPath)
    try {
      sendInstallEvent(eventContext, 'office_runtime_progress', '正在准备安装目录', 3)
      await fs.promises.mkdir(dirname(info.rootDir), { recursive: true })
      if (fs.existsSync(info.rootDir)) await fs.promises.rm(info.rootDir, { recursive: true, force: true })
      await fs.promises.mkdir(pythonDir, { recursive: true })

      sendInstallEvent(eventContext, 'office_runtime_progress', '正在下载 Office 运行组件', 8)
      const pythonArchive = await downloadBuffer(PYTHON_EMBED_URL, signal, ratio => {
        sendInstallEvent(
          eventContext,
          'office_runtime_progress',
          `正在下载 Office 运行组件（${Math.round(ratio * 100)}%）`,
          8 + ratio * 20
        )
      })
      sendInstallEvent(eventContext, 'office_runtime_progress', '正在配置 Office 运行环境', 30)
      await extractPythonArchive(pythonArchive, pythonDir)
      await configureEmbeddedPython(pythonDir)

      sendInstallEvent(eventContext, 'office_runtime_progress', '正在准备组件安装服务', 38)
      const getPipPath = join(info.rootDir, 'get-pip.py')
      await fs.promises.writeFile(getPipPath, await downloadBuffer(GET_PIP_URL, signal, () => undefined))
      await runProcess(info.pythonPath, [getPipPath, 'pip==24.3.1'], {
        cwd: info.rootDir,
        signal
      })

      sendInstallEvent(eventContext, 'office_runtime_progress', '正在安装 Office 文档转换组件', 55)
      await runProcess(
        info.pythonPath,
        [
          '-m',
          'pip',
          'install',
          '--only-binary=:all:',
          ...OFFICE_PYTHON_PACKAGES
        ],
        { cwd: info.rootDir, signal }
      )
      sendInstallEvent(eventContext, 'office_runtime_progress', '正在完成 Office 组件配置', 90)
      await writeOfficeRuntimeScripts(info)
      await fs.promises.writeFile(
        join(info.rootDir, 'manifest.json'),
        JSON.stringify(
          {
            schemaVersion: RUNTIME_SCHEMA_VERSION,
            pythonVersion: PYTHON_VERSION,
            packages: Object.fromEntries(
              OFFICE_PYTHON_PACKAGES.map(specification => specification.split('=='))
            ),
            installedAt: new Date().toISOString()
          },
          null,
          2
        ),
        'utf8'
      )
      if (!(await validateRuntime(info))) throw new Error('Office 组件包安装后验证失败')
      await fs.promises.rm(join(info.rootDir, 'get-pip.py'), { force: true })
      sendInstallEvent(eventContext, 'office_runtime_complete', 'Office 组件包安装完成，正在继续转换', 100)
      return info
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[OfficeRuntime] Office 组件包安装失败：', message)
      sendInstallEvent(
        eventContext,
        'office_runtime_error',
        'Office 组件包安装失败，请检查网络连接后重新转换',
        100
      )
      throw new Error('Office 组件包安装失败，请检查网络连接后重新转换')
    }
  }
}

export const officeRuntimeManager = new OfficeRuntimeManager()
