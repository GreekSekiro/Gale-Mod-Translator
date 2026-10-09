// 模糊复用自测：验证"只差版本号 / 标点 / 空白"的句子能命中已有译文，且版本号正确回填。
// 用法: node tools/test-fuzzy.mjs   （退出码非 0 表示失败）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fuzzyKey, transplantVersions, Translator } from '../core/translate.mjs';
import { Cache } from '../core/cache.mjs';
import { Library } from '../core/library.mjs';

let pass = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  [√] ${name}`);
  } else {
    fails.push(name + (extra ? ` —— ${extra}` : ''));
    console.log(`  [×] ${name}${extra ? ' —— ' + extra : ''}`);
  }
}
const eq = (name, a, b) => ok(name, a === b, `期望 ${JSON.stringify(b)}，得到 ${JSON.stringify(a)}`);

console.log('\n一、fuzzyKey 归一化');
eq('版本号被忽略', fuzzyKey('Adds loot to Valheim v1.2.3'), fuzzyKey('Adds loot to Valheim v2.0.0'));
eq('大小写被忽略', fuzzyKey('Adds Loot'), fuzzyKey('adds loot'));
eq('标点被忽略', fuzzyKey('Adds loot, magic items, and enchanting.'), fuzzyKey('Adds loot magic items and enchanting'));
eq('空白/换行被忽略', fuzzyKey('Adds   loot\n\n to Valheim'), fuzzyKey('adds loot to valheim'));
ok('纯数字差异仍能区分', fuzzyKey('adds 3 items') !== fuzzyKey('adds 5 items'), '单数字不应被当成版本号');
ok('句意不同不会撞键', fuzzyKey('Adds loot to Valheim') !== fuzzyKey('Removes loot from Valheim'));

console.log('\n二、transplantVersions 版本号回填');
eq(
  '版本号按序替换',
  transplantVersions('Requires Jotunn v2.1.0', '需要 Jotunn v2.1.0 前置', 'Requires Jotunn v2.14.3'),
  '需要 Jotunn v2.14.3 前置',
);
eq(
  '多个版本号按序替换',
  transplantVersions('Works with 1.0.0 and 1.1.0', '兼容 1.0.0 与 1.1.0', 'Works with 9.9.9 and 8.8.8'),
  '兼容 9.9.9 与 8.8.8',
);
eq('无版本号时原样复用', transplantVersions('Adds loot', '增加掉落物', 'Adds loot.'), '增加掉落物');
eq('版本号数量不一致则放弃复用', transplantVersions('Works with 1.0.0', '兼容 1.0.0', 'Works with 1.0.0 and 2.0.0'), null);

console.log('\n三、translate() 端到端：模糊命中零请求');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gale-fuzzy-'));
const cache = new Cache(path.join(tmp, 'cache.json'));
const library = new Library(path.join(tmp, 'library.json'));
const cfg = {
  provider: 'cache-only',
  fallback: [],
  target: 'zh-CN',
  source: 'auto',
  proxy: '',
  fuzzyReuse: true,
  library: { autoCollect: true },
  glossary: [],
  phraseMap: {},
  postReplace: [],
};
const tr = new Translator({ cache, library, getConfig: () => cfg, log: () => {} });

// 预置一条已有译文
cache.set('Requires Jotunn v2.1.0 to craft the new sword.', 'cache-only', 'zh-CN', '需要 Jotunn v2.1.0 才能制作新剑。');

const out = await tr.translate(['Requires Jotunn v2.14.3 to craft the new sword.'], {});
eq('模糊命中', out[0].provider, 'fuzzy');
eq('版本号已回填', out[0].dst, '需要 Jotunn v2.14.3 才能制作新剑。');
eq('模糊命中计数 +1', tr.stats.fuzzyHits, 1);
eq('未发起任何节点请求', tr.stats.requests, 0);
ok('命中结果已固化为精确缓存', cache.get('Requires Jotunn v2.14.3 to craft the new sword.', 'cache-only', 'zh-CN') === out[0].dst);

// 关掉开关后应退回"未命中"
cfg.fuzzyReuse = false;
const out2 = await tr.translate(['Requires Jotunn v3.0.0 to craft the new sword.'], {});
ok('关掉 fuzzyReuse 后不再模糊复用', out2[0].provider !== 'fuzzy', `实际 provider=${out2[0].provider}`);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n结果：通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('失败明细：');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log('模糊复用自测全部通过。\n');
