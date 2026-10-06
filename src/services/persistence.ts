// 本地持久化层：模拟写盘失败，失败时登记重试清单，重开后可区分生效/待审/失败

export type QueueStatus = 'live' | 'pending' | 'failed';

export interface RetryItem {
  id: string;
  flagId: string;
  flagName: string;
  seq?: number;
  kind: string;
  summary: string;
  at: string;
  attempts: number;
  lastError: string;
  payload: string; // 序列化后的待写状态片（快照 + 审计）
}

interface PersistShape {
  version: number;
  state: unknown;
  queue: RetryItem[];
}

const STORE_KEY = 'yf58-snapshot-state-v2';
const QUEUE_KEY = 'yf58-snapshot-retry-queue';
const FAIL_KEY = 'yf58-fail-next-writes';

// 测试/演示钩子：让接下来的 n 次写盘失败
export function armWriteFailures(n = 1): void {
  localStorage.setItem(FAIL_KEY, String(n));
}

function consumeFailureToken(): boolean {
  const left = Number(localStorage.getItem(FAIL_KEY) || '0');
  if (left > 0) {
    localStorage.setItem(FAIL_KEY, String(left - 1));
    return true;
  }
  return false;
}

export function loadAll(): PersistShape | null {
  const rawState = localStorage.getItem(STORE_KEY);
  if (!rawState) return null;
  const parsed = JSON.parse(rawState) as { version?: number; state?: unknown };
  const queue: RetryItem[] = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  // 兼容形态：{ version, state }（当前）或裸 state
  const state = parsed && typeof parsed === 'object' && 'state' in parsed ? parsed.state : parsed;
  return { version: parsed?.version ?? 2, state, queue };
}

export function writeState(state: unknown): void {
  if (consumeFailureToken()) {
    throw new Error('模拟写盘失败：存储暂时不可用（配额/IO 错误）');
  }
  localStorage.setItem(STORE_KEY, JSON.stringify({ version: 2, state }));
}

export function loadQueue(): RetryItem[] {
  return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
}

export function saveQueue(queue: RetryItem[]): void {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export function clearStorage(): void {
  localStorage.removeItem(STORE_KEY);
  localStorage.removeItem(QUEUE_KEY);
  localStorage.removeItem(FAIL_KEY);
}
