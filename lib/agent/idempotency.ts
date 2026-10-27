import type { AgentResponse } from './types';

/**
 * messageId 幂等。
 *
 * 业务端重试、网络抖动、BFF 补发快照后重发——都会用同一个 messageId 再打一次。
 * 没有这层，用户就收到两条一样的回复（或者更糟：两张采集表）。
 *
 * W0 用进程内 Map + 5 分钟 TTL；生产用 Redis SETNX 抢锁，
 * 抢不到的直接返回已有结果，避免两个实例同时处理同一条消息。
 */

const TTL_MS = 5 * 60_000;
const MAX = 2000;

const cache = new Map<string, { response: AgentResponse; at: number }>();

const keyOf = (conversationId: string, messageId: string) => `${conversationId}::${messageId}`;

export function replayOf(conversationId: string, messageId: string): AgentResponse | undefined {
  const hit = cache.get(keyOf(conversationId, messageId));
  if (!hit) return undefined;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(keyOf(conversationId, messageId));
    return undefined;
  }
  return hit.response;
}

export function rememberReply(
  conversationId: string,
  messageId: string,
  response: AgentResponse,
): void {
  if (cache.size >= MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(keyOf(conversationId, messageId), { response, at: Date.now() });
}

export function resetIdempotency(): void {
  cache.clear();
}
