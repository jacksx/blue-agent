# 招聘 IM Agent 服务 · 施工规划 v3

> 定位变更（v3）：从「C 端聊天产品」改为「**可被业务后端集成的 Agent 服务**」。
> 已有业务服务端负责与 BOSS 直聘 / 店长直聘 收发 IM；本项目提供 Agent 能力 + 一个本地测试用的 Web Playground。
> **边界终点：约面采集表发出即结束。** 到面、入职、佣金不在范围内。

---

## 0. 一句话定位

> 一个给招聘 IM 场景用的 Agent 服务：业务后端把用户消息丢进来，它还回「该说什么 + 该做什么动作」。

**核心判断一：Agent 的输出不是文本，是动作。**

业务端要执行的是"发卡片""发采集表""转人工"。所以接口返回 `actions[]`，文本只是其中一种。这个抽象决定了后面所有设计。

**核心判断二：这不是对话产品，是分流器。**

把混乱的 IM 流量分到几条确定性链路：事实直答 / 采集匹配 / 换岗推荐 / 转人工 / 静默。对话只是载体。

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
                   │ HTTP  POST /v1/messages
                   │ 请求：messageId + 候选人 + 项目单 + 消息
                   │ 响应：actions[] + meta
┌──────────────────▼───────────────────────────┐
│  Agent 服务（本项目）                          │
│                                                │
│  ┌──────────────────────────────────────────┐ │
│  │ HTTP 层（薄）                              │ │
│  │  鉴权 / 幂等 / 参数校验 / 超时 / 限流      │ │
│  └──────────────────┬───────────────────────┘ │
│  ┌──────────────────▼───────────────────────┐ │
│  │ Agent 核心（框架无关的纯 TS）              │ │
│  │  首响引擎 · 意图分类 · 路由                │ │
│  │  RAG（rewrite→hybrid→RRF→rerank）        │ │
│  │  槽位采集 · 匹配预判 · 护栏 · 升级判定     │ │
│  └──────────────────┬───────────────────────┘ │
│  ┌──────────────────▼───────────────────────┐ │
│  │ 存储：Supabase (Postgres + pgvector)      │ │
│  │  Postgres 存一切可存的状态；不引 ORM       │ │
│  └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│  Web Playground（本项目附带，本地测试 + demo） │
│  左：模拟蓝领用户聊天                          │
│  右：Request / Response / Trace 三个 tab       │
│  控件：mode 切换（shadow/draft/auto）、回放    │
└──────────────────────────────────────────────┘
```

**为什么 Agent 核心要框架无关**：它是纯函数式的编排层，不该知道 Next.js 的存在。HTTP 层只是 adapter。这样：
- 单仓单应用部署（Vercel 免费），开发成本最低
- 随时可以迁到 Fastify / Docker / 内网部署，核心代码不动
- 面试可讲："core 和 transport 分离，换框架只是重写 200 行 adapter"

---

## 2. 接口契约（本项目最重要的工程产物）

### 2.1 请求

```ts
POST /v1/messages
Authorization: Bearer <api_key>

interface AgentRequest {
  messageId: string;              // ★ 幂等键，业务端生成（建议 platform:msgId）
  platform: 'boss' | 'dianzhang';
  conversationId: string;
  candidateId: string;
  jobOrderId: string;

  candidate: {                    // 结构化简历（平台字段）
    age?: number;
    gender?: 'male' | 'female';
    city?: string;
    district?: string;
    education?: string;
    experienceYears?: number;
    expectSalary?: { min: number; max: number };
    availableFrom?: string;       // ISO date
    hasHealthCert?: boolean;
    isStudent?: boolean;
    skills?: string[];
  };

  jobOrder: {                     // 当前项目单
    id: string;
    title: string;
    city: string;
    district?: string;
    salaryMin: number;
    salaryMax: number;
    payType: 'hourly' | 'daily' | 'monthly';
    shifts: string[];
    requirements: Record<string, unknown>;
    headcountLeft: number;
  };

  message: { type: 'text'; text: string; sentAt: string };

  options?: {
    mode?: 'shadow' | 'draft' | 'auto';   // ★ 默认 auto
    maxLatencyMs?: number;                 // 默认 3000
    locale?: string;
  };
}
```

### 2.2 响应

```ts
interface AgentResponse {
  traceId: string;
  conversationId: string;

