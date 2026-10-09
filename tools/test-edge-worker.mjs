// 内置引擎的「Edge 离线翻译后端」自测（离线：不下载语言包、不拉起浏览器）
//
// 背景：Gale 用的 WebView2 不提供端侧翻译模型（见 README 的 ⚠ 一节），所以内置引擎
// 改成由插件自己拉起一个**无窗口的 Edge**来跑模型（core/edge-worker.mjs + core/edge-worker-page.js）。
// 这里只做「契约」级别的自测：常量、语言码映射、状态形状、以及几处踩过坑的源码约束。
// 真正的端到端（会下 ~197.5 MB 语言包，之后秒级）是 tools/test-builtin.mjs 那种玩法，手动跑。
//
// 用法: node tools/test-edge-worker.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROFILE_DIR,
  PACK_DIRNAME,
  PACK_DIR_RE,
  PACK_REAL_MIN_BYTES,
  WORKER_PAGE_PATH,
  WORKER_SCRIPT_PATH,
  edgePath,
  packPath,
  packDirs,
  dirBytes,
  packInstalled,
  packBytes,
  packLooksReal,
  packLooksBroken,
  pairPackDirs,
  pairPackBytes,
  stubPairPack,
  profileBytes,
  wipeProfile,
  packEntry,
  hasEdge,
  seedProfileDir,
  seedRuntimeReady,
  seedInfo,
  adoptSeed,
  workerInfo,
  workerStatus,
  workerPrepare,
  workerReset,
  localLang,
  pairKey,
  setWorkerLogger,
} from '../core/edge-worker.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
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

console.log('\n一、常量与路径');
ok('页面路径是 /edge-worker', WORKER_PAGE_PATH === '/edge-worker', WORKER_PAGE_PATH);
ok('脚本路径是 /edge-worker.js', WORKER_SCRIPT_PATH === '/edge-worker.js', WORKER_SCRIPT_PATH);
ok('语言包目录名跟 Edge 自己用的一致', PACK_DIRNAME === 'EdgeTranslateKitLanguagePack', PACK_DIRNAME);
ok('profile 落在仓库的 data/edge-profile', PROFILE_DIR === path.join(ROOT, 'data', 'edge-profile'), PROFILE_DIR);
ok('语言包路径 = profile/语言包目录', packPath() === path.join(PROFILE_DIR, PACK_DIRNAME), packPath());
// 踩过的坑：一开始写成 /^TranslateKit.*LanguagePack$/，而真实目录名是
// EdgeTranslateKitLanguagePack（Edge 带前缀），加了 ^ 一个都匹配不到 → 认不出语言包。
ok('语言包按正则识别（不带 ^ 锚定，Edge 加前缀也认得）', PACK_DIR_RE.test('EdgeTranslateKitLanguagePack') && PACK_DIR_RE.test('TranslateKitLanguagePack'), String(PACK_DIR_RE));
ok('语言包正则带 $ 锚定（不误伤别的目录）', !PACK_DIR_RE.test('EdgeTranslateKitLanguagePackBackup'), String(PACK_DIR_RE));
ok('语言包正则不带 ^（带 ^ 就认不出 Edge 的前缀了）', String(PACK_DIR_RE).includes('^') === false, String(PACK_DIR_RE));
ok('profile 不跟 test-builtin 的临时 profile 混用', !PROFILE_DIR.includes(path.join('test', '.tmp')), PROFILE_DIR);

console.log('\n二、别把 200 MB 的语言包提交进 git');
const gi = read('.gitignore');
ok('.gitignore 忽略了 data/（profile 与语言包都在里面）', /^\s*data\/?\s*$/m.test(gi), gi.split('\n').filter((l) => /data/.test(l)).join(' | '));
ok('.gitignore 忽略了 test/.tmp（test-builtin 的 profile）', /^\s*test\/\.tmp\/?\s*$/m.test(gi), gi.split('\n').filter((l) => /tmp/.test(l)).join(' | '));

