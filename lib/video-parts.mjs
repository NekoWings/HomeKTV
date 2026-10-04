import { normalizeVideo } from './room.mjs';

export function vocalType(title) {
  if (/off[\s_-]*vocal|vocal[\s_-]*off|オフボーカル|伴奏|无人声|無人声|instrumental/i.test(title)) return 'off';
  if (/on[\s_-]*vocal|vocal[\s_-]*on|オンボーカル|原唱|带人声|歌入り/i.test(title)) return 'on';
  return '';
}

export class VideoParts {
  constructor(fetcher = fetch, now = Date.now) { this.fetcher = fetcher; this.now = now; this.cache = new Map(); this.pending = new Map(); }
  async get(input) {
    const url = new URL(normalizeVideo(input));
    if (url.hostname === 'www.youtube.com') throw new Error('YouTube 视频不支持分P，请直接点歌');
    const id = url.pathname.split('/')[2];
    const cached = this.cache.get(id);
    if (cached && this.now() - cached.at < 300000) return cached.data;
    if (this.pending.has(id)) return this.pending.get(id);
    if (this.pending.size >= 4) throw new Error('正在读取其他歌曲版本，请稍后再试');
    const task = this.load(id).then(data => {
      if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(id, { at: this.now(), data }); return data;
    }).finally(() => this.pending.delete(id));
    this.pending.set(id, task); return task;
  }
  async load(id) {
    const endpoint = new URL('https://api.bilibili.com/x/web-interface/view');
    endpoint.searchParams.set(id.startsWith('BV') ? 'bvid' : 'aid', id.startsWith('BV') ? id : id.slice(2));
    let response, result;
    try { response = await this.fetcher(endpoint, { signal: AbortSignal.timeout(8000), redirect: 'error' }); if (response.ok) result = await response.json(); }
    catch { throw new Error('读取分P失败，请稍后重试，或在 B站选择分P后从链接添加'); }
    if (!response.ok || result?.code !== 0) throw new Error('B站暂未提供分P信息，请稍后重试，或在 B站选择分P后从链接添加');
    const data = result.data;
    if (!/^BV[0-9A-Za-z]{10}$/.test(data?.bvid || '') || !Array.isArray(data.pages)) throw new Error('视频分P信息不完整');
    const base = `https://www.bilibili.com/video/${data.bvid}/`;
    const parts = data.pages.filter(p => Number.isSafeInteger(p.page) && p.page > 0 && p.page <= 10000).map(p => {
      const title = String(p.part || `P${p.page}`).slice(0, 160);
      return { page: p.page, title, duration: Math.max(0, Number(p.duration) || 0), vocal: vocalType(title), url: normalizeVideo(`${base}?p=${p.page}`) };
    });
    if (!parts.length) throw new Error('这个视频没有可选择的分P');
    return { title: String(data.title || id).slice(0, 160), url: base, parts };
  }
}
