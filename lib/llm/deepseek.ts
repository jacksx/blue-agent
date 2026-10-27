import type { JsonCall, LlmOutcome, LlmProvider, TextCall } from './types';

/**
 * DeepSeek（OpenAI 兼容）适配器。不引 SDK，一次 fetch 就够，
 * 也方便把 baseURL 指向本地 mock 做契约测试。
 *
 * 重试策略：只重试"可能自愈"的错——5xx / 429 / 超时 / 网络。
 * 4xx（参数错、鉴权错）重试多少次结果都一样，直接放弃。
 * 退避是指数 + 抖动，避免多个实例同时重试把上游打穿。
 */

interface DeepseekConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  maxAttempts?: number;
}

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

interface Usage {
  promptTokens: number;
  completionTokens: number;
}

const DEFAULT_BASE = 'https://api.deepseek.com';
const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 200;

/** 这个错值不值得再试一次 */
function isRetryable(error: string): boolean {
  if (error === 'timeout' || error === 'network') return true;
  if (error === 'http_429') return true;
  if (/^http_5\d\d$/.test(error)) return true;
  return false;
}

function backoffMs(attempt: number): number {
  return BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * 100;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createDeepseek(config: DeepseekConfig): LlmProvider {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  const defaultModel = config.model ?? 'deepseek-chat';
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  /** 单次往返，不重试 */
  async function once(
    req: TextCall,
    jsonMode: boolean,
  ): Promise<{ ok: true; content: string; usage: Usage } | { ok: false; error: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), req.timeoutMs ?? 8000);

    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: req.model ?? defaultModel,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          temperature: req.temperature ?? 0.3,
          max_tokens: req.maxTokens ?? 220,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) return { ok: false, error: `http_${res.status}` };

      const body = (await res.json()) as ChatCompletion;
      const content = body.choices?.[0]?.message?.content?.trim();
      if (!content) return { ok: false, error: 'empty_content' };

      return {
        ok: true,
        content,
        usage: {
          promptTokens: body.usage?.prompt_tokens ?? 0,
          completionTokens: body.usage?.completion_tokens ?? 0,
        },
      };
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      return { ok: false, error: aborted ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** 带重试与退避 */
  async function call(req: TextCall, jsonMode: boolean): Promise<LlmOutcome<string>> {
    const started = Date.now();
    const budgetMs = (req.timeoutMs ?? 8000) * 2.5;
    let lastError = 'unknown';
    let attempts = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      const out = await once(req, jsonMode);

      if (out.ok) {
        return {
          ok: true,
          data: out.content,
          model: req.model ?? defaultModel,
          latencyMs: Date.now() - started,
          usage: out.usage,
          attempts,
        };
      }

      lastError = out.error;
      const elapsed = Date.now() - started;
      const canRetry = isRetryable(out.error) && attempt < maxAttempts && elapsed < budgetMs;
      if (!canRetry) break;

      await sleep(backoffMs(attempt));
    }

    return { ok: false, error: lastError, latencyMs: Date.now() - started, attempts };
  }

  async function chatText(call0: TextCall): Promise<LlmOutcome<string>> {
    return call(call0, false);
  }

  async function chatJSON<T>(call0: JsonCall<T>): Promise<LlmOutcome<T>> {
    const raw = await call(call0, true);
    if (!raw.ok) return raw;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.data);
    } catch {
      return { ok: false, error: 'invalid_json', latencyMs: raw.latencyMs, attempts: raw.attempts };
    }

    const checked = call0.parse(parsed);
    if (!checked.ok) {
      return {
        ok: false,
        error: `schema:${checked.error}`,
        latencyMs: raw.latencyMs,
        attempts: raw.attempts,
      };
    }

    return { ...raw, data: checked.data };
  }

  return { name: 'deepseek', defaultModel, chatText, chatJSON };
}