console.log('\n三、Edge 可执行文件与语言包探测');
const exe = edgePath();
ok('edgePath() 返回字符串', typeof exe === 'string', typeof exe);
ok('edgePath() 要么是空（没装 Edge），要么指向真实存在的 msedge.exe', !exe || (fs.existsSync(exe) && path.basename(exe).toLowerCase() === 'msedge.exe'), exe);
ok('packInstalled() 是布尔值', typeof packInstalled() === 'boolean', String(packInstalled()));
const pdirs = packDirs();
ok('packDirs() 返回数组', Array.isArray(pdirs), typeof pdirs);
ok('packDirs() 只收名字匹配 TranslateKit*LanguagePack 的目录', pdirs.every((d) => d && typeof d.path === 'string' && typeof d.bytes === 'number' && PACK_DIR_RE.test(path.basename(d.path))), JSON.stringify(pdirs));
ok('packInstalled() = 「找到至少一个语言包目录」', packInstalled() === pdirs.length > 0, `installed=${packInstalled()} dirs=${pdirs.length}`);
ok('packBytes() 是非负数字', typeof packBytes() === 'number' && packBytes() >= 0, String(packBytes()));
ok('packBytes() = 各语言包目录之和', packBytes() === pdirs.reduce((n, d) => n + d.bytes, 0), `${packBytes()} vs ${pdirs.reduce((n, d) => n + d.bytes, 0)}`);
const entry = packEntry();
ok('packEntry() 是 null 或 {path, bytes}', entry === null || (typeof entry.bytes === 'number' && PACK_DIR_RE.test(path.basename(String(entry.path)))), JSON.stringify(entry));
ok('语言包目录存在时 packBytes() 接近 197.5 MB（±20 MB）', !packInstalled() || Math.abs(packBytes() - 197.5 * 1024 * 1024) < 20 * 1024 * 1024, `${(packBytes() / 1048576).toFixed(1)} MB`);
ok('packLooksReal() = 「有目录且体积像真的」（≥5 MB，专治下到一半的空壳目录）', packLooksReal() === (packInstalled() && packBytes() >= PACK_REAL_MIN_BYTES), `real=${packLooksReal()} installed=${packInstalled()} bytes=${packBytes()}`);
ok('PACK_REAL_MIN_BYTES 是 5 MB', PACK_REAL_MIN_BYTES === 5 * 1024 * 1024, String(PACK_REAL_MIN_BYTES));
ok('profileBytes() ≥ packBytes()（语言包就在 profile 里）', profileBytes() >= packBytes(), `${profileBytes()} vs ${packBytes()}`);
const pbytes = pairPackBytes('en', 'zh-CN');
ok('pairPackBytes() 是数字（en-zh 那份，没有就是 0）', typeof pbytes === 'number' && pbytes >= 0, String(pbytes));
ok('pairPackDirs() 只返回真实存在的目录', pairPackDirs('en', 'zh-CN').every((d) => fs.existsSync(d.path)), JSON.stringify(pairPackDirs('en', 'zh-CN')));
ok('stubPairPack() 是布尔值', typeof stubPairPack('en', 'zh-CN') === 'boolean', String(stubPairPack('en', 'zh-CN')));
ok('packLooksBroken() 是布尔值', typeof packLooksBroken('en', 'zh-CN') === 'boolean', String(packLooksBroken('en', 'zh-CN')));
ok('wipeProfile() 是异步函数（有语言包时不能在这里真跑，只验契约）', wipeProfile.constructor.name === 'AsyncFunction', wipeProfile.constructor.name);

console.log('\n三之二、自带语言包（seed）');
ok('hasEdge() 是布尔值，且与 edgePath() 一致', typeof hasEdge() === 'boolean' && hasEdge() === !!edgePath(), `hasEdge=${hasEdge()} path=${JSON.stringify(edgePath())}`);
ok('seedProfileDir() 返回字符串（没有自带语言包时是空串）', typeof seedProfileDir() === 'string', JSON.stringify(seedProfileDir()));
const seed = seedInfo();
ok('seedInfo() 是 {ready, path, bytes, runtime}', !!seed && typeof seed === 'object'
  && typeof seed.ready === 'boolean' && typeof seed.path === 'string'
  && typeof seed.bytes === 'number' && typeof seed.runtime === 'boolean', JSON.stringify(seed));
