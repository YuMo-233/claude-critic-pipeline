// 干跑 quality-round.js 的脚本逻辑：不调真实子代理，只验参数流动、合并、封顶、收敛判定。
// 用法：node scripts/dryrun-quality-round.cjs <case>
//   case = normal  |  plagiarism  |  stalled  |  nostale（默认 normal）

const fs = require('fs')
const path = require('path')

const caseName = process.argv[2] || 'normal'
const src = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'quality-round.js'), 'utf8')
const body = src.replace('export const meta', 'const meta')

const DIM_KEYS = [
  'resolution-clarity',
  'render-pipeline-lighting',
  'material-texture',
  'color-composition',
  'post-processing',
  'particles-effects',
  'animation-visual',
  'ui-hud-visual',
]

const argsByCase = {
  normal: {
    benchmarkRefs: ['MockRefA', 'MockRefB'],
    capturePlan: {
      run: 'echo mock-capture',
      workdir: '.',
      outputDir: 'mock/shots',
      scenes: ['home', 'list'],
      shots: ['mock/shots/home.png', 'mock/shots/list.png'],
      metrics: [{ name: 'sharpness', command: 'echo 42' }],
      codePaths: ['mock/render.cfg'],
    },
    goal: '让界面更清晰统一',
    round: 1,
    depth: 'quick',
    known: [],
  },
  plagiarism: {
    benchmarkRefs: ['MockRefA'],
    shots: ['mock/shots/home.png'],
    round: 2,
    history: [
      {
        round: 1,
        scores: Object.fromEntries(DIM_KEYS.map((k) => [k, 3])),
        mustFixCount: 1,
        plagiarismBlocked: false,
        hollowDimensions: [],
        coverageGapCount: 0,
      },
    ],
  },
  noref: {
    capturePlan: { shots: ['mock/shots/home.png'] },
  },
  nocapture: {
    benchmarkRefs: ['MockRefA'],
  },
  lensfail: {
    benchmarkRefs: ['MockRefA'],
    shots: ['mock/shots/home.png'],
  },
  converged: {
    benchmarkRefs: ['MockRefA'],
    shots: ['mock/shots/home.png'],
    round: 2,
    history: [
      {
        round: 1,
        scores: Object.fromEntries(DIM_KEYS.map((k) => [k, 4.5])),
        mustFixCount: 2,
        plagiarismBlocked: false,
        hollowDimensions: [],
        coverageGapCount: 0,
      },
    ],
  },
  stalled: {
    benchmarkRefs: ['MockRefA'],
    shots: ['mock/shots/home.png'],
    round: 3,
    history: [
      {
        round: 1,
        scores: Object.fromEntries(DIM_KEYS.map((k) => [k, 3])),
        mustFixCount: 4,
        plagiarismBlocked: false,
        hollowDimensions: [],
        coverageGapCount: 0,
      },
      {
        round: 2,
        scores: Object.fromEntries(DIM_KEYS.map((k) => [k, 4])),
        mustFixCount: 3,
        plagiarismBlocked: false,
        hollowDimensions: [],
        coverageGapCount: 0,
      },
    ],
  },
}

