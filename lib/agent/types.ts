// ─────────────────────────────────────────────────────────────
// 契约类型：前后端共用同一份（Playground 与服务端都 import 这里）
// ─────────────────────────────────────────────────────────────

export type Platform = 'boss' | 'dianzhang';
export type Locale = 'zh-CN';

/**
 * 用户想干什么。封闭枚举——它出现在流程分支里，模型不能自由编。
 * 「在问什么」用 topics 表达，那个是可扩展的。
 */
export type IntentAction = 'ask' | 'want_other' | 'reject' | 'accept' | 'none';

/** 一条消息的模型用量。成本按账号报价算，没配价格就只报 token */
export interface LlmMeter {
  promptTokens: number;
  completionTokens: number;
  /** 模型调用次数（理解 + 措辞） */
  calls: number;
  /** 重试次数（>0 说明上游抖过） */
  retries: number;
  costCny?: number;
}

// ── 岗位 ─────────────────────────────────────────────────────

/**
 * 发布表单里「枚举 + 自定义」的通用形状。
 *
 *   code 有值 → 已归一，可以参与判定/排序/换算
 *   norm = 'unmapped' → 运营填了自定义，只有原文，**不许拿去算**
 *
 * 这条约束很硬：没有归一的信息只能展示，不能拿来判"合适/不合适"。
 */
export interface Choice<T extends string> {
  code: T | null;
  /** 展示文案；自定义时就是运营填的原文 */
  label: string;
  norm: 'mapped' | 'unmapped';
}

/** 倒班情况（对应表单的四个选项） */
export type ShiftCode = 'day' | 'night' | 'two_shift' | 'three_shift';

/** 作息情况（对应表单的三个选项） */
export type RestCode = 'monthly_4' | 'weekend_2' | 'work_6_rest_1';

/**
 * 工作时间。字段形状直接照着发布表单来：
 *
 *   作息时间   [上班] - [下班]   ☑ 包含休息时间
 *   作息情况   月休四天 / 周末双休 / 做六休一 / ⊕自定义
 *   倒班情况   长白班 / 长夜班 / 两班倒 / 三班倒 / ⊕自定义
 */
export interface Schedule {
  shift: Choice<ShiftCode>;
  rest: Choice<RestCode>;
  /**
   * 归一后的月休天数。"月休四天" 和 "做六休一" 都归到 4。
   * 自定义且识别不出来时是 null —— 下游必须跳过这个维度，不许猜。
   */
  restDaysPerMonth: number | null;
  start?: string;
  end?: string;
  /** 表单里的「包含休息时间」勾选，直接决定实际工时怎么算 */
  breakIncluded: boolean;
  breakMinutes?: number;
  overtimeAfter?: string;
}

/** 行政区划码。判定和通勤矩阵都用它，区名只做展示 */
export interface District {
  code: string;
  name: string;
}

/** 岗位类别（发布表单里的固定选项） */
export type PositionCode = 'operator' | 'packer' | 'waiter' | 'cashier';

/** 技能项，表单里是多选，不是自由输入 */
export type SkillCode =
  | 'line'
  | 'assembly'
  | 'scan'
  | 'pack'
  | 'inspect'
  | 'order'
  | 'serve'
  | 'greet'
  | 'cashier';

/** 社保类型（表单：多选） */
export type InsuranceCode = 'social' | 'accident' | 'commercial';

/** 奖金补贴（表单：多选） */
export type BonusCode =
  | 'meal_subsidy'
  | 'housing_subsidy'
  | 'full_attendance'
  | 'performance'
  | 'year_end';

/** 包吃住（表单：多选） */
export type LivingCode = 'meal_included' | 'dorm_included';

/**
 * 多选 + 自定义。
 *
 * 真实表单每一组都有「⊕自定义」，所以形状必须是"命中的 code 集合 + 自定义原文"，
 * 而不是给每个属性一个 boolean——那样每加一项都要改表结构。
 */
export interface MultiChoice<T extends string> {
  codes: T[];
  custom: string[];
}

export interface Benefits {
  insurance: MultiChoice<InsuranceCode>;
  bonus: MultiChoice<BonusCode>;
  living: MultiChoice<LivingCode>;

