import { hasBonus, hasInsurance, hasLiving, shiftLabel } from './format';
import { freshnessPrefix, isUsable } from './slots';
import { canonicalIdsOfJob, canonicalizeAll, resolveShiftCode } from './tags';
import type {
  BlockingCheck,
  Candidate,
  JobOrder,
  MatchAssessment,
  NegotiableCheck,
  OpenQuestion,
  PrefCheck,
  Precondition,
  SlotMap,
} from './types';

/**
 * 判断"能不能"归规则，"像不像"归语义。
 * 本文件只做前半句——全部是确定性计算，不调模型。
 */

/** 差距 ≤5% 直接推；5–10% 试探一次；>10% 坦白问一次 */
export const TOLERANCE = { direct: 0.05, probe: 0.1 };

/** 通勤：>75 分钟提示，60–75 提示一次，<60 通过 */
export const COMMUTE = { ok: 60, probe: 75 };

function toMinutes(hhmm?: string): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// ── 薪资口径 ─────────────────────────────────────────────────

/** 综合口径下限：不加班的稳定到手 */
export function monthlyFloor(job: JobOrder): number {
  return job.pay.displayMin;
}

/**
 * 综合口径上限：愿意多加班、拿满绩效能到的水位。
 * 判断"给不给得起"必须用这个——用下限会把区间宽的岗位全误杀。
 */
export function monthlyCeiling(job: JobOrder): number {
  return job.pay.displayMax;
}

/**
 * 薪资必须说清构成。
 * 简单结构（日结/纯时薪）不拆，复杂结构（保底+全勤+加班）必须拆。
 */
export function salaryBrief(job: JobOrder): string {
  const p = job.pay;
  if (p.mode === 'daily' && p.dailyRate) {
    return `${p.dailyRate} 一天，${p.settle}`;
  }
  if (p.mode === 'hourly' && p.hourlyRate) {
    return `${p.hourlyRate.min} 到 ${p.hourlyRate.max} 一小时，月综合看加班`;
  }
  const parts: string[] = [`保底 ${p.base}`];
  if (p.fullAttendance) parts.push(`全勤 ${p.fullAttendance}`);
  if (p.performance) parts.push(`绩效 ${p.performance}`);
  const head = parts.join(' + ');
  // 综合价差在哪必须说清楚，否则就是虚高承诺
  const otNote = p.overtime ? '，加班另算' : '';
  return `${head}${otNote}，综合 ${p.displayMin} 到 ${p.displayMax}`;
}

/** 采集表上的岗位名。用结构化字段，不去解析展示串——那玩意儿改个格式就崩 */
export function jobName(job: JobOrder): string {
  return job.positionName || job.title;
}

// ── 通勤 ─────────────────────────────────────────────────────

/**
 * 区级通勤矩阵（分钟）。
 * 业务端会在 locations[].commuteMinutes 里传实时值；没传才走这里兜底。
 * 只有候选人和岗位同住一个区时，岗位级的 commuteMinutes 才成立——
 * 三个候选人共用一个数字是错的。
 */
const COMMUTE_MATRIX: Record<string, Record<string, number>> = {
  '330109': { '330109': 20, '330108': 45, '330110': 65 }, // 萧山
  '330108': { '330109': 45, '330108': 15, '330110': 55 }, // 滨江
  '330110': { '330109': 65, '330108': 55, '330110': 20 }, // 余杭
};

export function commuteMinutes(job: JobOrder, cand?: Candidate): number | null {
  const primary = job.locations.find((l) => l.isPrimary) ?? job.locations[0];
  if (!primary) return null;

  if (cand) {
    const byDistrict =
      COMMUTE_MATRIX[cand.current.district.code]?.[primary.district.code];
    if (byDistrict != null) return byDistrict;
  }
  return primary.commuteMinutes ?? null;
}

/** 只说三档，绝不给用户报精确分钟——那个数字没人信，也没人算得准 */
export function commuteLabelOf(job: JobOrder, cand?: Candidate): string {
  const m = commuteMinutes(job, cand);
  if (m == null) return '通勤未知';
  if (m < 30) return '半小时内';
  if (m <= 60) return '一小时左右';
  return '比较远';
}

// ── 三类检查 ─────────────────────────────────────────────────

