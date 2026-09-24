// Read only visible page content. No cookies, page internals or private APIs are exported.
globalThis.readHomeKTVSearch = function(document) {
  const items = [], seen = new Set();
  for (const card of document.querySelectorAll('.bili-video-card')) {
    const heading = card.querySelector('h3');
    const link = heading?.closest('a') || card.querySelector('a[href*="/video/"]');
    if (!link || !heading) continue;
    const id = link.href.match(/^https:\/\/www\.bilibili\.com\/video\/(BV[0-9A-Za-z]{10})\//)?.[1];
    if (!id || seen.has(id)) continue;
    const title = (heading.getAttribute('title') || heading.textContent).trim();
    if (!title) continue;
    seen.add(id);
    const img = card.querySelector('picture img');
    const src = img?.getAttribute('src') || '';
    items.push({ url: `https://www.bilibili.com/video/${id}/`, title,
      author: card.querySelector('.bili-video-card__info--author')?.textContent.trim() || '',
      duration: card.querySelector('.bili-video-card__stats__duration')?.textContent.trim() || '',
      cover: src.startsWith('//') ? `https:${src}` : src });
    if (items.length === 30) break;
  }
  const text = document.body?.innerText || '';
  const blocked = /安全验证|请完成验证|访问过于频繁|请求被拦截|验证后继续访问/.test(text);
  return { results: items, blocked,
    shellReady: document.readyState !== 'loading' && !!document.querySelector('input') && /综合排序|最多播放/.test(text),
    empty: !items.length && !blocked && /没有找到|未找到|暂无搜索结果|没有相关/.test(text) };
};
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.type !== 'ktv-search-read') return;
  const url = new URL(location.href);
  if (url.hostname !== 'search.bilibili.com' || url.searchParams.get('ktv_search') !== message.id || url.searchParams.get('keyword') !== message.query) { reply({ wrongPage: true }); return; }
  reply(globalThis.readHomeKTVSearch(document));
});
