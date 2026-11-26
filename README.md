# critic-pipeline

通用**挑刺流水线**：给一轮代码改动做多视角"找茬"，产出结构化清单，**只挑刺、不修代码**。

一个插件打包三档流水线 + 九个只读角色 + 三个 workflow。装一次，任何仓库都能用：

- **代码档**（`critic-round`）：审一轮代码改动，管正确性、兼容、性能、交互体验；
- **画面档**（`quality-round`）：审画面表现，拿调用方点名的参考作品当基准，做多轮迭代式挑刺；
- **设计档**（`design-round`）：审游戏设计，先只读分诊判任务类型与评分维度（11 维可选），再做多轮迭代挑刺，只认结构证据；复检轮只重打涉改维与旧账所在维。

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
| `benchmarkBrief` | 否 | 从 `.critic/benchmark-quality.json` 读出的上轮基准；传了且未过期则跳过调研 |
| `projectRef` | 否 | 当前项目版本/commit，用于判断基准是否还适用；不传则跳过版本比对 |
| `depth` | 否 | `quick`（默认，4 路合并）/ `full`（8 路分维） |
| `targetScores` | 否 | 逐维目标分覆盖，默认 4 |
| `maxRounds` | 否 | 硬停轮数，默认 4 |
| `known` | 否 | 已知未修项 |
| `projectContext` | 否 | 技术栈 / 资源规范 / 美术红线；不传则项目无关 |

**返回**：`dimensions`（分数/目标/扣分项/优点/是否假达标）、`mustFix`/`shouldFix`/`minor`、`plagiarism`、`coverage`（取证缺口）、`converged`/`stopReason`/`stuckDimensions`、`progressRecord`（存给下一轮）、`benchmarkBrief`（写回文件）、`briefStatus`/`briefPath`/`briefRevision`（本轮复用还是重研）、`handoff`（按维度分组的施工清单，未达标维附参考做法与出处）。

**基准固化**：脚本不碰磁盘，只做校验与打标。调度员每轮开跑前读 `.critic/benchmark-quality.json` 传 `benchmarkBrief`，收结果后按 `briefStatus` 决定是否写回——`reused` 不动文件，`researched`/`stale-researched` 原样写回 `briefPath`（`revision` 已由脚本 +1），`unused` 不写回。过期只认变更：`benchmarkRefs` 集合变了，或 `projectRef` 与 `appliesTo` 不一致；`fetchedAt` 只记录不触发。基准换了导致分数不可比时，停因给 `brief-revised`。

**长期迭代**由调度员驱动：拿 `handoff` 去改画面 → 补 `coverage` → 带 `round+1`/`history`/`benchmarkBrief` 再调一轮，直到收敛或触停。

**参考做法（事实层）**：`handoff` 对**未达标**的维附三行——参考作品在该维的做法（裁 160 字）、可核验口径最多 2 条、出处 1 条。全部由脚本从 `benchmarkBrief` 机械拼接，不新增模型输出；调研失败时的占位「基准未覆盖」自动跳过，并在末尾显式写「本轮无有效基准 brief，未附参考做法」。只给事实与出处、不给改造处方——怎么改由施工队决定；画面档另附一行「禁止照搬具体构图、素材、界面布局」。

## 设计档（design-round）

给一套**游戏设计**做迭代式挑刺。核心难点是**趣味性主观**——AI 不能真玩一局说"不爽"，所以本档只查**结构代理指标**，且**玩家原话永远不能当证据**。

**先分诊，再挑刺**：`goal` 往往是大方向（「地图要有视觉诱饵」「Boss 机制要多样」「双人要有差分」），固定几维装不下就会静默吞掉。所以每轮先由一个只读分诊员读 `goal` + 项目现状，判出**任务类型**与**评分维度**：

