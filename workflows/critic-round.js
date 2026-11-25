// critic-round.js —— 一轮多视角挑刺流水线
//
// 定位：只负责「找茬」，绝不修代码。干活（探索/施工/验收）由团队台本负责，
//       本 workflow 只干挑刺这一格，产出一份结构化清单交回主代理（调度员）。
//
// 内部层次（正常 3 层，升级门触发则 4 层）：
//   ① 分诊：一位「分诊员」读意图+diff 判任务类型（不查文件、不改文件、只转发判断）
//   ② 并行扇出：N 路「找茬的」同时开跑
//      常规四路：正确性与回归 / 兼容 / 性能 / 用户体验（UX 路先枚举用户可达路径矩阵再找缺陷）
//      外加可选的第五路「发散者」
//   ③ 判卷：每路镜头配一个分片判卷（只回编号+保留/驳回+定级）→ 脚本合并 → 轻量汇流判卷
//   ④ 可选：汇流判卷判定高风险 → 再派 1~2 路补充「找茬的」→ 分片判卷后并入
//
// 判卷必须分片：单次吃下全部镜头结果再吐全部终裁，镜头一多就会被上游
// 单次输出上限截断（画面档实测 8 路时思考十几万字符、tool call 被截断整轮报废）。
//
// 「发散者」是唯一被允许看超本 diff 范围的找茬者：它枚举同功能/同交互族的
// 所有入口路径（拖拽→扫拖拽的全部入口，而非只盯 diff 那几行），专抓"改了这
// 条路径、漏了同族其它路径"这种同类缺陷（比如改了拖拽起手、漏了跨容器更新后
// 的避让重算）。它产出的发现分三类，由判卷归置：
//   repairIncomplete  本次改动没修完的部分  → 进主清单
//   preExisting       同场景的既有老缺陷    → 单列，交用户拍板，不混入本次必修
//   adjacentRisk      相邻风险、低置信        → 进 escalate / minor
//
// 硬约束（写在代码里，不靠自觉）：
//   - 找茬的一律 agentType: 'critic-pipeline:critic-reader'（插件 agents/critic-reader.md，disallowedTools 写禁用工具 + 快档模型）
//   - 判卷的一律 agentType: 'critic-pipeline:critic-judge'（插件 agents/critic-judge.md，disallowedTools 写禁用工具 + 强档模型）
//   - agentType 必须带 `critic-pipeline:` 插件前缀，否则引擎只在项目本地 .claude/agents/ 里找，换仓库即报 not found
//   - 模型写死在 agent 文件 frontmatter（model:），脚本不再逐个传 model，换档只改 .md
//   - 每轮都是全新的一次性子代理，无记忆 —— 天然满足"换人挑刺"
//   - 所有带 schema 的子代理，prompt 末尾写死"必须调用 StructuredOutput，否则流程中断"

