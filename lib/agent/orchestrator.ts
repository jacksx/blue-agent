import type {
  AgentAction,
  AgentRequest,
  AgentResponse,
  Candidate,
  ConversationState,
  JobOrder,
  MatchAssessment,
  Slot,
  SlotMap,
  TraceStep,
} from './types';
import { commuteLabelOf, evaluate, jobName, monthlyCeiling, salaryBrief } from './match';
import { toCard } from './cards';
import { restFact, shiftLabel } from './format';
import { dormBrief, payDayText } from './format';
import {
  educationLabel,
  experienceLabel,
  hasBonus,
  hasLiving,
  insuranceText,
  skillText,
} from './format';
import { shiftBrief } from './format';
import { recommend } from './recommend';
import { getConversation, saveConversation } from './store';
import { ANSWERABLE_TOPICS } from './rules';
import { ruleUnderstanding, type Understanding } from './nlu';
import { refreshSlots } from './slots';
import type { SlotChange } from './store';
import type { DecisionContext } from './tools';

// ─────────────────────────────────────────────────────────────
// 编排层：只做决策，不做理解、不做措辞。
//
//   理解 → nlu.understand()   模型/规则，产出 意图 + 明确约束
//   决策 → 本文件 handle()    纯同步、可复现
//   措辞 → compose.composeReply()  模型改写 + 接地校验
//
// 三条产品约束写死在这里：
//   1. 首条要打招呼；回复 = 回答对方问的 + 一个推进动作，一条消息说完
//   2. 岗位是用户自己点进来的，薪资/通勤差一点只问不赶人
//   3. 表是收集信息的，不是替代判断的——判断依据不齐不许发
// ─────────────────────────────────────────────────────────────

// ── 槽位 ─────────────────────────────────────────────────────

function makeSlot(
  value: Slot['value'],
  opts: {
    reason?: string;
    strength?: Slot['strength'];
    evidence?: string;
    ttlDays?: number;
    scope?: Slot['scope'];
    jobOrderId?: string;
  } = {},
): Slot {
  return {
    value,
    reason: opts.reason,
    strength: opts.strength ?? 'strong',
    source: 'chat',
    evidence: opts.evidence,
    assertedAt: new Date().toISOString(),
    ttlDays: opts.ttlDays ?? 90,
    state: 'fresh',
    carrier: 'chat',
    scope: opts.scope ?? 'person',
    jobOrderId: opts.jobOrderId,
  };
}

function numOf(v: Slot['value'] | undefined): number | undefined {
  if (typeof v === 'number') return v;
  if (Array.isArray(v)) return v[0];
  return undefined;
}

/**
 * 前后说法不一致检测。
 *
 * 典型场景：先说"六千就行"，聊了两轮改口"得七千多"。
 * 光覆盖不记录，出事时没人查得出来是第几轮改的；记录但不提示，
 * 用户会觉得你没在听。这里两边都做：记下来，并且只在改动很大时提一句。
 */
function detectSlotChanges(base: SlotMap, u: Understanding): SlotChange[] {
  const now = new Date().toISOString();
  const out: SlotChange[] = [];

  // 简历基线也会写进同一个槽位，所以只比"聊天来源"的值
  const salarySlot = base['pref.salaryTarget'];
  if (u.salaryTarget != null && salarySlot?.source === 'chat') {
    const prev = numOf(salarySlot.value);
    if (prev != null && prev !== u.salaryTarget) {
      out.push({ key: 'pref.salaryTarget', from: prev, to: u.salaryTarget, at: now });
    }
  }

  const shiftSlot = base['constraint.shift'];
  if (u.shift && shiftSlot?.source === 'chat') {
    const prev = shiftSlot.value;
    if (prev != null && prev !== u.shift.value) {
      out.push({ key: 'constraint.shift', from: prev, to: u.shift.value, at: now });
    }
  }

  return out;
}

