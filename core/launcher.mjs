// Gale 汉化外挂 · 启动器
// 由 start.cmd 调用。所有中文输出都由 Node 负责（避免 cmd 代码页问题）。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildId } from './build.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, 'data', 'runtime.json');
const cfgPath = path.join(ROOT, 'config.json');
// 本次代码指纹：和正在跑的服务对不上就重启它（避免"改了代码但旧服务还在跑"）
const BUILD_ID = buildId();

const cfg = {
  galePath: 'D:\\Gale\\gale.exe',
  cdpPort: 9223,
  ...(fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {}),
};

// --quiet：供快捷方式/自启调用，不打印、不询问（Gale 没带调试端口就直接重开）
const quiet = process.argv.includes('--quiet');

const say = (s = '') => {
  if (!quiet) console.log(s);
};
const ok = (s) => say('  [√] ' + s);
const warn = (s) => say('  [!] ' + s);
const step = (n, s) => say(`\n[${n}/3] ${s}`);

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) =>
    rl.question(q, (a) => {
      rl.close();
      res(a.trim().toLowerCase());
    }),
  );
}

function exec(cmd, args) {
  return new Promise((res) =>
    execFile(cmd, args, { windowsHide: true }, (err, stdout) => res({ err, stdout: stdout || '' })),
  );
}

async function galeRunning() {
  const { stdout } = await exec('tasklist', ['/FI', 'IMAGENAME eq gale.exe', '/NH']);
  return /gale\.exe/i.test(stdout);
}

/** 从上次记录的端口起扫一小段，返回第一个有调试端口在听的端口号（0 = 没有）。
 *  之所以要扫一段：服务端在端口被占用时会自动改用后续端口，这里必须跟着走。 */
async function cdpReachable() {
  let base = cfg.cdpPort;
  try {
    const j = JSON.parse(fs.readFileSync(RUNTIME, 'utf8'));
    if (j.cdpPort) base = j.cdpPort;
  } catch {}
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${base + i}/json/version`, { signal: AbortSignal.timeout(1200) });
      if (r.ok) return base + i;
    } catch {}
  }
  return 0;
}

/** 读 runtime.json 并确认那个端口上的服务真的活着；返回它的状态快照 */
async function serviceInfo() {
  try {
    const j = JSON.parse(fs.readFileSync(RUNTIME, 'utf8'));
    if (!j.port) return null;
    const r = await fetch(`http://127.0.0.1:${j.port}/api/status`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    return { port: j.port, pid: j.pid, ...(await r.json()) };
  } catch {}
  return null;
}

/** 等某个端口上的服务关掉（连不上就算关掉了） */
async function portFree(port, timeoutMs = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(600) });
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** 关掉正在跑的服务：优先走 /api/shutdown；老版本没有这个接口，就按 runtime.json 里的 pid 结束 */
async function shutdownService(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) });
  } catch {}
  if (await portFree(port, 3000)) return true;
  try {
    const j = JSON.parse(fs.readFileSync(RUNTIME, 'utf8'));
    if (j.pid) await exec('taskkill', ['/PID', String(j.pid), '/F']);
  } catch {}
  return portFree(port, 4000);
}

async function main() {
  // 兜底：快捷方式模式下，任何环节失败都要保证 Gale 仍能正常打开（只是没有汉化）
  if (quiet) {
    try {
      await run();
    } catch (e) {
      try {
        spawn(cfg.galePath, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      } catch {}
      process.exit(0);
    }
    return;
  }
  await run();
}

async function run() {
  say('============================================');
  say('   Gale 汉化外挂 · 启动器');
  say('============================================');

  step(1, '检查 Gale 运行状态 …');
  const running = await galeRunning();
  const hasCdp = await cdpReachable();
  if (running && !hasCdp) {
    warn('Gale 正在运行，但没有开启调试端口，外挂无法挂载。');
    if (quiet) {
      // 快捷方式模式：直接接管重开，不打断用户
      await exec('taskkill', ['/IM', 'gale.exe', '/F']);
      await new Promise((r) => setTimeout(r, 2000));
    } else {
      warn('（Gale 必须由本启动器拉起，或在启动前完全退出，包括托盘图标）');
      const a = await ask('  是否关闭 Gale 并重新以调试模式启动？(y/N) ');
      if (a !== 'y' && a !== 'yes') {
        say('\n已取消。请手动完全退出 Gale 后重新运行 start.cmd。\n');
        process.exit(1);
      }
      await exec('taskkill', ['/IM', 'gale.exe', '/F']);
      await new Promise((r) => setTimeout(r, 2000));
    }
  } else if (running && hasCdp) {
    ok(`Gale 已以调试模式运行（端口 ${hasCdp}），将直接挂载。`);
  } else {
    ok('Gale 未运行，稍后由服务拉起。');
  }

  step(2, '启动本地翻译服务 …');
  let svc = await serviceInfo();
  if (svc && svc.buildId !== BUILD_ID) {
    // 代码更新过但后台还是旧进程 —— 直接换掉，否则改了等于没改
    warn(`后台服务还是旧代码（${svc.version || '未知版本'} / 指纹 ${svc.buildId || '无'}），正在重启…`);
    const stopped = await shutdownService(svc.port);
    if (!stopped) warn('旧服务没能关掉，可能需要在任务管理器里结束 node.exe 后重试。');
    svc = await serviceInfo();
  }
  if (svc) {
    ok(`服务已在运行（端口 ${svc.port}），跳过启动。`);
  } else {
    fs.rmSync(RUNTIME, { force: true });
    const child = spawn(process.execPath, [path.join(__dirname, 'server.mjs')], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: ROOT,
    });
    child.unref();
    let port = null;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 400));
      port = (await serviceInfo())?.port;
      if (port) break;
    }
    if (!port) {
      warn('服务启动超时，请查看 logs\\service.log');
      if (quiet) {
        // 兜底：服务起不来也要让用户能开 Gale
        spawn(cfg.galePath, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
        process.exit(0);
      }
      process.exit(1);
    }
    ok(`服务已就绪： http://127.0.0.1:${port}/`);
  }

  step(3, '启动 Gale 并注入翻译 …');
  const port = (await serviceInfo())?.port || 8799;
  if (!(await galeRunning())) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/launch-gale`, { method: 'POST', signal: AbortSignal.timeout(10000) });
      const j = await r.json();
      ok(j.ok ? '已以调试模式启动 Gale。' : '启动 Gale 失败，请到设置面板检查 Gale 路径。');
    } catch (e) {
      warn('调用启动接口失败：' + e.message);
    }
  } else {
    ok('Gale 已在运行。');
  }
  ok('页面右下角出现悬浮控制条即表示挂载成功。');
  if (quiet) return; // 快捷方式模式：到此为止，不弹任何窗口
  say('');
  say('  设置面板： http://127.0.0.1:' + port + '/');
  say('  停止外挂： 运行 stop.cmd');
  say('  日志文件： logs\\service.log');
  say('');

  const firstRun = path.join(ROOT, 'data', '.first-run');
  if (!fs.existsSync(firstRun)) {
    spawn('cmd.exe', ['/c', 'start', '""', `http://127.0.0.1:${port}/`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    fs.mkdirSync(path.dirname(firstRun), { recursive: true });
    fs.writeFileSync(firstRun, 'done');
    say('  已为你打开设置面板（首次运行）。');
  }
  say('提示：若 Gale 里没有出现悬浮控制条，请先完全退出 Gale，再重新运行 start.cmd。');
}

main().catch((e) => {
  console.error('[错误] ' + e.message);
  process.exit(1);
});
