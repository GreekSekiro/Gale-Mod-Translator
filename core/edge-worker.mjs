// 用真正的 Edge 当"端侧翻译后端"（worker）。
//
// 为什么需要它（实测结论，README 里有完整证据）：
//   · Translator API 的模型运行时是 Chromium 里 //chrome 层的组件（component updater，
//     组件名就叫 "Chrome TranslateKit"）；WebView2 不带这一层，所以 Gale 页面里
//     Translator.availability() **永远**是 'unavailable'，而且一个字节都不会下载。
//   · 同一台机器上的 Edge 浏览器没这个问题：实测 Edg/154.0.4258.62 能把 en→zh 语言包
//     （197.5 MB）下下来并离线翻译，输出正常中文。
// 于是插件自己拉起一个**无窗口**的 Edge 专门跑翻译：用户零安装、零密钥、零条款风险。
//
// 几个不显眼但必须这么做的点：
//   ① 用独立 profile（data/edge-profile），绝不碰用户日常浏览的那个 Edge profile；
//      语言包也就落在里面，所以「查看语言包占用 / 删除语言包」能直接复用现有实现。
//   ② 调试端口写 0（让浏览器自己挑），再读 profile 里的 DevToolsActivePort —— 本机 Windows
//      保留了好几个 TCP 端口段（netsh int ipv4 show excludedportrange protocol=tcp），
//      写死端口会**静默**拿不到调试端口（Edge 不报错，只是那个端口上没有服务），极难排查。
//   ③ 翻译页必须是 http://127.0.0.1（安全上下文）才暴露 Translator API，
//      所以 worker 页由本服务自己托管（见 server.mjs 的 /edge-worker 路由）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { CdpBridge } from './cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const PROFILE_DIR = path.join(ROOT, 'data', 'edge-profile');
export const PACK_DIRNAME = 'EdgeTranslateKitLanguagePack';
export const WORKER_PAGE_PATH = '/edge-worker';
export const WORKER_SCRIPT_PATH = '/edge-worker.js';

let bridge = null;
let pid = 0;
let port = 0;
let starting = null;
let lastError = '';
let lastStartAt = 0;
let onLog = () => {};

export function setWorkerLogger(fn) {
  onLog = typeof fn === 'function' ? fn : () => {};
}
function log(msg, level = 'info') {
  try {
    onLog(msg, level);
  } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (p) => {
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------- Edge 与语言包
/**
 * 找到可用的 Edge。允许用环境变量 `GALE_TRANS_EDGE_PATH` 指定（绿色版 / 非标准安装位置，
// 或者以后想换成别的 Chromium 内核浏览器做实验）。
 */
export function edgePath() {
  const custom = String(process.env.GALE_TRANS_EDGE_PATH || '').trim();
  if (custom) {
    try {
      if (fs.existsSync(custom)) return custom;
    } catch {}
  }
  const roots = [process.env['ProgramFiles(x86)'], process.env['ProgramFiles'], process.env['LOCALAPPDATA']].filter(Boolean);
  for (const r of roots) {
    const p = path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return '';
}

/** 本机有没有 Edge。界面用这个说清楚"为什么内置引擎不能用"（不是所有机器都装了 Edge）。 */
export function hasEdge() {
  return !!edgePath();
}

export function packPath() {
  return path.join(PROFILE_DIR, PACK_DIRNAME);
}

// 语言包目录名不能写死：它来自 Edge 的组件名（"Chrome TranslateKit"），换 Edge 版本或
// 语言对都可能变，实测这一版叫 EdgeTranslateKitLanguagePack。按名字模式找更稳。
// 与 server.mjs 的 LANG_PACK_RE 保持一致：**不能加 ^ 锚定**，实测目录名是
// EdgeTranslateKitLanguagePack（前面带 Edge 前缀），写成 /^TranslateKit/ 会一个都匹配不到。
export const PACK_DIR_RE = /TranslateKit.*LanguagePack$/i;

/** 有边界的目录大小统计（别在超大目录上卡住） */
export function dirBytes(dir, maxEntries = 30000) {
  let n = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length && seen < maxEntries) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      seen++;
      const p = path.join(cur, e.name);
      try {
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile()) n += fs.statSync(p).size;
      } catch {}
    }
  }
  return n;
}

