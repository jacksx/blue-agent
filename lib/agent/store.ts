import type { ConversationState, SlotMap } from './types';
import { loadSnapshot, markLoaded, schedulePersist } from './persistence';

/**
 * 会话状态存储。
 *
 * 放这里的意义是把"状态归谁"这件事固定下来：
 * **对话历史与槽位归 agent，业务事实归业务端**（见 §2.3）。
 *
 * 现在是内存 + 异步落盘，重启不丢；生产换 Postgres 时只改这个文件。
 */

export interface SlotChange {
  key: string;
  from: unknown;
  to: unknown;
  at: string;
  evidence?: string;
}

export interface ConversationRecord {
  conversationId: string;
  slots: SlotMap;
  state: ConversationState;
  jobOrderId?: string;
  /** 已处理的用户消息数，用来判断"首条" */
  turns: number;
  /** 上一轮问了什么，用来把"能""可以"这类短回答接住 */
  pendingField?: string;
  /** 已经在哪个岗位上问过"要不要来面试"——问过就不再催 */
  interviewAskedJobId?: string;
  /** 连续非文本消息数：连续 2 条转人工（用户可能不习惯打字） */
  nonTextStreak?: number;
  /** 槽位被改过的历史（前后说法不一致时能翻出来） */
  slotChanges?: SlotChange[];
  updatedAt: string;
}

const store = new Map<string, ConversationRecord>();
let hydrated = false;

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  markLoaded();
  const raw = loadSnapshot();
  for (const [id, rec] of Object.entries(raw)) {
    store.set(id, rec as ConversationRecord);
  }
}

function snapshot(): Record<string, ConversationRecord> {
  return Object.fromEntries(store);
}

export function getConversation(conversationId: string): ConversationRecord {
  hydrate();
  const hit = store.get(conversationId);
  if (hit) return hit;

  const fresh: ConversationRecord = {
    conversationId,
    slots: {},
    state: 'GREETING',
    turns: 0,
    updatedAt: new Date().toISOString(),
  };
  store.set(conversationId, fresh);
  return fresh;
}

export function saveConversation(
  conversationId: string,
  patch: Partial<ConversationRecord>,
): ConversationRecord {
  const cur = getConversation(conversationId);
  const next: ConversationRecord = {
    ...cur,
    ...patch,
    slots: patch.slots ?? cur.slots,
    updatedAt: new Date().toISOString(),
  };
  store.set(conversationId, next);
  schedulePersist(snapshot);
  return next;
}

export function resetConversation(conversationId: string): void {
  hydrate();
  store.delete(conversationId);
  schedulePersist(snapshot);
}

/** 测试用：看看内存里到底有什么 */
export function dumpConversations(): Record<string, ConversationRecord> {
  hydrate();
  return snapshot();
}
