// CDP 动作工具：刷新 / 点击元素 / 截图，便于调试
// 用法: node cdp-act.mjs --reload
//       node cdp-act.mjs --click "选择器"
//       node cdp-act.mjs --navigate "/browse"
//       node cdp-act.mjs --shot out.png
import fs from 'node:fs';
import { cdpPort } from './cdp-port.mjs';

const PORT = cdpPort();
const argv = process.argv.slice(2);
const getArg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

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
await send('Runtime.enable');

if (argv.includes('--reload')) {
  await send('Page.reload', { ignoreCache: false });
  console.log('reloaded');
}
const nav = getArg('--navigate');
if (nav) {
  await send('Runtime.evaluate', { expression: `location.href=${JSON.stringify(nav)}` });
  console.log('navigated to ' + nav);
}
const click = getArg('--click');
if (click) {
  const r = await send('Runtime.evaluate', {
    expression: `(()=>{const el=document.querySelector(${JSON.stringify(click)}); if(!el) return 'not found'; el.click(); return 'clicked: '+el.textContent.trim().slice(0,40);})()`,
    returnByValue: true,
  });
  console.log(r.result.value);
  await new Promise((r) => setTimeout(r, 1500));
}
const shot = getArg('--shot');
if (shot) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shot, Buffer.from(r.data, 'base64'));
  console.log('saved ' + shot);
}
ws.close();
// 显式退出：CDP 的 WebSocket 有时会让事件循环多活一会儿，命令行看起来像"卡住了"
// （同目录的 cdp-eval.mjs 也是这么收尾的）
process.exit(0);
