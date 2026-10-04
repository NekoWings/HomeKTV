import test from 'node:test';
import assert from 'node:assert/strict';
import { inviteUrls } from '../lib/invite.mjs';

test('invites use current interfaces, exclude loopback/link-local, and prefer the connected interface', () => {
  const item = (address, internal = false, family = 'IPv4') => ({ address, internal, family });
  const interfaces = { lo: [item('127.0.0.1', true)], wifi: [item('192.168.1.223'), item('fe80::1', false, 'IPv6')], ethernet: [item('10.0.0.2'), item('169.254.1.2'), item('192.168.1.223')] };
  assert.deepEqual(inviteUrls(3211, '::ffff:10.0.0.2', interfaces), ['http://10.0.0.2:3211', 'http://192.168.1.223:3211']);
  assert.deepEqual(inviteUrls(3210, '127.0.0.1', { wifi: [item('192.168.1.224')] }), ['http://192.168.1.224:3210']);
  assert.deepEqual(inviteUrls(3210, '127.0.0.1', {}), []);
});
