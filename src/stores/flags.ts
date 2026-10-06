import { defineStore } from 'pinia';
import {
  type AuditRecord, type DraftFields, type FeatureFlag, type FieldKey, type FlagStatus,
  type MergeConflict, type RuleSet, type SimUser, type Snapshot,
  evaluate, getDraftField, nowLabel, setDraftField, snapshotToDraft, threeWayMerge
} from '../lib/snapshot';
import { loadAll, loadQueue, saveQueue, writeState, type RetryItem } from '../services/persistence';

export type { AuditRecord, DraftFields, FeatureFlag, FieldKey, FlagStatus, MergeConflict, RuleSet, SimUser, Snapshot };

interface State {
  version: 2;
  tabId: string;
  flags: FeatureFlag[];
  snapshots: Snapshot[];
  audit: AuditRecord[];
  queue: RetryItem[];
  activeId: string;
}

const APPROVERS = ['产品负责人', '研发负责人'];

// ---- 旧数据：没有版本编号的开关/审批（灰度控制台迁移前的形态）----
interface LegacyFlag { id: string; name: string; key: string; enabled: boolean; rollout: number; rules: RuleSet; status: FlagStatus; }
interface LegacyPlan { id: string; flagId: string; scheduledAt: string; approvals: string[]; version: number; }
interface LegacyAudit { id: string; at: string; actor: string; action: string; detail: string; }
const legacyFlags: LegacyFlag[] = [
  { id: 'f1', name: '新版结算页', key: 'checkout-v2', enabled: false, rollout: 10, rules: { region: '上海', appVersion: '>= 8.2', authenticated: true }, status: 'draft' },
  { id: 'f2', name: '推荐模型 B', key: 'recommend-model-b', enabled: true, rollout: 35, rules: { region: '全部', appVersion: '>= 8.0', authenticated: false }, status: 'rolling' }
];
const legacyPlans: LegacyPlan[] = [{ id: 'p1', flagId: 'f1', scheduledAt: '2026-10-01T10:00', approvals: [], version: 3 }];
const legacyAudit: LegacyAudit[] = [
  { id: 'a1', at: '09:10', actor: '产品负责人', action: '创建草稿', detail: 'checkout-v2 规则草案 v3' },
  { id: 'a2', at: '09:22', actor: '研发负责人', action: '规则校验', detail: '依赖 payment-v3 已启用' }
];

// 把旧开关/审批回填成每个开关的 v1 初始快照
function backfill(): State {
  const flags: FeatureFlag[] = [];
  const snapshots: Snapshot[] = [];
  for (const legacy of legacyFlags) {
    const plan = legacyPlans.find((p) => p.flagId === legacy.id);
    const live = legacy.enabled && legacy.status === 'rolling';
    const snap: Snapshot = {
      id: `s-${legacy.id}-v1`,
      flagId: legacy.id,
      seq: 1,
      kind: 'config',
      at: '迁移前',
      author: '系统回填',
      summary: '旧开关/审批数据回填为初始快照',
      enabled: legacy.enabled,
      rollout: legacy.rollout,
      rules: { ...legacy.rules },
      scheduledAt: plan?.scheduledAt ?? '',
      approvals: live ? ['产品负责人（回填）', '研发负责人（回填）'] : [...(plan?.approvals ?? [])],
      status: legacy.status,
      released: live,
      voided: false,
      rev: 1
    };
    const draft = snapshotToDraft(snap);
    draft.name = legacy.name;
    snapshots.push(snap);
    flags.push({ id: legacy.id, name: legacy.name, key: legacy.key, createdAt: '迁移前', backfilled: true, baseRev: snap.id, draft, conflicts: null, rev: 1 });
  }
  const audit: AuditRecord[] = legacyAudit.map((a) => ({ ...a, rev: 1, backfilled: true }));
  audit.unshift({ id: `a-backfill-${Date.now()}`, at: nowLabel(), actor: '系统', action: '接入发布快照', detail: `已将 ${legacyFlags.length} 个旧开关回填为 v1 初始快照`, rev: 1 });
  return { version: 2, tabId: `tab-${Math.random().toString(36).slice(2, 8)}`, flags, snapshots, audit, queue: [], activeId: 'f1' };
}

function initialState(): State {
  const saved = loadAll();
  if (saved && saved.state) {
    const state = saved.state as State;
    state.queue = saved.queue ?? loadQueue();
    state.tabId = state.tabId || `tab-${Math.random().toString(36).slice(2, 8)}`;
    return state;
  }
  const seeded = backfill();
  try { writeState(seeded); } catch { /* 首次落盘失败：留在内存并进入重试清单 */ seeded.queue = []; }
  return seeded;
}

