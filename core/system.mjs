// 系统集成：快捷方式接管 + 开机自启
// 目的：不再必须由 start.cmd 启动 Gale —— 接管桌面/开始菜单快捷方式后，
//      双击 Gale 图标就会带着调试端口启动，后台服务自动挂载。
// 说明：只改快捷方式与用户级注册表，不碰 Gale 本体的任何文件；改动前全部备份，可一键还原。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const BACKUP = path.join(DATA, 'shortcut-backup.json');
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = 'GaleTranslatorService';

const ps = (script, timeout = 30000) =>
  new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout, maxBuffer: 4 << 20 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || err?.message || '') }),
    );
  });

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

/** 生成隐藏窗口的辅助脚本（用 wscript 调用，不闪黑框） */
export function ensureHelpers() {
  fs.mkdirSync(path.join(ROOT, 'tools'), { recursive: true });
  const nodeExe = process.execPath;
  const launchVbs = path.join(ROOT, 'tools', 'launch-gale.vbs');
  const serviceVbs = path.join(ROOT, 'tools', 'service-hidden.vbs');
  const common = 'Set sh = CreateObject("WScript.Shell")\n';
  fs.writeFileSync(
    launchVbs,
    `${common}sh.CurrentDirectory = ${JSON.stringify(ROOT)}\nsh.Run """" & ${JSON.stringify(nodeExe)} & """ """ & ${JSON.stringify(path.join(ROOT, 'core', 'launcher.mjs'))} & """ --quiet", 0, False\n`,
    'utf8',
  );
  fs.writeFileSync(
    serviceVbs,
    `${common}sh.CurrentDirectory = ${JSON.stringify(ROOT)}\nsh.Run """" & ${JSON.stringify(nodeExe)} & """ """ & ${JSON.stringify(path.join(ROOT, 'core', 'server.mjs'))} & """", 0, False\n`,
    'utf8',
  );
  return { launchVbs, serviceVbs };
}

function findGaleShortcuts(galePath) {
  const exeName = path.basename(galePath || 'gale.exe');
  const script = `
$ErrorActionPreference='SilentlyContinue'
$sh = New-Object -ComObject WScript.Shell
$dirs = @("$env:PUBLIC\\Desktop", [Environment]::GetFolderPath('Desktop'), "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs", "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs")
$out = @()
foreach ($d in $dirs) {
  Get-ChildItem -Path $d -Filter *.lnk -Recurse | Where-Object { $_.Name -like '*Gale*' } | ForEach-Object {
    $t = $sh.CreateShortcut($_.FullName).TargetPath
    if ($t -and ((Split-Path $t -Leaf) -ieq ${q(exeName)})) {
      $out += [pscustomobject]@{ path = $_.FullName; target = $t }
    }
  }
}
$out | ConvertTo-Json -Compress
`;
  return ps(script).then((r) => {
    try {
      const v = JSON.parse(r.out.trim() || '[]');
      return Array.isArray(v) ? v : [v];
    } catch {
      return [];
    }
  });
}

/** 在用户自己的桌面创建「Gale 汉化」快捷方式（不需要管理员权限） */
export async function createUserShortcut(galePath, { onDesktop = true, inStartup = false } = {}) {
  const { launchVbs } = ensureHelpers();
  const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
  const dirs = [];
  if (onDesktop) dirs.push('[Environment]::GetFolderPath("Desktop")');
  if (inStartup) dirs.push('[Environment]::GetFolderPath("Startup")');
  if (!dirs.length) return { ok: false, error: '无需创建的快捷方式' };

  const script = `
$ErrorActionPreference='Stop'
$sh = New-Object -ComObject WScript.Shell
$made = @()
foreach ($d in @(${dirs.join(',')})) {
  $p = Join-Path $d 'Gale 汉化.lnk'
  $lnk = $sh.CreateShortcut($p)
  $lnk.TargetPath = ${q(wscript)}
  $lnk.Arguments = '"' + ${q(launchVbs)} + '"'
  $lnk.WorkingDirectory = ${q(ROOT)}
  $lnk.IconLocation = ${q(galePath + ',0')}
  $lnk.Description = '以汉化模式启动 Gale（自动开启调试端口并挂载翻译）'
  $lnk.Save()
  $made += $p
}
$made | ConvertTo-Json -Compress
`;
  const r = await ps(script, 40000);
  if (!r.ok) return { ok: false, error: r.err || '创建快捷方式失败' };
  let made = [];
  try {
    const v = JSON.parse(r.out.trim() || '[]');
    made = Array.isArray(v) ? v : [v];
  } catch {}
  return { ok: true, created: made };
}

