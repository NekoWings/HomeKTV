const $ = id => document.getElementById(id);
let config, state, hosting = false, polling = false, connecting = false, connected = false, playerTab = null, loadedId = null, navigatingAt = 0;
let ticker;
let loadedResume;
let searchTab = null, searchJob = null, searchBusy = false, searchStarted = 0, searchSignature = '', searchReloaded = false;
let hostId = crypto.randomUUID();
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
  if (!config) throw new Error('请先连接房间');
  const response = await fetch(`${config.server}/api/${route}`, { method: body ? 'POST' : 'GET', headers: { 'x-room-key': config.key, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(4500) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '房间连接失败');
  return result;
}
function draw(next) {
  state = next; connected = true;
  $('role').textContent = hosting ? '● 本机已是播放主机 · 控制台保持打开即可' : next.hostOnline ? '房间已有播放主机，这台电脑也可以只点歌。' : '房间已连接，等待播放主机启动。';
  $('hostBadge').textContent = hosting ? '主机已就绪' : next.hostOnline ? '其他主机在线' : '等待主机';
  $('hostBadge').classList.toggle('ready', hosting);
  $('setupProgress').textContent = hosting ? '已连接 → 本机负责播放 → 点歌页已准备好。' : config?.role === 'remote' ? '仅点歌模式：播放由房间内的主机负责。' : '已连接房间，可以启动本机播放。';
  $('connect').textContent = hosting ? '返回点歌页 ↗' : $('hostMode').checked ? '启动主机并去点歌 ↗' : '连接并去点歌 ↗';
  $('hostMode').disabled = hosting;
  for (const id of ['server', 'key', 'name']) $(id).disabled = hosting;
  $('remote').disabled = false;
  $('claim').hidden = hosting || config?.role === 'remote';
  $('guestOpen').hidden = hosting || !next.hostOnline || config?.role === 'remote';
  $('focus').disabled = !hosting;
  for (const id of ['play', 'pause', 'next', 'stop']) $(id).disabled = !next.current;
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
      const url = new URL(job.source === 'youtube' ? 'https://www.youtube.com/results' : 'https://search.bilibili.com/all');
      url.searchParams.set(job.source === 'youtube' ? 'search_query' : 'keyword', job.query);
      if (job.source !== 'youtube') url.searchParams.set('page', job.page); url.searchParams.set('ktv_search', job.id);
      if (tab) await chrome.tabs.update(searchTab, { url: url.href });
      else { searchTab = (await chrome.tabs.create({ url: url.href, active: false })).id; await chrome.storage.session.set({ searchTab }); }
      $('searchState').textContent = `正在帮朋友搜索：${job.query}`;
      return;
    }
    let result;
    try { result = await chrome.tabs.sendMessage(searchTab, { type: 'ktv-search-read', id: job.id, query: job.query }); } catch {}
    if (result?.blocked) {
      await api('search/result', { hostId, id: job.id, token: job.token, error: '视频来源显示验证或访问限制。请在主机点击「查看搜索页」，按页面提示处理后重新搜索。' });
      searchJob = null; $('searchState').textContent = '搜索页需要手动处理，请点击「查看搜索页」';
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
      $('searchState').textContent = '搜索列表暂未加载，正在自动刷新一次…';
      await chrome.tabs.reload(searchTab);
      return;
    }
    if (Date.now() - searchStarted > 25000) {
      await api('search/result', { hostId, id: job.id, token: job.token, error: '未能读取搜索结果。请在主机点击「查看搜索页」，检查网络、登录或验证提示后重试。' });
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
    const report = await chrome.tabs.sendMessage(playerTab, { type: 'ktv-control', id: song.id, desired: next.desired, resumeTime: loadedResume, seek: next.seek });
    if (!report) throw new Error('播放器未响应');
    if (report.ended) { draw(await api('action', { action: 'ended', id: song.id, hostId })); return; }
    if (report.wrongPage) {
      await chrome.tabs.update(playerTab, { url: url.href }); navigatingAt = Date.now(); return;
    }
    draw(await api('report', { hostId, id: song.id, ...report }));
  } catch (error) {
    if (Date.now() - navigatingAt > 20000) {
      await api('report', { hostId, id: song.id, message: '播放页未就绪：请检查视频网站登录、网络或刷新播放页。也可以手动切歌。' });
    }
  }
}
async function poll() {
  if (!config || polling || connecting) return;
  polling = true;
  try {
    const next = hosting ? await api('host', { hostId }) : await api('state');
    draw(next);
    if (hosting) { searchStep(); await control(next); }
  } catch (error) {
    notice(`连接中断：${error.message}`); connected = false;
    // Do not continue singing if the host lease may have been taken by another machine.
    if (hosting) { hosting = false; ticker?.abort(); await closePlayer(); await closeSearch(); }
    showSetupError(new Error('服务连接已断开。请确认播放电脑上的 npm start 仍在运行，然后点击恢复主机。'));
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
    await closePlayer(); await closeSearch(); showSetupError(new Error(`${error.message}，请点击恢复主机。`));
  }
}
async function openSongPage() {
  if (!config || !connected) throw new Error('请先连接房间');
  const tabs = await chrome.tabs.query({ url: `${config.server}/*` });
  const existing = tabs.find(tab => { try { const url = new URL(tab.url); return url.origin === config.server && url.pathname === '/'; } catch { return false; } });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
  } else await chrome.tabs.create({ url: config.server, active: true });
}
function showSetupError(error) {
  $('setupError').hidden = false;
  $('setupError').textContent = error.message;
  $('settingsDetails').open = true;
  $('hostMode').disabled = hosting;
  for (const id of ['server', 'key', 'name']) $(id).disabled = hosting;
  $('claim').hidden = !config || config.role === 'remote' || hosting;
  $('claim').disabled = false;
  $('release').disabled = !hosting;
  $('focus').disabled = !hosting;
  $('remote').disabled = !connected;
  if (!hosting) $('role').textContent = connected ? '房间已连接，本机尚未启动播放。' : '尚未连接房间，请检查下方提示。';
  $('connect').textContent = hosting ? '返回点歌页 ↗' : $('hostMode').checked ? '启动主机并去点歌 ↗' : '连接并去点歌 ↗';
  $('hostBadge').textContent = hosting ? '主机已就绪' : '需要处理';
  $('hostBadge').classList.toggle('ready', hosting);
  notice(error.message);
}
async function startHost() {
  // Serialize with any heartbeat so it cannot draw an outdated role or open a second player.
  while (polling) await new Promise(resolve => setTimeout(resolve, 50));
  const next = await api('host', { hostId });
  hosting = true;
  config.role = 'host'; config.autoHost = true;
  await chrome.storage.local.set({ config });
  $('setupError').hidden = true; $('settingsDetails').open = false;
  draw(next); startTicks();
  notice('本机已成为播放主机。去点歌页选歌，朋友在「邀请朋友」里扫码加入。');
  await openSongPage();
}
$('hostMode').onchange = () => { $('connect').textContent = $('hostMode').checked ? '启动主机并去点歌 ↗' : '连接并去点歌 ↗'; };
$('settings').onsubmit = async event => {
  event.preventDefault();
  if (connecting) return;
  if (hosting) { try { await openSongPage(); } catch (error) { showSetupError(error); } return; }
  connecting = true; $('connect').disabled = true; $('setupError').hidden = true;
  try {
    const url = new URL($('server').value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('服务地址应为 http://主机IP:3210，不含其他路径');
    const allowed = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
    if (!allowed) throw new Error('需要允许扩展连接这个局域网地址');
    while (polling) await new Promise(resolve => setTimeout(resolve, 50));
    connected = false;
    config = { server: url.origin, key: $('key').value.trim(), name: $('name').value.trim() || '朋友', role: $('hostMode').checked ? 'host' : 'remote', autoHost: $('hostMode').checked };
    try { draw(await api('state')); }
    catch (error) { if (error instanceof TypeError) throw new Error('找不到房间服务。请先在播放电脑的 HomeKTV 文件夹运行 npm start，再重试；如服务在另一台电脑，请检查服务地址。'); throw error; }
    await chrome.storage.local.set({ config });
    if (config.role === 'host') await startHost();
    else { notice('已连接，播放由房间内的主机负责。'); await openSongPage(); }
  } catch (error) { showSetupError(error); }
  finally { connecting = false; $('connect').disabled = false; }
};
$('claim').onclick = async () => {
  if (connecting) return;
  connecting = true;
  try { await startHost(); } catch (error) { showSetupError(error); }
  finally { connecting = false; }
};
$('guestOpen').onclick = async () => {
  if (!config || hosting || connecting) return;
  config.role = 'remote'; config.autoHost = false; $('hostMode').checked = false;
  try { await chrome.storage.local.set({ config }); $('setupError').hidden = true; draw(await api('state')); await openSongPage(); }
  catch (error) { showSetupError(error); }
};
$('release').onclick = async () => {
  if (connecting) return;
  connecting = true;
  hosting = false;
  ticker?.abort();
  // An in-flight poll can still create/update a tab. Finish it before closing.
  while (polling) await new Promise(resolve => setTimeout(resolve, 50));
  await closePlayer();
  await closeSearch();
  try { config.autoHost = false; await chrome.storage.local.set({ config }); draw(await api('release', { hostId })); notice('已停止本机播放，不会自动重新启动。要继续时点击「恢复主机并去点歌」。'); } catch (error) { showSetupError(error); }
  finally { connecting = false; }
};
$('focus').onclick = async () => { if (playerTab !== null) { const tab = await chrome.tabs.update(playerTab, { active: true }).catch(() => null); if (tab) await chrome.windows.update(tab.windowId, { focused: true, state: 'fullscreen' }); } else notice('尚未创建播放页。先启动主机并点一首歌。'); };
$('remote').onclick = async () => { try { await openSongPage(); } catch (error) { showSetupError(error); } };
$('searchFocus').onclick = async () => { if (searchTab === null) return notice('搜索页将在朋友搜索时自动打开。'); const tab = await chrome.tabs.update(searchTab, { active: true }).catch(() => null); if (tab) await chrome.windows.update(tab.windowId, { focused: true }); };
for (const action of ['play', 'pause', 'next', 'stop']) $(action).onclick = async () => { try { draw(await api('action', { action, id: state?.current?.id, requestId: crypto.randomUUID() })); } catch (error) { notice(error.message); } };
chrome.tabs.onRemoved.addListener(tabId => { if (tabId !== playerTab) return; playerTab = null; loadedId = null; if (hosting) api('action', { action: 'stop' }).catch(error => notice(error.message)); });
// Closing the controller closes only the dedicated player. A browser crash also expires the server lease.
window.addEventListener('pagehide', () => { for (const id of [playerTab, searchTab]) if (id !== null) chrome.tabs.remove(id).catch(() => {}); });
(async () => {
  const ownTab = await chrome.tabs.getCurrent();
  await chrome.tabs.update(ownTab.id, { autoDiscardable: false });
  const saved = await chrome.storage.local.get('config');
  const session = await chrome.storage.session.get(['controllerTab', 'hostId', 'playerTab', 'searchTab']);
  if (session.controllerTab === ownTab.id && session.hostId) hostId = session.hostId;
  await chrome.storage.session.set({ controllerTab: ownTab.id, hostId });
  if (session.searchTab !== undefined) { searchTab = session.searchTab; await closeSearch(); }
  if (session.playerTab !== undefined) { playerTab = session.playerTab; await closePlayer(); }
  if (saved.config) {
    config = saved.config;
    for (const key of ['server', 'key', 'name']) $(key).value = config[key] || '';
    $('hostMode').checked = config.role !== 'remote';
    connecting = true;
    try {
      const allowed = await chrome.permissions.contains({ origins: [`${config.server}/*`] });
      if (!allowed) throw new Error('请点击「启动主机并去点歌」，允许扩展连接房间。');
      draw(await api('state'));
      if (config.role !== 'remote' && config.autoHost !== false) await startHost();
    } catch (error) { showSetupError(error); }
    finally { connecting = false; }
  }
  setInterval(poll, 1000);
})();
