// quality-round.js —— 一轮画面挑刺（画面档）
//
// 定位：对「画面表现」做迭代式挑刺，拿调用方点名的参考作品当基准。
//       只挑刺，不改画面；一次调用 = 一轮，多轮由调度员驱动。
//       性能/卡顿/加载耗时不在本档范畴——那些属代码档 critic-round 的 perf。
//
// 内部层次：
//   ① 基准调研（可选）：把参考作品转成八维可核验口径（基准 brief）
//   ② 取证：执行调用方给的 capturePlan，收集截图与量化指标
//   ③ 找茬：4 路合并镜头（或 depth=full 8 路）逐维找茬并自评扣分；
//      细节评委同批并行，审「假达标」与抄袭风险
//   ④ 判卷：主判卷汇总、去重、执行封顶与硬阻断
//   ⑤ 收敛：脚本按双闸门判定收敛 / 停滞 / 硬停
//
// 硬约束（写在代码里，不靠自觉）：
//   - 插件不含任何游戏名、项目路径或截图脚本；基准与取证全由调用方传
//   - 视觉挑刺者 / 细节评委 / 主判卷均无写工具，物理改不了项目文件
//   - agentType 必须带 `critic-pipeline:` 插件前缀，否则换仓库即报 not found
//   - 模型写死在 agent 文件 frontmatter（model:），脚本不逐个传 model
//   - 所有带 schema 的子代理，prompt 末尾写死「必须调用 StructuredOutput」
//   - 评分 = 扣分表：5 - 扣分合计；脚本按扣分项重算，不信手填总分
//   - 抄袭硬阻断：细节评委给出 confidence >= 0.7 的具体标识命中 → 本轮不算达标
//   - 假达标：细节评委命中的维度封顶 3 分，且作为必修项进清单

