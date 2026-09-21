import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createOpenVikingExtension, MemoryDelivery, type MemoryExtensionOptions } from './host.js';
import { createIsolatedToolsExtension, type IsolatedToolExecutor } from './worker-tools.js';

const statusLabels: Record<string, string> = {
  queued: '等待处理', session_unknown: '正在核对', session_created: '处理中',
  message_unknown: '正在核对', message_delivered: '处理中', commit_unknown: '正在核对',
  processing: '处理中', ready: '已保存', failed: '保存失败', blocked: '需要处理', blocked_by_pause: '已被暂停阻止',
};

let launcherBinding: { options: MemoryExtensionOptions; worker: IsolatedToolExecutor } | undefined;

/** Only the trusted CLI bootstrap installs this binding, before pi loads extensions. */
export function bindStandardHost(options: MemoryExtensionOptions, worker: IsolatedToolExecutor): void {
  if (launcherBinding) throw new Error('DUPLICATE_STANDARD_MEMORY_HOST');
  if (!worker) throw new Error('MISSING_MEMORY_WORKER');
  launcherBinding = { options, worker };
}

export default async function openViking(pi: ExtensionAPI): Promise<void> {
  if (!launcherBinding) {
    pi.on('session_start', (_event, ctx) => {
      ctx.ui.notify('长期记忆未启用：请通过受保护的 pi-openviking 启动入口运行。', 'info');
    });
    return;
  }
  const { options, worker } = launcherBinding;
  // The memory gate verifies the very same worker that receives native tools.
  await createIsolatedToolsExtension(worker)(pi);
  await createOpenVikingExtension({ ...options, assertToolIsolation: () => worker.assertIsolated() })(pi);
  const delivery = new MemoryDelivery({ store: options.stateStore, transport: options.client, maxPayloadBytes: options.policy.maxPayloadBytes });
  pi.registerCommand('memory', {
    description: '长期记忆：enable、pause、auto-enable、auto-disable、status、show。启用和自动采集分别授权。',
    async handler(args, ctx) {
      try {
        const action = args.trim();
        if (action === 'enable') {
          await worker.assertIsolated();
          if (!ctx.hasUI) { ctx.ui.notify('请在交互模式中确认启用长期记忆。', 'warning'); return; }
          const accepted = await ctx.ui.confirm('启用长期记忆',
            '明确保存的事实将发送到已配置的记忆服务，并可在新聊天中召回。启用不会新增自动采集授权；已有独立授权时，恢复后仅采集新请求。启用前的保存请求需重新确认。');
          if (!accepted) return;
          const state = await options.stateStore.read();
          if (!state.authorization.enabled) {
            const signal = AbortSignal.timeout(options.collection?.lifecycleTimeoutMs ?? options.policy.recallTimeoutMs);
            if (options.collection) await options.collection.sessions.register(ctx.sessionManager, signal);
            await delivery.enable(state.authorization.policyVersion, await options.collection?.sessions.boundaries(signal) ?? []);
          }
          const enabled = await options.stateStore.read();
          ctx.ui.notify(`长期记忆已启用；自动采集${enabled.authorization.automaticCollection ? '沿用独立授权，仅采集恢复后的新请求' : '未授权'}。请重新发起需要保存的事实。`, 'info');
        } else if (action === 'auto-enable') {
          if (!options.collection) { ctx.ui.notify('宿主尚未配置自动采集。', 'warning'); return; }
          await worker.assertIsolated();
          if (!ctx.hasUI) { ctx.ui.notify('请在交互模式中单独确认自动采集授权。', 'warning'); return; }
          const state = await options.stateStore.read();
          if (!state.authorization.enabled) { ctx.ui.notify('请先启用长期记忆，再单独授权自动采集。', 'warning'); return; }
          const accepted = await ctx.ui.confirm('单独授权自动采集',
            '授权后，新完成对话中的稳定事实将经模型筛选后发送到记忆服务。仅采集当前授权范围内的新请求，不回填历史；你可随时关闭自动采集或暂停全部记忆。');
          if (!accepted) return;
          const signal = AbortSignal.timeout(options.collection.lifecycleTimeoutMs);
          await options.collection.sessions.register(ctx.sessionManager, signal);
          await delivery.authorizeCollection({ policyVersion: state.authorization.policyVersion, scope: options.scope ?? null,
            boundaries: await options.collection.sessions.boundaries(signal) });
          try { options.collection.wake(); } catch { /* durable owner polling recovers */ }
          ctx.ui.notify('自动采集已单独授权，仅处理此刻之后开始并完成的新请求。', 'info');
        } else if (action === 'auto-disable') {
          await delivery.revokeCollection();
          ctx.ui.notify('自动采集已关闭；未发送的自动任务不会重放。显式保存与召回仍遵循长期记忆开关。', 'info');
        } else if (action === 'pause') {
          await delivery.pause();
          ctx.ui.notify('长期记忆已暂停。未发送的保存不会在恢复后自动重放。', 'info');
        } else if (action === 'status') {
          const state = await options.stateStore.read();
          const recent = Object.values(state.operations).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
          const summary = [`长期记忆：${state.authorization.enabled ? '已启用' : '已暂停'}；自动采集：${state.authorization.automaticCollection ? '已授权' : '未授权'}`,
            ...recent.map(operation => `${statusLabels[operation.phase]} · ${operation.createdAt} · ${operation.id}`)];
          const failures = Object.values(state.collectionRequests ?? {}).filter(request => request.phase === 'selection_failed');
          if (failures.length) summary.push(`自动采集未完成：${failures.length} 项，尚未保存为长期记忆。`);
          ctx.ui.notify(summary.join('\n'), 'info');
        } else if (action.startsWith('show ')) {
          const id = action.slice(5).trim();
          if (!/^[a-f0-9]{64}$/.test(id)) { ctx.ui.notify('保存记录不存在。', 'warning'); return; }
          const operation = (await options.stateStore.read()).operations[id];
          if (!operation) { ctx.ui.notify('保存记录不存在。', 'warning'); return; }
          const lines = [`状态：${statusLabels[operation.phase]}`, `时间：${operation.createdAt}`,
            `来源会话：${operation.source.sessionId}`];
          if (operation.phase === 'ready' && options.client.readMemory) {
            for (const uri of operation.memoryUris ?? []) lines.push(await options.client.readMemory(uri));
          }
          ctx.ui.notify(lines.join('\n'), 'info');
        } else {
          ctx.ui.notify('使用 /memory enable、/memory pause、/memory auto-enable、/memory auto-disable、/memory status 或 /memory show <记录编号>。', 'info');
        }
      } catch { ctx.ui.notify('记忆操作暂时不可用；普通聊天可继续。', 'warning'); }
    },
  });
}