  /** 选了「餐补」才可能有金额；金额是附加参数，不是"有没有餐补"的事实源 */
  mealSubsidyPerDay?: number;
  mealNote?: string;

  dorm: {
    /** 几人间：给范围，不给"6-8 人间"这种句子 */
    capacityMin?: number;
    capacityMax?: number;
    facilities?: FacilityCode[];
    walkMinutes?: number;
  };
}

/** 宿舍设施，表单里是勾选 */
export type FacilityCode = 'ac' | 'wifi' | 'water_heater' | 'washer' | 'toilet';

/** 学历要求，表单里是下拉 */
export type EducationCode = 'none' | 'middle' | 'high' | 'vocational' | 'college';

/** 经验要求，表单里是下拉 */
export type ExperienceCode = 'none' | 'under_1y' | 'one_to_three' | 'three_plus';

export interface JobOrder {
  id: string;
  /** 两个平台 id 不同，但岗位是同一批 */
  platformJobId: Record<Platform, string>;
  platformEnabled: Platform[];

  /** 营销化标题，绝不作为事实来源 */
  title: string;
  /** 岗位名（结构化字段，采集表上写这个） */
  positionName: string;
  /** 岗位类别 code，匹配和召回都用它 */
  positionCode: PositionCode;
  /** 展示用的完整分类串，别拿来解析 */
  jobType: string;
  employmentType: 'full' | 'part' | 'both';
  headcount: { total: number; left: number };
  store: { id: string; name: string };
  category: string;

  locations: Array<{
    address: string;
    geo: { lat: number; lng: number };
    district: District;
    isPrimary: boolean;
    /** 业务端实时算好传过来的通勤分钟数；没有则走区级矩阵兜底 */
    commuteMinutes?: number;
  }>;

  pay: {
    displayMin: number;
    displayMax: number;
    mode: 'monthly' | 'hourly' | 'daily';
    base: number;
    fullAttendance?: number;
    performance?: number;
    overtime?: {
      weekday: number;
      weekend: number;
      holiday: number;
      startAfter?: string;
    };
    hourlyRate?: { min: number; max: number };
    dailyRate?: number;
    /** 发薪日：每月几号；null 表示日结/不定 */
    payDayOfMonth: number | null;
    /** 是否次月发（"次月 15 号" vs "每月 15 号"） */
    payDayNextMonth: boolean;
    /** 结算方式 code */
    settle: 'monthly' | 'daily' | 'on_leave';
    advance?: { allowed: boolean; afterDays?: number };
  };

  schedule: Schedule;

  requirements: {
    ageMin: number;
    ageMax: number;
    gender: 'any' | 'male' | 'female';
    education: EducationCode;
    experience: ExperienceCode;
    healthCert: boolean;
    acceptsNightShift: boolean;
    acceptsRotating: boolean;
    /** 技能也是多选 + 自定义：固定选项给 code，自定义给原文 */
    skills: MultiChoice<SkillCode>;
    other: string[];
  };

  benefits: Benefits;

  description: {
    raw: string;
    environment?: string;
    content?: string[];
    highlights?: string[];
  };

  recruiter: {
    id: string;
    name: string;
    role: string;
    online: boolean;
    verified: boolean;
    repliesToday?: number;
    /** 回复率 0-1，标签由展示层按阈值算 */
    replyRate?: number;
  };

  tags: string[];
  updatedAt: string;
  status: 'open' | 'paused' | 'closed';
}

// ── 候选人 ───────────────────────────────────────────────────

export interface Candidate {
  id: string;
  basic: { name: string; gender: 'male' | 'female'; age: number; phone: string };
  jobStatus: '随便看看' | '离职-随时到岗' | '在职-考虑机会' | '学生';
  jobType: '全职' | '兼职' | '都看';
  expect: {
    /** 期望岗位类别 code，和岗位用同一套 */
    positionCodes: PositionCode[];
    salaryMin?: number;
    salaryMax?: number;
  };
  /** 技能，和岗位用同一套选项；自定义部分只能原文比对 */
  skills: MultiChoice<SkillCode>;
  /** 简历里的自述，只做展示，不参与匹配 */
  advantages: string[];
  experiences: Array<{ title: string; company: string; start: string; end: string | null }>;
  education: Array<{ school: string; degree: string; start: string; end: string }>;
  certificates: { healthCert?: { has: boolean; expiry?: string; uploaded: boolean } };
  current: { city: string; district: District };
  constraints?: string[];
  updatedAt: string;
}

