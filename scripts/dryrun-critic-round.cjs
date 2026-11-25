// 干跑 critic-round.js 的脚本逻辑：不调真实子代理，只验分诊选路、分片判卷、汇流、升级门与合并。
// 用法：node scripts/dryrun-critic-round.cjs <case>
//   case = normal | cleanup | explicit-lenses | nodiff | escalate | dropall（默认 normal）

const fs = require('fs')
const path = require('path')

const caseName = process.argv[2] || 'normal'
const src = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'critic-round.js'), 'utf8')
const body = src.replace('export const meta', 'const meta')

const DIFF = [
  'diff --git a/src/drag.ts b/src/drag.ts',
  '+function onDragStart(e) { start(e.pointerId) }',
  '-  // 旧实现只处理了鼠标事件',
].join('\n')

const argsByCase = {
  normal: {
    diff: DIFF,
    intent: '给拖拽加指针事件支持，兼容触摸屏',
    projectContext: 'mock 项目：TypeScript + 浏览器环境',
  },
  cleanup: {
    diff: 'rename: src/utils/old-name.ts -> src/utils/new-name.ts\nupdate imports',
    intent: '批量重命名工具文件',
    type: 'file-cleanup',
  },
  'explicit-lenses': {
    diff: DIFF,
    intent: '只从体验角度看看',
    lenses: ['ux'],
    diverge: false,
    escalate: false,
  },
  nodiff: {
    intent: '忘了给 diff',
  },
  escalate: {
    diff: DIFF,
    intent: '改动了权限检查逻辑',
    type: 'feature',
  },
  dropall: {
    diff: DIFF,
    intent: '改了点小东西',
    type: 'hotfix',
  },
}

