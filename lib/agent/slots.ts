import type { Slot, SlotMap } from './types';

/**
 * 槽位的时效（§2.10）。
 *
 * 两个月前的"我下个月才能到岗"，现在大概率已经错了。
 * 但过期不等于丢弃——按类型降级：
 *   fresh   → 直接用
 *   stale   → 可以用，但引用时要暴露时间（"你上次说…"），高代价动作前重确认
 *   expired → 视为未知，必须重问
 *
 * 最糟的不是用旧信息，是**静默地**用旧信息。用户以为你记得，你却记的是错的。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 超过 TTL 的 80% 就算 stale：留出一次确认的窗口，而不是等它硬过期 */
const STALE_RATIO = 0.8;

export function slotAgeDays(slot: Slot, now = Date.now()): number | null {
  const t = Date.parse(slot.assertedAt);
  if (!Number.isFinite(t)) return null;
  return (now - t) / DAY_MS;
}

export function refreshSlot(slot: Slot, now = Date.now()): Slot {
  // 硬事实没有 TTL，永远是 fresh；已经标记冲突的也不由时间改写
  if (slot.ttlDays == null || slot.state === 'conflicted') return slot;

  const age = slotAgeDays(slot, now);
  if (age == null) return slot;

  if (age >= slot.ttlDays) {
    return slot.state === 'expired' ? slot : { ...slot, state: 'expired' };
  }
  if (age >= slot.ttlDays * STALE_RATIO) {
    return slot.state === 'stale' || slot.state === 'expired' ? slot : { ...slot, state: 'stale' };
  }
  return slot.state === 'stale' || slot.state === 'expired' ? slot : { ...slot, state: 'fresh' };
}

export function refreshSlots(slots: SlotMap, now = Date.now()): SlotMap {
  const out: SlotMap = {};
  for (const [key, slot] of Object.entries(slots)) out[key] = refreshSlot(slot, now);
  return out;
}

/** 判断能不能拿来用：expired 等于没有 */
export function isUsable(slot: Slot | undefined): boolean {
  return slot != null && slot.state !== 'expired';
}

/** 引用旧信息时的时间前缀。绝不裸说"你要的是…"，要给用户纠正的机会 */
export function freshnessPrefix(slot: Slot | undefined): string {
  if (!slot || slot.state === 'fresh') return '';
  const age = slotAgeDays(slot);
  if (age == null) return '你之前说';
  if (age >= 60) return '你前两个月说';
  if (age >= 25) return '你上个月说';
  if (age >= 5) return '你前阵子说';
  return '你之前说';
}

export function staleSlots(slots: SlotMap): Slot[] {
  return Object.values(slots).filter((s) => s.state === 'stale' || s.state === 'expired');
}
