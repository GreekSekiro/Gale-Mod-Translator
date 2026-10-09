// 集成冒烟测试：临时起一份服务（隔离配置，不会动你的 config.json / 不会启动 Gale），
// 再用无头 Edge 加载夹具页面、注入 inject.js + drawer.js，验证：
//   1) 服务能起来，关键 API 都能响应
//   2) 页面侧注入成功（悬浮条 + 抽屉都建出来）
//   3) 点悬浮条 ⚙ 能打开页内抽屉，抽屉能通过 HTTP 拿到真实服务状态（跨域 CORS 通）
//   4) 全程没有未捕获的 JS 异常
//
// 用法: node tools/test-integration.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { request, setOfflineOnly, isOfflineOnly, isLoopbackHost } from '../core/net.mjs';
import { isProviderLocal, filterLocalProviders } from '../core/providers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const I18N_SRC = fs.readFileSync(path.join(ROOT, 'core', 'i18n.js'), 'utf8');
const INJECT = fs.readFileSync(path.join(ROOT, 'core', 'inject.js'), 'utf8');
const DRAWER = fs.readFileSync(path.join(ROOT, 'core', 'drawer.js'), 'utf8');
// 顺序必须和服务端 buildInjection() 完全一致：i18n → inject → drawer。
// 少了 i18n.js 就会出现"界面切不了英文"这种假失败（词典压根没注入）。
const PAGE_SCRIPT = `${I18N_SRC}\n;\n${INJECT}\n;\n${DRAWER}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 同步睡一小会儿（删目录的重试循环里用）
const sleepSync = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {}
};
// 带重试地删目录：Windows 上 Edge 被 kill 之后，GPU / 渲染 / crashpad 子进程还会活一小会儿，
// 立刻 rmSync 会因为文件被占用而**静默失败**（原来就一个 try/catch 包着），
// 结果每次跑集成测试都在 TEMP 里留下一个 ~40 MB 的 profile 目录。
const rmTreeSync = (d) => {
  for (let i = 0; i < 8; i++) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
    if (!fs.existsSync(d)) return true;
    sleepSync(250);
  }
  return false;
};
let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  [√] ${name}`);
  } else {
    fails.push(name + (extra ? ` —— ${extra}` : ''));
    console.log(`  [×] ${name}${extra ? ' —— ' + extra : ''}`);
  }
};

const BROWSERS = [
  process.env.GALE_TEST_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
].filter(Boolean);
const browser = BROWSERS.find((p) => fs.existsSync(p));
if (!browser) {
  console.error('没有找到可用的 Chromium 内核浏览器（Edge / Chrome）。');
  process.exit(2);
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gale-it-'));
const svcPort = await freePort();
const cdpPort = await freePort();
const httpPort = await freePort();

// ---------------------------------------------------------------- 隔离的服务副本
for (const d of ['core', 'ui']) fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'VERSION'), path.join(tmp, 'VERSION'));
fs.writeFileSync(
  path.join(tmp, 'config.json'),
  JSON.stringify(
    {
      provider: 'cache-only',
      // 下面几项故意塞进"已移除的节点 / 已废弃的字段"，用来验证配置迁移
      fallback: ['bing', 'deepl'],
      disabledSources: ['bing', 'mymemory'],
      quality: { mode: 'fast', voters: ['mymemory', 'openai'], consistency: true },
      mymemoryEmail: 'someone@example.com',
      target: 'zh-CN',
      source: 'auto',
      proxy: '',
      galePath: path.join(tmp, 'no-such-gale.exe'),
      autoLaunchGale: false, // 关键：不要在测试时启动 Gale
      servicePort: svcPort,
      cdpPort,
      fuzzyReuse: true,
    },
    null,
    2,
  ),
);

const svc = spawn(process.execPath, [path.join(tmp, 'core', 'server.mjs')], { cwd: tmp, stdio: 'ignore', windowsHide: true });

let svcUp = false;
async function waitService(timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(`http://127.0.0.1:${svcPort}/api/status`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch {}
    await sleep(300);
  }
  return false;
}

// ---------------------------------------------------------------- 夹具页面
const fixturePath = path.join(ROOT, 'test', 'fixtures', 'browse.html');
const fixtureHtml = fs.existsSync(fixturePath)
  ? fs.readFileSync(fixturePath, 'utf8')
  : '<!doctype html><html><head><meta name="gale-route" content="/browse"></head><body><h2>Installation</h2><p>Extract the archive into your game folder.</p></body></html>';
const pageServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(fixtureHtml);
});

let ws = null;
let edge = null;
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gale-it-edge-'));
const cleanup = () => {
  try {
    ws?.close();
  } catch {}
  try {
    pageServer.close();
  } catch {}
  try {
    edge?.kill();
  } catch {}
  try {
    svc.kill();
  } catch {}
  for (const d of [userDataDir, tmp]) rmTreeSync(d);
};

function connect(url) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(url);
    s.addEventListener('open', () => resolve(s));
    s.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
  });
}
function makeClient(sock) {
  let nextId = 1;
  const pending = new Map();
  const exceptions = [];
  sock.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails;
      exceptions.push(d?.exception?.description || d?.text || 'unknown');
    }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  });
  const send = (method, params = {}, timeout = 20000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeout);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      sock.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  return { send, evaluate, exceptions };
}

async function waitForCdp(timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        const page = (await r.json()).find((t) => t.type === 'page');
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch {}
    await sleep(400);
  }
  throw new Error('等待无头浏览器调试端口超时');
}

console.log('\n集成冒烟测试\n');

