chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('console.html');
  const tabs = await chrome.tabs.query({ url });
  if (tabs[0]) { await chrome.tabs.update(tabs[0].id, { active: true }); await chrome.windows.update(tabs[0].windowId, { focused: true }); }
  else await chrome.tabs.create({ url });
});
chrome.tabs.onRemoved.addListener(async tabId => {
  const session = await chrome.storage.session.get(['controllerTab', 'playerTab', 'searchTab']);
  if (tabId === session.controllerTab) {
    for (const id of [session.playerTab, session.searchTab]) if (id !== undefined) await chrome.tabs.remove(id).catch(() => {});
    await chrome.storage.session.remove(['controllerTab', 'playerTab', 'searchTab']);
  }
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.type !== 'ktv-add') return;
  (async () => {
    if (!sender.tab || !/^https:\/\/(www|search)\.bilibili\.com\//.test(sender.url || '')) throw new Error('不支持的页面');
    const { config } = await chrome.storage.local.get('config');
    if (!config?.server) throw new Error('请先点击浏览器的 HomeKTV 图标，连接房间');
    const response = await fetch(`${config.server}/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-room-key': config.key }, body: JSON.stringify({ action: 'add', url: message.url, title: message.title, first: !!message.first, by: config.name || '朋友', requestId: message.requestId }), signal: AbortSignal.timeout(5000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '点歌失败');
    return { ok: true };
  })().then(reply, error => reply({ error: error.message }));
  return true;
});
