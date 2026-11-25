// design-round.js —— 一轮游戏设计挑刺（设计档）
//
// 定位：对「游戏设计本身」做迭代式挑刺——数值平衡、经济成长、趣味结构、
//       多人合作、突发意外、玩家反馈背后的心理机制。只挑刺，不改设计；
//       一次调用 = 一轮，多轮由调度员驱动。
//
// 本档最硬的一条设计：**只查结构代理指标**。
//   AI 没法真玩一局说「不爽」，所以每条缺陷必须落到具体数值 / 模拟输出 / 代码位置 /
//   参考作品口径上。玩家反馈允许进来，但**不许当证据用**——必须先映射到心理学机制，
//   再由机制落到结构锚点（schema 的 anchorKind 物理禁止 feedback）。
//
// 内部层次：
//   ① 基准调研（可选）：把参考作品转成逐维可核验口径（基准 brief）
//   ② 取证：执行调用方给的 simPlan（跑模拟、读数值表），产出 numericAnchors
//   ③ 找茬：activeDims 按镜头分组并行逐维找茬并自评扣分；
//      玩家反馈那一路改用心理机制 schema；细节评委同批并行审假达标与证据造假
//   ④ 判卷：每镜头一个分片判卷（引用式输出）→ 脚本合并 → 轻量汇流收口
//   ⑤ 收敛：脚本按双闸门判定收敛 / 停滞 / 硬停
//
// 硬约束（写在代码里，不靠自觉）：
//   - 插件不含任何游戏名、项目路径或模拟脚本；基准与取证全由调用方传
//   - 分析者 / 细节评委 / 判卷均无写工具，物理改不了项目文件
//   - 判卷必须分片：单次吃下全部镜头结果再吐全部终裁，镜头一多就会被上游
//     单次输出上限截断（画面档实测 8 路时整轮报废）
//   - agentType 必须带 `critic-pipeline:` 插件前缀，否则换仓库即报 not found
//   - 模型写死在 agent 文件 frontmatter（model:），脚本不逐个传 model
//   - 所有带 schema 的子代理，prompt 末尾写死「必须调用 StructuredOutput」
//   - 评分 = 扣分表：5 - 扣分合计；脚本按扣分项重算，不信手填总分
//   - 玩家反馈不得作为结构证据：anchorKind 枚举里没有 feedback 这一项
//   - 证据造假硬阻断：细节评委抽查锚点与真实配置对不上 → 本轮不算达标

export const meta = {
  name: 'design-round',
  description: '一轮游戏设计挑刺：基准调研 → 取证（数值/模拟） → 逐维找茬（含玩家反馈的心理机制解析）+ 细节评委 → 分片判卷与汇流 → 扣分表与收敛判定。只挑刺不改设计。',
  phases: [
    { title: '基准调研', detail: '无基准 brief 且有参考作品时，把它转成逐维可核验口径' },
    { title: '取证', detail: '执行调用方给的 simPlan，跑模拟、读数值表，产出数值锚点' },
    { title: '找茬', detail: '按维度并行找茬并自评扣分；玩家反馈一路做心理机制解析；细节评委审假达标与证据造假' },
    { title: '判卷', detail: '每镜头一片分片判卷（引用式），脚本按编号回填正文' },
    { title: '汇流', detail: '轻量判卷跨片去重、统一严重度、写总结；证据造假由脚本硬阻断' },
    { title: '收敛', detail: '脚本按双闸门判定收敛 / 停滞 / 硬停' },
  ],
}

// 入参归一：本机构建实测，Workflow 工具把 args 以 JSON 字符串传进来（不是对象），
// 直接 args?.x 永远取不到值。这里统一解析成对象，正文一律用 A。
const A = (() => {
  if (args && typeof args === 'object') return args
  if (typeof args === 'string' && args.trim()) {
    try { return JSON.parse(args) } catch (e) { return {} }
  }
  return {}
})()

// ─────────────────────────────────────────────────────────────
// 入参（由调度员传）：
//   args.goal            字符串 —— 本轮想改善什么 / 设计方向，必填
//   args.projectPath     字符串 —— 项目根；读数值配置与代码的起点，可选
//   args.simPlan         对象   —— 取证与模拟计划，强烈建议给：
//                                  { run?, workdir?, outputDir?, checks[{name,command}], codePaths[] }
//   args.feedback        对象|串 —— 玩家反馈：{ text?, files?[] } 或直接字符串，可选
//   args.benchmarkRefs   数组   —— 参考作品名，可选；有则调研出基准 brief
//   args.players         数     —— 游玩人数，默认 1；>=2 才自动开合作/意外两族
//   args.dimensions      数组   —— 显式维度白名单，可越闸；给了就只跑这些
//   args.known           数组   —— 已知未修项，可选
//   args.round           数     —— 第几轮，默认 1
//   args.maxRounds       数     —— 硬停轮数，默认 4
//   args.history         数组   —— 往轮 progressRecord，可选
//   args.benchmarkBrief  对象   —— 跨轮复用的基准 brief，可选；不传且有参考作品则本轮先调研
//   args.depth           字符串 —— quick（默认，分组合并）/ full（逐维分路），可选
//   args.targetScores    对象   —— 逐维目标分覆盖，可选；默认 4
//   args.projectContext  字符串 —— 项目上下文（引擎/品类/目标玩家），可选
// ─────────────────────────────────────────────────────────────

const DEFAULT_TARGET = 4
const MAX_ROUNDS_DEFAULT = 4

// 游戏设计七维（顺序即报告顺序）。minPlayers 缺省 1。
const DIMENSIONS = [
  {
    key: 'combat-balance',
    name: '数值平衡',
    minPlayers: 1,
    prompt:
      '看战斗与对抗数值是否「站得住」：TTK/伤害曲线的分布、玩家成长斜率与敌人强度是否匹配、' +
      '有没有极值离群（某武器/技能/敌人一枝独秀）、难度曲线有无断崖。' +
      '必须给出实测或手算的偏差数字，禁止「感觉不平」这类空话。',
  },
  {
    key: 'economy-growth',
    name: '经济与成长曲线',
    minPlayers: 1,
    prompt:
      '看资源与成长是否「咬合」：产出/消耗漏斗是否闭合、有无通胀或死水、' +
      '成长坡度与内容解锁节奏是否匹配、有没有某阶段完全无产出的卡点。' +
      '必须指到具体数值表与公式，给出量化偏差。',
  },
  {
    key: 'fun-structure',
    name: '趣味性结构代理',
    minPlayers: 1,
    prompt:
      '只查结构，不评「好不好玩」：反馈密度（每次操作有多少即时反馈）、' +
      '决策分支（同一情境是否有 ≥2 条有效路径）、失败惩罚强度、节奏峰谷、' +
      '目标梯度（下一目标是否始终可见）。每条缺陷必须指到机制或数值，说不出结构就不扣。',
  },
  {
    key: 'co-op-synergy',
    name: '合作性',
    minPlayers: 2,
    prompt:
      '看多人协作是否「必要且划算」：角色/职业互补是否不可替代（单人能否替代）、' +
      '协同收益是否明显大于各自为战、责任分担是否清晰、有没有搭便车漏洞。' +
      '只查结构与数值，不评主观感受。',
  },
  {
    key: 'co-op-fun',
    name: '合作趣味',
    minPlayers: 2,
    prompt:
      '只查结构：沟通是否必要（不沟通是否就打不过）、是否有共享决策与互相救场时刻、' +
      '社交涌现空间有多大、失败是否共担。每条都要落到机制，不评「感觉热闹」。',
  },
  {
    key: 'surprise-fun',
    name: '突发意外趣味',
    minPlayers: 2,
    prompt:
      '看随机与意外是否「有趣而不恼人」：随机事件的好坏比是否失衡、意外是否可控（可否应对）、' +
      '有没有戏剧性翻盘时刻、随机是否退化成纯惩罚。必须指到随机表/概率配置。',
  },
  {
    key: 'feedback-psych',
    name: '玩家反馈的心理机制',
    minPlayers: 1,
    prompt:
      '仅在传入玩家反馈时启用。把每条反馈映射到具体心理机制（自我决定论三需求：自主/胜任/关联；' +
      '心流；损失厌恶；可变比率强化；沉没成本；峰终定律），再落到结构锚点。' +
      '无法落锚的归未验证，不计分。玩家的情绪不能直接当证据。',
  },
]

