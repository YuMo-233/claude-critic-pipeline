# critic-pipeline

通用**挑刺流水线**：给一轮代码改动做多视角"找茬"，产出结构化清单，**只挑刺、不修代码**。

一个插件打包三档流水线 + 七个只读角色 + 三个 workflow。装一次，任何仓库都能用：

- **代码档**（`critic-round`）：审一轮代码改动，管正确性、兼容、性能、交互体验；
- **画面档**（`quality-round`）：审画面表现，拿调用方点名的参考作品当基准，做多轮迭代式挑刺；
- **设计档**（`design-round`）：审游戏设计，按数值平衡、经济成长、趣味性结构代理、合作性/合作趣味、突发意外趣味、玩家反馈的心理机制分维挑刺，只认结构证据。

## 它解决什么

改完代码，很容易"只看见自己改的那几行"。常见的漏网：

- 改了这条路径，同族的其它入口路径上的缺陷没人管；
- 自己改完，自己复审，看不出问题；
- 兼容性、性能、用户体验这些维度，改代码时往往没顾上。

这个流水线用**每轮全新的一次性只读子代理**，从四个独立视角（外加一个可选的发散者）找问题，再由**分片判卷**逐路去伪、再由**汇流判卷**统一口径定级。找茬的和判卷的都**没有写工具**（用 `disallowedTools` 隔离，物理上改不了代码），不靠自觉。

## 内部结构

一次调用 = 一轮多视角挑刺：

```
① 找茬   N 路只读 critic 并行
② 分片判卷  每一路找茬配一个分片判卷，只审该路自己报的 findings（引用式：只回编号+keep/drop+定级）
③ 汇流   轻量判卷只读各片小结论，做跨片去重、统一严重度、判断是否需升级
④ 升级   （可选）汇流判高风险时补派 1~2 路新视角 → 同样分片判卷并入
```

**为什么分片**：判卷一次吃下全部镜头结果、一次吐出全部终裁，缺陷条数一多就会撞上游单次输出上限，整轮报废。分片后每片只处理一路，输出体量恒定；正文/位置/证据由脚本从原始 findings 回填，判卷只回编号与结论。跨片重复由汇流判卷给合并组，脚本只保留每组第一条——汇流仍可能漏合并，但不会再因体量炸掉。

**四路常规视角**：

| 视角 | 查什么 |
|---|---|
| 正确性与回归 | 改动本身有没有真的修对、逻辑有没有写反、边界/空值/并发/异常路径；原本正常的行为是否被打破 |
| 兼容 | 换环境就退化或炸的写法：运行时/依赖版本、操作系统与平台、文件系统（路径分隔符/大小写/长路径/只读目录）、编码换行、区域时区、权限沙箱、网络代理、硬件资源 |
| 性能 | 关键路径上卡顿的写法：O(n²)、无谓重算、同步 IO、无界缓存/泄漏/无界并发 |
| 用户体验 | 先枚举**用户可达路径矩阵**（每条标 covered/uncovered/n-a），只对 uncovered 报可证据化的体验缺陷（无反馈、缺加载/空/错误态、该禁未禁、裸抛栈、死胡同等）；纯品味（配色/间距/圆角）一律不报 |

**发散者**（第五路，默认开，`diverge:false` 关）：**唯一允许看超 diff 范围**的挑刺者。它从 diff 推断本次触碰的功能/交互族，枚举该族所有入口路径，专抓"改了这条路径、漏了同族其它路径"这类缺陷。它的发现分三类桶，由分片判卷归置、汇流校对：

- `repairIncomplete`（本次没修完）→ 进主清单；
- `preExisting`（既有老毛病，与本次改动无关）→ 单列返回，**交用户拍板，绝不混入本次必修**；
- `adjacentRisk`（相邻风险、低置信）→ 进升级门或 minor。

## 画面档（quality-round）

