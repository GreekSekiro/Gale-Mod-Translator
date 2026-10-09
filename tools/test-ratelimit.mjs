// 限流处理自测（离线；除本机 mock 服务外不发任何外部请求）
// 1) 冷却登记：标记 / 递增 / 到期 / 清除 / 状态查询
// 2) isRateLimitError 识别
// 3) OpenAI 兼容节点（local-llm）把多段合并成少量请求 —— 用本机 mock 服务收请求
// 4) 被限流时"快速失败"，不逐段硬打
// 5) 被限流时"冷却 + 自动切备用节点"，且冷却期内不再碰该节点
// 用法: node tools/test-ratelimit.mjs
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  getProvider,
  providerCooldown,
  markProviderRateLimited,
  clearProviderRateLimit,
  rateLimitStatus,
  isRateLimitError,
} from '../core/providers.mjs';
import { Translator } from '../core/translate.mjs';
import { Cache } from '../core/cache.mjs';
import { Library } from '../core/library.mjs';

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

console.log('\n一、限流识别');
for (const [msg, want] of [
  ['模型接口 HTTP 429: rate limit exceeded', true],
  ['请求频率过快', true],
  ['rate limit exceeded', true],
  ['Too Many Requests', true],
  ['HTTP 500', false],
  ['请求超时(8000ms)', false],
  ['返回条目数不匹配', false],
]) {
  eq(`isRateLimitError(${JSON.stringify(msg)})`, isRateLimitError(new Error(msg)), want);
}

console.log('\n二、冷却登记');
clearProviderRateLimit('deepl');
eq('初始无冷却', providerCooldown('deepl'), 0);
eq('初始状态列表为空', rateLimitStatus().length, 0);

const ms1 = markProviderRateLimited('deepl', 'test-1');
ok('标记后进入冷却', providerCooldown('deepl') > 0, `${providerCooldown('deepl')}ms`);
eq('首次冷却 60s', ms1, 60_000);

const ms2 = markProviderRateLimited('deepl', 'test-2');
eq('再次被限流 → 冷却翻倍（120s）', ms2, 120_000);
const ms3 = markProviderRateLimited('deepl', 'test-3');
eq('第三次 → 240s', ms3, 240_000);

const st = rateLimitStatus();
eq('状态列表有 1 条', st.length, 1);
eq('状态里带 strikes', st[0].strikes, 3);
ok('状态里带剩余毫秒', st[0].remainingMs > 0, `${st[0].remainingMs}`);

// 冷却上限 10 分钟
for (let i = 0; i < 8; i++) markProviderRateLimited('deepl', 'x');
ok('冷却时间有上限（<= 10 分钟）', providerCooldown('deepl') <= 10 * 60_000, `${providerCooldown('deepl')}ms`);

clearProviderRateLimit('deepl');
eq('清除后立刻可用', providerCooldown('deepl'), 0);

// ---------------------------------------------------------------- 本机 mock 的 OpenAI 兼容服务
// 记录每次请求里的条目数；mode = 'ok' 正常返回，'429' 一律按限流失败。
const seen = [];
let mode = 'ok';
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let items = [];
    try {
      const j = JSON.parse(body || '{}');
      const userMsg = (j.messages || []).find((m) => m.role === 'user')?.content || '[]';
      const parsed = JSON.parse(userMsg);
      items = Array.isArray(parsed) ? parsed : [parsed];
    } catch {}
    seen.push(items.length);
    if (mode === '429') {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(items.map((x) => 'T:' + x)) } }],
      }),
    );
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}/v1`;

console.log('\n三、OpenAI 兼容节点批量合并（12 段一批）');
const llm = getProvider('local-llm');
const ctx = { source: 'auto', target: 'zh-CN', proxy: null, cfg: { localLlmBaseUrl: base, localLlmModel: 'mock' } };

seen.length = 0;
let out = await llm.translate(['a', 'b', 'c'], ctx);
eq('3 段只发了 1 次请求', seen.length, 1);
eq('每次请求都带上全部 3 段', seen[0], 3);
eq('3 段结果都正确', out.join('|'), 'T:a|T:b|T:c');

seen.length = 0;
const many = Array.from({ length: 30 }, (_, i) => 's' + i);
out = await llm.translate(many, ctx);
eq('30 段 → 3 次请求', seen.length, 3);
eq('请求按 12 / 12 / 6 切分', seen.join(','), '12,12,6');
eq('返回条目数与输入一致', out.length, 30);
eq('顺序与输入一致（首条）', out[0], 'T:s0');
eq('顺序与输入一致（末条）', out[29], 'T:s29');

console.log('\n四、被限流时快速失败（不逐段硬打）');
mode = '429';
seen.length = 0;
let threw = null;
try {
  await llm.translate(many, ctx);
} catch (e) {
  threw = e;
}
mode = 'ok';
ok('限流错误会上抛给上层', !!threw && isRateLimitError(threw), String(threw && threw.message));
eq('只尝试了 1 次（没有逐批硬打）', seen.length, 1);

console.log('\n五、冷却 + 自动切备用节点（端到端）');
const dd = getProvider('deepl');
const oo = getProvider('openai');
const origD = dd.translate;
const origO = oo.translate;

let fallbackCalls = 0;
let primaryCalls = 0;
dd.translate = async () => {
  primaryCalls++;
  throw new Error('DeepL 返回 HTTP 429: rate limit exceeded');
};
oo.translate = async (texts) => {
  fallbackCalls++;
  return texts.map((t) => '译:' + t);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gale-rl-'));
const cfg = {
  provider: 'deepl',
  fallback: ['openai'],
  target: 'zh-CN',
  source: 'auto',
  proxy: '',
  fuzzyReuse: false,
  library: { autoCollect: false },
  glossary: [],
  phraseMap: {},
  postReplace: [],
};
const tr = new Translator({
  cache: new Cache(path.join(tmp, 'cache.json')),
  library: new Library(path.join(tmp, 'library.json')),
  getConfig: () => cfg,
  log: () => {},
});

clearProviderRateLimit('deepl');
const r1 = await tr.translate(['hello'], {});
eq('主节点被限流后自动用了备用节点', r1[0].provider, 'openai');
eq('备用节点拿到了正确译文', r1[0].dst, '译:hello');
ok('主节点已被标记冷却', providerCooldown('deepl') > 0, `${providerCooldown('deepl')}ms`);

primaryCalls = 0;
const r2 = await tr.translate(['world'], {});
eq('冷却期内第二次翻译仍用备用节点', r2[0].provider, 'openai');
eq('冷却期内完全没有再请求被限流的节点', primaryCalls, 0);
ok('翻译统计里有失败计数', tr.stats.errors > 0, String(tr.stats.errors));

// 解除冷却后应重新尝试主节点
clearProviderRateLimit('deepl');
dd.translate = async (texts) => texts.map((t) => 'D:' + t);
const r3 = await tr.translate(['again'], {});
eq('解除冷却后重新用主节点', r3[0].provider, 'deepl');
eq('主节点结果正确', r3[0].dst, 'D:again');

dd.translate = origD;
oo.translate = origO;
clearProviderRateLimit('deepl');
fs.rmSync(tmp, { recursive: true, force: true });
srv.close();

console.log(`\n结果：通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('失败明细：');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log('限流处理自测全部通过。\n');
