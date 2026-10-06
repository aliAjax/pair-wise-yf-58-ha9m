<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { message } from 'ant-design-vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { useFlagStore } from './stores/flags';
import { FIELD_LABELS, type SimUser } from './lib/snapshot';
import { armWriteFailures } from './services/persistence';

const store = useFlagStore();
const online = useOnline();
const createOpen = ref(false);

const active = computed(() => store.active);
const pending = computed(() => (active.value ? store.pendingSnapshot(active.value.id) : undefined));
const effective = computed(() => (active.value ? store.effectiveSnapshot(active.value.id) : undefined));
const history = computed(() => (active.value ? store.flagSnapshots(active.value.id) : []));

const user = reactive<SimUser>({ id: 'user-1042', region: '上海', appVersion: '8.3.0', authenticated: true });
const simSeq = ref<number | 'draft'>('draft');
const simulation = ref<{ hit: boolean; reason: string; bucket: number; seq: number | 'draft' } | null>(null);

const seqOptions = computed(() => [
  { value: 'draft' as const, label: '当前草稿（未提交）' },
  ...history.value.map((s) => ({ value: s.seq, label: `v${s.seq} · ${s.kind === 'control' ? '控制' : '配置'}${s.voided ? '（已作废）' : s.released ? '（生效中）' : '（待审）'}` }))
]);

function simulate(seq: number | 'draft' = simSeq.value) {
  simSeq.value = seq;
  simulation.value = store.simulate(user, seq);
}

function submit() {
  const result = store.submitSnapshot();
  if (!result.ok) { message.info('草稿相对当前快照没有改动，无需生成新快照'); return; }
  result.queued
    ? message.warning(`快照 v${result.seq} 已生成，但写盘失败，进入重试清单`)
    : message.success(`已生成带编号快照 v${result.seq}，模拟/放量/审计均引用它`);
}

function statusColor(status?: string) {
  if (status === 'rolling') return 'green';
  if (status === 'approved') return 'blue';
  if (status === 'scheduled') return 'purple';
  if (status === 'stopped' || status === 'rolled-back') return 'red';
  return 'gold';
}
const statusText: Record<string, string> = {
  draft: '草稿/待审', approved: '双审通过', rolling: '灰度中',
  scheduled: '定时待发', stopped: '已停止', 'rolled-back': '已回滚'
};

// ---------- 演示：两个标签页同时保存 ----------
function simulateRemoteAuto() {
  if (!active.value?.draft) return;
  const remote = JSON.parse(JSON.stringify(store.$state));
  remote.tabId = 'tab-remote-demo';
  const rf = remote.flags.find((f: { id: string }) => f.id === active.value!.id);
  rf.draft.scheduledAt = '2026-10-08T09:30';
  rf.rev += 1;
  store.mergeRemote(remote);
  message.info('已模拟另一标签页保存定时（本页未改同字段，自动并入）');
}
function simulateRemoteConflict() {
  const flag = active.value;
  if (!flag?.draft) return;
  const localVal: number = flag.draft.rollout >= 50 ? 10 : 50;
  const remoteVal: number = localVal === 80 ? 65 : 80;
  store.editField('rollout', localVal); // 本页先改
  const remote = JSON.parse(JSON.stringify(store.$state));
  remote.tabId = 'tab-remote-demo';
  const rf = remote.flags.find((f: { id: string }) => f.id === flag.id);
  rf.draft.rollout = remoteVal; // 他页改成另一个值
  rf.rev += 1;
  store.mergeRemote(remote);
  message.warning(`两页都改了放量（本页 ${localVal}% / 他页 ${remoteVal}%），已留两份待确认`);
}

// 真实的跨标签页广播：他页落盘后本页按字段合并
onMounted(() => {
  window.addEventListener('storage', (event) => {
    if (event.key !== 'yf58-snapshot-state-v2' || !event.newValue) return;
    try {
      const remote = JSON.parse(event.newValue).state;
      if (store.mergeRemote(remote)) message.info('检测到另一标签页的保存，已按字段合并');
    } catch { /* 忽略损坏的广播 */ }
  });
});