  actions: AgentAction[];         // ★ 业务端按顺序执行
  state: ConversationState;       // GREETING | DISCOVERY | COLLECTING | MATCHING | FORM_SENT | HANDOFF | CLOSED

  meta: {
    intent: IntentLabel[];
    intentConfidence: number;
    match?: MatchAssessment;
    escalated: boolean;
    degraded: boolean;            // 是否降级（超时/模型失败）
    latencyMs: number;
    model: string;
    promptVersion: string;
  };
}

type AgentAction =
  | { type: 'text'; text: string }
  | { type: 'job_cards'; jobs: JobCard[]; reason: string }
  | { type: 'interview_form'; formId: string; url: string; prefill: FormPrefill }
  | { type: 'handoff'; reason: HandoffReason; summary: string; suggestedReply?: string }
  | { type: 'noop' };             // 广告/刷屏/无需回复
```

### 2.3 幂等

- `messageId` 唯一索引
- 重复请求**不重算**，直接返回首次结果 + `meta.cached = true`
- 为什么重要：业务端超时重试是常态；不幂等 = 同一句话回两遍 + 双倍成本

### 2.4 mode 开关（一个服务，三种接法）

| mode | 行为 | 用途 |
|---|---|---|
| `shadow` | 只返回 `actions` 给后台记录，不发送 | 线上零风险验证 |
| `draft` | 返回草稿，业务端人工确认后发送 | 人机协同期 |
| `auto` | 直接执行 | 灰度放量 |

**同一套代码，改配置不改代码**。线上三阶段验证不需要重构，这是设计上的关键决定。

### 2.5 超时与降级

| 场景 | 行为 |
|---|---|
| 正常 | P95 < 2s 返回 |
| 接近 `maxLatencyMs` | 返回模板兜底 + `degraded: true` |
| 业务端超时 | 业务端自己发兜底话术；agent 记 `timeout` 指标 |
| 模型不可用 | 503 + 重试建议；业务端发兜底 |
| 限流 | 429，按 `conversationId` 限 |

**不做异步回调**（MVP 取舍）：长任务回调需要业务端暴露 callback、要处理乱序、要处理重复。收益不抵成本。README 里写清这个判断。

### 2.6 错误码

| 码 | 含义 | 业务端该做什么 |
|---|---|---|
| 400 | 参数错误 | 修 bug，别重试 |
| 401 | 鉴权失败 | 检查 key |
| 409 | messageId 重复 | 用首次结果 |
| 429 | 限流 | 退避重试 |
| 503 | 模型/依赖不可用 | 发兜底话术 |

---

## 3. 接管边界

### L0 全自动

- 首响与寒暄
- 结构化事实答疑：薪资区间、发薪日、地点、班次、食宿、要求、剩余名额
- 槽位追问（年龄、期望城市、到岗时间、健康证…）
- 岗位卡片推荐与切换
- 流程问题（怎么面试、带什么、体检在哪做）

### L1 建议 / 分级

- 匹配预判与发采集表：按 §5 四态，`auto_match` 自动发（可撤回），`suggest` 人工确认
- 换岗推荐

### L2 必须人工

| 触发条件 | 判据来源 |
|---|---|
| 用户明确要求人工 | 意图分类 |
| 薪资谈判 / 要求承诺 | 规则 + 分类 |
| 投诉、情绪激烈、辱骂 | 情绪分 + 关键词 |
| 简历与聊天冲突 | 一致性校验 |
| 连续 2 次工具失败 / 检索低于阈值 | 系统信号 |
| 试图脱离平台（要微信/私下聊） | 规则 |
| 健康、身份、法律敏感问题 | 分类 |

### 谁来决定升级：不是 LLM

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

### 不做清单（写进 prompt，也写进 README）

不承诺薪资 / 不承诺录取 / 不透露其他候选人信息 / 不做歧视性表述 / 不给医疗法律建议 / 不引导脱离平台。

---

## 4. 流程映射

| # | 流程 | 人工现状 | Agent | 级别 |
|---|---|---|---|---|
| 1 | 用户 IM 问当前职位 | 手动看，几分钟回 | 3 秒首响：确认在招 + 一句追问 | L0 |
| 2 | 答疑 / 追问 | 重复答同样 10 个问题 | 结构化事实直答 + RAG 兜底 + 槽位追问 | L0 |
| 3 | 匹配判定 | 翻简历 + 翻聊天 | 四态预判 + 证据包 | L1 |
| 4 | 匹配 → 发采集表 | 手填表单 | 自动预填 + 免登录链接 + 话术 | L1 |
| 5 | 不匹配 → 推荐卡片 | 手动找岗位 | 混合检索 top3 + 卡片 | L0 |
| 6 | 结束 | — | 归档 + trace | — |

### 首响为什么不用大模型

蓝领用户同时问 3–5 家，谁先回跟谁聊。要 P95 < 2s，只能模板 + 槽位填充 + 缓存。

| 环节 | 预算 | 手段 |
|---|---|---|
| 入库 + 去重 | 20ms | 唯一索引 |
| 意图分类 | 150ms | 小模型 / 规则优先 |
| 首响生成 | 50ms | 模板 + 缓存 |
| **首响 P95** | **< 2s** | 不含大模型 |

---

## 5. 匹配判定（四态）

有结构化简历，所以能做硬条件比对。

### 硬条件（零容忍，任一 fail 即 not_match）

年龄区间、性别要求、健康证、学历、经验年限、到岗时间、学生工限制。

### 软条件（打分）

期望薪资与岗位区间的重叠度、通勤（区域）、班次偏好、行业经验相关性。

### 四态决策

| 判定 | 条件 | 动作 |
|---|---|---|
| `insufficient_data` | 硬条件字段缺失 | **追问**，不判 |
| `not_match` | 任一硬条件 fail | 推荐其他岗位卡片 |
| `auto_match` | 全 pass + 画像完整度 ≥ 0.9 + 软分 ≥ 0.6 | 自动发采集表（可撤回） |
| `suggest` | 全 pass 但信息不全或软分边缘 | 经纪人一键确认 |

**关键：数据缺失不能判不匹配，要追问。** 这是业务常识，也是很多 AI 项目翻车的地方。

### 证据包

```ts
interface MatchAssessment {
  decision: 'insufficient_data' | 'not_match' | 'auto_match' | 'suggest';
  score: number;
  hardChecks: Array<{
    field: string;
    required: string;
    actual: string | null;
    pass: boolean | null;      // null = 数据缺失
    source: 'resume' | 'chat' | null;
    evidence?: string;         // 引用原话
  }>;
  missing: string[];
  softScores: Record<string, number>;
}
```

**精确率优先**：错发一次采集表的成本（用户白跑 + 投诉）远高于少发一次。所以宁可不发。

---

## 6. RAG 设计

链路：**提示词重写 → 向量化 → 混合检索 → RRF → rerank**。

### 6.1 前置：四类知识，只有两类走向量

| 类型 | 例子 | 处理 | 为什么 |
|---|---|---|---|
| 结构化事实 | 薪资、地点、班次、名额、发薪日 | **查库 + 模板** | 必须实时精确；招满即停 |
| 半结构化 | 岗位要求、工作内容、环境 | 混合检索 + RRF + rerank | 答案在长文本里 |
| 政策流程 | 体检、住宿、结算、平台规则 | 独立知识库，混合检索 | 跨岗位通用 |
| 历史话术 | 经纪人优质回复 | 检索做 few-shot | 学风格，不学事实 |

> 把"月薪 8000"塞进向量库是 RAG 最典型的错误——既快不了也准不了。**该用 SQL 的地方用 SQL。**

### 6.2 查询重写

1. **指代消解**："这个多少钱" → "XX 电子厂普工岗薪资"
2. **口语归一**：`包吃住→食宿`、`几号发→发薪日`、`要不要体检→体检要求`、`管饭不→工作餐`
3. **意图扩展**：`多少钱` → `薪资/时薪/加班费/结算方式/发薪日`
4. **槽位抽取**：同时输出结构化过滤条件

```json
{
  "rewritten": "郑州 电子厂 普工 薪资 时薪 加班费 结算方式",
  "filters": { "city": "郑州", "jobOrderId": "J2024-0815" },
  "subQueries": ["普工薪资", "加班费怎么算", "几号发工资"]
}
```

### 6.3 向量化与切分

- 模型：`bge-m3`（中文强，1024 维，免费额度够）
- 索引：pgvector HNSW，`vector_cosine_ops`
- **按"字段组"切，不按字数切**：

```
一个岗位 → 4 个 chunk
  [薪资组] 薪资区间 / 结算方式 / 发薪日 / 加班费
  [要求组] 年龄 / 性别 / 学历 / 经验 / 健康证
  [福利组] 食宿 / 班车 / 社保 / 补贴
  [内容组] 工作内容 / 班次 / 时长 / 环境
