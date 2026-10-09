// 回归测试：滚动后新渲染的内容是否会被翻译
// ---------------------------------------------------------------------------
// Gale 的模组列表是虚拟列表：滚动时会**新渲染**一批卡片节点。
// 引擎靠 MutationObserver 发现这些新节点并补翻。这条链路一旦断了，
// 表现就是"首屏翻了，往下滚就不翻了"。
//
// 本测试用仓库里的 mock 翻译接口（自定义节点）跑真实链路：
//   夹具页面 → 引擎注入 → 首屏翻译 → 追加新节点（模拟滚动渲染）→ 断言补翻
// 并额外验证：抽屉打开/关闭之后，补翻依然正常（防止抽屉改动破坏扫描）。
//
// 用法: node tools/test-scroll.mjs
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

const PREFIX = '【译】';
const T_FIRST = 'Plant multiple crops at once and harvest everything with a single click.';
const T_SCROLL = 'Adds a new boss fight with unique loot and mechanics.';
const T_WITH_DRAWER = 'Spawns additional creatures in the Black Forest biome.';

// ---------------------------------------------------------------- mock 翻译服务
const mockPort = await freePort();
let mockCalls = 0;
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Content-Type': 'application/json' };
    try {
      const j = JSON.parse(body || '{}');
      const list = Array.isArray(j.text) ? j.text : [];
      mockCalls++;
      res.writeHead(200, cors);
      res.end(JSON.stringify({ translations: list.map((t) => ({ text: PREFIX + t })) }));
    } catch (e) {
      res.writeHead(400, cors);
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});
await new Promise((r) => mock.listen(mockPort, '127.0.0.1', r));

// ---------------------------------------------------------------- 隔离服务
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gale-scroll-'));
for (const d of ['core', 'ui']) fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'VERSION'), path.join(tmp, 'VERSION'));

const svcPort = await freePort();
const cdpPort = await freePort();
fs.writeFileSync(
  path.join(tmp, 'config.json'),
  JSON.stringify(
    {
      provider: 'custom:mock',
      fallback: [],
      target: 'zh-CN',
      source: 'auto',
      proxy: '',
      autoLaunchGale: false,
      servicePort: svcPort,
      cdpPort,
      uiLang: 'zh-CN',
      minLen: 3,
      fuzzyReuse: false,
      translateNames: false,
      translateConfigPage: true,
      quality: { mode: 'fast', voters: [], consistency: false },
      customSources: [
        {
          id: 'mock',
          name: 'mock',
          url: `http://127.0.0.1:${mockPort}/`,
          method: 'POST',
          headers: '{"Content-Type":"application/json"}',
          body: '{"text":{{texts_json}},"to":"{{target}}"}',
          responsePath: 'translations[].text',
          batch: true,
          enabled: true,
        },
      ],
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

// ---------------------------------------------------------------- 夹具页面
const fixture = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'browse.html'), 'utf8');
const pagePort = await freePort();
const pageServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fixture);
});
await new Promise((r) => pageServer.listen(pagePort, '127.0.0.1', r));

// ---------------------------------------------------------------- 无头浏览器
const edge = spawn(
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-allow-origins=*', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${path.join(tmp, 'edge')}`, 'about:blank'],
  { stdio: 'ignore', windowsHide: true },
);

let wsUrl = null;
for (let i = 0; i < 50; i++) {
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
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const desctexts = () => evaluate(`JSON.stringify([...document.querySelectorAll('.desc')].map(e => e.textContent.trim()))`);

const addCard = (text, tag = 'NewMod') =>
  evaluate(`(() => {
    const box = document.querySelector('svelte-virtual-list-contents');
    const d = document.createElement('div');
    d.className = 'card';
    d.innerHTML = '<div class="body"><a class="name"><h3>${tag}</h3></a><p class="desc">${text}</p></div>';
    box.appendChild(d);
    return true;
  })()`);

console.log('\n滚动补翻回归测试\n');

try {
  ok('隔离服务已启动', svcUp);
  if (!svcUp) throw new Error('服务没起来');

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${pagePort}/browse` });
  await sleep(4500);

  console.log('一、首屏翻译');
  ok('引擎已注入', (await evaluate('typeof window.__galeTrans')) === 'object');
  const first = JSON.parse(await desctexts());
  ok('首屏卡片简介被翻译', first.some((t) => t.includes(PREFIX + T_FIRST)), JSON.stringify(first).slice(0, 160));
  ok('确实调用了翻译接口', mockCalls > 0, `mockCalls=${mockCalls}`);

  console.log('\n二、模拟滚动：新渲染的节点是否补翻');
  await addCard(T_SCROLL, 'ScrollMod');
  await sleep(3000);
  const afterScroll = JSON.parse(await desctexts());
  ok('滚动后新卡片被翻译', afterScroll.some((t) => t.includes(PREFIX + T_SCROLL)), JSON.stringify(afterScroll).slice(0, 200));

  console.log('\n三、抽屉打开时的补翻');
  await evaluate('window.__galeDrawer.open()');
  await sleep(2500);
  await addCard(T_WITH_DRAWER, 'DrawerMod');
  await sleep(3000);
  const withDrawer = JSON.parse(await desctexts());
  ok('抽屉打开时新卡片仍会被翻译', withDrawer.some((t) => t.includes(PREFIX + T_WITH_DRAWER)), JSON.stringify(withDrawer).slice(0, 200));

  console.log('\n四、抽屉关闭后的补翻');
  await evaluate('window.__galeDrawer.close()');
  await sleep(1200);
  const T_AFTER = 'Fixes a crash when opening the crafting menu in multiplayer.';
  await addCard(T_AFTER, 'AfterMod');
  await sleep(3000);
  const afterClose = JSON.parse(await desctexts());
  ok('抽屉关闭后新卡片仍会被翻译', afterClose.some((t) => t.includes(PREFIX + T_AFTER)), JSON.stringify(afterClose).slice(0, 200));

  console.log('\n五、原有译文没有被回退');
  ok('首屏译文还在', afterClose.some((t) => t.includes(PREFIX + T_FIRST)));

  console.log('\n六、异常检查');
  ok('全程没有未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));

  const st = await (await fetch(`http://127.0.0.1:${svcPort}/api/status`)).json();
  console.log(`     （统计：请求 ${st.stats.requests} · 已译 ${st.stats.items} · 错误 ${st.stats.errors}）`);
} catch (e) {
  ok('测试执行未出错', false, e.message);
} finally {
  try {
    ws.close();
  } catch {}
  pageServer.close();
  mock.close();
  edge.kill();
  svc.kill();
  await sleep(500);
  if (fails.length) {
    console.log('\n--- 隔离服务日志（诊断用）---');
    try {
      const log = fs.readFileSync(path.join(tmp, 'logs', 'service.log'), 'utf8').split('\n');
      console.log(log.slice(-25).join('\n'));
    } catch (e) {
      console.log('（读不到日志：' + e.message + '）');
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n结果：通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('失败明细：');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log('滚动补翻回归测试全部通过。\n');
