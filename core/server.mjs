// Gale 汉化外挂 · 本地服务
// 职责：托管设置页 / 提供翻译 API / 用 CDP 把页面脚本注入 Gale 的 WebView2 / 需要时拉起 Gale
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { Cache } from './cache.mjs';
import { Library } from './library.mjs';
import { Translator, normalizeText } from './translate.mjs';
import {
  listProviders,
  LANG_LIST,
  isKnownProvider,
  isProviderLocal,
  filterLocalProviders,
  rateLimitStatus,
  clearProviderRateLimit,
  setLocalTranslator,
  setLocalEngineEnv,
  localEngineEnv,
  isLocalEngineUnusable,
} from './providers.mjs';
import { CdpBridge } from './cdp.mjs';
import {
  setWorkerLogger,
  workerInfo,
  workerStatus,
  workerPrepare,
  workerTranslate,
  workerReset,
  ensureWorker,
  stopWorker,
  packEntry,
  packInstalled,
  packBytes,
  packLooksReal,
  profileBytes,
  wipeProfile,
  seedInfo,
  removeSeed,
  revealTarget,
  PROFILE_DIR,
  edgePath,
  hasEdge,
  WORKER_PAGE_PATH,
  WORKER_SCRIPT_PATH,
} from './edge-worker.mjs';
import { pickCdpPort, readPortMemory, writePortMemory, portCandidates } from './ports.mjs';
import { buildId } from './build.mjs';
import { request, getSystemProxy, getPacUrl, setOfflineOnly, setOfflineLogger, isOfflineOnly } from './net.mjs';
import { systemStatus, enableShortcuts, restoreShortcuts, enableAutostart, disableAutostart, enableIntegration, disableIntegration } from './system.mjs';
import { DEFAULT_CONFIG } from './defaults.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const CACHE_FILE = path.join(ROOT, 'data', 'cache.json');
const PORT_MEMORY_FILE = path.join(ROOT, 'data', 'ports.json');
const LOG_FILE = path.join(ROOT, 'logs', 'service.log');
const VERSION = (() => {
  try {
    return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
  } catch {
    return 'dev';
  }
})();
// 本次启动时的代码指纹：启动器靠它判断"后台服务是不是旧代码"
const BUILD = buildId();


// ------------------------------------------------------------------ 配置
function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

let config = { ...DEFAULT_CONFIG };
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      // 必须容忍 BOM：Windows 记事本 / PowerShell 的 Set-Content -Encoding UTF8 都会在开头写 EF BB BF，
      // 而 JSON.parse 遇到 BOM 会直接抛 "Unexpected token ''"——那样整份配置会被悄悄换成默认值，
      // 用户填的密钥、术语表、节点选择全部"看起来丢了"（实测踩过：日志里是「配置读取失败，使用默认值」）。
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
      config = deepMerge(DEFAULT_CONFIG, JSON.parse(raw));
    }
  } catch (e) {
    logLine('配置读取失败，使用默认值: ' + e.message);
  }
  sanitizeConfig();
  applyOfflineMode();
}

/**
 * 把「仅本地模式（禁用联网）」同步给 net.mjs —— 那里是所有对外 HTTP 的唯一出口。
 * 每次读配置、每次保存配置之后都要调一次，保证开关立刻生效（不用重启服务）。
 */
function applyOfflineMode() {
  setOfflineLogger(logLine);
  setOfflineOnly(!!config.offlineOnly);
}

// 已废弃的配置项（节点被移除后留下的）
const REMOVED_CONFIG_KEYS = [
  'mymemoryEmail',
  // 曾经内置过、后来移除的官方 API 节点（腾讯云 TMT / 有道智云 / Google Cloud）的密钥字段。
  // 保留这一条是为了让已经填过密钥的旧配置在升级后被自动清掉，不留悬空字段。
  'tencentCloudSecretId',
  'tencentCloudSecretKey',
  'tencentCloudRegion',
  'youdaoAppKey',
  'youdaoAppSecret',
  'googleCloudKey',
  'googleCloudProject',
];

/** 清理配置里指向"已移除节点 / 已不存在 id"的残留，例如曾经用过的 bing / mymemory */
function sanitizeConfig() {
  const notes = [];
  const bad = (list) => (list || []).filter((x) => !isKnownProvider(x));
  const drop = (list) => (list || []).filter((x) => isKnownProvider(x));

  if (config.provider && !isKnownProvider(config.provider)) {
    notes.push(`翻译节点 ${config.provider} 已不可用，改为内置引擎`);
    config.provider = 'builtin';
  }
  const fb = drop(config.fallback);
  if (fb.length !== (config.fallback || []).length) {
    notes.push(`备用节点里移除了失效项：${bad(config.fallback).join(', ')}`);
    config.fallback = fb;
  }
  const ds = drop(config.disabledSources);
  if (ds.length !== (config.disabledSources || []).length) {
    notes.push(`停用列表里移除了已不存在的节点：${bad(config.disabledSources).join(', ')}`);
    config.disabledSources = ds;
  }
  const q = config.quality || {};
  const voters = drop(q.voters);
  if (voters.length !== (q.voters || []).length) {
    notes.push(`择优节点里移除了失效项：${bad(q.voters).join(', ')}`);
    config.quality = { ...q, voters };
  }
  const removed = REMOVED_CONFIG_KEYS.filter((k) => k in config);
  if (removed.length) {
    for (const k of removed) delete config[k];
    notes.push('清除了已废弃的配置项：' + removed.join(', '));
  }
  config.offlineOnly = !!config.offlineOnly;
  if (notes.length) {
    saveConfig();
    for (const n of notes) logLine('配置迁移：' + n, 'warn');
  }
  return notes;
}
function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    logLine('配置写入失败: ' + e.message);
  }
}

