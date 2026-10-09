// 手动诊断工具：填代理之前，先用它确认「走这个代理到底能不能连上境外节点」。
// 需要出境的节点是 Google 翻译（内置的免密钥节点里唯一一个）以及 DeepL / OpenAI 兼容端点；
// 腾讯 / 有道 / 内置引擎 / 本地大模型 / 自建 LibreTranslate / 缓存都直连或不出本机，所以这里只探境外的。
// 无密钥访问会返回 401 / 403 —— 能拿到 HTTP 状态就说明代理链路通了。
// 用法: node tools/test-proxy.mjs [http://127.0.0.1:7890]
import { request } from '../core/net.mjs';

const PROXY = process.argv[2] || 'http://127.0.0.1:7892';
const UA = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0',
};

async function test(name, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(`[OK  ] ${name}  ${Date.now() - t0}ms -> ${String(r).slice(0, 110).replace(/\s+/g, ' ')}`);
  } catch (e) {
    console.log(`[FAIL] ${name}  ${Date.now() - t0}ms -> ${e.message}`);
  }
}

console.log('代理: ' + PROXY + '\n');

await test('DeepL API（无密钥应为 403/401，拿到状态码就说明通了）', async () => {
  const r = await request('https://api-free.deepl.com/v2/translate', {
    method: 'POST',
    headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'text=Hello&target_lang=ZH',
    proxy: PROXY,
    timeout: 12000,
  });
  return 'HTTP ' + r.status;
});

await test('OpenAI 兼容端点 /v1/models（无密钥应为 401）', async () => {
  const r = await request('https://api.openai.com/v1/models', { proxy: PROXY, timeout: 12000, headers: UA });
  return 'HTTP ' + r.status;
});

await test('Google 翻译免费接口（免密钥，200 就算通）', async () => {
  const u =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=' +
    encodeURIComponent('hello');
  const r = await request(u, { proxy: PROXY, timeout: 12000, headers: UA });
  return 'HTTP ' + r.status;
});

await test('DeepL 官网可达', async () => {
  const r = await request('https://www.deepl.com/', { proxy: PROXY, timeout: 12000, headers: UA });
  return 'HTTP ' + r.status;
});

console.log('\n对照：不带代理直连同一个 Google 接口（国内预期超时/失败）');
await test('Google 免费接口（直连）', async () => {
  const u =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=' +
    encodeURIComponent('hello');
  const r = await request(u, { proxy: null, timeout: 8000, headers: UA });
  return 'HTTP ' + r.status;
});

console.log('\n对照：不带代理直连同一个 OpenAI 端点（国内预期超时/失败）');
await test('OpenAI /v1/models（直连）', async () => {
  const r = await request('https://api.openai.com/v1/models', { proxy: null, timeout: 8000, headers: UA });
  return 'HTTP ' + r.status;
});