| 类型 | 起手维度 |
|---|---|
| `balance-tuning` 数值平衡 | 数值平衡 + 经济与成长曲线 |
| `level-content` 地图与内容 | 地图与关卡结构 + 收集与分支结构 |
| `boss-encounter` Boss 战 | Boss 与敌人机制多样性（提数值可加数值平衡） |
| `coop-experience` 双人体验 | 合作性 + 合作趣味 + 双人差分与对等（强制 players ≥ 2） |
| `full-mixed` 复合需求 | 全部 11 维 |

分诊还会把 `goal` 拆成条目**逐条指定归属维度**。归不进去的单列 `uncoveredGoals`、给出建议（补证据 / 显式加维 / 人工拍板），并**拦住收敛**（停因 `goal-uncovered`）——绝不静默丢弃。调用方显式传 `type` 或 `dimensions` 时跳过分诊（显式优先），跨轮把它回传即可避免每轮重诊导致维度漂移。

**十一个设计维度**（每维一个 `minPlayers` 闸）：

| 维度 | 查什么 | 人数闸 |
|---|---|---|
| 数值平衡 | 难度曲线、TTK/TTD、数值断崖与正反馈循环 | 1 |
| 经济与成长曲线 | 产出/消耗速率、通胀、成长斜率与瓶颈 | 1 |
| 地图与关卡结构 | 路径连通、视线遮挡与盲区、单屏同框信息量、地标可见性、通用交互规则数、探索回报密度 | 1 |
| 收集与分支结构 | 必得 vs 可选、分支路径数、错过可补性、重复战斗率、解锁依赖 | 1 |
| Boss 与敌人机制多样性 | pattern 复用率、弹幕形状数、阶段数、预警与弱点、机制类型分布、秒杀窗口 | 1 |
| 趣味性结构代理 | 反馈密度、选择空间、风险回报结构、失败代价与重试成本 | 1 |
| 合作性 | 分工必要性、互补收益、搭便车与拖累 | 2 |
| 合作趣味 | 协作中的沟通需求、共同目标张力、失误的社交后果 | 2 |
| 双人差分与对等 | 动词分配、信息不对称、主动权轮换、嫉妒与搭便车、换位二周目 | 2 |
| 突发意外趣味 | 随机事件的结构位置、可回溯性、雪球失控 | 2 |
| 玩家反馈的心理机制 | 反馈文本 → 心理学机制 → 结构锚点 | 有 `feedback` 才开 |

维度边界写在各自的 prompt 里（「这个不归我，交给谁」），跨维重叠由判卷合并时保留更具体的那条。项目**根本没有**某个设计面时，维度可标 `not-applicable`：不计分、不阻塞收敛，单列返回并写明理由。

**逐轮模式**：`history` 为空 → `explore`（全量挖）；否则 → `verify`（复检）。复检由一个只读核对员把上轮必修项逐条判 `fixed` / `still-present` / `worsened` / `untestable`，同时把本轮改动（`changes`）映射到受影响维度，只对**涉改维与旧账所在维**重打分并跑定向回归镜头，其余维度沿用上轮分数（标 `carried`）。旧账没清完就不算收敛。

**玩家反馈怎么处理**：每条反馈必须映射到心理学机制（自主 / 胜任 / 归属 / 心流 / 损失厌恶 / 变比率奖励 / 沉没成本 / 峰终 / 其他），再落到具体数值:行、模拟输出或代码位置。落不了锚的进 `unverifiedFeedback` 单列，**不计分、不阻塞收敛**。纯情绪直接不入账。

**取证在 workflow 外**：调度员先用插件自带的 `critic-evidence` MCP server 调 `prepare_evidence`，把模拟输出、校验命令与配置拍到 `.critic/evidence/<label>/`；workflow 只收 `evidenceDir`，各角色用 `get_evidence_slice` 按关键词取切片、用 `verify_anchors` 机械核锚点。证据不再内联进 prompt——这是本档的主要 token 省法。