function blockingChecks(job: JobOrder, cand: Candidate): BlockingCheck[] {
  const r = job.requirements;
  const age = cand.basic.age;
  const genderOk = r.gender === 'any' ? true : r.gender === cand.basic.gender;

  return [
    {
      field: 'age',
      required: `${r.ageMin}-${r.ageMax} 岁`,
      actual: `${age} 岁`,
      pass: age >= r.ageMin && age <= r.ageMax,
    },
    {
      field: 'gender',
      required: r.gender === 'any' ? '不限' : r.gender === 'male' ? '男' : '女',
      actual: cand.basic.gender === 'male' ? '男' : '女',
      pass: genderOk,
    },
    {
      field: 'employmentType',
      required:
        job.employmentType === 'both'
          ? '全职/兼职'
          : job.employmentType === 'full'
            ? '全职'
            : '兼职',
      actual: cand.jobType,
      pass:
        job.employmentType === 'both' ||
        cand.jobType === '都看' ||
        (job.employmentType === 'full' && cand.jobType === '全职') ||
        (job.employmentType === 'part' && cand.jobType === '兼职'),
    },
    {
      field: 'status',
      required: '在招',
      actual: job.status === 'open' ? '在招' : job.status === 'paused' ? '暂停' : '已关闭',
      pass: job.status === 'open' && job.headcount.left > 0,
    },
  ];
}

function firstNum(v: SlotMap[string] | undefined): number | undefined {
  // 过期＝未知：不能拿两个月前的数字继续判死
  if (!isUsable(v)) return undefined;
  const raw = v?.value;
  if (typeof raw === 'number') return raw;
  if (Array.isArray(raw)) return raw[0];
  return undefined;
}

/**
 * 取当前岗位能用的班次诉求。
 *
 * subject 作用域的槽位（"这个岗位的夜班我能接受"）只对绑定岗位有效；
 * 换到 B 之后必须重新问，不能把 A 的接受度当成 B 的。
 */
function shiftSlotFor(slots: SlotMap, jobId: string): SlotMap[string] | undefined {
  const slot = slots['constraint.shift'];
  if (!slot) return undefined;
  if (slot.scope === 'subject' && slot.jobOrderId && slot.jobOrderId !== jobId) return undefined;
  return slot;
}

/**
 * 期望薪资从哪来：**对话优先于简历**。
 *
 * 简历里的 6000 是他一周前填的；他刚说"得七千多"，那就是七千多。
 * 之前这里先读简历，导致对话里说的数字永远不生效——
 * 中文数字、口语说法全都白提取了。
 */
function salaryTargetOf(cand: Candidate, slots: SlotMap): number | undefined {
  const fromChat = firstNum(slots['pref.salaryTarget']);
  if (fromChat != null) return fromChat;
  return cand.expect.salaryMin;
}

/**
 * 薪资判定分三段，比较对象是**上限**：
 *   期望 ≤ 下限          → 完全满足，还能说"比你想的高"
 *   下限 < 期望 ≤ 上限   → 满足，但到手要看加班/绩效
 *   期望 > 上限          → 才按 5% / 10% 算差距
 * 用下限去减期望是最常见的错：区间越宽越容易被误杀。
 *
 * 另有一条：用户明确说过"这个数我能接受"，就是**底线**，不再是期望。
 * 底线够得着就放行，别拿简历上的期望反复卡他。
 */
function salaryCheck(job: JobOrder, cand: Candidate, slots: SlotMap): NegotiableCheck {
  const target = salaryTargetOf(cand, slots);
  const floor = monthlyFloor(job);
  const ceil = monthlyCeiling(job);
  const range = `${floor}-${ceil}`;

  if (!target) {
    return {
      field: 'salary',
      expected: '未提',
      actual: range,
      verdict: 'ok',
      note: '用户没提薪资预期',
    };
  }

  const explicitFloor = firstNum(slots['pref.salaryFloor']);
  if (explicitFloor != null && explicitFloor <= ceil) {
    return {
      field: 'salary',
      expected: `${target}`,
      actual: range,
      gapPct: 0,
      verdict: 'ok',
      note: `你已说过 ${explicitFloor} 能接受`,
    };
  }

  if (target <= floor) {
    const lead = Math.round(((floor - target) / target) * 100);
    return {
      field: 'salary',
      expected: `${target}`,
      actual: range,
      gapPct: -lead,
      verdict: 'ok',
      note: lead > 0 ? `比你想的高 ${lead}%` : '跟你期望持平',
    };
  }

  if (target <= ceil) {
    return {
      field: 'salary',
      expected: `${target}`,
      actual: range,
      gapPct: 0,
      verdict: 'ok',
      note: `想拿到 ${target} 得配合加班`,
    };
  }

  const gap = (target - ceil) / target;
  const gapPct = Number((gap * 100).toFixed(1));
  const verdict: NegotiableCheck['verdict'] =
    gap <= TOLERANCE.direct ? 'ok' : gap <= TOLERANCE.probe ? 'probe' : 'reject';

  return {
    field: 'salary',
    expected: `${target}`,
    actual: range,
    gapPct,
    verdict,
    note: `最多给到 ${ceil}，比预期低 ${Math.round(gap * 100)}%`,
  };
}

