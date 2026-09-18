import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '@earendil-works/pi-coding-agent';
import { protectedPiArguments } from '../dist/launcher.js';

test('protected CLI denies executable resource and administration overrides', () => {
  for (const args of [['--approve'], ['-a'], ['-e', './unsafe.js'], ['--extension=unsafe.js'],
    ['--skill', './skills'], ['--theme', './theme.json'], ['--session-dir', './sessions'],
    ['install', './package'], ['config']]) {
    assert.throws(() => protectedPiArguments(args), /UNTRUSTED_PI/);
  }
});
test('real pi parser keeps isolation flags effective for ordinary print and resumed sessions', () => {
  for (const args of [['--print', 'hello'], ['--resume'], ['--', 'hello']]) {
    const parsed = parseArgs(protectedPiArguments(args));
    assert.equal(parsed.projectTrustOverride, false);
    assert.equal(parsed.noExtensions, true);
    assert.equal(parsed.noSkills, true);
    assert.equal(parsed.noBuiltinTools, true);
    assert.equal(parsed.extensions, undefined);
  }
});