export const meta = {
  name: 'critic-round',
  description: '一轮多视角挑刺：分诊判任务类型 → 并行 N 路只读找茬（含发散者）→ 分片判卷与汇流去伪定级 →（可选）升级补充 → 返回结构化 findings',
  phases: [
    { title: '分诊', detail: '分诊员按任务性质判类型（整理文件/新功能/修bug/重构），决定跑哪些视角' },
    { title: '找茬', detail: 'N 路只读 critic 并行，各看一个视角（发散者枚举同族入口路径）' },
    { title: '判卷', detail: '每路镜头一片分片判卷（引用式），脚本按编号回填正文' },
    { title: '汇流', detail: '轻量判卷跨片去重、统一严重度、校对路径矩阵、判断是否升级' },
    { title: '升级', detail: '仅在汇流判卷判定高风险时，补派 1~2 路新视角' },
    { title: '终裁', detail: '升级补派的 findings 分片判卷后并入最终清单' },
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
//   args.diff       字符串 —— 本轮改动（git diff 或改动摘要），必填
//   args.intent     字符串 —— 本轮修改意图／需求，必填
//   args.known      数组   —— 前几轮已知未修项，可选
//   args.type       字符串 —— 任务类型：file-cleanup / feature / hotfix / refactor，可选；
//                             不传则先由分诊员按 diff+intent 自动判断（推荐日常用不着传）
//   args.lenses     数组   —— 手动指定视角，可选；传了就覆盖 type 展开的视角集合
//   args.projectContext 字符串 —— 项目上下文（技术栈/版本矩阵/项目红线/领域术语），可选；
//                                 不传则流水线保持技术栈无关，任何仓库都能跑
//   args.diverge    布尔   —— 是否启用发散者，可选；不传则按 type 的 profile 决定
//   args.escalate   布尔   —— 是否允许判卷的触发升级门，可选；不传则按 profile 决定
//   args.maxEscalate 数    —— 升级补充路数上限，可选；不传则按 profile 决定
// ─────────────────────────────────────────────────────────────

// 任务类型 → 挑刺配置（自由编排的核心：按任务性质决定跑多重的挑刺）
//   file-cleanup 最轻：整理文件不是行为改动，性能/兼容/发散/升级全是浪费
//   feature/refactor 最全：常规开发与重构碰高风险面概率高，升级门开
//   hotfix 四路+发散但关升级：求快，同族漏改靠发散者兜
const TYPE_PROFILES = {
  'file-cleanup': {
    lenses: ['correctness-regression', 'ux'],
    diverge: false,
    escalate: false,
    maxEscalate: 0,
    hint: '批量整理文件、重命名、移动、格式化、删废代码等不改变行为意图的改动',
  },
  feature: {
    lenses: ['correctness-regression', 'compat', 'perf', 'ux'],
    diverge: true,
    escalate: true,
    maxEscalate: 2,
    hint: '常规新功能开发、新增能力、扩展已有功能',
  },
  hotfix: {
    lenses: ['correctness-regression', 'compat', 'perf', 'ux'],
    diverge: true,
    escalate: false,
    maxEscalate: 0,
    hint: '紧急修复、修 bug、修线上问题，要求快',
  },
  refactor: {
    lenses: ['correctness-regression', 'compat', 'perf', 'ux'],
    diverge: true,
    escalate: true,
    maxEscalate: 2,
    hint: '重构、架构调整、大范围结构性改动',
  },
}

const DEFAULT_TYPE = 'feature'

const ALL_LENSES = [
  {
    key: 'correctness-regression',
    name: '正确性与回归',
    prompt:
      '两件事都查：①改动本身——是否真的把声称的问题修对了、逻辑有没有写反、边界/空值/并发/异常路径是否被照顾；' +
      '②影响面——原本正常的行为是否被打破、调用方是否被波及、有无状态残留或旧状态未清理。',
  },
  {
    key: 'compat',
    name: '兼容',
    prompt:
      '检查「换一个环境就退化或直接炸」的写法。兼容维度不止操作系统，凡运行环境差异都算：' +
      '运行时/语言/解释器版本、依赖库版本、操作系统与平台、文件系统（路径分隔符、大小写敏感、长路径、只读目录）、' +
      '编码与换行（UTF-8/GBK、CRLF/LF）、区域与时区、权限与沙箱、shell 与终端、网络与代理、硬件资源。' +
      '按本项目实际涉及的维度逐条对照；若调用方给出具体版本矩阵或环境清单，以它为准，不要硬套不适用的维度。',
  },
  {
    key: 'perf',
    name: '性能',
    prompt:
      '检查耗时/内存/资源占用/关键路径阻塞：有没有 O(n²) 或更差的复杂度、无谓重算、同步 IO、' +
      '无谓重建、大对象驻留、无界缓存或泄漏、无界并发。' +
      '关键路径指本项目里最忌卡顿的那条（UI 线程、事件循环、请求处理主链路等），按项目实际所指判断。',
  },
  {
    key: 'ux',
    name: '用户体验',
    prompt:
      '两个动作都要做：①先枚举用户可达路径（按调用方给出的 projectContext 维度；没有就按状态 × 环境 × 操作交叉，宁可多列），' +
      '每条路径标 已覆盖/未覆盖/不适用；②再逐条只针对未覆盖路径查体验缺陷。' +
      '只报能用代码指出来、能证实的体验缺陷（凡纯品味——配色、间距、圆角、字号、动效节奏——一律不报）：' +
      '①用户可点的操作没有任何反馈（既无提示也无可见状态变化）；' +
      '②异步/长任务缺加载中、成功、失败、空态；' +
      '③该禁用时没禁用、不该点时仍可点；' +
      '④报错把栈信息/英文裸串/内部状态原样抛给用户；' +
      '⑤流程走死胡同——某步之后没有任何出口或返回路径；' +
      '⑥触摸目标小于平台规范；' +
      '⑦文本未处理溢出/截断/换行；' +
      '⑧颜色、图标、文案硬编码导致深色主题/多主题下不可用；' +
      '⑨无障碍缺失（关键控件无可访问性标识、缺焦点顺序）；' +
      '⑩文案与该项目领域术语不一致或明显误导。' +
      '每条必须给出 文件:行 与「用户实际会碰到什么」。平台阈值与领域术语以调用方提供的 projectContext 为准。' +
      '路径枚举产物单独放 pathMatrix（path/status/note），不要把路径本身写成 findings——findings 只放真缺陷。',
  },
]

const diff = String(A?.diff ?? '').trim()
const intent = String(A?.intent ?? '').trim()
const known = Array.isArray(A?.known) ? A.known : []

// 项目上下文：技术栈、版本/平台矩阵、项目红线、领域术语等。由调用方传入，
// 不传则整套流水线保持技术栈无关（可用于任意仓库）。
const projectContext = String(A?.projectContext ?? '').trim()
const ctxBlock = projectContext
  ? `\n【项目上下文（调用方提供，判断时按此对齐）】\n${projectContext}\n`
  : ''

if (!diff) {
  log('缺 args.diff，无法挑刺。请调度员传入本轮改动。')
  return { error: 'missing args.diff', findings: [] }
}

// ── 分诊：任务类型判定 ──
// 优先用调用方显式传的 args.type；没传才请分诊员读 diff+intent 判。
// 分诊员只看传进来的文本，不查文件、不改文件，只负责把 type 转发回来。
const CLASSIFIER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'reason'],
  properties: {
    type: { type: 'string', enum: Object.keys(TYPE_PROFILES) },
    reason: { type: 'string', description: '一句话判定理由' },
  },
}