**参考作品页面被反爬拦住**：调研员的取数分两级——先 free-search（毫秒级，多数页面够用）；只有当它的 fetch 返回验证页 / 403 / 空壳时，才改用插件自带的 `critic-browse` MCP（工具 `browse_fetch`）。`browse_fetch` 用真实浏览器（ego-browser）打开同一 URL，返回标题、正文与页面内链接；能过 Cloudflare 挡住的 wiki.gg / fandom 系站点与需要 JS 渲染的页面。代价是每页约 2 秒 + 一个浏览器进程，只当兜底，不替代搜索。依赖本机装有 ego-browser（可用环境变量 `EGO_BROWSER_BIN` 指路径）。

一次调用 = 一轮：

```
① 分诊（可跳过）    只读勘察判任务类型 + 评分维度 + 目标逐条归位 + 不适用维度
② 基准调研（可选）  无基准 brief 且给了 benchmarkRefs 时先跑：把参考作品转成可核验口径
                    参考只增不减时走增量：只补新参考影响的维，旧口径不重查
③b 复检（verify）   核对员逐条判上轮必修项 + 把改动映射到受影响维度
④ 找茬             按组并行镜头（depth=full 拆逐维；verify 只跑涉改维）挑刺并自评扣分
                    玩家反馈维单独走心理机制解析；细节评委同批并行：审假达标 + 证据造假 + 阈值漂移
⑤ 分片+汇流        每镜头一个分片判卷（引用式，可改判 anchorKind），再轻量汇流跨片去重；证据造假阻断由脚本按细节评委违规执行
⑥ 收敛             脚本按双闸门判定收敛 / 停滞 / 硬停
```

**体量闸门**：每维 findings ≤ 8、每片 items ≤ 24、汇流 digest ≤ 80 条（超出按严重度截断并标丢弃数）——单次输入/输出撞上游长度上限会让判卷整体报废，闸门是硬约束。

**评分沿用扣分表**：每维满分 5，从 5 往下扣；每笔扣分必须写清「差什么 / 差距多大 / 证据在哪」，且 `anchorKind` 只能是 `numeric-config` / `sim-output` / `code` / `benchmark`——枚举里物理上没有 `feedback`，玩家原话冒充结构证据会被细节评委拦下。

**收敛**：全部活跃维达标（默认 4）+ 无必修项 + 旧账无未修项 + 无证据造假阻断 + 目标全部有维度接住。停因优先级：`已收敛` → `目标未覆盖` → `基准换版` → `证据造假阻断` → `达轮数上限` → `停滞` → `取证不足`。基准换版只在**整套尺子换了**时才拦（参考被移除 / 版本变了 / 旧文件是占位）；只往名单里加参考属于增量补维，照常判收敛。

**基准增量**：`benchmarkRefs` 只增不减且版本未变 → 脚本派一次「补差异」调研（`briefMode='patch'`），只重写被新参考影响的维，其余维沿用旧口径；调研员改旧维必须写 `changeReason`。返回 `briefAffectedDims` 列出本轮口径变了的维（这些维旧分不可比），`benchmarkBrief.changes` 留最近 20 次变更记录。有删减 / 版本变化 / 旧文件为占位 → 全量重研（`briefMode='full'`），旧口径会被整份覆盖，想留底先手工备份。

**参数**：

