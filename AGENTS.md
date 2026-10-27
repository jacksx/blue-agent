# AGENTS.md · 本仓库的工作约定

> 这是给在本仓库执行任务的 agent 读的指令。**开始任何改动前，先读本文件和 [TODO.md](TODO.md)。**
> 与用户最新口头指示冲突时，以用户指示为准，并同步更新这里的约定。

---

## 0. 开工前必读（顺序）

1. **[TODO.md](TODO.md)** —— 当前 P0/P1/P2、验收标准、哪些已经做完。先查有没有重复任务或相关已完成项。
2. **[README.md](README.md)** —— 对外能力、实测数字、协议。任何“已完成”的描述必须和代码一致。
3. **[recruiting-agent-plan.md](recruiting-agent-plan.md)** —— 设计依据。改判定、RAG、审批前看对应章节。
4. **[docs/schema.sql](docs/schema.sql)** —— 改数据模型时必看。
5. 改动涉及具体模块时，再读该模块的注释（`lib/agent/*`、`lib/rag/*` 顶部都有设计说明）。

---

## 1. 完成的定义（Definition of Done）

一个任务只有**同时**满足以下条件，才能在 TODO.md 里标 `[x]`：

- [ ] 代码 / 文档改动完成，`pnpm exec tsc --noEmit` 通过（或 `pnpm build` 通过）。
- [ ] 有**可重跑**的验证：脚本、单测、eval case 或可复现命令，并且**实际跑过**。
- [ ] **TODO.md 已更新**：`[ ]` → `[x]`，补日期和证据；更新「当前快照」计数与「更新日志」。
- [ ] 对外能力有变化时，README 的能力表 / 实测数字同步。
- [ ] 接口、action、数据模型变化时，`docs/schema.sql` / `mock-backend-spec.md` 同步。
- [ ] 没有把未验证的东西写成“已完成”。

**只改代码不改 TODO.md = 没做完。**
**只写“已验证”不写命令 = 没做完。**

---

## 2. TODO.md 维护规则

它是任务状态的**唯一事实源**，README 不再维护第二份清单。

| 状态 | 写法 | 含义 |
|---|---|---|
| 待做 | `- [ ] 事项 — 验收标准` | 还没开始 |
| 进行中 | `- [ ] **进行中** 事项 — ...` | 正在做 |
| 完成 | `- [x] 事项 — 证据（YYYY-MM-DD）` | 代码 + 验证 + 文档都完成 |
| 不做 | `- [-] 事项 — 原因` | 明确不做，别反复提 |

规则：

1. **新任务先写验收标准**，没有“怎么算做完”就不进清单。
2. **完成即更新**，和代码放在同一个提交里；不要攒到最后。
3. 完成的条目移到「已完成」对应模块，保留日期与证据；同时更新「当前快照」的计数。
4. P0 不超过 5 项；P1/P2 可以多，但要按周排。
5. 证据必须可重跑（脚本名 + 结果数字），不写“目测”“应该没问题”。
6. 术语区分 `核查`（确认已有并验证）和 `实现`（本轮新写），别把旧能力算成本轮成果。
7. 每次完成一批任务，在「更新日志」加一条：做了什么、结果数字、遗留风险。

格式自检：

```bash
pwsh -File scripts/todo-check.ps1
```

它会检查：完成项有没有日期、待做项有没有验收标准、当前快照的计数和实际条目是否一致。
**CI 里应把它和 typecheck 放在同一层。**

---

## 3. 项目结构与硬约束

```
app/                 Next.js App Router（页面 + API adapter）
lib/agent/           编排、匹配、审批、槽位、标签、存储（不 import next/*）
lib/rag/             政策语料、检索、RAG 评测题集
lib/llm/             DeepSeek 适配、prompt、schema、接地校验
lib/eval/            回归集、McNemar、维度
lib/fixtures/        3 岗位 + 3 候选人
scripts/             pwsh 验证脚本
docs/schema.sql      Supabase 建表
```

必须遵守：

