// 翻译源适配器。每个源实现 translate(texts, ctx) -> string[]（顺序、数量与输入一致）
// ctx = { source, target, proxy, cfg, log }
import { request, isLoopbackUrl } from './net.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把长文本按句子边界切成 <= max 字符的片段，翻译后再拼回 */
function splitLong(text, max) {
  if (text.length <= max) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = -1;
    for (const re of [/[.!?。！？;；]\s/g, /,\s/g, /\s/g]) {
      re.lastIndex = 0;
      let m;
      let last = -1;
      while ((m = re.exec(rest)) !== null) {
        if (m.index + m[0].length <= max) last = m.index + m[0].length;
        else break;
      }
      if (last > max * 0.4) {
        cut = last;
        break;
      }
    }
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

/** 简单并发限制映射 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// 各源的最小请求间隔（毫秒）。免费接口对频率敏感，太快会被限流。
// google 的免费 gtx 接口按 IP 限流很严，间隔给大一点。
const RATE_LIMIT = { tencent: 200, youdao: 1300, google: 400, deepl: 0, openai: 0, libretranslate: 0 };
// 各源的最大并发：免费接口只开 1 个，避免自己把自己打成 429
// 内置引擎也必须串行 —— Translator API 本身就是顺序处理的，并发发过去只会排队
const CONCURRENCY = { google: 1, youdao: 1, tencent: 2, builtin: 1 };
const _queue = new Map();
/** 串行限速：同一翻译源的请求按队列排队，彼此至少间隔 interval 毫秒 */
function throttle(id) {
  const interval = RATE_LIMIT[id] ?? 0;
  if (!interval) return Promise.resolve();
  const prev = _queue.get(id) || Promise.resolve();
  const next = prev.then(() => sleep(interval));
  _queue.set(
    id,
    next.catch(() => {}),
  );
  return next;
}

/** 判断一个错误是不是"被限流"（429 / 频率过快 之类） */
export function isRateLimitError(e) {
  const m = String((e && e.message) || e || '');
  return /429|频率过快|请求频率|限流|频繁|too many requests|rate.?limit/i.test(m);
}

/** 带重试的请求包装：瞬时错误自动退避重试。
 *  注意：**被限流（429）不在这里重试** —— 重试只会让限流更严重，
 *  交给下面的"冷却"机制处理（失败后短时间内直接跳过该节点、自动用备用节点）。 */
async function withRetry(id, fn, { tries = 3, base = 800 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    await throttle(id);
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (isRateLimitError(e)) break;
      if (!/频率|限流|频繁|timeout|超时|socket|ECONN|fetch failed|空结果|HTTP 5\d\d/i.test(e.message)) break;
      await sleep(base * Math.pow(2, i));
    }
  }
  throw lastErr;
}

async function chunkedTranslate(texts, max, fn, { id, concurrency = 4, tries = 3 } = {}) {
  const one = async (t) => {
    const parts = splitLong(t, max);
    if (parts.length === 1) return withRetry(id, () => fn(t), { tries });
    const out = [];
    for (const p of parts) out.push(await withRetry(id, () => fn(p), { tries }));
    return out.join('');
  };
  const limit = CONCURRENCY[id] ?? (RATE_LIMIT[id] ? 2 : concurrency);
  return mapLimit(texts, limit, one);
}

// ---------------------------------------------------------------- 限流冷却（熔断）
// 免费接口被限流后，短时间内继续请求只会更糟（还可能连累同一出口 IP 的其它人）。
// 这里给每个节点记一个"冷却到什么时候"：冷却期内直接跳过、自动用备用节点，
// 并把状态暴露给设置页 / 抽屉，让用户知道"为什么这个节点暂时不用了"。
const COOLDOWN_BASE = 60 * 1000; // 第一次限流冷却 1 分钟
const COOLDOWN_MAX = 10 * 60 * 1000; // 上限 10 分钟
const _cooldown = new Map(); // id -> { until, strikes, reason, at }

/** 某节点还要冷却多久（毫秒）；0 表示可用 */
export function providerCooldown(id) {
  const c = _cooldown.get(id);
  if (!c) return 0;
  const left = c.until - Date.now();
  if (left <= 0) {
    _cooldown.delete(id);
    return 0;
  }
  return left;
}

/** 标记某节点被限流：冷却时间指数增长（1min → 2min → 4min … 上限 10min） */
export function markProviderRateLimited(id, reason = '') {
  const prev = _cooldown.get(id);
  const strikes = (prev?.strikes || 0) + 1;
  const ms = Math.min(COOLDOWN_MAX, COOLDOWN_BASE * Math.pow(2, strikes - 1));
  _cooldown.set(id, { until: Date.now() + ms, strikes, reason, at: Date.now() });
  return ms;
}

/** 该节点成功翻译了 → 清掉冷却记录 */
export function clearProviderRateLimit(id) {
  _cooldown.delete(id);
}

