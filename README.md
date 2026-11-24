# critic-pipeline

通用**挑刺流水线**：给一轮代码改动做多视角"找茬"，产出结构化清单，**只挑刺、不修代码**。

一个插件把两件事打包：两个只读角色 + 一个 workflow。装一次，任何仓库都能用。

## 它解决什么

改完代码，很容易"只看见自己改的那几行"。常见的漏网：

- 改了这条路径，同族的其它入口路径上的缺陷没人管；
- 自己改完，自己复审，看不出问题；
- 兼容性、性能、用户体验这些维度，改代码时往往没顾上。

这个流水线用**每轮全新的一次性只读子代理**，从四个独立视角（外加一个可选的发散者）找问题，再由一个**判卷的**去伪存真、定级。找茬的物理上改不了代码（工具白名单只有只读三件），不靠自觉。

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

- **只挑刺，不修代码**。找茬的和判卷的工具白名单都是 `Read, Grep, Glob`，物理上改不了代码。
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
│   ├── critic-reader.md     # 找茬角色（只读 + 快档）
│   └── critic-judge.md      # 判卷角色（只读 + 强档）
└── workflows/
    └── critic-round.js      # 挑刺流水线本体
```

## 相关

- ADR：`D:\app\YuMoBox\docs\adr\0055-critic-pipeline-workflow.md`
- 团队台本：`D:\app\YuMoBox\.claude\team-kits\standard-kit.json`（干活用团队，挑刺用本插件，两者解耦）