1. **`lib/agent/*` 不 import 任何 `next/*`**。换 Fastify/容器部署时只改 `app/api` adapter。
2. **决策层是纯同步、可复现的**（`orchestrator.handle`）。模型只出现在理解（`nlu`）和措辞（`compose`）两头。
3. **审批之前不能有非幂等副作用**。采集表 `formId` 由会话 + 岗位 + 轮次确定性生成，恢复多少次都是同一张。
4. **事实归规则，措辞归模型**。模型拿不到岗位/简历原文，只拿到草稿；输出必须过接地校验。
5. **prompt 改动必须升版本号**（`lib/llm/prompts.ts` 的 `version`），并重跑 eval 后再改 README 数字。
6. **工具走 `AgentTools`**；不要在 `orchestrator` 里直接 import fixtures。
7. **站外导流红线**：agent 永远不报自己的微信号/手机号/二维码；用户主动要微信走转出 + 交接摘要。
8. **不承诺**：不承诺薪资、录取、返费；不透露其他候选人信息；不做医疗/法律建议。
9. **不改幂等、审批、快照的语义**来让某个 case 变绿；先改 case 或设计，并在 TODO 记录原因。
10. **密钥不进仓库**：`.env*.local` 已在 `.gitignore`；不要读出来打印。

---

## 4. 验证命令（按改动范围选）

```bash
pnpm exec tsc --noEmit                 # 类型
pnpm build                             # 生产构建（改路由/前端后必跑）

pwsh -File scripts/unit-check.ps1      # L0 纯函数（毫秒级）
pwsh -File scripts/rag-check.ps1       # RAG 召回/拒答/消融
pwsh -File scripts/approval-check.ps1  # 审批中断/恢复/离线
pwsh -File scripts/merge-check.ps1     # 连发合并 + 幂等
pwsh -File scripts/robust-check.ps1    # 用量/改口/并发
pwsh -File scripts/eval.ps1            # 23 条回归（单次）
pwsh -File scripts/eval.ps1 -Runs 3    # 接模型后必跑，看 flaky
pwsh -File scripts/eval.ps1 -SaveBaseline   # 改 prompt/判定之前先存基线
```

判定纪律：

- **先看 `broken`，再看 `fixed`，最后才看总分。** 总分涨了不代表没弄坏东西。
- 改 prompt / 判定前先 `-SaveBaseline`；改完用 `-Runs 3` 对比。
- `degraded > 0` 要解释原因；`flaky > 0` 要说明是模型抖动还是 case 在边界。
- README 里的数字只能来自最近一次实际运行，不能手写“大概”。

启动本地服务（演示/联调）：

```bash
pnpm dev      # http://127.0.0.1:3000
```

---

## 5. 文档同步矩阵

| 改了什么 | 必须同步 |
|---|---|
| 任何功能/修复 | **TODO.md**（状态、日期、证据、更新日志） |
| 用户可见能力 | README 能力表、演示脚本、实测数字 |
| 接口/action/状态机 | `lib/agent/types.ts`、README「契约里的协议」、`mock-backend-spec.md` |
| 数据模型 | `docs/schema.sql`、README 目录、TODO |
| prompt | `lib/llm/prompts.ts` 版本号、eval 数字、README |
| 脚本 | README 快速开始、TODO 证据列 |
| 新增文件/目录 | README 目录树、TODO 证据位置 |

---

## 6. 明确不做（不要重新提议）

- OCR/ASR 识别健康证、身份证、语音；表单发出后的催填、排期、改约；主动触达。
- shadow 模式；全局审批开关；跨经纪人自动转交；向量记忆库；multi-agent。
- 让 agent 报自己的微信号；承诺薪资/录取；歧视性表述；医疗/法律建议。

完整列表见 [TODO.md](TODO.md) 的「明确不做」。

---

## 7. 交付汇报格式

给用户的最终回复至少包含：

1. **做了什么**（按模块，不逐文件罗列）。
2. **怎么验证的**（命令 + 结果数字，而不是“测试通过”）。
3. **还没做的 / 风险**（指向 TODO.md 的 P0/P1，不隐瞒）。
4. **怎么体验**（如果改了 UI 或接口，给出 URL / 请求示例）。

不要用“全部完成”“完美”这类无法验证的词；用用例数和脚本输出说话。