let uid = 0;
function nextId(prefix: string): string {
  uid += 1;
  return `${prefix}-${Date.now().toString(36)}-${uid}`;
}

// Pinia state 是响应式代理，用 JSON 做纯数据深拷贝
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const useFlagStore = defineStore('flags', {
  state: (): State => initialState(),

  getters: {
    active(state): FeatureFlag | undefined { return state.flags.find((f) => f.id === state.activeId); },
    flagSnapshots: (state) => (flagId: string): Snapshot[] =>
      state.snapshots.filter((s) => s.flagId === flagId).sort((a, b) => a.seq - b.seq),
    effectiveSnapshot: (state) => (flagId: string): Snapshot | undefined => {
      const list = state.snapshots.filter((s) => s.flagId === flagId && s.released && !s.voided).sort((a, b) => b.seq - a.seq);
      return list[0];
    },
    pendingSnapshot: (state) => (flagId: string): Snapshot | undefined => {
      const list = state.snapshots.filter((s) => s.flagId === flagId && s.kind === 'config' && !s.released && !s.voided).sort((a, b) => b.seq - a.seq);
      return list[0];
    },
    flagStatus(): (flagId: string) => FlagStatus {
      return (flagId: string) => this.pendingSnapshot(flagId)?.status ?? this.effectiveSnapshot(flagId)?.status ?? 'draft';
    },
    // 重开后三分：生效 / 待审 / 失败
    liveFlags(state): FeatureFlag[] { return state.flags.filter((f) => this.flagStatus(f.id) === 'rolling'); },
    pendingFlags(state): { flag: FeatureFlag; snap: Snapshot }[] {
      return state.flags
        .map((flag) => ({ flag, snap: this.pendingSnapshot(flag.id) }))
        .filter((x): x is { flag: FeatureFlag; snap: Snapshot } => Boolean(x.snap));
    },
    failedItems(state): RetryItem[] { return state.queue; }
  },

  actions: {
    // ---------- 持久化：写盘失败进入重试清单 ----------
    persist(kind: string, flagId: string, summary: string): boolean {
      try {
        writeState(this.$state);
        return true;
      } catch (error) {
        const flag = this.flags.find((f) => f.id === flagId);
        const item: RetryItem = {
          id: nextId('q'),
          flagId,
          flagName: flag?.name ?? flagId,
          kind,
          summary,
          at: nowLabel(),
          attempts: 0,
          lastError: error instanceof Error ? error.message : String(error),
          payload: JSON.stringify({
            snapshots: this.snapshots,
            audit: this.audit,
            flags: this.flags
          })
        };
        this.queue.unshift(item);
        try { saveQueue(this.queue); } catch { /* 重试清单本身写不进时仅保留在内存 */ }
        return false;
      }
    },

    log(flagId: string, action: string, detail: string, snapSeq?: number): void {
      this.audit.unshift({ id: nextId('a'), at: nowLabel(), actor: '当前操作人', action, detail, snapSeq, rev: 1, flagId });
    },

    select(id: string) { this.activeId = id; this.persist('select', id, '切换选中开关'); },

    createFlag(name: string, key: string): string {
      const id = nextId('f');
      const draft: DraftFields = {
        name, enabled: false, rollout: 0,
        rules: { region: '全部', appVersion: '>= 1.0', authenticated: false },
        scheduledAt: ''
      };
      const snap: Snapshot = {
        id: nextId('s'), flagId: id, seq: 1, kind: 'config', at: nowLabel(), author: '当前操作人',
        summary: '新建开关初始快照', enabled: false, rollout: 0,
        rules: { ...draft.rules }, scheduledAt: '', approvals: [], status: 'draft',
        released: false, voided: false, rev: 1
      };
      this.flags.push({ id, name, key, createdAt: nowLabel(), baseRev: snap.id, draft, conflicts: null, rev: 1 });
      this.snapshots.push(snap);
      this.activeId = id;
      this.log(id, '创建开关', `${key} 生成初始快照 v1`, 1);
      this.persist('create', id, '新建开关 v1');
      return id;
    },

    // 规则/放量/定时改动：旧快照与审批记录一起作废，等待重新提交生成新编号
    editField(field: FieldKey, value: string | number | boolean): void {
      const flag = this.active;
      if (!flag?.draft) return;
      const before = getDraftField(flag.draft, field);
      if (before === value) return;
      setDraftField(flag.draft, field, value);
      flag.rev += 1;
      this.voidPending(flag.id, `字段「${field}」改动`);
      this.persist('edit', flag.id, `编辑字段 ${field}`);
    },

    voidPending(flagId: string, reason: string, writeLog = true): Snapshot[] {
      const dropped = this.snapshots.filter((s) => s.flagId === flagId && s.kind === 'config' && !s.released && !s.voided);
      for (const snap of dropped) {
        snap.voided = true;
        snap.voidReason = reason;
        snap.status = 'draft';
        snap.rev += 1;
        // 审批记录随快照一起作废
        for (const record of this.audit) {
          if (record.flagId === flagId && record.snapSeq === snap.seq && !record.backfilled) {
            record.voided = true;
            record.rev += 1;
          }
        }
      }
      if (writeLog && dropped.length > 0) {
        this.log(flagId, '快照作废重算', `${reason}，v${dropped.map((s) => s.seq).join('、v')} 连同审批记录作废`);
      }
      return dropped;
    },

    // 每次提交生成一个带编号的新快照；模拟、放量、审计都引用它
    submitSnapshot(): { ok: boolean; seq?: number; queued?: boolean } {
      const flag = this.active;
      if (!flag?.draft) return { ok: false };
      const target = this.pendingSnapshot(flag.id) ?? this.snapshots.find((s) => s.id === flag.baseRev);
      if (target && !target.voided) {
        const same = ['enabled', 'rollout', 'region', 'appVersion', 'authenticated', 'scheduledAt'] as FieldKey[];
        const unchanged = same.every((f) => getDraftField(flag.draft!, f) === getDraftField(snapshotToDraft(target), f));
        if (unchanged) return { ok: false };
      }
      const dropped = this.voidPending(flag.id, '提交了新版本快照');
      const seq = Math.max(0, ...this.snapshots.filter((s) => s.flagId === flag.id).map((s) => s.seq)) + 1;
      const d = flag.draft;
      const snap: Snapshot = {
        id: nextId('s'),
        flagId: flag.id,
        seq,
        kind: 'config',
        at: nowLabel(),
        author: '当前操作人',
        summary: `提交发布快照 v${seq}`,
        enabled: d.enabled,
        rollout: d.rollout,
        rules: { ...d.rules },
        scheduledAt: d.scheduledAt,
        approvals: [],
        status: d.scheduledAt ? 'scheduled' : 'draft',
        released: false,
        voided: false,
        rev: 1
      };
      for (const old of dropped) old.supersededBy = snap.id;
      this.snapshots.push(snap);
      flag.baseRev = snap.id;
      flag.rev += 1;
      this.log(flag.id, '提交快照', `${flag.key} 生成 v${seq}，模拟/放量/审计统一引用该编号`, seq);
      const queued = !this.persist('submit', flag.id, `提交快照 v${seq}`);
      return { ok: true, seq, queued };
    },

    approve(role: string): void {
      const flag = this.active;
      const snap = flag && this.pendingSnapshot(flag.id);
      if (!flag || !snap || snap.approvals.includes(role)) return;
      snap.approvals.push(role);
      snap.status = snap.approvals.length >= APPROVERS.length ? 'approved' : 'draft';
      snap.rev += 1;
      this.log(flag.id, '审批发布', `${role} 确认 v${snap.seq}（剩 ${Math.max(0, APPROVERS.length - snap.approvals.length)} 方）`, snap.seq);
      this.persist('approve', flag.id, `${role} 审批 v${snap.seq}`);
    },

    startRollout(): void {
      const flag = this.active;
      const snap = flag && this.pendingSnapshot(flag.id);
      if (!flag || !snap || snap.status !== 'approved') return;
      snap.released = true;
      snap.enabled = true;
      snap.status = 'rolling';
      snap.rev += 1;
      const draft = snapshotToDraft(snap);
      draft.name = flag.name;
      flag.draft = draft;
      flag.baseRev = snap.id;
      flag.rev += 1;
      this.log(flag.id, '开始灰度', `${flag.key} 按 v${snap.seq} 放量 ${snap.rollout}%`, snap.seq);
      this.persist('release', flag.id, `发布 v${snap.seq}`);
    },

    // 运行中放量调整：生成控制类编号快照，审计可引用复算
    adjustRollout(value: number): void {
      const flag = this.active;
      if (!flag?.draft) return;
      const effective = this.effectiveSnapshot(flag.id);
      const pending = this.pendingSnapshot(flag.id);
      flag.draft.rollout = value;
      flag.rev += 1;
      if (effective && effective.status === 'rolling' && !pending) {
        const seq = Math.max(0, ...this.snapshots.filter((s) => s.flagId === flag.id).map((s) => s.seq)) + 1;
        const control: Snapshot = {
          ...clone(effective),
          id: nextId('s'), seq, kind: 'control', at: nowLabel(), author: '当前操作人',
          summary: `运行中放量调整至 ${value}%`, rollout: value, released: true, status: 'rolling',
          voided: false, voidReason: undefined, supersededBy: undefined, rev: 1
        };
        this.snapshots.push(control);
        flag.baseRev = control.id;
        this.log(flag.id, '调整放量', `${flag.key} v${seq} → ${value}%`, seq);
        this.persist('control', flag.id, `放量调整 v${seq}`);
      } else {
        this.voidPending(flag.id, `放量比例改动为 ${value}%`);
        this.persist('edit', flag.id, `调整放量 ${value}%`);
      }
    },

    emergencyStop(): void {
      const flag = this.active;
      const effective = flag && this.effectiveSnapshot(flag.id);
      if (!flag || !effective) return;
      const seq = Math.max(0, ...this.snapshots.filter((s) => s.flagId === flag.id).map((s) => s.seq)) + 1;
      const control: Snapshot = {
        ...clone(effective),
        id: nextId('s'), seq, kind: 'control', at: nowLabel(), author: '值班人员',
        summary: '紧急停止', enabled: false, released: true, status: 'stopped',
        voided: false, voidReason: undefined, supersededBy: undefined, rev: 1
      };
      this.snapshots.push(control);
      if (flag.draft) { flag.draft.enabled = false; }
      flag.baseRev = control.id;
      flag.rev += 1;
      this.log(flag.id, '紧急停止', `${flag.key} 按 v${seq} 立即关闭`, seq);
      this.persist('control', flag.id, `紧急停止 v${seq}`);
    },

    rollback(): void {
      const flag = this.active;
      const effective = flag && this.effectiveSnapshot(flag.id);
      if (!flag || !effective) return;
      const seq = Math.max(0, ...this.snapshots.filter((s) => s.flagId === flag.id).map((s) => s.seq)) + 1;
      const control: Snapshot = {
        ...clone(effective),
        id: nextId('s'), seq, kind: 'control', at: nowLabel(), author: '当前操作人',
        summary: '回滚至关闭状态', enabled: false, rollout: 0, released: true, status: 'rolled-back',
        voided: false, voidReason: undefined, supersededBy: undefined, rev: 1
      };
      this.snapshots.push(control);
      if (flag.draft) { flag.draft.enabled = false; flag.draft.rollout = 0; }
      flag.baseRev = control.id;
      flag.rev += 1;
      this.log(flag.id, '执行回滚', `${flag.key} 按 v${seq} 回滚`, seq);
      this.persist('control', flag.id, `回滚 v${seq}`);
    },

    // 按编号复算同一个人的结果；也可用草稿预演
    simulate(user: SimUser, seq: number | 'draft'): { hit: boolean; reason: string; bucket: number; seq: number | 'draft' } {
      const flag = this.active;
      if (!flag?.draft) return { hit: false, reason: '缺少快照', bucket: 0, seq };
      if (seq === 'draft') {
        const result = evaluate({ enabled: flag.draft.enabled, rollout: flag.draft.rollout, rules: flag.draft.rules }, user);
        return { ...result, seq: 'draft' };
      }
      const snap = this.snapshots.find((s) => s.flagId === flag.id && s.seq === seq);
      if (!snap) return { hit: false, reason: `找不到 v${seq}`, bucket: 0, seq };
      const result = evaluate(snap, user);
      return { ...result, seq: snap.seq };
    },

    // ---------- 两个标签页同时保存：按字段三方合并 ----------
    mergeRemote(remote: State): boolean {
      if (remote.tabId === this.tabId) return false;
      let changed = false;
      const notes: string[] = [];
      // 只吸收对方新产生的编号快照与审计
      for (const rs of remote.snapshots) {
        const local = this.snapshots.find((s) => s.id === rs.id);
        if (!local) { this.snapshots.push(clone(rs)); changed = true; }
        else if (rs.rev > local.rev) { Object.assign(local, clone(rs)); changed = true; }
      }
      for (const ra of remote.audit) {
        if (!this.audit.some((a) => a.id === ra.id)) { this.audit.unshift(clone(ra)); changed = true; }
      }
      for (const remoteFlag of remote.flags) {
        const flag = this.flags.find((f) => f.id === remoteFlag.id);
        if (!flag || !flag.draft || !remoteFlag.draft) continue;
        const baseSnap = this.snapshots.find((s) => s.id === flag.baseRev)
          ?? this.snapshots.find((s) => s.id === remoteFlag.baseRev);
        if (!baseSnap) continue;
        const base = snapshotToDraft(baseSnap);
        base.name = flag.name;
        const { merged, conflicts, autoChanged } = threeWayMerge(base, flag.draft, remoteFlag.draft);
        if (autoChanged.length > 0) {
          flag.draft = merged;
          changed = true;
          notes.push(`${flag.name}：自动并入对方改动字段 ${autoChanged.join('、')}`);
        }
        if (conflicts.length > 0) {
          // 两边都改过同字段：保留本地/远端两份值待人工确认
          const prior = new Map((flag.conflicts ?? []).filter((c) => c.resolution).map((c) => [c.field, c]));
          flag.conflicts = conflicts.map((c) => prior.get(c.field) ?? c);
          changed = true;
          notes.push(`${flag.name}：${conflicts.map((c) => c.field).join('、')} 两边都改过，留两份待确认`);
        }
        flag.rev += 1;
      }
      if (notes.length > 0) this.log(this.activeId, '标签页合并', notes.join('；'));
      if (changed) this.persist('merge', this.activeId, '合并另一标签页的保存');
      return changed;
    },

    resolveConflict(field: FieldKey, resolution: 'local' | 'remote'): void {
      const flag = this.active;
      const conflict = flag?.conflicts?.find((c) => c.field === field);
      if (conflict) conflict.resolution = resolution;
    },

    applyConflictResolutions(): void {
      const flag = this.active;
      if (!flag?.conflicts || !flag.draft) return;
      if (flag.conflicts.some((c) => !c.resolution)) return;
      for (const conflict of flag.conflicts) {
        setDraftField(flag.draft, conflict.field, conflict.resolution === 'local' ? conflict.local : conflict.remote);
      }
      const fields = flag.conflicts.map((c) => c.field).join('、');
      flag.conflicts = null;
      flag.rev += 1;
      this.log(flag.id, '冲突确认完成', `字段 ${fields} 已按人工选择合并`);
      this.persist('merge-resolve', flag.id, '确认双标签页冲突值');
    },

    // ---------- 失败重试清单 ----------
    // 重放落盘失败时留在清单里的状态片（按 rev 合并，幂等）
    replayPayloadInternal(item: RetryItem): boolean {
      let payload: { snapshots: Snapshot[]; audit: AuditRecord[]; flags: FeatureFlag[] };
      try { payload = JSON.parse(item.payload); } catch { return false; }
      for (const rs of payload.snapshots) {
        const local = this.snapshots.find((s) => s.id === rs.id);
        if (!local) this.snapshots.push(clone(rs));
        else if (rs.rev > local.rev) Object.assign(local, clone(rs));
      }
      for (const ra of payload.audit) {
        const local = this.audit.find((a) => a.id === ra.id);
        if (!local) this.audit.unshift(clone(ra));
        else if (ra.rev > local.rev) Object.assign(local, clone(ra));
      }
      for (const rf of payload.flags) {
        const local = this.flags.find((f) => f.id === rf.id);
        if (!local) this.flags.push(clone(rf));
        else if (rf.rev > local.rev) Object.assign(local, clone(rf));
      }
      return true;
    },

    retryItem(id: string): boolean {
      const item = this.queue.find((q) => q.id === id);
      if (!item) return true;
      item.attempts += 1;
      if (!this.replayPayloadInternal(item)) {
        item.lastError = '清单数据损坏，无法重放';
        saveQueue(this.queue);
        return false;
      }
      try {
        writeState(this.$state);
        this.queue = this.queue.filter((q) => q.id !== id);
        saveQueue(this.queue);
        this.log(item.flagId, '重试写盘成功', `「${item.summary}」已生效`);
        try { writeState(this.$state); } catch { /* 状态已落盘，仅成功日志丢失 */ }
        return true;
      } catch (error) {
        item.lastError = error instanceof Error ? error.message : String(error);
        saveQueue(this.queue);
        return false;
      }
    },

    retryAll(): number {
      let done = 0;
      for (const item of [...this.queue]) if (this.retryItem(item.id)) done += 1;
      return done;
    },

    discardFailure(id: string): void {
      this.queue = this.queue.filter((q) => q.id !== id);
      saveQueue(this.queue);
      this.persist('discard', this.activeId, '丢弃失败写盘项');
    }
  }
});