/** 把理解层抽到的原始事实落成槽位。约束强度由理解层决定，这里不猜 */
function applyUnderstanding(u: Understanding, base: SlotMap, evidence: string, job: JobOrder): SlotMap {
  const slots: SlotMap = { ...base };

  if (u.shift) {
    // 硬约束（"只能上白班"）是人的约束；意愿（"能接受两班倒"）是对这个岗位的。
    // 不区分的话，在 A 说"能接受夜班"会被带到 B，变成 B 也接受。
    const person = u.shift.strength === 'hard';
    slots['constraint.shift'] = makeSlot(u.shift.value, {
      reason: u.shift.reason,
      strength: u.shift.strength,
      evidence,
      scope: person ? 'person' : 'subject',
      jobOrderId: person ? undefined : job.id,
    });
  }
  if (u.salaryTarget != null) {
    slots['pref.salaryTarget'] = makeSlot([u.salaryTarget, u.salaryTarget], {
      evidence,
      ttlDays: 30,
      scope: 'person',
    });
  }
  if (u.healthCert != null) {
    slots['cert.healthCert'] = makeSlot(u.healthCert, {
      evidence,
      ttlDays: 180,
      scope: 'person',
    });
  }

  return slots;
}

/**
 * 把"能""可以"这类短回答接住。
 * 没有这一步，agent 问完"你能接受两班倒吗"，用户答"能"，它当没听见。
 */
function applyPendingAnswer(
  text: string,
  slots: SlotMap,
  pendingField: string | undefined,
  job: JobOrder,
): { slots: SlotMap; answered: boolean; ok: boolean; no: boolean } {
  const none = { slots, answered: false, ok: false, no: false };
  if (!pendingField) return none;

  const trimmed = text.trim();
  const yes = /^(能|可以|行|接受|没问题|好的|好|嗯|对|要|ok)/i.test(trimmed);
  const no = /^(不能|不行|不去|不面|不接受|不想|不要|不干|不太|不用|算了|再看看)/.test(trimmed);
  if (!yes && !no) return none;

  if (pendingField === 'shift') {
    const next: SlotMap = { ...slots };
    // 这是"对这个岗位的班次"的态度，不是"我能接受夜班"的人生决定。
    // 绑到当前岗位：换岗位后必须重新确认，不能把 A 的接受度带到 B。
    next['constraint.shift'] = no
      ? makeSlot('长白班', {
          evidence: text,
          strength: 'strong',
          scope: 'subject',
          jobOrderId: job.id,
        })
      : makeSlot(shiftLabel(job.schedule), {
          evidence: text,
          scope: 'subject',
          jobOrderId: job.id,
        });
    return { slots: next, answered: true, ok: yes, no };
  }

  // 用户说"能接受"某个更低的薪资，那这个数就是他的底线，不是期望
  if (pendingField === 'salary' && yes) {
    const next: SlotMap = { ...slots };
    next['pref.salaryFloor'] = makeSlot(monthlyCeiling(job), {
      evidence: text,
      strength: 'strong',
      ttlDays: 30,
    });
    return { slots: next, answered: true, ok: true, no: false };
  }

  // 面试意向：不改槽位，只回一个"去不去"
  if (pendingField === 'interview') {
    return { slots, answered: true, ok: yes, no };
  }

  return { ...none, answered: false };
}

function baseSlots(cand: Candidate): SlotMap {
  const now = new Date().toISOString();
  // 简历字段的"断言时间"用简历自己的 updatedAt，不是现在——
  // 否则每次刷新都变成刚说的，30 天半衰期永远不会生效
  const assertedAt = Number.isFinite(Date.parse(cand.updatedAt)) ? cand.updatedAt : now;
  const s: SlotMap = {
    'person.age': {
      value: cand.basic.age,
      strength: 'hard',
      source: 'resume',
      assertedAt,
      state: 'fresh',
      carrier: 'resume',
      scope: 'person',
    },
    'person.currentDistrict': {
      value: cand.current.district.name,
      strength: 'strong',
      source: 'resume',
      assertedAt,
      ttlDays: 90,
      state: 'fresh',
      carrier: 'resume',
      scope: 'person',
    },
  };
  if (cand.expect.salaryMin != null) {
    s['pref.salaryTarget'] = {
      value: [cand.expect.salaryMin, cand.expect.salaryMax ?? cand.expect.salaryMin],
      strength: 'strong',
      source: 'resume',
      assertedAt,
      ttlDays: 30,
      state: 'fresh',
      carrier: 'resume',
      scope: 'person',
    };
  }
  return s;
}

