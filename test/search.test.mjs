import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchQueue } from '../lib/search.mjs';

const video = { url: 'https://www.bilibili.com/video/BV1sg4y1q7WD/', title: '晴天', author: 'UP主', duration: '05:15', cover: 'https://i2.hdslb.com/bfs/archive/test.jpg' };
test('Japanese mode uses ニコカラ and stays separate from Chinese and plain caches', () => {
  const queue = new SearchQueue();
  const jp = queue.create({ query: 'メルト', mode: 'nicokara' }, true);
  assert.equal(jp.query, 'メルト ニコカラ');
  assert.notEqual(queue.create({ query: 'メルト', mode: 'ktv' }, true).id, jp.id);
  assert.equal(queue.create({ query: 'メルト', mode: 'plain' }, true).query, 'メルト');
  assert.throws(() => queue.create({ query: '歌', mode: 'invalid' }, true));
});
test('search combines keywords, deduplicates jobs, caches results and keeps ordinary mode separate', () => {
  const queue = new SearchQueue();
  const job = queue.create({ query: ' 晴天 ' }, true);
  assert.equal(job.query, '晴天 KTV 伴奏');
  assert.equal(queue.create({ query: '晴天' }, true).id, job.id);
  const task = queue.claim('host');
  queue.finish({ ...task, results: [video] }, 'host');
  assert.equal(queue.create({ query: '晴天' }, false).status, 'done');
  assert.notEqual(queue.create({ query: '晴天', karaoke: false }, true).id, job.id);
  assert.notEqual(queue.create({ query: '晴天', page: 2 }, true).id, job.id);
});
test('search needs online host, validates input and bounds pending requests', () => {
  const queue = new SearchQueue();
  assert.throws(() => queue.create({ query: '歌' }, false), /启动主机/);
  for (const args of [{ query: '' }, { query: 'a'.repeat(81) }, { query: '歌', page: 0 }]) assert.throws(() => queue.create(args, true));
  for (let n = 0; n < 5; n++) queue.create({ query: `歌${n}` }, true);
  assert.throws(() => queue.create({ query: '满' }, true), /稍等/);
});
test('host failover invalidates old result, duplicate result cannot overwrite cache', () => {
  const queue = new SearchQueue(); queue.create({ query: '歌' }, true);
  const old = queue.claim('one'), current = queue.claim('two');
  assert.notEqual(old.token, current.token);
  assert.throws(() => queue.finish({ ...old, results: [video] }, 'one'), /失效/);
  queue.finish({ ...current, results: [video] }, 'two');
  assert.equal(queue.finish({ ...current, results: [] }, 'two').results.length, 1);
});
test('timeouts are errors, empty results are valid, failures retry and cache expires', () => {
  let now = 0; const queue = new SearchQueue(() => now);
  const job = queue.create({ query: '歌' }, true); queue.claim('one'); now = 46000;
  assert.equal(queue.get(job.id).status, 'error');
  const retry = queue.create({ query: '歌' }, true); assert.notEqual(retry.id, job.id);
  const task = queue.claim('one'); queue.finish({ ...task, results: [] }, 'one');
  assert.deepEqual(queue.get(retry.id).results, []);
  now = 400000; assert.throws(() => queue.get(retry.id), /过期/);
});
test('results accept only canonical B站 links and approved HTTPS cover hosts', () => {
  const queue = new SearchQueue(); queue.create({ query: '歌' }, true); const task = queue.claim('host');
  const result = queue.finish({ ...task, results: [video, video, { ...video, url: 'javascript:alert(1)' }, { ...video, url: 'BV1u441117ko', cover: 'https://hdslb.com.evil.test/x' }] }, 'host');
  assert.equal(result.results.length, 2); assert.equal(result.results[0].cover, video.cover); assert.equal(result.results[1].cover, '');
});

test('YouTube jobs use separate caches, restrict pagination and filter source and covers', () => {
  const queue = new SearchQueue();
  const yt = queue.create({ query: 'song', source: 'youtube', mode: 'plain' }, true);
  assert.equal(yt.source, 'youtube');
  assert.notEqual(queue.create({ query: 'song', mode: 'plain' }, true).id, yt.id);
  const task = queue.claim('host');
  const result = queue.finish({ ...task, results: [video, { url: 'https://youtu.be/k9OCGQl5HMI', title: 'Song', cover: 'https://i.ytimg.com/vi/k9OCGQl5HMI/hqdefault.jpg' }, { url: 'https://youtube.com/watch?v=zxjFe42SA8I', title: 'Other', cover: 'https://evil.test/img.jpg' }] }, 'host');
  assert.equal(result.results.length, 2); assert.match(result.results[0].cover, /ytimg/); assert.equal(result.results[1].cover, '');
  assert.equal(queue.create({ query: 'song', source: 'youtube', mode: 'plain' }, false).id, yt.id);
  assert.equal(queue.create({ query: 'song', source: 'youtube' }, true).query, 'song karaoke');
  assert.throws(() => queue.create({ query: 'song', source: 'youtube', page: 2 }, true), /首批/);
  assert.throws(() => queue.create({ query: 'song', source: 'unknown' }, true), /来源/);
});
