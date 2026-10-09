// Edge worker 页面脚本（由服务托管在 /edge-worker.js，页面在 /edge-worker）。
//
// 它把「内置引擎」的接口原样实现一遍：localStatus / localPrepare / localTranslate / localReset。
// 为什么要在页面里跑：Translator API 只在浏览器页面里存在，Node 侧碰不到，
// 所以服务通过 CDP 调这里的 window.__edgeTrans，跟调 Gale 页面里的 __galeTrans 是同一套玩法。
//
// 与 core/inject.js 里那份的区别：
//   · 这里没有 Gale 的页面状态（state / scheduleScan），所以省掉那些"唤醒重新扫描"的收尾；
//   · 'unavailable' 的文案不能写"Gale 用的 WebView2 就是如此" —— 这段代码本来就是在真 Edge 里跑的，
//     真出现了说明是别的原因（版本太旧 / 策略禁用），文案必须是中性的。
(() => {
  const PACK_BYTES = 197.5 * 1024 * 1024; // 实测 en→zh 语言包 197.5 MB，用于把 0~1 进度换算成 MB 与速度
  const LOCAL = {
    supported: typeof Translator !== 'undefined',
    translators: new Map(),
    preparing: null,
    lastError: '',
    env: '',
    envReason: '',
  };

  function localVerdict(availability) {
    if (!LOCAL.supported) {
      return { state: 'unsupported', unusable: true, reason: '当前环境没有 Translator API（需要 Edge / Chrome 138 以上）' };
    }
    if (availability === 'available') return { state: 'ready', unusable: false, reason: '' };
    if (availability === 'downloadable' || availability === 'downloading') {
      return { state: 'needDownload', unusable: false, reason: '内置引擎的语言包还没下载好：请在设置里点一下「启用内置引擎」' };
    }
    return {
      state: 'unavailable',
      unusable: true,
      reason: '当前运行环境不提供端侧翻译模型，内置引擎无法使用，请在设置里改用其它翻译节点',
    };
  }

  function rememberVerdict(availability) {
    const v = localVerdict(availability);
    LOCAL.env = v.state;
    LOCAL.envReason = v.reason;
    return v;
  }

  function localSpeed(job) {
    const s = job.samples;
    if (!s || s.length < 2) return 0;
    const last = s[s.length - 1];
    let i = s.length - 1;
    while (i > 0 && last.t - s[i - 1].t <= 3000) i--;
    const first = s[i];
    const dt = (last.t - first.t) / 1000;
    const dp = last.p - first.p;
    if (dt < 0.4 || dp <= 0) return 0;
    return (dp * PACK_BYTES) / dt;
  }

  function localLang(code) {
    const c = String(code || '').toLowerCase();
    if (!c || c === 'auto') return 'en';
    if (c.startsWith('zh')) return /hant|tw|hk|mo/.test(c) ? 'zh-Hant' : 'zh';
    return c.split('-')[0];
  }

  function localPair(source, target) {
    return { sl: localLang(source), tl: localLang(target) };
  }

  async function getLocalTranslator(source, target) {
    if (!LOCAL.supported) throw new Error('本地翻译后端需要 Edge / Chrome 138 或更高版本');
    const { sl, tl } = localPair(source, target);
    if (sl === tl) throw new Error('源语言与目标语言相同，不需要翻译');
    const key = sl + '>' + tl;
    const cached = LOCAL.translators.get(key);
    if (cached) return cached;
    const avail = await Translator.availability({ sourceLanguage: sl, targetLanguage: tl });
    if (avail !== 'available') {
      const v = rememberVerdict(avail);
      throw new Error(v.reason);
    }
    rememberVerdict(avail);
    const tr = await Translator.create({ sourceLanguage: sl, targetLanguage: tl });
    LOCAL.translators.set(key, tr);
    return tr;
  }

  async function localStatus(source, target) {
    if (!LOCAL.supported) {
      return {
        supported: false,
        env: 'unsupported',
        unusable: true,
        reason: '当前浏览器不支持 Translator API（需要 Edge / Chrome 138 以上）',
      };
    }
    const want = localPair(source, target);
    const wantKey = want.sl + '>' + want.tl;
    const out = { supported: true, preparing: null, lastError: LOCAL.lastError, wantKey, ready: false, pairs: {} };
    const job = LOCAL.preparing;
    if (job) {
      const p = Math.max(0, Math.min(1, Number(job.progress) || 0));
      const speedBps = localSpeed(job);
      out.preparing = {
        key: job.key,
        progress: p,
        elapsedMs: Date.now() - job.startedAt,
        hasProgress: job.samples.length > 0,
        speedBps,
        downloadedBytes: p * PACK_BYTES,
        totalBytes: PACK_BYTES,
        etaMs: speedBps > 0 && p > 0 && p < 1 ? (((1 - p) * PACK_BYTES) / speedBps) * 1000 : null,
        samples: job.samples.length,
      };
    }
    for (const k of [...new Set([wantKey, 'en>zh', 'en>zh-Hant'])]) {
      const [sl, tl] = k.split('>');
      try {
        out.pairs[k] = await Translator.availability({ sourceLanguage: sl, targetLanguage: tl });
      } catch (e) {
        out.pairs[k] = 'error: ' + ((e && e.message) || e);
      }
    }
    out.ready = out.pairs[wantKey] === 'available';
    const v = rememberVerdict(out.pairs[wantKey]);
    out.env = v.state;
    out.unusable = v.unusable;
    out.reason = v.reason;
    return out;
  }

  async function localPrepare(source, target) {
    if (!LOCAL.supported) throw new Error('本地翻译后端需要 Edge / Chrome 138 或更高版本');
    const { sl, tl } = localPair(source, target);
    const key = sl + '>' + tl;
    if (LOCAL.translators.has(key)) return { ok: true, cached: true, key };
    const avail0 = await Translator.availability({ sourceLanguage: sl, targetLanguage: tl }).catch(() => '');
    if (avail0) {
      const v0 = rememberVerdict(avail0);
      if (v0.unusable) {
        LOCAL.lastError = v0.reason;
        throw new Error(v0.reason);
      }
    }
    if (LOCAL.preparing && LOCAL.preparing.key === key) {
      await LOCAL.preparing.promise;
      return { ok: true, cached: true, key };
    }
    const job = { key, progress: 0, startedAt: Date.now(), samples: [], promise: null };
    job.promise = (async () => {
      try {
        const tr = await Translator.create({
          sourceLanguage: sl,
          targetLanguage: tl,
          monitor(m) {
            m.addEventListener('downloadprogress', (e) => {
              const p = Number(e.loaded);
              job.progress = Number.isFinite(p) ? p : 0;
              job.samples.push({ t: Date.now(), p: job.progress });
              if (job.samples.length > 60) job.samples.shift();
            });
          },
        });
        LOCAL.translators.set(key, tr);
        LOCAL.lastError = '';
      } catch (e) {
        LOCAL.lastError = (e && e.message) || String(e);
        throw e;
      } finally {
        LOCAL.preparing = null;
      }
    })();
    LOCAL.preparing = job;
    const t0 = Date.now();
    await job.promise;
    return { ok: true, cached: false, key, ms: Date.now() - t0 };
  }

  async function localReset() {
    const n = LOCAL.translators.size;
    LOCAL.translators.clear();
    LOCAL.lastError = '';
    return { ok: true, cleared: n, downloading: !!LOCAL.preparing };
  }

  async function localTranslate(texts, opts = {}) {
    const tr = await getLocalTranslator(opts.source, opts.target);
    const out = [];
    for (const t of texts) {
      try {
        out.push(await tr.translate(String(t)));
      } catch (e) {
        throw new Error('本地翻译后端翻译失败：' + ((e && e.message) || e));
      }
    }
    return out;
  }

  window.__edgeTrans = {
    __installed: true,
    ready: true,
    localTranslate,
    localPrepare,
    localStatus,
    localReset,
    _localSpeed: localSpeed,
    _localPackBytes: PACK_BYTES,
    info: () => ({
      ua: navigator.userAgent,
      supported: LOCAL.supported,
      languages: LOCAL.supported ? [...LOCAL.translators.keys()] : [],
      preparing: !!LOCAL.preparing,
      env: LOCAL.env,
      reason: LOCAL.envReason,
      lastError: LOCAL.lastError,
    }),
  };

  // 页面上给个人眼看的痕迹（worker 是无窗口的，主要方便有头调试时确认）
  const el = document.getElementById('wstate');
  if (el) el.textContent = LOCAL.supported ? '端侧翻译引擎可用' : '端侧翻译引擎不可用（Translator API 不存在）';
})();
