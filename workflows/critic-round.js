// critic-round.js —— 一轮多视角挑刺流水线
//
// 定位：只负责「找茬」，绝不修代码。干活（探索/施工/验收）由团队台本负责，
//       本 workflow 只干挑刺这一格，产出一份结构化清单交回主代理（调度员）。
//
// 内部层次（正常 2 层，升级门触发则 3 层）：
//   ① 并行扇出：N 路「找茬的」同时开跑
//      常规四路：正确性与回归 / 兼容 / 性能 / 用户体验（UX 路先枚举用户可达路径矩阵再找缺陷）
//      外加可选的第五路「发散者」
//   ② 汇总：一位「判卷的」去伪 + 定级 + 自主判断要不要加派
//   ③ 可选：判卷的判定高风险 → 再派 1~2 路补充「找茬的」→ 判卷的二次汇总
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
//   - 找茬的一律 agentType: 'critic-pipeline:critic-reader'（插件 agents/critic-reader.md，只读工具 + 快档模型）
//   - 判卷的一律 agentType: 'critic-pipeline:critic-judge'（插件 agents/critic-judge.md，只读工具 + 强档模型）
//   - agentType 必须带 `critic-pipeline:` 插件前缀，否则引擎只在项目本地 .claude/agents/ 里找，换仓库即报 not found
//   - 模型写死在 agent 文件 frontmatter（model:），脚本不再逐个传 model，换档只改 .md
//   - 每轮都是全新的一次性子代理，无记忆 —— 天然满足"换人挑刺"
//   - 所有带 schema 的子代理，prompt 末尾写死"必须调用 StructuredOutput，否则流程中断"

export const meta = {
  name: 'critic-round',
  description: '一轮多视角挑刺：并行 N 路只读找茬（含发散者）→ 判卷去伪定级 →（可选）升级补充 → 返回结构化 findings',
  phases: [
    { title: '找茬', detail: 'N 路只读 critic 并行，各看一个视角（发散者枚举同族入口路径）' },
    { title: '判卷', detail: '去伪存真 + 定级 + 判断是否需升级；发散发现归三类桶' },
    { title: '升级', detail: '仅在判卷判定高风险时，补派 1~2 路新视角' },
    { title: '终裁', detail: '汇总最终清单' },
  ],
}

// ─────────────────────────────────────────────────────────────
// 入参（由调度员传）：
//   args.diff       字符串 —— 本轮改动（git diff 或改动摘要），必填
//   args.intent     字符串 —— 本轮修改意图／需求，必填
//   args.known      数组   —— 前几轮已知未修项，可选
//   args.lenses     数组   —— 只挑这几路视角，可选；缺省=四路全开
//   args.projectContext 字符串 —— 项目上下文（技术栈/版本矩阵/项目红线/领域术语），可选；
//                                 不传则流水线保持技术栈无关，任何仓库都能跑
//   args.diverge    布尔   —— 是否启用发散者（默认 true；false 关闭）
//   args.escalate   布尔   —— 是否允许判卷的触发升级门，默认 true
//   args.maxEscalate 数    —— 升级补充路数上限，默认 2
// ─────────────────────────────────────────────────────────────

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

const diff = String(args?.diff ?? '').trim()
const intent = String(args?.intent ?? '').trim()
const known = Array.isArray(args?.known) ? args.known : []
const allowEscalate = args?.escalate !== false
const diverge = args?.diverge !== false // 发散者默认常开，传 false 关闭
const maxEscalate = Number.isFinite(args?.maxEscalate) ? Math.max(1, args.maxEscalate) : 2

// 项目上下文：技术栈、版本/平台矩阵、项目红线、领域术语等。由调用方传入，
// 不传则整套流水线保持技术栈无关（可用于任意仓库）。
const projectContext = String(args?.projectContext ?? '').trim()
const ctxBlock = projectContext
  ? `\n【项目上下文（调用方提供，判断时按此对齐）】\n${projectContext}\n`
  : ''