给一个项目的**画面表现**做迭代式挑刺：拿调用方点名的参考作品当基准，逐维打分、列差距，改完再挑，直到收敛。**只管看起来怎么样**；帧率、卡顿、加载耗时属性能范畴，走代码档。

插件不含任何游戏名、项目路径或截图脚本——基准与取证全由调用方传。

**八个画面维度**：分辨率与清晰度 / 渲染管线与光照 / 材质与贴图 / 色彩与构图 / 后处理 / 粒子与特效 / 动画视觉表现 / 界面与 HUD 视觉。界面维只报观感，交互缺陷仍归代码档。

一次调用 = 一轮：

```
① 基准调研（可选）  无基准 brief 时先跑一次：把参考作品转成八维可核验口径
② 取证             执行调用方给的 capturePlan，收集截图与量化指标
③ 找茬             4 路合并镜头（depth=full 拆 8 路）逐维找茬并自评扣分
                    细节评委同批并行：审假达标 + 抄袭风险
④ 分片+汇流        每镜头一个分片判卷（引用式），再轻量汇流跨片去重；封顶与硬阻断由脚本执行
⑤ 收敛             脚本按双闸门判定收敛 / 停滞 / 硬停
```

**评分是扣分表**：每维满分 5，从 5 往下扣；每笔扣分必须写清「差什么 / 差距多大 / 证据在哪」，无据不扣分。脚本按扣分项重算，不信手填总分；分片判卷只能给分数与理由，扣分项一律沿用镜头原文（保证「5 - 扣分合计」可核验），汇流不再改扣分项。

**两条红线**：

- **抄袭**：只拦可识别的具体标识（角色形象、场景构图、界面布局、标志性素材、专有图案）。风格、色温、技法（多层视差、高对比剪影）属可学范围。命中即硬阻断，本轮不算达标。
- **假达标**：表面像、细节松。细节评委命中后，该维封顶 3 分并强制进必修项。

**收敛**：八维全部达标（默认目标分 4）+ 无必修项 + 无抄袭命中。另有硬停（达 `maxRounds`，默认 4）、停滞（分数没提升且无新增必修）、取证不足三种止路。

**参数**：

| 参数 | 必填 | 说明 |
|---|---|---|
| `benchmarkRefs` | 是 | 参考作品名，一个或多个；由调用方点名 |
| `capturePlan` | 强烈建议 | `{run, workdir, outputDir, scenes, shots, metrics[{name,command}], codePaths}`；`run`/`shots`/`outputDir` 至少一个 |
| `goal` | 否 | 本轮想改善什么 / 美术方向 |
| `round` | 否 | 第几轮，默认 1 |
| `history` | 否 | 往轮 `progressRecord`，用于防重复扣分与判停滞 |
| `benchmarkBrief` | 否 | 跨轮复用基准口径，传了则跳过调研 |
| `depth` | 否 | `quick`（默认，4 路合并）/ `full`（8 路分维） |
| `targetScores` | 否 | 逐维目标分覆盖，默认 4 |
| `maxRounds` | 否 | 硬停轮数，默认 4 |
| `known` | 否 | 已知未修项 |
| `projectContext` | 否 | 技术栈 / 资源规范 / 美术红线；不传则项目无关 |

**返回**：`dimensions`（分数/目标/扣分项/优点/是否假达标）、`mustFix`/`shouldFix`/`minor`、`plagiarism`、`coverage`（取证缺口）、`converged`/`stopReason`/`stuckDimensions`、`progressRecord`（存给下一轮）、`benchmarkBrief`（跨轮复用）、`handoff`（按维度分组的施工清单）。

**长期迭代**由调度员驱动：拿 `handoff` 去改画面 → 补 `coverage` → 带 `round+1`/`history`/`benchmarkBrief` 再调一轮，直到收敛或触停。

## 设计档（design-round）

给一套**游戏设计**做迭代式挑刺：数值平衡、经济与成长曲线、趣味性、多人协作、意外乐趣、玩家反馈。核心难点是**趣味性主观**——AI 不能真玩一局说"不爽"，所以本档只查**结构代理指标**，且**玩家原话永远不能当证据**。