function commuteCheck(job: JobOrder, cand: Candidate): NegotiableCheck {
  const m = commuteMinutes(job, cand);
  if (m == null) {
    return { field: 'commute', expected: '<60 分钟', actual: '未知', verdict: 'ok' };
  }
  const verdict: NegotiableCheck['verdict'] =
    m <= COMMUTE.ok ? 'ok' : m <= COMMUTE.probe ? 'probe' : 'reject';
  return {
    field: 'commute',
    expected: '<60 分钟',
    actual: commuteLabelOf(job, cand),
    verdict,
  };
}

/**
 * 班次：把「理由」代入新岗位的实际条件再判断，
 * 而不是只比 pattern 字符串。
 *
 * 这是唯一设 hard 的可谈项：用户说"只能上白班"是硬约束，
 * 岗位给不了就是给不了，该换岗——不是"你能接受吗"。
 */
function shiftCheck(job: JobOrder, slots: SlotMap): NegotiableCheck {
  const slot = shiftSlotFor(slots, job.id);
  const shift = job.schedule.shift;
  const label = shiftLabel(job.schedule);
  const end = toMinutes(job.schedule.end);

  // 过期＝未知：不拿两个月前的班次偏好直接判死，交给 openQuestions 重问
  if (!slot || !isUsable(slot)) {
    return {
      field: 'shift',
      expected: slot ? '已过期' : '未提',
      actual: label,
      verdict: 'ok',
      note: slot?.state === 'expired' ? '班次偏好已过期，需要重新确认' : undefined,
    };
  }

  const wantsDay = slot.value === '长白班';
  const reason = slot.reason ?? '';

  // 自定义倒班先归一：置信度 ≥0.95（字典/人工）才敢拿来判，
  // 低置信只展示，不否决——"月休五天"这种词库外的东西不能自动判死
  const resolved = resolveShiftCode(shift);
  if (!resolved.code || resolved.confidence < 0.95) {
    return {
      field: 'shift',
      expected: wantsDay ? '长白班' : '不限',
      actual: label,
      verdict: 'ok',
      note: `班次是自定义的（${label}），判断不了，交给人工确认`,
    };
  }

  const isDay = resolved.code === 'day';

  if (wantsDay && !isDay) {
    return {
      field: 'shift',
      expected: '长白班',
      actual: label,
      verdict: 'reject',
      hard: true,
      note: reason ? `你要${reason}，${label}做不到` : undefined,
    };
  }

  // 理由代入：接孩子 5:30，看下班时间够不够
  if (wantsDay && end != null && end > toMinutes('17:30')!) {
    return {
      field: 'shift',
      expected: '17:30 前下班',
      actual: job.schedule.end ?? '',
      verdict: 'reject',
      hard: true,
      note: reason ? `${job.schedule.end} 才下班，${reason}来不及` : undefined,
    };
  }

  return {
    field: 'shift',
    expected: wantsDay ? '长白班' : '不限',
    actual: label,
    verdict: 'ok',
  };
}

function preferenceChecks(job: JobOrder, cand: Candidate): PrefCheck[] {
  // 用户的"想找包吃住"也走同一套规范层；两边原文不同也能对上
  const jobIds = canonicalIdsOfJob(job).ids;
  const wants = (id: string) =>
    (cand.constraints ?? []).some((c) => canonicalizeAll(c).some((m) => m.id === id));

  return [
    {
      field: 'meal',
      expected: wants('meal.provided') ? '包吃' : '不限',
      satisfied: jobIds.has('meal.provided'),
    },
    {
      field: 'dorm',
      expected: wants('dorm.provided') ? '包住' : '不限',
      satisfied: jobIds.has('dorm.provided'),
    },
  ];
}

