import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

for (const roomKey of ['', 'test-room']) test(`HTTP ${roomKey ? 'protected' : 'open'} room, concurrent clients and restart recovery`, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'homektv-test-'));
  await writeFile(path.join(dir, 'room-key.txt'), 'legacy-generated-key');
  let child;
  async function start() {
    child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '0', KTV_ROOM_KEY: roomKey, KTV_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('server startup timeout')), 5000);
      child.once('error', reject); child.once('exit', code => { clearTimeout(timeout); reject(new Error(`server exited ${code}`)); });
      child.stdout.on('data', chunk => { const port = chunk.toString().match(/127\.0\.0\.1:(\d+)/)?.[1]; if (port) { clearTimeout(timeout); resolve(`http://127.0.0.1:${port}`); } });
    });
  }
  async function stop() { const exited = once(child, 'exit'); child.kill(); await exited; }
  try {
    let base = await start();
    const api = async (route, body, key = roomKey) => {
      const response = await fetch(`${base}/api/${route}`, { method: body ? 'POST' : 'GET', headers: { 'x-room-key': key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, data: await response.json() };
    };
    assert.equal((await api('state', null, 'wrong')).status, roomKey ? 401 : 200);
    assert.equal((await fetch(`${base}/api/state`)).status, roomKey ? 401 : 200);
    assert.deepEqual(await (await fetch(`${base}/api/info`)).json(), { keyRequired: !!roomKey });
    const invitation = await fetch(`${base}/api/invite`, { headers: { Host: 'untrusted.example:9999' } });
    assert.equal(invitation.status, 200);
    assert.equal(invitation.headers.get('cache-control'), 'no-store');
    const { urls } = await invitation.json();
    assert.ok(Array.isArray(urls));
    for (const url of urls) {
      assert.match(url, /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/);
      assert.equal(new URL(url).port, new URL(base).port);
      assert.notEqual(new URL(url).hostname, '127.0.0.1');
    }
    assert.equal((await fetch(`${base}/vendor/qrcode.js`)).status, 200);
    assert.equal((await fetch(`${base}/server.mjs`)).status, 404);
    assert.equal((await fetch(`${base}/`)).status, 200);
    const controller = new AbortController();
    const stream = await fetch(`${base}/api/ticks`, { headers: { 'x-room-key': roomKey }, signal: controller.signal });
    assert.equal(stream.status, 200); assert.match(new TextDecoder().decode((await stream.body.getReader().read()).value), /data: tick/); controller.abort();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => api('action', { action: 'add', url: 'BV1u441117ko', title: `song ${i}`, requestId: `req-${i}` })));
    assert.ok(results.every(x => x.status === 200));
    let state = (await api('state')).data; assert.equal(state.queue.length, 11);
    const hostId = 'integration-host-1234'; assert.equal((await api('host', { hostId })).status, 200);
    assert.equal((await api('host', { hostId: 'different-host-1234' })).status, 400);
    const search = await api('search', { query: '晴天' }); assert.equal(search.status, 200);
    assert.equal((await api('search/claim', { hostId: 'wrong' })).status, 400);
    const assignment = (await api('search/claim', { hostId })).data.job;
    assert.equal(assignment.id, search.data.id);
    const searchResult = await api('search/result', { hostId, id: assignment.id, token: assignment.token, results: [{ url: 'BV1sg4y1q7WD', title: '晴天 KTV' }] });
    assert.equal(searchResult.status, 200);
    assert.equal((await api(`search/${search.data.id}`)).data.results[0].title, '晴天 KTV');
    assert.equal((await api('report', { hostId, id: state.current.id, message: '正在播放', time: 2, duration: 100 })).status, 200);
    await Promise.all([api('action', { action: 'next', id: state.current.id }), api('action', { action: 'ended', id: state.current.id, hostId })]);
    state = (await api('state')).data; assert.equal(state.queue.length, 10);
    await stop(); base = await start();
    const restored = (await api('state')).data; assert.equal(restored.current.id, state.current.id); assert.equal(restored.queue.length, 10); assert.equal(restored.desired, 'paused'); assert.equal(restored.hostOnline, false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) await stop();
    const resolved = path.resolve(dir), tempRoot = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved), tempRoot);
    assert.ok(path.basename(resolved).startsWith('homektv-test-'));
    await rm(resolved, { recursive: true, force: true });
  }
});
