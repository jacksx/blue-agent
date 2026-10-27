import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AgentRequest, AgentResponse } from '@/lib/agent/types';
import { respond } from '@/lib/agent/pipeline';
import { resetConversation } from '@/lib/agent/store';
import { CANDIDATES, findJob } from '@/lib/fixtures/data';
import { getProvider } from '@/lib/llm';
import { EVAL_CASES, type EvalCase } from '@/lib/eval/cases';
import { dimensionOf } from '@/lib/eval/dimensions';
import { flaky, mcnemar, majority } from '@/lib/eval/stats';

export const runtime = 'nodejs';

/**
 * 评测入口。跑的是和线上同一条 respond()，所以任何判定退化都会在这里报红。
 *
 * 单次跑只能回答"过没过"，回答不了"改动到底有没有变好"：
 *   · 模型会抖 → 每条跑 N 次取多数票
 *   · 总分会被平均掩盖 → case 级 diff，列出 fixed / broken
 *   · 净变化可能只是噪声 → McNemar 配对检验
 *
 * 查询参数：
 *   ?runs=3            每条跑几次（默认 1，上限 5）
 *   ?baseline=0        不读 .data/eval-baseline.json
 *   ?saveBaseline=1    把本次结果存成新基线（改 prompt 前先存一次）
 */

interface RunResult {
  ok: boolean;
  failures: string[];
  text: string;
  decision?: string;
  state?: string;
  degraded: boolean;
  latencyMs: number;
  error?: string;
}

interface CaseResult {
  id: string;
  desc: string;
  dimension: string;
  ok: boolean;
  skipped: boolean;
  runs: number;
  passCount: number;
  /** 跑多次时结果不一致——模型不稳，或 case 本身在边界上 */
  flaky: boolean;
  failures: string[];
  lastText: string;
  decision?: string;
  state?: string;
  degraded: boolean;
  latencyMs: number;
}

interface BaselineFile {
  savedAt: string;
  gitSha?: string;
  runs?: number;
  cases: Array<{ id: string; ok: boolean; skipped: boolean }>;
}

const BASELINE_FILE = resolve(process.cwd(), '.data', 'eval-baseline.json');

function textOf(res: AgentResponse): string {
  return res.actions
    .filter((a): a is { type: 'text'; text: string } => a.type === 'text')
    .map((a) => a.text)
    .join('\n');
}

function buildRequest(c: EvalCase, stepIndex: number, convId: string): AgentRequest {
  const step = c.steps[stepIndex]!;
  const job = findJob(step.jobId);
  const cand = CANDIDATES.find((x) => x.id === step.candidateId);
  if (!job || !cand) throw new Error(`fixture missing: ${step.jobId}/${step.candidateId}`);

  return {
    messageId: `${convId}-${stepIndex}`,
    platform: 'boss',
    conversationId: convId,
    message: { type: 'text', text: step.text, sentAt: new Date().toISOString() },
    subject: {
      candidate: { id: cand.id, version: cand.updatedAt, snapshot: cand },
      jobOrder: { id: job.id, version: job.updatedAt, snapshot: job },
    },
    recruiter: { id: job.recruiter.id, online: job.recruiter.online },
  };
}

async function runOnce(c: EvalCase, runIndex: number): Promise<RunResult> {
  const t0 = Date.now();
  // 每次采样用独立会话：第 2 次不能看到第 1 次的槽位
  const convId = `eval-${c.id}-r${runIndex}`;
  resetConversation(convId);

  let last: AgentResponse | undefined;
  for (let i = 0; i < c.steps.length; i++) {
    last = await respond(buildRequest(c, i, convId));
  }

  const failures: string[] = [];
  const text = last ? textOf(last) : '';
  const e = c.expect;

  if (!last) failures.push('没有产出响应');

  if (e.decision && last?.meta.match?.decision !== e.decision) {
    failures.push(`decision 期望 ${e.decision}，实际 ${last?.meta.match?.decision}`);
  }
  if (e.state && last?.state !== e.state) {
    failures.push(`state 期望 ${e.state}，实际 ${last?.state}`);
  }
  if (e.hasForm != null) {
    const has = last?.actions.some((a) => a.type === 'interview_form') ?? false;
    if (has !== e.hasForm) failures.push(`form 期望 ${e.hasForm}，实际 ${has}`);
  }
  if (e.hasCards != null) {
    const has = last?.actions.some((a) => a.type === 'job_cards') ?? false;
    if (has !== e.hasCards) failures.push(`cards 期望 ${e.hasCards}，实际 ${has}`);
  }
  for (const kw of e.includes ?? []) {
    if (!text.includes(kw)) failures.push(`应包含「${kw}」`);
  }
  if (e.includesAny && e.includesAny.length > 0) {
    if (!e.includesAny.some((kw) => text.includes(kw))) {
      failures.push(`应命中其一：${e.includesAny.join(' / ')}`);
    }
  }
  for (const kw of e.excludes ?? []) {
    if (text.includes(kw)) failures.push(`不应包含「${kw}」`);
  }

  return {
    ok: failures.length === 0,
    failures,
    text,
    decision: last?.meta.match?.decision,
    state: last?.state,
    degraded: last?.meta.degraded ?? false,
    latencyMs: Date.now() - t0,
  };
}