const CLASSIFIER_PROMPT = `你是挑刺流水线的分诊员。你的活只有一个：读下面给出的本轮修改意图与改动内容，判断它属于哪种任务类型，然后按 schema 输出。

【可选类型】
${Object.entries(TYPE_PROFILES)
  .map(([k, v]) => `- ${k}：${v.hint}`)
  .join('\n')}

判断只看改动性质：改的是行为逻辑还是只动文件组织、改动范围与风险面。
拿不准时选 ${DEFAULT_TYPE}（更全面，宁多勿漏）。
不要查文件、不要跑命令、不要修改任何东西——事实底座已经给全了。

【本轮修改意图】
${intent || '（调度员未提供，按 diff 自行推断）'}

【本轮改动】
${diff}

严格按 schema 输出，**必须调用 StructuredOutput，否则整条流程会中断**。`

// 选路优先级：显式 lenses > 显式 type > 分诊员判断
let taskType = String(A?.type ?? '').trim()
const wantedKeys = new Set(Array.isArray(A?.lenses) ? A.lenses.map(String) : [])
const explicitLenses = ALL_LENSES.filter((l) => wantedKeys.has(l.key))
const hasExplicitLenses = explicitLenses.length > 0

if (!TYPE_PROFILES[taskType]) taskType = ''
if (!taskType && !hasExplicitLenses) {
  phase('分诊')
  log('调用方未指定任务类型，分诊员判断中…')
  const verdict = await agent(CLASSIFIER_PROMPT, {
    label: '分诊:判类型',
    phase: '分诊',
    agentType: 'critic-pipeline:critic-reader',
    schema: CLASSIFIER_SCHEMA,
  })
  taskType = TYPE_PROFILES[verdict?.type] ? verdict.type : DEFAULT_TYPE
  log(`分诊结果：${taskType}${verdict?.reason ? ` —— ${verdict.reason}` : ''}`)
}

const profile = TYPE_PROFILES[taskType] ?? TYPE_PROFILES[DEFAULT_TYPE]

// 展开 profile → 实际配置；调用方显式传的单参数永远盖过 profile
const lenses = hasExplicitLenses
  ? explicitLenses
  : ALL_LENSES.filter((l) => profile.lenses.includes(l.key))
const diverge = A?.diverge === undefined ? profile.diverge : A.diverge !== false
const allowEscalate = A?.escalate === undefined ? profile.escalate : A.escalate !== false
const maxEscalate = Number.isFinite(A?.maxEscalate)
  ? Math.max(1, A.maxEscalate)
  : profile.maxEscalate

const knownBlock = known.length
  ? `\n【前几轮已知未修项（不要重复报，除非这轮又恶化了）】\n${known
      .map((k, i) => `${i + 1}. ${typeof k === 'string' ? k : JSON.stringify(k)}`)
      .join('\n')}\n`
  : ''