if (!diff) {
  log('缺 args.diff，无法挑刺。请调度员传入本轮改动。')
  return { error: 'missing args.diff', findings: [] }
}

// 选路：显式传了 lenses 就只用那几路，否则四路全开
let lenses = ALL_LENSES
if (Array.isArray(args?.lenses) && args.lenses.length) {
  const wanted = new Set(args.lenses.map(String))
  const picked = ALL_LENSES.filter((l) => wanted.has(l.key))
  if (picked.length) lenses = picked
}

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
2) 枚举该功能/交互族的【入口路径矩阵】，每条路径必须标注 covered / uncovered / n-a：
   - covered：这次 diff 或已有防线已照顾到
   - uncovered：存在但这次改动没碰、也不确定有没有防线
   - n-a：当前代码库里此路径不存在（说明理由）
   矩阵至少覆盖：用户可直接触发的全部入口、程序化触发的同类路径（如跨容器/程序更新）、
   配置开关/主题/深色等变体路径。宁多勿漏。
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

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'confirmed',
    'userPathMatrix',
    'rejectedCount',
    'needEscalate',
    'escalateLenses',
    'summary',
  ],
  properties: {
    confirmed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['location', 'problem', 'severity', 'evidence', 'fromLens'],
        properties: {
          location: { type: 'string' },
          problem: { type: 'string' },
          severity: { type: 'string', enum: ['must-fix', 'should-fix', 'minor'] },
          evidence: { type: 'string' },
          fromLens: { type: 'string' },
        },
      },
    },
    // 发散者发现在判卷后的归置结果（无发散者时为空数组）
    pathMatrix: {
      type: 'array',
      description: '发散者的入口路径矩阵原样透传（判卷可修正 status/note），无发散者时空数组',
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
      description: '用户体验路的用户可达路径矩阵（校对后透传），无 UX 路时为空数组',
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
    preExisting: {
      type: 'array',
      description: '发散者确认的老毛病（bucket=preExisting），单列给用户拍板，绝不混入 confirmed',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['location', 'problem', 'severity', 'evidence'],
        properties: {
          location: { type: 'string' },
          problem: { type: 'string' },
          severity: { type: 'string', enum: ['must-fix', 'should-fix', 'minor'] },
          evidence: { type: 'string' },
        },
      },
    },
    rejectedCount: { type: 'number', description: '被驳掉的假阳性条数' },
    needEscalate: { type: 'boolean', description: '是否需要补派新视角再挑一轮' },
    escalateLenses: {
      type: 'array',
      description: 'needEscalate 为 true 时要补的具体视角描述',
      items: { type: 'string' },
    },
    summary: { type: 'string', description: '一句话总结本轮整体结论' },
  },
}

// ── ① 并行扇出：N 路找茬同时开跑（发散者算一路，但用独立 schema） ──
phase('找茬')
log(`开 ${lenses.length} 路 + ${diverge ? 1 : 0} 路发散者：${lenses.map((l) => l.name).join(' / ')}`)

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

// ── ② 判卷：去伪 + 定级 + 判断是否升级（发散发现归三桶） ──
phase('判卷')

