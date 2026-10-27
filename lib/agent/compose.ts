import type { AgentResponse } from './types';
import { getProvider, llmTimeoutMs } from '@/lib/llm';
import { checkGrounding } from '@/lib/llm/grounding';
import { REPLY_STYLE_PROMPT } from '@/lib/llm/prompts';
import { costCny } from '@/lib/llm/pricing';

/**
 * 措辞层。
 *
 * 规则已经把「说什么」定死了（事实、顺序、该问的问题），这里只让模型把这句话
 * 说得更像人。所以模型拿不到任何额外的业务数据——它只看到那段草稿，
 * 改完还要过接地校验。给它的信息越少，能编的东西越少。
 *
 * 每个失败点都有退路：
 *   没配 key        → 压根不调
 *   超时/网络/5xx   → 用草稿
 *   数字/问句/联系方式越界 → 用草稿
 * 任何时候用户拿到的都是一句能发的话。
 */

export async function composeReply(res: AgentResponse): Promise<AgentResponse> {
  const idx = res.actions.findIndex((a) => a.type === 'text');
  if (idx < 0) return res;

  const action = res.actions[idx];
  if (action.type !== 'text') return res;

  const provider = getProvider();
  const draft = action.text;

  // 把规则组的原话也记进 trace：服务视角里能直接看到「规则写的」→「模型改的」
  const withDraft = withTrace(res, { node: 'draft', detail: draft, ms: 0 });

  if (!provider) {
    return withTrace(withDraft, {
      node: 'compose',
      detail: '未配置模型，直接用规则话术',
      ms: 0,
    });
  }

  const t0 = Date.now();
  const out = await provider.chatText({
    system: REPLY_STYLE_PROMPT.system,
    user: `草稿：\n${draft}\n\n请改写这一条消息。`,
    timeoutMs: llmTimeoutMs(),
    temperature: 0.3,
  });

  if (!out.ok) {
    return degraded(withDraft, `模型调用失败(${out.error})，保留模板`, out.latencyMs);
  }

  const violations = checkGrounding(out.data, draft);
  if (violations.length > 0) {
    return degraded(
      withDraft,
      `接地校验拦下：${violations.map((v) => v.detail).join('；')}`,
      Date.now() - t0,
    );
  }

  const actions = [...res.actions];
  actions[idx] = { type: 'text', text: out.data };

  const promptTokens = out.usage?.promptTokens ?? 0;
  const completionTokens = out.usage?.completionTokens ?? 0;

  return {
    ...withDraft,
    actions,
    meta: {
      ...res.meta,
      model: `${provider.name}:${out.model}`,
      promptVersion: REPLY_STYLE_PROMPT.version,
      latencyMs: res.meta.latencyMs + (Date.now() - t0),
      usage: mergeUsage(res.meta.usage, {
        promptTokens,
        completionTokens,
        calls: 1,
        retries: Math.max(0, out.attempts - 1),
        costCny: costCny(promptTokens, completionTokens),
      }),
    },
    trace: [
      ...withDraft.trace,
      {
        node: 'compose',
        detail:
          `${provider.name} 改写 ${draft.length}→${out.data.length} 字` +
          ` · ${promptTokens}+${completionTokens} tok` +
          `${out.attempts > 1 ? ` · 重试 ${out.attempts - 1} 次` : ''}`,
        ms: Date.now() - t0,
      },
    ],
  };
}

/** 同一个回合里可能调两次模型（理解 + 措辞），用量要累加 */
export function mergeUsage(
  a: AgentResponse['meta']['usage'],
  b: NonNullable<AgentResponse['meta']['usage']>,
): NonNullable<AgentResponse['meta']['usage']> {
  if (!a) return b;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    calls: a.calls + b.calls,
    retries: a.retries + b.retries,
    costCny:
      a.costCny == null && b.costCny == null ? undefined : (a.costCny ?? 0) + (b.costCny ?? 0),
  };
}

function degraded(res: AgentResponse, reason: string, ms: number): AgentResponse {
  return withTrace(
    { ...res, meta: { ...res.meta, degraded: true } },
    { node: 'compose', detail: reason, ms: Math.max(0, ms) },
  );
}

function withTrace(res: AgentResponse, step: AgentResponse['trace'][number]): AgentResponse {
  return { ...res, trace: [...res.trace, step] };
}