// ── 发散者：唯一被允许看超 diff 范围的找茬者 ──
// 规则：先强制枚举同功能/同交互族的入口路径矩阵（每条标 已覆盖/未覆盖/不适用），
//       再只针对「未覆盖」的路径报缺陷。产出分三类：
//       repairIncomplete（本次改动没修完，进主清单）
//       preExisting（同场景老毛病，单列给用户拍板）
//       adjacentRisk（相邻风险，低置信，进 escalate/minor）
const DIVERGER_PROMPT = `你与其他挑刺者不同：你是发散者，唯一被允许超出本轮 diff 范围找茬的人。

本轮改动聚焦在某个功能/交互上。你的任务不是再审一遍 diff，而是回答：
「同一功能/交互族里，还有哪些入口路径没被这次改动覆盖到？」

硬性步骤（必须先做第一步，不许跳到报 bug）：
1) 从 diff 与意图推断本次触碰的功能/交互族（例：动了拖拽起手 → 扫遍拖拽的全部入口路径）。
   **只聚焦与本次改动最相关的同族，不铺开无关的交互族。** 例：本次只动拖拽，就不去扫"点按""长按"这类不同交互的入口。
2) 枚举该功能/交互族的【入口路径矩阵】，每条路径必须标注 covered / uncovered / n-a：
   - covered：这次 diff 或已有防线已照顾到
   - uncovered：存在但这次改动没碰、也不确定有没有防线
   - n-a：当前代码库里此路径不存在（说明理由）
   **矩阵只覆盖与本次改动同一交互族**的同类入口，宁深勿泛：同一族内的入口要尽量列全，
   但不要扩散到无关交互族，也不要为凑数列 n-a 路径（没有就说明理由，不硬凑）。
3) 只针对 uncovered 的路径找缺陷。发现的问题按 bucket 分三类：
   - repairIncomplete：这次改动本来就该修到但没修完（属本次改动缺陷，最值钱）
   - preExisting：与本次改动无关、同场景里早就存在的老毛病
   - adjacentRisk：沾边的风险、把握不大

证据要求与其他挑刺者相同：每条必须带 文件:行 或具体代码引用，报不出证据就不报。
禁止自由联想：矩阵里标不了 covered/uncovered/n-a 的路径不许报。

【本轮修改意图】
${intent || '（调度员未提供，按 diff 自行推断）'}
${ctxBlock}
【本轮改动】
${diff}
${knownBlock}
【输出要求】
- pathMatrix 每条含 path / status / note；status 只能是 covered / uncovered / n-a。
- findings 只允许来自 uncovered 路径；每条必须带 bucket 与 文件:行 证据。
- 没有发现时 findings 返回空数组，pathMatrix 照常给全。
- 严格按下面的 schema 输出，**必须调用 StructuredOutput，否则整条流程会中断**。`

const DIVERGER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pathMatrix', 'findings'],
  properties: {
    pathMatrix: {
      type: 'array',
      description: '同功能/同交互族的入口路径矩阵，先于 findings 枚举',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'status', 'note'],
        properties: {
          path: { type: 'string', description: '一条入口路径（用户可触发/程序化触发/变体）' },
          status: { type: 'string', enum: ['covered', 'uncovered', 'n-a'] },
          note: { type: 'string', description: '判为该状态的依据或缺失防线说明' },
        },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['location', 'problem', 'bucket', 'severity', 'confidence', 'evidence'],
        properties: {
          location: { type: 'string' },
          problem: { type: 'string' },
          bucket: {
            type: 'string',
            enum: ['repairIncomplete', 'preExisting', 'adjacentRisk'],
            description: '三类桶：没修完/老毛病/相邻风险',
          },
          severity: { type: 'string', enum: ['must-fix', 'should-fix', 'minor'] },
          confidence: { type: 'number', description: '0~1，越高越确定' },
          evidence: { type: 'string' },
        },
      },
    },
  },
}

