import { CHUNK_BY_ID, POLICY_CHUNKS, type PolicyCategory, type PolicyChunk } from './corpus';

/**
 * 检索：查询重写 → 混合召回（BM25 + 本地向量）→ RRF → rerank → 拒答。
 *
 * 三个刻意的取舍：
 *   1. 向量用**本地哈希向量**（feature hashing）而不是调 embedding API。
 *      好处是可复现、零成本、评测能锁死；换 bge-m3 时只换 embed() 一个函数。
 *   2. RRF 不用加权分数融合：BM25 与 cosine 的分布不可比，归一化会随 query 漂移。
 *   3. 低于阈值必须拒答。答错一条政策（"不收押金"说成"收"）比不答贵得多。
 */

export type RetrievalMode = 'bm25' | 'vector' | 'hybrid' | 'hybrid+rerank';

export interface PolicyHit {
  chunk: PolicyChunk;
  /** 0–1，用于拒答阈值；不同 mode 的算法不同但口径一致 */
  score: number;
  bm25: number;
  vector: number;
  rrf: number;
  rerank: number;
  matchedBy: 'bm25' | 'vector' | 'both';
}

export interface PolicyLookup {
  query: string;
  rewritten: string;
  category?: PolicyCategory;
  hits: PolicyHit[];
  topScore: number;
  refused: boolean;
  mode: RetrievalMode;
  reason: string;
}

// ── 分词：中文 bigram + 英文/数字 token ───────────────────────