try {
  console.log('一、服务与 API');
  svcUp = await waitService();
  ok('服务启动并响应 /api/status', svcUp);
  if (!svcUp) throw new Error('服务未能启动');

  const j = async (p) => (await fetch(`http://127.0.0.1:${svcPort}${p}`)).json();
  const post = async (p, body) => (await fetch(`http://127.0.0.1:${svcPort}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();

  const status = await j('/api/status');
  ok('/api/status 带实际 cdpPort', Number.isInteger(status.cdpPort), JSON.stringify(status.cdpPort));
  ok('/api/status 带 library 规模', typeof status.library?.size === 'number');
  ok('/api/status 带 pageHealth 字段', 'pageHealth' in status);
  ok('/api/status 带代码指纹 buildId（启动器靠它判断服务是否旧代码）', typeof status.buildId === 'string' && status.buildId.length > 0, String(status.buildId));
  ok('/api/status 带端口记忆 cdpPortRemembered', Number.isInteger(status.cdpPortRemembered), String(status.cdpPortRemembered));
  ok('端口记忆已落盘 data/ports.json', (() => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'ports.json'), 'utf8'));
      return Number.isInteger(m.lastPort) && m.lastPort > 0 && Number.isInteger(m.configuredPort);
    } catch {
      return false;
    }
  })());
  ok('runtime.json 记录了 buildId 与 cdpPort', (() => {
    try {
      const rt = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'runtime.json'), 'utf8'));
      return !!rt.buildId && Number.isInteger(rt.cdpPort);
    } catch {
      return false;
    }
  })());

  const health = await j('/api/health');
  ok('/api/health 可用且未降级（无 Gale 时应为 null 而非误报）', health.ok === true && health.degraded === false, JSON.stringify(health.degraded));

  const cc = await j('/api/client-config');
  ok('/api/client-config 下发 fuzzyReuse', cc.config.fuzzyReuse !== false);
  ok('/api/client-config 有可用节点', Array.isArray(cc.providers) && cc.providers.length > 0, `${cc.providers?.length}`);
  const ids = (cc.providers || []).map((p) => p.id);
  ok('节点列表里已无 bing / mymemory', !ids.includes('bing') && !ids.includes('mymemory'), ids.join(','));
  ok('需要密钥的节点带 fields 元数据（DeepL 1 项 / OpenAI 3 项）', cc.providers.find((p) => p.id === 'deepl')?.fields?.length === 1 && cc.providers.find((p) => p.id === 'openai')?.fields?.length === 3);

  console.log('\n一之二、配置迁移（已移除节点的残留会被清掉）');
  const migCfg = await j('/api/config');
  ok('fallback 里清掉 bing', JSON.stringify(migCfg.config.fallback) === '["deepl"]', JSON.stringify(migCfg.config.fallback));
  ok('disabledSources 里清掉失效项', Array.isArray(migCfg.config.disabledSources) && migCfg.config.disabledSources.length === 0, JSON.stringify(migCfg.config.disabledSources));
  ok('quality.voters 里清掉 mymemory', JSON.stringify(migCfg.config.quality?.voters) === '["openai"]', JSON.stringify(migCfg.config.quality?.voters));
  ok('删除已废弃字段 mymemoryEmail', !('mymemoryEmail' in migCfg.config));

  // 已移除的三个官方 API 节点（腾讯云 TMT / 有道智云 / Google Cloud）的密钥字段也要被清掉，
  // 否则旧配置里会留下一堆没人再读的悬空字段。这里**真的写进去**再验证被清理。
  const legacyPatch = {
    tencentCloudSecretId: 'AKIDxxxx',
    tencentCloudSecretKey: 'secretxxxx',
    tencentCloudRegion: 'ap-guangzhou',
    youdaoAppKey: 'ak',
    youdaoAppSecret: 'as',
    googleCloudKey: 'AIzaxxxx',
    googleCloudProject: 'proj',
  };
  const legacyPost = await post('/api/config', legacyPatch);
  const legacyLeft = Object.keys(legacyPatch).filter((k) => k in legacyPost.config);
  ok('写入已移除官方 API 节点的密钥 → 立刻被清理', legacyLeft.length === 0, legacyLeft.join(', '));
  ok('清理时给出 migrationNotes', (legacyPost.migrationNotes || []).some((n) => /已废弃|废弃的配置项/.test(n)), JSON.stringify(legacyPost.migrationNotes));
  const migNodes = ((await j('/api/client-config')).providers || []).map((p) => p.id);
  ok('节点列表里没有 tencent-cloud / youdao-zhiyun / google-cloud', !migNodes.some((id) => ['tencent-cloud', 'youdao-zhiyun', 'google-cloud'].includes(id)), JSON.stringify(migNodes));
  ok('需要密钥的节点只剩 deepl / libretranslate / openai', JSON.stringify(migNodes.filter((id) => ['openai', 'deepl', 'libretranslate', 'tencent-cloud', 'youdao-zhiyun', 'google-cloud'].includes(id)).sort()) === '["deepl","libretranslate","openai"]', JSON.stringify(migNodes));

  console.log('\n一之二之补充、节点顺序与新增的本地大模型节点');
  ok('内置引擎排在翻译源列表第一位（置顶）', migNodes[0] === 'builtin', JSON.stringify(migNodes));
  ok('列表末尾仍是「仅用缓存」', migNodes[migNodes.length - 1] === 'cache-only', JSON.stringify(migNodes));
  ok('包含本地大模型节点 local-llm', migNodes.includes('local-llm'), JSON.stringify(migNodes));
  const ccForNodes = await j('/api/client-config');
  const llmNode = (ccForNodes.providers || []).find((p) => p.id === 'local-llm');
  ok('local-llm 声明了 3 个参数（地址 / 模型 / 可选密钥）', !!llmNode && (llmNode.fields || []).length === 3, JSON.stringify(llmNode && llmNode.fields));
  ok('local-llm 默认地址指向本机 Ollama', JSON.stringify((llmNode && llmNode.fields) || []).includes('127.0.0.1:11434'), JSON.stringify(llmNode && llmNode.fields));
  const builtinNode = (ccForNodes.providers || []).find((p) => p.id === 'builtin');
  ok('builtin 节点也在列表里且不需要密钥', !!builtinNode && (builtinNode.fields || []).length === 0, JSON.stringify(builtinNode && builtinNode.fields));

  console.log('\n一之二之补充二、内置引擎接口（未连接 Gale 时不能误报）');
  const leDown = await j('/api/local-engine');
  ok('未连接时明确标记 bridgeDown（不再混同于"浏览器不支持"）', leDown.bridgeDown === true, JSON.stringify(leDown));
  ok('未连接时给出可读原因', typeof leDown.reason === 'string' && leDown.reason.length > 0, leDown.reason);
  ok('未连接时带 galeRunning 字段供界面区分"Gale 没开"和"页面没挂上"', 'galeRunning' in leDown, JSON.stringify(leDown.galeRunning));
  const prepDown = await post('/api/local-engine/prepare', { source: 'en', target: 'zh-CN' });
  ok('未连接时 prepare 直接报错，而不是假装 started', prepDown.ok === false && prepDown.started === false, JSON.stringify(prepDown));
  const resetDown = await post('/api/local-engine/reset', {});
  ok('未连接时 reset 给出明确错误', resetDown.ok === false && !!resetDown.error, JSON.stringify(resetDown));

  console.log('\n一之二之补充三、语言包扫描与删除（破坏性操作必须确认）');
  const packList = await j('/api/local-engine/pack');
  ok('/api/local-engine/pack 可用且返回 dirs 数组', packList.ok === true && Array.isArray(packList.dirs), JSON.stringify(packList).slice(0, 200));
  ok('扫描结果带 totalBytes', typeof packList.totalBytes === 'number' && packList.totalBytes >= 0, String(packList.totalBytes));
  ok('扫描结果带 workerProfile（界面要说清"其中语言包 X MB"）', !!packList.workerProfile && typeof packList.workerProfile.bytes === 'number' && typeof packList.workerProfile.packBytes === 'number' && typeof packList.workerProfile.packInstalled === 'boolean', JSON.stringify(packList.workerProfile));
  ok('扫描结果带 seed（随包自带语言包：ready/path/bytes/runtime）', !!packList.seed && typeof packList.seed.ready === 'boolean' && typeof packList.seed.path === 'string' && typeof packList.seed.bytes === 'number' && typeof packList.seed.runtime === 'boolean', JSON.stringify(packList.seed));
  ok('扫描结果带 edge（本机有没有 Edge，没装时界面要给出替代方案）', !!packList.edge && typeof packList.edge.available === 'boolean' && typeof packList.edge.path === 'string', JSON.stringify(packList.edge));
  const delNoConfirm = await post('/api/local-engine/pack/delete', {});
  ok('不带 confirm 时拒绝删除（返回 400）', delNoConfirm.ok === false && /确认/.test(delNoConfirm.error || ''), JSON.stringify(delNoConfirm));

  // —— 自带语言包（data/edge-pack）单独一档：能删、但只删它自己 ——
  // 隔离环境只复制了 core/ 与 ui/，本来没有 seed，所以先造一份假的再走删除通路。
  const fakeSeed = path.join(tmp, 'data', 'edge-pack');
  const fakePack = path.join(fakeSeed, 'EdgeTranslateKitLanguagePack', 'en-zh', '2026.4.6.1');
  fs.mkdirSync(fakePack, { recursive: true });
  fs.writeFileSync(path.join(fakePack, 'manifest.json'), '{}');
  fs.mkdirSync(path.join(fakeSeed, 'EdgeLLMRuntime', '2026.10.2.1'), { recursive: true });
  const seedSeen = await j('/api/local-engine/pack');
  ok('自带语言包被识别成 seed.ready（含模型运行时）', seedSeen.seed.ready === true && seedSeen.seed.runtime === true && seedSeen.seed.bytes > 0, JSON.stringify(seedSeen.seed));
  const delSeed = await post('/api/local-engine/pack/delete', { confirm: true, scope: 'seed' });
  ok(
    'scope=seed 只删自带那份（removed / freedBytes / seedDeleted 齐全）',
    delSeed.ok === true && delSeed.scope === 'seed' && delSeed.seedDeleted === true && delSeed.removed.length === 1 && delSeed.freedBytes > 0,
    JSON.stringify(delSeed),
  );
  ok('删掉的确实是 data/edge-pack，不是 Edge 的 profile', !fs.existsSync(fakeSeed), String(delSeed.removed[0]));
  const seedGone = await j('/api/local-engine/pack');
  ok('删完之后 seed 回到 ready:false', seedGone.seed.ready === false, JSON.stringify(seedGone.seed));
  const delSeedAgain = await post('/api/local-engine/pack/delete', { confirm: true, scope: 'seed' });
  ok(
    '没有自带语言包时如实返回 note（不报错、不假装删掉了）',
    delSeedAgain.ok === true && delSeedAgain.removed.length === 0 && /没有找到自带语言包/.test(delSeedAgain.note || ''),
    JSON.stringify(delSeedAgain),
  );

  console.log('\n一之二之补充四、仅本地翻译（禁用联网）');
  // —— 纯函数：什么算"本地节点" ——
  ok('内置引擎 / 仅用缓存恒为本地', isProviderLocal('builtin', {}) === true && isProviderLocal('cache-only', {}) === true);
  ok('DeepL / OpenAI 恒为远程', ['deepl', 'openai'].every((id) => isProviderLocal(id, {}) === false));
  ok('本机 Ollama 地址的 local-llm 算本地', isProviderLocal('local-llm', { localLlmBaseUrl: 'http://127.0.0.1:11434/v1' }) === true);
  ok('指向局域网/公网的 local-llm 不算本地（只认回环）', isProviderLocal('local-llm', { localLlmBaseUrl: 'http://192.168.1.9:11434/v1' }) === false);
  ok('localhost / [::1] 的 LibreTranslate 算本地', isProviderLocal('libretranslate', { libreUrl: 'http://localhost:5000' }) === true && isProviderLocal('libretranslate', { libreUrl: 'http://[::1]:5000' }) === true);
  ok('自定义节点的地址决定它算不算本地', isProviderLocal('custom:abc', { customSources: [{ id: 'abc', url: 'http://127.0.0.1:8080/x' }] }) === true && isProviderLocal('custom:abc', { customSources: [{ id: 'abc', url: 'https://api.example.com/x' }] }) === false);
  ok('filterLocalProviders 只留下本地的那些（腾讯/有道/Google/OpenAI 都不算）', JSON.stringify(filterLocalProviders(['builtin', 'libretranslate', 'local-llm', 'tencent', 'youdao', 'google', 'openai'], {})) === '["builtin","libretranslate","local-llm"]', JSON.stringify(filterLocalProviders(['builtin', 'libretranslate', 'local-llm', 'tencent', 'youdao', 'google', 'openai'], {})));
  ok('回环判定认得 127.x / localhost / ::1', ['127.0.0.1', '127.5.5.5', 'localhost', 'LOCALHOST', '::1', '[::1]'].every((h) => isLoopbackHost(h) === true));
  ok('回环判定不误伤公网域名', ['transmart.qq.com', 'api.openai.com', '192.168.1.9', ''].every((h) => isLoopbackHost(h) === false));

  // —— 网闸本身：真的拦得住，而且本机地址照样放行 ——
  setOfflineOnly(true);
  let gateErr = '';
  try {
    await request('https://transmart.qq.com/api/imt', { method: 'POST', body: '{}' });
  } catch (e) {
    gateErr = (e && e.message) || String(e);
  }
  ok('开着网闸时对外请求直接被拦下（连 DNS 都不做）', /仅本地模式已开启：已拦截对 transmart\.qq\.com/.test(gateErr), gateErr);
  ok('isOfflineOnly() 反映开关状态', isOfflineOnly() === true);
  let loopErr = '';
  try {
    await request('http://127.0.0.1:1/nope', { method: 'GET' });
  } catch (e) {
    loopErr = (e && e.message) || String(e);
  }
  ok('本机地址不走网闸（失败原因是连不上，而不是被拦截）', !/仅本地模式/.test(loopErr), loopErr);
  setOfflineOnly(false);
  ok('关掉网闸后不再拦截', isOfflineOnly() === false);

  // —— 服务侧：状态过滤 + 配置往返 ——
  const stOff0 = await j('/api/status');
  ok('/api/status 带 offlineOnly 与 offlineBlocked', stOff0.offlineOnly === false && Array.isArray(stOff0.offlineBlocked), JSON.stringify({ offlineOnly: stOff0.offlineOnly, offlineBlocked: stOff0.offlineBlocked }));
  ok('没开仅本地模式时 offlineBlocked 是空的（没停用任何节点）', stOff0.offlineBlocked.length === 0, JSON.stringify(stOff0.offlineBlocked));
  const offPost = await post('/api/config', { offlineOnly: true });
  ok('POST /api/config 能打开仅本地模式', offPost.config.offlineOnly === true, JSON.stringify(offPost.config.offlineOnly));
  const stOff1 = await j('/api/status');
  ok('开启后 usableNodes 里不再有在线节点', ['tencent', 'youdao', 'google', 'deepl', 'openai'].every((id) => !stOff1.usableNodes.includes(id)), JSON.stringify(stOff1.usableNodes));
  ok('开启后备用链里也不再有在线节点', ['tencent', 'youdao', 'google', 'deepl', 'openai'].every((id) => !stOff1.chainNodes.includes(id)), JSON.stringify(stOff1.chainNodes));
  ok('开启后 offlineBlocked 列出被停用的在线节点（界面据此置灰）', ['tencent', 'youdao', 'google', 'deepl', 'openai'].every((id) => stOff1.offlineBlocked.includes(id)), JSON.stringify(stOff1.offlineBlocked));
  // DeepL 是"需要密钥"的节点：先放一个假密钥，才能走到网闸那一层（否则先报「未配置 DeepL API Key」）
  await post('/api/config', { deeplKey: 'dummy:fx' });
  const tpOff = await post('/api/test-provider', { provider: 'deepl' });
  ok('点名测试 DeepL 节点 → 被网闸拦下且错误可读', tpOff.ok === false && /仅本地模式已开启/.test(String(tpOff.error || '')), JSON.stringify(tpOff).slice(0, 220));
  await post('/api/config', { deeplKey: '' });
  const cfgOff = await j('/api/config');
  ok('offlineOnly 落盘（重启后还在）', cfgOff.config.offlineOnly === true);
  const discPost = await post('/api/config', { offlineOnly: false });
  ok('能再关掉', discPost.config.offlineOnly === false);
  const stOff2 = await j('/api/status');
  ok('关掉后在线节点恢复可用', stOff2.usableNodes.some((id) => ['deepl', 'openai'].includes(id)), JSON.stringify(stOff2.usableNodes));

  console.log('\n一之三、限流冷却');
  ok('/api/status 带 rateLimited 字段', Array.isArray(status.rateLimited), JSON.stringify(status.rateLimited));
  const rlClear = await post('/api/rate-limit/clear', {});
  ok('/api/rate-limit/clear 可用（手动解除冷却）', rlClear.ok === true && Array.isArray(rlClear.rateLimited), JSON.stringify(rlClear));

  const langs = await j('/api/langs');
  ok('/api/langs 返回语言列表', Array.isArray(langs.langs) && langs.langs.length >= 30, `${langs.langs?.length}`);

  const lib = await j('/api/library/stats');
  ok('/api/library/stats 可用', typeof lib.size === 'number');

  const cov = await j('/api/coverage');
  ok('/api/coverage 在未挂载时优雅返回 ok:false', cov.ok === false, JSON.stringify(cov.ok));

  // 写配置：验证 fuzzyReuse 能被关掉并持久化
  await post('/api/config', { fuzzyReuse: false });
  const after = await j('/api/config');
  ok('POST /api/config 能改 fuzzyReuse', after.config.fuzzyReuse === false);
  await post('/api/config', { fuzzyReuse: true });

  const migPost = await post('/api/config', { provider: 'mymemory' });
  ok('POST 一个已移除的节点 → 自动回落到内置引擎', migPost.config.provider === 'builtin', migPost.config.provider);
  ok('迁移会返回说明 migrationNotes', Array.isArray(migPost.migrationNotes) && migPost.migrationNotes.length > 0, JSON.stringify(migPost.migrationNotes));
  await post('/api/config', { provider: 'cache-only' });

  console.log('\n二、页面注入与页内抽屉');
  await new Promise((r) => pageServer.listen(httpPort, '127.0.0.1', r));
  edge = spawn(
    browser,
    ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--remote-allow-origins=*', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`, 'about:blank'],
    { stdio: 'ignore', windowsHide: true },
  );
  const wsUrl = await waitForCdp();
  ws = await connect(wsUrl);
  const { send, evaluate, exceptions } = makeClient(ws);
  await send('Runtime.enable');
  await send('Page.enable');

  // 前导要和**服务端真实下发的那份**保持一致（含 uiLang 与 build）：
  // 页内脚本用 build 做幂等判断，形状不一致就会被当成"另一份代码"而重复建一遍。
  const prelude = `window.__GALE_TR__ = ${JSON.stringify({ api: `http://127.0.0.1:${svcPort}`, debug: false, uiLang: 'zh-CN', build: status.buildId })};`;
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `${prelude}\n${PAGE_SCRIPT}` });
  await send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/browse` });

  let ready = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    await sleep(200);
    try {
      ready = await evaluate('document.readyState === "complete" && !!(window.__galeTrans && window.__galeTrans.dryRun)');
    } catch {}
    if (ready) break;
  }
  ok('注入成功（window.__galeTrans 就绪）', ready);
  if (!ready) throw new Error('注入失败');

  await sleep(1500);
  ok('注入引擎为真实模式（dry=false，已建悬浮条）', (await evaluate("document.querySelectorAll('#gale-trans-host').length")) === 1);
  ok('页内抽屉宿主已创建', (await evaluate("document.querySelectorAll('#gale-drawer-host').length")) === 1);
  ok('抽屉 API 已挂上 window.__galeDrawer', await evaluate('!!(window.__galeDrawer && window.__galeDrawer.toggle)'));

  // 点悬浮条的 ⚙，应该打开抽屉（而不是去开浏览器设置页）
  const opened = await evaluate(`(() => {
    const host = document.querySelector('#gale-trans-host');
    const gear = host.shadowRoot.getElementById('gear');
    if (!gear) return 'no-gear';
    gear.click();
    const d = document.querySelector('#gale-drawer-host');
    return d.shadowRoot.getElementById('host').classList.contains('open');
  })()`);
  ok('点悬浮条 ⚙ 打开页内抽屉', opened === true, String(opened));

  // 抽屉里的状态区应通过 HTTP 拿到真实服务信息（跨域 CORS 通）
  await sleep(2500);
  const drawerStatus = await evaluate(`(() => {
    const d = document.querySelector('#gale-drawer-host');
    const sr = d.shadowRoot;
    return JSON.stringify({
      sections: sr.querySelectorAll('section').length,
      status: (sr.getElementById('status').textContent || '').trim(),
      ver: (sr.getElementById('ver').textContent || '').trim(),
      providers: sr.getElementById('provider').options.length,
      langs: sr.getElementById('target').options.length,
      quality: sr.getElementById('quality').value,
      fuzzy: sr.getElementById('fuzzyReuse').value,
      glossaryLines: sr.getElementById('glossary').value.split('\\n').filter(Boolean).length,
    });
  })()`);
  const ds = JSON.parse(drawerStatus);
  ok('抽屉渲染出足够的分区', ds.sections >= 7, `${ds.sections}`);
  ok('抽屉状态区拿到了真实服务数据（含端口）', /端口/.test(ds.status), ds.status.slice(0, 120));
  ok('抽屉显示版本号', /^v?\d/.test(ds.ver), ds.ver);
  ok('抽屉填充了翻译节点下拉', ds.providers > 0, `${ds.providers}`);
  ok('抽屉填充了语言下拉', ds.langs >= 30, `${ds.langs}`);
  ok('抽屉回显翻译模式', ds.quality === 'fast' || ds.quality === 'best', ds.quality);
  ok('抽屉回显 fuzzyReuse', ds.fuzzy === 'true' || ds.fuzzy === 'false', ds.fuzzy);
  ok('抽屉回显术语表', ds.glossaryLines > 0, `${ds.glossaryLines}`);

  // 覆盖率体检按钮：点一下不应抛异常（无 Gale 时会显示失败提示）
  const healthClicked = await evaluate(`(() => {
    const sr = document.querySelector('#gale-drawer-host').shadowRoot;
    sr.getElementById('health').click();
    return true;
  })()`);
  await sleep(1500);
  const healthOut = await evaluate("document.querySelector('#gale-drawer-host').shadowRoot.getElementById('healthOut').textContent.trim()");
  ok('抽屉体检按钮可点击且给出结果/失败提示', healthClicked === true && healthOut.length > 0, healthOut.slice(0, 80));

  // 关闭抽屉
  const closed = await evaluate(`(() => {
    const sr = document.querySelector('#gale-drawer-host').shadowRoot;
    sr.getElementById('close').click();
    return !sr.getElementById('host').classList.contains('open');
  })()`);
  ok('抽屉可关闭', closed === true);

  console.log('\n二之二、悬浮条展开方向（向左 / 靠边自动翻转）');
  const pillDir = JSON.parse(
    await evaluate(`(() => {
      const sr = document.querySelector('#gale-trans-host').shadowRoot;
      const bar = sr.getElementById('bar');
      const exp = sr.getElementById('expand');
      sr.getElementById('more').click();
      const er = exp.getBoundingClientRect();
      const br = bar.getBoundingClientRect();
      return JSON.stringify({
        shown: !exp.classList.contains('hidden'),
        expLeft: Math.round(er.left), expRight: Math.round(er.right),
        barLeft: Math.round(br.left), flip: bar.classList.contains('flip-right'),
      });
    })()`),
  );
  ok('点 ⋯ 能展开', pillDir.shown === true);
  ok('展开内容在悬浮条左侧（不再往右顶出屏幕）', pillDir.expRight <= pillDir.barLeft + 2, JSON.stringify(pillDir));
  ok('展开内容没有超出屏幕左边', pillDir.expLeft >= 0, JSON.stringify(pillDir));

  const pillFlip = JSON.parse(
    await evaluate(`(() => {
      const host = document.querySelector('#gale-trans-host');
      host.style.right = 'auto'; host.style.bottom = 'auto';
      host.style.left = '4px'; host.style.top = '120px';
      const sr = host.shadowRoot;
      const bar = sr.getElementById('bar');
      const exp = sr.getElementById('expand');
      sr.getElementById('more').click();  // 收起
      sr.getElementById('more').click();  // 再展开 → 触发翻转判断
      const er = exp.getBoundingClientRect();
      const br = bar.getBoundingClientRect();
      return JSON.stringify({ flip: bar.classList.contains('flip-right'), expLeft: Math.round(er.left), barRight: Math.round(br.right), vw: window.innerWidth });
    })()`),
  );
  ok('悬浮条贴左边缘时自动翻到右侧', pillFlip.flip === true, JSON.stringify(pillFlip));
  ok('翻转后仍在屏幕内', pillFlip.expLeft >= pillFlip.barRight - 2 && pillFlip.expLeft < pillFlip.vw, JSON.stringify(pillFlip));

  console.log('\n二之三、抽屉补齐的设置项与节点参数');
  await evaluate('window.__galeDrawer.open()');
  await sleep(2500);
  const drawerNew = JSON.parse(
    await evaluate(`(() => {
      const sr = document.querySelector('#gale-drawer-host').shadowRoot;
      const ids = ['customBox','polishBox','compareBox','libBox','sysBox','logBox','fallback','proxy','postReplace','qVoters','minLen','srcFields','srcFieldsGrid','save','discard','uiLang','providerNote','testProvider','health','clearCache','libExport','libImport','sysOn','autoOn','localBox','localState','localProgWrap','localBar','localBarFill','localProgText','localDiag','enableLocal','recheckLocal','resetLocal','localPackRow','localPackInfo','scanPack','delPack'];
      return JSON.stringify({
        missing: ids.filter((i) => !sr.getElementById(i)),
        sections: sr.querySelectorAll('section').length,
        details: sr.querySelectorAll('details').length,
      });
    })()`),
  );
  ok('抽屉新增项全部存在', drawerNew.missing.length === 0, '缺少：' + drawerNew.missing.join(','));
  ok('抽屉分区与折叠组数量足够', drawerNew.sections >= 8 && drawerNew.details >= 6, JSON.stringify(drawerNew));

  // 切到需要密钥的节点，抽屉应自动展开参数输入框
  const fieldsOf = async (pid) => {
    await fetch(`http://127.0.0.1:${svcPort}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: pid }) });
    await evaluate(`document.querySelector('#gale-drawer-host').shadowRoot.getElementById('refresh').click()`);
    await sleep(1200);
    return JSON.parse(
      await evaluate(`(() => {
        const sr = document.querySelector('#gale-drawer-host').shadowRoot;
        const box = sr.getElementById('srcFields');
        const inputs = [...sr.getElementById('srcFieldsGrid').querySelectorAll('input[data-key]')];
        return JSON.stringify({ visible: box.style.display !== 'none', keys: inputs.map((i) => i.dataset.key), types: inputs.map((i) => i.type), title: sr.getElementById('srcFieldsTitle').textContent });
      })()`),
    );
  };

  const fDeepl = await fieldsOf('deepl');
  ok('选 DeepL → 抽屉出现密钥输入框', fDeepl.visible && fDeepl.keys.join(',') === 'deeplKey' && fDeepl.types[0] === 'password', JSON.stringify(fDeepl));

  const fOpenai = await fieldsOf('openai');
  ok('选 OpenAI 兼容 → 抽屉出现接口地址 / Key / 模型三项', fOpenai.visible && fOpenai.keys.join(',') === 'openaiBaseUrl,openaiKey,openaiModel', JSON.stringify(fOpenai));

  const fNoKey = await fieldsOf('cache-only');
  ok('选无需密钥的节点 → 参数区自动隐藏', fNoKey.visible === false, JSON.stringify(fNoKey));

  await fetch(`http://127.0.0.1:${svcPort}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'cache-only' }) });

  console.log('\n二之四、抽屉延迟保存（改选项不再自动刷新）');
  await evaluate('window.__loadCount = (window.__loadCount || 0) + 1');
  await evaluate('window.__galeDrawer.open()');
  await sleep(2500);

  const dirty1 = JSON.parse(
    await evaluate(`(() => {
      const sr = document.querySelector('#gale-drawer-host').shadowRoot;
      const sel = sr.getElementById('quality');
      sel.value = 'best';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return JSON.stringify({
        dirty: window.__galeDrawer.isDirty(),
        saveLabel: (sr.getElementById('save').textContent || '').trim(),
        discardVisible: sr.getElementById('discard').style.display !== 'none',
        drawerOpen: sr.getElementById('host').classList.contains('open'),
        loadCount: window.__loadCount,
      });
    })()`),
  );
  ok('改选项后标记为未保存', dirty1.dirty === true, JSON.stringify(dirty1));
  ok('保存按钮显示未保存项数', /1/.test(dirty1.saveLabel), dirty1.saveLabel);
  ok('出现「还原」按钮', dirty1.discardVisible === true);
  ok('改选项后抽屉仍然开着（不再自动刷新）', dirty1.drawerOpen === true);
  ok('改选项后页面没有重新加载', dirty1.loadCount === 1, String(dirty1.loadCount));

  const dirty2 = await evaluate(`(() => {
    const sr = document.querySelector('#gale-drawer-host').shadowRoot;
    const sel = sr.getElementById('fuzzyReuse');
    sel.value = 'false';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return (sr.getElementById('save').textContent || '').trim();
  })()`);
  ok('可以继续改其他选项并累加', /2/.test(dirty2), dirty2);

  const saved = JSON.parse(
    await evaluate(`(async () => {
      const sr = document.querySelector('#gale-drawer-host').shadowRoot;
      sr.getElementById('save').click();
      await new Promise(r => setTimeout(r, 4000));
      return JSON.stringify({
        drawerOpen: sr.getElementById('host').classList.contains('open'),
        loadCount: window.__loadCount,
        dirty: window.__galeDrawer.isDirty(),
        saveLabel: (sr.getElementById('save').textContent || '').trim(),
      });
    })()`),
  );
  ok('保存后抽屉仍然开着', saved.drawerOpen === true, JSON.stringify(saved));
  ok('保存后页面没有重新加载', saved.loadCount === 1, String(saved.loadCount));
  ok('保存后未保存状态清零', saved.dirty === false && !/未保存/.test(saved.saveLabel), JSON.stringify(saved));

  const afterSave = await j('/api/config');
  ok(
    '保存确实写进了服务端配置',
    afterSave.config.quality?.mode === 'best' && afterSave.config.fuzzyReuse === false,
    JSON.stringify({ mode: afterSave.config.quality?.mode, fuzzy: afterSave.config.fuzzyReuse }),
  );

  const applyRes = await (await fetch(`http://127.0.0.1:${svcPort}/api/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  ok('/api/apply 能对页面做软应用（不刷新）', applyRes.ok === true, JSON.stringify(applyRes));

  // 还原按钮：先改成一个"和已保存值不同"的值（已保存是 best），再点还原
  const reverted = JSON.parse(
    await evaluate(`(async () => {
      const sr = document.querySelector('#gale-drawer-host').shadowRoot;
      const sel = sr.getElementById('quality');
      sel.value = 'fast';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      const before = (sr.getElementById('save').textContent || '').trim();
      sr.getElementById('discard').click();
      await new Promise(r => setTimeout(r, 1800));
      return JSON.stringify({
        before,
        after: (sr.getElementById('save').textContent || '').trim(),
        value: sr.getElementById('quality').value,
        loadCount: window.__loadCount,
      });
    })()`),
  );
  ok('「还原」能丢弃未保存的改动', reverted.value === 'best' && !/未保存/.test(reverted.after), JSON.stringify(reverted));
  ok('「还原」不会刷新页面', reverted.loadCount === 1, String(reverted.loadCount));

  // 提示条位置：必须贴在底部按钮栏**上方**，不能盖住「保存设置 / 还原 / 重新注入」
  const flashGeom = JSON.parse(
    await evaluate(`(async () => {
      const sr = document.querySelector('#gale-drawer-host').shadowRoot;
      sr.getElementById('discard').click();
      await new Promise(r => setTimeout(r, 500));
      const f = sr.getElementById('flashOut');
      const ft = sr.querySelector('footer');
      if (!f || !ft) return JSON.stringify({ missing: true, hasFlash: !!f, hasFooter: !!ft });
      const fr = f.getBoundingClientRect(), tr = ft.getBoundingClientRect();
      return JSON.stringify({
        shown: f.style.display !== 'none',
        flashBottom: Math.round(fr.bottom),
        footerTop: Math.round(tr.top),
      });
    })()`),
  );
  ok('提示条出现在底部按钮栏上方（不遮挡按钮）', flashGeom.missing !== true && flashGeom.flashBottom <= flashGeom.footerTop + 1, JSON.stringify(flashGeom));

  await fetch(`http://127.0.0.1:${svcPort}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quality: { mode: 'fast' }, fuzzyReuse: true }) });

  console.log('\n二之五、界面中英切换');
  await fetch(`http://127.0.0.1:${svcPort}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uiLang: 'en' }) });
  const ccEn = await j('/api/client-config');
  ok('uiLang=en 时服务端下发英文节点名', /DeepL|Built-in|Cache|Local LLM/.test(ccEn.providers.map((p) => p.name).join('|')), ccEn.providers.map((p) => p.name).join(' | ').slice(0, 120));
  ok('uiLang=en 时节点参数标签也是英文', ((ccEn.providers.find((p) => p.id === 'openai') || {}).fields || []).some((f) => f.label === 'Endpoint URL'));

  const enDrawer = JSON.parse(
    await evaluate(`(async () => {
      const sr = document.querySelector('#gale-drawer-host').shadowRoot;
      const sel = sr.getElementById('uiLang');
      sel.value = 'en';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 2200));
      sr.getElementById('refresh').click();
      await new Promise(r => setTimeout(r, 1200));
      const t = (id) => (sr.getElementById(id).textContent || '').trim();
      return JSON.stringify({
        save: t('save'),
        headings: [...sr.querySelectorAll('section > h2, details > summary')].map(h => h.textContent.trim()),
        provider: (sr.getElementById('provider').selectedOptions[0] || {}).textContent || '',
        glossaryLabel: (sr.getElementById('glossary').previousElementSibling || {}).textContent || '',
      });
    })()`),
  );
  ok('抽屉切英文：保存按钮变英文', /Save/.test(enDrawer.save), enDrawer.save);
  ok('抽屉切英文：分区标题变英文', enDrawer.headings.some((s) => /^(Status|Providers|Behaviour|Language)/.test(s)), JSON.stringify(enDrawer.headings.slice(0, 8)));
  ok('抽屉切英文：节点名变英文', /DeepL|Built-in|Cache|Local LLM/.test(enDrawer.provider), enDrawer.provider);
  ok('抽屉切英文：表单标签变英文', /Protected terms/.test(enDrawer.glossaryLabel), enDrawer.glossaryLabel);
  ok('抽屉切英文后基本没有残留中文标题', enDrawer.headings.filter((s) => /[\u3400-\u9fff]/.test(s)).length === 0, JSON.stringify(enDrawer.headings.filter((s) => /[\u3400-\u9fff]/.test(s))));

  const zhDrawer = JSON.parse(
    await evaluate(`(async () => {
      const sr = document.querySelector('#gale-drawer-host').shadowRoot;
      const sel = sr.getElementById('uiLang');
      sel.value = 'zh-CN';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 1500));
      return JSON.stringify({
        save: (sr.getElementById('save').textContent || '').trim(),
        provider: (sr.getElementById('provider').selectedOptions[0] || {}).textContent || '',
      });
    })()`),
  );
  ok('切回中文：文案还原', /保存/.test(zhDrawer.save), zhDrawer.save);
  ok('切回中文：节点名还原', /DeepL|内置引擎|仅用缓存|本地大模型/.test(zhDrawer.provider), zhDrawer.provider);

  console.log('\n二之六、内置引擎下载进度（速度换算）');
  // Translator API 只给 0~1 的百分比（拿不到字节数），所以"已下载量 / 速度"是按语言包体积换算的估算值。
  // 这里用确定性的假采样直接验证换算逻辑（真实下载要 200MB，不适合放进冒烟测试）。
  const speed = JSON.parse(
    await evaluate(`(() => {
      const T = window.__galeTrans;
      const MB = 1048576;
      const total = T._localPackBytes;
      const mk = (arr) => ({ samples: arr.map(([t, p]) => ({ t, p })) });
      const now = Date.now();
      return JSON.stringify({
        totalMB: total / MB,
        // 1) 2 秒内从 0.1 涨到 0.3 → 0.2 * 197.5MB / 2s ≈ 19.75 MB/s
        normal: T._localSpeed(mk([[now - 2000, 0.1], [now - 1000, 0.2], [now, 0.3]])),
        // 2) 进度没动 → 0（不能报一个假的非零速度）
        flat: T._localSpeed(mk([[now - 2000, 0.5], [now - 1000, 0.5], [now, 0.5]])),
        // 3) 只有 1 个采样 → 0
        single: T._localSpeed(mk([[now, 0.2]])),
        // 4) 空采样 → 0
        empty: T._localSpeed(mk([])),
        // 5) 窗口裁剪：10 秒前那次慢速不应拖住最近 3 秒的速度
        //    最近 2 秒从 0.5 涨到 0.7 = 0.2*197.5MB/2s ≈ 19.75 MB/s（若算全程则只有 0.02/10s ≈ 0.4 MB/s）
        windowed: T._localSpeed(mk([[now - 10000, 0.48], [now - 2000, 0.5], [now - 1000, 0.6], [now, 0.7]])),
      });
    })()`),
  );
  // _localSpeed 返回**字节/秒**，统一换算成 MB/s 再比
  const toMB = (bps) => bps / 1048576;
  const expectNormal = (0.2 * speed.totalMB) / 2; // 0.2 的进度用 2 秒走完 → 19.75 MB/s
  ok('语言包体积基准是 197.5 MB', Math.abs(speed.totalMB - 197.5) < 0.01, String(speed.totalMB));
  ok(
    '速度换算正确（0.2 进度 / 2 秒 ≈ 19.75 MB/s）',
    Math.abs(toMB(speed.normal) - expectNormal) < 0.05,
    `${toMB(speed.normal).toFixed(2)} MB/s vs ${expectNormal.toFixed(2)} MB/s`,
  );
  ok('进度没变化时不报速度（不编造数字）', speed.flat === 0, String(speed.flat));
  ok('只有一个采样点时不报速度', speed.single === 0, String(speed.single));
  ok('没有采样时不报速度', speed.empty === 0, String(speed.empty));
  ok(
    '速度取最近窗口（不被早期的慢速拖住）',
    Math.abs(toMB(speed.windowed) - expectNormal) < 0.05,
    `${toMB(speed.windowed).toFixed(2)} MB/s vs ${expectNormal.toFixed(2)} MB/s`,
  );

  console.log('\n二之七、内置引擎区块（回归：按钮不能被藏掉）');
  // 曾经的 bug：CDP 没连上时 /api/local-engine 返回 supported:false，
  // 界面据此把「启用内置引擎」按钮 display:none —— 用户看到的就是"显示未下载、又没法下载"。
  const localUi = JSON.parse(
    await evaluate(`(async () => {
      const sr = document.querySelector('#gale-drawer-host').shadowRoot;
      const g = (id) => sr.getElementById(id);
      const sel = g('provider');
      sel.value = 'builtin';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      // 等状态区**真的刷成新结论**：桥刚断时界面会先显示「⚠ 还没连接到 Gale…」（2 秒后自愈重试），
      // 而 #localState 在 provider 不是 builtin 时保留着上一次的旧文案。不判"变了没"就可能读到旧值，
      // 于是这一段等于没测到真正关心的分支。
      const before = (g('localState').textContent || '').trim();
      let state = before;
      for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, 500));
        state = (g('localState').textContent || '').trim();
        if (state && state !== before && !/还没连接到 Gale/.test(state)) break;
      }
      return JSON.stringify({
        state,
        enableDisplay: getComputedStyle(g('enableLocal')).display,
        enableDisabled: !!g('enableLocal').disabled,
        recheckDisplay: getComputedStyle(g('recheckLocal')).display,
        resetDisplay: getComputedStyle(g('resetLocal')).display,
        packRowDisplay: getComputedStyle(g('localPackRow')).display,
        delPackDisplay: getComputedStyle(g('delPack')).display,
        diagText: (g('localDiag').textContent || '').trim(),
      });
    })()`),
  );
  ok('「启用内置引擎」按钮永远不会被藏起来（这就是"无法下载"的根因）', localUi.enableDisplay !== 'none', JSON.stringify(localUi));
  ok('「重新检测」按钮常驻', localUi.recheckDisplay !== 'none', JSON.stringify(localUi));
  ok('「重置引擎」按钮常驻', localUi.resetDisplay !== 'none', JSON.stringify(localUi));
  ok(
    '内置引擎状态文案是明确的（不是空白）',
    /语言包|连接到 Gale|不支持|正在|端侧|无法使用/.test(localUi.state),
    JSON.stringify(localUi.state),
  );
  ok('状态区有诊断信息（语言对 / 错误原因）', localUi.diagText.length > 0, JSON.stringify(localUi.diagText));
  // 回归：曾经的 bug —— `#localPackRow` 藏在 #localBox 里、而且只在"就绪/正在下载"时显示。
  // 环境不提供端侧模型时（WebView2）永远不 ready，于是"删除语言包"100% 够不到；
  // 更糟的是服务端 unusable 时会把 provider 自动切走，整个 #localBox 都会隐藏。
  ok('「查看/删除语言包」入口常驻（不被藏、也不依赖引擎状态）', localUi.packRowDisplay !== 'none' && localUi.delPackDisplay !== 'none', JSON.stringify(localUi));

  // 回归：环境**根本不提供端侧模型**时（Gale 的 WebView2 就是如此，实测 154.0.4258.62 下
  // Translator.availability() 对所有语言对都返回 unavailable），界面以前会落进最后的 else，
  // 谎称"语言包还没下载：首次启用约需下载 200 MB"并放开「启用」按钮 —— 用户点了毫无反应。
  // 本机跑测试的那个 Edge 恰好是 downloadable（真浏览器支持下载），所以这里**用 fetch 打桩**
  // 强制造出 unusable 的响应，保证这条断言在任何机器上都真正被执行到。
  const stubbed = JSON.parse(
    await evaluate(`(async () => {
      const sr = document.querySelector('#gale-drawer-host').shadowRoot;
      const g = (id) => sr.getElementById(id);
      const realFetch = window.fetch;
      const forced = {
        ok: true, supported: true, preparing: null, lastError: '',
        wantKey: 'en>zh', ready: false,
        pairs: { 'en>zh': 'unavailable', 'en>zh-Hant': 'unavailable' },
        env: 'unavailable', unusable: true, bridgeDown: false,
        reason: '当前运行环境不提供端侧翻译模型（Gale 用的 WebView2 就是如此），内置引擎无法使用，请在设置里改用其它翻译节点',
      };
      window.fetch = (u, o) => {
        const s = typeof u === 'string' ? u : ((u && u.url) || '');
        if (/\\/api\\/local-engine(\\?|$)/.test(s)) {
          return Promise.resolve(new Response(JSON.stringify(forced), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }));
        }
        return realFetch(u, o);
      };
      const snap = {};
      try {
        const sel = g('provider');
        sel.value = 'builtin';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        let state = '';
        for (let i = 0; i < 16; i++) {
          await new Promise(r => setTimeout(r, 300));
          state = (g('localState').textContent || '').trim();
          if (/端侧|无法使用/.test(state)) break;
        }
        snap.state = state;
        snap.enableDisabled = !!g('enableLocal').disabled;
        snap.enableDisplay = getComputedStyle(g('enableLocal')).display;
        snap.packRowDisplay = getComputedStyle(g('localPackRow')).display;
        snap.delPackDisplay = getComputedStyle(g('delPack')).display;
        snap.diag = (g('localDiag').textContent || '').trim();
      } finally {
        window.fetch = realFetch; // 打桩必须还原，后面的用例还要用真的接口
      }
      // 让界面回到本机真实状态，别把打桩结果留给下一个用例
      g('recheckLocal').click();
      await new Promise(r => setTimeout(r, 800));
      return JSON.stringify(snap);
    })()`),
  );
  ok('环境不提供端侧模型时：文案如实说明是环境限制（不再谎称"还没下载"）', /端侧|无法使用/.test(stubbed.state), JSON.stringify(stubbed));
  ok('环境不提供端侧模型时：「启用内置引擎」被禁用（不再诱导用户点一个必然失败的按钮）', stubbed.enableDisabled === true && stubbed.enableDisplay !== 'none', JSON.stringify(stubbed));
  ok('环境不提供端侧模型时：「查看/删除语言包」入口依然可达（语言包管理是磁盘操作）', stubbed.packRowDisplay !== 'none' && stubbed.delPackDisplay !== 'none', JSON.stringify(stubbed));

  console.log('\n二之八、重复注入不会拆掉抽屉（幂等）');
  // 曾经的坑：`Page.addScriptToEvaluateOnNewDocument` 是**累加**的（注册几次就执行几遍），
  // 而且 inject.js 的 boot() 会顺手删掉 #gale-drawer-host。两件事凑一起，
  // "重新注入"就会把用户正开着的抽屉拆成空白。
  const reSnap = () =>
    evaluate(`(() => {
      const d = document.querySelector('#gale-drawer-host');
      const sr = d && d.shadowRoot;
      const st = window.__galeDrawer && window.__galeDrawer.stats ? window.__galeDrawer.stats() : {};
      return JSON.stringify({
        hosts: document.querySelectorAll('#gale-drawer-host').length,
        open: !!(window.__galeDrawer && window.__galeDrawer.isOpen()),
        providers: sr ? sr.getElementById('provider').options.length : -1,
        boots: st.boots,
        skipped: st.skipped,
      });
    })()`);
  const beforeRe = JSON.parse(await reSnap());
  const reRes = await post('/api/reinject', { reload: false });
  await sleep(2500);
  const afterRe = JSON.parse(await reSnap());
  ok('重新注入接口调用成功', reRes.ok === true, JSON.stringify(reRes));
  ok('重复注入后抽屉宿主仍然只有一个', afterRe.hosts === 1, JSON.stringify(afterRe));
  ok('重复注入后抽屉仍然开着', afterRe.open === true, JSON.stringify(afterRe));
  ok('重复注入后抽屉内容还在（没被清空）', afterRe.providers > 0, JSON.stringify(afterRe));
  ok('同一份代码重复注入被跳过（不会重建）', afterRe.boots === beforeRe.boots && afterRe.skipped > 0, `${JSON.stringify(beforeRe)} -> ${JSON.stringify(afterRe)}`);

  console.log('\n三、完整设置页（浏览器端）');
  const before = exceptions.length;
  await send('Page.navigate', { url: `http://127.0.0.1:${svcPort}/` });
  let webReady = false;
  const tw = Date.now();
  while (Date.now() - tw < 15000) {
    await sleep(250);
    try {
      webReady = await evaluate('document.readyState === "complete" && !!document.getElementById("fuzzyReuse")');
    } catch {}
    if (webReady) break;
  }
  ok('设置页加载完成', webReady);
  if (webReady) {
    // 回归断言：引擎绝不能注入到插件自己的设置页（否则会把设置页界面当成 Gale 内容翻译）
    ok('设置页没有被注入翻译引擎', (await evaluate('typeof window.__galeTrans')) === 'undefined', String(await evaluate('typeof window.__galeTrans')));
    ok('设置页没有被注入抽屉', (await evaluate('typeof window.__galeDrawer')) === 'undefined');
    await sleep(2500); // 等它自己拉完配置
    const web = JSON.parse(
      await evaluate(`JSON.stringify({
        ver: (document.getElementById('ver').textContent||'').trim(),
        stats: (document.getElementById('stats').textContent||'').trim(),
        fuzzy: document.getElementById('fuzzyReuse').value,
        banner: document.getElementById('healthBanner').style.display,
        glossaryLines: document.getElementById('glossary').value.split('\\n').filter(Boolean).length,
        targetOptions: document.getElementById('target').options.length,
        providerRows: document.getElementById('providers').children.length,
        libState: (document.getElementById('libState').textContent||'').trim(),
        localProgIds: ['localBox','localState','localProgWrap','localBar','localBarFill','localProgText','btnEnableLocal','btnRecheckLocal','btnResetLocal','localDiag','localPackRow','btnScanPack','btnOpenPack','btnDelPack']
          .filter(id => !document.getElementById(id)),
      })`),
    );
    ok('设置页显示版本号 0.1.0', /0\.1\.0/.test(web.ver), web.ver);
    ok('设置页状态区含「模糊复用」统计', /模糊复用/.test(web.stats), web.stats.slice(0, 100));
    ok('设置页回显 fuzzyReuse 开关', web.fuzzy === 'true' || web.fuzzy === 'false', web.fuzzy);
    ok('设置页未误报自检降级横幅', web.banner === 'none', web.banner);
    ok('设置页填充术语表', web.glossaryLines > 0, `${web.glossaryLines}`);
    ok('设置页填充语言下拉', web.targetOptions >= 30, `${web.targetOptions}`);
    ok('设置页渲染翻译节点列表', web.providerRows > 0, `${web.providerRows}`);
    ok('设置页译库概况已填充', web.libState.length > 0, web.libState.slice(0, 60));
    ok('设置页有内置引擎的进度条与管理元素', web.localProgIds.length === 0, web.localProgIds.join(', '));

    const webFields = JSON.parse(
      await evaluate(`(() => {
        CFG.provider = 'openai'; renderProviderFields();
        const box = document.getElementById('srcFields');
        const inputs = [...document.getElementById('srcFieldsGrid').querySelectorAll('input[data-key]')];
        const out = { visible: box.style.display !== 'none', keys: inputs.map(i=>i.dataset.key), types: inputs.map(i=>i.type) };
        CFG.provider = 'cache-only'; renderProviderFields();
        out.hiddenAfter = document.getElementById('srcFields').style.display === 'none';
        return JSON.stringify(out);
      })()`),
    );
    ok('设置页：选需要密钥的节点会展开参数输入框', webFields.visible && webFields.keys.join(',') === 'openaiBaseUrl,openaiKey,openaiModel', JSON.stringify(webFields));
    ok('设置页：密钥框是密码类型', webFields.types.includes('password'), JSON.stringify(webFields.types));
    ok('设置页：换回无需密钥的节点会收起参数区', webFields.hiddenAfter === true);

    // 「打开语言包位置」+「删除语言包」两步确认：只验界面这一链（按钮 → 请求 → 说明行）。
    // 两个都**不真的打到后端**：`pack/open` 会弹资源管理器窗口，`pack/delete` 的 scope:'all' 会去扫
    // 机器上真实的 Gale / Temp 目录（findLanguagePacks 是全局的）——测试里不许有这种副作用。
    // 所以把 fetch 换成一针假响应，同时把请求体抓下来验 scope 参数。
    const packUi = JSON.parse(
      await evaluate(`(async () => {
        const info = () => (document.getElementById('localPackInfo').textContent || '').trim();
        const waitFor = async (pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await new Promise(r => setTimeout(r, 100)); } return pred(); };
        const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
        const sent = [];
        const realFetch = window.fetch;
        window.fetch = async (u, o) => {
          const url = String(u);
          if (url.includes('/api/local-engine/pack/open')) return json({ ok: true, opened: 'D:\\\\fake\\\\data\\\\edge-pack' });
          if (url.includes('/api/local-engine/pack/delete')) {
            sent.push(o && o.body ? String(o.body) : '');
            return json({ ok: true, removed: ['D:\\\\fake\\\\data\\\\edge-pack'], freedBytes: 210532744, failed: 0, scope: 'all', seedDeleted: true });
          }
          return realFetch(u, o);
        };
        const openBtn = document.getElementById('btnOpenPack');
        const delBtn = document.getElementById('btnDelPack');
        const out = { openOnclick: typeof openBtn.onclick, openLabel: (openBtn.textContent || '').trim(), sent };
        openBtn.click();
        await waitFor(() => /已在资源管理器里打开|打开失败/.test(info()), 4000);
        out.afterOpen = info();
        out.delLabel = (delBtn.textContent || '').trim();
        delBtn.click();
        out.armed = await waitFor(() => /再点一次确认删除/.test(delBtn.textContent || ''), 4000);
        out.hint = info();
        if (out.armed) {
          delBtn.click();
          await waitFor(() => /已清理|删除失败|没有找到/.test(info()), 6000);
        }
        out.after = info();
        window.fetch = realFetch;
        return JSON.stringify(out);
      })()`),
    );
    ok('设置页有「打开语言包位置」按钮并绑上了处理器', /打开语言包位置/.test(packUi.openLabel) && packUi.openOnclick === 'function', packUi.openLabel);
    ok('点它会把实际打开的目录写在说明里', /已在资源管理器里打开：D:\\fake/.test(packUi.afterOpen), packUi.afterOpen.slice(0, 140));
    ok('设置页「删除语言包」第一下只进入两步确认', packUi.armed === true, JSON.stringify(packUi).slice(0, 220));
    ok('确认提示改成指向「打开语言包位置」（不再提已撤掉的按钮）', /用旁边的「打开语言包位置」/.test(packUi.hint) && !/删除自带语言包/.test(packUi.hint), packUi.hint.slice(0, 160));
    ok('第二下发的请求带 scope:"all"（连自带那份一起清）', packUi.sent.length === 1 && JSON.parse(packUi.sent[0]).scope === 'all' && JSON.parse(packUi.sent[0]).confirm === true, JSON.stringify(packUi.sent));
    ok('结果行如实报出释放量并按 seedDeleted 选说法', /已清理 1 处，释放 200\.8 MB。（连随包自带的那份也一起删了。）/.test(packUi.after), packUi.after.slice(0, 160));

    const enWeb = JSON.parse(
      await evaluate(`(async () => {
        const sel = document.getElementById('uiLang');
        sel.value = 'en';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 2600));
        const t = (id) => (document.getElementById(id).textContent || '').trim();
        return JSON.stringify({
          save: t('btnSave'),
          headings: [...document.querySelectorAll('.card h2')].map(h => h.textContent.trim()),
          cacheLabels: t('cacheStats'),
        });
      })()`),
    );
    ok('设置页切英文：保存按钮变英文', /Save/.test(enWeb.save), enWeb.save);
    ok('设置页切英文：卡片标题变英文', enWeb.headings.some((s) => /^(Status|Language|Providers|Cache|Usage|Log)/.test(s)), JSON.stringify(enWeb.headings.slice(0, 10)));
    ok('设置页切英文：统计标签变英文', /Entries|Hits/.test(enWeb.cacheLabels), enWeb.cacheLabels.slice(0, 80));
    ok('设置页切英文后基本没有残留中文标题', enWeb.headings.filter((s) => /[\u3400-\u9fff]/.test(s)).length === 0, JSON.stringify(enWeb.headings.filter((s) => /[\u3400-\u9fff]/.test(s))));

    const backZh = await evaluate(`(async () => {
      const sel = document.getElementById('uiLang');
      sel.value = 'zh-CN';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 1200));
      return (document.getElementById('btnSave').textContent || '').trim();
    })()`);
    ok('设置页切回中文：文案还原', /保存/.test(backZh), backZh);
  }
  await sleep(500);
  ok('设置页没有未捕获异常', exceptions.length === before, exceptions.slice(before, before + 2).join(' | '));

  console.log('\n四、异常检查');
  ok('全程没有未捕获的 JS 异常', exceptions.length === 0, exceptions.slice(0, 3).join(' | '));

  console.log('\n四之二、全新安装的默认值（直接读默认配置模块）');
  // ⚠️ 这里**故意不起服务**：默认配置里 autoLaunchGale 是 true，起一个全新服务会真的把 Gale 拉起来。
  // 之前就是踩了这个坑（测试顺带启动了 Gale），所以把默认配置抽成了 core/defaults.mjs 直接断言。
  {
    const { DEFAULT_CONFIG } = await import(pathToFileURL(path.join(ROOT, 'core', 'defaults.mjs')).href);
    ok('全新安装默认节点是内置引擎', DEFAULT_CONFIG.provider === 'builtin', JSON.stringify(DEFAULT_CONFIG.provider));
    ok(
      '全新安装的备用链是免密钥的免费节点（内置引擎没好时开箱就能看到中文）',
      JSON.stringify(DEFAULT_CONFIG.fallback) === '["tencent","youdao"]',
      JSON.stringify(DEFAULT_CONFIG.fallback),
    );
    ok(
      '全新安装带 local-llm 的默认参数（指向本机 Ollama）',
      DEFAULT_CONFIG.localLlmBaseUrl === 'http://127.0.0.1:11434/v1' && !!DEFAULT_CONFIG.localLlmModel,
      JSON.stringify({ u: DEFAULT_CONFIG.localLlmBaseUrl, m: DEFAULT_CONFIG.localLlmModel }),
    );
    ok('默认配置里没有已移除节点的密钥字段', !Object.keys(DEFAULT_CONFIG).some((k) => /^(tencentCloud|youdaoApp|googleCloud)/.test(k)), Object.keys(DEFAULT_CONFIG).filter((k) => /^(tencentCloud|youdaoApp|googleCloud)/.test(k)).join(','));
  }

  console.log('\n五、关闭接口（启动器换掉旧服务时用）');
  let shutdownOk = false;
  try {
    const r = await fetch(`http://127.0.0.1:${svcPort}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3000) });
    shutdownOk = r.ok;
  } catch {}
  ok('POST /api/shutdown 返回成功', shutdownOk);
  let gone = false;
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    try {
      await fetch(`http://127.0.0.1:${svcPort}/api/status`, { signal: AbortSignal.timeout(600) });
    } catch {
      gone = true;
      break;
    }
  }
  ok('关闭后服务端口不再响应', gone);
} catch (e) {
  fails.push('测试执行出错：' + e.message);
  console.log('  [×] 测试执行出错：' + e.message);
} finally {
  cleanup();
}

console.log(`\n结果：通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('失败明细：');
  for (const f of fails) console.log('  - ' + f);
  console.log('');
  process.exit(1);
}
console.log('集成冒烟测试全部通过。\n');
process.exit(0);
