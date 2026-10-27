import type {
  AgentAction,
  AgentRequest,
  AgentResponse,
  ApprovalInfo,
  ApprovalPolicy,
  Candidate,
  ConversationState,
  IntentAction,
  JobOrder,
  MatchAssessment,
  SlotMap,
} from './types';
import { saveConversation } from './store';

/**
 * 人工审批：中断 + 恢复（§2.5）。
 *
 * 关键设计：
 *   1. 审批按**动作**配，不是一个全局 mode。发错一句话无所谓，发错采集表用户白跑。
 *   2. 中断点前面的代码不能有非幂等副作用。所以这里只**提出**动作，不执行；
 *      formId 也由会话 + 岗位 + 轮次决定，恢复多少次都是同一张表。
 *   3. 恢复是新的状态推进，messageId 必须新生成；同一 messageId 仍然幂等。
 *   4. 离线不等于全放开：没人兜底时只让高置信走自动。
 *
 * 置信度来自**证据完整度**（硬条件、可谈项、槽位新鲜度），不是模型自评——
 * 模型自评永远偏高。
 */

const DEFAULT_POLICY: ApprovalPolicy = {
  default: 'auto',
  overrides: { interview_form: 'require' },
  offlineFallback: 'auto_if_confident',
  confidenceThreshold: 0.85,
};

const TTL_MS = 30 * 60_000;

export interface PendingApproval {
  approvalId: string;
  conversationId: string;
  messageId: string;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'approved' | 'edited' | 'rejected';
  /** 审批通过后要执行的动作 */
  proposed: AgentAction[];
  /** 审批通过后会话应有的状态（handle 已经算好的） */
  state: ConversationState;
  /** 被中断前的状态，驳回时回退到这里 */
  beforeState: ConversationState;
  beforePendingField?: string;
  summary: string;
  reason: string;
  confidence: number;
  confidenceNotes: string[];
  /** 审批卡片上要展示的回复原文 */
  draft: string;
  /** 恢复时把判定一起带回去，Playground 的「判断依据」面板不会因此清空 */
  match?: MatchAssessment;
  topics: string[];
  intent: string[];
  action: IntentAction;
}

