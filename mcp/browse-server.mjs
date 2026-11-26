#!/usr/bin/env node
// critic-browse：把 ego-browser（真实 Chromium，带用户配置）封成一个只读 MCP 工具。
// 用途只有一个：free-search 的 fetch 被 Cloudflare / 人机验证 / 403 挡住时，用它把页面正文取回来。
// 零依赖，stdio JSON-RPC。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SERVER_NAME = 'critic-browse'
const SERVER_VERSION = '1.0.0'
const PROTOCOL_VERSION = '2024-11-05'
const RESULT_MARK = '__EGO_BROWSE_RESULT__'

const DEFAULT_TIMEOUT_MS = 30000
const MAX_TIMEOUT_MS = 90000
const DEFAULT_MAX_CHARS = 15000
const MAX_MAX_CHARS = 60000
const DEFAULT_CHALLENGE_WAIT_MS = 12000
const SCRIPT_GRACE_MS = 15000
const MAX_LINKS = 60

const TOOLS = [
  {
    name: 'browse_fetch',
    description:
      '用真实浏览器（ego-browser）打开一个被反爬/人机验证拦住的页面（wiki、fandom、GitHub 等），返回标题、正文纯文本与页面内链接。' +
      '只在 free-search 的 fetch 返回验证页、403、空壳或明显不完整时才用；能用 free-search 就先用它。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'http(s) 绝对地址' },
        maxChars: {
          type: 'number',
          description: `正文最多返回多少字符，默认 ${DEFAULT_MAX_CHARS}，上限 ${MAX_MAX_CHARS}`,
        },
        start: { type: 'number', description: '从正文第几个字符开始返回，默认 0；长文分段读时用' },
        timeoutMs: { type: 'number', description: `导航超时毫秒，默认 ${DEFAULT_TIMEOUT_MS}` },
        challengeWaitMs: {
          type: 'number',
          description: `人机验证页最多等待毫秒（等它自动放行），默认 ${DEFAULT_CHALLENGE_WAIT_MS}`,
        },
        contentSelector: {
          type: 'string',
          description: '只取该 CSS 选择器内的正文；不填则自动找 main/article/#mw-content-text 等',
        },
        includeLinks: { type: 'boolean', description: '是否返回页面内链接清单，默认 true' },
      },
    },
  },
]

function clip(n, lo, hi, dflt) {
  const v = Number(n)
  if (!Number.isFinite(v)) return dflt
  return Math.min(hi, Math.max(lo, Math.round(v)))
}

