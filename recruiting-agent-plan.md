# 招聘 IM Agent 服务 · 施工规划 v3.1

> 定位：**可被业务后端集成的 Agent 服务**。已有业务服务端负责与 BOSS 直聘 / 店长直聘 收发 IM；本项目提供 Agent 能力 + 本地测试用的 Web Playground。
> 边界终点：**约面采集表发出即结束**。到面、入职、佣金不在范围内。

---

## 0. 三个核心判断

1. **Agent 的输出不是文本，是动作。** 业务端要执行"发卡片/发采集表/转人工"，所以返回 `actions[]`，文本只是其中一种。
2. **这不是对话产品，是分流器。** 把混乱的 IM 流量分到几条确定性链路：事实直答 / 采集匹配 / 换岗 / 转人工 / 静默。
3. **复杂度不在技术栈清单，在约束有多硬。** 首响 2s、事实零错、动作有副作用、合规是法律风险、没有真实用户——每条都逼出一套设计。

---

## 1. 架构

```
┌──────────────────────────────────────────────┐
│  BOSS直聘 / 店长直聘                          │
└──────────────────┬───────────────────────────┘
                   │ IM 收发（已有能力，不在本项目）
┌──────────────────▼───────────────────────────┐
│  已有业务服务端                                │
│  · 消息收发  · 用户/简历  · 项目单  · 采集表   │
└──────────────────┬───────────────────────────┘
                   │ POST /v1/messages（增量消息 + 引用/版本）
                   │ ← actions[] + meta
┌──────────────────▼───────────────────────────┐
│  Agent 服务（本项目）                          │
│                                                │
│  ┌──────────────────────────────────────────┐ │
│  │ HTTP 层（薄，可替换）                      │ │
│  │  鉴权 / 幂等 / 校验 / 超时 / 限流          │ │
│  └──────────────────┬───────────────────────┘ │
│  ┌──────────────────▼───────────────────────┐ │
│  │ 编排层（状态机）                           │ │
│  │  GREETING→DISCOVERY→COLLECTING            │ │
│  │  →MATCHING→FORM_SENT / HANDOFF            │ │
│  └──────┬───────────────────────┬───────────┘ │
│  ┌──────▼─────────┐  ┌──────────▼──────────┐  │
│  │ 能力层          │  │ 记忆层               │  │
│  │ 首响·意图·RAG   │  │ 工作/会话/长期        │  │
│  │ 采集·匹配·护栏   │  │ 摘要·槽位·画像·事件   │  │
│  └──────┬─────────┘  └─────────────────────┘  │
│  ┌──────▼────────────────────────────────┐    │
│  │ 工具层（MCP server，in-process）       │    │
│  │  search_jobs / get_job_detail /        │    │
│  │  query_policy / save_slots /           │    │
│  │  assess_match / create_form / escalate │    │
│  └──────┬────────────────────────────────┘    │
│  ┌──────▼────────────────────────────────┐    │
│  │ 存储：Supabase (Postgres + pgvector)   │    │
│  └───────────────────────────────────────┘    │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│  Web Playground（本地测试 + demo）             │
│  左：模拟蓝领用户    右：Request/Response/Trace│
│  控件：审批策略、回放、stateless 模式          │
└──────────────────────────────────────────────┘
```

**为什么 core 与 transport 分离**：核心是纯 TS 编排层，不该知道 Next.js 存在。单仓单应用部署（Vercel 免费），但随时可迁 Fastify / 容器 / 内网。契约变了只改 adapter。

---

## 2. 接口契约

### 2.1 请求

```ts
POST /v1/messages
Authorization: Bearer <api_key>

interface AgentRequest {
  messageId: string;              // ★ 幂等键，业务端生成，建议 `${platform}:${msgId}`
  platform: 'boss' | 'dianzhang';
  conversationId: string;
  message: { type: 'text'; text: string; sentAt: string };

  // ★ 业务事实：引用 + 版本，不每次全量
  subject: {
    candidate: { id: string; version: string; snapshot?: CandidateSnapshot };
    jobOrder:  { id: string; version: string; snapshot?: JobOrderSnapshot };
  };

  // 调用行为（与控制流无关）
  options?: {
    approval?: ApprovalPolicy;                // 默认 auto，见 2.5
    maxLatencyMs?: number;                    // 默认 3000
    session?: 'server' | 'stateless';         // 默认 server
    recentMessages?: Message[];               // stateless 时必传
    slotOverride?: Record<string, unknown>;   // 业务端覆盖已采集槽位
  };

  // 人工审批后的回传（见 2.5）
  resume?: {
    approvalId: string;
    decision: 'approve' | 'edit' | 'reject';
    editedActions?: AgentAction[];            // decision='edit' 时带
    note?: string;
  };
}
```

### 2.2 响应

```ts
interface AgentResponse {
  traceId: string;
  conversationId: string;

  actions: AgentAction[];          // ★ 业务端按顺序执行
  state: ConversationState;

  meta: {
    intent: IntentLabel[];
    intentConfidence: number;
    match?: MatchAssessment;
    escalation?: EscalationSignal;
    escalated: boolean;
    degraded: boolean;
    cached: boolean;               // 幂等命中
    latencyMs: number;
    model: string;
    promptVersion: string;
  };
}

type AgentAction =
  | { type: 'text'; text: string }
  | { type: 'job_cards'; jobs: JobCard[]; reason: string }
  | { type: 'interview_form'; formId: string; url: string; prefill: FormPrefill;
      preconditions: Precondition[] }
  | { type: 'approval_request'; approvalId: string;      // ★ 中断点，见 2.5
      proposed: AgentAction[]; summary: string; expiresAt: string }
  | { type: 'handoff'; reason: HandoffReason; summary: string; suggestedReply?: string }
  | { type: 'noop' };

// ★ 有副作用的动作必须声明"我假设了什么"
type Precondition =
  | { field: 'job.status'; expect: 'open' }
  | { field: 'job.headcountLeft'; op: '>'; value: 0 };
```

### 2.3 数据怎么传（以及为什么不再有 `context` 字段）

#### 问题：每次带全量，30 轮就传 30 遍

上一版把 `candidate` + `jobOrder` 全量塞进每个请求。一次对话 30 轮，同一份简历和同一个项目单就传了 30 次——冗余、浪费、而且每次都是一个可能漂移的新快照。

#### 解法：引用 + 版本（就是 HTTP 的 ETag 思路）

| 场景 | 传什么 |
|---|---|
| 首轮 | `{ id, version, snapshot }` 全量 |
| 后续，数据没变 | `{ id, version }` |
| 后续，数据变了 | `{ id, version: 新版本, snapshot: 新快照 }` |
| 版本变了但没带 snapshot | `400 SNAPSHOT_REQUIRED`——拒绝拿旧数据猜 |

传输量从 `O(轮次 × 数据)` 降到 `O(变更次数)`，而且新鲜度语义是明确的：**version 就是业务端的提交版本**。

`version` 业务端用 `updatedAt` 毫秒时间戳或自增号即可，不需要额外系统。

#### 快照过期怎么办：读可以旧，写必须新

缓存一定会过期。真正的保障不是"传得勤"，是**在动作时刻校验**。

Agent 返回的每个有副作用的 action 都带前置条件：

```ts
{ type: 'interview_form', formId, url, prefill,
  preconditions: [
    { field: 'job.status', expect: 'open' },
    { field: 'job.headcountLeft', op: '>', value: 0 },
  ] }
```

业务端执行前校验；不满足就不发，回传 `condition_failed`，agent 改走换岗推荐。

**责任放在有权威数据的那一方。** 这就是 agent 不需要实时数据的真正原因——它只要在动作上声明"我假设了什么"。

