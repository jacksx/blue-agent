import type { LlmProvider } from './types';
import { createDeepseek } from './deepseek';

/**
 * 没有 key 时返回 null —— 整条链路走规则，行为、延迟、字节数都和之前完全一致。
 * 有 key 时才多一次改写调用，并且过了接地校验才会替换文本。
 */

let cached: LlmProvider | null | undefined;

export function getProvider(): LlmProvider | null {
  if (cached !== undefined) return cached;

  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    cached = null;
    return cached;
  }

  cached = createDeepseek({
    apiKey,
    baseUrl: process.env.DEEPSEEK_BASE_URL,
    model: process.env.DEEPSEEK_MODEL,
  });
  return cached;
}

/** 测试用：切 provider 不重启进程 */
export function setProviderForTest(provider: LlmProvider | null | undefined): void {
  cached = provider;
}

export function llmTimeoutMs(): number {
  const raw = Number(process.env.LLM_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 6000;
}