function buildScript(args) {
  const cfg = {
    url: String(args.url),
    maxChars: clip(args.maxChars, 200, MAX_MAX_CHARS, DEFAULT_MAX_CHARS),
    start: clip(args.start, 0, Number.MAX_SAFE_INTEGER, 0),
    timeoutMs: clip(args.timeoutMs, 3000, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    challengeWaitMs: clip(args.challengeWaitMs, 0, 60000, DEFAULT_CHALLENGE_WAIT_MS),
    contentSelector: typeof args.contentSelector === 'string' ? args.contentSelector.trim() : '',
    includeLinks: args.includeLinks !== false,
    maxLinks: MAX_LINKS,
    mark: RESULT_MARK,
  }
  return `
const cfg = ${JSON.stringify(cfg)};
const task = await taskSpace("mcp-browse-" + Math.floor(Math.random() * 1e9).toString(36));
const page = task.page("p1");
let navError = null;
let challengePending = false;
try {
  await page.goto(cfg.url, { timeout: cfg.timeoutMs, waitUntil: "domcontentloaded" });
} catch (e) {
  navError = String(e && e.message ? e.message : e).slice(0, 400);
}
const readState = async () => page.evaluate(() => ({
  title: document.title || "",
  bodyLen: (document.body && document.body.innerText ? document.body.innerText.length : 0),
}));
let st = { title: "", bodyLen: 0 };
try { st = await readState(); } catch (e) { navError = navError || String(e.message || e).slice(0, 400); }
const looksBlocked = (s) =>
  /just a moment|attention required|checking your browser|verify(ing)? (you|your browser)|安全验证|人机验证|请稍候|稍等/i.test(s.title) ||
  (s.bodyLen < 600 && /verification|cloudflare|captcha/i.test(s.title + " " + s.bodyLen));
challengePending = looksBlocked(st);
if (challengePending && cfg.challengeWaitMs > 0) {
  const deadline = Date.now() + cfg.challengeWaitMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout ? page.waitForTimeout(800) : new Promise((r) => setTimeout(r, 800));
    try { st = await readState(); } catch (e) {}
    if (!looksBlocked(st) && st.bodyLen > 600) { challengePending = false; break; }
  }
}
let payload = null;
try {
  payload = await page.evaluate((c) => {
    const pick = (sel) => { try { return document.querySelector(sel); } catch (e) { return null; } };
    let root = null;
    if (c.contentSelector) root = pick(c.contentSelector);
    if (!root) {
      for (const sel of ["#mw-content-text", "main article", "main", "article", "[role=main]", "#content", ".markdown-body", "#readme"]) {
        root = pick(sel);
        if (root && (root.innerText || "").trim().length > 200) break;
        root = null;
      }
    }
    if (!root) root = document.body;
    const full = (root && root.innerText ? root.innerText : "").replace(/\\u00a0/g, " ");
    const lines = full.split("\\n").map((l) => l.replace(/\\s+$/g, ""));
    const kept = [];
    let blank = 0;
    for (const l of lines) {
      const t = l.trim();
      if (!t) { blank += 1; if (blank > 1 && kept.length) continue; else if (!kept.length) continue; }
      else blank = 0;
      const dup = kept.length && kept[kept.length - 1].trim() === t;
      if (!dup) kept.push(l);
    }
    const text = kept.join("\\n").trim();
    const links = [];
    if (c.includeLinks) {
      const seen = new Set();
      for (const a of document.querySelectorAll("a[href]")) {
        const label = (a.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 100);
        const href = a.href;
        if (!label || !href || !/^https?:/i.test(href)) continue;
        if (/(Special:|UserLogin|CreateAccount|oauth|signin|login\\?)/i.test(href)) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        links.push({ label, href: href.split("#")[0] });
        if (links.length >= c.maxLinks) break;
      }
    }
    return { title: document.title || "", text, linkCount: links.length, links };
  }, { contentSelector: cfg.contentSelector, includeLinks: cfg.includeLinks, maxLinks: cfg.maxLinks });
} catch (e) {
  navError = navError || String(e && e.message ? e.message : e).slice(0, 400);
}
const text = payload && payload.text ? payload.text : "";
const out = {
  url: cfg.url,
  finalUrl: await page.url().catch(() => cfg.url),
  title: (payload && payload.title) || st.title || "",
  totalChars: text.length,
  start: cfg.start,
  navError,
  blocked: challengePending,
  text: text.slice(cfg.start, cfg.start + cfg.maxChars),
  links: payload && payload.links ? payload.links : [],
};
console.log(cfg.mark + JSON.stringify(out));
try { await task.finish({ keep: [] }); } catch (e) {
  try { await task.finish({ keep: "all" }); } catch (e2) {}
}
`
}

// 找 ego-browser 可执行文件：优先真 exe（免 shell，stdin 直通），退回 PATH 上的命令名。
function resolveEgoBin() {
  if (process.env.EGO_BROWSER_BIN) return { bin: process.env.EGO_BROWSER_BIN, shell: false }
  if (process.platform === 'win32') {
    const candidates = [
      join(homedir(), '.local', 'share', 'ego', 'active_version_dir', 'ego-browser.exe'),
      'C:\\Program Files\\Citro Labs\\ego lite\\ego-browser.exe',
    ]
    for (const c of candidates) if (existsSync(c)) return { bin: c, shell: false }
    return { bin: 'ego-browser.cmd', shell: true }
  }
  return { bin: 'ego-browser', shell: false }
}

function runEgo(script, hardTimeoutMs) {
  return new Promise((resolve) => {
    const { bin, shell } = resolveEgoBin()
    const child = spawn(bin, ['nodejs'], {
      shell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      try { child.kill() } catch {}
      resolve(r)
    }
    const timer = setTimeout(() => finish({ error: `ego-browser 超时（${hardTimeoutMs}ms 未返回）`, stdout, stderr }), hardTimeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      finish({ error: `无法启动 ego-browser：${e.message}（可用环境变量 EGO_BROWSER_BIN 指定路径）` })
    })
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ code, stdout, stderr })
    })
    try {
      child.stdin.write(script)
      child.stdin.end()
    } catch (e) {
      clearTimeout(timer)
      finish({ error: `写入 ego-browser 脚本失败：${e.message}` })
    }
  })
}

