// 发布快照领域模型：带编号的快照、规则求值、复算、三方字段合并

export type FlagStatus = 'draft' | 'approved' | 'rolling' | 'scheduled' | 'stopped' | 'rolled-back';
export type SnapshotKind = 'config' | 'control';

export interface RuleSet {
  region: string;
  appVersion: string;
  authenticated: boolean;
}

export interface SimUser {
  id: string;
  region: string;
  appVersion: string;
  authenticated: boolean;
}

export interface EvaluateResult {
  hit: boolean;
  reason: string;
  bucket: number;
}

export interface Snapshot {
  id: string;
  flagId: string;
  seq: number;
  kind: SnapshotKind;
  at: string;
  author: string;
  summary: string;
  enabled: boolean;
  rollout: number;
  rules: RuleSet;
  scheduledAt: string;
  approvals: string[];
  status: FlagStatus;
  released: boolean;
  voided: boolean;
  voidReason?: string;
  supersededBy?: string;
  rev: number;
}

export interface AuditRecord {
  id: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
  snapSeq?: number;
  voided?: boolean;
  backfilled?: boolean;
  flagId?: string;
  rev: number;
}

export interface FeatureFlag {
  id: string;
  name: string;
  key: string;
  createdAt: string;
  backfilled?: boolean;
  baseRev: string; // 当前草稿基线快照 id（三方合并的 base）
  draft: DraftFields | null;
  conflicts: MergeConflict[] | null;
  rev: number;
}

export type FieldKey = 'name' | 'enabled' | 'rollout' | 'region' | 'appVersion' | 'authenticated' | 'scheduledAt';

export interface DraftFields {
  name: string;
  enabled: boolean;
  rollout: number;
  rules: RuleSet;
  scheduledAt: string;
}

export type FieldValue = string | number | boolean;

export interface MergeConflict {
  field: FieldKey;
  base: FieldValue;
  local: FieldValue;
  remote: FieldValue;
  resolution: 'local' | 'remote' | null;
}

export const DRAFT_FIELDS: FieldKey[] = ['enabled', 'rollout', 'region', 'appVersion', 'authenticated', 'scheduledAt'];

export function getDraftField(draft: DraftFields, field: FieldKey): FieldValue {
  switch (field) {
    case 'enabled': return draft.enabled;
    case 'rollout': return draft.rollout;
    case 'region': return draft.rules.region;
    case 'appVersion': return draft.rules.appVersion;
    case 'authenticated': return draft.rules.authenticated;
    case 'scheduledAt': return draft.scheduledAt;
    case 'name': return draft.name;
  }
}

export function setDraftField(draft: DraftFields, field: FieldKey, value: FieldValue): void {
  switch (field) {
    case 'enabled': draft.enabled = Boolean(value); break;
    case 'rollout': draft.rollout = Number(value); break;
    case 'region': draft.rules.region = String(value); break;
    case 'appVersion': draft.rules.appVersion = String(value); break;
    case 'authenticated': draft.rules.authenticated = Boolean(value); break;
    case 'scheduledAt': draft.scheduledAt = String(value); break;
    case 'name': draft.name = String(value); break;
  }
}

export function snapshotToDraft(s: Snapshot): DraftFields {
  return {
    name: '',
    enabled: s.enabled,
    rollout: s.rollout,
    rules: { ...s.rules },
    scheduledAt: s.scheduledAt
  };
}

// 稳定灰度桶：同一用户在任何编号的快照下复算结果一致（取 seed 保证幂等）
export function grayBucket(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return hash % 100;
}

function parseSemver(v: string): number[] {
  return v.trim().split(/[._-]/)[0].split('.').map((part) => Number.parseInt(part, 10) || 0).concat([0, 0, 0]).slice(0, 3);
}

function cmpSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

// 支持 >= 8.2、>、=、<=、<、区间外回退到精确匹配
export function matchAppVersion(required: string, actual: string): boolean {
  const m = /^\s*(>=|<=|>|<|=)?\s*([0-9].*)$/.exec(required);
  if (!m) return required.trim() === actual.trim();
  const [, op = '=', target] = m;
  const cmp = cmpSemver(actual, target);
  if (op === '>=') return cmp >= 0;
  if (op === '<=') return cmp <= 0;
  if (op === '>') return cmp > 0;
  if (op === '<') return cmp < 0;
  return cmp === 0;
}

// 按快照复算同一个人的命中结果
export function evaluate(snapshot: Pick<Snapshot, 'enabled' | 'rollout' | 'rules'>, user: SimUser): EvaluateResult {
  const bucket = grayBucket(user.id);
  if (!snapshot.enabled) return { hit: false, reason: '快照中开关未启用', bucket };
  const rule = snapshot.rules;
  if (rule.region !== '全部' && rule.region !== user.region) return { hit: false, reason: `地区不匹配（要求${rule.region}）`, bucket };
  if (rule.authenticated && !user.authenticated) return { hit: false, reason: '要求已登录用户', bucket };
  if (!matchAppVersion(rule.appVersion, user.appVersion)) return { hit: false, reason: `版本不满足 ${rule.appVersion}（当前 ${user.appVersion}）`, bucket };
  const hit = bucket < snapshot.rollout;
  return { hit, reason: hit ? `灰度桶 ${bucket} < 放量 ${snapshot.rollout}%` : `灰度桶 ${bucket} ≥ 放量 ${snapshot.rollout}%`, bucket };
}

// 三方字段合并：只有一边改 → 取改动；两边都改同字段 → 留两份待确认
export function threeWayMerge(
  base: DraftFields,
  local: DraftFields,
  remote: DraftFields,
  fields: FieldKey[] = DRAFT_FIELDS
): { merged: DraftFields; conflicts: MergeConflict[]; autoChanged: FieldKey[] } {
  const merged: DraftFields = {
    name: local.name,
    enabled: local.enabled,
    rollout: local.rollout,
    rules: { ...local.rules },
    scheduledAt: local.scheduledAt
  };
  const conflicts: MergeConflict[] = [];
  const autoChanged: FieldKey[] = [];
  for (const field of fields) {
    const b = getDraftField(base, field);
    const l = getDraftField(local, field);
    const r = getDraftField(remote, field);
    const localChanged = l !== b;
    const remoteChanged = r !== b;
    if (!localChanged && remoteChanged) {
      setDraftField(merged, field, r);
      autoChanged.push(field);
    } else if (localChanged && remoteChanged && l !== r) {
      conflicts.push({ field, base: b, local: l, remote: r, resolution: null });
    }
  }
  return { merged, conflicts, autoChanged };
}

export const FIELD_LABELS: Record<FieldKey, string> = {
  name: '名称',
  enabled: '启用状态',
  rollout: '放量比例',
  region: '目标地区',
  appVersion: '客户端版本',
  authenticated: '登录要求',
  scheduledAt: '定时生效'
};

export function nowLabel(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}
