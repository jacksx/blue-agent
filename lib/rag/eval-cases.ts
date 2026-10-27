/**
 * RAG 评测集（小但可解释）。
 *
 * 正例：query → 应该命中的 chunk（允许多个可接受答案，如"面试带什么"
 *       既是面试流程也是入职材料）。
 * 负例：知识库外的问题，必须拒答。**拒答率比召回率更值得盯**——
 *       答错一条政策比不答贵得多。
 *
 * 题集是代码，进 git；改题就要走 diff，和回归集同一套纪律。
 */

export interface RagEvalCase {
  id: string;
  query: string;
  /** 命中任意一个就算 recall 记一分；MRR 取第一个命中的名次 */
  expectIds: string[];
  shouldRefuse?: boolean;
}

export const RAG_CASES: RagEvalCase[] = [
  { id: 'fee-exam', query: '体检费谁出', expectIds: ['health.exam_fee'] },
  { id: 'fee-exam-2', query: '入职体检多少钱', expectIds: ['health.exam_fee'] },
  { id: 'health-cert', query: '健康证过期了怎么办', expectIds: ['health.certificate'] },
  { id: 'health-items', query: '体检都查什么', expectIds: ['health.exam_items'] },
  { id: 'onboard-materials', query: '入职要带什么材料', expectIds: ['onboarding.materials'] },
  { id: 'contract-sign', query: '什么时候签合同', expectIds: ['onboarding.contract'] },
  { id: 'probation', query: '试用期多久', expectIds: ['onboarding.contract'] },
  { id: 'deposit', query: '收押金吗', expectIds: ['fees.no_deposit'] },
  { id: 'uniform-fee', query: '要交服装费吗', expectIds: ['fees.no_deposit'] },
  { id: 'dorm-room', query: '宿舍几人间', expectIds: ['accommodation.dorm'] },
  { id: 'couple-room', query: '有夫妻房吗', expectIds: ['accommodation.couple'] },
  { id: 'outside-subsidy', query: '不住宿舍有补贴吗', expectIds: ['accommodation.outside'] },
  { id: 'canteen', query: '食堂吃饭贵吗', expectIds: ['meal.canteen'] },
  { id: 'meal-subsidy', query: '有餐补吗', expectIds: ['meal.canteen'] },
  { id: 'night-pay', query: '夜班补贴多少', expectIds: ['shift.night'] },
  { id: 'social-insurance', query: '社保什么时候交', expectIds: ['insurance.social'] },
  { id: 'leave', query: '请假怎么请', expectIds: ['attendance.leave'] },
  { id: 'late', query: '迟到扣钱吗', expectIds: ['attendance.late'] },
  { id: 'resign', query: '离职提前多久说', expectIds: ['settlement.leave'] },
  { id: 'payday', query: '工资几号发', expectIds: ['settlement.payday'] },
  { id: 'advance', query: '能预支工资吗', expectIds: ['settlement.advance'] },
  { id: 'overtime-pay', query: '加班费怎么算', expectIds: ['settlement.overtime_pay'] },
  {
    id: 'interview-what',
    query: '面试带什么',
    expectIds: ['interview.process', 'onboarding.materials'],
  },
  { id: 'interview-where', query: '面试地址在哪', expectIds: ['interview.location'] },
  { id: 'age', query: '年龄有要求吗', expectIds: ['eligibility.age'] },
  { id: 'student', query: '学生能做暑假工吗', expectIds: ['eligibility.student'] },
  { id: 'referral', query: '推荐朋友有奖励吗', expectIds: ['misc.referral'] },
  { id: 'report', query: '遇到收费怎么举报', expectIds: ['platform.report'] },
  { id: 'wechat', query: '加微信安全吗', expectIds: ['platform.wechat'] },
  { id: 'withhold', query: '工资会压吗', expectIds: ['settlement.payday'] },

  // ── 负例：知识库外，必须拒答 ──────────────────────────────
  { id: 'neg-weather', query: '今天天气怎么样', expectIds: [], shouldRefuse: true },
  { id: 'neg-robot', query: '你是机器人吗', expectIds: [], shouldRefuse: true },
  { id: 'neg-joke', query: '给我讲个笑话', expectIds: [], shouldRefuse: true },
  { id: 'neg-code', query: '帮我写一段代码', expectIds: [], shouldRefuse: true },
  { id: 'neg-homework', query: '我儿子作业不会做', expectIds: [], shouldRefuse: true },
  { id: 'neg-boss', query: '你们老板叫什么名字', expectIds: [], shouldRefuse: true },
  { id: 'neg-stock', query: '股票怎么买', expectIds: [], shouldRefuse: true },
  { id: 'neg-movie', query: '推荐一部电影', expectIds: [], shouldRefuse: true },
];
