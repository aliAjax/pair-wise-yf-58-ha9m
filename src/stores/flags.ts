import { defineStore } from 'pinia';
import { toRaw } from 'vue';

export type FlagStatus = 'draft' | 'approved' | 'rolling' | 'scheduled' | 'stopped' | 'rolled-back';
export interface RuleSet { region: string; appVersion: string; authenticated: boolean; }

/** 发布快照：一次提交冻结的不可变配置，带编号 */
export interface ReleaseSnapshot {
  id: string;
  flagId: string;
  version: number;
  rules: RuleSet;
  rollout: number;
  scheduledAt: string;
  approvals: string[];
  status: 'active' | 'superseded' | 'draft';
  createdAt: string;
  committedAt: string | null;
}

export interface FeatureFlag {
  id: string;
  name: string;
  key: string;
  enabled: boolean;
  status: FlagStatus;
  rules: RuleSet;
  rollout: number;
  scheduledAt: string;
  activeSnapshotId: string | null;
  draftSnapshotId: string | null;
}

export interface AuditRecord { id: string; at: string; actor: string; action: string; detail: string; }

/** 双标签页并发修改后保留的待确认冲突 */
export interface PendingConflict {
  id: string;
  flagId: string;
  field: string;
  baseValue: unknown;
  localValue: unknown;
  remoteValue: unknown;
  detectedAt: string;
  status: 'pending' | 'resolved';
}

/** 写盘失败后留下的重试清单项 */
export interface PendingWrite {
  id: string;
  attemptedAt: string;
  status: 'failed';
  attempts: number;
  reason: string;
  payload: unknown;
}

interface State {
  flags: FeatureFlag[];
  snapshots: ReleaseSnapshot[];
  auditLogs: AuditRecord[];
  conflicts: PendingConflict[];
  retryQueue: PendingWrite[];
  activeId: string;
  backfilled: boolean;
  writeFailureMode: boolean;
}

const STORAGE_KEY = 'yf58-flag-state';
const RETRY_KEY = 'yf58-flag-retry';

const seed: State = {
  activeId: 'f1',
  backfilled: false,
  writeFailureMode: false,
  flags: [
    { id: 'f1', name: '新版结算页', key: 'checkout-v2', enabled: false, rollout: 10, rules: { region: '上海', appVersion: '>= 8.2', authenticated: true }, scheduledAt: '2026-10-01T10:00', status: 'draft', activeSnapshotId: null, draftSnapshotId: null },
    { id: 'f2', name: '推荐模型 B', key: 'recommend-model-b', enabled: true, rollout: 35, rules: { region: '全部', appVersion: '>= 8.0', authenticated: false }, scheduledAt: '2026-10-01T10:00', status: 'rolling', activeSnapshotId: null, draftSnapshotId: null }
  ],
  snapshots: [],
  auditLogs: [
    { id: 'a1', at: '09:10', actor: '产品负责人', action: '创建草稿', detail: 'checkout-v2 规则草案 v3' },
    { id: 'a2', at: '09:22', actor: '研发负责人', action: '规则校验', detail: '依赖 payment-v3 已启用' }
  ],
  conflicts: [],
  retryQueue: []
};

function clone<T>(value: T): T {
  const raw = deepRaw(value) as T;
  return JSON.parse(JSON.stringify(raw)) as T;
}