```

按字数切会把"薪资"和"要求"切进同一个 chunk，检索出来就是噪音。

### 6.4 混合检索 + RRF

```sql
-- 向量路 top20
select id, 1 - (embedding <=> $1) as score
from job_chunks order by embedding <=> $1 limit 20;

-- 关键词路 top20（中文先分词，空格连接存 search_text）
select id, ts_rank_cd(tsv, plainto_tsquery('simple', $2)) as score
from job_chunks where tsv @@ plainto_tsquery('simple', $2)
order by score desc limit 20;
```

$$\text{RRF}(d) = \sum_{r} \frac{1}{60 + \text{rank}_r(d)}$$

**为什么不用分数加权**：BM25 分数无上界，cosine 在 [-1,1]，分布不可比；归一化系数随 query 漂移。RRF 只用排名，零调参。

### 6.5 Rerank 与拒答

- `bge-reranker-v2-m3`（免费额度）或 LLM listwise（GLM-Flash）
- top20 → top5，归一化到 0–1
- **低于 0.35 不生成**，走兜底："这个我确认一下，马上回你" + 转人工

### 6.6 生成 + 事实校验（防幻觉最有效的一招）

1. 强制带引用（chunk_id / 字段名）
2. **数字校验**：抽取生成文本里所有数字，逐个比对 `job_orders`；不一致就重写或降级模板
3. 禁用词过滤

> 幻觉在招聘场景是**法律风险**，不是体验问题。事实只能靠校验，不能靠模型记忆。

### 6.7 消融实验（面试杀器）

100 条标注 query，逐项关掉看掉多少：

| 配置 | Recall@5 | MRR | NDCG@5 | P95 | 成本 |
|---|---|---|---|---|---|
| 仅向量 | | | | | |
| 仅 BM25 | | | | | |
| 向量+BM25 加权 | | | | | |
| + RRF | | | | | |
| + rerank | | | | | |
| + 查询重写 | | | | | |

能回答："rerank 值不值 3 倍延迟？""短 query 上重写有没有用？"收益 < 成本的，砍掉并写进 README。

---

## 7. 数据模型

```sql
create extension if not exists vector;

