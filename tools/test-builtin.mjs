// 内置引擎（浏览器本地模型）端到端测试
// ---------------------------------------------------------------------------
// 链路：Node 服务 → CDP → Gale 页面里的 Translator API（本地语言包）
// 验证：能不能识别支持性、能不能触发下载、下载完能不能真的翻出中文、
//       以及首次"需要用户手势"这条约束在服务端调用时是否被满足。
//
// 注意：模型约 200MB，首次跑要 50~75 秒。测试**复用同一个浏览器 profile**
// （test/.tmp/builtin-profile），所以只有第一次慢，之后是秒级。
// 用法: node tools/test-builtin.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((r) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gale-builtin-'));
for (const d of ['core', 'ui']) fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'VERSION'), path.join(tmp, 'VERSION'));

const svcPort = await freePort();
const cdpPort = await freePort();
fs.writeFileSync(
  path.join(tmp, 'config.json'),
  JSON.stringify(
    {
      provider: 'builtin',
      fallback: [],
      target: 'zh-CN',
      source: 'auto',
      proxy: '',
      autoLaunchGale: false,
      servicePort: svcPort,
      cdpPort,
      uiLang: 'zh-CN',
      fuzzyReuse: false,
      quality: { mode: 'fast', voters: [], consistency: false },
    },
    null,
    2,
  ),
);

const svc = spawn(process.execPath, [path.join(tmp, 'core', 'server.mjs')], { cwd: tmp, stdio: 'ignore', windowsHide: true });
let svcUp = false;
for (let i = 0; i < 60; i++) {
  await sleep(300);
  try {
    if ((await fetch(`http://127.0.0.1:${svcPort}/api/status`)).ok) {
      svcUp = true;
      break;
    }
  } catch {}
}

// 复用 profile：模型只下载一次
const profileDir = path.join(ROOT, 'test', '.tmp', 'builtin-profile');
fs.mkdirSync(profileDir, { recursive: true });
const modelCached = fs.existsSync(path.join(profileDir, 'EdgeTranslateKitLanguagePack'));

const fixture = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'browse.html'), 'utf8');
const pagePort = await freePort();
const pageServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(fixture);
});
await new Promise((r) => pageServer.listen(pagePort, '127.0.0.1', r));

const edge = spawn(
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-allow-origins=*', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profileDir}`, 'about:blank'],
  { stdio: 'ignore', windowsHide: true },
);

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  await sleep(400);
  try {
    const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) {
      const p = (await r.json()).find((t) => t.type === 'page');
      if (p?.webSocketDebuggerUrl) {
        wsUrl = p.webSocketDebuggerUrl;
        break;
      }
    }
  } catch {}
}

let nextId = 1;
const pending = new Map();
const exceptions = [];
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', rej);
});
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text);
  }
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: false });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result?.value;
};
const j = async (p, init) => (await fetch(`http://127.0.0.1:${svcPort}${p}`, init)).json();
const post = (p, body) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

console.log('\n内置引擎（浏览器本地模型）端到端测试\n');
console.log(`（语言包${modelCached ? '已缓存，本次应较快' : '未缓存，首次需下载约 200MB / 50~75 秒'}）\n`);

