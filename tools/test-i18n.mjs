// 界面词典自测（离线）
// 1) 覆盖率：界面里所有中文文案（设置页 / 抽屉 / 悬浮条，含 placeholder / title）都必须能翻
// 2) 抽查：若干关键串与动态串的翻译结果
// 3) 切回中文：译文能原样还原
// 4) 主题 token：ui/index.html 抄的那份必须与 core/i18n.js 的 THEME 逐字一致（改了色没同步就会红）
// 用法: node tools/test-i18n.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CJK = /[\u3400-\u9fff]/;
const norm = (s) => s.replace(/\s+/g, ' ').trim();

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

// ---------------------------------------------------------------- 加载词典
const emptyWalker = { nextNode: () => null };
global.window = {};
global.document = { nodeType: 9, ownerDocument: null, createTreeWalker: () => emptyWalker };
global.NodeFilter = { SHOW_ELEMENT: 1, SHOW_TEXT: 4 };
global.localStorage = { getItem: () => null, setItem: () => {} };
eval(fs.readFileSync(path.join(ROOT, 'core', 'i18n.js'), 'utf8'));
const I = global.window.GALE_I18N;

console.log('\n一、词典规模');
ok('词典已挂上 window.GALE_I18N', !!I && I.__installed === true);
ok('精确词条 >= 300', Object.keys(I.EXACT).length >= 300, `${Object.keys(I.EXACT).length}`);
ok('动态规则 >= 50', I.RULES.length >= 50, `${I.RULES.length}`);
ok('属性词条 >= 10', Object.keys(I.ATTRS).length >= 10, `${Object.keys(I.ATTRS).length}`);

// ---------------------------------------------------------------- 覆盖率
console.log('\n二、界面文案覆盖率');
// 有意保留原文的（语言名 / 本来就是双语的提示）
const KEEP = new Set(['简体中文', '界面语言 / UI language']);
I.setLang('en');
const covered = (s) => KEEP.has(s) || Object.prototype.hasOwnProperty.call(I.ATTRS, s) || I.t(s) !== s;

const misses = new Map();
const add = (where, text) => {
  const s = String(text || '').replace(/\\\\/g, '\\');
  if (!s || !CJK.test(s) || covered(s)) return;
  if (!misses.has(s)) misses.set(s, new Set());
  misses.get(s).add(where);
};

const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const noScript = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
for (const m of noScript.matchAll(/>([^<>]+)</g)) add('设置页', norm(m[1]));
for (const m of noScript.matchAll(/(?:placeholder|title)="([^"]*)"/g)) add('设置页属性', norm(m[1]));

for (const [file, where] of [
  ['core/drawer.js', '抽屉'],
  ['core/inject.js', '悬浮条'],
]) {
  const s = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const m of s.matchAll(/innerHTML = `([\s\S]*?)`;/g)) {
    const noExpr = m[1].replace(/\$\{[^}]*\}/g, ' ');
    for (const mm of noExpr.matchAll(/>([^<>]+)</g)) add(where, norm(mm[1]));
    for (const mm of noExpr.matchAll(/(?:placeholder|title)="([^"]*)"/g)) add(where + '属性', norm(mm[1]));
  }
}

const missList = [...misses.entries()].sort((a, b) => a[0].localeCompare(b[0]));
ok('界面文案全部有译文（0 条遗漏）', missList.length === 0, missList.map(([t, w]) => `[${[...w].join(',')}] ${t}`).join(' | '));
console.log(`     （已检查 ${missList.length === 0 ? '全部' : ''} 界面文案，词典覆盖 100%）`);

