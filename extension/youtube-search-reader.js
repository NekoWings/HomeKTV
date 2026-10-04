// Read public search cards only; no cookies, private APIs or account data.
globalThis.readHomeKTVYouTubeSearch = function(document) {
  const results = [], seen = new Set();
  for (const card of document.querySelectorAll('ytd-video-renderer')) {
    const link = card.querySelector('a#video-title');
    let url;
    try { url = new URL(link?.href); } catch { continue; }
    const id = url.searchParams.get('v');
    if (url.hostname !== 'www.youtube.com' || url.pathname !== '/watch' || !/^[\w-]{11}$/.test(id || '') || seen.has(id)) continue;
    const title = (link.getAttribute('title') || link.textContent || '').trim();
    if (!title) continue;
    seen.add(id);
    results.push({ url: `https://www.youtube.com/watch?v=${id}`, title,
      author: card.querySelector('ytd-channel-name')?.textContent.trim() || '',
      duration: card.querySelector('ytd-thumbnail-overlay-time-status-renderer')?.textContent.trim() || '',
      cover: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` });
    if (results.length === 30) break;
  }
  const text = document.body?.innerText || '';
  const blocked = /unusual traffic|confirm you.re not a bot|Before you continue to YouTube|异常流量|異常流量|不是机器人|不是機器人|繼續使用 YouTube 前/i.test(text);
  return { results, blocked, shellReady: false, empty: !results.length && !blocked && /No results found|没有找到任何结果|找不到任何結果/i.test(text) };
};
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.type !== 'ktv-search-read') return;
  const url = new URL(location.href);
  if (url.hostname !== 'www.youtube.com' || url.pathname !== '/results' || url.searchParams.get('ktv_search') !== message.id || url.searchParams.get('search_query') !== message.query) return reply({ wrongPage: true });
  reply(globalThis.readHomeKTVYouTubeSearch(document));
});