// ── 话术 ─────────────────────────────────────────────────────

function answerFacts(topics: string[], job: JobOrder, cand: Candidate): string {
  const parts: string[] = [];

  if (topics.includes('hiring')) {
    parts.push(job.headcount.left > 0 ? '还招人的' : '这个岗位已经招满了');
  }
  if (topics.includes('salary')) {
    parts.push(`${salaryBrief(job)}，${payDayText(job.pay)}发`);
  }
  if (topics.includes('rest')) {
    parts.push(restFact(job.schedule));
  }
  if (topics.includes('dorm')) {
    parts.push(dormBrief(job));
  }
  if (topics.includes('meal')) {
    const b = job.benefits;
    if (hasLiving(b, 'meal_included')) {
      // 自定义项（比如"包三餐"）也选在这一组里，别丢
      const extra = b.living.custom.length ? b.living.custom.join('、') : b.mealNote;
      parts.push(`包吃${extra ? '，' + extra : ''}`);
    } else if (hasBonus(b, 'meal_subsidy')) {
      parts.push(
        `吃自理，有餐补${b.mealSubsidyPerDay ? ` ${b.mealSubsidyPerDay}/天` : ''}` +
          (b.mealNote ? '，' + b.mealNote : ''),
      );
    } else {
      parts.push('吃自理');
    }
  }
  if (topics.includes('overtime')) {
    // 实际工时是算出来的：含休息就扣掉休息，不含就是整段
    parts.push(
      `${shiftBrief(job)}${job.schedule.overtimeAfter ? `，${job.schedule.overtimeAfter} 后算加班` : ''}`,
    );
  }
  if (topics.includes('advance')) {
    parts.push(
      job.pay.advance?.allowed ? `可以预支，满 ${job.pay.advance.afterDays} 天` : '不能预支',
    );
  }
  if (topics.includes('insurance')) {
    const b = job.benefits;
    parts.push(insuranceText(job.benefits));
  }
  if (topics.includes('requirement')) {
    const r = job.requirements;
    const skills = skillText(r.skills);
    parts.push(
      `${r.ageMin}-${r.ageMax} 岁，${educationLabel(r.education)}，${experienceLabel(r.experience)}` +
        `${skills ? `，要会${skills}` : ''}`,
    );
  }
  if (topics.includes('environment')) {
    parts.push(job.description.environment ?? '环境一般');
  }
  if (topics.includes('content')) {
    parts.push(job.description.content?.join('、') ?? '流水线作业');
  }
  if (topics.includes('location')) {
    const loc = job.locations[0]!;
    parts.push(`在${loc.district.name}，过去${commuteLabelOf(job, cand)}`);
  }
  if (topics.includes('interview')) {
    const loc = job.locations[0]!;
    const sameDay = job.description.highlights?.some((h) => h.includes('当天')) ?? false;
    parts.push(
      `面试就在${job.store.name}（${loc.district.name}），带上身份证${sameDay ? '，当天就能安排' : ''}`,
    );
  }
  // 站外导流是封号级红线：agent 永远不报自己的微信号。
  // 用户主动要微信不是违规——走转出流程（见主流程的 transfer 分支）

  return parts.filter(Boolean).join('。');
}

