import { POLICY_CHUNKS } from '@/lib/rag/corpus';
import { RAG_CASES } from '@/lib/rag/eval-cases';
import { retrieve, REFUSE_THRESHOLD, type RetrievalMode } from '@/lib/rag/retrieve';

export const runtime = 'nodejs';

/**
 * RAG 消融评测。
 *
 * 同一批 query 跑四种检索配置，看每一层的增量：
 *   bm25 → vector → hybrid → hybrid+rerank
 * 指标：
 *   Recall@5    正例里 top5 命中任一期望 chunk 的比例
 *   MRR@5       第一个命中名次的倒数均值
 *   拒答准确率    负例里正确拒答的比例
 *   误拒率       正例里被拒的比例
 *
 * 只给总分看不出哪一层有用；分层对比才是"为什么这么设计"的证据。
 */

const MODES: RetrievalMode[] = ['bm25', 'vector', 'hybrid', 'hybrid+rerank'];

interface CaseDetail {
  id: string;
  query: string;
  shouldRefuse: boolean;
  refused: boolean;
  topScore: number;
  topIds: string[];
  hit: boolean;
  rank: number | null;
}

function evaluateMode(mode: RetrievalMode) {
  const details: CaseDetail[] = [];
  let positives = 0;
  let negatives = 0;
  let recallHits = 0;
  let rrSum = 0;
  let falseRefusal = 0;
  let refusalHits = 0;

  for (const c of RAG_CASES) {
    const lookup = retrieve(c.query, mode);
    const topIds = lookup.hits.map((h) => h.chunk.id);
    const rank = c.expectIds.length
      ? (() => {
          for (let i = 0; i < topIds.length && i < 5; i++) {
            if (c.expectIds.includes(topIds[i]!)) return i + 1;
          }
          return null;
        })()
      : null;
    const hit = c.shouldRefuse ? lookup.refused : rank != null;

    if (c.shouldRefuse) {
      negatives += 1;
      if (lookup.refused) refusalHits += 1;
    } else {
      positives += 1;
      if (rank != null) {
        recallHits += 1;
        rrSum += 1 / rank;
      }
      if (lookup.refused) falseRefusal += 1;
    }

    details.push({
      id: c.id,
      query: c.query,
      shouldRefuse: Boolean(c.shouldRefuse),
      refused: lookup.refused,
      topScore: lookup.topScore,
      topIds,
      hit,
      rank,
    });
  }

  return {
    mode,
    threshold: REFUSE_THRESHOLD,
    recallAt5: positives ? Number((recallHits / positives).toFixed(3)) : 0,
    mrrAt5: positives ? Number((rrSum / positives).toFixed(3)) : 0,
    refusalAccuracy: negatives ? Number((refusalHits / negatives).toFixed(3)) : 1,
    falseRefusalRate: positives ? Number((falseRefusal / positives).toFixed(3)) : 0,
    positives,
    negatives,
    details,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const withDetails = url.searchParams.get('details') === '1';
  const started = Date.now();

  const results = MODES.map(evaluateMode);
  // 当前线上配置放在最前面，方便脚本直接读
  const primary = results.find((r) => r.mode === 'hybrid+rerank')!;

  return Response.json({
    corpusSize: POLICY_CHUNKS.length,
    cases: RAG_CASES.length,
    durationMs: Date.now() - started,
    primary: {
      ...primary,
      details: withDetails ? primary.details : undefined,
    },
    modes: results.map((r) => ({ ...r, details: withDetails ? r.details : undefined })),
  });
}