// 默认分组镜头：每路盯相关几维；depth=full 时拆成逐维一路。
// 注意：玩家反馈那一路（psych）schema 与常规逐维不同，必须单独成路，不并进 fun 组。
const LENS_GROUPS = [
  { key: 'numbers', name: '数值与经济', dimKeys: ['combat-balance', 'economy-growth'] },
  { key: 'fun', name: '趣味结构', dimKeys: ['fun-structure'] },
  { key: 'psych', name: '反馈心理机制', dimKeys: ['feedback-psych'], psych: true },
  { key: 'coop', name: '多人协作', dimKeys: ['co-op-synergy', 'co-op-fun'] },
  { key: 'surprise', name: '意外趣味', dimKeys: ['surprise-fun'] },
]

// ── 入参归一 ──
const goal = String(A?.goal ?? '').trim()
const projectPath = String(A?.projectPath ?? '').trim()
const round = Math.max(1, Number(A?.round) || 1)
const maxRounds = Math.max(1, Number(A?.maxRounds) || MAX_ROUNDS_DEFAULT)
const depth = A?.depth === 'full' ? 'full' : 'quick'
const history = Array.isArray(A?.history) ? A.history : []
const known = Array.isArray(A?.known) ? A.known : []
const projectContext = String(A?.projectContext ?? '').trim()
const players = Math.max(1, Number(A?.players) || 1)
const ctxBlock = projectContext
  ? `\n【项目上下文（调用方提供，判断时按此对齐）】\n${projectContext}\n`
  : ''
const targetScores =
  A?.targetScores && typeof A.targetScores === 'object' ? A.targetScores : {}

const benchmarkRefs = (Array.isArray(A?.benchmarkRefs) ? A.benchmarkRefs : [])
  .map((x) => String(x).trim())
  .filter(Boolean)

const rawPlan = A?.simPlan && typeof A.simPlan === 'object' ? A.simPlan : {}
const plan = {
  run: String(rawPlan.run ?? '').trim(),
  workdir: String(rawPlan.workdir ?? '').trim(),
  outputDir: String(rawPlan.outputDir ?? '').trim(),
  checks: (Array.isArray(rawPlan.checks) ? rawPlan.checks : [])
    .filter((c) => c && String(c.command ?? '').trim())
    .map((c) => ({
      name: String(c.name ?? c.command).trim().slice(0, 100),
      command: String(c.command).trim(),
    })),
  codePaths: (Array.isArray(rawPlan.codePaths) ? rawPlan.codePaths : []).map(String).filter(Boolean),
}

// 玩家反馈归一：字符串或 { text, files[] }
const rawFeedback = A?.feedback
let feedbackText = ''
let feedbackFiles = []
if (typeof rawFeedback === 'string') {
  feedbackText = rawFeedback.trim()
} else if (rawFeedback && typeof rawFeedback === 'object') {
  feedbackText = String(rawFeedback.text ?? '').trim()
  feedbackFiles = (Array.isArray(rawFeedback.files) ? rawFeedback.files : []).map(String).filter(Boolean)
}
const hasFeedback = !!feedbackText || feedbackFiles.length > 0

// ── 早退：缺目标 / 缺证据 ──
if (!goal) {
  log('缺 args.goal，无法判定设计方向。请调度员说明本轮想改善什么。')
  return { error: 'missing args.goal', dimensions: [] }
}

const hasEvidence =
  !!plan.run ||
  plan.checks.length > 0 ||
  plan.codePaths.length > 0 ||
  hasFeedback ||
  benchmarkRefs.length > 0
if (!hasEvidence) {
  log('缺证据：simPlan.run / simPlan.checks / simPlan.codePaths / feedback / benchmarkRefs 至少给一个，否则无从判设计。')
  return { error: 'missing evidence (simPlan / feedback / benchmarkRefs)', dimensions: [] }
}

// ── 激活维度 ──
const requested = new Set((Array.isArray(A?.dimensions) ? A.dimensions : []).map(String))
const activeDims = DIMENSIONS.filter((d) => {
  if (requested.has(d.key)) return true // 显式点名 → 越闸强制开
  if (requested.size > 0) return false // 给了白名单就只跑白名单
  if ((d.minPlayers ?? 1) > players) return false // 人数不够 → 关
  if (d.key === 'feedback-psych' && !hasFeedback) return false // 没反馈 → 关
  return true
})
const activeSet = new Set(activeDims.map((d) => d.key))

if (!activeDims.length) {
  log('按当前 players / dimensions / feedback 过滤后没有任何活跃维度，本轮无从判定。')
  return { error: 'no active dimensions', dimensions: [], players, hasFeedback }
}

const knownBlock = known.length
  ? `\n【前几轮已知未修项（不要重复报，除非这轮又恶化了）】\n${known
      .map((k, i) => `${i + 1}. ${typeof k === 'string' ? k : JSON.stringify(k)}`)
      .join('\n')}\n`
  : ''

const prevRecord = history.length ? history[history.length - 1] : null
const historyBlock = prevRecord
  ? `\n【上一轮（第 ${prevRecord.round ?? Math.max(1, round - 1)} 轮）结果】\n` +
    `各维分数：${JSON.stringify(prevRecord.scores ?? {})}\n` +
    `上轮必修 ${prevRecord.mustFixCount ?? '未知'} 条` +
    `${prevRecord.evidenceBlocked ? '；上轮有证据完整性阻断' : ''}` +
    `${Array.isArray(prevRecord.hollowDimensions) && prevRecord.hollowDimensions.length ? `；上轮假达标维度：${prevRecord.hollowDimensions.join('、')}` : ''}\n` +
    `本轮注意：上轮已修的扣分点不要重复扣；未修的继续扣；只对新增差距扣分。\n`
  : ''

let brief =
  A?.benchmarkBrief && typeof A.benchmarkBrief === 'object' ? A.benchmarkBrief : null
let evidence = null

// ── 基准 brief 与目标分 ──
function targetFor(key) {
  const override = Number(targetScores?.[key])
  if (Number.isFinite(override) && override > 0) return Math.min(5, Math.max(1, override))
  const fromBrief = Number(brief?.dimensions?.find((d) => d.key === key)?.targetScore)
  if (Number.isFinite(fromBrief) && fromBrief > 0) return Math.min(5, Math.max(1, fromBrief))
  return DEFAULT_TARGET
}

function fallbackBrief(caveat) {
  return {
    refs: benchmarkRefs,
    dimensions: DIMENSIONS.map((d) => ({
      key: d.key,
      referenceApproach: '（基准未覆盖，按通用质量线判断）',
      verifiableCriteria: [],
      deductionPoints: [],
      targetScore: DEFAULT_TARGET,
    })),
    sources: [],
    caveats: caveat,
  }
}

