/* Gale 汉化外挂 · 页面内翻译引擎
 * 由本地服务通过 CDP 注入。不修改 Gale 任何文件，靠文本特征 + 结构启发式定位，
 * 因此 Gale 版本更新后通常无需改动即可继续工作。
 */
(() => {
  // 重新注入（服务重启 / 升级脚本）时，先拆掉旧实例，避免两套引擎抢改同一段文本。
  // 旧版本实例可能没有 dispose（升级场景），此时直接接管，必要时由 reload 清理残留译文。
  const prev = window.__galeTrans;
  if (prev) {
    try {
      if (typeof prev.dispose === 'function') prev.dispose();
      else if (prev.state?.pill?.host) prev.state.pill.host.remove();
    } catch {}
    try {
      delete window.__galeTrans;
    } catch {}
  }

  const BOOT = window.__GALE_TR__ || {};
  const API = (BOOT.api || 'http://127.0.0.1:8799').replace(/\/+$/, '');
  // dry = 离线回放自检模式：只建实例、只做规则判定，不联网、不建悬浮条、不自动翻译
  const DRY = !!BOOT.dry;
  const log = (...a) => BOOT.debug && console.log('[Gale汉化]', ...a);

  /** Trusted Types 安全的 shadowRoot.innerHTML 写入：成功返回 true，失败返回 false（不抛异常）。
   *  优先用 core/i18n.js 提供的 GALE_UI.setHTML（它会建一个 Trusted Types policy），
   *  没有时退回普通写法。 */
  function setShadowHTML(el, html) {
    const UI = window.GALE_UI;
    if (UI && typeof UI.setHTML === 'function') return UI.setHTML(el, html);
    try {
      el.innerHTML = html;
      return true;
    } catch {
      return false;
    }
  }

  // 双保险：绝不注入到插件自己的设置页 —— 否则引擎会把设置页的界面文字当成
  // Gale 的英文内容去翻译（真出现过：i18n 把标题写成 "Usage"，引擎又按固定译法
  // 把 "Usage" 翻回 "使用方法"）。判断依据：与 API 同源（同 host 同 port）。
  try {
    const api = new URL(API);
    if (location.hostname === api.hostname && location.port === api.port) {
      log('当前页面是插件自己的设置页，跳过注入');
      return;
    }
  } catch {}

  const state = {
    __installed: true,
    enabled: true,
    showOriginal: false,
    config: {
      translateNames: false,
      hoverOriginal: true,
      minLen: 3,
      target: 'zh-CN',
      provider: 'builtin',
      glossary: [],
      scope: 'content',
    },
    providers: [],
    nodes: new Set(), // 我们改过的文本节点（用于还原）
    originals: new WeakMap(), // node -> 原文
    applied: new WeakMap(), // node -> 我们写入的译文
    pending: new WeakMap(), // node -> 正在翻译的原文
    failed: new WeakMap(), // node -> 失败的原文
    failedAt: new WeakMap(),
    protectedNodes: new Set(),
    phraseKeys: new Set(),
    forceKeys: new Set(),
    stats: { translated: 0, requests: 0, failed: 0, lastError: null },
    // 关键锚点自检：Gale 前端结构若发生大改，这里会立刻告警，而不是静默什么都不翻
    health: {
      bootedAt: Date.now(),
      scans: 0,
      lastScanAt: 0,
      mode: 'normal',
      anchors: {},
      everSeen: {},
      candidates: 0,
      latinNodes: 0,
      zeroCandidateStreak: 0,
      degraded: false,
      reasons: [],
    },
    pill: null,
  };
  // 离线回放测试可以在注入前通过 BOOT.config 覆盖页面侧配置（minLen / translateConfigPage 等）
  if (BOOT.config && typeof BOOT.config === 'object') Object.assign(state.config, BOOT.config);

  // ------------------------------------------------------------------ 文本筛选
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD', 'SAMP', 'TT', 'SVG', 'TEXTAREA', 'INPUT', 'OPTION', 'IFRAME']);
  const CHROME_SEL =
    'nav,header,footer,button,select,option,input,textarea,[role="menubar"],[role="menu"],[role="menuitem"],[role="tooltip"],[contenteditable="true"]';
  // 配置页：左侧模组名与配置分组标题本身就放在 <button> 里，这些按钮不算“界面框架”
  const CHROME_CONFIG_SEL =
    'nav,header,footer,select,option,input,textarea,[role="menubar"],[role="menu"],[role="menuitem"],[role="tooltip"],[contenteditable="true"]';
  const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
  const LATIN_WORD = /[A-Za-z]{2,}/;

  /** 当前页面模式：配置页用更宽松的规则，否则左侧列表会被当成按钮跳掉 */
  function pageMode() {
    if (state.config.translateConfigPage === false) return 'normal';
    return /^\/config(\/|$)/i.test(location.pathname) ? 'config' : 'normal';
  }

  // 单词型文本中，愿意翻译的常见英文小标题/词
  const COMMON_WORDS = new Set(
    ('features feature installation install installing requirements requirement credits credit changelog changes ' +
      'configuration config notes note overview description usage commands command mechanics compatibility ' +
      'contents license permissions faq tips warning warnings dependencies dependency translations translation ' +
      'links link support donation setup guide tutorial about details information instructions introduction ' +
      'known issues fixes added changed removed fixed important optional required recommended example examples ' +
      'settings options default enable disable enabled disabled true false yes no source sources menu mods modding ' +
      'client server clients servers download downloads changelogs wiki contact compatibility').split(/\s+/),
  );

  function glossarySet() {
    const g = new Set();
    for (const t of state.config.glossary || []) {
      const from = typeof t === 'string' ? t : t && t.from;
      if (from) g.add(String(from).trim().toLowerCase());
    }
    return g;
  }
  let _glossary = glossarySet();
  const refreshGlossary = () => (_glossary = glossarySet());

  /** 判断是否是"名字/标识符"这类不该翻译的短文本。
   *  关键：先区分"句子"与"短标签"，句子一律翻译（否则句中的 BepInEx、AzuCraftyBoxes
   *  会被 CamelCase 规则误判成名字，整句被跳过）。 */
  function isProtectedShape(s, relaxed = false) {
    const t = s.trim();
    if (_glossary.has(t.toLowerCase())) return true;
    if (/^(https?:\/\/|www\.)\S+$/i.test(t)) return true;
    if (/^[\d\s.,:%+\-/()[\]]+[a-zA-Z]{0,3}$/.test(t)) return true; // 纯数字/体积/计数

    // 配置键名 / 标识符列表：Beech_small1，FirTree_small ...（要在"句子判定"之前拦下）
    if (/_/.test(t) && t.split(/[\s,，、]+/).filter(Boolean).length >= 2) return true;

    // 文件路径 / 文件名：BepInEx\config\Azumatt.Xxx.cfg —— 含斜杠或以扩展名结尾的单段文本。
    // 必须放在"句子判定"之前，否则会因为带 "." 被当成句子而送去翻译（1.2 的缺陷）。
    if (!/\s/.test(t) && /[\\/]/.test(t)) return true;
    if (!/\s/.test(t) && /\.[a-z0-9]{1,6}$/i.test(t)) return true;

    // 配置页左侧列表：配置文件名、插件 GUID 这类标识符仍然保护，
    // 但「Achievements」「CheatFlags」「Craft From Chests」这类标题要翻译
    if (relaxed) {
      if (/\.(dll|yml|yaml|json|cfg|ini|txt|zip|exe|log|md)$/i.test(t)) return true;
      if (!/\s/.test(t) && /[._/\\-]/.test(t)) return true; // 单段标识符：zenox.betterui / BetterUIMK_BetterUI
      if (/^[A-Z0-9\s._\-+*/#]+$/.test(t) && t.length > 1 && !/[a-z]/.test(t)) return true; // 全大写
      return false;
    }

    const words = t.split(/\s+/);
    const core = t.replace(/[\s.!?,;:，。！？；：、"')\]】]+$/, ''); // 去掉尾部标点再判断
    const sentenceLike = /[.!?,;:，。！？；：]/.test(core) || words.length > 3;
    if (sentenceLike) return false; // 句子一律翻译

    if (/^[A-Z0-9\s._\-+*/#]+$/.test(t) && t.length > 1 && !/[a-z]/.test(t)) return true; // 全大写
    if (/[a-z][A-Z]/.test(t)) return true; // CamelCase：AzuCraftyBoxes / PlantEasily
    if (/\.(dll|yml|yaml|json|cfg|md|ini|txt|zip|exe|log)$/i.test(t)) return true; // 文件名
    if (/\d/.test(t) && !/\s/.test(t)) return true; // 含数字的单词：r2modman / v1.2
    if (words.length === 1) {
      if (t.length <= 2) return true;
      if (/[._/\\]/.test(t)) return true; // 标识符 / 路径
      if (/^[a-z0-9-]+$/.test(t)) return false; // 全小写单词 -> 翻译
      return !COMMON_WORDS.has(t.toLowerCase()); // 首字母大写单词 -> 仅常见词翻译
    }
    return false;
  }

  /** 乱码识别：Gale 里个别 mod 的说明是 GBK 字节被当 Latin-1 解码的结果，
   *  这类文本里会混入正常英文绝不会出现的字符。
   *  注意不要放入 IPA / 修饰字母区（0x250-0x2FF）：正常音标标注会用它们。 */
  const SUSPICIOUS =
    /[\u00aa-\u00bf\u0100-\u024f\u0370-\u03ff\u0400-\u04ff\u0530-\u058f\u0590-\u05ff\u0600-\u06ff]/;
  function looksLikeMojibake(s) {
    return SUSPICIOUS.test(s);
  }

  function isChrome(el, mode = 'normal') {
    return !!el.closest(mode === 'config' ? CHROME_CONFIG_SEL : CHROME_SEL);
  }

  function inMarkdown(el) {
    return !!el.closest('.markdown, [class*="markdown"]');
  }

  /** 收集"卡片"根节点（搜索结果行 / 依赖列表行），用于保护模组名与作者名 */
  function collectCards() {
    const out = [];
    const vl = document.querySelector('svelte-virtual-list-contents');
    if (vl) for (const c of vl.children) out.push(c);
    if (out.length) return out;
    // 兜底：找包含 ≥3 个「图标 + 长英文文本」子项的容器
    const containers = [...document.querySelectorAll('div,ul,ol')].filter((el) => el.children.length >= 3 && el.children.length <= 200);
    for (const el of containers) {
      let hits = 0;
      for (const c of el.children) {
        if (c.querySelector('img') && /[A-Za-z]{3}/.test(c.textContent || '') && (c.textContent || '').length > 40) hits++;
      }
      if (hits >= 3) {
        for (const c of el.children) out.push(c);
        break;
      }
    }
    return out;
  }

  function cardTextNodes(card) {
    const res = [];
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const s = (n.nodeValue || '').trim();
      if (s.length < 2 || !LATIN_WORD.test(s) || CJK.test(s)) continue;
      const el = n.parentElement;
      if (!el || SKIP_TAGS.has(el.tagName)) continue;
      res.push(n);
    }
    return res;
  }

  function markProtectedNodes(mode = 'normal') {
    state.protectedNodes.clear();
    if (state.config.translateNames) return;
    if (mode === 'config') return; // 配置页的左列就是需要翻译的配置名，不做名称保护
    for (const card of collectCards()) {
      const nodes = cardTextNodes(card);
      if (!nodes.length) continue;
      state.protectedNodes.add(nodes[0]); // 名称
      // 作者 / 版本等紧跟名称的短文本（不依赖它们在 DOM 中的确切位置）
      let short = 0;
      for (const n of nodes) {
        if (n === nodes[0]) continue;
        const s = (n.nodeValue || '').trim();
        if (s.length <= 40 && s.split(/\s+/).length <= 3) {
          state.protectedNodes.add(n);
          if (++short >= 2) break;
        }
      }
    }
  }

  /** 保护规则可能"迟到"（首次扫描时列表还没渲染完），
   *  这里把已经误翻的保护文本还原回原文。 */
  function enforceProtected() {
    for (const node of state.protectedNodes) {
      const orig = state.originals.get(node);
      const applied = state.applied.get(node);
      if (orig == null || applied == null) continue;
      if (applied === node.nodeValue && orig.trim() !== node.nodeValue.trim()) {
        node.nodeValue = orig;
        state.applied.delete(node);
        state.nodes.delete(node);
        state.stats.translated = Math.max(0, state.stats.translated - 1);
      }
    }
  }

  function isCandidate(node, mode = 'normal') {
    if (!node.isConnected) return false;
    const raw = node.nodeValue;
    if (!raw) return false;
    const s = raw.trim();
    if (s.length < state.config.minLen) return false;
    if (!LATIN_WORD.test(s)) return false;
    if (mode !== 'config' && CJK.test(s)) return false; // 配置页允许中英混排的标题
    const el = node.parentElement;
    if (!el) return false;
    if (SKIP_TAGS.has(el.tagName)) return false;
    if (state.forceKeys.has(s.toLowerCase())) return true; // 用户点名要翻译：绕过所有启发式
    if (el.closest('code,pre,kbd,samp,svg,script,style,[contenteditable="true"]')) return false;
    if (state.phraseKeys.has(s.toLowerCase())) return true; // 固定译法最高优先级
    if (state.protectedNodes.has(node)) return false;
    if (isChrome(el, mode)) return false;
    if (looksLikeMojibake(s)) return false;
    // 详情页头部的模组名/作者是 <a>；README 内的链接仍翻译
    if (el.closest('a') && !inMarkdown(el) && mode !== 'config') return false;
    const relaxed = mode === 'config' && !!el.closest('button');
    if (isProtectedShape(s, relaxed)) return false;
    return true;
  }

  function collectCandidates(mode = 'normal') {    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        return isCandidate(n, mode) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  // ------------------------------------------------------------------ 关键锚点自检
  /** 页面上"含英文、且不在脚本/样式里"的文本节点数 —— 判断这一页是否本应有内容可翻 */
  function countLatinNodes() {
    let n = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const s = (node.nodeValue || '').trim();
      if (s.length < state.config.minLen || !LATIN_WORD.test(s)) continue;
      const el = node.parentElement;
      if (!el || SKIP_TAGS.has(el.tagName)) continue;
      n++;
    }
    return n;
  }

  /** 每次扫描后更新健康状态：锚点是否还在、候选数是否为 0（Gale 改版会立刻暴露） */
  function updateHealth(candidates, mode) {
    const h = state.health;
    h.scans++;
    h.lastScanAt = Date.now();
    h.mode = mode;
    const anchors = {
      markdown: !!document.querySelector('.markdown, [class*="markdown"]'),
      virtualList: !!document.querySelector('svelte-virtual-list-contents'),
      cardContainer: collectCards().length > 0,
    };
    h.anchors = anchors;
    for (const k of Object.keys(anchors)) if (anchors[k]) h.everSeen[k] = true;
    h.candidates = candidates;

    if (candidates > 0) {
      h.zeroCandidateStreak = 0;
      h.latinNodes = -1; // -1 = 本页有候选，无需再全页统计（省一次遍历）
    } else {
      h.latinNodes = countLatinNodes();
      h.zeroCandidateStreak = h.latinNodes > 0 ? h.zeroCandidateStreak + 1 : 0;
    }

    const reasons = [];
    const anchorMiss = !anchors.markdown && !anchors.virtualList && !anchors.cardContainer;
    if (h.zeroCandidateStreak >= 3 && anchorMiss) {
      reasons.push('页面有英文文本，但识别到的可翻译内容为 0，且未匹配到任何已知锚点');
    }
    if (Date.now() - h.bootedAt > 20000 && !h.everSeen.markdown && !h.everSeen.virtualList && !h.everSeen.cardContainer) {
      reasons.push('启动 20 秒内未匹配到任何已知锚点（.markdown / 虚拟列表 / 卡片容器）');
    }
    h.reasons = reasons;
    h.degraded = reasons.length > 0;
    return h;
  }

  /** 供设置面板 / 抽屉 / 自检脚本读取的健康快照 */
  function health() {
    const h = state.health;
    return {
      degraded: h.degraded,
      reasons: h.reasons,
      scans: h.scans,
      mode: h.mode,
      anchors: h.anchors,
      everSeen: h.everSeen,
      candidates: h.candidates,
      latinNodes: h.latinNodes,
      zeroCandidateStreak: h.zeroCandidateStreak,
      translated: state.stats.translated,
      lastError: state.stats.lastError,
      installed: true,
      api: API,
    };
  }

  /** 离线回放自检：不联网，纯规则判定"哪些文本会被翻译 / 为什么没翻"。
   *  tools/replay-test.mjs 用它把固化下来的 DOM 快照跑一遍，和期望结果比对。 */
  function dryRun() {
    const mode = pageMode();
    markProtectedNodes(mode);
    const candidates = [];
    const classified = {};
    const bump = (reason, text) => {
      (classified[reason] ||= []).push(text);
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const raw = (n.nodeValue || '').trim();
      if (!raw || !LATIN_WORD.test(raw)) continue;
      const el = n.parentElement;
      if (!el || SKIP_TAGS.has(el.tagName)) continue;
      if (state.forceKeys.has(raw.toLowerCase())) {
        bump('forced', raw);
        continue;
      }
      if (state.phraseKeys.has(raw.toLowerCase())) {
        bump('phrase', raw);
        continue;
      }
      if (state.protectedNodes.has(n)) {
        bump('mod-name', raw);
        continue;
      }
      if (isCandidate(n, mode)) {
        candidates.push(raw);
        continue;
      }
      if (_glossary.has(raw.toLowerCase())) bump('glossary', raw);
      else if (isChrome(el, mode)) bump('ui-chrome', raw);
      else if (el.closest('code,pre,kbd,samp')) bump('code', raw);
      else if (looksLikeMojibake(raw)) bump('mojibake', raw);
      else if (raw.length < state.config.minLen) bump('too-short', raw);
      else if (el.closest('a') && !inMarkdown(el) && mode !== 'config') bump('link', raw);
      else if (isProtectedShape(raw, mode === 'config' && !!el.closest('button'))) bump('identifier', raw);
      else bump('other', raw);
    }
    const dedup = (a) => [...new Set(a)];
    const classifiedOut = Object.fromEntries(Object.entries(classified).map(([k, v]) => [k, dedup(v)]));
    const counts = Object.fromEntries(Object.entries(classifiedOut).map(([k, v]) => [k, v.length]));
    counts.translatable = dedup(candidates).length;
    return {
      route: location.pathname,
      mode,
      counts,
      candidates: dedup(candidates),
      classified: classifiedOut,
    };
  }

  /** 软应用：重新拉页面侧配置 → 还原译文 → 重新扫描。
   *  不刷新页面，所以页内抽屉不会关掉、滚动位置也不会丢。 */
  async function softApply() {
    try {
      await refreshProviderSelect();
    } catch {}
    state.failed = new WeakMap();
    state.failedAt = new WeakMap();
    restoreAll();
    scheduleScan(60);
    return true;
  }

  /** 覆盖率体检：把页面上所有含英文的文本按"为什么没翻"归类，供设置面板展示 */
  function coverage(mode = pageMode(), sampleLimit = 15) {
    const counts = {};
    const samples = {};
    const bump = (reason, text) => {
      counts[reason] = (counts[reason] || 0) + 1;
      if (text && (samples[reason] ||= []).length < sampleLimit) samples[reason].push(text);
    };

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const raw = (n.nodeValue || '').trim();
      if (!raw) continue;
      // 我们翻译过的节点：即使已经全中文（不再含拉丁字母）也要计入"已译"
      if (state.originals.has(n)) {
        bump('translated');
        continue;
      }
      // 翻译过但机翻原样返回（例如单个驼峰词）——不是漏译，但可以指定译法
      if (state.applied.has(n)) {
        bump('unchanged', raw.slice(0, 80));
        continue;
      }
      if (!LATIN_WORD.test(raw)) continue;
      const el = n.parentElement;
      if (!el || SKIP_TAGS.has(el.tagName)) continue;
      const short = raw.length < state.config.minLen;

      if (_glossary.has(raw.toLowerCase())) bump('glossary', raw.slice(0, 80));
      else if (state.forceKeys.has(raw.toLowerCase())) bump('forced', raw.slice(0, 80));
      else if (state.phraseKeys.has(raw.toLowerCase())) bump('phrase', raw.slice(0, 80));
      else if (isChinese(raw)) bump('translated');
      else if (short) bump('too-short', raw.slice(0, 40));
      else if (el.closest('code,pre,kbd,samp')) bump('code', raw.slice(0, 60));
      else if (looksLikeMojibake(raw)) bump('mojibake', raw.slice(0, 60));
      else if (state.protectedNodes.has(n)) bump('mod-name', raw.slice(0, 60));
      else if (isChrome(el, mode)) bump('ui-chrome', raw.slice(0, 60));
      else if (el.closest('a') && !inMarkdown(el) && mode !== 'config') bump('link', raw.slice(0, 60));
      else if (isProtectedShape(raw, mode === 'config' && !!el.closest('button'))) bump('identifier', raw.slice(0, 60));
      else if (state.pending.has(n)) bump('pending', raw.slice(0, 60));
      else if (state.failed.has(n)) bump('failed', raw.slice(0, 60));
      else bump('untranslated', raw.slice(0, 80));
    }
    return { route: location.pathname, mode, counts, samples };
  }

  function isChinese(s) {
    return CJK.test(s);
  }

  // ------------------------------------------------------------------ 翻译请求
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function api(pathname, body) {
    const res = await fetch(API + pathname, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${pathname} HTTP ${res.status}`);
    return res.json();
  }

  function applyTranslation(node, dst) {
    if (!node.isConnected) return;
    const cur = node.nodeValue;
    // 注意：Svelte 的文本节点常带首尾空白，比较时必须 trim，
    // 否则同一段会被反复"翻译"，并把它自己的译文当成原文记录下来。
    const applied = state.applied.get(node);
    if (applied != null && applied.trim() === cur.trim()) return;
    if (!state.originals.has(node)) state.originals.set(node, cur);
    state.applied.set(node, dst);
    state.nodes.add(node);
    node.nodeValue = dst;
    const el = node.parentElement;
    if (el && state.config.hoverOriginal) {
      const orig = (state.originals.get(node) || '').trim();
      if (orig && orig.length <= 300) el.setAttribute('data-gale-orig', orig);
    }
    state.stats.translated++;
  }

  function restoreAll() {
    for (const node of state.nodes) {
      if (!node.isConnected) continue;
      const orig = state.originals.get(node);
      if (orig != null) node.nodeValue = orig;
    }
    state.applied = new WeakMap();
    state.pending = new WeakMap();
    state.stats.translated = 0;
    updatePill();
  }

  let scanTimer = null;
  let scanning = false;

  function scheduleScan(delay = 300) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(runScan, delay);
  }

  function groupBatches(nodes) {
    const batches = [];
    let cur = [];
    let len = 0;
    for (const n of nodes) {
      const s = n.nodeValue.trim();
      if (len + s.length > 1200 && cur.length) {
        batches.push(cur);
        cur = [];
        len = 0;
      }
      cur.push(n);
      len += s.length;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  /** 判断一个批次是否"重要"（列表行 / 简述 / 标签这类短文本）——重要批次才走多节点择优 */
  function batchIsImportant(batch) {
    let important = 0;
    for (const n of batch) {
      const el = n.parentElement;
      if (!el) continue;
      if (el.closest('svelte-virtual-list-contents')) {
        important++;
        continue;
      }
      const inMd = !!el.closest('.markdown, [class*="markdown"]');
      const len = (n.nodeValue || '').trim().length;
      if (!inMd && len <= 320) important++;
    }
    return important * 2 >= batch.length;
  }

  /** 当前游戏名（顶部工具栏第一个带图标的按钮里的文字），用于给译库打标签 */
  let _gameCache = { at: 0, name: '' };
  function currentGame() {
    if (Date.now() - _gameCache.at < 30000) return _gameCache.name;
    let name = '';
    try {
      for (const b of document.querySelectorAll('button')) {
        if (!b.querySelector('img')) continue;
        const t =
          (b.innerText || '')
            .trim()
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)[0] || '';
        if (t && t.length <= 30 && /[A-Za-z\u4e00-\u9fff]/.test(t)) {
          name = t;
          break;
        }
      }
    } catch {}
    _gameCache = { at: Date.now(), name };
    return name;
  }

  /** LLM 润色完成后，服务端会把修订推回来：按"原文"匹配到节点并就地替换 */
  function applyRevisions(list) {
    if (!Array.isArray(list) || !list.length) return 0;
    const bySrc = new Map();
    for (const r of list) if (r && r.src && r.dst) bySrc.set(String(r.src).trim(), String(r.dst));
    let n = 0;
    for (const node of state.nodes) {
      if (!node.isConnected) continue;
      const orig = (state.originals.get(node) || '').trim();
      if (!orig) continue;
      const dst = bySrc.get(orig);
      if (!dst) continue;
      const applied = state.applied.get(node);
      if (applied != null && applied !== node.nodeValue) continue; // 页面已改过，不覆盖
      if (node.nodeValue.trim() === dst) continue;
      state.applied.set(node, dst);
      node.nodeValue = dst;
      n++;
    }
    if (n) {
      state.stats.polished = (state.stats.polished || 0) + n;
      updatePill();
      log(`已应用 ${n} 条润色修订`);
    }
    return n;
  }

  async function runScan() {
    if (scanning) {
      scheduleScan(500);
      return;
    }
    scanning = true;
    try {
      // 清理已脱离文档的节点
      for (const n of [...state.nodes]) if (!n.isConnected) state.nodes.delete(n);

      if (!state.enabled || state.showOriginal || !document.body) return;

      const mode = pageMode();
      state.mode = mode;
      markProtectedNodes(mode);
      enforceProtected();
      const candidates = collectCandidates(mode);
      updateHealth(candidates.length, mode);
      const fresh = [];
      const now = Date.now();
      for (const n of candidates) {
        const cur = n.nodeValue;
        const applied = state.applied.get(n);
        if (applied != null && applied.trim() === cur.trim()) continue;
        const pending = state.pending.get(n);
        if (pending != null && pending.trim() === cur.trim()) continue;
        const failed = state.failed.get(n);
        if (failed != null && failed.trim() === cur.trim() && now < (state.failedAt.get(n) || 0)) continue;
        fresh.push(n);
      }
      if (!fresh.length) return;

      for (const batch of groupBatches(fresh)) {
        const texts = batch.map((n) => n.nodeValue.trim());
        for (const n of batch) state.pending.set(n, n.nodeValue);
        try {
          state.stats.requests++;
          const r = await api('/api/translate', {
            texts,
            quality: batchIsImportant(batch) ? 'best' : 'fast',
            game: currentGame(),
          });
          const items = r.items || [];
          items.forEach((item, i) => {
            const node = batch[i];
            if (!node) return;
            state.pending.delete(node);
            if (item && item.dst && item.dst !== item.src) {
              applyTranslation(node, item.dst);
            } else if (item && item.error) {
              state.failed.set(node, node.nodeValue);
              state.failedAt.set(node, Date.now() + 20000);
              state.stats.failed++;
              state.stats.lastError = item.error;
            } else if (item) {
              // 译文与原文相同（例如专有名词）：记下来，避免每次扫描都重复请求
              state.applied.set(node, item.dst || node.nodeValue);
              if (item.unchanged) {
                state.stats.unchanged = (state.stats.unchanged || 0) + 1;
              }
            }
          });
        } catch (e) {
          for (const n of batch) state.pending.delete(n);
          state.stats.lastError = e.message;
          log('批量翻译失败', e);
          await sleep(1500);
        }
        updatePill();
      }
    } finally {
      scanning = false;
      updatePill();
    }
  }

  // ------------------------------------------------------------------ 中文搜索
  let searchPanel = null;
  let searchTimer = null;
  let lastIndexSig = '';
  let indexTimer = null;

  /** 取卡片里所有文本节点（含中文），用于给"本地 mod 索引"提供中英描述 */
  function cardAllTexts(card) {
    const res = [];
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const s = (n.nodeValue || '').trim();
      if (s.length < 8) continue;
      const el = n.parentElement;
      if (!el || SKIP_TAGS.has(el.tagName)) continue;
      if (/\d/.test(s) && /^[\d\s.,%+]+$/.test(s)) continue; // 下载量之类
      res.push(s);
    }
    return res;
  }

  /** 把"见过的 mod（英文名 + 当前显示的描述）"报给本地服务，作为中文搜索的语料 */
  function reportModIndex() {
    if (indexTimer) return;
    indexTimer = setTimeout(async () => {
      indexTimer = null;
      try {
        const entries = [];
        for (const card of collectCards()) {
          const all = cardAllTexts(card);
          if (!all.length) continue;
          const name = all[0];
          if (!name || name.length > 80) continue;
          let desc = '';
          for (const s of all) {
            if (s === name) continue;
            if (s.length > desc.length) desc = s;
          }
          if (desc.length > 20) entries.push({ name, text: desc.slice(0, 300), zh: CJK.test(desc) });
        }
        if (!entries.length) return;
        const sig = entries.map((e) => e.name + (e.zh ? '1' : '0')).join('|');
        if (sig === lastIndexSig) return;
        lastIndexSig = sig;
        await api('/api/index-mods', { entries });
      } catch {}
    }, 1200);
  }

  function findSearchInput() {
    const inputs = [...document.querySelectorAll('input')].filter((el) => {
      const t = (el.type || 'text').toLowerCase();
      if (t !== 'text' && t !== 'search') return false;
      if (!el.offsetParent) return false;
      const r = el.getBoundingClientRect();
      return r.width > 100 && r.height > 12;
    });
    return inputs.find((el) => /搜索|search/i.test(el.placeholder || '')) || null;
  }

  function setInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function ensurePanel() {
    if (searchPanel) return searchPanel;
    const host = document.createElement('div');
    host.id = 'gale-search-hint';
    // z-index 比悬浮条低：抽屉打开时（抽屉是最高的 2147483647）两个面板都要能被盖住
    host.style.cssText = 'position:fixed;z-index:2147483645;display:none';
    const root = host.attachShadow({ mode: 'open' });
    const uiHTML = `
      <style>
        ${themeVarsCss()}
        .box{font:var(--g-fs)/1.55 var(--g-font);background:var(--g-surface-a);color:var(--g-fg);
             border:1px solid var(--g-line);border-radius:var(--g-r);box-shadow:var(--g-shadow);
             padding:10px 12px;max-height:360px;overflow:auto;min-width:300px;backdrop-filter:blur(10px)}
        .t{color:var(--g-dim);font-size:var(--g-fs-xs);margin:8px 0 5px}
        .row{display:flex;gap:8px;align-items:baseline;padding:4px 7px;border-radius:var(--g-r-xs);cursor:pointer}
        .row:hover{background:var(--g-acc-soft)}
        .en{color:var(--g-acc-hi);font-weight:600}
        .zh{color:var(--g-fg-2);font-size:var(--g-fs-sm);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .kw{display:inline-block;margin:2px 5px 2px 0;padding:3px 9px;border-radius:var(--g-r-pill);background:var(--g-surface-2);cursor:pointer}
        .kw:hover{background:var(--g-acc-soft)}
        .empty{color:var(--g-dim);font-size:var(--g-fs-sm)}
      </style>
      <div class="box">
        <div class="t" id="tExact">固定词表命中</div><div id="exact"></div>
        <div class="t" id="tMods">本地已见 mod</div><div id="mods"></div>
        <div class="t" id="tKw">建议英文关键词</div><div id="kw"></div>
      </div>`;
    if (!setShadowHTML(root, uiHTML)) throw new Error('无法写入搜索面板界面（页面可能启用了 Trusted Types）');
    document.body.appendChild(host);
    const I18N2 = window.GALE_I18N;
    if (I18N2) {
      try {
        I18N2.observe(root);
        I18N2.apply(root);
      } catch {}
    }
    const $ = (id) => root.getElementById(id);
    const choose = (v) => {
      const input = findSearchInput();
      if (input) setInputValue(input, v);
      hidePanel();
    };
    searchPanel = { host, $, choose };
    return searchPanel;
  }

  function hidePanel() {
    if (searchPanel) searchPanel.host.style.display = 'none';
  }

  function showPanel(input) {
    const p = ensurePanel();
    const r = input.getBoundingClientRect();
    p.host.style.left = Math.round(r.left) + 'px';
    p.host.style.top = Math.round(r.bottom + 6) + 'px';
    p.host.style.display = 'block';
  }

  async function querySearch(input) {
    const q = (input.value || '').trim();
    if (!q || !CJK.test(q) || state.config.chineseSearch === false) return hidePanel();
    try {
      const r = await api('/api/search?q=' + encodeURIComponent(q));
      const p = ensurePanel();
      const { $, choose } = p;
      const fillRows = (box, items, render) => {
        box.innerHTML = '';
        if (!items.length) {
          box.innerHTML = '<div class="empty">（无）</div>';
          return;
        }
        for (const it of items) {
          const d = document.createElement('div');
          d.className = 'row';
          d.innerHTML = render(it);
          d.onclick = () => choose(it.__value);
          box.appendChild(d);
        }
      };
      const exact = (r.exact || []).map((x) => ({ ...x, __value: x.en }));
      const mods = (r.mods || []).map((x) => ({ ...x, __value: x.name }));
      const kws = (r.keywords || []).map((x) => ({ ...x, __value: x.word }));
      fillRows($('exact'), exact, (it) => `<span class="en">${it.en}</span>`);
      fillRows($('mods'), mods, (it) => `<span class="en">${it.name}</span> <span class="zh">${(it.zh || '').slice(0, 40)}</span>`);
      $('kw').innerHTML = '';
      if (!kws.length) $('kw').innerHTML = '<div class="empty">（无，先多翻几个 mod 页面再来搜）</div>';
      for (const it of kws) {
        const s = document.createElement('span');
        s.className = 'kw';
        s.textContent = it.word;
        s.onclick = () => choose(it.word);
        $('kw').appendChild(s);
      }
      $('tExact').style.display = exact.length ? '' : 'none';
      $('tMods').style.display = mods.length ? '' : 'none';
      showPanel(input);
    } catch {
      hidePanel();
    }
  }

  function hookSearch() {
    if (state.config.chineseSearch === false) return;
    const input = findSearchInput();
    if (!input || input.dataset.galeSearchHooked === '1') return;
    input.dataset.galeSearchHooked = '1';
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => querySearch(input), 280);
    });
    input.addEventListener('blur', () => setTimeout(hidePanel, 200));
    input.addEventListener('focus', () => {
      if (CJK.test(input.value || '')) querySearch(input);
    });
    log('已挂接中文搜索框');
  }

  // ------------------------------------------------------------------ 悬浮控制条
  // 主题变量（色板跟 Gale 走，见 core/i18n.js 的 THEME）：
  // 注入进 Gale 时它的深/浅色是界面里的开关，只能看 <html class="dark">，不能用 prefers-color-scheme。
  // i18n.js 缺失时退回一套内置的深色，界面不至于变成"没有颜色"。
  const FALLBACK_THEME =
    '--g-bg:#0f172a;--g-surface:#1e293b;--g-surface-a:rgba(30,41,59,.94);--g-surface-2:#273449;--g-line:#334155;' +
    '--g-fg:#f1f5f9;--g-fg-2:#cbd5e1;--g-dim:#94a3b8;--g-acc:#16a34a;--g-acc-hi:#22c55e;--g-acc-soft:rgba(34,197,94,.16);' +
    '--g-acc-fg:#fff;--g-ok:#22c55e;--g-warn:#f59e0b;--g-err:#ef4444;--g-shadow:0 12px 32px rgba(2,6,23,.55);' +
    '--g-code-bg:#0b1220;--g-r:12px;--g-r-sm:9px;--g-r-xs:7px;--g-r-pill:999px;' +
    '--g-font:"Microsoft YaHei UI","Microsoft YaHei","Segoe UI",Inter,system-ui,sans-serif;' +
    '--g-mono:Consolas,"Cascadia Mono",monospace;' +
    '--g-fs:14px;--g-fs-sm:12.5px;--g-fs-xs:11.5px;--g-fs-lg:15px;--g-fs-xl:17px';
  function themeVarsCss() {
    const T = window.GALE_UI && window.GALE_UI.theme;
    try {
      return T ? T.css(T.galeMode()) : `:host{${FALLBACK_THEME}}`;
    } catch {
      return `:host{${FALLBACK_THEME}}`;
    }
  }

  function buildPill() {
    if (state.pill) return;
    const host = document.createElement('div');
    host.id = 'gale-trans-host';
    // 抽屉（2147483647）高于悬浮条：抽屉铺满右侧时不会出现"悬浮条压在抽屉上"
    host.style.cssText = 'position:fixed;z-index:2147483646;right:16px;bottom:68px;';
    const root = host.attachShadow({ mode: 'open' });
    const uiHTML = `
      <style id="themeVars">${themeVarsCss()}</style>
      <style>
        .pill{display:flex;align-items:center;gap:8px;font:var(--g-fs)/1.45 var(--g-font);
          background:var(--g-surface-a);color:var(--g-fg);border:1px solid var(--g-line);border-radius:var(--g-r-pill);
          padding:6px 10px;box-shadow:var(--g-shadow);backdrop-filter:blur(10px);user-select:none;
          cursor:move;opacity:.72;transition:opacity .18s,box-shadow .18s}
        .pill:hover{opacity:1;box-shadow:0 14px 36px rgba(2,6,23,.5)}
        .pill button{all:unset;cursor:pointer;padding:3px 11px;border-radius:var(--g-r-pill);background:var(--g-surface-2);color:var(--g-fg-2);font-size:var(--g-fs);transition:background .15s,color .15s}
        .pill button:hover{background:var(--g-acc-soft);color:var(--g-fg)}
        .pill button.on{background:var(--g-acc);color:var(--g-acc-fg);font-weight:600}
        .pill select{all:unset;cursor:pointer;color:var(--g-fg-2);font-size:var(--g-fs);padding:3px 7px;border-radius:var(--g-r-sm);background:var(--g-surface-2);max-width:190px}
        .pill select:hover{background:var(--g-acc-soft);color:var(--g-fg)}
        .pill select option{color:#0f172a;background:#fff}
        .pill .hidden{display:none !important}
        .pill .warn{background:var(--g-err);color:#fff;border-radius:var(--g-r-pill);padding:2px 9px;font-size:var(--g-fs-xs);cursor:help;white-space:nowrap}
        .pill{position:relative}
        .expand{position:absolute;right:100%;top:0;margin-right:8px;display:flex;align-items:center;gap:8px;
          background:var(--g-surface-a);border:1px solid var(--g-line);border-radius:var(--g-r-pill);padding:6px 10px;
          box-shadow:var(--g-shadow);backdrop-filter:blur(10px);white-space:nowrap}
        .pill.flip-right .expand{right:auto;left:100%;margin-right:0;margin-left:8px}
        .dot{width:9px;height:9px;border-radius:50%;background:var(--g-ok);flex:0 0 auto}
        .dot.err{background:var(--g-err)}
        .stat{opacity:.85;color:var(--g-fg-2);font-size:var(--g-fs-sm);white-space:nowrap}
      </style>
      <div class="pill" id="bar">
        <div class="expand hidden" id="expand">
          <select id="provider" title="翻译节点"></select>
          <span class="stat" id="stat"></span>
        </div>
        <span class="dot" id="dot" title="状态"></span>
        <span class="warn hidden" id="warn">识别异常</span>
        <button id="toggle" title="切换 中文 / 原文">中文</button>
        <button id="more" title="展开/收起">⋯</button>
        <button id="gear" title="打开设置">⚙</button>
      </div>`;
    if (!setShadowHTML(root, uiHTML)) throw new Error('无法写入悬浮条界面（页面可能启用了 Trusted Types）');
    const $ = (id) => root.getElementById(id);

    // 跟着 Gale 自己的深浅色开关走（它把开关加在 <html class="dark"> 上）：
    // 只重写那一小块变量，不重新渲染界面。
    try {
      const themeEl = root.getElementById('themeVars');
      const syncTheme = () => {
        const T = window.GALE_UI && window.GALE_UI.theme;
        if (T && themeEl) themeEl.textContent = T.css(T.galeMode());
      };
      new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    } catch {}

    // 记忆位置 + 拖动
    try {
      const saved = JSON.parse(localStorage.getItem('gale-trans-pos') || 'null');
      if (saved && typeof saved.x === 'number') {
        host.style.right = 'auto';
        host.style.bottom = 'auto';
        host.style.left = saved.x + 'px';
        host.style.top = saved.y + 'px';
      }
    } catch {}
    const bar = $('bar');
    let drag = null;
    bar.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT') return;
      if (e.target.closest && e.target.closest('.expand')) return; // 展开区里也能点选
      const r = host.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const x = Math.max(4, Math.min(window.innerWidth - 60, e.clientX - drag.dx));
      const y = Math.max(4, Math.min(window.innerHeight - 30, e.clientY - drag.dy));
      host.style.right = 'auto';
      host.style.bottom = 'auto';
      host.style.left = x + 'px';
      host.style.top = y + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      drag = null;
      try {
        localStorage.setItem('gale-trans-pos', JSON.stringify({ x: parseInt(host.style.left, 10), y: parseInt(host.style.top, 10) }));
      } catch {}
    });

    $('toggle').onclick = () => {
      state.showOriginal = !state.showOriginal;
      $('toggle').textContent = state.showOriginal ? '原文' : '中文';
      $('toggle').classList.toggle('on', state.showOriginal);
      if (state.showOriginal) restoreAll();
      else {
        state.applied = new WeakMap();
        state.pending = new WeakMap();
        state.failed = new WeakMap();
        scheduleScan(60);
      }
    };
    $('more').onclick = () => {
      const exp = $('expand');
      const willShow = exp.classList.contains('hidden');
      exp.classList.toggle('hidden', !willShow);
      if (!willShow) return;
      // 展开内容默认在悬浮条左侧（向左展开，不会往屏幕右边顶出去）；
      // 若悬浮条本身已经贴着屏幕左边缘，就翻到右侧，避免反向溢出。
      bar.classList.remove('flip-right');
      const er = exp.getBoundingClientRect();
      if (er.left < 4) bar.classList.add('flip-right');
    };
    $('gear').onclick = () => {
      if (window.__galeDrawer && window.__galeDrawer.toggle) window.__galeDrawer.toggle();
      else fetch(API + '/api/open-settings').catch(() => {});
    };
    $('provider').onchange = async (e) => {
      const provider = e.target.value;
      const opt = e.target.options[e.target.selectedIndex];
      if (opt && opt.disabled) {
        // 理论上点不到（disabled 的 option 不可选），防御性兜底：别让它在"仅本地模式"下改回在线节点
        e.target.value = state.config.provider || '';
        return;
      }
      await setProviderFromPill(provider);
    };
    state.pill = { host, root, $ };
    (document.body || document.documentElement).appendChild(host);
    // 界面国际化：翻译悬浮条自身的文案，并在语言切换 / 动态更新时保持同步
    const I18N = window.GALE_I18N;
    if (I18N) {
      try {
        I18N.observe(root);
        I18N.apply(root);
      } catch {}
    }
    refreshProviderSelect();
  }

  async function refreshProviderSelect() {
    try {
      const r = await api('/api/client-config');
      state.providers = r.providers || [];
      state.config = { ...state.config, ...(r.config || {}) };
      state.phraseKeys = new Set((r.phraseKeys || []).map((k) => String(k).trim().toLowerCase()));
      state.forceKeys = new Set((r.forceTranslate || []).map((k) => String(k).trim().toLowerCase()));
      refreshGlossary();
    } catch {}
    if (!state.pill) return;
    const sel = state.pill.$('provider');
    // 「仅本地翻译（禁用联网）」开着时，在线节点在这里也要置灰 ——
    // 否则用户能在悬浮栏里选已停用的节点，选了之后请求会被服务端拦下，看起来像"翻译坏了"。
    // 判定由服务端下发（每个节点带 local: true/false），页面侧不重复实现回环判断。
    const off = !!state.config.offlineOnly;
    sel.innerHTML = '';
    for (const p of state.providers) {
      const o = document.createElement('option');
      o.value = p.id;
      const blocked = off && p.local === false;
      o.textContent = blocked ? p.name + '（仅本地模式下已停用）' : p.name;
      o.disabled = blocked;
      sel.appendChild(o);
    }
    sel.value = state.config.provider || 'builtin';
    sel.title = off ? '翻译源（仅本地模式：在线节点已停用）' : '翻译源';
    const t = state.pill.$('toggle');
    t.textContent = state.showOriginal ? '原文' : '中文';
    // 当前节点若被"仅本地模式"停用，关闭状态的 <select> 会直接显示带后缀的选项文字
    // （"某节点（仅本地模式下已停用）"），不必再往统计行塞提示——
    // 统计行由 updatePill() 每次刷新时覆写，塞进去也会被冲掉。
  }

  /** 悬浮栏翻译源切换：写配置 + 通知抽屉，避免两个界面显示不一致 */
  async function setProviderFromPill(provider) {
    const prev = state.config.provider;
    state.config.provider = provider;
    try {
      await api('/api/config', { provider });
      if (window.__galeDrawer && typeof window.__galeDrawer.onConfigChanged === 'function') {
        window.__galeDrawer.onConfigChanged({ provider });
      }
    } catch (err) {
      state.config.provider = prev;
      state.stats.lastError = '保存翻译源失败';
      if (state.pill) state.pill.$('provider').value = prev || '';
      return;
    }
    restoreAll();
    scheduleScan(60);
  }

  function updatePill() {
    if (!state.pill) return;
    const dot = state.pill.$('dot');
    const stat = state.pill.$('stat');
    const warn = state.pill.$('warn');
    const bad = state.stats.failed || state.health.degraded;
    dot.className = 'dot' + (bad ? ' err' : '');
    stat.textContent = `已译 ${state.stats.translated} · 请求 ${state.stats.requests}${state.stats.failed ? ' · 失败 ' + state.stats.failed : ''}`;
    stat.title = state.stats.lastError || '';
    if (warn) {
      warn.classList.toggle('hidden', !state.health.degraded);
      const T = (s) => (window.GALE_I18N ? window.GALE_I18N.t(s) : s);
      warn.title = state.health.degraded
        ? T('注入自检') + ': ' + state.health.reasons.map(T).join(' / ') + ' — ' + T('点 ⚙ 查看详情')
        : '';
    }
    dot.title = state.health.degraded ? (window.GALE_I18N ? window.GALE_I18N.t('识别异常') : '识别异常') : '';
  }

  // ------------------------------------------------------------------ 监听与启动
  let mo = null;
  let lastHref = location.href;

  function startObserver() {
    mo = new MutationObserver((records) => {
      let meaningful = false;
      for (const r of records) {
        if (r.type === 'characterData') {
          const node = r.target;
          const applied = state.applied.get(node);
          if (applied != null && applied === node.nodeValue) continue; // 是我们自己写的
          meaningful = true;
        } else if (r.type === 'childList') {
          const t = r.target;
          if (t && (t.id === 'gale-trans-host' || t.id === 'gale-drawer-host' || (t.closest && t.closest('#gale-trans-host, #gale-drawer-host')))) continue;
          meaningful = true;
        }
        if (meaningful) break;
      }
      if (meaningful) scheduleScan(350);
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function watchRoute() {
    routeTimer = setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        log('路由变化', lastHref);
        scheduleScan(400);
      }
      if (state.stats.failed && state.enabled && !state.showOriginal) scheduleScan(2000);
      hookSearch(); // SPA 换页后搜索框是新节点，需要重新挂接
      reportModIndex();
      if (searchPanel && searchPanel.host.style.display !== 'none' && !findSearchInput()) hidePanel();
      // 兜底同步：配置也可能被别处改掉（打开设置页的浏览器标签、外面手改 config.json、
      // 另一个 Gale 窗口）。这里每 ~6 秒静默对一次，保证悬浮栏的翻译源列表不会停在旧状态。
      // 用户正在操作下拉框 / 页面不可见时跳过，别把展开的列表重建掉。
      if (++pillSyncTick >= 4) {
        pillSyncTick = 0;
        const sel = state.pill && state.pill.$('provider');
        if (!document.hidden && state.pill && sel && document.activeElement !== sel) {
          refreshProviderSelect().catch(() => {});
        }
      }
    }, 1500);
  }

  let routeTimer = null;
  let pillSyncTick = 0;

  function dispose() {
    try {
      state.disposed = true;
      restoreAll();
      mo?.disconnect();
      clearInterval(routeTimer);
      clearTimeout(scanTimer);
      for (const el of document.querySelectorAll('#gale-trans-host')) el.remove();
      state.pill = null;
      delete window.__galeTrans;
    } catch {}
  }

  function boot() {
    if (state.disposed) return; // 已被新实例接管，不要重复建悬浮条/观察器
    // 防御性清理：旧实例（可能没有 dispose）残留的悬浮条
    for (const el of document.querySelectorAll('#gale-trans-host')) el.remove();
    for (const el of document.querySelectorAll('#gale-search-hint')) el.remove();
    // ⚠️ 这里**不要**删 `#gale-drawer-host` —— 抽屉由 core/drawer.js 自己管生命周期。
    // 以前删了会踩一个很隐蔽的坑：抽屉脚本是幂等的（同一份代码重复注入会跳过），
    // 而引擎每次重新注入都会把抽屉宿主删掉，结果就是"抽屉被删了却没人重建" → 界面消失。
    if (DRY) {
      log('dry-run 模式：仅用于离线规则自检，不联网');
      return;
    }

    // 界面构建失败**绝不能影响翻译主流程**。
    // 某些页面（开启了 Trusted Types 的页面）不允许写 shadowRoot.innerHTML，会直接抛异常；
    // 以前这里没有 try/catch，一抛就导致后面的 startObserver/scheduleScan 都不执行 ——
    // 表现就是"整页都不翻译"，非常难查。
    try {
      buildPill();
    } catch (e) {
      state.pillError = e.message;
      log('悬浮条构建失败（翻译不受影响）：' + e.message);
    }

    // 先把扫描链路拉起来（观察器 + 首扫），再补 UI 相关的后续动作
    startObserver();
    watchRoute();
    scheduleScan(700); // 稍等列表渲染完，避免误翻名称

    refreshProviderSelect()
      .then(() => {
        try {
          hookSearch();
        } catch (e) {
          log('搜索框挂接失败（不影响翻译）：' + e.message);
        }
      })
      .catch((e) => log('读取节点列表失败：' + e.message));

    log('已注入', API);
  }

  // ---------------------------------------------------------------- 内置翻译引擎（浏览器本地模型）
  // 用 Edge/Chrome 138+ 的 Translator API：语言包在**本地**运行，离线、不联网、
  // 不需要密钥，也不涉及任何第三方接口条款。
  //
  // 实测得出的三条关键约束（决定了这里的写法）：
  //   1. 语言包**没下载过**时，Translator.create() 要求"用户激活"，否则抛 NotAllowedError
  //      → 所以提供 localPrepare() 给用户点一下；服务端通过 CDP 调用时带 userGesture
  //   2. 首次下载约 200 MB / 50~75 秒，**一次性**；之后 create() 只要 10 毫秒级，
  //      而且会随浏览器 profile 持久化（正常退出即可保住，硬杀进程可能丢）
  //   3. Translator API 本身是**串行**处理的，并发发过去只会排队 → 并发限制为 1
  // 语言包体积的估算基准（实测 en→zh 为 197.5 MB）。
  // 注意：Translator API 的 downloadprogress 只给 **0~1 的进度**（实测 total 恒为 1，拿不到字节数），
  // 所以"已下载多少 MB / 下载速度"都是用这个基准换算出来的**估算值**，界面上都标了"约"。
  const LOCAL_PACK_BYTES = 197.5 * 1024 * 1024;
  const LOCAL = {
    supported: typeof Translator !== 'undefined',
    translators: new Map(), // "en>zh" -> Translator 实例
    preparing: null, // { key, progress, startedAt, samples[], promise }
    lastError: '',
  };

  /** 把 availability() 的返回值翻译成"到底能不能用"的结论。
   *
   *  ⚠️ 这里区分的是两类完全不同的失败，混在一起会让用户白折腾：
   *    - 'downloadable' / 'downloading' → 语言包还没下载，点「启用内置引擎」有用；
   *    - 'unavailable' → **该运行环境根本不提供这个语言对的端侧模型**。实测 Gale 的
   *      WebView2（Edg/154）就是这样：API 存在、所有语言对都是 unavailable，
   *      Translator.create() 抛 NotSupportedError: Unable to create translator for the
   *      given source and target language. —— 下载永远不会成功，必须让用户改选别的节点。
   */
  function localVerdict(availability) {
    if (!LOCAL.supported) {
      return {
        state: 'unsupported',
        unusable: true,
        reason: '当前环境没有 Translator API（需要 Edge / Chrome 138 以上）',
      };
    }
    if (availability === 'available') return { state: 'ready', unusable: false, reason: '' };
    if (availability === 'downloadable' || availability === 'downloading') {
      return {
        state: 'needDownload',
        unusable: false,
        reason: '内置引擎的语言包还没下载好：请在设置里点一下「启用内置引擎」',
      };
    }
    return {
      state: 'unavailable',
      unusable: true,
      reason:
        'Gale 页面自己不带端侧翻译模型（WebView2 的限制）：内置引擎已改用插件拉起的无窗口 Edge，若仍显示不可用，请确认本机装有 Edge，或到设置里换个翻译节点',
    };
  }

  /** 把结论同步给服务端（CDP 轮询时顺带取走），也留在页面里供诊断 */
  LOCAL.verdict = null;
  function rememberVerdict(availability) {
    const v = localVerdict(availability);
    LOCAL.env = v.state;
    LOCAL.envReason = v.reason;
    return v;
  }

  /** 从进度采样里算下载速度（字节/秒，估算）。
   *  取最近 ~3 秒的窗口而不是全程平均——全程平均在网络抖动时会严重滞后。 */
  function localSpeed(job) {
    const s = job.samples;
    if (!s || s.length < 2) return 0;
    const last = s[s.length - 1];
    let i = s.length - 1;
    while (i > 0 && last.t - s[i - 1].t <= 3000) i--;
    const first = s[i];
    const dt = (last.t - first.t) / 1000;
    const dp = last.p - first.p;
    if (dt < 0.4 || dp <= 0) return 0; // 窗口太短或没进展 → 不给速度（避免闪出乱跳的数字）
    return (dp * LOCAL_PACK_BYTES) / dt;
  }

  /** 把界面语言码映射成 Translator API 认的 BCP-47（它只认 'zh' / 'zh-Hant'） */
  function localLang(code, isSource) {
    const c = String(code || '').toLowerCase();
    if (!c || c === 'auto') return 'en'; // 该 API 不支持自动检测源语言；本插件主要翻英文内容
    if (c.startsWith('zh')) return /hant|tw|hk|mo/.test(c) ? 'zh-Hant' : 'zh';
    return c.split('-')[0]; // en-US -> en
  }

  function localPair(source, target) {
    return { sl: localLang(source, true), tl: localLang(target, false) };
  }

  async function getLocalTranslator(source, target) {
    if (!LOCAL.supported) throw new Error('内置引擎需要 Edge / Chrome 138 或更高版本');
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

  /** 给 UI 查询用。source/target 是**当前配置**的语言，界面想知道的是"这一对准备好了没有"——
   *  以前固定查 en>zh，所以把目标语言改成繁体（zh-Hant）就会误报"未下载"。 */
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
    const out = {
      supported: true,
      preparing: null,
      lastError: LOCAL.lastError,
      wantKey,
      ready: false,
      pairs: {},
    };
    // 下载中：把进度、速度、已下载量、预计剩余时间都给界面（都是估算值，见 LOCAL_PACK_BYTES 注释）
    const job = LOCAL.preparing;
    if (job) {
      const p = Math.max(0, Math.min(1, Number(job.progress) || 0));
      const speedBps = localSpeed(job);
      out.preparing = {
        key: job.key,
        progress: p,
        elapsedMs: Date.now() - job.startedAt,
        hasProgress: job.samples.length > 0, // false = 还在连接/准备，尚未开始下载
        speedBps,
        downloadedBytes: p * LOCAL_PACK_BYTES,
        totalBytes: LOCAL_PACK_BYTES,
        etaMs: speedBps > 0 && p > 0 && p < 1 ? (((1 - p) * LOCAL_PACK_BYTES) / speedBps) * 1000 : null,
        samples: job.samples.length,
      };
    }
    // 顺带报一下 en>zh / en>zh-Hant，供界面做诊断展示
    for (const k of [...new Set([wantKey, 'en>zh', 'en>zh-Hant'])]) {
      const [sl, tl] = k.split('>');
      try {
        out.pairs[k] = await Translator.availability({ sourceLanguage: sl, targetLanguage: tl });
      } catch (e) {
        out.pairs[k] = 'error: ' + ((e && e.message) || e);
      }
    }
    out.ready = out.pairs[wantKey] === 'available';
    // 把"这一对到底能不能用"的结论一起报出去（服务端据此决定要不要把内置引擎踢出候选链）
    const v = rememberVerdict(out.pairs[wantKey]);
    out.env = v.state;
    out.unusable = v.unusable;
    out.reason = v.reason;
    return out;
  }

  /** 下载 / 预热语言包。要在有"用户激活"的上下文里调用（界面点击，或 CDP 带 userGesture） */
  async function localPrepare(source, target) {
    if (!LOCAL.supported) throw new Error('内置引擎需要 Edge / Chrome 138 或更高版本');
    const { sl, tl } = localPair(source, target);
    const key = sl + '>' + tl;
    if (LOCAL.translators.has(key)) return { ok: true, cached: true, key };
    // 环境根本不提供端侧模型（WebView2）时别假装"正在下载"——直接给明确原因，
    // 否则界面会显示一条永远停在 0% 的进度条，用户等半天也等不出结果。
    const avail0 = await Translator.availability({ sourceLanguage: sl, targetLanguage: tl }).catch(() => '');
    if (avail0) {
      const v0 = rememberVerdict(avail0);
      if (v0.unusable) {
        LOCAL.lastError = v0.reason;
        throw new Error(v0.reason);
      }
    }
    if (LOCAL.preparing && LOCAL.preparing.key === key) {
      await LOCAL.preparing.promise; // 已经在下载了，一起等
      return { ok: true, cached: true, key };
    }
    // 注意：这里的 job 不能叫 state —— 那会遮蔽上面引擎的 state
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
              if (job.samples.length > 60) job.samples.shift(); // 只留最近 60 个采样（约 4 秒）
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
    // 语言包刚就绪：之前因为"语言包没下载好"而失败的节点要**立刻**重试，
    // 而不是继续等 20 秒的失败退避（否则用户点了启用还要再等半分钟才看到效果）
    try {
      state.failed = new WeakMap();
      state.failedAt = new WeakMap();
      scheduleScan(150);
    } catch {}
    return { ok: true, cached: false, key, ms: Date.now() - t0 };
  }

  /** 重置引擎：丢掉已创建的模型实例，下次翻译时重新创建。
   *  只动内存里的实例，**不删磁盘上的语言包**（语言包由服务端的 /api/local-engine/pack/delete 负责删）。
   *  用途：模型状态异常（比如翻译开始报错）时不用重启 Gale 就能恢复。 */
  async function localReset() {
    const n = LOCAL.translators.size;
    LOCAL.translators.clear();
    LOCAL.lastError = '';
    // 正在下载的话不能打断（会白下），只提示
    const downloading = !!LOCAL.preparing;
    try {
      state.failed = new WeakMap();
      state.failedAt = new WeakMap();
      scheduleScan(150);
    } catch {}
    return { ok: true, cleared: n, downloading };
  }

  /** 服务端通过 CDP 调这个：把一批文本交给本地模型（串行，与 API 自身一致） */
  async function localTranslate(texts, opts = {}) {
    const tr = await getLocalTranslator(opts.source, opts.target);
    const out = [];
    for (const t of texts) {
      try {
        out.push(await tr.translate(String(t)));
      } catch (e) {
        throw new Error('内置引擎翻译失败：' + ((e && e.message) || e));
      }
    }
    return out;
  }

  // 对外诊断接口（供本地服务与调试使用）
  window.__galeTrans = {
    __installed: true,
    api: API,
    state,
    dispose,
    rescan: () => scheduleScan(10),
    applyRevisions,
    softApply,
    /** 抽屉 / 设置页改完配置后调它：重拉 client-config 并重建悬浮栏的翻译源列表
     *  （「仅本地模式」开关就是靠这个把在线节点实时置灰的） */
    refreshConfig: () => refreshProviderSelect(),
    localTranslate,
    localPrepare,
    localStatus,
    localReset,
    _localSpeed: localSpeed, // 测试钩子：可传 { samples:[{t,p}] } 直接验证速度计算
    _localPackBytes: LOCAL_PACK_BYTES,
    coverage: (mode) => coverage(mode || pageMode()),
    health,
    dryRun,
    diag: () => ({
      installed: true,
      api: API,
      enabled: state.enabled,
      showOriginal: state.showOriginal,
      config: {
        provider: state.config.provider,
        target: state.config.target,
        translateNames: state.config.translateNames,
        translateConfigPage: state.config.translateConfigPage !== false,
      },
      pageMode: pageMode(),
      stats: { ...state.stats },
      health: health(),
      translatedNodes: [...state.nodes].filter((n) => n.isConnected).length,
      candidates: (() => {
        try {
          const m = pageMode();
          markProtectedNodes(m);
          return collectCandidates(m).length;
        } catch {
          return -1;
        }
      })(),
      protectedNodes: state.protectedNodes.size,
      cards: collectCards().length,
      hasMarkdown: !!document.querySelector('.markdown, [class*="markdown"]'),
      sample: (() => {
        try {
          const m = pageMode();
          return collectCandidates(m)
            .slice(0, 12)
            .map((n) => (n.nodeValue || '').trim().slice(0, 60));
        } catch {
          return [];
        }
      })(),
    }),
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
