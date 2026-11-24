---
name: quality-round
description: 跑一轮画面挑刺。先建立参考作品基准，再执行取证计划收集截图与量化指标，按八个画面维度并行找茬并自评扣分，细节评委审假达标与抄袭，主判卷汇总终裁，最后判定收敛/停滞。只挑刺不改画面；多轮由调度员驱动。触发词：画面挑刺、画质评审、画面效果评审、视觉挑刺、quality-round、对标画质、画面迭代、渲染效果检查。
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

可选：`goal`（本轮想改善什么）、`projectContext`（技术栈与美术红线）、`known`（已知未修项）、`targetScores`（逐维目标分）、`depth`（quick 四路合并 / full 八路分维）、`maxRounds`。

## 2. 调用 workflow

调 `quality-round` workflow。一次调用只跑一轮：

- 画面档**不看代码改动**，看的是画面现状 + 基准，所以不传 diff/intent。
- 性能、卡顿、加载耗时不在本档范畴；要查这些走代码档。
- 画面档只挑刺：视觉挑刺者、细节评委、主判卷都无写工具，改不了项目文件。

## 3. 收结果

返回核心：

- `dimensions`：八维逐项——分数、目标分、是否达标、扣分项（扣几分 / 差什么 / 差距多大 / 证据）、值得保留的优点、是否假达标；
- `mustFix` / `shouldFix` / `minor`：终裁后的确认项（假达标会被强制提到必修）；
- `plagiarism`：是否硬阻断、风险明细、借鉴与抄袭的归置；
- `coverage`：本轮没拍到的场景，照着补拍；
- `converged` / `stopReason` / `stuckDimensions`：收敛状态、停因、卡在哪几维；
- `progressRecord`：跨轮快照，**存下来传给下一轮**；
- `benchmarkBrief`：基准口径，**存下来跨轮复用**，后续轮不必重复调研；
- `handoff`：按维度分组的施工清单，可直接转给施工队。

## 4. 驱动长期迭代

1. 拿 `handoff` 去改画面（本 skill 不改）；
2. 补齐 `coverage` 里的取证缺口（补场景或补 metrics 命令）；
3. 再调一轮，传 `round + 1`、`history`（之前所有 progressRecord）、`benchmarkBrief`、`known`（未修的必修项）；
4. 直到 `converged` 为真，或 `stopReason` 为 `plagiarism-blocked` / `max-rounds` / `stalled` / `insufficient-evidence` 时停下交人看。

停因口径：`converged`（八维全部达标且无必修、无抄袭）优先；其次是抄袭阻断；再其次是达轮数上限；然后是停滞（分数没提升且无新增必修）；取证不足。