// ------------------------------------------------------------------ 日志
const events = [];
function logLine(msg, level = 'info') {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  console.log(line);
  events.push({ t: Date.now(), level, msg });
  if (events.length > 300) events.shift();
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

// ------------------------------------------------------------------ 核心组件
loadConfig();
const cache = new Cache(CACHE_FILE);
const library = new Library(path.join(ROOT, 'data', 'library.json'));
const translator = new Translator({ cache, library, getConfig: () => config, log: (m) => logLine(m, 'debug') });
const bridge = new CdpBridge({
  port: config.cdpPort,
  onLog: (m) => logLine(m),
  // 刚连上页面时脚本可能还在跑，稍等一下再探测内置引擎的环境结论
  onAttach: () => setTimeout(() => probeLocalEngine().catch(() => {}), 1500),
});

// LLM 润色完成后，把修订直接推回 Gale 页面（无需刷新页面）
translator.onRevisions = async (list) => {
  if (!list?.length) return;
  const payload = JSON.stringify(list.slice(0, 200).map((r) => ({ src: String(r.src).slice(0, 300), dst: r.dst })));
  await bridge.evaluate(`(window.__galeTrans && window.__galeTrans.applyRevisions ? window.__galeTrans.applyRevisions(${payload}) : 0)`);
};

// ---------------------------------------------- 翻译节点可用性（内置引擎的环境自愈）
// 背景（实测，不是推测）：Gale 用 WebView2，它的 Translator API **存在**，但
//   ① 所有语言对的 availability() 都返回 'unavailable'；
//   ② Translator.create() 直接抛 NotSupportedError: Unable to create translator for the
//      given source and target language.
// 也就是说「内置引擎」跑在 Gale 页面里时**永远不可能工作**（不是缺语言包，而是运行环境不带端侧模型）。
// 这就是插件要自己拉起一个无窗口 Edge 的原因（见 core/edge-worker.mjs）。
// 而 builtin 偏偏是新装默认节点，所以这里做三件事：
//   ① 连上页面后主动探测一次，把结论缓存下来（供链路剔除 + 界面说实话）；
//   ② 两条后端都不行时**不自动改 provider**（autoSwitchFromBuiltin 默认关：这是个开源插件，
//      不能替用户把要翻译的文本悄悄发给第三方节点），只在界面里如实写明原因、让用户自己挑；
//   ③ 整条链都没有可用节点时，给出明确告警而不是静默失败。
let localEngine = { state: '', reason: '', wantKey: '', ready: false, bridgeDown: true, at: 0, backend: '' };

// ---------------------------------------------------------------- 内置引擎的两条后端
// 内置引擎（浏览器端侧模型）有两个可能放模型的地方：
//   'gale' = Gale 自己的 WebView2 页面里 —— 最省事（模型和要翻译的内容在同一个进程里）；
//            但**实测 Gale 用的 WebView2 不提供端侧模型**（见 README 的 ⚠ 一节），所以这条路通常走不通。
//   'edge' = 插件自己拉起的无窗口 Edge（core/edge-worker.mjs）—— WebView2 不行时的正解，
//            真 Edge 能下载语言包并离线翻译，用户依旧零安装、零密钥、零条款风险。
// 谁可用由 readLocalEngineStatus() 探测后写进 localEngine.backend，翻译与准备都照着它走。
function edgeBackendAvailable() {
  return !!edgePath();
}

/**
 * 这一次该用哪条后端。空串 = 两条都不行（调用方负责给出明确原因）。
 * 没连上 Gale 时直接空串：Edge 后端也是为 Gale 页面服务的（没页面就没得翻），
 * 而且不能因为一次断连就悄悄拉起浏览器、下 200 MB 语言包。
 */
function localBackend() {
  if (!bridge.attached) return '';
  if (localEngine.backend === 'edge') return edgeBackendAvailable() ? 'edge' : '';
  return 'gale';
}

setWorkerLogger((m, level) => logLine('本地翻译后端：' + m, level === 'debug' ? 'debug' : undefined));

// Edge 后端的宿主页面：只负责挂上页面脚本，并把状态写进 #wstate 方便人肉诊断
const WORKER_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Gale 汉化 · 本地翻译后端</title>
<style>
  body { margin: 0; background: #14161a; color: #cfd3da; font: 14px/1.7 "Microsoft YaHei", system-ui, sans-serif; }
  main { padding: 18px 22px; }
  h1 { font-size: 15px; margin: 0 0 10px; color: #e8ebf0; }
  #wstate { padding: 10px 12px; background: #1c1f26; border: 1px solid #2a2f38; border-radius: 6px; white-space: pre-wrap; }
  p { color: #7d8593; font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1>本地翻译后端（无窗口 Edge）</h1>
  <div id="wstate">正在加载…</div>
  <p>这个页面只给插件自己用：它在这里调用浏览器的端侧翻译 API（Translator），把译文通过本地服务回传给 Gale 汉化插件。关掉它（或关掉 Gale）就会停用内置引擎；下次点「启用内置引擎」会自动再起来。</p>
</main>
<script src="${WORKER_SCRIPT_PATH}"></script>
</body>
</html>
`;


/** 排除停用/未知/cache-only 之后，还"真的能用"的节点（仅本地模式下顺带排除所有在线节点） */
function usableProviderIds() {
  const disabled = new Set(config.disabledSources || []);
  let ids = listProviders(config, config.uiLang)
    .map((p) => p.id)
    .filter((id) => id !== 'cache-only' && !disabled.has(id))
    .filter((id) => !(id === 'builtin' && isLocalEngineUnusable()));
  if (config.offlineOnly) ids = filterLocalProviders(ids, config);
  return ids;
}

/** 当前配置真正会走到的节点（主节点 + 备用链），与 translate.mjs 的建链规则保持一致 */
function activeChainIds() {
  const disabled = new Set(config.disabledSources || []);
  const skip = (p) =>
    !p ||
    disabled.has(p) ||
    p === 'cache-only' ||
    !isKnownProvider(p) ||
    (p === 'builtin' && isLocalEngineUnusable()) ||
    (config.offlineOnly && !isProviderLocal(p, config));
  const out = [];
  if (!skip(config.provider)) out.push(config.provider);
  for (const p of config.fallback || []) if (!skip(p) && !out.includes(p)) out.push(p);
  return out;
}

/** 给界面用的诊断：为什么翻不出来 */
function nodeDiagnostics() {
  const usable = usableProviderIds();
  const chain = activeChainIds();
  let warning = '';
  if (!chain.length) {
    if (config.offlineOnly) {
      // 仅本地模式下的"翻不出来"是用户自己选的，要说清楚：不是坏了，而是没有可用的本地节点
      warning = usable.length
        ? '仅本地模式已开启：当前节点不是本地节点，已被停用 —— 请到设置里选用内置引擎 / 本地大模型 / 本机 LibreTranslate'
        : '仅本地模式已开启，但没有任何可用的本地节点：请启用内置引擎、或在本机跑一个本地大模型（Ollama）';
    } else {
      warning = isLocalEngineUnusable()
        ? `内置引擎在当前环境不可用（${localEngine.reason || '运行环境不提供端侧翻译模型'}），备用链里也没有其它节点：请到设置里启用一个翻译节点`
        : '没有任何可用的翻译节点：请到设置里启用一个翻译节点';
    }
  }
  return {
    usable,
    chain,
    warning,
    offlineOnly: !!config.offlineOnly,
    localEngine: { ...localEngine },
    worker: workerInfo(),
  };
}

/** 把页面报回来的结论落盘到内存缓存，并按需自愈 */
function applyLocalEngineStatus(st, { autoSwitch = true } = {}) {
  if (!st || typeof st !== 'object') return { ...localEngine };
  localEngine = {
    state: String(st.env || (st.ready ? 'ready' : '')),
    reason: String(st.reason || ''),
    wantKey: String(st.wantKey || ''),
    ready: !!st.ready,
    bridgeDown: false,
    at: Date.now(),
    // 记住了这次结论是哪条后端给的，翻译/准备/重置都照它走
    backend: st.backend === 'edge' ? 'edge' : st.backend === 'gale' ? 'gale' : '',
  };
  setLocalEngineEnv(localEngine);
  if (autoSwitch && st.unusable && config.provider === 'builtin' && config.autoSwitchFromBuiltin !== false) {
    const next = activeChainIds().find((id) => id !== 'builtin') || usableProviderIds()[0];
    if (next) {
      config.provider = next;
      saveConfig();
      logLine(`内置引擎在当前环境不可用（${localEngine.reason}），已自动把翻译节点切换为 ${next}`, 'warn');
      events.push({ t: Date.now(), level: 'warn', msg: `内置引擎不可用，已自动切换到节点 ${next}` });
    } else {
      logLine('内置引擎在当前环境不可用，而且没有其它可用节点 —— 请在设置里启用一个翻译节点', 'warn');
    }
  }
  return { ...localEngine };
}

/** 问出「内置引擎现在到底怎么样」，并决定这一次用哪条后端。
 *  ① Gale 页面自己能跑端侧模型就用它（模型和被翻译的内容在同一个进程里，最省事）；
 *  ② Gale 的 WebView2 不提供端侧模型（实测结论，见 README 的 ⚠ 一节）或者压根没连上时，
 *     改用插件自己拉起的无窗口 Edge（core/edge-worker.mjs）—— 对用户依旧零安装、零密钥、零条款风险；
 *  ③ 两条都不行才如实报「用不了」，并提示改用其它翻译节点。
 *  返回对象总是带一个 worker 字段，方便界面与诊断看后端进程的状态。 */
async function readLocalEngineStatus({ source, target, autoSwitch = true } = {}) {
  const src = source || config.source || 'auto';
  const tgt = target || config.target || 'zh-CN';
  const q = `${JSON.stringify(src)}, ${JSON.stringify(tgt)}`;

  let gale = null;
  if (bridge.attached) {
    try {
      gale = await bridge.evaluate(
        `(async () => (window.__galeTrans && window.__galeTrans.localStatus) ? await window.__galeTrans.localStatus(${q}) : { supported: false, reason: 'Gale 页面里没有内置引擎（请重启 Gale 让脚本重新注入）' })()`,
        { timeout: 20000 },
      );
    } catch (e) {
      logLine('读取 Gale 页面的内置引擎状态失败：' + e.message, 'debug');
    }
  }

  // ① Gale 页面自己就能跑端侧模型
  if (gale && typeof gale === 'object' && gale.supported !== false && !gale.unusable) {
    const env = applyLocalEngineStatus({ ...gale, backend: 'gale' }, { autoSwitch });
    if (env.state) logLine(`内置引擎环境探测：${env.state}${env.state === 'ready' ? '' : ' — ' + env.reason}`);
    // 注意返回的是**页面报的原始状态**（supported / pairs / preparing 界面都要用），
    // 只在上面那份缓存里留精简结论；别把原始字段吞掉。
    return { ...gale, backend: 'gale', worker: workerInfo() };
  }

  // ② 换成插件自带的 Edge 后端
  if (edgeBackendAvailable()) {
    try {
      const st = await workerStatus(src, tgt);
      const env = applyLocalEngineStatus({ ...st, backend: 'edge' }, { autoSwitch });
      const w = workerInfo();
      if (env.state) logLine(`内置引擎环境探测（Edge 后端）：${env.state}${env.state === 'ready' ? '' : ' — ' + env.reason}`);
      // 语言包已经在磁盘上就顺手把后端预热起来，省得第一次翻译还要等浏览器启动
      if (!w.attached && !w.starting && st.ready) {
        ensureWorker({ servicePort: actualPort }).catch((e) => logLine('预热 Edge 翻译后端失败：' + e.message, 'debug'));
      }
      return { ...st, backend: 'edge', worker: workerInfo() };
    } catch (e) {
      logLine('Edge 翻译后端状态读取失败：' + e.message, 'warn');
    }
  }

  // ③ 两条都不行：如实回报（原因留给界面显示，不要在这里拼字符串，i18n 按整句匹配）
  const last = gale && typeof gale === 'object'
    ? { ...gale }
    : { supported: false, env: 'unsupported', unusable: true, reason: '还没连接到 Gale 页面', bridgeDown: true };
  // 本机没装 Edge 是**最常见**的"内置引擎不可用"原因，而 Gale 页面报的那句话讲的是
  // WebView2 不带端侧模型 —— 对着没装 Edge 的人说这句等于没说。这里换成能照着做的原因。
  if (bridge.attached && !edgeBackendAvailable()) {
    last.unusable = true;
    last.noBrowser = true;
    last.reason =
      '这台机器上没有找到 Microsoft Edge：内置引擎用的是浏览器端侧模型，需要一个 Edge 148+；' +
      '也可以改用「本地大模型（Ollama）」或「本机 LibreTranslate」，或者到设置里换一个在线节点';
  }
  applyLocalEngineStatus(last, { autoSwitch });
  if (!bridge.attached) localEngine = { ...localEngine, bridgeDown: true };
  if (workerInfo().lastError) logLine('Edge 翻译后端上次启动失败：' + workerInfo().lastError, 'warn');
  return { ...last, bridgeDown: !!last.bridgeDown || !bridge.attached, backend: '', worker: workerInfo() };
}

/** 主动探测一次（服务端侧调用；失败只记 debug，不影响主流程） */
async function probeLocalEngine(opts = {}) {
  try {
    return await readLocalEngineStatus(opts);
  } catch (e) {
    logLine('内置引擎环境探测失败：' + e.message, 'debug');
    return { ...localEngine, bridgeDown: true, worker: workerInfo() };
  }
}

function buildInjection() {
  const prelude = `window.__GALE_TR__ = ${JSON.stringify({
    api: `http://127.0.0.1:${actualPort}`,
    debug: !!config.debug,
    uiLang: config.uiLang || 'zh-CN',
    // 代码指纹：页内脚本靠它判断"这次注入是不是同一份代码"。
    // 重复注入同一份代码时直接跳过，避免把已经打开的抽屉拆掉重建（会表现为"抽屉打开却是空白"）。
    build: BUILD,
  })};`;
  const parts = [];
  // 界面国际化词典（抽屉 / 悬浮条用；可选文件）
  try {
    parts.push(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8'));
  } catch (e) {
    logLine('未找到 core/i18n.js，界面语言切换不可用：' + e.message, 'warn');
  }
  parts.push(fs.readFileSync(path.join(__dirname, 'inject.js'), 'utf8'));
  // 页内设置抽屉（可选文件；缺失时自动跳过，不影响主流程）
  try {
    parts.push(fs.readFileSync(path.join(__dirname, 'drawer.js'), 'utf8'));
  } catch (e) {
    logLine('未找到 core/drawer.js，跳过页内抽屉：' + e.message, 'warn');
  }
  bridge.setInjection(prelude, parts.join('\n;\n'));
}

// ------------------------------------------------------------------ 中文搜索
const MOD_INDEX_FILE = path.join(ROOT, 'data', 'mod-index.json');
let modIndex = {}; // name -> { en, zh, ts }
try {
  if (fs.existsSync(MOD_INDEX_FILE)) modIndex = JSON.parse(fs.readFileSync(MOD_INDEX_FILE, 'utf8'));
} catch {}

let modIndexTimer = null;
function saveModIndex() {
  if (modIndexTimer) return;
  modIndexTimer = setTimeout(() => {
    modIndexTimer = null;
    try {
      fs.mkdirSync(path.dirname(MOD_INDEX_FILE), { recursive: true });
      fs.writeFileSync(MOD_INDEX_FILE, JSON.stringify(modIndex), 'utf8');
    } catch {}
  }, 4000);
  modIndexTimer.unref?.();
}

/** 页面把"见过的 mod"报上来，用于中文搜索的本地命中 */
function upsertModIndex(entries) {
  let n = 0;
  for (const e of entries || []) {
    const name = String(e?.name || '').trim();
    const text = String(e?.text || '').trim();
    if (!name || name.length > 80 || text.length < 8) continue;
    const rec = (modIndex[name] ||= { en: '', zh: '', ts: 0 });
    if (e.zh) {
      if (rec.zh !== text) {
        rec.zh = text.slice(0, 400);
        n++;
      }
    } else if (rec.en !== text) {
      rec.en = text.slice(0, 400);
      n++;
      // 只有英文时顺手查一下翻译缓存，能直接补上中文（页面还没滚到这里的 mod 也能被中文搜到）
      try {
        const hit = cache.get(normalizeText(text), config.provider, config.target);
        if (hit) rec.zh = hit.slice(0, 400);
      } catch {}
    }
    rec.ts = Date.now();
  }
  if (n) saveModIndex();
  return n;
}

const STOP_WORDS = new Set(
  ('the and for with that this from your you are can will not but all any use using used add adds added new mod mods make makes made more most ' +
    'other into out over when where which while have has had they them their there here also just like only than then some such very well much ' +
    'many may might must should would could about above after again against because before being below between both during each few further how ' +
    'once same she he it its our who whom why able allow allows allowed get gets getting want wants').split(/\s+/),
);

/** 从命中的英文原文里挑出最可能的搜索关键词 */
function extractKeywords(hits) {
  const freq = new Map();
  for (const s of hits) {
    const words = String(s).toLowerCase().match(/[a-z][a-z-]{2,}/g) || [];
    const seen = new Set();
    for (const w of words) {
      if (STOP_WORDS.has(w) || seen.has(w)) continue;
      seen.add(w);
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([word, score]) => ({ word, score }));
}

/** 中文 -> 英文关键词检索：固定词表反查 + 本地 mod 索引 + 翻译语料反查 */
function searchChinese(q) {
  const query = String(q || '').trim();
  if (!query) return { exact: [], mods: [], keywords: [], hitCount: 0 };

  const exact = [];
  for (const [from, to] of Object.entries(config.phraseMap || {})) {
    if (String(to).includes(query)) exact.push({ en: from, zh: to });
  }

  const mods = [];
  for (const [name, rec] of Object.entries(modIndex)) {
    const zh = rec.zh || '';
    if (zh.includes(query) || name.toLowerCase().includes(query.toLowerCase())) {
      mods.push({ name, zh: zh.slice(0, 120), en: (rec.en || '').slice(0, 120) });
      if (mods.length >= 12) break;
    }
  }

  const hits = [];
  for (const v of cache.map.values()) {
    if (typeof v?.d === 'string' && v.d.includes(query)) hits.push(v.s || '');
    if (hits.length >= 300) break;
  }
  return { exact: exact.slice(0, 8), mods, keywords: extractKeywords(hits), hitCount: hits.length };
}

// ------------------------------------------------------------------ 代理探测
const COMMON_PROXY_PORTS = [7890, 7891, 7892, 7893, 7897, 7899, 10808, 10809, 1080, 2080, 8889, 20171, 8118, 1087, 8080, 3128];

function portOpen(port, host = '127.0.0.1', timeout = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

// 代理连通性实测用的探测地址。挑一个"国内直连不通、走代理才通"的公开端点：
// Google 的 gtx 接口就是最典型的一个（也因此只有它必须配代理）。
const GOOGLE_TEST_URL =
  'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=' + encodeURIComponent('test');

async function probeProxy(url) {
  const t0 = Date.now();
  try {
    const r = await request(GOOGLE_TEST_URL, { proxy: url, timeout: 6000 });
    if (r.status === 200) return { url, ok: true, ms: Date.now() - t0, kind: 'http', error: '' };
    return { url, ok: false, ms: Date.now() - t0, kind: 'http', error: 'HTTP ' + r.status };
  } catch (e) {
    // HTTP 隧道不通时再试 SOCKS5（本地客户端常常同端口两种协议都支持）
    const socksUrl = url.replace(/^http:\/\//i, 'socks5://');
    const t1 = Date.now();
    try {
      const r2 = await request(GOOGLE_TEST_URL, { proxy: socksUrl, timeout: 6000 });
      if (r2.status === 200) return { url: socksUrl, ok: true, ms: Date.now() - t1, kind: 'socks5', error: '' };
    } catch {}
    return { url, ok: false, ms: Date.now() - t0, kind: 'http', error: e.message };
  }
}

/** 探测可用代理：系统代理 + 常见本地端口，并实测能否连上境外端点 */
async function detectProxy() {
  const candidates = [];
  const seen = new Set();
  const add = (url) => {
    if (url && !seen.has(url)) {
      seen.add(url);
      candidates.push(url);
    }
  };
  const sys = await getSystemProxy();
  if (sys) add(sys);
  for (const port of COMMON_PROXY_PORTS) {
    if (await portOpen(port)) add(`http://127.0.0.1:${port}`);
  }
  const results = [];
  for (const url of candidates.slice(0, 6)) results.push(await probeProxy(url));
  return { system: sys, pac: await getPacUrl(), candidates: results };
}

// ------------------------------------------------------------------ Gale 路径探测
function runPowerShell(script, timeout = 20000) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout, maxBuffer: 4 << 20 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

/** 自动寻找 Gale 安装位置（换电脑后不用手工填路径） */
async function detectGalePath() {
  const found = [];
  const push = (p) => {
    if (!p) return;
    const s = String(p).trim().replace(/^"|"$/g, '');
    if (!s) return;
    if (/gale\.exe$/i.test(s)) found.push(s);
    else found.push(path.join(s, 'gale.exe'));
  };

  if (config.galePath) push(config.galePath);

  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$out=@()",
    "$keys=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
    "Get-ItemProperty $keys | Where-Object { $_.DisplayName -like '*Gale*' } | ForEach-Object { if($_.InstallLocation){$out+=$_.InstallLocation}; if($_.DisplayIcon){$out+=($_.DisplayIcon -replace ',\\d+$','')}; if($_.UninstallString){$out+=$_.UninstallString} }",
    "$sh=New-Object -ComObject WScript.Shell",
    "$dirs=@(\"$env:PUBLIC\\Desktop\",\"$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\",\"$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\")",
    "foreach($d in $dirs){ Get-ChildItem -Path $d -Filter '*.lnk' -Recurse | Where-Object { $_.Name -like '*Gale*' } | ForEach-Object { $t=$sh.CreateShortcut($_.FullName).TargetPath; if($t){$out+=$t} } }",
    "$out | ConvertTo-Json -Compress",
  ].join('; ');
  try {
    const raw = (await runPowerShell(ps)).trim();
    if (raw) {
      const arr = JSON.parse(raw);
      for (const p of Array.isArray(arr) ? arr : [arr]) push(p);
    }
  } catch {}

  // 常见位置
  push(path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Gale'));
  push(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Gale'));
  push(path.join(process.env['LOCALAPPDATA'] || '', 'Programs', 'Gale'));
  push(path.join(process.env['LOCALAPPDATA'] || '', 'Gale'));
  push('D:\\Gale');
  push('E:\\Gale');
  push('C:\\Gale');

  // 各磁盘根目录下找 Gale 文件夹
  try {
    for (const drive of 'CDEFG'.split('')) {
      const root = drive + ':\\';
      if (!fs.existsSync(root)) continue;
      push(path.join(root, 'Gale'));
      for (const sub of ['Program Files', 'Program Files (x86)', 'Games']) {
        push(path.join(root, sub, 'Gale'));
      }
    }
  } catch {}

  for (const c of found) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {}
  }
  return null;
}

// ------------------------------------------------------------------ Gale 进程
function isGaleRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq gale.exe', '/NH'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(/gale\.exe/i.test(stdout));
    });
  });
}

