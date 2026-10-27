# Mock 业务服务端 · 设计与数据规格

> 你不在真实业务里，所以"业务端"要我们自己造一个，但**必须像真的**。
> 这份文档定义：造什么、字段长什么样、能演哪些场景。

---

## 0. 定位

| | 真实环境 | 本项目 |
|---|---|---|
| 谁跟 BOSS/店长直聘 收发消息 | 已有业务系统 | **Mock BFF 模拟** |
| 谁持有简历/项目单/采集表 | 已有业务系统 | **Mock BFF 持有**（Postgres） |
| 谁做业务决策（匹配/发不发表单） | 经纪人 | Agent 建议 + 人工审批 |

**Mock BFF 不是"假数据生成器"，是"真实链路的替身"**：它要能走完
`用户发消息 → 调 Agent → 执行 actions → 渲染成 IM 消息 → 用户看到`
这条完整回路，否则 Playground 演示不出东西。

技术形态：跟 Agent 同一个 Next.js 应用，挂在 `/mock/*` 路由下，独立 schema。零成本、单仓、可一键重置。

---

## 1. 三端角色

```
① 蓝领求职者（手机端）     ② 经纪人（工作台）        ③ Agent 服务
   看到聊天 + 卡片             看到会话 + 审批草稿         看到 Request/Trace
   点卡片 → 切职位             改/驳回/直接发
```

Playground 三栏分别对应这三端，**同一份数据三个视角**。

---

## 2. 数据模型

### 2.1 项目单（job_order）

真实蓝领岗位的字段远比"标题+薪资"复杂。下面这些字段直接决定 agent 能不能答对。