**七个设计维度**（每维一个 `minPlayers` 闸）：

| 维度 | 查什么 | 人数闸 |
|---|---|---|
| 数值平衡 | 难度曲线、TTK/TTD、数值断崖与正反馈循环 | 1 |
| 经济与成长曲线 | 产出/消耗速率、通胀、成长斜率与瓶颈 | 1 |
| 趣味性结构代理 | 反馈密度、选择空间、风险回报结构、失败代价与重试成本 | 1 |
| 合作性 | 分工必要性、互补收益、搭便车与拖累 | 2 |
| 合作趣味 | 协作中的沟通需求、共同目标张力、失误的社交后果 | 2 |
| 突发意外趣味 | 随机事件的结构位置、可回溯性、雪球失控 | 2 |
| 玩家反馈的心理机制 | 反馈文本 → 心理学机制 → 结构锚点 | 有 `feedback` 才开 |

**玩家反馈怎么处理**：每条反馈必须映射到心理学机制（自主 / 胜任 / 归属 / 心流 / 损失厌恶 / 变比率奖励 / 沉没成本 / 峰终 / 其他），再落到具体数值:行、模拟输出或代码位置。落不了锚的进 `unverifiedFeedback` 单列，**不计分、不阻塞收敛**。纯情绪直接不入账。

一次调用 = 一轮：

```
① 基准调研（可选）  无基准 brief 且给了 benchmarkRefs 时先跑：把参考作品转成七维可核验口径
② 取证             执行 simPlan（模拟命令 / 校验命令）
③ 找茬             按组并行镜头（depth=full 拆逐维）挑刺并自评扣分
                    玩家反馈维单独走心理机制解析；细节评委同批并行：审假达标 + 证据造假 + 阈值漂移
④ 分片+汇流        每镜头一个分片判卷（引用式，可改判 anchorKind），再轻量汇流跨片去重；证据造假阻断由脚本按细节评委违规执行
⑤ 收敛             脚本按双闸门判定收敛 / 停滞 / 硬停
```

**评分沿用扣分表**：每维满分 5，从 5 往下扣；每笔扣分必须写清「差什么 / 差距多大 / 证据在哪」，且 `anchorKind` 只能是 `numeric-config` / `sim-output` / `code` / `benchmark`——枚举里物理上没有 `feedback`，玩家原话冒充结构证据会被细节评委拦下。

**收敛**：全部活跃维达标（默认 4）+ 无必修项 + 无证据造假阻断。止路还有达 `maxRounds`（默认 4）、停滞、取证不足。

**参数**：

| 参数 | 必填 | 说明 |
|---|---|---|
| `goal` | 是 | 本轮想改善什么 |
| `simPlan` | 建议 | `{run, workdir, outputDir, checks[{name,command}], codePaths}` |
| `feedback` | 否 | 玩家反馈文本，`string` 或 `{text, files[]}`；给了才开反馈维 |
| `benchmarkRefs` | 否 | 参考作品名，由调用方点名 |
| `players` | 否 | 人数，默认 1；2 人以上开合作/意外三维 |
| `dimensions` | 否 | 维度白名单，可强制开启被人数闸关掉的维 |
| `projectPath` | 否 | 项目根路径，用于定位；本身不算证据 |
| `round` / `history` / `benchmarkBrief` / `known` / `targetScores` / `maxRounds` / `depth` / `projectContext` | 否 | 同画面档 |

四类证据（`simPlan.run` / `simPlan.checks` / `simPlan.codePaths` / `feedback` / `benchmarkRefs`）至少给一个，否则直接早退。

**返回**：`dimensions`（分数/目标/扣分项/优点/是否假达标/是否豁免）、`mustFix`/`shouldFix`/`minor`、`evidenceIntegrity`（造假硬阻断）、`unverifiedFeedback`（落不了锚的反馈）、`coverage`、`converged`/`stopReason`/`stuckDimensions`、`progressRecord`、`benchmarkBrief`、`handoff`。

