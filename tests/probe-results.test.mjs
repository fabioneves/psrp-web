import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCandidate, summarizeStun, summarizeLoopback, summarizeWorkerTransfer } from '../web/probe-results.js';

test('candidate lines yield protocol, endpoint and type, and junk yields null', () => {
  assert.deepEqual(parseCandidate('candidate:842163049 1 udp 1677729535 203.0.113.7 4242 typ srflx raddr 0.0.0.0 rport 0 generation 0'),
    { protocol: 'udp', address: '203.0.113.7', port: 4242, type: 'srflx' });
  assert.deepEqual(parseCandidate('candidate:1 1 TCP 1518280447 192.0.2.4 9 typ host tcptype active'),
    { protocol: 'tcp', address: '192.0.2.4', port: 9, type: 'host' });
  assert.equal(parseCandidate(''), null);
  assert.equal(parseCandidate('not a candidate'), null);
});

test('a UDP server-reflexive candidate proves outbound UDP; host candidates alone do not', () => {
  const host = { protocol: 'udp', address: 'abc.local', port: 5000, type: 'host' };
  const mapped = { protocol: 'udp', address: '203.0.113.7', port: 4242, type: 'srflx' };
  assert.deepEqual(summarizeStun([host]), { udp: false, publicEndpoints: [], verdict: 'No STUN answer over UDP: outbound UDP looks blocked, so WebRTC would fall back to WebSocket.' });
  assert.deepEqual(summarizeStun([host, mapped, mapped]), { udp: true, publicEndpoints: ['203.0.113.7:4242'], verdict: 'Outbound UDP works.' });
  const tcpOnly = summarizeStun([{ ...mapped, protocol: 'tcp' }]);
  assert.equal(tcpOnly.udp, false);
});

test('different public endpoints per STUN server are reported, because the mapping is not stable', () => {
  const summary = summarizeStun([
    { protocol: 'udp', address: '203.0.113.7', port: 4242, type: 'srflx' },
    { protocol: 'udp', address: '203.0.113.7', port: 4977, type: 'srflx' }]);
  assert.equal(summary.udp, true);
  assert.deepEqual(summary.publicEndpoints, ['203.0.113.7:4242', '203.0.113.7:4977']);
  assert.match(summary.verdict, /changes per destination/);
});

test('loopback totals become rates and a loss percentage, and an empty run stays finite', () => {
  assert.deepEqual(summarizeLoopback({ sent: 1000, received: 950, bytes: 1100, seconds: 2 }),
    { sentMbps: 4.4, receivedMbps: 4.18, lossPercent: 5 });
  assert.deepEqual(summarizeLoopback({ sent: 0, received: 0, bytes: 1100, seconds: 2 }), { sentMbps: 0, receivedMbps: 0, lossPercent: 0 });
});

test('a data channel that reaches a worker and delivers there reads as transferable', () => {
  const result = summarizeWorkerTransfer({ transferred: true, sent: 200, received: 200 });
  assert.equal(result.mode, 'transfer');
  assert.match(result.verdict, /200 of 200/);
});

test('a refused or silent hand-off reads as forwarding through the page, with the reason', () => {
  const refused = summarizeWorkerTransfer({ transferred: false, error: 'DataCloneError' });
  assert.equal(refused.mode, 'forward');
  assert.match(refused.verdict, /DataCloneError/);
  const silent = summarizeWorkerTransfer({ transferred: true, sent: 200, received: 3 });
  assert.equal(silent.mode, 'forward');
  assert.match(silent.verdict, /3 of 200/);
});
