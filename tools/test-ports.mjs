// 端口选择与端口记忆自测
// 背景：Windows 上 Hyper-V / WSL / Docker 保留的端口段，listen 会直接 EACCES，
//       必须实际试绑才能判断，不能只看"有没有被占用"。
// 用法: node tools/test-ports.mjs
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tryBind, findFreePort, pickCdpPort, readPortMemory, writePortMemory, portCandidates } from '../core/ports.mjs';

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

/** 占住一个端口，返回 { port, close } */
function occupy() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => srv.close() }));
  });
}

console.log('\n一、tryBind 试绑');

const r0 = await tryBind(0);
ok('tryBind(0) 让系统分配一个可用端口', r0.ok === true && r0.port > 0, JSON.stringify(r0));

const held = await occupy();
const rHeld = await tryBind(held.port);
ok('tryBind 对已占用端口返回 ok:false', rHeld.ok === false, JSON.stringify(rHeld));
ok('占用错误码是 EADDRINUSE', rHeld.code === 'EADDRINUSE', String(rHeld.code));

console.log('\n二、findFreePort 跳过被占用的端口');

const scan = await findFreePort(held.port, 8);
ok('能找到一个可用端口', scan.port > 0, JSON.stringify(scan));
ok('找到的端口不是被占用的那个', scan.port !== held.port, `${scan.port} vs ${held.port}`);
ok('记录了被占用的个数', scan.used >= 1, JSON.stringify(scan));

const eph = await findFreePort(0, 1);
ok('findFreePort(0,1) 返回系统分配的端口', eph.port > 0, JSON.stringify(eph));

const none = await findFreePort(held.port, 0);
ok('tries=0 时返回 port:null（表示这段都不行）', none.port === null, JSON.stringify(none));

held.close();

console.log('\n三、pickCdpPort 决策（preferred 支持数组，顺序即优先级）');

const freeBase = (await findFreePort(0, 1)).port;

const reuse = await pickCdpPort({ preferred: freeBase, isReachable: async () => true });
ok('已有调试端口在跑 → 沿用（via=reuse）', reuse.via === 'reuse' && reuse.port === freeBase, JSON.stringify(reuse));

const isFree = await pickCdpPort({ preferred: freeBase, isReachable: async () => false });
ok('候选端口空闲 → 直接用它（via=bind）', isFree.via === 'bind' && isFree.port === freeBase, JSON.stringify(isFree));

const held2 = await occupy();
const occ = await pickCdpPort({ preferred: held2.port, isReachable: async () => false });
ok('首选被占用 → 向上扫到别的端口（via=scan）', occ.via === 'scan' && occ.port !== held2.port, JSON.stringify(occ));
held2.close();

// 多候选：第一个被占用、第二个可用 → 应该用第二个（"上次用过的端口优先"就是这么生效的）
const held3 = await occupy();
const freeB = (await findFreePort(0, 1)).port;
const multi = await pickCdpPort({ preferred: [held3.port, freeB], isReachable: async () => false });
ok('多候选：跳过不可用的第一个，用第二个', multi.via === 'bind' && multi.port === freeB, JSON.stringify(multi));
held3.close();

const reuseMulti = await pickCdpPort({ preferred: [1, freeB], isReachable: async (p) => p === freeB });
ok('多候选：任一候选上已有调试端口 → 沿用', reuseMulti.via === 'reuse' && reuseMulti.port === freeB, JSON.stringify(reuseMulti));

// 候选被占用 + 不允许向上扫（scanTries=0）→ 模拟"整段都不可用"（例如落在 Windows 保留段里）
const held4 = await occupy();
const ephPick = await pickCdpPort({ preferred: held4.port, isReachable: async () => false, scanTries: 0 });
held4.close();
ok('整段都不可用 → 兜底到系统分配（via=ephemeral）', ephPick.via === 'ephemeral' && ephPick.ephemeral === true, JSON.stringify(ephPick));
ok('兜底端口真的能绑上（即不在系统保留段）', (await tryBind(ephPick.port)).ok === true, String(ephPick.port));

console.log('\n四、端口记忆');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gale-ports-'));
const memFile = path.join(tmp, 'ports.json');

ok('文件不存在时返回空记忆', (() => {
  const m = readPortMemory(memFile);
  return m.lastPort === 0 && m.configuredPort === 0;
})());

writePortMemory(memFile, { lastPort: 9581, configuredPort: 9223 });
const m1 = readPortMemory(memFile);
ok('写入后能读回 lastPort', m1.lastPort === 9581, JSON.stringify(m1));
ok('写入后能读回 configuredPort', m1.configuredPort === 9223, JSON.stringify(m1));
ok('记录了时间戳', !!m1.updatedAt, m1.updatedAt);

fs.writeFileSync(memFile, '{ 坏掉的 json', 'utf8');
ok('文件损坏时不抛异常、返回空记忆', readPortMemory(memFile).lastPort === 0);
fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n五、候选顺序（端口记忆优先）');

const same = portCandidates({ configured: 9223, remembered: 9581, rememberedConfigured: 9223 });
ok('配置没改过 → 上次成功的端口优先', same[0] === 9581 && same[1] === 9223, JSON.stringify(same));

const changed = portCandidates({ configured: 9500, remembered: 9581, rememberedConfigured: 9223 });
ok('用户改过配置端口 → 配置优先（避免改了不生效）', changed[0] === 9500 && changed[1] === 9581, JSON.stringify(changed));

const noMem = portCandidates({ configured: 9223, remembered: 0, rememberedConfigured: 0 });
ok('没有记忆时只剩配置端口', noMem.length === 1 && noMem[0] === 9223, JSON.stringify(noMem));

const dedup = portCandidates({ configured: 9581, remembered: 9581, rememberedConfigured: 9581 });
ok('两者相同时去重', dedup.length === 1, JSON.stringify(dedup));

console.log(`\n结果：通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('失败明细：');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log('端口选择与端口记忆自测全部通过。\n');
