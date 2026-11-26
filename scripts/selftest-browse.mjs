#!/usr/bin/env node
// critic-browse 自测：起 MCP server，走 stdio JSON-RPC，真实抓一个被 Cloudflare 拦的 wiki 页。
// 用法：node scripts/selftest-browse.mjs [url]

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = join(here, '..', 'mcp', 'browse-server.mjs')
const url = process.argv[2] || 'https://calamitymod.wiki.gg/wiki/Calamity_Mod_Wiki'

let pass = 0
let fail = 0
function ok(cond, name) {
  if (cond) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}`)
  }
}

const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] })
let buf = ''
const pending = new Map()
let nextId = 1

child.stdout.on('data', (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id)
      pending.delete(msg.id)
      resolve(msg)
    }
  }
})
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))

function rpc(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`rpc timeout: ${method}`))
    }, 120000)
    pending.set(id, {
      resolve: (m) => {
        clearTimeout(timer)
        resolve(m)
      },
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

function textOf(resp) {
  return (resp?.result?.content ?? []).map((c) => c.text || '').join('\n')
}

const t0 = Date.now()

const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'selftest', version: '0' },
})
ok(!!init.result?.serverInfo, 'initialize 握手')
ok(init.result?.serverInfo?.name === 'critic-browse', 'serverInfo.name = critic-browse')

const list = await rpc('tools/list', {})
const names = (list.result?.tools ?? []).map((t) => t.name)
ok(names.length === 1 && names[0] === 'browse_fetch', `tools/list 只有 browse_fetch（实际：${names.join(',')}）`)

// 参数校验
const badUrl = await rpc('tools/call', { name: 'browse_fetch', arguments: { url: 'ftp://x' } })
ok(badUrl.result?.isError === true && /http/.test(textOf(badUrl)), '非 http(s) 地址被拒')

// 真实抓取（Cloudflare 站点）
const t1 = Date.now()
const r = await rpc('tools/call', { name: 'browse_fetch', arguments: { url, maxChars: 4000 } })
const txt = textOf(r)
ok(!r.result?.isError, `browse_fetch 未报错（${Date.now() - t1}ms）`)
ok(/Official|Wiki/i.test(txt), '标题/正文含站点特征词')
ok(txt.length > 1200, `正文长度足够（${txt.length} 字符）`)
ok(!/Just a moment\.\.\.\s*Verification successful\.?$/m.test(txt), '不是 Cloudflare 挑战页壳')
ok(/【正文】/.test(txt) && /导航|Main page|Main Page|Contents/i.test(txt), '正文段落结构正常')
ok(/【页面内链接/.test(txt) || /正文总长/.test(txt), '返回元信息齐全')
console.log('--- 抓取摘要 ---')
console.log(txt.split('\n').slice(0, 8).join('\n'))
console.log(`--- 用时 ${Date.now() - t0}ms ---`)

// 分段读取
const seg = await rpc('tools/call', { name: 'browse_fetch', arguments: { url, maxChars: 800, start: 800 } })
const segTxt = textOf(seg)
ok(!seg.result?.isError && /\[800,/.test(segTxt), 'start 分段读取生效')

child.stdin.end()
child.kill()

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)