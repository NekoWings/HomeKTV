import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
function harness({ managed = true, blocked = false, screen = 'normal', fullscreenReady = true } = {}) {
  let listener, interval, fullscreenClicks = 0;
  const events = {};
  const video = { paused: true, muted: true, currentTime: 10, duration: 60, readyState: 4, error: null,
    getBoundingClientRect: () => ({ width: 800 }), addEventListener: (name, callback) => { events[name] = callback; },
    pause() { this.paused = true; }, async play() { if (blocked) { const error = new Error('blocked'); error.name = 'NotAllowedError'; throw error; } this.paused = false; events.play?.(); }
  };
  const location = { href: `https://www.bilibili.com/video/BV1u441117ko/${managed ? '?ktv_song=song-a' : ''}` };
  const context = { location, URL, WeakSet, Date, Promise, console, document: { body: null, querySelectorAll: query => query === 'video' ? [video] : [], querySelector: query => query.includes('ctrl-web') ? (fullscreenReady ? { click() { fullscreenClicks++; screen = 'web'; } } : null) : query.includes('player-container') ? { getAttribute: () => screen } : video }, MutationObserver: class { observe() {} }, setInterval: callback => { interval = callback; }, setTimeout: () => {}, chrome: { storage: { local: { async get() { return {}; } }, onChanged: { addListener() {} } }, runtime: { onMessage: { addListener: callback => { listener = callback; } } } } };
  vm.runInNewContext(source, context);
  return { video, events, location, interval, get fullscreenClicks() { return fullscreenClicks; }, setFullscreenReady(value) { fullscreenReady = value; }, command(desired = 'playing', id = 'song-a', extra = {}) { return new Promise(resolve => { const result = listener({ type: 'ktv-control', desired, id, ...extra }, {}, resolve); if (result === undefined) resolve(undefined); }); } };
}
test('player control plays, unmutes, pauses and reports actual progress', async () => {
  const player = harness(); const report = await player.command();
  assert.equal(player.video.paused, false); assert.equal(player.video.muted, false); assert.equal(report.time, 10);
  await player.command('paused'); assert.equal(player.video.paused, true);
});
test('autoplay rejection is surfaced and ordinary browsing is not controlled', async () => {
  assert.match((await harness({ blocked: true }).command()).message, /开始唱/);
  const ordinary = harness({ managed: false }); assert.equal(await ordinary.command(), undefined); assert.equal(ordinary.video.muted, true);
  const managed = harness(); assert.equal(await managed.command('playing', 'wrong-song'), undefined);
});
test('ended event latches until next page, prevents replay, and reports only after playback', async () => {
  const player = harness(); await player.command(); player.events.timeupdate();
  let stopped = false; player.events.ended({ stopImmediatePropagation() { stopped = true; } });
  assert.equal(stopped, true); assert.equal((await player.command()).ended, true); assert.equal(player.video.paused, true);
});
test('B站 own navigation and expired controller heartbeat stop playback', async () => {
  const player = harness(); await player.command();
  player.location.href = 'https://www.bilibili.com/video/BV1TEh66gEzJ/';
  assert.equal((await player.command()).wrongPage, true); assert.equal(player.video.paused, true);
  const stale = harness(); stale.video.paused = false; stale.interval(); assert.equal(stale.video.paused, true);
});

test('part resume waits for metadata and seek completion, then seeks only once', async () => {
  const h = harness(); const extra = { resumeTime: 32.5 };
  h.video.readyState = 0;
  assert.match((await h.command('playing', 'song-a', extra)).message, /加载/);
  assert.equal(h.video.currentTime, 10); assert.equal(h.video.paused, true);
  h.video.readyState = 4; h.video.seeking = true;
  await h.command('playing', 'song-a', extra);
  assert.equal(h.video.currentTime, 32.5); assert.equal(h.video.paused, true);
  h.video.seeking = false;
  await h.command('playing', 'song-a', extra); assert.equal(h.video.paused, false);
  h.video.currentTime = 35;
  await h.command('playing', 'song-a', extra); assert.equal(h.video.currentTime, 35);
});

test('paused part resume clamps to shorter video and capture freezes exact time', async () => {
  const h = harness();
  await h.command('paused', 'song-a', { resumeTime: 90 });
  assert.equal(h.video.currentTime, 59.5); assert.equal(h.video.paused, true);
  await h.command(); h.video.currentTime = 41.2;
  const report = await h.command('playing', 'song-a', { type: 'ktv-capture' });
  assert.equal(report.time, 41.2); assert.equal(h.video.paused, true);
});

test('managed player enters webpage fullscreen once per page after controls load', async () => {
  const player = harness({ fullscreenReady: false });
  await player.command(); assert.equal(player.fullscreenClicks, 0);
  player.setFullscreenReady(true); player.interval(); assert.equal(player.fullscreenClicks, 1);
  await player.command(); player.interval(); assert.equal(player.fullscreenClicks, 1);
  const fullscreen = harness({ screen: 'web' }); await fullscreen.command(); assert.equal(fullscreen.fullscreenClicks, 0);
  const ordinary = harness({ managed: false }); ordinary.interval(); assert.equal(ordinary.fullscreenClicks, 0);
});
