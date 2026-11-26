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
// 内部层次（按任务性质自由编排，不再每轮全量跑满）：
//   ① 分诊（无显式 type/dimensions 时）：只读勘察判任务类型与评分维度，目标逐条归位
//   ② 基准调研（可选）：把参考作品转成逐维可核验口径（基准 brief）
//   ③ 证据包（workflow 外）：调度员先用 critic-evidence 的 prepare_evidence 跑模拟、
//      读数值表、落盘成扁平证据包；workflow 拿 evidenceDir（+ 可选 evidenceIndex 索引表），
//      各角色按条目 id 定点取一次切片，正文不内联
//   ④ 复检（mode=verify）：核对员逐条判旧账，把本轮改动映射到受影响维度
//   ⑤ 找茬：activeDims 按镜头分组并行逐维找茬并自评扣分；
//      玩家反馈那一路改用心理机制 schema；细节评委同批并行审假达标与证据造假
//   ⑥ 判卷：每镜头一个分片判卷（引用式输出）→ 脚本合并 → 轻量汇流收口
//   ⑦ 收敛：脚本按双闸门判定收敛 / 停滞 / 硬停
//
// 硬约束（写在代码里，不靠自觉）：
//   - 插件不含任何游戏名、项目路径或模拟脚本；基准与证据全由调用方传
//   - 分析者 / 分诊员 / 核对员 / 细节评委 / 判卷均无写工具，物理改不了项目文件
//   - **修复不在本档**：workflow 只挑刺与核对，改代码由调度员自己做
//   - 判卷必须分片：单次吃下全部镜头结果再吐全部终裁，镜头一多就会被上游
//     单次输出上限截断（画面档实测 8 路时整轮报废）
//   - 体量闸门：每维 findings ≤8、每片 ≤24、汇流 digest ≤80
//   - 证据不进 prompt：正文只给 evidenceDir 与索引里的条目 id，各角色用 critic-evidence 定点取
//   - agentType 必须带 `critic-pipeline:` 插件前缀，否则换仓库即报 not found
//   - 模型写死在 agent 文件 frontmatter（model:），脚本不逐个传 model
//   - 所有带 schema 的子代理，prompt 末尾写死「必须调用 StructuredOutput」
//   - 评分 = 扣分表：5 - 扣分合计；脚本按扣分项重算，不信手填总分
//   - 玩家反馈不得作为结构证据：anchorKind 枚举里没有 feedback 这一项
//   - 证据造假硬阻断：细节评委抽查锚点与真实配置对不上 → 本轮不算达标
//   - 目标没处安放就拦住收敛：未覆盖目标不静默吞掉（除非调用方显式接受）