// ---------- 新建开关 ----------
const schema = toTypedSchema(z.object({ name: z.string().min(3), key: z.string().regex(/^[a-z0-9-]+$/, '仅支持小写字母、数字和连字符') }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [name] = defineField('name');
const [key] = defineField('key');
const create = handleSubmit((values) => {
  store.createFlag(values.name, values.key);
  message.success('已创建并生成 v1 初始快照');
  createOpen.value = false;
  resetForm();
});
</script>

<template>
  <a-config-provider><a-layout class="app-shell">
    <a-layout-header class="topbar">
      <div><div class="eyebrow">FEATURE FLAG / SNAPSHOT CONSOLE / PORT 62023</div><h1>{{ $t('title') }}</h1></div>
      <a-space wrap>
        <a-tag :color="online ? 'green' : 'orange'">{{ online ? '控制面在线' : '离线草稿' }}</a-tag>
        <a-button @click="simulateRemoteAuto">模拟他页保存(自动合并)</a-button>
        <a-button @click="simulateRemoteConflict">模拟两页同改(冲突)</a-button>
        <a-button danger ghost @click="armWriteFailures(1)">制造一次写盘失败</a-button>
        <a-button type="primary" @click="createOpen = true">新建功能开关</a-button>
      </a-space>
    </a-layout-header>

    <a-layout-content class="content">
      <a-alert v-if="!online" type="warning" show-icon message="离线状态" description="规则修改保留在浏览器；写盘失败会进入重试清单，恢复后可重放。" class="mb" />

      <!-- 写盘失败重试清单 -->
      <a-alert v-if="store.failedItems.length" class="mb" type="error" show-icon
        :message="`写盘失败重试清单（${store.failedItems.length} 项）——重开后这些改动尚未生效`">
        <template #description>
          <a-space direction="vertical" style="width:100%">
            <div v-for="item in store.failedItems" :key="item.id" class="fail-row">
              <a-space wrap>
                <b>{{ item.flagName }}</b>
                <a-tag>{{ item.kind }}</a-tag>
                <span>{{ item.summary }}</span>
                <span class="dim">{{ item.at }} · 已重试 {{ item.attempts }} 次 · {{ item.lastError }}</span>
                <a-button size="small" type="primary" @click="store.retryItem(item.id) && message.success('重试成功，改动已生效')">重试</a-button>
                <a-button size="small" danger ghost @click="store.discardFailure(item.id)">丢弃</a-button>
              </a-space>
            </div>
            <a-button size="small" @click="message.success(`已重试并生效 ${store.retryAll()} 项`)">全部重试</a-button>
          </a-space>
        </template>
      </a-alert>

      <a-row :gutter="[18,18]">
        <a-col :xs="24" :lg="7">
          <!-- 重开三分：生效 / 待审 / 失败 -->
          <a-card size="small" class="mb">
            <a-row :gutter="8">
              <a-col :span="8"><div class="bucket-num green">{{ store.liveFlags.length }}</div><div class="bucket-label">生效中</div></a-col>
              <a-col :span="8"><div class="bucket-num gold">{{ store.pendingFlags.length }}</div><div class="bucket-label">待审批</div></a-col>
              <a-col :span="8"><div class="bucket-num red">{{ store.failedItems.length }}</div><div class="bucket-label">写盘失败</div></a-col>
            </a-row>
            <div v-if="store.pendingFlags.length" class="mt">
              <div v-for="x in store.pendingFlags" :key="x.flag.id" class="pending-row" @click="store.select(x.flag.id)">
                {{ x.flag.name }} <a-tag color="purple">v{{ x.snap.seq }} 待审 {{ x.snap.approvals.length }}/2</a-tag>
              </div>
            </div>
          </a-card>

          <a-card title="功能开关" size="small">
            <a-list :data-source="store.flags" bordered>
              <template #renderItem="{ item }">
                <a-list-item :class="{ selected: item.id === store.activeId }" @click="store.select(item.id)">
                  <a-list-item-meta>
                    <template #title>
                      <a-space><span>{{ item.name }}</span><a-tag v-if="item.backfilled" color="default">v1 回填</a-tag><a-tag :color="statusColor(store.flagStatus(item.id))">{{ statusText[store.flagStatus(item.id)] }}</a-tag></a-space>
                    </template>
                    <template #description><code>{{ item.key }}</code></template>
                  </a-list-item-meta>
                </a-list-item>
              </template>
            </a-list>
          </a-card>

          <a-card title="规则命中模拟（按编号复算）" size="small" class="mt">
            <a-form layout="vertical">
              <a-form-item label="用户 ID"><a-input v-model:value="user.id" /></a-form-item>
              <a-row :gutter="8">
                <a-col :span="12"><a-form-item label="地区"><a-input v-model:value="user.region" /></a-form-item></a-col>
                <a-col :span="12"><a-form-item label="版本"><a-input v-model:value="user.appVersion" /></a-form-item></a-col>
              </a-row>
              <a-checkbox v-model:checked="user.authenticated">已登录</a-checkbox>
              <a-form-item label="引用快照编号" class="mt">
                <a-select v-model:value="simSeq" :options="seqOptions" />
              </a-form-item>
              <a-button type="primary" block @click="simulate()">{{ $t('simulate') }}</a-button>
            </a-form>
            <a-alert v-if="simulation" class="mt" :type="simulation.hit ? 'success' : 'info'" show-icon
              :message="`${simulation.seq === 'draft' ? '草稿' : 'v' + simulation.seq}：${simulation.hit ? '命中新功能' : '未命中'}`"
              :description="`${simulation.reason}（同一用户同一编号结果可复算）`" />
          </a-card>
        </a-col>

        <a-col :xs="24" :lg="17">
          <template v-if="active && active.draft">
            <a-card :title="active.name" class="mb">
              <template #extra>
                <a-space wrap>
                  <a-tag :color="statusColor(store.flagStatus(active.id))">{{ statusText[store.flagStatus(active.id)] }}</a-tag>
                  <a-button danger :disabled="!effective || effective.status !== 'rolling'" @click="store.emergencyStop">紧急停止</a-button>
                  <a-button danger ghost :disabled="!effective" @click="store.rollback">回滚</a-button>
                </a-space>
              </template>

              <a-descriptions bordered :column="{ xs: 1, md: 3 }">
                <a-descriptions-item label="开关 Key"><code>{{ active.key }}</code></a-descriptions-item>
                <a-descriptions-item label="生效快照">{{ effective ? `v${effective.seq}（${effective.rollout}%）` : '无' }}</a-descriptions-item>
                <a-descriptions-item label="待审快照">{{ pending ? `v${pending.seq} · ${pending.approvals.join('、') || '待审批'}` : '无（改动后需提交）' }}</a-descriptions-item>
              </a-descriptions>

              <!-- 双标签页字段冲突 -->
              <template v-if="active.conflicts?.length">
                <a-divider>两个标签页同时保存：留两份待确认</a-divider>
                <a-alert type="warning" show-icon :message="`${active.conflicts.length} 个字段两边都改过，请逐字段保留一份`" class="mb" />
                <div v-for="c in active.conflicts" :key="c.field" class="conflict-row">
                  <b>{{ FIELD_LABELS[c.field] }}</b>
                  <span class="dim">基线：{{ String(c.base) }}</span>
                  <a-radio-group :value="c.resolution" @change="(e: { target: { value: 'local' | 'remote' } }) => store.resolveConflict(c.field, e.target.value)">
                    <a-radio value="local">本页：{{ String(c.local) }}</a-radio>
                    <a-radio value="remote">他页：{{ String(c.remote) }}</a-radio>
                  </a-radio-group>
                </div>
                <a-button type="primary" class="mt" :disabled="active.conflicts.some((c) => !c.resolution)" @click="store.applyConflictResolutions()">确认合并所选值</a-button>
              </template>

              <a-divider>规则组合（改动即作废待审快照与审批）</a-divider>
              <a-form layout="vertical">
                <a-row :gutter="16">
                  <a-col :span="6"><a-form-item label="开关启用"><a-switch :checked="active.draft.enabled" @change="(v: boolean) => store.editField('enabled', v)" /></a-form-item></a-col>
                  <a-col :span="6"><a-form-item label="目标地区"><a-select :value="active.draft.rules.region" :options="['全部','上海','北京','广东'].map(v => ({ value: v, label: v }))" @change="(v: string) => store.editField('region', v)" /></a-form-item></a-col>
                  <a-col :span="6"><a-form-item label="客户端版本"><a-input :value="active.draft.rules.appVersion" @change="(e: Event) => store.editField('appVersion', (e.target as HTMLInputElement).value)" /></a-form-item></a-col>
                  <a-col :span="6"><a-form-item label="登录要求"><a-switch :checked="active.draft.rules.authenticated" @change="(v: boolean) => store.editField('authenticated', v)" /></a-form-item></a-col>
                </a-row>
              </a-form>

              <a-divider>逐步放量</a-divider>
              <a-slider :value="active.draft.rollout" :min="0" :max="100" :step="5"
                :tip-formatter="(v?: number) => `${v}%`"
                @change="(v: number) => store.adjustRollout(v)" />
              <div class="rollout-label">{{ active.draft.rollout }}% 用户可命中
                <span v-if="effective?.status === 'rolling'" class="dim">（灰度中调整将生成控制类编号快照；其他状态改动会作废待审快照）</span>
              </div>

              <a-divider>定时生效（改动后快照与审批一起作废重算）</a-divider>
              <a-input type="datetime-local" style="max-width:260px" :value="active.draft.scheduledAt"
                @change="(e: Event) => store.editField('scheduledAt', (e.target as HTMLInputElement).value)" />

              <a-divider>提交快照与审批</a-divider>
              <a-space wrap>
                <a-button type="primary" @click="submit">提交并生成带编号快照</a-button>
                <a-button :disabled="!pending || pending.approvals.includes('产品负责人')" @click="store.approve('产品负责人')">产品审批 v{{ pending?.seq }}</a-button>
                <a-button :disabled="!pending || pending.approvals.includes('研发负责人')" @click="store.approve('研发负责人')">研发审批 v{{ pending?.seq }}</a-button>
                <a-button type="primary" ghost :disabled="!pending || pending.status !== 'approved'" @click="store.startRollout">按 v{{ pending?.seq }} 开始灰度</a-button>
              </a-space>
            </a-card>

            <a-card title="发布快照编号链（模拟 / 放量 / 审计都引用这些编号）" size="small" class="mb">
              <a-timeline>
                <a-timeline-item v-for="s in [...history].reverse()" :key="s.id" :color="s.voided ? 'gray' : s.released ? 'green' : 'blue'">
                  <a-space wrap>
                    <b>v{{ s.seq }}</b>
                    <a-tag>{{ s.kind === 'control' ? '控制' : '配置' }}</a-tag>
                    <a-tag :color="s.voided ? 'default' : statusColor(s.status)">{{ s.voided ? `已作废：${s.voidReason}` : statusText[s.status] }}</a-tag>
                    <span class="dim">{{ s.at }} · {{ s.author }} · {{ s.summary }}</span>
                    <a-button size="small" @click="simulate(s.seq)">按 v{{ s.seq }} 复算此人</a-button>
                  </a-space>
                  <div class="dim">放量 {{ s.rollout }}% · 地区 {{ s.rules.region }} · 版本 {{ s.rules.appVersion }} · 登录 {{ s.rules.authenticated ? '要求' : '不限' }} · 审批 {{ s.approvals.join('、') || '无' }}</div>
                </a-timeline-item>
              </a-timeline>
            </a-card>

            <a-card title="审计记录（引用快照编号；作废记录划掉）" size="small">
              <a-timeline>
                <a-timeline-item v-for="item in store.audit" :key="item.id"
                  :color="item.voided ? 'gray' : item.action.includes('停止') || item.action.includes('失败') ? 'red' : item.action.includes('回滚') ? 'orange' : 'blue'">
                  <span :class="{ voided: item.voided }">
                    <b>{{ item.at }} · {{ item.actor }}</b>
                    <p>{{ item.action }}：{{ item.detail }}
                      <a-tag v-if="item.snapSeq" color="purple">引用 v{{ item.snapSeq }}</a-tag>
                      <a-tag v-if="item.backfilled" color="default">旧数据回填</a-tag>
                      <a-button v-if="item.snapSeq" size="small" type="link" @click="simulate(item.snapSeq!)">按编号复算</a-button>
                    </p>
                  </span>
                </a-timeline-item>
              </a-timeline>
            </a-card>
          </template>
        </a-col>
      </a-row>
    </a-layout-content>

    <a-modal v-model:open="createOpen" title="新建功能开关" @ok="create">
      <a-form layout="vertical">
        <a-form-item label="展示名称" :validate-status="errors.name ? 'error' : ''" :help="errors.name"><a-input v-model:value="name" /></a-form-item>
        <a-form-item label="开关 Key" :validate-status="errors.key ? 'error' : ''" :help="errors.key"><a-input v-model:value="key" /></a-form-item>
      </a-form>
    </a-modal>
  </a-layout></a-config-provider>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; background: #f4f6fb; font-family: Inter, "PingFang SC", sans-serif; }
.app-shell { min-height: 100vh; background: transparent; }
.topbar { height: auto; min-height: 88px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 16px 32px; color: white; background: linear-gradient(120deg, #111827, #312e81); }
.topbar h1 { color: white; margin: 3px 0; font-size: 25px; }
.eyebrow { color: #a5b4fc; font-size: 11px; letter-spacing: .13em; }
.content { max-width: 1400px; width: 100%; margin: 0 auto; padding: 24px; }
.mb { margin-bottom: 18px; }.mt { margin-top: 14px; }
.selected { background: #eef2ff; cursor: pointer; }.ant-list-item { cursor: pointer; }
.rollout-label { color: #4338ca; font-weight: 700; }
.dim { color: #8c8c8c; font-size: 12px; }
.voided { text-decoration: line-through; color: #a0a0a0; }
.bucket-num { font-size: 28px; font-weight: 800; text-align: center; }
.bucket-num.green { color: #16a34a; } .bucket-num.gold { color: #d48806; } .bucket-num.red { color: #dc2626; }
.bucket-label { text-align: center; color: #555; font-size: 13px; }
.pending-row { padding: 4px 0; border-bottom: 1px dashed #e5e7eb; cursor: pointer; }
.fail-row { background: #fff2f0; padding: 6px 8px; border-radius: 6px; }
.conflict-row { display: flex; align-items: center; gap: 14px; padding: 8px 0; border-bottom: 1px dashed #e5e7eb; flex-wrap: wrap; }
@media (max-width: 720px) { .topbar { padding: 18px; flex-direction: column; align-items: flex-start; }.content { padding: 16px; } }
</style>
