/**
 * 模型接入层的契约。
 *
 * 设计约束：模型**不产生业务事实**，只做两件事——理解（结构化输出）、措辞（改写）。
 * 所有产出都要过校验，过不了就退回规则，绝不允许"模型说得挺顺就用"。
 */

export interface TextCall {
  system: string;
  user: string;
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
}

export type ParseResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface JsonCall<T> extends TextCall {
  /** 结构化输出的校验与归一化。模型给的 raw 是 unknown，必须过这一关 */
  parse: (raw: unknown) => ParseResult<T>;
}

export type LlmOutcome<T> =
  | {
      ok: true;
      data: T;
      model: string;
      latencyMs: number;
      usage?: LlmUsage;
      /** 一共试了几次（含首次）。>1 说明重试过 */
      attempts: number;
    }
  | { ok: false; error: string; latencyMs: number; attempts: number };

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly defaultModel: string;
  /** 纯文本输出 */
  chatText(call: TextCall): Promise<LlmOutcome<string>>;
  /** JSON 输出，强制过 schema */
  chatJSON<T>(call: JsonCall<T>): Promise<LlmOutcome<T>>;
}
