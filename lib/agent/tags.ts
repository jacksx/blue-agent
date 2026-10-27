import type { Choice, JobOrder, RestCode, ShiftCode } from './types';

/**
 * 标签归一化（§7.9）。
 *
 * 问题：招聘方和用户都能填自定义标签。「包吃」「管饭」「免费三餐」文本不同、
 * code 也不同（custom_8821 / custom_9932），比 code 全错，比文本只有一字不差才过。
 *
 * 做法：加一层 canonical。**所有比对只在规范层做**，原始文本只用于展示和回溯。
 *
 * 置信度分流（这是安全边界，不是装饰）：
 *   ≥0.95  字典/人工确认 → 可以参与硬条件判断
 *   0.8–0.95 包含/模糊匹配 → 只用于排序加分，不判死
 *   <0.8   拿不准 → unresolved，进人工队列，绝不自动判断
 *
 * 为什么这么严：把「管饭」误判成「不包吃」，用户问"包吃吗"会得到错误答案，
 * 而且他永远不知道自己被错判了。
 */

export type TagCategory =
  | 'insurance'
  | 'bonus'
  | 'meal'
  | 'dorm'
  | 'rest'
  | 'shift'
  | 'commission'
  | 'skill';

export interface CanonicalTag {
  id: string;
  category: TagCategory;
  name: string;
  aliases: string[];
}

export const CANONICAL_TAGS: CanonicalTag[] = [
  // 吃
  { id: 'meal.provided', category: 'meal', name: '包吃', aliases: ['包吃', '管饭', '免费三餐', '包三餐', '包伙食', '提供工作餐', '吃饭免费', '包中餐', '包午餐', '包吃住', '管吃管住'] },
  { id: 'meal.none', category: 'meal', name: '吃饭自理', aliases: ['吃饭自理', '不包吃', '不管饭', '伙食自理', '餐补自理', '吃自理'] },
  { id: 'meal.subsidy', category: 'meal', name: '餐补', aliases: ['餐补', '饭补', '伙食补贴', '餐费补贴', '餐贴'] },
  // 住
  { id: 'dorm.provided', category: 'dorm', name: '包住', aliases: ['包住', '管住', '提供住宿', '免费住宿', '包住宿', '住宿免费', '包吃住', '管吃管住'] },
  { id: 'dorm.none', category: 'dorm', name: '住宿自理', aliases: ['住宿自理', '不包住', '不管住', '自己租房'] },
  { id: 'dorm.subsidy', category: 'dorm', name: '房补', aliases: ['房补', '住房补贴', '外宿补贴', '租房补贴'] },
  // 社保
  { id: 'insurance.social', category: 'insurance', name: '社保', aliases: ['社保', '五险', '交社保', '五险一金', '社会保险'] },
  { id: 'insurance.accident', category: 'insurance', name: '意外险', aliases: ['意外险', '商业意外险', '工伤险'] },
  { id: 'insurance.commercial', category: 'insurance', name: '商业保险', aliases: ['商业保险', '补充医疗'] },
  // 奖金
  { id: 'bonus.full_attendance', category: 'bonus', name: '全勤奖', aliases: ['全勤', '全勤奖', '满勤'] },
  { id: 'bonus.performance', category: 'bonus', name: '绩效奖金', aliases: ['绩效', '绩效奖', '绩效奖金', '提成绩效'] },
  { id: 'bonus.year_end', category: 'bonus', name: '年终奖', aliases: ['年终奖', '年底双薪', '十三薪'] },
  // 作息
  { id: 'rest.monthly_4', category: 'rest', name: '月休四天', aliases: ['月休四天', '月休4天', '每月休4天', '月休四日'] },
  { id: 'rest.weekend_2', category: 'rest', name: '周末双休', aliases: ['周末双休', '双休', '做五休二'] },
  { id: 'rest.work_6_rest_1', category: 'rest', name: '做六休一', aliases: ['做六休一', '单休', '一周休一天', '六天工作制'] },
  // 班次
  { id: 'shift.day', category: 'shift', name: '长白班', aliases: ['长白班', '白班', '常白班', '只上白班', '固定白班'] },
  { id: 'shift.night', category: 'shift', name: '长夜班', aliases: ['长夜班', '夜班', '固定夜班'] },
  { id: 'shift.two_shift', category: 'shift', name: '两班倒', aliases: ['两班倒', '两班制', '白夜班', '两班轮换'] },
  { id: 'shift.three_shift', category: 'shift', name: '三班倒', aliases: ['三班倒', '三班制', '三班轮换'] },
  // 提成
  { id: 'commission.sales', category: 'commission', name: '销售额提成', aliases: ['销售额提成', '提成', '按销售额', '业绩提成'] },
  { id: 'commission.piece', category: 'commission', name: '计件提成', aliases: ['计件', '计件工资', '多劳多得'] },
  // 技能（只列 demo 用得到的）
  { id: 'skill.forklift', category: 'skill', name: '叉车', aliases: ['叉车', '开叉车', '叉车证'] },
  { id: 'skill.packing', category: 'skill', name: '打包', aliases: ['打包', '会用打包机', '包装'] },
  { id: 'skill.inspection', category: 'skill', name: '巡检', aliases: ['巡检', '质检', '品检'] },
];