const SEP_RE = /[\s，。！？、；：""''（）()【】\[\]<>《》,.!?;:'"~`@#$%^&*_+=|\\/—-]/g;

export function normalizeText(s: string): string {
  return s.replace(SEP_RE, '').toLowerCase();
}

export function tokenize(text: string): string[] {
  const s = normalizeText(text);
  const out: string[] = [];
  const re = /[\u4e00-\u9fff]+|[a-z0-9]+/g;
  for (const m of s.matchAll(re)) {
    const run = m[0]!;
    if (/^[a-z0-9]+$/.test(run)) {
      out.push(run);
      continue;
    }
    if (run.length === 1) {
      out.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

// ── 查询重写：口语 → 规范词 ───────────────────────────────────

interface RewriteRule {
  re: RegExp;
  add: string;
  category?: PolicyCategory;
}

/** 顺序就是优先级：先命中先定 category，后面的只做扩写 */
const REWRITE_RULES: RewriteRule[] = [
  {
    re: /体检|健康证|办证|查体/,
    add: '体检 体检费 健康证 费用 报销 体检项目',
    category: 'health',
  },
  {
    re: /加班费|加班工资|几倍工资/,
    add: '加班费 加班 1.5 倍 工资 结算',
    category: 'settlement',
  },
  {
    re: /押金|收费|服装费|中介费|中芥费|扣证件|押身份证/,
    add: '押金 收费 费用 0 费用 身份证 服装费 中介费',
    category: 'fees',
  },
  {
    re: /合同|试用期|签什么|协议/,
    add: '合同 劳动合同 试用期 入职',
    category: 'onboarding',
  },
  {
    re: /身份证|带什么|入职材料|照片|银行卡/,
    add: '入职 材料 身份证 银行卡 照片 带什么',
    category: 'onboarding',
  },
  {
    re: /夫妻房|两口子|一起住|老婆|老公/,
    add: '夫妻房 宿舍 申请 一起住',
    category: 'accommodation',
  },
  {
    re: /宿舍|住宿|几人间|空调|热水|外宿|房补/,
    add: '宿舍 住宿 几人间 空调 热水器 水电费 外宿 房补',
    category: 'accommodation',
  },
  {
    re: /食堂|吃饭|餐补|管饭|包吃|伙食/,
    add: '吃饭 食堂 餐补 包吃 餐补一天',
    category: 'meal',
  },
  {
    re: /社保|五险|公积金|保险/,
    add: '社保 五险 公积金 缴纳 入职',
    category: 'insurance',
  },
  {
    re: /请假|病假|事假|迟到|旷工|全勤/,
    add: '请假 病假 迟到 旷工 全勤 考勤',
    category: 'attendance',
  },
  {
    re: /离职|辞职|不干了|走人|结算/,
    add: '离职 辞职 结算 人走账清',
    category: 'settlement',
  },
  {
    re: /压工资|压.{0,2}工资|工资.{0,2}压|拖欠|拖工资|几号发|发薪|工资条|扣钱|扣款/,
    add: '发薪 压工资 几号发 工资条 扣款 结算',
    category: 'settlement',
  },
  {
    re: /预支|借钱|支工资|先给/,
    add: '预支 借钱 上班满 7 天',
    category: 'settlement',
  },
  {
    re: /夜班|倒班|两班倒|换班|白班/,
    add: '夜班 倒班 两班倒 夜班补贴 长白班',
    category: 'shift',
  },
  {
    re: /年龄|多大|超龄|学历|要求/,
    add: '年龄 学历 要求 18 45 超龄',
    category: 'eligibility',
  },
  {
    re: /学生|暑假工|兼职|开学/,
    add: '学生 暑假工 学生证 满 16 周岁',
    category: 'eligibility',
  },
  {
    re: /(推荐|介绍).{0,6}(朋友|入职|人|奖励)|内推/,
    add: '推荐 介绍 朋友 奖励 内推',
    category: 'platform',
  },
  {
    re: /举报|投诉|骗|维权/,
    add: '举报 投诉 维权 收费 虚假',
    category: 'platform',
  },
  {
    re: /隐私|信息泄露|简历安全/,
    add: '隐私 信息 泄露 简历 安全',
    category: 'platform',
  },
  {
    re: /微信|手机号|换微信|站外/,
    add: '微信 换微信 手机号 站外 转出',
    category: 'platform',
  },
  {
    re: /面试|到厂|地址|路线|怎么去|班车/,
    add: '面试 到厂 流程 地址 路线 班车',
    category: 'interview',
  },
];

export interface RewriteResult {
  query: string;
  added: string[];
  category?: PolicyCategory;
}

export function rewriteQuery(raw: string): RewriteResult {
  const added: string[] = [];
  let category: PolicyCategory | undefined;
  for (const rule of REWRITE_RULES) {
    if (!rule.re.test(raw)) continue;
    added.push(rule.add);
    if (!category && rule.category) category = rule.category;
  }
  return {
    query: [raw, ...added].join(' '),
    added,
    category,
  };
}

/** 查得着的问题长什么样。用于决定要不要走 RAG，不用于判定 */
export const POLICY_HINT_RE =
  /体检|健康证|押金|收费|服装费|中介费|中芥费|合同|试用期|请假|病假|迟到|旷工|离职|辞职|结算|压工资|几号发|预支|夫妻房|外宿|水电|班车|工服|年龄|超龄|学历|学生|暑假工|推荐|介绍|举报|投诉|隐私|换微信|手机号|体检费|做饭|发票/;

// ── 索引 ─────────────────────────────────────────────────────

interface Doc {
  chunk: PolicyChunk;
  tokens: string[];
  tf: Map<string, number>;
  len: number;
  vector: Float64Array;
}

const VECTOR_DIM = 512;
const K1 = 1.2;
const B = 0.75;

function fnv(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** feature hashing：同一 token 永远落到同一个维度，不需要额外模型 */
function embed(tokens: string[]): Float64Array {
  const v = new Float64Array(VECTOR_DIM);
  for (const t of tokens) {
    const h1 = fnv(t);
    const h2 = fnv(`#${t}`);
    const sign = h2 & 1 ? 1 : -1;
    v[h1 % VECTOR_DIM] += sign * 1;
    v[h2 % VECTOR_DIM] += sign * 0.5;
  }
  let norm = 0;
  for (let i = 0; i < VECTOR_DIM; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < VECTOR_DIM; i++) v[i] = v[i]! / norm;
  }
  return v;
}

function cosine(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < VECTOR_DIM; i++) s += a[i]! * b[i]!;
  return s;
}

const DOCS: Doc[] = POLICY_CHUNKS.map((chunk) => {
  const tokens = tokenize(`${chunk.title} ${chunk.text} ${chunk.keywords.join(' ')}`);
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return { chunk, tokens, tf, len: tokens.length, vector: embed(tokens) };
});

const DF = new Map<string, number>();
for (const doc of DOCS) {
  for (const t of doc.tf.keys()) DF.set(t, (DF.get(t) ?? 0) + 1);
}
const AVG_LEN = DOCS.reduce((s, d) => s + d.len, 0) / DOCS.length;

function idf(token: string): number {
  const df = DF.get(token) ?? 0;
  return Math.log(1 + (DOCS.length - df + 0.5) / (df + 0.5));
}

function bm25Scores(queryTokens: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const uniq = [...new Set(queryTokens)];
  for (const doc of DOCS) {
    let score = 0;
    for (const t of uniq) {
      const tf = doc.tf.get(t);
      if (!tf) continue;
      const denom = tf + K1 * (1 - B + (B * doc.len) / AVG_LEN);
      score += idf(t) * ((tf * (K1 + 1)) / denom);
    }
    if (score > 0) out.set(doc.chunk.id, score);
  }
  return out;
}

function vectorScores(queryVector: Float64Array): Map<string, number> {
  const out = new Map<string, number>();
  for (const doc of DOCS) {
    const s = cosine(queryVector, doc.vector);
    if (s > 0.02) out.set(doc.chunk.id, s);
  }
  return out;
}

/** Reciprocal Rank Fusion：只看名次，不看分数分布 */
function rrf(lists: Map<string, number>[], k = 60): Map<string, number> {
  const out = new Map<string, number>();
  for (const list of lists) {
    const ranked = [...list.entries()].sort((a, b) => b[1] - a[1]);
    ranked.forEach(([id], rank) => {
      out.set(id, (out.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return out;
}

function maxOf(map: Map<string, number>): number {
  let max = 0;
  for (const v of map.values()) if (v > max) max = v;
  return max;
}

/** 召回先砍到 topN 再融合：RRF 只关心名次，长尾不进候选 */
function topN(map: Map<string, number>, n: number): Map<string, number> {
  return new Map([...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n));
}

function keywordCoverage(queryTokens: string[], doc: Doc): number {
  const uniq = [...new Set(queryTokens)];
  if (uniq.length === 0) return 0;
  let hit = 0;
  for (const t of uniq) if (doc.tf.has(t)) hit += 1;
  return hit / uniq.length;
}

// ── 检索 ─────────────────────────────────────────────────────

export const REFUSE_THRESHOLD = 0.34;

function makeHit(
  doc: Doc,
  parts: { bm25: number; vector: number; rrf: number; rerank: number; score: number },
): PolicyHit {
  const matchedBy =
    parts.bm25 > 0 && parts.vector > 0.05 ? 'both' : parts.bm25 > 0 ? 'bm25' : 'vector';
  return { chunk: doc.chunk, ...parts, matchedBy };
}

function docOf(id: string): Doc {
  const doc = DOCS.find((d) => d.chunk.id === id);
  if (!doc) throw new Error(`chunk missing: ${id}`);
  return doc;
}

/**
 * 一次完整检索。mode 只给评测做消融用，线上固定走 hybrid+rerank。
 */
export function retrieve(raw: string, mode: RetrievalMode = 'hybrid+rerank'): PolicyLookup {
  const rewrite = rewriteQuery(raw);
  const queryTokens = tokenize(rewrite.query);
  const bm25 = bm25Scores(queryTokens);
  const vector = mode === 'bm25' ? new Map<string, number>() : vectorScores(embed(queryTokens));

  const bm25Conf = (s: number) => s / (s + 6);

  const candidates = new Map<string, PolicyHit>();
  const fused = rrf([topN(bm25, 20), topN(vector, 20)]);
  const ids = new Set<string>([...bm25.keys(), ...vector.keys()]);

  for (const id of ids) {
    const doc = docOf(id);
    const b = bm25.get(id) ?? 0;
    const v = vector.get(id) ?? 0;
    const coverage = keywordCoverage(queryTokens, doc);
    const categoryHit = rewrite.category && rewrite.category === doc.chunk.category ? 1 : 0;
    const hybridConf = 0.55 * bm25Conf(b) + 0.45 * Math.max(0, v);

    let score: number;
    let rerank = 0;
    if (mode === 'bm25') {
      score = 0.75 * bm25Conf(b) + 0.25 * coverage;
    } else if (mode === 'vector') {
      score = Math.max(0, v);
    } else if (mode === 'hybrid') {
      score = 0.6 * hybridConf + 0.4 * coverage;
    } else {
      const rrfNorm = (fused.get(id) ?? 0) / Math.max(1e-6, maxOf(fused));
      rerank = 0.5 * rrfNorm + 0.3 * coverage + 0.2 * categoryHit;
      score = 0.55 * hybridConf + 0.25 * coverage + 0.2 * categoryHit;
    }

    candidates.set(
      id,
      makeHit(doc, {
        bm25: Number(b.toFixed(3)),
        vector: Number(v.toFixed(3)),
        rrf: Number((fused.get(id) ?? 0).toFixed(4)),
        rerank: Number(rerank.toFixed(3)),
        // 精度因子：只命中 1 个词的长句（"推荐一部电影"）不该拿高分。
        // 召回可以松，拒答前的最后一关必须收紧。
        score: Number((score * (0.55 + 0.45 * coverage)).toFixed(3)),
      }),
    );
  }

  const hits = [...candidates.values()]
    .filter((h) => h.score > 0.02)
    .sort((a, b) => {
      if (mode === 'hybrid+rerank') {
        if (b.rerank !== a.rerank) return b.rerank - a.rerank;
      }
      return b.score - a.score;
    })
    .slice(0, 5);

  const topScore = hits[0]?.score ?? 0;
  const refused = topScore < REFUSE_THRESHOLD;

  return {
    query: raw,
    rewritten: rewrite.query,
    category: rewrite.category,
    hits,
    topScore,
    refused,
    mode,
    reason: refused
      ? `最高分 ${topScore.toFixed(2)} < 阈值 ${REFUSE_THRESHOLD}`
      : `命中 ${hits[0]!.chunk.id}（${topScore.toFixed(2)}）`,
  };
}

/** 给编排层用：拒答就不返回文本，让上层走"我帮你问一下"，而不是硬编 */
export function policyAnswer(lookup: PolicyLookup | undefined): string | undefined {
  if (!lookup || lookup.refused || lookup.hits.length === 0) return undefined;
  return lookup.hits[0]!.chunk.text;
}

export function chunkById(id: string): PolicyChunk | undefined {
  return CHUNK_BY_ID.get(id);
}