// UX 视角专用 schema：比常规多一段 pathMatrix，供判卷校对用户可达路径覆盖情况
const UX_FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'pathMatrix', 'findings'],
  properties: {
    lens: { type: 'string' },
    pathMatrix: {
      type: 'array',
      description:
        '用户可达路径矩阵，先于 findings 枚举；与发散者的入口路径矩阵互相独立（这里只枚举用户实际可走到的路径）',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'status', 'note'],
        properties: {
          path: { type: 'string' },
          status: { type: 'string', enum: ['covered', 'uncovered', 'n-a'] },
          note: { type: 'string', description: '判为该状态的依据或缺失体验防御说明' },
        },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['location', 'problem', 'severity', 'confidence', 'evidence'],
        properties: {
          location: { type: 'string', description: '文件:行，或明确代码位置' },
          problem: { type: 'string', description: '问题是什么（大白话）' },
          severity: { type: 'string', enum: ['must-fix', 'should-fix', 'minor'] },
          confidence: { type: 'number', description: '0~1，越高越确定' },
          evidence: {
            type: 'string',
            description: '支撑证据：代码引用/调用链/复现思路/用户实际会碰到什么',
          },
        },
      },
    },
  },
}

// 分发 schema：UX 路走专用 schema，其余走常规 schema
function schemaForLens(lens) {
  return lens.key === 'ux' ? UX_FINDINGS_SCHEMA : FINDINGS_SCHEMA
}

const divergerBriefing = diverge ? DIVERGER_PROMPT : null

// 公共交接单：每路 critic 都拿到同样的事实底座
function briefing(lens) {
  return `你是一位只读挑刺专家，本轮视角 = 【${lens.name}】。${lens.prompt}

你不能修改任何文件，也不需要跑命令；只读文件、看下面这份改动清单，凭证据找茬。

【本轮修改意图】
${intent || '（调度员未提供，按 diff 自行推断）'}
${ctxBlock}
【本轮改动】
${diff}
${knownBlock}
【输出要求】
- 只报你真能在代码里指出位置的项，每条必须带 文件:行 或具体代码引用。
- 纯风格偏好、"为挑而挑"、无法证实的猜测，一律不报。
- 若本视角下没发现问题，findings 返回空数组。
- 严格按下面的 schema 输出，**必须调用 StructuredOutput，否则整条流程会中断**。`
}

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'findings'],
  properties: {
    lens: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['location', 'problem', 'severity', 'confidence', 'evidence'],
        properties: {
          location: { type: 'string', description: '文件:行，或明确代码位置' },
          problem: { type: 'string', description: '问题是什么（大白话）' },
          severity: { type: 'string', enum: ['must-fix', 'should-fix', 'minor'] },
          confidence: { type: 'number', description: '0~1，越高越确定' },
          evidence: { type: 'string', description: '支撑证据：代码引用/调用链/复现思路' },
        },
      },
    },
  },
}

// ── ① 并行扇出：N 路找茬同时开跑（发散者算一路，但用独立 schema） ──
phase('找茬')
log(
  `任务类型=${taskType || '手动'}；开 ${lenses.length} 路 + ${diverge ? 1 : 0} 路发散者` +
    `${allowEscalate ? '（升级门开）' : '（升级门关）'}：${lenses.map((l) => l.name).join(' / ')}`
)

const thunks = lenses.map((lens) => () =>
  agent(briefing(lens), {
    label: `找茬:${lens.name}`,
    phase: '找茬',
    agentType: 'critic-pipeline:critic-reader',
    schema: schemaForLens(lens),
  }).then((r) => (r ? { ...r, lens: r.lens || lens.name } : null))
)

if (divergerBriefing) {
  thunks.push(() =>
    agent(divergerBriefing, {
      label: '找茬:发散者',
      phase: '找茬',
      agentType: 'critic-pipeline:critic-reader',
      schema: DIVERGER_SCHEMA,
    })
  )
}

const raw = await parallel(thunks)

const divergerRaw = diverge ? (raw[raw.length - 1] ?? null) : null
const perLens = (diverge ? raw.slice(0, -1) : raw).filter(Boolean)
const allFindings = perLens.flatMap((r) =>
  (r.findings || []).map((f) => ({ ...f, fromLens: r.lens }))
)

// UX 路的用户可达路径矩阵（本路独有），单独留着透传给判卷校对
const uxMatrix = perLens.find((r) => r.lens === '用户体验')?.pathMatrix ?? []

// 发散者的发现也送判卷归置（带 bucket 标记），路径矩阵单独留着透传
const divergerMatrix = Array.isArray(divergerRaw?.pathMatrix) ? divergerRaw.pathMatrix : []
const divergentFindings = (divergerRaw?.findings || []).map((f) => ({
  ...f,
  fromLens: '发散者',
}))