/** 交接摘要：经纪人在微信里接手时不用再问一遍 */
function handoffSummary(
  cand: Candidate,
  job: JobOrder,
  slots: SlotMap,
  match: MatchAssessment,
): string {
  const shiftSlot = slots['constraint.shift'];
  const shift =
    shiftSlot &&
    !(shiftSlot.scope === 'subject' && shiftSlot.jobOrderId && shiftSlot.jobOrderId !== job.id)
      ? shiftSlot.value
      : undefined;
  const salary = slots['pref.salaryTarget']?.value;
  const health = slots['cert.healthCert']?.value ?? cand.certificates.healthCert?.has;
  const lines = [
    `${cand.basic.name} / ${cand.basic.age} / ${cand.basic.gender === 'male' ? '男' : '女'} / 住${cand.current.district.name}`,
    `意向：${job.positionName}（${job.store.name}）`,
    `已知：${[
      shift ? `班次 ${String(shift)}` : null,
      salary ? `期望 ${Array.isArray(salary) ? salary[0] : salary}` : null,
      hasLiving(job.benefits, 'dorm_included') ? '包住' : null,
    ]
      .filter(Boolean)
      .join('、')}`,
    `健康证：${health ? '有' : '没有，需入职前办'}`,
    `看过：${handoffTitle(job)}，判定 ${match.decision}`,
    '建议：直接发面试表，约本周到厂',
  ];
  return lines.join('\n');
}

function handoffTitle(job: JobOrder): string {
  return `${job.positionName}（${job.locations[0]?.district.name ?? ''} ${job.schedule.shift.label}）`;
}

/** 表单 id 由会话 + 岗位 + 轮次决定：恢复审批多少次，都还是同一张表 */
function formIdOf(conversationId: string, jobId: string, turn: number): string {
  let h = 2166136261;
  const seed = `${conversationId}|${jobId}|${turn}`;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `form-${(h >>> 0).toString(36)}`;
}

function stateOf(decision: string): ConversationState {
  switch (decision) {
    case 'not_match':
      return 'DISCOVERY';
    case 'negotiable':
      return 'MATCHING';
    case 'auto_match':
    case 'suggest':
      return 'FORM_SENT';
    default:
      return 'COLLECTING';
  }
}

/** 硬条件否决的理由。只说改不了的那一条，不罗列全部分数 */
function mismatchReason(match: MatchAssessment): string {
  const hard = match.negotiable.find((n) => n.verdict === 'reject' && n.hard);
  if (hard?.note) return `${hard.note}。`;
  if (hard) return `这个岗位要${hard.actual}，你这边不合适。`;
  const failed = match.blocking.filter((b) => b.pass === false);
  if (failed.length > 0) return `这个岗位卡${failed[0]!.field}，你这边不符合。`;
  return '这个岗位可能不太合适。';
}

// ── 主流程 ───────────────────────────────────────────────────

