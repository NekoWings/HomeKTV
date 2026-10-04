const $ = id => document.getElementById(id);
let config, state, hosting = false, polling = false, playerTab = null, loadedId = null, navigatingAt = 0;
let ticker;
let loadedResume;
let searchTab = null, searchJob = null, searchBusy = false, searchStarted = 0, searchSignature = '', searchReloaded = false;
const hostId = crypto.randomUUID();
const notice = message => { $('notice').textContent = message; };
const buttonsPreference = $('showSongButtons');
chrome.storage.local.get('showSongButtons').then(saved => { buttonsPreference.checked = saved.showSongButtons !== false; });
buttonsPreference.onchange = async () => {
  const enabled = buttonsPreference.checked;
  try {
    await chrome.storage.local.set({ showSongButtons: enabled });
    notice(enabled ? '已显示 B站点歌按钮。' : '已隐藏 B站点歌按钮，主机播放和手机点歌仍可使用。');
  } catch (error) { buttonsPreference.checked = !enabled; notice(`设置未保存：${error.message}`); }
};
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.showSongButtons) buttonsPreference.checked = changes.showSongButtons.newValue !== false;
});
async function api(route, body) {
  if (!config) throw new Error('请先保存并连接房间');
  const response = await fetch(`${config.server}/api/${route}`, { method: body ? 'POST' : 'GET', headers: { 'x-room-key': config.key, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(4500) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '房间连接失败');
  return result;
}
function draw(next) {
  state = next;
  $('role').textContent = hosting ? '● 本机正在接管播放 · 请保持本控制台打开' : `当前是点歌端 · ${next.hostOnline ? 'KTV 主机在线' : '等待 KTV 主机接管'}`;
  $('song').textContent = next.current?.title || '还没有点歌';
  $('playback').textContent = `${next.status.message || ''} · 待唱 ${next.queue.length} 首`;
  $('claim').disabled = hosting; $('release').disabled = !hosting;
}
async function closePlayer() {
  const tabId = playerTab; playerTab = null; loadedId = null;
  await chrome.storage.session.remove('playerTab');
  if (tabId !== null) await chrome.tabs.remove(tabId).catch(() => {});
}
async function closeSearch() {
  while (searchBusy) await new Promise(resolve => setTimeout(resolve, 50));
  const id = searchTab; searchTab = null; searchJob = null;
  await chrome.storage.session.remove('searchTab');
  if (id !== null) await chrome.tabs.remove(id).catch(() => {});
}
async function searchStep() {
  if (!hosting || searchBusy) return;
  searchBusy = true;
  try {
    const { job } = await api('search/claim', { hostId });
    if (!hosting) return;
    if (!job) { searchJob = null; return; }
    const tab = searchTab !== null ? await chrome.tabs.get(searchTab).catch(() => null) : null;
    if (!searchJob || searchJob.token !== job.token || !tab) {
      searchJob = job; searchStarted = Date.now(); searchSignature = ''; searchReloaded = false;
      const url = new URL('https://search.bilibili.com/all');
      url.searchParams.set('keyword', job.query); url.searchParams.set('page', job.page); url.searchParams.set('ktv_search', job.id);
      if (tab) await chrome.tabs.update(searchTab, { url: url.href });
      else { searchTab = (await chrome.tabs.create({ url: url.href, active: false })).id; await chrome.storage.session.set({ searchTab }); }
      $('searchState').textContent = `正在帮朋友搜索：${job.query}`;
      return;
    }
    let result;
    try { result = await chrome.tabs.sendMessage(searchTab, { type: 'ktv-search-read', id: job.id, query: job.query }); } catch {}
    if (result?.blocked) {
      await api('search/result', { hostId, id: job.id, token: job.token, error: 'B站显示验证或访问限制。请在主机点击「查看搜索页」，按页面提示处理后重新搜索。' });
      searchJob = null; $('searchState').textContent = 'B站需要手动处理，请点击「查看搜索页」';
      return;
    }
    if (result && !result.wrongPage && (result.results?.length || result.empty)) {
      const signature = JSON.stringify(result.results);
      // Wait for two stable reads so hydration/skeleton cards are not returned early.
      if (signature === searchSignature && Date.now() - searchStarted > 2000) {
        await api('search/result', { hostId, id: job.id, token: job.token, results: result.results });
        searchJob = null; $('searchState').textContent = `已返回 ${result.results.length} 条搜索结果`;
        return;
      }
      searchSignature = signature;
    } else searchSignature = '';
    // A loaded search shell can stall without any cards. One ordinary reload
    // mirrors the user's working recovery, without stealing focus or looping.
    const elapsed = Date.now() - searchStarted;
    if (result?.shellReady && !result.wrongPage && !result.empty && !result.results?.length && !searchReloaded && elapsed >= 8000 && elapsed < 20000) {
      searchReloaded = true; searchSignature = '';
      $('searchState').textContent = 'B站列表暂未加载，正在自动刷新一次…';
      await chrome.tabs.reload(searchTab);
      return;
    }
    if (Date.now() - searchStarted > 25000) {
      await api('search/result', { hostId, id: job.id, token: job.token, error: '未能读取 B站搜索结果。请在主机点击「查看搜索页」，检查网络、登录或验证提示后重试。' });
      searchJob = null; $('searchState').textContent = '搜索未完成，请点击「查看搜索页」检查 B站页面';
    }
  } catch (error) { $('searchState').textContent = `搜索连接失败：${error.message}`; }
  finally { searchBusy = false; }
}
async function control(next) {
  if (!next.current || next.desired === 'stopped') { await closePlayer(); return; }
  const song = next.current;
  const url = new URL(song.url);
  url.searchParams.set('ktv_song', song.id);
  const existing = playerTab !== null ? await chrome.tabs.get(playerTab).catch(() => null) : null;
  if (!existing) {
    loadedResume = song.resumeTime;
    const tab = await chrome.tabs.create({ url: url.href, active: false });
    playerTab = tab.id; loadedId = song.id; navigatingAt = Date.now();
    await chrome.storage.session.set({ playerTab });
    // Isolate fullscreen to the dedicated player, keeping the controller available.
    await chrome.windows.create({ tabId: tab.id, type: 'popup', state: 'fullscreen', focused: true });
    return;
  }
  if (loadedId !== song.id) {
    let resume = song.resumeTime;
    if (song.resumeFrom === loadedId) {
      try {
        const position = await chrome.tabs.sendMessage(playerTab, { type: 'ktv-capture', id: loadedId });
        if (Number.isFinite(position?.time)) resume = position.time;
        else if (Number.isFinite(loadedResume)) resume = loadedResume;
      } catch {}
    }
    loadedResume = resume;
    loadedId = song.id; navigatingAt = Date.now();
    await chrome.tabs.update(playerTab, { url: url.href }); return;
  }
  try {
    const report = await chrome.tabs.sendMessage(playerTab, { type: 'ktv-control', id: song.id, desired: next.desired, resumeTime: loadedResume });
    if (!report) throw new Error('播放器未响应');
    if (report.ended) { draw(await api('action', { action: 'ended', id: song.id, hostId })); return; }
    if (report.wrongPage) {
      await chrome.tabs.update(playerTab, { url: url.href }); navigatingAt = Date.now(); return;
    }
    draw(await api('report', { hostId, id: song.id, ...report }));
  } catch (error) {
    if (Date.now() - navigatingAt > 20000) {
      await api('report', { hostId, id: song.id, message: '播放页未就绪：请检查 B站登录、网络或刷新播放页。也可以手动切歌。' });
    }
  }
}
async function poll() {
  if (!config || polling) return;
  polling = true;
  try {
    const next = hosting ? await api('host', { hostId }) : await api('state');
    draw(next);
    if (hosting) { searchStep(); await control(next); }
  } catch (error) {
    notice(`连接中断：${error.message}`);
    // Do not continue singing if the host lease may have been taken by another machine.
    if (hosting) { hosting = false; await closePlayer(); await closeSearch(); $('role').textContent = '已停止接管，请检查连接后重新接管'; $('claim').disabled = false; }
  } finally { polling = false; }
}
async function startTicks() {
  ticker?.abort();
  const controller = new AbortController(); ticker = controller;
  try {
    const response = await fetch(`${config.server}/api/ticks`, { headers: { 'x-room-key': config.key }, signal: controller.signal });
    if (!response.ok) throw new Error('播放心跳连接失败');
    const reader = response.body.getReader();
    while (hosting && !controller.signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('播放心跳已断开');
      await poll();
    }
    await reader.cancel();
  } catch (error) {
    if (controller.signal.aborted) return;
    hosting = false;
    while (polling) await new Promise(resolve => setTimeout(resolve, 50));
    await closePlayer(); await closeSearch(); $('claim').disabled = false; $('role').textContent = '主机连接已断开'; notice(`${error.message}，请重新接管。`);
  }
}
$('settings').onsubmit = async event => {
  event.preventDefault();
  if (hosting) return notice('请先停止接管，再更换房间。');
  try {
    const url = new URL($('server').value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('服务地址应为 http://主机IP:3210，不含其他路径');
    const allowed = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
    if (!allowed) throw new Error('需要允许扩展连接这个局域网地址');
    config = { server: url.origin, key: $('key').value.trim(), name: $('name').value.trim() || '朋友' };
    draw(await api('state')); await chrome.storage.local.set({ config }); notice('房间已连接。在 B站视频页或搜索结果旁可以点击 ＋点歌 / ↑置顶。');
  } catch (error) { notice(error.message); }
};
$('claim').onclick = async () => {
  if (polling) return notice('正在同步，请稍后再点接管。');
  try { draw(await api('host', { hostId })); hosting = true; notice('已接管。首次播放请在 B站页面点击「开始唱」。'); startTicks(); } catch (error) { notice(error.message); }
};
$('release').onclick = async () => {
  hosting = false;
  ticker?.abort();
  // An in-flight poll can still create/update a tab. Finish it before closing.
  while (polling) await new Promise(resolve => setTimeout(resolve, 50));
  await closePlayer();
  await closeSearch();
  try { draw(await api('release', { hostId })); notice('已停止接管，其他设备可以接管。'); } catch (error) { notice(error.message); }
};
$('focus').onclick = async () => { if (playerTab !== null) { const tab = await chrome.tabs.update(playerTab, { active: true }).catch(() => null); if (tab) await chrome.windows.update(tab.windowId, { focused: true, state: 'fullscreen' }); } else notice('尚未创建播放页。先接管播放并点一首歌。'); };
$('remote').onclick = () => { if (config) chrome.tabs.create({ url: config.server }); else notice('请先连接房间'); };
$('searchFocus').onclick = async () => { if (searchTab === null) return notice('搜索页将在朋友搜索时自动打开。'); const tab = await chrome.tabs.update(searchTab, { active: true }).catch(() => null); if (tab) await chrome.windows.update(tab.windowId, { focused: true }); };
for (const action of ['play', 'pause', 'next', 'stop']) $(action).onclick = async () => { try { draw(await api('action', { action, id: state?.current?.id, requestId: crypto.randomUUID() })); } catch (error) { notice(error.message); } };
chrome.tabs.onRemoved.addListener(tabId => { if (tabId !== playerTab) return; playerTab = null; loadedId = null; if (hosting) api('action', { action: 'stop' }).catch(error => notice(error.message)); });
// Closing the controller closes only the dedicated player. A browser crash also expires the server lease.
window.addEventListener('pagehide', () => { for (const id of [playerTab, searchTab]) if (id !== null) chrome.tabs.remove(id).catch(() => {}); });
(async () => {
  const ownTab = await chrome.tabs.getCurrent();
  await chrome.tabs.update(ownTab.id, { autoDiscardable: false });
  await chrome.storage.session.set({ controllerTab: ownTab.id });
  const saved = await chrome.storage.local.get('config');
  const session = await chrome.storage.session.get(['playerTab', 'searchTab']);
  if (session.searchTab !== undefined) { searchTab = session.searchTab; await closeSearch(); }
  if (session.playerTab !== undefined) { playerTab = session.playerTab; await closePlayer(); }
  if (saved.config) { config = saved.config; for (const key of ['server', 'key', 'name']) $(key).value = config[key]; await poll(); }
  setInterval(poll, 1000);
})();