/** 删除本外挂创建的快捷方式 */
export async function removeUserShortcut() {
  const script = `
$ErrorActionPreference='SilentlyContinue'
$n = 0
foreach ($d in @([Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("Startup"))) {
  $p = Join-Path $d 'Gale 汉化.lnk'
  if (Test-Path $p) { Remove-Item $p -Force; $n++ }
}
$n
`;
  const r = await ps(script, 20000);
  return { ok: true, removed: Number(r.out.trim() || 0) };
}

/** 生成"以管理员身份接管原有快捷方式"的辅助脚本（公共桌面/开始菜单需要管理员） */
export function writeElevatedHelper(galePath) {
  const { launchVbs } = ensureHelpers();
  const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
  const file = path.join(ROOT, '接管原Gale快捷方式-需管理员.cmd');
  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    'net session >nul 2>&1 || (echo 需要管理员权限：请右键本文件 -^> 以管理员身份运行 & pause & exit /b 1)',
    'echo 正在把 Gale 的原有快捷方式改为「汉化启动」…',
    `powershell -NoProfile -Command "$sh=New-Object -ComObject WScript.Shell; $paths=@(); foreach($d in @(\"$env:PUBLIC\\Desktop\",\"$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\")){ Get-ChildItem $d -Filter *.lnk -Recurse | Where-Object { $_.Name -like '*Gale*' } | ForEach-Object { $t=$sh.CreateShortcut($_.FullName).TargetPath; if($t -and (Split-Path $t -Leaf) -ieq '${path.basename(galePath)}'){ $paths += $_.FullName } } }; foreach($p in $paths){ $l=$sh.CreateShortcut($p); $l.TargetPath='${wscript.replace(/\\/g, '\\\\')}'; $l.Arguments='\\"${launchVbs}\\"'; $l.WorkingDirectory='${ROOT}'; $l.Save(); Write-Host ('已接管: ' + $p) }; if(-not $paths){ Write-Host '没找到可接管的快捷方式' }"`,
    'echo.',
    'echo 完成。想还原请运行 stop.cmd 后重新安装 Gale 快捷方式，或用设置面板的「还原」。',
    'pause',
  ];
  fs.writeFileSync(file, lines.join('\r\n'), 'utf8');
  return file;
}

/** 把 Gale 的快捷方式改成走本外挂（先备份原值）—— 公共桌面/开始菜单需要管理员 */
export async function enableShortcuts(galePath) {
  const { launchVbs } = ensureHelpers();
  const list = await findGaleShortcuts(galePath);
  if (!list.length) return { ok: false, error: '没找到指向 gale.exe 的快捷方式，请手动把快捷方式指向 tools\\launch-gale.vbs' };

  let backup = {};
  try {
    if (fs.existsSync(BACKUP)) backup = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
  } catch {}

  const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
  const script = `
$ErrorActionPreference='Stop'
$sh = New-Object -ComObject WScript.Shell
$paths = @(${list.map((x) => q(x.path)).join(',')})
foreach ($p in $paths) {
  $lnk = $sh.CreateShortcut($p)
  $lnk.TargetPath = ${q(wscript)}
  $lnk.Arguments = '"' + ${q(launchVbs)} + '"'
  $lnk.WorkingDirectory = ${q(ROOT)}
  $lnk.Save()
}
'ok'
`;
  const r = await ps(script);
  if (!r.ok) return { ok: false, error: r.err || '改写快捷方式失败' };

  for (const item of list) {
    backup[item.path] = { target: item.target, hijacked: true, ts: Date.now() };
  }
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(BACKUP, JSON.stringify(backup, null, 2), 'utf8');
  return { ok: true, count: list.length, paths: list.map((x) => x.path) };
}

