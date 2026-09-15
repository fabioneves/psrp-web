import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAccountId } from '../web/account-id.js';

test('numeric PSN IDs encode as eight little-endian bytes without losing integer precision', () => {
  assert.equal(encodeAccountId('1'), 'AQAAAAAAAAA=');
  assert.equal(encodeAccountId('72623859790382856'), 'CAcGBQQDAgE=');
  assert.equal(encodeAccountId('18446744073709551615'), '//////////8=');
});

test('existing encoded IDs and surrounding whitespace are accepted', () => {
  assert.equal(encodeAccountId(' CAcGBQQDAgE= '), 'CAcGBQQDAgE=');
  assert.equal(encodeAccountId(' 1 '), 'AQAAAAAAAAA=');
});

test('online names, overflow, signed numbers and invalid Base64 are rejected', () => {
  for (const value of ['', 'MyPSNName', '-1', '1.5', '1e3', '18446744073709551616', 'AAAA', 'CAcGBQQDAgF='])
    assert.throws(() => encodeAccountId(value), /account ID/);
});