-- 会话（服务端持有状态；业务端只传 messageId + 增量）
create table conversations (
  id uuid primary key default gen_random_uuid(),
  platform text, external_conversation_id text,
  candidate_id text, job_order_id text,
  state text default 'GREETING',
  status text default 'active',
  slot_state jsonb default '{}',        -- 已采集槽位 + 来源
  summary text,
  mode text default 'auto',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (platform, external_conversation_id)
);

-- 消息（幂等）
create table messages (
  id bigserial primary key,
  message_id text unique not null,       -- ★ 幂等键
  conversation_id uuid references conversations(id),
  role text,                              -- candidate / agent / human
  content text,
  actions jsonb,                          -- agent 产生的动作
  state_after text,
  created_at timestamptz default now()
);
create index on messages (conversation_id, id);

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
  chunk_type text,                        -- salary / requirement / perk / content / policy
  text text, search_text text,            -- 分词后空格连接
  embedding vector(1024),
  tsv tsvector generated always as (to_tsvector('simple', coalesce(search_text,''))) stored
);
create index on job_chunks using hnsw (embedding vector_cosine_ops);
create index on job_chunks using gin (tsv);

-- 匹配预判
create table match_assessments (
  id bigserial primary key,
  conversation_id uuid, job_order_id text,
  decision text, score int,
  hard_checks jsonb, soft_scores jsonb, missing jsonb,
  model text, prompt_version text,
  created_at timestamptz default now()
);

