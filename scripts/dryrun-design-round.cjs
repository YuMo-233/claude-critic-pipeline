// 干跑 design-round.js 的脚本逻辑：不调真实子代理，只验参数流动、维度过滤、合并、封顶、收敛判定。
// 用法：node scripts/dryrun-design-round.cjs <case>
//   case = normal | solo-nofeedback | forced-dim | nogoal | noevidence | simfail |
//          thresholddrift | evidenceblocked | converged | stalled | psych-unverified
//   默认 normal

const fs = require('fs')
const path = require('path')

const caseName = process.argv[2] || 'normal'
const src = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'design-round.js'), 'utf8')
const body = src.replace('export const meta', 'const meta')

const DIM_KEYS = [
  'combat-balance',
  'economy-growth',
  'level-topology',
  'content-branching',
  'boss-variety',
  'fun-structure',
  'co-op-synergy',
  'co-op-fun',
  'coop-differentiation',
  'surprise-fun',
  'feedback-psych',
]

// 证据包由调度员在 workflow 外准备，workflow 只收目录
const evidenceDir = 'mock/.critic/evidence/mock'

// 构造一份「已落盘」的基准文件内容（含元数据），供复用/过期用例
function storedBrief(over) {
  const base = {
    refs: ['MockRefA'],
    revision: 3,
    fetchedAt: '2026-11-20',
    appliesTo: 'v1',
    origin: 'research',
    dimensions: DIM_KEYS.map((k) => ({
      key: k,
      referenceApproach: '文件里的参考做法 ' + k,
      verifiableCriteria: ['文件口径 ' + k],
      deductionPoints: ['文件扣分点 ' + k],
      targetScore: 4,
    })),
    sources: [{ title: 'MockRefA 官方攻略', url: 'https://example.invalid/a' }],
    caveats: 'stored brief',
  }
  return Object.assign(base, over || {})
}

