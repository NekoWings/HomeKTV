import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

async function controllerHarness(source = 'bilibili', options = {}) {
  let time = 1000, nextId = 10, job = { id: 'job', token: 'token', source, query: '晴天 KTV 伴奏', page: 1 };
  const tabs = new Map(), created = [], reports = [], nodes = new Map(), reloads = [], windows = [];
  const requests = [], updates = [];
  const saved = options.fresh ? {} : { config: { server: 'http://localhost:3210', key: '', name: 'test', role: options.role || 'remote', autoHost: options.autoHost } };
  const state = { current: null, queue: [], desired: 'paused', hostOnline: true, status: {} };
  const context = vm.createContext({
    URL, AbortSignal, AbortController, Promise, setTimeout, setInterval: () => {},
    Date: class extends Date { static now() { return time; } },
    crypto: { randomUUID: () => 'controller-host-123456' },
    document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, { value: id === 'server' ? 'http://localhost:3210' : '', checked: id === 'hostMode', classList: { toggle() {} } }); return nodes.get(id); } },
    window: { addEventListener() {} },
    chrome: { permissions: { async contains() { return options.permission !== false; }, async request() { return options.permission !== false; } }, storage: { onChanged: { addListener() {} }, local: { async get(key) { return { [key]: saved[key] }; }, async set(data) { Object.assign(saved, structuredClone(data)); } }, session: { async get() { return {}; }, async set() {}, async remove() {} } },
      windows: { async create(data) { windows.push(data); return { id: 2 }; } },
      tabs: { async query() { return options.existing ? [{ id: 90, windowId: 1, url: 'http://localhost:3210/' }] : [...tabs.values()]; }, async getCurrent() { return { id: 1 }; }, async get(id) { if (!tabs.has(id)) throw new Error('missing'); return tabs.get(id); },
        async create(data) { const tab = { ...data, id: nextId++ }; tabs.set(tab.id, tab); created.push(tab); return tab; },
        async update(id, data) { updates.push({ id, ...data }); return { ...tabs.get(id), ...data, id }; }, async remove(id) { tabs.delete(id); }, async reload(id) { reloads.push(id); },
        async sendMessage(id, message) { return { results: [{ url: 'https://www.bilibili.com/video/BV1sg4y1q7WD/', title: '晴天' }], empty: false }; }, onRemoved: { addListener() {} } } },
    async fetch(url, requestOptions) {
      const route = new URL(url).pathname, body = requestOptions.body && JSON.parse(requestOptions.body);
      requests.push({ route, body });
      if (route === '/api/ticks') return { ok: true, body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }) } };
      if (route === '/api/host' && options.conflict) return { ok: false, json: async () => ({ error: '已有一台 KTV 主机在线，请先在原主机停止接管' }) };
      let data = state;
      if (route === '/api/search/claim') data = { job };
      if (route === '/api/search/result') { reports.push(body); job = null; data = { status: 'done' }; }
      return { ok: true, async json() { return data; } };
    }
  });
  vm.runInContext(readFileSync(new URL('../extension/console.js', import.meta.url), 'utf8'), context);
  // Finish the controller's normal initialization without invoking browser timers.
  await new Promise(resolve => setImmediate(resolve));
  if (!options.natural) vm.runInContext('hosting = true', context);
  return { context, created, reports, tabs, reloads, windows, nodes, saved, requests, updates, advance(ms) { time += ms; } };
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

test('dedicated player opens in its own fullscreen window and reuses it for next songs', async () => {
  const h = await controllerHarness();
  const state = { current: { id: 'a', url: 'https://www.bilibili.com/video/BV1sg4y1q7WD/' }, desired: 'playing', queue: [], status: {} };
  await h.context.control(state);
  assert.equal(h.created[0].active, false);
  assert.deepEqual(h.windows.map(data => ({ ...data })), [{ tabId: h.created[0].id, type: 'popup', state: 'fullscreen', focused: true }]);
  await h.context.control({ ...state, current: { ...state.current, id: 'b' } });
  assert.equal(h.created.length, 1); assert.equal(h.windows.length, 1);
  await h.context.closePlayer(); assert.equal(h.tabs.size, 0);
});


test('YouTube search uses its own background results page and mixed playback keeps video identity', async () => {
  const h = await controllerHarness('youtube');
  await h.context.searchStep();
  const search = new URL(h.created[0].url);
  assert.equal(search.hostname, 'www.youtube.com'); assert.equal(search.pathname, '/results');
  assert.equal(search.searchParams.get('search_query'), '晴天 KTV 伴奏');
  assert.equal(h.created[0].active, false);
  const state = { current: { id: 'yt', url: 'https://www.youtube.com/watch?v=k9OCGQl5HMI' }, desired: 'playing', queue: [], status: {} };
  await h.context.control(state);
  const player = new URL(h.created[1].url);
  assert.equal(player.searchParams.get('v'), 'k9OCGQl5HMI'); assert.equal(player.searchParams.get('ktv_song'), 'yt');
});

test('first connection automatically hosts and opens song page, explicit guest does not claim', async () => {
  for (const host of [true, false]) {
    const h = await controllerHarness('bilibili', { fresh: true, natural: true });
    h.context.document.getElementById('hostMode').checked = host;
    await h.nodes.get('settings').onsubmit({ preventDefault() {} });
    assert.equal(h.requests.filter(r => r.route === '/api/host').length, host ? 1 : 0);
    assert.equal(vm.runInContext('hosting', h.context), host);
    assert.equal(h.saved.config.role, host ? 'host' : 'remote');
    assert.equal(h.created.length, 1); assert.equal(h.created[0].url, 'http://localhost:3210');
  }
});
test('saved host reconnects automatically and reuses the song page; stopped host stays stopped', async () => {
  const h = await controllerHarness('bilibili', { role: 'host', natural: true, existing: true });
  assert.equal(vm.runInContext('hosting', h.context), true);
  assert.equal(h.created.length, 0); assert.ok(h.updates.some(t => t.id === 90 && t.active));
  await h.nodes.get('release').onclick();
  assert.equal(vm.runInContext('hosting', h.context), false); assert.equal(h.saved.config.autoHost, false);
  const stopped = await controllerHarness('bilibili', { role: 'host', autoHost: false, natural: true });
  assert.equal(stopped.requests.some(r => r.route === '/api/host'), false);
});
test('existing host is not replaced and permissions are required before automatic setup', async () => {
  const conflict = await controllerHarness('bilibili', { role: 'host', natural: true, conflict: true });
  assert.equal(vm.runInContext('hosting', conflict.context), false);
  assert.equal(conflict.created.length, 0);
  assert.match(conflict.nodes.get('setupError').textContent, /已有/);
  await conflict.nodes.get('guestOpen').onclick();
  assert.equal(conflict.saved.config.role, 'remote'); assert.equal(conflict.created.length, 1);
  const denied = await controllerHarness('bilibili', { fresh: true, natural: true, permission: false });
  await denied.nodes.get('settings').onsubmit({ preventDefault() {} });
  assert.equal(denied.requests.length, 0); assert.equal(denied.saved.config, undefined);
});