/** 健康证缺失不是 not_match，是「可解决的前置条件」 */
function preconditions(job: JobOrder, cand: Candidate, slots: SlotMap): Precondition[] {
  if (!job.requirements.healthCert) return [];

  // 对话里说的盖过简历：他刚说"健康证有"，就按有算；过期了就不算
  const asserted = slots['cert.healthCert'];
  const has =
    asserted && isUsable(asserted) && typeof asserted.value === 'boolean'
      ? asserted.value
      : (cand.certificates.healthCert?.has ?? false);

  return [
    {
      field: 'healthCert',
      label: '健康证',
      satisfied: has,
      note: has ? undefined : '入职前办好即可，可以办',
    },
  ];
}

/**
 * 还缺什么判断依据。
 *
 * 只问"判断必需的、简历给不了的"。健康证不在里面——它能入职前补，
 * 不是判断依据；问了就是白占一个回合。
 */
function openQuestions(job: JobOrder, cand: Candidate, slots: SlotMap): OpenQuestion[] {
  const q: OpenQuestion[] = [];

  // 只有归一过的倒班才敢拿来问；自定义的问了也没法判
  const shift = job.schedule.shift;
  const resolvedShift = resolveShiftCode(shift);
  const needsRotating =
    resolvedShift.confidence >= 0.95 &&
    (resolvedShift.code === 'two_shift' ||
      resolvedShift.code === 'three_shift' ||
      resolvedShift.code === 'night');
  const shiftSlot = shiftSlotFor(slots, job.id);

  // 没有、或已经过期，都要重新问。过期不是丢掉，是降级成"未知"
  if (needsRotating && (!shiftSlot || shiftSlot.state === 'expired')) {
    const s = job.schedule;
    const label = shiftLabel(s);
    if (shiftSlot?.state === 'expired') {
      const prev = Array.isArray(shiftSlot.value) ? shiftSlot.value.join('-') : String(shiftSlot.value);
      q.push({
        field: 'shift',
        question: `${freshnessPrefix(shiftSlot)}${prev}${shiftSlot.reason ? `（${shiftSlot.reason}）` : ''}，现在还是这样吗？`,
      });
    } else {
      q.push({
        field: 'shift',
        // 光问"能接受两班倒吗"太干，把时间点带上，用户才知道要接受的是什么
        question:
          s.start && s.end
            ? `我们这边是${label}，${s.start} 到 ${s.end}，你能接受吗？`
            : `我们这边是${label}，你能接受吗？`,
      });
    }
  }

  const salarySlot = slots['pref.salaryTarget'];
  if (!salaryTargetOf(cand, slots)) {
    q.push({ field: 'salaryExpect', question: '你期望一个月到手多少？' });
  } else if (salarySlot?.state === 'expired') {
    const prev = Array.isArray(salarySlot.value) ? salarySlot.value[0] : salarySlot.value;
    q.push({
      field: 'salaryExpect',
      question: `${freshnessPrefix(salarySlot)}期望 ${String(prev)}，现在还是这个数吗？`,
    });
  }

  return q;
}

// ── 主判定 ───────────────────────────────────────────────────

