# 任务清单 / TODO

> **单一事实源**：要做什么、做到哪了、为什么没做，都以这份文档为准。
> 改代码前先看这里；做完一项就回来更新状态、日期和验证方式。
>
> 相关文档：[AGENTS.md](AGENTS.md)（agent 执行约定）· [README.md](README.md)（能力与用法）· [recruiting-agent-plan.md](recruiting-agent-plan.md)（设计规划）· [docs/schema.sql](docs/schema.sql)（数据模型）
>
> 本文件由 [AGENTS.md](AGENTS.md) 强制维护：**只改代码不改这里 = 没做完**；格式/计数由 `scripts/todo-check.ps1` 校验。

---

## 维护规则

状态只有四种，别自创：

| 标记 | 含义 | 写法 |
|---|---|---|
| `[ ]` | 待做 | `- [ ] 事项 — 验收标准` |
| `[ ] **进行中**` | 正在做 | 在待做基础上加粗标进行中，并写负责人/分支（可选） |
| `[x]` | 已完成 | `- [x] 事项 — 证据（YYYY-MM-DD）` |
| `[-]` | 明确不做 | 写清原因，别让它反复被提 |

更新纪律：

1. **完成即更新**：改完代码、跑完验证，同一次提交里把这一项改成 `[x]`，补日期和证据。
2. **证据必须是可重跑的**：命令、脚本名、用例数，不写“目测没问题”。
3. **验收标准先写**：新任务进来时就要有“怎么算做完”，否则不做。
4. **P0 不超 5 项**：P0 是“这周必须做”，多了等于没有优先级。
5. **对外能力变化**：同步更新 README 的能力表；纯内部重构只改这里。
6. **不删历史**：完成的条目移到「已完成」归档，保留日期和证据，方便回溯。

---

## 当前快照（2026-10-27）

| 项 | 值 |
|---|---|
| 代码状态 | 工作区（未提交），基线 commit `618f10e` |
| 任务计数 | 已完成 **53** · 待做 **15**（P0 4 / P1 6 / P2 5）· 明确不做 **10** |
| 回归集 | **23/23**；`-Runs 3` 也是 23/23，flaky 0，degraded 0，约 186s |
| L0 单元 | **33/33**（McNemar / TTL / 审批 / 标签 / 接地 / 卡片 / scope） |
| RAG 消融 | 38 条（30 正 + 8 负）；Recall@5 **1.000**、MRR **0.928**、拒答 **1.000**、误拒 **0** |
| 审批脚本 | 全绿（中断 / pending 拦截 / approve / edit / reject / 离线降级） |
| 构建 | `pnpm build` 通过（2026-10-27） |
| 本地服务 | `http://127.0.0.1:3000`（`pnpm dev`） |

---

## P0（这周必须做）

- [ ] **长期记忆：跨会话候选人画像** — 新建 `profile_slots` / `preference_events` 的读写层，按 `candidateId` 直取；新会话注入「画像摘要 + 最近 3 次结论 + 负偏好」；聊天与简历冲突标 `conflicted` 并澄清一次。
  - 验收：同一候选人换新会话，不再重复问年龄/现居/班次/薪资；冲突字段只澄清一次；清空会话后仍记得“只上白班”。
  - 依赖：`docs/schema.sql` 的 `profile_slots` / `preference_events` 已建表，缺代码。
  - 位置：`lib/agent/store.ts`、新增 `lib/agent/profile.ts`、`orchestrator` 注入。

- [ ] **审批 / 快照 / 幂等 持久化** — 审批从进程内 Map 换到 `.data` 或 Redis；快照缓存、幂等结果也迁出内存；多实例共享。
  - 验收：重启服务后，未处理的审批还能 `resume`；两个实例并跑，同一 `messageId` 只处理一次；审批过期能自动清理。
  - 依赖：Redis/Postgres（本地可先用文件持久化过渡）。
  - 位置：`approval.ts`、`snapshot-cache.ts`、`idempotency.ts`。