export const meta = {
  name: 'quality-round',
  description: '一轮画面挑刺：基准调研 → 取证 → 4/8 路逐维找茬+细节评委 → 主判卷 → 扣分表与收敛判定。只挑刺不改画面。',
  phases: [
    { title: '基准调研', detail: '无基准 brief 时，把调用方点名的参考作品转成八维可核验口径' },
    { title: '取证', detail: '执行调用方给的 capturePlan，收集截图与量化指标' },
    { title: '找茬', detail: '按维度并行找茬并自评扣分；细节评委同批审假达标与抄袭' },
    { title: '判卷', detail: '主判卷汇总、去重、执行假达标封顶与抄袭硬阻断' },
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
//   args.benchmarkRefs   数组   —— 参考作品名（一个或多个），必填；插件不写死任何游戏名
//   args.capturePlan     对象   —— 取证计划，强烈建议给：
//                                  { run?, workdir?, outputDir?, scenes[], shots[], metrics[{name,command}], codePaths[] }
//                                  run 为取证命令；shots 为现成截图；outputDir 为图片目录；
//                                  metrics 为像素统计命令；codePaths 为值得查的画质配置文件
//   args.shots           数组   —— 现成截图路径（capturePlan.shots 的快捷写法），可选
//   args.goal            字符串 —— 本轮想改善什么 / 美术方向，可选
//   args.round           数     —— 第几轮，默认 1
//   args.history         数组   —— 往轮 progressRecord，可选；用来防重复扣分与判停滞
//   args.benchmarkBrief  对象   —— 跨轮复用的基准 brief，可选；不传则本轮先调研
//   args.depth           字符串 —— quick（默认，4 路合并）/ full（8 路分维），可选
//   args.targetScores    对象   —— 逐维目标分覆盖，可选；默认 4
//   args.maxRounds       数     —— 硬停轮数，默认 4
//   args.known           数组   —— 已知未修项，可选
//   args.projectContext  字符串 —— 项目上下文（技术栈/资源规范/美术红线），可选；
//                                  不传则整套流水线保持项目无关
// ─────────────────────────────────────────────────────────────

const DEFAULT_TARGET = 4
const MAX_ROUNDS_DEFAULT = 4
const PLAGIARISM_BLOCK_CONFIDENCE = 0.7

// 画面八维（顺序即报告顺序）
const DIMENSIONS = [
  {
    key: 'resolution-clarity',
    name: '分辨率与清晰度',
    prompt:
      '看画面是否「清」：原生分辨率/渲染倍率是否够、缩放用什么滤镜（nearest 会锯齿、linear 会糊）、' +
      '像素是否对齐、文字与图标在高 DPI 下是否发虚、抗锯齿质量、图集缩放有没有拉伸。只判观感，不测帧率。',
  },
  {
    key: 'render-pipeline-lighting',
    name: '渲染管线与光照',
    prompt:
      '看光照是否「立得住」：光源方向与层级是否统一、阴影软硬与精度、环境光遮蔽、曝光与高光溢出、' +
      '反射/折射是否可信、雾与体积光、角色与环境的光向是否打架。没有管线细节就按画面事实判。',
  },
  {
    key: 'material-texture',
    name: '材质与贴图',
    prompt:
      '看材质是否「有区分度」：金属/布料/皮肤/水面是否一眼分得开、贴图分辨率与压缩痕迹、平铺接缝、' +
      'UV 拉伸、法线与粗糙度是否对、Mipmap 缺失导致的闪烁。',
  },
  {
    key: 'color-composition',
    name: '色彩与构图',
    prompt:
      '看色彩与构图是否「可读」：主次层级、明度对比、色温统一、主体与背景分离、剪影可读性、' +
      '视线引导、暗部与亮部是否都有细节。',
  },
  {
    key: 'post-processing',
    name: '后处理',
    prompt:
      '看后处理是否「干净」：bloom 是否泛光污染、景深是否糊掉主体、色差/暗角/颗粒是否过头、' +
      '色调分级是否统一、有没有色阶断层（banding）与死白死黑。',
  },
  {
    key: 'particles-effects',
    name: '粒子与特效',
    prompt:
      '看特效是否「有层次且不糊屏」：粒子密度与生命周期、拖尾/烟尘/水花/命中特效的层次、' +
      '叠加时是否遮住主体、是否过曝、特效与场景光照是否协调、特效是否真的对应玩法反馈。',
  },
  {
    key: 'animation-visual',
    name: '动画视觉表现',
    prompt:
      '看动画是否「顺且有重量」：缓动曲线、预备/跟随/回复、拉伸挤压、节奏与停顿、状态切换的视觉连续性、' +
      '循环接缝、动效风格是否统一。不含掉帧/卡顿。',
  },
  {
    key: 'ui-hud-visual',
    name: '界面与 HUD 视觉',
    prompt:
      '只看界面与 HUD 的视觉观感：字体/图标/描边/圆角/材质是否同一套语言、暗底亮底与复杂背景上的可读性、' +
      '图标风格统一、缩放清晰度、HUD 遮挡与层级、视觉密度是否过挤或过空。' +
      '交互缺陷（点击无反馈、缺加载态）不归本档。',
  },
]

// 默认 4 路合并镜头：每路盯二维，兼顾质量与并行度；depth=full 时拆成 8 路
const LENS_GROUPS = [
  {
    key: 'render-base',
    name: '渲染基础',
    dimKeys: ['render-pipeline-lighting', 'material-texture'],
  },
  {
    key: 'imaging',
    name: '成像链',
    dimKeys: ['resolution-clarity', 'post-processing'],
  },
  {
    key: 'mood-ui',
    name: '画面调性与界面',
    dimKeys: ['color-composition', 'ui-hud-visual'],
  },
  {
    key: 'motion',
    name: '动态表现',
    dimKeys: ['particles-effects', 'animation-visual'],
  },
]

// ── 入参归一 ──
const benchmarkRefs = (Array.isArray(A?.benchmarkRefs) ? A.benchmarkRefs : [])
  .map((x) => String(x).trim())
  .filter(Boolean)
const goal = String(A?.goal ?? '').trim()
const round = Math.max(1, Number(A?.round) || 1)
const maxRounds = Math.max(1, Number(A?.maxRounds) || MAX_ROUNDS_DEFAULT)
const depth = A?.depth === 'full' ? 'full' : 'quick'
const history = Array.isArray(A?.history) ? A.history : []
const known = Array.isArray(A?.known) ? A.known : []
const projectContext = String(A?.projectContext ?? '').trim()
const ctxBlock = projectContext
  ? `\n【项目上下文（调用方提供，判断时按此对齐）】\n${projectContext}\n`
  : ''
const targetScores =
  A?.targetScores && typeof A.targetScores === 'object' ? A.targetScores : {}

const rawPlan = A?.capturePlan && typeof A.capturePlan === 'object' ? A.capturePlan : {}
const plan = {
  run: String(rawPlan.run ?? '').trim(),
  workdir: String(rawPlan.workdir ?? '').trim(),
  outputDir: String(rawPlan.outputDir ?? '').trim(),
  scenes: (Array.isArray(rawPlan.scenes) ? rawPlan.scenes : []).map(String).filter(Boolean),
  shots: [
    ...(Array.isArray(rawPlan.shots) ? rawPlan.shots : []),
    ...(Array.isArray(A?.shots) ? A.shots : []),
  ]
    .map(String)
    .filter(Boolean),
  metrics: (Array.isArray(rawPlan.metrics) ? rawPlan.metrics : [])
    .filter((m) => m && String(m.command ?? '').trim())
    .map((m) => ({
      name: String(m.name ?? m.command).trim().slice(0, 100),
      command: String(m.command).trim(),
    })),
  codePaths: (Array.isArray(rawPlan.codePaths) ? rawPlan.codePaths : []).map(String).filter(Boolean),
}

if (!benchmarkRefs.length) {
  log('缺 args.benchmarkRefs，无法建立画面基准。请调度员点名参考作品（一个或多个）。')
  return { error: 'missing args.benchmarkRefs', dimensions: [] }
}
if (!plan.run && !plan.shots.length && !plan.outputDir) {
  log('缺取证证据：capturePlan 的 run / shots / outputDir 至少给一个，否则无从判画面。')
  return { error: 'missing capture evidence (capturePlan.run / shots / outputDir)', dimensions: [] }
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
    `${prevRecord.plagiarismBlocked ? '；上轮有抄袭阻断' : ''}` +
    `${Array.isArray(prevRecord.hollowDimensions) && prevRecord.hollowDimensions.length ? `；上轮假达标维度：${prevRecord.hollowDimensions.join('、')}` : ''}\n` +
    `本轮注意：上轮已修的扣分点不要重复扣；未修的继续扣；只对新增差距扣分。\n`
  : ''

let brief =
  A?.benchmarkBrief && typeof A.benchmarkBrief === 'object' ? A.benchmarkBrief : null
let capture = null

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
        `-【${dim.name}】目标分 ${targetFor(key)}\n` +
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
      description: '画面八维，必须齐全',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'referenceApproach', 'verifiableCriteria', 'deductionPoints', 'targetScore'],
        properties: {
          key: { type: 'string', enum: DIMENSIONS.map((d) => d.key) },
          referenceApproach: { type: 'string', description: '参考作品在该维做对了什么' },
          verifiableCriteria: {
            type: 'array',
            description: '可落到画面事实/技术参数/代码配置的判断句',
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

const RESEARCH_PROMPT = `你是画面档的基准调研员。目标只有一个：把调用方点名的参考作品，转成一套八维、可核验、能扣分的评分口径（基准 brief）。

【参考作品】
${benchmarkRefs.map((r, i) => `${i + 1}. ${r}`).join('\n')}

${ctxBlock}
【八个画面维度】
${DIMENSIONS.map((d) => `- ${d.key}（${d.name}）：${d.prompt}`).join('\n')}

【要求】
- 逐维写四件事：referenceApproach（参考作品在该维做对了什么）、verifiableCriteria（能落到画面事实/技术参数/代码配置的判断句）、deductionPoints（差在哪会掉分）、targetScore（默认 4，满分 5）。
- 八维必须齐全，缺一不可。
- 只查公开的技术拆解、开发演讲、美术分析、官方文档；**不得下载、复制、搬运参考作品的图像素材或模型文件**。
- 查不到就写「公开资料不足」，按通用质量线给标准；不要编造具体参数、分辨率或帧率数字。
- 参考作品可能是一个，也可能是多个：按作品各自的强项写，不要硬凑成一个平均标准。
- sources 只放你真看过的公开页面；没看就空数组。

${knownBlock}
严格按 schema 输出，**必须调用 StructuredOutput，否则整条流程会中断**。`

const CAPTURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['executed', 'commands', 'shots', 'metrics', 'visionAvailable', 'notes'],
  properties: {
    executed: { type: 'boolean', description: '是否执行了 capturePlan.run' },
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
    shots: {
      type: 'array',
      description: '本轮可用截图；每张标 scene 与路径',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['scene', 'path'],
        properties: {
          scene: { type: 'string', description: '对应 capturePlan.scenes 的名字；对不上就写文件名并标 unverified' },
          path: { type: 'string' },
        },
      },
    },
    metrics: {
      type: 'array',
      description: '像素统计等量化指标；没给 metrics 命令就空数组',
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
    visionAvailable: {
      type: 'boolean',
      description: '当前模型是否真能通过 Read 看到截图内容（至少实测打开一张）',
    },
    notes: { type: 'string', description: '缺依赖、命令失败、图对不上场景等如实写；成功也写一句' },
  },
}

const CAPTURE_PROMPT = `你是画面档的取证员。只做一件事：按调用方给的取证计划准备证据，不评价画面、不打分。

【取证计划】
${JSON.stringify(plan, null, 2)}

【执行规则】
1. 若 run 非空：在 workdir（为空则当前目录）下执行该命令；原样记录命令、退出码、末尾输出。失败不要反复重试，把原始报错放进 output。
2. 收集截图：先用 shots 里给的路径；再扫 outputDir 下的图片（.png/.jpg/.jpeg/.webp）。每张标 scene：能对上 scenes 就用对应名，对不上写文件名并在 scene 末尾加「(unverified)」。
3. 若 metrics 非空：逐条执行，记录原始输出。
4. 用 Read 打开至少一张截图，确认当前模型是否真能看到图像内容，把结论写进 visionAvailable。
5. 只允许在 outputDir 下产生文件（截图/日志）。不得修改项目源码、资源、配置；不得删除文件；不得安装依赖（缺依赖就报错回来）。
6. 不得访问、下载或搬运参考作品的图像素材。

${knownBlock}
严格按 schema 输出，**必须调用 StructuredOutput，否则整条流程会中断**。`

const researchTask = brief
  ? null
  : agent(RESEARCH_PROMPT, {
      label: '调研:基准brief',
      phase: '基准调研',
      agentType: 'critic-pipeline:critic-vision-reader',
      schema: BRIEF_SCHEMA,
    })

const captureTask = agent(CAPTURE_PROMPT, {
  label: '取证:截图与指标',
  phase: '取证',
  agentType: 'critic-pipeline:critic-vision-reader',
  schema: CAPTURE_SCHEMA,
})

const prep = await parallel([() => researchTask, () => captureTask])
const researchRaw = prep?.[0] ?? null
const captureRaw = prep?.[1] ?? null

if (researchRaw) {
  brief = researchRaw
  log(`基准 brief 完成：${brief?.dimensions?.length ?? 0} 维${brief?.caveats ? `（${brief.caveats}）` : ''}`)
} else if (!brief) {
  brief = fallbackBrief('基准调研未产出，本轮按通用质量线评分')
  log('基准调研未产出，退化为通用质量线。')
}

capture = captureRaw ?? {
  executed: false,
  commands: [],
  shots: [],
  metrics: [],
  visionAvailable: false,
  notes: '取证子代理未返回结果',
}
log(
  `取证完成：截图 ${capture.shots?.length ?? 0} 张 / 指标 ${capture.metrics?.length ?? 0} 条 / 可读图 ${capture.visionAvailable ? '是' : '否'}`
)

// ── ③ 找茬：逐维镜头 + 细节评委同批并行 ──
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
            description: '5 减去 deductions 的 points 之和；no-evidence 时填 0 占位（脚本会忽略）',
          },
          deductions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['points', 'issue', 'gap', 'evidence'],
              properties: {
                points: { type: 'number', description: '扣多少分，0.5 的倍数' },
                issue: { type: 'string', description: '差什么' },
                gap: { type: 'string', description: '与基准/标准的差距有多大' },
                evidence: {
                  type: 'string',
                  description: '截图路径+区域 / 指标数字 / 代码位置；无视觉判读必须明标',
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
        required: ['location', 'problem', 'severity', 'confidence', 'evidence', 'dimension'],
        properties: {
          location: { type: 'string', description: '截图路径+区域，或文件:行' },
          problem: { type: 'string' },
          severity: { type: 'string', enum: ['must-fix', 'should-fix', 'minor'] },
          confidence: { type: 'number' },
          evidence: { type: 'string' },
          dimension: { type: 'string', enum: DIMENSIONS.map((d) => d.key) },
        },
      },
    },
    coverageGaps: {
      type: 'array',
      description: '该拍但没拍到的场景 / 该有但没有的证据',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['scene', 'why', 'neededEvidence'],
        properties: {
          scene: { type: 'string' },
          why: { type: 'string' },
          neededEvidence: { type: 'string' },
        },
      },
    },
  },
}