/** 递归解包响应式代理，避免 JSON.stringify 在嵌套代理上无限递归 */
function deepRaw(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const unwrapped = toRaw(value);
  if (Array.isArray(unwrapped)) return unwrapped.map(deepRaw);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(unwrapped)) {
    result[key] = deepRaw((unwrapped as Record<string, unknown>)[key]);
  }
  return result;
}
function deepEqual(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

/** 命中计算：快照 + 用户 -> 确定结果，可按编号复算 */
export function computeHit(snapshot: ReleaseSnapshot, user: { id: string; region: string; appVersion: string; authenticated: boolean }): { hit: boolean; reason: string; bucket: number } {
  const rule = snapshot.rules;
  if (rule.region !== '全部' && rule.region !== user.region) return { hit: false, reason: `地区不匹配（要求${rule.region}）`, bucket: -1 };
  if (rule.authenticated && !user.authenticated) return { hit: false, reason: '要求已登录用户', bucket: -1 };
  const bucket = [...user.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 100;
  const hit = bucket < snapshot.rollout;
  return { hit, reason: hit ? `灰度桶 ${bucket} < ${snapshot.rollout}%` : `灰度桶 ${bucket} ≥ ${snapshot.rollout}%`, bucket };
}

/** 旧数据回填：没有版本编号的开关统一补成初始快照 v1 */
function backfill(state: State): State {
  for (const flag of state.flags) {
    if (state.snapshots.some((s) => s.flagId === flag.id)) continue;
    const isLive = flag.status === 'rolling' || flag.status === 'approved' || flag.status === 'stopped' || flag.status === 'rolled-back';
    const snapshot: ReleaseSnapshot = {
      id: `snap-${flag.id}-v1`,
      flagId: flag.id,
      version: 1,
      rules: { ...flag.rules },
      rollout: flag.rollout,
      scheduledAt: flag.scheduledAt,
      approvals: isLive ? ['产品负责人', '研发负责人'] : [],
      status: isLive ? 'active' : 'draft',
      createdAt: new Date().toISOString(),
      committedAt: isLive ? new Date().toISOString() : null
    };
    state.snapshots.push(snapshot);
    if (isLive) flag.activeSnapshotId = snapshot.id; else flag.draftSnapshotId = snapshot.id;
  }
  state.backfilled = true;
  return state;
}

/** 三向合并：按字段合并本地与远程，两边都改过的字段留待确认 */
function mergeState(local: State, remote: State, base: State): { merged: State; conflicts: PendingConflict[] } {
  // 先解包响应式代理，避免嵌套代理在反复合并时累积导致内存溢出
  const l = deepRaw(local) as State;
  const r = deepRaw(remote) as State;
  const b = deepRaw(base) as State;
  const conflicts: PendingConflict[] = [];
  const merged: State = { ...l, flags: [], snapshots: [...l.snapshots], auditLogs: [...l.auditLogs], conflicts: [...l.conflicts], retryQueue: [...l.retryQueue] };

  const remoteFlagMap = new Map(r.flags.map((f) => [f.id, f]));
  const baseFlagMap = new Map(b.flags.map((f) => [f.id, f]));
  const localFlagIds = new Set(l.flags.map((f) => f.id));

  for (const lf of l.flags) {
    const rf = remoteFlagMap.get(lf.id);
    const bf = baseFlagMap.get(lf.id);
    if (!rf || !bf) { merged.flags.push(lf); continue; }
    const mergedFlag: FeatureFlag = { ...lf };
    const fields: (keyof FeatureFlag)[] = ['rules', 'rollout', 'scheduledAt', 'enabled', 'status'];
    for (const field of fields) {
      const lv = lf[field];
      const rv = rf[field];
      const bv = bf[field];
      const localChanged = !deepEqual(lv, bv);
      const remoteChanged = !deepEqual(rv, bv);
      if (localChanged && remoteChanged && !deepEqual(lv, rv)) {
        conflicts.push({ id: `cf-${Date.now()}-${field}-${Math.random().toString(36).slice(2, 7)}`, flagId: lf.id, field, baseValue: bv, localValue: lv, remoteValue: rv, detectedAt: new Date().toISOString(), status: 'pending' });
      } else if (!localChanged && remoteChanged) {
        (mergedFlag as unknown as Record<string, unknown>)[field] = rv;
      }
    }
    // 两边各自起了草稿快照 -> 两份待确认
    if (lf.draftSnapshotId && rf.draftSnapshotId && lf.draftSnapshotId !== rf.draftSnapshotId) {
      conflicts.push({ id: `cf-${Date.now()}-draft-${Math.random().toString(36).slice(2, 7)}`, flagId: lf.id, field: 'draft', baseValue: bf.draftSnapshotId, localValue: lf.draftSnapshotId, remoteValue: rf.draftSnapshotId, detectedAt: new Date().toISOString(), status: 'pending' });
    }
    // 同步本地草稿配置，避免合并后草稿与工作副本不一致
    if (mergedFlag.draftSnapshotId) {
      const draft = merged.snapshots.find((s) => s.id === mergedFlag.draftSnapshotId);
      if (draft) { draft.rules = { ...mergedFlag.rules }; draft.rollout = mergedFlag.rollout; draft.scheduledAt = mergedFlag.scheduledAt; }
    }
    merged.flags.push(mergedFlag);
  }
  for (const rf of r.flags) if (!localFlagIds.has(rf.id)) merged.flags.push(rf);

  const snapIds = new Set(merged.snapshots.map((s) => s.id));
  for (const rs of r.snapshots) if (!snapIds.has(rs.id)) { merged.snapshots.push(rs); snapIds.add(rs.id); }

  const auditIds = new Set(merged.auditLogs.map((a) => a.id));
  for (const ra of r.auditLogs) if (!auditIds.has(ra.id)) { merged.auditLogs.push(ra); auditIds.add(ra.id); }

  const conflictIds = new Set(merged.conflicts.map((c) => c.id));
  for (const rc of r.conflicts) if (!conflictIds.has(rc.id)) merged.conflicts.push(rc);

  const retryIds = new Set(merged.retryQueue.map((r) => r.id));
  for (const rr of r.retryQueue) if (!retryIds.has(rr.id)) merged.retryQueue.push(rr);

  return { merged, conflicts };
}

let baseState: State | null = null;
let storageHandler: ((e: StorageEvent) => void) | null = null;

function load(): State {
  let state: State;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    state = saved ? (JSON.parse(saved) as State) : clone(seed);
  } catch {
    state = clone(seed);
  }
  try {
    const retryRaw = localStorage.getItem(RETRY_KEY);
    if (retryRaw) state.retryQueue = JSON.parse(retryRaw) as PendingWrite[];
  } catch { /* 忽略重试清单读取失败 */ }
  state = backfill(state);
  baseState = clone(state);
  // 回填后的快照立即落盘，确保旧数据的初始快照在重开后仍可用
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* 写盘失败时仅保留在内存 */ }
  if (!storageHandler) {
    storageHandler = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || !e.newValue) return;
      try {
        const remote = JSON.parse(e.newValue) as State;
        const store = useFlagStore();
        if (!baseState) { baseState = clone(remote); return; }
        const { merged, conflicts } = mergeState(store.$state, remote, baseState);
        merged.conflicts.push(...conflicts);
        store.flags = merged.flags;
        store.snapshots = merged.snapshots;
        store.auditLogs = merged.auditLogs;
        store.conflicts = merged.conflicts;
        store.retryQueue = merged.retryQueue;
        baseState = clone(remote);
        if (conflicts.length) store.audit('检测到并发修改', `${conflicts.length} 处冲突待确认`);
      } catch { /* 忽略损坏的远端数据 */ }
    };
    window.addEventListener('storage', storageHandler);
  }
  return state;
}

