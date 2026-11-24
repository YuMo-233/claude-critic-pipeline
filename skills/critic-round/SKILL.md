---
name: critic-round
description: 跑一轮通用挑刺。代码改动完成后，分诊员先按任务性质（整理文件/新功能/修bug/重构）判类型，按性质挑视角跑只读找茬，去伪定级后返回结构化清单。只挑刺不改代码。触发词：挑刺、跑挑刺、代码评审、审一下改动、检查改动、review、critic、挑毛病、看有没有问题。
---

# 跑一轮通用挑刺

## 1. 先补齐事实底座

挑刺只看两个输入，缺了就问用户或先补：

- **diff**：本轮改动。未提交用 `git diff`（另加未跟踪文件清单），已提交用 `git show <ref>` 或提交摘要。
- **intent**：本轮修改意图。从对话/需求里提炼成一句大白话；用户没明说就写「未明确，按 diff 推断」。

可选，有就给，没有不硬凑：

- **known**：前几轮已知未修项，避免重复报。
- **projectContext**：技术栈、版本/平台矩阵、项目红线、领域术语。传了挑刺能对齐语境，不传流水线保持技术栈无关。

## 2. 调用 workflow

**先试名字，报错就走内联**：

1. 调 `Workflow({ name: 'critic-pipeline:critic-round', args: {...} })`；
2. 若报 `Unknown workflow`（本机 Haha 构建即如此），用 Glob 找到插件目录下最新的 `workflows/critic-round.js`（形如 `~/.claude/plugins/cache/*/critic-pipeline/*/workflows/critic-round.js`），把文件**全文**作为 `script` 传给 Workflow 工具，`args` 照旧传。
3. `args` 传对象或 JSON 字符串都行——脚本顶部会归一解析，不用预处理。

**正常情况不要传 type / lenses / diverge / escalate** —— 交给分诊员按任务性质自动判，它自己会展开成对应视角。

四种任务类型对应的挑刺强度（分诊员负责判）：

| type | 何时用 | 视角 | 发散者 | 升级门 |
|---|---|---|---|---|
| `file-cleanup` | 整理/重命名/移动/格式化/删废代码 | 正确性 + UX | 不开 | 关 |
| `feature` | 新功能、扩展能力 | 四路全开 | 开 | 开 |
| `hotfix` | 紧急修 bug、修线上问题 | 四路全开 | 开 | 关 |
| `refactor` | 重构、架构调整、大范围改动 | 四路全开 | 开 | 开 |

只有两种情况手动覆盖：

- 明确知道要跑哪几路 → 传 `lenses`（显式 lenses 盖过 type 展开）；
- 分诊判得不准 → 传 `type`。

## 3. 收结果

返回是结构化清单，直接用：

- `mustFix` / `shouldFix` / `minor`：判卷定级后的确认项；
- `preExisting`：发散者发现的同场景老毛病，**单列给用户拍板，绝不混进本次必修**；
- `pathMatrix` / `userPathMatrix`：发散者与 UX 路枚举的入口/用户可达路径矩阵；
- `rejectedCount`：被驳掉的假阳性条数，用来核对有没有漏；
- `handoff`：可直接转给施工队的文字清单。

`mustFix` 与 `shouldFix` 交施工队，`preExisting` 单独列给用户，`minor` 记待办。