log(
  `收到 ${allFindings.length} 条原始 findings（去伪前）` +
    (diverge ? ` + 发散者 ${divergentFindings.length} 条 / 路径矩阵 ${divergerMatrix.length} 条` : '')
)

// ── ② 判卷：分片判卷（每路镜头一片，引用式输出）→ 脚本合并 → 轻量汇流 ──
// 背景：单个判卷要一次吃下全部镜头结果、吐出全部终裁，镜头一多就会被上游
// 单次输出上限截断（画面档实测 8 路时思考十几万字符、tool call 被截断整轮报废）。
// 这里每路镜头配一个分片判卷，只回「编号 + 保留/驳回 + 定级」，
// 正文与证据由脚本从原始 findings 回填；路径矩阵直接交汇流判卷校对。
phase('判卷')

function clipText(v, n) {
  const s = String(v ?? '')
  return s.length > n ? `${s.slice(0, n)}…(截断 ${s.length - n} 字)` : s
}

let findingSeq = 0
const findingShards = perLens.map((r) => ({
  lens: r.lens,
  items: (r.findings || []).map((f) => ({ id: `F${++findingSeq}`, ...f, fromLens: r.lens })),
}))
if (divergentFindings.length) {
  findingShards.push({
    lens: '发散者',
    items: divergentFindings.map((f) => ({ id: `F${++findingSeq}`, ...f })),
  })
}

const SHARD_JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts', 'summary'],
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
          bucket: {
            type: 'string',
            enum: ['repairIncomplete', 'preExisting', 'adjacentRisk'],
            description: '仅发散者那路需要：可改判 bucket，改不了就照抄',
          },
          reason: { type: 'string', description: '一句话理由，不抄正文' },
        },
      },
    },
    summary: { type: 'string', description: '本片一句话结论' },
  },
}

function shardJudgePrompt(shard) {
  const isDivergeShard = shard.lens === '发散者'
  const bucketBlock = isDivergeShard
    ? `\n发散者发现归置规则：
- bucket=repairIncomplete：属本次改动没修完，照常定级。
- bucket=preExisting：同场景老毛病，与本次改动无关，照抄即可，脚本会单列给用户拍板。
- bucket=adjacentRisk：相邻风险。置信够就定 minor，把握不足就驳回。
- 发散者的 location/problem 一样要过证据关：证据站不住的直接驳回。\n`
    : ''
  return `你是代码档的分片判卷，只审【${shard.lens}】这一路镜头自己的产出，不与其他镜头交叉。你只做两件事：
1) 逐条裁决下面列出的 finding：保留还是驳回；保留项给出定级（must-fix / should-fix / minor）。**用 id 引用，不要抄正文**。
2) 一句话写本片结论。
规则：不许新增镜头没报过的缺陷；证据站不住或明显「为挑而挑」才驳回，拿不准就保留。
${bucketBlock}
【本轮修改意图】
${intent}
${ctxBlock}

【本片 findings（只裁决这些 id）】
${JSON.stringify(shard.items, null, 2)}

严格按 schema 输出，**必须调用 StructuredOutput，否则整条流程会中断**。`
}

const shardRaw = await parallel(
  findingShards.map((shard) => () =>
    agent(shardJudgePrompt(shard), {
      label: `分片判卷:${shard.lens}`,
      phase: '判卷',
      agentType: 'critic-pipeline:critic-judge',
      schema: SHARD_JUDGE_SCHEMA,
    })
  )
)

let confirmed = []
let preExisting = []
let rejected = 0
let shardFailed = 0
findingShards.forEach((shard, idx) => {
  const sr = shardRaw?.[idx] ?? null
  if (!sr) {
    shardFailed++
    for (const item of shard.items) {
      if (item.bucket === 'preExisting') preExisting.push(item)
      else confirmed.push({ ...item })
    }
    return
  }
  const verdicts = new Map((sr.verdicts ?? []).map((v) => [String(v.id), v]))
  for (const item of shard.items) {
    const v = verdicts.get(item.id)
    if (v?.action === 'drop') {
      rejected++
      continue
    }
    const merged = { ...item, severity: v?.severity ?? item.severity }
    const bucket = v?.bucket ?? item.bucket
    if (bucket === 'preExisting') preExisting.push(merged)
    else confirmed.push({ ...merged, bucket })
  }
})
if (shardFailed) log(`有 ${shardFailed} 片分片判卷未返回，该片按原始 findings 全量保留。`)