const argsByCase = {
  normal: {
    goal: '让第三章难度更平滑',
    projectPath: 'mock/project',
    evidenceDir,
    feedback: { text: '第3章太难了，我打不过', files: ['feedback/r1.txt'] },
    benchmarkRefs: ['MockRefA'],
    players: 4,
    round: 1,
    depth: 'quick',
  },
  researchfail: {
    goal: '基准调研失败的降级验证',
    projectPath: 'mock/project',
    evidenceDir,
    players: 1,
    benchmarkRefs: ['MockRefA'],
    round: 1,
    depth: 'quick',
  },
  'solo-nofeedback': {
    goal: '单人模式下数值更平滑',
    projectPath: 'mock/project',
    evidenceDir,
    players: 1,
    round: 1,
  },
  'forced-dim': {
    goal: '单机也要有意外惊喜',
    projectPath: 'mock/project',
    evidenceDir,
    players: 1,
    dimensions: ['surprise-fun'],
    round: 1,
  },
  nogoal: {
    projectPath: 'mock/project',
    evidenceDir,
    players: 1,
  },
  noevidence: {
    goal: '随便看看',
    players: 1,
  },
  simfail: {
    goal: '看战斗数值',
    projectPath: 'mock/project',
    evidenceDir,
    players: 1,
    round: 1,
  },
  thresholddrift: {
    goal: '让趣味结构更扎实',
    projectPath: 'mock/project',
    evidenceDir,
    players: 1,
    round: 1,
  },
  evidenceblocked: {
    goal: '核对数值结论',
    projectPath: 'mock/project',
    evidenceDir,
    feedback: { text: '怪太肉了' },
    players: 1,
    round: 1,
  },
  converged: {
    goal: '数值与趣味都达标',
    projectPath: 'mock/project',
    evidenceDir,
    feedback: { text: '现在打着舒服' },
    players: 4,
    round: 2,
    history: [
      {
        round: 1,
        scores: Object.fromEntries(DIM_KEYS.map((k) => [k, 4.5])),
        mustFixCount: 2,
        evidenceBlocked: false,
        hollowDimensions: [],
        coverageGapCount: 0,
      },
    ],
  },
  stalled: {
    goal: '再挑一轮',
    projectPath: 'mock/project',
    evidenceDir,
    feedback: { text: '还是有点难' },
    players: 4,
    round: 3,
    history: [
      {
        round: 1,
        scores: Object.fromEntries(DIM_KEYS.map((k) => [k, 4])),
        mustFixCount: 2,
        evidenceBlocked: false,
        hollowDimensions: [],
        coverageGapCount: 0,
      },
      {
        round: 2,
        scores: Object.fromEntries(DIM_KEYS.map((k) => [k, 4])),
        mustFixCount: 2,
        evidenceBlocked: false,
        hollowDimensions: [],
        coverageGapCount: 0,
      },
    ],
  },
  'psych-unverified': {
    goal: '看看玩家为什么抱怨',
    projectPath: 'mock/project',
    evidenceDir,
    feedback: { text: '玩着没意思\n就是不好玩' },
    players: 1,
    round: 1,
  },
  // ── 分诊 / 目标覆盖 / 切片 ──
  'triage-map': {
    goal: '把地图做成视野盲区沙盒，箱庭谜题双人强制合作',
    projectPath: 'mock/project',
    evidenceDir,
    players: 1,
    round: 1,
    depth: 'quick',
  },
  'triage-fallback': {
    goal: '随便优化一下',
    projectPath: 'mock/project',
    evidenceDir,
    players: 1,
    round: 1,
    depth: 'quick',
  },
  'goal-uncovered': {
    goal: '让打击手感更爽，界面更顺手',
    projectPath: 'mock/project',
    evidenceDir,
    players: 1,
    round: 1,
    depth: 'quick',
  },
  'accept-uncovered': {
    goal: '让打击手感更爽，界面更顺手',
    projectPath: 'mock/project',
    evidenceDir,
    players: 1,
    round: 1,
    depth: 'quick',
    acceptUncovered: true,
  },
  scope: {
    goal: '只看第三章的地图结构',
    projectPath: 'mock/project',
    evidenceDir,
    players: 1,
    round: 1,
    depth: 'quick',
    dimensions: ['level-topology'],
    scope: { label: '第三章', units: ['3-1', '3-2'], note: '只看这两关' },
  },
  'not-applicable': {
    goal: '看看 Boss 机制多样性',
    projectPath: 'mock/project',
    evidenceDir,
    players: 1,
    round: 1,
    depth: 'quick',
  },
  'cap-findings': {
    goal: '看战斗数值',
    projectPath: 'mock/project',
    evidenceDir,
    players: 1,
    round: 1,
    depth: 'quick',
    dimensions: ['combat-balance'],
  },
  // ── 复检 ──
  'verify-fixed': {
    goal: '复检上一轮的必修项',
    projectPath: 'mock/project',
    evidenceDir,
    players: 4,
    round: 2,
    mode: 'verify',
    history: [
      {
        round: 1,
        scores: Object.assign(Object.fromEntries(DIM_KEYS.map((k) => [k, 5])), { 'combat-balance': 3 }),
        mustFixCount: 2,
        mustFixItems: [
          {
            dimension: 'combat-balance',
            location: 'data/boss.csv:3',
            problem: 'HP 涨幅过高',
            severity: 'must-fix',
            evidence: '2400 vs 1600',
          },
          {
            dimension: 'fun-structure',
            location: 'src/feedback.js:22',
            problem: '反馈密度不足',
            severity: 'must-fix',
            evidence: '每 3 次操作 1 次反馈',
          },
        ],
        evidenceBlocked: false,
        hollowDimensions: [],
        coverageGapCount: 0,
      },
    ],
  },
  'verify-still': {
    goal: '复检上一轮的必修项',
    projectPath: 'mock/project',
    evidenceDir,
    players: 4,
    round: 2,
    mode: 'verify',
    history: [
      {
        round: 1,
        scores: Object.assign(Object.fromEntries(DIM_KEYS.map((k) => [k, 5])), { 'combat-balance': 3 }),
        mustFixCount: 2,
        mustFixItems: [
          {
            dimension: 'combat-balance',
            location: 'data/boss.csv:3',
            problem: 'HP 涨幅过高',
            severity: 'must-fix',
            evidence: '2400 vs 1600',
          },
          {
            dimension: 'fun-structure',
            location: 'src/feedback.js:22',
            problem: '反馈密度不足',
            severity: 'must-fix',
            evidence: '每 3 次操作 1 次反馈',
          },
        ],
        evidenceBlocked: false,
        hollowDimensions: [],
        coverageGapCount: 0,
      },
    ],
  },
  'verify-fallback': {
    goal: '想复检但没给旧账',
    projectPath: 'mock/project',
    evidenceDir,
    players: 1,
    round: 2,
    mode: 'verify',
    depth: 'quick',
  },
  // ── brief 固化 ──
  fresh: {
    goal: '让第三章难度更平滑',
    projectPath: 'mock/project',
    evidenceDir,
    feedback: { text: '第3章太难了' },
    benchmarkRefs: ['MockRefA'],
    players: 4,
    projectRef: 'v9',
    round: 1,
    depth: 'quick',
  },
  reuse: {
    goal: '让第三章难度更平滑',
    projectPath: 'mock/project',
    evidenceDir,
    feedback: { text: '第3章太难了' },
    benchmarkRefs: ['MockRefA'],
    players: 4,
    projectRef: 'v1',
    benchmarkBrief: storedBrief(),
    round: 2,
    history: [
      {
        round: 1,
        scores: Object.fromEntries(DIM_KEYS.map((k) => [k, 3])),
        mustFixCount: 2,
        evidenceBlocked: false,
        hollowDimensions: [],
        coverageGapCount: 0,
        briefRevision: 3,
      },
    ],
  },
  'stale-refs': {
    goal: '让第三章难度更平滑',
    projectPath: 'mock/project',
    evidenceDir,
    feedback: { text: '第3章太难了' },
    benchmarkRefs: ['MockRefA'],
    players: 4,
    benchmarkBrief: storedBrief({ refs: ['OldRef'] }),
    round: 1,
  },
  'stale-version': {
    goal: '让第三章难度更平滑',
    projectPath: 'mock/project',
    evidenceDir,
    feedback: { text: '第3章太难了' },
    benchmarkRefs: ['MockRefA'],
    players: 4,
    projectRef: 'v2',
    benchmarkBrief: storedBrief(),
    round: 1,
  },
  fallback: {
    goal: '让第三章难度更平滑',
    projectPath: 'mock/project',
    evidenceDir,
    feedback: { text: '第3章太难了' },
    benchmarkRefs: ['MockRefA'],
    players: 4,
    benchmarkBrief: storedBrief({ origin: 'fallback', revision: 0, appliesTo: '', dimensions: [] }),
    round: 1,
  },
  partial: {
    goal: '让第三章难度更平滑',
    projectPath: 'mock/project',
    evidenceDir,
    feedback: { text: '第3章太难了' },
    benchmarkRefs: ['MockRefA'],
    players: 4,
    benchmarkBrief: storedBrief({ dimensions: storedBrief().dimensions.slice(0, 2) }),
    round: 2,
    history: [
      {
        round: 1,
        scores: Object.fromEntries(DIM_KEYS.map((k) => [k, 3])),
        mustFixCount: 2,
        evidenceBlocked: false,
        hollowDimensions: [],
        coverageGapCount: 0,
        briefRevision: 3,
      },
    ],
  },
  briefrevised: {
    goal: '让第三章难度更平滑',
    projectPath: 'mock/project',
    evidenceDir,
    feedback: { text: '第3章太难了' },
    benchmarkRefs: ['MockRefA'],
    players: 4,
    projectRef: 'v1',
    benchmarkBrief: storedBrief({ revision: 2 }),
    round: 2,
    history: [
      {
        round: 1,
        scores: Object.fromEntries(DIM_KEYS.map((k) => [k, 3])),
        mustFixCount: 2,
        evidenceBlocked: false,
        hollowDimensions: [],
        coverageGapCount: 0,
        briefRevision: 1,
      },
    ],
  },
  oldhistory: {
    goal: '让第三章难度更平滑',
    projectPath: 'mock/project',
    evidenceDir,
    feedback: { text: '第3章太难了' },
    benchmarkRefs: ['MockRefA'],
    players: 4,
    projectRef: 'v1',
    benchmarkBrief: storedBrief({ revision: 2 }),
    round: 2,
    history: [
      {
        round: 1,
        scores: Object.fromEntries(DIM_KEYS.map((k) => [k, 3])),
        mustFixCount: 2,
        evidenceBlocked: false,
        hollowDimensions: [],
        coverageGapCount: 0,
      },
    ],
  },
  // 参考只增不减 → 增量补维，不整份重研；旧维口径原样保留
  'patch-refs': {
    goal: '让第三章难度更平滑',
    projectPath: 'mock/project',
    evidenceDir,
    feedback: { text: '第3章太难了' },
    benchmarkRefs: ['MockRefA', 'MockRefB'],
    players: 4,
    benchmarkBrief: storedBrief(),
    round: 2,
    history: [
      {
        round: 1,
        scores: Object.fromEntries(DIM_KEYS.map((k) => [k, 3])),
        mustFixCount: 2,
        evidenceBlocked: false,
        hollowDimensions: [],
        coverageGapCount: 0,
        briefRevision: 3,
      },
    ],
  },
  // 增量调研没产出 → 沿用旧 brief，不假装新参考已纳入，文件不写回
  'patch-fail': {
    goal: '让第三章难度更平滑',
    projectPath: 'mock/project',
    evidenceDir,
    feedback: { text: '第3章太难了' },
    benchmarkRefs: ['MockRefA', 'MockRefB'],
    players: 4,
    benchmarkBrief: storedBrief(),
    round: 2,
    history: [
      {
        round: 1,
        scores: Object.fromEntries(DIM_KEYS.map((k) => [k, 3])),
        mustFixCount: 2,
        evidenceBlocked: false,
        hollowDimensions: [],
        coverageGapCount: 0,
        briefRevision: 3,
      },
    ],
  },
  // 传了证据索引：角色应按条目 id 定点取一次切片，不再自己按关键词猜
  evidenceindex: {
    goal: '让第三章难度更平滑',
    projectPath: 'mock/project',
    evidenceDir,
    feedback: { text: '第3章太难了' },
    players: 1,
    round: 1,
    evidenceIndex: [
      {
        id: 'e1',
        kind: 'metric',
        source: 'src/config.js:12',
        tags: ['combat-balance', '数值平衡'],
        summary: 'bossHp = 8',
        lineCount: 4,
      },
      {
        id: 'e2',
        kind: 'metric',
        source: 'src/growth.js:30',
        tags: ['economy-growth', '经济成长'],
        summary: 'goldPerLevel = 1.25',
        lineCount: 3,
      },
      {
        id: 'e3',
        kind: 'command-output',
        source: 'scripts/metrics.js',
        tags: ['sim-output'],
        summary: '模拟输出：第3章通过率 0.42',
        lineCount: 40,
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
    refs: ['MockRefA'],
    fetchedAt: '2026-11-26',
    dimensions: DIM_KEYS.map((k) => ({
      key: k,
      referenceApproach: 'mock 参考做法 ' + k,
      verifiableCriteria: ['能落到数值的核验句 ' + k],
      deductionPoints: ['差在这会掉分 ' + k],
      targetScore: 4,
    })),
    sources: [],
    caveats: 'mock brief',
  }
}

// 增量补维的调研产物：只给改动维，并带 changeReason（无理由的会被当漂移处理）
function mockBriefPatch() {
  const dims = ['combat-balance', 'economy-growth']
  return {
    dimensions: dims.map((k) => ({
      key: k,
      referenceApproach: '新增参考的 mock 做法 ' + k,
      verifiableCriteria: ['增量核验句 ' + k],
      deductionPoints: ['增量扣分点 ' + k],
      targetScore: 4,
      changeReason: '新增参考 MockRefB 在该维的做法有差异',
    })),
    sources: [{ title: 'MockRefB 公开拆解', url: 'https://example.invalid/b' }],
    caveats: 'mock patch',
    fetchedAt: '2026-11-27',
  }
}

function dimEntry(k) {
  const noEvidence =
    CASE === 'simfail' && (k === 'combat-balance' || k === 'economy-growth')
  return {
    key: k,
    status: noEvidence ? 'no-evidence' : 'assessed',
    score: noEvidence ? 0 : 5,
    deductions: [],
    strengths: ['mock 优点 ' + k],
  }
}

const LENS_DIMS = {
  '数值与经济': ['combat-balance', 'economy-growth'],
  地图与内容结构: ['level-topology', 'content-branching', 'boss-variety'],
  趣味结构: ['fun-structure'],
  多人协作: ['co-op-synergy', 'co-op-fun', 'coop-differentiation'],
  意外趣味: ['surprise-fun'],
}

const NAME_TO_KEY = {
  数值平衡: 'combat-balance',
  经济与成长曲线: 'economy-growth',
  地图与关卡结构: 'level-topology',
  收集与分支结构: 'content-branching',
  'Boss 与敌人机制多样性': 'boss-variety',
  趣味性结构代理: 'fun-structure',
  合作性: 'co-op-synergy',
  合作趣味: 'co-op-fun',
  双人差分与对等: 'coop-differentiation',
  突发意外趣味: 'surprise-fun',
  玩家反馈的心理机制: 'feedback-psych',
}

function ownDimsOf(label) {
  const g = Object.entries(LENS_DIMS).find(([n]) => label.includes(n))
  if (g) return g[1]
  const name = label.replace('找茬:', '').trim()
  return NAME_TO_KEY[name] ? [NAME_TO_KEY[name]] : DIM_KEYS
}

const KEY_TO_NAME = Object.fromEntries(Object.entries(NAME_TO_KEY).map(([n, k]) => [k, n]))

function mockLensFindings(label, prompt) {
  const base = ownDimsOf(label)
  // 只看首行「本轮负责 N 个维度：【…】」——维度正文里会提到别的维度名（「归 XX」）
  const head = String(prompt).split('\\n')[0]
  const hit = base.filter((k) => head.includes(KEY_TO_NAME[k]))
  const own = hit.length ? hit : base
  if (CASE === 'not-applicable' && own.includes('boss-variety')) {
    return {
      lens: label,
      dimensions: [
        {
          key: 'boss-variety',
          status: 'not-applicable',
          score: 0,
          deductions: [],
          strengths: [],
          statusNote: '本项目没有 Boss',
        },
      ],
      findings: [],
      coverageGaps: [],
    }
  }
  const findings =
    CASE === 'simfail'
      ? []
      : CASE === 'cap-findings'
        ? Array.from({ length: 12 }, (_, i) => ({
            location: 'data/boss.csv:' + (3 + i),
            problem: '第 ' + (i + 1) + ' 条数值偏差',
            severity: 'should-fix',
            confidence: 0.8,
            evidence: 'mock 证据 ' + (i + 1),
            dimension: 'combat-balance',
            anchorKind: 'numeric-config',
          }))
        : [
            {
              location: 'data/boss.csv:3',
              problem: '第3章敌人HP涨幅超过玩家DPS涨幅',
              severity: 'should-fix',
              confidence: 0.85,
              evidence: '敌人 2400 / 玩家涨幅对应 1600',
              dimension: 'combat-balance',
              anchorKind: 'numeric-config',
            },
          ]
  return {
    lens: label,
    dimensions: own.map(dimEntry),
    findings,
    coverageGaps: [
      { item: '合作收益实测', why: '本轮没跑多人模拟', neededEvidence: '多人协同收益模拟输出' },
    ],
  }
}

function mockTriage() {
  if (CASE === 'triage-fallback') return null
  if (CASE === 'triage-map') {
    return {
      type: 'level-content',
      dimensions: ['level-topology', 'content-branching'],
      adjustments: [{ key: 'content-branching', action: 'add', why: '目标是箱庭谜题，涉及内容分布' }],
      goalCoverage: [
        { item: '视野盲区沙盒', dimension: 'level-topology', note: '地图结构' },
        { item: '双人强制合作', dimension: 'none', note: '不属关卡与内容结构，需另开 coop' },
      ],
      uncoveredGoals: [],
      rationale: 'mock 分诊：关卡与内容结构',
    }
  }
  if (CASE === 'goal-uncovered' || CASE === 'accept-uncovered') {
    return {
      type: 'balance-tuning',
      dimensions: ['combat-balance', 'economy-growth'],
      adjustments: [],
      goalCoverage: [{ item: '打击手感', dimension: 'none', note: '现有维度不测手感' }],
      uncoveredGoals: [
        { item: '打击手感更爽', why: '十一维里没有手感/输入延迟维度', suggestion: '人工拍板或补自定义维度' },
      ],
      rationale: 'mock 分诊：数值平衡，但手感无维可归',
    }
  }
  if (CASE === 'not-applicable') {
    return {
      type: 'boss-encounter',
      dimensions: ['boss-variety'],
      adjustments: [],
      goalCoverage: [{ item: 'Boss 机制', dimension: 'boss-variety', note: 'ok' }],
      uncoveredGoals: [],
      rationale: 'mock 分诊：Boss 遭遇',
    }
  }
  return {
    type: 'full-mixed',
    dimensions: DIM_KEYS,
    adjustments: [],
    goalCoverage: [{ item: 'mock 目标', dimension: 'combat-balance', note: 'mock' }],
    uncoveredGoals: [],
    rationale: 'mock 分诊：全维',
  }
}

function mockVerify(prompt) {
  const ids = prompt.match(/^V\\d+ \\[/gm) || []
  const still = CASE === 'verify-still'
  return {
    items: ids.map((s) => s.split(' ')[0]).map((id) => ({
      id,
      status: still ? 'still-present' : 'fixed',
      evidence: 'mock 复检证据',
      note: still ? 'mock 未修好' : 'mock 已修',
    })),
    touchedDims: [{ key: 'combat-balance', why: 'mock 改动涉及' }],
    summary: 'mock 复检结论',
  }
}

function mockPsych() {
  if (CASE === 'psych-unverified') {
    return {
      mechanismFindings: [],
      unverified: [
        { quote: '玩着没意思', why: '纯情绪，落不到任何数值或代码' },
        { quote: '就是不好玩', why: '纯情绪，落不到任何数值或代码' },
      ],
      strengths: [],
      summary: '两条反馈均无法落到结构锚点',
    }
  }
  return {
    mechanismFindings: [
      {
        feedbackQuote: '第3章太难了，我打不过',
        mechanismType: 'competence',
        mechanism: '胜任感受挫：难度断崖让玩家看不到可行路径',
        brokenNeed: '胜任感',
        structuralAnchor: 'data/boss.csv:3',
        anchorKind: 'numeric-config',
        severity: 'must-fix',
        points: 1,
        evidence: '第3章敌人HP +50% 而玩家DPS只 +20%',
      },
    ],
    unverified: [],
    strengths: ['前期成长节奏获得正面反馈'],
    summary: '核心问题是胜任感受挫',
  }
}

function mockDetail() {
  const hollow =
    CASE === 'normal' || CASE === 'thresholddrift'
      ? [
          {
            dimension: 'fun-structure',
            problem: '只说了反馈密度不足，指不出哪次操作没有反馈',
            whyHollow: '没落到具体操作与反馈链',
            evidence: '镜头结论原文',
          },
        ]
      : []
  const drift =
    CASE === 'thresholddrift'
      ? [
          {
            dimension: 'fun-structure',
            briefCriterion: '偏差必须 <20%',
            lensClaim: '偏差按 <50% 放过',
            why: '找茬者私自放宽阈值',
          },
        ]
      : []
  return {
    hollowFindings: hollow,
    anchorViolations:
      CASE === 'evidenceblocked'
        ? [
            {
              finding: '胜任感受挫',
              quote: '玩家说难 → 结构锚点 data/boss.csv:9',
              why: '该文件只有 5 行，锚点不存在',
            },
          ]
        : [],
    thresholdDrift: drift,
    summary: 'mock 细节结论',
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
  const own = Object.entries(LENS_DIMS).find(([n]) => lens.includes(n))?.[1] || DIM_KEYS
  const dimensions = own.map((k) => ({
    key: k,
    score: CASE === 'stalled' ? 4 : 5,
    notes: 'mock 分片复核',
  }))
  // briefrevised 用例需要至少一条 mustFix，否则会先判 converged、掩盖 brief-revised
  const keep = CASE === 'normal' || CASE === 'stalled' || CASE === 'briefrevised'
  const isNumbers = lens.includes('数值与经济') || lens.includes('数值平衡')
  const verdicts = idsOf(prompt).map((id) =>
    keep && isNumbers
      ? { id, action: 'keep', severity: 'must-fix', reason: 'mock 证据成立' }
      : { id, action: 'drop', reason: 'mock 驳回' }
  )
  return { verdicts, dimensions, summary: 'mock 分片结论' }
}

function mockFinalJudge() {
  return { mergeClusters: [], severityOverrides: [], summary: 'mock 汇流总结' }
}

async function agent(prompt, opts = {}) {
  const label = String(opts.label || '')
  agentCalls.push({
    label,
    agentType: opts.agentType || '',
    phase: opts.phase || '',
    promptLen: prompt.length,
    prompt: prompt,
    schemaRequired: opts.schema?.required || [],
  })
  // 先判更具体的前缀：分片判卷的 label 里也带「找茬」，顺序反了会被镜头 mock 抢走
  if (label.startsWith('分片判卷')) return mockShardJudge(prompt, label)
  if (label.startsWith('汇流')) return mockFinalJudge()
  if (label.startsWith('分诊')) return mockTriage()
  if (label.startsWith('复检')) return mockVerify(prompt)
  if (label.includes('调研')) {
    if (CASE === 'researchfail') return null
    if (label.includes('增量')) return CASE === 'patch-fail' ? null : mockBriefPatch()
    return mockBrief()
  }
  if (label.includes('心理机制')) return mockPsych()
  if (label.includes('找茬')) return mockLensFindings(label, prompt)
  if (label.includes('评审')) return mockDetail()
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
const logs = []
function log(m) {
  logs.push(String(m))
  console.log('[log] ' + m)
}

const args = ${JSON.stringify(argsByCase[caseName] || argsByCase.normal)}

const failures = []
function assert(cond, msg) {
  if (!cond) {
    failures.push(msg)
    console.error('[FAIL] ' + msg)
  }
}

async function __run() {
${body}
}

__run()
  .then((r) => {
    console.log('=== RESULT ===')
    console.log(JSON.stringify(r, null, 2))
    console.log('=== AGENT CALLS ===')
    console.log(JSON.stringify(agentCalls, null, 2))

    const lensCalls = agentCalls.filter((c) => c.label.startsWith('找茬:'))
    const detailCalls = agentCalls.filter((c) => c.label.includes('评审'))
    assert(!agentCalls.some((c) => c.label.includes('取证')), 'evidence agent must not run inside workflow')
    assert(
      lensCalls.every((c) => c.prompt.includes('get_evidence_slice') && c.prompt.includes(${JSON.stringify(evidenceDir)})),
      'lens prompt should carry evidenceDir + get_evidence_slice pointer'
    )

    if (CASE === 'nogoal') {
      assert(r.error === 'missing args.goal', 'expected missing args.goal, got ' + r.error)
    } else if (CASE === 'noevidence') {
      assert(r.error === 'missing args.evidenceDir', 'expected missing args.evidenceDir, got ' + r.error)
    } else if (CASE === 'researchfail') {
      assert(!/参考做法（/.test(r.handoff), 'researchfail: must not paste placeholder as advice')
      assert(r.handoff.includes('本轮无有效基准 brief'), 'researchfail: should state no valid brief')
      assert(r.briefStatus === 'unused', 'researchfail: placeholder brief must not be persisted')
    } else if (CASE === 'nogoal' || CASE === 'noevidence') {
      // 早退分支没有 briefStatus，跳过固化断言
    } else if (CASE === 'fresh') {
      assert(r.briefStatus === 'researched', 'fresh: briefStatus should be researched')
      assert(r.briefRevision === 1, 'fresh: revision should be 1, got ' + r.briefRevision)
      assert(r.benchmarkBrief && r.benchmarkBrief.origin === 'research', 'fresh: origin should be research')
      assert(r.benchmarkBrief && r.benchmarkBrief.appliesTo === 'v9', 'fresh: appliesTo should be projectRef')
      assert(
        r.benchmarkBrief && r.benchmarkBrief.fetchedAt === '2026-11-26',
        'fresh: fetchedAt should come from research agent'
      )
      assert(r.briefPath === '.critic/benchmark-design.json', 'fresh: briefPath should be design file')
      const researchCalls = agentCalls.filter((c) => c.label.includes('调研')).length
      assert(researchCalls === 1, 'fresh: research should run once, got ' + researchCalls)
    } else if (CASE === 'reuse') {
      assert(r.briefStatus === 'reused', 'reuse: briefStatus should be reused')
      assert(r.briefRevision === 3, 'reuse: revision should stay 3, got ' + r.briefRevision)
      const researchCalls = agentCalls.filter((c) => c.label.includes('调研')).length
      assert(researchCalls === 0, 'reuse: must not re-research, got ' + researchCalls)
      assert(
        r.benchmarkBrief && r.benchmarkBrief.dimensions[0].referenceApproach === '文件里的参考做法 combat-balance',
        'reuse: should use stored dimensions'
      )
    } else if (CASE === 'stale-refs') {
      assert(r.briefStatus === 'stale-researched', 'stale-refs: should be stale-researched')
      assert(r.briefRevision === 4, 'stale-refs: revision should be 4, got ' + r.briefRevision)
      const researchCalls = agentCalls.filter((c) => c.label.includes('调研')).length
      assert(researchCalls === 1, 'stale-refs: should re-research, got ' + researchCalls)
    } else if (CASE === 'stale-version') {
      assert(r.briefStatus === 'stale-researched', 'stale-version: should be stale-researched')
      assert(r.briefRevision === 4, 'stale-version: revision should be 4, got ' + r.briefRevision)
    } else if (CASE === 'fallback') {
      assert(r.briefStatus === 'stale-researched', 'fallback: fallback brief should trigger re-research')
      assert(r.briefRevision === 1, 'fallback: revision should be 1, got ' + r.briefRevision)
      assert(r.benchmarkBrief && r.benchmarkBrief.origin === 'research', 'fallback: re-researched brief origin=research')
    } else if (CASE === 'partial') {
      assert(r.briefStatus === 'reused', 'partial: should reuse stored brief')
      assert(
        r.benchmarkBrief && r.benchmarkBrief.dimensions.length === 11,
        'partial: missing dims should be backfilled to 11, got ' +
          (r.benchmarkBrief && r.benchmarkBrief.dimensions.length)
      )
      assert(
        r.benchmarkBrief &&
          r.benchmarkBrief.dimensions.some(
            (d) => d.key === 'surprise-fun' && String(d.referenceApproach).includes('基准未覆盖')
          ),
        'partial: backfilled dim should carry placeholder'
      )
    } else if (CASE === 'briefrevised') {
      assert(r.stopReason === 'brief-revised', 'briefrevised: stopReason should be brief-revised')
      assert(
        r.progressRecord && r.progressRecord.briefRevision === 2,
        'briefrevised: progressRecord.briefRevision should be 2'
      )
    } else if (CASE === 'oldhistory') {
      assert(r.stopReason !== 'brief-revised', 'oldhistory: missing briefRevision must not trigger brief-revised')
      assert(
        r.progressRecord && r.progressRecord.briefRevision === 2,
        'oldhistory: progressRecord.briefRevision should be current revision'
      )
    } else if (CASE === 'patch-refs') {
      assert(r.briefStatus === 'patched-researched', 'patch-refs: should be patched-researched, got ' + r.briefStatus)
      assert(r.briefMode === 'patch', 'patch-refs: briefMode should be patch, got ' + r.briefMode)
      assert(r.briefRevision === 4, 'patch-refs: revision should be 4, got ' + r.briefRevision)
      assert(
        r.benchmarkBrief && r.benchmarkBrief.refs.length === 2 && r.benchmarkBrief.refs.includes('MockRefB'),
        'patch-refs: refs should include both'
      )
      assert(
        Array.isArray(r.briefAffectedDims) &&
          r.briefAffectedDims.length === 2 &&
          r.briefAffectedDims.includes('combat-balance') &&
          r.briefAffectedDims.includes('economy-growth'),
        'patch-refs: briefAffectedDims should be the two rewritten dims, got ' + JSON.stringify(r.briefAffectedDims)
      )
      assert(r.stopReason !== 'brief-revised', 'patch-refs: incremental round must not stop as brief-revised')
      const patchCalls = agentCalls.filter((c) => c.label.includes('增量')).length
      const fullCalls = agentCalls.filter((c) => c.label === '调研:基准brief').length
      assert(patchCalls === 1, 'patch-refs: incremental research should run once, got ' + patchCalls)
      assert(fullCalls === 0, 'patch-refs: full research must not run, got ' + fullCalls)
      const kept = (r.benchmarkBrief?.dimensions ?? []).find((d) => d.key === 'level-topology')
      assert(
        kept && kept.referenceApproach === '文件里的参考做法 level-topology',
        'patch-refs: untouched dim must keep stored wording, got ' + kept?.referenceApproach
      )
      const patched = (r.benchmarkBrief?.dimensions ?? []).find((d) => d.key === 'combat-balance')
      assert(
        patched && String(patched.referenceApproach).includes('新增参考'),
        'patch-refs: rewritten dim should carry new wording, got ' + patched?.referenceApproach
      )
      const ch = (r.benchmarkBrief?.changes ?? []).slice(-1)[0]
      assert(
        ch && ch.mode === 'patch' && (ch.refsAdded ?? []).includes('MockRefB') &&
          (ch.rewrittenDims ?? []).some((d) => d.key === 'combat-balance' && d.reason),
        'patch-refs: changes should record patch mode, added refs and reasons'
      )
    } else if (CASE === 'evidenceindex') {
      assert(
        lensCalls.every((c) => c.prompt.includes('证据切片（定点取')),
        'evidenceindex: lens prompts should use the pick block'
      )
      assert(
        !lensCalls.some((c) => c.prompt.includes('本轮建议关键词')),
        'evidenceindex: lens prompts must not fall back to keyword guessing'
      )
      const numbers = lensCalls.find((c) => c.label.includes('数值平衡'))
      assert(
        numbers && numbers.prompt.includes('"e1"'),
        'evidenceindex: numbers lens should get the combat metric id'
      )
      const economy = lensCalls.find((c) => c.label.includes('经济与成长'))
      assert(
        economy && economy.prompt.includes('"e2"'),
        'evidenceindex: economy lens should get the economy metric id'
      )
      assert(
        numbers && !numbers.prompt.includes('"e3"'),
        'evidenceindex: unrelated sim entry must not be pushed to the numbers lens'
      )
      assert(
        numbers && numbers.prompt.includes('只调**一次** get_evidence_slice'),
        'evidenceindex: pick block should cap the slice call to once'
      )
      const detail = agentCalls.filter((c) => c.label.includes('评审'))
      assert(
        detail.length > 0 && detail.every((c) => c.prompt.includes('证据切片（定点取')),
        'evidenceindex: detail judge should use the pick block'
      )
      assert(
        detail.every((c) => !c.prompt.includes('本轮建议关键词')),
        'evidenceindex: detail judge must not keyword-guess'
      )
      const judge = agentCalls.filter((c) => c.label.startsWith('分片判卷'))
      assert(
        judge.length > 0 && judge.every((c) => c.prompt.includes('证据切片（定点取')),
        'evidenceindex: shard judge should use the pick block'
      )
      const fun = lensCalls.find((c) => c.prompt.includes('趣味性结构代理'))
      assert(
        fun && fun.prompt.includes('索引里没有与本维直接对应的条目'),
        'evidenceindex: unmatched dim should fall back to a single query hint'
      )
    } else if (CASE === 'patch-fail') {
      assert(r.briefStatus === 'reused', 'patch-fail: should fall back to reused, got ' + r.briefStatus)
      assert(r.briefPatchFailed === true, 'patch-fail: briefPatchFailed should be true')
      assert(r.briefRevision === 3, 'patch-fail: revision must not bump, got ' + r.briefRevision)
      assert(
        r.benchmarkBrief && r.benchmarkBrief.dimensions.length === 11,
        'patch-fail: old brief dims should be kept and normalized'
      )
      const patchCalls = agentCalls.filter((c) => c.label.includes('增量')).length
      assert(patchCalls === 1, 'patch-fail: incremental research should be attempted once, got ' + patchCalls)
    } else {
      assert(!r.error, 'unexpected error: ' + r.error)
      if (CASE === 'normal') {
        assert(r.activeDimKeys.length === 11, 'normal: activeDims should be 11, got ' + r.activeDimKeys.length)
        assert(lensCalls.length === 6, 'normal: 6 lenses expected, got ' + lensCalls.length)
        assert(r.type === 'full-mixed', 'normal: triage should map to full-mixed, got ' + r.type)
        assert(detailCalls.length === 1, 'normal: detail judge expected')
        assert(r.converged === false, 'normal: should not converge')
        assert(
          r.mustFix.length === 2,
          'normal: 2 mustFix expected (judge + hollow), got ' + r.mustFix.length
        )
        assert(
          r.mustFix.some((f) => f.fromLens === '细节评委' && f.dimension === 'fun-structure'),
          'normal: hollow finding should be forced into mustFix'
        )
        const psy = r.dimensions.find((d) => d.key === 'feedback-psych')
        assert(psy && psy.status === 'assessed', 'normal: psych dim should be assessed')
        assert(
          psy && psy.deductions.length === 1 && psy.deductions[0].points === 1,
          'normal: psych deduction should land on the dimension (score 5-1)'
        )
        assert(psy && psy.score === 4, 'normal: psych score should be 4, got ' + (psy && psy.score))
        const fs = r.dimensions.find((d) => d.key === 'fun-structure')
        assert(fs && fs.hollow === true, 'normal: fun-structure should be hollow')
        assert(fs && fs.score <= 3, 'normal: hollow dim should be capped at 3, got ' + (fs && fs.score))
        const belowCount = r.dimensions.filter(
          (d) => d.status === 'assessed' && d.score !== null && d.score < d.target
        ).length
        const hintCount = (r.handoff.match(/参考做法（MockRefA）/g) || []).length
        assert(hintCount > 0, 'normal: handoff should carry reference hints')
        assert(hintCount === belowCount, 'normal: hints should only sit on below-target dims (' + hintCount + ' vs ' + belowCount + ')')
      }
      if (CASE === 'solo-nofeedback') {
        assert(r.activeDimKeys.length === 6, 'solo: 6 dims expected, got ' + r.activeDimKeys.length)
        assert(lensCalls.length === 6, 'solo: explore defaults to full depth (6 lenses), got ' + lensCalls.length)
        assert(!lensCalls.some((c) => c.label.includes('反馈心理机制')), 'solo: psych lens should not run')
        assert(!r.dimensions.some((d) => d.key.startsWith('co-op-') || d.key === 'coop-differentiation'), 'solo: co-op dims must be absent')
      }
      if (CASE === 'triage-map') {
        assert(r.type === 'level-content', 'triage-map: type should be level-content, got ' + r.type)
        assert(r.activeDimKeys.length === 2, 'triage-map: 2 dims expected, got ' + JSON.stringify(r.activeDimKeys))
        assert(lensCalls.length === 1, 'triage-map: structure group is one lens, got ' + lensCalls.length)
        assert(r.goalCoverage.some((g) => g.dimension === 'none'), 'triage-map: goalCoverage should keep the none row')
      }
      if (CASE === 'triage-fallback') {
        assert(r.triageFallback === true, 'triage-fallback: flag should be true')
        assert(r.type === 'full-mixed', 'triage-fallback: should fall back to full-mixed')
        assert(r.activeDimKeys.length === 6, 'triage-fallback: 6 active (no feedback), got ' + r.activeDimKeys.length)
        assert(logs.some((l) => l.includes('兜底')), 'triage-fallback: should log fallback')
      }
      if (CASE === 'goal-uncovered') {
        assert(r.stopReason === 'goal-uncovered', 'goal-uncovered: stopReason should be goal-uncovered, got ' + r.stopReason)
        assert(r.converged === false, 'goal-uncovered: must not converge')
        assert(r.uncoveredGoals.length === 1, 'goal-uncovered: 1 uncovered goal expected')
        assert(r.handoff.includes('目标没有维度接住'), 'goal-uncovered: handoff should surface it')
        assert(r.progressRecord.uncoveredGoals.length === 1, 'goal-uncovered: must persist into progressRecord')
      }
      if (CASE === 'accept-uncovered') {
        assert(r.uncoveredGoals.length === 0, 'accept-uncovered: uncovered should be cleared')
        assert(r.acceptedUncovered === true, 'accept-uncovered: flag should be echoed')
        assert(r.stopReason === 'converged', 'accept-uncovered: should converge, got ' + r.stopReason)
      }
      if (CASE === 'scope') {
        assert(r.scope && r.scope.label === '第三章', 'scope: scope should be echoed')
        assert(
          lensCalls.every((c) => c.prompt.includes('本轮聚焦切片')),
          'scope: lens prompts should carry the scope block'
        )
      }
      if (CASE === 'not-applicable') {
        const bv = r.dimensions.find((d) => d.key === 'boss-variety')
        assert(bv && bv.status === 'not-applicable', 'not-applicable: dim status expected')
        assert(r.notApplicable.length === 1, 'not-applicable: should be listed separately')
        assert(r.converged === true, 'not-applicable: must not block convergence')
        assert(r.handoff.includes('不适用'), 'not-applicable: handoff should say so')
      }
      if (CASE === 'cap-findings') {
        assert(logs.some((l) => l.includes('已截断 4 条')), 'cap-findings: 12-8 should be truncated and logged')
        assert(r.confirmed.length === 0, 'cap-findings: mock judge drops all')
      }
      if (CASE === 'verify-fixed') {
        assert(r.mode === 'verify', 'verify-fixed: mode should stay verify')
        assert(r.touchedDims.includes('combat-balance'), 'verify-fixed: touched should include combat-balance')
        assert(r.carriedDims.length === 8, 'verify-fixed: 8 untouched dims should be carried, got ' + r.carriedDims.length)
        assert(r.carriedDims.includes('economy-growth'), 'verify-fixed: economy stays carried (filtered out of the numbers lens)')
        assert(r.converged === true, 'verify-fixed: should converge, got ' + r.stopReason)
      }
      if (CASE === 'verify-still') {
        assert(r.mode === 'verify', 'verify-still: mode should stay verify')
        assert(r.verifier && r.verifier.items.every((x) => x.status === 'still-present'), 'verify-still: verdicts')
        assert(r.converged === false, 'verify-still: old open items must block convergence')
        assert(r.handoff.includes('【复检结论】'), 'verify-still: handoff should carry the verify section')
      }
      if (CASE === 'verify-fallback') {
        assert(r.mode === 'explore', 'verify-fallback: should downgrade to explore')
        assert(r.verifyFallback === true, 'verify-fallback: flag should be true')
      }
      if (CASE === 'forced-dim') {
        assert(
          r.activeDimKeys.length === 1 && r.activeDimKeys[0] === 'surprise-fun',
          'forced: only surprise-fun expected, got ' + JSON.stringify(r.activeDimKeys)
        )
        assert(lensCalls.length === 1, 'forced: 1 lens expected, got ' + lensCalls.length)
      }
      if (CASE === 'simfail') {
        assert(r.evidence.dir === ${JSON.stringify(evidenceDir)}, 'simfail: evidence should only carry dir')
        assert(r.evidenceIntegrity.blocked === false, 'simfail: must not be blocked')
        assert(r.stopReason !== 'evidence-blocked', 'simfail: stopReason must not be evidence-blocked')
        const noEv = r.dimensions.filter((d) => d.status === 'no-evidence')
        assert(noEv.length === 2, 'simfail: 2 no-evidence dims expected, got ' + noEv.length)
      }
      if (CASE === 'thresholddrift') {
        const fs = r.dimensions.find((d) => d.key === 'fun-structure')
        assert(fs && fs.hollow === true, 'drift: fun-structure should be hollow')
        assert(fs && fs.score === 3, 'drift: hollow dim score should be exactly 3, got ' + (fs && fs.score))
        assert(r.thresholdDrift.length === 1, 'drift: thresholdDrift should have 1 entry')
      }
      if (CASE === 'evidenceblocked') {
        assert(r.evidenceIntegrity.blocked === true, 'blocked: evidenceIntegrity.blocked should be true')
        assert(r.stopReason === 'evidence-blocked', 'blocked: stopReason should be evidence-blocked')
      }
      if (CASE === 'converged') {
        assert(r.converged === true, 'converged: should be true')
        assert(r.stopReason === 'converged', 'converged: stopReason should be converged')
      }
      if (CASE === 'stalled') {
        assert(r.stopReason === 'stalled', 'stalled: stopReason should be stalled, got ' + r.stopReason)
      }
      if (CASE === 'psych-unverified') {
        assert(r.unverifiedFeedback.length === 2, 'psych: 2 unverified expected')
        const p = r.dimensions.find((d) => d.key === 'feedback-psych')
        assert(p && p.status === 'no-evidence' && p.exempt === true, 'psych: dim should be no-evidence + exempt')
        assert(r.converged === true, 'psych: unverified feedback must not block convergence')
      }
      assert(r.progressRecord && typeof r.progressRecord === 'object', 'progressRecord missing')
      assert(typeof r.handoff === 'string' && r.handoff.length > 0, 'handoff should be a non-empty string')
    }

    if (failures.length) {
      console.error('[FAIL] case=' + CASE + ' count=' + failures.length)
      process.exit(1)
    }
    console.log('[ok] case=' + CASE)
  })
  .catch((e) => {
    console.error('=== THROWN ===')
    console.error(e && e.stack ? e.stack : e)
    process.exit(1)
  })
`

fs.writeFileSync(path.join(__dirname, '_dryrun-design-round.generated.cjs'), harness, 'utf8')
require('./_dryrun-design-round.generated.cjs')