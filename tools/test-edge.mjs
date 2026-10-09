// 边界与对抗性测试（离线为主）
// 覆盖那些"平时不出事、一出事就很难查"的地方：
//   1) 译库长译文不能被静默截断（截断=给用户看半句话，比不翻还糟）
//   2) 缓存 / 译库文件损坏要能自愈（隔离坏文件而不是崩掉）
//   3) 术语占位符被机翻吃掉时，不能把 [[0]] 这种标记漏到界面上
//   4) 配置里出现非法类型 / 非法自定义节点时，服务不能崩
//   5) 本地服务的 CORS 必须只放行本机来源（否则任意网页都能改你的配置、读你的译库）
//   6) 译库导入的异常输入要有友好报错
// 用法: node tools/test-edge.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Cache } from '../core/cache.mjs';
import { Library } from '../core/library.mjs';

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
const eq = (name, a, b) => ok(name, a === b, `期望 ${JSON.stringify(b)}，得到 ${JSON.stringify(a)}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gale-edge-'));

// ---------------------------------------------------------------- 一、译库
console.log('\n一、译库：长译文与容错');
{
  const lib = new Library(path.join(tmp, 'lib1.json'));
  const LONG = '很长的译文。'.repeat(400); // 2400 字，超过旧实现的 1000 字上限
  ok('长译文的长度确实超过旧上限', LONG.length > 1000, `${LONG.length}`);

  lib.add('some long source text', LONG, { target: 'zh-CN' });
  const got = lib.get('some long source text', 'zh-CN');
  ok('长译文能存进译库', !!got, JSON.stringify(got)?.slice(0, 60));
  eq('取回的译文长度与原文一致（没有被截断）', got && got.d.length, LONG.length);

  // 落盘再读回，确认不是内存里的假象
  lib.flush && lib.flush();
  const lib2 = new Library(path.join(tmp, 'lib1.json'));
  const got2 = lib2.get('some long source text', 'zh-CN');
  eq('重新加载后依然完整', got2 && got2.d.length, LONG.length);
}

console.log('\n二、缓存 / 译库损坏自愈');
{
  const cacheFile = path.join(tmp, 'cache.json');
  fs.writeFileSync(cacheFile, '{ 这不是合法 JSON', 'utf8');
  let threw = null;
  let c = null;
  try {
    c = new Cache(cacheFile);
  } catch (e) {
    threw = e;
  }
  ok('损坏的缓存文件不会让构造抛异常', !threw, String(threw && threw.message));
  ok('损坏文件被隔离成 .broken-*', fs.readdirSync(tmp).some((f) => f.startsWith('cache.json.broken-')), fs.readdirSync(tmp).join(','));
  ok('隔离后缓存仍可正常使用', (() => { c.set('a', 'cache-only', 'zh-CN', 'b'); return c.get('a', 'cache-only', 'zh-CN') === 'b'; })());
  ok('缓存给长文本打上"源文被截断"标记（导出时要跳过）', (() => {
    const long = 'x'.repeat(500);
    c.set(long, 'cache-only', 'zh-CN', 'y');
    const entry = [...c.map.values()].find((v) => v.d === 'y');
    return entry && entry.tr === 1;
  })());
  ok('短文本不带截断标记', (() => {
    const entry = [...c.map.values()].find((v) => v.d === 'b');
    return entry && !entry.tr;
  })());

  const libFile = path.join(tmp, 'lib2.json');
  fs.writeFileSync(libFile, 'null', 'utf8');
  threw = null;
  try {
    new Library(libFile);
  } catch (e) {
    threw = e;
  }
  ok('内容是 null 的译库文件也不会崩', !threw, String(threw && threw.message));
}

// ---------------------------------------------------------------- 三、术语占位符
console.log('\n三、术语占位符被机翻吃掉时不能残留标记');
{
  const { Translator } = await import('../core/translate.mjs');
  const { getProvider } = await import('../core/providers.mjs');

  const tt = getProvider('deepl');
  const orig = tt.translate;
  // 模拟"机翻把 [[0]] 标记弄丢了"：直接返回不含标记的译文
  tt.translate = async (texts) => texts.map(() => '瓦尔海姆很好玩');
  const cfg = {
    provider: 'deepl',
    fallback: [],
    target: 'zh-CN',
    source: 'auto',
    proxy: '',
    fuzzyReuse: false,
    library: { autoCollect: false },
    glossary: [{ from: 'Valheim', to: '英灵神殿' }],
    phraseMap: {},
    postReplace: [],
  };
  const tr = new Translator({
    cache: new Cache(path.join(tmp, 'c3.json')),
    library: new Library(path.join(tmp, 'l3.json')),
    getConfig: () => cfg,
    log: () => {},
  });
  const out = await tr.translate(['Valheim is great'], {});
  const dst = out[0].dst || '';
  ok('译文里不残留 [[数字]] 标记', !/\[\s*\[/.test(dst), JSON.stringify(dst));

  // 正常情况：标记被保留 → 术语应还原成指定译法
  tt.translate = async (texts) => texts.map((t) => '【' + t + '】');
  const tr2 = new Translator({
    cache: new Cache(path.join(tmp, 'c3b.json')),
    library: new Library(path.join(tmp, 'l3b.json')),
    getConfig: () => cfg,
    log: () => {},
  });
  const out2 = await tr2.translate(['Valheim is great'], {});
  ok('标记被保留时术语还原成指定译法', /英灵神殿/.test(out2[0].dst || ''), JSON.stringify(out2[0].dst));
  ok('标记被保留时译文里没有标记', !/\[\s*\[/.test(out2[0].dst || ''), JSON.stringify(out2[0].dst));
  tt.translate = orig;
}

// ---------------------------------------------------------------- 服务侧
const svcPort = await freePort();
const cdpPort = await freePort();
const svcDir = path.join(tmp, 'svc');
for (const d of ['core', 'ui']) fs.cpSync(path.join(ROOT, d), path.join(svcDir, d), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'VERSION'), path.join(svcDir, 'VERSION'));
fs.writeFileSync(
  path.join(svcDir, 'config.json'),
  JSON.stringify(
    {
      provider: 'cache-only',
      fallback: [],
      target: 'zh-CN',
      proxy: '',
      autoLaunchGale: false,
      servicePort: svcPort,
      cdpPort,
      minLen: '这不是数字', // 故意给个非法类型
      quality: 'not-an-object',
      glossary: 'not-an-array',
      customSources: [{ id: 'bad', name: 'bad', url: 'http://127.0.0.1:1/', headers: '{坏 JSON', body: '{}', responsePath: '[[[', batch: true, enabled: true }],
    },
    null,
    2,
  ),
);
const svc = spawn(process.execPath, [path.join(svcDir, 'core', 'server.mjs')], { cwd: svcDir, stdio: 'ignore', windowsHide: true });
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

try {
  console.log('\n四、非法配置不能让服务崩');
  ok('配置里全是非法类型，服务仍能启动', svcUp);
  if (svcUp) {
    const st = await (await fetch(`http://127.0.0.1:${svcPort}/api/status`)).json();
    ok('/api/status 正常响应', typeof st.version === 'string');
    const cc = await (await fetch(`http://127.0.0.1:${svcPort}/api/client-config`)).json();
    ok('/api/client-config 正常响应', Array.isArray(cc.providers));
    const langs = await (await fetch(`http://127.0.0.1:${svcPort}/api/langs`)).json();
    ok('/api/langs 正常响应', Array.isArray(langs.langs));

    console.log('\n五、异常输入要友好报错而不是崩');
    const badImport = await (await fetch(`http://127.0.0.1:${svcPort}/api/library/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'Z:\\definitely\\not\\here.json' }) })).json();
    ok('导入不存在的路径 → ok:false 且有 error', badImport.ok === false && !!badImport.error, JSON.stringify(badImport).slice(0, 120));

    const badContent = await (await fetch(`http://127.0.0.1:${svcPort}/api/library/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '这不是 JSON' }) })).json();
    ok('导入非 JSON 内容 → ok:false 且有 error', badContent.ok === false && !!badContent.error, JSON.stringify(badContent).slice(0, 120));

    const badCompare = await (await fetch(`http://127.0.0.1:${svcPort}/api/compare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '' }) })).json();
    ok('空文本对比 → 不崩、返回结构化结果', badCompare && (badCompare.ok === false || Array.isArray(badCompare.results)), JSON.stringify(badCompare).slice(0, 120));

    const badTest = await (await fetch(`http://127.0.0.1:${svcPort}/api/test-provider`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: '不存在的节点' }) })).json();
    ok('测试不存在的节点 → ok:false 且有 error', badTest.ok === false && !!badTest.error, JSON.stringify(badTest).slice(0, 120));

    console.log('\n六、本地服务只应放行本机来源（防任意网页操控）');
    const evil = await fetch(`http://127.0.0.1:${svcPort}/api/status`, { headers: { Origin: 'https://evil.example.com' } });
    const evilAcao = evil.headers.get('access-control-allow-origin');
    ok('陌生网站 Origin 不被放行（不回 CORS 头）', !evilAcao || (evilAcao !== '*' && !evilAcao.includes('evil.example.com')), `ACAO=${evilAcao}`);

    const evilPost = await fetch(`http://127.0.0.1:${svcPort}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
      body: JSON.stringify({ provider: 'google' }),
    });
    const evilPostBody = await evilPost.json().catch(() => ({}));
    ok('陌生网站不能改配置（被拒绝）', evilPost.status === 403 || evilPostBody.ok !== true, `HTTP ${evilPost.status} ${JSON.stringify(evilPostBody).slice(0, 80)}`);
    const after = await (await fetch(`http://127.0.0.1:${svcPort}/api/config`)).json();
    ok('配置确实没有被改动', after.config.provider !== 'google', after.config.provider);

    const localOrigin = await fetch(`http://127.0.0.1:${svcPort}/api/status`, { headers: { Origin: `http://127.0.0.1:${svcPort}` } });
    ok('本机设置页来源正常放行', localOrigin.status === 200 && localOrigin.headers.get('access-control-allow-origin') === `http://127.0.0.1:${svcPort}`, `ACAO=${localOrigin.headers.get('access-control-allow-origin')}`);

    const tauriOrigin = await fetch(`http://127.0.0.1:${svcPort}/api/status`, { headers: { Origin: 'http://tauri.localhost' } });
    ok('注入页来源（tauri.localhost）正常放行', tauriOrigin.status === 200 && tauriOrigin.headers.get('access-control-allow-origin') === 'http://tauri.localhost', `ACAO=${tauriOrigin.headers.get('access-control-allow-origin')}`);

    const noOrigin = await fetch(`http://127.0.0.1:${svcPort}/api/status`);
    ok('无 Origin（命令行 / 测试工具）正常放行', noOrigin.status === 200);

    console.log('\n七、自定义节点非法模板不能拖垮其它节点');
    const testBad = await (await fetch(`http://127.0.0.1:${svcPort}/api/test-provider`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'custom:bad' }) })).json();
    ok('非法自定义节点返回结构化错误', testBad.ok === false && !!testBad.error, JSON.stringify(testBad).slice(0, 140));
    const stAfter = await (await fetch(`http://127.0.0.1:${svcPort}/api/status`)).json();
    ok('服务在多次异常请求后依然存活', typeof stAfter.version === 'string');
  }
} finally {
  svc.kill();
  await sleep(400);
  if (fails.length) {
    console.log('\n--- 隔离服务日志（诊断用）---');
    try {
      console.log(fs.readFileSync(path.join(svcDir, 'logs', 'service.log'), 'utf8').split('\n').slice(-15).join('\n'));
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
console.log('边界与对抗性测试全部通过。\n');
