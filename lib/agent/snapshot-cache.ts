import type { Candidate, JobOrder } from './types';

/**
 * 业务事实的快照缓存。
 *
 * 契约是 `id@version`，不是每条消息都塞一份 JSON。
 * 稳态下请求里只有 id 和 version；缓存未命中才让业务端补一次快照，
 * 补完这一版之后就一直是 0 业务数据。同一个思路见 ETag / If-None-Match。
 *
 * W0 用进程内 Map，生产换 Redis，TTL 跟岗位的更新频率走。
 */

const MAX_ENTRIES = 500;

interface Entry<T> {
  value: T;
  touchedAt: number;
}

const candidates = new Map<string, Entry<Candidate>>();
const jobOrders = new Map<string, Entry<JobOrder>>();

const key = (id: string, version: string) => `${id}@${version}`;

function evict<T>(map: Map<string, Entry<T>>): void {
  if (map.size <= MAX_ENTRIES) return;
  let oldestKey: string | null = null;
  let oldest = Infinity;
  for (const [k, e] of map) {
    if (e.touchedAt < oldest) {
      oldest = e.touchedAt;
      oldestKey = k;
    }
  }
  if (oldestKey) map.delete(oldestKey);
}

export function rememberCandidate(id: string, version: string, snapshot: Candidate): void {
  candidates.set(key(id, version), { value: snapshot, touchedAt: Date.now() });
  evict(candidates);
}

export function rememberJobOrder(id: string, version: string, snapshot: JobOrder): void {
  jobOrders.set(key(id, version), { value: snapshot, touchedAt: Date.now() });
  evict(jobOrders);
}

export function resolveCandidate(id: string, version: string): Candidate | undefined {
  const hit = candidates.get(key(id, version));
  if (!hit) return undefined;
  hit.touchedAt = Date.now();
  return hit.value;
}

export function resolveJobOrder(id: string, version: string): JobOrder | undefined {
  const hit = jobOrders.get(key(id, version));
  if (!hit) return undefined;
  hit.touchedAt = Date.now();
  return hit.value;
}

/** 缺少哪些快照——返回给业务端，让它决定是重发还是自己去查 */
export function missingSnapshots(subject: {
  candidate?: { id: string; version: string; snapshot?: Candidate };
  jobOrder?: { id: string; version: string; snapshot?: JobOrder };
}): string[] {
  const missing: string[] = [];
  if (!subject.candidate || !resolveCandidate(subject.candidate.id, subject.candidate.version)) {
    missing.push('candidate');
  }
  if (!subject.jobOrder || !resolveJobOrder(subject.jobOrder.id, subject.jobOrder.version)) {
    missing.push('jobOrder');
  }
  return missing;
}

export function cacheStats() {
  return { candidates: candidates.size, jobOrders: jobOrders.size };
}

export function resetSnapshotCache(): void {
  candidates.clear();
  jobOrders.clear();
}
