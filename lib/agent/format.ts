import type {
  Benefits,
  BonusCode,
  Choice,
  EducationCode,
  ExperienceCode,
  FacilityCode,
  InsuranceCode,
  JobOrder,
  LivingCode,
  MultiChoice,
  RestCode,
  Schedule,
  ShiftCode,
  SkillCode,
} from './types';

/**
 * 展示层。
 *
 * 所有"给人看的句子"都在这里拼，判定逻辑一律读结构化字段。
 * 之前是判定里顺手拼字符串，结果运营改个文案就可能把判定带歪。
 */

const SHIFT_LABEL: Record<ShiftCode, string> = {
  day: '长白班',
  night: '长夜班',
  two_shift: '两班倒',
  three_shift: '三班倒',
};

const REST_LABEL: Record<RestCode, string> = {
  monthly_4: '月休四天',
  weekend_2: '周末双休',
  work_6_rest_1: '做六休一',
};

/** 选项 code → 展示文案。自定义就返回运营填的原文 */
export function labelOf<T extends string>(
  choice: Choice<T>,
  dict: Record<string, string> | Record<T, string>,
): string {
  if (choice.code && choice.norm === 'mapped') {
    return (dict as Record<string, string>)[choice.code] ?? choice.label;
  }
  return choice.label;
}

export function shiftLabel(s: Schedule): string {
  return labelOf(s.shift, SHIFT_LABEL);
}

export function restLabel(s: Schedule): string {
  return labelOf(s.rest, REST_LABEL);
}

/** 归一过的作息，用"能算"的方式说：一个月休 4 天 */
export function restFact(s: Schedule): string {
  if (s.restDaysPerMonth != null) return `一个月休 ${s.restDaysPerMonth} 天`;
  // 没归一就照念原文，不做任何换算
  return restLabel(s);
}

/** 一天实际干多少小时（扣掉休息）；算不出来就是 null */
export function netWorkMinutes(s: Schedule): number | null {
  const start = toMinutes(s.start);
  const end = toMinutes(s.end);
  if (start == null || end == null) return null;

  const span = end > start ? end - start : end + 24 * 60 - start;
  const breakMin = s.breakIncluded ? (s.breakMinutes ?? 0) : 0;
  return Math.max(0, span - breakMin);
}

export function shiftBrief(job: JobOrder): string {
  const s = job.schedule;
  const hours = netWorkMinutes(s);
  const time =
    s.start && s.end ? `${s.start}-${s.end}` : '';
  const h = hours != null ? `，一天 ${(hours / 60).toFixed(1).replace(/\.0$/, '')} 小时` : '';
  return `${shiftLabel(s)}${time ? ` ${time}` : ''}${h}`;
}

function toMinutes(hhmm?: string): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 归一状态不好时，判定层要知道"这个维度不能算" */
export function isUnmapped<T extends string>(choice: Choice<T>): boolean {
  return choice.norm === 'unmapped' || choice.code == null;
}

// ── 薪资 / 宿舍 / 学历 等需要"从 code 拼成人话"的地方 ──────────

const SETTLE_LABEL: Record<string, string> = {
  monthly: '月结',
  daily: '日结',
  on_leave: '人走账清',
};

/** 「次月 15 号发」是拼出来的，不是存下来的 */
export function payDayText(pay: JobOrder['pay']): string {
  if (pay.payDayOfMonth == null) return SETTLE_LABEL[pay.settle] ?? '月结';
  const day = pay.payDayNextMonth ? `次月 ${pay.payDayOfMonth} 号` : `每月 ${pay.payDayOfMonth} 号`;
  return day;
}

const FACILITY_LABEL: Record<FacilityCode, string> = {
  ac: '空调',
  wifi: 'WiFi',
  water_heater: '热水器',
  washer: '洗衣机',
  toilet: '独立卫浴',
};

export function facilityLabels(codes: FacilityCode[] = []): string {
  return codes.map((c) => FACILITY_LABEL[c] ?? c).join('/');
}