/** 还原被接管的快捷方式（目标写回 gale.exe） */
export async function restoreShortcuts(galePath) {
  let backup = {};
  try {
    backup = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
  } catch {}
  const paths = Object.keys(backup).filter((p) => fs.existsSync(p));
  if (!paths.length) return { ok: true, count: 0 };
  const script = `
$ErrorActionPreference='Stop'
$sh = New-Object -ComObject WScript.Shell
$paths = @(${paths.map(q).join(',')})
foreach ($p in $paths) {
  $lnk = $sh.CreateShortcut($p)
  $lnk.TargetPath = ${q(galePath)}
  $lnk.Arguments = ''
  $lnk.WorkingDirectory = ${q(path.dirname(galePath))}
  $lnk.Save()
}
'ok'
`;
  const r = await ps(script);
  if (r.ok) {
    for (const p of paths) delete backup[p];
    fs.writeFileSync(BACKUP, JSON.stringify(backup, null, 2), 'utf8');
  }
  return r.ok ? { ok: true, count: paths.length } : { ok: false, error: r.err };
}

export async function enableAutostart() {
  const { serviceVbs } = ensureHelpers();
  const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
  const r = await ps(`reg add ${q(RUN_KEY)} /v ${RUN_NAME} /t REG_SZ /d ${q(`"${wscript}" "${serviceVbs}"`)} /f`);
  return r.ok ? { ok: true } : { ok: false, error: r.err };
}

export async function disableAutostart() {
  const r = await ps(`reg delete ${q(RUN_KEY)} /v ${RUN_NAME} /f`);
  return { ok: true, removed: r.ok };
}

/** 一键开启：先试接管原有快捷方式，失败则退回"创建用户级快捷方式"（不需要管理员） */
export async function enableIntegration(galePath) {
  const r = await enableShortcuts(galePath);
  const helper = writeElevatedHelper(galePath);
  if (r.ok) return { ok: true, mode: 'hijack', count: r.count, paths: r.paths };
  const u = await createUserShortcut(galePath, { onDesktop: true });
  return {
    ok: !!u.ok,
    mode: 'user-shortcut',
    created: u.created || [],
    hijackError: r.error,
    elevatedHelper: helper,
    note: '原有快捷方式在公共桌面/开始菜单，需要管理员权限才能改；已改为在你的桌面创建「Gale 汉化」快捷方式。若想连原图标一起接管，右键运行项目根目录下的「接管原Gale快捷方式-需管理员.cmd」。',
  };
}

/** 还原：撤掉用户级快捷方式与被接管的快捷方式 */
export async function disableIntegration(galePath) {
  const a = await restoreShortcuts(galePath);
  const b = await removeUserShortcut();
  return { ok: true, restored: a.count || 0, removed: b.removed || 0 };
}

export async function systemStatus(galePath) {
  const runKey = await ps(`reg query ${q(RUN_KEY)} /v ${RUN_NAME}`);
  let hijacked = [];
  try {
    const backup = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
    hijacked = Object.keys(backup).filter((p) => fs.existsSync(p));
  } catch {}
  const shortcuts = await findGaleShortcuts(galePath);
  const userLnk = await ps(
    `$p = Join-Path ([Environment]::GetFolderPath("Desktop")) 'Gale 汉化.lnk'; if (Test-Path $p) { 'yes' } else { 'no' }`,
    15000,
  );
  return {
    autostart: runKey.ok,
    hijackedCount: hijacked.length,
    hijacked,
    userShortcut: userLnk.out.trim() === 'yes',
    galeShortcuts: shortcuts.map((s) => s.path),
    launchHelper: path.join(ROOT, 'tools', 'launch-gale.vbs'),
  };
}
