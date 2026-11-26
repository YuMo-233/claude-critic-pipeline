#!/usr/bin/env node
/**
 * critic-evidence MCP server（零依赖，stdio JSON-RPC）
 *
 * 用途：给挑刺流水线当"资料室管理员"。
 *   - prepare_evidence：跑模拟/检查命令、读配置与代码，产出一份扁平证据包落盘，只回索引
 *   - get_evidence_slice：镜头按关键词取自己那份切片
 *   - code_query：窄口只读检索（grep / 读区间 / 列目录）
 *   - verify_anchors：批量机械核对「文件:行号:数值」类锚点
 *   - run_task：只跑调用方显式给定的命令
 *
 * 一律只读项目，唯一的写操作是证据包落盘（<projectPath>/.critic/evidence/）。
 * 命令只从调用方入参来，不猜、不重试。
 */

import { createInterface } from 'node:readline'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { exec } from 'node:child_process'

const SERVER_NAME = 'critic-evidence'
const SERVER_VERSION = '1.0.0'
const PROTOCOL_VERSION = '2024-11-05'

const MAX_OUTPUT_CHARS = 20000 // 单次工具返回上限
const MAX_FILE_LINES = 400 // 单文件读取上限
const MAX_COMMAND_CHARS = 2000000 // 命令输出落盘上限
const DEFAULT_TIMEOUT_MS = 120000
const SKIP_DIRS = new Set(['node_modules', '.git', '.gradle', '.idea', 'build', 'dist', 'out', '.critic', '__pycache__', '.venv', 'target', '.next'])

// ---------------------------------------------------------------- 小工具

function clip(s, n) {
  const t = String(s ?? '')
  if (t.length <= n) return t
  return t.slice(0, n) + `\n…（已截断，原文 ${t.length} 字符）`
}

function ok(text, extra) {
  return { content: [{ type: 'text', text: String(text) }], ...(extra || {}) }
}

function fail(text) {
  return { content: [{ type: 'text', text: String(text) }], isError: true }
}

function toJsonText(v) {
  return JSON.stringify(v, null, 2)
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true })
}

async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

function isBinary(buf) {
  const len = Math.min(buf.length, 4096)
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true
  return false
}

async function readTextFile(absPath) {
  const buf = await fs.readFile(absPath)
  if (isBinary(buf)) return null
  return buf.toString('utf8')
}

/** 把任意 JSON 里的数值拍平成 "路径 = 值" 行 */
function flattenNumbers(obj, prefix, out, depth) {
  if (out.length >= 800 || depth > 6) return
  if (typeof obj === 'number' && Number.isFinite(obj)) {
    out.push(`${prefix} = ${obj}`)
    return
  }
  if (typeof obj === 'string') {
    if (obj.length <= 120) out.push(`${prefix} = "${obj}"`)
    return
  }
  if (typeof obj === 'boolean') {
    out.push(`${prefix} = ${obj}`)
    return
  }
  if (Array.isArray(obj)) {
    if (obj.length <= 12 && obj.every(x => typeof x === 'number')) {
      out.push(`${prefix} = [${obj.join(', ')}]`)
      return
    }
    for (let i = 0; i < Math.min(obj.length, 40); i++) flattenNumbers(obj[i], `${prefix}[${i}]`, out, depth + 1)
    return
  }
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj).slice(0, 80)) flattenNumbers(obj[k], prefix ? `${prefix}.${k}` : k, out, depth + 1)
  }
}

/** 从路径与命令里抽标签（小写、按非字母数字切分） */
function tagsFrom(...sources) {
  const set = new Set()
  for (const s of sources) {
    for (const t of String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (t && t.length >= 2 && t.length <= 24) set.add(t)
    }
  }
  return [...set].slice(0, 40)
}

function runCommand(command, cwd, timeoutMs) {
  return new Promise(resolve => {
    const child = exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: MAX_COMMAND_CHARS, windowsHide: true, shell: true },
      (err, stdout, stderr) => {
        const exitCode = err && typeof err.code === 'number' ? err.code : err ? 1 : 0
        resolve({ exitCode, stdout: String(stdout || ''), stderr: String(stderr || ''), err: err ? String(err.message || err) : null })
      },
    )
    child.on('error', e => resolve({ exitCode: 1, stdout: '', stderr: '', err: String(e.message || e) }))
  })
}

