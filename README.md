# critic-pipeline

通用**挑刺流水线**：给一轮代码改动做多视角"找茬"，产出结构化清单，**只挑刺、不修代码**。

一个插件打包两档流水线 + 四个只读角色 + 两个 workflow。装一次，任何仓库都能用：

- **代码档**（`critic-round`）：审一轮代码改动，管正确性、兼容、性能、交互体验；
- **画面档**（`quality-round`）：审画面表现，拿调用方点名的参考作品当基准，做多轮迭代式挑刺。

## 它解决什么

改完代码，很容易"只看见自己改的那几行"。常见的漏网：

- 改了这条路径，同族的其它入口路径上的缺陷没人管；
- 自己改完，自己复审，看不出问题；
- 兼容性、性能、用户体验这些维度，改代码时往往没顾上。

这个流水线用**每轮全新的一次性只读子代理**，从四个独立视角（外加一个可选的发散者）找问题，再由一个**判卷的**去伪存真、定级。找茬的和判卷的都**没有写工具**（用 `disallowedTools` 隔离，物理上改不了代码），不靠自觉。

## 内部结构

一次调用 = 一轮多视角挑刺：

```
① 找茬   N 路只读 critic 并行
② 判卷   一位 judge 去伪 + 定级 + 判断是否需升级
③ 升级   （可选）judge 判定高风险时，补派 1~2 路新视角 → 二次汇总
```

**四路常规视角**：

| 视角 | 查什么 |
|---|---|
| 正确性与回归 | 改动本身有没有真的修对、逻辑有没有写反、边界/空值/并发/异常路径；原本正常的行为是否被打破 |
| 兼容 | 换环境就退化或炸的写法：运行时/依赖版本、操作系统与平台、文件系统（路径分隔符/大小写/长路径/只读目录）、编码换行、区域时区、权限沙箱、网络代理、硬件资源 |
| 性能 | 关键路径上卡顿的写法：O(n²)、无谓重算、同步 IO、无界缓存/泄漏/无界并发 |
| 用户体验 | 先枚举**用户可达路径矩阵**（每条标 covered/uncovered/n-a），只对 uncovered 报可证据化的体验缺陷（无反馈、缺加载/空/错误态、该禁未禁、裸抛栈、死胡同等）；纯品味（配色/间距/圆角）一律不报 |

**发散者**（第五路，默认开，`diverge:false` 关）：**唯一允许看超 diff 范围**的挑刺者。它从 diff 推断本次触碰的功能/交互族，枚举该族所有入口路径，专抓"改了这条路径、漏了同族其它路径"这类缺陷。它的发现分三类桶，由判卷归置：

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
④ 判卷             主判卷汇总、去重、执行封顶与硬阻断
⑤ 收敛             脚本按双闸门判定收敛 / 停滞 / 硬停
```

**评分是扣分表**：每维满分 5，从 5 往下扣；每笔扣分必须写清「差什么 / 差距多大 / 证据在哪」，无据不扣分。脚本按扣分项重算，不信手填总分；判卷只能下调，不能凭空上调。

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

## 安装

### 前提

已有本地 marketplace（如 `haha-connectors`），插件目录通过 junction 链接进来。

### 装插件

```bash
# 1. 把插件目录链接进本地 marketplace（免管理员，junction）
#    源：本仓库；链接到：~/.claude/connectors/marketplace/plugins/critic-pipeline
powershell -NoProfile -Command "New-Item -ItemType Junction -Path 'C:\Users\Administrator\.claude\connectors\marketplace\plugins\critic-pipeline' -Target 'D:\app\critic-pipeline' | Out-Null"

# 2. 在 marketplace.json 里登记插件（source 指向 ./plugins/critic-pipeline）
#    已登记则跳过

# 3. 安装并启用
claude plugin install critic-pipeline@haha-connectors
```

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
| `escalate` | 否 | 是否允许判卷触发升级门，默认允许 |
| `maxEscalate` | 否 | 升级最多补几路，默认 2 |

**返回**（结构化）：

| 字段 | 说明 |
|---|---|
| `confirmed` | 全部确认项 |
| `mustFix` / `shouldFix` / `minor` | 按严重度分档 |
| `preExisting` | 发散者报的既有老毛病，单列，交用户拍板 |
| `pathMatrix` | 发散者枚举的同族入口路径矩阵 |
| `userPathMatrix` | UX 路枚举的用户可达路径矩阵（判卷校对后） |
| `rejectedCount` | 被判卷驳回的条数 |
| `escalate` | 升级门信息（是否触发、补派了几路） |
| `handoff` | 可直接贴给施工队的文字清单 |

## 硬约束

- **只挑刺，不修代码**。四个角色都不用 `tools` 白名单，而是用 `disallowedTools` 禁掉全部写工具与子代理派发工具，物理上改不了代码；视觉挑刺者额外保留读图与执行取证命令的能力。
- **不许用 `tools` 白名单**。本机构建下，agent 一旦声明 `tools`，引擎注入的 `StructuredOutput` 会被过滤掉，带 schema 的子代理必然交不出结果。
- **每轮全新视角**。每轮都是一次性子代理，无记忆，天然"换人挑刺"。
- **判卷不自审**。判卷的不新增 findings，它自己发现的疑点只走升级门，交给下一轮独立找茬核实。
- **模型分档只改 `.md`**。脚本不写 model，模型与工具写在 agent 文件 frontmatter，换档只改文件不动脚本。

## 文件结构

```
critic-pipeline/
├── plugin.json              # 插件 manifest
├── .claude-plugin/
│   └── plugin.json          # 插件 manifest（打包版）
├── agents/
│   ├── critic-reader.md          # 代码档找茬角色（只读 + 快档）
│   ├── critic-judge.md           # 判卷角色（只读 + 强档，两档共用）
│   ├── critic-vision-reader.md   # 画面档：基准调研 / 取证 / 逐维找茬
│   └── critic-detail-judge.md    # 画面档：细节评委（假达标 + 抄袭）
├── skills/
│   ├── critic-round/SKILL.md     # /critic-pipeline:critic-round
│   └── quality-round/SKILL.md    # /critic-pipeline:quality-round
└── workflows/
    ├── critic-round.js           # 代码档流水线
    └── quality-round.js          # 画面档流水线
```

`CONTEXT.md` 是领域术语表（档位、画面八维、基准与评分、借鉴与抄袭、角色口径）。

## 相关

- 零成本干跑：`node scripts/dryrun-quality-round.cjs <case>`（normal / plagiarism / converged / stalled / noref / nocapture / lensfail），不调真实子代理，只验参数流动与收敛判定。
- ADR：`D:\app\YuMoBox\docs\adr\0055-critic-pipeline-workflow.md`
- 团队台本：`D:\app\YuMoBox\.claude\team-kits\standard-kit.json`（干活用团队，挑刺用本插件，两者解耦）