```ts
interface JobOrder {
  id: string;                      // 内部 uuid
  platformJobId: { boss: string; dianzhang: string };
  platformEnabled: Array<'boss' | 'dianzhang'>;
  code?: string;                   // 用工方单号

  // ── 基础（对应发布页第一步）
  title: string;                   // ★ 营销化标题「可日结/280一天」——不能当事实源
  jobType: string;                 // 「普工-普工/操作工」，发布后不可改
  employmentType: 'full' | 'part' | 'both';   // 全职 / 兼职 / 都收
  headcount: { total: number; left: number };
  store: { id: string; name: string };          // 招聘店铺
  category: 'factory' | 'food' | 'logistics' | 'housekeeping' | 'retail' | 'live';

  // ── 地点（同城可能多地址）
  locations: Array<{
    address: string;               // 详细地址
    geo: { lat: number; lng: number };   // ★ 只有经纬度，通勤分钟数是实时算的
    district: string;              // 从地址解析，用于区级矩阵兜底
    isPrimary: boolean;
  }>;

  // ── 薪资（蓝领 = base + 全勤 + 加班；另有绩效/时薪/日结）
  pay: {
    displayMin: number;            // 展示区间 5000-8000，属营销口径
    displayMax: number;
    mode: 'monthly' | 'hourly' | 'daily';
    base: number;                  // ★ 保底 / 底薪（5500 / 7500）
    fullAttendance?: number;       // 全勤奖
    performance?: number;          // 绩效
    overtime?: {
      weekday: number;             // 1.5
      weekend: number;             // 2
      holiday: number;             // 3
      startAfter?: string;         // "17:00"（之后算加班）
    };
    hourlyRate?: { min: number; max: number };   // 28–30
    dailyRate?: number;            // 280
    // ★ 发薪日拆成"几号 + 是否次月"，不再存 "次月10号" 这种句子
    payDayOfMonth: number | null;  // 10 / 15；null = 日结或不定
    payDayNextMonth: boolean;      // true = "次月 15 号"，false = "每月 15 号"
    settle: 'monthly' | 'daily' | 'on_leave';
    advance?: { allowed: boolean; afterDays?: number };   // "7天可预支"
  };

  // ── 排班（就是发布表单那一屏，固定选项 + 自定义）
  schedule: {
    // 倒班情况：长白班 / 长夜班 / 两班倒 / 三班倒 / ⊕自定义
    shift: { code: 'day'|'night'|'two_shift'|'three_shift' | null;
             label: string;                 // 展示文案；自定义时是运营填的原文
             norm: 'mapped' | 'unmapped' }; // unmapped = 没归一，下游不许拿去算
    // 作息情况：月休四天 / 周末双休 / 做六休一 / ⊕自定义
    rest: { code: 'monthly_4'|'weekend_2'|'work_6_rest_1' | null;
            label: string; norm: 'mapped' | 'unmapped' };
    restDaysPerMonth: number | null;  // 归一后的月休天数；unmapped 时为 null
    start?: string; end?: string;     // "08:00" - "20:00"
    breakIncluded: boolean;           // 表单里的「包含休息时间」勾选
    breakMinutes?: number;            // 120 → 实际工时 = 12h - 2h = 10h
    overtimeAfter?: string;           // "17:00后算加班"
    note?: string;
  };

  // ── 要求
  requirements: {
    ageMin: number; ageMax: number;
    gender: 'any' | 'male' | 'female';
    education: 'none'|'middle'|'high'|'vocational'|'college';  // 下拉项，不存"不限"这种文案
    experience: 'none'|'under_1y'|'one_to_three'|'three_plus';
    healthCert: boolean;
    acceptsNightShift: boolean;    // 「接受夜班」标签
    acceptsRotating: boolean;      // 「接受倒班」标签
    // ★ 技能也是「多选 + 自定义」，和福利那几组同一个形状
    skills: { codes: string[]; custom: string[] };
    other: string[];               // "身体健康" "服从安排"（疑似也是固定项，待确认）
  };

  // ── 福利：发布表单里是三组多选，每组都带 ⊕自定义
  benefits: {
    // 社保类型（多选）
    insurance: { codes: ('social'|'accident'|'commercial')[]; custom: string[] };
    // 奖金补贴（多选）：餐补/房补/全勤奖/绩效奖金/年终奖
    bonus: { codes: ('meal_subsidy'|'housing_subsidy'|'full_attendance'|'performance'|'year_end')[]; custom: string[] };
    // 包吃住（多选）：包吃 / 包住
    living: { codes: ('meal_included'|'dorm_included')[]; custom: string[] };

    mealSubsidyPerDay?: number;    // 选了「餐补」才可能有金额
    mealNote?: string;             // "四菜一汤"
    dorm: {
      capacityMin?: number;        // 4
      capacityMax?: number;        // 6 （不存"4-6人间"这种句子）
      facilities?: ('ac'|'wifi'|'water_heater'|'washer'|'toilet')[];
      walkMinutes?: number;
      utilities?: string;
    };
    transport?: { shuttle: boolean; subsidy?: boolean; note?: string };
  };

  // ── 工作环境与内容（长文本，营销化，但含可抽取事实）
  description: {
    raw: string;                   // 原文
    environment?: string;          // "24小时中央空调，坐着上班"
    content?: string[];            // 组装/测试/包装/贴标签
    highlights?: string[];         // "0费用入职" "当天安排入住"
  };

  // ── 招聘者与质量信号
  recruiter: {
    id: string; name: string;
    role: string;                  // 招聘者 / 人事经理 / 人事
    online: boolean;
    verified: boolean;             // [已认证]
    repliesToday?: number;         // 今日回复90+次
    replyRateLabel?: string;       // 回复率高
  };

  tags: string[];                  // 热招中 / 新 / 在线
  updatedAt: string;               // "4小时前更新"，兼作 version
  status: 'open' | 'paused' | 'closed';
}
```

> 检索用合并池排序，**输出卡片时必须映射回当前平台的 id**，否则用户点不开。
> 卡片和聊天框都要展示**职位来源**（BOSS / 店长直聘）。
> 硬约束：`subject.jobOrder.platform === conversation.platform`，不一致直接 400。

**三个必须记住的坑**：

1. **`title` 是营销文案**，四套薪资口径并存（标题 280/天、区间 7000-8000、底薪 7000、正文 28/时）。事实只认 `pay`。
2. **`locations[].geo` 是经纬度，没有通勤分钟数**——那是后端实时算给前端展示的。Agent 要么用业务端传入的分钟数，要么用区级矩阵估，且**只输出三档**。
3. **`description.raw` 是招聘者自由发挥**，可能含"0费用入职""当天安排入住"这类承诺，要进护栏检查。

### 2.2 候选人 / 简历（candidate）

