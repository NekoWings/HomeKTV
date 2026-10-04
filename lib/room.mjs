import { randomUUID } from 'node:crypto';

export function normalizeVideo(input) {
  const text = String(input || '').trim();
  let url;
  if (/^BV[0-9A-Za-z]{10}$/.test(text)) url = new URL(`https://www.bilibili.com/video/${text}`);
  else {
    const match = text.match(/https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(?:BV[0-9A-Za-z]{10}|av\d+)[^\s]*/);
    if (!match) throw new Error('请粘贴完整的 B站视频链接或 BV号；b23.tv 短链接请先打开后复制地址');
    url = new URL(match[0]);
  }
  const id = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10}|av\d+)\/?$/)?.[1];
  if (!id) throw new Error('视频链接格式不正确');
  const p = Number(url.searchParams.get('p') || 1);
  if (!Number.isSafeInteger(p) || p < 1 || p > 10000) throw new Error('分P编号不正确');
  return `https://www.bilibili.com/video/${id}/${p > 1 ? `?p=${p}` : ''}`;
}

export class Room {
  constructor(saved = {}, persist = () => {}) {
    this.state = { current: saved.current || null, queue: saved.queue || [], history: Array.isArray(saved.history) ? saved.history.slice(0, 200) : [], desired: 'paused', revision: 0 };
    this.persist = persist;
    this.host = null;
    this.status = { message: '等待 KTV 主机连接' };
    this.requests = new Map();
  }
  snapshot() {
    return { ...this.state, hostOnline: !!this.host && Date.now() - this.host.seen < 12000, status: this.status };
  }
  save() { this.state.revision++; this.persist(this.state); return this.snapshot(); }
  advance(outcome) {
    if (outcome && this.state.current) {
      const { resumeTime, resumeFrom, ...song } = this.state.current;
      this.state.history.unshift({ ...song, finishedAt: Date.now(), outcome });
      this.state.history = this.state.history.slice(0, 200);
    }
    this.state.current = this.state.queue.shift() || null;
    this.state.desired = this.state.current ? 'playing' : 'paused';
    this.status = { message: this.state.current ? '正在切换歌曲' : '歌单已唱完' };
  }
  claim(id) {
    if (typeof id !== 'string' || id.length < 16 || id.length > 100) throw new Error('主机标识无效');
    if (this.host && this.host.id !== id && Date.now() - this.host.seen < 12000) throw new Error('已有一台 KTV 主机在线，请先在原主机停止接管');
    this.host = { id, seen: Date.now() };
    return this.snapshot();
  }
  requireHost(id) {
    if (!this.host || this.host.id !== id || Date.now() - this.host.seen >= 12000) throw new Error('主机连接已过期，请重新接管');
  }
  action(body) {
    const { action, id } = body;
    // Retries with the same requestId must never insert a second copy.
    if (body.requestId && this.requests.has(body.requestId)) return this.snapshot();
    if (action === 'add' || action === 'replay') {
      if (this.state.queue.length >= 200) throw new Error('歌单已满（最多200首）');
      const previous = action === 'replay' ? this.state.history.find(song => song.id === id) : null;
      if (action === 'replay' && !previous) throw new Error('这首歌已不在已唱列表中，请重新搜索点歌');
      const input = previous ? { ...previous, by: body.by || previous.by } : body;
      const url = normalizeVideo(input.url);
      const song = { id: randomUUID(), url, title: String(input.title || url.match(/video\/([^/]+)/)[1]).slice(0, 160), by: String(input.by || '朋友').slice(0, 32) };
      song.baseTitle = String(input.baseTitle || song.title).slice(0, 160);
      body.first ? this.state.queue.unshift(song) : this.state.queue.push(song);
      if (!this.state.current) this.advance();
    } else if (action === 'part') {
      const current = this.state.current?.id === id;
      const index = this.state.queue.findIndex(song => song.id === id);
      const song = current ? this.state.current : this.state.queue[index];
      if (!song) throw new Error('歌曲已切换或移除，请重新选择');
      const url = normalizeVideo(body.url);
      if (new URL(url).pathname !== new URL(song.url).pathname) throw new Error('只能切换同一视频的分P');
      if (url === song.url) return this.snapshot();
      const replacement = { ...song, id: randomUUID(), url, baseTitle: song.baseTitle || song.title, title: String(body.title || song.title).slice(0, 160) };
      if (current) {
        replacement.resumeTime = Number.isFinite(this.status.time) ? Math.max(0, this.status.time) : (song.resumeTime || 0);
        replacement.resumeFrom = song.id;
        this.state.current = replacement;
        this.status = { message: '正在切换版本并恢复进度' };
      }
      else this.state.queue[index] = replacement;
    } else if (action === 'top' || action === 'remove') {
      const index = this.state.queue.findIndex(x => x.id === id);
      if (index < 0) throw new Error('这首歌已不在待唱列表中');
      const [song] = this.state.queue.splice(index, 1);
      if (action === 'top') this.state.queue.unshift(song);
    } else if (action === 'next' || action === 'ended') {
      if (action === 'ended') this.requireHost(body.hostId);
      // A delayed ended event or a second guest clicking next must not skip another song.
      if (this.state.current?.id !== id) return this.snapshot();
      this.advance(action === 'ended' ? 'completed' : 'skipped');
    } else if (action === 'play') {
      if (!this.state.current) this.advance();
      if (this.state.current) this.state.desired = 'playing';
    } else if (action === 'pause' || action === 'stop') {
      this.state.desired = action === 'stop' ? 'stopped' : 'paused';
      if (action === 'stop' && this.state.current) {
        delete this.state.current.resumeTime; delete this.state.current.resumeFrom;
        this.status = { message: '播放页已关闭' };
      }
    } else throw new Error('未知操作');
    if (body.requestId) {
      this.requests.set(String(body.requestId).slice(0, 100), true);
      if (this.requests.size > 1000) this.requests.delete(this.requests.keys().next().value);
    }
    return this.save();
  }
}