function briefRows(keys) {
  return keys
    .map((key) => {
      const dim = DIMENSIONS.find((d) => d.key === key)
      const entry = (brief?.dimensions ?? []).find((d) => d.key === key)
      return (
        `-【${dim?.name ?? key}】目标分 ${targetFor(key)}\n` +
        `  参考做法：${entry?.referenceApproach || '（基准未覆盖，按通用质量线判断）'}\n` +
        `  可核验标准：${(entry?.verifiableCriteria ?? []).join('；') || '（无）'}\n` +
        `  常见扣分点：${(entry?.deductionPoints ?? []).join('；') || '（无）'}`
      )
    })
    .join('\n')
}

// ── ① 基准调研 + ② 取证：互不依赖，同批并行 ──
const BRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['refs', 'dimensions', 'sources', 'caveats'],
  properties: {
    refs: {
      type: 'array',
      description: '调用方给的参考作品名，原样回传',
      items: { type: 'string' },
    },
    dimensions: {
      type: 'array',
      description: '逐维口径，覆盖所有活跃维度',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'referenceApproach', 'verifiableCriteria', 'deductionPoints', 'targetScore'],
        properties: {
          key: { type: 'string', enum: DIMENSIONS.map((d) => d.key) },
          referenceApproach: { type: 'string', description: '参考作品在该维做对了什么' },
          verifiableCriteria: {
            type: 'array',
            description: '能落到数值/模拟输出/代码/公开设计文档的判断句',
            items: { type: 'string' },
          },
          deductionPoints: {
            type: 'array',
            description: '差在哪会掉分的具体扣分点',
            items: { type: 'string' },
          },
          targetScore: { type: 'number', description: '该维目标分，默认 4' },
        },
      },
    },
    sources: {
      type: 'array',
      description: '公开资料出处；没有就空数组',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'url', 'note'],
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
          note: { type: 'string' },
        },
      },
    },
    caveats: { type: 'string', description: '资料不足/把握不大的地方，如实写' },
  },
}

const RESEARCH_PROMPT = `你是设计档的基准调研员。目标只有一个：把调用方点名的参考作品，转成一套逐维、可核验、能扣分的评分口径（基准 brief）。

【参考作品】
${benchmarkRefs.map((r, i) => `${i + 1}. ${r}`).join('\n')}

${ctxBlock}
【本轮活跃维度】
${activeDims.map((d) => `- ${d.key}（${d.name}）：${d.prompt}`).join('\n')}

【要求】
- 逐维写四件事：referenceApproach（参考作品在该维做对了什么）、verifiableCriteria（能落到数值/模拟输出/代码/公开设计文档的判断句）、deductionPoints（差在哪会掉分）、targetScore（默认 4，满分 5）。
- 覆盖所有活跃维度，缺一不可。
- 只查公开的技术拆解、策划分享、开发者演讲、官方设计文档；**不得下载、复制、搬运参考作品的素材或数值表**。
- 查不到就写「公开资料不足」，按通用质量线给标准；不要编造具体数值。
- 多部参考作品时按各自强项写，不要凑成一个平均标准。
- sources 只放你真看过的公开页面；没看就空数组。

${knownBlock}
严格按 schema 输出，**必须调用 StructuredOutput，否则整条流程会中断**。`

const EVIDENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['executed', 'commands', 'metrics', 'numericAnchors', 'notes'],
  properties: {
    executed: { type: 'boolean', description: '是否执行了 simPlan.run' },
    commands: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['command', 'exitCode', 'output'],
        properties: {
          command: { type: 'string' },
          exitCode: { type: 'number' },
          output: { type: 'string', description: '末尾输出，失败时必须带原始报错' },
        },
      },
    },
    metrics: {
      type: 'array',
      description: '逐条 checks 命令的量化结果；没给 checks 就空数组',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'command', 'output'],
        properties: {
          name: { type: 'string' },
          command: { type: 'string' },
          output: { type: 'string', description: '命令原始输出' },
        },
      },
    },
    numericAnchors: {
      type: 'array',
      description: '从数值表/模拟输出读到的关键数值与偏差；这是数值证据的唯一结构化出口',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'path', 'observation', 'deviation'],
        properties: {
          name: { type: 'string', description: '锚点名，如「第3章敌人HP」' },
          path: { type: 'string', description: '数值所在文件:行 或 模拟命令' },
          observation: { type: 'string', description: '实际观测到的数值' },
          deviation: { type: 'string', description: '与预期/互相之间的偏差，带数字，如 +50%' },
        },
      },
    },
    notes: { type: 'string', description: '缺依赖、命令失败、读不到的数值等如实写；成功也写一句' },
  },
}

const EVIDENCE_PROMPT = `你是设计档的取证员。只做一件事：按调用方给的模拟与取证计划准备证据，不评价设计、不打分。

【项目根】${projectPath || '（未指定；按当前目录或 simPlan.workdir）'}

【取证与模拟计划】
${JSON.stringify(plan, null, 2)}

【玩家反馈文件】${feedbackFiles.length ? feedbackFiles.map((f) => `- ${f}`).join('\n') : '（无）'}

【执行规则】
1. 若 run 非空：在 workdir（为空则 projectPath 或当前目录）下执行该命令；原样记录命令、退出码、末尾输出。失败不要反复重试，把原始报错放进 output。
2. 若 checks 非空：逐条执行，记录原始输出（相当于量化指标）。
3. codePaths 是值得读的数值表/公式/掉落表路径（相对 projectPath）。逐条读取，把关键数值与偏差写进 numericAnchors：name（锚点名）、path（文件:行 或模拟命令）、observation（实际数值）、deviation（与预期或互相之间的偏差，必须带数字）。
4. 玩家反馈只做原样搬运，不做解析（解析归找茬那一路）。
5. 只允许在 outputDir（若给）下产生文件。不得修改项目源码、资源、配置；不得删除文件；不得安装依赖（缺依赖就报错回来）。
6. 不得访问、下载或搬运参考作品的素材或数值表。

${knownBlock}
严格按 schema 输出，**必须调用 StructuredOutput，否则整条流程会中断**。`

const researchTask = brief || !benchmarkRefs.length
  ? null
  : agent(RESEARCH_PROMPT, {
      label: '调研:基准brief',
      phase: '基准调研',
      agentType: 'critic-pipeline:critic-design-analyst',
      schema: BRIEF_SCHEMA,
    })

const evidenceTask = agent(EVIDENCE_PROMPT, {
  label: '取证:数值与模拟',
  phase: '取证',
  agentType: 'critic-pipeline:critic-design-analyst',
  schema: EVIDENCE_SCHEMA,
})

const prep = await parallel([() => researchTask, () => evidenceTask])
const researchRaw = prep?.[0] ?? null
const evidenceRaw = prep?.[1] ?? null

if (researchRaw) {
  brief = researchRaw
  log(`基准 brief 完成：${brief?.dimensions?.length ?? 0} 维${brief?.caveats ? `（${brief.caveats}）` : ''}`)
} else if (!brief) {
  brief = fallbackBrief(benchmarkRefs.length ? '基准调研未产出，本轮按通用质量线评分' : '未给参考作品，按通用质量线评分')
  log('没有可用基准 brief，退化为通用质量线。')
}

evidence = evidenceRaw ?? {
  executed: false,
  commands: [],
  metrics: [],
  numericAnchors: [],
  notes: '取证子代理未返回结果',
}
log(
  `取证完成：命令 ${evidence.commands?.length ?? 0} 条 / 指标 ${evidence.metrics?.length ?? 0} 条 / 数值锚点 ${evidence.numericAnchors?.length ?? 0} 个`
)

