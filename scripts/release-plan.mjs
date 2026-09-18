import { readFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const current = JSON.parse(await readFile('package.json', 'utf8'));
const before = process.env.BEFORE_SHA;
let changed = true;
if (process.env.GITHUB_EVENT_NAME === 'push' && before && !/^0+$/.test(before)) {
  const previous = JSON.parse(execFileSync('git', ['show', `${before}:package.json`], { encoding: 'utf8' }));
  changed = current.version !== previous.version;
}

let publish = false;
if (changed) {
  // Query package metadata rather than interpreting any npm command failure as
  // an unpublished version. Network/auth/server errors must stop the release.
  const url = new URL(encodeURIComponent(current.name), 'https://registry.npmjs.org/');
  url.searchParams.set('release-check', process.env.GITHUB_RUN_ID ?? Date.now().toString());
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`npm metadata lookup failed: HTTP ${response.status}`);
  const metadata = await response.json();
  if (metadata.name !== current.name || !metadata.versions || typeof metadata.versions !== 'object') {
    throw new Error('Invalid npm package metadata');
  }
  publish = !Object.hasOwn(metadata.versions, current.version);
}
// Pre-release versions do not replace the normal installation default.
const tag = current.version.includes('-') ? 'next' : 'latest';
console.log(`${current.name}@${current.version}: ${publish ? `publish (${tag})` : 'skip (unchanged or already published)'}`);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `publish=${publish}\ntag=${tag}\n`);