// ── 槽位 ─────────────────────────────────────────────────────

export type SlotStrength = 'hard' | 'strong' | 'soft';
export type SlotState = 'fresh' | 'stale' | 'expired' | 'conflicted';

export interface Slot {
  value: string | number | boolean | number[] | null;
  /** 比 value 更值钱：为什么 */
  reason?: string;
  strength: SlotStrength;
  source: 'resume' | 'chat' | 'inferred';
  evidence?: string;
  assertedAt: string;
  ttlDays?: number;
  state: SlotState;
  /** 采集载体 */
  carrier: 'resume' | 'chat' | 'form';
  /**
   * 作用域。person = 跨职位稳定（年龄、只能白班）；subject = 只对某个岗位成立
   * （"这个岗位的夜班我能接受"不等于"我能接受夜班"）。
   */
  scope?: 'person' | 'subject';
  /** scope=subject 时绑定哪个岗位；换岗位后这条不参与判定 */
  jobOrderId?: string;
}

export type SlotMap = Record<string, Slot>;

// ── 匹配 ─────────────────────────────────────────────────────

export type Decision =
  | 'insufficient_data'
  | 'not_match'
  | 'negotiable'
  | 'auto_match'
  | 'suggest';

export interface BlockingCheck {
  field: string;
  required: string;
  actual: string | null;
  /** null = 数据缺失 */
  pass: boolean | null;
  evidence?: string;
}

export interface NegotiableCheck {
  field: string;
  expected: string;
  actual: string;
  gapPct?: number;
  verdict: 'ok' | 'probe' | 'reject';
  /**
   * true = 用户自己提的硬约束被违反（班次冲突等），可据此否岗。
   * 薪资/通勤这类不设 true：岗位是用户自己点进来的，不该被 agent 赶走。
   */
  hard?: boolean;
  note?: string;
}

/** 判断所需、但简历里没有、只能对话里问的信息 */
export interface OpenQuestion {
  field: string;
  question: string;
}

export interface PrefCheck {
  field: string;
  expected: string;
  satisfied: boolean;
}

export interface Precondition {
  field: string;
  label: string;
  satisfied: boolean;
  note?: string;
}

export interface MatchAssessment {
  decision: Decision;
  score: number;
  blocking: BlockingCheck[];
  negotiable: NegotiableCheck[];
  preferences: PrefCheck[];
  preconditions: Precondition[];
  missing: string[];
  /**
   * 还缺的判断依据（简历给不了、只能问）。
   * 非空时不许发采集表——表是收集信息的，不是替代判断的。
   */
  openQuestions: OpenQuestion[];
  probe?: { question: string; compensating?: string };
  reasons: string[];
}

// ── 动作与响应 ───────────────────────────────────────────────

export interface JobCard {
  jobOrderId: string;
  /** 必须映射回**当前平台**的 id，否则用户点不开（§2.15） */
  platformJobId: string;
  /** 卡片要标来源，跨平台时用户才知道自己在哪 */
  platform: Platform;
  platformLabel: string;
  title: string;
  salaryText: string;
  tags: string[];
  district: string;
  commuteLabel?: string;
  /** 岗位归属的顾问。跨经纪人推荐时必须显示，否则用户以为还是同一个人 */
  recruiterName?: string;
  reason: string;
}

/**
 * 审批策略按**动作**配，不是一个全局开关（§2.5）。
 * 数字 = 灰度比例：0.9 表示 90% 走审批，退坡就是把它调到 1。
 */
export type ApprovalMode = 'auto' | 'require' | number;

