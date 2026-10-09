// DOM 快照回放测试
// ---------------------------------------------------------------------------
// 把固化下来的 DOM 快照（test/fixtures/*.html）丢进无头 Edge，注入页面引擎
// （dry 模式：不联网、不建悬浮条），调用 dryRun() 得到"哪些文本会被翻译 / 为什么没翻"，
// 再与 test/expect/*.json 比对。改动筛选规则后跑一遍，就能立刻看出有没有误伤。
//
// 用法：
//   node tools/replay-test.mjs            比对（不一致则退出码 1）
//   node tools/replay-test.mjs --print    只打印当前结果，不比对
//   node tools/replay-test.mjs --update   用当前结果刷新期望文件
//
// 想用真实 Gale 页面做夹具：先启动 Gale（带调试端口），再跑
//   node tools/snapshot.mjs /browse
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = path.join(ROOT, 'test', 'fixtures');
const EXPECT_DIR = path.join(ROOT, 'test', 'expect');
const INJECT = fs.readFileSync(path.join(ROOT, 'core', 'inject.js'), 'utf8');

const MODE = process.argv.includes('--update') ? 'update' : process.argv.includes('--print') ? 'print' : 'check';

const BROWSERS = [
  process.env.GALE_TEST_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  for (const p of BROWSERS) if (fs.existsSync(p)) return p;
  return null;
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

// ---------------------------------------------------------------- 夹具
function loadFixtures() {
  if (!fs.existsSync(FIXTURE_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.html'))) {
    const file = path.join(FIXTURE_DIR, f);
    const html = fs.readFileSync(file, 'utf8');
    const m = html.match(/<meta\s+name=["']gale-route["']\s+content=["']([^"']+)["']/i);
    const route = m ? m[1] : '/' + f.replace(/\.html$/, '');
    out.push({ name: f.replace(/\.html$/, ''), file, route, html });
  }
  return out;
}

// ---------------------------------------------------------------- CDP
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
  });
}

function makeClient(ws) {
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
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
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || d.text || '页面脚本异常');
    }
    return r.result?.value;
  };
  return { send, evaluate };
}

// ---------------------------------------------------------------- 归一化与比对
const sortedObj = (o) => Object.fromEntries(Object.entries(o || {}).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
function normalize(res) {
  return {
    route: res.route,
    mode: res.mode,
    counts: sortedObj(res.counts),
    candidates: [...(res.candidates || [])].sort(),
    classified: Object.fromEntries(
      Object.entries(res.classified || {})
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        .map(([k, v]) => [k, [...v].sort()]),
    ),
  };
}

function diff(exp, act) {
  const lines = [];
  if (exp.route !== act.route) lines.push(`  路由：期望 ${exp.route}，实际 ${act.route}`);
  if (exp.mode !== act.mode) lines.push(`  模式：期望 ${exp.mode}，实际 ${act.mode}`);
  const keys = new Set([...Object.keys(exp.counts || {}), ...Object.keys(act.counts || {})]);
  for (const k of keys) {
    const a = exp.counts?.[k] ?? 0;
    const b = act.counts?.[k] ?? 0;
    if (a !== b) lines.push(`  计数 ${k}：期望 ${a}，实际 ${b}`);
  }
  const setDiff = (label, a, b) => {
    const A = new Set(a || []);
    const B = new Set(b || []);
    const gone = [...A].filter((x) => !B.has(x));
    const added = [...B].filter((x) => !A.has(x));
    if (gone.length) lines.push(`  ${label} 不再翻译/归类：${gone.map((s) => JSON.stringify(s)).join('、')}`);
    if (added.length) lines.push(`  ${label} 新增翻译/归类：${added.map((s) => JSON.stringify(s)).join('、')}`);
  };
  setDiff('候选', exp.candidates, act.candidates);
  const cats = new Set([...Object.keys(exp.classified || {}), ...Object.keys(act.classified || {})]);
  for (const c of cats) setDiff(`分类「${c}」`, exp.classified?.[c], act.classified?.[c]);
  return lines;
}

// ---------------------------------------------------------------- 主流程
const fixtures = loadFixtures();
if (!fixtures.length) {
  console.error(`没有找到夹具：${FIXTURE_DIR}\\*.html`);
  process.exit(2);
}

const browser = findBrowser();
if (!browser) {
  console.error('没有找到可用的 Chromium 内核浏览器（Edge / Chrome）。可用 GALE_TEST_BROWSER 指定路径。');
  process.exit(2);
}

const routeMap = new Map(fixtures.map((f) => [f.route, f]));
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  if (p === '/' && routeMap.has('/')) p = '/';
  const f = routeMap.get(p);
  if (!f) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('fixture not found: ' + p);
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(f.html);
});

