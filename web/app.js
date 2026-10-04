const $ = id => document.getElementById(id);
let selectedInviteUrl = '';
function showInvite(url) {
  selectedInviteUrl = url || '';
  $('inviteUrl').hidden = $('inviteQr').hidden = !url;
  if (!url) {
    $('inviteUrl').removeAttribute('href');
    $('inviteUrl').textContent = '';
    $('inviteQr').replaceChildren();
    return;
  }
  $('inviteUrl').href = url;
  $('inviteUrl').textContent = url;
  $('inviteAddress').value = url;
  const code = qrcode(0, 'M');
  code.addData(url);
  code.make();
  $('inviteQr').innerHTML = code.createSvgTag({ cellSize: 4, margin: 16, alt: '扫码打开手机点歌页' });
}
async function refreshInvite() {
  try {
    const { urls } = await api('invite');
    const selected = urls.includes(selectedInviteUrl) ? selectedInviteUrl : urls[0];
    $('inviteAddress').replaceChildren(...urls.map(url => {
      const option = document.createElement('option'); option.value = option.textContent = url; return option;
    }));
    $('inviteChoice').hidden = urls.length < 2;
    if ((selected || '') !== selectedInviteUrl) showInvite(selected);
    $('inviteAddress').value = selected || '';
    $('inviteHint').textContent = urls.length ? '地址和二维码自动更新；多网卡时请选择与手机同网段的地址。' : '未检测到局域网地址，请将主机连接到家庭 Wi-Fi 或以太网。';
  } catch {
    showInvite();
    $('inviteChoice').hidden = true;
    $('inviteHint').textContent = '无法获取主机地址，正在重试…';
  }
}
$('inviteAddress').onchange = event => showInvite(event.target.value);
let key = sessionStorage.getItem('ktv-key') || '', state, busy = false, joined = false, keyRequired = true;
$('name').value = localStorage.getItem('ktv-name') || '';
$('nickname').value = $('name').value;
$('nickname').onchange = () => localStorage.setItem('ktv-name', $('nickname').value.trim());
let noticeTimer;
function notice(message) {
  $('notice').textContent = message; $('notice').hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 4500);
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`); svg.append(use); return svg;
}
function songButton(label, symbol, handler, className = '') {
  const button = document.createElement('button'); button.type = 'button'; button.className = className;
  button.append(icon(symbol), document.createTextNode(label)); button.onclick = handler; return button;
}
function timeLabel(time) { const seconds = Math.max(0, Math.floor(Number(time) || 0)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
function hideRoom() {
  $('room').hidden = $('player').hidden = true; $('join').hidden = false;
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
}
for (const [trigger, dialog] of [['inviteOpen', 'inviteDialog'], ['linkOpen', 'linkDialog'], ['profileOpen', 'profileDialog'], ['moreOpen', 'moreDialog']]) {
  $(trigger).onclick = () => { if (dialog === 'linkDialog') $('linkMessage').hidden = true; $(dialog).showModal(); };
}
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => $(button.dataset.close).close();
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
});
const narrowLayout = matchMedia('(max-width: 800px)');
function dockQueue() {
  if (!narrowLayout.matches && $('queueDialog').open) $('queueDialog').close();
  (narrowLayout.matches ? $('queueDialog') : $('queueDock')).append($('queuePanel'));
}
narrowLayout.addEventListener('change', dockQueue); dockQueue();
function openQueue() {
  if (narrowLayout.matches) { if (!$('queueDialog').open) $('queueDialog').showModal(); }
  else $('queueTab').focus();
}
$('queueOpen').onclick = $('playerQueueOpen').onclick = openQueue;
$('queueClose').onclick = () => $('queueDialog').close();
function setQueueTab(history) {
  $('queuedPane').hidden = history; $('historyPane').hidden = !history;
  for (const [id, selected] of [['queueTab', !history], ['historyTab', history]]) {
    $(id).classList.toggle('active', selected); $(id).setAttribute('aria-selected', String(selected)); $(id).tabIndex = selected ? 0 : -1;
  }
}
$('queueTab').onclick = () => setQueueTab(false); $('historyTab').onclick = () => setQueueTab(true);
for (const id of ['queueTab', 'historyTab']) $(id).onkeydown = event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault(); const history = event.key === 'End' || (event.key !== 'Home' && id === 'queueTab');
  setQueueTab(history); $(history ? 'historyTab' : 'queueTab').focus();
};
let setlistSignature = '';
function drawSetlist(next) {
  const history = next.history || [];
  $('count').textContent = $('mobileCount').textContent = $('playerCount').textContent = next.queue.length;
  $('historyCount').textContent = history.length; $('playerQueueOpen').setAttribute('aria-label', `查看歌单，${next.queue.length}首待唱`);
  $('queueSummary').textContent = next.queue.length ? `${next.queue.length} 首待唱 · 按顺序播放` : '按点歌顺序播放';
  $('queueNow').hidden = !next.current;
  $('queueCurrent').textContent = next.current?.title || ''; $('queueCurrent').title = next.current?.title || '';
  $('queueBy').textContent = next.current ? `${next.current.by} 点的` : '';
  $('queuePanel').classList.toggle('paused', next.desired !== 'playing' || !next.hostOnline);
  const signature = JSON.stringify([next.queue, history]);
  // Keep scroll and keyboard focus stable while the playback heartbeat updates.
  if (signature === setlistSignature) return; setlistSignature = signature;
  $('empty').hidden = next.queue.length > 0; $('historyEmpty').hidden = history.length > 0;
  function row(song, index, past) {
    const li = document.createElement('li'); li.className = 'song-row';
    const number = document.createElement('span'); number.className = 'number'; number.textContent = String(index + 1).padStart(2, '0');
    const info = document.createElement('div'); info.className = 'song-info';
    const link = document.createElement('a'); link.textContent = song.title; link.href = song.url; link.target = '_blank'; link.rel = 'noreferrer';
    const by = document.createElement('small'); by.textContent = `${song.by} 点的${past ? ` · ${song.outcome === 'skipped' ? '已切歌' : '已唱完'}` : ''}`;
    info.append(link, by); const actions = document.createElement('div'); actions.className = 'song-actions';
    if (past) {
      for (const first of [false, true]) {
        const button = songButton(first ? '下一首唱' : '再唱一次', first ? 'next' : 'repeat', async () => {
          button.disabled = true; await act({ action: 'replay', id: song.id, first, by: localStorage.getItem('ktv-name') || '朋友' }, '已再次加入歌单'); button.disabled = false;
        }); actions.append(button);
      }
    } else {
      actions.append(songButton('下一首', 'up', () => act({ action: 'top', id: song.id }, '已安排为下一首')),
        songButton('版本', 'sliders', () => selectPart(song, { switching: true })),
        songButton('移除', 'close', () => act({ action: 'remove', id: song.id }, '已移除歌曲')));
    }
    li.append(number, info, actions); return li;
  }
  $('queue').replaceChildren(...next.queue.map((song, index) => row(song, index, false)));
  $('history').replaceChildren(...history.map((song, index) => row(song, index, true)));
}
async function api(path, body) {
  const response = await fetch(`/api/${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-room-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(path === 'video/parts' ? 10000 : 5000) });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || '连接失败'); error.status = response.status; throw error; }
  return result;
}
function render(next) {
  state = next; joined = true;
  $('join').hidden = true; $('room').hidden = $('player').hidden = false;
  $('inviteKey').textContent = keyRequired ? `房间口令：${key}` : '免口令 · 扫码即可点歌';
  $('connection').textContent = next.hostOnline ? '主机在线' : '主机离线';
  $('connection').classList.toggle('online', next.hostOnline);
  $('current').textContent = next.current?.title || '还没有点歌'; $('current').title = next.current?.title || '';
  for (const id of ['play', 'pause', 'next', 'stop', 'currentPart', 'moreOpen']) $(id).disabled = !next.current;
  const playing = next.desired === 'playing'; $('play').hidden = playing; $('pause').hidden = !playing;
  const status = next.hostOnline ? `${next.status.message || '等待播放'}${next.desired === 'paused' ? ' · 已暂停' : next.desired === 'stopped' ? ' · 已关闭播放' : ''}` : '主机离线 · 请在扩展控制台接管播放';
  $('status').textContent = $('status').title = status;
  $('progress').max = next.status.duration || 1; $('progress').value = next.status.time || 0;
  $('elapsed').textContent = timeLabel(next.status.time); $('duration').textContent = timeLabel(next.status.duration);
  drawSetlist(next);
}
async function refresh() { if (!joined || busy) return; busy = true; try { render(await api('state')); } catch (error) { $('connection').textContent = '连接中断'; $('connection').classList.remove('online'); notice(error.message); if (error.status === 401) { joined = false; keyRequired = true; $('keyField').hidden = false; $('key').required = true; $('joinHint').textContent = '本房间已启用口令，请输入主机设置的口令。'; hideRoom(); $('inviteKey').textContent = '本房间已启用口令，请输入口令加入。'; } } finally { busy = false; } }
async function act(body, message = '已更新歌单') { try { render(await api('action', { ...body, requestId: `${Date.now()}-${Math.random()}` })); notice(message); } catch (error) { notice(error.message); } }
$('joinForm').onsubmit = async event => { event.preventDefault(); key = $('key').value.trim(); localStorage.setItem('ktv-name', $('name').value.trim()); $('nickname').value = $('name').value.trim(); try { render(await api('state')); sessionStorage.setItem('ktv-key', key); notice('已加入房间，开始点歌吧。'); } catch (error) { notice(error.message); key = ''; } };
async function add(first) {
  if (!$('addForm').reportValidity()) return;
  $('linkMessage').hidden = true;
  const buttons = [...$('addForm').querySelectorAll('button')]; buttons.forEach(x => x.disabled = true);
  try { render(await api('action', { action: 'add', url: $('url').value, title: $('title').value.trim(), by: localStorage.getItem('ktv-name') || '朋友', first, requestId: `${Date.now()}-${Math.random()}` })); $('url').value = ''; $('title').value = ''; $('linkDialog').close(); notice('已加入歌单'); } catch (error) { $('linkMessage').hidden = false; $('linkMessage').textContent = error.message; notice(error.message); } finally { buttons.forEach(x => x.disabled = false); }
}
$('addForm').onsubmit = event => { event.preventDefault(); add(false); }; $('first').onclick = () => add(true);
for (const action of ['play', 'pause', 'next', 'stop']) $(action).onclick = async () => {
  const button = $(action); button.disabled = true;
  await act({ action, id: state?.current?.id }, { play: '已请求播放', pause: '已请求暂停', next: '已切换下一首', stop: '已关闭播放页' }[action]);
  if (action === 'stop') $('moreDialog').close(); button.disabled = !state?.current;
};
$('leave').onclick = () => { joined = false; key = ''; sessionStorage.removeItem('ktv-key'); hideRoom(); $('connection').textContent = '未加入'; $('connection').classList.remove('online'); $('inviteKey').textContent = keyRequired ? '加入房间后，这里会显示房间口令。' : '免口令 · 扫码即可点歌'; };
async function connect() {
  try {
    ({ keyRequired } = await api('info'));
    $('keyField').hidden = !keyRequired;
    $('key').required = keyRequired;
    $('joinHint').textContent = keyRequired ? '本房间已启用口令，请输入主机设置的口令。' : '家庭模式无需口令，直接加入即可。';
    $('inviteKey').textContent = keyRequired ? '加入房间后，这里会显示房间口令。' : '免口令 · 扫码即可点歌';
    if (!keyRequired) { key = ''; sessionStorage.removeItem('ktv-key'); }
    if (!keyRequired || key) { joined = true; await refresh(); }
  } catch (error) { notice(`连接失败：${error.message}，请刷新重试。`); }
}
connect(); setInterval(refresh, 1500);
refreshInvite(); setInterval(refreshInvite, 10000);