/** profile 顶层里所有"像语言包"的目录 */
export function packDirs() {
  let entries;
  try {
    entries = fs.readdirSync(PROFILE_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || !PACK_DIR_RE.test(e.name)) continue;
    const p = path.join(PROFILE_DIR, e.name);
    out.push({ path: p, bytes: dirBytes(p) });
  }
  return out;
}

export function packInstalled() {
  return packDirs().length > 0;
}

export function packBytes() {
  return packDirs().reduce((a, d) => a + d.bytes, 0);
}

/** 给 server.mjs 的 findLanguagePacks() 用：把 worker profile 里的语言包也报进去 */
export function packEntry() {
  const dirs = packDirs();
  if (!dirs.length) return null;
  return { path: dirs[0].path, bytes: dirs.reduce((a, d) => a + d.bytes, 0) };
}

/** 真正的端侧模型不可能这么小：小于它就是下载中断留下的空壳（实测空壳目录 0 字节） */
export const PACK_REAL_MIN_BYTES = 5 * 1024 * 1024;

/** 整个语言包目录里有没有真东西 */
export function packLooksReal() {
  return packInstalled() && packBytes() >= PACK_REAL_MIN_BYTES;
}

/**
 * 某个语言对的语言包目录。实测布局是 `EdgeTranslateKitLanguagePack\en-zh` ——
 * 语言包是**按语言对**下的，所以"pack 目录里有 197 MB"不代表用户要的这一对也在。
 */
export function pairPackDirs(source, target) {
  const [s, t] = pairKey(source, target).split('>');
  const out = [];
  for (const d of packDirs()) {
    for (const name of [`${s}-${t}`, `${s}_${t}`, `${s}.${t}`]) {
      const p = path.join(d.path, name);
      try {
        if (fs.statSync(p).isDirectory()) out.push({ path: p, bytes: dirBytes(p) });
      } catch {}
    }
  }
  return out;
}

export function pairPackBytes(source, target) {
  return pairPackDirs(source, target).reduce((a, d) => a + d.bytes, 0);
}

/** 目录在、里面却是空的（下载中断的残骸） */
export function stubPairPack(source, target) {
  const b = pairPackBytes(source, target);
  return b > 0 && b < PACK_REAL_MIN_BYTES;
}

/**
 * 磁盘上"有语言包的样子，却没有真东西"—— 这就是 Edge 会骗人的那种坏状态。
 * 反过来，只要真有完整语言包在，任何判断都不许把它当成坏的（否则会白白重下 200 MB）。
 */
export function packLooksBroken(source, target) {
  if (!packInstalled()) return true;
  if (!packLooksReal()) return true;
  return stubPairPack(source, target);
}

/** 整个 profile 的占用（语言包 + Edge 自己的组件缓存，实测后者也有近 200 MB） */
export function profileBytes() {
  return dirBytes(PROFILE_DIR);
}

/**
 * 删掉整个 worker profile。
 *
 * 为什么必须删**整个 profile**，而不是只删语言包目录（实测结论，别改回去）：
 *   只删 EdgeTranslateKitLanguagePack 时，Edge 的组件登记还在（Local State +
 *   component_crx_cache 里那个 178 MB 的 CRX），于是新起的 worker 里
 *   Translator.availability() 照样报 'available'，但 Translator.create() 抛
 *   "Unable to create translator for the given source and target language."，
 *   而且**永远不会重新下载** —— 用户看到的就是"删掉之后再也没法用"。
 *   清空整个 profile 之后 availability() 回到 'downloadable'，下载、翻译都正常。
 */