export const meta = {
  name: 'design-round',
  description: '一轮游戏设计挑刺：分诊（判任务类型与维度） → 基准调研 → 复检（可选，核对上轮修复） → 逐维找茬（含玩家反馈的心理机制解析）+ 细节评委 → 分片判卷与汇流 → 扣分表与收敛判定。证据由调用方预先用 critic-evidence 备好证据包。只挑刺不改设计。',
  phases: [
    { title: '分诊', detail: '无显式 type/dimensions 时，只读勘察判任务类型、选中维度并把目标逐条归位' },
    { title: '基准调研', detail: '无基准 brief 且有参考作品时，把它转成逐维可核验口径；仅新增参考时做增量补维' },
    { title: '复检', detail: 'mode=verify 时逐条核对上轮必修项现状，并把本轮改动映射到受影响维度' },
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
//   args.evidenceDir     字符串 —— 证据包目录，必填。调度员开跑前先调 critic-evidence 的
//                                  prepare_evidence({projectPath, run, checks, codePaths}) 拿到
//   args.evidenceIndex   数组   —— prepare_evidence 返回的索引表（id/kind/source/tags/summary），
//                                  强烈建议传：传了各角色按条目 id 定点取一次切片；不传则退化
//                                  为按关键词自取（裁决类角色会自己翻，实测更贵）
//   args.feedback        对象|串 —— 玩家反馈：{ text?, files?[] } 或直接字符串，可选
//   args.benchmarkRefs   数组   —— 参考作品名，可选；有则调研出基准 brief
//   args.players         数     —— 游玩人数，默认 1；>=2 才自动开合作/意外/双人差分
//   args.type            字符串 —— 显式任务类型（见 TYPE_PROFILES）；给了就跳过自动分诊
//   args.dimensions      数组   —— 显式维度白名单，可越闸；优先级高于 type
//   args.scope           对象   —— 本轮聚焦切片 { label?, units?[], note? }；镜头只深挖这些单元
//   args.mode            字符串 —— explore / verify；不传则首轮或无历史=explore，有历史=verify
//   args.changes         对象|串 —— 本轮改动摘要 { summary?, stat?, files?[], dimensions?[] }；
//                                  explore 下作回归提醒，verify 下用于定位受影响维度
//   args.prevMustFix     数组   —— 复检旧账明细，覆盖 history 里的 mustFixItems
//   args.acceptUncovered 布尔   —— 显式接受「未覆盖目标」，不再拦收敛
//   args.known           数组   —— 已知未修项，可选
//   args.round           数     —— 第几轮，默认 1
//   args.maxRounds       数     —— 硬停轮数，默认 4
//   args.history         数组   —— 往轮 progressRecord，可选
//   args.benchmarkBrief  对象   —— 跨轮复用的基准 brief，可选；不传且有参考作品则本轮先调研
//   args.depth           字符串 —— quick（分组合并）/ full（逐维分路），可选；
//                                  explore 默认 full，verify 默认 quick
//   args.targetScores    对象   —— 逐维目标分覆盖，可选；默认 4
//   args.projectRef      字符串 —— 当前项目版本/commit，可选；与 brief.appliesTo 比对判过期，
//                                  不传则跳过该项检查（不硬编，避免拿错值误判）
//   args.projectContext  字符串 —— 项目上下文（引擎/品类/目标玩家），可选
// ─────────────────────────────────────────────────────────────

const DEFAULT_TARGET = 4
const MAX_ROUNDS_DEFAULT = 4
const MAX_FINDINGS_PER_DIM = 8
const MAX_SHARD_ITEMS = 24
const MAX_DIGEST_ITEMS = 80

// 游戏设计十一维（顺序即报告顺序）。minPlayers 缺省 1。
// 每个维度的 prompt 里写死「不报什么、交给谁」，防止维度之间抢活。
const DIMENSIONS = [
  {
    key: 'combat-balance',
    name: '数值平衡',
    minPlayers: 1,
    prompt:
      '看战斗与对抗数值是否「站得住」：TTK/伤害曲线的分布、玩家成长斜率与敌人强度是否匹配、' +
      '有没有极值离群（某武器/技能/敌人一枝独秀）、难度曲线有无断崖。' +
      '必须给出实测或手算的偏差数字，禁止「感觉不平」这类空话。' +
      '不报 Boss 机制是否有变化（归 Boss 与敌人机制多样性），不报资源产出消耗（归 经济与成长曲线）。',
  },
  {
    key: 'economy-growth',
    name: '经济与成长曲线',
    minPlayers: 1,
    prompt:
      '看资源与成长是否「咬合」：产出/消耗漏斗是否闭合、有无通胀或死水、' +
      '成长坡度与内容解锁节奏是否匹配、有没有某阶段完全无产出的卡点。' +
      '必须指到具体数值表与公式，给出量化偏差。' +
      '不报内容分支多少与错过可补性（归 收集与分支结构），不报单场战斗的伤害数值（归 数值平衡）。',
  },
  {
    key: 'level-topology',
    name: '地图与关卡结构',
    minPlayers: 1,
    prompt:
      '看地图与关卡的「空间结构」：路径连通与回环、视线遮挡与盲区、单屏同框的信息量、' +
      '地标可见性、通用交互规则的数量（是否每个谜题一套专属规则）、探索回报密度。' +
      '锚点只能是地图/相机配置、几何距离、区域与关卡数据。' +
      '不报战斗数值强弱（归 数值平衡），不报内容解锁与分支取舍（归 收集与分支结构）。',
  },
  {
    key: 'content-branching',
    name: '收集与分支结构',
    minPlayers: 1,
    prompt:
      '看内容分布是否「有选择、有回报、不重复」：必得内容 vs 可选内容的比例、分支路径数量、' +
      '错过后能否补回、重复战斗率、解锁依赖链是否成立。锚点只能是内容表、掉落表、解锁条件、区域清单。' +
      '不报路径空间连通与视线遮挡（归 地图与关卡结构），不报经济产出消耗（归 经济与成长曲线）。',
  },
  {
    key: 'boss-variety',
    name: 'Boss 与敌人机制多样性',
    minPlayers: 1,
    prompt:
      '看 Boss 与敌人机制的多样性：pattern 复用率、弹幕/攻击形状数量、阶段数、预警与弱点、' +
      '机制类型分布（机制怪 / 弹幕 / 蠕虫 / 吞噬者等）、满资源秒杀窗口。' +
      '锚点只能是 Boss 配置表、敌人表、战斗代码。' +
      '不报单个招式的伤害数值是否平衡（归 数值平衡），不报 Boss 出没的空间布局（归 地图与关卡结构）。',
  },
  {
    key: 'fun-structure',
    name: '趣味性结构代理',
    minPlayers: 1,
    prompt:
      '只查结构，不评「好不好玩」：反馈密度（每次操作有多少即时反馈）、' +
      '决策分支（同一情境是否有 ≥2 条有效路径）、失败惩罚强度、节奏峰谷、' +
      '目标梯度（下一目标是否始终可见）。每条缺陷必须指到机制或数值，说不出结构就不扣。' +
      '不报具体地图连通、内容数量、Boss 招式这类专门维度的问题，只评跨系统的一般趣味结构。',
  },
  {
    key: 'co-op-synergy',
    name: '合作性',
    minPlayers: 2,
    prompt:
      '看多人协作是否「必要且划算」：角色/职业互补是否不可替代（单人能否替代）、' +
      '协同收益是否明显大于各自为战、责任分担是否清晰、有没有搭便车漏洞。' +
      '只查结构与数值，不评主观感受。' +
      '不报两人体验是否对等/是否有差分（归 双人差分与对等），不报沟通与救场时刻（归 合作趣味）。',
  },
  {
    key: 'co-op-fun',
    name: '合作趣味',
    minPlayers: 2,
    prompt:
      '只查结构：沟通是否必要（不沟通是否就打不过）、是否有共享决策与互相救场时刻、' +
      '社交涌现空间有多大、失败是否共担。每条都要落到机制，不评「感觉热闹」。' +
      '不报合作是否必要/协同收益（归 合作性），不报两人能力是否对等（归 双人差分与对等）。',
  },
  {
    key: 'coop-differentiation',
    name: '双人差分与对等',
    minPlayers: 2,
    prompt:
      '看双人体验是否「显著差分且对等」：两人的动词/能力分配、信息不对称、主动权轮换、' +
      '嫉妒与搭便车、换位二周目是否仍有新体验。锚点只能是输入映射、能力门、协同收益表、双人专属内容表。' +
      '不报「合作是否有必要 / 沟通是否必要」（归 合作性 / 合作趣味），只判两人体验是否真的不同且对等。',
  },
  {
    key: 'surprise-fun',
    name: '突发意外趣味',
    minPlayers: 2,
    prompt:
      '看随机与意外是否「有趣而不恼人」：随机事件的好坏比是否失衡、意外是否可控（可否应对）、' +
      '有没有戏剧性翻盘时刻、随机是否退化成纯惩罚。必须指到随机表/概率配置。' +
      '不报可预期的固定机制多样性（归 Boss 与敌人机制多样性 / 地图与关卡结构）。',
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

// 任务类型 → 基础维度集。分诊员以打底集为起点增删；调用方也可直接传 type 跳过分诊。
// 判不出、或目标横跨三类以上 → full-mixed（全维覆盖，贵但不漏）。
const TYPE_PROFILES = {
  'balance-tuning': {
    name: '数值平衡调优',
    base: ['combat-balance', 'economy-growth'],
    note: '只治数值与成长曲线；不碰地图、内容结构、多人关系。',
  },
  'level-content': {
    name: '关卡与内容结构',
    base: ['level-topology', 'content-branching'],
    note: '只治空间结构与内容分布；不评数值强弱与多人关系。',
  },
  'boss-encounter': {
    name: 'Boss 与遭遇战',
    base: ['boss-variety'],
    note: '只治机制多样性；目标里明确提数值强弱时可加 combat-balance。',
  },
  'coop-experience': {
    name: '双人合作体验',
    base: ['co-op-synergy', 'co-op-fun', 'coop-differentiation'],
    requirePlayers: 2,
    note: '只治多人关系；players < 2 时本类型不适用。',
  },
  'full-mixed': {
    name: '复合需求',
    base: DIMENSIONS.map((d) => d.key),
    note: '目标跨多类，全维覆盖。',
  },
}

// 默认分组镜头（quick 模式）：每路盯相关几维；depth=full 时拆成逐维一路。
// 注意：玩家反馈那一路（psych）schema 与常规逐维不同，必须单独成路，不并进 fun 组。
const LENS_GROUPS = [
  { key: 'numbers', name: '数值与经济', dimKeys: ['combat-balance', 'economy-growth'] },
  { key: 'structure', name: '地图与内容结构', dimKeys: ['level-topology', 'content-branching', 'boss-variety'] },
  { key: 'fun', name: '趣味结构', dimKeys: ['fun-structure'] },
  { key: 'psych', name: '反馈心理机制', dimKeys: ['feedback-psych'], psych: true },
  { key: 'coop', name: '多人协作', dimKeys: ['co-op-synergy', 'co-op-fun', 'coop-differentiation'] },
  { key: 'surprise', name: '意外趣味', dimKeys: ['surprise-fun'] },
]

// ── 入参归一 ──
const goal = String(A?.goal ?? '').trim()
const projectPath = String(A?.projectPath ?? '').trim()
const round = Math.max(1, Number(A?.round) || 1)
const maxRounds = Math.max(1, Number(A?.maxRounds) || MAX_ROUNDS_DEFAULT)
const history = Array.isArray(A?.history) ? A.history : []
const prevRecord = history.length ? history[history.length - 1] : null
const known = Array.isArray(A?.known) ? A.known : []
const knownBlock = known.length
  ? `\n【前几轮已知未修项（不要重复报，除非这轮又恶化了）】\n${known
      .map((k, i) => `${i + 1}. ${typeof k === 'string' ? k : JSON.stringify(k)}`)
      .join('\n')}\n`
  : ''
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

const evidenceDir = String(A?.evidenceDir ?? '').trim()

// 证据索引（可选但强烈建议）：调度员把 prepare_evidence 返回的索引表原样传进来。
// 有索引时各角色按条目 id 定点取一次切片，不再自己按关键词反复猜——实测没有索引时，
// 判卷 / 复检 / 细节评委会被迫自己探索几十次，比改造前更贵。
const evidenceIndex = (Array.isArray(A?.evidenceIndex) ? A.evidenceIndex : [])
  .filter((e) => e && typeof e === 'object' && String(e.id ?? '').trim())
  .map((e) => ({
    id: String(e.id).trim(),
    kind: String(e.kind ?? '').trim(),
    source: String(e.source ?? '').trim().slice(0, 160),
    tags: (Array.isArray(e.tags) ? e.tags : [])
      .map((t) => String(t ?? '').trim())
      .filter(Boolean)
      .slice(0, 12),
    summary: String(e.summary ?? '').trim().slice(0, 200),
    lineCount: Number(e.lineCount ?? 0) || 0,
  }))
  .slice(0, 400)
const hasEvidenceIndex = evidenceIndex.length > 0

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

// 显式白名单 / 显式类型（白名单优先级最高）
const requested = new Set(
  (Array.isArray(A?.dimensions) ? A.dimensions : []).map(String).filter(Boolean)
)
const rawType = String(A?.type ?? '').trim()
const typeGiven = rawType && TYPE_PROFILES[rawType] ? rawType : ''
if (rawType && !TYPE_PROFILES[rawType]) log(`args.type「${rawType}」不在类型表里，忽略并转分诊。`)

// 逐轮模式：显式优先；不传则首轮/无历史=explore，有历史=verify
const explicitMode = A?.mode === 'explore' || A?.mode === 'verify' ? A.mode : null

// 本轮改动（调度员提供）：字符串（一句说明）或 { summary?, stat?, files?[], dimensions?[] }
const rawChanges = A?.changes
const changes =
  typeof rawChanges === 'string' && rawChanges.trim()
    ? { summary: rawChanges.trim().slice(0, 2000), stat: '', files: [], dimensions: [] }
    : rawChanges && typeof rawChanges === 'object'
      ? {
          summary: String(rawChanges.summary ?? '').trim().slice(0, 2000),
          stat: String(rawChanges.stat ?? '').trim().slice(0, 4000),
          files: (Array.isArray(rawChanges.files) ? rawChanges.files : [])
            .map((x) => String(x).trim())
            .filter(Boolean)
            .slice(0, 200),
          dimensions: (Array.isArray(rawChanges.dimensions) ? rawChanges.dimensions : [])
            .map(String)
            .filter((k) => DIMENSIONS.some((d) => d.key === k)),
        }
      : null
const changesBlock = changes
  ? `\n【本轮改动（调度员提供，用于定位回归）】\n` +
    `${changes.summary ? `- 说明：${clipText(changes.summary, 400)}\n` : ''}` +
    `${changes.stat ? `- 变更统计：${clipText(changes.stat, 1200)}\n` : ''}` +
    `${changes.files.length ? `- 改动文件：${changes.files.slice(0, 60).join('、')}${changes.files.length > 60 ? ' 等' : ''}\n` : ''}` +
    `${changes.dimensions.length ? `- 调用方标注受影响维度：${changes.dimensions.join('、')}\n` : ''}`
  : ''

// 本轮聚焦切片：镜头只深挖这些单元；全局维度仍做基线，不重复深挖
const rawScope = A?.scope
const scope =
  rawScope && typeof rawScope === 'object'
    ? {
        label: String(rawScope.label ?? '').trim().slice(0, 120),
        units: (Array.isArray(rawScope.units) ? rawScope.units : [])
          .map((x) => String(x).trim())
          .filter(Boolean)
          .slice(0, 20),
        note: String(rawScope.note ?? '').trim().slice(0, 300),
      }
    : null
const scopeBlock = scope
  ? `\n【本轮聚焦切片（只深挖这些单元；全局维度仍做基线，但不重复深挖）】\n` +
    `- 切片：${scope.label || '（未命名）'}\n` +
    `${scope.units.map((u) => `- ${u}`).join('\n')}\n` +
    `${scope.note ? `- 说明：${scope.note}\n` : ''}`
  : ''

const acceptUncovered = A?.acceptUncovered === true

// 复检旧账：显式 prevMustFix > history.mustFixItems > history.mustFixLocations（只能按位置核对）
let prevMustFixLimited = false
let prevMustFixItems = []
const rawPrevMustFix = Array.isArray(A?.prevMustFix) ? A.prevMustFix : null
const prevItemsSource =
  rawPrevMustFix ??
  (Array.isArray(prevRecord?.mustFixItems) && prevRecord.mustFixItems.length
    ? prevRecord.mustFixItems
    : null)
if (prevItemsSource) {
  prevMustFixItems = prevItemsSource.slice(0, 40).map((x, i) => ({
    id: `V${i + 1}`,
    dimension: String(x?.dimension ?? ''),
    location: String(x?.location ?? '').slice(0, 240),
    problem: String(x?.problem ?? '').slice(0, 300),
    severity: 'must-fix',
    evidence: String(x?.evidence ?? '').slice(0, 240),
  }))
} else if (Array.isArray(prevRecord?.mustFixLocations) && prevRecord.mustFixLocations.length) {
  prevMustFixLimited = true
  prevMustFixItems = prevRecord.mustFixLocations.slice(0, 40).map((loc, i) => ({
    id: `V${i + 1}`,
    dimension: '',
    location: String(loc).slice(0, 240),
    problem: '（旧史只存了位置，按位置核对）',
    severity: 'must-fix',
    evidence: '',
  }))
}

// ── 早退：缺目标 / 缺证据 ──
if (!goal) {
  log('缺 args.goal，无法判定设计方向。请调度员说明本轮想改善什么。')
  return { error: 'missing args.goal', dimensions: [] }
}

if (!evidenceDir) {
  log(
    '缺证据包 args.evidenceDir。请调度员先用 critic-evidence 的 prepare_evidence({projectPath, run, checks, codePaths}) 生成证据包，把返回的 evidenceDir 传进来；' +
      '本轮明确不跑取证（跑模拟/读数值表都在 workflow 外），也不静默降级。'
  )
  return { error: 'missing args.evidenceDir', dimensions: [] }
}
if (!hasFeedback && !benchmarkRefs.length) {
  log('未给玩家反馈与参考作品：本轮只按证据包里的数值/代码做勘察。')
}

// 上轮分数：复检时没重打的维度沿用
const prevScores = prevRecord?.scores && typeof prevRecord.scores === 'object' ? prevRecord.scores : null

// ── 模式与深度 ──
let effectiveMode = explicitMode ?? (history.length ? 'verify' : 'explore')
let verifyFallback = false
if (effectiveMode === 'verify' && !prevMustFixItems.length && !changes) {
  effectiveMode = 'explore'
  verifyFallback = true
  log('要求复检，但既没有旧账明细也没有改动摘要，降级为全面勘察（explore）。')
}
const depthExplicit = A?.depth === 'full' || A?.depth === 'quick'
let depth =
  A?.depth === 'full' ? 'full' : A?.depth === 'quick' ? 'quick' : effectiveMode === 'verify' ? 'quick' : 'full'

// ── 分诊：显式 dimensions / type 都给了就跳过；否则只读勘察判类型与维度 ──
const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'dimensions', 'adjustments', 'goalCoverage', 'uncoveredGoals', 'rationale'],
  properties: {
    type: { type: 'string', enum: Object.keys(TYPE_PROFILES) },
    dimensions: {
      type: 'array',
      description: '本轮要跑的维度键：以该类型基础集为底增删后的结果，至少一个',
      items: { type: 'string', enum: DIMENSIONS.map((d) => d.key) },
    },
    adjustments: {
      type: 'array',
      description: '相对基础集的每一处增删，逐条给理由；没有调整就置空',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'action', 'why'],
        properties: {
          key: { type: 'string', enum: DIMENSIONS.map((d) => d.key) },
          action: { type: 'string', enum: ['add', 'remove'] },
          why: { type: 'string' },
        },
      },
    },
    goalCoverage: {
      type: 'array',
      description: '目标拆条后的逐条归位',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'dimension', 'note'],
        properties: {
          item: { type: 'string', description: '目标条目原文或极简转述' },
          dimension: {
            type: 'string',
            enum: [...DIMENSIONS.map((d) => d.key), 'none'],
            description: '归属维度键；归不进去填 none',
          },
          note: { type: 'string' },
        },
      },
    },
    uncoveredGoals: {
      type: 'array',
      description: '没有维度能接住的目标条目；会拦住收敛，必须单列',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'why', 'suggestion'],
        properties: {
          item: { type: 'string' },
          why: { type: 'string', description: '为什么现有维度接不住' },
          suggestion: { type: 'string', description: '补证据 / 自定义维度 / 人工拍板' },
        },
      },
    },
    rationale: { type: 'string', description: '类型判断与维度取舍的总理由' },
  },
}

