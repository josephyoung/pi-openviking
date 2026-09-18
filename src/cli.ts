#!/usr/bin/env node
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { runProtectedPi, type LauncherProfile } from './launcher.js';

try {
  const [profilePath, ...args] = process.argv.slice(2);
  if (!profilePath || !isAbsolute(profilePath)) throw new Error('ABSOLUTE_LAUNCH_PROFILE_REQUIRED');
  const canonical = await realpath(profilePath);
  // The bootstrap profile is administrator-owned data. Validate the whole path
  // before parsing it; it must not be replaceable from an untrusted workspace.
  for (let current = canonical;; current = dirname(current)) {
    const stat = await lstat(current);
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error('ADMIN_OWNED_LAUNCH_PROFILE_REQUIRED');
    if (current === canonical && !stat.isFile()) throw new Error('INVALID_LAUNCH_PROFILE');
    if (dirname(current) === current) break;
  }
  const profile = JSON.parse(await readFile(canonical, 'utf8')) as LauncherProfile;
  await runProtectedPi(profile, args);
} catch {
  // Configuration and provider failures can contain keys or endpoints.
  console.error('Protected pi startup failed. Check the administrator-owned launch profile and private host configuration.');
  process.exitCode = 1;
}