-- 采集表
create table interview_forms (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid, candidate_id text, job_order_id text,
  token text unique, prefill jsonb, submitted jsonb,
  status text default 'sent',            -- sent/opened/submitted/expired
  sent_at timestamptz, submitted_at timestamptz,
  auto_sent boolean default false, revoked boolean default false
);

-- 可观测性：一步一条
create table agent_runs (
  id bigserial primary key,
  trace_id uuid, conversation_id uuid, step int, node text,
  intent text, confidence numeric,
  tool text, tool_input jsonb, tool_output jsonb,
  retrieved jsonb,                        -- chunk ids + scores
  prompt_version text, model text,
  tokens_in int, tokens_out int, cost_usd numeric(10,6),
  latency_ms int, escalated boolean, degraded boolean, error text,
  created_at timestamptz default now()
);
create index on agent_runs (conversation_id, id);
create index on agent_runs (trace_id);

-- 评测
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

## 8. 评测与可靠性

### 8.1 能力契约

| 能力 | 成功定义 | 失败兜底 | 度量 |
|---|---|---|---|
| 首响 | P95 < 2s，含岗位名 + 一句追问 | 纯模板 | 时延分位 |
| 意图 | 8 类多标签，macro-F1 ≥ 0.9 | 低置信 → 追问澄清 | 混淆矩阵 |
| 事实答疑 | 与库 100% 一致 | 校验失败改模板 | 抽样人工 |
| 槽位采集 | 6 轮内补齐关键槽位 | 转人工 | 完成率 / 轮次 |
| 匹配预判 | 硬条件零误判 | 一律 suggest | 精确率优先 |
| 推荐 | 100% 满足硬约束 | 空结果 → 转人工 | 违反率 |
| 升级 | 不漏、不滥 | — | 漏转率 / 误转率 |

### 8.2 测试金字塔

| 层 | 对象 | 方式 | 频率 | 门槛 |
|---|---|---|---|---|
| L0 | prompt 版本、schema、禁用词 | 单测 + lint | 每次提交 | 100% |
| L1 | 工具函数、RRF、槽位合并、幂等、格式化 | 单测 | 每次提交 | 100% |
| L2 | 意图、RAG 检索、抽取、匹配 | 标注集 | 每次 PR | 分项阈值 |
| L3 | 多轮场景 | 用户模拟器 + 断言 | 每次发版 | 完成率 |
| L4 | 注入/越权/诱导承诺/PII | 红队集 | 每次发版 | 拦截率 / 误杀 |
| L5 | 真实流量 | 影子 → draft → auto | 持续 | 业务指标 |

### 8.3 数据集

| 集合 | 规模 | 内容 |
|---|---|---|
| `intent` | 600 | 8 类多标签短句，含歧义/错别字/方言 |
| `rag` | 100 | query → 正确 chunk，含 15 条应拒答负样本 |
| `extract` | 120 | 对话片段 → 槽位 |
| `match` | 100 | (简历, 项目单) → 四态 + 理由 |
| `redteam` | 60 | 注入、越权、诱导承诺、PII、脱离平台 |
| `e2e` | 40 | 完整场景 + 用户人格 |

**意图 taxonomy**：问薪资 / 问地点通勤 / 问食宿 / 问要求门槛 / 问工作内容强度 / 求职意向换岗 / 约面到岗 / 无效风险。

**难例回流**：L3/L5 失败 case 进回归集，永久保留。这是评测"活着"的标志。

**标注规范必须先定**（否则指标不可信）：
- "多少钱" → 薪资意图
- "还招人吗" → 求职意向
- 一句含两意图 → 多标签都标，主意图取第一个

### 8.4 线上三阶段

1. **shadow**：真实消息进来，agent 照算照记，不发送。与人工实际回复对比，产出差异分类。
2. **draft**：出草稿，经纪人一键发送或修改。**核心指标：修改率**——改的是哪一类，就是失败模式分布。这比任何 LLM-judge 都真实。
3. **auto**：5% → 20% → 50%，监控首响、意图抽检、采集表发出率与**回填率**、换岗点击率、升级率、负反馈率。

> 到面/入职不在范围内，**采集表回填率是本项目的终极业务指标**。口径要提前说清。

### 8.5 可靠性工程