export async function wipeProfile() {
  const freed = profileBytes();
  await stopWorker();
  let lastErr = '';
  for (let i = 0; i < 8; i++) {
    try {
      fs.rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (e) {
      lastErr = (e && e.message) || String(e);
    }
    if (!fs.existsSync(PROFILE_DIR)) return { ok: true, path: PROFILE_DIR, freedBytes: freed, failed: false };
    // Windows 上 Edge 的子进程可能还捏着几个文件，等它松手再试
    await sleep(250);
  }
  lastErr = lastErr || '目录仍被其它进程占用';
  log(`清空浏览器数据失败：${PROFILE_DIR} —— ${lastErr}`, 'warn');
  return { ok: false, path: PROFILE_DIR, freedBytes: 0, failed: true, error: lastErr };
}

// ---------------------------------------------------------------- 自带语言包（seed）
// 目的：让"没有网络 / 下载很慢 / 想开箱即用"的人不必先下 200 MB。做法是允许随包带一份
// 已经下好的 profile 快照，放在下面两个位置之一即可被认出来：
//     <项目>/data/edge-pack/      （开发时用 tools/export-edge-pack.mjs 生成）
//     <项目>/edge-pack/           （发布时把压缩包解开放在这里）
// 一份能用的 seed 需要**两样**东西（2026-XX 二分法实测，详见 tools/export-edge-pack.mjs 顶部注释）：
//     ① `EdgeTranslateKitLanguagePack/`：语言包本体（约 197.5 MB）—— 也是"这是不是一个 seed"的判据；
//     ② `EdgeLLMRuntime/`：跑模型的 onnxruntime-genai（约 3.3 MB）。缺 ② 时 Edge 会认为语言包
//        装好了，但 `Translator.create()` 永远报 `Unable to create translator…`，
//        availability 一直停在 `downloadable` 且**不会**重新下载 —— 正是最难查的那种坏法。
//     （`component_crx_cache` 与 `Local State` 都实测**不需要**，所以 seed 里不带，也就不含账号信息。）
//
// 三条铁律（用户明确要求"自带语言包但不能妨碍下载"）：
//   ① 只在本机**没有**完整语言包时才动用 seed —— 已经下好了绝不覆盖；
//   ② seed 是**复制**过去，不是移动：删掉语言包后还能再吃一次，用户也可以选择删掉这个目录；
//   ③ 任何一步失败都只是"退回下载"，不许把事情搞坏（调用方照常走原下载流程）。
export function seedProfileDir() {
  const cands = [path.join(ROOT, 'data', 'edge-pack'), path.join(ROOT, 'edge-pack')];
  for (const d of cands) {
    try {
      if (!fs.statSync(d).isDirectory()) continue;
      const has = fs.readdirSync(d, { withFileTypes: true }).some((e) => e.isDirectory() && PACK_DIR_RE.test(e.name));
      if (has) return d;
    } catch {}
  }
  return '';
}

/** seed 里有没有跑模型要用的 EdgeLLMRuntime（onnxruntime-genai） */
export function seedRuntimeReady(dir) {
  const d = dir || seedProfileDir();
  if (!d) return false;
  try {
    return fs
      .readdirSync(path.join(d, 'EdgeLLMRuntime'), { withFileTypes: true })
      .some((e) => e.isDirectory());
  } catch {
    return false;
  }
}

/** 本机 profile 里有没有 EdgeLLMRuntime（自带语言包铺开之后应该就有） */
function runtimeInProfile() {
  try {
    return fs
      .readdirSync(path.join(PROFILE_DIR, 'EdgeLLMRuntime'), { withFileTypes: true })
      .some((e) => e.isDirectory());
  } catch {
    return false;
  }
}

/** 给界面用：自带语言包在不在、有多大、里面有没有模型运行时 */
export function seedInfo() {
  const d = seedProfileDir();
  if (!d) return { ready: false, path: '', bytes: 0, runtime: false };
  return { ready: true, path: d, bytes: dirBytes(d), runtime: seedRuntimeReady(d) };
}

/**
 * 删掉随包自带的那份语言包（用户要省磁盘时用）。
 * 为什么单独一个函数：自带的那份**不在** Edge 的 profile 里，删它不需要停 worker、
 * 也不影响已经装好的内置引擎 —— 只是"以后重装要联网下载"。
 * 删完 seedInfo().ready 自然变 false，advanceSeed 这条通路就自动退回下载。
 */
export function removeSeed() {
  const d = seedProfileDir();
  if (!d) return { ok: false, path: '', freedBytes: 0, error: '没有找到自带语言包' };
  const bytes = dirBytes(d);
  try {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    // 兜底清一次父目录：<项目>/data/edge-pack 删掉后 data/ 还得留着（里面还有别的运行时数据）
    log(`已删除自带语言包：${d}（释放 ${(bytes / 1048576).toFixed(1)} MB）`);
    return { ok: true, path: d, freedBytes: bytes, error: '' };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    log('删除自带语言包失败：' + msg, 'warn');
    return { ok: false, path: d, freedBytes: 0, error: msg };
  }
}


/**
 * 「打开语言包位置」用：挑一个真实存在的目录交给资源管理器。
 * 顺序：语言包本身所在目录（profile 里的 EdgeTranslateKitLanguagePack）→ profile 根 →
 * 自带那份（data/edge-pack）→ data/（连没下载过也能看到"以后会下到哪儿"）。
 */
export function revealTarget() {
  const cands = [path.join(PROFILE_DIR, 'EdgeTranslateKitLanguagePack'), PROFILE_DIR, seedProfileDir(), path.join(ROOT, 'data')];
  for (const d of cands) {
    if (!d) continue;
    try {
      if (fs.statSync(d).isDirectory()) return d;
    } catch {}
  }
  return path.join(ROOT, 'data');
}

/** 同步递归复制（跨盘时 rename 会失败，只能老老实实拷） */function copyTreeSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const t = path.join(dst, e.name);
    if (e.isDirectory()) copyTreeSync(s, t);
    else if (e.isFile()) fs.copyFileSync(s, t);
  }
}