/** 当前处于冷却中的节点（供设置页 / 抽屉显示） */
export function rateLimitStatus() {
  const out = [];
  for (const [id, c] of _cooldown) {
    const left = c.until - Date.now();
    if (left <= 0) {
      _cooldown.delete(id);
      continue;
    }
    out.push({ id, remainingMs: left, strikes: c.strikes, reason: c.reason || '' });
  }
  return out;
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- 语言支持
/** 界面可选语言（通用码 -> 名称）。各翻译源再把它映射成自己的写法。 */
export const LANG_LIST = [
  { code: 'zh-CN', name: '简体中文' },
  { code: 'zh-TW', name: '繁體中文' },
  { code: 'en', name: 'English 英语' },
  { code: 'ja', name: '日本語 日语' },
  { code: 'ko', name: '한국어 韩语' },
  { code: 'ru', name: 'Русский 俄语' },
  { code: 'fr', name: 'Français 法语' },
  { code: 'de', name: 'Deutsch 德语' },
  { code: 'es', name: 'Español 西班牙语' },
  { code: 'pt-BR', name: 'Português 葡萄牙语' },
  { code: 'it', name: 'Italiano 意大利语' },
  { code: 'pl', name: 'Polski 波兰语' },
  { code: 'tr', name: 'Türkçe 土耳其语' },
  { code: 'uk', name: 'Українська 乌克兰语' },
  { code: 'cs', name: 'Čeština 捷克语' },
  { code: 'nl', name: 'Nederlands 荷兰语' },
  { code: 'sv', name: 'Svenska 瑞典语' },
  { code: 'da', name: 'Dansk 丹麦语' },
  { code: 'fi', name: 'Suomi 芬兰语' },
  { code: 'no', name: 'Norsk 挪威语' },
  { code: 'el', name: 'Ελληνικά 希腊语' },
  { code: 'hu', name: 'Magyar 匈牙利语' },
  { code: 'ro', name: 'Română 罗马尼亚语' },
  { code: 'vi', name: 'Tiếng Việt 越南语' },
  { code: 'th', name: 'ไทย 泰语' },
  { code: 'id', name: 'Bahasa Indonesia 印尼语' },
  { code: 'ms', name: 'Bahasa Melayu 马来语' },
  { code: 'hi', name: 'हिन्दी 印地语' },
  { code: 'bn', name: 'বাংলা 孟加拉语' },
  { code: 'ta', name: 'தமிழ் 泰米尔语' },
  { code: 'ar', name: 'العربية 阿拉伯语' },
  { code: 'fa', name: 'فارسی 波斯语' },
  { code: 'he', name: 'עברית 希伯来语' },
  { code: 'sw', name: 'Kiswahili 斯瓦希里语' },
  { code: 'tl', name: 'Filipino 菲律宾语' },
];

const primary = (code) => String(code || '').trim().split(/[-_]/)[0].toLowerCase();
const LANG_NAME_ZH = Object.fromEntries(LANG_LIST.map((l) => [l.code, l.name.replace(/[\s\u3000]*[^\s\u3000]*$/, '').trim() || l.name]));

/**
 * 把通用语言码映射成某个翻译源要求的写法。
 * @param {string} providerId
 * @param {string} code 通用码（如 zh-CN、en、auto）
 * @param {'source'|'target'} kind
 */
export function mapLang(providerId, code, kind) {
  const c = String(code || (kind === 'source' ? 'auto' : 'zh-CN')).trim();
  if (kind === 'source' && (c === '' || c.toLowerCase() === 'auto')) {
    if (providerId === 'youdao') return 'Auto'; // 免费网页接口用 'Auto'
    if (providerId === 'deepl') return 'EN';
    return 'auto';
  }
  const p = primary(c);
  switch (providerId) {
    case 'tencent':
      return c.toLowerCase() === 'zh-tw' ? 'zh-TW' : p;
    case 'youdao':
      if (p === 'zh') return c.toLowerCase() === 'zh-tw' ? 'zh-CHT' : 'zh-CHS';
      return p;
    case 'deepl':
      if (p === 'zh') return 'ZH';
      if (p === 'pt') return 'PT-BR';
      return p.toUpperCase();
    case 'openai':
      return LANG_NAME_ZH[c] || LANG_NAME_ZH[p] || c;
    case 'google':
      return p === 'zh' ? c : p;
    default:
      return p === 'zh' ? c : p; // libretranslate / 自定义节点
  }
}

// ---------------------------------------------------------------- 自定义翻译节点
/** 从响应里按路径取字符串数组。支持 a.b、a[0].b、a[].b（数组映射） */
function pickPath(obj, pathStr) {
  const tokens = String(pathStr || '')
    .replace(/\[(\d*)\]/g, '.$1')
    .split('.')
    .filter((t, i) => t !== '' || i > 0);
  let cur = [obj];
  for (const t of tokens) {
    const next = [];
    for (const c of cur) {
      if (c == null) continue;
      if (t === '') {
        if (Array.isArray(c)) next.push(...c);
      } else if (Array.isArray(c)) {
        for (const item of c) if (item != null && item[t] !== undefined) next.push(item[t]);
      } else if (c[t] !== undefined) {
        next.push(c[t]);
      }
    }
    cur = next;
  }
  const flat = [];
  const walk = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'string') flat.push(v);
    else if (typeof v === 'number') flat.push(String(v));
  };
  cur.forEach(walk);
  return flat;
}