- [ ] **多职位切换完整模型（§2.9）** — 建 `subject_bindings`；`messages.subjectId` 由 BFF 写入；槽位分 `person` / `subject` 两层（`scope` 已有，缺存储）；A→B→A 能恢复 A 的 `job.*`；切换时旧审批失效、旧采集表 `revoked`。
  - 验收：A→B→A 后不重问 A 已确认的岗位问题；B 的回答里不出现 A 的薪资/地点；切换时 pending 审批返回失效。
  - 现状：已用 `scope: subject` 防“A 的能接受带到 B”，但 `job.*` 没有按 subject 存。
  - 位置：`lib/agent/types.ts`、`store.ts`、`orchestrator.ts`、`approval.ts`。

- [ ] **鉴权 + 按会话限流** — 入口校验 `Authorization`（401）；在全局在飞限制之外，加按 `conversationId` 的桶；超限返回 429 + `retry-after`。
  - 验收：错 key 返回 401；同一会话 10 并发只有 1 个在处理，其余 429/排队；不同会话互不影响。
  - 现状：只有全局 `MAX_INFLIGHT=16`，没有鉴权。
  - 位置：`app/api/v1/messages/route.ts`、`lib/agent/gate.ts`。

---

## P1（下一步，按周排）

- [ ] **RAG 生产化** — 真实政策/岗位语料（≥300 chunk）；`bge-m3` 向量适配器（保留本地哈希向量做离线兜底）；人工标注 100 条 query→chunk；按语料重新校准拒答阈值。
  - 验收：标注集 Recall@5 ≥ 0.85；拒答准确率 ≥ 0.9；消融表能说明每一层增益；离线无 key 仍可跑。
  - 位置：`lib/rag/retrieve.ts` 的 `embed()`、`corpus.ts`、新增标注集。

- [ ] **标签归一化落库 + 人工审核队列** — `canonical_tags` / `tag_text_mappings` 回写；按归一化文本做 key；低置信（<0.85）进审核队列；人工确认后晋升为 0.98。
  - 验收：100 条自定义标签批量归一，unresolved 可列出并逐条确认；“管饭/包吃”命中同一 canonical；低置信不参与硬判断。
  - 现状：代码层字典 + 置信度分流已完成（`lib/agent/tags.ts`），缺 DB 回写与队列。
  - 位置：`tags.ts`、`docs/schema.sql`、新增批量脚本。

- [ ] **跨经纪人转介（§2.13）** — 请求体支持 `referral`（fromConversationId / fromRecruiterId / slots / summary）；新会话首轮合并旧上下文；卡片归属展示已做，缺 payload。
  - 验收：跳到新经纪人会话后，首轮能说“你刚看过包装厂”，不重问已知项；卡片显示“由 XX 顾问负责”。
  - 位置：`types.ts`、`pipeline.ts`、`recommend.ts`。

- [ ] **接管边界 L2（§4）** — 外部信号驱动的升级：要求人工、薪资谈判/要承诺、投诉/情绪、简历与聊天冲突、连续工具失败、敏感话题。
  - 验收：redteam 60 条拦截率 ≥ 95%，误杀 ≤ 3%；转人工带摘要；LLM 不参与“要不要交出去”的判断。
  - 现状：非文本连续 2 条、no_candidate、unclear 已能转；缺情绪/投诉/要求人工/敏感话题。
  - 位置：新增 `lib/agent/escalation.ts`、`orchestrator.ts`。

- [ ] **Playground：回放 / stateless / 工具面板** — JSONL 导入回放；session/stateless 切换；工具调用与检索 chunk 面板。
  - 验收：导入一段历史 JSONL 能逐步重放并对比；stateless 模式请求体自带上下文也能跑；能看到 tool / rag / approval 节点。
  - 现状：审批卡、策略切换、四栏 + trace 已完成。
  - 位置：`app/page.tsx`、新增 `/api/replay`。

- [ ] **指标看板 + Release Gate** — 首响 P95、发表率、degraded、flaky、单会话成本；任一维度跌破阈值拦发版。
  - 验收：一条命令出报告；gate 失败退出码非 0；能按 git sha / prompt 版本对比。
  - 现状：只有脚本输出与 eval baseline diff。
  - 位置：`scripts/`、`app/api/eval/*`。

---

## P2（有空再做 / 需要外部条件）