// ------------------------------------------------------------------ 内置引擎的语言包
// Edge/Chrome 把本地翻译模型下载成 profile 里的一个 `EdgeTranslateKitLanguagePack` 目录
// （实测 en→zh 是 197.5 MB）。Translator API **没有删除接口**，所以想释放空间只能自己删目录。
// 这里做一次**有边界**的扫描：只在几个已知的 profile 根目录下找，限制深度与访问量，避免全盘遍历。
const LANG_PACK_RE = /TranslateKit.*LanguagePack$/i;
function findLanguagePacks() {
  const roots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'com.kesomannen.gale'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'com.kesomannen.gale'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Temp'),
    process.env.TEMP,
  ].filter(Boolean);

  const dirSize = (dir) => {
    let n = 0;
    let seen = 0;
    const stack = [dir];
    while (stack.length && seen < 20000) {
      const cur = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        seen++;
        const p = path.join(cur, e.name);
        try {
          if (e.isDirectory()) stack.push(p);
          else if (e.isFile()) n += fs.statSync(p).size;
        } catch {}
      }
    }
    return n;
  };

  const found = new Map(); // path -> bytes
  let visited = 0;
  const deadline = Date.now() + 6000; // 硬上限：个别机器 Temp 目录极大时别把服务卡住
  let timedOut = false;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [{ dir: root, depth: 0 }];
    while (stack.length && visited < 30000) {
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }
      const { dir, depth } = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        visited++;
        const p = path.join(dir, e.name);
        if (LANG_PACK_RE.test(e.name)) {
          found.set(p, dirSize(p)); // 命中就不再往里递归
          continue;
        }
        if (depth < 5) stack.push({ dir: p, depth: depth + 1 });
      }
    }
    if (timedOut) break;
  }

  // 插件自带 Edge 后端（无窗口 Edge）的语言包在 data/edge-profile 里，
  // 它不在上面任何一个 profile 根目录下，所以必须显式补上，否则用户看不到也删不掉它
  const we = packEntry();
  if (we && we.path && !found.has(we.path)) found.set(we.path, we.bytes);

  return [...found.entries()]
    .map(([p, bytes]) => ({ path: p, bytes }))
    .sort((a, b) => b.bytes - a.bytes);
}

