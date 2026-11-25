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
  'fun-structure',
  'co-op-synergy',
  'co-op-fun',
  'surprise-fun',
  'feedback-psych',
]

const simPlan = {
  run: 'node sim/ttk.mjs',
  workdir: '.',
  outputDir: 'mock/out',
  checks: [{ name: 'ttk', command: 'node sim/ttk.mjs' }],
  codePaths: ['data/boss.csv'],
}

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
    simPlan,
    feedback: { text: '第3章太难了，我打不过', files: ['feedback/r1.txt'] },
    benchmarkRefs: ['MockRefA'],
    players: 4,
    round: 1,
    depth: 'quick',
  },
  researchfail: {
    goal: '基准调研失败的降级验证',
    projectPath: 'mock/project',
    simPlan,
    players: 1,
    benchmarkRefs: ['MockRefA'],
    round: 1,
    depth: 'quick',
  },
  'solo-nofeedback': {
    goal: '单人模式下数值更平滑',
    projectPath: 'mock/project',
    simPlan,
    players: 1,
    round: 1,
  },
  'forced-dim': {
    goal: '单机也要有意外惊喜',
    projectPath: 'mock/project',
    simPlan,
    players: 1,
    dimensions: ['surprise-fun'],
    round: 1,
  },
  nogoal: {
    projectPath: 'mock/project',
    simPlan,
    players: 1,
  },
  noevidence: {
    goal: '随便看看',
    players: 1,
  },
  simfail: {
    goal: '看战斗数值',
    projectPath: 'mock/project',
    simPlan: { ...simPlan, run: 'node sim/broken.mjs' },
    players: 1,
    round: 1,
  },
  thresholddrift: {
    goal: '让趣味结构更扎实',
    projectPath: 'mock/project',
    simPlan,
    players: 1,
    round: 1,
  },
  evidenceblocked: {
    goal: '核对数值结论',
    projectPath: 'mock/project',
    simPlan,
    feedback: { text: '怪太肉了' },
    players: 1,
    round: 1,
  },
  converged: {
    goal: '数值与趣味都达标',
    projectPath: 'mock/project',
    simPlan,
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
    simPlan,
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
    simPlan,
    feedback: { text: '玩着没意思\n就是不好玩' },
    players: 1,
    round: 1,
  },
  // ── brief 固化 ──
  fresh: {
    goal: '让第三章难度更平滑',
    projectPath: 'mock/project',
    simPlan,
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
    simPlan,
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
    simPlan,
    feedback: { text: '第3章太难了' },
    benchmarkRefs: ['MockRefA'],
    players: 4,
    benchmarkBrief: storedBrief({ refs: ['OldRef'] }),
    round: 1,
  },
  'stale-version': {
    goal: '让第三章难度更平滑',
    projectPath: 'mock/project',
    simPlan,
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
    simPlan,
    feedback: { text: '第3章太难了' },
    benchmarkRefs: ['MockRefA'],
    players: 4,
    benchmarkBrief: storedBrief({ origin: 'fallback', revision: 0, appliesTo: '', dimensions: [] }),
    round: 1,
  },
  partial: {
    goal: '让第三章难度更平滑',
    projectPath: 'mock/project',
    simPlan,
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
    simPlan,
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
    simPlan,
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

function mockEvidence() {
  const fail = CASE === 'simfail'
  return {
    executed: true,
    commands: [
      {
        command: fail ? 'node sim/broken.mjs' : 'node sim/ttk.mjs',
        exitCode: fail ? 1 : 0,
        output: fail ? 'Error: Cannot find module sim/broken.mjs' : 'ttk mean 12.4s',
      },
    ],
    metrics: fail ? [] : [{ name: 'ttk', command: 'node sim/ttk.mjs', output: 'ttk mean 12.4s' }],
    numericAnchors: fail
      ? []
      : [
          {
            name: '第3章敌人HP',
            path: 'data/boss.csv:3',
            observation: '2400',
            deviation: '+50% vs 玩家DPS涨幅',
          },
        ],
    notes: fail ? '模拟命令失败，未取得数值' : 'mock 取证完成',
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
  趣味结构: ['fun-structure'],
  多人协作: ['co-op-synergy', 'co-op-fun'],
  突发意外: ['surprise-fun'],
}

function mockLensFindings(label) {
  const own = Object.entries(LENS_DIMS).find(([n]) => label.includes(n))?.[1] || DIM_KEYS
  return {
    lens: label,
    dimensions: own.map(dimEntry),
    findings:
      CASE === 'simfail'
        ? []
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
          ],
    coverageGaps: [
      { item: '合作收益实测', why: '本轮没跑多人模拟', neededEvidence: '多人协同收益模拟输出' },
    ],
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
  const isNumbers = lens.includes('数值与经济')
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
    schemaRequired: opts.schema?.required || [],
  })
  // 先判更具体的前缀：分片判卷的 label 里也带「找茬」，顺序反了会被镜头 mock 抢走
  if (label.startsWith('分片判卷')) return mockShardJudge(prompt, label)
  if (label.startsWith('汇流')) return mockFinalJudge()
  if (label.includes('调研')) return CASE === 'researchfail' ? null : mockBrief()
  if (label.includes('取证')) return mockEvidence()
  if (label.includes('反馈心理机制')) return mockPsych()
  if (label.includes('找茬')) return mockLensFindings(label)
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
function log(m) { console.log('[log] ' + m) }

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

    if (CASE === 'nogoal') {
      assert(r.error === 'missing args.goal', 'expected missing args.goal, got ' + r.error)
    } else if (CASE === 'noevidence') {
      assert(String(r.error || '').startsWith('missing evidence'), 'expected missing evidence, got ' + r.error)
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
        r.benchmarkBrief && r.benchmarkBrief.dimensions.length === 7,
        'partial: missing dims should be backfilled to 7, got ' +
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
    } else {
      assert(!r.error, 'unexpected error: ' + r.error)
      if (CASE === 'normal') {
        assert(r.activeDimKeys.length === 7, 'normal: activeDims should be 7, got ' + r.activeDimKeys.length)
        assert(lensCalls.length === 5, 'normal: 5 lenses expected, got ' + lensCalls.length)
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
        assert(r.activeDimKeys.length === 3, 'solo: 3 dims expected, got ' + r.activeDimKeys.length)
        assert(lensCalls.length === 2, 'solo: 2 lenses expected, got ' + lensCalls.length)
        assert(!lensCalls.some((c) => c.label.includes('反馈心理机制')), 'solo: psych lens should not run')
        assert(!r.dimensions.some((d) => d.key.startsWith('co-op-')), 'solo: co-op dims must be absent')
      }
      if (CASE === 'forced-dim') {
        assert(
          r.activeDimKeys.length === 1 && r.activeDimKeys[0] === 'surprise-fun',
          'forced: only surprise-fun expected, got ' + JSON.stringify(r.activeDimKeys)
        )
        assert(lensCalls.length === 1, 'forced: 1 lens expected, got ' + lensCalls.length)
      }
      if (CASE === 'simfail') {
        assert(r.evidence.commands[0].exitCode === 1, 'simfail: exitCode should be 1')
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