- [ ] **MCP server** — 7 个 tool / 0 个 resource；in-memory transport 同进程部署，协议层可拆独立 HTTP。
  - 验收：MCP Inspector 能独立调工具；agent 作为 client 调用，行为不变。
  - 现状：工具层已抽象成 `AgentTools`，缺 MCP 封装。

- [ ] **跨平台岗位池合并（§2.15）** — 两个平台岗位一起排序；卡片映射回当前平台 id（已做）；会话/候选人按平台隔离（当前 key 只有 conversationId）。
  - 验收：BOSS 会话只出 BOSS 可点的卡；同一人在两平台被当两个人；请求 platform 与岗位不一致直接 400（已做）。

- [ ] **评测集扩容 + holdout** — intent 600 / rag 100 / match 100 / redteam 60；留 15% 不参与调优。
  - 验收：分层指标可报；holdout 只在发版跑；难例回流有记录。
  - 现状：23 条回归 + 38 条 RAG，题集偏小、recall 已饱和。

- [ ] **CI** — PR 上跑 typecheck + unit + 无模型 eval + build；nightly 跑带模型的全量 eval。
  - 验收：PR 红灯能定位到具体 case；nightly 报告有趋势。
  - 现状：全部手动脚本。

- [ ] **可观测性与 PII** — 结构化日志、`agent_runs` 落库、手机号/身份证脱敏、trace 保留期。
  - 验收：能按 traceId 查一次请求的每步；日志里不出现完整手机号；保留期可配。
  - 现状：trace 只随响应返回，不落库。

---

## 已完成

> 日期说明：`核查` = 本轮确认已有且验证通过；`实现` = 本轮新写。

### 契约与运行时

- [x] 请求 / 响应 / `actions[]` 契约（文本、卡片、采集表、转人工、审批卡）— `lib/agent/types.ts`（核查，2026-10-27）
- [x] 快照引用协议：稳态只传 `id@version`，缺失返回 `409 SNAPSHOT_REQUIRED`，补快照重发幂等 — `snapshot-cache.ts` / `route.ts`（核查，2026-10-27）
- [x] `messageId` 幂等重放：`meta.cached=true` + `x-idempotent-replay: 1`，traceId 与首次一致 — `idempotency.ts`（核查，2026-10-27）
- [x] 连发合并：1.2s 静默窗口、排序无关的 turn 幂等键、三条只回一次 — `merge.ts` / `merge-check.ps1`（核查，2026-10-27）
- [x] 岗位来源一致性：`platformEnabled` 不含当前平台直接 400 — `route.ts`（核查，2026-10-27）
- [x] 同会话串行、进锁后再查幂等 — `lock.ts`（核查，2026-10-27）
- [x] 在飞限流 16，超了 429 — `gate.ts`（核查，2026-10-27）
- [x] 模型重试退避（5xx/429/超时/网络，最多 3 次）— `deepseek.ts`（核查，2026-10-27）
- [x] 会话持久化：内存 + 200ms 合并写 `.data/conversations.json` — `persistence.ts`（核查，2026-10-27）
- [x] 用量埋点：理解 + 措辞两次调用的 token / 重试 / 成本累加 — `pipeline.ts` / `compose.ts`（核查，2026-10-27）

### 审批 / 转出 / 接管

- [x] **审批中断**：按动作配 `ApprovalPolicy`，`interview_form: require` 时返回 `approval_request` + `PENDING_APPROVAL`，此刻无副作用 — `approval.ts`（实现，2026-10-27）
- [x] **审批恢复**：`resume: approve / edit / reject`；审批未处理时新消息 409；已处理再批 409；同一 `messageId` 重发幂等 — `approval.ts` / `route.ts`（实现，2026-10-27）
- [x] **证据完整度**：硬条件、可谈项、待确认、槽位新鲜度算置信度，不用模型自评 — `approval.ts`（实现，2026-10-27）
- [x] **离线降级**：`auto_if_confident` / `wait` / `auto_always`；阈值可配 — `approval.ts`（实现，2026-10-27）
- [x] **确定性 formId**：会话 + 岗位 + 轮次决定，恢复多少次都是同一张表 — `orchestrator.ts`（实现，2026-10-27）
- [x] **用户发起换微信**：指路平台按钮 + 交接摘要 + `TRANSFERRED`，agent 不报自己微信号 — `orchestrator.ts`（实现，2026-10-27）
- [x] 连续 2 条非文本消息 → 转人工；单条给替代说法 — `orchestrator.ts`（实现，2026-10-27）
- [x] 岗位卡按当前平台映射 id，标平台来源与归属顾问 — `cards.ts`（实现，2026-10-27）