// ---------------------------------------------------------------- 抽查
console.log('\n三、抽查翻译结果');
const cases = [
  ['保存设置', 'Save settings'],
  ['运行状态', 'Status'],
  ['翻译节点', 'Providers'],
  ['已挂载', 'Attached'],
  ['端口 8799', 'Port 8799'],
  ['1234 条', '1234 entries'],
  ['已译 12 · 请求 3', 'Translated 12 · Requests 3'],
  ['已翻译：', 'Translated:'],
  ['桌面快捷方式', 'Desktop shortcut'],
  ['已创建', 'created'],
  ['· 开机自启', '· autostart'],
  ['未开启', 'off'],
  ['没有发现问题。', 'No problems found.'],
  ['开（推荐）', 'On (recommended)'],
  ['原文 = 译文', 'source = translation'],
  ['快速（单节点）', 'Fast (single provider)'],
  ['保存设置（2 项未保存）', 'Save settings (2 unsaved)'],
  ['已保存 3 项并生效', 'Saved 3 change(s) and applied'],
  ['请先填写 DeepL API Key 并保存', 'Please fill in DeepL API Key and save first'],
  ['译库 4 条 · 已命中 0 次 · 游戏分布：—', 'Library: 4 entries · 0 hits · games: —'],
  ['· 已接管 2 个原快捷方式', '· took over 2 original shortcut(s)'],
  ['· deepl 还需 45 秒', '· deepl needs 45s'],
  ['· deepl 还需 45 秒（第 2 次）', '· deepl needs 45s (attempt 2)'],
  ['节点被限流，正在冷却：', 'Rate-limited, cooling down:'],
  ['解除冷却', 'Clear cooldown'],
  ['启用内置引擎', 'Enable built-in engine'],
  ['正在下载语言包… 42%', 'Downloading language pack… 42%'],
  ['状态获取失败：', 'Failed to read status: '],
  // 内置引擎的下载进度行（逐段取词拼接）
  ['正在连接下载服务器', 'Connecting to the download server'],
  ['正在准备内置引擎（连接下载服务器）…', 'Preparing the built-in engine (connecting to the download server)…'],
  ['已开始下载，请稍候…', 'Download started, please wait…'],
  ['约', '~'],
  ['已用', 'elapsed'],
  ['剩余约', 'ETA ~'],
  [' 秒', 's'],
  [' 分', 'm'],
  // 内置引擎的管理功能（下载语言包 / 重置 / 语言包占用 / 删除）
  ['下载语言包', 'Download language pack'],
  ['重置引擎', 'Reset engine'],
  ['查看语言包占用', 'Check language-pack size'],
  ['打开语言包位置', 'Open language pack folder'],
  ['正在打开语言包所在目录…', 'Opening the language pack folder…'],
  ['删除语言包', 'Delete language pack'],
  [
    '已在资源管理器里打开：D:\\x\\data\\edge-profile\\EdgeTranslateKitLanguagePack',
    'Opened in File Explorer: D:\\x\\data\\edge-profile\\EdgeTranslateKitLanguagePack',
  ],
  [
    '打开失败：explorer.exe 不存在（位置：D:\\x\\data）',
    'Open failed: explorer.exe 不存在 (location: D:\\x\\data)',
  ],
  ['再点一次确认删除', 'Click again to confirm'],
  ['⚠ 还没连接到 Gale 页面，正在自动重试…', '⚠ Not connected to the Gale page yet — retrying automatically…'],
  ['当前语言对 en>zh：en>zh=downloadable', 'Current pair en>zh: en>zh=downloadable'],
  ['上次下载失败：net::ERR_TIMED_OUT', 'Last download failed: net::ERR_TIMED_OUT'],
  ['已重置：清掉 2 个模型实例，下次翻译会重新创建', 'Reset: cleared 2 model instance(s); they will be recreated on the next translation'],
  ['已清理 2 处，释放 395.0 MB。下次用内置引擎会自动装回来（没装语言包时约 200 MB，实测十几秒下完）。', 'Cleaned up 2 location(s), freed 395.0 MB. The next enable installs it again automatically (~200 MB and about ten seconds if it has never been installed).'],
  ['Gale 正在运行，文件被占用。请先关闭 Gale（stop.cmd）再删除。', 'Gale is running and the files are locked. Close Gale (stop.cmd) before deleting.'],
];
for (const [zh, en] of cases) ok(`${JSON.stringify(zh)} → ${JSON.stringify(en)}`, I.t(zh) === en, `实际 ${JSON.stringify(I.t(zh))}`);

