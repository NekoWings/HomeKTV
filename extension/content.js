(() => {
  // Only this explicitly marked, extension-created tab is controlled as the KTV player.
  const original = new URL(location.href);
  const managedId = original.searchParams.get('ktv_song');
  const originalVideo = original.pathname;
  const originalPart = original.searchParams.get('p') || '1';
  let resumeApplied = false, resumePending = false;
  let showSongButtons = false, panelHost;
  function setSongButtons(enabled) {
    showSongButtons = enabled;
    if (managedId) return;
    if (panelHost) panelHost.hidden = !enabled || !/\/video\//.test(location.pathname);
    if (!enabled) {
      document.querySelectorAll('.home-ktv-song-buttons').forEach(node => node.remove());
      document.querySelectorAll('a[data-home-ktv]').forEach(link => delete link.dataset.homeKtv);
    } else decorate();
  }
  chrome.storage.local.get('showSongButtons').then(saved => setSongButtons(saved.showSongButtons !== false));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.showSongButtons) setSongButtons(changes.showSongButtons.newValue !== false);
  });
  let lastCommand = 0, wanted = 'paused', attached = new WeakSet(), ended = false, armed = false, started = false, panel;
  const videos = () => [...document.querySelectorAll('video')];
  const mainVideo = () => document.querySelector('.bpx-player-video-wrap video, .bilibili-player-video video') || videos().find(v => v.getBoundingClientRect().width > 250) || videos()[0];
  function attach(video) {
    if (attached.has(video)) return; attached.add(video);
    video.addEventListener('ended', event => {
      if (!managedId || !armed || !started || resumePending || video !== mainVideo()) return;
      ended = true; wanted = 'paused'; video.pause();
      // Prevent B站's bubble-phase ended handler from advancing its own playlist.
      event.stopImmediatePropagation();
    }, true);
    video.addEventListener('play', () => {
      if (managedId && (!armed || ended || resumePending || wanted !== 'playing' || Date.now() - lastCommand > 10000)) video.pause();
    }, true);
    video.addEventListener('timeupdate', () => { if (armed && !video.paused && video.currentTime > 0.1) started = true; });
  }
  function show(message) { if (panel) panel.querySelector('.message').textContent = message; }
  function buildPanel() {
    if (panel || !document.body) return;
    const host = document.createElement('div');
    panelHost = host;
    host.style.cssText = 'position:fixed;right:18px;bottom:22px;z-index:2147483647;';
    panel = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style'); style.textContent = ':host{all:initial}aside{font:13px/1.5 system-ui;background:#171721;color:#fff;padding:14px;border:1px solid #5b5b70;border-radius:12px;max-width:300px;box-shadow:0 8px 30px #0005}strong{color:#c6fb78}.message{font-size:12px;margin:6px 0;overflow-wrap:anywhere}button{cursor:pointer;background:#c6fb78;color:#20251b;border:0;border-radius:6px;padding:7px 9px;font:600 12px system-ui;margin:4px 5px 0 0}';
    const box = document.createElement('aside'), title = document.createElement('strong'), msg = document.createElement('div');
    title.textContent = managedId ? 'HomeKTV · 专用播放页' : 'HomeKTV · 点歌'; msg.className = 'message'; msg.textContent = managedId ? '等待主机控制台…' : '当前视频加入客厅歌单'; box.append(title, msg);
    if (managedId) {
      const start = document.createElement('button'); start.textContent = '▶ 开始唱 / 允许声音'; start.onclick = async () => { const video = mainVideo(); if (!video) return show('视频还未加载，请稍后重试'); if (Date.now() - lastCommand > 10000) return show('请先在控制台接管播放'); wanted = 'playing'; video.muted = false; if (video.volume === 0) video.volume = 0.8; try { await video.play(); show('已启用声音'); } catch (error) { show(error.message); } }; box.append(start);
      const full = document.createElement('button'); full.textContent = '网页全屏'; full.onclick = () => { const button = document.querySelector('.bpx-player-ctrl-web, .bilibili-player-video-web-fullscreen'); if (button) button.click(); else show('请使用 B站播放器的网页全屏按钮'); }; box.append(full);
    } else for (const first of [false, true]) { const button = document.createElement('button'); button.textContent = first ? '↑ 下一首唱' : '＋ 加入歌单'; button.onclick = () => add(location.href, document.querySelector('h1')?.textContent || document.title.replace(/_哔哩哔哩.*$/, ''), first, button); box.append(button); }
    panel.append(style, box); document.body.append(host);
    if (!managedId && (!showSongButtons || !/\/video\//.test(location.pathname))) host.hidden = true;
  }
  async function add(url, title, first, button) {
    button.disabled = true; const label = button.textContent;
    try { const result = await chrome.runtime.sendMessage({ type: 'ktv-add', url, title: String(title || '').trim().slice(0, 160), first, requestId: crypto.randomUUID() }); if (result.error) throw new Error(result.error); button.textContent = '✓ 已点'; show('已加入客厅歌单'); }
    catch (error) { show(error.message); button.textContent = '连接失败'; alert(`HomeKTV：${error.message}`); }
    setTimeout(() => { button.textContent = label; button.disabled = false; }, 1500);
  }
  function decorate() {
    if (managedId || !showSongButtons) return;
    // Place beside video title links, including search results and recommended cards.
    for (const link of document.querySelectorAll('a[href*="/video/"]')) {
      if (link.dataset.homeKtv || !link.textContent.trim() || link.querySelector('img,video')) continue;
      if (!/^https:\/\/(www\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]{10}|av\d+)/.test(link.href)) continue;
      link.dataset.homeKtv = '1';
      const container = document.createElement('span'); container.style.cssText = 'display:inline-flex;gap:4px;position:relative;z-index:20;margin:4px;';
      container.className = 'home-ktv-song-buttons';
      for (const first of [false, true]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = first ? '↑置顶' : '＋点歌'; button.style.cssText = 'background:#17231c;color:#c6fb78;border:1px solid #6b8d42;border-radius:5px;padding:3px 7px;cursor:pointer;font:12px system-ui;white-space:nowrap;';
        button.onclick = event => { event.preventDefault(); event.stopPropagation(); add(link.href, link.getAttribute('title') || link.textContent, first, button); }; container.append(button);
      }
      link.insertAdjacentElement('afterend', container);
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message.type === 'ktv-capture' && managedId && message.id === managedId) {
      wanted = 'paused';
      const video = mainVideo();
      videos().forEach(v => v.pause());
      reply({ time: video && video.readyState >= 1 && !resumePending ? video.currentTime : undefined });
      return;
    }
    if (message.type !== 'ktv-control' || !managedId || message.id !== managedId) return;
    lastCommand = Date.now(); armed = true; wanted = message.desired;
    if (ended) { videos().forEach(v => v.pause()); reply({ ended: true }); return; }
    const current = new URL(location.href);
    if (current.pathname !== originalVideo || (current.searchParams.get('p') || '1') !== originalPart) { videos().forEach(v => v.pause()); reply({ wrongPage: true }); return; }
    const video = mainVideo();
    if (!video) { reply({ message: '等待 B站视频加载；若持续等待，请检查登录或手动切歌' }); return; }
    attach(video);
    (async () => {
      if (Number.isFinite(message.resumeTime) && message.resumeTime > 0 && !resumeApplied) {
        resumePending = true;
        video.pause();
        if (video.readyState < 1 || !Number.isFinite(video.duration) || video.duration <= 0) return { message: '等待新版本加载，以恢复进度' };
        // Seek once. Subsequent heartbeats must not keep rewinding the player.
        video.currentTime = Math.min(message.resumeTime, Math.max(0, video.duration - 0.5));
        resumeApplied = true;
      }
      if (resumePending) {
        video.pause();
        if (video.seeking || video.readyState < 2) return { message: '正在定位到切换前的进度' };
        resumePending = false;
      }
      let messageText;
      if (wanted !== 'playing') { video.pause(); messageText = '已暂停'; }
      else if (video.error) messageText = '视频加载失败，请检查网络或切歌';
      else {
        video.muted = false;
        try { await Promise.race([video.play(), new Promise((_, reject) => setTimeout(() => reject(new Error('视频缓冲中')), 2000))]); messageText = video.readyState >= 3 ? '正在播放' : '正在缓冲'; }
        catch (error) { messageText = error.name === 'NotAllowedError' ? '请在播放页点击「开始唱 / 允许声音」' : error.message; }
      }
      show(messageText); return { message: messageText, time: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : 0 };
    })().then(reply, error => reply({ message: error.message }));
    return true;
  });
  const observer = new MutationObserver(() => { if (managedId) videos().forEach(attach); });
  observer.observe(document, { childList: true, subtree: true });
  setInterval(() => {
    buildPanel();
    if (managedId) { videos().forEach(attach); if (ended || Date.now() - lastCommand > 10000) videos().forEach(v => v.pause()); }
    else decorate();
  }, 1000);
})();