async function browseFetch(args) {
  const url = String(args?.url ?? '').trim()
  if (!/^https?:\/\//i.test(url)) {
    return { isError: true, text: `url 必须是 http(s) 绝对地址，收到：${url || '（空）'}` }
  }
  const maxChars = clip(args.maxChars, 200, MAX_MAX_CHARS, DEFAULT_MAX_CHARS)
  const timeoutMs = clip(args.timeoutMs, 3000, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  const challengeWaitMs = clip(args.challengeWaitMs, 0, 60000, DEFAULT_CHALLENGE_WAIT_MS)
  const script = buildScript(args)
  const hardTimeout = timeoutMs + challengeWaitMs + SCRIPT_GRACE_MS
  const r = await runEgo(script, hardTimeout)
  if (r.error) return { isError: true, text: r.error }

  // ego-browser 把脚本里的 console.log 写到 stderr，两路合并找标记
  const merged = String(r.stdout || '') + String(r.stderr || '')
  const at = merged.indexOf(RESULT_MARK)
  if (at < 0) {
    const tail = (r.stderr || r.stdout || '').trim().slice(-1200)
    return {
      isError: true,
      text: `ego-browser 没有返回结果（退出码 ${r.code}）。尾部输出：\n${tail || '（空）'}`,
    }
  }
  const after = merged.slice(at + RESULT_MARK.length)
  const jsonText = after.split(/\r?\n/)[0].trim()
  let out
  try {
    out = JSON.parse(jsonText)
  } catch (e) {
    return { isError: true, text: `结果解析失败：${e.message}；前缀 ${jsonText.slice(0, 80)}` }
  }

  const head = [
    `URL：${out.url}`,
    out.finalUrl && out.finalUrl !== out.url ? `跳转后：${out.finalUrl}` : '',
    `标题：${out.title || '（空）'}`,
    `正文总长：${out.totalChars} 字符；本次返回 [${out.start}, ${out.start + out.text.length})`,
    out.blocked ? '⚠ 页面疑似仍停在人机验证/拦截页，正文不可信。' : '',
    out.navError ? `⚠ 导航提示：${out.navError}` : '',
  ].filter(Boolean)

  const parts = [head.join('\n'), '', '【正文】', out.text || '（空）']
  const rest = out.totalChars - (out.start + out.text.length)
  if (rest > 0) {
    parts.push('', `（还有 ${rest} 字符未返回；需要就再调一次，start=${out.start + out.text.length}）`)
  }
  if (Array.isArray(out.links) && out.links.length) {
    parts.push('', `【页面内链接 ${out.links.length} 条】`)
    for (const l of out.links) parts.push(`- ${l.label} — ${l.href}`)
  }
  return { isError: !!out.blocked, text: parts.join('\n') }
}

// ── stdio JSON-RPC ──
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    handle(line).catch((e) => {
      process.stderr.write(`[critic-browse] handler error: ${e && e.stack ? e.stack : e}\n`)
    })
  }
})

async function handle(line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = msg
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    })
  }
  if (method === 'notifications/initialized') return
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments ?? {}
    if (name !== 'browse_fetch') return replyError(id, -32601, `unknown tool: ${name}`)
    try {
      const r = await browseFetch(args)
      return reply(id, {
        content: [{ type: 'text', text: r.text }],
        isError: !!r.isError,
      })
    } catch (e) {
      return reply(id, {
        content: [{ type: 'text', text: `browse_fetch 失败：${e && e.message ? e.message : e}` }],
        isError: true,
      })
    }
  }
  if (id !== undefined) replyError(id, -32601, `unknown method: ${method}`)
}

process.stdin.on('end', () => process.exit(0))
process.stderr.write(`[critic-browse] ${SERVER_NAME} ${SERVER_VERSION} ready\n`)