const TRIAGE_PROMPT = `你是设计档的分诊员。只读勘察，判定本轮任务类型与要跑的评分维度；不打分、不找茬、不写改进建议。

【本轮目标】
${goal}
${ctxBlock}${scopeBlock}${changesBlock}
【项目根】${projectPath || '（未指定；只能在给定目标与上下文内判断）'}
【游玩人数】${players}
【玩家反馈】${hasFeedback ? '有' : '无'}

【任务类型表】
${Object.entries(TYPE_PROFILES)
  .map(([k, v]) => `- ${k}（${v.name}）：基础维度 ${v.base.join('、')}。${v.note}`)
  .join('\n')}

【评分维度表】
${DIMENSIONS.map(
  (d) =>
    `- ${d.key}（${d.name}）${(d.minPlayers ?? 1) > 1 ? `[需 ${d.minPlayers} 人]` : ''}：${d.prompt}`
).join('\n')}
${knownBlock}
【分诊规则】
1. 判类型：选最贴的一个；判不出、或目标横跨三类以上 → full-mixed。
2. 定维度：以该类型基础维度集为底，按目标增删；每一处增删写进 adjustments 并给理由（为什么选 / 为什么不选）。不得自造维度键。
3. 目标归位：把目标拆成条目，逐条给 dimension（归不进去填 none）并写一句说明。
4. 归不进去的条目单列 uncoveredGoals，给 suggestion（补证据 / 自定义维度 / 人工拍板）。**绝不静默丢弃目标。**
5. 项目里根本没有这个设计面（没有 Boss / 没有多人 / 没有随机事件 / 没有玩家反馈）就在 rationale 里说明，让调用方剔除。
6. 只读：最多读 12 个文件、每个不超过 200 行；先看目录与关键配置。不得执行命令、不得联网、不得修改文件。

严格按 schema 输出，**必须调用 StructuredOutput，否则整条流程会中断**。`

let triage = null
let triageFallback = false
let type = ''
if (requested.size > 0) {
  type = 'explicit'
  log(`按显式 dimensions 白名单开跑：${[...requested].join('、')}`)
} else if (typeGiven) {
  type = typeGiven
  log(`按显式 type 开跑：${type}（${TYPE_PROFILES[type].name}）`)
} else {
  phase('分诊')
  log('分诊：读目标与项目现状，判任务类型与评分维度…')
  const t = await agent(TRIAGE_PROMPT, {
    label: '分诊:任务类型与维度',
    phase: '分诊',
    agentType: 'critic-pipeline:critic-design-triager',
    schema: TRIAGE_SCHEMA,
  })
  if (t && TYPE_PROFILES[t.type] && Array.isArray(t.dimensions) && t.dimensions.length) {
    triage = t
    type = t.type
    log(
      `分诊完成：${TYPE_PROFILES[type].name}；维度 ${t.dimensions.join('、')}；` +
        `未覆盖目标 ${Array.isArray(t.uncoveredGoals) ? t.uncoveredGoals.length : 0} 条`
    )
  } else {
    triageFallback = true
    type = 'full-mixed'
    log('分诊未返回有效结果，兜底为复合类型（全维覆盖）。')
  }
}

// ── 激活维度 ──
const profile = TYPE_PROFILES[type] ?? TYPE_PROFILES['full-mixed']
const dimFilter =
  requested.size > 0 ? requested : triage ? new Set(triage.dimensions) : new Set(profile.base)