async function walkFiles(root, maxFiles) {
  const out = []
  const stack = [root]
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop()
    let ents = []
    try {
      ents = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      if (out.length >= maxFiles) break
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        stack.push(full)
      } else if (e.isFile()) {
        out.push(full)
      }
    }
  }
  return out
}

// ---------------------------------------------------------------- 工具实现

/**
 * prepare_evidence
 * 入参：
 *   projectPath  必填，项目根
 *   label        可选，证据包名（默认 default），同一 label 覆盖写
 *   run          [{name, command, timeoutMs?}] 要跑的模拟/统计命令
 *   checks       [{name, command}]             要跑的检查脚本
 *   codePaths    [path | {path, note?}]        要读的代码/配置文件（相对 projectPath）
 *   notes        可选，一段说明
 * 产出：<projectPath>/.critic/evidence/<label>/ 下 index.json + entries.jsonl + raw/ 原始输出
 * 返回：紧凑索引（每条 id / 标签 / 来源 / 摘要 / 行数），不返回正文
 */
async function prepareEvidence(args) {
  const projectPath = args?.projectPath
  if (!projectPath) return fail('missing args.projectPath')
  const absRoot = path.resolve(String(projectPath))
  if (!(await exists(absRoot))) return fail(`projectPath not found: ${absRoot}`)

  const label = String(args?.label || 'default').replace(/[^\w.\-]+/g, '_').slice(0, 40) || 'default'
  const dir = path.join(absRoot, '.critic', 'evidence', label)
  const rawDir = path.join(dir, 'raw')
  await ensureDir(rawDir)

  const entries = []
  const commandLog = []
  const warnings = []
  let seq = 0
  const nextId = () => `E${++seq}`

  const runList = Array.isArray(args?.run) ? args.run : []
  const checkList = Array.isArray(args?.checks) ? args.checks : []
  const codePaths = (Array.isArray(args?.codePaths) ? args.codePaths : []).map(x =>
    typeof x === 'string' ? { path: x } : x || {},
  ).filter(x => x.path)

  // 1) 命令类证据
  const allCommands = [
    ...runList.map(c => ({ ...c, kind: 'run' })),
    ...checkList.map(c => ({ ...c, kind: 'check' })),
  ]
  for (let i = 0; i < allCommands.length; i++) {
    const c = allCommands[i]
    if (!c.command) {
      warnings.push(`command[${i}] 缺 command 字段，跳过`)
      continue
    }
    const name = String(c.name || `${c.kind}-${i + 1}`)
    const timeoutMs = Number(c.timeoutMs) > 0 ? Number(c.timeoutMs) : DEFAULT_TIMEOUT_MS
    const res = await runCommand(String(c.command), absRoot, timeoutMs)
    const combined = [res.stdout, res.stderr].filter(Boolean).join('\n')
    const rawFile = path.join(rawDir, `${name.replace(/[^\w.\-]+/g, '_')}.txt`)
    await fs.writeFile(rawFile, combined, 'utf8')
    commandLog.push({ name, kind: c.kind, command: String(c.command), exitCode: res.exitCode, chars: combined.length, rawFile })

    const bodyEntries = []
    // 命令输出是 JSON → 拍平成指标行
    let parsed = null
    const trimmed = res.stdout.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        parsed = null
      }
    }
    if (parsed !== null) {
      const flat = []
      flattenNumbers(parsed, '', flat, 0)
      for (const line of flat) {
        bodyEntries.push({
          id: nextId(),
          kind: 'metric',
          source: `${name}（${c.command}）`,
          tags: tagsFrom(name, c.command),
          summary: line,
          lines: [line],
        })
      }
    } else {
      const lines = combined.split(/\r?\n/).filter(l => l.trim())
      if (lines.length) {
        bodyEntries.push({
          id: nextId(),
          kind: 'command-output',
          source: `${name}（${c.command}，exit=${res.exitCode}）`,
          tags: tagsFrom(name, c.command),
          summary: lines.slice(0, 3).join(' / '),
          lines: lines.slice(0, MAX_FILE_LINES),
        })
      }
    }
    if (!bodyEntries.length) {
      bodyEntries.push({
        id: nextId(),
        kind: 'command-empty',
        source: `${name}（${c.command}）`,
        tags: tagsFrom(name, c.command),
        summary: `无输出，exit=${res.exitCode}${res.err ? `，${res.err}` : ''}`,
        lines: [`exit=${res.exitCode}`],
      })
    }
    entries.push(...bodyEntries)
  }

  // 2) 文件类证据
  for (const cp of codePaths) {
    const abs = path.resolve(absRoot, String(cp.path))
    if (!abs.startsWith(absRoot)) {
      warnings.push(`codePaths 越界，跳过：${cp.path}`)
      continue
    }
    if (!(await exists(abs))) {
      warnings.push(`文件不存在，跳过：${cp.path}`)
      continue
    }
    const stat = await fs.stat(abs)
    if (!stat.isFile()) {
      warnings.push(`不是文件，跳过：${cp.path}`)
      continue
    }
    const text = await readTextFile(abs)
    if (text === null) {
      warnings.push(`二进制文件，跳过：${cp.path}`)
      continue
    }
    const lines = text.split(/\r?\n/)
    const numbered = lines
      .map((l, i) => ({ n: i + 1, l }))
      .filter(x => x.l.trim())
      .slice(0, MAX_FILE_LINES)
    if (!numbered.length) {
      warnings.push(`空文件，跳过：${cp.path}`)
      continue
    }
    entries.push({
      id: nextId(),
      kind: 'file',
      source: `${cp.path}${cp.note ? `（${cp.note}）` : ''}`,
      tags: tagsFrom(cp.path, cp.note),
      summary: numbered.slice(0, 3).map(x => x.l.trim()).join(' / ').slice(0, 300),
      lines: numbered.map(x => `L${x.n}: ${x.l}`),
    })
  }

  // 3) 落盘
  const index = {
    version: 1,
    label,
    projectPath: absRoot,
    createdAt: new Date().toISOString(),
    notes: args?.notes ? String(args.notes).slice(0, 2000) : '',
    commands: commandLog,
    entries: entries.map(e => ({
      id: e.id,
      kind: e.kind,
      source: e.source,
      tags: e.tags,
      summary: e.summary,
      lineCount: e.lines.length,
    })),
    warnings,
  }
  await fs.writeFile(path.join(dir, 'index.json'), toJsonText(index), 'utf8')
  await fs.writeFile(
    path.join(dir, 'entries.jsonl'),
    entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''),
    'utf8',
  )

  // 4) 回紧凑索引
  const table = entries
    .map(e => `${e.id}\t[${e.tags.slice(0, 6).join(',')}]\t${e.source}\t${e.lines.length}行\t${clip(e.summary, 100).replace(/\n/g, ' ')}`)
    .join('\n')
  const text = [
    `证据包已生成：${dir}`,
    `条目 ${entries.length} 条，命令 ${commandLog.length} 条。`,
    warnings.length ? `警告：\n- ${warnings.join('\n- ')}` : '',
    '',
    '索引（id / 标签 / 来源 / 行数 / 摘要）：',
    clip(table, MAX_OUTPUT_CHARS - 2000),
    '',
    '下一步：调 get_evidence_slice({evidenceDir, query}) 取正文，不要整包读回。',
  ]
    .filter(Boolean)
    .join('\n')

  return ok(text, { structuredContent: { evidenceDir: dir, entryCount: entries.length, warnings } })
}

