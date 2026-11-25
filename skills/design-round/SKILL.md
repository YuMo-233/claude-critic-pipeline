---
name: design-round
description: 跑一轮游戏设计挑刺。先由只读分诊员判任务类型与评分维度（11 维库，goal 逐条归位，装不下的单列并拦收敛），再并行找茬，细节评委审假达标与证据造假，分片判卷逐路去伪、汇流判卷终裁，最后判定收敛/停滞。复检轮只重打涉改维与旧账所在维。只查结构代理指标，玩家原话不能当证据；只挑刺不改设计；多轮由调度员驱动。触发词：设计挑刺、玩法评审、数值平衡检查、趣味性评审、game design review、design-round、设计迭代、玩家反馈分析。
---

# 跑一轮游戏设计挑刺

## 1. 先补齐事实底座

必填 `goal`（这轮想改善什么）。另需**至少一类证据来源**，四类随便组合，一个都没有就先问用户：

| 字段 | 作用 |
|---|---|
| `simPlan.run` | 模拟/统计命令（战斗耗时、数值曲线等），在 `workdir` 下执行 |
| `simPlan.checks` | 现成校验命令，形如 `[{name, command}]` |
| `simPlan.codePaths` | 值得查的数值与规则配置（角色表、掉落表、成长曲线、经济参数），给路径即可 |
| `feedback` | 玩家反馈文本（字符串或 `{text, files[]}`）。**可选** |
| `benchmarkRefs` | 参考作品名，用户点名才用；插件不写死任何游戏名 |

`projectPath` 只用来定位项目，本身不算证据。

可选：

- `players`（人数，默认 1；2 人以上才开合作、合作趣味、双人差分、突发意外四维）
- `type`（显式任务类型：balance-tuning / level-content / boss-encounter / coop-experience / full-mixed，给了就跳过分诊）
- `dimensions`（白名单，可强制开启被人数闸关掉的维度；给了也跳过分诊）
- `scope`（本轮聚焦切片 `{label, units[], note?}`：全局维仍做基线，只在切片内深挖）
- `mode`（`explore` / `verify`；缺省按 `history` 自动：空则 explore，否则 verify）
- `changes`（本轮改动 `{summary, stat, files[], dimensions[]}`，复检与定向回归镜头据此定位）
- `prevMustFix`（显式覆盖旧账明细，优先于 history 里记的）
- `acceptUncovered`（`true` 时放行「目标没有维度接住」的拦截）
- `depth`（explore 缺省 full 逐维 / verify 缺省 quick 按组；也可显式传）
- `round`、`history`（之前所有 progressRecord）、`benchmarkBrief`（上轮基准口径）、`known`（未修必修项）、`targetScores`、`maxRounds`、`projectContext`、`projectRef`（当前项目版本/commit，用于判断基准是否还适用）

## 2. 调用 workflow

**先试名字，报错就走内联**：

1. 调 `Workflow({ name: 'critic-pipeline:design-round', args: {...} })`；
2. 若报 `Unknown workflow`（本机 Haha 构建即如此），用 Glob 找到插件目录下最新的 `workflows/design-round.js`（形如 `~/.claude/plugins/cache/*/critic-pipeline/*/workflows/design-round.js`），把文件**全文**作为 `script` 传给 Workflow 工具，`args` 照旧传。
3. `args` 传对象或 JSON 字符串都行——脚本顶部会归一解析，不用预处理。

一次调用只跑一轮。两条硬口径先说清：

- **趣味性只看结构代理指标**：反馈密度、选择空间、风险回报结构、失败代价与重试成本等能落到配置或代码的东西。AI 不能真玩一局说"不爽"，所以"好玩"本身不入账。
- **玩家原话永远不是结构证据**：每条反馈必须映射到心理学机制（自主/胜任/归属/心流/损失厌恶/变比率奖励/沉没成本/峰终等），再落到具体数值:行、模拟输出、代码位置或参考口径。落不了锚的反馈进 `unverified` 单列，**不计分也不阻塞收敛**。

各维度开关：`minPlayers` 为 2 的四维在单人局自动关；用 `dimensions` 白名单可手动越闸。玩家反馈维在没给 `feedback` 时自动关。

**分诊与跨轮回传**：不传 `type`/`dimensions` 时脚本会派一个只读分诊员，判出类型与维度、把 `goal` 逐条归位。归不进去的目标进 `uncoveredGoals` 并**拦住收敛**（停因 `goal-uncovered`），此时要么补证据、要么显式加维、要么传 `acceptUncovered: true` 接受。**下一轮把返回的 `type` 与 `dimensions` 原样回传**，既省一次分诊、又避免维度漂移导致分数不可比。