// ── ③ 找茬：逐维镜头 + 心理机制路 + 细节评委同批并行 ──
const ANCHOR_KINDS = ['numeric-config', 'sim-output', 'code', 'benchmark']

const DIM_FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'dimensions', 'findings', 'coverageGaps'],
  properties: {
    lens: { type: 'string' },
    dimensions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'status', 'score', 'deductions', 'strengths'],
        properties: {
          key: { type: 'string', enum: DIMENSIONS.map((d) => d.key) },
          status: {
            type: 'string',
            enum: ['assessed', 'no-evidence'],
            description: 'assessed=有证据并已判；no-evidence=该维没有任何可用证据',
          },
          score: {
            type: 'number',
            description: '5 减去 deductions 的 points 之和；no-evidence 时填 0 占位（脚本会忽略并重算）',
          },
          deductions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['points', 'issue', 'gap', 'evidence', 'anchorKind'],
              properties: {
                points: { type: 'number', description: '扣多少分，0.5 的倍数' },
                issue: { type: 'string', description: '差什么' },
                gap: { type: 'string', description: '与基准/标准的差距有多大' },
                evidence: { type: 'string', description: '数值:行 / 模拟输出 / 代码位置 / 参考口径' },
                anchorKind: {
                  type: 'string',
                  enum: ANCHOR_KINDS,
                  description: '证据类型；玩家原话不属于任何一种，不得作为锚点',
                },
              },
            },
          },
          strengths: {
            type: 'array',
            description: '该维做得好、值得保留的点',
            items: { type: 'string' },
          },
        },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['location', 'problem', 'severity', 'confidence', 'evidence', 'dimension', 'anchorKind'],
        properties: {
          location: { type: 'string', description: '数值表:行 / 代码位置 / 模拟命令' },
          problem: { type: 'string' },
          severity: { type: 'string', enum: ['must-fix', 'should-fix', 'minor'] },
          confidence: { type: 'number' },
          evidence: { type: 'string' },
          dimension: { type: 'string', enum: DIMENSIONS.map((d) => d.key) },
          anchorKind: { type: 'string', enum: ANCHOR_KINDS },
        },
      },
    },
    coverageGaps: {
      type: 'array',
      description: '该查但没有证据的设计面 / 缺失的数值或模拟',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'why', 'neededEvidence'],
        properties: {
          item: { type: 'string' },
          why: { type: 'string' },
          neededEvidence: { type: 'string' },
        },
      },
    },
  },
}

function lensPrompt(lens) {
  const dims = lens.dimKeys.map((k) => DIMENSIONS.find((d) => d.key === k))
  return `你是设计档的挑刺者，本轮负责 ${dims.length} 个维度：【${dims.map((d) => d.name).join('、')}】。

${dims.map((d) => `【${d.name}】${d.prompt}`).join('\n')}

【评分口径（基准 brief）】
${briefRows(lens.dimKeys)}

【本轮目标】
${goal}
${ctxBlock}
【取证结果（调用方计划 + 取证员回报）】
${JSON.stringify(evidence, null, 2)}

【值得查的数值配置/代码】
${plan.codePaths.length ? plan.codePaths.map((p) => `- ${p}`).join('\n') : '（调用方未指定；可按需用 Grep/Glob 找数值表、公式、掉落表、成长曲线）'}
${historyBlock}${knownBlock}
【打分规则（必须严格执行）】
1. 每维满分 5；分数 = 5 - 该维所有 deductions 的 points 之和（最低 0）。points 用 0.5 的倍数。
2. 每笔扣分必须写全四件事：issue（差什么）、gap（与标准的差距）、evidence（数值:行 / 模拟输出 / 代码位置 / 参考口径）、anchorKind（证据类型）。
3. **只查结构代理指标**：反馈密度 / 决策分支 / 失败惩罚 / 节奏峰谷 / 目标梯度 / 数值偏差等。禁止「感觉不好玩」「不够有意思」这类无据扣分；说不出具体结构差距就不扣。
4. 先看证据再打分。该维没有任何可用数值或模拟证据 → status=no-evidence，score 填 0 占位，不要猜。
5. **玩家原话不能当结构证据**：anchorKind 只能是 numeric-config / sim-output / code / benchmark 之一。若你手上只有玩家吐槽、没有可落锚的结构事实，就把该条写进 coverageGaps，不要扣分。
6. 只判设计。代码正确性、性能、兼容性不归本档，不报。
7. 发现该查但没有证据的设计面 → 写进 coverageGaps，交调度员补数值或补模拟，不要靠猜。
8. 所有缺陷同时整理进 findings（带 dimension、severity、anchorKind）。
9. 你不修改任何文件；需要补证据就写进 coverageGaps。

严格按 schema 输出，**必须调用 StructuredOutput，否则整条流程会中断**。`
}

const PSYCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mechanismFindings', 'unverified', 'strengths', 'summary'],
  properties: {
    mechanismFindings: {
      type: 'array',
      description: '能落到结构锚点的反馈：每条都要有结构锚点，指不到就不许进这里',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['feedbackQuote', 'mechanismType', 'mechanism', 'brokenNeed', 'structuralAnchor', 'anchorKind', 'severity', 'points', 'evidence'],
        properties: {
          feedbackQuote: { type: 'string', description: '玩家原话，原样引用' },
          mechanismType: {
            type: 'string',
            enum: ['autonomy', 'competence', 'relatedness', 'flow', 'loss-aversion', 'variable-ratio', 'sunk-cost', 'peak-end', 'other'],
            description: '自我决定论三需求 / 心流 / 损失厌恶 / 可变比率强化 / 沉没成本 / 峰终定律',
          },
          mechanism: { type: 'string', description: '这条反馈指向哪条心理机制被破坏' },
          brokenNeed: { type: 'string', description: '被破坏的具体需求/体验，如「胜任感受挫」' },
          structuralAnchor: { type: 'string', description: '落到数值:行 / 模拟输出 / 代码位置 / 参考口径，必填' },
          anchorKind: { type: 'string', enum: ANCHOR_KINDS },
          severity: { type: 'string', enum: ['must-fix', 'should-fix', 'minor'] },
          points: { type: 'number', description: '该条扣多少分，0.5 的倍数；纯记录不扣则填 0' },
          evidence: { type: 'string', description: '支撑该锚点的证据' },
        },
      },
    },
    unverified: {
      type: 'array',
      description: '纯情绪、无法落到任何结构锚点的反馈，单列，不计分、不阻塞收敛',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['quote', 'why'],
        properties: {
          quote: { type: 'string' },
          why: { type: 'string', description: '为什么落不到结构锚点' },
        },
      },
    },
    strengths: {
      type: 'array',
      description: '反馈里反映的、结构上做得好的点',
      items: { type: 'string' },
    },
    summary: { type: 'string' },
  },
}