| 参数 | 必填 | 说明 |
|---|---|---|
| `goal` | 是 | 本轮想改善什么（可以很宽，分诊会拆条归位） |
| `evidenceDir` | 是 | `prepare_evidence` 产出的证据包目录；不传直接早退 |
| `feedback` | 否 | 玩家反馈文本，`string` 或 `{text, files[]}`；给了才开反馈维 |
| `benchmarkRefs` | 否 | 参考作品名，由调用方点名 |
| `players` | 否 | 人数，默认 1；2 人以上开合作/差分/意外四维 |
| `type` | 否 | 显式任务类型，给了就跳过分诊 |
| `dimensions` | 否 | 维度白名单，可强制开启被人数闸关掉的维；给了就跳过分诊 |
| `scope` | 否 | 本轮聚焦切片 `{label, units[], note?}`：全局维仍做基线，只在切片内深挖 |
| `mode` | 否 | `explore` / `verify`；缺省按 `history` 自动 |
| `changes` | 否 | 本轮改动 `{summary, stat, files[], dimensions[]}`，复检与回归镜头据此定位 |
| `prevMustFix` | 否 | 显式覆盖旧账明细（优先于 `history` 里的记录） |
| `acceptUncovered` | 否 | `true` 时放行「目标没有维度接住」的拦截 |
| `projectPath` | 否 | 项目根路径，用于定位；本身不算证据 |
| `round` / `history` / `benchmarkBrief` / `projectRef` / `known` / `targetScores` / `maxRounds` / `depth` / `projectContext` | 否 | 同画面档；本档基准文件为 `.critic/benchmark-design.json`；`depth` 缺省 explore=full、verify=quick |

证据来源（`prepare_evidence` 的 `run` / `checks` / `codePaths`，外加 `feedback` / `benchmarkRefs`）至少给一类；`evidenceDir` 本身永远必填——取证在 workflow 外做完才开跑，缺了就明确报错，不静默降级。

**返回**：`type` / `triage` / `triageFallback`、`goalCoverage` / `uncoveredGoals` / `acceptedUncovered`、`mode` / `verifyFallback` / `verifier` / `touchedDims` / `carriedDims`、`scope`、`notApplicable`、`dimensions`（分数/目标/扣分项/优点/是否假达标/是否沿用上轮/是否不适用）、`mustFix`/`shouldFix`/`minor`、`evidenceIntegrity`（造假硬阻断）、`unverifiedFeedback`、`coverage`、`converged`/`stopReason`/`stuckDimensions`、`progressRecord`、`benchmarkBrief`、`briefStatus`/`briefPath`/`briefRevision`、`briefMode`/`briefAffectedDims`/`briefPatchFailed`、`handoff`（未达标维附参考做法与出处；另附未覆盖目标与复检结论）。

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

- **只挑刺，不修代码**。所有角色都不用 `tools` 白名单，而是用 `disallowedTools` 禁掉全部写工具、子代理派发工具与自由 shell，物理上改不了代码。设计档的取数口子只剩插件自带的 `critic-evidence`：`get_evidence_slice`（取证据切片）、`code_query`（grep/read/list）、`verify_anchors`（批量核锚点），复检额外保留 `run_task`（只跑调用方给过的命令）。`prepare_evidence` 只属于调度员，agent 一律禁用——否则等于给了任意命令执行。`serena` 必禁：`serena_repl` 是能读能写还能跑 shell 的万能口子，`disallowedTools` 拦不住它内部的工具。`critic-browse` 的 `browse_fetch` **只给基准调研员**（它是唯一需要查外部资料的只读角色），其余 agent 全禁；该工具只能按 URL 取页面正文，不带点击、不带脚本执行。
- **不许用 `tools` 白名单**。本机构建下，agent 一旦声明 `tools`，引擎注入的 `StructuredOutput` 会被过滤掉，带 schema 的子代理必然交不出结果。
- **每轮全新视角**。每轮都是一次性子代理，无记忆，天然"换人挑刺"。
- **判卷不自审**。分片判卷与汇流都不新增 findings（分片 schema 物理上没有新增字段），汇流发现的疑点只走升级门，交给下一轮独立找茬核实。
- **模型分档只改 `.md`**。脚本不写 model，模型与工具写在 agent 文件 frontmatter，换档只改文件不动脚本。

## 文件结构

