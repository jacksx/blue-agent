/**
 * 评测维度。
 *
 * 一个总分会被平均掩盖：意图认错了、合规漏了、匹配判反了，都可能被"总体 85%"盖住。
 * 所以每条 case 归属一个维度，报告里分开看。新增 case 时在这里补一行。
 */
export const DIMENSIONS: Record<string, string> = {
  'first-turn-answers-only': 'flow',
  'ask-before-form': 'flow',
  'form-after-confirm': 'flow',
  'no-nag-after-hesitate': 'flow',
  'decline-interview-no-nag': 'flow',

  'clean-match-offers-first': 'matching',
  'hard-gate-before-salary': 'matching',
  'salary-probe-no-cards': 'matching',
  'hard-constraint-pushes-cards': 'matching',

  'carry-constraint-across-jobs': 'memory',
  'salary-change-reevaluates': 'memory',

  'salary-question-keeps-composition': 'extraction',
  'chat-salary-overrides-resume': 'extraction',

  'policy-question-answered': 'rag',
  'policy-refuses-offtopic': 'rag',

  'interview-question-answered': 'intent',
  'paraphrase-still-hiring': 'intent',
  'paraphrase-kid-pickup': 'intent',
  'paraphrase-pay-range': 'intent',
  'paraphrase-too-far': 'intent',

  'no-offsite-contact': 'compliance',
  'unclear-gets-acknowledged': 'compliance',

  'user-asks-other-jobs': 'recommend',
};

export function dimensionOf(caseId: string): string {
  return DIMENSIONS[caseId] ?? 'flow';
}
