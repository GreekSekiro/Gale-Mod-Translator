// 打包发布：把项目（不含运行时数据）压成 dist/Gale-Mod-Translator-v<版本>.zip
// 用法: node tools/package.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, `stage-${version}`);
const TARGET = path.join(STAGE, 'Gale-Mod-Translator');

// test/.tmp 是测试跑的临时目录（无头 Edge 缓存 + 下载的语言包，几百 MB），发布包必须排掉
const EXCLUDE = new Set(['.git', 'data', 'logs', 'dist', 'config.json', 'node_modules', '.tmp']);

// 运行时按本机情况生成的辅助脚本：里面的路径是本机的绝对路径，绝不能进发布包
// （core/system.mjs 的 ensureHelpers() / makeTakeoverHelper() 需要时会重新生成）
const GENERATED = new Set(['launch-gale.vbs', 'service-hidden.vbs', '接管原Gale快捷方式-需管理员.cmd']);

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name) || GENERATED.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

fs.rmSync(STAGE, { recursive: true, force: true });
copyDir(ROOT, TARGET);
fs.writeFileSync(path.join(TARGET, 'VERSION'), version + '\n');

const zip = path.join(DIST, `Gale-Mod-Translator-v${version}.zip`);
fs.rmSync(zip, { force: true });
execFileSync(
  'powershell',
  ['-NoProfile', '-Command', `Compress-Archive -Path '${TARGET}' -DestinationPath '${zip}' -Force`],
  { stdio: 'inherit' },
);
fs.rmSync(STAGE, { recursive: true, force: true });

const kb = (fs.statSync(zip).size / 1024).toFixed(0);
console.log(`打包完成: ${zip}  (${kb} KB, 版本 ${version})`);