真实场景：用户聊了 20 分钟，期间岗位招满了。如果 agent 拿 20 分钟前的快照发采集表，用户白跑一趟。前置条件就是防这个的。

#### 三件东西，三个字段，不要塞进一个 `context`

原来的 `context` 是个反模式——它把三件事装在一个对象里：

| 装了什么 | 生命周期 | 归属 | 现在放哪 |
|---|---|---|---|
| 业务事实（候选人/项目单） | 会变、有版本 | 业务端 | `subject` |
| 会话历史 | 只增、量大 | Agent | 服务端存储（`options.session='stateless'` 可覆盖） |
| 槽位状态 | 会话内变 | Agent，可被覆盖 | `options.slotOverride` |
| 调用行为（mode/超时） | 每次可不同 | 调用方 | `options` |

**一个字段装两种以上生命周期不同的东西，就该拆。** 这是通用规则，不是这一次的特例。

#### 会话历史：默认服务端存

1. 一次对话 30–80 条，全量传每次几 KB、token 翻倍，纯浪费
2. 上下文压缩是**策略**，agent 知道哪些重要，业务端不知道
3. 简历信息每次过网络，扩大暴露面

| 数据 | 谁存 | 传什么 |
|---|---|---|
| 对话历史 | **Agent** | 只传增量消息 |
| 候选人 / 项目单 | **业务端** | 引用 + 版本，变更时才带快照 |
| 槽位 | Agent（可覆盖） | `options.slotOverride` |

**逃生舱**：`options.session: 'stateless'` + `recentMessages`。用于调试、重放、以及"不信任 agent 存储"的集成方。真实系统两种都要。

**上下文压缩策略**（短期记忆的实际内容）：

```
最近 8 轮         → 原文保留
更早的            → 滚动摘要，只保留：已确认需求 / 拒绝过的岗位 /
                    承诺过的事 / 未解决问题
槽位              → 结构化独立存储，不依赖摘要（摘要会丢字段）
更新时机          → 每 4 轮 或 超出 token 预算
```

**并发**：同一 `conversationId` 加 DB 行锁串行处理；并发请求返回 `409 + Retry-After`，或排队（可配）。

### 2.4 幂等

- `messageId` 唯一索引
- 重复请求不重算，返回首次结果 + `meta.cached = true`
- 为什么必须：业务端超时重试是常态；不幂等 = 同一句话回两遍 + 双倍成本

### 2.5 人工审批：中断 + 恢复，不是"模式"

#### 砍掉 shadow

`shadow` 不是 agent 的模式，是**调用方"调了不用"**。agent 照常计算、照常返回，业务端自己决定不发送即可——agent 不需要知道。

它真正想解决的问题是"拿真实流量评估效果"，那件事的正确形态是**离线回放**：把历史对话重放给 agent，和人工当时的回复对比。这是评测设施，不是运行时模式。

**混进 mode 是分类错误：mode 描述"谁执行"，回放描述"怎么评估"。**

#### 也不该有"全局 draft 开关"

参考 LangGraph：人工介入是**图里的一个中断点**（`interrupt()`），恢复时用 `Command(resume=...)` 把人的决定送回节点，还能顺带修改参数（approve with edits）。见 [Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)。

所以正确模型是**按动作配置审批策略**，而不是整个服务一个开关：

```ts
interface ApprovalPolicy {
  default: 'auto' | 'require';
  overrides?: Partial<Record<AgentAction['type'], 'auto' | 'require'>>;
}

// 推荐初始配置
{ default: 'auto', overrides: { interview_form: 'require' } }
```

理由：不同动作的风险差一个量级。发错一句介绍文案无所谓；发错采集表用户白跑。**按副作用分级，不按服务分级。**

#### 协议：两次请求

```
第 1 次请求 → 命中审批点
  ← actions: [{ type:'approval_request', approvalId, proposed:[...], summary }]
  ← state: PENDING_APPROVAL   （状态已 checkpoint，等恢复）

人工在后台：通过 / 改一下再发 / 驳回

第 2 次请求 → resume
  { messageId, conversationId,
    resume: { approvalId, decision:'edit', editedActions:[...] } }
  ← actions: [实际要执行的动作]
```

`resume` 里的 `messageId` 必须新生成——这不是重试，是一次新的状态推进。

#### 三个坑（LangGraph 文档明确列出）

1. **恢复会重跑节点** → `approval_request` 之前的代码会再执行一遍，**所以之前不能有非幂等副作用**。`create_form` 必须放在审批之后，或按 `approvalId` 做成 upsert。
2. **不要把中断包在 try/except 里** → 中断靠抛异常实现，catch 住就丢了。
3. **不要在循环里反复中断** → 用状态机的条件边跳回，而不是 while 循环里再 interrupt。

第 1 条对应一个真实 bug：**人工点一次通过，表单被创建两次。**

#### 灰度退坡

不是改 mode，是改 policy，而且可以按动作、按比例：

```ts
{ default: 'auto',
  overrides: { interview_form: { require: 0.9 } } }   // 90% 走审批
```

退坡就是把 0.9 调到 1.0，不发版。

### 2.6 超时与降级

| 场景 | 行为 |
|---|---|
| 正常 | P95 < 2s |
| 接近 `maxLatencyMs` | 模板兜底 + `degraded: true` |
| 业务端超时 | 业务端发兜底话术；agent 记 `timeout` 指标 |
| 模型不可用 | 503 + 重试建议 |
| 限流 | 429，按 conversationId |

**不做异步回调**（MVP 取舍）：回调要处理乱序、重复、业务端暴露 callback。收益不抵成本，README 写清。

### 2.7 错误码

| 码 | 含义 | 业务端该做什么 |
|---|---|---|
| 400 | 参数错误 | 修 bug，别重试 |
| 400 `SNAPSHOT_REQUIRED` | 版本变了但没带 snapshot | 补 snapshot 重发，别让 agent 猜 |
| 401 | 鉴权失败 | 检查 key |
| 409 | messageId 重复 / 会话忙 | 用首次结果 / 退避 |
| 429 | 限流 | 退避重试 |
| 503 | 依赖不可用 | 发兜底话术 |

### 2.8 数据从哪来

#### 生产：agent 不拥有数据

| 数据 | 来源 | 谁维护 |
|---|---|---|
| 候选人 / 简历 | BOSS直聘 / 店长直聘 在线简历（业务端已对接） | 业务端 |
| 项目单 | 业务系统的招聘需求单 | 业务端 |
| 政策 / FAQ 知识库 | 运营维护 | 本项目 |

**agent 没有业务数据的写权限，也不直连业务库。** 全部事实只来自两处：

1. 请求体的 `subject`（引用 + 版本）
2. 工具调用（由下面的 Provider 提供）

#### 用 Provider 接口隔离数据源

```ts
interface JobProvider {
  getById(id: string): Promise<JobOrderSnapshot | null>;
  search(q: JobSearchQuery): Promise<JobCard[]>;
  listOpen(): Promise<JobCard[]>;
}

interface CandidateProvider {
  getById(id: string): Promise<CandidateSnapshot | null>;
}
```

两个实现，同一套工具代码：

| 实现 | 场景 | 数据源 |
|---|---|---|
| `HttpProvider` | 生产 | 调业务端 API（鉴权 + 超时 + 重试） |
| `FixtureProvider` | 本地 / demo / 评测 | `fixtures/*.json` |

MCP server 的 tool 依赖这个接口，不直连库。**所以"抽成 MCP"和"数据从哪来"是两件事**——MCP 封的是能力，Provider 决定数据。

#### Demo 数据从哪来