export function evaluate(job: JobOrder, cand: Candidate, slots: SlotMap): MatchAssessment {
  const blocking = blockingChecks(job, cand);
  const negotiable = [
    salaryCheck(job, cand, slots),
    commuteCheck(job, cand),
    shiftCheck(job, slots),
  ];
  const preferences = preferenceChecks(job, cand);
  const pre = preconditions(job, cand, slots);
  const qs = openQuestions(job, cand, slots);

  const missing = blocking.filter((b) => b.pass === null).map((b) => b.field);

  const failed = blocking.filter((b) => b.pass === false);
  const hardRejects = negotiable.filter((n) => n.verdict === 'reject' && n.hard);
  const softIssues = negotiable.filter((n) => n.verdict !== 'ok' && !n.hard);

  let decision: MatchAssessment['decision'];
  if (missing.length > 0) {
    decision = 'insufficient_data';
  } else if (failed.length > 0 || hardRejects.length > 0) {
    // 硬条件否决：改不了的，换岗
    decision = 'not_match';
  } else if (softIssues.length > 0) {
    // 薪资/通勤差一点：问，不赶人
    decision = 'negotiable';
  } else {
    const complete = cand.expect.salaryMin != null && cand.expect.positionCodes.length > 0;
    decision = complete ? 'auto_match' : 'suggest';
  }

  // 0–100 的可解释分：否决项扣得狠，可谈项轻扣
  let score = 100;
  score -= failed.length * 60;
  score -= hardRejects.length * 40;
  score -= softIssues.length * 12;
  score -= pre.filter((p) => !p.satisfied).length * 5;
  score -= preferences.filter((p) => !p.satisfied).length * 3;
  score = Math.max(0, Math.min(100, score));

  const reasons = buildReasons(job, cand, negotiable);

  const probe = softIssues.length
    ? {
        question: buildProbe(job, cand, softIssues),
        compensating: compensatingOf(job),
      }
    : undefined;

  return {
    decision,
    score,
    blocking,
    negotiable,
    preferences,
    preconditions: pre,
    missing,
    openQuestions: qs,
    probe,
    reasons,
  };
}

function compensatingOf(job: JobOrder): string | undefined {
  const c: string[] = [];
  if (hasLiving(job.benefits, 'dorm_included')) c.push('包住');
  if (hasLiving(job.benefits, 'meal_included')) c.push('包吃');
  if (hasBonus(job.benefits, 'meal_subsidy') && job.benefits.mealSubsidyPerDay) {
    c.push(`餐补 ${job.benefits.mealSubsidyPerDay}/天`);
  }
  if (hasInsurance(job.benefits, 'social')) c.push('交社保');
  if (hasBonus(job.benefits, 'full_attendance')) c.push('全勤奖');
  return c.length ? c.join('、') : undefined;
}

/**
 * 试探话术。
 * 差距小 → 说软话（补偿项兜一下）；差距大 → 不粉饰，直接报上限。
 * 两种情况都只问一次，不推别的岗位——岗位是用户自己点进来的。
 */
function buildProbe(job: JobOrder, cand: Candidate, issues: NegotiableCheck[]): string {
  const salary = issues.find((i) => i.field === 'salary');
  const commute = issues.find((i) => i.field === 'commute');
  const parts: string[] = [];

  if (salary) {
    const ceil = monthlyCeiling(job);
    // 这一句是用户第一次听到薪资，区间必须报全，不能只丢一个上限
    const range = `我们这边综合是 ${monthlyFloor(job)} 到 ${ceil}`;
    if (salary.verdict === 'reject') {
      parts.push(`${range}，跟你想的 ${salary.expected} 差得有点多`);
    } else {
      parts.push(`${range}，比你想的低一点`);
    }
  }

  if (commute) {
    parts.push(`过去${commuteLabelOf(job, cand)}`);
  }

  const comp = salary?.verdict === 'probe' ? compensatingOf(job) : undefined;
  const body = parts.join('，');
  const tail = comp ? `，不过${comp}，实际差不多` : '';
  return `${body}${tail}。你能接受吗？`;
}

/**
 * 只列**加分项**。
 * 通勤 45 分钟不是卖点，健康证要补办也不是卖点——
 * 后者在发采集表时单独说一句就够，堆在"挺合适的"后面反而像在挑刺。
 */
function buildReasons(job: JobOrder, cand: Candidate, negotiable: NegotiableCheck[]): string[] {
  const out: string[] = [];

  const salary = negotiable.find((n) => n.field === 'salary');
  if (salary && salary.verdict === 'ok' && (salary.gapPct ?? 0) < 0) {
    out.push('比你想要的高');
  }

  const m = commuteMinutes(job, cand);
  if (m != null && m < 30) out.push(commuteLabelOf(job, cand));
  if (resolveShiftCode(job.schedule.shift).code === 'day' && job.schedule.end) {
    out.push(`长白班 ${job.schedule.start}-${job.schedule.end}`);
  }

  if (hasLiving(job.benefits, 'meal_included')) out.push('包吃');
  if (hasLiving(job.benefits, 'dorm_included')) out.push('包住');
  if (hasInsurance(job.benefits, 'social')) out.push('交社保');

  return out;
}

// ── 兼容旧调用 ───────────────────────────────────────────────
export const commuteOf = commuteMinutes;
export const commuteLabel = commuteLabelOf;