function lensPrompt(lens) {
  const dims = lens.dimKeys.map((k) => DIMENSIONS.find((d) => d.key === k))
  return `你是画面档的视觉挑刺者，本轮负责 ${dims.length} 个维度：【${dims.map((d) => d.name).join('、')}】。

${dims.map((d) => `【${d.name}】${d.prompt}`).join('\n')}

【评分口径（基准 brief）】
${briefRows(lens.dimKeys)}

【本轮目标】
${goal || '（调用方未给具体目标，按基准 brief 的合格线判）'}
${ctxBlock}
【取证结果（调用方计划 + 取证员回报）】
${JSON.stringify(capture, null, 2)}

【值得查的画质配置】
${plan.codePaths.length ? plan.codePaths.map((p) => `- ${p}`).join('\n') : '（调用方未指定；可按需用 Grep/Glob 找渲染/资源/UI 配置）'}
${historyBlock}${knownBlock}
【打分规则（必须严格执行）】
1. 每维满分 5；分数 = 5 - 该维所有 deductions 的 points 之和（最低 0）。points 用 0.5 的倍数。
2. 每笔扣分必须写全三件事：issue（差什么）、gap（与基准/标准的差距）、evidence（截图路径+区域 / 指标数字 / 代码位置）。三缺一不许写。
3. 先看证据再打分：能读图就读图；读不了图（visionAvailable=false）只能靠指标与代码，必须在 evidence 里明标「无视觉判读」。
4. 该维没有任何可用证据 → status=no-evidence，score 填 0 占位，不要猜。
5. 禁止「总体感觉」「不够精致」这类无据扣分；扣不出具体差距就不扣。
6. 只判画面观感。交互缺陷（点击无反馈、缺加载态）、帧率/卡顿/加载耗时都不归本档，不报。
7. 发现该拍但没拍到的场景 → 写进 coverageGaps，交调度员补拍，不要靠猜。
8. 所有缺陷同时整理进 findings（带 dimension 与 severity）；扣分项与 findings 可以对应，也可以只是质量差距。
9. 你不修改任何文件；需要补拍或跑命令就写进 coverageGaps。

严格按 schema 输出，**必须调用 StructuredOutput，否则整条流程会中断**。`
}

