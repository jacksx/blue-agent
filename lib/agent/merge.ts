import { createHash } from 'node:crypto';
import type { AgentRequest, IncomingMessage } from './types';

/**
 * 连发合并。
 *
 * 用户在手机上打字慢，一句"还招人吗"经常拆成"在吗""还招吗""多少钱"三条发过来。
 * 一条一处理的话，agent 会连回三次，看起来像个机器人；更糟的是三条消息
 * 各自触发一次判定，可能同时发出两张采集表。
 *
 * 合并放在**业务端**做（静默窗口 1.5s，最长 4s），agent 只接收合并后的 turn。
 * agent 这边保留合并实现是为了让协议可验证：谁传 messages[] 都按同一套规则合。
 */

const MAX_PART_CHARS = 400;

export interface MergedTurn {
  message: IncomingMessage;
  /** 幂等键。由 messageId 集合决定，和到达顺序无关 */
  messageId: string;
  mergedFrom: string[];
}

function sortKey(m: IncomingMessage, i: number): [string, number] {
  return [m.sentAt, i];
}

export function mergeText(parts: IncomingMessage[]): string {
  const texts = parts
    .filter((m) => m.type === 'text')
    .map((m) => (m.text ?? '').trim())
    .filter(Boolean);

  if (texts.length === 0) return '';
  const joined = texts.join('\n');
  return joined.length > MAX_PART_CHARS * 3 ? joined.slice(0, MAX_PART_CHARS * 3) : joined;
}

/** 非文本消息不合并，按"最后一条"处理——图片和语音没法拼 */
export function mergeKey(parts: IncomingMessage[]): string {
  const ids = parts.map((m) => m.messageId ?? `${m.sentAt}:${m.text ?? ''}`).sort();
  const h = createHash('sha1').update(ids.join('|')).digest('hex');
  return `turn-${h.slice(0, 16)}`;
}

export function mergeTurn(parts: IncomingMessage[]): MergedTurn {
  const ordered = parts
    .map((m, i) => ({ m, k: sortKey(m, i) }))
    .sort((a, b) => (a.k[0] < b.k[0] ? -1 : a.k[0] > b.k[0] ? 1 : a.k[1] - b.k[1]))
    .map((x) => x.m);

  const last = ordered[ordered.length - 1]!;
  const nonText = ordered.filter((m) => m.type !== 'text');

  // 只要有一条不是文本，就以最后一条非文本为准（"我发你个截图" 场景）
  const message: IncomingMessage =
    nonText.length > 0
      ? { ...nonText[nonText.length - 1]!, sentAt: last.sentAt }
      : { type: 'text', text: mergeText(ordered), sentAt: last.sentAt };

  return { message, messageId: mergeKey(ordered), mergedFrom: ordered.map((m) => m.messageId ?? '') };
}

/**
 * 把各种形态的请求归一成一个 turn。
 * 单条消息和老调用方不受影响；传了 messages[] 就走合并。
 */
export function resolveTurn(req: AgentRequest): MergedTurn {
  const parts = req.messages?.filter(Boolean) ?? [];

  if (parts.length > 1) return mergeTurn(parts);

  const single =
    parts[0] ??
    req.message ?? { type: 'text' as const, text: '', sentAt: new Date().toISOString() };

  return {
    message: single,
    messageId: req.messageId ?? mergeKey([single]),
    mergedFrom: single.messageId ? [single.messageId] : [],
  };
}
