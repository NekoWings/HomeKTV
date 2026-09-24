import test from 'node:test';
import assert from 'node:assert/strict';
import { Room, normalizeVideo } from '../lib/room.mjs';
const video = 'BV1u441117ko';
const hostId = 'host-1234567890123456';
const add = (room, title, first = false) => room.action({ action: 'add', url: video, title, first });

test('changing current part reloads the song identity, preserves pause, and rejects stale ended', () => {
  const room = new Room(); room.claim(hostId); add(room, 'A'); add(room, 'B');
  const oldId = room.state.current.id;
  room.action({ action: 'pause' });
  room.status = { time: 42.5 };
  room.action({ action: 'part', id: oldId, url: `https://www.bilibili.com/video/${video}/?p=2`, title: 'A · Off Vocal' });
  assert.notEqual(room.state.current.id, oldId); assert.match(room.state.current.url, /p=2$/); assert.equal(room.state.desired, 'paused');
  assert.equal(room.state.current.resumeTime, 42.5); assert.equal(room.state.current.resumeFrom, oldId);
  room.action({ action: 'ended', id: oldId, hostId }); assert.equal(room.state.current.title, 'A · Off Vocal'); assert.equal(room.state.queue.length, 1);
});

test('rapid part changes retain pending position and stop clears resume', () => {
  const room = new Room(); add(room, 'A'); room.status = { time: 21 };
  room.action({ action: 'part', id: room.state.current.id, url: `https://www.bilibili.com/video/${video}/?p=2` });
  room.action({ action: 'part', id: room.state.current.id, url: video });
  assert.equal(room.state.current.resumeTime, 21);
  room.action({ action: 'stop' }); assert.equal(room.state.current.resumeTime, undefined);
});
test('changing queued part keeps its position and refuses another video', () => {
  const room = new Room(); add(room, 'A'); add(room, 'B'); add(room, 'C');
  const id = room.state.queue[0].id;
  assert.throws(() => room.action({ action: 'part', id, url: 'BV1sg4y1q7WD' }), /同一视频/);
  room.action({ action: 'part', id, url: `https://www.bilibili.com/video/${video}/?p=3`, title: 'B · P3' });
  assert.equal(room.state.current.title, 'A'); assert.deepEqual(room.state.queue.map(s => s.title), ['B · P3', 'C']);
  assert.throws(() => room.action({ action: 'part', id, url: video }), /已切换/);
});

test('canonical video URL preserves part, strips tracking and rejects other URLs', () => {
  assert.equal(normalizeVideo(`分享 https://www.bilibili.com/video/${video}/?p=3&share_source=copy`), `https://www.bilibili.com/video/${video}/?p=3`);
  for (const input of ['javascript:alert(1)', 'https://bilibili.com.evil.test/video/BV1u441117ko/', 'https://b23.tv/test', `https://www.bilibili.com/video/${video}/?p=-1`]) assert.throws(() => normalizeVideo(input));
});
test('FIFO, next priority, queue move and removal preserve current song', () => {
  const room = new Room(); add(room, 'A'); add(room, 'B'); add(room, 'C', true);
  assert.equal(room.state.current.title, 'A');
  assert.deepEqual(room.state.queue.map(x => x.title), ['C', 'B']);
  room.action({ action: 'top', id: room.state.queue[1].id });
  assert.deepEqual(room.state.queue.map(x => x.title), ['B', 'C']);
  room.action({ action: 'remove', id: room.state.queue[1].id });
  room.action({ action: 'next', id: room.state.current.id });
  assert.equal(room.state.current.title, 'B');
});
test('late ended and duplicate next cannot skip a new current song', () => {
  const room = new Room(); room.claim(hostId); add(room, 'A'); add(room, 'B'); add(room, 'C');
  const oldId = room.state.current.id;
  room.action({ action: 'next', id: oldId });
  room.action({ action: 'next', id: oldId });
  room.action({ action: 'ended', id: oldId, hostId });
  assert.equal(room.state.current.title, 'B'); assert.equal(room.state.queue.length, 1);
});
test('only active host can end songs and a stale host loses its lease', () => {
  const room = new Room(); room.claim(hostId); add(room, 'A');
  assert.throws(() => room.claim('other-host-1234567890'));
  assert.throws(() => room.action({ action: 'ended', id: room.state.current.id, hostId: 'wrong' }));
  room.host.seen -= 13000; assert.equal(room.snapshot().hostOnline, false);
  room.claim('other-host-1234567890'); assert.throws(() => room.requireHost(hostId));
});
test('ending the last song, pause, stop, resume and persistence', () => {
  let saved;
  const room = new Room({}, state => { saved = structuredClone(state); });
  add(room, 'A'); add(room, 'B'); room.action({ action: 'pause' }); assert.equal(room.state.desired, 'paused');
  room.action({ action: 'stop' }); assert.equal(room.state.current.title, 'A');
  room.action({ action: 'play' }); assert.equal(room.state.desired, 'playing');
  const recovered = new Room(saved); assert.equal(recovered.state.desired, 'paused'); assert.equal(recovered.state.queue[0].title, 'B');
  room.action({ action: 'next', id: room.state.current.id }); room.action({ action: 'next', id: room.state.current.id });
  assert.equal(room.state.current, null); assert.equal(room.state.desired, 'paused');
});
test('retried additions are idempotent and queue size is bounded', () => {
  const room = new Room(); const request = { action: 'add', url: video, requestId: 'same' };
  room.action(request); room.action(request); assert.equal(room.state.queue.length, 0);
  for (let i = 0; i < 200; i++) add(room, String(i));
  assert.throws(() => add(room, 'overflow'));
});