ok('seedInfo().ready 为真时 seedProfileDir() 必须非空', !seed.ready || !!seed.path, JSON.stringify(seed));
ok('seedInfo().runtime 为真时 ready 也得为真（运行时单独存在不算 seed）', !seed.runtime || seed.ready, JSON.stringify(seed));
ok('seedProfileDir() 只认 data/edge-pack 或 <ROOT>/edge-pack', !seed.path || [path.join(ROOT, 'data', 'edge-pack'), path.join(ROOT, 'edge-pack')].includes(seed.path), String(seed.path));
ok('seedRuntimeReady() 是布尔值', typeof seedRuntimeReady() === 'boolean', String(seedRuntimeReady()));
ok('seedRuntimeReady(不存在的目录) = false', seedRuntimeReady(path.join(ROOT, 'data', '__no_such_seed__')) === false);
ok('adoptSeed() 是异步函数', adoptSeed.constructor.name === 'AsyncFunction', adoptSeed.constructor.name);
// 二分实测结论：seed 必须同时有语言包 + EdgeLLMRuntime（onnxruntime-genai.dll），
// 缺运行时的话 Edge 会永远停在 downloadable 且不重下。
const rtDir = path.join(ROOT, 'data', 'edge-pack', 'EdgeLLMRuntime');
ok('自带语言包里若带 EdgeLLMRuntime，它就含 onnxruntime-genai.dll', !fs.existsSync(rtDir) || fs.readdirSync(rtDir).some((d) => fs.existsSync(path.join(rtDir, d, 'onnxruntime-genai.dll'))), rtDir);

console.log('\n四、语言码映射（必须和页面里的 localLang 一致）');
const langCases = [
  ['zh', 'zh'],
  ['zh-CN', 'zh'],
  ['zh-Hans', 'zh'],
  ['zh-TW', 'zh-Hant'],
  ['zh-HK', 'zh-Hant'],
  ['zh-Hant', 'zh-Hant'],
  ['en', 'en'],
  ['en-US', 'en'],
  ['ja', 'ja'],
  ['pt-BR', 'pt'],
  ['', 'en'],
  ['auto', 'en'],
  [undefined, 'en'],
];
for (const [input, want] of langCases) {
  ok(`localLang(${JSON.stringify(input)}) = ${want}`, localLang(input) === want, localLang(input));
}
ok("pairKey('en','zh') = 'en>zh'", pairKey('en', 'zh') === 'en>zh', pairKey('en', 'zh'));
ok("pairKey('auto','zh-CN') = 'en>zh'（auto 当英文）", pairKey('auto', 'zh-CN') === 'en>zh', pairKey('auto', 'zh-CN'));

console.log('\n五、状态形状');
const info = workerInfo();
ok('workerInfo() 带 available / running / attached / starting', [info.available, info.running, info.attached, info.starting].every((v) => typeof v === 'boolean'), JSON.stringify(info));
ok('workerInfo() 的 profile / packPath 与模块常量一致', info.profile === PROFILE_DIR && info.packPath === packPath(), JSON.stringify({ profile: info.profile, packPath: info.packPath }));
ok('workerInfo() 的 pid / port 是数字（没跑时为 0）', typeof info.pid === 'number' && typeof info.port === 'number', JSON.stringify({ pid: info.pid, port: info.port }));
ok('workerInfo() 的 lastError 是字符串', typeof info.lastError === 'string', String(info.lastError));
ok('workerInfo() 的 seedRuntime / runtimeInstalled 是布尔值（界面据此说清能不能铺开自带语言包）',
  typeof info.seedRuntime === 'boolean' && typeof info.runtimeInstalled === 'boolean', JSON.stringify({ seedRuntime: info.seedRuntime, runtimeInstalled: info.runtimeInstalled }));

