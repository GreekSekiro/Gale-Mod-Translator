// 从运行中的 Gale 抓取 DOM 快照，固化成回放测试用的夹具（test/fixtures/*.html）
// ---------------------------------------------------------------------------
// 用法：
//   node tools/snapshot.mjs                    抓默认路由：/ /browse /config /modpack /prefs
//   node tools/snapshot.mjs /browse            只抓指定路由
//   node tools/snapshot.mjs /browse --name browse2
//
// 抓之前请先启动 Gale（带调试端口，即由 start.cmd 启动）。
// 抓取时会先调用注入引擎的 dispose() 把译文还原成原文、并移除悬浮条，
// 这样夹具里保存的是"Gale 的原始 DOM"，回放测试才可复现。
// 抓完再跑 `node tools/replay-test.mjs --update` 生成期望文件。
import fs from 'node:fs';
import path from 'node:path';
import { cdpPort, ROOT } from './cdp-port.mjs';

const PORT = cdpPort();
const OUT_DIR = path.join(ROOT, 'test', 'fixtures');
const GALE_ORIGIN = process.env.GALE_ORIGIN || 'http://tauri.localhost';

const argv = process.argv.slice(2);
const nameIdx = argv.indexOf('--name');
const customName = nameIdx >= 0 ? argv[nameIdx + 1] : null;
const routes = argv.filter((a, i) => a.startsWith('/') && i !== nameIdx + 1);
if (!routes.length) routes.push('/', '/browse', '/config', '/modpack', '/prefs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const list = await res.json();
  const page = list.find((t) => t.type === 'page' && !/^devtools:/.test(t.url || ''));
  if (!page) throw new Error('没有找到 Gale 页面目标');
  return page;
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
  const send = (method, params = {}, timeout = 30000) =>
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  return { send, evaluate };
}

let target;
try {
  target = await pickTarget();
} catch (e) {
  console.error(`连不上 Gale 的调试端口 ${PORT}（${e.message}）。\n请先用 start.cmd 启动 Gale，或用 GALE_CDP_PORT 指定端口。`);
  process.exit(2);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')));
});
const { send, evaluate } = makeClient(ws);
await send('Runtime.enable');
await send('Page.enable');

fs.mkdirSync(OUT_DIR, { recursive: true });
const saved = [];

for (const route of routes) {
  try {
    await send('Page.navigate', { url: GALE_ORIGIN + route });
    await sleep(3200); // 等 Svelte 渲染完（虚拟列表 / markdown）
    // 还原译文、移除悬浮条与搜索面板，取到"原始 DOM"
    await evaluate(
      '(() => { try { window.__galeTrans && window.__galeTrans.dispose && window.__galeTrans.dispose(); } catch {} ' +
        "document.querySelectorAll('#gale-trans-host,#gale-search-hint').forEach(e=>e.remove()); return true; })()",
    );
    await sleep(400);
    const html = await evaluate('"<!doctype html>\\n" + document.documentElement.outerHTML');
    if (!html || html.length < 200) throw new Error('抓到的 DOM 太短，可能页面还没渲染完');

    const name = customName || route.replace(/^\/+/, '').replace(/[/\\]/g, '_') || 'root';
    const file = path.join(OUT_DIR, `${name}.html`);
    let out = html;
    if (!/<meta\s+name=["']gale-route["']/i.test(out)) {
      out = out.replace(/<head([^>]*)>/i, `<head$1>\n<meta name="gale-route" content="${route}">`);
    }
    fs.writeFileSync(file, out, 'utf8');
    saved.push({ route, file, bytes: Buffer.byteLength(out) });
    console.log(`  [√] ${route}  →  ${path.relative(ROOT, file)}（${(Buffer.byteLength(out) / 1024).toFixed(0)} KB）`);
  } catch (e) {
    console.log(`  [×] ${route}  失败：${e.message}`);
  }
}

ws.close();

if (saved.length) {
  console.log(`\n已保存 ${saved.length} 个夹具。接着跑：node tools/replay-test.mjs --update\n`);
} else {
  console.log('\n没有保存任何夹具。\n');
  process.exit(1);
}
