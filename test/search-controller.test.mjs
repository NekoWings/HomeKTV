import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

async function controllerHarness() {
  let time = 1000, nextId = 10, job = { id: 'job', token: 'token', query: '晴天 KTV 伴奏', page: 1 };
  const tabs = new Map(), created = [], reports = [], nodes = new Map(), reloads = [];
  const state = { current: null, queue: [], desired: 'paused', hostOnline: true, status: {} };
  const context = vm.createContext({
    URL, AbortSignal, AbortController, Promise, setTimeout, setInterval: () => {},
    Date: class extends Date { static now() { return time; } },
    crypto: { randomUUID: () => 'controller-host-123456' },
    document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); } },
    window: { addEventListener() {} },
    chrome: { storage: { onChanged: { addListener() {} }, local: { async get() { return { config: { server: 'http://localhost:3210', key: '', name: 'test' } }; } }, session: { async get() { return {}; }, async set() {}, async remove() {} } },
      tabs: { async getCurrent() { return { id: 1 }; }, async get(id) { if (!tabs.has(id)) throw new Error('missing'); return tabs.get(id); },
        async create(data) { const tab = { ...data, id: nextId++ }; tabs.set(tab.id, tab); created.push(tab); return tab; },
        async update(id, data) { return { ...tabs.get(id), ...data, id }; }, async remove(id) { tabs.delete(id); }, async reload(id) { reloads.push(id); },
        async sendMessage(id, message) { return { results: [{ url: 'https://www.bilibili.com/video/BV1sg4y1q7WD/', title: '晴天' }], empty: false }; }, onRemoved: { addListener() {} } } },
    async fetch(url, options) {
      const route = new URL(url).pathname, body = options.body && JSON.parse(options.body);
      let data = state;
      if (route === '/api/search/claim') data = { job };
      if (route === '/api/search/result') { reports.push(body); job = null; data = { status: 'done' }; }
      return { ok: true, async json() { return data; } };
    }
  });
  vm.runInContext(readFileSync(new URL('../extension/console.js', import.meta.url), 'utf8'), context);
  // Finish the controller's normal initialization without invoking browser timers.
  await new Promise(resolve => setImmediate(resolve));
  vm.runInContext('hosting = true', context);
  return { context, created, reports, tabs, reloads, advance(ms) { time += ms; } };
}

test('controller captures old player time before navigation and sends it to new part', async () => {
  const h = await controllerHarness();
  const base = { current: { id: 'old', url: 'https://www.bilibili.com/video/BV1sg4y1q7WD/' }, desired: 'playing', queue: [], status: {} };
  await h.context.control(base);
  const messages = [];
  h.context.chrome.tabs.sendMessage = async (id, message) => { messages.push(message); return { time: 47.25 }; };
  const next = { ...base, current: { ...base.current, id: 'new', url: base.current.url + '?p=2', resumeFrom: 'old', resumeTime: 46 } };
  await h.context.control(next);
  assert.equal(messages[0].type, 'ktv-capture'); assert.equal(messages[0].id, 'old');
  await h.context.control(next);
  assert.equal(messages[1].resumeTime, 47.25); assert.equal(messages[1].id, 'new');
});

test('controller opens a background search tab and submits only stable results without touching playback', async () => {
  const h = await controllerHarness();
  await h.context.searchStep();
  assert.equal(h.created.length, 1); assert.equal(h.created[0].active, false);
  const url = new URL(h.created[0].url); assert.equal(url.hostname, 'search.bilibili.com'); assert.equal(url.searchParams.get('keyword'), '晴天 KTV 伴奏');
  h.advance(3000); await h.context.searchStep(); assert.equal(h.reports.length, 0);
  await h.context.searchStep(); assert.equal(h.reports.length, 1); assert.equal(h.reports[0].results[0].title, '晴天');
  vm.runInContext('hosting = false', h.context); await h.context.closeSearch(); assert.equal(h.tabs.size, 0);
});
test('unreadable search page returns timeout error and leaves the page available to inspect', async () => {
  const h = await controllerHarness();
  h.context.chrome.tabs.sendMessage = async () => { throw new Error('not loaded'); };
  await h.context.searchStep(); h.advance(26000); await h.context.searchStep();
  assert.equal(h.reports.length, 1); assert.match(h.reports[0].error, /查看搜索页/); assert.equal(h.tabs.size, 1);
});

test('blank loaded shell reloads once in background, then returns recovered results', async () => {
  const h = await controllerHarness();
  const readResults = h.context.chrome.tabs.sendMessage;
  h.context.chrome.tabs.sendMessage = async () => ({ results: [], empty: false, shellReady: true });
  await h.context.searchStep(); h.advance(7000); await h.context.searchStep(); assert.equal(h.reloads.length, 0);
  h.advance(1000); await h.context.searchStep(); assert.deepEqual(h.reloads, [h.created[0].id]);
  h.advance(1000); await h.context.searchStep(); assert.equal(h.reloads.length, 1);
  h.context.chrome.tabs.sendMessage = readResults;
  await h.context.searchStep(); await h.context.searchStep();
  assert.equal(h.reports[0].results[0].title, '晴天'); assert.equal(h.created.length, 1); assert.equal(h.created[0].active, false);
});
test('persistently blank page times out without repeated reloads', async () => {
  const h = await controllerHarness();
  h.context.chrome.tabs.sendMessage = async () => ({ results: [], empty: false, shellReady: true });
  await h.context.searchStep(); h.advance(8000); await h.context.searchStep();
  h.advance(18000); await h.context.searchStep();
  assert.equal(h.reloads.length, 1); assert.match(h.reports[0].error, /查看搜索页/);
});
test('genuine empty results and verification prompts are never auto-reloaded', async () => {
  for (const result of [{ results: [], empty: true, shellReady: true }, { results: [], blocked: true, shellReady: true }]) {
    const h = await controllerHarness(); h.context.chrome.tabs.sendMessage = async () => result;
    await h.context.searchStep(); h.advance(9000); await h.context.searchStep(); await h.context.searchStep();
    assert.equal(h.reloads.length, 0); assert.equal(h.reports.length, 1);
    if (result.blocked) assert.match(h.reports[0].error, /验证/); else assert.equal(h.reports[0].results.length, 0);
  }
});
