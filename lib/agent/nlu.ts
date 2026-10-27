import type { JobOrder } from './types';
import { getProvider, llmTimeoutMs } from '@/lib/llm';
import { NLU_PROMPT } from '@/lib/llm/prompts';
import { parseNlu } from '@/lib/llm/schemas';
import { classify, ruleExtract, type IntentAction } from './rules';

/**
 * 理解层：把一句人话变成「在问什么（topics）+ 想干什么（action）+ 明确的约束」。
 *
 * 这是整条链路里唯一会调用模型两次的地方之一（另一次是措辞），
 * 也是最容易出幻觉的地方——所以输出必须过 schema，topic 和 action 都得在白名单里。
 * 模型失败、超时、返回未知值，一律回退规则，用户感知不到。
 */

export interface Understanding {
  /** 在问什么。字段组名，可扩展 */
  topics: string[];
  /** 想干什么。封闭枚举，决定流程 */
  action: IntentAction;
  confidence: number;
  shift?: { value: string; reason?: string; strength: 'hard' | 'strong' };
  salaryTarget?: number;
  healthCert?: boolean;
  /**
   * 这句话里有、但我们归不了类的诉求。
   * 模型自评出来的——宁可在回复里承认一句，也不要装作答完了。
   */
  unclear?: string;
  source: 'model' | 'rule';
  degraded: boolean;
  note?: string;
  latencyMs: number;
  /** 这次理解花了多少 token、重试了几次 */
  tokens?: { prompt: number; completion: number };
  retries?: number;
}

export function ruleUnderstanding(text: string, job: JobOrder): Understanding {
  const { topics, action, confidence } = classify(text);
  const facts = ruleExtract(text, job);
  return {
    topics,
    action,
    confidence,
    shift: facts.shift,
    salaryTarget: facts.salaryTarget,
    healthCert: facts.healthCert,
    source: 'rule',
    degraded: false,
    latencyMs: 0,
  };
}

export async function understand(text: string, job: JobOrder): Promise<Understanding> {
  const provider = getProvider();
  if (!provider) return ruleUnderstanding(text, job);

  const fallback = ruleUnderstanding(text, job);
  const t0 = Date.now();

  const out = await provider.chatJSON({
    system: NLU_PROMPT.system,
    user: `求职者说：${text}`,
    // 理解是个小 JSON，不该等太久；等不到就直接用规则
    timeoutMs: Math.min(llmTimeoutMs(), 3000),
    temperature: 0,
    maxTokens: 180,
    parse: parseNlu,
  });

  if (!out.ok) {
    return {
      ...fallback,
      degraded: true,
      note: `模型理解失败(${out.error} ×${out.attempts})，回退规则`,
      latencyMs: Date.now() - t0,
      retries: Math.max(0, out.attempts - 1),
    };
  }

  // topics 取并集：模型偶尔漏掉"还有别的吗"里的"别的"，规则能抓到的关键词
  // 不该被模型推翻。action 也保留规则兜底，避免模型把"算了"读成客气话。
  const ruleTopics = fallback.topics.filter((t) => t !== 'other');

  return {
    ...out.data,
    topics: [...new Set([...out.data.topics, ...ruleTopics])],
    action: out.data.action !== 'none' ? out.data.action : fallback.action,
    shift: out.data.shift ?? fallback.shift,
    salaryTarget: out.data.salaryTarget ?? fallback.salaryTarget,
    healthCert: out.data.healthCert ?? fallback.healthCert,
    latencyMs: Date.now() - t0,
    tokens: {
      prompt: out.usage?.promptTokens ?? 0,
      completion: out.usage?.completionTokens ?? 0,
    },
    retries: Math.max(0, out.attempts - 1),
  };
}