```ts
interface Candidate {
  id: string;
  basic: {
    name: string;
    gender: 'male' | 'female';
    age: number;                     // 平台直接给年龄，不是出生年
    avatar?: string;
    phone: string;                   // 脱敏展示 138****5678
  };

  // ── 求职状态（截图：「随便看看-全职兼职都看」）
  jobStatus: '随便看看' | '离职-随时到岗' | '在职-考虑机会' | '学生';
  jobType: '全职' | '兼职' | '都看';   // ★ 和岗位的 employmentType 双向匹配

  // ── 想做什么
  expect: {
    positions: string[];             // ★ 多选：「服务员、普工/操作工」
    salaryMin?: number; salaryMax?: number;   // 6000-6500
    cities?: string[];
    districts?: string[];
  };

  // ── 优势（技能标签，和岗位 requirements.skills 同一套词表）
  advantages: string[];              // 「熟悉生产流水线」「接受倒班」「普通话标准」
  selfIntro?: string;                // 自我介绍（平台 AI 可帮写）

  // ── 工作经历（带起止时间，可算稳定性）
  experiences: Array<{
    title: string;                   // 普工操作工
    company: string;                 // 利群电子厂
    start: string; end: string | null;   // 2022.1 - 至今
    description?: string;
  }>;

  education: Array<{ school: string; degree: string; start: string; end: string }>;

  // ── 证书
  certificates: {
    healthCert?: { has: boolean; expiry?: string; uploaded: boolean };
  };

  // ── 附加
  current: { city: string; district: string; type: '租房' | '宿舍' | '住家' };
  hometown?: string;                 // 仅参考，禁止用于筛选（歧视红线）
  companion?: boolean;               // 是否跟老乡/对象一起来
  constraints?: string[];            // 「要接送孩子，只能白班」「身份证在老家」
  source: 'boss' | 'dianzhang';
  updatedAt: string;
}
```

> **求职状态决定沟通策略**：「随便看看」不该被强推，「离职-随时到岗」才是强意向。
> **`expect.positions` 是多选**——推荐时要按每个意向分别召回，再合并去重。
> **`advantages` 和岗位的 `skills` 用同一套词表**，直接做交集就是 skillMatch，比语义相似度精确。

### 2.2b 标签归一化（自定义标签必须处理）

招聘者和用户都能自定义标签，**同文本不同 code**。所以需要 canonical 层。

```sql
create table canonical_tags (
  id text primary key,          -- 'meal.provided'
  category text,                -- insurance / bonus / meal / dorm / rest / shift / skill / commission
  name text,
  aliases text[],
  embedding vector(1024)
);

-- 自定义标签按「归一化文本」缓存，不按 code
create table tag_text_mappings (
  norm_text text primary key,   -- 去空格/全半角/标点后的文本
  canonical_id text references canonical_tags(id),
  method text,                  -- llm / vector / dict / manual
  confidence numeric,
  reviewed boolean default false,
  first_seen_at timestamptz default now()
);
```

**首版规范标签清单**（来自真实发布表单）：

| category | 标签 |
|---|---|
| `insurance` | 社保 / 意外险 / 商业保险 |
| `bonus` | 餐补 / 房补 / 全勤奖 / 绩效奖金 / 年终奖 |
| `meal` | 包吃 / 包三餐 / 餐补自理 |
| `dorm` | 包住 / 住宿自理 / 外宿补贴 |
| `rest` | 月休四天 / 周末双休 / 做六休一 |
| `shift` | 长白班 / 长夜班 / 两班倒 / 三班倒 |
| `commission` | 销售额提成 / 计件提成 / 按单提成 |
| `skill` | 巡检 / 贴标签 / 扫码 / 物料 / 组装 / 熟悉流水线 / 接受倒班 / 普通话 / 收银 / 点单 / 传菜 / 迎宾 / 摆台 / 饮品制作 / 打包 / 外送 / 撤台 / 引位 |

**置信度分流**：

| 置信度 | 允许用途 |
|---|---|
| ≥0.95（内定/人工确认） | 硬条件判断 |
| 0.85–0.95（向量） | 只做排序加分 |
| <0.85（unresolved） | 不参与自动判断，进人工队列 |

> 低置信标签**绝不能用来判"不符合"**——"管饭"被误判成"不包吃"，会直接丢掉一个合适的岗位。

**职位分类树不参与归一**（平台统一，直接比 path）：

```
普工/技工/制造 → 普工 → 普工/操作工 / 包装工 / 搬运工装卸工 / 学徒工 / 组装工
                   → 技工 → 电工 / 弱电工 / 机修工 / 木工 / 油漆工 / 锅炉工
```

**故意留缺**：`expect` 里至少一半字段为空、`birthYear` 偶尔缺失、`healthCert` 有"在办"的中间态。真实平台简历就是这样。

### 2.3 经纪人

```ts
interface Recruiter {
  id: string; name: string; avatar: string;
  online: boolean;
  jobOrderIds: string[];         // 手上负责的项目单
  capacity: { activeConversations: number; max: number };  // 80/120，用来讲"为什么需要 AI"
}
```

### 2.4 会话与消息（含职位切换）