/**
 * get_evidence_slice
 * 入参：evidenceDir（必填）/ query（关键词，逗号或空格分隔）/ ids（指定条目）/ maxLines（默认 400）
 */
async function getEvidenceSlice(args) {
  const evidenceDir = args?.evidenceDir
  if (!evidenceDir) return fail('missing args.evidenceDir')
  const dir = path.resolve(String(evidenceDir))
  const indexPath = path.join(dir, 'index.json')
  const entriesPath = path.join(dir, 'entries.jsonl')
  if (!(await exists(indexPath)) || !(await exists(entriesPath))) {
    return fail(
      `证据包不存在或未生成：${dir}\n请先调 prepare_evidence({projectPath, ...}) 生成，再取切片。`,
    )
  }
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'))
  const entries = (await fs.readFile(entriesPath, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))

  const ids = Array.isArray(args?.ids) ? new Set(args.ids.map(String)) : null
  const terms = String(args?.query || '')
    .toLowerCase()
    .split(/[\s,，、]+/)
    .filter(t => t.length >= 2)
  const maxLines = Number(args?.maxLines) > 0 ? Number(args.maxLines) : 400

  let chosen
  if (ids) {
    chosen = entries.filter(e => ids.has(e.id))
  } else if (terms.length) {
    const scored = entries.map(e => {
      const hay = `${e.id} ${e.source} ${e.tags.join(' ')} ${e.lines.join('\n')}`.toLowerCase()
      let score = 0
      for (const t of terms) {
        if (e.tags.some(tag => tag === t)) score += 5
        else if (e.source.toLowerCase().includes(t)) score += 3
        else if (hay.includes(t)) score += 1
      }
      return { e, score }
    })
    chosen = scored.filter(x => x.score > 0).sort((a, b) => b.score - a.score).map(x => x.e)
    if (!chosen.length) {
      const table = index.entries
        .map(e => `${e.id}\t${e.source}\t${e.tags.slice(0, 6).join(',')}`)
        .join('\n')
      return ok(`没有条目命中关键词「${args?.query}」。可用条目：\n${clip(table, 4000)}`)
    }
  } else {
    chosen = entries
  }

  let used = 0
  const blocks = []
  for (const e of chosen) {
    const lines = e.lines.slice(0, Math.max(1, maxLines - used))
    if (!lines.length) continue
    blocks.push(`### ${e.id} ${e.source}\n标签：${e.tags.join(', ')}\n${lines.join('\n')}`)
    used += lines.length
    if (used >= maxLines) break
  }
  const text = [
    `证据包：${dir}（label=${index.label}）`,
    index.notes ? `说明：${index.notes}` : '',
    '',
    blocks.join('\n\n'),
    used >= maxLines ? `\n…已达 ${maxLines} 行上限，需要更多请用 ids 精确取。` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return ok(clip(text, MAX_OUTPUT_CHARS))
}

/**
 * code_query
 * 入参：projectPath / mode='grep'|'read'|'list'|'symbols'
 *   grep: {pattern, include?, maxResults?, contextLines?}
 *   read: {path, start?, end?}
 *   list: {path?, depth?}
 */
async function codeQuery(args) {
  const projectPath = args?.projectPath
  if (!projectPath) return fail('missing args.projectPath')
  const root = path.resolve(String(projectPath))
  if (!(await exists(root))) return fail(`projectPath not found: ${root}`)
  const mode = String(args?.mode || 'grep')

  if (mode === 'symbols') {
    return fail(
      'code_query 不做符号级检索。需要定义/引用/实现查询时，请在主会话用 serena（LSP）先探明位置，把结论写进 args.changes 或证据包。',
    )
  }

  if (mode === 'read') {
    const rel = String(args?.path || '')
    if (!rel) return fail('missing args.path')
    const abs = path.resolve(root, rel)
    if (!abs.startsWith(root)) return fail('path 越界')
    if (!(await exists(abs))) return fail(`file not found: ${rel}`)
    const text = await readTextFile(abs)
    if (text === null) return fail(`binary file: ${rel}`)
    const lines = text.split(/\r?\n/)
    const start = Math.max(1, Number(args?.start) || 1)
    const end = Math.min(lines.length, Number(args?.end) || start + MAX_FILE_LINES - 1)
    const slice = lines.slice(start - 1, end).map((l, i) => `L${start + i}: ${l}`)
    return ok(`### ${rel}（L${start}-${end}，共 ${lines.length} 行）\n${clip(slice.join('\n'), MAX_OUTPUT_CHARS)}`)
  }

  if (mode === 'list') {
    const rel = String(args?.path || '.')
    const abs = path.resolve(root, rel)
    if (!abs.startsWith(root)) return fail('path 越界')
    if (!(await exists(abs))) return fail(`path not found: ${rel}`)
    const depth = Math.min(4, Math.max(1, Number(args?.depth) || 2))
    const out = []
    async function walk(dir, d, prefix) {
      if (d > depth || out.length > 300) return
      let ents = []
      try {
        ents = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of ents) {
        if (out.length > 300) return
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
        out.push(`${prefix}${e.name}${e.isDirectory() ? '/' : ''}`)
        if (e.isDirectory()) await walk(path.join(dir, e.name), d + 1, `${prefix}${e.name}/`)
      }
    }
    await walk(abs, 1, '')
    return ok(clip(out.join('\n') || '（空目录）', MAX_OUTPUT_CHARS))
  }

  // grep
  const pattern = String(args?.pattern || '')
  if (!pattern) return fail('missing args.pattern')
  let re
  try {
    re = new RegExp(pattern, 'm')
  } catch (e) {
    return fail(`正则无效：${e.message}`)
  }
  const include = args?.include ? String(args.include) : ''
  const incRe = include ? new RegExp('^' + include.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$') : null
  const maxResults = Number(args?.maxResults) > 0 ? Number(args.maxResults) : 60
  const ctxLines = Math.max(0, Math.min(3, Number(args?.contextLines) || 0))

  const files = await walkFiles(root, 4000)
  const hits = []
  for (const f of files) {
    if (hits.length >= maxResults) break
    const rel = path.relative(root, f).split(path.sep).join('/')
    if (incRe && !incRe.test(path.basename(f))) continue
    let text
    try {
      const stat = await fs.stat(f)
      if (stat.size > 2 * 1024 * 1024) continue
      text = await readTextFile(f)
    } catch {
      continue
    }
    if (text === null) continue
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
      if (!re.test(lines[i])) continue
      const s = Math.max(0, i - ctxLines)
      const e = Math.min(lines.length - 1, i + ctxLines)
      const block = []
      for (let k = s; k <= e; k++) block.push(`${rel}:${k + 1}: ${lines[k]}`)
      hits.push(block.join('\n'))
    }
  }
  if (!hits.length) return ok(`无命中：pattern=${pattern}${include ? ` include=${include}` : ''}`)
  return ok(clip(`命中 ${hits.length} 处：\n\n${hits.join('\n')}`, MAX_OUTPUT_CHARS))
}

/**
 * verify_anchors
 * 入参：projectPath / anchors [{path, line?, expectText?, expectNumber?, window?}]
 * 逐条机械核对，回 pass/fail + 实际内容
 */
async function verifyAnchors(args) {
  const projectPath = args?.projectPath
  if (!projectPath) return fail('missing args.projectPath')
  const root = path.resolve(String(projectPath))
  const anchors = Array.isArray(args?.anchors) ? args.anchors : []
  if (!anchors.length) return fail('missing args.anchors')

  const results = []
  let pass = 0
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i] || {}
    const rel = String(a.path || '')
    if (!rel) {
      results.push({ index: i, ok: false, why: '缺 path' })
      continue
    }
    const abs = path.resolve(root, rel)
    if (!abs.startsWith(root)) {
      results.push({ index: i, path: rel, ok: false, why: 'path 越界' })
      continue
    }
    if (!(await exists(abs))) {
      results.push({ index: i, path: rel, ok: false, why: '文件不存在' })
      continue
    }
    const text = await readTextFile(abs)
    if (text === null) {
      results.push({ index: i, path: rel, ok: false, why: '二进制文件' })
      continue
    }
    const lines = text.split(/\r?\n/)
    const window = Math.max(0, Math.min(10, Number(a.window) || 0))
    let lo = 1
    let hi = lines.length
    if (a.line) {
      lo = Math.max(1, Number(a.line) - window)
      hi = Math.min(lines.length, Number(a.line) + window)
    }
    const region = []
    for (let k = lo; k <= hi; k++) region.push({ n: k, l: lines[k - 1] ?? '' })
    const regionText = region.map(x => x.l).join('\n')

    const problems = []
    if (a.expectText && !regionText.includes(String(a.expectText))) problems.push(`未找到文本「${a.expectText}」`)
    if (a.expectNumber !== undefined && a.expectNumber !== null && a.expectNumber !== '') {
      const want = String(a.expectNumber).trim()
      const nums = regionText.match(/-?\d+(?:\.\d+)?/g) || []
      if (!nums.includes(want) && !nums.some(n => Math.abs(Number(n) - Number(want)) < 1e-9)) {
        problems.push(`未找到数值 ${want}（该区域出现：${nums.slice(0, 8).join(', ') || '无'}）`)
      }
    }
    if (!problems.length) {
      pass++
      results.push({ index: i, path: rel, line: a.line, ok: true, expectText: a.expectText, expectNumber: a.expectNumber })
    } else {
      results.push({
        index: i,
        path: rel,
        line: a.line,
        ok: false,
        why: problems.join('；'),
        actual: clip(region.map(x => `L${x.n}: ${x.l}`).join('\n'), 600),
      })
    }
  }

  const failed = results.filter(r => !r.ok)
  const summary = `锚点核对：${anchors.length} 条，通过 ${pass}，失败 ${failed.length}。`
  const detail = failed.length
    ? failed
        .map(f => `✗ [${f.index}] ${f.path}${f.line ? `:${f.line}` : ''} — ${f.why}\n${f.actual || ''}`)
        .join('\n\n')
    : '全部通过。可按下述抽样规则处理：抽 10% 复核即可，不必逐条读原文。'
  return ok(clip(`${summary}\n\n${detail}`, MAX_OUTPUT_CHARS), {
    structuredContent: { total: anchors.length, pass, fail: failed.length, failed: failed.map(f => f.index) },
  })
}

