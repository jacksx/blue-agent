/**
 * 配对检验与多次采样。
 *
 * 为什么不是"通过率涨了就算变好"：
 *   80% → 85% 可能是修好 12 条、弄坏 5 条，净 +7。只看总分，那 5 条就是上线后的事故。
 * 所以评测报告必须给出 case 级 diff（fixed / broken），再用 McNemar 判"净变化是不是噪声"。
 */

/** 二项分布组合数。n ≤ 60 时直接算，够用且不引依赖 */
function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let out = 1;
  for (let i = 1; i <= kk; i++) out = (out * (n - kk + i)) / i;
  return out;
}

/**
 * McNemar 的精确二项检验（双侧）。
 *
 * 原假设：修好的条数 b 和弄坏的条数 c 一样多（改动没有方向性）。
 * 在 b + c 次"不一致"里，b 服从 Binomial(b+c, 0.5)。
 * 小样本下比 χ² 近似更稳，所以默认给精确 p；χ² 仍然一起给，方便和面试材料对齐。
 */
export function mcnemar(b: number, c: number): {
  b: number;
  c: number;
  chi2: number;
  pValue: number;
  significant: boolean;
} {
  const n = b + c;
  if (n === 0) return { b, c, chi2: 0, pValue: 1, significant: false };

  const tail = Math.min(b, c);
  let mass = 0;
  for (let k = 0; k <= tail; k++) mass += choose(n, k);
  const pValue = Math.min(1, (2 * mass) / 2 ** n);

  const chi2 = Math.max(0, (Math.abs(b - c) - 1) ** 2 / n);

  return { b, c, chi2: Number(chi2.toFixed(2)), pValue: Number(pValue.toFixed(4)), significant: pValue < 0.05 };
}

/**
 * 多次采样取多数票。
 * 规则版是确定性的，跑 1 次就够；接模型后单次结果会抖，3 次多数票才稳。
 */
export function majority(oks: boolean[]): boolean {
  if (oks.length === 0) return false;
  const yes = oks.filter(Boolean).length;
  return yes * 2 > oks.length;
}

/** 0 → 1, 1 → 2, 2 → 3：至少跑 3 次才能说"这条抖不抖" */
export function flaky(oks: boolean[]): boolean {
  return oks.length > 1 && new Set(oks).size > 1;
}