export interface ApprovalPolicy {
  default: 'auto' | 'require';
  overrides?: Partial<Record<AgentAction['type'], ApprovalMode>>;
  /**
   * 经纪人离线时怎么办。蓝领高峰在晚上，离线不能一律等审批，
   * 但也不能全放开——没人兜底，只让高置信走自动。
   */
  offlineFallback?: 'auto_if_confident' | 'wait' | 'auto_always';
  /** 高置信阈值，默认 0.85 */
  confidenceThreshold?: number;
}

export type ApprovalDecision = 'approve' | 'edit' | 'reject';

export interface ApprovalResume {
  approvalId: string;
  decision: ApprovalDecision;
  /** decision=edit 时的新动作；必须至少保留一个非 approval_request 的动作 */
  editedActions?: AgentAction[];
  note?: string;
}

export interface ApprovalInfo {
  approvalId?: string;
  status: 'requested' | 'approved' | 'edited' | 'rejected';
  /** 为什么走到审批：策略命中 / 离线且置信不足 / 灰度命中 */
  reason: string;
  /** 判断依据的完整度，不是模型自评 */
  confidence: number;
  confidenceNotes?: string[];
}

export type AgentAction =
  | { type: 'text'; text: string }
  | { type: 'job_cards'; jobs: JobCard[]; reason: string }
  | {
      type: 'interview_form';
      formId: string;
      url: string;
      prefill: Record<string, string>;
    }
  | { type: 'handoff'; reason: string; summary: string }
  | {
      /** 命中审批点：proposed 是**审批通过后才会执行**的动作，此刻一个都没执行 */
      type: 'approval_request';
      approvalId: string;
      proposed: AgentAction[];
      summary: string;
      reason: string;
    }
  | { type: 'noop' };

export type ConversationState =
  | 'GREETING'
  | 'DISCOVERY'
  | 'COLLECTING'
  | 'MATCHING'
  | 'CONFIRMING'
  | 'PENDING_APPROVAL'
  | 'FORM_SENT'
  | 'TRANSFERRED'
  | 'HANDOFF'
  | 'CLOSED';

export interface IncomingMessage {
  type: 'text' | 'image' | 'voice' | 'file';
  text?: string;
  sentAt: string;
  /** 合并时用来算幂等键；单条消息可不填 */
  messageId?: string;
}

export interface AgentRequest {
  /** 单条消息的幂等键。传 messages[] 时由服务端按 messageId 集合生成 */
  messageId?: string;
  platform: Platform;
  conversationId: string;
  message?: IncomingMessage;
  /** 连发合并：业务端把静默窗口内的多条一起送进来 */
  messages?: IncomingMessage[];
  subject: {
    candidate: { id: string; version: string; snapshot?: Candidate };
    jobOrder: { id: string; version: string; snapshot?: JobOrder };
  };
  recruiter?: { id: string; online: boolean };
  /** 按动作配审批。不传＝全自动（保持 demo 的默认行为） */
  approvalPolicy?: ApprovalPolicy;
  /**
   * 恢复一次中断的审批。这是一次**新的状态推进**，messageId 必须新生成——
   * 不是重试，所以不走普通消息的幂等路径（但同一 messageId 仍然幂等）。
   */
  resume?: ApprovalResume;
  options?: { maxLatencyMs?: number };
}

export interface AgentResponse {
  traceId: string;
  conversationId: string;
  actions: AgentAction[];
  state: ConversationState;
  trace: TraceStep[];
  meta: {
    /** 展示用（topics + action）。判断逻辑一律读 topics / action，别读这个 */
    intent: string[];
    /** 在问什么（字段组） */
    topics: string[];
    /** 想干什么 */
    action: IntentAction;
    intentConfidence: number;
    match?: MatchAssessment;
    escalated: boolean;
    degraded: boolean;
    cached: boolean;
    latencyMs: number;
    model: string;
    promptVersion: string;
    /** 这条回复花了多少 token / 钱 */
    usage?: LlmMeter;
    /** 这条回复合并了哪几条原始消息 */
    mergedFrom?: string[];
    /** 只在这条回复命中审批点、或恢复审批时出现 */
    approval?: ApprovalInfo;
  };
}

export interface TraceStep {
  node: string;
  detail: string;
  ms: number;
}
