// 极简 CDP 评估工具：把 JS 表达式送进 Gale 的 WebView2 执行并打印结果
// 用法: node cdp-eval.mjs "expression"        (表达式，可 awaitPromise)
//       node cdp-eval.mjs --file expr.js      (从文件读表达式)
// 端口自动取 data/runtime.json（服务端换端口后也跟着走），可用 GALE_CDP_PORT 覆盖
import fs from 'node:fs';
import { cdpPort } from './cdp-port.mjs';

const PORT = cdpPort();
const args = process.argv.slice(2);
let expr;
if (args[0] === '--file') {
  expr = fs.readFileSync(args[1], 'utf8');
} else {
  expr = args.join(' ');
}
if (!expr) {
  console.error('no expression');
  process.exit(2);
}

async function pickTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await res.json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  return page;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error('ws error: ' + (e.message || 'unknown')));
  });
}

let nextId = 1;
function send(ws, method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMsg);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const target = await pickTarget();
const ws = await connect(target.webSocketDebuggerUrl);
try {
  await send(ws, 'Runtime.enable');
  const r = await send(ws, 'Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    console.error('EXCEPTION:', JSON.stringify(r.exceptionDetails, null, 2));
    process.exit(1);
  }
  const v = r.result?.value;
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
} finally {
  ws.close();
}
