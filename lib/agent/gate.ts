/**
 * 全局在飞请求上限。
 *
 * 每条消息最多两次模型调用，没有上限的话来一波就是一波并发打上游，
 * 撞上 429 再一起重试，雪崩。这里做最粗的一道闸：超了直接 429。
 *
 * 单实例计数，多实例要换成 Redis 计数器或者网关层的限流。
 */

const MAX_INFLIGHT = Number(process.env.MAX_INFLIGHT ?? 16);

let inflight = 0;

export function tryAcquire(): boolean {
  if (inflight >= MAX_INFLIGHT) return false;
  inflight += 1;
  return true;
}

export function release(): void {
  inflight = Math.max(0, inflight - 1);
}

export function inflightCount(): number {
  return inflight;
}

export function inflightLimit(): number {
  return MAX_INFLIGHT;
}