/** 「6-8 人间」是算出来的，数据里只有 min/max */
export function capacityText(dorm: JobOrder['benefits']['dorm']): string {
  const { capacityMin: min, capacityMax: max } = dorm;
  if (min == null && max == null) return '';
  if (min != null && max != null && min !== max) return `${min}-${max} 人间`;
  return `${min ?? max} 人间`;
}

export function dormBrief(job: JobOrder): string {
  const d = job.benefits.dorm;
  if (!hasLiving(job.benefits, 'dorm_included')) return '住宿自理';
  const cap = capacityText(d);
  const fac = facilityLabels(d.facilities);
  return `包住${cap ? `，${cap}` : ''}${fac ? '，' + fac : ''}`;
}

// ── 多选福利：包吃住 / 社保 / 奖金 ───────────────────────────

export function hasLiving(b: Benefits, code: LivingCode): boolean {
  return b.living.codes.includes(code);
}

export function hasInsurance(b: Benefits, code: InsuranceCode): boolean {
  return b.insurance.codes.includes(code);
}

export function hasBonus(b: Benefits, code: BonusCode): boolean {
  return b.bonus.codes.includes(code);
}

const INSURANCE_LABEL: Record<InsuranceCode, string> = {
  social: '社保',
  accident: '意外险',
  commercial: '商业保险',
};

const BONUS_LABEL: Record<BonusCode, string> = {
  meal_subsidy: '餐补',
  housing_subsidy: '房补',
  full_attendance: '全勤奖',
  performance: '绩效奖金',
  year_end: '年终奖',
};

export function insuranceText(b: Benefits): string {
  const items = [...b.insurance.codes.map((c) => INSURANCE_LABEL[c] ?? c), ...b.insurance.custom];
  return items.length ? items.join('、') : '没有社保';
}

export function bonusText(b: Benefits): string {
  return [...b.bonus.codes.map((c) => BONUS_LABEL[c] ?? c), ...b.bonus.custom].join('、');
}

/** 「包吃/包住」是「包吃住」这一组多选里选出来的，不是两个独立布尔 */
export function livingBrief(b: Benefits): string {
  const meal = hasLiving(b, 'meal_included');
  const dorm = hasLiving(b, 'dorm_included');
  const extra = b.living.custom.length ? `（${b.living.custom.join('、')}）` : '';
  if (meal && dorm) return `包吃包住${extra}`;
  if (meal) return `包吃${extra}`;
  if (dorm) return `包住${extra}`;
  return b.living.custom.join('、');
}

const EDUCATION_LABEL: Record<EducationCode, string> = {
  none: '学历不限',
  middle: '初中',
  high: '高中',
  vocational: '中专/技校',
  college: '大专',
};

const EXPERIENCE_LABEL: Record<ExperienceCode, string> = {
  none: '经验不限',
  under_1y: '1 年以内',
  one_to_three: '1-3 年',
  three_plus: '3 年以上',
};

export function educationLabel(code: EducationCode): string {
  return EDUCATION_LABEL[code] ?? code;
}

const SKILL_LABEL: Record<SkillCode, string> = {
  line: '流水线',
  assembly: '组装',
  scan: '扫码',
  pack: '打包',
  inspect: '巡检',
  order: '点单',
  serve: '传菜',
  greet: '迎宾',
  cashier: '收银',
};

/** 技能也是多选 + 自定义，自定义项照样要说给用户听 */
export function skillText(m: MultiChoice<SkillCode>): string {
  return [...m.codes.map((c) => SKILL_LABEL[c] ?? c), ...m.custom].join('、');
}

export function experienceLabel(code: ExperienceCode): string {
  return EXPERIENCE_LABEL[code] ?? code;
}

/** 回复率是数字，标签是按阈值算出来的 */
export function replyRateLabel(rate?: number): string {
  if (rate == null) return '';
  if (rate >= 0.95) return '回复率很高';
  if (rate >= 0.8) return '回复率高';
  return '回复率一般';
}

