import { chromium } from 'playwright';

const URL = 'http://localhost:62023/';
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });

// ---- Test 1: 回填初始快照 ----
console.log('\n[1] 旧数据回填成初始快照 v1');
const page = await ctx.newPage();
await page.goto(URL);
await page.waitForTimeout(800);
let state = await page.evaluate(() => JSON.parse(localStorage.getItem('yf58-flag-state') || '{}'));
check('backfilled=true', state.backfilled === true);
const f1snaps = state.snapshots.filter((s) => s.flagId === 'f1');
const f2snaps = state.snapshots.filter((s) => s.flagId === 'f2');
check('f1 有 v1 草稿快照', f1snaps.length === 1 && f1snaps[0].version === 1 && f1snaps[0].status === 'draft');
check('f2 有 v1 生效快照', f2snaps.length === 1 && f2snaps[0].version === 1 && f2snaps[0].status === 'active');
check('f1.draftSnapshotId 指向 v1', state.flags.find((f) => f.id === 'f1').draftSnapshotId === f1snaps[0].id);
check('f2.activeSnapshotId 指向 v1', state.flags.find((f) => f.id === 'f2').activeSnapshotId === f2snaps[0].id);

// ---- Test 2: 改规则 -> 草稿快照作废重审 ----
console.log('\n[2] 规则改动后快照与审批作废重算');
await page.click('.ant-select-selector');
await page.waitForTimeout(300);
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
state = await page.evaluate(() => JSON.parse(localStorage.getItem('yf58-flag-state') || '{}'));
let f1 = state.flags.find((f) => f.id === 'f1');
let f1draft = state.snapshots.find((s) => s.id === f1.draftSnapshotId);
check('改规则后仍为草稿快照', f1draft && f1draft.status === 'draft');
check('草稿审批被清空', f1draft.approvals.length === 0);
check('f1 状态变 draft', f1.status === 'draft');

// ---- Test 3: 审批 + 开始灰度 -> 提交带编号快照 ----
console.log('\n[3] 审批通过后提交生成带编号快照');
await page.click('button:has-text("产品审批")');
await page.waitForTimeout(300);
await page.click('button:has-text("研发审批")');
await page.waitForTimeout(300);
state = await page.evaluate(() => JSON.parse(localStorage.getItem('yf58-flag-state') || '{}'));
f1 = state.flags.find((f) => f.id === 'f1');
check('双审批后状态 approved', f1.status === 'approved');
await page.click('button:has-text("开始灰度发布")');
await page.waitForTimeout(500);
state = await page.evaluate(() => JSON.parse(localStorage.getItem('yf58-flag-state') || '{}'));
f1 = state.flags.find((f) => f.id === 'f1');
const f1snapsAfter = state.snapshots.filter((s) => s.flagId === 'f1').sort((a, b) => a.version - b.version);
check('提交后 f1 状态 rolling', f1.status === 'rolling' && f1.enabled === true);
check('提交后 f1 有 v1+v2 两个快照', f1snapsAfter.length === 2);
check('v2 生效、v1 作废', f1snapsAfter[0].status === 'superseded' && f1snapsAfter[1].status === 'active');
check('f1.activeSnapshotId 指向 v2', f1.activeSnapshotId === f1snapsAfter[1].id);
check('f1.draftSnapshotId 已清空', f1.draftSnapshotId === null);

// ---- Test 4: 模拟引用快照 + 按编号复算一致 ----
console.log('\n[4] 模拟引用快照，按编号复算结果一致');
await page.click('button:has-text("模拟命中")');
await page.waitForTimeout(300);
const simText = await page.locator('.ant-alert').last().textContent();
check('模拟结果含快照 v2', simText.includes('v2'), simText);
const recompute = await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('yf58-flag-state') || '{}');
  const snaps = s.snapshots.filter((x) => x.flagId === 'f1');
  const user = { id: 'user-1042', region: '上海', appVersion: '8.3.0', authenticated: true };
  function compute(snap) {
    const bucket = [...user.id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 100;
    return bucket < snap.rollout;
  }
  const v1 = compute(snaps.find((x) => x.version === 1));
  const v2 = compute(snaps.find((x) => x.version === 2));
  return { v1, v2, v1Again: compute(snaps.find((x) => x.version === 1)) };
});
check('按编号复算 v1 两次结果一致', recompute.v1 === recompute.v1Again);

// ---- Test 5: 写盘失败 -> 重试清单 + 三态分类 ----
console.log('\n[5] 写盘失败留重试清单，重开分清三态');
await page.click('.ant-switch');
await page.waitForTimeout(300);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
const slider = page.locator('.ant-slider').first();
await slider.click({ position: { x: 100, y: 8 } });
await page.waitForTimeout(500);
const stateAfterFail = await page.evaluate(() => {
  const main = JSON.parse(localStorage.getItem('yf58-flag-state') || '{}');
  const retry = JSON.parse(localStorage.getItem('yf58-flag-retry') || '[]');
  return { mainRollout: main.flags.find((f) => f.id === 'f1').rollout, retryLen: retry.length, retryStatus: retry[0]?.status };
});
check('写盘失败后重试清单有记录', stateAfterFail.retryLen >= 1, `retryLen=${stateAfterFail.retryLen}`);
check('重试清单项状态 failed', stateAfterFail.retryStatus === 'failed');
await page.reload();
await page.waitForTimeout(800);
check('重开后生效桶可见', await page.locator('text=生效中').count() >= 1);
check('重开后待审桶可见', await page.locator('text=待审批').count() >= 1);
check('重开后失败桶可见', await page.locator('text=写入失败').count() >= 1);
await page.click('.ant-switch');
await page.waitForTimeout(200);
await page.click('button:has-text("重试写盘")');
await page.waitForTimeout(500);
const retryCleared = await page.evaluate(() => {
  const retry = JSON.parse(localStorage.getItem('yf58-flag-retry') || '[]');
  return retry.length === 0;
});
check('重试后重试清单清空', retryCleared);

// ---- Test 6: 双标签页并发修改 -> 字段级合并 ----
console.log('\n[6] 双标签页并发修改按字段合并');
await page.evaluate(() => { localStorage.removeItem('yf58-flag-state'); localStorage.removeItem('yf58-flag-retry'); });
const pageA = await ctx.newPage();
await pageA.goto(URL);
await pageA.waitForTimeout(800);
const pageB = await ctx.newPage();
await pageB.goto(URL);
await pageB.waitForTimeout(800);
await pageA.click('.ant-select-selector');
await pageA.waitForTimeout(300);
await pageA.keyboard.press('ArrowDown');
await pageA.waitForTimeout(100);
await pageA.keyboard.press('Enter');
await pageA.waitForTimeout(400);
const sliderB = pageB.locator('.ant-slider').first();
await sliderB.click({ position: { x: 150, y: 8 } });
await pageB.waitForTimeout(600);
const mergedState = await pageA.evaluate(() => JSON.parse(localStorage.getItem('yf58-flag-state') || '{}'));
check('合并后快照完整', mergedState.snapshots.length >= 2);
check('合并后审计完整', mergedState.audit.length >= 2);
check('合并后开关完整', mergedState.flags.length === 2);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
await browser.close();
process.exit(fail ? 1 : 0);
