/**
 * 同一个会话串行，不同会话并行。
 *
 * 为什么必须有：一条消息进来要读会话 → 跑模型 → 写会话，中间有两次 await。
 * 同一会话的两条消息如果并发，两个请求会读到同一份旧状态、各写一次，
 * 后写的那次把前一次的 turns 覆盖掉——最坏情况两张采集表都发出去。
 *
 * 进程内实现，够单实例用。多实例时要换成 Redis 的 SET NX 或数据库行锁。
 */

const chains = new Map<string, Promise<unknown>>();

export function withConversationLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  // 前一个失败也要继续跑，所以 then 的两个分支都指向 fn
  const run = prev.then(fn, fn);
  chains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/** 测试用：看看现在有多少条队列 */
export function lockCount(): number {
  return chains.size;
}