/**
 * 把自带语言包铺进 worker profile（没有自带 / 已有完整语言包 / 出错时都只是返回说明）。
 * 由 launch() 在启动浏览器之前调用。
 */
export async function adoptSeed() {
  const seed = seedProfileDir();
  if (!seed) return { adopted: false, reason: '没有自带语言包' };
  if (packLooksReal()) return { adopted: false, reason: '本机已经有完整语言包，不需要用自带的' };
  const bytes = dirBytes(seed);
  // 缺 EdgeLLMRuntime 的 seed 用了也白用（会变成"怎么也建不出翻译器"），宁可直接走下载
  if (!seedRuntimeReady(seed)) {
    log('自带的语言包里没有模型运行时（EdgeLLMRuntime），这次不用它，改走正常下载', 'warn');
    return { adopted: false, from: seed, bytes, error: '自带语言包缺少 EdgeLLMRuntime（跑模型用的 onnxruntime-genai）' };
  }
  try {
    await stopWorker();
    // 残留的半成品必须先清掉：新旧混在一起时 Edge 的组件登记会对不上，
    // 那正是"删了语言包就再也下不回来"的根因（见 wipeProfile 的注释）。
    if (fs.existsSync(PROFILE_DIR)) {
      fs.rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
    fs.mkdirSync(path.dirname(PROFILE_DIR), { recursive: true });
    // 一律复制：自带的那份留着，用户下次删了语言包不用再下 200 MB
    // （想省空间可以自己删掉 data/edge-pack，README 里写了）。
    copyTreeSync(seed, PROFILE_DIR);
    // 用自带的这份之后，本机马上就该有真语言包与运行时；没有就说明这份 seed 本身是坏的
    if (!packLooksReal()) {
      return { adopted: false, from: seed, bytes, error: '自带的语言包不完整（里面没有真正的模型文件）' };
    }
    if (!runtimeInProfile()) {
      return { adopted: false, from: seed, bytes, error: '自带的语言包里没有模型运行时（EdgeLLMRuntime）' };
    }
    log(`已铺开自带语言包（${(bytes / 1048576).toFixed(1)} MB，复制自 ${seed}），不用联网下载`);
    return { adopted: true, from: seed, bytes, how: 'copy' };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    log('铺开自带语言包失败（继续走下载）：' + msg, 'warn');
    return { adopted: false, from: seed, bytes, error: msg };
  }
}

// ---------------------------------------------------------------- 进程管理
const PS = process.env['SystemRoot']
  ? path.join(process.env['SystemRoot'], 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

/** 找出所有"用了我们 profile"的 Edge 进程。
 *  为什么必须查：Edge 对同一个 --user-data-dir 只允许一个实例 —— 如果上一次的 worker
 *  还活着，新起的那个会**直接挂到老实例上**并且忽略新的 --remote-debugging-port，
 *  结果就是我们永远读不到自己的端口（表现为"启动成功但连不上"）。 */
function listWorkerPids() {
  return new Promise((resolve) => {
    const cmd = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${PROFILE_DIR}*' } | ForEach-Object { $_.ProcessId }`;
    execFile(PS, ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 20000, windowsHide: true }, (_err, stdout) => {
      const pids = String(stdout || '')
        .split(/\s+/)
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      resolve(pids);
    });
  });
}

async function killWorkerProcesses() {
  const pids = await listWorkerPids();
  if (!pids.length) return 0;
  await Promise.all(
    pids.map(
      (p) =>
        new Promise((res) => {
          try {
            execFile('taskkill', ['/PID', String(p), '/T', '/F'], { windowsHide: true }, () => res());
          } catch {
            res();
          }
        }),
    ),
  );
  await sleep(700);
  return pids.length;
}

async function waitReady(timeout = 30000) {
  const deadline = Date.now() + timeout;
  let lastErr = '';
  while (Date.now() < deadline) {
    if (pid && !alive(pid)) throw new Error('Edge 翻译后端中途退出了');
    try {
      const ok = await bridge.evaluate('!!(window.__edgeTrans && window.__edgeTrans.ready)', { timeout: 4000 });
      if (ok) return true;
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(300);
  }
  throw new Error('Edge 翻译后端页面没能就绪（30 秒超时）' + (lastErr ? '：' + lastErr : ''));
}

async function launch(servicePort) {
  const exe = edgePath();
  if (!exe) {
    throw new Error(
      '这台机器上没有找到 Microsoft Edge。内置引擎用的是浏览器自带的端侧翻译模型，需要一个 Edge 148+（装在标准位置，或者用环境变量 GALE_TRANS_EDGE_PATH 指定 msedge.exe）。' +
        '没装 Edge 也可以用「本地大模型（Ollama）」或「本机 LibreTranslate」，或者到设置里换一个在线节点。',
    );
  }
  // 有自带语言包就先铺开，省掉 200 MB 下载（没有 / 已经装好 / 出错都会自动退回下载）
  try {
    await adoptSeed();
  } catch (e) {
    log('铺开自带语言包异常（继续走下载）：' + ((e && e.message) || e), 'warn');
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const portFile = path.join(PROFILE_DIR, 'DevToolsActivePort');
  try {
    fs.rmSync(portFile, { force: true });
  } catch {}

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--remote-allow-origins=*',
    // 0 = 让浏览器自己挑一个空闲端口（避开 Windows 保留端口段），实际端口写在 DevToolsActivePort 里
    '--remote-debugging-port=0',
    `--user-data-dir=${PROFILE_DIR}`,
    `http://127.0.0.1:${servicePort}${WORKER_PAGE_PATH}`,
  ];
  log(`启动本地翻译后端（无窗口 Edge）：${exe}`);
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
  pid = child.pid || 0;
  child.unref?.();
  lastStartAt = Date.now();

  const deadline = Date.now() + 25000;
  let chosen = 0;
  while (Date.now() < deadline) {
    await sleep(250);
    if (pid && !alive(pid)) throw new Error('Edge 翻译后端启动后立刻退出了');
    try {
      const line = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0].trim();
      const n = parseInt(line, 10);
      if (Number.isFinite(n) && n > 0) {
        chosen = n;
        break;
      }
    } catch {}
  }
  if (!chosen) throw new Error('Edge 翻译后端没能在 25 秒内开出调试端口');
  port = chosen;
  log(`本地翻译后端已启动（PID ${pid}，调试端口 ${port}）`);

  bridge = new CdpBridge({
    port,
    servicePort,
    onLog: (m) => log(m, 'debug'),
    pickPage: (targets) =>
      (targets || []).find((t) => t.type === 'page' && String(t.url || '').startsWith(`http://127.0.0.1:${servicePort}${WORKER_PAGE_PATH}`)) || null,
    pageLabel: 'Edge 翻译后端页面',
  });
  bridge.start();
  await waitReady();
}

export function workerInfo() {
  const exe = edgePath();
  const seed = seedInfo();
  return {
    available: !!exe,
    edgePath: exe,
    running: !!(pid && alive(pid)),
    attached: !!(bridge && bridge.attached),
    starting: !!starting,
    pid: pid || 0,
    port: port || 0,
    profile: PROFILE_DIR,
    packInstalled: packInstalled(),
    packPath: packPath(),
    seedReady: seed.ready,
    seedPath: seed.path,
    seedBytes: seed.bytes,
    seedRuntime: seed.runtime,
    runtimeInstalled: runtimeInProfile(),
    lastError,
    startedAt: lastStartAt || 0,
  };
}

/** 确保 worker 在跑并且页面就绪。并发调用只会真正启动一次。 */
export async function ensureWorker({ servicePort } = {}) {
  if (workerInfo().attached) return workerInfo();
  if (starting) {
    await starting.catch(() => {});
    return workerInfo();
  }
  starting = (async () => {
    try {
      // 先清干净：残留进程会抢 profile，导致新实例的调试端口读不到
      try {
        bridge?.stop();
      } catch {}
      bridge = null;
      await killWorkerProcesses();
      await launch(servicePort);
      lastError = '';
    } catch (e) {
      lastError = (e && e.message) || String(e);
      try {
        bridge?.stop();
      } catch {}
      bridge = null;
      await killWorkerProcesses();
      throw new Error(lastError);
    }
  })();
  try {
    await starting;
  } finally {
    starting = null;
  }
  return workerInfo();
}

export async function stopWorker() {
  try {
    bridge?.stop();
  } catch {}
  bridge = null;
  const n = await killWorkerProcesses();
  pid = 0;
  port = 0;
  return n;
}

export async function evaluateWorker(expression, opts = {}) {
  if (!bridge || !bridge.attached) throw new Error('Edge 翻译后端还没就绪');
  return bridge.evaluate(expression, opts);
}

// ---------------------------------------------------------------- 语言码映射
/** 与页面里的 localLang() 保持一致：Translator API 只认 'zh' / 'zh-Hant' */
export function localLang(code) {
  const c = String(code || '').toLowerCase();
  if (!c || c === 'auto') return 'en';
  if (c.startsWith('zh')) return /hant|tw|hk|mo/.test(c) ? 'zh-Hant' : 'zh';
  return c.split('-')[0];
}
export function pairKey(source, target) {
  return localLang(source) + '>' + localLang(target);
}

/** worker 没在跑时的状态：从磁盘上语言包在不在来推断（不用为了看一眼状态就拉起浏览器） */
function diskStatus(source, target) {
  const installed = packInstalled();
  const real = packLooksReal();
  const pairBytes = pairPackBytes(source, target);
  const stub = stubPairPack(source, target);
  const broken = installed && !real ? true : stub;
  // 认得出用户要的这一对的目录时（>0）就以它为准；认不出来就退回"有语言包就算就绪"
  const ready = installed && real && (pairBytes === 0 || pairBytes >= PACK_REAL_MIN_BYTES);
  const key = pairKey(source, target);
  const seed = seedInfo();
  return {
    supported: true,
    backend: 'edge',
    workerRunning: false,
    env: ready ? 'ready' : 'needDownload',
    unusable: false,
    ready,
    stalePack: broken,
    preparing: null,
    lastError: '',
    wantKey: key,
    pairs: {},
    reason: ready
      ? ''
      : broken
        ? '本地模型文件不完整（可能被删过或上次没下完）：点「启用内置引擎」会清掉旧数据重新下载'
        : seed.ready && seed.runtime
          ? '内置引擎的语言包还没铺开：点「启用内置引擎」或「下载语言包」，插件自带的那份会直接装好，不用联网下载'
          : '内置引擎的语言包还没下载好：请在设置里点一下「启用内置引擎」',
  };
}

/**
 * 把页面报的状态和磁盘对一遍。
 *
 * 要抓的坏状态（用户报的"删掉之后没法重新下载"）有两种长相，实测都遇到过：
 *   ⓐ 语言包目录被整个删掉，但 Edge 的组件登记还认为装着 → 页面报 ready/available，磁盘上空的。
 *   ⓑ 下载中断留下一个**空壳目录**（实测 `EdgeTranslateKitLanguagePack\en-zh` 0 字节），
 *      于是"目录在不在"判断不出来 —— 页面报 downloadable，但 create() 1ms 内抛错，
 *      而且永远不真的去下载。
 * 两种都必须如实报成"需要重新下载"，否则用户看到"已就绪"点翻译只得到一句泛化失败，
 * 或者看到"首次启用约需下载 200 MB"却怎么点都没反应。
 * 只认 'available'：'downloadable' 表示"能下、还没下"，正常情况下那是待下载状态。
 */
function withStaleCheck(st, source, target) {
  const claimsReady = !!(st.ready || Object.values(st.pairs || {}).some((v) => v === 'available'));
  const stale =
    (!packInstalled() && claimsReady) || // ⓐ 页面说就绪，磁盘上连目录都没有
    (packInstalled() && !packLooksReal()) || // ⓑ 有目录却没真东西（空壳）
    stubPairPack(source, target); // ⓒ 有真语言包，但用户要的这一对是空壳
  if (!stale) return st;
  const seed = seedInfo();
  return {
    ...st,
    env: 'needDownload',
    ready: false,
    unusable: false,
    stalePack: true,
    reason:
      seed.ready && seed.runtime
        ? '本地模型文件不完整（可能被删过或上次没下完）：点「启用内置引擎」会清掉旧数据，用插件自带的那份重新装好，不用联网下载'
        : '本地模型文件不完整（可能被删过或上次没下完）：点「启用内置引擎」会清掉旧数据重新下载',
  };
}

export async function workerStatus(source, target) {
  if (!workerInfo().attached) return diskStatus(source, target);
  const st = await evaluateWorker(
    `(async () => (window.__edgeTrans ? await window.__edgeTrans.localStatus(${JSON.stringify(source)}, ${JSON.stringify(target)}) : null))()`,
    { timeout: 25000 },
  );
  if (!st || typeof st !== 'object') throw new Error('Edge 翻译后端没有返回状态');
  return withStaleCheck({ ...st, backend: 'edge', workerRunning: true }, source, target);
}

/** 一次 prepare 尝试（就是原来那段"等一小会儿看有没有立刻出结果"的逻辑） */
async function attemptPrepare(source, target, waitMs) {
  const task = evaluateWorker(
    `(async () => {
        const T = window.__edgeTrans;
        if (!T || typeof T.localPrepare !== 'function') return { ok: false, error: 'Edge 翻译后端页面里没有翻译引擎' };
        try { return await T.localPrepare(${JSON.stringify(source)}, ${JSON.stringify(target)}); }
        catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
      })()`,
    { timeout: 600000 },
  );
  // 与 Gale 后端那条路一样：**不能无条件报 started:true**。环境不提供端侧模型时页面里的
  // localPrepare 会立刻抛错，那样界面就一直显示"已开始下载"，用户永远等不到进度也看不到原因。
  // 先等一小会儿看有没有"立刻出结果"：立刻失败就如实回报，真在下载（近 200 MB）才转后台。
  const settled = await Promise.race([
    task.then((r) => ({ settled: true, r })).catch((e) => ({ settled: true, err: e })),
    new Promise((r) => setTimeout(() => r({ settled: false }), waitMs)),
  ]);
  if (!settled.settled) {
    task
      .then((r) => log('语言包准备结果：' + JSON.stringify(r)))
      .catch((e) => log('语言包准备失败：' + e.message, 'warn'));
    return { ok: true, started: true };
  }
  if (settled.err) return { ok: false, started: false, error: settled.err.message || String(settled.err) };
  const r = settled.r;
  if (r && r.ok === false) return { ok: false, started: false, error: r.error || '未能开始下载' };
  return { ok: true, started: true, result: r };
}

/** Edge 的组件登记和磁盘对不上时，create() 抛的就是这句（实测两种坏状态都一样） */
const CORRUPT_RE = /Unable to create translator|NotSupportedError/i;

/** 清空 profile + 重新起 worker，然后重试一次 prepare */
async function repairAndRetry(source, target, servicePort, waitMs, why) {
  log(`检测到本地模型数据已损坏（${why}）：清空内置浏览器的数据后重新下载`, 'warn');
  const w = await wipeProfile();
  if (w.ok) log(`已清空内置浏览器数据：${w.path}（释放 ${(w.freedBytes / 1048576).toFixed(1)} MB）`);
  else log('清空内置浏览器数据失败：' + (w.error || '未知原因'), 'warn');
  await ensureWorker({ servicePort });
  return attemptPrepare(source, target, waitMs);
}

export async function workerPrepare(source, target, { servicePort, waitMs = 1500, repair = true } = {}) {
  await ensureWorker({ servicePort });
  // 自愈第一层：状态层面就能看出来的坏状态（页面说就绪/能下，磁盘上却是空的或只有空壳）
  if (repair) {
    try {
      const st = await workerStatus(source, target);
      // st.preparing 为真说明下载正在进行中：这时别清空重来（会把已经下到一半的进度扔掉）
      if (st && st.stalePack && !st.preparing) return repairAndRetry(source, target, servicePort, waitMs, '语言包文件不完整');
    } catch (e) {
      log('检查语言包状态失败：' + ((e && e.message) || e), 'warn');
    }
  }
  const r = await attemptPrepare(source, target, waitMs);
  // 自愈第二层：状态层面看不出来、只有 create() 会暴露的那种 —— Edge 认为"可以下载"，
  // 组件登记却与实际文件对不上，create() 立刻抛错且永远不发起下载。此时磁盘上也没有真正的
  // 语言包（packLooksReal() 为假），清空重来是安全且唯一有效的做法。
  if (repair && r.ok === false && CORRUPT_RE.test(r.error || '') && !packLooksReal()) {
    return repairAndRetry(source, target, servicePort, waitMs, '创建翻译器一直失败且磁盘上没有完整语言包');
  }
  return r;
}

export async function workerTranslate(texts, { source, target } = {}, { servicePort } = {}) {
  await ensureWorker({ servicePort });
  const out = await evaluateWorker(
    `(async () => {
        const T = window.__edgeTrans;
        if (!T || typeof T.localTranslate !== 'function') return { __error: 'Edge 翻译后端页面里没有翻译引擎' };
        try { return { ok: await T.localTranslate(${JSON.stringify(texts)}, ${JSON.stringify({ source: source || 'auto', target: target || 'zh-CN' })}) }; }
        catch (e) { return { __error: (e && e.message) || String(e) }; }
      })()`,
    { timeout: 180000 },
  );
  if (out && out.__error) throw new Error(out.__error);
  if (!Array.isArray(out && out.ok) || out.ok.length !== texts.length) {
    throw new Error('Edge 翻译后端返回条目数不匹配');
  }
  return out.ok;
}

export async function workerReset() {
  if (!workerInfo().attached) return { ok: true, cleared: 0, workerRunning: false };
  const r = await evaluateWorker(
    `(async () => (window.__edgeTrans && window.__edgeTrans.localReset) ? await window.__edgeTrans.localReset() : { ok: true, cleared: 0 })()`,
    { timeout: 20000 },
  );
  return r && typeof r === 'object' ? r : { ok: true };
}