function psychPrompt(lens) {
  return `你是设计档的「玩家反馈 → 心理机制」解析员。玩家说什么不重要，重要的是：他这句话背后是哪条心理机制被破坏了，以及这能不能落到一个结构锚点上。

【本轮目标】
${goal}
${ctxBlock}
【玩家反馈原文】
${feedbackText || '（调用方仅给了反馈文件，按下面路径读取）'}
${feedbackFiles.length ? feedbackFiles.map((f) => `- ${f}`).join('\n') : ''}

【取证结果（数值/模拟，供你落锚）】
${JSON.stringify(evidence, null, 2)}

【值得查的数值配置/代码】
${plan.codePaths.length ? plan.codePaths.map((p) => `- ${p}`).join('\n') : '（调用方未指定；可按需用 Grep/Glob 找对应配置）'}
${historyBlock}${knownBlock}
【解析规则（必须严格执行）】
1. 逐条读反馈，先判定它指向哪条心理机制：
   - 自我决定论三需求：自主（autonomy）/ 胜任（competence）/ 关联（relatedness）
   - 心流 flow / 损失厌恶 loss-aversion / 可变比率强化 variable-ratio / 沉没成本 sunk-cost / 峰终定律 peak-end
2. **只有能落到结构锚点的才进 mechanismFindings**：structuralAnchor 必须指到具体数值:行 / 模拟输出 / 代码位置 / 参考口径。指不到就进 unverified（写清为什么落不了锚）。
3. anchorKind 只能是 numeric-config / sim-output / code / benchmark 之一——**玩家原话本身永远不能当锚点**。
4. points 用 0.5 的倍数；纯记录、不构成扣分的填 0。
5. 每维满分 5 由脚本按 points 之和重算，你不填总分。
6. 不得凭空编造玩家没说过的话；feedbackQuote 必须原样引用。
7. 你不修改任何文件。

严格按 schema 输出，**必须调用 StructuredOutput，否则整条流程会中断**。`
}

const DETAIL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['hollowFindings', 'anchorViolations', 'thresholdDrift', 'summary'],
  properties: {
    hollowFindings: {
      type: 'array',
      description: '假达标：表面像结构判断，实则空泛或没对齐',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['dimension', 'problem', 'whyHollow', 'evidence'],
        properties: {
          dimension: { type: 'string', enum: DIMENSIONS.map((d) => d.key) },
          problem: { type: 'string' },
          whyHollow: { type: 'string', description: '哪一层没对齐结构' },
          evidence: { type: 'string' },
        },
      },
    },
    anchorViolations: {
      type: 'array',
      description: '证据造假：用玩家情绪冒充结构证据，或锚点指向不存在的数值/代码',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['finding', 'quote', 'why'],
        properties: {
          finding: { type: 'string', description: '哪条扣分/结论有问题' },
          quote: { type: 'string', description: '可疑的锚点或引文' },
          why: { type: 'string', description: '为什么认为它造假或对不上真实配置' },
        },
      },
    },
    thresholdDrift: {
      type: 'array',
      description: '阈值漂移：找茬者把达标线私自放宽',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['dimension', 'briefCriterion', 'lensClaim', 'why'],
        properties: {
          dimension: { type: 'string', enum: DIMENSIONS.map((d) => d.key) },
          briefCriterion: { type: 'string', description: '基准 brief 原本的标准' },
          lensClaim: { type: 'string', description: '找茬者实际用的标准' },
          why: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
}

const DETAIL_PROMPT = `你是设计档的细节评委，独立于镜头与主判卷，只做三件事：审「假达标」、守「证据真实」、查「阈值漂移」。

【本轮目标】
${goal}
${ctxBlock}
【基准 brief】
${briefRows(activeDims.map((d) => d.key))}

【取证结果】
${JSON.stringify(evidence, null, 2)}
${historyBlock}${knownBlock}
【判据 A：假达标】表面像结构判断，实则空泛。例：说「反馈密度不足」却指不出哪次操作没有反馈；说「成长曲线不顺」却给不出坡度数字。
- 每条写 dimension、problem、whyHollow（哪一层没对齐结构）、evidence。
- 看不出来就把 hollowFindings 置空，不要凑。

【判据 B：证据造假】只拦**具体、可核验的造假**：
- 用玩家原话当结构证据（anchorKind 本不该容纳 feedback）；
- 锚点指向的数值/代码行根本不存在，或与取证结果对不上；
- 编造玩家没说过的话。
- 每条写 finding、quote、why。有具体证据才报，模糊怀疑不报。

【判据 C：阈值漂移】找茬者把达标线私自放宽（例：brief 要求偏差 <20%，找茬者按 <50% 放过）。
- 每条写 dimension、briefCriterion、lensClaim、why。

你不改任何文件，也不给总分——打分归镜头，终裁归主判卷。
不得访问、下载或搬运参考作品的素材或数值表。

严格按 schema 输出，**必须调用 StructuredOutput，否则整条流程会中断**。`

const lensList =
  depth === 'full'
    ? activeDims.map((d) => ({ key: d.key, name: d.name, dimKeys: [d.key], psych: d.key === 'feedback-psych' }))
    : LENS_GROUPS.map((g) => ({ ...g, dimKeys: g.dimKeys.filter((k) => activeSet.has(k)) })).filter(
        (g) => g.dimKeys.length > 0
      )

phase('找茬')
log(
  `深度=${depth}；players=${players}；反馈=${hasFeedback ? '有' : '无'}；` +
    `开 ${lensList.length} 路镜头（${lensList.map((l) => l.name).join(' / ')}）+ 1 位细节评委`
)

const lensThunks = lensList.map((lens) => () => {
  if (lens.psych) {
    return agent(psychPrompt(lens), {
      label: `找茬:${lens.name}`,
      phase: '找茬',
      agentType: 'critic-pipeline:critic-design-analyst',
      schema: PSYCH_SCHEMA,
    }).then((r) => {
      if (!r) return null
      const mf = Array.isArray(r.mechanismFindings) ? r.mechanismFindings : []
      const deductions = mf
        .filter((m) => Number(m.points) > 0)
        .map((m) => ({
          points: Number(m.points),
          issue: m.mechanism,
          gap: `破坏需求：${m.brokenNeed}`,
          evidence: `${m.structuralAnchor}；反馈原话：${m.feedbackQuote}`,
          anchorKind: m.anchorKind,
        }))
      const status = mf.length ? 'assessed' : 'no-evidence'
      return {
        lens: lens.name,
        dimensions: [
          { key: 'feedback-psych', status, score: 0, deductions, strengths: r.strengths ?? [] },
        ],
        findings: mf.map((m) => ({
          location: m.structuralAnchor,
          problem: `${m.mechanism}（${m.mechanismType}；破坏：${m.brokenNeed}）`,
          severity: m.severity,
          confidence: 0.8,
          evidence: `玩家原话：${m.feedbackQuote}；锚点：${m.evidence || m.structuralAnchor}`,
          dimension: 'feedback-psych',
          anchorKind: m.anchorKind,
        })),
        coverageGaps: [],
        unverified: Array.isArray(r.unverified) ? r.unverified : [],
        psychSummary: r.summary ?? '',
      }
    })
  }
  return agent(lensPrompt(lens), {
    label: `找茬:${lens.name}`,
    phase: '找茬',
    agentType: 'critic-pipeline:critic-design-analyst',
    schema: DIM_FINDINGS_SCHEMA,
  }).then((r) => (r ? { ...r, lens: r.lens || lens.name } : null))
})

const finderThunks = [
  ...lensThunks,
  () =>
    agent(DETAIL_PROMPT, {
      label: '评审:细节评委',
      phase: '找茬',
      agentType: 'critic-pipeline:critic-design-detail-judge',
      schema: DETAIL_SCHEMA,
    }),
]

const finderRaw = await parallel(finderThunks)
const detailRaw = finderRaw?.[finderRaw.length - 1] ?? null
const lensResults = (finderRaw?.slice(0, -1) ?? []).filter(Boolean)
const detail = detailRaw ?? {
  hollowFindings: [],
  anchorViolations: [],
  thresholdDrift: [],
  summary: '细节评委未返回结果',
}

const unverifiedAll = lensResults.flatMap((r) => r.unverified ?? [])
if (hasFeedback) {
  log(
    `收到 ${lensResults.length}/${lensList.length} 路镜头结果；假达标 ${detail.hollowFindings?.length ?? 0} 条；` +
      `证据造假 ${detail.anchorViolations?.length ?? 0} 条；阈值漂移 ${detail.thresholdDrift?.length ?? 0} 条；` +
      `未验证反馈 ${unverifiedAll.length} 条`
  )
} else {
  log(
    `收到 ${lensResults.length}/${lensList.length} 路镜头结果；假达标 ${detail.hollowFindings?.length ?? 0} 条；` +
      `证据造假 ${detail.anchorViolations?.length ?? 0} 条；阈值漂移 ${detail.thresholdDrift?.length ?? 0} 条`
  )
}

if (!lensResults.length) {
  log('所有镜头都未返回结果，本轮无法判设计。')
  return {
    error: 'all lenses failed',
    round,
    players,
    activeDimKeys: activeDims.map((d) => d.key),
    evidence,
    benchmarkBrief: brief,
    dimensions: [],
    converged: false,
    stopReason: 'insufficient-evidence',
    summary: '全部镜头未返回；检查插件 agent 定义与会话重启状态。',
  }
}

// 维度 → 镜头结果（同一维只应出现一次）
const lensDimByKey = new Map()
for (const r of lensResults) {
  for (const d of r.dimensions ?? []) {
    if (!lensDimByKey.has(d.key) || lensDimByKey.get(d.key)?.status !== 'assessed') {
      lensDimByKey.set(d.key, { ...d, fromLens: r.lens })
    }
  }
}

function deductionsSum(entry) {
  return (entry?.deductions ?? []).reduce((sum, d) => sum + (Number(d?.points) || 0), 0)
}

function computedScore(entry) {
  return Math.round(Math.max(0, Math.min(5, 5 - deductionsSum(entry))) * 100) / 100
}

const hollowDims = new Set(
  (detail.hollowFindings ?? []).map((f) => String(f.dimension ?? '')).filter(Boolean)
)

// ── ④ 判卷：分片判卷（每镜头一片，引用式输出）→ 脚本合并 → 轻量汇流 ──
// 背景：单个主判卷要一次吃下全部镜头结果、吐出全部终裁，镜头一多就会被上游
// 单次输出上限截断（画面档实测 8 路时思考十几万字符、tool call 被截断整轮报废）。
// 这里每路镜头配一个分片判卷，只回「编号 + 保留/驳回 + 定级 + 维度分」，
// 正文、扣分项、anchorKind 一律由脚本从镜头原文回填。

function clipText(v, n) {
  const s = String(v ?? '')
  return s.length > n ? `${s.slice(0, n)}…(截断 ${s.length - n} 字)` : s
}
function clipDeep(v, maxStr = 800, depth = 0) {
  if (depth > 4) return v
  if (typeof v === 'string') return clipText(v, maxStr)
  if (Array.isArray(v)) return v.slice(0, 60).map((x) => clipDeep(x, maxStr, depth + 1))
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) out[k] = clipDeep(val, maxStr, depth + 1)
    return out
  }
  return v
}