const DETAIL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['hollowFindings', 'plagiarismRisks', 'imitationVsLearning', 'summary'],
  properties: {
    hollowFindings: {
      type: 'array',
      description: '假达标：表面像、关键细节没对齐',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['dimension', 'problem', 'whyHollow', 'evidence'],
        properties: {
          dimension: { type: 'string', enum: DIMENSIONS.map((d) => d.key) },
          problem: { type: 'string' },
          whyHollow: { type: 'string', description: '哪一层没对齐' },
          evidence: { type: 'string', description: '截图路径/区域、指标数字、代码位置' },
        },
      },
    },
    plagiarismRisks: {
      type: 'array',
      description: '只报可识别的具体标识；风格与技法不算',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'reference', 'ours', 'evidence', 'confidence'],
        properties: {
          kind: {
            type: 'string',
            enum: [
              'character',
              'scene-composition',
              'ui-layout',
              'signature-asset',
              'proprietary-pattern',
              'other',
            ],
          },
          reference: { type: 'string', description: '参考作品里的哪个具体标识' },
          ours: { type: 'string', description: '本项目里的对应物' },
          evidence: { type: 'string' },
          confidence: { type: 'number', description: '0~1；>=0.7 视为命中并硬阻断' },
        },
      },
    },
    imitationVsLearning: {
      type: 'string',
      description: '哪些是「学对了」（技法/质量线），哪些「太像了」（具体标识）',
    },
    summary: { type: 'string' },
  },
}

