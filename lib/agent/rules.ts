import type { Candidate, IntentAction, JobOrder } from './types';

/**
 * 规则版理解层。
 *
 * 它有两个身份：
 *   1. 没配模型时的全部能力
 *   2. 模型超时/输出不合规时的兜底
 * 所以它不能差到"兜底等于失败"——这几个正则覆盖了蓝领 80% 的说法。
 *
 * 一句话拆成两样东西：
 *   topics  —— 在问什么。对应字段组，可扩展；加一个只加答案，不动流程。
 *   action  —— 想干什么。决定流程走向，封闭白名单，因为它是分支条件。
 */

export type { IntentAction };

export const TOPICS: Array<{ key: string; label: string; re: RegExp }> = [
  { key: 'hiring', label: '求职意向', re: /(还招|在招|招人吗|招吗|有空缺|还缺|缺人|要人)/ },
  { key: 'salary', label: '薪资', re: /(多少钱|工资|薪资|月薪|保底|几号发|发薪|时薪|日结|到手)/ },
  { key: 'rest', label: '休假', re: /(月休|休息|几天假|双休|做几休)/ },
  { key: 'dorm', label: '住宿', re: /(包住|住宿|宿舍|几人间|空调|吃住|夫妻房)/ },
  { key: 'meal', label: '吃饭', re: /(包吃|吃饭|餐补|食堂|管饭|吃住)/ },
  { key: 'overtime', label: '加班', re: /(加班|几点下班|几点上班|工时)/ },
  { key: 'advance', label: '预支', re: /(预支|借钱|先给|垫付)/ },
  { key: 'insurance', label: '五险一金', re: /(社保|五险|公积金|保险)/ },
  { key: 'requirement', label: '技能要求', re: /(经验|技能|要会|学历|年龄要求)/ },
  { key: 'environment', label: '工作环境', re: /(累不累|站着|坐着|环境|轻松|车间)/ },
  { key: 'content', label: '工作内容', re: /(干什么|做什么|工作内容)/ },
  { key: 'location', label: '地点通勤', re: /(在哪|地址|位置|远不远|怎么去|哪个区|通勤)/ },
  { key: 'interview', label: '面试', re: /(面试|什么时候能面|能去面|约)/ },
  { key: 'contact', label: '联系方式', re: /(微信|电话|加个|联系)/ },
];

/** 兜底 topic：什么都对不上时用它，保证 topics 永远非空 */
export const OTHER_TOPIC = 'other';

export const TOPIC_KEYS = TOPICS.map((t) => t.key).concat(OTHER_TOPIC);

/** 能从结构化字段直接答出来的 topic —— 这些绝不允许走检索 */
export const ANSWERABLE_TOPICS = TOPICS.map((t) => t.key);

/**
 * action 是封闭的，因为它出现在分支条件里：
 *   if (action === 'want_other') → 推卡
 * 模型一旦能自由编 action，流程就走歪了。
 */
const ACTION_RULES: Array<{ action: IntentAction; re: RegExp }> = [
  { action: 'reject', re: /(太低了|给得少|不合适|算了|不考虑|不接受|再看看)/ },
  { action: 'want_other', re: /(别的|其他|还有吗|换一个|有没有别的|还有没有)/ },
];

export interface Classification {
  topics: string[];
  action: IntentAction;
  confidence: number;
}

/** 规则版分类。没配模型时它就是全部，配了模型它是最低保障（取并集） */
export function classify(text: string): Classification {
  const topics = TOPICS.filter((t) => t.re.test(text)).map((t) => t.key);
  const hit = ACTION_RULES.find((a) => a.re.test(text));
  const action: IntentAction = hit?.action ?? 'none';

  if (topics.length === 0 && action === 'none') {
    return { topics: [OTHER_TOPIC], action: 'none', confidence: 0.5 };
  }

  const signals = topics.length + (action === 'none' ? 0 : 1);
  return { topics, action, confidence: signals > 1 ? 0.9 : 0.85 };
}

// ── 槽位抽取 ─────────────────────────────────────────────────

export interface ExtractedFacts {
  /** 只上白班是硬约束；能接受倒班只是意愿，别当硬条件 */
  shift?: { value: string; reason?: string; strength: 'hard' | 'strong' };
  salaryTarget?: number;
  healthCert?: boolean;
}

const CN_DIGIT: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const CN_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

/**
 * 中文数字 → 数字。蓝领说话几乎不用阿拉伯数字：七千、六千五、一万二。
 * 只认带单位（十/百/千/万）的写法，避免"一起""不要"这种被误当成数字。
 */
export function parseCnNumber(s: string): number | null {
  if (!/[十百千万]/.test(s)) return null;

  let total = 0;
  let pending = 0;
  let lastUnit = 1;
  let seen = false;

  for (const ch of s) {
    if (ch in CN_DIGIT) {
      pending = CN_DIGIT[ch]!;
      seen = true;
    } else if (ch in CN_UNIT) {
      const unit = CN_UNIT[ch]!;
      total += (pending === 0 ? 1 : pending) * unit;
      lastUnit = unit;
      pending = 0;
      seen = true;
    } else {
      break;
    }
  }

  if (!seen) return null;
  // "六千五" = 6500、"一万二" = 12000：末尾单字按上一个单位的十分之一补
  if (pending > 0) total += pending * (lastUnit / 10);

  return total > 0 ? Math.round(total) : null;
}

/** 从一句话里捞月薪：先认阿拉伯数字，再认中文数字 */
export function salaryIn(text: string): number | null {
  const arabic = /(\d{4,5})\s*(?:以上|起|左右|块|元|多)?/.exec(text);
  if (arabic) {
    const n = Number(arabic[1]);
    if (n >= 3000 && n <= 30000) return n;
  }

  const runs = text.match(/[零一二两三四五六七八九十百千万]{2,6}/g) ?? [];
  let best: number | null = null;
  for (const run of runs) {
    const n = parseCnNumber(run);
    if (n != null && n >= 3000 && n <= 30000 && (best == null || n > best)) best = n;
  }
  return best;
}

/** 规则版抽取。覆盖 demo 用得到的几种说法，说别的就走模型 */
export function ruleExtract(text: string, job: JobOrder): ExtractedFacts {
  const facts: ExtractedFacts = {};
  const reason = /接(孩子|娃)/.test(text) ? '接孩子，5:30 放学' : undefined;

  if (/(白班|只能上白|不能上夜|不上夜|不熬夜)/.test(text)) {
    facts.shift = { value: '长白班', reason, strength: 'hard' };
  } else if (/(能接受|可以|没关系|没问题|愿意).{0,8}(两班倒|三班倒|倒班|夜班)/.test(text)) {
    facts.shift = { value: job.schedule.shift.label, strength: 'strong' };
  } else if (/(不能|不行|不接受|不想|不干).{0,8}(倒班|夜班)/.test(text)) {
    facts.shift = { value: '长白班', reason, strength: 'hard' };
  }

  const salary = salaryIn(text);
  if (salary != null) facts.salaryTarget = salary;

  if (/(健康证).{0,4}(过期|没有|没了|没办)/.test(text)) facts.healthCert = false;
  else if (/(有|还在|没到期).{0,3}健康证|健康证.{0,4}(有效|还在)/.test(text)) {
    facts.healthCert = true;
  }

  return facts;
}

export function candidateDistrict(cand: Candidate): string {
  return cand.current.district.name;
}