async function runCase(c: EvalCase, runs: number): Promise<CaseResult> {
  const attempts: RunResult[] = [];
  let error: string | undefined;

  for (let r = 0; r < runs; r++) {
    try {
      attempts.push(await runOnce(c, r));
    } catch (err) {
      error = String(err);
      attempts.push({
        ok: false,
        failures: [`异常：${error}`],
        text: '',
        degraded: false,
        latencyMs: 0,
        error,
      });
    }
  }

  const oks = attempts.map((a) => a.ok);
  const ok = majority(oks);
  // 展示"最能说明问题"的那一次：失败优先，全过就取第一次
  const shown = attempts.find((a) => !a.ok) ?? attempts[0]!;

  return {
    id: c.id,
    desc: c.desc,
    dimension: dimensionOf(c.id),
    ok,
    skipped: false,
    runs: attempts.length,
    passCount: oks.filter(Boolean).length,
    flaky: flaky(oks),
    failures: shown.failures,
    lastText: shown.text,
    decision: shown.decision,
    state: shown.state,
    degraded: attempts.some((a) => a.degraded),
    latencyMs: attempts.reduce((s, a) => s + a.latencyMs, 0),
  };
}

function readBaseline(): BaselineFile | null {
  if (!existsSync(BASELINE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as BaselineFile;
  } catch {
    // 文件坏了就当没有基线，不要因此让评测失败
    return null;
  }
}

function writeBaseline(results: CaseResult[]): void {
  const body: BaselineFile = {
    savedAt: new Date().toISOString(),
    gitSha: gitSha(),
    runs: results[0]?.runs ?? 1,
    cases: results.map((r) => ({ id: r.id, ok: r.ok, skipped: r.skipped })),
  };
  mkdirSync(dirname(BASELINE_FILE), { recursive: true });
  writeFileSync(BASELINE_FILE, JSON.stringify(body, null, 2), 'utf8');
}

function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function dimensionReport(results: CaseResult[]) {
  const acc = new Map<string, { ran: number; passed: number; flaky: number }>();
  for (const r of results) {
    if (r.skipped) continue;
    const cur = acc.get(r.dimension) ?? { ran: 0, passed: 0, flaky: 0 };
    cur.ran += 1;
    cur.passed += r.ok ? 1 : 0;
    cur.flaky += r.flaky ? 1 : 0;
    acc.set(r.dimension, cur);
  }
  return Object.fromEntries(
    [...acc.entries()].map(([k, v]) => [
      k,
      {
        ran: v.ran,
        passed: v.passed,
        passRate: Number(((v.passed / v.ran) * 100).toFixed(1)),
        flaky: v.flaky,
      },
    ]),
  );
}

export async function GET(req: Request) {
  const started = Date.now();
  const url = new URL(req.url);
  const runs = Math.max(1, Math.min(5, Number(url.searchParams.get('runs') ?? 1) || 1));
  const useBaseline = url.searchParams.get('baseline') !== '0';
  const saveBaseline = url.searchParams.get('saveBaseline') === '1';

  const hasModel = getProvider() != null;
  const results: CaseResult[] = [];

  for (const c of EVAL_CASES) {
    // 只有模型能跑的说法，没配 key 就跳过——不拿它冒充失败，也不假装通过
    if (c.requiresModel && !hasModel) {
      results.push({
        id: c.id,
        desc: c.desc,
        dimension: dimensionOf(c.id),
        ok: true,
        skipped: true,
        runs: 0,
        passCount: 0,
        flaky: false,
        failures: [],
        lastText: '',
        degraded: false,
        latencyMs: 0,
      });
      continue;
    }

    results.push(await runCase(c, runs));
  }

  const skipped = results.filter((r) => r.skipped).length;
  const ran = results.length - skipped;
  const passed = results.filter((r) => r.ok && !r.skipped).length;
  const degraded = results.filter((r) => r.degraded).length;
  const flakyCount = results.filter((r) => r.flaky).length;

  if (saveBaseline) writeBaseline(results);

  // ── 基线对比：只比"上次跑过、这次也跑了"的 case ─────────────
  const baseline = useBaseline ? readBaseline() : null;
  let comparison:
    | {
        savedAt: string;
        gitSha?: string;
        compared: number;
        fixed: string[];
        broken: string[];
        stillFail: string[];
        mcnemar: ReturnType<typeof mcnemar>;
      }
    | null = null;

  if (baseline) {
    const before = new Map(baseline.cases.map((c) => [c.id, c]));
    const fixed: string[] = [];
    const broken: string[] = [];
    const stillFail: string[] = [];
    let compared = 0;

    for (const r of results) {
      if (r.skipped) continue;
      const b = before.get(r.id);
      if (!b || b.skipped) continue; // 新增 case 不参与配对检验
      compared += 1;
      if (!b.ok && r.ok) fixed.push(r.id);
      else if (b.ok && !r.ok) broken.push(r.id);
      else if (!b.ok && !r.ok) stillFail.push(r.id);
    }

    comparison = {
      savedAt: baseline.savedAt,
      gitSha: baseline.gitSha,
      compared,
      fixed,
      broken,
      stillFail,
      mcnemar: mcnemar(fixed.length, broken.length),
    };
  }

  return Response.json({
    total: results.length,
    ran,
    passed,
    failed: ran - passed,
    skipped,
    /** 有多少条最后是靠模板话术收场的——模型改写被拦或调用失败 */
    degraded,
    /** 多次采样结果不一致的条数：模型不稳或 case 在边界上 */
    flaky: flakyCount,
    passRate: ran === 0 ? 0 : Number(((passed / ran) * 100).toFixed(1)),
    runs,
    hasModel,
    gitSha: gitSha(),
    durationMs: Date.now() - started,
    dimensions: dimensionReport(results),
    baseline: comparison,
    baselineSaved: saveBaseline,
    cases: results,
  });
}