async function cdpReachable(port = actualCdpPort) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** 上一次运行时用的调试端口（runtime.json 里的，升级后 ports.json 还没建立时用作兜底） */
function previousCdpPort() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'runtime.json'), 'utf8'));
    return Number(j.cdpPort) || 0;
  } catch {
    return 0;
  }
}

/** 确定本次使用的 CDP 端口。
 *  候选顺序由 portCandidates() 给出：默认"上次成功用过的端口"优先；
 *  用户改过配置端口时则以配置端口优先。选完写回 data/ports.json 作为端口记忆。
 *  注意：Windows 上 Hyper-V / WSL / Docker 会保留大段端口，落到保留段的端口绑定会 EACCES，
 *  所以必须实际试绑（见 core/ports.mjs），不能只看"有没有被占用"。 */
async function resolveCdpPort() {
  const mem = readPortMemory(PORT_MEMORY_FILE);
  const remembered = mem.lastPort || previousCdpPort();
  cdpPortRemembered = remembered || 0;
  const candidates = portCandidates({
    configured: config.cdpPort,
    remembered,
    rememberedConfigured: mem.configuredPort,
  });

  const r = await pickCdpPort({ preferred: candidates, isReachable: (p) => cdpReachable(p) });
  actualCdpPort = r.port;

  if (r.via === 'reuse') {
    cdpPortNote = r.port === config.cdpPort ? '' : `沿用 Gale 当前正在使用的调试端口 ${actualCdpPort}（配置端口是 ${config.cdpPort}）`;
    logLine(`检测到 Gale 已在调试端口 ${actualCdpPort} 上运行，直接沿用。`);
  } else if (r.port === config.cdpPort) {
    cdpPortNote = '';
  } else if (r.via === 'bind' && r.port === remembered) {
    cdpPortNote = `沿用上次使用的调试端口 ${actualCdpPort}（配置端口 ${config.cdpPort} 不可用）`;
    logLine(cdpPortNote + '。');
  } else if (r.via === 'bind' || r.via === 'scan') {
    cdpPortNote = `配置端口 ${config.cdpPort} 不可用（被占用 ${r.used} 个 / 被系统保留 ${r.reserved} 个），已改用 ${actualCdpPort}`;
    logLine(cdpPortNote + '。', 'warn');
    if (r.reserved) logLine('提示：端口被"系统保留"通常是开了 Hyper-V / WSL / Docker；查看：netsh int ipv4 show excludedportrange protocol=tcp', 'warn');
  } else if (r.via === 'ephemeral') {
    cdpPortNote = `配置端口 ${config.cdpPort} 附近连续 ${r.reserved + r.used} 个端口都不可用（其中 ${r.reserved} 个被系统保留），已改用系统分配的空闲端口 ${actualCdpPort}`;
    logLine(cdpPortNote + '。', 'warn');
    logLine('提示：端口被"系统保留"通常是开了 Hyper-V / WSL / Docker；想让它重新分配，可执行 net stop winnat 再 net start winnat（需管理员）。', 'warn');
  } else {
    cdpPortNote = `找不到可用端口，仍按 ${actualCdpPort} 尝试`;
    logLine(cdpPortNote + '。', 'warn');
  }

  // 端口记忆：记住这次真正用上的端口，下次优先复用它（用户改配置端口时自动让位）
  writePortMemory(PORT_MEMORY_FILE, { lastPort: actualCdpPort, configuredPort: config.cdpPort });
  cdpPortRemembered = actualCdpPort;
  return actualCdpPort;
}

/** 启动 Gale 后确认调试端口真的开了；没开就给出可操作的原因（这是"悬浮条不出现"的头号原因） */
async function verifyCdpAfterLaunch(timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cdpReachable()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  logLine(`Gale 已启动，但调试端口 ${actualCdpPort} 在 ${Math.round(timeoutMs / 1000)} 秒内没有打开，外挂挂不上。`, 'warn');
  if (cdpPortNote) logLine(cdpPortNote + '。', 'warn');
  logLine('常见原因：① Gale 已在运行（含托盘图标）需完全退出再重启；② 端口被系统保留或被安全软件拦截；③ 启动参数被其他工具覆盖。', 'warn');
  return false;
}