const portNote = '配置端口 9223 附近连续 61 个端口都不可用（其中 61 个被系统保留），已改用系统分配的空闲端口 3651';
ok('服务端端口提示也能翻成英文', /Ports near the configured port 9223/.test(I.t(portNote)), I.t(portNote).slice(0, 60));
ok('配置迁移提示也能翻成英文', /no longer available/.test(I.t('翻译节点 mymemory 已不可用，改为内置引擎')));

// ---------------------------------------------------------------- 还原
console.log('\n四、切回中文');
I.setLang('zh-CN');
ok('切回中文后不再翻译', I.t('保存设置') === '保存设置', I.t('保存设置'));
ok('未命中的文本原样返回', I.t('这段没有词条') === '这段没有词条');
I.setLang('en');
ok('可以再次切到英文', I.t('保存设置') === 'Save settings');

// ---------------------------------------------------------------- 主题 token（三处界面同一套色板）
console.log('\n四之二、主题 token（悬浮条 / 抽屉 / 设置页共用一套）');
const UIM = global.window.GALE_UI;
ok(
  'GALE_UI.theme 已挂上（css / vars / galeMode / browserMode）',
  !!UIM && !!UIM.theme && typeof UIM.theme.css === 'function' && typeof UIM.theme.vars === 'function' && typeof UIM.theme.galeMode === 'function' && typeof UIM.theme.browserMode === 'function',
);
const TH = UIM.theme.THEME;
ok('dark / light / shared 三组 token 都在', !!TH.dark && !!TH.light && !!TH.shared, JSON.stringify(Object.keys(TH || {})));
ok(
  'token 全部是 --g- 前缀（不会撞 Gale 自己的变量）',
  [TH.dark, TH.light, TH.shared].every((g) => Object.keys(g).every((k) => k.startsWith('--g-'))),
);
ok(
  '深浅两套的键完全一致（漏一个就会出现"某个控件没颜色"）',
  JSON.stringify(Object.keys(TH.dark).sort()) === JSON.stringify(Object.keys(TH.light).sort()),
  JSON.stringify(Object.keys(TH.dark).filter((k) => !(k in TH.light))),
);
ok('css() 产出带选择器的变量块', /^:host\{--g-[a-z0-9-]+:.+\}$/.test(UIM.theme.css('dark')) && /^\.x\{--g-[a-z0-9-]+:.+\}$/.test(UIM.theme.css('light', '.x')));
ok(
  '暗色底/面用的是 Gale 的 primary-900 / primary-800',
  TH.dark['--g-bg'] === '#0f172a' && TH.dark['--g-surface'] === '#1e293b',
  `${TH.dark['--g-bg']} / ${TH.dark['--g-surface']}`,
);
ok('强调色是 Gale 的 green（暗 #16a34a / 亮 #15803d，不再是蓝紫）', TH.dark['--g-acc'] === '#16a34a' && TH.light['--g-acc'] === '#15803d');
ok('旧配色（#4f8cff / #2f5fd0 / #171b21 / #0f1216）已彻底清掉', !/#4f8cff|#2f5fd0|#171b21|#0f1216/.test(JSON.stringify(TH)));

// 设置页为避免首屏闪白，把同一套 token 抄进了 <style>：两份必须逐字一致，否则就是"改了色没生效"。
// 设置页**固定用暗色**（和 Gale 默认的暗色皮肤一致），所以这里只断言 THEME.dark 这一套。
const uiHtml = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const styleBlock = (uiHtml.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
const tokensOf = (src) => {
  const out = {};
  const re = /(--g-[a-z0-9-]+)\s*:\s*([^;}]+)/g;
  let m;
  while ((m = re.exec(src))) out[m[1]] = m[2].trim();
  return out;
};
const uiTokens = tokensOf(styleBlock);
const expectDark = Object.assign({}, TH.shared, TH.dark);
const diffDark = Object.keys(expectDark).filter((k) => uiTokens[k] !== expectDark[k]).map((k) => `${k}: ui=${uiTokens[k] || '(缺)'} theme=${expectDark[k]}`);
ok('设置页 token 与 THEME.dark 逐字一致（设置页固定暗色，和 Gale 皮肤一致）', diffDark.length === 0, diffDark.slice(0, 4).join(' | '));
ok('设置页不再跟系统偏好变亮（没有 @media prefers-color-scheme）', !/@media\s*\(prefers-color-scheme/.test(styleBlock));
ok('设置页声明了 color-scheme:dark（滚动条 / 表单控件也跟着变暗）', /color-scheme\s*:\s*dark/.test(styleBlock) && /<meta name="color-scheme" content="dark"\s*\/?>/.test(uiHtml));
ok('设置页居中：顶栏与内容区共用同一个 max-width + margin:0 auto', /header \.wrap\{[^}]*max-width:1120px[^}]*margin:0 auto/.test(styleBlock) && /main\{[^}]*max-width:1120px[^}]*margin:0 auto/.test(styleBlock));
ok('顶栏内容包在居中的 .wrap 里（宽屏下标题不会贴在屏幕最左边）', /<header>\s*<div class="wrap">/.test(uiHtml));
ok('内容区的 grid 轨道锁成 minmax(0,1fr)（否则一行不换行的长文本会把整页撑出横向滚动条）', /main\{[^}]*grid-template-columns:minmax\(0,1fr\)/.test(styleBlock));
ok('节点说明允许换行（不再是 nowrap + 省略号，否则长说明被切掉还会撑宽整页）', /\.src \.d\{[^}]*line-height/.test(styleBlock) && !/\.src \.d\{[^}]*white-space:nowrap/.test(styleBlock));
ok('卡片内的自适应栅格用 minmax(min(230px,100%),1fr)（窄窗口不会溢出）', /repeat\(auto-fit,minmax\(min\(230px,100%\),1fr\)\)/.test(styleBlock));