### 理解 / 匹配 / 记忆

- [x] topic / action 分离；action 封闭枚举，topic 可扩展 — `rules.ts` / `nlu.ts`（核查，2026-10-27）
- [x] 模型理解 + schema 校验 + 规则并集兜底；无 key 行为零差异 — `nlu.ts` / `schemas.ts`（核查，2026-10-27）
- [x] 槽位抽取 + 短回答接续（能/不能/可以）— `orchestrator.ts`（核查，2026-10-27）
- [x] 匹配五态 + 0–100 可解释分 + 证据包 — `match.ts`（核查，2026-10-27）
- [x] 薪资三段（上限比较）+ 5%/10% 阈值 + 期望/底线分离 — `match.ts`（核查，2026-10-27）
- [x] 硬约束 vs 可谈项：只有用户自己提的硬约束违反才推卡 — `match.ts`（核查，2026-10-27）
- [x] 待确认问题挡住发表；硬门槛优先于薪资；健康证不占回合 — `match.ts` / `orchestrator.ts`（核查，2026-10-27）
- [x] 跨岗位沿用旧约束并点明一句 — `orchestrator.ts`（核查，2026-10-27）
- [x] 改口检测 + trace；回复按新数字重算 — `orchestrator.ts`（核查，2026-10-27）
- [x] **槽位时效**：fresh/stale/expired；简历按 `updatedAt` 计时；过期视为未知并重问；引用旧信息带时间前缀 — `slots.ts`（实现，2026-10-27）
- [x] **诉求作用域**：`person` / `subject`；A 岗位“能接受班次”不带到 B，“只能白班”仍是人的硬约束 — `types.ts` / `match.ts`（实现，2026-10-27）
- [x] **标签归一化代码层**：canonical + 否定优先 + 置信度分流（≥0.95 才硬判） — `tags.ts`（实现，2026-10-27）

### RAG

- [x] 27 条政策语料，按“一个可独立回答的问题”切分 — `lib/rag/corpus.ts`（实现，2026-10-27）
- [x] 查询重写（口语→规范词、否定/同义词）— `retrieve.ts`（实现，2026-10-27）
- [x] BM25 + 本地哈希向量 + top20 召回 + RRF + rerank — `retrieve.ts`（实现，2026-10-27）
- [x] 阈值拒答（0.34）+ 措辞接地校验 — `retrieve.ts` / `grounding.ts`（实现，2026-10-27）
- [x] 只对政策问题检索；结构化能答的不走向量 — `tools.ts`（实现，2026-10-27）
- [x] RAG 接入对话：体检费/夫妻房/压工资能答；天气问题拒答 — `orchestrator.ts`（实现，2026-10-27）
- [x] RAG 评测：30 正 + 8 负，Recall@5 1.0、MRR 0.928、拒答 1.0、误拒 0；四模式消融 — `rag-check.ps1`（实现，2026-10-27）

### 推荐 / 前端

- [x] 推荐五段管线：过滤 → 打分 → 多样性 → 解释 → 一致性断言 — `recommend.ts`（核查，2026-10-27）
- [x] 区级通勤矩阵；三档标签不报精确分钟 — `match.ts`（核查，2026-10-27）
- [x] Playground 四栏 + 服务视角抽屉（request/response/trace）— `app/page.tsx`（核查，2026-10-27）
- [x] **审批 UI**：右上角 `auto / 采集表需审批` 切换；审批卡显示摘要/原因/草稿；通过/改一句/驳回 — `app/page.tsx`（实现，2026-10-27）
- [x] 状态与卡片展示：`PENDING_APPROVAL` / `TRANSFERRED` / 平台来源 / 归属顾问 — `app/page.tsx`（实现，2026-10-27）
- [x] trace 展示 `tool` / `rag` / `approval` / `compose` 节点 — `page.tsx`（实现，2026-10-27）