/** 没填路径时，尽力从常见响应结构里猜出译文数组 */
function autoExtract(json) {
  const cands = [
    (j) => j.translations?.map?.((x) => x.text ?? x.translatedText),
    (j) => j.translatedText,
    (j) => j.translation,
    (j) => j.translated_text,
    (j) => j.result,
    (j) => j.data,
    (j) => j.auto_translation,
    (j) => j,
  ];
  for (const f of cands) {
    try {
      const v = f(json);
      if (typeof v === 'string' && v) return [v];
      if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return v;
    } catch {}
  }
  return [];
}

function renderTpl(tpl, vars) {
  return String(tpl ?? '').replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
}

/** 用户自定义的翻译节点（设置面板可增删） */
async function runCustomSource(source, texts, ctx) {
  if (!source) throw new Error('自定义节点不存在');
  const useBatch = source.batch !== false && /(\{\{texts_json\}\}|\{\{texts_joined\}\})/.test(source.body || '');
  const target = mapLang('custom', ctx.target, 'target');
  const src = mapLang('custom', ctx.source, 'source');
  const out = [];

  const callOnce = async (list) => {
    const vars = {
      text: JSON.stringify(list[0] ?? '').slice(1, -1),
      texts_json: JSON.stringify(list),
      texts_joined: list.join('\n'),
      source: src,
      target,
      key: source.key || '',
      texts_count: list.length,
    };
    const url = renderTpl(source.url, vars);
    let headers = {};
    try {
      headers = source.headers ? JSON.parse(renderTpl(source.headers, vars)) : {};
    } catch {
      throw new Error('自定义节点的请求头不是合法 JSON');
    }
    const method = (source.method || 'POST').toUpperCase();
    const bodyTpl = source.body || '';
    const body = bodyTpl ? renderTpl(bodyTpl, vars) : undefined;
    const r = await request(url, { method, headers, body, proxy: ctx.proxy, timeout: 30000 });
    if (r.status !== 200) throw new Error(`自定义节点 HTTP ${r.status}: ${r.text.slice(0, 160)}`);
    let json;
    try {
      json = JSON.parse(r.text);
    } catch {
      if (list.length === 1) return [clean(r.text)];
      throw new Error('自定义节点返回的不是 JSON，且本次请求包含多段文本');
    }
    const arr = source.responsePath ? pickPath(json, source.responsePath) : autoExtract(json);
    if (!arr.length) throw new Error('自定义节点没取到译文，请检查“响应取值路径”');
    if (arr.length !== list.length) {
      throw new Error(`自定义节点返回条目数不匹配（期望 ${list.length}，得到 ${arr.length}）`);
    }
    return arr.map(clean);
  };

  if (useBatch) {
    out.push(...(await withRetry('custom:' + source.id, () => callOnce(texts), { tries: 2 })));
  } else {
    for (const t of texts) {
      const r = await withRetry('custom:' + source.id, () => callOnce([t]), { tries: 2 });
      out.push(r[0]);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 腾讯交互翻译（免费·国内直连·支持批量）
const tencent = {
  id: 'tencent',
  name: '腾讯交互翻译（免费·国内直连·推荐备用）',
  nameEn: 'Tencent Interactive Translation (free · direct in China · recommended fallback)',
  note: '免密钥、国内直连、一次请求可翻多段，速度和稳定性最好。',
  noteEn: 'No key needed, direct in China, batches many segments per request — fastest and most stable.',
  proxy: 'never', // 国内服务，走代理反而更慢甚至失败
  supportsBatch: true,
  async translate(texts, ctx) {
    const out = [];
    let i = 0;
    while (i < texts.length) {
      const batch = [];
      let len = 0;
      while (i < texts.length && batch.length < 20 && len + texts[i].length < 4500) {
        batch.push(texts[i]);
        len += texts[i].length;
        i++;
      }
      const arr = await withRetry(
        'tencent',
        async () => {
          const res = await request('https://transmart.qq.com/api/imt', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Referer: 'https://transmart.qq.com/zh-CN/index',
              Origin: 'https://transmart.qq.com',
            },
            body: JSON.stringify({
              header: { fn: 'auto_translation', client_key: 'browser-chrome-110.0.0.0' },
              type: 'plain',
              model_category: 'normal',
              source: { lang: mapLang('tencent', ctx.source, 'source'), text_list: batch },
              target: { lang: mapLang('tencent', ctx.target, 'target') },
            }),
            proxy: ctx.proxy,
            timeout: 15000,
          });
          if (res.status !== 200) throw new Error(`腾讯翻译 HTTP ${res.status}`);
          const j = JSON.parse(res.text);
          if (j?.header?.ret_code !== 'succ') throw new Error(`腾讯翻译失败: ${j?.header?.ret_code} ${j?.message || ''}`);
          const list = j.auto_translation;
          if (!Array.isArray(list) || list.length !== batch.length) {
            throw new Error(`腾讯返回条目数不匹配（期望 ${batch.length}，得到 ${list?.length}）`);
          }
          return list;
        },
        { tries: 3, base: 900 },
      );
      out.push(...arr.map(clean));
    }
    return out;
  },
};

// ---------------------------------------------------------------- 有道（免费 demo 接口，国内直连）
const youdao = {
  id: 'youdao',
  name: '有道翻译（免费·国内直连）',
  nameEn: 'Youdao Translate (free · direct in China)',
  note: '无需密钥，国内可直连；长文本自动分段，单段请求快但限流更严。',
  noteEn: 'No key needed, direct in China; long text is split automatically. Fast per segment, but rate limits are stricter.',
  proxy: 'never',
  supportsBatch: false,
  async translate(texts, ctx) {
    return chunkedTranslate(
      texts,
      1800,
      async (t) => {
        const r = await request('https://aidemo.youdao.com/trans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://aidemo.youdao.com/' },
          body: new URLSearchParams({
            q: t,
            from: mapLang('youdao', ctx.source, 'source'),
            to: mapLang('youdao', ctx.target, 'target'),
          }).toString(),
          proxy: ctx.proxy,
          timeout: 12000,
        });
        let j;
        try {
          j = JSON.parse(r.text);
        } catch {
          throw new Error(`有道返回非 JSON (HTTP ${r.status})`);
        }
        if (j.errorCode && j.errorCode !== '0') throw new Error(`有道错误 ${j.errorCode}: ${j.msg || ''}`);
        const arr = Array.isArray(j.translation) ? j.translation : [];
        if (!arr.length) throw new Error('有道返回空结果: ' + JSON.stringify(j).slice(0, 160));
        return arr.map(clean).join('\n');
      },
      { id: 'youdao' },
    );
  },
};

