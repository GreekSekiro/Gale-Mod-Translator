// 翻译编排：去重 → 缓存 → 公共译库 → 术语占位 → 调用节点（可多节点择优）→ 失败回退
//                → 写缓存/译库 →（可选）LLM 润色 → 回推修订给页面
import {
  getProvider,
  listProviders,
  isKnownProvider,
  providerCooldown,
  markProviderRateLimited,
  clearProviderRateLimit,
  isRateLimitError,
  isLocalEngineUnusable,
  isProviderLocal,
} from './providers.mjs';
import { pickBest, scoreCandidate } from './quality.mjs';
import { request, isLoopbackUrl } from './net.mjs';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MARK = (i) => `[[${i}]]`;
const MARK_RE = /\[\s*\[\s*(\d+)\s*\]\s*\]/g;

export function normalizeText(s) {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- 模糊复用
// 目的：只差版本号 / 标点 / 空白的句子也能命中已有译文，不必再请求一次。
// 做法：把版本号（1.2 / v1.2.3 / 1.2.3-beta）统一成占位符、标点与空白归一、转小写，
//       得到"骨架"作为索引键；命中后再把新原文里的版本号按顺序回填进旧译文。
const VERSION_RE = /\bv?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.]+)?\b/gi;

/** 把一句话压成"骨架"：忽略版本号、标点、大小写与空白差异 */
export function fuzzyKey(s) {
  return String(s ?? '')
    .replace(VERSION_RE, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把新原文里的版本号按顺序回填到旧译文里。
 * 版本号数量不一致（或旧译文里压根没有版本号）时返回 null，表示"不要复用"，
 * 宁可直接翻译，也不要给出错的版本号。
 */
export function transplantVersions(cachedSrc, cachedDst, newSrc) {
  const oldV = String(cachedSrc).match(VERSION_RE) || [];
  if (!oldV.length) return String(cachedDst); // 没有版本号，直接复用
  const newV = String(newSrc).match(VERSION_RE) || [];
  if (newV.length !== oldV.length) return null;
  let i = 0;
  return String(cachedDst).replace(VERSION_RE, () => newV[i++] ?? '');
}

/** 术语用占位符保护，避免被机翻（如 Valheim → 瓦尔海姆） */
function protectTerms(text, glossary) {
  const used = [];
  let out = text;
  const terms = [...glossary].filter((g) => g && g.from).sort((a, b) => b.from.length - a.from.length);
  for (const g of terms) {
    const re = new RegExp(escapeRe(g.from), 'gi');
    if (!re.test(out)) continue;
    const idx = used.length;
    used.push(g);
    out = out.replace(re, MARK(idx));
  }
  return { text: out, used };
}

function restoreTerms(text, used) {
  let missing = 0;
  const out = text.replace(MARK_RE, (m, i) => {
    const g = used[Number(i)];
    if (!g) {
      missing++;
      return m;
    }
    return g.to || g.from;
  });
  for (const g of used) {
    const replaced = g.to || g.from;
    if (!out.includes(replaced)) missing++;
  }
  return { text: out, missing };
}

/** 兜底：机翻把占位符弄丢 / 弄乱时，别把 [[0]] 这种标记漏到界面上 */
function stripMarks(text) {
  return String(text ?? '').replace(MARK_RE, '');
}

function applyPostReplace(text, rules) {
  let out = text;
  for (const r of rules || []) {
    if (!r || !r.from) continue;
    try {
      out = out.replace(new RegExp(escapeRe(r.from), 'gi'), r.to ?? '');
    } catch {}
  }
  return out;
}

/** 中英混排排版：中文与英文单词之间补一个空格（机翻常常漏掉） */
function spaceBetweenCJK(text) {
  return text
    .replace(/([\u3400-\u9fff\uf900-\ufaff])([A-Za-z]{2,})/g, '$1 $2')
    .replace(/([A-Za-z]{2,})([\u3400-\u9fff\uf900-\ufaff])/g, '$1 $2')
    .replace(/ {2,}/g, ' ');
}

const tokensOf = (s) => new Set((String(s).toLowerCase().match(/[a-z][a-z'-]{3,}/g) || []));

export class Translator {
  constructor({ cache, library, getConfig, log }) {
    this.cache = cache;
    this.library = library;
    this.getConfig = getConfig;
    this.log = log;
    this.onRevisions = null; // 由 server 注入：把润色后的修订推回页面
    this.events = [];
    this.stats = {
      requests: 0,
      items: 0,
      cacheHits: 0,
      libraryHits: 0,
      errors: 0,
      bestPicks: 0,
      polished: 0,
      fuzzyHits: 0,
      lastError: null,
      byProvider: {},
    };
    this._neighborIndex = { size: -1, ts: 0, map: new Map() };
    this._fuzzyIndex = { stamp: '', ts: 0, map: new Map() };
    this._polishQueue = [];
    this._polishing = false;
    this._polishTimer = null;
  }

  _record(level, msg) {
    const ev = { t: new Date().toISOString(), level, msg };
    this.events.push(ev);
    if (this.events.length > 200) this.events.shift();
    this.log?.(`[${level}] ${msg}`);
  }

  _bump(provider, field, n = 1) {
    const b = (this.stats.byProvider[provider] ||= { ok: 0, fail: 0, chars: 0 });
    b[field] += n;
  }

  // ---------------------------------------------------------------- 相似句一致性
  _buildNeighborIndex() {
    const size = this.cache.size;
    if (this._neighborIndex.size === size && Date.now() - this._neighborIndex.ts < 60000) return this._neighborIndex.map;
    const map = new Map();
    for (const v of this.cache.map.values()) {
      if (!v || typeof v.d !== 'string') continue;
      const toks = tokensOf(v.s || '');
      if (toks.size < 3) continue;
      const rec = { tokens: toks, dst: v.d };
      for (const t of toks) {
        if (!map.has(t)) map.set(t, []);
        const arr = map.get(t);
        if (arr.length < 40) arr.push(rec);
      }
    }
    this._neighborIndex = { size, ts: Date.now(), map };
    return map;
  }

  /** 找出与原文高度相似的已译句，用于"译法一致性"加分 */
  _neighbors(src) {
    try {
      const map = this._buildNeighborIndex();
      const toks = tokensOf(src);
      if (toks.size < 3) return [];
      const seen = new Set();
      for (const t of toks) for (const rec of map.get(t) || []) seen.add(rec);
      const out = [];
      for (const rec of seen) {
        let inter = 0;
        for (const t of toks) if (rec.tokens.has(t)) inter++;
        const jac = inter / (toks.size + rec.tokens.size - inter);
        if (jac >= 0.5) out.push({ jac, dst: rec.dst });
      }
      return out.sort((a, b) => b.jac - a.jac).slice(0, 3);
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------- 模糊复用
  /** 用 cache + 译库的已有译文建"骨架 → 译文"索引（按目标语言隔离，节点无关） */
  _buildFuzzyIndex(target) {
    const stamp = `${this.cache.size}|${this.library?.entries?.size ?? 0}|${target}`;
    if (this._fuzzyIndex.stamp === stamp && Date.now() - this._fuzzyIndex.ts < 60000) return this._fuzzyIndex.map;
    const map = new Map();
    const put = (s, d) => {
      if (!s || !d || s === d) return;
      const k = fuzzyKey(s);
      if (k.length < 8) return; // 太短（"安装" / "mods"）容易误命中，不复用
      if (map.has(k)) return; // 先到先得：节点缓存优先于译库
      map.set(k, { s, d });
    };
    for (const v of this.cache.map.values()) {
      if (v && typeof v.d === 'string' && (!target || v.t === target)) put(v.s, v.d);
    }
    if (this.library) {
      for (const v of this.library.entries.values()) {
        if (v && typeof v.d === 'string' && (!target || v.t === target)) put(v.s, v.d);
      }
    }
    this._fuzzyIndex = { stamp, ts: Date.now(), map };
    return map;
  }

  /** 精确未命中时，尝试用"骨架"复用已有译文；返回 { dst, src } 或 null */
  _fuzzyLookup(norm, target) {
    const rec = this._buildFuzzyIndex(target).get(fuzzyKey(norm));
    if (!rec) return null;
    const dst = transplantVersions(rec.s, rec.d, norm);
    if (dst == null) return null; // 版本号数量对不上，不复用
    return { dst, src: rec.s };
  }

  // ---------------------------------------------------------------- 单节点链路
  async _translateChain(protectedTexts, ctx, chain) {
    const skipped = [];
    for (const pid of chain) {
      // 正在冷却（刚被限流过）的节点直接跳过，别继续硬打
      const cd = providerCooldown(pid);
      if (cd) {
        skipped.push(`${pid}（还需 ${Math.ceil(cd / 1000)}s）`);
        continue;
      }
      try {
        const p = getProvider(pid);
        const effProxy = (p.proxy || 'auto') === 'never' ? null : ctx.proxy;
        this.stats.requests++;
        const out = await p.translate(protectedTexts, { ...ctx, proxy: effProxy });
        if (!Array.isArray(out) || out.length !== protectedTexts.length) {
          throw new Error(`返回条目数不匹配（期望 ${protectedTexts.length}，得到 ${out?.length}）`);
        }
        clearProviderRateLimit(pid);
        this._bump(pid, 'ok');
        this._bump(pid, 'chars', protectedTexts.reduce((a, b) => a + b.length, 0));
        return out.map((dst) => ({ dst, provider: pid }));
      } catch (e) {
        this._bump(pid, 'fail');
        this.stats.errors++;
        if (isRateLimitError(e)) {
          const ms = markProviderRateLimited(pid, e.message);
          const msg = `翻译节点 ${pid} 被限流，冷却 ${Math.round(ms / 1000)}s（期间自动改用备用节点）：${e.message}`;
          this.stats.lastError = msg;
          this._record('warn', msg);
        } else {
          const needsProxy = /^google/.test(pid);
          const hint =
            !ctx.proxy && needsProxy
              ? '（该节点在国内需要代理：请在设置面板点“自动检测”或“跟随系统代理”）'
              : '';
          this.stats.lastError = `${pid}: ${e.message}${hint}`;
          this._record('warn', `翻译节点 ${pid} 失败：${e.message}${hint}`);
        }
      }
    }
    const tail = skipped.length ? `（已跳过冷却中的节点：${skipped.join('、')}）` : '';
    return protectedTexts.map(() => ({ dst: null, provider: null, error: `全部翻译节点失败${tail}` }));
  }

  // ---------------------------------------------------------------- 多节点择优
  /** protectedChunk: [{text, used}] —— 打分前要先把术语占位符还原，否则会误判"丢失专名" */
  async _translateBest(protectedChunk, ctx) {
    const cfg = ctx.cfg;
    const q = cfg.quality || {};
    const protectedTexts = protectedChunk.map((x) => x.text);
    const disabled = new Set(cfg.disabledSources || []);
    // 冷却中的节点不参与择优（刚被限流过，继续打只会更糟）
    const usable = (v) => !!v && v !== 'cache-only' && isKnownProvider(v) && !disabled.has(v) && !providerCooldown(v);
    let voters = (Array.isArray(q.voters) ? q.voters : []).filter(usable);
    if (voters.length < 2) {
      // 配置里指定不足 2 个（或被停用 / 已移除 / 正在冷却）→ 从当前可用节点里自动补足
      const auto = listProviders(cfg)
        .filter((p) => p.id !== 'cache-only' && p.enabled !== false && !providerCooldown(p.id))
        .map((p) => p.id)
        .filter((id) => !voters.includes(id));
      voters = [...voters, ...auto];
    }
    voters = [...new Set(voters)].slice(0, 4);
    if (voters.length < 2) return protectedTexts.map(() => ({ dst: null, provider: null }));

    const settled = await Promise.all(
      voters.map(async (pid) => {
        try {
          const p = getProvider(pid);
          this.stats.requests++;
          const out = await p.translate(protectedTexts, { ...ctx, proxy: (p.proxy || 'auto') === 'never' ? null : ctx.proxy });
          if (!Array.isArray(out) || out.length !== protectedTexts.length) throw new Error('条目数不匹配');
          clearProviderRateLimit(pid);
          this._bump(pid, 'ok');
          return { pid, out };
        } catch (e) {
          this._bump(pid, 'fail');
          if (isRateLimitError(e)) {
            const ms = markProviderRateLimited(pid, e.message);
            this._record('warn', `择优候选 ${pid} 被限流，冷却 ${Math.round(ms / 1000)}s：${e.message}`);
          } else {
            this._record('warn', `择优候选 ${pid} 失败：${e.message}`);
          }
          return null;
        }
      }),
    );
    const ok = settled.filter(Boolean);
    if (!ok.length) return protectedTexts.map(() => ({ dst: null, provider: null, error: '全部候选节点失败' }));

    const out = [];
    for (let i = 0; i < protectedTexts.length; i++) {
      const used = protectedChunk[i].used || [];
      const cands = ok
        .map((v) => ({
          provider: v.pid,
          raw: v.out[i],
          dst: used.length ? stripMarks(restoreTerms(v.out[i] || '', used).text) : v.out[i],
        }))
        .filter((c) => c.dst);
      if (!cands.length) {
        out.push({ dst: null, provider: null, error: '候选均失败' });
        continue;
      }
      if (cands.length === 1) {
        out.push({ dst: cands[0].dst, provider: cands[0].provider });
        continue;
      }
      const neighbors = ctx.consistency ? this._neighbors(protectedTexts[i]) : [];
      const pick = await pickBest(protectedTexts[i], cands, {
        target: ctx.target,
        glossary: ctx.glossaryTerms,
        neighbors,
      });
      if (!pick.best) {
        // 所有候选都与原文相同（例如纯专名）——按"机翻未改动"处理，避免反复重试
        out.push({ dst: cands[0].dst, provider: cands[0].provider, unchanged: true });
        continue;
      }
      this.stats.bestPicks++;
      out.push({ dst: pick.best.dst, provider: pick.best.provider, score: pick.best.score, reasons: pick.best.reasons });
    }
    return out;
  }

  // ---------------------------------------------------------------- 回译校验 / 对比
  async _backTranslate(text, ctx) {
    const cfg = ctx.cfg || {};
    // 回译校验要一个"和主节点不同"的节点：先挑免密钥的免费节点（腾讯 / 有道 / Google），
    // 再按用户配的择优节点 → 备用节点 → 本机可用节点 的顺序挑；需要密钥的节点没填密钥就跳过，
    // 免得回译这一步直接把整轮判成失败。开了「仅本地翻译」时跳过所有在线节点。
    const usable = (id) => {
      if (!id || id === ctx.skipProvider) return false;
      if (id === 'deepl') return !!cfg.deeplKey;
      if (id === 'openai') return !!cfg.openaiKey;
      return isKnownProvider(id);
    };
    const freeNodes = cfg.offlineOnly ? [] : ['tencent', 'youdao', 'google'];
    const candidates = [
      ...freeNodes,
      ...(cfg.quality?.voters || []),
      ...(cfg.fallback || []),
      'builtin',
      'local-llm',
      'libretranslate',
    ];
    const pid = candidates.find(usable) || 'builtin';
    const p = getProvider(pid);
    const out = await p.translate([text], {
      source: ctx.target,
      target: 'en',
      proxy: (p.proxy || 'auto') === 'never' ? null : ctx.proxy,
      cfg: ctx.cfg || {},
    });
    return out?.[0] || '';
  }

  /** 设置面板「对比译法」：同一段文本让所有可用节点各翻一遍并打分 */
  async compare(text, opts = {}) {
    const cfg = this.getConfig();
    const target = opts.target || cfg.target || 'zh-CN';
    const source = opts.source || cfg.source || 'auto';
    const proxy = cfg.proxy || null;
    const glossary = /^zh/i.test(target) ? cfg.glossary || [] : [];
    const ids = listProviders(cfg)
      .filter((p) => p.id !== 'cache-only' && p.enabled !== false)
      .map((p) => p.id);
    const ctxBase = { source, target, proxy, cfg, log: () => {} };
    const settled = await Promise.all(
      ids.map(async (pid) => {
        try {
          const p = getProvider(pid);
          const out = await p.translate([text], { ...ctxBase, proxy: (p.proxy || 'auto') === 'never' ? null : proxy });
          return { provider: pid, dst: out?.[0] || '' };
        } catch (e) {
          return { provider: pid, error: e.message };
        }
      }),
    );
    const okList = settled.filter((x) => x.dst && !x.error);
    const neighbors = this._neighbors(text);
    const scored = await Promise.all(
      okList.map(async (c) => {
        let back = null;
        if (opts.verify) {
          try {
            back = await this._backTranslate(c.dst, { ...ctxBase, skipProvider: c.provider });
          } catch {}
        }
        const r = scoreCandidate(text, c.dst, { target, glossary, neighbors, back });
        return { ...c, score: r.score, reasons: r.reasons, detail: r.detail, back };
      }),
    );
    scored.sort((a, b) => (b.score || -999) - (a.score || -999));
    return {
      text,
      target,
      results: scored,
      failed: settled.filter((x) => x.error).map((x) => ({ provider: x.provider, error: x.error })),
    };
  }

  // ---------------------------------------------------------------- LLM 润色
  _polishConfig() {
    const cfg = this.getConfig();
    const p = cfg.polish || {};
    const base = (cfg.openaiBaseUrl || '').replace(/\/+$/, '');
    const key = cfg.openaiKey;
    // 仅本地模式：润色走的是"OpenAI 兼容接口"（默认指向在线服务），地址不是本机就整条关掉。
    // 否则会出现"机翻已经上屏了，然后一堆润色请求被拦截"的怪日志，用户以为翻坏了。
    const blockedByOffline = !!cfg.offlineOnly && !!base && !isLoopbackUrl(base);
    return {
      enabled: !!p.enabled && !!base && !!key && !blockedByOffline,
      base,
      key,
      model: cfg.openaiModel || 'deepseek-chat',
      batchSize: p.batchSize || 8,
      minLen: p.minLen ?? 10,
    };
  }

  _enqueuePolish(items) {
    const pc = this._polishConfig();
    if (!pc.enabled) return;
    for (const it of items) {
      if (!it || !it.src || !it.dst || it.dst === it.src) continue;
      if (it.dst.length < pc.minLen) continue;
      if (/^[\x00-\x7F\s]*$/.test(it.dst)) continue; // 纯 ASCII 说明没翻，别浪费
      this._polishQueue.push({ ...it, ts: Date.now() });
    }
    if (this._polishQueue.length > 400) this._polishQueue.splice(0, this._polishQueue.length - 400);
    if (!this._polishing && !this._polishTimer) {
      this._polishTimer = setTimeout(() => {
        this._polishTimer = null;
        this._drainPolish();
      }, 1200);
      this._polishTimer.unref?.();
    }
  }

  async _drainPolish() {
    if (this._polishing) return;
    this._polishing = true;
    try {
      while (this._polishQueue.length) {
        const pc = this._polishConfig();
        if (!pc.enabled) {
          this._polishQueue = [];
          break;
        }
        const batch = this._polishQueue.splice(0, pc.batchSize);
        try {
          const polished = await this._callPolish(batch, pc);
          const revisions = [];
          batch.forEach((it, i) => {
            const dst = normalizeText(polished[i] || '');
            if (!dst || dst === it.dst) return;
            this.cache.set(normalizeText(it.src), it.provider || 'polish', it.target, dst);
            this.library?.add(it.src, dst, { target: it.target, game: it.game, provider: 'polish' });
            revisions.push({ src: it.src, dst });
            this.stats.polished++;
          });
          if (revisions.length && this.onRevisions) {
            try {
              await this.onRevisions(revisions);
              this._record('info', `LLM 润色完成 ${revisions.length} 段并已回推页面`);
            } catch (e) {
              this._record('warn', '润色结果回推失败：' + e.message);
            }
          }
        } catch (e) {
          this._record('warn', 'LLM 润色失败：' + e.message);
          await new Promise((r) => setTimeout(r, 4000));
        }
      }
    } finally {
      this._polishing = false;
    }
  }

  async _callPolish(batch, pc) {
    const sys =
      '你是中文译文润色引擎。输入是 JSON 数组，每项形如 {"en":"英文原文","zh":"机器译文"}。' +
      '请把 zh 润色成自然、通顺、符合游戏模组社区习惯的简体中文：' +
      '1) 只输出 JSON 字符串数组，元素个数与顺序和输入完全一致，不要解释、不要代码块标记；' +
      '2) 专有名词、模组名、作者名、代码、文件路径、版本号、URL 保持原样，不要翻译；' +
      '3) 不要增删信息，不要加入原文没有的内容；4) 已经是通顺中文的条目原样返回。';
    const r = await request(`${pc.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + pc.key },
      body: JSON.stringify({
        model: pc.model,
        temperature: 0.3,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: JSON.stringify(batch.map((b) => ({ en: b.src, zh: b.dst }))) },
        ],
      }),
      timeout: 90000,
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.text.slice(0, 160)}`);
    const j = JSON.parse(r.text);
    let content = j?.choices?.[0]?.message?.content ?? '';
    content = content.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const s = content.indexOf('[');
    const e = content.lastIndexOf(']');
    let arr = null;
    if (s !== -1 && e > s) {
      try {
        arr = JSON.parse(content.slice(s, e + 1));
      } catch {}
    }
    if (!Array.isArray(arr) || arr.length !== batch.length) throw new Error(`返回条目数不匹配（期望 ${batch.length}）`);
    return arr.map((x) => (typeof x === 'string' ? x : ''));
  }

  async testPolish() {
    const pc = this._polishConfig();
    if (!pc.enabled) return { ok: false, error: '未启用润色，或未配置大模型接口地址 / API Key' };
    const sample = [{ src: 'Adds loot drops, magic items, and enchanting to Valheim.', dst: '为瓦尔海姆增加掉落物品、魔法物品和附魔。', target: 'zh-CN' }];
    try {
      const out = await this._callPolish(sample, pc);
      return { ok: true, result: out[0] };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---------------------------------------------------------------- 主流程
  /**
   * @param {string[]} texts
   * @param {{provider?:string,target?:string,source?:string,proxy?:string|null,quality?:'fast'|'best',game?:string}} opts
   */
  async translate(texts, opts = {}) {
    const cfg = this.getConfig();
    const providerId = opts.provider || cfg.provider || 'builtin';
    const target = opts.target || cfg.target || 'zh-CN';
    const source = opts.source || cfg.source || 'auto';
    const proxy = opts.proxy !== undefined ? opts.proxy : cfg.proxy || null;
    const game = opts.game || '';
    const glossary = cfg.glossary || [];
    const postReplace = cfg.postReplace || [];
    const phraseMap = cfg.phraseMap || {};

    const isChinese = /^zh/i.test(String(target || ''));
    const phrases = isChinese ? new Map(Object.entries(phraseMap).map(([k, v]) => [k.trim().toLowerCase(), v])) : new Map();
    const post = isChinese ? postReplace : [];
    const spaceCJK = isChinese && cfg.spaceBetweenCJK !== false;
    const glossaryTerms = isChinese ? glossary : [];
    const fuzzyReuse = cfg.fuzzyReuse !== false;

    const results = new Array(texts.length);
    const missIndexes = new Map();

    for (let i = 0; i < texts.length; i++) {
      const src = texts[i];
      const norm = normalizeText(src);
      if (!norm) {
        results[i] = { src, dst: src, cached: true, provider: 'none' };
        continue;
      }
      const fixed = phrases.get(norm.toLowerCase());
      if (fixed != null) {
        results[i] = { src, dst: fixed, cached: true, provider: 'phrase' };
        continue;
      }
      const hit = this.cache.get(norm, providerId, target);
      if (hit != null) {
        this.stats.cacheHits++;
        let d = applyPostReplace(hit, post);
        if (spaceCJK) d = spaceBetweenCJK(d);
        // 缓存命中也顺手补进译库（这样译库会带着游戏标签逐渐补齐，方便按游戏导出分享）
        if (cfg.library?.autoCollect !== false) this.library?.add(norm, d, { target, game, provider: providerId });
        results[i] = { src, dst: d, cached: true, provider: providerId };
        continue;
      }
      const lib = this.library?.get(norm, target);
      if (lib) {
        this.stats.libraryHits++;
        let d = applyPostReplace(lib.d, post);
        if (spaceCJK) d = spaceBetweenCJK(d);
        results[i] = { src, dst: d, cached: true, provider: 'library' };
        continue;
      }
      // 模糊复用：只差版本号 / 标点 / 空白的句子直接用已有译文（零请求）
      if (fuzzyReuse) {
        const fz = this._fuzzyLookup(norm, target);
        if (fz) {
          this.stats.fuzzyHits++;
          let d = applyPostReplace(fz.dst, post);
          if (spaceCJK) d = spaceBetweenCJK(d);
          this.cache.set(norm, providerId, target, d); // 固化：下次直接精确命中
          if (cfg.library?.autoCollect !== false) this.library?.add(norm, d, { target, game, provider: 'fuzzy' });
          results[i] = { src, dst: d, cached: true, provider: 'fuzzy' };
          continue;
        }
      }
      if (!missIndexes.has(norm)) missIndexes.set(norm, []);
      missIndexes.get(norm).push(i);
    }

    const pending = [...missIndexes.keys()];
    if (!pending.length) return results;

    const ctx = {
      source,
      target,
      proxy,
      cfg,
      primary: providerId,
      glossaryTerms,
      consistency: cfg.quality?.consistency !== false,
      log: (m) => this._record('debug', m),
    };
    const wantBest = opts.quality === 'best' && cfg.quality?.mode === 'best';
    // 备用链：跳过已停用与已移除的节点（"停用"就该完全不使用，包括兜底）
    //
    // 另外把"当前环境根本用不了"的内置引擎直接剔除：实测 Gale 的 WebView2 里
    // Translator API 存在但所有语言对都是 unavailable，放进链路只会每批都抛错、
    // 在日志里刷屏，还会让用户以为是"语言包没下载好"而去反复点启用。
    const disabled = new Set(cfg.disabledSources || []);
    // 仅本地模式：在线节点一个都不准进链路（net.mjs 那边还会硬拦一次，这里是第二道）
    const offLocal = (p) => !cfg.offlineOnly || isProviderLocal(p, cfg);
    const primaryUsable = !(providerId === 'builtin' && isLocalEngineUnusable()) && offLocal(providerId);
    const chain = [
      ...(primaryUsable ? [providerId] : []),
      ...(cfg.fallback || []).filter(
        (p) =>
          p &&
          p !== providerId &&
          p !== 'cache-only' &&
          isKnownProvider(p) &&
          !disabled.has(p) &&
          !(p === 'builtin' && isLocalEngineUnusable()) &&
          offLocal(p),
      ),
    ];
    if (!chain.length) {
      const why = cfg.offlineOnly
        ? '仅本地模式已开启，当前翻译节点不是本地节点（或本机没有任何可用的本地节点）'
        : isLocalEngineUnusable()
          ? '内置引擎在当前环境不可用（运行环境不提供端侧翻译模型），而备用链里没有其它可用节点'
          : '没有任何可用的翻译节点';
      // 注意：results 是稀疏数组（只填了命中项），这里必须按下标补齐，否则响应会缺条目
      return Array.from({ length: texts.length }, (_, i) => {
        const r = results[i];
        if (r && r.dst) return r; // 固定译法/缓存/译库命中的照常返回
        return { src: texts[i], dst: null, provider: null, error: `${why}：请到设置里启用一个翻译节点` };
      });
    }
    const CHUNK = wantBest ? 10 : providerId === 'openai' ? 12 : /deepl/.test(providerId) ? 20 : 30;
    const polishItems = [];

    for (let c = 0; c < pending.length; c += CHUNK) {
      const chunk = pending.slice(c, c + CHUNK);
      const protectedChunk = chunk.map((t) => protectTerms(t, glossaryTerms));
      const protectedTexts = protectedChunk.map((x) => x.text);

      let got;
      if (wantBest) {
        got = await this._translateBest(protectedChunk, ctx);
        if (got.every((g) => !g.dst)) {
          this._record('warn', '择优全部失败，回退到单节点链路');
          got = await this._translateChain(protectedTexts, ctx, chain);
        }
      } else {
        got = await this._translateChain(protectedTexts, ctx, chain);
      }
      for (let k = 0; k < chunk.length; k++) {
        const norm = chunk[k];
        const item = got[k] || {};
        if (!item.dst) {
          for (const i of missIndexes.get(norm)) {
            results[i] = { src: texts[i], dst: texts[i], cached: false, provider: item.provider || providerId, error: item.error || '全部翻译节点失败' };
          }
          continue;
        }
        const { used } = protectedChunk[k];
        let dst;
        if (used.length) {
          const r = restoreTerms(item.dst, used);
          // 不论术语有没有还原成功，都要把残留的 [[0]] 标记清掉
          dst = applyPostReplace(stripMarks(r.text), post);
        } else {
          dst = applyPostReplace(item.dst, post);
        }
        if (spaceCJK) dst = spaceBetweenCJK(dst);
        dst = normalizeText(dst) || norm;

        this.cache.set(norm, item.provider || providerId, target, dst);
        if (cfg.library?.autoCollect !== false) this.library?.add(norm, dst, { target, game, provider: item.provider || providerId });

        for (const i of missIndexes.get(norm)) {
          results[i] = { src: texts[i], dst, cached: false, provider: item.provider || providerId };
          this.stats.items++;
        }
        polishItems.push({ src: norm, dst, target, provider: item.provider, game });
      }
    }

    if (polishItems.length) this._enqueuePolish(polishItems);
    return results;
  }

  /** 设置页「测试节点」用 */
  async testProvider(providerId) {
    const sample = [
      'Adds loot drops, magic items, and enchanting to Valheim.',
      'This mod is compatible with all mods that add new containers.',
    ];
    const cfg = this.getConfig();
    const tmp = { ...cfg, provider: providerId, fallback: [] };
    const orig = this.getConfig;
    this.getConfig = () => tmp;
    try {
      const p = getProvider(providerId);
      const t0 = Date.now();
      const out = await p.translate(sample, {
        source: 'auto',
        target: tmp.target || 'zh-CN',
        proxy: tmp.proxy || null,
        cfg: tmp,
      });
      return { ok: true, ms: Date.now() - t0, results: out };
    } catch (e) {
      let extra = '';
      if (isRateLimitError(e)) {
        const ms = markProviderRateLimited(providerId, e.message);
        extra = `；该节点已进入冷却 ${Math.round(ms / 1000)}s`;
      }
      return { ok: false, error: e.message + extra };
    } finally {
      this.getConfig = orig;
    }
  }
}