```
critic-pipeline/
├── plugin.json              # 插件 manifest
├── .mcp.json                # 插件自带 MCP server 注册（critic-evidence / critic-browse）
├── .claude-plugin/
│   └── plugin.json          # 插件 manifest（打包版）
├── mcp/
│   ├── evidence-server.mjs   # 零依赖 stdio MCP：prepare_evidence / get_evidence_slice / code_query / verify_anchors / run_task
│   └── browse-server.mjs     # 零依赖 stdio MCP：browse_fetch（真实浏览器取被反爬拦住的页面）
├── agents/
│   ├── critic-reader.md               # 代码档找茬角色（只读 + 快档）
│   ├── critic-judge.md                # 代码/画面档分片判卷与汇流判卷共用角色（只读 + 强档）
│   ├── critic-vision-reader.md        # 画面档：基准调研 / 取证 / 逐维找茬
│   ├── critic-detail-judge.md         # 画面档：细节评委（假达标 + 抄袭）
│   ├── critic-design-triager.md       # 设计档：分诊（类型 + 评分维度 + 目标归位）
│   ├── critic-design-researcher.md    # 设计档：基准调研（只查公开资料）
│   ├── critic-design-analyst.md       # 设计档：逐维找茬 / 反馈心理机制解析
│   ├── critic-design-verifier.md      # 设计档：复检核对（旧账四态 + 改动映射）
│   ├── critic-design-detail-judge.md  # 设计档：细节评委（假达标 + 证据造假 + 阈值漂移）
│   └── critic-design-judge.md         # 设计档：分片判卷 / 汇流判卷
├── skills/
│   ├── critic-round/SKILL.md     # /critic-pipeline:critic-round
│   ├── quality-round/SKILL.md    # /critic-pipeline:quality-round
│   └── design-round/SKILL.md     # /critic-pipeline:design-round
├── scripts/
│   ├── dryrun-quality-round.cjs  # 画面档零成本干跑
│   ├── dryrun-design-round.cjs   # 设计档零成本干跑
│   ├── dryrun-critic-round.cjs   # 代码档零成本干跑
│   ├── selftest-mcp.mjs          # critic-evidence 五工具自测
│   └── selftest-browse.mjs       # critic-browse 自测（真实抓一个 Cloudflare wiki 页）
└── workflows/
    ├── critic-round.js           # 代码档流水线
    ├── quality-round.js          # 画面档流水线
    └── design-round.js           # 设计档流水线
```

`CONTEXT.md` 是领域术语表（档位、画面八维、设计十一维、分诊与复检、基准与评分、借鉴与抄袭、角色口径）。

## 相关

- 零成本干跑（不调真实子代理，只验参数流动、分片判卷合并与收敛判定）：
  - `node scripts/dryrun-critic-round.cjs <case>`：normal / cleanup / explicit-lenses / nodiff / escalate / dropall
  - `node scripts/dryrun-quality-round.cjs <case>`：normal / plagiarism / converged / stalled / noref / nocapture / researchfail / lensfail / fresh / reuse / stale-refs / stale-version / fallback / partial / briefrevised / oldhistory
  - `node scripts/dryrun-design-round.cjs <case>`（32 个）：normal / researchfail / solo-nofeedback / forced-dim / nogoal / noevidence / simfail / thresholddrift / evidenceblocked / converged / stalled / psych-unverified / triage-map / triage-fallback / goal-uncovered / accept-uncovered / scope / not-applicable / cap-findings / verify-fixed / verify-still / verify-fallback / fresh / reuse / stale-refs / stale-version / fallback / partial / briefrevised / oldhistory / patch-refs / patch-fail
- `node scripts/selftest-mcp.mjs`：critic-evidence 五工具自测（造临时玩具项目，起 stdio server 全链路跑一遍）
- `node scripts/selftest-browse.mjs [url]`：critic-browse 自测（默认抓一个 Cloudflare 挡住的 wiki 页，验证真能拿到正文）
- ADR：`D:\app\YuMoBox\docs\adr\0055-critic-pipeline-workflow.md`
- 团队台本：`D:\app\YuMoBox\.claude\team-kits\standard-kit.json`（干活用团队，挑刺用本插件，两者解耦）