// ---------------------------------------------------------------- Google（免费 gtx 接口，国内需代理）
const google = {
  id: 'google',
  name: 'Google 翻译（免费接口·国内需代理）',
  nameEn: 'Google Translate (free endpoint · proxy required in China)',
  note: '翻译质量稳定；国内直连被墙，需在设置里填写代理。免费接口按 IP 限流很严，被限流时会自动冷却并切到备用节点。',
  noteEn:
    'Consistently good quality; blocked in China, so a proxy must be configured. The free endpoint rate-limits by IP; when throttled it cools down and falls back automatically.',
  proxy: 'always',
  supportsBatch: true,

  /** 单次请求（一段文本） */
  async _one(t, ctx) {
    const url =
      'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=' +
      encodeURIComponent(mapLang('google', ctx.source, 'source')) +
      '&tl=' +
      encodeURIComponent(mapLang('google', ctx.target, 'target')) +
      '&q=' +
      encodeURIComponent(t);
    const r = await request(url, { proxy: ctx.proxy, timeout: 8000 });
    if (r.status === 429) {
      const ra = r.headers && (r.headers['retry-after'] || r.headers['Retry-After']);
      if (ra && ctx.log) ctx.log(`google 429，Retry-After=${ra}`);
      throw new Error('Google 返回 HTTP 429（出口 IP 被限流）');
    }
    if (r.status !== 200) throw new Error(`Google 返回 HTTP ${r.status}`);
    let j;
    try {
      j = JSON.parse(r.text);
    } catch {
      throw new Error('Google 返回非 JSON: ' + r.text.slice(0, 120));
    }
    const parts = Array.isArray(j?.[0]) ? j[0].map((x) => x?.[0] ?? '').join('') : '';
    if (!parts) throw new Error('Google 返回空结果');
    return parts;
  },

  /**
   * 把多段用换行拼成一次请求（显著减少请求数，这是缓解 429 最有效的办法）。
   * 只有"返回行数 == 输入段数、且没有空行"时才采用；
   * 否则返回 null，让调用方退回逐段请求 —— 宁可慢，也不能把译文错位。
   * 拼接前会把每段内部的换行压成空格，保证 1 段 == 1 行。
   */
  async _joined(texts, ctx) {
    if (texts.length < 2) return null;
    const out = new Array(texts.length);
    const groups = [];
    let cur = [];
    let len = 0;
    for (let i = 0; i < texts.length; i++) {
      const t = String(texts[i] ?? '');
      if (!t.trim()) {
        out[i] = t;
        continue;
      }
      if (cur.length && (cur.length >= 20 || len + t.length + 1 > 1500)) {
        groups.push(cur);
        cur = [];
        len = 0;
      }
      cur.push(i);
      len += t.length + 1;
    }
    if (cur.length) groups.push(cur);
    if (!groups.length) return out.map((v, i) => (v == null ? String(texts[i]) : v));

    for (const g of groups) {
      const joined = g.map((i) => String(texts[i]).replace(/\s*\n\s*/g, ' ').trim()).join('\n');
      const res = await withRetry('google', () => this._one(joined, ctx), { tries: 1 });
      const lines = String(res).split('\n').map((s) => s.trim());
      if (lines.length !== g.length || lines.some((s) => !s)) return null; // 行数对不上 → 退回逐段
      g.forEach((idx, k) => (out[idx] = lines[k]));
    }
    return out.map((v, i) => (v == null ? String(texts[i]) : v));
  },

  async translate(texts, ctx) {
    const short = [];
    const long = [];
    texts.forEach((t, i) => (String(t).length <= 1500 ? short : long).push(i));
    const result = new Array(texts.length);
    const perSegment = (idx) =>
      chunkedTranslate(idx.map((i) => texts[i]), 1500, (t) => this._one(t, ctx), { id: 'google', tries: 2 });

    if (short.length > 1) {
      let joined = null;
      try {
        joined = await this._joined(short.map((i) => texts[i]), ctx);
      } catch (e) {
        // 拼接请求被限流 → 直接上抛，让上层记录冷却并切备用节点（别再逐段硬打）
        if (isRateLimitError(e)) throw e;
        joined = null;
      }
      if (joined) short.forEach((i, k) => (result[i] = joined[k]));
      else (await perSegment(short)).forEach((v, k) => (result[short[k]] = v));
    } else if (short.length === 1) {
      result[short[0]] = await withRetry('google', () => this._one(texts[short[0]], ctx), { tries: 2 });
    }
    if (long.length) (await perSegment(long)).forEach((v, k) => (result[long[k]] = v));
    return result;
  },
};