export class ApprovalError extends Error {
  code: 'APPROVAL_NOT_FOUND' | 'APPROVAL_RESOLVED' | 'APPROVAL_EXPIRED' | 'APPROVAL_INVALID';
  constructor(code: ApprovalError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const approvals = new Map<string, PendingApproval>();

function shortHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** 0–1 的确定性随机：同一会话同一条消息每次都命中同一个灰度分支 */
function roll(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffffffff;
}

export function resolvePolicy(req: AgentRequest): ApprovalPolicy {
  const p = req.approvalPolicy;
  if (!p) return { ...DEFAULT_POLICY, overrides: {} }; // 不传＝全自动，保持 demo 行为
  return {
    default: p.default ?? DEFAULT_POLICY.default,
    overrides: { ...p.overrides },
    offlineFallback: p.offlineFallback ?? DEFAULT_POLICY.offlineFallback,
    confidenceThreshold: p.confidenceThreshold ?? DEFAULT_POLICY.confidenceThreshold,
  };
}

/**
 * 证据完整度。只读确定性信号：
 *   硬条件全过 / 可谈项没有差距 / 没有硬否决 / 槽位没过期 / decision 是否干净
 */
export function evidenceConfidence(
  match: MatchAssessment | undefined,
  slots: SlotMap,
): { score: number; notes: string[] } {
  if (!match) return { score: 0.4, notes: ['没有判定结果'] };

  let score = 0.5;
  const notes: string[] = [];

  const failedBlocking = match.blocking.filter((b) => b.pass === false);
  const missing = match.blocking.filter((b) => b.pass == null);
  if (failedBlocking.length === 0 && missing.length === 0) {
    score += 0.2;
    notes.push('硬条件全过');
  } else if (failedBlocking.length > 0) {
    score -= 0.35;
    notes.push(`硬条件不过 ${failedBlocking.length} 项`);
  }

  const hardRejects = match.negotiable.filter((n) => n.verdict === 'reject' && n.hard);
  if (hardRejects.length > 0) {
    score -= 0.2;
    notes.push('有硬约束冲突');
  }

  const soft = match.negotiable.filter((n) => n.verdict !== 'ok' && !n.hard);
  if (soft.length === 0) {
    score += 0.15;
    notes.push('没有可谈项差距');
  } else {
    notes.push(`可谈项有差距 ${soft.length} 项`);
  }

  if (match.openQuestions.length === 0) {
    score += 0.05;
    notes.push('没有待确认问题');
  } else {
    score -= 0.05;
    notes.push(`还有 ${match.openQuestions.length} 个待确认`);
  }

  const stale = Object.values(slots).filter((s) => s.state === 'stale' || s.state === 'expired');
  if (stale.length > 0) {
    score -= Math.min(0.15, stale.length * 0.05);
    notes.push(`过期/待确认槽位 ${stale.length} 个`);
  }

  if (match.decision === 'auto_match') score += 0.1;
  else if (match.decision === 'suggest') score += 0.03;
  else if (match.decision === 'negotiable') score -= 0.05;
  else if (match.decision === 'insufficient_data') score -= 0.15;
  else if (match.decision === 'not_match') score -= 0.2;

  return { score: Number(Math.max(0.05, Math.min(0.99, score)).toFixed(2)), notes };
}

function modeFor(
  action: AgentAction['type'],
  policy: ApprovalPolicy,
): 'auto' | 'require' | number {
  return policy.overrides?.[action] ?? policy.default;
}

/**
 * 单个动作是否要审批。
 * online=false 时按 offlineFallback 走；灰度比例用确定性 hash，避免同一会话反复横跳。
 */
export function requiresApproval(
  action: AgentAction['type'],
  policy: ApprovalPolicy,
  ctx: { conversationId: string; messageId: string; online: boolean; confidence: number },
): { require: boolean; reason: string } {
  if (action === 'text' || action === 'approval_request') {
    return { require: false, reason: '文本/审批卡不产生副作用' };
  }

  const mode = modeFor(action, policy);
  const threshold = policy.confidenceThreshold ?? DEFAULT_POLICY.confidenceThreshold!;

  if (!ctx.online) {
    switch (policy.offlineFallback ?? 'auto_if_confident') {
      case 'auto_always':
        return { require: false, reason: '经纪人离线，策略允许全自动' };
      case 'wait':
        return { require: true, reason: '经纪人离线，策略要求等审批' };
      default:
        return ctx.confidence >= threshold
          ? {
              require: false,
              reason: `经纪人离线，但证据完整度 ${ctx.confidence} ≥ ${threshold}，按策略放行`,
            }
          : {
              require: true,
              reason: `经纪人离线且证据完整度 ${ctx.confidence} < ${threshold}，等审批`,
            };
    }
  }

  if (mode === 'require') return { require: true, reason: `${action} 配了 require` };
  if (mode === 'auto') return { require: false, reason: `${action} 配了 auto` };

  const hit = roll(`${ctx.conversationId}:${ctx.messageId}:${action}`) < mode;
  return hit
    ? { require: true, reason: `${action} 命中灰度 ${Math.round(mode * 100)}%` }
    : { require: false, reason: `${action} 未命中灰度 ${Math.round(mode * 100)}%` };
}

/** 从动作里找出最需要审批的那个：采集表 > 转人工 > 卡片 */
function approvalTarget(actions: AgentAction[]): AgentAction | undefined {
  const order: AgentAction['type'][] = ['interview_form', 'handoff', 'job_cards'];
  for (const t of order) {
    const hit = actions.find((a) => a.type === t);
    if (hit) return hit;
  }
  return undefined;
}

export function approvalSummary(
  target: AgentAction,
  cand: Candidate,
  job: JobOrder,
): string {
  if (target.type === 'interview_form') {
    return `给 ${cand.basic.name} 发面试采集表（${target.prefill.岗位 ?? job.positionName}）`;
  }
  if (target.type === 'handoff') {
    return `把 ${cand.basic.name} 转人工：${target.summary}`;
  }
  if (target.type === 'job_cards') {
    return `给 ${cand.basic.name} 推 ${target.jobs.length} 张岗位卡`;
  }
  return `执行 ${target.type}`;
}

function draftOf(response: AgentResponse): string {
  return response.actions
    .filter((a): a is { type: 'text'; text: string } => a.type === 'text')
    .map((a) => a.text)
    .join('\n');
}

/**
 * 在链条末尾判断要不要中断。
 * 返回值是**新的响应**：原来的 actions 被替换成一张 approval_request，
 * proposed 里才是审批通过后要执行的东西。
 */
export function maybeRequestApproval(
  req: AgentRequest,
  response: AgentResponse,
  ctx: {
    match?: MatchAssessment;
    slots: SlotMap;
    candidate: Candidate;
    job: JobOrder;
    beforeState: ConversationState;
    beforePendingField?: string;
  },
): AgentResponse {
  const policy = resolvePolicy(req);
  const target = approvalTarget(response.actions);
  if (!target) return response;

  const { score, notes } = evidenceConfidence(ctx.match, ctx.slots);
  const online = req.recruiter?.online !== false;

  const decision = requiresApproval(target.type, policy, {
    conversationId: req.conversationId,
    messageId: req.messageId ?? '',
    online,
    confidence: score,
  });
  if (!decision.require) return response;

  const approvalId = `apr-${shortHash(`${req.conversationId}|${req.messageId}|${Date.now()}`)}`;
  const now = Date.now();
  const record: PendingApproval = {
    approvalId,
    conversationId: req.conversationId,
    messageId: req.messageId ?? '',
    createdAt: now,
    expiresAt: now + TTL_MS,
    status: 'pending',
    proposed: response.actions,
    state: response.state,
    beforeState: ctx.beforeState,
    beforePendingField: ctx.beforePendingField,
    summary: approvalSummary(target, ctx.candidate, ctx.job),
    reason: decision.reason,
    confidence: score,
    confidenceNotes: notes,
    draft: draftOf(response),
    match: response.meta.match,
    topics: response.meta.topics,
    intent: response.meta.intent,
    action: response.meta.action,
  };
  approvals.set(approvalId, record);

  // 此刻一个副作用都没发生，状态只是被 checkpoint 到等审批
  saveConversation(req.conversationId, { state: 'PENDING_APPROVAL' });

  const info: ApprovalInfo = {
    approvalId,
    status: 'requested',
    reason: decision.reason,
    confidence: score,
    confidenceNotes: notes,
  };

  return {
    ...response,
    actions: [
      {
        type: 'approval_request',
        approvalId,
        proposed: response.actions,
        summary: record.summary,
        reason: decision.reason,
      },
    ],
    state: 'PENDING_APPROVAL',
    meta: { ...response.meta, approval: info },
    trace: [
      ...response.trace,
      {
        node: 'approval',
        detail: `${decision.reason} · 证据完整度 ${score} · ${record.summary}`,
        ms: 0,
      },
    ],
  };
}

function expired(record: PendingApproval): boolean {
  return Date.now() > record.expiresAt;
}

export function getApproval(approvalId: string): PendingApproval | undefined {
  const hit = approvals.get(approvalId);
  if (!hit) return undefined;
  if (hit.status === 'pending' && expired(hit)) {
    hit.status = 'rejected';
    throw new ApprovalError('APPROVAL_EXPIRED', '审批已超时，请重新发起');
  }
  return hit;
}

export function latestPendingApproval(conversationId: string): PendingApproval | undefined {
  for (const record of approvals.values()) {
    if (record.conversationId === conversationId && record.status === 'pending' && !expired(record)) {
      return record;
    }
  }
  return undefined;
}

/**
 * 恢复。approve / edit 用提案（或改过的提案），reject 回退到中断前状态。
 * 不重跑 handle()——恢复不该重新判定，更不该重新生成一张表。
 */
export function resumeApproval(req: AgentRequest): AgentResponse {
  const resume = req.resume!;
  const record = getApproval(resume.approvalId);
  if (!record) throw new ApprovalError('APPROVAL_NOT_FOUND', '审批不存在或已被清理');
  if (record.conversationId !== req.conversationId) {
    throw new ApprovalError('APPROVAL_INVALID', '审批不属于这个会话');
  }
  if (record.status !== 'pending') {
    throw new ApprovalError('APPROVAL_RESOLVED', `审批已处理（${record.status}）`);
  }

  let actions: AgentAction[];
  let state: ConversationState;
  let status: 'approved' | 'edited' | 'rejected';
  let note: string;

  if (resume.decision === 'reject') {
    actions = [
      {
        type: 'text',
        text: '行，那这版先不发。你还有想了解的随时问我。',
      },
    ];
    state = record.beforeState;
    status = 'rejected';
    note = '人工驳回，未执行任何动作';
    saveConversation(req.conversationId, {
      state,
      pendingField: record.beforePendingField,
    });
  } else {
    const edited = (resume.editedActions ?? []).filter((a) => a.type !== 'approval_request');
    if (resume.decision === 'edit' && edited.length === 0) {
      throw new ApprovalError('APPROVAL_INVALID', 'edit 至少要给一个要执行的动作');
    }
    actions = resume.decision === 'edit' ? edited : record.proposed;
    state = record.state;
    status = resume.decision === 'edit' ? 'edited' : 'approved';
    note =
      resume.decision === 'edit'
        ? '人工改过再发'
        : '人工通过，执行提案';
    saveConversation(req.conversationId, { state, pendingField: undefined });
  }

  record.status = status;

  const info: ApprovalInfo = {
    approvalId: record.approvalId,
    status,
    reason: note,
    confidence: record.confidence,
    confidenceNotes: record.confidenceNotes,
  };

  return {
    traceId: `trace-${Date.now()}`,
    conversationId: req.conversationId,
    actions,
    state,
    trace: [
      { node: 'approval', detail: `${note} · ${record.summary}`, ms: 0 },
    ],
    meta: {
      intent: record.intent,
      topics: record.topics,
      action: record.action,
      intentConfidence: 1,
      match: record.match,
      escalated: actions.some((a) => a.type === 'handoff'),
      degraded: false,
      cached: false,
      latencyMs: 0,
      model: 'rule-v0',
      promptVersion: 'v0',
      approval: info,
    },
  };
}

/** 演示/测试：清空所有审批 */
export function resetApprovals(): void {
  approvals.clear();
}

/** 会话被重开时，它的审批一并失效——防止"批了旧会话的表" */
export function clearApprovalsFor(conversationId: string): void {
  for (const [id, record] of approvals) {
    if (record.conversationId === conversationId) approvals.delete(id);
  }
}

export function approvalCount(): number {
  return approvals.size;
}

/** 会话当前被哪张审批卡着——用于挡住"审批没处理又发新消息" */
export function pendingApprovalOf(conversationId: string): PendingApproval | undefined {
  return latestPendingApproval(conversationId);
}

/** 导出给测试/调试，避免直接摸内部 Map */
export function dumpApprovals(): PendingApproval[] {
  return [...approvals.values()];
}
