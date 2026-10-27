/**
 * 成本估算。
 *
 * 不内置任何价格——不同账号、不同模型、缓存命中与否都不一样，
 * 写死一个数字只会让人以为那是对的。要算钱就在环境变量里填自己账号的单价。
 *
 *   LLM_PRICE_IN_PER_M=2      # 每百万输入 token 多少元
 *   LLM_PRICE_OUT_PER_M=8     # 每百万输出 token 多少元
 */

export function costCny(promptTokens: number, completionTokens: number): number | undefined {
  const inPerM = Number(process.env.LLM_PRICE_IN_PER_M);
  const outPerM = Number(process.env.LLM_PRICE_OUT_PER_M);
  if (!Number.isFinite(inPerM) || !Number.isFinite(outPerM)) return undefined;
  if (inPerM <= 0 && outPerM <= 0) return undefined;

  const cost = (promptTokens / 1_000_000) * inPerM + (completionTokens / 1_000_000) * outPerM;
  return Number(cost.toFixed(6));
}