const DETAIL_PROMPT = `你是画面档的细节评委，独立于镜头与主判卷，只做两件事：审「假达标」，守「抄袭」。

【参考作品】
${benchmarkRefs.map((r, i) => `${i + 1}. ${r}`).join('\n')}

【基准 brief】
${briefRows(DIMENSIONS.map((d) => d.key))}

【本轮目标】
${goal || '（未指定）'}
${ctxBlock}
【取证结果】
${JSON.stringify(capture, null, 2)}
${historyBlock}${knownBlock}
【判据 A：假达标】表面看起来接近参考，但关键细节没对齐。例：只加了泛光却没处理过曝；只学了剪影却没学光照层级；UI 只换了配色但图标风格不统一。
- 每条必须写 dimension（八维 key）、problem、whyHollow（哪一层没对齐）、evidence（截图路径/区域、指标数字、代码位置）。
- 看不出来就把 hollowFindings 置空，不要凑。

【判据 B：抄袭风险】只拦**可识别的具体标识**：角色形象、场景构图、界面布局、标志性素材、专有图案。
- 风格、色温、技法（多层视差、高对比剪影、描边风）不算，属可学范围，不要报。
- 每条写 kind / reference / ours / evidence / confidence（0~1）。没有具体标识证据就不要报。
- confidence >= 0.7 视为命中，本轮会被硬阻断。

【判据 C】imitationVsLearning 用一段话写清：哪些是「学对了」，哪些「太像了」。

禁止下载或搬运参考作品的图像素材；只依据本轮截图、代码与公开文字资料判断。
你不改任何文件，也不给总分——打分归镜头，终裁归主判卷。

严格按 schema 输出，**必须调用 StructuredOutput，否则整条流程会中断**。`