function launchGale() {
  try {
    const env = {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${actualCdpPort} --remote-allow-origins=*`,
    };
    const child = spawn(config.galePath, [], { detached: true, stdio: 'ignore', env, windowsHide: false });
    child.unref();
    logLine(`已启动 Gale: ${config.galePath}（调试端口 ${actualCdpPort}）`);
    return true;
  } catch (e) {
    logLine('启动 Gale 失败: ' + e.message, 'error');
    return false;
  }
}

function openInBrowser(url) {
  try {
    spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) {
    logLine('打开浏览器失败: ' + e.message, 'error');
  }
}

// ------------------------------------------------------------------ 页面健康自检
// 注入脚本会定期自检"关键锚点是否还在、是否还有可翻译内容"；这里负责取回并在降级时告警。
let _pageHealth = { at: 0, value: null, degraded: false };
async function getPageHealth(maxAge = 10000) {
  if (Date.now() - _pageHealth.at < maxAge) return _pageHealth.value;
  let value = null;
  try {
    if (bridge.attached) {
      const raw = await bridge.evaluate(
        'JSON.stringify(window.__galeTrans && window.__galeTrans.health ? window.__galeTrans.health() : null)',
      );
      value = raw ? JSON.parse(raw) : null;
    }
  } catch {
    value = null;
  }
  if (value?.degraded && !_pageHealth.degraded) {
    logLine('注入自检告警：' + (value.reasons || []).join('；'), 'warn');
  }
  _pageHealth = { at: Date.now(), value, degraded: !!value?.degraded };
  return value;
}

// ------------------------------------------------------------------ HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

/**
 * 只放行"本机来源"的请求。
 * 为什么必须有这道门：本地服务的端口是固定的、可预测的，而浏览器允许网页向 127.0.0.1 发请求。
 * 如果 CORS 写成 `*`，那么**用户随便打开的任何网站**都能：
 *   · 读走你的译库（/api/library/export）
 *   · 改你的配置（把翻译节点换成它自己的服务器 → 你翻的每句话都过它一遍）
 *   · 给你装上开机自启、往桌面写快捷方式（/api/system/autostart、/api/system/shortcut）
 * 放行范围：本地设置页、注入到 Gale 的页面（tauri.localhost），以及没有 Origin 的命令行工具。
 */
function originAllowed(origin) {
  if (!origin) return true; // 非浏览器请求（curl / 测试脚本 / 本地工具）
  try {
    const host = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === 'tauri.localhost';
  } catch {
    return false;
  }
}

function send(res, status, body, type = 'application/json; charset=utf-8', { cors = true } = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
  // 只回显已通过校验的来源，并且加 Vary，避免中间层把响应缓存给别的来源
  if (cors && res._origin) {
    headers['Access-Control-Allow-Origin'] = res._origin;
    headers['Access-Control-Allow-Headers'] = '*';
    headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS';
    headers['Access-Control-Allow-Private-Network'] = 'true';
    headers['Vary'] = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return resolve({});
      try {
        resolve(JSON.parse(s));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
    // 先过来源校验：非本机来源一律拒绝（含预检），避免任意网页操控本地服务
    const origin = req.headers.origin || '';
    if (!originAllowed(origin)) {
      logLine(`拒绝非本机来源的请求：${origin} ${req.method} ${p}`, 'warn');
      return send(res, 403, { ok: false, error: 'only local origins are allowed' }, undefined, { cors: false });
    }
    res._origin = origin;

    if (req.method === 'OPTIONS') return send(res, 204, '');

    // 设置页与静态资源
    if (p === '/' || p === '/index.html') {
      const file = path.join(ROOT, 'ui', 'index.html');
      return send(res, 200, fs.readFileSync(file, 'utf8'), MIME['.html']);
    }

    if (p === '/i18n.js') {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8'), MIME['.js']);
    }

    // 本地翻译后端（无窗口 Edge）的宿主页面。
    // 端侧翻译 API 只在安全上下文里暴露，file:// / about:blank 都不行，所以由本服务托管在 127.0.0.1 上。
    // 顶层导航不带 Origin 头，originAllowed('') 会放行，不需要额外开洞。
    if (p === WORKER_PAGE_PATH) {
      return send(res, 200, WORKER_PAGE_HTML, MIME['.html']);
    }

    if (p === WORKER_SCRIPT_PATH) {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'edge-worker-page.js'), 'utf8'), MIME['.js']);
    }

    if (p === '/api/client-config') {
      return send(res, 200, {
        config: {
          provider: config.provider,
          target: config.target,
          source: config.source,
          translateNames: config.translateNames,
          translateConfigPage: config.translateConfigPage !== false,
          hoverOriginal: config.hoverOriginal,
          minLen: config.minLen,
          glossary: config.glossary,
          fuzzyReuse: config.fuzzyReuse !== false,
          uiLang: config.uiLang || 'zh-CN',
          // 悬浮栏也要知道"仅本地模式"开着，才能把在线节点置灰（它只读这一份轻量配置）
          offlineOnly: !!config.offlineOnly,
        },
        // 固定译法的键下发到页面：命中时强制翻译，不受"名字保护"等启发式影响
        phraseKeys: /^zh/i.test(String(config.target || ''))
          ? Object.keys(config.phraseMap || {}).map((k) => k.trim().toLowerCase())
          : [],
        forceTranslate: config.forceTranslate || [],
        chineseSearch: config.chineseSearch !== false,
        providers: listProviders(config, config.uiLang || 'zh-CN'),
      });
    }

    if (p === '/api/config' && req.method === 'GET') {
      return send(res, 200, { config });
    }

    if (p === '/api/langs') {
      return send(res, 200, { langs: LANG_LIST, target: config.target, source: config.source });
    }

    if (p === '/api/search') {
      const q = url.searchParams.get('q') || '';
      return send(res, 200, searchChinese(q));
    }

    if (p === '/api/index-mods' && req.method === 'POST') {
      const { entries } = await readBody(req);
      const n = upsertModIndex(entries);
      return send(res, 200, { ok: true, added: n, total: Object.keys(modIndex).length });
    }

    if (p === '/api/coverage') {
      try {
        const raw = await bridge.evaluate('JSON.stringify(window.__galeTrans ? window.__galeTrans.coverage() : null)');
        return send(res, 200, { ok: true, coverage: JSON.parse(raw) });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message });
      }
    }

    if (p === '/api/coverage-all' && req.method === 'POST') {
      // 依次访问各页面做体检，结束后回到原页面
      const routes = ['/', '/browse', '/config', '/modpack', '/prefs'];
      const results = [];
      try {
        const start = JSON.parse(await bridge.evaluate('JSON.stringify({href: location.href})'));
        for (const r of routes) {
          await bridge.send('Page.navigate', { url: 'http://tauri.localhost' + r });
          await new Promise((res2) => setTimeout(res2, 4500));
          const raw = await bridge.evaluate('JSON.stringify(window.__galeTrans ? window.__galeTrans.coverage() : null)');
          const cov = JSON.parse(raw);
          if (cov) results.push(cov);
        }
        await bridge.send('Page.navigate', { url: start.href });
        return send(res, 200, { ok: true, results });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message, results });
      }
    }

    if (p === '/api/health') {
      const page = await getPageHealth(0);
      const d = nodeDiagnostics();
      return send(res, 200, {
        ok: true,
        servicePort: actualPort,
        cdpPort: actualCdpPort,
        cdpPortConfigured: config.cdpPort,
        cdpPortNote,
        bridge: bridge.status,
        galeRunning: await isGaleRunning(),
        page,
        degraded: !!page?.degraded,
        localEngine: d.localEngine,
        usableNodes: d.usable,
        chainNodes: d.chain,
        nodeWarning: d.warning,
      });
    }

    if (p === '/api/system/status') {
      return send(res, 200, await systemStatus(config.galePath));
    }

    if (p === '/api/system/shortcut' && req.method === 'POST') {
      const { enable } = await readBody(req);
      const r = enable ? await enableIntegration(config.galePath) : await disableIntegration(config.galePath);
      logLine(`免启动器模式：${enable ? '开启' : '还原'} -> ${r.ok ? r.mode || 'ok' : r.error}`);
      return send(res, 200, r);
    }

    if (p === '/api/system/autostart' && req.method === 'POST') {
      const { enable } = await readBody(req);
      const r = enable ? await enableAutostart() : await disableAutostart();
      logLine(`开机自启：${enable ? '开启' : '关闭'} -> ${r.ok ? '成功' : r.error}`);
      return send(res, 200, r);
    }

    if (p === '/api/proxy-status') {
      const sys = await getSystemProxy();
      return send(res, 200, { configured: config.proxy || '', system: sys });
    }

    if (p === '/api/detect-proxy' && req.method === 'POST') {
      const r = await detectProxy();
      logLine(`代理探测：系统代理=${r.system || '未启用'}，可用=${r.candidates.filter((c) => c.ok).map((c) => c.url).join(',') || '无'}`);
      return send(res, 200, r);
    }

    if (p === '/api/detect-gale' && req.method === 'POST') {
      const found = await detectGalePath();
      if (found) {
        config.galePath = found;
        saveConfig();
        logLine('已自动找到 Gale: ' + found);
      }
      return send(res, 200, { ok: !!found, path: found, current: config.galePath });
    }

    if (p === '/api/config' && req.method === 'POST') {
      const patch = await readBody(req);
      config = deepMerge(config, patch);
      const notes = sanitizeConfig(); // 清理指向已移除节点的残留
      saveConfig();
      applyOfflineMode(); // 仅本地模式：立刻生效，不用重启服务
      if ('offlineOnly' in patch) {
        logLine(config.offlineOnly ? '已开启仅本地模式：所有对外网络请求会被拦截' : '已关闭仅本地模式：在线翻译节点恢复可用', 'warn');
      }
      logLine('配置已更新: ' + Object.keys(patch).join(','));
      if (patch.cdpPort && patch.cdpPort !== actualCdpPort) {
        await resolveCdpPort(); // 重新挑一个真的能绑上的端口
        bridge.port = actualCdpPort;
        bridge.stop();
        bridge.start();
        logLine(`调试端口已切换为 ${actualCdpPort}${cdpPortNote ? '（' + cdpPortNote + '）' : ''}`);
      }
      return send(res, 200, { ok: true, config, migrationNotes: notes });
    }

    if (p === '/api/translate' && req.method === 'POST') {
      const { texts, quality, game } = await readBody(req);
      if (!Array.isArray(texts)) return send(res, 400, { error: 'texts 必须是数组' });
      const clean = texts.slice(0, 500).map((t) => String(t ?? '').slice(0, 8000));
      const items = await translator.translate(clean, { quality, game });
      return send(res, 200, { items });
    }

    if (p === '/api/compare' && req.method === 'POST') {
      const { text, verify } = await readBody(req);
      if (!text) return send(res, 400, { ok: false, error: '缺少 text' });
      const r = await translator.compare(String(text).slice(0, 2000), { verify: !!verify });
      return send(res, 200, r);
    }

    if (p === '/api/polish/test' && req.method === 'POST') {
      return send(res, 200, await translator.testPolish());
    }

    if (p === '/api/library/stats') {
      return send(res, 200, { ...library.stats(), pendingPolish: translator._polishQueue.length });
    }

    if (p === '/api/library/export' && req.method === 'POST') {
      const { target, game, file, includeCache } = await readBody(req);
      try {
        let extra = [];
        if (includeCache !== false) {
          for (const v of cache.map.values()) {
            // 跳过源文被截断的条目：截断的源文在别人那边算出的 key 不同，导了也命中不了
            if (typeof v?.d === 'string' && v.s && !v.tr) extra.push({ s: v.s, d: v.d, t: v.t || config.target });
          }
        }
        const r = library.export({ target: target || '', game: game || '', file, extra });
        logLine(`译库导出：${r.count} 条（含缓存 ${extra.length} 条）-> ${r.file}`);
        return send(res, 200, r);
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message });
      }
    }

    if (p === '/api/library/import' && req.method === 'POST') {
      const { path: p1, url, content, onlyIfMissing } = await readBody(req);
      try {
        let text = content;
        let source = 'local-file';
        if (!text && url) {
          const r = await request(url, { timeout: 60000, proxy: config.proxy || null });
          if (r.status !== 200) throw new Error(`下载失败 HTTP ${r.status}`);
          text = r.text;
          source = url;
        } else if (!text && p1) {
          text = fs.readFileSync(p1, 'utf8');
          source = p1;
        }
        if (!text) throw new Error('需要提供 url / path / content 之一');
        const pack = JSON.parse(text);
        // 兼容三种形态：导出包 {entries:[...]}、纯数组 [...]、以及本机译库原文件 {entries:{hash:{...}}}
        const raw = Array.isArray(pack) ? pack : pack.entries ?? pack;
        const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
        if (!list.length) throw new Error('译库文件里没有条目');
        const packTarget = typeof pack?.target === 'string' && pack.target !== 'all' ? pack.target : config.target;
        const r = library.merge(list, { target: packTarget, onlyIfMissing: onlyIfMissing !== false, source });
        library.flush(); // 导入是显式操作，立刻落盘，避免服务重启丢失
        logLine(`译库导入：新增 ${r.added} 条（跳过 ${r.skipped}），共 ${r.total} 条`);
        return send(res, 200, { ok: true, ...r, source });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message });
      }
    }

    if (p === '/api/library/subscribe' && req.method === 'POST') {
      const { url, remove } = await readBody(req);
      const list = new Set(library.stats().subscriptions || []);
      if (remove) list.delete(url);
      else if (url) list.add(url);
      library.setSubscriptions([...list]);
      return send(res, 200, { ok: true, subscriptions: [...list] });
    }

    if (p === '/api/library/clear' && req.method === 'POST') {
      library.clear();
      return send(res, 200, { ok: true });
    }

    if (p === '/api/status') {
      const running = await isGaleRunning();
      return send(res, 200, {
        cdp: bridge.status,
        galeRunning: running,
        cdpReachable: await cdpReachable(),
        cdpPort: actualCdpPort,
        cdpPortConfigured: config.cdpPort,
        cdpPortRemembered,
        cdpPortNote,
        galePath: config.galePath,
        provider: config.provider,
        cache: { size: cache.size, hits: cache.hits, misses: cache.misses },
        library: { size: library.size, hits: library.hits },
        stats: translator.stats,
        rateLimited: rateLimitStatus(),
        // 翻译节点是否真的可用（内置引擎在 WebView2 里不可用时，界面要据此说实话并给出告警）
        ...(() => {
          const d = nodeDiagnostics();
          return {
            localEngine: d.localEngine,
            usableNodes: d.usable,
            chainNodes: d.chain,
            nodeWarning: d.warning,
            offlineOnly: d.offlineOnly,
            // 开着仅本地模式时，界面上要能一眼看出"联网节点已被停用"
            offlineBlocked: d.offlineOnly
              ? listProviders(config, config.uiLang)
                  .map((x) => x.id)
                  .filter((id) => !isProviderLocal(id, config))
              : [],
          };
        })(),
        pageHealth: await getPageHealth(),
        events: events.slice(-40).reverse(),
        servicePort: actualPort,
        version: VERSION,
        buildId: BUILD,
      });
    }

    if (p === '/api/shutdown' && req.method === 'POST') {
      // 供启动器在"服务是旧代码"时把它干净地换掉
      logLine('收到关闭请求，正在退出…');
      send(res, 200, { ok: true });
      setTimeout(shutdown, 150);
      return;
    }

    if (p === '/api/diag') {
      try {
        const d = await bridge.evaluate('JSON.stringify(window.__galeTrans ? window.__galeTrans.diag() : {installed:false})');
        return send(res, 200, { ok: true, diag: JSON.parse(d) });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message });
      }
    }

    if (p === '/api/apply' && req.method === 'POST') {
      // 软应用：重新拉页面侧配置 → 还原译文 → 重新扫描。不刷新页面，抽屉不会关。
      try {
        const ok = await bridge.evaluate(
          '(async () => { if (!window.__galeTrans || !window.__galeTrans.softApply) return false; await window.__galeTrans.softApply(); return true; })()',
        );
        return send(res, 200, { ok: !!ok });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message });
      }
    }

    if (p === '/api/reinject' && req.method === 'POST') {      try {
        const { reload } = await readBody(req);
        buildInjection();
        await bridge.inject();
        _pageHealth = { at: 0, value: null, degraded: false }; // 重新注入后旧的自检结果作废
        if (reload) {
          // 重新加载页面：清掉旧实例留下的译文，保证新规则/新词典立即生效
          await bridge.send('Page.reload', { ignoreCache: false });
        }
        return send(res, 200, { ok: true });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message });
      }
    }

    if (p === '/api/launch-gale' && req.method === 'POST') {
      const ok = launchGale();
      // 后台确认端口是否真的开了，不阻塞这次请求
      verifyCdpAfterLaunch().catch(() => {});
      return send(res, 200, { ok, cdpPort: actualCdpPort });
    }

    if (p === '/api/rate-limit/clear' && req.method === 'POST') {
      // 手动解除限流冷却（比如换了代理节点、或想立刻重试）
      const { provider } = await readBody(req);
      if (provider) clearProviderRateLimit(provider);
      else for (const x of rateLimitStatus()) clearProviderRateLimit(x.id);
      logLine(`限流冷却已清除：${provider || '全部'}`);
      return send(res, 200, { ok: true, rateLimited: rateLimitStatus() });
    }

    if (p === '/api/local-engine' && req.method === 'GET') {
      // 内置引擎（浏览器端侧模型）的状态：哪条后端能用、语言包是否就绪、下载进度
      //
      // ⚠️ 这里**必须把"还没连上 Gale"和"浏览器不支持"分开报**。以前两种情况都返回
      // supported:false，界面就把「启用内置引擎」按钮藏掉了 —— 用户看到的是"未下载、又没法下载"，
      // 完全查不出原因。现在用 bridgeDown 明确区分，界面才能给出对的提示并自愈重试。
      // 注意：内置引擎虽然有「插件自己拉起的无窗口 Edge」这条后端，但它同样是**为 Gale 页面服务**的，
      // 所以没挂上 Gale 时一律按"还没连上"回报 —— 既不会误导，也不会因为一次断连就悄悄
      // 拉起浏览器、下 200 MB 语言包（集成测试跑在隔离服务里，正是这种"永远挂不上"的场景）。
      if (!bridge.attached) {
        return send(res, 200, {
          ok: false,
          bridgeDown: true,
          supported: false,
          backend: '',
          galeRunning: await isGaleRunning(),
          reason: '还没连接到 Gale 页面',
        });
      }
      try {
        // 带上当前配置的语言对：界面要知道的是"**这一对**准备好了没有"，
        // 而不是固定的 en>zh（否则目标语言是繁体时会误报"未下载"）
        const src = url.searchParams.get('source') || config.source || 'auto';
        const tgt = url.searchParams.get('target') || config.target || 'zh-CN';
        const st = await readLocalEngineStatus({ source: src, target: tgt });
        return send(res, 200, { ok: true, ...st });
      } catch (e) {
        return send(res, 200, {
          ok: false,
          bridgeDown: true,
          supported: false,
          galeRunning: await isGaleRunning(),
          reason: '读取内置引擎状态失败：' + e.message,
        });
      }
    }

    if (p === '/api/local-engine/prepare' && req.method === 'POST') {
      const { source, target } = await readBody(req);
      const src = source || 'en';
      const tgt = target || 'zh-CN';

      // 装了 Edge、且 Gale 页面自己跑不了端侧模型时，用插件自带的 Edge 后端
      if (localBackend() === 'edge') {
        // 仅本地模式下唯一会联网的动作：第一次把语言包（约 200 MB）下下来。
        // 那次下载走的是 Edge 自己的组件下载，只取模型本身，不发送任何要翻译的文本 ——
        // 这里如实记一条日志，免得用户看到"禁网"却抓包抓到流量而困惑。
        // 例外：随包自带语言包（data/edge-pack）时连这一次都不用联网，见 core/edge-worker.mjs 的 adoptSeed()。
        const seed = seedInfo();
        if (isOfflineOnly() && !packLooksReal() && !seed.ready) {
          logLine(
            '仅本地模式已开启，但内置引擎的语言包还没下载：这次下载语言包需要联网（约 200 MB，只取模型本身，不发送要翻译的文本）',
            'warn',
          );
        } else if (!packLooksReal() && seed.ready && seed.runtime) {
          logLine(`将使用随包自带语言包（${(seed.bytes / 1048576).toFixed(1)} MB），本次不需要联网下载`);
        }
        const r = await workerPrepare(src, tgt, { servicePort: actualPort });
        if (r && r.ok === false) logLine('内置引擎准备失败（Edge 后端）：' + r.error, 'warn');
        else logLine(`内置引擎准备结果（Edge 后端）：${JSON.stringify(r)}`);
        return send(res, 200, r);
      }

      // 连不上 Gale 就别假装开始了 —— 直接报错，界面才能给出有用的提示
      if (!bridge.attached) {
        return send(res, 200, { ok: false, started: false, error: '还没连接到 Gale 页面，请先启动 Gale' });
      }
      // **不能无条件报 started:true**：环境不提供端侧模型时（Gale 用的 WebView2 就是），页面里的
      // localPrepare 会在 1ms 内抛错；以前这里是"发射后不管"，照样回 started:true，抽屉就一直显示
      // "已开始下载，请稍候…"，用户永远等不到进度、也看不到错误原因 —— 这就是"点了没反应"。
      // 折中：先等一小会儿看有没有**立刻**出结果：立刻失败就如实回报，真在下载（要 200 MB）才转后台。
      const task = bridge.evaluate(
        `(async () => {
            const T = window.__galeTrans;
            if (!T || typeof T.localPrepare !== 'function') return { ok: false, error: '页面里没有内置引擎' };
            try { return await T.localPrepare(${JSON.stringify(source || 'en')}, ${JSON.stringify(target || 'zh-CN')}); }
            catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
          })()`,
        { timeout: 600000 },
      );
      const settled = await Promise.race([
        task.then((r) => ({ settled: true, r })).catch((e) => ({ settled: true, err: e })),
        new Promise((r) => setTimeout(() => r({ settled: false }), 1500)),
      ]);
      if (settled.settled) {
        const r = settled.r;
        const err = settled.err
          ? settled.err.message || String(settled.err)
          : r && r.ok === false
            ? r.error || '未能开始下载'
            : '';
        if (err) {
          logLine('内置引擎准备失败：' + err, 'warn');
          return send(res, 200, { ok: false, started: false, error: err });
        }
        logLine(`内置引擎准备结果：${JSON.stringify(r)}`);
        return send(res, 200, { ok: true, started: true, result: r });
      }
      // 还没结束 —— 说明真的在下载了，转后台，界面靠轮询 /api/local-engine 看进度与错误
      task
        .then((r) => logLine(`内置引擎准备结果：${JSON.stringify(r)}`))
        .catch((e) => logLine('内置引擎准备失败：' + e.message, 'warn'));
      return send(res, 200, { ok: true, started: true });
    }

    if (p === '/api/local-engine/reset' && req.method === 'POST') {
      // 重置引擎：只清掉模型实例（下次翻译重新创建），**不删磁盘上的语言包**
      if (localBackend() === 'edge') {
        const r = await workerReset();
        logLine('内置引擎已重置（Edge 后端）：' + JSON.stringify(r));
        return send(res, 200, r);
      }
      if (!bridge.attached) return send(res, 200, { ok: false, error: '还没连接到 Gale 页面' });
      try {
        const r = await bridge.evaluate(
          `(async () => { const T = window.__galeTrans; if (!T || typeof T.localReset !== 'function') return { ok: false, error: '页面里没有内置引擎' }; return await T.localReset(); })()`,
          { timeout: 20000 },
        );
        logLine('内置引擎已重置：' + JSON.stringify(r));
        return send(res, 200, r && typeof r === 'object' ? r : { ok: true });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message });
      }
    }

    if (p === '/api/local-engine/pack' && req.method === 'GET') {
      // 扫描磁盘上的语言包目录（用于展示占用空间 / 供删除）
      const dirs = await findLanguagePacks();
      // Edge 后端那份的特殊之处：语言包只是插件 profile 的一部分，profile 里还有 Edge 自己的
      // 组件缓存（会随使用长到几百 MB）。删的时候是整个 profile 一起删，所以占用也得如实报整个 profile，
      // 不然用户看到"释放 197.5 MB"、实际少了更多，反而更糊涂。
      const workerProfile = {
        path: PROFILE_DIR,
        bytes: profileBytes(),
        packBytes: packBytes(),
        packInstalled: packInstalled(),
      };
      // 随包自带的那份语言包：它不占 Edge 的 profile，但占磁盘，得让用户看得见
      // （删掉它只影响"以后重装不用下载"，不影响正在用的引擎）。
      const seed = seedInfo();
      return send(res, 200, {
        ok: true,
        dirs,
        totalBytes: dirs.reduce((a, d) => a + d.bytes, 0),
        workerProfile,
        seed,
        edge: { available: hasEdge(), path: edgePath() },
      });
    }

    // 打开语言包位置：在资源管理器里把目录摊开给用户看（也能自己手动删）。
    // 为什么要有它：语言包不是随便一个文件，用户想确认"下到哪儿了、占多大"时，
    // 光看界面上的路径字符串不好找；给一个按钮点开最省事。
    if (p === '/api/local-engine/pack/open' && req.method === 'POST') {
      const dir = revealTarget();
      try {
        fs.mkdirSync(dir, { recursive: true }); // 还没下载过时 data/ 可能都不在，先建出来免得资源管理器报"找不到"
        spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
        logLine(`已打开语言包位置：${dir}`);
        return send(res, 200, { ok: true, opened: dir, seed: seedInfo() });
      } catch (e) {
        const msg = (e && e.message) || String(e);
        logLine(`打开语言包位置失败：${dir} —— ${msg}`, 'warn');
        return send(res, 200, { ok: false, opened: dir, error: msg });
      }
    }

    if (p === '/api/local-engine/pack/delete' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.confirm !== true) {
        return send(res, 400, { ok: false, error: '删除语言包需要确认（confirm: true）' });
      }
      // scope = 'seed'：只删"随包自带"的那份（data/edge-pack）。
      // 界面上已经**没有**单独的"删除自带语言包"按钮了（官方发布的主包不含语言包，那个按钮没有用武之地），
      // 「删除语言包」走的是默认的 'all'：profile + Gale 自己那份 + 自带那份一起清。
      // 这个 scope 留着是给脚本/测试用的（删自带那份**不用关 Gale、也不用停内置引擎**，纯省那 ~200 MB）。
      const scope = body.scope === 'seed' ? 'seed' : 'all';
      const removed = [];
      let freed = 0;
      let failed = 0;
      const seedNow = seedInfo();
      let seedDeleted = false;
      const dropSeed = () => {
        if (!seedNow.ready) return;
        const r = removeSeed();
        if (r.ok) {
          seedDeleted = true;
          removed.push(r.path);
          freed += r.freedBytes;
        } else {
          failed++;
          logLine(`删除自带语言包失败：${r.path} —— ${r.error || '未知原因'}`, 'warn');
        }
      };
      if (scope === 'seed') {
        if (!seedNow.ready) {
          return send(res, 200, { ok: true, removed: [], freedBytes: 0, note: '没有找到自带语言包' });
        }
        dropSeed();
        return send(res, 200, { ok: true, removed, freedBytes: freed, failed, scope, seedDeleted });
      }
      // Edge 后端那份在插件自己的 profile 里，删除 = **清空整个 profile**。
      // 只删语言包目录是错的：Edge 的组件登记还留着，它会认为模型已安装，于是
      // Translator.create() 一直失败、**语言包再也下不回来**（用户报的就是这个）——
      // 详见 core/edge-worker.mjs 里 wipeProfile() 的注释与实测记录。
      // 好处是：它不受 Gale 进程占用影响，所以删它不需要用户先关 Gale。
      const inProfile = (q) => {
        const a = path.resolve(q).toLowerCase();
        const b = path.resolve(PROFILE_DIR).toLowerCase();
        return a === b || a.startsWith(b + path.sep);
      };
      const dirs = await findLanguagePacks();
      const workerDirs = dirs.filter((d) => inProfile(d.path) || inProfile(path.dirname(d.path)));
      const otherDirs = dirs.filter((d) => !workerDirs.includes(d));
      const profBytes = profileBytes();
      if (!dirs.length && profBytes === 0 && !seedNow.ready) {
        return send(res, 200, { ok: true, removed: [], freedBytes: 0, note: '没有找到已下载的语言包' });
      }
      // Gale 自己那份（WebView2 profile 里的）会被 Gale 占着
      if (otherDirs.length && (await isGaleRunning())) {
        return send(res, 200, { ok: false, error: 'Gale 正在运行，文件被占用。请先关闭 Gale（stop.cmd）再删除。' });
      }
      if (workerDirs.length || profBytes > 0) {
        const w = await wipeProfile();
        if (w.ok) {
          removed.push(w.path);
          freed += w.freedBytes;
          logLine(`已清空内置浏览器数据（语言包在其中）：${w.path}（释放 ${(w.freedBytes / 1048576).toFixed(1)} MB）`);
        } else {
          failed++;
          logLine(`清空内置浏览器数据失败：${w.path} —— ${w.error || '未知原因'}`, 'warn');
        }
      }
      for (const d of otherDirs) {
        try {
          fs.rmSync(d.path, { recursive: true, force: true });
          removed.push(d.path);
          freed += d.bytes;
          logLine(`已删除语言包：${d.path}（${(d.bytes / 1048576).toFixed(1)} MB）`);
        } catch (e) {
          failed++;
          logLine(`删除语言包失败：${d.path} —— ${e.message}`, 'warn');
        }
      }
      // 自带那份不在 profile 里，放最后删：前面任何一步失败都不影响它被清掉（它就是用来省磁盘的）
      dropSeed();
      return send(res, 200, { ok: true, removed, freedBytes: freed, failed, scope, seedDeleted });
    }

    if (p === '/api/test-provider' && req.method === 'POST') {
      const { provider } = await readBody(req);
      const r = await translator.testProvider(provider || config.provider);
      return send(res, 200, r);
    }

    if (p === '/api/cache/clear' && req.method === 'POST') {
      cache.clear();
      logLine('缓存已清空');
      return send(res, 200, { ok: true });
    }

    if (p === '/api/open-settings') {
      openInBrowser(`http://127.0.0.1:${actualPort}/`);
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    logLine('请求处理异常 ' + p + ': ' + e.message, 'error');
    return send(res, 500, { error: e.message });
  }
});

