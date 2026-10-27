/**
 * 改写结果的接地校验。
 *
 * 模型最擅长的错就是"顺手编一个数"：把 5000-6500 说成"6000 到 7000"，
 * 或者说"宿舍 4 人间"（实际是 6-8 人间）。这类错误人眼很难发现，
 * 但用户会照着去面试，然后在现场吵起来。
 *
 * 校验方式不看语义，只做三条可以机械判定的：
 *   1. 数字闭包：输出里的数字必须都在草稿里出现过
 *   2. 问句保留：草稿在提问，输出就得还在提问
 *   3. 站外导流：草稿没提微信，输出就不许提
 */

const NUMBER_RE = /\d+(?:\.\d+)?/g;

/** 规范化数字，避免 "08" 和 "8"、"5,000" 和 "5000" 判成不同 */
function normalize(token: string): string {
  const n = Number(token.replace(/,/g, ''));
  return Number.isFinite(n) ? String(n) : token;
}

export function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(NUMBER_RE)) out.add(normalize(m[0]));
  return out;
}

const CONTACT_RE = /(微信|weixin|wechat|\bvx\b|v信|加我|二维码|\b1[3-9]\d{9}\b)/i;

export interface Violation {
  rule: 'number' | 'question' | 'contact' | 'greeting' | 'claim';
  detail: string;
}

/**
 * 承诺性说法。招聘里这些话说出去是要负责的，模型不许自己加。
 * 草稿里有就随便用，草稿里没有就是编。
 */
const CLAIM_WORDS = [
  '还招',
  '包吃',
  '包住',
  '包三餐',
  '交社保',
  '五险一金',
  '公积金',
  '全勤',
  '加班费',
  '双休',
  '月休',
];

export function checkGrounding(output: string, draft: string): Violation[] {
  const out = output.trim();
  if (!out) return [{ rule: 'number', detail: 'empty output' }];

  const violations: Violation[] = [];

  const allowed = numbersIn(draft);
  const extra = [...numbersIn(out)].filter((n) => !allowed.has(n));
  if (extra.length > 0) {
    violations.push({ rule: 'number', detail: `草稿里没有的数字: ${extra.join(', ')}` });
  }

  const draftAsks = draft.includes('？') || draft.includes('?');
  const outAsks = out.includes('？') || out.includes('?');
  if (draftAsks && !outAsks) {
    violations.push({ rule: 'question', detail: '草稿在提问，改写后没有问句' });
  }

  if (CONTACT_RE.test(out) && !CONTACT_RE.test(draft)) {
    violations.push({ rule: 'contact', detail: '引入了站外联系方式' });
  }

  // 首条要打招呼。模型很爱把它删掉，说"这样更简洁"——但用户第一次接触就冷冰冰
  const draftGreets = /你好|您好/.test(draft);
  const outGreets = /你好|您好/.test(out);
  if (draftGreets && !outGreets) {
    violations.push({ rule: 'greeting', detail: '草稿在打招呼，改写后没了' });
  }

  // 不许新增承诺。数字能挡住的只是"编价格"，"还招人的""包吃"这些也得挡住
  const added = CLAIM_WORDS.filter((w) => out.includes(w) && !draft.includes(w));
  if (added.length > 0) {
    violations.push({ rule: 'claim', detail: `草稿里没有的承诺: ${added.join('、')}` });
  }

  return violations;
}
