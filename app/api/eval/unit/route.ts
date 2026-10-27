import type { Slot } from '@/lib/agent/types';
import { evaluate } from '@/lib/agent/match';
import { toCard } from '@/lib/agent/cards';
import { evidenceConfidence, requiresApproval } from '@/lib/agent/approval';
import { refreshSlot, isUsable } from '@/lib/agent/slots';
import { ruleUnderstanding } from '@/lib/agent/nlu';
import { shouldLookupPolicy } from '@/lib/agent/tools';
import {
  canonicalIdsOfJob,
  canonicalizeAll,
  canonicalizeText,
  isHardUsable,
  resolveShiftCode,
} from '@/lib/agent/tags';
import { retrieve, rewriteQuery } from '@/lib/rag/retrieve';
import { checkGrounding } from '@/lib/llm/grounding';
import { mcnemar } from '@/lib/eval/stats';
import { findCandidate, findJob } from '@/lib/fixtures/data';

export const runtime = 'nodejs';

/**
 * L1 单元级检查。
 *
 * 端到端回归（eval.ps1）贵、慢、定位难；大部分逻辑错误应该在组件级被抓住。
 * 这里只放"纯函数 + 确定性"的断言，不调模型、不碰网络，毫秒级。
 */

interface Assertion {
  id: string;
  desc: string;
  ok: boolean;
  detail: string;
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function check(id: string, desc: string, fn: () => string): Assertion {
  try {
    return { id, desc, ok: true, detail: fn() };
  } catch (err) {
    return { id, desc, ok: false, detail: String(err) };
  }
}

function slot(value: Slot['value'], ttlDays?: number, daysAgo = 0): Slot {
  return {
    value,
    strength: 'strong',
    source: 'chat',
    assertedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    ttlDays,
    state: 'fresh',
    carrier: 'chat',
  };
}

export async function GET() {
  const started = Date.now();
  const zhang = findCandidate('cand-zhangwei')!;
  const wang = findCandidate('cand-wangqiang')!;
  const jobA = findJob('job-a')!;
  const jobB = findJob('job-b')!;
  const jobC = findJob('job-c')!;

  const cases: Assertion[] = [
    check('mcnemar-significant', '19 修好 / 3 弄坏 → p < 0.01 且显著', () => {
      const m = mcnemar(19, 3);
      assert(m.significant, `p=${m.pValue}`);
      assert(m.pValue < 0.01, `p=${m.pValue}`);
      return `χ²=${m.chi2} p=${m.pValue}`;
    }),
    check('mcnemar-null', '5 修好 / 4 弄坏 → p = 1，不能宣称变好', () => {
      const m = mcnemar(5, 4);
      assert(m.pValue === 1, `p=${m.pValue}`);
      assert(!m.significant, '不该显著');
      return `χ²=${m.chi2} p=${m.pValue}`;
    }),
    check('ttl-expired', '30 天 TTL 放了 100 天 → expired', () => {
      const s = refreshSlot(slot(6000, 30, 100));
      assert(s.state === 'expired', s.state);
      assert(!isUsable(s), '过期槽位不该可用');
      return s.state;
    }),
    check('ttl-stale', '90 天 TTL 放了 80 天 → stale（还能用，但要重确认）', () => {
      const s = refreshSlot(slot('长白班', 90, 80));
      assert(s.state === 'stale', s.state);
      assert(isUsable(s), 'stale 仍然可用');
      return s.state;
    }),
    check('ttl-fresh', '30 天 TTL 放了 1 天 → fresh', () => {
      const s = refreshSlot(slot(6000, 30, 1));
      assert(s.state === 'fresh', s.state);
      return s.state;
    }),
    check('approval-require', 'interview_form 配 require → 必须审批', () => {
      const d = requiresApproval(
        'interview_form',
        { default: 'auto', overrides: { interview_form: 'require' } },
        { conversationId: 'c1', messageId: 'm1', online: true, confidence: 0.99 },
      );
      assert(d.require, d.reason);
      return d.reason;
    }),
    check('approval-auto', '不配 policy → 全自动，保持 demo 行为', () => {
      const d = requiresApproval(
        'interview_form',
        { default: 'auto', overrides: {} },
        { conversationId: 'c1', messageId: 'm1', online: true, confidence: 0.99 },
      );
      assert(!d.require, d.reason);
      return d.reason;
    }),
    check('approval-offline-confident', '离线 + 证据完整度 0.9 → 放行（没人兜底也不卡死）', () => {
      const d = requiresApproval(
        'interview_form',
        { default: 'auto', overrides: { interview_form: 'require' } },
        { conversationId: 'c1', messageId: 'm1', online: false, confidence: 0.9 },
      );
      assert(!d.require, d.reason);
      return d.reason;
    }),
    check('approval-offline-low', '离线 + 证据完整度 0.5 → 等审批（离线不等于全放开）', () => {
      const d = requiresApproval(
        'interview_form',
        { default: 'auto', overrides: { interview_form: 'require' } },
        { conversationId: 'c1', messageId: 'm1', online: false, confidence: 0.5 },
      );
      assert(d.require, d.reason);
      return d.reason;
    }),
    check('approval-offline-wait', 'offlineFallback=wait → 多高置信度都等', () => {
      const d = requiresApproval(
        'interview_form',
        { default: 'auto', overrides: { interview_form: 'require' }, offlineFallback: 'wait' },
        { conversationId: 'c1', messageId: 'm1', online: false, confidence: 0.99 },
      );
      assert(d.require, d.reason);
      return d.reason;
    }),
    check('confidence-high', '硬条件全过、无可谈差距、无待确认 → ≥ 0.9', () => {
      const m = evaluate(jobA, zhang, { 'constraint.shift': slot('两班倒') });
      const c = evidenceConfidence(m, { 'constraint.shift': slot('两班倒') });
      assert(c.score >= 0.9, `score=${c.score} notes=${c.notes}`);
      return `${c.score} (${c.notes.join(' / ')})`;
    }),
    check('confidence-low', '差 14% 的可谈项 → < 0.85，离线时应等审批', () => {
      const m = evaluate(jobC, wang, {});
      const c = evidenceConfidence(m, {});
      assert(c.score < 0.85, `score=${c.score}`);
      return `${c.score} (${c.notes.join(' / ')})`;
    }),
    check('shift-scope-subject', 'A 岗位的「能接受班次」不能带到 B', () => {
      const stale = {
        ...slot('两班倒'),
        scope: 'subject' as const,
        jobOrderId: 'job-a',
      };
      const m = evaluate(jobB, zhang, {
        'constraint.shift': stale,
      });
      const shift = m.negotiable.find((n) => n.field === 'shift')!;
      assert(shift.verdict !== 'reject', `verdict=${shift.verdict}`);
      assert(!shift.hard, '不该变成硬否决');
      return `${shift.verdict} ${m.decision}`;
    }),
    check('shift-scope-person', '「只能上白班」是人的硬约束，换到两班倒岗位仍是否决', () => {
      const m = evaluate(jobA, zhang, {
        'constraint.shift': { ...slot('长白班'), strength: 'hard', reason: '接孩子 5:30' },
      });
      const shift = m.negotiable.find((n) => n.field === 'shift')!;
      assert(shift.verdict === 'reject' && shift.hard === true, JSON.stringify(shift));
      assert(m.decision === 'not_match', m.decision);
      return `${m.decision} ${shift.note}`;
    }),
    check('card-platform-dianzhang', '店长直聘会话的卡片必须映射回店长 id', () => {
      const card = toCard(jobA, zhang, 'test', 'dianzhang');
      assert(card.platformJobId === jobA.platformJobId.dianzhang, card.platformJobId);
      assert(card.platformLabel === '店长直聘', card.platformLabel);
      return `${card.platformLabel} ${card.platformJobId}`;
    }),
    check('card-platform-boss', 'BOSS 会话映射回 BOSS id', () => {
      const card = toCard(jobA, zhang, 'test', 'boss');
      assert(card.platformJobId === jobA.platformJobId.boss, card.platformJobId);
      return card.platformJobId;
    }),
    check('policy-gate-health', '「体检费谁出」要查知识库', () => {
      const u = ruleUnderstanding('体检费谁出', jobA);
      assert(shouldLookupPolicy('体检费谁出', u), '没过 gate');
      return u.topics.join(',') || '(empty)';
    }),
    check('policy-gate-structured', '「还招人吗」「包吃住吗」走结构化字段，不查库', () => {
      assert(!shouldLookupPolicy('还招人吗', ruleUnderstanding('还招人吗', jobA)), 'hiring 不该查库');
      assert(!shouldLookupPolicy('包吃住吗', ruleUnderstanding('包吃住吗', jobA)), '吃住不该查库');
      return 'ok';
    }),
    check('rag-health-top1', '体检费 query 的 top1 是 health.exam_fee 且不拒答', () => {
      const r = retrieve('体检费谁出');
      assert(!r.refused, r.reason);
      assert(r.hits[0]?.chunk.id === 'health.exam_fee', r.hits.map((h) => h.chunk.id).join(','));
      return `${r.hits[0]!.chunk.id} ${r.topScore}`;
    }),
    check('rag-refuse-offtopic', '天气问题必须拒答', () => {
      const r = retrieve('今天天气怎么样');
      assert(r.refused, `没拒答，top=${r.hits[0]?.chunk.id} ${r.topScore}`);
      return r.reason;
    }),
    check('rag-rewrite', '「工资会压吗」重写成 settlement 域', () => {
      const r = rewriteQuery('工资会压吗');
      assert(r.category === 'settlement', String(r.category));
      assert(r.query.includes('压工资'), r.query);
      return r.category!;
    }),
    check('tag-normalize', '「（包吃）」归一成 meal.provided，字典置信度 0.98', () => {
      const m = canonicalizeText('（包吃）');
      assert(m.id === 'meal.provided', String(m.id));
      assert(m.confidence >= 0.95, String(m.confidence));
      assert(isHardUsable(m), '字典命中应可用于硬判断');
      return `${m.id} ${m.confidence}`;
    }),
    check('tag-negative', '「不包吃」必须归成 meal.none，不能被包含匹配骗成包吃', () => {
      const m = canonicalizeText('不包吃');
      assert(m.id === 'meal.none', String(m.id));
      return `${m.id} ${m.method}`;
    }),
    check('tag-multi', '「包吃住」必须同时归出 meal.provided 和 dorm.provided', () => {
      const ids = canonicalizeAll('包吃住').map((m) => m.id);
      assert(ids.includes('meal.provided'), ids.join(','));
      assert(ids.includes('dorm.provided'), ids.join(','));
      return ids.join(',');
    }),
    check('tag-rest', '「月休四天」归一成 rest.monthly_4', () => {
      const m = canonicalizeText('月休四天');
      assert(m.id === 'rest.monthly_4', String(m.id));
      return m.id!;
    }),
    check('tag-unresolved', '「有班车接送」不在词表 → unresolved，不进判定', () => {
      const m = canonicalizeText('有班车接送');
      assert(m.id == null, String(m.id));
      assert(!isHardUsable(m), 'unresolved 不能用于硬判断');
      return m.method;
    }),
    check('tag-job-custom', '岗位的自定义「包三餐」被归到 meal.provided', () => {
      const t = canonicalIdsOfJob(jobC);
      assert(t.ids.has('meal.provided'), [...t.ids].join(','));
      assert(t.ids.has('dorm.provided'), [...t.ids].join(','));
      assert(t.unresolved.length === 0, t.unresolved.join(','));
      return [...t.ids].join(',');
    }),
    check('tag-shift-custom', '自定义「两班倒（白夜班）」能识别出 code，但只到 0.9 不进硬判', () => {
      const r = resolveShiftCode({ code: null, label: '两班倒（白夜班）', norm: 'unmapped' });
      assert(r.code === 'two_shift', String(r.code));
      assert(r.confidence < 0.95, `confidence=${r.confidence}`);
      return `${r.code} ${r.confidence} ${r.matched}`;
    }),
    check('grounding-number', '改写里多出草稿没有的数字 → 拦下', () => {
      const v = checkGrounding('综合 8000 到 9000', '综合 5000 到 6500');
      assert(v.some((x) => x.rule === 'number'), JSON.stringify(v));
      return v.map((x) => x.detail).join('；');
    }),
    check('grounding-question', '草稿在提问、改写成陈述 → 拦下', () => {
      const v = checkGrounding('我们这边包吃。', '我们这边包吃吗？');
      assert(v.some((x) => x.rule === 'question'), JSON.stringify(v));
      return v.map((x) => x.detail).join('；');
    }),
    check('grounding-contact', '草稿没提微信、改写引入联系方式 → 拦下', () => {
      const v = checkGrounding('加我微信吧', '在平台上聊就行');
      assert(v.some((x) => x.rule === 'contact'), JSON.stringify(v));
      return v.map((x) => x.detail).join('；');
    }),
    check('grounding-claim', '草稿没承诺、改写加了「包吃」→ 拦下', () => {
      const v = checkGrounding('还招人的，包吃', '你好，还招人的');
      assert(v.some((x) => x.rule === 'claim'), JSON.stringify(v));
      return v.map((x) => x.detail).join('；');
    }),
    check('grounding-clean', '原样改写且不越界 → 不产生违规', () => {
      const draft = '你好，还招人的。我们这边是两班倒，08:00 到 20:00，你能接受吗？';
      const v = checkGrounding(draft, draft);
      assert(v.length === 0, JSON.stringify(v));
      return '0 violations';
    }),
  ];

  const passed = cases.filter((c) => c.ok).length;
  return Response.json({
    total: cases.length,
    passed,
    failed: cases.length - passed,
    durationMs: Date.now() - started,
    cases,
  });
}
