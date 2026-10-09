// 端口工具：挑一个"真的能绑上"的本地端口，并记住上次成功用过的那个
// ---------------------------------------------------------------------------
// 背景：Windows 上 Hyper-V / WSL / Docker 会保留大段端口
//       （netsh int ipv4 show excludedportrange protocol=tcp 可查），
//       落到保留段里的端口 listen 会直接 EACCES —— WebView2 的
//       --remote-debugging-port 也一样开不起来，表现就是"外挂挂不上"。
// 所以不能只按"有没有被占用"判断，必须实际试绑一次。
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

/** 试绑一个端口：port=0 表示让系统分配。返回 { ok:true, port } 或 { ok:false, code } */
export function tryBind(port = 0, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    srv.once('error', (e) => {
      try {
        srv.close();
      } catch {}
      done({ ok: false, code: e.code || 'ERROR' });
    });
    srv.listen(port, host, () => {
      const p = srv.address().port;
      srv.close(() => done({ ok: true, port: p }));
    });
  });
}

/**
 * 从 start 起向上找可用端口；start=0 时让系统分配一个。
 * @returns {Promise<{port:number|null, reserved:number, used:number}>}
 *          reserved = 被系统保留（EACCES）的个数，used = 被其他程序占用的个数
 */
export async function findFreePort(start, tries = 60, host = '127.0.0.1') {
  let reserved = 0;
  let used = 0;
  const n = start === 0 ? 1 : tries;
  for (let i = 0; i < n; i++) {
    const r = await tryBind(start === 0 ? 0 : start + i, host);
    if (r.ok) return { port: r.port, reserved, used };
    if (r.code === 'EACCES') reserved++;
    else used++;
  }
  return { port: null, reserved, used };
}

/**
 * 决定本次使用的 CDP 调试端口。
 * @param {{preferred:number|number[], isReachable:(port:number)=>Promise<boolean>, scanTries?:number}} opts
 *        preferred 可以是数组，**顺序即优先级**（一般把"上次用过的端口"放前面）
 * @returns {Promise<{port:number, via:'reuse'|'bind'|'scan'|'ephemeral'|'none',
 *                    reserved:number, used:number, ephemeral:boolean, fromPreferred:boolean}>}
 */
export async function pickCdpPort({ preferred, isReachable, scanTries = 60 }) {
  const list = (Array.isArray(preferred) ? preferred : [preferred]).map(Number).filter((p) => p > 0);
  const candidates = [...new Set(list)];
  if (!candidates.length) candidates.push(9223);

  // 1) 任一候选上已经有调试端口在跑（上次 Gale 留下的）→ 直接沿用，别换
  for (const p of candidates) {
    if (await isReachable(p)) {
      return { port: p, via: 'reuse', reserved: 0, used: 0, ephemeral: false, fromPreferred: true };
    }
  }

  // 2) 任一候选可绑 → 用它（按候选顺序，即"上次用过的端口"优先）
  let reserved = 0;
  let used = 0;
  for (const p of candidates) {
    const r = await tryBind(p);
    if (r.ok) {
      return { port: p, via: 'bind', reserved, used, ephemeral: false, fromPreferred: true };
    }
    if (r.code === 'EACCES') reserved++;
    else used++;
  }

  // 3) 从第一个候选向上扫一段
  const scan = await findFreePort(candidates[0], scanTries);
  if (scan.port) {
    return {
      port: scan.port,
      via: 'scan',
      reserved: reserved + scan.reserved,
      used: used + scan.used,
      ephemeral: false,
      fromPreferred: false,
    };
  }

  // 4) 整段都被保留/占用 → 让系统分配一个临时端口（系统绝不会分配到保留段）
  const eph = await findFreePort(0, 1);
  if (eph.port) {
    return { port: eph.port, via: 'ephemeral', reserved: reserved + scan.reserved, used: used + scan.used, ephemeral: true, fromPreferred: false };
  }

  return { port: candidates[0], via: 'none', reserved: reserved + scan.reserved, used: used + scan.used, ephemeral: false, fromPreferred: false };
}

// ---------------------------------------------------------------- 端口记忆
/**
 * 读取"端口记忆"文件。记录上次真正用成功的调试端口，以及当时的配置端口——
 * 下次启动优先复用上次那个，除非用户改过配置端口。
 * @returns {{lastPort:number, configuredPort:number, updatedAt:string}}
 */
export function readPortMemory(file) {
  const empty = { lastPort: 0, configuredPort: 0, updatedAt: '' };
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      lastPort: Number(j.lastPort) || 0,
      configuredPort: Number(j.configuredPort) || 0,
      updatedAt: String(j.updatedAt || ''),
    };
  } catch {
    return empty;
  }
}

export function writePortMemory(file, { lastPort, configuredPort }) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const data = { lastPort: Number(lastPort) || 0, configuredPort: Number(configuredPort) || 0, updatedAt: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return data;
  } catch {
    return null;
  }
}

/**
 * 按"记忆 + 配置"算出候选端口顺序。
 * - 用户改过配置端口 → 配置优先（否则改了不生效，会很困惑）
 * - 否则 → 上次用成功的端口优先（避免每次都换、也避免又落到保留段）
 */
export function portCandidates({ configured, remembered, rememberedConfigured }) {
  const out = [];
  const push = (p) => {
    const n = Number(p) || 0;
    if (n > 0 && !out.includes(n)) out.push(n);
  };
  if (remembered && rememberedConfigured && rememberedConfigured !== configured) {
    push(configured);
    push(remembered);
  } else {
    push(remembered);
    push(configured);
  }
  return out;
}