| 问题 | 方案 |
|---|---|
| 重复处理 | `messageId` 唯一索引 + 首次结果缓存 |
| 并发乱序 | 会话级锁（DB 行锁） |
| 模型超时 | 3s 超时 → 模板 + `degraded` |
| 限流 | 按 conversationId |
| 幻觉 | 数字校验 + 引用强制 + 阈值拒答 |
| 越权 | 查询强制带 candidateId |
| 审计 | 每条回复可回溯 prompt 版本 + 模型 + 检索证据 |
| 成本 | 单会话 token 预算，超限降小模型 |
| 脱敏 | 日志不落手机号/身份证 |

### 8.6 Release Gate

| 项 | 阈值 |
|---|---|
| L0 + L1 | 100% |
| 意图 macro-F1 | ≥ 0.90 |
| RAG Recall@5 | ≥ 0.85 |
| 槽位抽取 F1 | ≥ 0.88 |
| 匹配硬条件违反率 | **0** |
| 对抗拦截率 | ≥ 95% |
| 合规误杀率 | ≤ 3% |
| 首响 P95 | < 2s |
| 单会话成本 | < ¥0.1 |

不过 gate 不许发版。这张表本身就是最好的简历素材。

---

## 9. Playground

**不是聊天框，是"服务调试台"。**

```
┌─────────────────────┬──────────────────────────────┐
│  模拟用户聊天        │  Request  Response  Trace     │
│                     │                              │
│  [蓝领头像] 还招人吗  │  POST /v1/messages           │
│                     │  {                           │
│  [Agent] 在招的，你   │    "messageId": "boss:881",  │
│   多大？在哪个区？    │    "candidate": {...},       │
│                     │    ...                       │
│  多少钱一个月         │  }                           │
│                     │  ─────────────────────       │
│  ┌───────────────┐  │  {                           │
│  │ 岗位卡片       │  │    "actions": [...],         │
│  └───────────────┘  │    "latencyMs": 1420        │
│                     │  }                           │
├─────────────────────┴──────────────────────────────┤
│ mode: [shadow] [draft] [auto]   回放: [导入 JSONL]  │
└────────────────────────────────────────────────────┘
```

必须有的：
- mode 切换（证明三阶段是配置不是重构）
- Request/Response 原始 JSON（证明这是服务）
- Trace：每步耗时、检索到的 chunk、工具调用、是否降级
- 回放：导入一段对话 JSONL 重跑（影子模式和回归测试的基础）
- 角色切换：可以手打"业务端视角"的请求

这一个界面同时是测试工具、demo、和"服务"定位的证据。

---

## 10. 六周计划

| 周 | 主题 | 交付物 | 验收 |
|---|---|---|---|
| **W0**（3 天） | 地基 | 单仓骨架 + Supabase 建表 + Vercel 上线 + 合成数据（60 项目单 / 60 简历 / 600 意图句） | 公网可访问，意图集 v0 |
| **W1** | 契约 + 首响 + 意图 | `/v1/messages` 完整契约（幂等/鉴权/错误码）、首响引擎、意图分类、Playground 双栏 | 意图混淆矩阵 + baseline |
| **W2** | RAG | rewrite → 向量化 → 混合 → RRF → rerank 全链路 | Recall@5 ≥ 0.85 + 消融表 |
| **W3** | 采集 + 匹配 | 槽位采集、匹配四态 + 证据包、采集表生成、岗位卡片 | 抽取 F1 ≥ 0.88，硬条件零违反 |
| **W4** | 边界 + 接管 | 护栏、升级判定、三级接管（auto/suggest）、mode 三态打通 | 对抗拦截 ≥ 95%，误杀 ≤ 3% |
| **W5** | 系统评测 | 用户模拟器端到端、gate 脚本、回放、指标看板 | 一条命令出报告 + 回归 diff |
| **W6** | 包装 | trace 页、demo 视频、README、OpenAPI、技术文章、面试演练 | 10 问能答满 3 分钟 |

**砍伐顺序**（先砍后面的）：
`demo 修饰 > trace 页 > 看板 > 岗位卡片美化 > rerank > 回放 > 匹配预判 > 对抗集 > 采集表 > RAG > 意图 > 首响`

**六件套不能砍**：首响、意图、RAG、采集、匹配、评测。

---

## 11. 指标

