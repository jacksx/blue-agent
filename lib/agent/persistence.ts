import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * 会话落盘。
 *
 * W0 用"内存 + 异步写盘（write-behind）"：
 *   · 读永远走内存，快
 *   · 写先改内存，200ms 后合并落盘，重启不丢
 *
 * 这不是最终形态。真上生产要换成 Postgres（见 docs/schema.sql 的 conversations 表），
 * 那时 getConversation/saveConversation 会变成 async，状态读写要上提到 pipeline。
 * 现在保持同步，是为了让 handle() 仍然是纯函数。
 */

export type Snapshot = Record<string, unknown>;

const FILE = resolve(process.cwd(), '.data', 'conversations.json');
const FLUSH_DELAY_MS = 200;

let loaded = false;
let dirty = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function ensureLoaded(load: () => void): void {
  if (loaded) return;
  loaded = true;
  load();
}

export function loadSnapshot(): Snapshot {
  ensureLoaded(() => {});
  if (!existsSync(FILE)) return {};
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as Snapshot;
  } catch {
    // 文件坏了不能把服务带崩，当成空库
    return {};
  }
}

export function markLoaded(): void {
  loaded = true;
}

/** 延迟合并写：短时间内的多次保存只落一次盘 */
export function schedulePersist(snapshot: () => Snapshot): void {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    if (!dirty) return;
    dirty = false;
    persistNow(snapshot);
  }, FLUSH_DELAY_MS);
  // 别让一个未落盘的定时器把进程吊住
  timer.unref?.();
}

export function persistNow(snapshot: () => Snapshot): void {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(snapshot()), 'utf8');
  } catch {
    // 落盘失败不影响本次请求，下一次保存会重试
  }
}

export function storagePath(): string {
  return FILE;
}