const BY_CATEGORY = new Map<TagCategory, CanonicalTag[]>();
for (const tag of CANONICAL_TAGS) {
  const list = BY_CATEGORY.get(tag.category) ?? [];
  list.push(tag);
  BY_CATEGORY.set(tag.category, list);
}

const SEP_RE = /[\s，。！？、；：""''（）()【】\[\]<>《》,.!?;:'"~`@#$%^&*_+=|\\/—-]/g;

export function normalizeTagText(text: string): string {
  return text.replace(SEP_RE, '').toLowerCase();
}

const NEGATIVE_RE = /(不包|不管|不供|不含|自理|没有|无住|无吃|不提供)/;

export type CanonicalizeMethod = 'dict' | 'contains' | 'fuzzy' | 'negative' | 'unresolved';

export interface CanonicalMatch {
  id: string | null;
  category?: TagCategory;
  confidence: number;
  method: CanonicalizeMethod;
  matched?: string;
  /** 原文，保留下来用于回溯 */
  raw: string;
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

function dice(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return (2 * inter) / (A.size + B.size);
}

function candidateTags(category?: TagCategory): CanonicalTag[] {
  return category ? (BY_CATEGORY.get(category) ?? []) : CANONICAL_TAGS;
}

/**
 * 把一段自定义文本归到 canonical。
 * 先处理否定（"不包吃" 不能因为包含 "包吃" 就归成正向）。
 */
export function canonicalizeText(raw: string, category?: TagCategory): CanonicalMatch {
  const text = normalizeTagText(raw);
  if (!text) return { id: null, confidence: 0, method: 'unresolved', raw };

  const pool = candidateTags(category);

  // 否定优先：只有 meal/dorm 有反向标签
  if (NEGATIVE_RE.test(text)) {
    const negative = pool.find((t) => t.id.endsWith('.none') || t.id.endsWith('.self'));
    if (negative) {
      return { id: negative.id, category: negative.category, confidence: 0.98, method: 'negative', matched: negative.name, raw };
    }
  }

  for (const tag of pool) {
    for (const alias of tag.aliases) {
      if (text === normalizeTagText(alias)) {
        return { id: tag.id, category: tag.category, confidence: 0.98, method: 'dict', matched: alias, raw };
      }
    }
  }

  // 包含匹配：只给 0.9，能排序不能判死
  let best: { tag: CanonicalTag; alias: string } | undefined;
  for (const tag of pool) {
    for (const alias of tag.aliases) {
      const a = normalizeTagText(alias);
      if (a.length >= 2 && text.includes(a)) {
        if (!best || a.length > normalizeTagText(best.alias).length) best = { tag, alias };
      }
    }
  }
  if (best) {
    return {
      id: best.tag.id,
      category: best.tag.category,
      confidence: 0.9,
      method: 'contains',
      matched: best.alias,
      raw,
    };
  }

  // 模糊：只给 0.82，低于硬判阈值
  let fuzzy: { tag: CanonicalTag; score: number; alias: string } | undefined;
  for (const tag of pool) {
    for (const alias of tag.aliases) {
      const score = dice(text, normalizeTagText(alias));
      if (score >= 0.75 && (!fuzzy || score > fuzzy.score)) fuzzy = { tag, score, alias };
    }
  }
  if (fuzzy) {
    return {
      id: fuzzy.tag.id,
      category: fuzzy.tag.category,
      confidence: Number((0.7 + fuzzy.score * 0.15).toFixed(2)),
      method: 'fuzzy',
      matched: fuzzy.alias,
      raw,
    };
  }

  return { id: null, confidence: 0, method: 'unresolved', raw };
}

/** 硬判断只认 ≥0.95：字典/人工确认 */
export const HARD_TAG_CONFIDENCE = 0.95;

export function isHardUsable(match: CanonicalMatch): boolean {
  return match.id != null && match.confidence >= HARD_TAG_CONFIDENCE;
}

/**
 * 一条文本可能命中多个标签："包吃住" 同时是 meal.provided + dorm.provided。
 * 单值版本用于展示/兜底，多值版本用于判定。
 */
export function canonicalizeAll(raw: string, categories?: TagCategory[]): CanonicalMatch[] {
  const text = normalizeTagText(raw);
  if (!text) return [];

  const pool = categories?.length
    ? categories.flatMap((c) => BY_CATEGORY.get(c) ?? [])
    : CANONICAL_TAGS;

  const out: CanonicalMatch[] = [];
  const seen = new Set<string>();

  const push = (m: CanonicalMatch) => {
    if (!m.id || seen.has(m.id)) return;
    seen.add(m.id);
    out.push(m);
  };

  // 否定只对"整句是对某个正向标签的否定"生效，不能把"包吃住"里的住也否掉
  if (NEGATIVE_RE.test(text)) {
    for (const tag of pool) {
      if (!(tag.id.endsWith('.none') || tag.id.endsWith('.self'))) continue;
      for (const alias of tag.aliases) {
        if (text.includes(normalizeTagText(alias))) {
          push({
            id: tag.id,
            category: tag.category,
            confidence: 0.98,
            method: 'negative',
            matched: alias,
            raw,
          });
        }
      }
    }
    if (out.length > 0) return out;
  }

  for (const tag of pool) {
    for (const alias of tag.aliases) {
      const a = normalizeTagText(alias);
      if (text === a) {
        push({ id: tag.id, category: tag.category, confidence: 0.98, method: 'dict', matched: alias, raw });
      } else if (a.length >= 2 && text.includes(a)) {
        push({ id: tag.id, category: tag.category, confidence: 0.9, method: 'contains', matched: alias, raw });
      }
    }
  }

  return out;
}

// ── 岗位标签归一 ─────────────────────────────────────────────

const LIVING_CODES: Record<string, string> = {
  meal_included: 'meal.provided',
  dorm_included: 'dorm.provided',
};

const BONUS_CODES: Record<string, string> = {
  meal_subsidy: 'meal.subsidy',
  housing_subsidy: 'dorm.subsidy',
  full_attendance: 'bonus.full_attendance',
  performance: 'bonus.performance',
  year_end: 'bonus.year_end',
};

const INSURANCE_CODES: Record<string, string> = {
  social: 'insurance.social',
  accident: 'insurance.accident',
  commercial: 'insurance.commercial',
};

const SHIFT_CODES: Record<ShiftCode, string> = {
  day: 'shift.day',
  night: 'shift.night',
  two_shift: 'shift.two_shift',
  three_shift: 'shift.three_shift',
};

const REST_CODES: Record<RestCode, string> = {
  monthly_4: 'rest.monthly_4',
  weekend_2: 'rest.weekend_2',
  work_6_rest_1: 'rest.work_6_rest_1',
};

export interface JobCanonicalTags {
  ids: Set<string>;
  /** 拿不准的自定义标签：只展示，不参与判断 */
  unresolved: string[];
}

export function canonicalIdsOfJob(job: JobOrder): JobCanonicalTags {
  const ids = new Set<string>();
  const unresolved: string[] = [];

  for (const code of job.benefits.living.codes) {
    const id = LIVING_CODES[code];
    if (id) ids.add(id);
  }
  for (const code of job.benefits.bonus.codes) {
    const id = BONUS_CODES[code];
    if (id) ids.add(id);
  }
  for (const code of job.benefits.insurance.codes) {
    const id = INSURANCE_CODES[code];
    if (id) ids.add(id);
  }
  if (job.schedule.shift.norm === 'mapped' && job.schedule.shift.code) {
    ids.add(SHIFT_CODES[job.schedule.shift.code]);
  }
  if (job.schedule.rest.norm === 'mapped' && job.schedule.rest.code) {
    ids.add(REST_CODES[job.schedule.rest.code]);
  }

  const addCustom = (texts: string[], categories: TagCategory[]) => {
    for (const text of texts) {
      // 自定义项没有 category 信息，挨个域试；多值标签（包吃住）要全部收下
      const matches = canonicalizeAll(text, categories).filter((m) => m.confidence >= 0.8);
      if (matches.length > 0) for (const m of matches) ids.add(m.id!);
      else unresolved.push(`${categories.join('/')}:${text}`);
    }
  };
  addCustom(job.benefits.living.custom, ['meal', 'dorm']);
  addCustom(job.benefits.bonus.custom, ['bonus', 'meal', 'dorm']);
  addCustom(job.benefits.insurance.custom, ['insurance']);
  addCustom(job.requirements.skills.custom, ['skill']);

  return { ids, unresolved };
}

/** 班次 code 归一：自定义也能在置信度够时参与判定 */
export function resolveShiftCode(choice: Choice<ShiftCode>): {
  code: ShiftCode | null;
  confidence: number;
  matched?: string;
} {
  if (choice.code && choice.norm === 'mapped') return { code: choice.code, confidence: 1 };
  const m = canonicalizeText(choice.label, 'shift');
  const code = m.id?.startsWith('shift.') ? (m.id.slice('shift.'.length) as ShiftCode) : null;
  return { code, confidence: m.confidence, matched: m.matched };
}

export function resolveRestCode(choice: Choice<RestCode>): {
  code: RestCode | null;
  confidence: number;
  matched?: string;
} {
  if (choice.code && choice.norm === 'mapped') return { code: choice.code, confidence: 1 };
  const m = canonicalizeText(choice.label, 'rest');
  const code = m.id?.startsWith('rest.') ? (m.id.slice('rest.'.length) as RestCode) : null;
  return { code, confidence: m.confidence, matched: m.matched };
}
