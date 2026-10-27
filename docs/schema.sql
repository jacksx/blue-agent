-- ─────────────────────────────────────────────────────────────
-- 招聘 IM Agent · 数据模型
-- 目标库：Supabase (Postgres 15+) with pgvector
-- 说明：
--   · agent 不拥有业务数据，但为了评测/回放/可观测性，
--     会冗余保存一份会话与运行记录
--   · 业务事实的权威仍在业务端（见 docs/plan §2.3）
-- ─────────────────────────────────────────────────────────────

create extension if not exists vector;
create extension if not exists pgcrypto;

-- ── 会话与消息 ───────────────────────────────────────────────

create table if not exists conversations (
  id                   uuid primary key default gen_random_uuid(),
  external_id          text not null,            -- 业务端的 conversationId
  platform             text not null check (platform in ('boss','dianzhang')),
  candidate_id         text not null,
  active_job_order_id  text,
  state                text not null default 'GREETING',
  status               text not null default 'active'
                       check (status in ('active','pending_approval','human_taken','transferred','closed')),
  slot_state           jsonb not null default '{}'::jsonb,
  summary              text,
  summary_updated_at   timestamptz,
  mode                 text not null default 'auto',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (platform, external_id)
);

create table if not exists messages (
  id               bigserial primary key,
  message_id       text not null unique,         -- 幂等键
  conversation_id  uuid not null references conversations(id) on delete cascade,
  role             text not null check (role in ('candidate','agent','human','system')),
  content_type     text not null default 'text'
                   check (content_type in ('text','image','voice','file','card','form','system')),
  content          text,
  subject_id       text,                          -- 多职位切换：这条消息当时属于哪个 subject
  actions          jsonb,
  tokens_in        int,
  tokens_out       int,
  latency_ms       int,
  created_at       timestamptz not null default now()
);

create index if not exists idx_messages_conv on messages (conversation_id, id);

-- ── 审批（中断 / 恢复）─────────────────────────────────────
-- 一次审批就是一条 state machine 记录：pending → approved / edited / rejected / expired。
-- proposed_actions 存的是"通过后才会执行"的动作；中断前不产生任何副作用。

create table if not exists approvals (
  id               uuid primary key default gen_random_uuid(),
  external_id      text not null unique,          -- approvalId（返回给业务端）
  conversation_id  uuid not null references conversations(id) on delete cascade,
  message_id       text,                           -- 触发中断的那条消息
  status           text not null default 'pending'
                   check (status in ('pending','approved','edited','rejected','expired')),
  policy           jsonb,                          -- 当时的 ApprovalPolicy（可追溯）
  proposed_actions jsonb not null,                 -- 通过后要执行的动作
  edited_actions   jsonb,                          -- decision=edit 时人工改过的动作
  confidence       numeric,                        -- 证据完整度，不是模型自评
  reason           text,                           -- 为什么走到审批
  summary          text,
  requested_at     timestamptz not null default now(),
  resolved_at      timestamptz,
  expires_at       timestamptz not null
);

create index if not exists idx_approvals_conv on approvals (conversation_id, status);
create index if not exists idx_approvals_pending on approvals (status, expires_at);

-- ── 岗位（外部数据镜像，用于本地召回与评测）────────────────