let findingSeq = 0
const lensShards = lensResults.map((r) => ({
  lens: r.lens,
  result: r,
  items: (Array.isArray(r.findings) ? r.findings : []).map((f) => ({ id: `F${++findingSeq}`, ...f })),
}))

const SHARD_JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts', 'dimensions', 'summary'],
  properties: {
    verdicts: {
      type: 'array',
      description: '只对本片列出的 finding id 逐条裁决',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'action'],
        properties: {
          id: { type: 'string', description: '本片 findings 里的 id，如 F3' },
          action: { type: 'string', enum: ['keep', 'drop'] },
          severity: {
            type: 'string',
            enum: ['must-fix', 'should-fix', 'minor'],
            description: 'action=keep 时必填',
          },
          anchorKind: { type: 'string', enum: ANCHOR_KINDS, description: '可下调锚点口径；改不了就照抄' },
          reason: { type: 'string', description: '一句话理由，不抄正文' },
        },
      },
    },
    dimensions: {
      type: 'array',
      description: '只复制本片负责的维度；score 只能等于或低于镜头重算分',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'score'],
        properties: {
          key: { type: 'string', enum: DIMENSIONS.map((d) => d.key) },
          score: { type: 'number' },
          notes: { type: 'string', description: '下调或维持的一句理由' },
        },
      },
    },
    summary: { type: 'string', description: '本片一句话结论' },
  },
}

function shardJudgePrompt(shard) {
  const dims = (shard.result.dimensions ?? []).map((d) => ({
    key: d.key,
    name: DIMENSIONS.find((x) => x.key === d.key)?.name ?? d.key,
    status: d.status,
    selfScore: d.status === 'assessed' ? computedScore(d) : null,
    deductionCount: (d.deductions ?? []).length,
  }))
  return `你是设计档的分片判卷，只审【${shard.lens}】这一路镜头自己的产出，不与其他镜头交叉。你只做三件事：
1) 逐条裁决下面列出的 finding：保留还是驳回；保留项给出定级（must-fix / should-fix / minor）。**用 id 引用，不要抄正文**。
2) 复核本片负责维度的分数：只能等于或低于该维自评分，不得上调；notes 写一句理由。
3) 一句话写本片结论。
规则：不许新增镜头没报过的缺陷；证据站不住、纯情绪当结构证据、或明显「为挑而挑」才驳回，拿不准就保留。
**玩家原话永远不能当结构证据**：anchorKind 只能是 numeric-config / sim-output / code / benchmark。
${ctxBlock}
【本轮目标】
${goal}

【本片维度的基准口径】
${briefRows(dims.map((d) => d.key))}

【本片维度自评】
${JSON.stringify(dims, null, 2)}

【本片 findings（只裁决这些 id）】
${JSON.stringify(shard.items, null, 2)}

【取证结果（核对证据用，不要从中另找新缺陷）】
${JSON.stringify(clipDeep(evidence), null, 2)}
${historyBlock}${knownBlock}
严格按 schema 输出，**必须调用 StructuredOutput，否则整条流程会中断**。`
}

phase('判卷')
log(`分片判卷：${lensShards.length} 片并行（每片只审自己那一路）…`)
const shardRaw = await parallel(
  lensShards.map((shard) => () =>
    agent(shardJudgePrompt(shard), {
      label: `分片判卷:${shard.lens}`,
      phase: '判卷',
      agentType: 'critic-pipeline:critic-design-judge',
      schema: SHARD_JUDGE_SCHEMA,
    })
  )
)

const shardDims = new Map()
let confirmed = []
let shardDropped = 0
let shardFailed = 0
lensShards.forEach((shard, idx) => {
  const sr = shardRaw?.[idx] ?? null
  if (!sr) {
    shardFailed++
    for (const item of shard.items) confirmed.push({ ...item })
    return
  }
  const verdicts = new Map((sr.verdicts ?? []).map((v) => [String(v.id), v]))
  for (const item of shard.items) {
    const v = verdicts.get(item.id)
    if (v?.action === 'drop') {
      shardDropped++
      continue
    }
    confirmed.push({
      ...item,
      severity: v?.severity ?? item.severity,
      anchorKind: ANCHOR_KINDS.includes(v?.anchorKind) ? v.anchorKind : item.anchorKind,
    })
  }
  for (const d of sr.dimensions ?? []) {
    const val = Number(d?.score)
    if (!DIMENSIONS.some((x) => x.key === d?.key) || !Number.isFinite(val)) continue
    const prev = shardDims.get(d.key)
    if (!prev || val < prev.score) shardDims.set(d.key, { score: val, notes: String(d.notes ?? '') })
  }
})
if (shardFailed) log(`有 ${shardFailed} 片分片判卷未返回，该片按镜头原样保留。`)

