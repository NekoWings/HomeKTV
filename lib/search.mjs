import { randomUUID } from 'node:crypto';
import { normalizeVideo } from './room.mjs';

export class SearchQueue {
  constructor(now = Date.now) { this.now = now; this.jobs = new Map(); }
  clean() {
    const now = this.now();
    for (const [id, job] of this.jobs) {
      if (now - job.created > 300000) this.jobs.delete(id);
      else if (['queued', 'running'].includes(job.status) && now - job.created > 45000) {
        job.status = 'error'; job.error = '搜索超时，请确认主机已加载新版扩展并启动播放，或在主机检查搜索页。';
      }
    }
  }
  view(job) { return { id: job.id, query: job.query, source: job.source, page: job.page, status: job.status, results: job.results, error: job.error }; }
  create({ query, source = 'bilibili', karaoke = true, mode = karaoke ? 'ktv' : 'plain', page = 1 }, hostOnline) {
    this.clean();
    if (!['bilibili', 'youtube'].includes(source)) throw new Error('请选择有效的视频来源');
    if (source === 'youtube' && page !== 1) throw new Error('YouTube 当前只提供首批搜索结果，请细化关键词');
    if (typeof query !== 'string' || !query.trim() || query.length > 80) throw new Error('请输入1至80字的歌名或歌手');
    if (!Number.isInteger(page) || page < 1 || page > 10) throw new Error('页码须为1至10');
    const text = query.trim().replace(/\s+/g, ' ');
    if (!['ktv', 'nicokara', 'plain'].includes(mode)) throw new Error('请选择有效的搜索模式');
    const effective = mode === 'nicokara' ? `${text} ニコカラ` : mode === 'ktv' ? `${text} ${source === 'youtube' ? 'karaoke' : 'KTV 伴奏'}` : text;
    for (const job of this.jobs.values()) if (job.source === source && job.query === effective && job.page === page && job.status !== 'error') return this.view(job);
    if (!hostOnline) throw new Error('请先在播放电脑的扩展点击「启动主机并去点歌」，再搜索歌曲');
    if ([...this.jobs.values()].filter(j => ['queued', 'running'].includes(j.status)).length >= 5) throw new Error('大家正在找歌，请稍等片刻再搜');
    if (this.jobs.size >= 100) { const expired = [...this.jobs.values()].find(j => ['done', 'error'].includes(j.status)); if (expired) this.jobs.delete(expired.id); }
    const job = { id: randomUUID(), query: effective, source, page, status: 'queued', created: this.now() };
    this.jobs.set(job.id, job); return this.view(job);
  }
  get(id) { this.clean(); const job = this.jobs.get(id); if (!job) throw new Error('搜索已过期，请重新搜索'); return this.view(job); }
  claim(hostId) {
    this.clean();
    const job = [...this.jobs.values()].find(j => ['queued', 'running'].includes(j.status));
    if (!job) return null;
    if (job.owner !== hostId || job.status === 'queued') { job.owner = hostId; job.token = randomUUID(); job.status = 'running'; }
    return { ...this.view(job), token: job.token };
  }
  finish({ id, token, results, error }, hostId) {
    this.clean(); const job = this.jobs.get(id);
    if (!job || job.owner !== hostId || job.token !== token) throw new Error('搜索任务已失效');
    if (job.status !== 'running') return this.view(job);
    if (error) { job.status = 'error'; job.error = String(error).slice(0, 200); return this.view(job); }
    if (!Array.isArray(results) || results.length > 40) throw new Error('搜索结果格式不正确');
    const seen = new Set();
    job.results = results.flatMap(item => {
      try {
        const url = normalizeVideo(item.url);
        if ((new URL(url).hostname === 'www.youtube.com') !== (job.source === 'youtube')) return [];
        if (seen.has(url) || typeof item.title !== 'string' || !item.title.trim()) return [];
        seen.add(url);
        let cover = '';
        try { const image = new URL(item.cover); if (image.protocol === 'https:' && (job.source === 'youtube' ? /(^|\.)ytimg\.com$/.test(image.hostname) : /(^|\.)hdslb\.com$/.test(image.hostname)) && !image.username && !image.password) cover = image.href; } catch {}
        return [{ url, title: item.title.slice(0, 160), author: String(item.author || '').slice(0, 80), duration: String(item.duration || '').slice(0, 16), cover }];
      } catch { return []; }
    });
    job.status = 'done'; return this.view(job);
  }
}