## 安装

### 前提

本仓库**自带 marketplace 清单**（`.claude-plugin/marketplace.json`），仓库根即 marketplace 根，不需要另建 marketplace 目录、也不许用 junction 把插件链到别的 marketplace 里（新版 CLI 会以"source 越界"拒载）。

### 装插件

```bash
# 1. 在 ~/.claude/plugins/known_marketplaces.json 登记 marketplace：
#    haha-connectors 的 source.path 与 installLocation 都指向本仓库根
#    （也可用 claude plugin marketplace add <本仓库路径> 让 CLI 自己登记）

# 2. 安装并启用
claude plugin install critic-pipeline@haha-connectors
```

硬约束：marketplace.json 里插件条目的 `source` 必须写 `./`，不能写 `.`——CLI 对 `.` 放行，桌面端 zod 校验（`startsWith('./')`）会拒收，表现为插件"需关注 / 没有可用描述 / 技能 0"。

**验收口径是桌面端插件面板统计非 0（4+3 agents / 3 skills），不是 CLI 全绿。**

装完在 `~/.claude/settings.json` 的 `enabledPlugins` 里确认：

```json
"enabledPlugins": {
  "critic-pipeline@haha-connectors": true
}
```

### 换仓库用

插件装好后，**任何仓库**都能直接调，无需在项目里再放 agents/workflows。`agentType` 必须带 `critic-pipeline:` 前缀。

## 怎么调

### 调用通道（先试名字，不通就走内联）

| 通道 | 写法 | 适用 |
|---|---|---|
| 按名字 | `Workflow({ name: 'critic-pipeline:critic-round', args })` | 标准 Claude Code（插件 workflow 会自动注册） |
| 内联脚本 | `Read` 插件目录下 `workflows/*.js` 全文 → `Workflow({ script: <全文>, args })` | 名字查不到时的兜底（本机 Haha 构建即如此） |
| 文件路径 | `Workflow({ scriptPath: '<插件目录>/workflows/*.js', args })` | 能执行但结果可能取不回，非必要不用 |

两个脚本都在顶部把 `args` 归一：传对象或 JSON 字符串都行，**内部会自己解析**，不需要调用方预处理。

本机构建实测：`Workflow({ name: 'critic-pipeline:*' })` 会报 `Unknown workflow`（name 表只认内置 `deep-research`）；`scriptPath` 通道子代理真会跑（journal.jsonl 有结果）但 `TaskOutput` 报 `No task found`；内联 `script` 通道执行与取回都正常，**优先走它**。

### 代码档参数

主代理（调度员）调 workflow `critic-pipeline:critic-round`：

| 参数 | 必填 | 说明 |
|---|---|---|
| `diff` | 是 | 本轮改动（git diff 或改动摘要） |
| `intent` | 是 | 本轮想达到什么目的 |
| `known` | 否 | 前几轮已知未修项，避免重复报 |
| `lenses` | 否 | 只开某几路：`correctness-regression` / `compat` / `perf` / `ux`，不传=四路全开 |
| `projectContext` | 否 | 项目上下文：技术栈 / 版本矩阵 / 项目红线 / 领域术语，自动拼进找茬/发散者/判卷三处 prompt。**不传则技术栈无关，任何仓库都能跑** |
| `diverge` | 否 | 是否启用发散者，默认 `true`；`false` 关闭 |
| `escalate` | 否 | 是否允许汇流判卷触发升级门，默认允许 |
| `maxEscalate` | 否 | 升级最多补几路，默认 2 |

**返回**（结构化）：