// ------------------------------------------------------------------ 启动
let actualPort = config.servicePort;
let actualCdpPort = config.cdpPort;
let cdpPortNote = ''; // 端口被换掉时的原因，供设置面板 / 抽屉显示
let cdpPortRemembered = 0; // 端口记忆：上次成功使用的调试端口

function listen(port, triesLeft = 10) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      if (e.code === 'EADDRINUSE' && triesLeft > 0) {
        server.removeListener('error', onError);
        listen(port + 1, triesLeft - 1).then(resolve, reject);
      } else reject(e);
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      actualPort = port;
      resolve(port);
    });
  });
}

async function main() {
  await listen(config.servicePort);

  // 先定下 CDP 端口（被占用就换一个），再写 runtime.json 供启动器与设置页读取
  await resolveCdpPort();

  try {
    fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(ROOT, 'data', 'runtime.json'),
      JSON.stringify(
        {
          port: actualPort,
          pid: process.pid,
          cdpPort: actualCdpPort,
          cdpPortNote,
          cdpPortRemembered,
          buildId: BUILD,
          version: VERSION,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } catch (e) {
    logLine('写入 runtime.json 失败: ' + e.message, 'warn');
  }
  logLine(`Gale 汉化服务已启动: http://127.0.0.1:${actualPort}/  （翻译源：${config.provider}，调试端口 ${actualCdpPort}）`);
  buildInjection();
  bridge.port = actualCdpPort;
  bridge.servicePort = actualPort; // 让 CDP 选页面时排除插件自己的设置页

  // 内置引擎（浏览器端侧模型）跑在浏览器页面里，Node 侧只能"转发"。两条后端二选一：
  //   'gale' → Gale 页面自己的 Translator（走 CDP 调 window.__galeTrans.localTranslate）
  //   'edge' → 插件自己拉起的无窗口 Edge（走 CDP 调 window.__edgeTrans.localTranslate）
  // 首次下载语言包要 50~75 秒，超时给足。
  setLocalTranslator(async (texts, { source, target } = {}) => {
    const backend = localBackend();
    if (backend === 'edge') {
      return await workerTranslate(
        texts,
        { source: source || 'auto', target: target || 'zh-CN' },
        { servicePort: actualPort },
      );
    }
    if (backend !== 'gale') {
      throw new Error('内置引擎不可用：Gale 页面还没挂上，或者本机找不到可用的 Edge');
    }
    const out = await bridge.evaluate(
      `(async () => {
        const T = window.__galeTrans;
        if (!T || typeof T.localTranslate !== 'function') return { __error: '页面里没有内置引擎（请重新注入或重启 Gale）' };
        try { return { ok: await T.localTranslate(${JSON.stringify(texts)}, ${JSON.stringify({ source: source || 'auto', target: target || 'zh-CN' })}) }; }
        catch (e) { return { __error: (e && e.message) || String(e) }; }
      })()`,
      { timeout: 180000 },
    );
    if (out && out.__error) throw new Error(out.__error);
    if (!Array.isArray(out && out.ok) || out.ok.length !== texts.length) {
      throw new Error('内置引擎返回条目数不匹配');
    }
    return out.ok;
  });

  bridge.start();

  if (config.autoLaunchGale) {
    if (!fs.existsSync(config.galePath)) {
      const found = await detectGalePath();
      if (found) {
        config.galePath = found;
        saveConfig();
        logLine('自动找到 Gale 安装位置: ' + found);
      } else {
        logLine('未找到 gale.exe，请在设置面板里手工填写 Gale 路径。', 'warn');
      }
    }
    const running = await isGaleRunning();
    if (!running) {
      logLine('未检测到 Gale 进程，正在以调试模式启动…');
      launchGale();
      await verifyCdpAfterLaunch();
    } else if (!(await cdpReachable())) {
      logLine(
        `注意：Gale 已在运行，但 ${actualCdpPort} 端口上没有调试端口。请完全退出 Gale（含托盘）后由本服务重新启动，或手动运行 start.cmd。`,
        'warn',
      );
    } else {
      logLine(`检测到 Gale 已以调试模式运行（端口 ${actualCdpPort}），直接挂载。`);
    }
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
function shutdown() {
  logLine('正在退出，保存缓存与译库…');
  cache.flush();
  library.flush();
  bridge.stop();
  // 插件自己拉起的 Edge 后端也要收掉，不然会留下一个没有宿主的无窗口 Edge 进程。
  // 用兜底定时器等清理，但不为了清理而不退出。
  let done = false;
  const bye = () => {
    if (done) return;
    done = true;
    process.exit(0);
  };
  try {
    stopWorker().catch(() => {}).finally(bye);
  } catch {
    bye();
  }
  setTimeout(bye, 1500).unref?.();
}
setInterval(() => cache.flush(), 60000).unref?.();
// 后台自检：即使设置面板没开，也定期检查页面是否降级并写日志告警
setInterval(() => getPageHealth(0).catch(() => {}), 60000).unref?.();

main().catch((e) => {
  logLine('启动失败: ' + e.message, 'error');
  process.exit(1);
});