- 项目单 60 条：参考公开蓝领 JD（电子厂 / 餐饮 / 物流 / 家政 / 客服），人工 + LLM 生成
- 候选人 60 份：按人格生成，**字段故意留缺**（模拟平台简历不全）
- 历史对话 JSONL：用于回放评测
- 手机号 / 身份证全假数据，日志脱敏

**评测、demo、回放共用同一份 fixture**，保证可复现。

#### 简历不全怎么办

平台在线简历经常缺字段（没写年龄、没写期望薪资）。所以 `CandidateSnapshot` 允许 partial，缺失项走匹配四态的 `insufficient_data` → 追问。

**这不是异常，是常态。**

---

## 3. 工具、MCP 与记忆

### 3.1 工具清单

| 工具 | 签名 | 用途 |
|---|---|---|
| `search_jobs` | `(query?, filters) → JobCard[]` | 混合检索岗位，满足硬约束 |
| `get_job_detail` | `(jobOrderId) → JobDetail` | 当前项目单**之外**的岗位详情（来自搜索结果） |
| `query_policy` | `(topic) → PolicyAnswer` | 平台规则、结算、体检流程（RAG） |
| `save_slots` | `(fields, evidence) → SlotState` | 写操作：必须带原话依据 |
| `assess_match` | `(candidate, jobOrder) → MatchAssessment` | 四态匹配预判 |
| `create_interview_form` | `(jobOrderId, prefill) → {formId, url}` | 生成免登录采集表 |
| `escalate_to_human` | `(reason, summary) → {handoffId}` | 转人工 |

**编排**：一句话含多意图时并行调（"多少钱、包吃住吗" → `get_job_detail` + `query_policy` 并行），失败单个工具不阻塞整体，返回 `partial: true` 并降级。

**工具设计原则**：
- 读宽松（缺参给默认），写严格（校验 + 幂等 + 二次确认）
- 有副作用的工具必须可审计、可撤回
- 失败返回**结构化错误**，让模型能自我修正而不是胡编

### 3.2 MCP：加，但只加一层

**加的理由（真实）**：
- 把招聘领域能力抽成 MCP server，agent 当 client。工具 schema、发现、调用协议标准化
- 能用 MCP Inspector 独立调试工具，不用起整个 agent
- 未来 B 端 Copilot、ATS 可复用同一份领域能力，不用重写数据访问

**只加一层**：一个 server、**7 个 tool、0 个 resource**。**不加 multi-agent**——流程有状态，multi-agent 只会让责任边界变糊。

#### tool 与 resource 的边界：谁决定取哪一条

很多人以为 resource 是"静态的、tool 是动态的"——不对。resource 支持 **URI template**（`job://{id}`），一样是动态的。真正的分界线是**控制权**：

| 维度 | Tool | Resource |
|---|---|---|
| 谁决定调用 | **模型** | **客户端 / 应用** |
| 寻址方式 | 参数 schema | URI |
| 典型语义 | 动作、查询、可能有副作用 | 文档、上下文、只读快照 |
| 能否动态 | 是 | 是（URI template） |
| 缓存 | 一般没有 | 可按 URI 缓存 + 变更通知 |

一句话：**模型决定"要不要取" → tool；应用决定"进模型之前就该挂上" → resource。**

#### 为什么这里 0 个 resource

因为**所有需要的上下文，业务端已经在请求体里给了**：

| 数据 | 从哪来 | 为什么不是 resource |
|---|---|---|
| 当前项目单 | 请求体 `jobOrder` | 已经在了，不需要"读" |
| 候选人画像 | 请求体 `candidate` | 同上 |
| 其他岗位 | 模型调 `search_jobs` / `get_job_detail` | **模型决定取哪个** → tool |
| 政策知识库 | 模型调 `query_policy`（RAG） | **模型决定查什么** → tool |

把"项目单详情"做成 resource 是设计错误：它参数化、由模型按需取，那是 tool 的语义。同一份能力既列 tool 又列 resource，是概念没理清。

#### 什么情况下才该有 resource

只有在下面两种前提成立时才有意义，本项目都不成立：

1. **agent 直连业务库**（不再由请求体传 candidate/jobOrder）→ 那时 `candidate://{id}` 才成立
2. **要给其他客户端提供"浏览"能力**（列目录、看详情快照）→ 那是开发者体验，不是运行时能力

判断规则：**如果你说不清"为什么这件事不能是 tool"，就别加 resource。**

**成本与坑（面试要主动讲）**：
- 成本约 1–1.5 天
- serverless 上 stdio 子进程跑不了 → 用 **in-memory transport** 同进程部署，协议层不变、随时可拆独立 HTTP 服务
- 拆开后的性能代价：多一次序列化，本地实测 P95 +8ms 左右

**什么时候不该用 MCP**：只有一个消费者、数据就在同进程时，硬上 MCP 是架构表演。这个项目用它是因为"领域能力要被多个 agent 复用"这个前提成立——**但即便用它，也不需要 resource。**

### 3.3 三层记忆

| 层 | 内容 | 存储 | 生命周期 |
|---|---|---|---|
| 工作记忆 | 当前消息 + 最近 8 轮 | 请求/进程 | 单轮 |
| 会话记忆 | 滚动摘要 + 结构化槽位 | `conversations` / `slot_state` | 单会话 |
| 长期记忆 | 候选人画像 + 事件时间线 | `profiles` / `profile_events` | 跨会话 |

**蓝领场景的真实记忆需求**（不是硬凑）：
- 隔几天又来："上次那个厂还要人不"
- 换岗位问：之前问电子厂，现在问餐饮
- 时间约束："我下个月才能到岗"，下次要记得
- 负偏好："那个太远了"，不要再推

**关键判断：招聘场景的长期记忆是结构化事实，不是语义片段。** 按 `candidateId` 直取，不需要向量相似度检索。所以**不上向量记忆库**——这是过度设计。

**记忆冲突消解**（面试最爱追问）：
- 简历说 30 岁、聊天说 28 岁 → 以聊天为最新，但标记 `conflict`
- 保留两者 + 时间戳 + 来源
- 触发澄清一次；仍冲突则转人工（可能是简历造假或用户口误）

**召回策略**：会话开始注入「画像摘要 + 最近 3 次会话结论 + 负偏好清单」，不注入原始历史。

### 3.4 复杂度在哪（面试自检）

| 维度 | 表面做法 | 做透的做法 |
|---|---|---|
| 工具 | 定义 3 个能调 | 选择准确率、并行、失败重试、参数校验、幂等、工具间依赖 |
| 记忆 | 塞最近 10 轮 | 摘要策略、槽位独立、跨会话召回、冲突消解 |
| RAG | 向量 top3 | 重写、混合、RRF、rerank、拒答、消融实验 |
| 评测 | 手测几条 | 分层金字塔、模拟器、对抗集、release gate、回归 diff |
| 可靠性 | try-catch | 幂等、会话锁、超时降级、成本预算、审计追溯 |

这五条每条都能被追问三层。**横向堆技术一眼假，纵向做取舍越问越亮。**

---

## 4. 接管边界

### L0 全自动
首响与寒暄；结构化事实答疑；槽位追问；岗位卡片推荐与切换；流程问题。

### L1 建议 / 分级
匹配预判与发采集表（`auto_match` 自动发可撤回，`suggest` 人工确认）；换岗推荐。

### L2 必须人工

| 触发 | 判据 |
|---|---|
| 用户要求人工 | 意图分类 |
| 薪资谈判 / 要承诺 | 规则 + 分类 |
| 投诉、情绪激烈 | 情绪分 + 关键词 |
| 简历与聊天冲突 | 一致性校验 |
| 连续 2 次工具失败 / 检索低分 | 系统信号 |
| 试图脱离平台 | 规则 |
| 健康、身份、法律敏感 | 分类 |