const harness = `
const agentCalls = []
const CASE = ${JSON.stringify(caseName)}
const DIM_KEYS = ${JSON.stringify(DIM_KEYS)}

function mockBrief() {
  return {
    refs: ['MockRefA', 'MockRefB'],
    dimensions: DIM_KEYS.map((k) => ({
      key: k,
      referenceApproach: 'mock 参考做法 ' + k,
      verifiableCriteria: ['能落到画面事实的标准 ' + k],
      deductionPoints: ['差在这会掉分 ' + k],
      targetScore: 4,
    })),
    sources: [],
    caveats: 'mock brief',
  }
}

function mockCapture() {
  return {
    executed: true,
    commands: [{ command: 'echo mock-capture', exitCode: 0, output: 'mock-capture' }],
    shots: [
      { scene: 'home', path: 'mock/shots/home.png' },
      { scene: 'list', path: 'mock/shots/list.png' },
    ],
    metrics: [{ name: 'sharpness', command: 'echo 42', output: '42' }],
    visionAvailable: true,
    notes: 'mock 取证',
  }
}

function mockLensFindings(label) {
  const dims = DIM_KEYS.map((k) => ({
    key: k,
    status: 'assessed',
    score: CASE === 'converged' ? 5 : 4,
    deductions: [],
    strengths: ['mock 优点 ' + k],
  }))
  if (CASE === 'converged') {
    return { lens: label, dimensions: dims, findings: [], coverageGaps: [] }
  }
  if (label.includes('渲染基础')) {
    dims[1].deductions = [{ points: 1, issue: '光照方向不统一', gap: '与参考差一档', evidence: 'home.png 左上区域' }]
    dims[1].score = 4
    dims[2].deductions = [{ points: 0.5, issue: '金属与布料难区分', gap: '材质区分度不足', evidence: 'home.png 中央' }]
    dims[2].score = 4.5
  }
  if (label.includes('成像链')) {
    dims[0].deductions = [{ points: 0.5, issue: '缩放使用线性滤镜导致发虚', gap: '清晰度掉一档', evidence: 'list.png 文字' }]
    dims[0].score = 4.5
  }
  return {
    lens: label,
    dimensions: dims,
    findings: [
      {
        location: 'home.png 左上区域',
        problem: '光源方向与角色受光不一致',
        severity: 'should-fix',
        confidence: 0.8,
        evidence: '角色高光在右，环境阴影在左',
        dimension: 'render-pipeline-lighting',
      },
    ],
    coverageGaps: [
      { scene: 'battle', why: '本轮未拍战斗场景', neededEvidence: '战斗界面截图一张' },
    ],
  }
}

function mockDetail() {
  const hollow = CASE === 'normal' || CASE === 'stalled'
    ? [
        {
          dimension: 'material-texture',
          problem: '金属材质只是加了高光，粗糙度没区分',
          whyHollow: '只学了表面反光，没学材质区分',
          evidence: 'home.png 中央区域',
        },
      ]
    : []
  const plag = CASE === 'plagiarism'
    ? [
        {
          kind: 'ui-layout',
          reference: 'MockRefA 的主界面三栏布局',
          ours: 'home.png 的三栏布局与图标位置逐一对应',
          evidence: 'home.png 与参考主界面截图比对',
          confidence: 0.9,
        },
      ]
    : []
  return {
    hollowFindings: hollow,
    plagiarismRisks: plag,
    imitationVsLearning: '技法层面学对了光照层级；具体标识层面未见搬运。',
    summary: 'mock 细节结论',
  }
}

function mockJudge() {
  const base = {
    dimensions: DIM_KEYS.map((k) => ({
      key: k,
      status: 'assessed',
      score: CASE === 'converged' ? 5 : 4,
      deductions: [],
      notes: 'mock 判卷',
    })),
    rejectedCount: 1,
    plagiarism: {
      blocked: CASE === 'plagiarism',
      risks: CASE === 'plagiarism' ? mockDetail().plagiarismRisks : [],
      decision: CASE === 'plagiarism' ? '命中具体界面布局' : '未命中具体标识',
    },
    coverage: [
      { scene: 'battle', why: '本轮未拍战斗场景', neededEvidence: '战斗界面截图一张', fromLens: '渲染基础' },
    ],
    summary: 'mock 判卷总结',
  }
  if (CASE === 'converged') return { ...base, confirmed: [], coverage: [] }
  return {
    ...base,
    confirmed: [
      {
        location: 'home.png 左上区域',
        problem: '光源方向与角色受光不一致',
        severity: 'must-fix',
        evidence: '角色高光在右，环境阴影在左',
        dimension: 'render-pipeline-lighting',
        fromLens: '渲染基础',
      },
    ],
  }
}

async function agent(prompt, opts = {}) {
  const label = String(opts.label || '')
  agentCalls.push({ label, agentType: opts.agentType || '', phase: opts.phase || '', promptLen: prompt.length, schemaRequired: opts.schema?.required || [] })
  if (label.includes('调研')) return mockBrief()
  if (label.includes('取证')) return mockCapture()
  if (label.includes('找茬')) return CASE === 'lensfail' ? null : mockLensFindings(label)
  if (label.includes('评审')) return mockDetail()
  if (label.includes('判卷')) return mockJudge()
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

fs.writeFileSync(path.join(__dirname, '_dryrun-quality-round.generated.cjs'), harness, 'utf8')
require('./_dryrun-quality-round.generated.cjs')