/**
 * run_task
 * 入参：projectPath / command（必填）/ timeoutMs? / name?
 */
async function runTask(args) {
  const projectPath = args?.projectPath
  if (!projectPath) return fail('missing args.projectPath')
  const root = path.resolve(String(projectPath))
  if (!(await exists(root))) return fail(`projectPath not found: ${root}`)
  const command = String(args?.command || '')
  if (!command) return fail('missing args.command')
  const timeoutMs = Number(args?.timeoutMs) > 0 ? Number(args.timeoutMs) : DEFAULT_TIMEOUT_MS
  const res = await runCommand(command, root, timeoutMs)
  const text = [
    `命令：${command}`,
    `退出码：${res.exitCode}${res.err ? `（${res.err}）` : ''}`,
    res.stdout.trim() ? `--- stdout ---\n${clip(res.stdout, MAX_OUTPUT_CHARS / 2)}` : '',
    res.stderr.trim() ? `--- stderr ---\n${clip(res.stderr, MAX_OUTPUT_CHARS / 2)}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return ok(text, { structuredContent: { exitCode: res.exitCode } })
}

// ---------------------------------------------------------------- 工具注册

const TOOLS = [
  {
    name: 'prepare_evidence',
    description:
      '生成扁平证据包：按调用方给的命令与文件清单跑一遍，产出 .critic/evidence/<label>/（index.json + entries.jsonl + raw/），只返回索引表（id/标签/来源/行数/摘要），不返回正文。挑刺 workflow 开跑前由调度员调用一次。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: '项目根目录绝对路径' },
        label: { type: 'string', description: '证据包名，默认 default；同一 label 覆盖写' },
        run: {
          type: 'array',
          description: '要跑的模拟/统计命令；输出为 JSON 时自动拍平成逐条指标',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, command: { type: 'string' }, timeoutMs: { type: 'number' } },
            required: ['command'],
          },
        },
        checks: {
          type: 'array',
          description: '要跑的检查脚本',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, command: { type: 'string' }, timeoutMs: { type: 'number' } },
            required: ['command'],
          },
        },
        codePaths: {
          type: 'array',
          description: '要读进来的代码/配置文件（相对 projectPath）',
          items: { type: 'string' },
        },
        notes: { type: 'string', description: '给镜头看的说明（口径、已知偏差）' },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'get_evidence_slice',
    description:
      '按关键词或条目 id 取证据包切片，返回紧凑文本。镜头只取自己维度那一份，不要整包读回。',
    inputSchema: {
      type: 'object',
      properties: {
        evidenceDir: { type: 'string', description: 'prepare_evidence 返回的证据包目录' },
        query: { type: 'string', description: '关键词，空格/逗号分隔，按标签与来源加权匹配' },
        ids: { type: 'array', items: { type: 'string' }, description: '直接指定条目 id' },
        maxLines: { type: 'number', description: '返回行数上限，默认 400' },
      },
      required: ['evidenceDir'],
    },
  },
  {
    name: 'code_query',
    description:
      '窄口只读检索：mode=grep（正则+文件名通配+上下文行）/ read（读文件指定行区间）/ list（列目录）。不做符号级查询（那交给主会话的 serena）。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
        mode: { type: 'string', enum: ['grep', 'read', 'list', 'symbols'], description: '默认 grep' },
        pattern: { type: 'string', description: 'grep 模式：JS 正则' },
        include: { type: 'string', description: 'grep 文件名通配，如 *.js' },
        maxResults: { type: 'number', description: 'grep 命中上限，默认 60' },
        contextLines: { type: 'number', description: 'grep 上下文行数 0-3' },
        path: { type: 'string', description: 'read/list 的相对路径' },
        start: { type: 'number', description: 'read 起始行（1 基）' },
        end: { type: 'number', description: 'read 结束行' },
        depth: { type: 'number', description: 'list 递归深度 1-4' },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'verify_anchors',
    description:
      '批量机械核对锚点：文件在不在、指定行（±window）有没有那段文本/那个数值，逐条回 pass/fail 与实际内容。细节评委与判卷先用它把假锚点筛掉，只对失败项逐条深看。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
        anchors: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '相对 projectPath' },
              line: { type: 'number', description: '锚点行号（1 基）' },
              window: { type: 'number', description: '行号浮动范围，默认 0' },
              expectText: { type: 'string', description: '该区域应出现的文本片段' },
              expectNumber: { type: ['number', 'string'], description: '该区域应出现的数值' },
            },
            required: ['path'],
          },
        },
      },
      required: ['projectPath', 'anchors'],
    },
  },
  {
    name: 'run_task',
    description: '跑一条调用方显式给定的命令（带超时），回退出码 + stdout/stderr。复检轮重跑上轮模拟用。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
        command: { type: 'string' },
        timeoutMs: { type: 'number' },
        name: { type: 'string' },
      },
      required: ['projectPath', 'command'],
    },
  },
]

const HANDLERS = {
  prepare_evidence: prepareEvidence,
  get_evidence_slice: getEvidenceSlice,
  code_query: codeQuery,
  verify_anchors: verifyAnchors,
  run_task: runTask,
}

// ---------------------------------------------------------------- JSON-RPC 主循环

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

async function handle(msg) {
  const { id, method, params } = msg || {}
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    }
  }
  if (method === 'notifications/initialized' || method === 'initialized') return null
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
  if (method === 'tools/call') {
    const name = params?.name
    const fn = HANDLERS[name]
    if (!fn) {
      return { jsonrpc: '2.0', id, result: fail(`unknown tool: ${name}`) }
    }
    try {
      const res = await fn(params?.arguments || {})
      return { jsonrpc: '2.0', id, result: res }
    } catch (e) {
      return { jsonrpc: '2.0', id, result: fail(`工具执行出错：${e && e.message ? e.message : String(e)}`) }
    }
  }
  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } }
  if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } }
  if (typeof method === 'string' && method.startsWith('notifications/')) return null
  if (id !== undefined && id !== null) {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
  }
  return null
}

let chain = Promise.resolve()
rl.on('line', line => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }
  chain = chain.then(async () => {
    const out = await handle(msg)
    if (out) process.stdout.write(JSON.stringify(out) + '\n')
  }).catch(() => {})
})

rl.on('close', () => process.exit(0))