function judgePrompt(findings, round, divergent) {
  const divergeBlock =
    diverge && divergent.length
      ? `\n【发散者发现（带 bucket 标记，必须按下述规则归置）】\n${JSON.stringify(divergent, null, 2)}\n
发散者发现归置规则：
- bucket=repairIncomplete：属本次改动没修完，归入 confirmed（照常定级）。
- bucket=preExisting：同场景老毛病，与本次改动无关——归入 preExisting，绝不混入 confirmed。
- bucket=adjacentRisk：相邻风险。置信够就归 confirmed 定 minor；把握不足则体现在 needEscalate/escalateLenses 里。
- 发散者的 location/problem 一样要过证据关：证据站不住的直接驳掉（计进 rejectedCount）。`
      : ''

  return `你是判卷的（主任医师），不是挑刺的人。你的活只有三件：
1) 把下面 ${findings.length} 条原始 findings 去重、剔除假阳性与"为挑而挑"、给每条定级（must-fix / should-fix / minor）；
2) 判断是否需要补派新视角再挑一轮（needEscalate）——只有当改动碰了高风险面（权限/并发/安全/认证/数据迁移/不可逆操作）或你对现有结论明显没把握时才置 true；
3) 一句话总结。

findings 只报这次改动引起的问题；发散者（fromLens=发散者）的发现是唯一例外，按 bucket 规则归置。
不要自己新增 findings；你发现的疑点只能体现在 needEscalate/escalateLenses 里，交给下一轮独立 critic 核实。
${divergeBlock}
${diverge ? `\n【入口路径矩阵（校对后原样透传，可修正 status/note）】\n${JSON.stringify(divergerMatrix, null, 2)}\n` : ''}
${uxMatrix.length ? `\n【用户体验路的用户可达路径矩阵（核对 status 是否站得住，可修正；这份放 userPathMatrix，不要和上面的入口路径矩阵混）】\n${JSON.stringify(uxMatrix, null, 2)}\n` : ''}
【本轮修改意图】
${intent}
${ctxBlock}

【原始 findings（第 ${round} 轮）】
${JSON.stringify(findings, null, 2)}

严格按 schema 输出，**必须调用 StructuredOutput，否则整条流程会中断**。`
}

const round1 = await agent(judgePrompt(allFindings, 1, divergentFindings), {
  label: '判卷:R1',
  phase: '判卷',
  agentType: 'critic-pipeline:critic-judge',
  schema: JUDGE_SCHEMA,
})

let finalConfirmed = round1?.confirmed ?? []
let finalPreExisting = round1?.preExisting ?? []
let finalPathMatrix = round1?.pathMatrix ?? []
let finalUserPathMatrix = round1?.userPathMatrix?.length ? round1.userPathMatrix : uxMatrix
let rejected = round1?.rejectedCount ?? 0
let escalateInfo = null

// ── ③ 升级门（可选）：判卷判高风险 → 补派 1~2 路全新视角 ──
if (allowEscalate && round1?.needEscalate && (round1.escalateLenses?.length ?? 0) > 0) {
  phase('升级')
  const extra = round1.escalateLenses.slice(0, maxEscalate)
  log(`判卷要求升级，补派 ${extra.length} 路：${extra.join(' / ')}`)

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
  const extraFindings = extraRaw
    .filter(Boolean)
    .flatMap((r) => (r.findings || []).map((f) => ({ ...f, fromLens: r.lens })))

  if (extraFindings.length) {
    phase('终裁')
    const round2 = await agent(judgePrompt(extraFindings, 2, []), {
      label: '判卷:R2',
      phase: '终裁',
      agentType: 'critic-pipeline:critic-judge',
      schema: JUDGE_SCHEMA,
    })
    // 二次汇总：合并两轮确认项（按 location+problem 粗去重）
    const seen = new Set()
    const merged = []
    for (const f of [...finalConfirmed, ...(round2?.confirmed ?? [])]) {
      const k = `${f.location}||${f.problem}`
      if (!seen.has(k)) {
        seen.add(k)
        merged.push(f)
      }
    }
    finalConfirmed = merged
    rejected += round2?.rejectedCount ?? 0
    escalateInfo = { reasons: extra, extraRaised: extraFindings.length }
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
  lenses: lenses.map((l) => l.name),
  diverge,
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
  summary: round1?.summary ?? '',
  // 交给调度员回派施工队时可直接用的文字清单
  handoff: finalConfirmed
    .filter((f) => f.severity !== 'minor')
    .map((f) => `- [${f.severity}] ${f.location}：${f.problem}（依据：${f.evidence}）`)
    .join('\n'),
}
