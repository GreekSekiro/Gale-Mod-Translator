// 翻译缓存：内存 Map + 磁盘 JSON，防抖落盘，容量上限内按时间淘汰
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sha1 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');

export class Cache {
  constructor(file, { maxEntries = 60000, flushDelay = 4000 } = {}) {
    this.file = file;
    this.maxEntries = maxEntries;
    this.flushDelay = flushDelay;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
    this._timer = null;
    this._load();
  }

  static key(text, provider, target) {
    return `${provider}|${target}|${sha1(text).slice(0, 20)}`;
  }

  _load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const entries = raw?.entries || {};
      for (const [k, v] of Object.entries(entries)) this.map.set(k, v);
    } catch (e) {
      try {
        fs.renameSync(this.file, this.file + '.broken-' + Date.now());
      } catch {}
    }
  }

  get(text, provider, target) {
    const k = Cache.key(text, provider, target);
    const v = this.map.get(k);
    if (v && typeof v.d === 'string') {
      this.hits++;
      v.ts = Date.now();
      v.n = (v.n || 1) + 1;
      return v.d;
    }
    this.misses++;
    return null;
  }

  set(text, provider, target, dst) {
    const s = String(text ?? '');
    const k = Cache.key(s, provider, target);
    // s 只用于"搜缓存"与导出时的可读性；缓存 key 是整段文本的 sha1，所以截断它不影响命中。
    // 但要打上 tr 标记：导出译库时要跳过它 —— 别人拿到截断的源文会算出不同的 key，
    // 结果就是"导出了却永远命中不了"。
    this.map.set(k, { s: s.slice(0, 400), tr: s.length > 400 ? 1 : 0, d: dst, p: provider, t: target, ts: Date.now(), n: 1 });
    this._evict();
    this._schedule();
  }

  _evict() {
    if (this.map.size <= this.maxEntries) return;
    const arr = [...this.map.entries()].sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
    const drop = this.map.size - this.maxEntries;
    for (let i = 0; i < drop; i++) this.map.delete(arr[i][0]);
  }

  _schedule() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, this.flushDelay);
    this._timer.unref?.();
  }

  flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const entries = {};
      for (const [k, v] of this.map) entries[k] = v;
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), entries }), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      /* 落盘失败不影响翻译 */
    }
  }

  clear() {
    this.map.clear();
    this.flush();
  }

  get size() {
    return this.map.size;
  }
}