const plannedDims = DIMENSIONS.filter((d) =>
  requested.size > 0 ? requested.has(d.key) : dimFilter.has(d.key)
)
const activeDims = plannedDims.filter((d) => {
  if (requested.size > 0) return true // 显式点名 → 越闸强制开
  if ((d.minPlayers ?? 1) > players) return false // 人数不够 → 关
  if (d.key === 'feedback-psych' && !hasFeedback) return false // 没反馈 → 关
  return true
})
const activeSet = new Set(activeDims.map((d) => d.key))

const gatedOff = plannedDims
  .filter((d) => !activeSet.has(d.key))
  .map((d) => `${d.name}（${(d.minPlayers ?? 1) > players ? `需 ${d.minPlayers} 人` : '无玩家反馈'}）`)
if (gatedOff.length) log(`按闸门关掉：${gatedOff.join('、')}`)

if (!activeDims.length) {
  const hint =
    type === 'coop-experience' && players < 2
      ? '；type=coop-experience 需要 players>=2'
      : dimFilter.has('feedback-psych')
        ? '；只剩玩家反馈维但没给反馈'
        : ''
  log(`按 type/dimensions/players/feedback 过滤后没有任何活跃维度，本轮无从判定${hint}。`)
  return { error: 'no active dimensions', type, triageFallback, dimensions: [], players, hasFeedback }
}

// ── 目标覆盖：没有维度接住的目标会拦住收敛，绝不静默吞掉 ──
const goalCoverage = Array.isArray(triage?.goalCoverage) ? triage.goalCoverage : []
let uncoveredGoals = Array.isArray(triage?.uncoveredGoals)
  ? triage.uncoveredGoals
  : Array.isArray(prevRecord?.uncoveredGoals)
    ? prevRecord.uncoveredGoals
    : []
const acceptedUncovered = acceptUncovered ? uncoveredGoals : []
if (acceptUncovered) {
  if (acceptedUncovered.length) log(`调用方显式接受 ${acceptedUncovered.length} 条未覆盖目标，本轮不拦收敛。`)
  uncoveredGoals = []
}
if (uncoveredGoals.length) {
  log(`有 ${uncoveredGoals.length} 条目标没有对应维度：会拦住收敛（如可忽略请传 acceptUncovered=true）。`)
}

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

// ── brief 固化：脚本不碰磁盘，只做「校验 + 打标」──
// 读写由调度员负责（见 SKILL.md）；脚本决定本轮是复用文件里的还是重新调研。
const BRIEF_PATH = '.critic/benchmark-design.json'

// 只留本档认识的维；缺失的按本档默认口径补齐并提示
function normalizeBrief(raw, keys) {
  const known = new Set(DIMENSIONS.map((d) => d.key))
  const out = []
  const seen = new Set()
  for (const d of Array.isArray(raw?.dimensions) ? raw.dimensions : []) {
    if (!d || typeof d !== 'object' || !known.has(String(d.key)) || seen.has(d.key)) continue
    seen.add(d.key)
    out.push({
      key: d.key,
      referenceApproach:
        typeof d.referenceApproach === 'string' && d.referenceApproach.trim()
          ? d.referenceApproach
          : '（基准未覆盖，按通用质量线判断）',
      verifiableCriteria: (Array.isArray(d.verifiableCriteria) ? d.verifiableCriteria : []).filter(
        (c) => typeof c === 'string' && c.trim()
      ),
      deductionPoints: (Array.isArray(d.deductionPoints) ? d.deductionPoints : []).filter(
        (c) => typeof c === 'string' && c.trim()
      ),
      targetScore:
        Number.isFinite(Number(d.targetScore)) && Number(d.targetScore) > 0
          ? Math.min(5, Math.max(1, Number(d.targetScore)))
          : DEFAULT_TARGET,
    })
  }
  for (const key of keys) {
    if (seen.has(key)) continue
    const dim = DIMENSIONS.find((d) => d.key === key)
    out.push({
      key,
      referenceApproach: '（基准未覆盖，按通用质量线判断）',
      verifiableCriteria: [],
      deductionPoints: [],
      targetScore: DEFAULT_TARGET,
    })
    log(`brief 缺维度「${dim?.name ?? key}」，按本档默认口径补齐。`)
  }
  return out
}

const projectRef = A?.projectRef ? String(A.projectRef).trim() : ''

// 新鲜度只认变更触发：参考作品集合变了，或项目版本与 appliesTo 不一致。
// fetchedAt 只做记录，不参与过期判定（参考作品不会随时间变化，硬设天数只会白跑调研）。
// 只增不减的参考变化走增量（patch）：旧口径原样保留，只补被新增参考影响的维度；
// 有删减 / 版本变化 / 旧 brief 是占位兜底 → 全量重研（删参考会动摇已有维的依据，不能只补不删）。
let briefStatus = benchmarkRefs.length ? 'researched' : 'unused'
let rejectedBriefRevision = null
let patchRequest = null
let briefAffectedDims = []
let briefPatchFailed = false

if (brief) {
  const origin = brief.origin === 'research' ? 'research' : 'fallback'
  const oldRefs = (Array.isArray(brief.refs) ? brief.refs : [])
    .map((r) => String(r).trim())
    .filter(Boolean)
  const addedRefs = benchmarkRefs.filter((r) => !oldRefs.includes(r))
  const removedRefs = oldRefs.filter((r) => !benchmarkRefs.includes(r))
  const versionChanged =
    !!projectRef && !!brief.appliesTo && projectRef !== String(brief.appliesTo)
  if (origin !== 'research' || versionChanged || oldRefs.length === 0 || removedRefs.length > 0) {
    rejectedBriefRevision = Number.isFinite(Number(brief.revision)) ? Number(brief.revision) : null
    const why =
      origin !== 'research'
        ? 'brief 来源是占位兜底（origin=fallback）'
        : versionChanged
          ? '项目版本与 appliesTo 不一致'
          : oldRefs.length === 0
            ? '旧 brief 没有记录参考作品'
            : `参考作品被移除（${removedRefs.join('、')}）`
    if (benchmarkRefs.length) {
      log(`brief 不可复用（${why}），本轮全量重研。`)
      briefStatus = 'stale-researched'
    } else {
      log(`brief 不可复用（${why}），且本轮未给参考作品，无法重研，退化为通用质量线。`)
      briefStatus = 'unused'
    }
    brief = null
  } else if (addedRefs.length > 0) {
    // 增量：只补新增参考，旧维口径不动；调研员可重写旧维但必须写改动理由
    patchRequest = { base: brief, addedRefs }
    briefStatus = 'patched-researched'
    log(
      `brief 增量更新：新增参考 ${addedRefs.length} 部（${addedRefs.join('、')}），` +
        '只补受影响维度，其余沿用旧口径（不整份重研）。'
    )
  } else {
    brief = { ...brief, dimensions: normalizeBrief(brief, activeDims.map((d) => d.key)) }
    briefStatus = 'reused'
  }
}

function stampBrief(raw, opts = {}) {
  const patchMode = opts.mode === 'patch'
  const baseRev = patchMode
    ? Number.isFinite(Number(opts.baseRevision))
      ? Number(opts.baseRevision)
      : 0
    : Number.isFinite(rejectedBriefRevision)
      ? rejectedBriefRevision
      : Number.isFinite(Number(prevRecord?.briefRevision))
        ? Number(prevRecord.briefRevision)
        : 0
  const prevChanges = (patchMode ? opts.baseChanges : Array.isArray(raw?.changes) ? raw.changes : [])
    .filter((c) => c && typeof c === 'object')
    .slice(-19)
  const change =
    patchMode || rejectedBriefRevision !== null
      ? {
          at: typeof raw?.fetchedAt === 'string' ? raw.fetchedAt : '',
          revision: baseRev + 1,
          mode: patchMode ? 'patch' : 'full',
          refsAdded: patchMode ? (opts.addedRefs ?? []) : benchmarkRefs.slice(),
          refsRemoved: patchMode ? [] : (opts.removedRefs ?? []),
          rewrittenDims: patchMode ? (opts.rewrittenDims ?? []) : [],
        }
      : null
  const changes = change ? [...prevChanges, change] : prevChanges
  return {
    ...raw,
    refs: benchmarkRefs.slice(),
    revision: baseRev + 1,
    fetchedAt: typeof raw?.fetchedAt === 'string' ? raw.fetchedAt : '',
    appliesTo: projectRef || String(raw?.appliesTo ?? ''),
    origin: 'research',
    briefMode: patchMode ? 'patch' : 'full',
    changes,
  }
}