const harness = `
const agentCalls = []
const CASE = ${JSON.stringify(caseName)}

function mockClassifier() {
  return { type: CASE === 'cleanup' ? 'file-cleanup' : 'feature', reason: 'mock 分诊' }
}

function mockLens(prompt, label) {
  if (label.includes('用户体验')) {
    return {
      lens: '用户体验',
      pathMatrix: [
        { path: '触摸拖拽', status: 'uncovered', note: '本次只测鼠标' },
        { path: '鼠标拖拽', status: 'covered', note: '已有实现' },
      ],
      findings: [
        {
          location: 'src/drag.ts:12',
          problem: '触摸拖拽无任何进行中提示',
          severity: 'should-fix',
          confidence: 0.8,
          evidence: 'onDragStart 无 UI 反馈调用',
        },
      ],
    }
  }
  if (label.includes('升级')) {
    return {
      lens: label,
      findings: [
        {
          location: 'src/permission.ts:3',
          problem: '指针事件回调未校验 iframe 来源',
          severity: 'minor',
          confidence: 0.6,
          evidence: 'postMessage 无 origin 校验',
        },
      ],
    }
  }
  if (label.includes('发散者')) {
    return {
      pathMatrix: [
        { path: '拖拽到容器外释放', status: 'uncovered', note: '无边界处理' },
        { path: '拖拽中旋转屏幕', status: 'n-a', note: '桌面端无此路径' },
      ],
      findings: [
        {
          location: 'src/drag.ts:30',
          problem: '拖到容器外释放时状态未清理',
          bucket: 'repairIncomplete',
          severity: 'must-fix',
          confidence: 0.9,
          evidence: 'end() 只在容器内触发',
        },
        {
          location: 'src/legacy.ts:8',
          problem: '老的鼠标拖拽也没做边界处理',
          bucket: 'preExisting',
          severity: 'should-fix',
          confidence: 0.7,
          evidence: 'legacy 分支同样缺失',
        },
      ],
    }
  }
  return {
    lens: label,
    findings: [
      {
        location: 'src/drag.ts:5',
        problem: '指针事件在旧浏览器下未降级',
        severity: 'should-fix',
        confidence: 0.7,
        evidence: '无 PointerEvent 特性检测',
      },
    ],
  }
}

function idsOf(prompt) {
  return prompt
    .split('"id": "')
    .slice(1)
    .map((s) => s.slice(0, s.indexOf('"')))
    .filter((s) => s.startsWith('F'))
}

function mockShardJudge(prompt, label) {
  const lens = label.replace('分片判卷:', '')
  const ids = idsOf(prompt)
  if (CASE === 'dropall') {
    return { verdicts: ids.map((id) => ({ id, action: 'drop', reason: 'mock 驳回' })), summary: 'mock 全部驳回' }
  }
  const isCorrectness = lens.includes('正确性与回归')
  const isDiverge = lens.includes('发散者')
  const isExtra = lens.includes('升级')
  const verdicts = ids.map((id, i) => {
    if (isCorrectness && i === 0) return { id, action: 'keep', severity: 'must-fix', reason: 'mock 证据成立' }
    if (isDiverge) return { id, action: 'keep', severity: undefined, reason: 'mock 按 bucket 归置' }
    if (isExtra) return { id, action: 'keep', severity: 'minor', reason: 'mock 升级补充' }
    return { id, action: 'keep', severity: 'should-fix', reason: 'mock 保留' }
  })
  // severity 为 undefined 时 JSON 会丢键，属正常：脚本回落到 item.severity
  return { verdicts, summary: 'mock 分片结论' }
}

function mockFinalJudge(prompt) {
  // 前 4 条是各常规镜头报的同一问题（mock 故意让每路都报），归一组验证脚本去重
  const ids = idsOf(prompt)
  const mergeClusters = ids.length >= 4 ? [ids.slice(0, 4)] : []
  if (CASE === 'escalate') {
    return {
      mergeClusters,
      severityOverrides: ids.length ? [{ id: ids[0], severity: 'must-fix', reason: 'mock 统一口径' }] : [],
      pathMatrix: [{ path: '拖拽到容器外释放', status: 'uncovered', note: '无边界处理' }],
      userPathMatrix: [{ path: '触摸拖拽', status: 'uncovered', note: '本次只测鼠标' }],
      needEscalate: true,
      escalateLenses: ['安全边界: 指针事件权限与跨域 iframe'],
      summary: 'mock 汇流：需要补派安全视角',
    }
  }
  return {
    mergeClusters,
    severityOverrides: [],
    pathMatrix: [{ path: '拖拽到容器外释放', status: 'uncovered', note: '无边界处理' }],
    userPathMatrix: [],
    needEscalate: false,
    escalateLenses: [],
    summary: 'mock 汇流总结',
  }
}

async function agent(prompt, opts = {}) {
  const label = String(opts.label || '')
  agentCalls.push({
    label,
    agentType: opts.agentType || '',
    phase: opts.phase || '',
    promptLen: prompt.length,
    schemaRequired: opts.schema?.required || [],
  })
  if (label.startsWith('分片判卷')) return mockShardJudge(prompt, label)
  if (label.startsWith('汇流')) return mockFinalJudge(prompt)
  if (label.startsWith('分诊')) return mockClassifier()
  if (label.includes('找茬')) return mockLens(prompt, label)
  return null
}

async function parallel(thunks) {
  const out = []
  for (const t of thunks) {
    try {
      out.push(await t())
    } catch (e) {
      out.push(null)
    }
  }
  return out
}

function phase() {}
function log(m) { console.log('[log] ' + m) }

const args = ${JSON.stringify(argsByCase[caseName] || argsByCase.normal)}

async function __run() {
${body}
}

__run()
  .then((r) => {
    console.log('=== RESULT ===')
    console.log(JSON.stringify(r, null, 2))
    console.log('=== AGENT CALLS ===')
    console.log(JSON.stringify(agentCalls, null, 2))
  })
  .catch((e) => {
    console.error('=== THROWN ===')
    console.error(e && e.stack ? e.stack : e)
    process.exit(1)
  })
`

fs.writeFileSync(path.join(__dirname, '_dryrun-critic-round.generated.cjs'), harness, 'utf8')
require('./_dryrun-critic-round.generated.cjs')