export function handle(
  req: AgentRequest,
  understanding?: Understanding,
  ctx?: DecisionContext,
): AgentResponse {
  const t0 = Date.now();
  const trace: TraceStep[] = [];

  const candidate = req.subject.candidate.snapshot;
  const job = req.subject.jobOrder.snapshot;

  if (!candidate || !job) {
    return {
      traceId: req.conversationId,
      conversationId: req.conversationId,
      actions: [{ type: 'handoff', reason: 'missing_snapshot', summary: '缺少快照' }],
      state: 'HANDOFF',
      meta: {
        intent: [],
        topics: [],
        action: 'none',
        intentConfidence: 0,
        escalated: true,
        degraded: true,
        cached: false,
        latencyMs: Date.now() - t0,
        model: 'rule-v0',
        promptVersion: 'v0',
      },
      trace,
    };
  }

  const msg = req.message ?? { type: 'text' as const, text: '', sentAt: '' };
  const text = msg.text ?? '';

  // 工具召回在决策之前完成，决策本身不碰网络
  const jobPool = ctx?.jobPool ?? [];
  if (ctx) {
    const policyNote = ctx.policy
      ? ` · policy ${ctx.policy.refused ? '拒答' : ctx.policy.hits[0]?.chunk.id} (${ctx.policy.topScore})`
      : '';
    trace.push({
      node: 'tool',
      detail: `searchJobPool → ${ctx.jobPool.length} 个候选${policyNote}`,
      ms: ctx.searchMs ?? 0,
    });
  }

  const conv = getConversation(req.conversationId);
  const isFirst = conv.turns === 0;
  trace.push({
    node: 'ingest',
    detail: `第 ${conv.turns + 1} 条: ${text.slice(0, 30)}`,
    ms: Date.now() - t0,
  });

  // 非文本消息：不假装看懂。连续 2 条说明用户不习惯打字，转人工比继续磨更合适
  if (msg.type !== 'text') {
    trace.push({ node: 'media', detail: msg.type, ms: 0 });
    const streak = (conv.nonTextStreak ?? 0) + 1;
    const escalate = streak >= 2;
    const reply = escalate
      ? '你发的我这边确实看不了。我让招人的同事直接联系你，你用文字说一句也行。'
      : msg.type === 'voice'
        ? '语音我这儿听不了，你打字发我就行。想问啥直接说。'
        : '图片我看不太准，你用文字说一下就行。';
    const actions: AgentAction[] = [{ type: 'text', text: reply }];
    if (escalate) {
      actions.push({
        type: 'handoff',
        reason: 'repeated_non_text',
        summary: `连续 ${streak} 条非文本消息（${msg.type}），用户可能不习惯打字`,
      });
    }
    saveConversation(req.conversationId, {
      turns: conv.turns + 1,
      nonTextStreak: streak,
      state: escalate ? 'HANDOFF' : conv.state === 'GREETING' ? 'DISCOVERY' : conv.state,
    });
    return {
      traceId: req.conversationId,
      conversationId: req.conversationId,
      actions,
      state: escalate ? 'HANDOFF' : conv.state === 'GREETING' ? 'DISCOVERY' : conv.state,
      meta: {
        intent: ['非文本'],
        topics: [],
        action: 'none',
        intentConfidence: 1,
        escalated: escalate,
        degraded: false,
        cached: false,
        latencyMs: Date.now() - t0,
        model: 'rule-v0',
        promptVersion: 'v0',
      },
      trace,
    };
  }

  const und = understanding ?? ruleUnderstanding(text, job);
  const confidence = und.confidence;
  trace.push({
    node: 'nlu',
    detail:
      `${und.source === 'model' ? '模型' : '规则'} ` +
      `action=${und.action} topics=${und.topics.join(',')}` +
      `${und.degraded ? ' · 降级' : ''}${und.note ? ` (${und.note})` : ''}`,
    ms: und.latencyMs,
  });

  // 槽位 = 简历基线 + 会话里已抽取的 + 上一轮问题的回答 + 本轮新说的
  // 顺序有讲究：先接短回答，再用本轮的明确说法覆盖——"可以，不过我只能上白班"
  let slots: SlotMap = refreshSlots({ ...baseSlots(candidate), ...conv.slots });
  const pending = applyPendingAnswer(text, slots, conv.pendingField, job);
  slots = pending.slots;

  // 改之前先记一笔：他前后说的不一致时，得能查出来
  const changes = detectSlotChanges(slots, und);
  if (changes.length > 0) {
    trace.push({
      node: 'conflict',
      detail: changes.map((c) => `${c.key} ${String(c.from)} → ${String(c.to)}`).join('；'),
      ms: 0,
    });
  }

  slots = applyUnderstanding(und, slots, text, job);
  trace.push({
    node: 'slots',
    detail: `${Object.keys(slots).length} 个：${Object.keys(slots).join(', ')}`,
    ms: Date.now() - t0,
  });

  const match = evaluate(job, candidate, slots);
  trace.push({
    node: 'match',
    detail: `${match.decision} (${match.score}) 待问 ${match.openQuestions.length}`,
    ms: Date.now() - t0,
  });

  // ── 组话 ──────────────────────────────────────────────────
  // 固定三段：打招呼（仅首条）→ 回答他问的那一句 → 一个推进动作。
  // 不主动报价：他没问薪资，塞进来就是噪音。
  const parts: string[] = [];
  const actions: AgentAction[] = [];
  let state: ConversationState = 'DISCOVERY';
  let pendingField: string | undefined;
  let interviewAskedJobId = conv.interviewAskedJobId;

  const topics = und.topics;
  // 模型偶尔把"体检"归到 requirement。没有要求类字眼时别答非所问
  const answerable = topics.filter(
    (t) =>
      ANSWERABLE_TOPICS.includes(t) &&
      (t !== 'requirement' || /(经验|技能|要会|学历|年龄|要求)/.test(text)),
  );
  const wantsOther = und.action === 'want_other' || und.action === 'reject';
  const interviewGo = conv.pendingField === 'interview' && pending.ok;
  const interviewNo = conv.pendingField === 'interview' && pending.no;

  // 知识库只补结构化字段答不了的那部分；拒答时一个字都不编
  const policyText =
    ctx?.policy && !ctx.policy.refused ? ctx.policy.hits[0]?.chunk.text : undefined;

  // 已经按"换岗/拒绝"处理过的诉求，就不必再说"我不太确定"——
  // 那句附言是留给"没接住的东西"的，不能被已经接住的事占用；
  // 知识库已经答上的，也不算"没接住"
  const unclearForReply = wantsOther || policyText ? undefined : und.unclear;

  const answer = wantsOther ? '' : answerFacts(answerable, job, candidate);
  if (isFirst) parts.push(answer ? `你好，${answer}` : '你好。');
  else if (answer) parts.push(answer);

  if (policyText && !wantsOther) {
    parts.push(policyText);
    trace.push({
      node: 'rag',
      detail: `${ctx!.policy!.hits[0]!.chunk.id} · ${ctx!.policy!.topScore} · ${ctx!.policy!.mode}`,
      ms: 0,
    });
  }

  // 改口了而且幅度不小，就点一句，别装作一直在用同一个数
  const salaryChange = changes.find((c) => c.key === 'pref.salaryTarget');
  if (salaryChange) {
    const prev = Number(salaryChange.from);
    const next = Number(salaryChange.to);
    if (prev > 0 && Math.abs(next - prev) / prev > 0.1) {
      parts.push(`按你刚说的 ${next} 算。`);
    }
  }

  // 接住了上一轮的问题，得有个回应，不然下一个问题来得像没听见
  if (pending.answered && pending.ok && !interviewGo && parts.length === 0) {
    parts.push('行。');
  }

  const preNote = (): string => {
    const unsat = match.preconditions.filter((p) => !p.satisfied);
    return unsat.length > 0 ? `${unsat.map((u) => u.label).join('、')}入职前能补上就行。` : '';
  };

  // 用户主动要微信：这是平台提供的「换微信」功能，合规，走转出而不是拒绝。
  // 但 agent 自己报号仍是红线，所以只指路 + 交接，不给任何联系方式。
  const wantsTransfer = topics.includes('contact') && und.action !== 'want_other';
  if (wantsTransfer) {
    parts.push('平台上有个「换微信」按钮，点了会话就转到微信。我先把你的情况整理给顾问，你到那边不用再说一遍。');
    actions.push({ type: 'text', text: parts.join('\n') });
    actions.push({
      type: 'handoff',
      reason: 'user_requested_wechat',
      summary: handoffSummary(candidate, job, slots, match),
    });
    state = 'TRANSFERRED';
    pendingField = undefined;
    saveConversation(req.conversationId, {
      slots,
      state,
      jobOrderId: job.id,
      turns: conv.turns + 1,
      pendingField,
      interviewAskedJobId,
      nonTextStreak: 0,
      slotChanges: [...(conv.slotChanges ?? []), ...changes],
    });
    trace.push({ node: 'transfer', detail: '用户要求换微信 → 转出', ms: 0 });
    return finish(req, actions, state, trace, t0, und, confidence, match, undefined);
  }

  // 明确拒绝面试：先于"换岗"判断。
  // 他拒绝的是这一次面试，不是这个岗位——别立刻推一堆别的岗位给他。
  if (interviewNo && und.action !== 'want_other') {
    parts.push('行，那你再考虑考虑，有想了解的随时问我。');
    saveConversation(req.conversationId, {
      slots,
      state: 'MATCHING',
      jobOrderId: job.id,
      turns: conv.turns + 1,
      pendingField: undefined,
      interviewAskedJobId: job.id,
      nonTextStreak: 0,
       slotChanges: [...(conv.slotChanges ?? []), ...changes],
    });
    return finish(
      req,
      [{ type: 'text', text: parts.join('\n') }],
      'MATCHING',
      trace,
      t0,
      und,
      confidence,
      match,
      unclearForReply,
    );
  }

  // 用户主动要别的 → 推卡（这是唯一"用户发起"的换岗）
  if (wantsOther) {
    const lead = und.action === 'reject' ? '行，那我给你看看别的。' : '我看看你附近还有哪些合适的。';
    parts.push(lead);
    const recs = recommend(candidate, slots, jobPool, { exclude: [job.id], limit: 3 }).filter((r) =>
      r.job.platformEnabled.includes(req.platform),
    );
    actions.push({ type: 'text', text: parts.join('\n') });
    if (recs.length > 0) {
      actions.push({
        type: 'job_cards',
        jobs: recs.map((r) => toCard(r.job, candidate, r.reasons.join('、'), req.platform)),
        reason: 'user_asked',
      });
      state = 'DISCOVERY';
    } else {
      actions.push({ type: 'handoff', reason: 'no_candidate', summary: '本池没有合适岗位，转人工' });
      state = 'HANDOFF';
    }
    trace.push({ node: 'recommend', detail: `${recs.length} 个候选`, ms: Date.now() - t0 });
    saveConversation(req.conversationId, {
      slots,
      state,
      jobOrderId: job.id,
      turns: conv.turns + 1,
      pendingField: undefined,
      interviewAskedJobId,
      nonTextStreak: 0,
       slotChanges: [...(conv.slotChanges ?? []), ...changes],
    });
    return finish(req, actions, state, trace, t0, und, confidence, match, unclearForReply);
  }

  if (match.decision === 'not_match') {
    // 硬条件否决（班次冲突 / 年龄卡）→ 换岗。这是"改不了的"，不是"谈不谈得拢"
    parts.push(`${mismatchReason(match)}我看看你附近还有哪些合适的。`);
    const recs = recommend(candidate, slots, jobPool, { exclude: [job.id], limit: 3 }).filter((r) =>
      r.job.platformEnabled.includes(req.platform),
    );
    actions.push({ type: 'text', text: parts.join('\n') });
    if (recs.length > 0) {
      actions.push({
        type: 'job_cards',
        jobs: recs.map((r) => toCard(r.job, candidate, r.reasons.join('、'), req.platform)),
        reason: 'not_match',
      });
      state = 'DISCOVERY';
    } else {
      actions.push({ type: 'handoff', reason: 'no_candidate', summary: '本池没有合适岗位，转人工' });
      state = 'HANDOFF';
    }
    trace.push({ node: 'recommend', detail: `${recs.length} 个候选`, ms: Date.now() - t0 });
  } else if (match.decision === 'insufficient_data') {
    parts.push(match.openQuestions[0]?.question ?? '你期望一个月到手多少？');
    state = 'COLLECTING';
    pendingField = match.openQuestions[0]?.field ?? 'salaryExpect';
    actions.push({ type: 'text', text: parts.join('\n') });
  } else if (interviewGo) {
    // 他答应了，才发采集表。前置条件上一句刚说过，不重复
    parts.push('好，那就这么定。把下面这个填一下，我帮你约时间。');
    const formId = formIdOf(req.conversationId, job.id, conv.turns + 1);
    actions.push({ type: 'text', text: parts.join('\n') });
    actions.push({
      type: 'interview_form',
      formId,
      url: `https://example.com/f/${formId}`,
      prefill: {
        岗位: jobName(job),
        姓名: candidate.basic.name,
        电话: candidate.basic.phone,
        面试方式: '到厂面试',
        地址: job.locations[0]!.address,
      },
    });
    state = 'FORM_SENT';
    pendingField = undefined;
    trace.push({ node: 'form', detail: formId, ms: Date.now() - t0 });
  } else if (match.openQuestions.length > 0) {
    // 判断依据还不齐：先问。表是收集信息的，不是替代判断的
    const q = match.openQuestions[0]!;
    parts.push(q.question);
    state = 'COLLECTING';
    pendingField = q.field;
    actions.push({ type: 'text', text: parts.join('\n') });
    trace.push({ node: 'ask', detail: q.field, ms: Date.now() - t0 });
  } else if (match.decision === 'negotiable') {
    // 薪资/通勤差一点：问一次。不推卡——岗位是用户自己点进来的
    parts.push(match.probe?.question ?? '这个跟你想要的差一点，你能接受吗？');
    state = 'MATCHING';
    pendingField = match.negotiable.find((n) => n.verdict !== 'ok' && !n.hard)?.field;
    actions.push({ type: 'text', text: parts.join('\n') });
  } else if (interviewAskedJobId === job.id) {
    // 问过一次了，他没答应也没拒绝：不再催，只回答他问的
    if (parts.length === 0) parts.push('嗯，你想好了随时跟我说。');
    state = 'MATCHING';
    actions.push({ type: 'text', text: parts.join('\n') });
  } else {
    // 条件都对得上：表达意向 + 问一句要不要面试
    // 跨岗位沿用他之前说过的约束，点明一句，别装作没记住
    const carried =
      conv.jobOrderId != null &&
      conv.jobOrderId !== job.id &&
      slots['constraint.shift']?.value === '长白班' &&
      job.schedule.shift.code === 'day';
    const rs = (carried ? match.reasons.filter((r) => !r.startsWith('长白班')) : match.reasons).slice(
      0,
      3,
    );
    const head = carried ? '按你之前说的只上白班，' : '';
    parts.push(`${head}这个岗位跟你挺合适的${rs.length > 0 ? `（${rs.join('、')}）` : ''}。${preNote()}要不要来面试？`);
    state = 'CONFIRMING';
    pendingField = 'interview';
    interviewAskedJobId = job.id;
    actions.push({ type: 'text', text: parts.join('\n') });
  }

  saveConversation(req.conversationId, {
    slots,
    state,
    jobOrderId: job.id,
    turns: conv.turns + 1,
    pendingField,
    interviewAskedJobId,
    nonTextStreak: 0,
     slotChanges: [...(conv.slotChanges ?? []), ...changes],
  });

  return finish(req, actions, state, trace, t0, und, confidence, match, unclearForReply);
}

