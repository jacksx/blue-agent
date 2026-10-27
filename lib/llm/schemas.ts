import { z } from 'zod';
import { TOPIC_KEYS, type IntentAction } from '@/lib/agent/rules';
import type { Understanding } from '@/lib/agent/nlu';
import type { ParseResult } from '@/lib/llm/types';

/**
 * 模型输出的 schema。
 *
 * 模型有可能：编一个不存在的 topic、把薪资写成 "6000 左右"、给负数、
 * 或者自创一个 action。这里全部收口成确定结构，收不住就当模型失败，走规则兜底。
 *
 * action 必须严格白名单——它在代码里是分支条件，模型编一个就直接走错分支。
 */

const ACTIONS: IntentAction[] = ['ask', 'want_other', 'reject', 'accept', 'none'];

const ShiftEnum = z.enum(['长白班', '两班倒', '长夜班', '三班倒', '排班', '时间灵活']);

export const NluSchema = z.object({
  action: z.string().max(20).optional(),
  topics: z.array(z.string()).max(6).optional(),
  confidence: z.number().min(0).max(1).optional(),
  shift: ShiftEnum.nullable().optional(),
  shiftReason: z.string().max(60).nullable().optional(),
  salaryTarget: z.number().min(1000).max(100000).nullable().optional(),
  healthCert: z.boolean().nullable().optional(),
  /** 模型自己报告"这句里有我归不了类的诉求" */
  unclear: z.string().max(60).nullable().optional(),
});

export type NluPayload = z.infer<typeof NluSchema>;

/**
 * 归一化：
 *   · 未知 topic 丢掉；一个都不剩就当 "other"
 *   · action 不在白名单 → none（不能猜，猜错了流程就走歪）
 */
export function parseNlu(raw: unknown): ParseResult<Understanding> {
  const checked = NluSchema.safeParse(raw);
  if (!checked.success) {
    return { ok: false, error: checked.error.issues[0]?.message ?? 'schema' };
  }

  const p = checked.data;
  const topics = (p.topics ?? []).filter((t) => TOPIC_KEYS.includes(t));
  const action = ACTIONS.find((a) => a === p.action);

  if (topics.length === 0 && action == null) {
    return { ok: false, error: 'no_known_topic' };
  }

  return toUnderstanding({
    topics: topics.length > 0 ? topics : ['other'],
    action: action ?? 'none',
    confidence: p.confidence ?? 0.7,
    shift: p.shift ?? undefined,
    shiftReason: p.shiftReason ?? undefined,
    salaryTarget: p.salaryTarget ?? undefined,
    healthCert: p.healthCert ?? undefined,
    unclear: p.unclear ?? undefined,
  });
}

function toUnderstanding(input: {
  topics: string[];
  action: IntentAction;
  confidence: number;
  shift?: string;
  shiftReason?: string;
  salaryTarget?: number;
  healthCert?: boolean;
  unclear?: string;
}): ParseResult<Understanding> {
  const u: Understanding = {
    topics: input.topics,
    action: input.action,
    confidence: input.confidence,
    source: 'model',
    degraded: false,
    latencyMs: 0,
  };

  if (input.shift) {
    // 只上白班才是硬约束；说"能接受两班倒"只是意愿
    const hard = input.shift === '长白班';
    u.shift = {
      value: input.shift,
      reason: input.shiftReason,
      strength: hard ? 'hard' : 'strong',
    };
  }
  if (input.salaryTarget != null) u.salaryTarget = input.salaryTarget;
  if (input.healthCert != null) u.healthCert = input.healthCert;
  if (input.unclear) u.unclear = input.unclear.slice(0, 40);

  return { ok: true, data: u };
}