// ---------------------------------------------------------------- DeepL（官方 API，需密钥）
const deepl = {
  id: 'deepl',
  name: 'DeepL（官方 API·需密钥）',
  nameEn: 'DeepL (official API · key required)',
  note: '质量最佳之一；需要 DeepL API Key（免费版 key 以 :fx 结尾）。',
  noteEn: 'One of the best. Requires a DeepL API key (free-tier keys end with :fx).',
  supportsBatch: true,
  fields: [{ key: 'deeplKey', label: 'DeepL API Key', labelEn: 'DeepL API Key', type: 'password' }],
  async translate(texts, ctx) {
    const key = ctx.cfg?.deeplKey;
    if (!key) throw new Error('未配置 DeepL API Key');
    const host = key.trim().endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
    const out = [];
    for (let i = 0; i < texts.length; i += 20) {
      const batch = texts.slice(i, i + 20);
      const body = new URLSearchParams();
      for (const t of batch) body.append('text', t);
      body.append('target_lang', mapLang('deepl', ctx.target, 'target'));
      body.append('source_lang', mapLang('deepl', ctx.source, 'source'));
      const r = await request(`https://${host}/v2/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'DeepL-Auth-Key ' + key.trim() },
        body: body.toString(),
        proxy: ctx.proxy,
        timeout: 20000,
      });
      if (r.status !== 200) throw new Error(`DeepL 返回 HTTP ${r.status}: ${r.text.slice(0, 140)}`);
      const j = JSON.parse(r.text);
      for (const t of j.translations || []) out.push(clean(t.text));
    }
    return out;
  },
};

// ---------------------------------------------------------------- OpenAI 兼容（DeepSeek / 硅基流动 / 本地 Ollama …）
/** OpenAI 兼容的 chat/completions 翻译。openai 与 local-llm 两个节点共用这段逻辑，
 *  区别只在默认值、是否需要密钥、以及界面上的说法。 */
async function openAiCompatibleTranslate(texts, ctx, { base, key, model, label }) {
  const out = [];
  for (let i = 0; i < texts.length; i += 12) {
    const batch = texts.slice(i, i + 12);
    const langName = mapLang('openai', ctx.target, 'target');
    const sys =
      `你是游戏模组平台的界面翻译引擎。把用户给出的 JSON 字符串数组逐条翻译成${langName}。` +
      '规则：1) 只输出 JSON 数组，元素个数与顺序和输入完全一致，不要输出任何解释或代码块标记；' +
      '2) 模组名、作者名、软件名（如 Valheim、BepInEx、Jotunn、Thunderstore）、代码、配置文件路径、URL、版本号保持原样；' +
      '3) 已经是目标语言的条目原样返回；4) 保留原文本中的换行与标点风格；5) 术语用游戏圈通用译法。';
    const r = await request(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: JSON.stringify(batch) },
        ],
      }),
      proxy: ctx.proxy,
      timeout: 90000,
    });
    if (r.status !== 200) throw new Error(`${label}接口 HTTP ${r.status}: ${r.text.slice(0, 160)}`);
    const j = JSON.parse(r.text);
    let content = j?.choices?.[0]?.message?.content ?? '';
    content = content.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const s = content.indexOf('[');
    const e = content.lastIndexOf(']');
    let arr = null;
    if (s !== -1 && e > s) {
      try {
        arr = JSON.parse(content.slice(s, e + 1));
      } catch {
        arr = null;
      }
    }
    if (!Array.isArray(arr) || arr.length !== batch.length) {
      const lines = content
        .split('\n')
        .map((l) => l.replace(/^\s*\d+[.、)]\s*/, '').trim())
        .filter(Boolean);
      if (lines.length === batch.length) arr = lines;
      else throw new Error(`模型返回条目数不匹配（期望 ${batch.length}，得到 ${Array.isArray(arr) ? arr.length : lines.length}）`);
    }
    for (const x of arr) out.push(clean(typeof x === 'string' ? x : JSON.stringify(x)));
  }
  return out;
}

const openai = {
  id: 'openai',
  name: 'OpenAI 兼容大模型（DeepSeek 等·需密钥）',
  nameEn: 'OpenAI-compatible LLM (DeepSeek etc. · key required)',
  note: '可填 DeepSeek / 硅基流动等兼容地址；上下文理解最好，模组术语更准。',
  noteEn: 'Works with DeepSeek / SiliconFlow and similar endpoints; best context handling and mod terminology.',
  supportsBatch: true,
  fields: [
    { key: 'openaiBaseUrl', label: '接口地址', labelEn: 'Endpoint URL', type: 'text', placeholder: 'https://api.deepseek.com/v1' },
    { key: 'openaiKey', label: 'API Key', labelEn: 'API Key', type: 'password' },
    { key: 'openaiModel', label: '模型', labelEn: 'Model', type: 'text', placeholder: 'deepseek-chat' },
  ],
  async translate(texts, ctx) {
    const base = (ctx.cfg?.openaiBaseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
    const key = ctx.cfg?.openaiKey;
    const model = ctx.cfg?.openaiModel || 'deepseek-chat';
    if (!key) throw new Error('未配置 API Key');
    return openAiCompatibleTranslate(texts, ctx, { base, key, model, label: '模型' });
  },
};

// ---------------------------------------------------------------- 本地大模型（Ollama / LM Studio / llama.cpp）
// 和上面的 openai 节点是同一套协议，差别在：**不需要密钥、地址默认指向本机**。
// 用途：想用自己本地的模型翻译（完全离线、零第三方条款、无额度限制），
// 或者本地跑一个更大的模型来获得比内置引擎更好的质量。
const localLlm = {
  id: 'local-llm',
  name: '本地大模型（Ollama / LM Studio·离线·免密钥）',
  nameEn: 'Local LLM (Ollama / LM Studio · offline · no key)',
  note: '用你自己电脑上跑的模型翻译，完全离线、不联网、无额度限制。先在本地起一个 Ollama（或 LM Studio / llama.cpp）并下载好模型，然后点「测试当前节点」验证连通性。（地址填局域网 / 公网地址、而不是 127.0.0.1 时，它就不算"本地节点"，开「仅本地翻译」后会被停用。）',
  noteEn:
    'Translate with a model running on your own machine — fully offline, no quota. Start Ollama (or LM Studio / llama.cpp) locally and pull a model first, then click “Test current provider”. (If the URL points at a LAN/public host instead of 127.0.0.1 it no longer counts as local and is disabled in local-only mode.)',
  supportsBatch: true,
  fields: [
    { key: 'localLlmBaseUrl', label: '本地接口地址', labelEn: 'Local endpoint URL', type: 'text', placeholder: 'http://127.0.0.1:11434/v1' },
    { key: 'localLlmModel', label: '模型名', labelEn: 'Model name', type: 'text', placeholder: 'qwen2.5:7b' },
    { key: 'localLlmKey', label: 'API Key（可选，Ollama 不需要）', labelEn: 'API key (optional, not needed for Ollama)', type: 'password' },
  ],
  async translate(texts, ctx) {
    const base = (ctx.cfg?.localLlmBaseUrl || 'http://127.0.0.1:11434/v1').replace(/\/+$/, '');
    const key = String(ctx.cfg?.localLlmKey || '').trim();
    const model = String(ctx.cfg?.localLlmModel || '').trim() || 'qwen2.5:7b';
    // 本地地址不该走代理（走代理反而连不上 127.0.0.1）
    return openAiCompatibleTranslate(texts, { ...ctx, proxy: null }, { base, key, model, label: '本地模型' });
  },
};

// ---------------------------------------------------------------- LibreTranslate（自建/公共实例）
const libretranslate = {
  id: 'libretranslate',
  name: 'LibreTranslate（自建实例）',
  nameEn: 'LibreTranslate (self-hosted)',
  note: '适合本地自建/离线场景；公共实例大多已限流。（公共实例是外网地址，开「仅本地翻译」后会被停用。）',
  noteEn:
    'Good for self-hosted or offline use; most public instances are rate-limited. (Public instances live on the internet, so local-only mode disables them.)',
  supportsBatch: true,
  fields: [
    { key: 'libreUrl', label: '实例地址', labelEn: 'Instance URL', type: 'text', placeholder: 'http://127.0.0.1:5000' },
    { key: 'libreKey', label: 'API Key（可选）', labelEn: 'API Key (optional)', type: 'password' },
  ],
  async translate(texts, ctx) {
    const base = (ctx.cfg?.libreUrl || 'http://127.0.0.1:5000').replace(/\/+$/, '');
    const out = [];
    for (let i = 0; i < texts.length; i += 10) {
      const batch = texts.slice(i, i + 10);
      const payload = {
        q: batch,
        source: mapLang('libretranslate', ctx.source, 'source'),
        target: mapLang('libretranslate', ctx.target, 'target'),
        format: 'text',
      };
      if (ctx.cfg?.libreKey) payload.api_key = ctx.cfg.libreKey;
      const r = await request(`${base}/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        proxy: ctx.proxy,
        timeout: 30000,
      });
      if (r.status !== 200) throw new Error(`LibreTranslate HTTP ${r.status}: ${r.text.slice(0, 120)}`);
      const j = JSON.parse(r.text);
      const arr = Array.isArray(j.translatedText) ? j.translatedText : [j.translatedText];
      for (const t of arr) out.push(clean(t));
    }
    return out;
  },
};

