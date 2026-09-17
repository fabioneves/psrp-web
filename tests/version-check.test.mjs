import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageIsStale, reloadDecision } from '../web/version-check.js';

test('a page reloads when the server build moved on, but only once nothing is streaming', () => {
  assert.equal(reloadDecision('abc1234', 'abc1234', false), 'current');
  assert.equal(reloadDecision('abc1234', 'def5678', false), 'now');
  assert.equal(reloadDecision('abc1234', 'def5678', true), 'after-stream');
  assert.equal(pageIsStale('dev', 'def5678'), false, 'development builds are never stale');
  assert.equal(pageIsStale('abc1234', 'dev'), false);
  assert.equal(pageIsStale('', 'def5678'), false);
});
