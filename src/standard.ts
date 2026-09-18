import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createOpenVikingExtension, type MemoryExtensionOptions } from './host.js';

let launcherBinding: MemoryExtensionOptions | undefined;

/** Only the trusted CLI bootstrap installs this binding, before pi loads extensions. */
export function bindStandardHost(options: MemoryExtensionOptions): void {
  if (launcherBinding) throw new Error('DUPLICATE_STANDARD_MEMORY_HOST');
  launcherBinding = options;
}

export default function openViking(pi: ExtensionAPI): void | Promise<void> {
  if (!launcherBinding) {
    pi.on('session_start', (_event, ctx) => {
      ctx.ui.notify('长期记忆未启用：请通过受保护的 pi-openviking 启动入口运行。', 'info');
    });
    return;
  }
  return createOpenVikingExtension(launcherBinding)(pi);
}