// ── 轻量汇流判卷：只读各片小结论 ──
const FINAL_JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mergeClusters', 'severityOverrides', 'summary'],
  properties: {
    mergeClusters: {
      type: 'array',
      description: '同一问题被不同镜头分别报出的，按 id 归组；脚本只保留每组第一个',
      items: { type: 'array', items: { type: 'string' } },
    },
    severityOverrides: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'severity'],
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['must-fix', 'should-fix', 'minor'] },
          reason: { type: 'string' },
        },
      },
    },
    summary: { type: 'string', description: '一句话总结本轮设计状况，点出最该先修的 1~2 项' },
  },
}

function finalJudgePrompt() {
  const dimDigest = activeDims.map((d) => {
    const lensDim = lensDimByKey.get(d.key)
    return {
      key: d.key,
      name: d.name,
      status: lensDim?.status ?? 'no-evidence',
      lensScore: lensDim?.status === 'assessed' ? computedScore(lensDim) : null,
      shardScore: shardDims.get(d.key)?.score ?? null,
    }
  })
  const digest = confirmed.map((f) => ({
    id: f.id,
    fromLens: f.fromLens,
    dimension: f.dimension,
    location: clipText(f.location, 120),
    problem: clipText(f.problem, 160),
    severity: f.severity,
    anchorKind: f.anchorKind,
  }))
  return `你是设计档的汇流判卷。分片判卷已经逐片裁决过，你只做跨片收口，不再看原始证据：
1) 跨片去重：同一个缺陷被不同镜头分别报出的，按 id 归组（mergeClusters）；脚本只保留每组第一个。不同问题不要硬并。
2) 统一严重度：跨片口径明显不一致时给 severityOverrides；否则不动。
3) 一句话总结本轮设计状况（点出最该先修的 1~2 项）。
不要新增缺陷；不要复述正文；拿不准的分组不要建。
${ctxBlock}
【本轮目标】
${goal}
【维度分数（lensScore 为镜头重算分，shardScore 为分片复核分）】
${JSON.stringify(dimDigest, null, 2)}
【分片保留项（引用式）】
${JSON.stringify(digest, null, 2)}
【细节评委结论】
${clipText(detail.summary, 300)}
${historyBlock}${knownBlock}
严格按 schema 输出，**必须调用 StructuredOutput，否则整条流程会中断**。`
}

let finalJudge = null
if (confirmed.length) {
  phase('汇流')
  log(`汇流判卷：收口 ${confirmed.length} 条保留项…`)
  finalJudge =
    (await agent(finalJudgePrompt(), {
      label: '汇流:设计终裁',
      phase: '汇流',
      agentType: 'critic-pipeline:critic-design-judge',
      schema: FINAL_JUDGE_SCHEMA,
    })) ?? null
  if (!finalJudge) log('汇流判卷未返回，按分片结果直接合并。')
} else {
  log('分片判卷未保留任何缺陷，跳过汇流判卷。')
}

if (finalJudge?.mergeClusters?.length) {
  const dropIds = new Set()
  for (const group of finalJudge.mergeClusters) {
    if (!Array.isArray(group)) continue
    for (const id of group.slice(1)) if (typeof id === 'string') dropIds.add(id)
  }
  if (dropIds.size) confirmed = confirmed.filter((f) => !dropIds.has(f.id))
}
const sevOverrides = new Map(
  (finalJudge?.severityOverrides ?? [])
    .filter((x) => x && typeof x.id === 'string')
    .map((x) => [x.id, x.severity])
)
if (sevOverrides.size) {
  confirmed = confirmed.map((f) => (sevOverrides.has(f.id) ? { ...f, severity: sevOverrides.get(f.id) } : f))
}

// ── ⑤ 收敛：脚本按双闸门判定 ──
phase('收敛')

const dimResults = activeDims.map((dim) => {
  const lensDim = lensDimByKey.get(dim.key)
  const judgeDim = shardDims.get(dim.key)
  const assessed = lensDim?.status === 'assessed'
  const lensScore = assessed ? computedScore(lensDim) : null
  const judgeScore = Number.isFinite(Number(judgeDim?.score)) ? Number(judgeDim.score) : null
  let score = assessed ? Math.min(lensScore, judgeScore ?? lensScore) : null
  const hollow = assessed && hollowDims.has(dim.key)
  if (hollow && score !== null) score = Math.min(score, 3)
  const target = targetFor(dim.key)
  // 扣分项一律沿用镜头原文（分片判卷只改分数与理由，不重写扣分项）
  const deductions = lensDim?.deductions ?? []
  // 玩家反馈维：有反馈但一条都落不了锚 → no-evidence，且不阻塞收敛
  const exempt = dim.key === 'feedback-psych' && !assessed
  return {
    key: dim.key,
    name: dim.name,
    status: assessed ? 'assessed' : 'no-evidence',
    score,
    lensScore,
    target,
    meetsTarget: assessed && score !== null && score >= target,
    hollow,
    exempt,
    deductions,
    strengths: lensDim?.strengths ?? [],
    notes: judgeDim?.notes ?? '',
    fromLens: lensDim?.fromLens ?? '',
  }
})

// 假达标 → 强制必修项（脚本兜底，不依赖判卷是否记得）
for (const h of detail.hollowFindings ?? []) {
  const already = confirmed.some(
    (f) => f.dimension === h.dimension && String(f.problem ?? '').includes(String(h.problem ?? ''))
  )
  if (!already) {
    confirmed.push({
      location: '（细节评委）',
      problem: `假达标：${h.problem}`,
      severity: 'must-fix',
      evidence: `${h.whyHollow}；证据：${h.evidence}`,
      dimension: h.dimension,
      fromLens: '细节评委',
      anchorKind: 'code',
    })
  }
}

// 去重（dimension + location + problem）
const seen = new Set()
const deduped = []
for (const f of confirmed) {
  const k = `${f.dimension ?? ''}||${f.location ?? ''}||${f.problem ?? ''}`
  if (!seen.has(k)) {
    seen.add(k)
    deduped.push(f)
  }
}
// 剥掉分片判卷内部编号，不泄漏到对外返回
confirmed = deduped.map(({ id, ...rest }) => rest)

// 证据造假硬阻断：由细节评委独立判定（不再依赖判卷转述，防止洗白）
const detailViolations = detail.anchorViolations ?? []
const evidenceBlocked = detailViolations.length > 0
const integrityViolations = detailViolations.map((v) => ({
  finding: v.finding,
  why: `${v.why}（引文：${v.quote}）`,
}))

const coverageMap = new Map()
const coverageSources = lensResults.flatMap((r) =>
  (r.coverageGaps ?? []).map((g) => ({ ...g, fromLens: r.lens }))
)
for (const g of coverageSources) {
  const k = `${g.item ?? ''}||${g.neededEvidence ?? ''}`
  if (!coverageMap.has(k)) coverageMap.set(k, g)
}
const coverage = [...coverageMap.values()]

const mustFix = confirmed.filter((f) => f.severity === 'must-fix')
const shouldFix = confirmed.filter((f) => f.severity === 'should-fix')
const minor = confirmed.filter((f) => f.severity === 'minor')