// 把增量 patch 合并进旧 brief：patch 列到的维用它，没列的维保留旧口径
function mergeBriefPatch(base, patch) {
  const keys = activeDims.map((d) => d.key)
  const baseDims = Array.isArray(base?.dimensions) ? base.dimensions : []
  const patchDims = Array.isArray(patch?.dimensions) ? patch.dimensions : []
  const rewrittenDims = []
  const dimensions = keys
    .map((key) => {
      const p = patchDims.find((d) => d && String(d.key) === key)
      if (p) {
        rewrittenDims.push({
          key,
          reason: String(p.changeReason ?? '').trim() || '（调研员未写改动理由）',
        })
        return {
          key,
          referenceApproach: p.referenceApproach,
          verifiableCriteria: p.verifiableCriteria,
          deductionPoints: p.deductionPoints,
          targetScore: p.targetScore,
        }
      }
      return baseDims.find((d) => d && String(d.key) === key)
    })
    .filter(Boolean)
  const seenSources = new Set()
  const sources = []
  for (const s of [
    ...(Array.isArray(base?.sources) ? base.sources : []),
    ...(Array.isArray(patch?.sources) ? patch.sources : []),
  ]) {
    if (!s || typeof s !== 'object') continue
    const k = `${String(s.title ?? '').trim()}|${String(s.url ?? '').trim()}`
    if (seenSources.has(k)) continue
    seenSources.add(k)
    sources.push(s)
  }
  const caveats = [
    String(base?.caveats ?? '').trim(),
    String(patch?.caveats ?? '').trim(),
  ]
    .filter(Boolean)
    .join('；')
  return {
    brief: {
      ...base,
      dimensions,
      sources,
      caveats: caveats.slice(0, 1200),
      fetchedAt:
        typeof patch?.fetchedAt === 'string' && patch.fetchedAt.trim()
          ? patch.fetchedAt.trim()
          : String(base?.fetchedAt ?? ''),
    },
    rewrittenDims,
  }
}

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
    revision: 0,
    fetchedAt: '',
    appliesTo: '',
    origin: 'fallback',
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

// ── ① 基准调研（取证已在 workflow 外由调度员用 prepare_evidence 做完）──
const BRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['refs', 'dimensions', 'sources', 'caveats', 'fetchedAt'],
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
    fetchedAt: {
      type: 'string',
      description: '本次调研日期，格式 YYYY-MM-DD（用你已知的当前日期；脚本会补 revision/appliesTo/origin，不用你填）',
    },
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
- fetchedAt：本次调研日期，格式 YYYY-MM-DD（用你已知的当前日期）。

${knownBlock}
严格按 schema 输出，**必须调用 StructuredOutput，否则整条流程会中断**。`

const BRIEF_PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dimensions', 'sources', 'caveats', 'fetchedAt'],
  properties: {
    dimensions: {
      type: 'array',
      description:
        '只列你改动过的维：新增参考影响的维、以及你认为旧口径需要修正的维。其余维一律不要列（会原样保留旧口径）',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'referenceApproach', 'verifiableCriteria', 'deductionPoints', 'targetScore', 'changeReason'],
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
          changeReason: { type: 'string', description: '为什么这一维要改：依据是哪部新参考的哪条公开资料' },
        },
      },
    },
    sources: {
      type: 'array',
      description: '本次为改动维查到的公开出处；没有就空数组',
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
    fetchedAt: {
      type: 'string',
      description: '本次调研日期，格式 YYYY-MM-DD（用你已知的当前日期）',
    },
  },
}

const BRIEF_PATCH_PROMPT = `你是设计档的基准调研员（增量）。调用方往参考名单里加了新作品，旧的评分口径大部分仍然成立，你的任务是**只补新参考带来的差异**，不整份重查。

【本次新增的参考作品】
${(patchRequest?.addedRefs ?? []).map((r, i) => `${i + 1}. ${r}`).join('\n')}

【旧口径全文（这是你的底稿，不是让你重抄）】
${briefRows(activeDims.map((d) => d.key))}
${(Array.isArray(patchRequest?.base?.sources) ? patchRequest.base.sources : [])
  .map((s) => `- ${String(s?.title ?? '').trim()}（${String(s?.url ?? '').trim()}）：${String(s?.note ?? '').trim()}`)
  .join('\n')}

${ctxBlock}
【本轮活跃维度】
${activeDims.map((d) => `- ${d.key}（${d.name}）：${d.prompt}`).join('\n')}

【要求】
- 只在 dimensions 里列**你确实要改的维**：新增参考明显改变了该维做法的，或旧口径依据的资料站不住需要修正的。**没把握就别动，不列就等于保留旧口径。**
- 每改一维必须写 changeReason，说清依据是哪部新参考的哪条公开资料；空理由的改动调度员会当漂移处理。
- referenceApproach 要写清新旧参考各自的做法差异，verifiableCriteria 与 deductionPoints 要能直接落到数值/模拟/代码，targetScore 默认 4。
- 不要碰与新增参考无关的维度；不要整份重查旧参考（你已有旧口径，浪费 token 无意义）。
- sources 只放本次为改动维真看过的公开页面；没看就空数组。不得下载、复制、搬运参考作品的素材或数值表。
- caveats 如实写；fetchedAt 用你已知的当前日期，格式 YYYY-MM-DD。

${knownBlock}
严格按 schema 输出，**必须调用 StructuredOutput，否则整条流程会中断**。`

// 证据包取法：各角色按自己的关键词自取切片，正文不内联
function evidenceBlock(keywords, roleNote) {
  const kw = (Array.isArray(keywords) ? keywords : [keywords]).filter(Boolean)
  return `【证据包（不在 prompt 内联，按需自取）】
项目根：${projectPath || '（未指定）'}
证据包目录：${evidenceDir}
取法：调 critic-evidence 的 get_evidence_slice({ evidenceDir, query })，本轮建议关键词：
${kw.map((k) => `- query: "${k}"`).join('\n')}
无命中时按返回的可用条目清单换词再取；要补看代码用 code_query（mode=grep / read / list）。${roleNote ? `\n${roleNote}` : ''}
不要整包读回，取过的不重复取。`
}

// 按维度名/关键词从证据索引里挑条目（只读索引元数据，不碰正文）
function pickEvidenceEntries(keys, limit) {
  const want = (Array.isArray(keys) ? keys : [keys])
    .map((x) => String(x ?? '').trim().toLowerCase())
    .filter((x) => x.length >= 2)
  const uniq = [...new Set(want)]
  if (!uniq.length) return evidenceIndex.slice(0, limit)
  const scored = evidenceIndex.map((e) => {
    const tags = e.tags.map((t) => t.toLowerCase())
    const source = e.source.toLowerCase()
    const all = `${e.summary} ${tags.join(' ')} ${source}`.toLowerCase()
    let score = 0
    for (const w of uniq) {
      if (tags.some((t) => t === w)) score += 5
      else if (tags.some((t) => t.includes(w) || w.includes(t))) score += 4
      else if (source.includes(w)) score += 3
      else if (all.includes(w)) score += 1
    }
    return { e, score }
  })
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.e)
}

// 定点取切片：把索引里筛出来的条目 id 直接给角色，只准调一次，禁止自己乱翻
function evidencePickBlock(keys, roleNote, opts = {}) {
  const limit = opts.limit ?? 24
  const codeBudget = opts.codeBudget ?? 3
  const picks = pickEvidenceEntries(keys, limit)
  const ids = picks.map((e) => e.id)
  const rows = picks
    .map(
      (e) =>
        `- ${e.id}${e.kind ? ` [${e.kind}]` : ''} ${e.source || ''}${e.summary ? `：${e.summary}` : ''}`
    )
    .join('\n')
  const callLine = ids.length
    ? `取法：只调**一次** get_evidence_slice({ evidenceDir, ids: ${JSON.stringify(ids)} })，把这批正文一次拿回来。`
    : `索引里没有与本维直接对应的条目：最多调**一次** get_evidence_slice({ evidenceDir, query: "…" })，query 用你自己的维度名。`
  const codeLine =
    codeBudget > 0
      ? `补看代码用 code_query，最多 ${codeBudget} 次；核锚点用 verify_anchors 批量机械核，不要逐条读原文。`
      : `核锚点用 verify_anchors 批量机械核，不要逐条读原文；不要自己翻代码。`
  return `【证据切片（定点取，不要把证据包整包读回）】