// ── 轻量汇流判卷：只读各片保留项的紧凑清单 ──
const FINAL_JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mergeClusters', 'severityOverrides', 'summary'],
  properties: {
    mergeClusters: {
      type: 'array',
      description: '同一问题被多路镜头分别报出的，按 id 归组；脚本只保留每组第一个',
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
    pathMatrix: {
      type: 'array',
      description: '入口路径矩阵校对后透传（可修正 status/note）；无发散者时返回空数组',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'status', 'note'],
        properties: {
          path: { type: 'string' },
          status: { type: 'string', enum: ['covered', 'uncovered', 'n-a'] },
          note: { type: 'string' },
        },
      },
    },
    userPathMatrix: {
      type: 'array',
      description: '用户体验路的用户可达路径矩阵校对后透传；无 UX 路时返回空数组',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'status', 'note'],
        properties: {
          path: { type: 'string' },
          status: { type: 'string', enum: ['covered', 'uncovered', 'n-a'] },
          note: { type: 'string' },
        },
      },
    },
    needEscalate: { type: 'boolean', description: '是否需要补派新视角再挑一轮' },
    escalateLenses: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string', description: '一句话总结本轮整体结论' },
  },
}

function finalJudgePrompt() {
  const digest = confirmed.map((f) => ({
    id: f.id,
    fromLens: f.fromLens,
    location: clipText(f.location, 120),
    problem: clipText(f.problem, 160),
    severity: f.severity,
  }))
  return `你是代码档的汇流判卷。分片判卷已经逐片裁决过，你只做跨片收口，不再看原始证据：
1) 跨片去重：同一个缺陷被不同镜头分别报出的，按 id 归组（mergeClusters）；脚本只保留每组第一个。不同问题不要硬并。
2) 统一严重度：跨片口径明显不一致时给 severityOverrides；否则不动。
3) 校对路径矩阵：核对 status 是否站得住（可修正 status/note），入口矩阵放 pathMatrix，用户体验路的放 userPathMatrix，不要混。
4) 判断是否需要补派新视角再挑一轮（needEscalate）——只有当改动碰了高风险面（权限/并发/安全/认证/数据迁移/不可逆操作）或你对现有结论明显没把握时才置 true，并写明 escalateLenses。
5) 一句话总结。
不要新增缺陷；不要复述正文；拿不准的分组不要建。
${diverge ? `\n【入口路径矩阵（发散者产出，校对后透传）】\n${JSON.stringify(divergerMatrix, null, 2)}\n` : ''}
${uxMatrix.length ? `\n【用户体验路的用户可达路径矩阵（核对 status，放 userPathMatrix）】\n${JSON.stringify(uxMatrix, null, 2)}\n` : ''}
【本轮修改意图】
${intent}
${ctxBlock}

【分片保留项（引用式，第 1 轮）】
${JSON.stringify(digest, null, 2)}

严格按 schema 输出，**必须调用 StructuredOutput，否则整条流程会中断**。`
}

phase('汇流')
log(`汇流判卷：收口 ${confirmed.length} 条保留项…`)
const finalJudge = confirmed.length
  ? ((await agent(finalJudgePrompt(), {
      label: '汇流:代码终裁',
      phase: '汇流',
      agentType: 'critic-pipeline:critic-judge',
      schema: FINAL_JUDGE_SCHEMA,
    })) ?? null)
  : null
if (!finalJudge && confirmed.length) log('汇流判卷未返回，按分片结果直接合并。')

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

let finalConfirmed = confirmed.map(({ id, ...rest }) => rest)
const finalPreExisting = preExisting.map(({ id, bucket, ...rest }) => rest)
let finalPathMatrix = diverge ? (finalJudge?.pathMatrix ?? divergerMatrix) : []
let finalUserPathMatrix = finalJudge?.userPathMatrix?.length ? finalJudge.userPathMatrix : uxMatrix

