// Gale 汉化外挂 · 停止
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, 'data', 'runtime.json');

const say = (s = '') => console.log(s);
const exec = (cmd, args) => new Promise((res) => execFile(cmd, args, { windowsHide: true }, (e, o) => res({ e, o: o || '' })));

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) =>
    rl.question(q, (a) => {
      rl.close();
      res(a.trim().toLowerCase());
    }),
  );
}

async function main() {
  say('============================================');
  say('   Gale 汉化外挂 · 停止');
  say('============================================');
  let stopped = false;
  try {
    const j = JSON.parse(fs.readFileSync(RUNTIME, 'utf8'));
    if (j.pid) {
      await exec('taskkill', ['/PID', String(j.pid), '/T', '/F']);
      say(`  [√] 已结束翻译服务（PID ${j.pid}）`);
      stopped = true;
    }
  } catch {}
  if (!stopped) {
    // 兜底：按命令行匹配
    const ps =
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*core\\server.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
    await exec('powershell', ['-NoProfile', '-Command', ps]);
    say('  [√] 已按进程名结束翻译服务');
  }
  fs.rmSync(RUNTIME, { force: true });

  const a = await ask('\n是否同时关闭 Gale？(y/N) ');
  if (a === 'y' || a === 'yes') {
    await exec('taskkill', ['/IM', 'gale.exe', '/F']);
    say('  [√] Gale 已关闭');
  }
  say('\n已停止。翻译缓存保留在 data\\cache.json，下次启动直接复用。\n');
}

main().catch((e) => {
  console.error('[错误] ' + e.message);
  process.exit(1);
});
