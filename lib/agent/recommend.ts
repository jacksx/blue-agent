import type { Candidate, JobOrder, MatchAssessment, SlotMap } from './types';
import { commuteMinutes, evaluate } from './match';
import { canonicalIdsOfJob } from './tags';

export interface RecommendationItem {
  job: JobOrder;
  assessment: MatchAssessment;
  score: number;
  breakdown: Record<string, number>;
  reasons: string[];
}

export interface RecommendOptions {
  exclude?: string[];
  limit?: number;
}

/**
 * 推荐 = 匹配函数的批量应用 + 排序。
 * 不重写判定逻辑，直接复用 evaluate()，避免"推荐了但点进去不合适"。
 */
export function recommend(
  cand: Candidate,
  slots: SlotMap,
  jobs: JobOrder[],
  opts: RecommendOptions = {},
): RecommendationItem[] {
  const limit = opts.limit ?? 3;
  const exclude = new Set(opts.exclude ?? []);

  const items: RecommendationItem[] = [];

  for (const job of jobs) {
    if (exclude.has(job.id)) continue;

    const assessment = evaluate(job, cand, slots);
    // 预匹配：不合适的直接出局，不进入排序
    if (assessment.decision === 'not_match' || assessment.decision === 'insufficient_data') {
      continue;
    }

    const breakdown = dimScores(job, cand, slots, assessment);
    const score = weighted(breakdown);

    items.push({
      job,
      assessment,
      score,
      breakdown,
      reasons: assessment.reasons,
    });
  }

  items.sort((a, b) => b.score - a.score);

  return diversify(items, limit);
}

// ── 打分维度 ─────────────────────────────────────────────────

const WEIGHTS = {
  salary: 0.3,
  commute: 0.24,
  shift: 0.2,
  skill: 0.14,
  perk: 0.08,
  quality: 0.04,
};

function dimScores(
  job: JobOrder,
  cand: Candidate,
  slots: SlotMap,
  a: MatchAssessment,
): Record<string, number> {
  const salaryCheck = a.negotiable.find((n) => n.field === 'salary');
  let salary = 0.5;
  if (salaryCheck?.gapPct == null) {
    salary = 0.6;
  } else if (salaryCheck.gapPct <= 0) {
    salary = 1;
  } else if (salaryCheck.gapPct <= 5) {
    salary = 0.9;
  } else {
    salary = 0.6;
  }

  const m = commuteMinutes(job, cand);
  const commute = m == null ? 0.5 : m < 30 ? 1 : m <= 60 ? 0.6 : 0.2;

  const shiftCheck = a.negotiable.find((n) => n.field === 'shift');
  const shift = shiftCheck == null || shiftCheck.verdict === 'ok' ? 1 : 0.5;

  return {
    salary,
    commute,
    shift,
    skill: skillScore(job, cand),
    perk: perkScore(job),
    quality: qualityScore(job),
  };
}

/**
 * 技能打分：**code 算交集，自定义只认一字不差**。
 *
 * 两边都能填自定义（"会用打包机"这种），但自由文本没法可靠比对——
 * "会打包" 和 "会用打包机" 是不是一回事，代码判断不了。
 * 所以自定义项只在**完全同文**时算命中，绝不因为"文本对不上"倒扣分。
 * 宁可少给一点分，也不要拿猜的去判断合不合适。
 */
function skillScore(job: JobOrder, cand: Candidate): number {
  const mineCodes = new Set(cand.skills.codes);
  const jobCodes = new Set(job.requirements.skills.codes);

  let inter = 0;
  for (const t of jobCodes) if (mineCodes.has(t)) inter += 1;
  const union = new Set([...mineCodes, ...jobCodes]).size;
  const codeScore = union === 0 ? 0 : inter / union;

  const norm = (s: string) => s.replace(/\s+/g, '').trim();
  const myCustom = new Set(cand.skills.custom.map(norm));
  const hits = job.requirements.skills.custom.filter((c) => myCustom.has(norm(c))).length;
  const customScore =
    job.requirements.skills.custom.length === 0 ? 0 : hits / job.requirements.skills.custom.length;

  // 岗位技能全是自定义（没有 code）时，只能退回原文比对
  const skill = union === 0 ? customScore : codeScore + 0.2 * customScore;

  // 岗位类别对不对口，比技能重叠更硬
  const typeHit = cand.expect.positionCodes.includes(job.positionCode) ? 1 : 0;

  return Math.min(1, 0.6 * skill + 0.4 * typeHit);
}

function perkScore(job: JobOrder): number {
  // 内置 code + 自定义标签都在规范层比对："管饭" 和 "包吃" 算同一件事
  const ids = canonicalIdsOfJob(job).ids;
  let s = 0;
  if (ids.has('meal.provided')) s += 0.35;
  if (ids.has('meal.subsidy')) s += 0.1;
  if (ids.has('dorm.provided')) s += 0.35;
  if (ids.has('bonus.full_attendance')) s += 0.1;
  if (ids.has('insurance.social')) s += 0.1;
  return Math.min(1, s);
}

function qualityScore(job: JobOrder): number {
  const r = job.recruiter;
  const replies = Math.min((r.repliesToday ?? 0) / 100, 1);
  return 0.4 * (r.verified ? 1 : 0) + 0.3 * (r.online ? 1 : 0) + 0.2 * replies + 0.1;
}

function weighted(b: Record<string, number>): number {
  let s = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) s += (b[k] ?? 0) * w;
  return Number((s * 100).toFixed(1));
}

// ── 多样性：目标不是"最相似的 3 个"，是"值得看的 3 个" ──────

function diversify(items: RecommendationItem[], limit: number): RecommendationItem[] {
  const out: RecommendationItem[] = [];
  const perCategory = new Map<string, number>();

  for (const it of items) {
    const c = it.job.category;
    const used = perCategory.get(c) ?? 0;
    if (used >= 2) continue; // 同品类最多 2 个
    out.push(it);
    perCategory.set(c, used + 1);
    if (out.length >= limit) break;
  }

  // 不够就补，允许打破品类限制
  if (out.length < limit) {
    for (const it of items) {
      if (out.includes(it)) continue;
      out.push(it);
      if (out.length >= limit) break;
    }
  }

  return out;
}

/** 一致性断言：推荐出来的岗位必须能通过同一个 evaluate() */
export function assertConsistency(items: RecommendationItem[], cand: Candidate, slots: SlotMap): void {
  for (const it of items) {
    const re = evaluate(it.job, cand, slots);
    if (re.decision === 'not_match') {
      throw new Error(`推荐与匹配不一致: ${it.job.id}`);
    }
  }
}
