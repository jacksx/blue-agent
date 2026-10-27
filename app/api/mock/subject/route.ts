import { NextResponse } from 'next/server';
import { CANDIDATES, JOBS, findCandidate, findJob } from '@/lib/fixtures/data';
import type { AgentRequest } from '@/lib/agent/types';

/**
 * Mock BFF 的 fixture 出口。
 * Playground 与外部脚本都从这里取"业务端视角"的数据，
 * 保证评测、demo、回放共用同一份数据。
 *
 * 默认返回 reference-only 的请求（稳态形态，0 业务字段）；
 * ?full=1 返回带快照的版本，用于冷启动。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const jobId = url.searchParams.get('job');
  const candId = url.searchParams.get('candidate');
  const full = url.searchParams.get('full') === '1';

  if (!jobId && !candId) {
    return NextResponse.json({ candidates: CANDIDATES, jobs: JOBS });
  }

  const job = findJob(jobId ?? 'job-a');
  if (!job) return NextResponse.json({ error: 'JOB_NOT_FOUND' }, { status: 404 });

  const cand = findCandidate(candId ?? 'cand-zhangwei') ?? CANDIDATES[0]!;
  const text = url.searchParams.get('text') ?? '还招人吗';

  const request: AgentRequest = {
    messageId: `boss:${Date.now()}`,
    platform: 'boss',
    conversationId: `conv-${cand.id}`,
    message: { type: 'text', text, sentAt: new Date().toISOString() },
    subject: {
      candidate: {
        id: cand.id,
        version: cand.updatedAt,
        ...(full ? { snapshot: cand } : {}),
      },
      jobOrder: {
        id: job.id,
        version: job.updatedAt,
        ...(full ? { snapshot: job } : {}),
      },
    },
    recruiter: { id: job.recruiter.id, online: job.recruiter.online },
  };

  return NextResponse.json({ job, candidate: cand, request });
}