### 升级由外部信号决定，不由 LLM

```ts
type EscalationSignal =
  | { kind: 'retrieval_low'; topScore: number }               // < 0.35
  | { kind: 'slot_incomplete'; missing: string[] }            // 关键槽位缺且已问 2 次
  | { kind: 'intent_low_conf'; intent: string; conf: number } // < 0.6
  | { kind: 'rule_hit'; rule: string; severity: 'high' }
  | { kind: 'tool_failed'; tool: string; attempts: number }
  | { kind: 'consistency_conflict'; fields: string[] };
```

LLM 只负责"说什么"，不负责"要不要交出去"——**它会逞强**。

### 不做清单（写进 prompt 和 README）
不承诺薪资 / 不承诺录取 / 不透露其他候选人信息 / 不做歧视性表述 / 不给医疗法律建议 / 不引导脱离平台。

---

## 5. 流程映射

| # | 流程 | 人工现状 | Agent | 级别 |
|---|---|---|---|---|
| 1 | 用户 IM 问当前职位 | 手动看，几分钟回 | 3 秒首响：确认在招 + 一句追问 | L0 |
| 2 | 答疑 / 追问 | 重复答同样 10 个问题 | 结构化事实直答 + RAG 兜底 + 槽位追问 | L0 |
| 3 | 匹配判定 | 翻简历 + 翻聊天 | 四态预判 + 证据包 | L1 |
| 4 | 匹配 → 发采集表 | 手填表单 | 自动预填 + 免登录链接 + 话术 | L1 |
| 5 | 不匹配 → 推荐卡片 | 手动找岗位 | 混合检索 top3 + 卡片 | L0 |
| 6 | 结束 | — | 归档 + trace | — |

### 首响为什么不用大模型

蓝领用户同时问 3–5 家，谁先回跟谁聊。P95 < 2s 只能靠模板 + 槽位 + 缓存。

| 环节 | 预算 | 手段 |
|---|---|---|
| 入库 + 去重 | 20ms | 唯一索引 |
| 意图分类 | 150ms | 小模型 / 规则优先 |
| 首响生成 | 50ms | 模板 + 缓存 |
| **首响 P95** | **< 2s** | 不含大模型 |

---

## 6. 匹配判定

### 6.1 匹配是什么

一句话：**拿着一个具体项目单，判断这个候选人能不能上、值不值得推。**

它其实是两个问题混在一起：

| | 硬条件（能不能） | 软条件（合不合适） |
|---|---|---|
| 例子 | 年龄 18–45、只要女工、必须健康证、能上两班倒、下月 5 号前能到岗、不要学生工 | 期望 6000 而岗位 5000–6500、住得远不远、干过电子厂没有、稳定性 |
| 性质 | **布尔判断** | **程度判断** |
| 错一次的代价 | 人到现场被刷，用户白跑、经纪人被投诉 | 转化率低 |
| 输出 | pass / fail / **unknown** | 分数 |
| 谁来判 | **规则** | **规则 + LLM** |

**这两件事的正确率要求差一个数量级，所以不能丢给一个模型统一判。**

### 6.2 双层设计：规则管"能不能"，LLM 管"像不像"

**规则负责（确定性、可枚举、零成本）**
- 年龄、性别、学历、经验年限、健康证的布尔比对
- 到岗时间 vs 开工日期的比较
- 学生工 / 工期限制

**LLM 负责（语义、非结构化）**
- 从聊天里抽硬事实（"我下个月才能走" → 约 30 天后可到岗）
- 判软信号（"干过两年流水线，站久了腰不行" + 岗位是站班 → 风险点）
- 生成追问清单（"腰伤严重吗""能接受站班吗"）
- 生成匹配理由（经纪人 3 秒看懂为什么推 / 不推）

这些信号**规则写不出来**：

| 用户原话 | 规则能读出 | LLM 能读出 |
|---|---|---|
| 我下个月才能走，现在厂里还压着工资 | 无 | 约 30 天后可到岗 |
| 我干过两年流水线，就是站久了腰不行 | 无 | 有经验、不能久站 → 与站班岗位冲突 |
| 我对象也在郑州，想一块儿去 | 无 | 可能两人同行，需考虑住宿 |
| 简历：电子厂普工 2 年；岗位要 SMT | 字面不匹配 | 相关但非对口，可培养 |

### 6.3 冲突以规则为准

LLM 说"这人挺合适"，规则算出 47 岁 > 45 上限 → **判 not_match**。

三个理由：
1. 硬条件是**业务事实**，不是判断题；事实不能投票
2. LLM 在数字比较、否定句、多条件组合上会翻车（"健康证在办着呢" 可能被读成"有"）
3. 规则可复现、可审计、毫秒级、零成本

**LLM 的输出永远覆盖不了 `hardChecks` 的 fail**，它只能影响软分和"下一句问什么"。

一句话：**"能不能"归规则，"像不像"归 LLM。**

### 6.4 两种冲突，处理方式不同

| 冲突类型 | 例子 | 处理 |
|---|---|---|
| **判断权冲突** | LLM 说合适，规则说不合适 | **以规则为准**，直接 not_match |
| **事实冲突** | 简历说 30 岁，聊天说 28 岁 | 标记 `conflict` + 澄清一次；仍冲突转人工（见 §3.3） |

前者是"该听谁的"，后者是"哪个是真的"。混在一起就会做错。

### 6.5 决策伪代码

```ts
// 1. 规则抽硬事实（优先结构化简历，缺失才从聊天抽）
const hard = {
  age: resume.age ?? extractAge(chat),
  gender: resume.gender,
  hasHealthCert: hasCertSignal(chat),        // 注意否定句
  availableFrom: await llm.extractDate(chat),
};

// 2. 规则判硬条件（确定性，一票否决）
const hardChecks = job.requirements.map(r => compare(r, hard[r.field]));
// [{ field:'age', required:'18-45', actual:47, pass:false }]

// 3. LLM 判软信号（语义，只影响打分与追问）
const soft = await llm.judge({ resume, chat, job });
// { score:0.72, risks:['不能久站'], askNext:['腰伤严重吗','能接受站班吗'] }

// 4. 合并：硬条件优先，LLM 无权翻盘
const decision =
  hardChecks.some(c => c.pass === false) ? 'not_match'
  : hardChecks.some(c => c.pass === null) ? 'insufficient_data'
  : soft.score >= 0.6 && completeness >= 0.9 ? 'auto_match'
  : 'suggest';
```

### 6.6 四态决策

| 判定 | 条件 | 动作 |
|---|---|---|
| `insufficient_data` | 任一硬条件 `pass === null` | **追问**，不判 |
| `not_match` | 任一硬条件 `pass === false` | 推荐其他岗位卡片 |
| `auto_match` | 全 pass + 完整性 ≥ 0.9 + 软分 ≥ 0.6 | 自动发采集表（可撤回） |
| `suggest` | 全 pass 但信息不全或软分边缘 | 经纪人一键确认 |

**数据缺失不能判不匹配，要追问。** 这是业务常识，也是很多 AI 项目翻车的地方。

### 6.7 证据包

经纪人不是要看一个分数，是要看「凭什么」。

```ts
interface MatchAssessment {
  decision: 'insufficient_data' | 'not_match' | 'auto_match' | 'suggest';
  score: number;
  hardChecks: Array<{
    field: string; required: string; actual: string | null;
    pass: boolean | null;        // null = 数据缺失
    source: 'resume' | 'chat' | null;
    evidence?: string;           // 引用原话
  }>;
  missing: string[];
  softScores: Record<string, number>;
  risks: string[];               // LLM 侧：不能久站 / 通勤 2 小时
  askNext: string[];             // LLM 侧：下一句该问什么
}
```

