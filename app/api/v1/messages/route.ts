import { NextResponse } from 'next/server';
import { respond } from '@/lib/agent/pipeline';
import { resolveTurn } from '@/lib/agent/merge';
import { rememberReply, replayOf } from '@/lib/agent/idempotency';
import { withConversationLock } from '@/lib/agent/lock';
import { release, tryAcquire } from '@/lib/agent/gate';
import { resetConversation } from '@/lib/agent/store';
import { ApprovalError, clearApprovalsFor, pendingApprovalOf } from '@/lib/agent/approval';
import {
  missingSnapshots,
  rememberCandidate,
  rememberJobOrder,
  resolveCandidate,
  resolveJobOrder,
} from '@/lib/agent/snapshot-cache';
import type { AgentRequest } from '@/lib/agent/types';

export const runtime = 'nodejs';

/**
 * 业务端调用入口。
 * 真实环境里由业务后端调；本地由 Playground 扮演业务端。
 *
 * 快照协议：subject 只带 id@version，稳态下请求里没有一个业务字段。
 * 缓存未命中返回 409 SNAPSHOT_REQUIRED，业务端补一次快照重发即可。
 *
 * 连发合并：`messages[]` 里放静默窗口内的多条，服务端合并成一个 turn，
 * 幂等键由 messageId 集合生成——重发同一批不会发第二次。
 */
export async function POST(req: Request) {
  let body: AgentRequest;

  try {
    body = (await req.json()) as AgentRequest;
  } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 });
  }

  if (!body.conversationId) {
    return NextResponse.json({ error: 'MISSING_IDS' }, { status: 400 });
  }

  const turn = resolveTurn(body);
  if (!turn.messageId) {
    return NextResponse.json({ error: 'MISSING_IDS' }, { status: 400 });
  }

  // 先查幂等：重试的请求不该再走一遍判定，也不该因为缺快照被 409
  const replay = replayOf(body.conversationId, turn.messageId);
  if (replay) {
    return NextResponse.json(
      { ...replay, meta: { ...replay.meta, cached: true } },
      { headers: { 'x-idempotent-replay': '1' } },
    );
  }

  // ── 恢复审批：不重跑判定、不需要快照，直接执行/驳回当时存下的提案 ──
  if (body.resume) {
    if (!body.messageId) {
      return NextResponse.json(
        { error: 'MISSING_IDS', hint: 'resume 是一次新的状态推进，必须带新 messageId' },
        { status: 400 },
      );
    }

    try {
      const result = await withConversationLock(body.conversationId, async () => {
        const again = replayOf(body.conversationId, turn.messageId);
        if (again) return { result: again, replay: true };

        const fresh = await respond({ ...body, messageId: turn.messageId });
        rememberReply(body.conversationId, turn.messageId, fresh);
        return { result: fresh, replay: false };
      });

      return NextResponse.json(
        result.replay ? { ...result.result, meta: { ...result.result.meta, cached: true } } : result.result,
        {
          headers: {
            'x-approval-resume': body.resume.decision,
            ...(result.replay ? { 'x-idempotent-replay': '1' } : {}),
          },
        },
      );
    } catch (err) {
      if (err instanceof ApprovalError) {
        return NextResponse.json(
          { error: err.code, hint: err.message },
          { status: err.code === 'APPROVAL_NOT_FOUND' ? 404 : 409 },
        );
      }
      return NextResponse.json(
        { error: 'RESUME_FAILED', hint: String(err) },
        { status: 500 },
      );
    }
  }

  // 有一张审批卡没处理：先恢复它，别让会话继续往前走（否则恢复时状态已经漂移）
  const pending = pendingApprovalOf(body.conversationId);
  if (pending) {
    return NextResponse.json(
      {
        error: 'PENDING_APPROVAL',
        approvalId: pending.approvalId,
        summary: pending.summary,
        hint: '先恢复这张审批，再发新消息',
      },
      { status: 409 },
    );
  }

  if (!body.subject?.candidate?.id || !body.subject?.jobOrder?.id) {
    return NextResponse.json(
      { error: 'MISSING_SUBJECT', hint: 'subject 至少要给 id 和 version' },
      { status: 400 },
    );
  }

  // 带了快照就先入缓存（幂等：同版本重复写覆盖即可）
  if (body.subject.candidate.snapshot) {
    rememberCandidate(
      body.subject.candidate.id,
      body.subject.candidate.version,
      body.subject.candidate.snapshot,
    );
  }
  if (body.subject.jobOrder.snapshot) {
    rememberJobOrder(
      body.subject.jobOrder.id,
      body.subject.jobOrder.version,
      body.subject.jobOrder.snapshot,
    );
  }

  const missing = missingSnapshots(body.subject);
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: 'SNAPSHOT_REQUIRED',
        missing,
        keys: missing.map((m) =>
          m === 'candidate'
            ? `${body.subject.candidate.id}@${body.subject.candidate.version}`
            : `${body.subject.jobOrder.id}@${body.subject.jobOrder.version}`,
        ),
        hint: '带上对应 snapshot 重发同一个 messageId 即可',
      },
      { status: 409 },
    );
  }

  const candidate = resolveCandidate(body.subject.candidate.id, body.subject.candidate.version)!;
  const jobOrder = resolveJobOrder(body.subject.jobOrder.id, body.subject.jobOrder.version)!;

  // 入口硬校验：会话所在平台必须和岗位来源一致
  if (!jobOrder.platformEnabled.includes(body.platform)) {
    return NextResponse.json(
      { error: 'PLATFORM_MISMATCH', hint: `岗位未在 ${body.platform} 上架` },
      { status: 400 },
    );
  }

  // 最粗的闸：在飞请求超了就直接拒，别把上游打穿
  if (!tryAcquire()) {
    return NextResponse.json(
      { error: 'TOO_MANY_INFLIGHT', hint: '同一个会话请等上一条回复' },
      { status: 429, headers: { 'retry-after': '1' } },
    );
  }

  try {
    // 同一会话串行：读状态 → 跑模型 → 写状态，中间有 await，不能并发
    const result = await withConversationLock(body.conversationId, async () => {
      // 进了锁再查一次幂等：并发的同一 messageId 只能有一个真正处理
      const again = replayOf(body.conversationId, turn.messageId);
      if (again) return { result: again, replay: true };

      const fresh = await respond({
        ...body,
        messageId: turn.messageId,
        message: turn.message,
        subject: {
          candidate: { ...body.subject.candidate, snapshot: candidate },
          jobOrder: { ...body.subject.jobOrder, snapshot: jobOrder },
        },
      });
      rememberReply(body.conversationId, turn.messageId, fresh);
      return { result: fresh, replay: false };
    });

    return NextResponse.json(
      result.replay ? { ...result.result, meta: { ...result.result.meta, cached: true } } : result.result,
      {
        headers: {
          'x-snapshot-carry':
            body.subject.candidate.snapshot || body.subject.jobOrder.snapshot
              ? 'full'
              : 'reference',
          ...(result.replay ? { 'x-idempotent-replay': '1' } : {}),
        },
      },
    );
  } finally {
    release();
  }
}

/** 演示用的会话重置。真实环境不会有这个接口——会话是业务的，不是 agent 的 */
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const conversationId = url.searchParams.get('conversationId');
  if (!conversationId) {
    return NextResponse.json({ error: 'MISSING_CONVERSATION_ID' }, { status: 400 });
  }
  resetConversation(conversationId);
  clearApprovalsFor(conversationId);
  return NextResponse.json({ ok: true, conversationId });
}