### 评测与文档

- [x] 23 条回归 case（5 条需模型）— `lib/eval/cases.ts`（实现，2026-10-27）
- [x] pass@k：`-Runs 3` 多数票 + `flaky` 统计 — `stats.ts` / `eval.ps1`（实现，2026-10-27）
- [x] McNemar 精确检验 + case 级 fixed/broken + 基线文件 — `stats.ts` / `eval/run`（实现，2026-10-27）
- [x] 分维度指标（flow/matching/memory/extraction/intent/compliance/recommend/rag）— `dimensions.ts`（实现，2026-10-27）
- [x] L0 单元检查 33 条 + RAG 消融 38 条 — `unit-check.ps1`（实现，2026-10-27）
- [x] 冒烟 / 合并 / 健壮性 / 审批 / RAG / 单元六套脚本 — `scripts/`（实现，2026-10-27）
- [x] README 能力表与实测数字对齐；任务清单独立成文 — `README.md` / `TODO.md`（实现，2026-10-27）
- [x] 建表 SQL 补 `approvals` / `policy_chunks`；审批与 RAG 有表可落 — `docs/schema.sql`（实现，2026-10-27）
- [x] **agent 执行约定**：新增 `AGENTS.md`，开工必读 TODO；完成的定义包含「更新 TODO/README/schema」，并给验证命令与文档同步矩阵 — `AGENTS.md`（实现，2026-10-27）
- [x] **TODO 自检脚本**：完成项必须带日期、待做项必须带验收标准、快照计数与真实条目一致、AGENTS 与 TODO 互相引用 — `scripts/todo-check.ps1`（实现，2026-10-27）

---

## 明确不做

- [-] **OCR 识别健康证/身份证** — 猜错证件类型会出事；降级话术足够。
- [-] **语音转文字** — 同上，且成本高；给“打字发我”的替代动作。
- [-] **表单发出后的催填 / 排期 / 改约** — 流程边界到“采集表发出”为止。
- [-] **主动触达（用户沉默后跟进）** — IM 里是打扰，属于后置流程。
- [-] **shadow 模式** — 那是“调了不用”，由调用方控制，不是 agent 的运行时模式。
- [-] **全局审批开关** — 按动作配策略，不按服务分级。
- [-] **跨经纪人自动转交会话** — 归属是平台/业务逻辑；只带上下文，不替人做主。
- [-] **向量记忆库** — 招聘记忆是结构化事实，按 `candidateId` 直取；语义检索是过度设计。
- [-] **multi-agent** — 流程有状态，多 agent 只会让责任边界变糊。
- [-] **医疗 / 法律建议；承诺薪资/录取；歧视性表述** — 内容红线。

---

## 更新日志

### 2026-10-27 · 文档与协作约定

- 新增 `AGENTS.md`：开工先读 TODO；完成的定义强制包含 TODO/README/schema 同步；写明验证命令、硬约束、文档同步矩阵。
- 新增 `scripts/todo-check.ps1`：校验完成项日期、待做项验收标准、快照计数与真实条目一致。
- TODO 计数更新为：已完成 53 · 待做 15（P0 4 / P1 6 / P2 5）· 明确不做 10。

### 2026-10-27 · 第一轮完善

- 核查：23 条回归、6 套脚本、构建、四栏 Playground。
- 实现：审批中断/恢复、RAG 全链路、pass@k/McNemar/基线、槽位时效、诉求作用域、标签归一代码层、L0 单元检查。
- 修复：跨平台卡片 id 串平台；用户换微信被硬拒（改为转出 + 交接摘要）；formId 非确定性；连续非文本未升级。
- 结果：回归 23/23（×3 无 flaky、无 degraded）；L0 33/33；RAG Recall@5 1.0 / 拒答 1.0；`pnpm build` 通过。
- 新增文档：本文件；README 的“还没做”改为指向这里。

### 2026-10-27 之前

- W0 骨架：契约、快照、幂等、合并、匹配五态、措辞层、fixtures、初始回归集与建表 SQL。