const lensList =
  depth === 'full'
    ? DIMENSIONS.map((d) => ({ key: d.key, name: d.name, dimKeys: [d.key] }))
    : LENS_GROUPS

phase('找茬')
log(
  `深度=${depth}；开 ${lensList.length} 路镜头（${lensList.map((l) => l.name).join(' / ')}）+ 1 位细节评委`
)

const lensThunks = lensList.map((lens) => () =>
  agent(lensPrompt(lens), {
    label: `找茬:${lens.name}`,
    phase: '找茬',
    agentType: 'critic-pipeline:critic-vision-reader',
    schema: DIM_FINDINGS_SCHEMA,
  }).then((r) => (r ? { ...r, lens: r.lens || lens.name } : null))
)
const finderThunks = [
  ...lensThunks,
  () =>
    agent(DETAIL_PROMPT, {
      label: '评审:细节评委',
      phase: '找茬',
      agentType: 'critic-pipeline:critic-detail-judge',
      schema: DETAIL_SCHEMA,
    }),
]

const finderRaw = await parallel(finderThunks)
const detailRaw = finderRaw?.[finderRaw.length - 1] ?? null
const lensResults = (finderRaw?.slice(0, -1) ?? []).filter(Boolean)
const detail = detailRaw ?? {
  hollowFindings: [],
  plagiarismRisks: [],
  imitationVsLearning: '',
  summary: '细节评委未返回结果',
}

log(
  `收到 ${lensResults.length}/${lensList.length} 路镜头结果；假达标 ${detail.hollowFindings?.length ?? 0} 条；抄袭风险 ${detail.plagiarismRisks?.length ?? 0} 条`
)

if (!lensResults.length) {
  log('所有镜头都未返回结果，本轮无法判画面。')
  return {
    error: 'all lenses failed',
    round,
    benchmarkRefs,
    capture,
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
const blockingPlagiarism = (detail.plagiarismRisks ?? []).filter(
  (r) => (Number(r.confidence) || 0) >= PLAGIARISM_BLOCK_CONFIDENCE
)

// ── ④ 判卷：汇总 + 去重 + 封顶 + 硬阻断 ──
const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dimensions', 'confirmed', 'rejectedCount', 'plagiarism', 'coverage', 'summary'],
  properties: {
    dimensions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'status', 'score', 'deductions'],
        properties: {
          key: { type: 'string', enum: DIMENSIONS.map((d) => d.key) },
          status: { type: 'string', enum: ['assessed', 'no-evidence'] },
          score: { type: 'number', description: '只能等于或低于镜头重算分，不得凭空上调' },
          deductions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['points', 'issue', 'gap', 'evidence'],
              properties: {
                points: { type: 'number' },
                issue: { type: 'string' },
                gap: { type: 'string' },
                evidence: { type: 'string' },
              },
            },
          },
          notes: { type: 'string', description: '合并/下调/封顶的理由' },
        },
      },
    },
    confirmed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['location', 'problem', 'severity', 'evidence', 'dimension', 'fromLens'],
        properties: {
          location: { type: 'string' },
          problem: { type: 'string' },
          severity: { type: 'string', enum: ['must-fix', 'should-fix', 'minor'] },
          evidence: { type: 'string' },
          dimension: { type: 'string', enum: DIMENSIONS.map((d) => d.key) },
          fromLens: { type: 'string' },
        },
      },
    },
    rejectedCount: { type: 'number' },
    plagiarism: {
      type: 'object',
      additionalProperties: false,
      required: ['blocked', 'risks', 'decision'],
      properties: {
        blocked: { type: 'boolean' },
        risks: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'reference', 'ours', 'evidence', 'confidence'],
            properties: {
              kind: { type: 'string' },
              reference: { type: 'string' },
              ours: { type: 'string' },
              evidence: { type: 'string' },
              confidence: { type: 'number' },
            },
          },
        },
        decision: { type: 'string', description: '为什么阻断/为什么没阻断' },
      },
    },
    coverage: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['scene', 'why', 'neededEvidence', 'fromLens'],
        properties: {
          scene: { type: 'string' },
          why: { type: 'string' },
          neededEvidence: { type: 'string' },
          fromLens: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
}

