import type { ConversationState, Decision } from '@/lib/agent/types';

/**
 * 回归集。
 *
 * 目标不是"覆盖所有分支"，而是**锁住已经被推翻过的错误**。
 * 每条 case 都对应一次真实的产品判断，改坏了就报红：
 *   - 首轮不报价、不推卡     ← 用户反馈"回一大堆无关信息"
 *   - 表要在意向确认之后才发 ← 用户反馈"直接糊一张表"
 *   - 硬门槛优先于薪资       ← 班次不确认，谈钱没意义
 */

export interface EvalStep {
  jobId: string;
  candidateId: string;
  text: string;
}

export interface EvalExpect {
  decision?: Decision;
  state?: ConversationState;
  includes?: string[];
  /** 命中任意一个即可。措辞归模型，断言别锁字面 */
  includesAny?: string[];
  excludes?: string[];
  hasForm?: boolean;
  hasCards?: boolean;
}

export interface EvalCase {
  id: string;
  desc: string;
  steps: EvalStep[];
  expect: EvalExpect;
  /**
   * 只有接了模型才跑得通的说法（口语、绕弯、没有关键词）。
   * 没配 key 时跳过而不是失败——规则版做不到这些，本来也不该假装做到。
   */
  requiresModel?: boolean;
}

const Z = 'cand-zhangwei';
const L = 'cand-liguifang';
const W = 'cand-wangqiang';