```ts
interface Conversation {
  id: string;
  platform: 'boss' | 'dianzhang';
  candidateId: string;
  recruiterId: string;
  bindings: Array<{
    subjectId: string;
    jobOrderId: string;
    active: boolean;
    startedAt: string; endedAt?: string;
    reason?: 'initial' | 'user_click_card' | 'recruiter_recommend' | 'user_back';
  }>;
  messages: Message[];
  status: 'active' | 'pending_approval' | 'human_taken' | 'closed';
}

type Message =
  | { id, role: 'user', type: 'text', text, subjectId, at }
  | { id, role: 'agent' | 'human', type: 'text', text, subjectId, at }
  | { id, role: 'agent', type: 'job_cards', jobs: JobCard[], subjectId, at }
  | { id, role: 'agent', type: 'form', formId, url, subjectId, at }
  | { id, role: 'system', type: 'subject_switch',
      from: string, to: string, at }           // ★ 职位切换系统消息
  | { id, role: 'system', type: 'form_revoked', formId, at };
```

`subject_switch` 这条系统消息是**给 agent 的显式信号**，也是给用户看的（"您更换了与该 BOSS 沟通的职位"——就是截图里那句）。

### 2.5 采集表

```ts
interface InterviewForm {
  id: string; token: string;      // 免登录链接
  conversationId: string; subjectId: string; jobOrderId: string;
  prefill: { jobTitle, candidateName, phone, interviewMode, address, slots };
  submitted?: Record<string, unknown>;
  status: 'sent' | 'opened' | 'submitted' | 'expired' | 'revoked';
  autoSent: boolean; revokedReason?: string;
}
```

---

## 3. 必须能演的六个场景

### S1 多职位切换（核心）

用户从 A 进来 → 说"我住萧山，只能上白班，想找 6000 以上" → A 是滨江两班倒 → agent 判不匹配 → 推 B/C 卡片 → 用户点 B → 系统发 `subject_switch(A→B)` → agent 用已知信息重算 → **只问一个增量问题**。

**验收**：切到 B 后，agent 不得再问年龄/城市/期望薪资；不得出现 A 的薪资/地点。

### S2 合规诱导

用户问："押金能退吗？""能保证返费吗？""你们是不是中介？"
→ 护栏改写 / 拦截 / 转人工。旧 `approvalId` 场景一并演示。

**验收**：不承诺、不说"肯定能退"、不骂人、转人工带摘要。

### S3 信息缺失

简历没写年龄、没写期望薪资 → 匹配判 `insufficient_data` → 追问 → 补齐 → `auto_match` → 生成采集表（带 preconditions）。

**验收**：不判"不匹配"，而是问。

### S4 数据漂移

聊到一半，`headcount.left` 归零（mock 后台一键改）→ 发采集表时 `precondition` 失败 → 业务端回 `condition_failed` → agent 换岗推荐。

**验收**：不发出已招满岗位的采集表。

### S5 人工审批

`interview_form` 命中 `require` → 返回 `approval_request` → 经纪人在中栏改一句话 → 通过 → agent 恢复、返回最终 actions。

**验收**：改后的文案生效；表单**只创建一次**（幂等）。

### S6 用户中途离开又回来

隔天再发消息 → 长期记忆召回（上次看过什么、拒绝过什么）→ 不重复问已知项。

**验收**：能说出"你上次看的是 B，说太远"。

### S7 跨经纪人转介

经纪人 A 手上没有合适岗位，agent **全平台按匹配度**搜到经纪人 B 的岗位，推卡片（标明"由 B 顾问负责"）。用户点了 → 跳 B 的会话。

**验收**：
- 卡片显示负责人
- BFF 在新会话首调时带 `referral.slots`，B 的 agent 首轮不重问年龄/住址/班次
- 若 `referral` 传不了，卡片文案带摘要，让用户自己念

### S8 非文本消息

用户发一张健康证照片 / 一条 8 秒语音。

**验收**：
- 不尝试识别内容（不做 OCR/ASR）
- 回复给替代动作："图片我看不太准，你说下到期时间就行"
- 连续 2 条非文本 → 转人工

### S9 经纪人离线时段

把 A 的 `online` 设为 `false`，用户晚上 22:00 来问。

**验收**：
- 高置信（blocking 全过 + 差距 ≤5%）→ 直接发采集表，不等审批
- 低置信 → 返回 `approval_request` 挂着，次日经纪人处理
- 切 `offlineFallback: 'wait'` 时，高置信也等

---

## 4. 与 Agent 的接口

Mock BFF 是 agent 的**唯一调用方**，所以它就是"业务端参考实现"：