| 字段 | 说明 |
|---|---|
| `confirmed` | 全部确认项 |
| `mustFix` / `shouldFix` / `minor` | 按严重度分档 |
| `preExisting` | 发散者报的既有老毛病，单列，交用户拍板 |
| `pathMatrix` | 发散者枚举的同族入口路径矩阵 |
| `userPathMatrix` | UX 路枚举的用户可达路径矩阵（汇流判卷校对后） |
| `rejectedCount` | 被分片判卷驳回的条数合计 |
| `escalate` | 升级门信息（是否触发、补派了几路） |
| `handoff` | 可直接贴给施工队的文字清单 |

## 硬约束

- **只挑刺，不修代码**。所有角色都不用 `tools` 白名单，而是用 `disallowedTools` 禁掉全部写工具与子代理派发工具，物理上改不了代码；视觉挑刺者额外保留读图与执行取证命令的能力，设计档分析师额外保留执行模拟命令的能力。
- **不许用 `tools` 白名单**。本机构建下，agent 一旦声明 `tools`，引擎注入的 `StructuredOutput` 会被过滤掉，带 schema 的子代理必然交不出结果。
- **每轮全新视角**。每轮都是一次性子代理，无记忆，天然"换人挑刺"。
- **判卷不自审**。分片判卷与汇流都不新增 findings（分片 schema 物理上没有新增字段），汇流发现的疑点只走升级门，交给下一轮独立找茬核实。
- **模型分档只改 `.md`**。脚本不写 model，模型与工具写在 agent 文件 frontmatter，换档只改文件不动脚本。

## 文件结构

```
critic-pipeline/
├── plugin.json              # 插件 manifest
├── .claude-plugin/
│   └── plugin.json          # 插件 manifest（打包版）
├── agents/
│   ├── critic-reader.md               # 代码档找茬角色（只读 + 快档）
│   ├── critic-judge.md                # 代码/画面档分片判卷与汇流判卷共用角色（只读 + 强档）
│   ├── critic-vision-reader.md        # 画面档：基准调研 / 取证 / 逐维找茬
│   ├── critic-detail-judge.md         # 画面档：细节评委（假达标 + 抄袭）
│   ├── critic-design-analyst.md       # 设计档：基准调研 / 取证 / 逐维找茬 / 反馈心理机制解析
│   ├── critic-design-detail-judge.md  # 设计档：细节评委（假达标 + 证据造假 + 阈值漂移）
│   └── critic-design-judge.md         # 设计档：分片判卷 / 汇流判卷
├── skills/
│   ├── critic-round/SKILL.md     # /critic-pipeline:critic-round
│   ├── quality-round/SKILL.md    # /critic-pipeline:quality-round
│   └── design-round/SKILL.md     # /critic-pipeline:design-round
├── scripts/
│   ├── dryrun-quality-round.cjs  # 画面档零成本干跑
│   ├── dryrun-design-round.cjs   # 设计档零成本干跑
│   └── dryrun-critic-round.cjs   # 代码档零成本干跑
└── workflows/
    ├── critic-round.js           # 代码档流水线
    ├── quality-round.js          # 画面档流水线
    └── design-round.js           # 设计档流水线
```

`CONTEXT.md` 是领域术语表（档位、画面八维、设计七维、基准与评分、借鉴与抄袭、角色口径）。

## 相关

- 零成本干跑（不调真实子代理，只验参数流动、分片判卷合并与收敛判定）：
  - `node scripts/dryrun-critic-round.cjs <case>`：normal / cleanup / explicit-lenses / nodiff / escalate / dropall
  - `node scripts/dryrun-quality-round.cjs <case>`：normal / plagiarism / converged / stalled / noref / nocapture / lensfail
  - `node scripts/dryrun-design-round.cjs <case>`：normal / solo-nofeedback / forced-dim / nogoal / noevidence / simfail / thresholddrift / evidenceblocked / converged / stalled / psych-unverified
- ADR：`D:\app\YuMoBox\docs\adr\0055-critic-pipeline-workflow.md`
- 团队台本：`D:\app\YuMoBox\.claude\team-kits\standard-kit.json`（干活用团队，挑刺用本插件，两者解耦）