function judgePrompt() {
  return `你是画面档的主判卷。镜头已各自给自己盯的维度打过分、列了扣分项；细节评委已给出假达标与抄袭结论。你的活：

1) 汇总八维：保留镜头分数；你可因证据**下调**，不得凭空上调（上调一律驳回）。合并重复扣分项。
2) 归置 findings：去重、剔除假阳性与「为挑而挑」、定级（must-fix / should-fix / minor）。
3) 抄袭守门：细节评委 confidence >= ${PLAGIARISM_BLOCK_CONFIDENCE} 的具体标识命中，必须在 plagiarism.blocked 置 true 并说明；不得洗白。风格与技法不算抄袭。
4) 汇总 coverage：合并各镜头报的取证缺口。
5) 一句话总结。

不要自己新增镜头没报过的缺陷；你自己的疑点只能写进 summary 或 plagiarism.decision。
卷面上的假达标会由脚本强制封顶 3 分并转成必修项，你只需在 notes 里写清是否认同。

【基准 brief】
${briefRows(DIMENSIONS.map((d) => d.key))}

【本轮目标】
${goal || '（未指定）'}
${ctxBlock}
【取证结果】
${JSON.stringify(capture, null, 2)}
${historyBlock}${knownBlock}
【镜头原始结果】
${JSON.stringify(lensResults, null, 2)}

【细节评委结论】
${JSON.stringify(detail, null, 2)}

严格按 schema 输出，**必须调用 StructuredOutput，否则整条流程会中断**。`
}

phase('判卷')
log('主判卷汇总中…')
const judgeRaw = await agent(judgePrompt(), {
  label: '判卷:画面终裁',
  phase: '判卷',
  agentType: 'critic-pipeline:critic-judge',
  schema: JUDGE_SCHEMA,
})
const judge = judgeRaw ?? null
if (!judge) log('主判卷未返回结果，退化为镜头自评 + 细节评委结论。')

const judgeDims = new Map((judge?.dimensions ?? []).map((d) => [d.key, d]))

// ── ⑤ 收敛：脚本按双闸门判定 ──
phase('收敛')

const dimResults = DIMENSIONS.map((dim) => {
  const lensDim = lensDimByKey.get(dim.key)
  const judgeDim = judgeDims.get(dim.key)
  const assessed = lensDim?.status === 'assessed'
  const lensScore = assessed ? computedScore(lensDim) : null
  const judgeScore = Number.isFinite(Number(judgeDim?.score)) ? Number(judgeDim.score) : null
  let score = assessed ? Math.min(lensScore, judgeScore ?? lensScore) : null
  const hollow = assessed && hollowDims.has(dim.key)
  if (hollow && score !== null) score = Math.min(score, 3)
  const target = targetFor(dim.key)
  const deductions =
    (judgeDim?.deductions?.length ? judgeDim.deductions : lensDim?.deductions) ?? []
  return {
    key: dim.key,
    name: dim.name,
    status: assessed ? 'assessed' : 'no-evidence',
    score,
    lensScore,
    target,
    meetsTarget: assessed && score !== null && score >= target,
    hollow,
    deductions,
    strengths: lensDim?.strengths ?? [],
    notes: judgeDim?.notes ?? '',
    fromLens: lensDim?.fromLens ?? '',
  }
})

