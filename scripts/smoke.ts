// 端到端冒烟：回填 → 提交编号快照 → 模拟复算 → 作废重算 → 双页合并 → 写盘失败/重试
import { createPinia, setActivePinia } from 'pinia';
import { useFlagStore } from '../src/stores/flags';
import { armWriteFailures, clearStorage } from '../src/services/persistence';

let mem = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, v); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => { mem = new Map(); },
  key: () => null,
  length: 0
} as Storage;

function assert(cond: unknown, msg: string) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exit(1); }
  console.log('✅', msg);
}

function freshStore() {
  clearStorage();
  setActivePinia(createPinia());
  const s = useFlagStore();
  s.select('f1');
  return s;
}

let store = freshStore();

// 1. 回填
assert(store.flagSnapshots('f1').length === 1 && store.flagSnapshots('f1')[0].seq === 1, '旧开关 f1 回填为 v1 初始快照');
assert(store.flags.find(f => f.id === 'f2')!.backfilled === true, 'f2 标记为回填数据');
assert(store.effectiveSnapshot('f2')!.seq === 1 && store.effectiveSnapshot('f2')!.status === 'rolling', 'f2 回填后即为生效快照');
assert(store.audit.some(a => a.action === '接入发布快照'), '回填动作写入审计');

// 2. 无改动提交不产生新版本
assert(store.submitSnapshot().ok === false, '无改动时提交不产生新编号');

// 3. 规则改动 → 提交 v2
store.editField('rollout', 40);
assert(store.flagSnapshots('f1').find(s => s.seq === 1)!.voided === true, '改动后旧 v1 快照作废');
assert(store.audit.some(a => a.action === '快照作废重算'), '作废动作写入审计');
const r = store.submitSnapshot();
assert(r.ok && r.seq === 2, '提交生成带编号快照 v2');

// 4. 同一人按编号复算结果稳定
const u = { id: 'user-1042', region: '上海', appVersion: '8.3.0', authenticated: true };
const a = store.simulate(u, 2);
const b = store.simulate(u, 2);
assert(a.hit === b.hit && a.bucket === b.bucket, '同一人在 v2 上复算结果一致');
const v1 = store.simulate(u, 1);
assert(v1.reason.includes('未启用'), '已作废 v1 仍可按编号复算（当时未启用）');

// 5. 审批后发布，审计引用 v2
store.approve('产品负责人');
store.approve('研发负责人');
assert(store.pendingSnapshot('f1')!.status === 'approved', '双审批通过');
store.startRollout();
assert(store.effectiveSnapshot('f1')!.seq === 2, '放量引用 v2');
assert(store.audit.some(x => x.snapSeq === 2), '审计记录引用编号 v2');
const live = store.simulate(u, 2);
assert(live.hit === (live.bucket < 40), '命中结果 = 桶 < 放量');

// 6. 灰度中调整放量 → 控制快照 v3
store.adjustRollout(80);
const sns = store.flagSnapshots('f1');
assert(sns[sns.length - 1].kind === 'control' && sns[sns.length - 1].seq === 3, '放量调整生成控制快照 v3');
assert(store.effectiveSnapshot('f1')!.rollout === 80, '生效放量为 80%');

// 7. 规则再改 → 待审快照 v4，部分审批后定时再改 → v4 与其上审批一起作废重算为 v5
store.editField('region', '北京');
store.submitSnapshot();
const v4 = store.flagSnapshots('f1').find(s => s.seq === 4)!;
assert(v4 && !v4.released && !v4.voided, '规则改动提交 v4 待审');
assert(store.audit.some(x => x.snapSeq === 2), '已发布 v2 的审批记录作为历史保留');
store.approve('产品负责人'); // v4 拿到一方审批
assert(store.audit.some(x => x.snapSeq === 4 && x.action === '审批发布' && !x.voided), 'v4 审批记录正常存在');
store.editField('scheduledAt', '2026-10-09T08:00'); // 定时改动
assert(store.flagSnapshots('f1').find(s => s.seq === 4)!.voided, '定时改动后 v4 作废重算');
assert(store.audit.filter(x => x.snapSeq === 4 && x.action === '审批发布').every(x => x.voided), 'v4 上的审批记录随快照一起作废');
assert(store.submitSnapshot().seq === 5, '重算后提交 v5');

// 8. 两个标签页字段合并：只一边改 → 自动并入
store = freshStore();
store.editField('appVersion', '>= 9.0'); // 本页只改版本
const remoteState = JSON.parse(JSON.stringify(store.$state));
const rf = remoteState.flags.find((f: any) => f.id === 'f1');
rf.draft.rules.appVersion = '>= 8.2';  // 远端版本保持基线
rf.draft.rules.authenticated = false;  // 远端只改登录要求
rf.rev += 1;
remoteState.tabId = 'tab-other';
const changed = store.mergeRemote(remoteState);
assert(changed === true, '检测到他页保存并合并');
assert(store.active!.draft!.rules.appVersion === '>= 9.0', '保留本页改动的版本字段');
assert(store.active!.draft!.rules.authenticated === false, '自动并入他页改动的登录字段');
assert(store.active!.conflicts === null, '不同字段无冲突');

// 9. 两边都改同字段 → 留两份待确认
store.editField('rollout', 50);
const remoteState2 = JSON.parse(JSON.stringify(store.$state));
const rf2 = remoteState2.flags.find((f: any) => f.id === 'f1');
rf2.draft.rollout = 80;
rf2.rev += 1;
remoteState2.tabId = 'tab-other-2';
store.mergeRemote(remoteState2);
const c = store.active!.conflicts!;
assert(c.length === 1 && c[0].field === 'rollout', '同字段两边都改 → 一份冲突待确认');
assert(c[0].local === 50 && c[0].remote === 80, '保留本地/远端两份值');
store.applyConflictResolutions();
assert(store.active!.draft!.rollout === 50, '未全部确认前保持本页草稿值');
assert(store.active!.conflicts!.length === 1, '未全部确认前冲突仍保留');
store.resolveConflict('rollout', 'remote');
store.applyConflictResolutions();
assert(store.active!.draft!.rollout === 80, '确认后采用他页 80%');
assert(store.active!.conflicts === null, '冲突清空');

// 10. 写盘失败 → 重试清单
const q0 = store.failedItems.length;
armWriteFailures(1);
store.editField('region', '北京');
assert(store.failedItems.length === q0 + 1, '写盘失败留下重试清单项');
assert(store.failedItems[0].lastError.includes('写盘失败'), '清单记录失败原因');

// 11. 重开：重新加载 store，生效/待审/失败三项可分清
setActivePinia(createPinia());
const reopened = useFlagStore();
assert(reopened.liveFlags.some(f => f.id === 'f2'), '重开后可列出"生效"项');
assert(Array.isArray(reopened.pendingFlags), '重开后可列出"待审"项');
assert(reopened.failedItems.length === 1, '重开后可列出"失败"重试项');
assert(reopened.flags.find(f => f.id === reopened.failedItems[0].flagId)!.draft!.rules.region === '上海',
  '重开后内存视图停留在上次落盘状态（上海）');
const retried = reopened.retryItem(reopened.failedItems[0].id);
assert(retried && reopened.failedItems.length === 0, '重试成功后清单项消除');
setActivePinia(createPinia());
const reopened2 = useFlagStore();
assert(reopened2.flags.find(f => f.id === 'f1')!.draft!.rules.region === '北京', '重试后待写改动真正落盘');

console.log('\n全部冒烟断言通过 🎉');