项目根：${projectPath || '（未指定）'}
证据包目录：${evidenceDir}
索引里筛给你的条目（已按本维关键词挑过；正文没内联，按 id 取）：
${rows || '（无匹配条目）'}
${callLine}
${codeLine}
不许按关键词反复试、不许把整个证据包拉回来；取过的条目不要重复取。${roleNote ? `\n${roleNote}` : ''}`
}

// 统一入口：有索引走定点取切片（便宜、确定），没索引退化为关键词自取（兼容旧调用方）
function evidenceFor(keys, roleNote, opts) {
  return hasEvidenceIndex ? evidencePickBlock(keys, roleNote, opts) : evidenceBlock(keys, roleNote)
}

// 增量轮只派一次「补差异」调研，不重查旧参考；全量轮行为不变
let researchRaw = null
let patchRaw = null
if (patchRequest) {
  patchRaw = await agent(BRIEF_PATCH_PROMPT, {
    label: '调研:基准brief增量',
    phase: '基准调研',
    agentType: 'critic-pipeline:critic-design-researcher',
    schema: BRIEF_PATCH_SCHEMA,
  })
} else if (!brief && benchmarkRefs.length) {
  researchRaw = await agent(RESEARCH_PROMPT, {
    label: '调研:基准brief',
    phase: '基准调研',
    agentType: 'critic-pipeline:critic-design-researcher',
    schema: BRIEF_SCHEMA,
  })
}

if (patchRaw && patchRequest) {
  const merged = mergeBriefPatch(patchRequest.base, patchRaw)
  briefAffectedDims = merged.rewrittenDims.map((d) => d.key)
  brief = stampBrief(
    { ...merged.brief, dimensions: normalizeBrief(merged.brief, activeDims.map((d) => d.key)) },
    {
      mode: 'patch',
      baseRevision: patchRequest.base?.revision,
      baseChanges: Array.isArray(patchRequest.base?.changes) ? patchRequest.base.changes : [],
      addedRefs: patchRequest.addedRefs,
      rewrittenDims: merged.rewrittenDims,
    }
  )
  if (!briefAffectedDims.length) {
    log('基准 brief 增量完成：新增参考未改变任何维口径，全部沿用旧 brief。')
  } else {
    const names = briefAffectedDims
      .map((k) => DIMENSIONS.find((d) => d.key === k)?.name ?? k)
      .join('、')
    log(
      `基准 brief 增量完成：重写 ${briefAffectedDims.length} 维（${names}），其余沿用旧口径（revision ${brief.revision}）。`
    )
  }
} else if (patchRequest) {
  // 增量调研没产出：沿用旧 brief（旧维仍可用），但不假装新增参考已纳入；文件不写回，下轮再试
  brief = {
    ...patchRequest.base,
    dimensions: normalizeBrief(patchRequest.base, activeDims.map((d) => d.key)),
    briefMode: 'unchanged',
  }
  briefPatchFailed = true
  briefStatus = 'reused'
  log('增量调研未产出，本轮沿用旧 brief（新增参考未纳入评分口径，下轮会再试）。')
} else if (researchRaw) {
  brief = stampBrief({
    ...researchRaw,
    dimensions: normalizeBrief(researchRaw, activeDims.map((d) => d.key)),
  })
  log(
    `基准 brief 完成：${brief?.dimensions?.length ?? 0} 维（revision ${brief.revision}）` +
      `${brief?.caveats ? `（${brief.caveats}）` : ''}`
  )
} else if (!brief) {
  brief = fallbackBrief(
    benchmarkRefs.length ? '基准调研未产出，本轮按通用质量线评分' : '未给参考作品，按通用质量线评分'
  )
  // 调研没产出有效结果：占位 brief 不写回文件，下轮重新调研
  briefStatus = 'unused'
  log('没有可用基准 brief，退化为通用质量线。')
}

evidence = { dir: evidenceDir }
log(
  `证据包已就绪：${evidenceDir}（正文由各角色自取，不再内联进 prompt；` +
    (hasEvidenceIndex
      ? `索引 ${evidenceIndex.length} 条，按条目 id 定点取切片）`
      : `未传 evidenceIndex，角色将按关键词自己搜索——判卷/复检这类裁决角色会变贵，建议传入）`)
)

// ── ②b 复检（mode=verify）：核对旧账 + 把改动映射到受影响维度 ──
// 只核对调度员上轮手动修的东西，不铺新面；新问题交给定向回归镜头。
const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'touchedDims', 'summary'],
  properties: {
    items: {
      type: 'array',
      description: '对每条旧账的判定；id 必须来自输入，不得新增',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status', 'evidence', 'note'],
        properties: {
          id: { type: 'string', description: '旧账编号，如 V1' },
          status: {
            type: 'string',
            enum: ['fixed', 'still-present', 'worsened', 'untestable'],
          },
          evidence: { type: 'string', description: '数值:行 / 模拟输出 / 代码位置 / 参考口径' },
          note: { type: 'string', description: '一句话说明；untestable 写清缺什么证据' },
        },
      },
    },
    touchedDims: {
      type: 'array',
      description: '本轮改动波及的评分维度，用于定向回归',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'why'],
        properties: {
          key: { type: 'string', enum: DIMENSIONS.map((d) => d.key) },
          why: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
}

const VERIFY_PROMPT = `你是设计档的复检核对员。本轮不重新铺开找茬，只做两件事：核对上一轮必修项现在好没好，把本轮改动映射到受影响的评分维度。

【项目根】${projectPath || '（未指定；按当前目录）'}
【本轮目标】
${goal}
${ctxBlock}${scopeBlock}${changesBlock}
【上轮必修项（带编号，逐条判；不得新增条目）】
${
  prevMustFixItems.length
    ? prevMustFixItems
        .map(
          (x) =>
            `${x.id} [${x.dimension || '未标维'}] ${x.location}：${x.problem}` +
            `${x.evidence ? `（上轮证据：${x.evidence}）` : ''}`
        )
        .join('\n')
    : '（无旧账）'
}

${evidenceFor(
  ['上一轮模拟输出', 'sim', ...prevMustFixItems.map((x) => x.location).filter(Boolean).slice(0, 6)],
  '要重跑复测就用 run_task({projectPath, command})，命令必须来自上轮记录或证据包 commands 列表。',
  { limit: 16, codeBudget: 2 }
)}

【执行规则】
1. 每条旧账给固定 id（V1、V2…）与 status：fixed / still-present / worsened / untestable；每条都要 evidence。
2. 需要重跑复测时用 run_task；失败不要反复重试，原样记录报错。
3. 旧账之外的新缺陷不要报——那是定向回归镜头的活。
4. touchedDims：根据改动摘要、旧账位置与代码依赖，列出本轮受影响维度并写理由；判断不了就置空。
5. 只读：不得修改项目源码、数值表、配置、资源；只能在指定 outputDir 产生临时文件；不得删除文件、不得安装依赖。
6. 不得下载、复制、搬运参考作品的素材或数值表。
${historyBlock}${knownBlock}
严格按 schema 输出，**必须调用 StructuredOutput，否则整条流程会中断**。`

let verifyResult = null
let touchedDims = []
if (effectiveMode === 'verify') {
  phase('复检')
  log(`复检：核对上轮 ${prevMustFixItems.length} 条必修项${prevMustFixLimited ? '（旧史只有位置）' : ''}…`)
  const vr = await agent(VERIFY_PROMPT, {
    label: '复检:旧账核对',
    phase: '复检',
    agentType: 'critic-pipeline:critic-design-verifier',
    schema: VERIFY_SCHEMA,
  })
  if (vr) {
    verifyResult = vr
    const items = Array.isArray(vr.items) ? vr.items : []
    const count = (s) => items.filter((x) => x.status === s).length
    log(
      `核对完成：已修 ${count('fixed')} / 仍存在 ${count('still-present')} / 更糟 ${count('worsened')} / 无法验证 ${count('untestable')}`
    )
  } else {
    effectiveMode = 'explore'
    verifyFallback = true
    if (!depthExplicit) depth = 'full'
    log('核对员未返回结果，本轮降级为全面勘察（explore / full）。')
  }
}

if (effectiveMode === 'verify') {
  const touched = new Set()
  for (const x of prevMustFixItems) {
    if (x.dimension && activeSet.has(x.dimension)) touched.add(x.dimension)
  }
  for (const k of changes?.dimensions ?? []) {
    if (activeSet.has(k)) touched.add(k)
  }
  for (const x of verifyResult?.touchedDims ?? []) {
    const k = String(x?.key ?? '')
    if (activeSet.has(k)) touched.add(k)
  }
  // 上轮就没达标的维也重打，否则 carried 分数会永远卡在目标线下拖住收敛
  for (const [k, v] of Object.entries(prevScores ?? {})) {
    const n = Number(v)
    if (Number.isFinite(n) && activeSet.has(k) && n < targetFor(k)) touched.add(k)
  }
  touchedDims = [...touched]
  if (prevMustFixLimited && !touchedDims.length) log('旧账只有位置没有维度，且核对员没给出映射：本轮无定向回归镜头。')
  if (!touchedDims.length) log('复检没有受影响的维度：跳过找茬，全部沿用上轮分数。')
  else log(`复检受影响维度：${touchedDims.join('、')}`)
}

// 复检补充块：注入镜头与心理路，明确「只重打这些维、只报改动相关回归」
const verifyBlock =
  effectiveMode === 'verify'
    ? `\n【本轮是复检（不是全面重挖）】\n` +
      `本轮只重打以下受影响维度：${touchedDims.join('、') || '（无）'}\n` +
      `\n【上轮必修项与核对结论】\n` +
      (prevMustFixItems.length
        ? prevMustFixItems
            .map((it) => {
              const v = (verifyResult?.items ?? []).find((x) => String(x?.id) === it.id)
              return (
                `- ${it.id} [${it.dimension || '未标维'}] ${it.location}：${it.problem} → ` +
                `${v?.status ?? 'untestable'}${v?.evidence ? `（${clipText(v.evidence, 160)}）` : ''}`
              )
            })
            .join('\n')
        : '（无旧账）') +
      `\n\n只重打上列维度与本次改动波及面；新缺陷只报与本次改动直接相关的回归；没证据就 no-evidence，不许猜「应该好了」。\n`
    : ''

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
            enum: ['assessed', 'no-evidence', 'not-applicable'],
            description:
              'assessed=有证据并已判；no-evidence=该维没有任何可用证据；not-applicable=项目根本没有这个设计面（如没有 Boss），不计分也不阻塞',
          },
          statusNote: {
            type: 'string',
            description: 'status 非 assessed 时必填原因；not-applicable 要写清项目缺什么',
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
${ctxBlock}${scopeBlock}${changesBlock}${verifyBlock}
${evidenceFor(
  lens.dimKeys.flatMap((k) => {
    const d = DIMENSIONS.find((x) => x.key === k)
    return [d?.name ?? k, ...k.split('-')]
  }),
  '数值配置/公式/掉落表/成长曲线都在证据包里；缺什么写进 coverageGaps 交调度员补，不要自己满项目翻。',
  { limit: 30, codeBudget: 4 }
)}
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
10. 若给了「本轮聚焦切片」，只在切片单元内深挖；切片之外只维持全局基线，不展开铺量。
11. **每维最多报 8 条 findings**；超出时自己挑最重的 8 条，其余并进同维扣分项或丢弃，不要堆数量。
12. 只有项目**根本不存在这个设计面**（如没有 Boss、没有多人模式）才用 status=not-applicable，并在 statusNote 写清缺什么；「这一轮没证据」不等于「不存在」。

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
${ctxBlock}${scopeBlock}${changesBlock}${verifyBlock}
【玩家反馈原文】
${feedbackText || '（调用方仅给了反馈文件，按下面路径读取）'}
${feedbackFiles.length ? feedbackFiles.map((f) => `- ${f}`).join('\n') : ''}

${evidenceFor(
  ['feedback', 'balance', 'reward', 'punish', ...feedbackText.slice(0, 200).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2).slice(0, 8)],
  '反馈原话不能当锚点；锚必须落到证据包里的数值/模拟输出/代码位置，指不到就进 unverified。',
  { limit: 20, codeBudget: 3 }
)}
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
8. 若给了「本轮聚焦切片」，只深挖切片单元相关的反馈；与切片无关但确实可落锚的反馈可以单列，不要铺量。
9. mechanismFindings 最多 20 条；超出时挑机制最清晰、锚点最硬的保留。

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

// 本轮实际重打的维度：复检只碰受影响的，勘察是全部活跃维
const finderDimKeys = effectiveMode === 'verify' ? touchedDims : activeDims.map((d) => d.key)

const DETAIL_PROMPT = `你是设计档的细节评委，独立于镜头与主判卷，只做三件事：审「假达标」、守「证据真实」、查「阈值漂移」。