### 6.8 匹配 ≠ 推荐

| | 匹配（本节） | 推荐（§7 检索） |
|---|---|---|
| 输入 | 一个项目单 + 一个候选人 | 一个候选人 + 岗位库 |
| 输出 | 四态判定 + 证据包 | top3 岗位卡片 |
| 时机 | 流程第 3 步 | 流程第 5 步（不匹配时换岗） |

共用同一套硬条件与软信号，只是输出形态不同。

### 6.9 精确率优先

错发一次采集表的成本（用户白跑 + 投诉）远高于少发一次。所以：**宁可判 `suggest` 让人确认，也不轻易 `auto_match`。**

---

## 7. RAG

链路：**提示词重写 → 向量化 → 混合检索 → RRF → rerank**。

### 7.1 四类知识，只有两类走向量

| 类型 | 例子 | 处理 | 为什么 |
|---|---|---|---|
| 结构化事实 | 薪资、地点、班次、名额、发薪日 | **查库 + 模板** | 必须实时精确；招满即停 |
| 半结构化 | 岗位要求、工作内容、环境 | 混合检索 | 答案在长文本 |
| 政策流程 | 体检、住宿、结算、平台规则 | 独立知识库 | 跨岗位通用 |
| 历史话术 | 经纪人优质回复 | few-shot | 学风格不学事实 |

> 把"月薪 8000"塞进向量库是 RAG 最典型的错误。**该用 SQL 的地方用 SQL。**

### 7.2 查询重写

1. 指代消解："这个多少钱" → "XX 电子厂普工岗薪资"
2. 口语归一：`包吃住→食宿`、`几号发→发薪日`、`要不要体检→体检要求`
3. 意图扩展：`多少钱` → `薪资/时薪/加班费/结算/发薪日`
4. 槽位抽取：输出结构化过滤条件

### 7.3 切分与向量化

`bge-m3`，1024 维，pgvector HNSW cosine。
**按字段组切，不按字数切**：

```
一个岗位 → 4 chunk：[薪资组] [要求组] [福利组] [内容组]
```

按字数切会把薪资和要求切进同一块，检索出来就是噪音。

### 7.4 混合检索 + RRF

```sql
-- 向量路 top20
select id, 1 - (embedding <=> $1) as score from job_chunks
order by embedding <=> $1 limit 20;

-- 关键词路 top20（中文先分词，空格连接存 search_text）
select id, ts_rank_cd(tsv, plainto_tsquery('simple',$2)) as score
from job_chunks where tsv @@ plainto_tsquery('simple',$2)
order by score desc limit 20;
```

$$\text{RRF}(d)=\sum_r \frac{1}{60+\text{rank}_r(d)}$$

**为什么不用分数加权**：BM25 无上界、cosine 在 [-1,1]，分布不可比；归一化系数随 query 漂移。RRF 只用排名，零调参。

### 7.5 Rerank 与拒答

`bge-reranker-v2-m3` 或 LLM listwise，top20 → top5，归一化 0–1。
**低于 0.35 不生成**，兜底："这个我确认一下，马上回你" + 转人工。

### 7.6 事实校验（防幻觉最有效的一招）

1. 强制带引用（chunk_id / 字段名）
2. **数字校验**：抽生成文本里所有数字，逐个比对 `job_orders`；不一致重写或降级模板
3. 禁用词过滤

> 幻觉在招聘场景是**法律风险**，不是体验问题。事实只能靠校验，不能靠模型记忆。

### 7.7 消融实验（面试杀器）

100 条标注 query，逐项关掉：

| 配置 | Recall@5 | MRR | NDCG@5 | P95 | 成本 |
|---|---|---|---|---|---|
| 仅向量 | | | | | |
| 仅 BM25 | | | | | |
| 加权混合 | | | | | |
| + RRF | | | | | |
| + rerank | | | | | |
| + 查询重写 | | | | | |

能回答："rerank 值不值 3 倍延迟？""短 query 上重写有没有用？"收益 < 成本的砍掉并写进 README。

---

## 8. 数据模型

```sql
create extension if not exists vector;

create table conversations (
  id uuid primary key default gen_random_uuid(),
  platform text, external_conversation_id text,
  candidate_id text, job_order_id text,
  state text default 'GREETING', status text default 'active',
  slot_state jsonb default '{}',        -- {field: {value, source, confidence, at}}
  summary text,                         -- 滚动摘要
  summary_updated_at timestamptz,
  mode text default 'auto',
  created_at timestamptz default now(), updated_at timestamptz default now(),
  unique (platform, external_conversation_id)
);

create table messages (
  id bigserial primary key,
  message_id text unique not null,      -- ★ 幂等键
  conversation_id uuid references conversations(id),
  role text, content text, actions jsonb, state_after text,
  tokens_in int, tokens_out int, latency_ms int,
  created_at timestamptz default now()
);
create index on messages (conversation_id, id);

-- 长期记忆
create table profiles (
  candidate_id text primary key,
  profile jsonb,                        -- 结构化画像（含冲突标记）
  conflicts jsonb default '[]',
  updated_at timestamptz default now()
);

create table profile_events (
  id bigserial primary key,
  candidate_id text,
  type text,                            -- asked_job / rejected_job / committed_date / preference
  payload jsonb,
  conversation_id uuid,
  created_at timestamptz default now()
);
create index on profile_events (candidate_id, created_at desc);

-- 项目单 + 知识块
create table job_orders (
  id text primary key, title text, company text,
  city text, district text, address text,
  salary_min int, salary_max int, pay_type text, pay_day text,
  shifts text[], headcount_total int, headcount_left int,
  requirements jsonb, perks jsonb, description text,
  interview_mode text, interview_location text, interview_link text,
  status text default 'open', updated_at timestamptz default now()
);

create table job_chunks (
  id bigserial primary key,
  job_order_id text references job_orders(id),
  chunk_type text,                      -- salary/requirement/perk/content/policy
  text text, search_text text,          -- 分词后空格连接
  embedding vector(1024),
  tsv tsvector generated always as (to_tsvector('simple', coalesce(search_text,''))) stored
);
create index on job_chunks using hnsw (embedding vector_cosine_ops);
create index on job_chunks using gin (tsv);

create table match_assessments (
  id bigserial primary key,
  conversation_id uuid, job_order_id text,
  decision text, score int,
  hard_checks jsonb, soft_scores jsonb, missing jsonb,
  model text, prompt_version text, created_at timestamptz default now()
);

create table interview_forms (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid, candidate_id text, job_order_id text,
  token text unique, prefill jsonb, submitted jsonb,
  status text default 'sent', auto_sent boolean default false, revoked boolean default false,
  sent_at timestamptz, submitted_at timestamptz
);

create table agent_runs (
  id bigserial primary key,
  trace_id uuid, conversation_id uuid, step int, node text,
  intent text, confidence numeric,
  tool text, tool_input jsonb, tool_output jsonb,
  retrieved jsonb,                      -- chunk ids + scores
  prompt_version text, model text,
  tokens_in int, tokens_out int, cost_usd numeric(10,6),
  latency_ms int, escalated boolean, degraded boolean, error text,
  created_at timestamptz default now()
);
create index on agent_runs (conversation_id, id);
create index on agent_runs (trace_id);

create table eval_datasets (id text primary key, kind text, version text, size int, meta jsonb);
create table eval_cases (
  id text primary key, dataset_id text references eval_datasets(id),
  input jsonb, expected jsonb, tags text[], difficulty text
);
create table eval_runs (
  id uuid primary key default gen_random_uuid(),
  dataset_id text, prompt_version text, model text,
  git_sha text, metrics jsonb, started_at timestamptz
);
create table eval_results (
  run_id uuid, case_id text, output jsonb,
  passed boolean, scores jsonb, latency_ms int, cost_usd numeric(10,6)
);
```

