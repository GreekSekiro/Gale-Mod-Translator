// 把"已经下好的端侧翻译模型"打包成随发布一起发的 data/edge-pack，
// 让别人装上插件就能用内置引擎，不必先联网下 200 MB（用户在意的就是这一点）。
//
// 用法（在项目根目录跑）：
//   node tools/export-edge-pack.mjs               # 精简：语言包 + EdgeLLMRuntime（实测约 201 MB）
//   node tools/export-edge-pack.mjs --full        # 整个 profile（最保险，也最大）
//   node tools/export-edge-pack.mjs --out <目录>  # 换输出目录
//
// 为什么精简版这两样就够（实测结论，2026-XX）：
//   Edge 的端侧翻译模型由两部分组成 ——
//     ① `EdgeTranslateKitLanguagePack/`：语言包本体（实测 197.5 MB，按语言对分目录）；
//     ② `EdgeLLMRuntime/<版本>/onnxruntime-genai.dll`：真正跑模型的 ONNX Runtime GenAI（实测 3.27 MB）。
//   把这两样搬进一个**全新**的 profile，Translator 就能直接翻译。少 ② 会退化成"状态说可用、
//   create() 立刻报错 `Unable to create translator for the given source and target language.`、
//   而且 availability 一直停在 downloadable、永远不重新下载"——因为它以为语言包已经装好了，
//   只是跑不起来。用二分法在"能用的 profile"上逐个移出顶层项实测，②就是唯一的必要条件。
//   另外两样**不需要**（都实测过）：
//     · `component_crx_cache/<hash>`（那个 178 MB 的 CRX）—— 移掉照样能翻；
//     · `Local State`（组件登记）—— 移掉照样能翻。不带它还有个好处：它是 Edge 自己的全局状态，
//       里面记着导出者登录的账号信息（`profile.info_cache`），不该跟着发布包发出去。
//
// 产物不进 git（`.gitignore` 忽略 data/）：发布时把它压成 zip 挂到 GitHub Release，
// 用户解压到项目根或 data/ 下即可（core/edge-worker.mjs 的 seedProfileDir() 认这两个位置）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILE_DIR, PACK_DIR_RE, dirBytes } from '../core/edge-worker.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const full = args.includes('--full');
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 && args[outIdx + 1] ? path.resolve(args[outIdx + 1]) : path.join(ROOT, 'data', 'edge-pack');

// 这些是"跑起来之后自己会重建"的东西，带过去只会白白变大，甚至引起锁定问题
const SKIP_DIRS = new Set(['Crashpad', 'GPUPersistentCache', 'GrShaderCache', 'ShaderCache', 'BrowserMetrics']);
const SKIP_FILES = [/^DevToolsActivePort$/i, /^lockfile$/i, /^Singleton/i, /\.pma$/i, /^Last Browser$/i];

function copyTree(src, dst, { depth = 0 } = {}) {
  fs.mkdirSync(dst, { recursive: true });
  let bytes = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (depth === 0 && (SKIP_DIRS.has(e.name) || SKIP_FILES.some((re) => re.test(e.name)))) continue;
    const s = path.join(src, e.name);
    const t = path.join(dst, e.name);
    if (e.isDirectory()) bytes += copyTree(s, t, { depth: depth + 1 });
    else if (e.isFile()) {
      fs.copyFileSync(s, t);
      bytes += fs.statSync(t).size;
    }
  }
  return bytes;
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return fs.statSync(dst).size;
}

function main() {
  if (!fs.existsSync(PROFILE_DIR)) {
    console.error(`找不到 ${PROFILE_DIR} —— 先让插件把语言包下下来（设置页「启用内置引擎」/「下载语言包」）再导出。`);
    process.exit(1);
  }
  const packs = fs.readdirSync(PROFILE_DIR, { withFileTypes: true }).filter((e) => e.isDirectory() && PACK_DIR_RE.test(e.name));
  if (!packs.length) {
    console.error(`${PROFILE_DIR} 里没有语言包目录（${PACK_DIR_RE}）—— 先把语言包下好。`);
    process.exit(1);
  }

  if (fs.existsSync(OUT)) {
    const b = dirBytes(OUT);
    console.log(`输出目录已存在，先清掉：${OUT}（${(b / 1048576).toFixed(1)} MB）`);
    fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }

  let total = 0;
  if (full) {
    console.log(`复制整个 profile → ${OUT}`);
    total = copyTree(PROFILE_DIR, OUT);
  } else {
    // ① 语言包本体
    for (const p of packs) {
      console.log(`· 语言包：${p.name}`);
      total += copyTree(path.join(PROFILE_DIR, p.name), path.join(OUT, p.name));
    }
    // ② ONNX Runtime GenAI（跑语言包模型的可执行组件，缺了它 create() 直接失败）
    const runtimeDir = path.join(PROFILE_DIR, 'EdgeLLMRuntime');
    if (fs.existsSync(runtimeDir)) {
      console.log('· 模型运行时：EdgeLLMRuntime（onnxruntime-genai）');
      total += copyTree(runtimeDir, path.join(OUT, 'EdgeLLMRuntime'));
    } else {
      console.warn('· 没找到 EdgeLLMRuntime —— 精简版一定不完整（内置引擎会一直报"无法创建翻译器"），建议改用 --full');
    }
  }

  console.log(`\n导出完成：${OUT}`);
  console.log(`大小：${(total / 1048576).toFixed(1)} MB（${full ? '整份 profile' : '精简版'}）`);
  if (full) {
    console.log('⚠ --full 会把导出者 Edge 的登录状态一起带上（Local State / Default 里的账号信息），');
    console.log('  对外发布前建议改用精简版（语言包 + EdgeLLMRuntime 就够，实测可跑）。');
  }
  console.log('发布时把它压成 zip 挂到 GitHub Release；用户解压到项目根或 data/ 下即可，');
  console.log('插件启动内置引擎时会自动铺开（不用联网），也可以照旧走下载。');
}

main();