setWorkerLogger(() => {}); // 别把日志打到测试输出里
const st = await workerStatus('en', 'zh-CN');
ok('workerStatus() 在没拉起浏览器时也能给出结论（纯磁盘推断）', !!st && typeof st === 'object', JSON.stringify(st));
ok('workerStatus() 标了 backend=edge', st.backend === 'edge', String(st.backend));
ok('workerStatus() 的 wantKey 归一化成 en>zh', st.wantKey === 'en>zh', String(st.wantKey));
ok('workerStatus() 的 ready 跟语言包是否在磁盘上一致', st.ready === packInstalled(), `ready=${st.ready} installed=${packInstalled()}`);
ok('workerStatus() 的 env 是 ready / needDownload', ['ready', 'needDownload'].includes(st.env), String(st.env));
ok('workerStatus() 的 unusable 是 false（有 Edge 就还能救）', st.unusable === false, String(st.unusable));
ok('workerStatus() 的 lastError 是字符串', typeof st.lastError === 'string', String(st.lastError));
ok('没下完语言包时给出可操作的提示', st.ready || /启用内置引擎/.test(String(st.reason)), String(st.reason));

const rst = await workerReset();
ok('workerReset() 在后端没跑时也不抛错', rst && rst.ok === true, JSON.stringify(rst));

console.log('\n六、源码约束（这几条都踩过坑）');
const page = read('core/edge-worker-page.js');
ok('worker 页面脚本暴露 window.__edgeTrans', /__edgeTrans/.test(page));
ok('worker 页面脚本实现了 localStatus / localPrepare / localTranslate / localReset', ['localStatus', 'localPrepare', 'localTranslate', 'localReset'].every((k) => page.includes(k)));
ok('worker 页面脚本不写死"Gale 的 WebView2"（它在真 Edge 里跑）', !/WebView2/.test(page.replace(/^\s*\/\/.*$/gm, '')));
ok('worker 页面脚本的不可用文案是中性的（不说 WebView2）', /当前运行环境不提供端侧翻译模型，内置引擎无法使用/.test(page));
ok('worker 页面脚本也认 197.5 MB 这个估算值', /197\.5/.test(page));