function finish(
  req: AgentRequest,
  actions: AgentAction[],
  state: ConversationState,
  trace: TraceStep[],
  t0: number,
  und: Understanding,
  confidence: number,
  match: MatchAssessment | undefined,
  unclear?: string,
): AgentResponse {
  let finalActions = actions;
  let escalated = actions.some((a) => a.type === 'handoff');

  // 有归不了类的诉求：宁可承认一句，也不要装作答完了
  if (unclear) {
    const idx = finalActions.findIndex((a) => a.type === 'text');
    const hit = idx >= 0 ? finalActions[idx] : undefined;
    if (hit && hit.type === 'text') {
      const next = [...finalActions];
      next[idx] = {
        type: 'text',
        text: `${hit.text}\n另外你说的「${unclear}」我不太确定，我让招人的同事看一下。`,
      };
      finalActions = next;
    }
    escalated = true;
    trace.push({ node: 'unclear', detail: unclear, ms: 0 });
  }

  return {
    traceId: `trace-${Date.now()}`,
    conversationId: req.conversationId,
    actions: finalActions,
    state,
    meta: {
      // 展示用；判断一律读 topics / action
      intent: [...und.topics, ...(und.action === 'none' ? [] : [und.action])],
      topics: und.topics,
      action: und.action,
      intentConfidence: confidence,
      match,
      escalated,
      degraded: false,
      cached: false,
      latencyMs: Date.now() - t0,
      model: 'rule-v0',
      promptVersion: 'v0',
    },
    trace,
  };
}

export { stateOf };
