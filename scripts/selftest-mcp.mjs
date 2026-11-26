#!/usr/bin/env node
/**
 * critic-evidence MCP server 自测（零依赖）。
 *
 * 造一个临时玩具项目（数值配置 + 统计脚本 + 一个小源文件），
 * 用 stdio JSON-RPC 挨个调五个工具，逐条断言。
 *
 * 用法：node scripts/selftest-mcp.mjs
 * 退出码 0 = 全过；1 = 有失败。
 */

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverPath = path.join(here, '..', 'mcp', 'evidence-server.mjs')

let failures = 0
function check(name, cond, extra) {
  if (cond) {
    console.log(`[ok] ${name}`)
  } else {
    failures++
    console.log(`[FAIL] ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'critic-ev-'))
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true })

  await fs.writeFile(
    path.join(root, 'src', 'config.js'),
    [
      'export const CONFIG = {',
      '  bossHp: 8,',
      '  pulseDamage: 2,',
      '  resonanceCap: 100,',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  await fs.writeFile(
    path.join(root, 'scripts', 'metrics.js'),
    [
      'const cfg = { bossHp: 8, pulseDamage: 2, resonanceCap: 100 }',
      'console.log(JSON.stringify({',
      '  pulsesToKill: Math.ceil(cfg.bossHp / cfg.pulseDamage),',
      '  regions: 16,',
      '  telegraphs: 0,',
      '}))',
      '',
    ].join('\n'),
    'utf8',
  )
  await fs.writeFile(
    path.join(root, 'src', 'world.js'),
    [
      'export function damage(b, amount, gear) {',
      '  b.hp = Math.max(0, b.hp - amount * (1 + (gear.bossDamage || 0)))',
      '  return b.hp',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  await fs.writeFile(path.join(root, 'scripts', 'rules.js'), 'console.log("rules ok")\n', 'utf8')
  await fs.writeFile(path.join(root, 'scripts', 'failing.js'), 'console.error("boom")\nprocess.exit(2)\n', 'utf8')
  return root
}

function makeClient() {
  const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  let nextId = 1
  const pending = new Map()

  child.stdout.on('data', chunk => {
    buf += chunk.toString('utf8')
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    }
  })
  child.stderr.on('data', () => {})

  function send(method, params, isNotification) {
    const id = isNotification ? undefined : nextId++
    const payload = { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }
    if (!isNotification) payload.id = id
    child.stdin.write(JSON.stringify(payload) + '\n')
    if (isNotification) return Promise.resolve(null)
    return new Promise(resolve => pending.set(id, resolve))
  }

  async function call(name, args) {
    const res = await send('tools/call', { name, arguments: args })
    if (res?.error) return { isError: true, text: res.error.message }
    const r = res?.result || {}
    return { isError: !!r.isError, text: (r.content || []).map(c => c.text).join('\n'), structured: r.structuredContent }
  }

  return { child, send, call }
}

async function main() {
  const root = await makeFixture()
  const client = makeClient()
  try {
    const init = await client.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'selftest', version: '0' },
    })
    check('initialize 握手', init?.result?.serverInfo?.name === 'critic-evidence', JSON.stringify(init?.result?.serverInfo))

    const list = await client.send('tools/list', {})
    const names = (list?.result?.tools || []).map(t => t.name).sort()
    check(
      'tools/list 五个工具齐',
      JSON.stringify(names) === JSON.stringify(['code_query', 'get_evidence_slice', 'prepare_evidence', 'run_task', 'verify_anchors']),
      JSON.stringify(names),
    )

    // 1) prepare_evidence
    const prep = await client.call('prepare_evidence', {
      projectPath: root,
      label: 'selftest',
      run: [
        { name: 'metrics', command: 'node scripts/metrics.js' },
        { name: 'rules', command: 'node scripts/rules.js' },
        { name: 'failing', command: 'node scripts/failing.js' },
      ],
      codePaths: ['src/config.js', 'src/world.js'],
      notes: '自测用玩具项目',
    })
    check('prepare_evidence 成功', !prep.isError, prep.text.slice(0, 400))
    const evidenceDir = prep.structured?.evidenceDir
    check('返回 evidenceDir', !!evidenceDir && evidenceDir.includes('.critic'), evidenceDir)
    check('条目数 ≥ 5', (prep.structured?.entryCount || 0) >= 5, String(prep.structured?.entryCount))
    check('索引含指标行 pulsesToKill', prep.text.includes('pulsesToKill'))
    check('索引含文件条目 config.js', prep.text.includes('config.js'))
    check('失败命令有警告/负退出码可读', prep.text.includes('failing') || prep.structured?.warnings?.length > 0)

    const indexRaw = await fs.readFile(path.join(evidenceDir, 'index.json'), 'utf8')
    const index = JSON.parse(indexRaw)
    check('index.json 命令 3 条', index.commands.length === 3, String(index.commands.length))
    const failCmd = index.commands.find(c => c.name === 'failing')
    check('failing 退出码非 0', failCmd && failCmd.exitCode !== 0, JSON.stringify(failCmd))

    // 2) get_evidence_slice
    const slice = await client.call('get_evidence_slice', { evidenceDir, query: 'boss damage config' })
    check('切片命中 config 相关', !slice.isError && slice.text.includes('config'), slice.text.slice(0, 400))

    const metricSlice = await client.call('get_evidence_slice', { evidenceDir, query: 'pulsesToKill telegraphs' })
    check('切片命中指标', metricSlice.text.includes('pulsesToKill') || metricSlice.text.includes('telegraphs'), metricSlice.text.slice(0, 400))

    const noHit = await client.call('get_evidence_slice', { evidenceDir, query: 'zzz_nothing_matches_qqq' })
    check('无命中时给可用条目而不是报错', !noHit.isError && noHit.text.includes('没有条目命中'), noHit.text.slice(0, 200))

    const missingDir = await client.call('get_evidence_slice', { evidenceDir: path.join(root, 'nope') })
    check('证据包缺失明确报错', missingDir.isError && missingDir.text.includes('prepare_evidence'), missingDir.text.slice(0, 200))

    // 3) code_query
    const grep = await client.call('code_query', { projectPath: root, mode: 'grep', pattern: 'bossHp', include: '*.js' })
    check('grep 命中 bossHp', !grep.isError && grep.text.includes('bossHp'), grep.text.slice(0, 300))

    const grepCtx = await client.call('code_query', {
      projectPath: root, mode: 'grep', pattern: 'bossDamage', include: '*.js', contextLines: 1,
    })
    check('grep 带上下文行', grepCtx.text.includes('world.js:2:') || grepCtx.text.includes('world.js:3:'), grepCtx.text.slice(0, 300))

    const read = await client.call('code_query', { projectPath: root, mode: 'read', path: 'src/config.js', start: 2, end: 3 })
    check('read 指定区间带行号', read.text.includes('L2:') && read.text.includes('bossHp'), read.text.slice(0, 300))

    const listDir = await client.call('code_query', { projectPath: root, mode: 'list', depth: 2 })
    check('list 列目录', listDir.text.includes('src/') && listDir.text.includes('config.js'), listDir.text.slice(0, 300))

    const symbols = await client.call('code_query', { projectPath: root, mode: 'symbols', path: 'src/world.js' })
    check('symbols 明确引导去 serena', symbols.isError && symbols.text.includes('serena'), symbols.text.slice(0, 200))

    // 4) verify_anchors
    const good = await client.call('verify_anchors', {
      projectPath: root,
      anchors: [
        { path: 'src/config.js', line: 2, expectText: 'bossHp', expectNumber: 8 },
        { path: 'src/world.js', line: 2, expectText: 'Math.max' },
      ],
    })
    check('锚点全过', !good.isError && good.structured?.fail === 0, good.text.slice(0, 400))

    const bad = await client.call('verify_anchors', {
      projectPath: root,
      anchors: [
        { path: 'src/config.js', line: 2, expectNumber: 99 },
        { path: 'src/nope.js', line: 1 },
        { path: 'src/config.js', line: 2, expectText: 'not-here-text' },
      ],
    })
    check('失败锚点逐条报因', bad.structured?.fail === 3, JSON.stringify(bad.structured))
    check('失败项给实际内容', bad.text.includes('实际') || bad.text.includes('L2:'), bad.text.slice(0, 400))

    // 5) run_task
    const task = await client.call('run_task', { projectPath: root, command: 'node scripts/metrics.js' })
    check('run_task 成功', !task.isError && task.structured?.exitCode === 0, task.text.slice(0, 300))

    const taskFail = await client.call('run_task', { projectPath: root, command: 'node scripts/failing.js' })
    check('run_task 失败可见', taskFail.structured?.exitCode === 2 && taskFail.text.includes('boom'), taskFail.text.slice(0, 300))

    // 6) 未知工具
    const unknown = await client.call('no_such_tool', {})
    check('未知工具报错不崩', unknown.isError, unknown.text.slice(0, 120))
  } finally {
    client.child.kill()
    try {
      await fs.rm(root, { recursive: true, force: true })
    } catch {}
  }

  console.log(failures === 0 ? '\nALL PASS' : `\nFAILURES: ${failures}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => {
  console.error('selftest crashed:', e)
  process.exit(1)
})