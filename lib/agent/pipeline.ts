import type { AgentRequest, AgentResponse } from './types';
import { handle } from './orchestrator';
import { understand } from './nlu';
import { composeReply, mergeUsage } from './compose';
import { resolveTurn } from './merge';
import { defaultTools, shouldLookupPolicy, type AgentTools, type DecisionContext } from './tools';
import { getConversation } from './store';
import { maybeRequestApproval, resumeApproval } from './approval';
import { costCny } from '@/lib/llm/pricing';

/**
 * 一条消息的完整流水线。
 *
 *   合并 → 工具 → 理解 → 决策 → 措辞 → 审批
 *   merge  tools   nlu    handle  compose  approval
 *
 * 三段分开的意义：决策是纯同步、纯函数，能用回归集锁死；
 * 模型只出现在两头（理解、措辞），两头都有兜底。
 * 需要"去库里拿东西"的部分单独抽成工具，在决策之前一次取好，
 * 这样决策里没有一处 await，可以逐行复现。
 *
 * 审批放在最后：先把"该说什么"算完，再决定"能不能发"。
 * 中断点之前只有判定和措辞，没有副作用，所以恢复时不需要重跑。
 */
export async function respond(
  req: AgentRequest,
  tools: AgentTools = defaultTools,
): Promise<AgentResponse> {
  const turn = resolveTurn(req);
  const normalized: AgentRequest = {
    ...req,
    message: turn.message,
    messageId: turn.messageId,
  };

  // 恢复审批不需要快照，也不该重新判定——直接执行/驳回当时存下的提案
  if (normalized.resume) return resumeApproval(normalized);

  const candidate = normalized.subject.candidate.snapshot;
  const job = normalized.subject.jobOrder.snapshot;

  if (!candidate || !job) return handle(normalized);

  // 中断前的状态要留一份：驳回时回退到这里，而不是回退到"刚进来"的 GREETING
  const before = getConversation(normalized.conversationId);

  const text = turn.message.text ?? '';

  const understanding =
    turn.message.type === 'text' && text.trim() ? await understand(text, job) : undefined;

  // 唯一的工具调用：召回岗位池 + 必要时查政策库。
  // 真实实现是一次 SQL + 向量召回；决策之前一次取好，决策里没有 await
  const toolStart = Date.now();
  const policy = shouldLookupPolicy(text, understanding) ? tools.searchPolicy(text) : undefined;
  const ctx: DecisionContext = {
    jobPool: tools.searchJobPool({ candidate, currentJobId: job.id, limit: 20 }),
    searchMs: Date.now() - toolStart,
    policy,
  };

  const base = handle(normalized, understanding, ctx);
  const composed = await composeReply(base);

  // meta.latencyMs 只算了决策+措辞，理解层在 handle 之前
  // 用量同理：理解层那次调用的 token 要补进来
  // 理解层那次调用也要计入用量：即使它失败了，token 和重试也已经花掉了
  const nluUsage =
    understanding && understanding.source === 'model'
      ? {
          promptTokens: understanding.tokens?.prompt ?? 0,
          completionTokens: understanding.tokens?.completion ?? 0,
          calls: 1,
          retries: understanding.retries ?? 0,
          costCny: costCny(understanding.tokens?.prompt ?? 0, understanding.tokens?.completion ?? 0),
        }
      : undefined;

  const withLatency: AgentResponse = {
    ...composed,
    meta: {
      ...composed.meta,
      latencyMs: composed.meta.latencyMs + (understanding?.latencyMs ?? 0),
      usage: nluUsage ? mergeUsage(composed.meta.usage, nluUsage) : composed.meta.usage,
    },
  };

  const final =
    turn.mergedFrom.length <= 1
      ? withLatency
      : { ...withLatency, meta: { ...withLatency.meta, mergedFrom: turn.mergedFrom } };

  // 审批策略只看"有副作用的动作"；纯文本永远不会被卡
  return maybeRequestApproval(normalized, final, {
    match: final.meta.match,
    slots: getConversation(normalized.conversationId).slots,
    candidate,
    job,
    beforeState: before.state,
    beforePendingField: before.pendingField,
  });
}
