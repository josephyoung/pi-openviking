import type { DefaultResourceLoader, ExtensionFactory, SettingsManager } from '@earendil-works/pi-coding-agent';

type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

/** Apply before any reload/package resolution, not after extensions load.
 * The caller owns a protected agentDir and audited, read-only Skill paths.
 */
export function protectedMemoryResources(settingsManager: SettingsManager, factory: ExtensionFactory,
  trustedSkillPaths: readonly string[] = []): Pick<LoaderOptions,
  'settingsManager' | 'noExtensions' | 'noSkills' | 'additionalExtensionPaths' | 'additionalSkillPaths' | 'extensionFactories'> {
  settingsManager.setProjectTrusted(false);
  return {
    settingsManager,
    noExtensions: true,
    noSkills: true,
    additionalExtensionPaths: [],
    additionalSkillPaths: [...trustedSkillPaths],
    extensionFactories: [{ name: 'openviking', factory }],
  };
}
