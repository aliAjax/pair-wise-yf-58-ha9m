// 直接实例化 Pinia store 验证快照逻辑（mock localStorage / window）
import { createPinia, setActivePinia } from 'pinia';

// ---- mock 浏览器环境 ----
const memory = new Map();
global.localStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => { memory.set(k, String(v)); },
  removeItem: (k) => { memory.delete(k); }
};
global.window = { addEventListener: () => {} };
global.structuredClone = (v) => JSON.parse(JSON.stringify(v));

setActivePinia(createPinia());
const { useFlagStore } = await import('../src/stores/flags.ts');
const store = useFlagStore();

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

// ---- Test 1: 回填初始快照 ----
console.log('\n[1] 旧数据回填成初始快照 v1');
let state = JSON.parse(localStorage.getItem('yf58-flag-state'));
check('backfilled=true', state.backfilled === true);
const f1snaps = state.snapshots.filter((s) => s.flagId === 'f1');
const f2snaps = state.snapshots.filter((s) => s.flagId === 'f2');
check('f1 有 v1 草稿快照', f1snaps.length === 1 && f1snaps[0].version === 1 && f1snaps[0].status === 'draft');
check('f2 有 v1 生效快照', f2snaps.length === 1 && f2snaps[0].version === 1 && f2snaps[0].status === 'active');
check('f1.draftSnapshotId 指向 v1', state.flags.find((f) => f.id === 'f1').draftSnapshotId === f1snaps[0].id);
check('f2.activeSnapshotId 指向 v1', state.flags.find((f) => f.id === 'f2').activeSnapshotId === f2snaps[0].id);

// ---- Test 2: 改规则 -> 草稿作废重审 ----
console.log('\n[2] 规则改动后快照与审批作废重算');
store.updateRule({ region: '北京' });
state = JSON.parse(localStorage.getItem('yf58-flag-state'));
let f1 = state.flags.find((f) => f.id === 'f1');
let f1draft = state.snapshots.find((s) => s.id === f1.draftSnapshotId);
check('改规则后仍为草稿快照', f1draft && f1draft.status === 'draft');
check('草稿审批被清空', f1draft.approvals.length === 0);
check('f1 状态变 draft', f1.status === 'draft');
check('草稿规则已更新为北京', f1draft.rules.region === '北京');

// ---- Test 3: 审批 + 提交 ----
console.log('\n[3] 审批通过后提交生成带编号快照');
store.approve('产品负责人');
store.approve('研发负责人');
state = JSON.parse(localStorage.getItem('yf58-flag-state'));
f1 = state.flags.find((f) => f.id === 'f1');
check('双审批后状态 approved', f1.status === 'approved');
store.startRollout();
state = JSON.parse(localStorage.getItem('yf58-flag-state'));
f1 = state.flags.find((f) => f.id === 'f1');
const f1snapsAfter = state.snapshots.filter((s) => s.flagId === 'f1').sort((a, b) => a.version - b.version);
check('提交后 f1 rolling', f1.status === 'rolling' && f1.enabled === true);
check('f1 首次提交为 v1 生效', f1snapsAfter.length === 1 && f1snapsAfter[0].version === 1 && f1snapsAfter[0].status === 'active');
check('f1.activeSnapshotId 指向 v1', f1.activeSnapshotId === f1snapsAfter[0].id);
check('f1.draftSnapshotId 已清空', f1.draftSnapshotId === null);

// f2 已有 active v1，改动后提交应生成 v2
store.select('f2');
store.updateRule({ region: '广东' });
store.approve('产品负责人');
store.approve('研发负责人');
store.startRollout();
state = JSON.parse(localStorage.getItem('yf58-flag-state'));
const f2snapsAfter = state.snapshots.filter((s) => s.flagId === 'f2').sort((a, b) => a.version - b.version);
check('f2 改动后提交生成 v2', f2snapsAfter.length === 2 && f2snapsAfter[1].version === 2 && f2snapsAfter[1].status === 'active');
check('f2.v1 已作废', f2snapsAfter[0].status === 'superseded');
check('f2.activeSnapshotId 指向 v2', state.flags.find((f) => f.id === 'f2').activeSnapshotId === f2snapsAfter[1].id);
store.select('f1');