【本轮目标】
${goal}
${ctxBlock}
【基准 brief】
${briefRows(finderDimKeys)}

${evidenceFor(
  finderDimKeys.flatMap((k) => {
    const d = DIMENSIONS.find((x) => x.key === k)
    return [d?.name ?? k, ...k.split('-')]
  }),
  '判据 B 要核锚点时就调 verify_anchors({projectPath, anchors:[{path, line, expectText|expectNumber}]}) 批量机械核对，别逐条读原文。',
  { limit: 20, codeBudget: 0 }
)}
${historyBlock}${knownBlock}
【判据 A：假达标】表面像结构判断，实则空泛。例：说「反馈密度不足」却指不出哪次操作没有反馈；说「成长曲线不顺」却给不出坡度数字。
- 每条写 dimension、problem、whyHollow（哪一层没对齐结构）、evidence。
- 看不出来就把 hollowFindings 置空，不要凑。

【判据 B：证据造假】只拦**具体、可核验的造假**：
- 用玩家原话当结构证据（anchorKind 本不该容纳 feedback）；
- 锚点指向的数值/代码行根本不存在，或与证据包对不上（先用 verify_anchors 机械核，失败项才深看）；
- 编造玩家没说过的话。
- 每条写 finding、quote、why。有具体证据才报，模糊怀疑不报。

【判据 C：阈值漂移】找茬者把达标线私自放宽（例：brief 要求偏差 <20%，找茬者按 <50% 放过）。
- 每条写 dimension、briefCriterion、lensClaim、why。

你不改任何文件，也不给总分——打分归镜头，终裁归主判卷。
不得访问、下载或搬运参考作品的素材或数值表。