export const useFlagStore = defineStore('flags', {
  state: (): State => load(),
  getters: {
    active(state): FeatureFlag | undefined { return state.flags.find((item) => item.id === state.activeId); },
    activeSnapshot(state): ReleaseSnapshot | undefined {
      const flag = state.flags.find((item) => item.id === state.activeId);
      return state.snapshots.find((s) => s.id === flag?.activeSnapshotId);
    },
    draftSnapshot(state): ReleaseSnapshot | undefined {
      const flag = state.flags.find((item) => item.id === state.activeId);
      return state.snapshots.find((s) => s.id === flag?.draftSnapshotId);
    },
    snapshotsForActive(state): ReleaseSnapshot[] {
      const flag = state.flags.find((item) => item.id === state.activeId);
      if (!flag) return [];
      return state.snapshots.filter((s) => s.flagId === flag.id).sort((a, b) => a.version - b.version);
    },
    pendingConflicts(state): PendingConflict[] { return state.conflicts.filter((c) => c.status === 'pending'); },
    activeSnapshots(state): ReleaseSnapshot[] { return state.snapshots.filter((s) => s.status === 'active'); },
    draftSnapshots(state): ReleaseSnapshot[] { return state.snapshots.filter((s) => s.status === 'draft'); }
  },
  actions: {
    persist() {
      let remote: State | null = null;
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        remote = raw ? (JSON.parse(raw) as State) : null;
      } catch { remote = null; }

      let mergedState: State = clone(this.$state);
      if (remote && baseState) {
        const { merged, conflicts } = mergeState(this.$state, remote, baseState);
        merged.conflicts.push(...conflicts);
        // 直接替换顶层属性，避免 $patch 深合并导致响应式代理嵌套累积
        this.flags = merged.flags;
        this.snapshots = merged.snapshots;
        this.auditLogs = merged.auditLogs;
        this.conflicts = merged.conflicts;
        // retryQueue 是本地失败清单，不参与远程合并
        mergedState = merged;
        if (conflicts.length) {
          // 直接写审计记录，不再调用 audit()（否则会递归触发 persist）
          this.auditLogs.unshift({ id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: new Date().toLocaleTimeString(), actor: '当前操作人', action: '检测到并发修改', detail: `${conflicts.length} 处冲突待确认` });
        }
      }

      try {
        if (this.writeFailureMode) throw new Error('模拟写盘失败：磁盘空间不足 / 隐私模式');
        localStorage.setItem(STORAGE_KEY, JSON.stringify(mergedState));
        baseState = clone(mergedState);
      } catch (e) {
        const pending: PendingWrite = {
          id: `pw-${Date.now()}`,
          attemptedAt: new Date().toISOString(),
          status: 'failed',
          attempts: 1,
          reason: (e as Error).message,
          payload: clone(mergedState)
        };
        this.retryQueue.push(pending);
        try { localStorage.setItem(RETRY_KEY, JSON.stringify(this.retryQueue)); } catch { /* 重试清单也写失败时仅保留在内存 */ }
        // 直接写审计记录，不再调用 audit()（否则会递归触发 persist 导致无限循环）
        this.auditLogs.unshift({ id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: new Date().toLocaleTimeString(), actor: '当前操作人', action: '写盘失败', detail: `${pending.id}：${pending.reason}，已进入重试清单` });
      }
    },
    audit(action: string, detail: string, actor = '当前操作人') {
      this.auditLogs.unshift({ id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: new Date().toLocaleTimeString(), actor, action, detail });
      this.persist();
    },
    select(id: string) { this.activeId = id; this.persist(); },

    ensureDraft(flag: FeatureFlag): ReleaseSnapshot {
      const existing = this.snapshots.find((s) => s.id === flag.draftSnapshotId);
      if (existing) return existing;
      const active = this.snapshots.find((s) => s.id === flag.activeSnapshotId);
      const draft: ReleaseSnapshot = {
        id: `snap-${flag.id}-v${(active?.version ?? 0) + 1}-${Date.now()}`,
        flagId: flag.id,
        version: (active?.version ?? 0) + 1,
        rules: { ...flag.rules },
        rollout: flag.rollout,
        scheduledAt: flag.scheduledAt,
        approvals: [],
        status: 'draft',
        createdAt: new Date().toISOString(),
        committedAt: null
      };
      this.snapshots.push(draft);
      flag.draftSnapshotId = draft.id;
      return draft;
    },

    updateRule(rule: Partial<RuleSet>) {
      const flag = this.active;
      if (!flag) return;
      const draft = this.ensureDraft(flag);
      flag.rules = { ...flag.rules, ...rule };
      draft.rules = { ...flag.rules };
      draft.approvals = [];
      flag.status = 'draft';
      this.audit('修改规则', `快照 v${draft.version} 作废重审：${JSON.stringify(flag.rules)}`);
    },
    setRollout(value: number) {
      const flag = this.active;
      if (!flag) return;
      const draft = this.ensureDraft(flag);
      flag.rollout = value;
      draft.rollout = value;
      draft.approvals = [];
      this.audit('调整放量', `快照 v${draft.version} 作废重审：${flag.key} → ${value}%`);
    },
    schedule(value: string) {
      const flag = this.active;
      if (!flag) return;
      const draft = this.ensureDraft(flag);
      flag.scheduledAt = value;
      draft.scheduledAt = value;
      draft.approvals = [];
      flag.status = 'scheduled';
      this.audit('设置定时', `快照 v${draft.version} 作废重审：${value}`);
    },
    approve(role: string) {
      const flag = this.active;
      if (!flag) return;
      const draft = this.ensureDraft(flag);
      if (draft.approvals.includes(role)) return;
      draft.approvals.push(role);
      flag.status = draft.approvals.length >= 2 ? 'approved' : 'draft';
      this.audit('审批发布', `${role} 已确认快照 v${draft.version}`, role);
    },
    startRollout() {
      const flag = this.active;
      if (!flag) return;
      const draft = this.snapshots.find((s) => s.id === flag.draftSnapshotId);
      if (!draft || draft.status !== 'draft' || draft.approvals.length < 2) return;
      const active = this.snapshots.find((s) => s.id === flag.activeSnapshotId);
      draft.version = (active?.version ?? 0) + 1;
      draft.status = 'active';
      draft.committedAt = new Date().toISOString();
      draft.rules = { ...flag.rules };
      draft.rollout = flag.rollout;
      draft.scheduledAt = flag.scheduledAt;
      if (active) active.status = 'superseded';
      flag.activeSnapshotId = draft.id;
      flag.draftSnapshotId = null;
      flag.enabled = true;
      flag.status = 'rolling';
      this.audit('提交快照', `${flag.key} 快照 v${draft.version} 生效，放量 ${flag.rollout}%`);
    },
    emergencyStop() {
      const flag = this.active;
      if (!flag) return;
      flag.enabled = false;
      flag.status = 'stopped';
      this.audit('紧急停止', `${flag.key} 已立即关闭`);
    },
    rollback() {
      const flag = this.active;
      if (!flag) return;
      const active = this.snapshots.find((s) => s.id === flag.activeSnapshotId);
      const snap: ReleaseSnapshot = {
        id: `snap-${flag.id}-v${(active?.version ?? 0) + 1}-${Date.now()}`,
        flagId: flag.id,
        version: (active?.version ?? 0) + 1,
        rules: { ...flag.rules },
        rollout: 0,
        scheduledAt: flag.scheduledAt,
        approvals: ['产品负责人', '研发负责人'],
        status: 'active',
        createdAt: new Date().toISOString(),
        committedAt: new Date().toISOString()
      };
      if (active) active.status = 'superseded';
      this.snapshots.push(snap);
      flag.activeSnapshotId = snap.id;
      flag.draftSnapshotId = null;
      flag.rollout = 0;
      flag.enabled = false;
      flag.status = 'rolled-back';
      this.audit('执行回滚', `${flag.key} 回滚至快照 v${snap.version}（关闭）`);
    },

    simulateHit(user: { id: string; region: string; appVersion: string; authenticated: boolean }) {
      const flag = this.active;
      if (!flag) return { hit: false, reason: '无活动开关', snapshotVersion: null as number | null, isDraft: false };
      const snap = this.snapshots.find((s) => s.id === (flag.draftSnapshotId ?? flag.activeSnapshotId));
      if (!snap) return { hit: false, reason: '无可用快照', snapshotVersion: null, isDraft: false };
      if (!flag.enabled && !flag.draftSnapshotId) return { hit: false, reason: '开关未启用', snapshotVersion: snap.version, isDraft: false };
      const result = computeHit(snap, user);
      this.audit('模拟命中', `按快照 v${snap.version}${flag.draftSnapshotId ? '（草稿预览）' : ''}复算：${result.reason}`);
      return { ...result, snapshotVersion: snap.version, isDraft: !!flag.draftSnapshotId };
    },
    recomputeHit(flagId: string, version: number, user: { id: string; region: string; appVersion: string; authenticated: boolean }) {
      const snap = this.snapshots.find((s) => s.flagId === flagId && s.version === version);
      if (!snap) return { hit: false, reason: '快照不存在', snapshotVersion: version, isDraft: false };
      const result = computeHit(snap, user);
      this.audit('按编号复算', `快照 v${version}：${result.reason}`);
      return { ...result, snapshotVersion: version, isDraft: false };
    },

    resolveConflict(conflictId: string, choice: 'local' | 'remote') {
      const conflict = this.conflicts.find((c) => c.id === conflictId);
      if (!conflict || conflict.status !== 'pending') return;
      const flag = this.flags.find((f) => f.id === conflict.flagId);
      if (flag) {
        if (conflict.field === 'draft') {
          const keepId = (choice === 'local' ? conflict.localValue : conflict.remoteValue) as string;
          const discardId = (choice === 'local' ? conflict.remoteValue : conflict.localValue) as string;
          flag.draftSnapshotId = keepId;
          this.snapshots = this.snapshots.filter((s) => s.id !== discardId);
        } else {
          (flag as Record<string, unknown>)[conflict.field] = choice === 'local' ? conflict.localValue : conflict.remoteValue;
          const draft = this.snapshots.find((s) => s.id === flag.draftSnapshotId);
          if (draft) { draft.rules = { ...flag.rules }; draft.rollout = flag.rollout; draft.scheduledAt = flag.scheduledAt; }
        }
      }
      conflict.status = 'resolved';
      this.audit('解决冲突', `${conflict.field} 采用${choice === 'local' ? '本地' : '远程'}副本`);
    },

    retryFailedWrites() {
      if (this.retryQueue.length === 0) return;
      this.writeFailureMode = false;
      const latest = this.retryQueue[this.retryQueue.length - 1];
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(latest.payload));
        this.retryQueue = [];
        try { localStorage.removeItem(RETRY_KEY); } catch { /* 忽略 */ }
        baseState = clone(latest.payload as State);
        this.audit('重试写盘', `已补发 ${latest.id}，状态持久化成功`);
      } catch (e) {
        latest.attempts += 1;
        this.audit('重试失败', `${latest.id}：${(e as Error).message}`);
      }
    },

    toggleWriteFailure(enabled: boolean) {
      this.writeFailureMode = enabled;
      this.persist();
    },

    createFlag(values: { name: string; key: string }) {
      const id = `f-${Date.now()}`;
      const flag: FeatureFlag = {
        id, name: values.name, key: values.key, enabled: false, rollout: 0,
        rules: { region: '全部', appVersion: '>= 1.0', authenticated: false },
        scheduledAt: '2026-10-02T10:00', status: 'draft',
        activeSnapshotId: null, draftSnapshotId: null
      };
      this.flags.push(flag);
      this.ensureDraft(flag);
      this.select(id);
      this.audit('创建开关', `${values.key} 草稿快照 v1`);
    }
  }
});

export { computeHit as computeHitForSnapshot };