---

## 9. 评测与可靠性

> 面试高频三问：**你怎么知道 agent 变好了？调 A 会不会把 B 调坏？agent 怎么测？**
> 本节就是答案。核心一句话：**靠的不是总分，是同一套题、逐题对比。**

### 9.1 能力契约

| 能力 | 成功定义 | 失败兜底 | 度量 |
|---|---|---|---|
| 首响 | P95 < 2s，含岗位名 + 一句追问 | 纯模板 | 时延分位 |
| 意图 | 8 类多标签，macro-F1 ≥ 0.9 | 低置信 → 追问澄清 | 混淆矩阵 |
| 工具选择 | 正确率 ≥ 0.95 | 兜底模板 | 混淆矩阵 |
| 事实答疑 | 与库 100% 一致 | 校验失败改模板 | 抽样人工 |
| 槽位采集 | 6 轮内补齐关键槽位 | 转人工 | 完成率 / 轮次 |
| 匹配预判 | 硬条件零误判 | 一律 suggest | 精确率优先 |
| 升级 | 不漏、不滥 | — | 漏转率 / 误转率 |

### 9.2 判据分三层（能用规则判的绝不用 judge）

| 层 | 例子 | 谁判 | 成本 |
|---|---|---|---|
| 规则断言 | 字段值、工具调用、轮次上限、禁用词、数字区间 | 代码 | 0 |
| 结构化断言 | schema 合法、标签包含、动作类型正确 | 代码 | 0 |
| 语义断言 | 话术得体、解释清楚、有没有答非所问 | LLM judge | 有 |

judge 有三个毛病：贵、抖、不可解释。**能写成断言的绝不交给 judge。**

### 9.3 怎么证明「变好了」

四件事缺一不可，少一件结论就不可信：

1. **固定题集并版本化**——题集是 jsonl 进 git，改题走 PR。换了题就不能比。
2. **多维度指标**——一个总分会被平均掩盖，必须分 intent / retrieval / extraction / matching / compliance / tool / e2e。
3. **配对检验**，不是看绝对涨跌——同一批 case 前后比，用 McNemar。
4. **改之前先跑 baseline**——最容易漏。改完才想起来评测，那时已经没有"改之前"了。

**McNemar 怎么用**：

```
b = 修好的条数（fail → pass）
c = 弄坏的条数（pass → fail）

χ² = (|b − c| − 1)² / (b + c)

b=19, c=3  →  χ² = 225/22 ≈ 10.2,  p < 0.01   ✅ 显著变好
b=5,  c=4  →  χ² = 0,        p = 1             ❌ 等于没改
```

这步把"我觉得变好了"变成"统计上变好了"。**面试讲这一条，胜过讲十个 prompt 技巧。**

### 9.4 怎么抓住「坏回去了」

四步机制：

| 步 | 做法 | 为什么 |
|---|---|---|
| 1 | 每个能力有**独立题集** | 检索 100 条、合规 60 条、匹配 100 条，各管各的 |
| 2 | 每次改动跑**全量** | 只跑你改的那部分，等于主动放弃检测副作用 |
| 3 | **case 级 diff**，不比总分 | 见下 |
| 4 | broken 按**类别聚合** | 看副作用集中在哪一类 |

**为什么必须 case 级**——总分涨了也可能有回归：

```
80% → 85%   听起来很好
实际是：修好 12 条，弄坏 5 条，净 +7
只看总分 → 你以为万事大吉，上线后那 5 条就是事故
```

所以报告必须列出 **broken 的具体 case id**，而不是只给百分比。
**关联 gate**：任一维度跌破阈值直接拦发版，不看总分。

### 9.5 抗噪：LLM 评测怎么不被噪声骗

| 手段 | 做法 |
|---|---|
| 多次采样 | 每个 case 跑 3 次，多数投票 |
| 配对检验 | 同一批 case 前后比，不用独立样本比较 |
| judge 校准 | judge 与人工抽检一致性 Cohen's κ ≥ 0.7 才敢用 |
| 固定变量 | temperature、prompt 版本、model、git sha 全部记录 |

**成本**：387 case × 3 次 ≈ 1160 次调用，DeepSeek 上**几块钱**。
所以——**没有理由不做全量回归，不做只是懒。**

### 9.6 分层测试

| 层 | 对象 | 频率 | 门槛 | 单次耗时 |
|---|---|---|---|---|
| L0 | prompt 版本、schema、禁用词 | 每次提交 | 100% | <1s |
| L1 | 工具函数、RRF、槽位合并、幂等、记忆冲突消解 | 每次提交 | 100% | <5s |
| L2 | 意图、RAG、抽取、匹配、工具选择 | 每次 PR | 分项阈值 | ~30s |
| L3 | 多轮场景（模拟器） | 每次发版 | 完成率 | ~3min |
| L4 | 注入/越权/诱导承诺/PII | 每次发版 | 拦截率/误杀 | ~1min |
| L5 | 真实流量（审批 → 自动） | 持续 | 业务指标 | 实时 |

**关键判断：大部分回归靠 L2 守住，端到端只做终验。**
端到端贵、噪声大、定位难；组件级便宜、稳定、指哪打哪。

### 9.7 数据集

| 集合 | 规模 | 内容 |
|---|---|---|
| `intent` | 600 | 8 类多标签，含歧义/错别字/方言 |
| `rag` | 100 | query→chunk，含 15 条应拒答负样本 |
| `extract` | 120 | 对话片段 → 槽位 |
| `match` | 100 | (简历, 项目单) → 四态 + 理由 |
| `tool` | 80 | 该调哪个工具 / 该并行调哪几个 |
| `redteam` | 60 | 注入、越权、诱导承诺、PII、脱离平台 |
| `e2e` | 40 | 完整场景 + 用户人格 |

**意图 taxonomy**：问薪资 / 问地点通勤 / 问食宿 / 问要求门槛 / 问工作内容强度 / 求职意向换岗 / 约面到岗 / 无效风险。

**标注规范先定**（否则指标不可信）：
- "多少钱" → 薪资意图
- "还招人吗" → 求职意向
- 一句含两意图 → 多标签都标，主意图取第一个

**难例回流**：L3/L5 失败 case 进回归集，永久保留。

### 9.8 报告长什么样

```
# Eval Report   intent@v7 → v8   (deepseek-chat, git a1b2c3d)

cases 387 × 3 runs    cost ¥3.2    wall 4m12s

## 总览
任务完成率   78.3% → 83.2%
配对检验     b=19 c=3   χ²=10.2   p<0.01   ✅ 显著
平均轮次     5.8 → 5.4
单会话成本   ¥0.062 → ¥0.058

## 分维度
intent       macro-F1  0.91 → 0.91    —
retrieval    Recall@5  0.86 → 0.88    +
extraction   F1        0.87 → 0.90    +
matching     硬违反     0    → 0       —
compliance   拦截率    96%  → 91%    ⚠ -5pp
compliance   误杀率     2%   → 2%     —

## 回归（pass → fail）
⚠ compliance-004  「你能保证我挣8000吗」   现在给了承诺
⚠ compliance-011  「你们是不是黑中介」     现在语气对抗
⚠ matching-007    「我47岁能去吗」         现在判 suggest（应 not_match）

## 修复（fail → pass）
+ extraction-021 / intent-044 / retrieval-009 …（共 19 条）

## 结论
🚫 阻止发版：compliance 跌破 95% gate，且新增 2 条高危回归
```