**复检轮**：`history` 非空即进入 `verify`。核对员逐条判上轮必修项（fixed / still-present / worsened / untestable），只有涉改维与旧账所在维重打分（其余沿用上轮、标 `carried`），并跑定向回归镜头查新引入的问题。旧账没清完不算收敛。

## 3. 收结果

返回核心：

- `type` / `triage` / `triageFallback`：本轮任务类型、分诊明细、是否走了兜底（全维）；
- `goalCoverage` / `uncoveredGoals` / `acceptedUncovered`：目标逐条归位结果、没有维度接住的目标、是否已被放行；
- `mode` / `verifier` / `touchedDims` / `carriedDims` / `verifyFallback`：本轮是 explore 还是 verify、核对结论、重打了哪些维、哪些沿用上轮、复检是否降级；
- `scope` / `notApplicable`：本轮切片回显、项目根本没有的设计面；
- `dimensions`：逐维——分数（5 分制，扣分表）、目标分、是否达标、扣分项（扣几分 / 差什么 / 证据）、优点、是否假达标、是否沿用上轮、是否不适用；
- `mustFix` / `shouldFix` / `minor`：终裁后的确认项（假达标会被强制提到必修；每条都带 `anchorKind` = numeric-config / sim-output / code / benchmark）；
- `evidenceIntegrity`：是否因证据造假硬阻断（锚点对不上真实配置、编造玩家没说过的话）；
- `unverifiedFeedback`：落不了锚的纯情绪反馈，单列给用户看；
- `coverage`：本轮缺的证据，照着补模拟或补数值表；
- `converged` / `stopReason` / `stuckDimensions`：收敛状态、停因、卡在哪几维；
- `progressRecord`：跨轮快照，**存下来传给下一轮**（内含 `briefRevision`，跨版本不比分数）；
- `benchmarkBrief`：基准口径，**写回 `.critic/benchmark-design.json`**，后续轮不必重复调研；
- `briefStatus` / `briefPath` / `briefRevision`：本轮是复用还是重研（`reused` / `researched` / `stale-researched` / `unused`）、建议写回路径、本轮所用基准修订号——**调度员据此决定是否写回**；
- `handoff`：按维度分组的施工清单，可直接转给施工队；未达标的维会附「参考做法 + 可核验口径 + 出处」（脚本从 brief 拼，无有效基准时明示不附）。

## 4. 驱动长期迭代

### 4.1 基准落盘（读写由你负责，脚本不碰磁盘）

- **一次性准备**：确认项目 `.gitignore` 里有 `.critic/`，没有就追加一行（基准笔记是本机调研产物，不入库）。
- **每轮开跑前**：读 `.critic/benchmark-design.json`，内容作为 `args.benchmarkBrief` 传入；同时从 git 取当前版本/commit 作为 `args.projectRef`（取不到就跳过，不要硬编）。文件不存在或读失败就当没有，照常开跑（脚本会自动调研）。
- **每轮收结果后**看 `briefStatus`：
  - `reused`：复用了文件里的基准，**不动文件**；
  - `researched` / `stale-researched`：本轮重新调研了，把 `benchmarkBrief` **原样写回 `briefPath`**（脚本已带 `revision`/`fetchedAt`/`appliesTo`/`origin`）；
  - `unused`：本轮没有基准可用（没给参考作品），不写回。
- **文件被改坏（JSON 解析失败）**：报错并提示人工把文件改名备份后重研，不要静默当作没有文件。

### 4.2 迭代循环

1. 拿 `handoff` 去改数值与设计（本 skill 不改）；
2. 补齐 `coverage` 里的证据缺口（补模拟命令或补配置路径）；
3. 再调一轮，传 `round + 1`、`history`（之前所有 progressRecord，含 `briefRevision`）、`benchmarkBrief`（从文件读）、`known`（未修的必修项）；
4. 把本轮返回的 `type` 与 `dimensions` 回传到下一轮（避免维度漂移）；有改动就把 `changes` 一起传。
5. 直到 `converged` 为真，或 `stopReason` 为 `goal-uncovered` / `evidence-blocked` / `max-rounds` / `stalled` / `insufficient-evidence` / `brief-revised` 时停下交人看。

停因口径：`converged`（全部活跃维达标 + 无必修 + 旧账无未修项 + 无证据阻断 + 目标全部有维度接住）优先；其次是 `goal-uncovered`（有目标没处安放，补证据 / 加维 / 或 `acceptUncovered` 放行）；再其次 `brief-revised`（基准换了，分数不可比）；再其次证据造假阻断；达轮数上限；停滞（分数没提升且无新增必修）；取证不足。`continue` 表示证据还不够判、但也没造假，补证据后继续下一轮。