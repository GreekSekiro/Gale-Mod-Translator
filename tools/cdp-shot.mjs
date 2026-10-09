// 通过 CDP 截取 Gale 窗口当前画面，用于验证翻译效果
import fs from 'node:fs';
import { cdpPort } from './cdp-port.mjs';

const PORT = cdpPort();
const out = process.argv[2] || 'shot.png';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('no page target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
  });

await send('Page.enable');
const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
console.log('saved ' + out);
ws.close();
// 显式退出：CDP 的 WebSocket 有时会让事件循环多活一会儿，命令行看起来像"卡住了"
// （同目录的 cdp-eval.mjs 也是这么收尾的）
process.exit(0);