const httpPort = await freePort();
await new Promise((r) => server.listen(httpPort, '127.0.0.1', r));

const cdpPort = await freePort();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gale-replay-'));
const proc = spawn(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ],
  { stdio: 'ignore', windowsHide: true },
);

let ws = null;
const cleanup = () => {
  try {
    ws?.close();
  } catch {}
  try {
    server.close();
  } catch {}
  try {
    proc.kill();
  } catch {}
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {}
};

async function waitForCdp(timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        const list = await r.json();
        const page = list.find((t) => t.type === 'page');
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch {}
    await sleep(400);
  }
  throw new Error('等待无头浏览器调试端口超时');
}

try {
  const wsUrl = await waitForCdp();
  ws = await connect(wsUrl);
  const { send, evaluate } = makeClient(ws);

  await send('Runtime.enable');
  await send('Page.enable');
  // 注入：dry 模式 + 指向一个必然连不上的端口，保证完全离线
  const prelude = `window.__GALE_TR__ = ${JSON.stringify({ api: 'http://127.0.0.1:9', dry: true, debug: false })};`;
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `${prelude}\n${INJECT}` });

  const results = [];
  for (const f of fixtures) {
    await send('Page.navigate', { url: `http://127.0.0.1:${httpPort}${f.route}` });
    // 等页面加载完 + 引擎挂上
    const t0 = Date.now();
    let ready = false;
    while (Date.now() - t0 < 15000) {
      await sleep(200);
      try {
        ready = await evaluate('document.readyState === "complete" && !!(window.__galeTrans && window.__galeTrans.dryRun)');
      } catch {}
      if (ready) break;
    }
    if (!ready) throw new Error(`夹具 ${f.name} 加载或注入失败（route=${f.route}）`);
    const raw = await evaluate('JSON.stringify(window.__galeTrans.dryRun())');
    const res = JSON.parse(raw);
    results.push({ fixture: f, res: normalize(res) });
  }

  console.log(`\n回放测试：${results.length} 个夹具（${path.basename(browser)} 无头模式）\n`);

  if (MODE === 'print') {
    for (const { fixture, res } of results) {
      console.log(`—— ${fixture.name} (${res.route}) ——`);
      console.log(JSON.stringify(res, null, 2));
    }
    cleanup();
    process.exit(0);
  }

  fs.mkdirSync(EXPECT_DIR, { recursive: true });
  let failed = 0;
  for (const { fixture, res } of results) {
    const expectFile = path.join(EXPECT_DIR, `${fixture.name}.json`);
    if (MODE === 'update' || !fs.existsSync(expectFile)) {
      const existed = fs.existsSync(expectFile);
      fs.writeFileSync(expectFile, JSON.stringify(res, null, 2) + '\n', 'utf8');
      console.log(`  [${existed ? '已更新' : '已写入'}] ${path.relative(ROOT, expectFile)}  （候选 ${res.candidates.length} 条，分类 ${Object.keys(res.classified).length} 类）`);
      continue;
    }
    let exp;
    try {
      exp = JSON.parse(fs.readFileSync(expectFile, 'utf8'));
    } catch (e) {
      console.log(`  [×] ${fixture.name}：期望文件解析失败 —— ${e.message}`);
      failed++;
      continue;
    }
    const d = diff(exp, res);
    if (!d.length) {
      console.log(`  [√] ${fixture.name} (${res.route})：候选 ${res.candidates.length} 条，分类与期望一致`);
    } else {
      failed++;
      console.log(`  [×] ${fixture.name} (${res.route})：与期望不一致`);
      for (const line of d) console.log(line);
      console.log(`      → 若确认是新行为，跑 node tools/replay-test.mjs --update 更新期望`);
    }
  }

  console.log('');
  cleanup();
  if (failed) {
    console.log(`回放测试失败：${failed} 个夹具与期望不符。\n`);
    process.exit(1);
  }
  console.log('回放测试全部通过。\n');
  process.exit(0);
} catch (e) {
  console.error('回放测试出错：' + e.message);
  cleanup();
  process.exit(2);
}