const srv = read('core/server.mjs');
ok('server.mjs 起了 /edge-worker 页面路由', srv.includes('WORKER_PAGE_PATH'));
ok('server.mjs 起了 /edge-worker.js 脚本路由', srv.includes('WORKER_SCRIPT_PATH'));
ok('server.mjs 把语言包入口加进 findLanguagePacks（否则删不掉 worker 的语言包）', /packEntry\(\)/.test(srv) && /found\.set\(we\.path/.test(srv));
// 曾经的 bug：把 applyLocalEngineStatus() 的精简缓存当 API 结果返回，supported/pairs/preparing 全没了，
// 抽屉于是掉进「当前浏览器不支持内置引擎」分支。
ok('readLocalEngineStatus 返回的是页面/后端报的原始状态（不是精简缓存）', /return \{ \.\.\.gale, backend: 'gale'/.test(srv) && /return \{ \.\.\.st, backend: 'edge'/.test(srv));
ok('本地翻译后端由 localBackend() 分流（gale / edge）', /function localBackend\(\)/.test(srv));
ok('关服务时会把 Edge 后端一起收掉', /stopWorker\(\)/.test(srv));

const defs = read('core/defaults.mjs');
ok('默认关掉"内置引擎不可用时自动切换节点"（别偷偷把文本发给腾讯/有道）', /autoSwitchFromBuiltin:\s*false/.test(defs));

const pkg = JSON.parse(read('package.json'));
ok('package.json 注册了 test:edgeworker', !!pkg.scripts['test:edgeworker'], JSON.stringify(pkg.scripts['test:edgeworker']));
ok('这个自测在 npm test 里（离线，必须每次都跑）', /test-edge-worker\.mjs/.test(pkg.scripts.test), pkg.scripts.test);

// ---------------------------------------------------------------------------
console.log('\n七、「删了语言包就再也下不回来」的修复（用户报的 bug ①）');
// 现场：用户用「删除语言包」删掉语言包目录后，Edge 的组件登记还认为装过 —— 页面照旧报
// available / downloadable，但 Translator.create() 立刻抛 "Unable to create translator …"，
// 而且**永远不会再下载**。实测唯一可靠的办法：把整个 profile 删掉重来。
const wsrc = read('core/edge-worker.mjs');
ok('edge-worker.mjs 有 wipeProfile()', /export async function wipeProfile\(\)/.test(wsrc));
ok('wipeProfile() 先停掉无窗口 Edge（不然文件被占用删不干净）', /await stopWorker\(\)/.test(wsrc));
ok('wipeProfile() 删完会校验目录真的没了，并且会重试', /maxRetries/.test(wsrc) && /existsSync\(PROFILE_DIR\)/.test(wsrc));
ok('workerPrepare 自愈第一层：状态说 stalePack 就先清 profile 再下', /stalePack/.test(wsrc) && /repairAndRetry/.test(wsrc));
ok('workerPrepare 自愈第二层：创建翻译器失败且磁盘上没有完整语言包时也清', /CORRUPT_RE\.test/.test(wsrc) && /packLooksReal\(\)/.test(wsrc));
ok('自愈不会打断正在进行的下载（preparing 时不修）', /!st\.preparing/.test(wsrc));
ok('status 会标记 stalePack（页面说 available 但磁盘没语言包 = 它在骗人）', /stalePack:\s*true/.test(wsrc) && /claimsReady/.test(wsrc));
ok('status 的 reason 只说"文件不完整"，并告诉用户点启用会自动重下', /本地模型文件不完整/.test(wsrc) && /重新下载/.test(wsrc));
ok('workerPrepare / workerStatus 都还是导出的公开接口', typeof workerPrepare === 'function' && typeof workerStatus === 'function');
ok('pack/delete 走 wipeProfile()（只删语言包目录是没用的，实测过）', /wipeProfile\(\)/.test(srv));
ok('/api/local-engine/pack 回报 profile 整体占用（界面要说清"其中语言包 X MB"）', /workerProfile/.test(srv));
ok('server.mjs 导入了 packLooksReal（仅本地模式的提示要用）', /packLooksReal/.test(srv));
ok('drawer.js 有 stalePack 分支（不完整时给专门的提示）', /stalePack/.test(read('core/drawer.js')));

// ---------------------------------------------------------------------------
console.log('\n七之二、自带语言包（seed）通路与「没装 Edge」场景');
// 需求：发布包里直接带一份语言包（不能妨碍正常下载），并且要照顾没装 Edge 的人。
// 二分实测：seed 只要 语言包 + EdgeLLMRuntime 两样（约 201 MB），CRX / Local State 都不需要。
ok('adoptSeed() 在 launch() 里被调用（启用内置引擎/自愈都会先吃自带语言包）', /await adoptSeed\(\)/.test(wsrc));
ok('adoptSeed() 先查运行时再动手（缺 EdgeLLMRuntime 时不许先毁掉现有 profile）',
  wsrc.indexOf('seedRuntimeReady(seed)') > -1 && wsrc.indexOf('seedRuntimeReady(seed)') < wsrc.indexOf('await stopWorker()', wsrc.indexOf('export async function adoptSeed')));
ok('adoptSeed() 是复制不是移动（自带那份留着，删了还能再装一次）', /copyTreeSync/.test(wsrc) && !/renameSync\(seed/.test(wsrc));
ok('自带语言包只在「本机没有完整语言包」时才用（绝不覆盖已下好的）', /本机已经有完整语言包，不需要用自带的/.test(wsrc));
ok('seed 铺开后校验语言包与运行时，不真就退回下载', /自带的语言包不完整/.test(wsrc) && /自带的语言包里没有模型运行时/.test(wsrc));
ok('没装 Edge 的报错写明替代方案（本地大模型 / LibreTranslate / 在线节点）', /Microsoft Edge/.test(wsrc) && /Ollama/.test(wsrc) && /LibreTranslate/.test(wsrc));
ok('缺少 seed 时不谎称"自带的那份会直接装好"（reason 收紧到 seed.ready && seed.runtime）', /seed\.ready && seed\.runtime/.test(wsrc));
ok('/api/local-engine/pack 回报 seed 与 Edge 可用性', /seed,\s*\n\s*edge: \{ available: hasEdge\(\), path: edgePath\(\) \}/.test(srv));
ok('server.mjs 导入了 seedInfo / hasEdge', /seedInfo/.test(srv) && /hasEdge/.test(srv));
ok('/api/local-engine 在没装 Edge 时给专门原因（而不是"还没连接 Gale"）', /noBrowser/.test(srv) && /这台机器上没有找到 Microsoft Edge/.test(srv));
ok('仅本地模式下的下载提示会看 seed（有自带语言包就别吓唬用户说必须联网）', /seed\.ready && seed\.runtime/.test(srv));
const exp = read('tools/export-edge-pack.mjs');
const expCode = exp.replace(/^\s*\/\/.*$/gm, '');
ok('导出工具有 --full / --out', /--full/.test(exp) && /--out/.test(exp));
ok('精简版复制 EdgeLLMRuntime（缺它就是"无法创建翻译器"）', /EdgeLLMRuntime/.test(expCode));
ok('精简版不再复制 component_crx_cache（实测不需要，省 364 MB）', !/component_crx_cache/.test(expCode));
ok('精简版不带 Local State（否则会把导出者的账号信息一起发出去）', !/copyTree\([^)]*Local State/.test(expCode) && !/seedItems[\s\S]{0,200}Local State/.test(expCode));
ok('导出工具会提醒 --full 含登录状态（对外发布建议用精简版）', /Local State/.test(exp) && /--full 会把导出者/.test(exp));
ok('导出工具在没有 EdgeLLMRuntime 时会警告并建议 --full', /没找到 EdgeLLMRuntime/.test(exp));

// ---------------------------------------------------------------------------
console.log('\n八、「仅本地翻译（禁用联网）」开关（用户要的 bug ②/需求②）');
const net = read('core/net.mjs');
ok('net.mjs 装了网闸：setOfflineOnly / isOfflineOnly / setOfflineLogger', ['setOfflineOnly', 'isOfflineOnly', 'setOfflineLogger'].every((k) => net.includes(`export function ${k}`)));
ok('网闸拦在 request() 这条唯一的对外出口上', /仅本地模式已开启：已拦截对/.test(net));
ok('回环判定覆盖 localhost / 127.x / ::1', net.includes('localhost') && net.includes('127\\.') && net.includes('::1'));
ok('providers.mjs 有 isProviderLocal / filterLocalProviders', /export function isProviderLocal/.test(read('core/providers.mjs')) && /export function filterLocalProviders/.test(read('core/providers.mjs')));
ok('节点列表带 local 标记（界面据此置灰在线节点）', /local:\s*isProviderLocal\(/.test(read('core/providers.mjs')));
ok('默认配置里 offlineOnly = false', /offlineOnly:\s*false/.test(defs));
ok('server.mjs 在载入/保存配置后同步网闸（applyOfflineMode）', /function applyOfflineMode/.test(srv) && /setOfflineOnly\(!!config\.offlineOnly\)/.test(srv));
ok('server.mjs 的可用节点/备用链在仅本地模式下过滤非本地节点', /filterLocalProviders/.test(srv) && /isProviderLocal\(p, config\)/.test(srv));
ok('/api/status 会告诉界面哪些节点被禁网挡了', /offlineBlocked/.test(srv));
ok('translate.mjs 建链时也过滤（手工把 provider 设成腾讯也发不出去）', /offLocal/.test(read('core/translate.mjs')));
ok('translate.mjs 的空链错误在仅本地模式下有专门文案', /仅本地模式已开启，当前翻译节点不是本地节点/.test(read('core/translate.mjs')));
ok('润色在仅本地模式下不会去敲远程 API', /blockedByOffline/.test(read('core/translate.mjs')));
ok('抽屉与设置页都有这个开关', /id="offlineOnly"/.test(read('core/drawer.js')) && /id="offlineOnly"/.test(read('ui/index.html')));
const i18n = read('core/i18n.js');
ok('开关文案有英文译文（含首次下载那条例外）', i18n.includes("'仅本地翻译（禁用联网）'") && /例外：内置引擎首次要下载约 200 MB 语言包/.test(i18n));

console.log('\n九、状态显示契约：挂上 Gale 之后不许再显示上一次的错误');
const cdpSrc = read('core/cdp.mjs');
ok('连接成功后清掉 lastError（否则界面会一直显示「· fetch failed」）', /this\.attached = true;\s*\n\s*this\.lastError = null;/.test(cdpSrc));
ok('抽屉只在未挂载时显示 cdp.lastError', /okGale \? '页面脚本已注入' : \(c\.lastError/.test(read('core/drawer.js')));
ok('设置页只在未挂载时显示 cdp.lastError', /\(!c\.attached&&c\.lastError\)/.test(read('ui/index.html')));

// ---------------------------------------------------------------------------
console.log('\n十、语言包位置：「打开语言包位置」+ 不再有单独的「删除自带语言包」按钮');
// 用户要求（m05070）：官方主包不带语言包，所以那个按钮没有用武之地 —— 删掉它、
// 把"连自带那份一起清"并进「删除语言包」，另加一个"打开语言包位置"。
const dwsrc = read('core/drawer.js');
const uisrc = read('ui/index.html');
ok('edge-worker 导出 revealTarget()（挑一个真实存在的目录给资源管理器）', /export function revealTarget\(\)/.test(wsrc));
ok('revealTarget() 的候选顺序含语言包目录 / profile / 自带那份 / data', /EdgeTranslateKitLanguagePack/.test(wsrc) && /seedProfileDir\(\)/.test(wsrc) && /path\.join\(ROOT, 'data'\)/.test(wsrc));
ok('server 有 /api/local-engine/pack/open 路由并调资源管理器', /'\/api\/local-engine\/pack\/open'/.test(srv) && /explorer\.exe/.test(srv));
ok('pack/open 返回实际打开的目录（界面要显示出来）', /ok: true, opened: dir, seed: seedInfo\(\)/.test(srv));
ok('两套界面都删掉了「删除自带语言包」按钮', !/delSeedPack/.test(dwsrc) && !/btnDelSeedPack/.test(uisrc));
ok('两套界面都新增了「打开语言包位置」按钮', /id="openPack"/.test(dwsrc) && /id="btnOpenPack"/.test(uisrc));
ok('两套界面都调 pack/open 并显示打开的路径', /pack\/open/.test(dwsrc) && /pack\/open/.test(uisrc) && /已在资源管理器里打开/.test(dwsrc) && /已在资源管理器里打开/.test(uisrc));
ok('「删除语言包」仍走 scope: all（连自带那份一起清，就是"功能整合"）', /scope: 'all'/.test(dwsrc) && /scope: 'all'/.test(uisrc));
ok('删除确认提示改成指向「打开语言包位置」（不再提已删除的按钮）', /用旁边的「打开语言包位置」/.test(dwsrc) && /用旁边的「打开语言包位置」/.test(uisrc));
ok('删除结果行不再声称"有随包自带语言包时不用联网"', !/有随包自带语言包时不用联网/.test(dwsrc) && !/有随包自带语言包时不用联网/.test(uisrc));
ok('scope:"all" 那条路真的会连自带那份一起清（dropSeed() 在清完 profile 之后）', /dropSeed\(\);\s*\n\s*return send\(res, 200, \{ ok: true, removed, freedBytes: freed, failed, scope, seedDeleted \}\)/.test(srv));

console.log(`\n结果：通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('失败明细：');
  for (const f of fails) console.log('  - ' + f);
  console.log('');
  process.exit(1);
}
console.log('Edge 离线翻译后端自测全部通过。\n');