let searchGeneration = 0, searchRequest, searchPage = 1;
function showSearchResults(results) {
  $('searchResults').replaceChildren(...results.map(song => {
    const card = document.createElement('article'); card.className = 'search-result';
    const cover = document.createElement('div'); cover.className = 'result-cover'; cover.append(icon('mic'));
    if (song.cover) { const image = document.createElement('img'); image.src = song.cover; image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer'; image.onerror = () => { image.remove(); cover.append(icon('mic')); }; cover.replaceChildren(image); }
    const info = document.createElement('div'); info.className = 'search-result-info';
    const title = document.createElement('a'); title.href = song.url; title.target = '_blank'; title.rel = 'noreferrer'; title.textContent = song.title;
    const meta = document.createElement('p'); meta.className = 'muted small'; meta.textContent = [song.author, song.duration].filter(Boolean).join(' · ');
    const actions = document.createElement('div'); actions.className = 'controls';
    for (const first of [false, true]) actions.append(songButton(first ? '下一首唱' : '点歌', first ? 'next' : 'plus', () => selectPart(song, { first }), first ? '' : 'primary'));
    info.append(title, meta, actions); card.append(cover, info); return card;
  }));
}
async function search(page = 1, newQuery = false) {
  if (newQuery) { searchRequest = { query: $('searchQuery').value.trim(), mode: $('searchMode').value }; localStorage.setItem('ktv-search-mode', searchRequest.mode); }
  if (!searchRequest?.query) return;
  const generation = ++searchGeneration; $('searchWelcome').hidden = true; $('resultsScroll').scrollTop = 0;
  $('searchSubmit').disabled = true; $('searchPrev').hidden = true; $('searchNext').hidden = true; $('searchPage').textContent = '';
  $('searchResults').replaceChildren(); $('searchMessage').textContent = '正在请主机找歌，首次搜索可能需要几秒…';
  try {
    let job = await api('search', { ...searchRequest, page });
    const deadline = Date.now() + 50000;
    while (['queued', 'running'].includes(job.status)) {
      if (generation !== searchGeneration) return;
      if (Date.now() > deadline) throw new Error('等待搜索超时，请检查主机插件是否已更新并接管播放');
      $('searchMessage').textContent = job.status === 'queued' ? '搜索已排队，等待主机处理…' : '主机正在读取 B站搜索结果…';
      await new Promise(resolve => setTimeout(resolve, 1000)); job = await api(`search/${job.id}`);
    }
    if (generation !== searchGeneration) return;
    if (job.status === 'error') throw new Error(job.error);
    searchPage = page; showSearchResults(job.results || []);
    $('searchMessage').textContent = job.results.length ? `找到 ${job.results.length} 个视频，多分P歌曲点歌时可选 On / Off Vocal 或其他版本。` : '没有找到相关视频，试试更短的歌名，或切换搜索模式。';
    $('searchPage').textContent = `第 ${page} 页`; $('searchPrev').hidden = page === 1; $('searchNext').hidden = page >= 10 || !job.results.length;
  } catch (error) { if (generation === searchGeneration) $('searchMessage').textContent = error.message; }
  finally { if (generation === searchGeneration) $('searchSubmit').disabled = false; }
}
$('searchForm').onsubmit = event => { event.preventDefault(); search(1, true); };
$('searchPrev').onclick = () => search(searchPage - 1);
$('searchNext').onclick = () => search(searchPage + 1);

const savedMode = localStorage.getItem('ktv-search-mode');
if (['ktv', 'nicokara', 'plain'].includes(savedMode)) $('searchMode').value = savedMode;
for (const button of document.querySelectorAll('[data-query]')) button.onclick = () => {
  $('searchQuery').value = button.dataset.query; if (button.dataset.mode) $('searchMode').value = button.dataset.mode;
  search(1, true);
};
let partSelection = 0;
$('partsClose').onclick = () => $('partsDialog').close();
$('partsDialog').addEventListener('close', () => { partSelection++; });
$('currentPart').onclick = () => { if (state?.current) selectPart(state.current, { switching: true }); };
async function selectPart(song, { first = false, switching = false } = {}) {
  const selection = ++partSelection;
  $('partsSong').textContent = song.title;
  $('partsStatus').textContent = '正在读取视频版本…';
  $('partsList').replaceChildren(); $('partsFilterLabel').hidden = true; $('partsFilter').value = ''; $('partsFallback').hidden = true;
  if (!$('partsDialog').open) $('partsDialog').showModal();
  let submitting = false;
  async function choose(part, baseTitle, multi) {
    if (submitting || selection !== partSelection) return;
    submitting = true;
    const title = multi ? `${baseTitle} · P${part.page} ${part.title}` : baseTitle;
    $('partsStatus').textContent = switching ? '正在切换版本…' : '正在点歌…';
    for (const button of $('partsList').querySelectorAll('button')) button.disabled = true;
    $('partsFallback').disabled = true;
    try {
      const next = await api('action', { action: switching ? 'part' : 'add', id: song.id, url: part.url, title, baseTitle, first, by: localStorage.getItem('ktv-name') || '朋友', requestId: `${Date.now()}-${Math.random()}` });
      render(next);
      const message = switching ? `已选择版本：${part.title}` : `已点：${title}`;
      notice(message); $('searchMessage').textContent = message;
      if (selection === partSelection) $('partsDialog').close();
    } catch (error) {
      if (selection === partSelection) { $('partsStatus').textContent = error.message; for (const button of $('partsList').querySelectorAll('button')) button.disabled = false; }
    } finally { submitting = false; $('partsFallback').disabled = false; }
  }
  try {
    const data = await api('video/parts', { url: song.url });
    if (selection !== partSelection) return;
    if (data.parts.length === 1 && !switching) { await choose(data.parts[0], data.title, false); return; }
    $('partsStatus').textContent = `共 ${data.parts.length} 个版本 / 分P，请选择。`;
    $('partsFilterLabel').hidden = data.parts.length < 6;
    const drawParts = () => {
      const query = $('partsFilter').value.trim().toLowerCase();
      const matches = data.parts.filter(part => `${part.page} ${part.title} ${part.vocal === 'off' ? '伴奏 Off Vocal' : part.vocal === 'on' ? '带人声 On Vocal' : ''}`.toLowerCase().includes(query));
      $('partsList').replaceChildren(...matches.map(part => {
        const button = document.createElement('button'); button.className = 'part-option';
        const name = document.createElement('strong'); name.textContent = `P${part.page} · ${part.title}`;
        const detail = document.createElement('span'); detail.className = 'muted small';
        const minutes = Math.floor(part.duration / 60), seconds = Math.floor(part.duration % 60);
        detail.textContent = [part.vocal === 'off' ? 'Off Vocal · 伴奏' : part.vocal === 'on' ? 'On Vocal · 带人声' : '其他版本', `${minutes}:${String(seconds).padStart(2, '0')}`, switching && part.url === song.url ? '当前版本' : ''].filter(Boolean).join(' · ');
        button.append(name, detail); button.disabled = switching && part.url === song.url;
        button.onclick = () => choose(part, data.title, data.parts.length > 1); return button;
      }));
      if (!matches.length) $('partsList').textContent = '没有匹配的分P，请换个关键词。';
    };
    $('partsFilter').oninput = drawParts; drawParts();
  } catch (error) {
    if (selection !== partSelection) return;
    $('partsStatus').textContent = error.message;
    if (!switching) { $('partsFallback').hidden = false; $('partsFallback').onclick = () => choose({ url: song.url, title: song.title }, song.title, false); }
  }
}