严格按 schema 输出，**必须调用 StructuredOutput，否则整条流程会中断**。`

// 复检只开受影响维度的镜头；勘察开全部活跃维
const regressSet = new Set(touchedDims)
const lensUniverse =
  effectiveMode === 'verify' ? activeDims.filter((d) => regressSet.has(d.key)) : activeDims
const lensList =
  depth === 'full'
    ? lensUniverse.map((d) => ({
        key: d.key,
        name: d.name,
        dimKeys: [d.key],
        psych: d.key === 'feedback-psych',
      }))
    : LENS_GROUPS.map((g) => ({ ...g, dimKeys: g.dimKeys.filter((k) => activeSet.has(k)) }))
        .filter((g) => g.dimKeys.length > 0)
        .map((g) =>
          effectiveMode === 'verify'
            ? { ...g, dimKeys: g.dimKeys.filter((k) => regressSet.has(k)) }
            : g
        )
        .filter((g) => g.dimKeys.length > 0)

let detail = {
  hollowFindings: [],
  anchorViolations: [],
  thresholdDrift: [],
  summary: '本轮未跑找茬',
}
let lensResults = []
let unverifiedAll = []

if (lensList.length) {
  phase('找茬')
  log(
    `模式=${effectiveMode}；深度=${depth}；players=${players}；反馈=${hasFeedback ? '有' : '无'}；` +
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
  lensResults = (finderRaw?.slice(0, -1) ?? []).filter(Boolean)
  detail = detailRaw ?? {
    hollowFindings: [],
    anchorViolations: [],
    thresholdDrift: [],
    summary: '细节评委未返回结果',
  }

  // 体量闸门：单维 findings 超过上限就按原顺序截断（镜头已按严重度排过），并记数
  lensResults = lensResults.map((r) => {
    const perDim = new Map()
    const kept = []
    let dropped = 0
    for (const f of Array.isArray(r.findings) ? r.findings : []) {
      const k = String(f?.dimension ?? '')
      const n = perDim.get(k) ?? 0
      if (n >= MAX_FINDINGS_PER_DIM) {
        dropped++
        continue
      }
      perDim.set(k, n + 1)
      kept.push(f)
    }
    if (dropped) log(`镜头「${r.lens}」单维 findings 超上限，已截断 ${dropped} 条。`)
    return { ...r, findings: kept }
  })

  unverifiedAll = lensResults.flatMap((r) => r.unverified ?? [])
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
    if (effectiveMode === 'verify') {
      // 复检的定向回归全军覆没：不当作全盘失败，沿用上轮分数，靠旧账核对结论判收敛
      log('定向回归镜头全部未返回；本轮不重打分，全部沿用上轮分数。')
    } else {
      log('所有镜头都未返回结果，本轮无法判设计。')
      return {
        error: 'all lenses failed',
        round,
        players,
        type,
        triage,
        mode: effectiveMode,
        activeDimKeys: activeDims.map((d) => d.key),
        evidence,
        benchmarkBrief: brief,
        dimensions: [],
        converged: false,
        stopReason: 'insufficient-evidence',
        summary: '全部镜头未返回；检查插件 agent 定义与会话重启状态。',
      }
    }
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
const lensShards = lensResults.map((r) => {
  const all = Array.isArray(r.findings) ? r.findings : []
  const kept = all.slice(0, MAX_SHARD_ITEMS)
  if (all.length > kept.length) log(`镜头「${r.lens}」findings 超 ${MAX_SHARD_ITEMS} 条，分片只送前 ${MAX_SHARD_ITEMS} 条。`)
  return {
    lens: r.lens,
    result: r,
    items: kept.map((f) => ({ id: `F${++findingSeq}`, ...f })),
  }
})

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

${evidenceFor(
  [
    ...dims.map((d) => d.name),
    ...(shard.items ?? [])
      .map((x) => String(x?.evidence ?? x?.location ?? ''))
      .filter(Boolean)
      .slice(0, 6),
  ],
  '只用于核对本片 findings 的锚点，不要从中另找新缺陷；能机械核的（文件:行:数值）先用 verify_anchors 批量核完再裁决。',
  { limit: 16, codeBudget: 0 }
)}
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
  const digest = confirmed.slice(0, MAX_DIGEST_ITEMS).map((f) => ({
    id: f.id,
    fromLens: f.fromLens,
    dimension: f.dimension,
    location: clipText(f.location, 120),
    problem: clipText(f.problem, 160),
    severity: f.severity,
    anchorKind: f.anchorKind,
  }))
  if (confirmed.length > digest.length) log(`汇流清单超 ${MAX_DIGEST_ITEMS} 条，只送前 ${MAX_DIGEST_ITEMS} 条。`)
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
  // 项目根本没有这个设计面：不计分、不阻塞收敛，单列返回
  const notApplicable = lensDim?.status === 'not-applicable'
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
  const exempt = dim.key === 'feedback-psych' && !assessed && !notApplicable
  // 复检：本轮没重打的维度沿用上轮分数（标 carried，不再当无证据）
  const carriedScore = !assessed && !notApplicable ? Number(prevScores?.[dim.key]) : NaN
  const carried = Number.isFinite(carriedScore)
  const finalScore = assessed ? score : carried ? carriedScore : null
  return {
    key: dim.key,
    name: dim.name,
    status: notApplicable ? 'not-applicable' : assessed ? 'assessed' : carried ? 'carried' : 'no-evidence',
    score: finalScore,
    lensScore,
    target,
    meetsTarget: finalScore !== null && finalScore >= target,
    hollow,
    exempt,
    carried,
    statusNote: String(lensDim?.statusNote ?? ''),
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

const unassessed = dimResults.filter((d) => d.status === 'no-evidence' && !d.exempt)
// carried 也算数：上轮就没达标的维，本轮没重打也不能当达标
const belowTarget = dimResults.filter((d) => d.score !== null && d.score < d.target)
const carriedDims = dimResults.filter((d) => d.status === 'carried').map((d) => d.key)
const notApplicable = dimResults.filter((d) => d.status === 'not-applicable')

// 复检旧账：核对员判 still-present / worsened / untestable 的都算没修完
const undecided = prevMustFixItems.filter((it) => {
  const v = (verifyResult?.items ?? []).find((x) => String(x?.id) === it.id)
  return !v || v.status !== 'fixed'
})
const oldOpen = effectiveMode === 'verify' ? undecided : []

// brief 是否有真内容（非 fallbackBrief 占位）——决定是否附参考做法
const hasValidBrief = (brief?.dimensions ?? []).some(
  (x) => typeof x?.referenceApproach === 'string' && x.referenceApproach.trim() && !x.referenceApproach.includes('基准未覆盖')
)

// 目标没处安放就拦住收敛：不静默吞，不假装达标
const goalUncovered = uncoveredGoals.length > 0
const converged =
  mustFix.length === 0 &&
  !evidenceBlocked &&
  unassessed.length === 0 &&
  belowTarget.length === 0 &&
  oldOpen.length === 0 &&
  !goalUncovered

const improved = prevScores
  ? dimResults.some((d) => {
      const p = Number(prevScores[d.key])
      return Number.isFinite(p) && d.score !== null && d.score > p
    })
  : false
const prevMustFixCount = Number(prevRecord?.mustFixCount)
const newMustFix = Number.isFinite(prevMustFixCount) ? mustFix.length > prevMustFixCount : true
const stagnated = !!prevScores && round > 1 && !improved && !newMustFix

const briefRevisionNow = Number.isFinite(Number(brief?.revision)) ? Number(brief.revision) : null
const prevBriefRevision = Number.isFinite(Number(prevRecord?.briefRevision))
  ? Number(prevRecord.briefRevision)
  : null
// 旧条目缺 briefRevision 视为「版本不明」，不参与判定（向前兼容）
const briefChanged =
  briefRevisionNow !== null && prevBriefRevision !== null && briefRevisionNow !== prevBriefRevision
// 增量轮只改了几维，其余口径没动，分数仍可比 → 不停轮，只标记受影响的维；
// 全量重研（参考被移除 / 版本变了 / 旧 brief 是兜底）等于换了整套尺子 → 仍然停轮
const briefRebaselined = briefChanged && brief?.briefMode !== 'patch'
// 对外统一口径：增量轮只列重写的维；全量重研且确实是换尺子时，全部活跃维都不可比
const briefAffectedAll =
  brief?.briefMode === 'patch'
    ? briefAffectedDims
    : briefRebaselined
      ? activeDims.map((d) => d.key)
      : []

let stopReason = 'continue'
if (converged) stopReason = 'converged'
else if (goalUncovered) stopReason = 'goal-uncovered'
else if (briefRebaselined) stopReason = 'brief-revised'
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
  mode: effectiveMode,
  type,
  scores: scoreMap,
  targets: targetMap,
  activeDimKeys: activeDims.map((d) => d.key),
  carriedDimKeys: carriedDims,
  mustFixCount: mustFix.length,
  mustFixLocations: mustFix.map((f) => `${f.dimension ?? ''}:${f.location ?? ''}`),
  // 明细供下一轮复检逐条核对；旧史只有位置时退回 mustFixLocations
  mustFixItems: mustFix.slice(0, 40).map((f) => ({
    dimension: f.dimension ?? '',
    location: clipText(f.location, 240),
    problem: clipText(f.problem, 240),
    severity: f.severity ?? 'must-fix',
    evidence: clipText(f.evidence, 240),
  })),
  // 未覆盖目标跨轮追账：不清空就继续拦收敛，除非调用方明确 acceptUncovered
  uncoveredGoals,
  // 本轮所用基准修订号：调度员记进 history；增量轮的分数不可比范围见 briefAffectedDims
  briefRevision: briefRevisionNow,
  briefMode: brief?.briefMode ?? 'full',
  briefAffectedDims: briefAffectedAll,
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
  if (uncoveredGoals.length) {
    lines.push('【目标没有维度接住（先决定怎么处理，否则永远收敛不了）】')
    for (const g of uncoveredGoals) {
      lines.push(`- 「${g.item}」：${g.why}；建议：${g.suggestion}`)
    }
    lines.push('处理方式：补证据 / 用 args.dimensions 显式加维 / 人工拍板后传 args.acceptUncovered=true 放行')
    lines.push('')
  }
  if (effectiveMode === 'verify' && verifyResult) {
    const items = verifyResult.items ?? []
    const count = (s) => items.filter((x) => x.status === s).length
    lines.push(
      `【复检结论】已修 ${count('fixed')} / 仍存在 ${count('still-present')} / 更糟 ${count('worsened')} / 无法验证 ${count('untestable')}`
    )
    for (const it of prevMustFixItems) {
      const v = items.find((x) => String(x?.id) === it.id)
      if (!v || v.status === 'fixed') continue
      lines.push(`- ${it.id} ${v.status}：${it.location}（${clipText(v.note || v.evidence, 160)}）`)
    }
    if (carriedDims.length) lines.push(`- 本轮未重打、沿用上轮分数的维：${carriedDims.join('、')}`)
    lines.push('')
  }
  if (evidenceBlocked) {
    lines.push('【硬阻断：证据完整性】本轮不算达标，先补真证据再谈分数。')
    for (const v of integrityViolations) {
      lines.push(`- ${v.finding}：${v.why}`)
    }
    lines.push('')
  }
  for (const d of dimResults) {
    if (d.status === 'not-applicable') {
      lines.push(`【${d.name}】不适用：${d.statusNote || '项目没有这个设计面'}`)
      lines.push('')
      continue
    }
    const scoreText = d.score === null ? '未取证' : `${d.score}${d.carried ? '（沿用上轮）' : ''}`
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
  `收敛判定：${stopReason}；模式 ${effectiveMode}；类型 ${type}；必修 ${mustFix.length} / 建议 ${shouldFix.length} / 可忽略 ${minor.length}` +
    `；低于目标 ${belowTarget.length} 维；证据缺口 ${coverage.length} 条` +
    (oldOpen.length ? `；旧账未清 ${oldOpen.length} 条` : '') +
    (goalUncovered ? `；目标未覆盖 ${uncoveredGoals.length} 条` : '') +
    (notApplicable.length ? `；不适用 ${notApplicable.length} 维` : '') +
    (evidenceBlocked ? '；证据完整性硬阻断' : '')
)

return {
  round,
  goal,
  depth,
  mode: effectiveMode,
  // 分诊结果：type/dimensions 请原样回传 args.type / args.dimensions，避免每轮重诊导致维度漂移
  type,
  triage,
  triageFallback,
  verifyFallback,
  goalCoverage,
  uncoveredGoals,
  acceptedUncovered: acceptUncovered,
  scope,
  verifier: verifyResult,
  touchedDims,
  carriedDims,
  notApplicable,
  players,
  hasFeedback,
  benchmarkRefs,
  activeDimKeys: activeDims.map((d) => d.key),
  // 基准 brief：调度员写回 .critic/benchmark-design.json，下轮读出传回，避免重复调研
  benchmarkBrief: brief,
  // brief 固化信号：调度员据此决定是否写回（只在重研后写回并 +1，复用轮不动文件）
  briefStatus,
  briefPath: BRIEF_PATH,
  briefRevision: briefRevisionNow,
  // 基准本轮怎么来的：full 全量重研 / patch 增量补维 / unchanged 增量失败沿用旧 brief / reused 原样复用
  briefMode: brief?.briefMode ?? 'full',
  // 增量轮里被新参考重写口径的维度（这些维的旧分数不可比；全量轮即全部活跃维）
  briefAffectedDims: briefAffectedAll,
  briefPatchFailed,
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