const unassessed = dimResults.filter((d) => d.status !== 'assessed' && !d.exempt)
const belowTarget = dimResults.filter(
  (d) => d.status === 'assessed' && d.score !== null && d.score < d.target
)

// brief 是否有真内容（非 fallbackBrief 占位）——决定是否附参考做法
const hasValidBrief = (brief?.dimensions ?? []).some(
  (x) => typeof x?.referenceApproach === 'string' && x.referenceApproach.trim() && !x.referenceApproach.includes('基准未覆盖')
)

const converged =
  mustFix.length === 0 &&
  !evidenceBlocked &&
  unassessed.length === 0 &&
  belowTarget.length === 0

const prevScores = prevRecord?.scores && typeof prevRecord.scores === 'object' ? prevRecord.scores : null
const improved = prevScores
  ? dimResults.some((d) => {
      const p = Number(prevScores[d.key])
      return Number.isFinite(p) && d.score !== null && d.score > p
    })
  : false
const prevMustFixCount = Number(prevRecord?.mustFixCount)
const newMustFix = Number.isFinite(prevMustFixCount) ? mustFix.length > prevMustFixCount : true
const stagnated = !!prevScores && round > 1 && !improved && !newMustFix

let stopReason = 'continue'
if (converged) stopReason = 'converged'
else if (evidenceBlocked) stopReason = 'evidence-blocked'
else if (round >= maxRounds) stopReason = 'max-rounds'
else if (stagnated) stopReason = 'stalled'
else if (unassessed.length > 0) stopReason = 'insufficient-evidence'

const stuckDimensions = belowTarget
  .slice()
  .sort((a, b) => a.score - a.target - (b.score - b.target))
  .slice(0, 3)
  .map((d) => `${d.name}（${d.score} / 目标 ${d.target}）`)

const scoreMap = Object.fromEntries(dimResults.map((d) => [d.key, d.score]))
const targetMap = Object.fromEntries(dimResults.map((d) => [d.key, d.target]))

const progressRecord = {
  round,
  scores: scoreMap,
  targets: targetMap,
  activeDimKeys: activeDims.map((d) => d.key),
  mustFixCount: mustFix.length,
  mustFixLocations: mustFix.map((f) => `${f.dimension ?? ''}:${f.location ?? ''}`),
  evidenceBlocked,
  hollowDimensions: [...hollowDims],
  coverageGapCount: coverage.length,
  unverifiedFeedbackCount: unverifiedAll.length,
  summary: finalJudge?.summary ?? detail.summary ?? '',
}

const summary = finalJudge?.summary ?? detail.summary ?? ''

// 基准占位符：调研失败/未给参考作品时 fallbackBrief 写的假内容，绝不能当「参考做法」贴出去
const BRIEF_PLACEHOLDER = '（基准未覆盖，按通用质量线判断）'

// 从基准 brief 机械拼「参考做法 + 可核验口径 + 出处」；零新增模型输出
function referenceHints(dimKey) {
  const entry = (brief?.dimensions ?? []).find((x) => x?.key === dimKey)
  const approach = (entry?.referenceApproach ?? '').trim()
  if (!approach || approach === BRIEF_PLACEHOLDER || approach.includes('基准未覆盖')) return []
  const out = []
  const refNames = (brief?.refs ?? []).filter(Boolean)
  out.push(`- 参考做法${refNames.length ? `（${refNames.join(' / ')}）` : ''}：${clipText(approach, 160)}`)
  const criteria = (entry?.verifiableCriteria ?? []).filter((c) => typeof c === 'string' && c.trim()).slice(0, 2)
  if (criteria.length) {
    out.push(`- 可核验口径：${criteria.map((c) => clipText(c.trim(), 100)).join('；')}`)
  }
  const src = (brief?.sources ?? []).find((s) => s?.title || s?.url)
  if (src) {
    const label = [src.title, src.url].filter(Boolean).join(' ')
    out.push(`- 出处：${clipText(label, 140)}`)
  }
  return out
}

function handoffText() {
  const lines = []
  if (evidenceBlocked) {
    lines.push('【硬阻断：证据完整性】本轮不算达标，先补真证据再谈分数。')
    for (const v of integrityViolations) {
      lines.push(`- ${v.finding}：${v.why}`)
    }
    lines.push('')
  }
  for (const d of dimResults) {
    const scoreText = d.score === null ? '未取证' : `${d.score}`
    lines.push(`【${d.name}】${scoreText} / 目标 ${d.target}${d.hollow ? '（假达标，封顶 3）' : ''}`)
    if (d.deductions.length) {
      for (const x of d.deductions) {
        lines.push(`- 扣 ${x.points}：${x.issue}（差距：${x.gap}；证据：${x.evidence}）`)
      }
    } else if (d.status === 'assessed') {
      lines.push('- 无扣分')
    } else if (d.exempt) {
      lines.push('- 该维有反馈但无法落到结构锚点，已单列未验证，不入账')
    }
    const related = mustFix.concat(shouldFix).filter((f) => f.dimension === d.key)
    for (const f of related) {
      lines.push(`- [${f.severity}] ${f.location}：${f.problem}（依据：${f.evidence}）`)
    }
    // 只对未达标的维附参考做法（事实层：人家怎么做的 + 可核验口径 + 出处）
    if (d.status === 'assessed' && d.score !== null && d.score < d.target) {
      for (const h of referenceHints(d.key)) lines.push(h)
    }
    lines.push('')
  }
  if (!hasValidBrief) {
    lines.push('【本轮无有效基准 brief，未附参考做法】')
    lines.push('')
  }
  if (unverifiedAll.length) {
    lines.push('【未验证的玩家反馈（纯情绪，未计入分数）】')
    for (const u of unverifiedAll) {
      lines.push(`- 「${u.quote}」：${u.why}`)
    }
    lines.push('')
  }
  if (coverage.length) {
    lines.push('【证据缺口（下一轮补数值或补模拟）】')
    for (const g of coverage) {
      lines.push(`- 设计面「${g.item}」：${g.why}；需要：${g.neededEvidence}`)
    }
  }
  return lines.join('\n').trim()
}

log(
  `收敛判定：${stopReason}；必修 ${mustFix.length} / 建议 ${shouldFix.length} / 可忽略 ${minor.length}` +
    `；低于目标 ${belowTarget.length} 维；证据缺口 ${coverage.length} 条` +
    (evidenceBlocked ? '；证据完整性硬阻断' : '')
)

return {
  round,
  goal,
  depth,
  players,
  hasFeedback,
  benchmarkRefs,
  activeDimKeys: activeDims.map((d) => d.key),
  // 基准 brief：调度员缓存后传回下一轮，避免重复调研
  benchmarkBrief: brief,
  evidence,
  dimensions: dimResults,
  confirmed,
  mustFix,
  shouldFix,
  minor,
  // 细节评委专属
  hollowFindings: detail.hollowFindings ?? [],
  thresholdDrift: detail.thresholdDrift ?? [],
  evidenceIntegrity: {
    blocked: evidenceBlocked,
    violations: integrityViolations,
  },
  // 玩家反馈专属
  unverifiedFeedback: unverifiedAll,
  // 证据缺口：调度员照着补数值或补模拟
  coverage,
  rejectedCount: shardDropped,
  // 收敛三态
  converged,
  stopReason,
  stuckDimensions,
  // 跨轮快照：调度员存进 history
  progressRecord,
  summary,
  // 按维度分组的施工清单
  handoff: handoffText(),
}
