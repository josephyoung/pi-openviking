import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceAlignedContent } from '../dist/source-aligned-content.js';

test('keeps a verbatim model quote unchanged', () => {
  assert.deepEqual(sourceAlignedContent(['请记住：验收专用灯塔代号是云汀201。'], '验收专用灯塔代号是云汀201'),
    { content: '验收专用灯塔代号是云汀201', corrected: false });
});

test('repairs one uniquely aligned numeric run from the current user message', () => {
  assert.deepEqual(sourceAlignedContent(['请记住：验收专用灯塔代号是云汀201。'], '验收专用灯塔代号是云汀202'),
    { content: '验收专用灯塔代号是云汀201', corrected: true });
  assert.deepEqual(sourceAlignedContent(['请记住：验收专用灯塔代号是云汀201。'], '验收专用灯塔代号是云汀2020'),
    { content: '验收专用灯塔代号是云汀201', corrected: true });
});

test('rejects ambiguous, multiple-edit and nonnumeric substitutions', () => {
  assert.equal(sourceAlignedContent(['请记住：验收专用灯塔代号是云汀201。验收专用灯塔代号是云汀203。'],
    '验收专用灯塔代号是云汀202'), null);
  assert.equal(sourceAlignedContent(['请记住：验收专用灯塔代号是云汀201。'], '验收专用灯塔代号是云汀9999'), null);
  assert.equal(sourceAlignedContent(['请记住：验收专用灯塔代号是云汀201。验收专用灯塔代号是云汀203。'],
    '验收专用灯塔代号是云汀2020'), null);
  assert.equal(sourceAlignedContent(['请记住：验收专用灯塔代号是云汀201。'], '验收专用灯塔代号是云亭201'), null);
  assert.equal(sourceAlignedContent(['请记住：代号是201。'], '代号是202'), null);
});