const injectSrc = fs.readFileSync(path.join(ROOT, 'core', 'inject.js'), 'utf8');
const drawerSrc = fs.readFileSync(path.join(ROOT, 'core', 'drawer.js'), 'utf8');
const cssUsesVars = (s) => (s.match(/var\(--g-/g) || []).length >= 20 && !/background:#171b21|background:#1b2027|background:#0d1014|color:#e6e9ee|color:#e8eaed/.test(s);
ok('悬浮条与抽屉都从 GALE_UI.theme 取色（不再各写一套）', /window\.GALE_UI && window\.GALE_UI\.theme/.test(injectSrc) && /window\.GALE_UI && window\.GALE_UI\.theme/.test(drawerSrc));
ok('两者都有 i18n.js 缺失时的内置回退色', injectSrc.includes('FALLBACK_THEME') && drawerSrc.includes('FALLBACK_THEME'));
ok('两者都用 token 取色（没有残留的硬编码暗色面板色）', cssUsesVars(injectSrc) && cssUsesVars(drawerSrc), `${(injectSrc.match(/var\(--g-/g) || []).length} / ${(drawerSrc.match(/var\(--g-/g) || []).length}`);
ok('注入界面按 Gale 自己的 <html class="dark"> 判深浅色（不能用 prefers-color-scheme）', /contains\('dark'\)/.test(fs.readFileSync(path.join(ROOT, 'core', 'i18n.js'), 'utf8')));
ok('悬浮条与抽屉的字号都走 --g-fs', /font:var\(--g-fs\)/.test(injectSrc) && /font:var\(--g-fs\)/.test(drawerSrc));
ok('字号确实加大了：设置页正文 15px、抽屉面板 440px、悬浮条基准 14px', /body\{[^}]*font:15px/.test(styleBlock) && /width:440px/.test(drawerSrc) && TH.shared['--g-fs'] === '14px');

console.log(`\n结果：通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('失败明细：');
  for (const f of fails) console.log('  - ' + f);
  console.log('');
  process.exit(1);
}
console.log('界面词典自测全部通过。\n');