// findings 合并：判卷优先；判卷缺失时退回镜头原始 findings
let confirmed = Array.isArray(judge?.confirmed) ? judge.confirmed : []
if (!judge) {
  confirmed = lensResults.flatMap((r) =>
    (r.findings ?? []).map((f) => ({ ...f, fromLens: r.lens }))
  )
}

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
confirmed = deduped

const plagiarismBlocked =
  judge?.plagiarism?.blocked === true ||
  blockingPlagiarism.length > 0
const plagiarismRisks =
  (judge?.plagiarism?.risks?.length ? judge.plagiarism.risks : detail.plagiarismRisks) ?? []
const plagiarismDecision =
  judge?.plagiarism?.decision ??
  (plagiarismBlocked
    ? '细节评委给出 confidence >= 0.7 的具体标识命中，硬阻断。'
    : '未命中具体标识。')

const coverageMap = new Map()
const coverageSources = [
  ...(judge?.coverage ?? []),
  ...lensResults.flatMap((r) =>
    (r.coverageGaps ?? []).map((g) => ({ ...g, fromLens: r.lens }))
  ),
]
for (const g of coverageSources) {
  const k = `${g.scene ?? ''}||${g.neededEvidence ?? ''}`
  if (!coverageMap.has(k)) coverageMap.set(k, g)
}
const coverage = [...coverageMap.values()]

const mustFix = confirmed.filter((f) => f.severity === 'must-fix')
const shouldFix = confirmed.filter((f) => f.severity === 'should-fix')
const minor = confirmed.filter((f) => f.severity === 'minor')

const unassessed = dimResults.filter((d) => d.status !== 'assessed')
const belowTarget = dimResults.filter((d) => d.status === 'assessed' && d.score < d.target)

const converged =
  mustFix.length === 0 &&
  !plagiarismBlocked &&
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
else if (plagiarismBlocked) stopReason = 'plagiarism-blocked'
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
  mustFixCount: mustFix.length,
  mustFixLocations: mustFix.map((f) => `${f.dimension ?? ''}:${f.location ?? ''}`),
  plagiarismBlocked,
  hollowDimensions: [...hollowDims],
  coverageGapCount: coverage.length,
  summary: judge?.summary ?? detail.summary ?? '',
}

const summary = judge?.summary ?? detail.summary ?? ''

function handoffText() {
  const lines = []
  if (plagiarismBlocked) {
    lines.push('【硬阻断：抄袭风险】本轮不算达标，先改掉再谈分数。')
    for (const r of plagiarismRisks) {
      lines.push(
        `- [${r.kind}] 参考「${r.reference}」↔ 本项目「${r.ours}」（置信 ${r.confidence}；依据：${r.evidence}）`
      )
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
    }
    const related = mustFix.concat(shouldFix).filter((f) => f.dimension === d.key)
    for (const f of related) {
      lines.push(`- [${f.severity}] ${f.location}：${f.problem}（依据：${f.evidence}）`)
    }
    lines.push('')
  }
  if (coverage.length) {
    lines.push('【取证缺口（下一轮补拍）】')
    for (const g of coverage) {
      lines.push(`- 场景「${g.scene}」：${g.why}；需要：${g.neededEvidence}`)
    }
  }
  return lines.join('\n').trim()
}

log(
  `收敛判定：${stopReason}；必修 ${mustFix.length} / 建议 ${shouldFix.length} / 可忽略 ${minor.length}` +
    `；低于目标 ${belowTarget.length} 维；取证缺口 ${coverage.length} 条` +
    (plagiarismBlocked ? '；抄袭硬阻断' : '')
)

return {
  round,
  goal,
  depth,
  benchmarkRefs,
  // 基准 brief：调度员缓存后传回下一轮，避免重复调研
  benchmarkBrief: brief,
  capture,
  dimensions: dimResults,
  confirmed,
  mustFix,
  shouldFix,
  minor,
  // 细节评委专属
  hollowFindings: detail.hollowFindings ?? [],
  plagiarism: {
    blocked: plagiarismBlocked,
    risks: plagiarismRisks,
    decision: plagiarismDecision,
    imitationVsLearning: detail.imitationVsLearning ?? '',
  },
  // 取证缺口：调度员照着补拍
  coverage,
  rejectedCount: Number(judge?.rejectedCount) || 0,
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