// ---- Test 4: 模拟引用快照 + 按编号复算一致 ----
console.log('\n[4] 模拟引用快照，按编号复算结果一致');
const user = { id: 'user-1042', region: '北京', appVersion: '8.3.0', authenticated: true };
const sim = store.simulateHit(user);
check('模拟返回快照版本 v1', sim.snapshotVersion === 1, `got ${sim.snapshotVersion}`);
const r1 = store.recomputeHit('f1', 1, user);
const r1again = store.recomputeHit('f1', 1, user);
check('按编号复算 v1 两次一致', r1.hit === r1again.hit && r1.reason === r1again.reason);
const r2 = store.recomputeHit('f1', 2, user);
check('v2 复算引用 v2', r2.snapshotVersion === 2);
check('复算结果可复现', r1.reason.includes('灰度桶'));

// ---- Test 5: 写盘失败 -> 重试清单 + 三态 ----
console.log('\n[5] 写盘失败留重试清单，重开分清三态');
store.toggleWriteFailure(true);
store.setRollout(50);
let retry = JSON.parse(localStorage.getItem('yf58-flag-retry') || '[]');
check('写盘失败后重试清单有记录', retry.length >= 1, `len=${retry.length}`);
check('重试清单项 failed', retry[0].status === 'failed');
// 模拟重开：重新 load（store 已实例化，手动触发 backfill 后的状态）
// 直接检查 state 中的三态
const activeSnaps = store.snapshots.filter((s) => s.status === 'active');
const draftSnaps = store.snapshots.filter((s) => s.status === 'draft');
check('生效桶非空', activeSnaps.length >= 1);
check('待审桶非空（有其他 flag 草稿）', draftSnaps.length >= 1);
check('失败桶 = 重试清单', store.retryQueue.length >= 1);
// 关闭故障并重试
store.toggleWriteFailure(false);
store.retryFailedWrites();
retry = JSON.parse(localStorage.getItem('yf58-flag-retry') || '[]');
check('重试后重试清单清空', retry.length === 0);
check('重试后 retryQueue 清空', store.retryQueue.length === 0);

// ---- Test 6: 字段级合并冲突 ----
console.log('\n[6] 双标签页并发修改按字段合并');
// 构造 base/local/remote 三向合并场景
const base = JSON.parse(localStorage.getItem('yf58-flag-state'));
// local: 改 f1 地区为上海
const local = JSON.parse(JSON.stringify(base));
local.flags.find((f) => f.id === 'f1').rules.region = '上海';
// remote: 改 f1 放量为 80（不同字段）
const remote = JSON.parse(JSON.stringify(base));
remote.flags.find((f) => f.id === 'f1').rollout = 80;
// 直接调用 mergeState（通过 store 的 persist 间接触发）
// 先把 remote 写入 localStorage，再让 local persist
localStorage.setItem('yf58-flag-state', JSON.stringify(remote));
// 手动设置 store 状态为 local，然后 persist 触发合并
store.$state = local;
// 由于 baseState 是 store 内部的，persist 会用它做三向合并
store.persist();
const merged = JSON.parse(localStorage.getItem('yf58-flag-state'));
const mergedF1 = merged.flags.find((f) => f.id === 'f1');
check('不同字段合并：地区取本地', mergedF1.rules.region === '上海', `got ${mergedF1.rules.region}`);
check('不同字段合并：放量取远程', mergedF1.rollout === 80, `got ${mergedF1.rollout}`);

// 两边改同一字段 -> 冲突
const base2 = JSON.parse(localStorage.getItem('yf58-flag-state'));
const local2 = JSON.parse(JSON.stringify(base2));
local2.flags.find((f) => f.id === 'f1').rules.region = '广东';
const remote2 = JSON.parse(JSON.stringify(base2));
remote2.flags.find((f) => f.id === 'f1').rules.region = '北京';
localStorage.setItem('yf58-flag-state', JSON.stringify(remote2));
store.$state = local2;
store.persist();
const afterConflict = JSON.parse(localStorage.getItem('yf58-flag-state'));
const pendingConflicts = afterConflict.conflicts.filter((c) => c.status === 'pending');
check('同字段两边改 -> 产生待确认冲突', pendingConflicts.length >= 1, `conflicts=${pendingConflicts.length}`);
check('冲突记录含本地/远程副本', pendingConflicts.some((c) => c.field === 'rules' && c.localValue && c.remoteValue));

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