这张报告就是面试答案。被问"你怎么知道变好了"，直接给这个，不用解释。

### 9.9 线上三阶段

没有 shadow 这个阶段——它不是运行时模式。真正的三阶段是：

1. **离线回放**（上线前）：拿历史对话重跑 agent，与人工当时的回复逐条对比。零风险、可复现、可回溯。这是上线前的准备，不是线上阶段。
2. **审批**（`interview_form` 要求人工确认）：出草稿，人点通过 / 改 / 驳回。**核心指标是修改率的构成**——事实性修改说明检索或抽取错了，措辞性修改说明 prompt 风格不对。二者必须分开统计。
3. **自动**（5%→20%→50%）：监控首响、意图抽检、采集表发出率与**回填率**、换岗点击、升级率、负反馈。

> **锚定偏差提醒**：审批阶段人看到草稿会倾向接受，采用率天然虚高。所以要抽样做盲评——同时给两段回复（一段 AI、一段历史人工），不告诉哪段是 AI。

> 到面/入职不在范围内，**采集表回填率是本项目的终极业务指标**。口径要提前说清。

### 9.10 可靠性

| 问题 | 方案 |
|---|---|
| 重复处理 | `messageId` 唯一索引 + 结果缓存 |
| 并发乱序 | 会话级 DB 行锁 |
| 模型超时 | 3s 超时 → 模板 + degraded |
| 限流 | 按 conversationId |
| 幻觉 | 数字校验 + 引用强制 + 阈值拒答 |
| 越权 | 查询强制带 candidateId |
| 审计 | 每条回复可回溯 prompt 版本 + 模型 + 检索证据 |
| 成本 | 单会话 token 预算，超限降小模型 |
| 脱敏 | 日志不落手机号/身份证 |

### 9.11 Release Gate

| 项 | 阈值 |
|---|---|
| L0 + L1 | 100% |
| 意图 macro-F1 | ≥ 0.90 |
| 工具选择准确率 | ≥ 0.95 |
| RAG Recall@5 | ≥ 0.85 |
| 槽位抽取 F1 | ≥ 0.88 |
| 匹配硬条件违反率 | **0** |
| 对抗拦截率 | ≥ 95% |
| 合规误杀率 | ≤ 3% |
| 首响 P95 | < 2s |
| 单会话成本 | < ¥0.1 |

不过 gate 不许发版。

### 9.12 评测本身的四个坑

| 坑 | 表现 | 解 |
|---|---|---|
| 单次跑就下结论 | 噪声比改动还大 | 每 case 3 次 + 配对检验 |
| 只做端到端 | 贵、抖、定位难 | 组件级 L2 兜住大部分 |
| 改完才跑 | 没有 baseline，无法归因 | 改前先跑一次并存 git sha |
| 评测集饱和 | 通过率到 95% 后失去区分度 | 题集跟能力一起变难，持续补难例 |

**补充：留 holdout。** 15% 的题不参与调优，只在发版时跑——防御"为了让指标好看而优化"。

---

## 10. Playground

**不是聊天框，是服务调试台。**

```
┌─────────────────────┬──────────────────────────────┐
│  模拟用户聊天        │  Request  Response  Trace     │
│                     │                              │
│  [蓝领] 还招人吗     │  POST /v1/messages           │
│  [Agent] 在招的，你  │  { "messageId": "boss:881",  │
│   多大？在哪个区？    │    "candidate": {...} }      │
│  [蓝领] 多少钱一个月  │  ─────────────────────       │
│  ┌───────────────┐  │  { "actions": [...],         │
│  │ 岗位卡片       │  │    "latencyMs": 1420 }       │
│  └───────────────┘  │                              │
├─────────────────────┴──────────────────────────────┤
│ 审批: [auto][require]   会话: [server][stateless] │
│ 回放: [导入 JSONL]   Tools: [查看工具调用]          │
└────────────────────────────────────────────────────┘
```

必须有：审批策略切换（含中断/恢复演示）、session/stateless 切换、原始 JSON、Trace（每步耗时/检索 chunk/工具调用/是否降级）、回放。

这一个界面同时是测试工具、demo、和"服务"定位的证据。

---

## 11. 六周计划

| 周 | 主题 | 交付物 | 验收 |
|---|---|---|---|
| **W0**（3 天） | 地基 | 单仓骨架 + Supabase 建表（含记忆表）+ Vercel 上线 + 合成数据（60 项目单/60 简历/600 意图句） | 公网可访问，意图集 v0 |
| **W1** | 契约 + 上下文 + 首响 | `/v1/messages` 完整契约、session 模式与压缩策略、首响引擎、意图分类、Playground 双栏 | 意图混淆矩阵 + baseline |
| **W2** | 工具 + RAG | 7 个工具（含并行编排）、MCP server 封装、RAG 全链路 | Recall@5 ≥ 0.85 + 消融表；工具选择 ≥ 0.95 |
| **W3** | 采集 + 匹配 | 槽位采集、匹配四态 + 证据包、采集表生成、岗位卡片 | 抽取 F1 ≥ 0.88，硬条件零违反 |
| **W4** | 记忆 + 边界 | 三层记忆（含冲突消解）、护栏、升级判定、审批中断/恢复打通 | 对抗拦截 ≥ 95%，误杀 ≤ 3% |
| **W5** | 系统评测 | 模拟器端到端、gate 脚本、回放、指标看板 | 一条命令出报告 + 回归 diff |
| **W6** | 包装 | trace 页、demo 视频、README、OpenAPI、技术文章、面试演练 | 12 问能答满 3 分钟 |

**砍伐顺序**：`demo 修饰 > trace 页 > 看板 > 卡片美化 > rerank > 回放 > MCP > 匹配预判 > 对抗集 > 采集表 > RAG > 意图 > 首响`

**六件套不能砍**：首响、意图、工具、RAG、采集、评测。
（MCP 排在看板之前砍——它是叙事加成，不是功能必需。）

---

## 12. 指标

| 层 | 指标 | 现状 | 目标 |
|---|---|---|---|
| 时效 | 首响 P95 | 3–5 分钟 | < 2 秒 |
| 理解 | 意图 macro-F1 | — | ≥ 0.90 |
| 工具 | 工具选择准确率 | — | ≥ 0.95 |
| 检索 | Recall@5 | — | ≥ 0.85 |
| 转化 | 采集表发出率 | — | 测出来 |
| **业务** | **采集表回填率** | — | 相对基线 +X% |
| 护栏 | 拦截率 / 误杀率 | — | ≥95% / ≤3% |
| 成本 | 单会话成本 | ¥3–5（人力） | < ¥0.1 |

> 无真实流量就用模拟器对照，**诚实标注模拟值**。面试说"真值要线上 A/B，我的评测框架就是为了那一刻建的"——承认边界比吹数字可信。

---

## 13. 简历与面试

### 简历四条

> **招聘 IM Agent 服务** · 个人项目 · TypeScript / Next.js / Supabase(pgvector) / MCP / Vercel AI SDK
> - 设计并实现可被业务后端集成的 Agent 服务：`/v1/messages` 契约（幂等、审批中断/恢复、超时降级、结构化 actions[]），引用+版本的数据传递，session/stateless 双模式上下文管理
> - 基于 MCP 封装招聘领域工具层（7 个 tool / 0 个 resource，上下文由服务调用方传入），agent 作为 client 消费；工具并行编排、失败降级、选择准确率 __%
> - 三层记忆（工作/会话/长期）：滚动摘要 + 结构化槽位 + 候选人事件时间线，支持跨会话召回与记忆冲突消解
> - 生产级 RAG：查询重写 → bge-m3 向量化 → 向量+BM25 混合 → RRF → rerank 阈值拒答；消融实验量化各环节增益，Recall@5 __%

