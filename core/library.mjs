// 公共译库：与翻译节点无关的共享译文层（src -> dst）
// 用途：把自己攒下的译文导出成文件发给别人 / 上传网盘，别人导入或订阅后即可直接复用，零请求。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sha1 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');

// 单条能存多长。
// 注意：**绝不能存"截断版"** —— 译库命中后是直接拿来当译文用的，
// 截断等于给用户看半句话，比不翻还糟。超长的条目直接不收（下次照常走翻译）。
// 源文也一并限长：导出时写的是这个字段，截断的源文在别人那边会算出不同的 key，
// 结果就是"导出了却命中不了"。
const MAX_SRC = 4000;
const MAX_DST = 4000;

export class Library {
  constructor(file, { maxEntries = 300000, flushDelay = 5000 } = {}) {
    this.file = file;
    this.maxEntries = maxEntries;
    this.flushDelay = flushDelay;
    this.entries = new Map(); // key -> {s,d,t,g,p,ts,n}
    this.hits = 0;
    this._timer = null;
    this.meta = { subscriptions: [], lastImport: null };
    this._load();
  }

  static key(src, target) {
    return `${target}|${sha1(String(src)).slice(0, 20)}`;
  }

  _load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [k, v] of Object.entries(raw?.entries || {})) this.entries.set(k, v);
      if (raw?.meta) this.meta = { ...this.meta, ...raw.meta };
    } catch {
      try {
        fs.renameSync(this.file, this.file + '.broken-' + Date.now());
      } catch {}
    }
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
      for (const [k, v] of this.entries) entries[k] = v;
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, meta: this.meta, entries }), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch {}
  }

  get(src, target = 'zh-CN') {
    const v = this.entries.get(Library.key(src, target));
    if (v && typeof v.d === 'string') {
      this.hits++;
      v.n = (v.n || 1) + 1;
      v.ts = Date.now();
      return v;
    }
    return null;
  }

  add(src, dst, { target = 'zh-CN', game = '', provider = '' } = {}) {
    const s = String(src || '').trim();
    const d = String(dst || '').trim();
    if (!s || !d || s === d) return false;
    if (s.length > MAX_SRC || d.length > MAX_DST) return false; // 太长：宁可不用，也不存截断版
    const k = Library.key(s, target);
    const prev = this.entries.get(k);
    if (prev && prev.d === d) return false;
    this.entries.set(k, { s, d, t: target, g: game, p: provider, ts: Date.now(), n: (prev?.n || 0) + 1 });
    if (this.entries.size > this.maxEntries) this._evict();
    this._schedule();
    return true;
  }

  _evict() {
    const arr = [...this.entries.entries()].sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
    const drop = this.entries.size - this.maxEntries;
    for (let i = 0; i < drop; i++) this.entries.delete(arr[i][0]);
  }

  /** 合并一批条目（导入/订阅用）；onlyIfMissing=true 时不覆盖已有译文 */
  merge(list, { target = 'zh-CN', onlyIfMissing = true, source = '' } = {}) {
    let added = 0;
    let skipped = 0;
    for (const e of list || []) {
      const s = String(e?.s ?? e?.src ?? '').trim();
      const d = String(e?.d ?? e?.dst ?? '').trim();
      const t = String(e?.t || target);
      if (!s || !d || s === d) {
        skipped++;
        continue;
      }
      if (s.length > MAX_SRC || d.length > MAX_DST) {
        skipped++; // 太长：不收截断版
        continue;
      }
      const k = Library.key(s, t);
      const prev = this.entries.get(k);
      if (prev && onlyIfMissing) {
        skipped++;
        continue;
      }
      this.entries.set(k, { s, d, t, g: e.g || '', p: e.p || source || 'import', ts: Date.now(), n: prev?.n || 1 });
      added++;
    }
    this.meta.lastImport = { at: Date.now(), added, skipped, source };
    this._schedule();
    return { added, skipped, total: this.entries.size };
  }

  /** 导出成一个可分享的译库文件。extra 里可塞入缓存条目（没有游戏标签的历史译文） */
  export({ target = '', game = '', file, extra = [] } = {}) {
    const entries = [];
    const seen = new Set();
    const push = (s, d, t, g) => {
      if (!s || !d || s === d) return;
      const ss = String(s);
      const dd = String(d);
      if (ss.length > MAX_SRC || dd.length > MAX_DST) return; // 不导出截断版（别人导入会命中不了 / 看到半句话）
      const k = `${t}|${ss}`;
      if (seen.has(k)) return;
      seen.add(k);
      entries.push({ s: ss, d: dd, t, g: g || '' });
    };
    for (const v of this.entries.values()) {
      if (target && v.t !== target) continue;
      if (game && v.g !== game) continue;
      push(v.s, v.d, v.t, v.g);
    }
    for (const v of extra || []) {
      if (target && v.t && v.t !== target) continue;
      if (game && v.g !== game) continue;
      push(v.s, v.d, v.t || target || 'zh-CN', v.g);
    }
    const pack = {
      format: 'gale-mod-translator-library',
      version: 1,
      target: target || 'all',
      game: game || 'all',
      generatedAt: new Date().toISOString(),
      count: entries.length,
      entries,
    };
    const out = file || path.join(path.dirname(this.file), 'library', `gale-lib-${target || 'all'}-${game || 'all'}-${Date.now()}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(pack), 'utf8');
    return { ok: true, file: out, count: entries.length, bytes: fs.statSync(out).size };
  }

  stats() {
    const byTarget = {};
    const byGame = {};
    for (const v of this.entries.values()) {
      byTarget[v.t || '?'] = (byTarget[v.t || '?'] || 0) + 1;
      if (v.g) byGame[v.g] = (byGame[v.g] || 0) + 1;
    }
    return {
      size: this.entries.size,
      hits: this.hits,
      byTarget,
      byGame,
      subscriptions: this.meta.subscriptions || [],
      lastImport: this.meta.lastImport,
      file: this.file,
    };
  }

  setSubscriptions(list) {
    this.meta.subscriptions = list || [];
    this._schedule();
  }

  get size() {
    return this.entries.size;
  }

  clear() {
    this.entries.clear();
    this.flush();
  }
}
