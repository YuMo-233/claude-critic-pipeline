---
name: quality-round
description: 跑一轮画面挑刺。先建立参考作品基准，再执行取证计划收集截图与量化指标，按八个画面维度并行找茬并自评扣分，细节评委审假达标与抄袭，分片判卷逐路去伪、汇流判卷终裁，最后判定收敛/停滞。只挑刺不改画面；多轮由调度员驱动。触发词：画面挑刺、画质评审、画面效果评审、视觉挑刺、quality-round、对标画质、画面迭代、渲染效果检查。
---

# 跑一轮画面挑刺

## 1. 先补齐事实底座

画面档有两个必填输入，缺了先问用户：

- **benchmarkRefs**：参考作品名，一个或多个，由用户点名。插件不写死任何游戏名；用户没点名就问清「拿什么当基准」。
- **capturePlan**：取证计划——跑什么命令、拍哪些场景、图存哪里、量化指标怎么算、哪些画质配置文件值得查。给全一点，缺了会退化：

| 字段 | 作用 |
|---|---|
| `run` | 取证命令（启动截图流程），在 `workdir` 下执行 |
| `workdir` | 取证命令的工作目录 |
| `outputDir` | 截图输出目录，取证员会扫这里 |
| `scenes` | 想覆盖的场景名，用于给截图对号入座 |
| `shots` | 现成截图路径（不想现场跑就只给这个） |
| `metrics` | 像素统计等量化命令，形如 `[{name, command}]` |
| `codePaths` | 值得查的画质配置（渲染、资源、UI），给路径即可 |

三个能出证据的入口（`run` / `shots` / `outputDir`）至少给一个，否则无法判画面。

可选：`goal`（本轮想改善什么）、`projectContext`（技术栈与美术红线）、`known`（已知未修项）、`targetScores`（逐维目标分）、`depth`（quick 四路合并 / full 八路分维）、`maxRounds`、`projectRef`（当前项目版本/commit，用于判断基准是否还适用）。

## 2. 调用 workflow

**先试名字，报错就走内联**：

1. 调 `Workflow({ name: 'critic-pipeline:quality-round', args: {...} })`；
2. 若报 `Unknown workflow`（本机 Haha 构建即如此），用 Glob 找到插件目录下最新的 `workflows/quality-round.js`（形如 `~/.claude/plugins/cache/*/critic-pipeline/*/workflows/quality-round.js`），把文件**全文**作为 `script` 传给 Workflow 工具，`args` 照旧传。
3. `args` 传对象或 JSON 字符串都行——脚本顶部会归一解析，不用预处理。

一次调用只跑一轮：

- 画面档**不看代码改动**，看的是画面现状 + 基准，所以不传 diff/intent。
- 性能、卡顿、加载耗时不在本档范畴；要查这些走代码档。
- 画面档只挑刺：视觉挑刺者、细节评委、分片判卷与汇流判卷都无写工具，改不了项目文件。

## 3. 收结果

返回核心：

- `dimensions`：八维逐项——分数、目标分、是否达标、扣分项（扣几分 / 差什么 / 差距多大 / 证据）、值得保留的优点、是否假达标；
- `mustFix` / `shouldFix` / `minor`：终裁后的确认项（假达标会被强制提到必修）；
- `plagiarism`：是否硬阻断、风险明细、借鉴与抄袭的归置；
- `coverage`：本轮没拍到的场景，照着补拍；
- `converged` / `stopReason` / `stuckDimensions`：收敛状态、停因、卡在哪几维；
- `progressRecord`：跨轮快照，**存下来传给下一轮**（内含 `briefRevision`，跨版本不比分数）；
- `benchmarkBrief`：基准口径，**写回 `.critic/benchmark-quality.json`**，后续轮不必重复调研；
- `briefStatus` / `briefPath` / `briefRevision`：本轮是复用还是重研（`reused` / `researched` / `stale-researched` / `unused`）、建议写回路径、本轮所用基准修订号——**调度员据此决定是否写回**；
- `handoff`：按维度分组的施工清单，可直接转给施工队；未达标的维会附「参考做法 + 可核验口径 + 出处」（脚本从 brief 拼，无有效基准时明示不附）。

## 4. 驱动长期迭代

### 4.1 基准落盘（读写由你负责，脚本不碰磁盘）

- **一次性准备**：确认项目 `.gitignore` 里有 `.critic/`，没有就追加一行（基准笔记是本机调研产物，不入库）。
- **每轮开跑前**：读 `.critic/benchmark-quality.json`，内容作为 `args.benchmarkBrief` 传入；同时从 git 取当前版本/commit 作为 `args.projectRef`（取不到就跳过，不要硬编）。文件不存在或读失败就当没有，照常开跑（脚本会自动调研）。
- **每轮收结果后**看 `briefStatus`：
  - `reused`：复用了文件里的基准，**不动文件**；
  - `researched` / `stale-researched`：本轮重新调研了，把 `benchmarkBrief` **原样写回 `briefPath`**（脚本已带 `revision`/`fetchedAt`/`appliesTo`/`origin`）；
  - `unused`：本轮没有基准可用，不写回。
- **文件被改坏（JSON 解析失败）**：报错并提示人工把文件改名备份后重研，不要静默当作没有文件。

### 4.2 迭代循环

1. 拿 `handoff` 去改画面（本 skill 不改）；
2. 补齐 `coverage` 里的取证缺口（补场景或补 metrics 命令）；
3. 再调一轮，传 `round + 1`、`history`（之前所有 progressRecord，含 `briefRevision`）、`benchmarkBrief`（从文件读）、`known`（未修的必修项）；
4. 直到 `converged` 为真，或 `stopReason` 为 `plagiarism-blocked` / `max-rounds` / `stalled` / `insufficient-evidence` / `brief-revised` 时停下交人看。

停因口径：`converged`（八维全部达标且无必修、无抄袭）优先；其次是 `brief-revised`（基准换了，分数不可比，先确认目标分再继续）；再其次是抄袭阻断；达轮数上限；停滞（分数没提升且无新增必修）；取证不足。