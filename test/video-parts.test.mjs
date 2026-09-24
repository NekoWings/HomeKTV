import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoParts, vocalType } from '../lib/video-parts.mjs';

const fixture = { code: 0, data: { bvid: 'BV1sg4y1q7WD', title: '日语歌', pages: [{ page: 1, part: 'On Vocal', duration: 180 }, { page: 2, part: 'Off Vocal', duration: 179 }] } };
test('parts preserve source order, label vocals and generate exact p URLs', async () => {
  let calls = 0;
  const service = new VideoParts(async url => { calls++; assert.equal(url.hostname, 'api.bilibili.com'); assert.equal(url.searchParams.get('bvid'), fixture.data.bvid); return { ok: true, json: async () => fixture }; });
  const [a, b] = await Promise.all([service.get(fixture.data.bvid), service.get(`https://www.bilibili.com/video/${fixture.data.bvid}/?p=2`)]);
  assert.equal(calls, 1); assert.deepEqual(a, b); assert.equal(a.parts[0].vocal, 'on'); assert.equal(a.parts[1].vocal, 'off'); assert.match(a.parts[1].url, /\?p=2$/);
  await service.get(fixture.data.bvid); assert.equal(calls, 1);
});
test('vocal classification does not assume every part is an accompaniment', () => {
  assert.equal(vocalType('オフボーカル'), 'off'); assert.equal(vocalType('Off_Vocal +3'), 'off'); assert.equal(vocalType('オンボーカル'), 'on'); assert.equal(vocalType('原唱'), 'on'); assert.equal(vocalType('live +2'), '');
});
test('metadata failures can retry and arbitrary URLs never reach upstream', async () => {
  let calls = 0;
  const service = new VideoParts(async () => { calls++; return { ok: false, status: 412 }; });
  await assert.rejects(service.get('https://evil.test/video/x')); assert.equal(calls, 0);
  await assert.rejects(service.get(fixture.data.bvid), /分P信息/);
  await assert.rejects(service.get(fixture.data.bvid), /分P信息/); assert.equal(calls, 2);
});