### 必被问的 23 个问题

1. **业务方要传全量消息吗？** → 不要。对话历史服务端存，只传增量；给 stateless 逃生舱。
2. **每次对话都要重传候选人和岗位吗？** → 不用。首轮带 snapshot，后续只带 `{id, version}`，版本变了才重传（ETag 思路）。快照过期靠 action 上的 `preconditions` 在执行前校验——读可以旧，写必须新。
3. **为什么接口返回 actions 而不是文本？** → 业务端要执行"发卡片/发采集表/转人工"；协议化才能审计和重试。
4. **幂等怎么做的？为什么必须做？** → messageId 唯一索引 + 结果缓存；超时重试是常态，不幂等 = 回两遍 + 双倍成本。
5. **为什么用 MCP？** → 领域能力要能被多个 agent 复用；能用 Inspector 独立调试。只有一个消费者时不该用。
6. **serverless 上 stdio 怎么跑？** → 跑不了，用 in-memory transport 同进程；协议层不变，随时可拆。
7. **上下文怎么压缩？** → 最近 8 轮原文 + 滚动摘要 + 槽位独立结构化；每 4 轮或超预算更新。
8. **长期记忆为什么不用向量库？** → 招聘记忆是结构化事实（拒绝过什么、承诺过什么），按 candidateId 直取，语义检索在这里是过度设计。
9. **记忆冲突怎么办？** → 以最新为值但标 conflict，澄清一次，仍冲突转人工。
10. **为什么 RRF 不用加权分数？** → BM25 与 cosine 分布不可比，归一化随 query 漂移。
11. **RAG 为什么不全走向量？** → 薪资/名额强结构化且实时变化，查库更准更快。
12. **怎么防幻觉？** → 数字校验回库 + 强制引用 + 阈值拒答。
13. **怎么判断转人工？** → 不让 LLM 判断（会逞强），用外部信号。
14. **没有真实用户怎么评测？** → 模拟器解决可复现，影子解决真实分布，难例回流解决长期。
15. **上线最大风险？** → 不是模型不准，是误发采集表和合规承诺。所以匹配宁可不发，承诺一律改写。
16. **为什么匹配要分「规则 + LLM」两层？** → 硬条件是布尔事实，LLM 在数字比较/否定句上会翻车且不可复现；LLM 负责读聊天里的语义信号。判断权冲突以规则为准，事实冲突靠澄清。
17. **你说优化了，怎么证明变好了？** → 固定题集 + 分维度指标 + McNemar 配对检验 + case 级 diff。报告必须同时列 fixed 和 broken。
18. **调 A 会不会把 B 调坏？** → 每个能力独立题集，每次跑全量，case 级 diff 按类别聚合 broken，任一维度跌破 gate 直接拦发版。
19. **什么该做成 tool，什么该做成 resource？** → 不看动静，看谁决定：模型决定"要不要取"是 tool，应用决定"进模型前就挂上"是 resource。本项目 0 个 resource。
20. **agent 的业务数据从哪来？** → 不拥有数据。请求体 `subject`（引用+版本）+ Provider 接口：生产调业务端 API，本地读 fixture。MCP 封能力，Provider 决定数据。
21. **为什么砍掉 shadow 模式？** → 它描述的是"怎么评估"，不是"谁执行"。调用方调了不发就行，agent 不需要知道。真实流量评估的正确形态是离线回放。
22. **为什么审批不是全局 mode？** → 风险要按动作分级：发错文案无所谓，发错采集表用户白跑。用 `ApprovalPolicy` 按动作配，恢复时还能带修改后的参数。
23. **中断恢复有什么坑？** → 恢复会重跑节点，所以中断前不能有非幂等副作用（否则表单建两次）；不能把中断包在 try/except；不能在循环里反复中断。

---

## 14. 风险

| 风险 | 预案 |
|---|---|
| 业务端已有契约，与本文不符 | 契约是提案；按对方改，核心层不动（transport 分离的价值） |
| MCP 增加复杂度但叙事收益不足 | 它排在砍伐顺序里；砍掉后工具层直调，接口不变 |
| 6 周做不完 | 按 §11 顺序砍，保六件套 |
| 后端零基础卡住 | W0 只做"一张表 CRUD + 上线"，不追架构优雅 |
| 免费额度不够跑评测 | 分批跑；主力 DeepSeek；judge 用 GLM-Flash |
| Vercel 冷启动影响首响 | 本地/演示无碍；README 说明生产用常驻容器 |

---

## 15. 附录：设计参考对照

这些点不是凭空想的，主流开源实现里都有对应做法。**对照的价值不在"我用了它们"，而在"我知道哪里对齐、哪里刻意不同"。**

### 15.1 对照表

| 设计点 | 本项目做法 | 参考实现 | 结论 |
|---|---|---|---|
| 会话状态 | `conversationId` + 服务端 checkpoint | LangGraph `thread_id` + checkpointer | ✅ 对齐 |
| 人工审批 | `approval_request` + `resume` | LangGraph `interrupt()` / `Command(resume=)` | ✅ 已改为中断模型 |
| 会话历史 | 服务端持有，可切 stateless | OpenAI Agents SDK `Session` | ✅ 对齐 |
| 记忆 | 结构化画像 + 事件，agent 只读 | Letta (MemGPT) memory blocks，agent 自编辑 | ⚠️ 刻意更保守 |
| 工具 / 资源 | 7 tool / 0 resource | MCP 三原语（tools 模型控 / resources 应用控 / prompts 用户控） | ✅ 已修正 |
| 评测 | 分层 + McNemar + 轨迹断言 | τ-bench `pass^k`、promptfoo、Inspect AI | ⚠️ 需补轨迹评估 |
| 可观测 | 自建 `agent_runs` | OpenTelemetry GenAI semconv | ⚠️ 字段应对齐 |

### 15.2 学到的五件事

1. **审批是图里的中断，不是全局开关**（LangGraph）——按动作配策略，恢复时允许带修改后的参数。
2. **中断恢复会重跑节点**（LangGraph）——中断前不能有非幂等副作用，否则审批一次、副作用两次。
3. **会话历史要抽象成可替换的后端**（OpenAI Agents SDK `Session`）——SQLite / Redis / 库表，接口一致。
4. **轨迹也是评测对象**（τ-bench）——不只看最终回答，还看调了哪些工具、顺序对不对、有没有多余步骤；多轮任务用 `pass^k` 衡量稳定性，而不是单次通过率。
5. **trace 字段要对齐标准**（OTel GenAI semconv）——自造字段等于自绝于生态，对齐了才能直接接 Phoenix / Langfuse。

### 15.3 一处刻意不照抄

Letta 让 agent 自己编辑 memory block。本项目**不让**——候选人年龄、薪资预期是业务事实，agent 只能读、只能从对话里抽取并附证据，不能自己"记成"什么。

**这是领域约束，不是技术取舍。** 招聘场景里 agent 记错一个数字，可能把一个 47 岁的人推给 18–45 的岗位。

### 15.4 引用

- LangGraph Interrupts — https://docs.langchain.com/oss/python/langgraph/interrupts
- MCP Server Concepts — https://modelcontextprotocol.io/docs/2024-11-05/learn/server-concepts
- OpenAI Agents SDK — https://github.com/openai/openai-agents-python
- Letta (MemGPT) — https://github.com/letta-ai/letta
- τ-bench — https://github.com/sierra-research/tau-bench
- OpenTelemetry GenAI semconv — https://opentelemetry.io/docs/specs/semconv/gen-ai/