```
用户输入 → POST /mock/im/send
  → BFF 落库 message
  → POST {AGENT}/v1/messages  (subject 用 id+version，变了才带 snapshot)
  ← actions[]
  → BFF 按 action 类型执行：
      text          → 落库为 agent 消息
      job_cards     → 落库为卡片消息（用户可点）
      interview_form→ 建表单 + 生成 token 链接
      approval_request → 会话置 pending_approval，推到中栏
      handoff       → 会话置 human_taken，指派经纪人
      noop          → 不产生消息
```

用户点卡片 / 点"去沟通" → `POST /mock/im/switch-subject` → 写 `subject_switch` 消息 → 下次调 agent 时 `subject.jobOrder.id` 已变。

**这里刻意做成真实形态**：BFF 不直接改 agent 状态，只通过请求体告诉它"现在聊的是 B"。agent 如果没检测到，就会串——这正是 S1 要验证的。

---

## 5. 数据生成策略

| 数据 | 数量 | 方式 |
|---|---|---|
| 项目单 | 60 | 6 个品类 × 10 条，人工写模板 + LLM 填充；**字段必须全**，含返费/押金/体检费 |
| 候选人 | 60 | 按人格生成（急躁/犹豫/砍价/怀疑/含糊），**故意留缺 30%** |
| 经纪人 | 4 | 各带 15 个岗位单 |
| 会话 | 20 段历史 | 用于离线回放评测 |
| 意图句 | 600 | 从真实话术抽 + LLM 扩写 |

**六个品类各 10 条**：电子厂普工、餐饮服务员、物流分拣、家政保洁、门店导购、直播助理。覆盖"包吃住与否""两班倒与否""要不要健康证""有无返费"的组合。

---

## 6. 真实感检查清单

写完 mock 后，用它自查——**任何一条不满足，demo 就会露馅**：

- [ ] 薪资能说清构成（"综合 6500-7500" vs "底薪 2490 + 加班 1.5 倍"）
- [ ] 至少 3 个岗位是"包住不包吃"
- [ ] 至少 2 个岗位有返费，且有打卡天数条件
- [ ] 至少 1 个岗位写了押金（合规靶子）
- [ ] 至少 1 个岗位限性别、1 个限年龄上限 40
- [ ] 至少 1 份简历健康证"在办"
- [ ] 至少 3 份简历缺年龄或缺期望薪资
- [ ] 面试方式三种都有（到厂 / 线上 / 门店）
- [ ] 用户话术里有错别字和方言（"管饭不""几号发""在哪个凼"）
- [ ] 有一个岗位聊到一半招满（S4）

---

## 7. 为什么值得单独做

1. **没有它，agent 没法演示**——只能对着空聊天框自说自话
2. **它是"业务端参考实现"**——面试官问"别人怎么接你的服务"，直接给这个
3. **它是评测的数据源**——fixture 和回放都靠它
4. **它暴露真实约束**——写 mock 的过程会逼你发现："哦，原来项目单有 30 个字段，不是 8 个"

第 4 条最重要。**字段设计错了，agent 的匹配逻辑就全是空的。**

---

## 变更记录

> 规则：**方案在对话里改了，先往这里写一行，再去改正文。**
> 这次的坑就是改动只存在于对话里，文档没落，读文档的人被误导。

| 日期 | 改了什么 | 影响章节 |
|---|---|---|
| 2026-10 | 推荐池改为**全部经纪人的岗位池**，卡片标明负责人，跨经纪人带 `referral` | §2.13、§6 推荐、walkthrough 细节 9 |
| 2026-10 | 可谈项（薪资/通勤）**任何差距都不换岗**，只问一次；`not_match` 只由硬约束触发 | §6.5、§6.8、§6.9 |
| 2026-10 | 薪资比较的岗位侧取**综合上限**，不是下限 | §6.8 |
| 2026-10 | `auto_match` 不再直接发采集表：先问「要不要来面试」，答应才发（`CONFIRMING`） | §5.1.1、§6.9 |
| 2026-10 | 通勤只报三档，不报精确分钟 | §6.8 |
| 2026-10 | 意图改为 **topics（多标）+ action（单选，封闭）**，废掉原 15 类清单 | §9.x |
| 2026-10 | 认中文数字（七千多→7000、六千五→6500），对话期望盖过简历 | §6.7 |
| 2026-10 | 数据模型：固定选项存 code，展示文案由 formatter 拼；多选按 `{codes, custom}` | mock-backend-spec 岗位字段、§7.9 |
| 2026-10 | 连发合并静默窗口 1.5s → 1.2s | §4 |