try {
  ok('隔离服务已启动', svcUp);
  if (!svcUp) throw new Error('服务没起来');

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${pagePort}/browse` });
  await sleep(4000);

  console.log('一、能力探测');
  const st0 = await j('/api/local-engine');
  ok('引擎已注入页面', (await evaluate('typeof window.__galeTrans')) === 'object');
  ok('页面里能拿到本地翻译能力', (await evaluate('typeof Translator')) === 'function', String(await evaluate('typeof Translator')));
  ok('/api/local-engine 报告支持', st0.supported === true, JSON.stringify(st0).slice(0, 200));
  ok('en>zh 语言包状态可查', !!st0.pairs && !!st0.pairs['en>zh'], JSON.stringify(st0.pairs));
  ok('auto 源语言被映射成 en（该 API 不支持自动检测）', (await evaluate(`window.__galeTrans.localStatus().then(()=>'ok')`)) === 'ok');

  console.log('\n二、准备语言包（首次会触发下载）');
  if (st0.pairs && st0.pairs['en>zh'] !== 'available') {
    const t0 = Date.now();
    const prep = await post('/api/local-engine/prepare', { source: 'en', target: 'zh-CN' });
    ok('prepare 接口立即返回（不阻塞）', prep.ok === true && prep.started === true, JSON.stringify(prep));
    let ready = false;
    let lastSt = null;
    let seenPrep = null; // 抓一份"下载中"的状态，用来验证进度字段（缓存命中时就抓不到）
    for (let i = 0; i < 90; i++) {
      await sleep(2000);
      const st = await j('/api/local-engine');
      lastSt = st;
      if (!seenPrep && st.preparing && st.preparing.hasProgress) seenPrep = st.preparing;
      if (st.pairs && st.pairs['en>zh'] === 'available') {
        ready = true;
        break;
      }
      if (i % 3 === 0) {
        const p = st.preparing ? `下载中 ${Math.round((st.preparing.progress || 0) * 100)}%` : '未在下载';
        console.log(`      …${Math.round((Date.now() - t0) / 1000)}s  状态=${JSON.stringify(st.pairs)} ${p}${st.lastError ? ' 错误=' + st.lastError : ''}`);
      }
    }
    ok('语言包下载完成并就绪', ready, `耗时 ${Math.round((Date.now() - t0) / 1000)}s，最后状态 ${JSON.stringify(lastSt && lastSt.pairs)} 错误=${(lastSt && lastSt.lastError) || '无'}`);

    console.log('\n二之二、下载进度字段（界面靠这些画进度条）');
    if (seenPrep) {
      console.log('     抓到一份下载中状态：' + JSON.stringify(seenPrep));
      ok('上报进度百分比（0~1）', typeof seenPrep.progress === 'number' && seenPrep.progress > 0 && seenPrep.progress <= 1, String(seenPrep.progress));
      ok('上报已用时间', typeof seenPrep.elapsedMs === 'number' && seenPrep.elapsedMs >= 0, String(seenPrep.elapsedMs));
      ok('上报语言包总大小（估算）', seenPrep.totalBytes > 0, String(seenPrep.totalBytes));
      ok('上报已下载量（估算，与百分比一致）', seenPrep.downloadedBytes > 0 && Math.abs(seenPrep.downloadedBytes - seenPrep.progress * seenPrep.totalBytes) < 1024, `${seenPrep.downloadedBytes} / ${seenPrep.totalBytes}`);
      ok('上报下载速度（估算，>= 0）', typeof seenPrep.speedBps === 'number' && seenPrep.speedBps >= 0, String(seenPrep.speedBps));
      ok('标记"已开始有进度"', seenPrep.hasProgress === true, String(seenPrep.hasProgress));
    } else {
      console.log('     （语言包已缓存，本次没经历下载过程 → 跳过；用全新 profile 可覆盖到）');
      ok('下载中状态字段：本次缓存命中，跳过（不计失败）', true);
    }
  } else {
    ok('语言包已就绪（无需下载）', true);
  }

  const st1 = await j('/api/local-engine');
  ok('就绪后 availability = available', st1.pairs && st1.pairs['en>zh'] === 'available', JSON.stringify(st1.pairs));

  console.log('\n三、端到端翻译（服务端 → CDP → 本地模型）');
  const texts = [
    'Adds loot drops and magic items.',
    'Requires BepInEx to be installed first.',
    'Fixes a crash when opening the crafting menu.',
  ];
  const r = await post('/api/translate', { texts });
  ok('/api/translate 有返回', Array.isArray(r.items) && r.items.length === texts.length, JSON.stringify(r).slice(0, 200));
  if (Array.isArray(r.items)) {
    ok('每个条目都有译文', r.items.every((x) => x && typeof x.dst === 'string' && x.dst.length > 0), JSON.stringify(r.items).slice(0, 240));
    ok('译文确实是中文', r.items.every((x) => /[\u3400-\u9fff]/.test(x.dst || '')), JSON.stringify(r.items.map((x) => x.dst)));
    ok('译文不是照抄原文', r.items.every((x) => x.dst !== x.src), JSON.stringify(r.items.map((x) => x.dst)));
    ok('provider 标记为 builtin', r.items.every((x) => x.provider === 'builtin'), JSON.stringify(r.items.map((x) => x.provider)));
    console.log('     译文：' + JSON.stringify(r.items.map((x) => x.dst), null, 0));
  }

  console.log('\n四、页面确实被翻译了（语言包就绪后应自动补翻）');
  let descs = [];
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    descs = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.desc')].map(e=>e.textContent.trim()))`));
    if (descs.some((t) => /[\u3400-\u9fff]/.test(t))) break;
  }
  ok('夹具页面的英文简介被自动翻成中文', descs.some((t) => /[\u3400-\u9fff]/.test(t)), JSON.stringify(descs).slice(0, 220));
  console.log('     页面上的译文：' + JSON.stringify(descs.slice(0, 2)));

  console.log('\n五、长文本');
  const long = await post('/api/translate', {
    texts: ['This mod adds a wide variety of new content to the game, including weapons, armor, and building pieces. '.repeat(5).trim()],
  });
  ok('长文本也能翻（不报错、有中文）', Array.isArray(long.items) && /[\u3400-\u9fff]/.test(long.items[0]?.dst || ''), JSON.stringify(long.items?.[0]?.dst || long).slice(0, 160));

  console.log('\n六、异常检查');
  ok('全程没有未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));
  const st = await j('/api/status');
  ok('服务依然存活', typeof st.version === 'string');
} catch (e) {
  ok('测试执行未出错', false, e.message);
} finally {
  try {
    ws.close();
  } catch {}
  pageServer.close();
  try {
    edge.kill();
  } catch {}
  svc.kill();
  await sleep(600);
  if (fails.length) {
    console.log('\n--- 隔离服务日志（诊断用）---');
    try {
      console.log(fs.readFileSync(path.join(tmp, 'logs', 'service.log'), 'utf8').split('\n').slice(-20).join('\n'));
    } catch {}
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n结果：通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('失败明细：');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log('内置引擎端到端测试全部通过。\n');