// ---------------------------------------------------------------- 仅用缓存（离线，不联网）
const cacheOnly = {
  id: 'cache-only',
  name: '仅用缓存（离线·不联网）',
  nameEn: 'Cache only (offline · no network)',
  note: '只用本地已翻译过的内容，不发起任何网络请求。',
  noteEn: 'Uses only what is already translated locally; makes no network requests at all.',
  supportsBatch: true,
  async translate() {
    throw new Error('离线模式：该文本尚未有缓存');
  },
};

// ---------------------------------------------------------------- 内置引擎（本机 Edge 的端侧模型）
// 用 Edge/Chrome 138+ 的 Translator API：语言包在**本地**运行，
// 离线可用、不联网、不需要密钥，也不涉及任何第三方接口条款。
// 适合轻度使用 / 没有梯子 / 不想配 Key 的场景。
//
// 注意：模型跑在**浏览器页面里**（Gale 页面，或插件拉起的无窗口 Edge），Node 侧没法直接调，
// 所以实现是"转发"——由 server.mjs 通过 CDP 调 window.__galeTrans.localTranslate。
let _localTranslator = null;

/** 由 server.mjs 注入：把一批文本交给页面里的本地模型翻译 */
export function setLocalTranslator(fn) {
  _localTranslator = fn;
}
export function hasLocalTranslator() {
  return typeof _localTranslator === 'function';
}