| 层 | 指标 | 现状 | 目标 |
|---|---|---|---|
| 时效 | 首响 P95 | 3–5 分钟 | < 2 秒 |
| 理解 | 意图 macro-F1 | — | ≥ 0.90 |
| 检索 | Recall@5 | — | ≥ 0.85 |
| 转化 | 采集表发出率 | — | 测出来 |
| **业务** | **采集表回填率** | — | 相对基线 +X% |
| 护栏 | 拦截率 / 误杀率 | — | ≥95% / ≤3% |
| 成本 | 单会话成本 | ¥3–5（人力） | < ¥0.1 |
| 负载 | 单经纪人可挂会话 | 5–8 | 不限 |

> 无真实流量就用模拟器对照，**诚实标注模拟值**。面试说"真值要线上 A/B，我的评测框架就是为了那一刻建的"——承认边界比吹数字可信。

---

## 12. 简历与面试

### 简历三条

> **招聘 IM Agent 服务** · 个人项目 · TypeScript / Next.js / Supabase(pgvector) / Vercel AI SDK
> - 设计并实现可被业务后端集成的招聘 IM Agent 服务：`/v1/messages` 契约（幂等、mode 三态、超时降级、结构化 actions[]），覆盖首响、8 类多标签意图、槽位采集、匹配四态预判与采集表生成
> - 实现生产级 RAG：查询重写 → bge-m3 向量化 → 向量+BM25 混合检索 → RRF 融合 → rerank 阈值拒答；消融实验量化各环节增益，Recall@5 __%
> - 建立分层评测（单测/组件/场景/对抗/线上影子）与 release gate：意图 F1 __、对抗拦截 __%/误杀 __%、首响 P95 __ms、单会话成本 ¥__

### 必被问的 12 个问题

1. **为什么接口返回 actions 而不是文本？** → 业务端要执行"发卡片/发采集表/转人工"，文本只是其中一种；协议化才能审计和重试。
2. **幂等怎么做的？为什么必须做？** → messageId 唯一索引 + 首次结果缓存；业务端超时重试是常态，不幂等 = 回两遍 + 双倍成本。
3. **超时了怎么办？** → 3s 硬超时返回模板 + degraded 标记；不做异步回调，因为回调要处理乱序和重复，收益不抵成本。
4. **mode 三态为什么放在服务端？** → 线上放量要能随时退回；放客户端就是发版风险。
5. **为什么不直接用大模型自由对话？** → 首响要 2s、事实要零错、动作要有副作用控制。
6. **为什么 RRF 不用加权分数？** → BM25 与 cosine 分布不可比，归一化随 query 漂移；RRF 只用排名。
7. **RAG 为什么不全走向量？** → 薪资/名额是强结构化且实时变化，查库比检索准且快。
8. **怎么防幻觉？** → 生成后数字校验回库 + 强制引用 + 阈值拒答。
9. **怎么判断转人工？** → 不让 LLM 判断（会逞强），用外部信号：检索分、槽位完整度、分类置信度、规则命中。
10. **数据缺失时匹配怎么判？** → 判 insufficient_data 去追问，不能判不匹配。
11. **没有真实用户怎么评测？** → 模拟器解决可复现，影子模式解决真实分布，难例回流解决长期。
12. **上线最大风险？** → 不是模型不准，是误发采集表和合规承诺。所以匹配宁可不发，承诺一律改写。

### 为什么不用 Python

> 6 周、一个人、零预算，还要同时证明服务设计和前端交付，一套 TS 端到端能把时间花在契约和评测上。核心层是框架无关的纯 TS，换语言只是重写，不是重学。

---

## 13. 风险

| 风险 | 预案 |
|---|---|
| 业务端已有契约，与本文不符 | 契约只是提案；真实对接时按对方改，核心层不动（这正是 transport 分离的价值） |
| 拿不到真实简历结构 | 已确认有结构化字段；若字段缺失按 `insufficient_data` 追问 |
| 6 周做不完 | 按 §10 顺序砍，保六件套 |
| 后端零基础卡住 | W0 只做"一张表 CRUD + 上线"，不追架构优雅 |
| 免费额度不够跑评测 | 分批跑；主力 DeepSeek；judge 用 GLM-Flash |
| Vercel 冷启动影响首响 | 本地/演示无碍；README 说明生产应用常驻容器 |