export const EVAL_CASES: EvalCase[] = [
  {
    id: 'first-turn-answers-only',
    desc: '首轮只回答问的那句：不报价、不推卡',
    steps: [{ jobId: 'job-a', candidateId: Z, text: '还招人吗' }],
    expect: { hasCards: false, includesAny: ['还招人', '还在招', '在招人'], excludes: ['保底'] },
  },
  {
    id: 'ask-before-form',
    desc: '条件都对了，也要先问来不来，不直接发采集表',
    steps: [
      { jobId: 'job-a', candidateId: Z, text: '还招人吗' },
      { jobId: 'job-a', candidateId: Z, text: '能接受' },
    ],
    expect: { state: 'CONFIRMING', hasForm: false, includes: ['要不要来面试'] },
  },
  {
    id: 'form-after-confirm',
    desc: '他说可以，才发采集表',
    steps: [
      { jobId: 'job-a', candidateId: Z, text: '还招人吗' },
      { jobId: 'job-a', candidateId: Z, text: '能接受' },
      { jobId: 'job-a', candidateId: Z, text: '可以' },
    ],
    expect: { state: 'FORM_SENT', hasForm: true },
  },
  {
    id: 'clean-match-offers-first',
    desc: '条件全对的人，第一句就问面试意向',
    steps: [{ jobId: 'job-b', candidateId: L, text: '还招人吗' }],
    expect: { state: 'CONFIRMING', hasForm: false, includes: ['要不要来面试'] },
  },
  {
    id: 'hard-gate-before-salary',
    desc: '两班倒还没确认，不谈钱',
    steps: [{ jobId: 'job-a', candidateId: W, text: '还招人吗' }],
    expect: { includes: ['两班倒'], excludes: ['综合是'] },
  },
  {
    id: 'salary-probe-no-cards',
    desc: '差 14% 只坦白问一句，不推卡',
    steps: [{ jobId: 'job-c', candidateId: W, text: '还招人吗' }],
    expect: { decision: 'negotiable', hasCards: false, includes: ['差得有点多'] },
  },
  {
    id: 'hard-constraint-pushes-cards',
    desc: '硬约束被违反才推卡',
    steps: [{ jobId: 'job-a', candidateId: Z, text: '我只能上白班，要接孩子' }],
    expect: { decision: 'not_match', hasCards: true },
  },
  {
    id: 'carry-constraint-across-jobs',
    desc: '跨岗位沿用旧约束，并点明一句',
    steps: [
      { jobId: 'job-a', candidateId: Z, text: '我只能上白班，要接孩子' },
      { jobId: 'job-b', candidateId: Z, text: '还招人吗' },
    ],
    expect: { includes: ['之前说的'] },
  },
  {
    id: 'no-offsite-contact',
    desc: '不报微信号，给站内路径',
    steps: [{ jobId: 'job-a', candidateId: Z, text: '加个微信吧' }],
    expect: { includes: ['平台上'], excludes: ['微信号是'] },
  },
  {
    id: 'no-nag-after-hesitate',
    desc: '问过一次没答应，就不再追着问',
    steps: [
      { jobId: 'job-a', candidateId: Z, text: '还招人吗' },
      { jobId: 'job-a', candidateId: Z, text: '能接受' },
      { jobId: 'job-a', candidateId: Z, text: '再想想' },
    ],
    expect: { excludes: ['要不要来面试'], hasForm: false },
  },
  {
    id: 'decline-interview-no-nag',
    desc: '明确说不去，不重问也不推卡',
    steps: [
      { jobId: 'job-b', candidateId: L, text: '还招人吗' },
      { jobId: 'job-b', candidateId: L, text: '不去了' },
    ],
    expect: { excludes: ['要不要来面试'], hasCards: false },
  },
  {
    id: 'user-asks-other-jobs',
    desc: '用户主动要，才给卡片',
    steps: [{ jobId: 'job-a', candidateId: Z, text: '还有别的吗' }],
    expect: { hasCards: true },
  },
  {
    id: 'salary-change-reevaluates',
    desc: '改口说更高薪资，要重新判一遍并按新数字算',
    steps: [
      { jobId: 'job-a', candidateId: Z, text: '一个月六千就行' },
      { jobId: 'job-a', candidateId: Z, text: '不过得七千多我才去' },
    ],
    // 6000 原本落在 5000-6500 内，改成 7000 之后必须变成可谈
    expect: { decision: 'negotiable', includesAny: ['7000'] },
  },
  {
    id: 'salary-question-keeps-composition',
    desc: '问薪资要连构成一起说，不能只报区间',
    steps: [{ jobId: 'job-a', candidateId: Z, text: '多少钱一个月' }],
    expect: { includes: ['保底', '全勤', '综合'] },
  },

  {
    id: 'chat-salary-overrides-resume',
    desc: '对话里说的薪资要盖过简历，中文数字也算',
    steps: [{ jobId: 'job-a', candidateId: Z, text: '一个月得七千多我才去' }],
    // 简历写 6000，他说七千多 → 必须判成可谈，不能当作匹配
    expect: { decision: 'negotiable' },
  },
  {
    id: 'interview-question-answered',
    desc: '问面试要给地点和带什么，不能答非所问',
    steps: [{ jobId: 'job-a', candidateId: Z, text: '什么时候能面试' }],
    expect: { includesAny: ['身份证', '面试地点', '到厂'] },
  },

  {
    id: 'policy-question-answered',
    desc: '岗位单里没有的政策问题（体检费）要走知识库答，不能装作没看见',
    steps: [{ jobId: 'job-a', candidateId: Z, text: '体检费谁出' }],
    expect: { includesAny: ['体检', '报销'], hasForm: false },
  },
  {
    id: 'policy-refuses-offtopic',
    desc: '知识库外的问题要拒答，不能硬编一条政策',
    steps: [{ jobId: 'job-a', candidateId: Z, text: '今天天气怎么样' }],
    expect: { excludes: ['体检', '报销', '押金'], hasForm: false },
  },

  // ── 下面这些规则版做不了：说法里没有关键词，得靠模型理解 ──
  {
    id: 'unclear-gets-acknowledged',
    desc: '答应了的事要接住，听不懂的事要承认，不能装作答完了',
    requiresModel: true,
    steps: [{ jobId: 'job-a', candidateId: Z, text: '我媳妇也在找活儿，你们一起招吗' }],
    expect: { includesAny: ['不太确定', '同事'] },
  },
  {
    id: 'paraphrase-still-hiring',
    desc: '「现在还要人不」= 问还招不招',
    requiresModel: true,
    steps: [{ jobId: 'job-a', candidateId: Z, text: '你们那边现在还要人不' }],
    expect: { includesAny: ['还招人', '还在招', '在招人'] },
  },
  {
    id: 'paraphrase-kid-pickup',
    desc: '「娃五点半放学」= 只能上白班，硬约束',
    requiresModel: true,
    steps: [{ jobId: 'job-a', candidateId: Z, text: '我娃下午五点半放学得去接，晚上回不来' }],
    expect: { decision: 'not_match', hasCards: true },
  },
  {
    id: 'paraphrase-pay-range',
    desc: '「到手能有五千大几不」要按薪资问题回答，且必须带构成',
    requiresModel: true,
    steps: [{ jobId: 'job-a', candidateId: Z, text: '一个月到手能有五千大几不' }],
    expect: { includes: ['保底', '综合'] },
  },
  {
    id: 'paraphrase-too-far',
    desc: '「太远了算了」= 用户主动要别的岗位',
    requiresModel: true,
    steps: [{ jobId: 'job-c', candidateId: Z, text: '那边太远了我跑不动，算了' }],
    expect: { hasCards: true },
  },
];