// 内置引擎的**环境结论**：'' 未知 | 'ready' 可用 | 'needDownload' 语言包待下载 |
// 'unavailable' 本环境不提供该语言对的端侧模型 | 'unsupported' 没有 Translator API。
//
// 为什么需要它：实测 Gale 的 WebView2（Edg/154）里 Translator API **存在**，
// 但所有语言对的 availability() 都返回 'unavailable'，Translator.create() 直接抛
// NotSupportedError: Unable to create translator for the given source and target language.
// 这是"该运行环境根本不带端侧模型"，**不是**"还没下载"——点多少次「启用内置引擎」都不会成功。
// 所以要把这条结论缓存下来：① 别再把 builtin 放进候选链白刷错误日志；② 让界面说实话。
let _localEngineEnv = { state: '', reason: '', wantKey: '', at: 0 };

export function setLocalEngineEnv(env) {
  if (!env || typeof env !== 'object') return;
  const state = String(env.state || '');
  if (!state) return;
  _localEngineEnv = {
    state,
    reason: String(env.reason || ''),
    wantKey: String(env.wantKey || ''),
    at: Date.now(),
  };
}

export function localEngineEnv() {
  return { ..._localEngineEnv };
}

/** 内置引擎在当前环境是不是"根本用不了"（不是缺语言包，而是环境不提供模型）。 */
export function isLocalEngineUnusable() {
  return _localEngineEnv.state === 'unavailable' || _localEngineEnv.state === 'unsupported';
}

const builtin = {
  id: 'builtin',
  name: '内置引擎（本机 Edge 端侧模型·离线·免密钥）',
  nameEn: 'Built-in engine (on-device model in your Edge · offline · no key)',
  note: '完全离线、不联网、不需要任何密钥；首次启用要下载约 200 MB 语言包（一次性，之后一直可用）。Gale 自带的 WebView2 不提供端侧模型，插件会自动拉起一个无窗口的 Edge 来跑模型 —— 所以本机要装有 Edge（系统里装的普通 Edge 就行），不需要你另外装别的东西。',
  noteEn:
    'Fully offline, no network, no key. The first enable downloads a ~200 MB language pack (one-time, then it stays available). Gale\'s own WebView2 does not ship the on-device model, so the add-on launches a windowless Edge to run it — which means Microsoft Edge must be installed on this machine (the normal system install is enough); nothing else is required.',
  proxy: 'never',
  supportsBatch: true,
  async translate(texts, ctx) {
    if (!_localTranslator) {
      throw new Error('内置引擎不可用：还没连接到 Gale 页面（请用 start.cmd 启动 Gale 后再试）');
    }
    if (isLocalEngineUnusable()) {
      throw new Error(
        `内置引擎在当前环境不可用：${_localEngineEnv.reason || '运行环境不提供端侧翻译模型'}（请改用其它翻译节点）`,
      );
    }
    return _localTranslator(texts, { source: ctx.source, target: ctx.target });
  },
};