// ── ③ 升级门（可选）：汇流判卷判高风险 → 补派 1~2 路全新视角 ──
let escalateInfo = null
const needEscalate = finalJudge === null ? true : finalJudge?.needEscalate === true
if (allowEscalate && needEscalate && (finalJudge?.escalateLenses?.length ?? 0) > 0) {
  phase('升级')
  const extra = (finalJudge?.escalateLenses ?? []).slice(0, maxEscalate)
  log(`汇流判卷要求升级，补派 ${extra.length} 路：${extra.join(' / ')}`)

  const extraRaw = await parallel(
    extra.map((lensDesc, i) => () =>
      agent(briefing({ name: `升级-${i + 1}`, prompt: lensDesc }), {
        label: `找茬:升级${i + 1}`,
        phase: '升级',
        agentType: 'critic-pipeline:critic-reader',
        schema: FINDINGS_SCHEMA,
      }).then((r) => (r ? { ...r, lens: r.lens || `升级-${i + 1}` } : null))
    )
  )
  const extraShards = extraRaw
    .map((r, i) =>
      r
        ? {
            lens: r.lens || `升级-${i + 1}`,
            items: (r.findings || []).map((f) => ({ id: `F${++findingSeq}`, ...f, fromLens: r.lens || `升级-${i + 1}` })),
          }
        : null
    )
    .filter((s) => s && s.items.length)

  if (extraShards.length) {
    phase('终裁')
    const extraShardRaw = await parallel(
      extraShards.map((shard) => () =>
        agent(shardJudgePrompt(shard), {
          label: `分片判卷:${shard.lens}`,
          phase: '终裁',
          agentType: 'critic-pipeline:critic-judge',
          schema: SHARD_JUDGE_SCHEMA,
        })
      )
    )
    const seenKeys = new Set(finalConfirmed.map((f) => `${f.location}||${f.problem}`))
    let extraRaised = 0
    extraShards.forEach((shard, idx) => {
      const sr = extraShardRaw?.[idx] ?? null
      const verdicts = new Map((sr?.verdicts ?? []).map((v) => [String(v.id), v]))
      for (const item of shard.items) {
        if (sr) {
          const v = verdicts.get(item.id)
          if (v?.action === 'drop') {
            rejected++
            continue
          }
          const severity = v?.severity ?? item.severity
          const k = `${item.location}||${item.problem}`
          if (seenKeys.has(k)) continue
          seenKeys.add(k)
          const { id, ...rest } = item
          finalConfirmed.push({ ...rest, severity })
          extraRaised++
        } else {
          const k = `${item.location}||${item.problem}`
          if (seenKeys.has(k)) continue
          seenKeys.add(k)
          const { id, ...rest } = item
          finalConfirmed.push(rest)
          extraRaised++
        }
      }
    })
    escalateInfo = { reasons: extra, extraRaised }
  } else {
    escalateInfo = { reasons: extra, extraRaised: 0 }
  }
}

// ── 返回给调度员（结构化） ──
const mustFix = finalConfirmed.filter((f) => f.severity === 'must-fix')
const shouldFix = finalConfirmed.filter((f) => f.severity === 'should-fix')
const minor = finalConfirmed.filter((f) => f.severity === 'minor')

log(
  `终裁完成：必修 ${mustFix.length} / 建议 ${shouldFix.length} / 可忽略 ${minor.length}（驳回 ${rejected}）` +
    (diverge ? `；发散：老毛病 ${finalPreExisting.length} 条 / 入口路径矩阵 ${finalPathMatrix.length} 条` : '') +
    `；用户可达路径矩阵 ${finalUserPathMatrix.length} 条`
)

return {
  round: 1,
  intent,
  // 分诊结果：taskType 为 '' 表示调用方手动指定了 lenses，未走 profile
  type: taskType,
  profile: {
    lenses: profile.lenses,
    diverge: profile.diverge,
    escalate: profile.escalate,
    maxEscalate: profile.maxEscalate,
  },
  lenses: lenses.map((l) => l.name),
  diverge,
  escalateAllowed: allowEscalate,
  confirmed: finalConfirmed,
  mustFix,
  shouldFix,
  minor,
  // 发散者专属：老毛病单列（交用户拍板，不进 handoff），入口路径矩阵透传
  preExisting: finalPreExisting,
  pathMatrix: finalPathMatrix,
  // UX 路专属：用户可达路径矩阵（判卷校对后）
  userPathMatrix: finalUserPathMatrix,
  rejectedCount: rejected,
  escalate: escalateInfo,
  summary: finalJudge?.summary ?? '',
  // 交给调度员回派施工队时可直接用的文字清单
  handoff: finalConfirmed
    .filter((f) => f.severity !== 'minor')
    .map((f) => `- [${f.severity}] ${f.location}：${f.problem}（依据：${f.evidence}）`)
    .join('\n'),
}