create table if not exists job_orders (
  id                 text primary key,
  platform_job_id    jsonb not null,             -- {"boss":"...","dianzhang":"..."}
  platform_enabled   text[] not null default '{}',
  title              text not null,              -- 营销文案，不作事实源
  position_name      text not null,              -- 结构化岗位名（采集表写这个）
  job_type           text not null,              -- 展示用分类串，禁止解析
  employment_type    text not null check (employment_type in ('full','part','both')),
  category           text not null,
  store_name         text,
  city               text,
  district           text,
  address            text,
  lat                double precision,
  lng                double precision,
  commute_minutes    int,                        -- 由业务端实时算好传入；null 则走区级矩阵
  headcount_total    int not null default 0,
  headcount_left     int not null default 0,

  -- 薪资：base + 全勤 + 加班（真实结构）
  pay                jsonb not null,
  schedule           jsonb not null,
  requirements       jsonb not null,
  benefits           jsonb not null,
  description        jsonb not null,
  recruiter          jsonb not null,
  tags               text[] not null default '{}',
  canonical_tags     text[] not null default '{}',   -- 归一层（见 §7.9）

  status             text not null default 'open' check (status in ('open','paused','closed')),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_jobs_recall
  on job_orders (city, status, headcount_left);
create index if not exists idx_jobs_age
  on job_orders (((requirements->>'ageMin')::int), ((requirements->>'ageMax')::int));

-- 知识块（RAG 用）：按字段组切，不按字数切
create table if not exists job_chunks (
  id             bigserial primary key,
  job_order_id   text not null references job_orders(id) on delete cascade,
  chunk_type     text not null,                  -- salary / requirement / perk / content / policy
  text           text not null,
  search_text    text,                           -- 分词后空格连接
  embedding      vector(1024),
  tsv            tsvector generated always as
                 (to_tsvector('simple', coalesce(search_text, ''))) stored
);

create index if not exists idx_chunks_hnsw
  on job_chunks using hnsw (embedding vector_cosine_ops);
create index if not exists idx_chunks_tsv
  on job_chunks using gin (tsv);

-- 政策 / FAQ 知识块（RAG）：按"一个可独立回答的问题"切，不按字数切。
-- 与 job_chunks 分开：岗位事实查库，政策事实走检索，两条线不混。
create table if not exists policy_chunks (
  id          text primary key,                  -- 'health.exam_fee'
  category    text not null,                     -- settlement / health / onboarding / ...
  title       text not null,
  text        text not null,
  keywords    text[] not null default '{}',
  search_text text,
  embedding   vector(1024),
  tsv         tsvector generated always as
              (to_tsvector('simple', coalesce(search_text, ''))) stored,
  updated_at  timestamptz not null default now()
);

create index if not exists idx_policy_chunks_hnsw
  on policy_chunks using hnsw (embedding vector_cosine_ops);
create index if not exists idx_policy_chunks_tsv
  on policy_chunks using gin (tsv);

-- ── 标签归一化 ───────────────────────────────────────────────

create table if not exists canonical_tags (
  id          text primary key,                  -- 'meal.provided'
  category    text not null,
  name        text not null,
  aliases     text[] not null default '{}',
  embedding   vector(1024)
);

create table if not exists tag_text_mappings (
  norm_text     text primary key,                -- 去空格/全半角/标点后
  canonical_id  text not null references canonical_tags(id),
  method        text not null check (method in ('exact','dict','vector','llm','manual')),
  confidence    numeric not null default 0,
  reviewed      boolean not null default false,
  first_seen_at timestamptz not null default now()
);

-- ── 匹配与推荐 ───────────────────────────────────────────────

create table if not exists match_assessments (
  id               bigserial primary key,
  conversation_id  uuid references conversations(id) on delete cascade,
  job_order_id     text not null,
  decision         text not null,
  score            int not null,
  blocking         jsonb not null,
  negotiable       jsonb not null,
  preferences      jsonb not null,
  preconditions    jsonb not null,
  reasons          jsonb not null,
  prompt_version   text,
  created_at       timestamptz not null default now()
);

create table if not exists interview_forms (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid references conversations(id) on delete cascade,
  job_order_id     text not null,
  token            text not null unique,
  prefill          jsonb not null,
  submitted        jsonb,
  status           text not null default 'sent'
                   check (status in ('sent','opened','submitted','expired','revoked')),
  auto_sent        boolean not null default false,
  sent_at          timestamptz not null default now(),
  submitted_at     timestamptz
);

-- ── 记忆 ─────────────────────────────────────────────────────

create table if not exists profile_slots (
  candidate_id  text not null,
  key           text not null,
  scope         text not null default 'person' check (scope in ('person','subject')),
  value         jsonb,
  reason        text,
  strength      text not null default 'soft' check (strength in ('hard','strong','soft')),
  source        text not null default 'chat' check (source in ('resume','chat','inferred')),
  evidence      text,
  asserted_at   timestamptz not null default now(),
  expires_at    timestamptz,
  state         text not null default 'fresh'
                check (state in ('fresh','stale','expired','conflicted')),
  primary key (candidate_id, key, scope)
);

create table if not exists preference_events (
  id               bigserial primary key,
  candidate_id     text not null,
  key              text not null,
  old_value        jsonb,
  new_value        jsonb,
  reason           text,
  conversation_id  uuid,
  at               timestamptz not null default now()
);

-- ── 可观测性 ─────────────────────────────────────────────────

create table if not exists agent_runs (
  id               bigserial primary key,
  trace_id         uuid not null,
  conversation_id  uuid,
  step             int not null,
  node             text not null,
  intent           text,
  confidence       numeric,
  tool             text,
  tool_input       jsonb,
  tool_output      jsonb,
  retrieved        jsonb,
  prompt_version   text,
  model            text,
  tokens_in        int,
  tokens_out       int,
  cost_usd         numeric(10,6),
  latency_ms       int,
  escalated        boolean not null default false,
  degraded         boolean not null default false,
  error            text,
  created_at       timestamptz not null default now()
);

create index if not exists idx_runs_conv on agent_runs (conversation_id, id);
create index if not exists idx_runs_trace on agent_runs (trace_id);

-- ── 评测 ─────────────────────────────────────────────────────

create table if not exists eval_datasets (
  id          text primary key,
  kind        text not null,
  version     text not null,
  size        int not null default 0,
  meta        jsonb
);

create table if not exists eval_cases (
  id           text primary key,
  dataset_id   text not null references eval_datasets(id),
  input        jsonb not null,
  expected     jsonb not null,
  tags         text[] not null default '{}',
  difficulty   text
);

create table if not exists eval_runs (
  id               uuid primary key default gen_random_uuid(),
  dataset_id       text not null,
  prompt_version   text,
  model            text,
  git_sha          text,
  metrics          jsonb,
  started_at       timestamptz not null default now()
);

create table if not exists eval_results (
  run_id       uuid not null references eval_runs(id) on delete cascade,
  case_id      text not null,
  output       jsonb,
  passed       boolean not null,
  scores       jsonb,
  latency_ms   int,
  cost_usd     numeric(10,6),
  primary key (run_id, case_id)
);