// 注册顺序 = 界面上「翻译节点」下拉框的顺序。
// builtin 放第一位：它是**不需要密钥、零第三方条款**的那个，也是新装的默认节点。
export const PROVIDERS = {
  builtin,
  tencent,
  youdao,
  google,
  deepl,
  openai,
  'local-llm': localLlm,
  libretranslate,
  'cache-only': cacheOnly,
};

export const CUSTOM_PREFIX = 'custom:';

/** 这个 id 是不是一个存在的翻译节点（含自定义节点）——配置里残留的失效 id 会被清理掉 */
export function isKnownProvider(id) {
  const s = String(id || '');
  if (s.startsWith(CUSTOM_PREFIX)) return true;
  return !!PROVIDERS[s];
}

// ---------------------------------------------------------------- 「仅本地」判定
// 「仅本地翻译（禁用联网）」这个开关靠它决定哪些节点还留着。判定标准很实在：
// **这个节点发出的请求会不会离开本机**（看地址是不是回环地址），而不是名字里有没有"本地"。
//   · builtin / cache-only：压根不发网络请求 → 本地
//   · local-llm / libretranslate / 自定义节点：地址是 127.0.0.1 之类 → 本地；写成公网地址
//     那就是真的在联网（比如别人的 LibreTranslate 实例），仅本地模式下会被停用
//   · tencent / youdao / google：一律远程（免密钥的网页接口，仍然在联网）
//   · deepl / openai：一律远程（都要自备密钥）
/** 这个地址是不是指向本机（回环）——从 net.mjs 复用同一套判断 */
export function isProviderLocal(id, cfg = {}) {
  const s = String(id || '');
  if (s === 'builtin' || s === 'cache-only') return true;
  if (s.startsWith(CUSTOM_PREFIX)) {
    const sid = s.slice(CUSTOM_PREFIX.length);
    const src = (cfg.customSources || []).find((x) => String(x.id) === sid);
    return !!src && isLoopbackUrl(src.url);
  }
  if (s === 'local-llm') return isLoopbackUrl(cfg.localLlmBaseUrl || 'http://127.0.0.1:11434/v1');
  if (s === 'libretranslate') return isLoopbackUrl(cfg.libreUrl || 'http://127.0.0.1:5000');
  return false;
}

/** 仅本地模式：把节点列表按"能不能留下"过滤（顺序不变） */
export function filterLocalProviders(ids, cfg = {}) {
  return (ids || []).filter((id) => isKnownProvider(id) && isProviderLocal(id, cfg));
}

/**
 * 列出可用翻译源：内置源（可按配置停用）+ 用户自定义节点
 * @param {{disabledSources?:string[], customSources?:Array}} cfg
 * @param {string} lang 界面语言（'en' 时返回英文名 / 说明 / 字段标签）
 */
export function listProviders(cfg = {}, lang = 'zh-CN') {
  const en = String(lang || '').toLowerCase().startsWith('en');
  const disabled = new Set((cfg.disabledSources || []).map(String));
  const builtins = Object.values(PROVIDERS)
    .filter((p) => !disabled.has(p.id))
    .map((p) => ({
      id: p.id,
      name: (en && p.nameEn) || p.name,
      note: (en && p.noteEn) || p.note,
      supportsBatch: !!p.supportsBatch,
      fields: (p.fields || []).map((f) => (en && f.labelEn ? { ...f, label: f.labelEn } : f)),
      custom: false,
      // 请求会不会离开本机（界面据此在「仅本地翻译」开启时把在线节点置灰）
      local: isProviderLocal(p.id, cfg),
    }));
  const customs = (cfg.customSources || [])
    .filter((s) => s && s.id)
    .map((s) => ({
      id: CUSTOM_PREFIX + s.id,
      name: `${s.name || s.id}${s.enabled === false ? (en ? ' (disabled)' : '（已停用）') : ''}`,
      note: s.note || (en ? `Custom provider · ${s.url || ''}` : `自定义节点 · ${s.url || ''}`),
      supportsBatch: s.batch !== false,
      fields: [],
      custom: true,
      enabled: s.enabled !== false,
      sourceId: s.id,
      local: isProviderLocal(CUSTOM_PREFIX + s.id, cfg),
    }));
  return [...builtins, ...customs];
}

export function getProvider(id) {
  if (String(id).startsWith(CUSTOM_PREFIX)) {
    const sid = String(id).slice(CUSTOM_PREFIX.length);
    return {
      id,
      name: '自定义节点 ' + sid,
      supportsBatch: true,
      async translate(texts, ctx) {
        const list = ctx?.cfg?.customSources || [];
        const source = list.find((s) => String(s.id) === sid);
        if (!source) throw new Error('找不到自定义节点：' + sid);
        if (source.enabled === false) throw new Error('自定义节点已停用：' + sid);
        return runCustomSource(source, texts, ctx);
      },
    };
  }
  const p = PROVIDERS[id];
  if (!p) throw new Error('未知翻译源: ' + id);
  return p;
}

export { mapLimit, sleep, splitLong, runCustomSource };
