/* Gale 汉化外挂 · 界面国际化（中文 / English）
 * ---------------------------------------------------------------------------
 * 设计：不改 JS 里的显示逻辑，只做"词典 + DOM 遍历"：
 *   1) 静态文案（HTML / 模板串里的文本节点）按**精确匹配**替换；
 *   2) 动态文案（`已译 ${n} 段` 这种）按**正则规则**替换（带捕获组）；
 *   3) placeholder / title 等属性单独一张表。
 * 译文会记住原文（WeakMap），切回中文时原样还原。
 * 页面重新渲染出新的中文节点时，MutationObserver 会自动再翻一遍。
 *
 * 浏览器侧脚本，同时被设置页（<script src="/i18n.js">）和注入到 Gale 的
 * 抽屉 / 悬浮条使用（由服务端拼进注入脚本）。
 */
(() => {
  if (window.GALE_I18N && window.GALE_I18N.__installed) return;

  const CJK = /[\u3400-\u9fff]/;

  // ---------------------------------------------------------------- 精确词典
  const EXACT = {
    // —— 通用按钮 / 动作 ——
    保存: 'Save',
    保存设置: 'Save settings',
    保存参数: 'Save parameters',
    保存词典: 'Save dictionaries',
    保存并刷新: 'Save & apply',
    保存并更新订阅: 'Save & update subscriptions',
    保存修改: 'Save changes',
    还原: 'Revert',
    刷新: 'Refresh',
    刷新日志: 'Refresh log',
    关闭: 'Close',
    删除: 'Delete',
    编辑: 'Edit',
    添加节点: 'Add provider',
    导入: 'Import',
    对比: 'Compare',
    测试当前节点: 'Test current provider',
    测试润色: 'Test polishing',
    导出译库文件: 'Export library file',
    清空翻译缓存: 'Clear translation cache',
    清空译库: 'Clear library',
    自动检测: 'Auto-detect',
    跟随系统代理: 'Use system proxy',
    体检当前页面: 'Check current page',
    '体检全部页面（约 30 秒）': 'Check all pages (~30s)',
    '恢复所有被停用的内置节点': 'Restore all disabled built-in providers',
    查看页面识别情况: 'Inspect page detection',
    '以调试模式启动 Gale': 'Launch Gale in debug mode',
    重新注入并刷新: 'Re-inject & reload',
    '重新注入并刷新 Gale 页面': 'Re-inject & reload the Gale page',
    打开完整设置页: 'Open full settings',
    打开设置: 'Open settings',
    看覆盖率体检: 'See coverage report',
    保护它: 'Protect',
    指定译法: 'Set translation',
    翻译它: 'Translate it',
    停用: 'Disable',
    开启免启动器模式: 'Enable launcher-free mode',
    开启开机自启: 'Enable autostart',
    关闭开机自启: 'Disable autostart',
    '➕ 添加自定义翻译节点': '➕ Add a custom provider',
    是: 'Yes',
    否: 'No',
    开: 'On',
    关: 'Off',
    '开（推荐）': 'On (recommended)',
    '开（推荐，省请求）': 'On (recommended, fewer requests)',
    '否（推荐，保留原名便于搜索）': 'No (recommended — keeps names searchable)',
    '包含（推荐，条数最多）': 'Include (recommended, most entries)',
    只导出译库: 'Library only',
    '是（请求体含 texts_json / texts_joined）': 'Yes (body uses texts_json / texts_joined)',
    '否（每段一次请求，用 {{text}}）': 'No (one request per segment, uses {{text}})',
    '其他（手动输入语言代码）…': 'Other (enter a language code manually)…',

    // —— 分区标题 ——
    运行状态: 'Status',
    注入自检: 'Injection self-check',
    翻译节点: 'Providers',
    自定义翻译节点: 'Custom providers',
    语言与质量: 'Language & quality',
    翻译行为: 'Behaviour',
    网络代理: 'Network proxy',
    '术语与固定译法': 'Glossary & fixed phrases',
    覆盖率体检: 'Coverage check',
    '缓存与译库': 'Cache & library',
    '译库导出 / 导入 / 订阅': 'Library export / import / subscribe',
    '系统集成（免启动器 / 开机自启）': 'System integration (launcher-free / autostart)',
    最近日志: 'Recent log',
    公共译库: 'Shared library',
    译法比对与润色: 'Comparison & polish',
    使用说明: 'Usage',
    日志: 'Log',
    缓存: 'Cache',
    语言与网络: 'Language & network',
    术语与译文处理: 'Terminology & text processing',
    免启动器模式: 'Launcher-free mode',
    'Gale 汉化外挂': 'Gale Mod Translator',
    'Gale 汉化外挂 · 设置': 'Gale Mod Translator · Settings',
    'Gale 汉化': 'Gale Translator',

    // —— 状态 ——
    已挂载: 'Attached',
    未挂载: 'Not attached',
    '页面脚本已注入': 'Page script injected',
    已连接: 'Connected',
    正常运行: 'Running',
    'Gale 未运行': 'Gale is not running',
    'Gale 在运行但未挂载（需带调试端口启动）': 'Gale is running but not attached (needs the debug port)',
    'Gale 挂载': 'Gale',
    服务: 'Service',
    调试端口: 'Debug port',
    当前节点: 'Provider',
    本页已译: 'This page',
    '缓存 / 译库': 'Cache / library',
    模糊复用: 'Fuzzy reuse',
    端口: 'Port',
    记忆: 'remembered',
    状态: 'Status',
    条目数: 'Entries',
    命中: 'Hits',
    未命中: 'Misses',
    请求: 'Requests',
    错误: 'Errors',
    按语言: 'By language',
    译库: 'Library',
    订阅: 'Subscriptions',
    游戏分布: 'Games',
    模式: 'Mode',
    快速模式: 'Fast mode',
    择优模式: 'Best-of mode',
    '· LLM 润色开': '· LLM polishing on',
    识别异常: 'Detection issue',
    中文: 'Translated',
    原文: 'Original',

    // —— 表单标签 ——
    'Gale 程序路径（换电脑后点“自动检测”）': 'Gale executable path (click Auto-detect after moving to a new PC)',
    '最小翻译长度（字符）': 'Minimum length (characters)',
    最小翻译长度: 'Minimum length',
    '最短润色长度（字符）': 'Minimum length to polish (characters)',
    最短润色长度: 'Minimum length to polish',
    每批段数: 'Segments per batch',
    开关: 'Enabled',
    翻译成: 'Translate into',
    源语言: 'Source language',
    翻译模式: 'Mode',
    '快速（单节点直出，省请求）': 'Fast (single provider, fewer requests)',
    '快速（单节点）': 'Fast (single provider)',
    '择优（多节点并发翻译 + 质量评分选最好）': 'Best-of (translate with several providers, keep the best by score)',
    '择优（多节点评分）': 'Best-of (scored)',
    '参与择优的节点 id（逗号分隔，留空=自动取可用节点）': 'Providers to vote (comma-separated; empty = pick available ones)',
    '译法一致性（与已有相似译法保持一致）': 'Translation consistency (match similar existing translations)',
    '失败时的备用节点（逗号分隔的节点 id）': 'Fallback providers (comma-separated ids)',
    '失败时的备用节点（逗号分隔）': 'Fallback providers (comma-separated)',
    '网络代理（Google / DeepL / 大模型等境外节点需要）': 'Network proxy (needed by offshore providers such as Google / DeepL / an LLM)',
    翻译模组名: 'Translate mod names',
    '翻译模组配置页（左侧列表与配置标题）': 'Translate the config page (left list & group titles)',
    翻译配置页: 'Translate config page',
    中文搜索: 'Chinese search',
    '中文搜索（输入中文给出英文关键词）': 'Chinese search (type Chinese, get English keywords)',
    悬停显示原文: 'Show original on hover',
    鼠标悬停显示原文: 'Show original on hover',
    模糊复用: 'Fuzzy reuse',
    '模糊复用（只差版本号/标点的句子复用已有译文）': 'Fuzzy reuse (reuse translations that differ only by version/punctuation)',
    '启动时自动打开 Gale': 'Launch Gale automatically on start',
    回译校验: 'Back-translation check',
    批量发送: 'Batch requests',
    响应取值路径: 'Response path',
    请求地址: 'Endpoint URL',
    请求方法: 'Method',
    方法: 'Method',
    '请求头（JSON）': 'Headers (JSON)',
    请求体模板: 'Body template',
    名称: 'Name',
    'id（英文）': 'id (ASCII)',
    '节点 id（英文标识）': 'Provider id (ASCII)',
    节点名称: 'Provider name',
    备注: 'Note',
    'API Key（可选）': 'API Key (optional)',
    占位符: 'Placeholders',
    '可用占位符：': 'Available placeholders:',
    '我的翻译接口': 'My translation API',
    '原文 = 译文': 'source = translation',
    '对比译法（同一段文本让所有可用节点各翻一遍并打分）': 'Compare translations (run one string through every available provider and score them)',
    '对比译法（同一段让所有节点各翻一遍并打分）': 'Compare translations (run one string through every provider and score them)',
    术语保护表: 'Protected terms',
    '术语保护表（每行一个；可写': 'Protected terms (one per line; write ',
    '术语保护表（每行一个，这些词不会被翻译；可写成': 'Protected terms (one per line; these are never translated. You may write ',
    固定译法: 'Fixed phrases',
    '固定译法（每行一条': 'Fixed phrases (one per line: ',
    '固定译法（每行': 'Fixed phrases (one per line: ',
    译文后处理替换: 'Post-replace rules',
    '译文后处理替换（每行一条': 'Post-replace rules (one per line: ',
    '译文后处理替换（每行': 'Post-replace rules (one per line: ',
    '，用于纠正机翻惯用译名）': ' — fixes habitual MT naming)',
    '；整段完全匹配时直接采用，不调用翻译接口）': '; a whole-string match is used as-is, without calling any provider)',
    '强制指定译法）': ' to force a specific translation)',
    '导出：目标语言（留空=全部）': 'Export: target language (empty = all)',
    '导出：语言（留空=全部）': 'Export: language (empty = all)',
    '导出：限定游戏（留空=全部）': 'Export: limit to a game (empty = all)',
    '导出：游戏（留空=全部）': 'Export: game (empty = all)',
    导出时包含节点缓存里的历史译文: 'Include historical translations from the provider cache',
    '导入：本地文件 / 网址（支持别处导出的译库文件，也支持对方整个 library.json）':
      'Import: local file or URL (accepts exported library files and a plain library.json)',
    '导入：本地文件路径或网址': 'Import: local file path or URL',
    改成覆盖同名条目: 'Overwrite entries with the same source',
    '订阅（每行一个网址，点“保存并更新订阅”会全部拉取并合并）':
      'Subscriptions (one URL per line; “Save & update subscriptions” fetches and merges them all)',
    '订阅（每行一个网址，保存后会全部拉取并合并）':
      'Subscriptions (one URL per line; saving fetches and merges them all)',

    // —— 说明文字 ——
    '把 Gale 里的英文实时翻译成你选择的语言 · 不改动 Gale 任何文件':
      'Translate Gale into your language in real time · without touching a single Gale file',
    '看哪些英文没翻、以及为什么没翻': 'See which English text was not translated, and why',
    '看当前页面哪些英文没翻、以及为什么没翻。每条可一键处理。':
      'See which English text on this page was not translated, and why. Every item can be handled in one click.',
    '只有 Google、以及你自己配的 DeepL / 大模型这类境外节点需要代理；腾讯、有道始终直连，本机服务（本地大模型、LibreTranslate）不要填。':
      'Only Google, plus any DeepL / LLM provider you configure, needs a proxy; Tencent and Youdao always connect directly, and local services (local LLM, LibreTranslate) must not use one.',
    '复用「OpenAI 兼容」节点的接口地址 / Key / 模型；未配置时自动跳过。':
      'Reuses the endpoint / key / model of the OpenAI-compatible provider; skipped automatically when unset.',
    '使用「翻译节点」里 OpenAI 兼容节点的接口地址 / Key / 模型；未配置时本功能自动跳过。':
      'Uses the endpoint / key / model of the OpenAI-compatible provider; skipped automatically when unset.',
    '术语保护、固定译法、后处理替换、中英混排空格都是中文专用；目标语言不是中文时会自动跳过。':
      'Protected terms, fixed phrases, post-replace rules and CJK spacing are Chinese-specific and are skipped for other target languages.',
    '择优只作用于列表简介、详情摘要、标签这类短文本；README 长正文仍走单节点，避免请求量翻几倍。':
      'Best-of applies only to short text such as list blurbs, summaries and tags; long README bodies still use a single provider to avoid multiplying requests.',
    '保存后立即生效，不会刷新 Gale 页面': 'Saving applies immediately (without reloading the page)',
    '译库是「与翻译节点无关」的共享译文层：导出成文件发给朋友、或传到网盘 / Gist，对方导入或订阅后， 遇到相同内容直接出中文，':
      'The library is a provider-independent layer of shared translations: export it to a file and send it to a friend (or upload it to a drive / Gist); after they import or subscribe, identical text is translated instantly,',
    '。你浏览过的内容会自动进译库。': ' You browse, and it lands in the library automatically.',
    '零网络请求': 'with zero network requests',
    '已翻译过的内容不会重复请求翻译接口，断网也能显示。缓存按“目标语言 + 节点”分开存放。':
      'Anything already translated is never requested again — it even works offline. The cache is kept separately per target language and provider.',
    '导入默认不覆盖已有译文（只补缺）：': 'Import only fills gaps by default (existing translations are kept):',
    '打开本页面；控制条可拖动，位置会记住。': ' opens this panel. The bar can be dragged and remembers its position.',
    '页面右下角会出现悬浮控制条：': 'A floating bar appears at the bottom right of the page:',
    '一键切换、': ' one-click switch,',
    '展开节点切换与计数、': ' expand the provider picker and counters,',
    '必须通过本项目的': 'Gale must be launched through this project’s ',
    '启动 Gale，外挂才能挂载（已经开启「免启动器模式」时，用桌面快捷方式启动也可以）。若 Gale 已在运行（包括托盘图标），请先完全退出，再运行 start.cmd。':
      ' for the add-on to attach (with “launcher-free mode” on, the desktop shortcut works too). If Gale is already running (including in the tray), quit it completely first and then run start.cmd.',
    '换到新电脑：解压后双击': 'Moving to a new PC: unzip and double-click ',
    '；若提示找不到 Gale，点上方的“自动检测”或手工填写路径。':
      '; if Gale cannot be found, use “Auto-detect” above or enter the path manually.',
    '更新 Gale 版本后无需重新安装：外挂不修改 Gale 的任何文件，只依赖 WebView2 调试端口与页面文本特征。若某次更新后失效，点“查看页面识别情况”把结果发出来即可快速适配。':
      'Updating Gale does not break it: the add-on never modifies Gale files and only relies on the WebView2 debug port and page text patterns. If a future update breaks it, click “Inspect page detection” and share the result.',
    '开启后桌面会多一个「Gale 汉化」快捷方式：双击它即自动拉起后台服务与带调试端口的 Gale。 再打开「开机自启」，登录后服务就在后台待命，你之后怎么启动 Gale 都能被接管。 原有快捷方式位于公共桌面/开始菜单，改它们需要管理员权限；项目根目录会生成一个提权脚本可按需使用。':
      'Once enabled, a “Gale Translator” shortcut appears on your desktop: double-clicking it starts the background service and Gale with the debug port. Turn on autostart too and the service waits in the background after login, so however you launch Gale it gets attached. The original shortcuts live on the Public Desktop / Start Menu and need administrator rights to modify; an elevation script is generated in the project root if you want that.',
    '开启免启动器模式后，桌面会多一个「Gale 汉化」快捷方式：双击它即自动拉起服务与带调试端口的 Gale。':
      'Once enabled, a “Gale Translator” shortcut appears on your desktop: double-clicking it starts the service and Gale with the debug port.',
    'LLM 润色（机翻先上屏，再自动替换）': 'LLM polishing (show MT first, then replace it)',
    'LLM 润色（机翻先上屏，再用大模型润色并自动替换，无需刷新）':
      'LLM polishing (show MT first, then let an LLM rewrite it — no reload needed)',
    '译库是"与节点无关"的共享译文层：导出成文件发给朋友，对方导入后遇到相同内容直接出中文，零请求。':
      'The library is a provider-independent layer of shared translations: export it and send it to a friend — after importing, identical text is translated instantly, with zero network requests.',
    '，整段完全匹配时直接采用、不调接口）': '; a whole-string match is used as-is, without calling any provider)',
    '单段文本 ·': 'single text ·',
    'JSON 数组 ·': 'JSON array ·',
    '换行拼接 ·': 'newline-joined ·',
    '段数 ·': 'segments ·',
    模组名也翻译: 'Translate mod names too',
    清空缓存: 'Clear cache',
    '中文/原文': 'Translated / original',
    '本地已见 mod': 'Mods seen locally',
    固定词表命中: 'Fixed-phrase matches',
    建议英文关键词: 'Suggested English keywords',
    '节点被限流，正在冷却：': 'Rate-limited, cooling down:',
    '⚠ 节点被限流，正在冷却：': '⚠ Rate-limited, cooling down:',
    解除冷却: 'Clear cooldown',
    冷却期间会自动改用备用节点: 'Fallback providers are used while cooling down',
    已解除冷却: 'Cooldown cleared',
    // —— 内置引擎（浏览器本地模型）——
    启用内置引擎: 'Enable built-in engine',
    '✅ 语言包已就绪：本地运行、不联网、不消耗任何额度':
      '✅ Language pack ready: runs locally, no network, no quota',
    // 有 Edge 可用时的就绪文案：说清"是谁在跑模型"（Gale 的 WebView2 不提供端侧模型，改用插件拉起的无窗口 Edge）
    '✅ 语言包已就绪：本地运行、不联网、不消耗任何额度（模型跑在插件拉起的无窗口 Edge 里，用的是系统安装的 Edge）':
      '✅ Language pack ready: runs locally, no network, no quota (the model runs in a headless Edge that the plugin launches, using your installed Edge)',
    '语言包还没下载：首次启用约需下载 200 MB（一次性，之后一直可用）':
      'Language pack not downloaded yet: the first enable downloads ~200 MB (one-time, then it stays available)',
    '当前浏览器不支持 Translator API（需要 Edge / Chrome 138 以上）':
      'This browser does not support the Translator API (Edge / Chrome 138+ required)',
    // 环境不提供端侧模型（Gale 用的 WebView2 就是如此）。这是**环境限制**，不是"语言包没下载"，
    // 以前会被误显示成后者，用户点了「启用」毫无反应。文案来自 inject.js 的 localVerdict()。
    'Gale 页面自己不带端侧翻译模型（WebView2 的限制）：内置引擎已改用插件拉起的无窗口 Edge，若仍显示不可用，请确认本机装有 Edge，或到设置里换个翻译节点':
      'The Gale page itself does not ship the on-device translation model (a WebView2 limitation): the built-in engine now uses a windowless Edge that the plugin launches. If it still shows as unavailable, make sure Microsoft Edge is installed, or switch to another provider in the settings.',
    '⛔ Gale 页面自己不带端侧翻译模型（WebView2 的限制）：内置引擎已改用插件拉起的无窗口 Edge，若仍显示不可用，请确认本机装有 Edge，或到设置里换个翻译节点':
      '⛔ The Gale page itself does not ship the on-device translation model (a WebView2 limitation): the built-in engine now uses a windowless Edge that the plugin launches. If it still shows as unavailable, make sure Microsoft Edge is installed, or switch to another provider in the settings.',
    '当前运行环境不提供端侧翻译模型，内置引擎无法使用':
      'This runtime does not provide an on-device translation model, so the built-in engine cannot be used',
    '⛔ 当前运行环境不提供端侧翻译模型，内置引擎无法使用':
      '⛔ This runtime does not provide an on-device translation model, so the built-in engine cannot be used',
    // —— 仅本地翻译（禁用联网）——
    '仅本地翻译（禁用联网）': 'Local-only translation (block network)',
    '关闭时可以用在线节点（腾讯 / 有道 / Google / DeepL / 大模型），要翻译的文本会发到那些第三方服务器。':
      'When off, online providers (Tencent / Youdao / Google / DeepL / an LLM) are allowed and the text is sent to those third-party servers.',
    '已开启：只允许"请求不出本机"的节点（内置引擎 / 本地大模型 / 本机 LibreTranslate / 仅用缓存），所有对外请求都会被拦下。例外：内置引擎首次要下载约 200 MB 语言包，那次下载会联网（只下模型本身，不发送任何要翻译的文本）。':
      'On: only providers whose requests never leave this machine are allowed (built-in engine / local LLM / a local LibreTranslate / cache-only); all outbound requests are blocked. Exception: the built-in engine downloads its ~200 MB language pack over the network the first time — the model only, never the text you translate.',
    '仅本地模式下已停用': 'disabled in local-only mode',
    '[仅本地模式下已停用]': '[disabled in local-only mode]',
    '（仅本地模式下已停用）': ' (disabled in local-only mode)',
    '仅本地模式已开启：这个节点会把文本发到本机之外，已被停用。要用它请先关掉「仅本地翻译」。':
      'Local-only mode is on: this provider sends your text off this machine, so it is disabled. Turn “Local-only translation” off to use it.',
    '内置引擎语言包（模型跑在插件拉起的无窗口 Edge 里，与当前所选翻译节点无关）：':
      'Built-in engine language pack (the model runs in a headless Edge that the plugin launches; unrelated to the selected provider):',
    '未连接到 Gale 页面（请用 start.cmd 启动 Gale）': 'Not connected to the Gale page (launch Gale via start.cmd)',
    '状态获取失败：': 'Failed to read status: ',
    '已开始下载，请稍候…': 'Download started, please wait…',
    '启用失败：': 'Enable failed: ',
    // —— 下载进度行（逐段取词拼接，见 drawer.js / index.html 的 fmtBytes / fmtSecs）——
    正在连接下载服务器: 'Connecting to the download server',
    '正在准备内置引擎（连接下载服务器）…': 'Preparing the built-in engine (connecting to the download server)…',
    约: '~',
    已用: 'elapsed',
    剩余约: 'ETA ~',
    秒: 's',
    分: 'm',
    '浏览器只给百分比进度，MB 与速度是按语言包体积（约 197.5 MB）换算的估算值':
      'The browser only reports a percentage; the MB values and speed are estimated from the language-pack size (~197.5 MB)',
    // —— 内置引擎：连接状态 / 管理（重置、删除语言包）——
    下载语言包: 'Download language pack',
    重置引擎: 'Reset engine',
    '正在重置…': 'Resetting…',
    '已重置（语言包还在下载，未打断）': 'Reset (the language pack is still downloading and was not interrupted)',
    '⚠ 还没连接到 Gale：Gale 当前没有运行。启动 Gale 后这里会自动恢复。':
      '⚠ Not connected to Gale: Gale is not running. This recovers automatically once you start Gale.',
    '⚠ 还没连接到 Gale 页面，正在自动重试…': '⚠ Not connected to the Gale page yet — retrying automatically…',
    '还没连接到 Gale 页面': 'Not connected to the Gale page yet',
    '还没连接到 Gale 页面，请先启动 Gale': 'Not connected to the Gale page — please start Gale first',
    'Gale 页面里没有内置引擎（请重启 Gale 让脚本重新注入）':
      'The Gale page has no built-in engine (restart Gale so the script is injected again)',
    读取内置引擎状态失败: 'Failed to read built-in engine status',
    '页面没有返回状态': 'The page returned no status',
    当前语言对: 'Current pair',
    上次错误: 'Last error',
    上次下载失败: 'Last download failed',
    查看语言包占用: 'Check language-pack size',
    删除语言包: 'Delete language pack',
    再点一次确认删除: 'Click again to confirm',
    '正在扫描…': 'Scanning…',
    '正在删除…': 'Deleting…',
    '已取消。': 'Cancelled.',
    '没有找到可删除的语言包。': 'No language pack found to delete.',
    '没有在磁盘上找到已下载的语言包（可能还没下载，或不在已知的 profile 目录里）。':
      'No downloaded language pack found on disk (it may not be downloaded yet, or it lives outside the known profile folders).',
    '将清空插件拉起的无窗口 Edge 数据目录（语言包就在里面）。删完再点「启用内置引擎」会自动装回来：没装过的话约 200 MB、实测十几秒下完。如果磁盘上还有 Gale 自己那份语言包，也会一并删掉（那份需要先关掉 Gale）。想先看一眼位置、或者只删某一处，用旁边的「打开语言包位置」。此操作不可撤销。':
      'This clears the windowless-Edge data folder launched by the plugin (the language pack lives inside). After that, clicking “Enable built-in engine” installs it again automatically: about 200 MB and roughly ten seconds if it has never been installed. Any language pack Gale itself owns is deleted too (that one needs Gale closed first). To look at the folder or delete just one of them, use “Open language pack folder” next to this. This cannot be undone.',
    '打开语言包位置': 'Open language pack folder',
    '正在打开语言包所在目录…': 'Opening the language pack folder…',
    'Gale 正在运行，文件被占用。请先关闭 Gale（stop.cmd）再删除。':
      'Gale is running and the files are locked. Close Gale (stop.cmd) before deleting.',
    重置失败: 'Reset failed',
    扫描失败: 'Scan failed',
    删除失败: 'Delete failed',
    '为什么没翻': 'why',
    '句子': 'sentence',
    '卡片': 'card',
    '名字/标识符': 'name/identifier',
    '句子判定': 'sentence test',
    '含英文、且不在脚本/样式里': 'contains English and is not inside a script/style',
    '注入自检': 'Self-check',
    '点 ⚙ 查看详情': 'click ⚙ for details',
    '页面有英文文本，但识别到的可翻译内容为 0，且未匹配到任何已知锚点':
      'The page contains English text, but nothing translatable was detected and no known anchor matched',
    '启动 20 秒内未匹配到任何已知锚点（.markdown / 虚拟列表 / 卡片容器）':
      'No known anchor matched within 20s of start-up (.markdown / virtual list / card container)',
    虚拟列表: 'virtual list',
    卡片容器: 'card container',

    // —— 覆盖率体检的原因标签 ——
    已翻译: 'Translated',
    未翻译: 'Untranslated',
    '⚠ 未翻译（可点“翻译它”）': '⚠ Untranslated (click “Translate it”)',
    '模组名/作者名（保留）': 'Mod/author name (kept)',
    '标识符/路径（保留）': 'Identifier/path (kept)',
    '界面框架（跳过）': 'UI chrome (skipped)',
    '代码块（跳过）': 'Code block (skipped)',
    术语表保护: 'Glossary-protected',
    你点名翻译: 'Force-translated',
    '太短（跳过）': 'Too short (skipped)',
    '链接文字（保留）': 'Link text (kept)',
    '乱码文本（跳过）': 'Mojibake (skipped)',
    翻译中: 'Translating',
    '翻译失败（会自动重试）': 'Failed (will retry)',
    机翻未改动: 'Unchanged by MT',

    // —— 提示 / 结果 ——
    '（无）': '(none)',
    '（无，先多翻几个 mod 页面再来搜）': '(none — browse a few more mod pages first)',
    '（暂无自定义节点）': '(no custom providers yet)',
    '（点「刷新日志」加载）': '(click “Refresh log” to load)',
    '没有发现问题。': 'No problems found.',
    没有可用节点: 'No provider available',
    '体检中…': 'Checking…',
    '导入中…': 'Importing…',
    '导出中…': 'Exporting…',
    '翻译中…': 'Translating…',
    '测试中…': 'Testing…',
    '翻译中（会依次调用所有可用节点）…': 'Translating (calls every available provider in turn)…',
    '加载失败：': 'Load failed: ',
    '加载配置失败：': 'Failed to load configuration: ',
    '刷新失败：': 'Refresh failed: ',
    '保存失败：': 'Save failed: ',
    '导入失败：': 'Import failed: ',
    '探测失败：': 'Probe failed: ',
    '体检失败': 'Check failed',
    '失败：': 'Failed: ',
    '已清空': 'Cleared',
    '已保存': 'Saved',
    '已删除': 'Deleted',
    '已开启': 'Enabled',
    '已停用': 'Disabled',
    '已完成': 'Done',
    '完成': 'Done',
    '已加入': 'Added',
    已加入强制翻译: 'Added to force-translate',
    已加入固定译法: 'Added to fixed phrases',
    已加入术语保护表: 'Added to protected terms',
    已恢复内置节点: 'Built-in providers restored',
    '已尝试启动 Gale': 'Tried to launch Gale',
    已重新注入并刷新页面: 'Re-injected and reloaded the page',
    '已保存并刷新 Gale 页面': 'Saved and applied',
    代理已保存: 'Proxy saved',
    参数已保存: 'Parameters saved',
    已设为跟随系统代理: 'Set to use the system proxy',
    '已填入可用代理：': 'Filled in a working proxy: ',
    '已切换到：': 'Switched to: ',
    已切换翻译节点: 'Provider switched',
    已切换自定义节点: 'Custom provider switched',
    '已找到：': 'Found: ',
    '没找到 gale.exe，请手工填写路径': 'gale.exe not found — please enter the path manually',
    缓存已清空: 'Cache cleared',
    译库已清空: 'Library cleared',
    '没有可用代理，请确认梯子已开启': 'No working proxy found — make sure your VPN/proxy is running',
    '名称、id、请求地址都要填': 'Name, id and endpoint URL are all required',
    '请填写文件路径或网址': 'Please enter a file path or URL',
    '⚠ 注入自检异常（可能 Gale 前端结构已变化）': '⚠ Injection self-check failed (Gale’s front-end may have changed)',
    '翻译节点不可用：': 'No usable translation node: ',
    '内置引擎在当前环境不可用': 'The built-in engine is unavailable in this environment',
    '可能 Gale 前端结构已变化：': 'Gale’s front-end may have changed:',
    '已扫描': 'Scanned',
    '可点「体检当前页面」看细节。': 'Click “Check current page” for details.',
    '⚠ 还没填密钥，保存后点「测试当前节点」验证': '⚠ No key yet — save, then click “Test current provider”',
    '已保存，可点「测试当前节点」验证': 'Saved — you can now click “Test current provider”',
    '没有需要保存的更改': 'Nothing to save',
    '已还原未保存的更改': 'Unsaved changes reverted',
    '保存中…': 'Saving…',
    '探测中…': 'Probing…',
    '自定义节点已保存': 'Custom provider saved',
    '已设为跟随系统代理（记得点左下角「保存设置」）': 'Set to use the system proxy (click “Save settings” to apply)',
    '系统代理：未启用': 'System proxy: not enabled',
    '未发现本地代理端口': 'no local proxy port found',
    桌面快捷方式: 'Desktop shortcut',
    已创建: 'created',
    未创建: 'not created',
    '· 开机自启': '· autostart',
    已开启: 'on',
    未开启: 'off',
    已接管: 'took over',
    个原快捷方式: 'original shortcut(s)',
    自定义: 'custom',
    '[自定义]': '[custom]',
  };

  // ---------------------------------------------------------------- 动态文案规则
  // [正则, 替换] —— 用于 `已译 ${n} 段` 这类拼接出来的文本
  const RULES = [
    [/^已译 (\d+) · 请求 (\d+)$/, 'Translated $1 · Requests $2'],
    [/^已译 (\d+) · 请求 (\d+) · 失败 (\d+)$/, 'Translated $1 · Requests $2 · Failed $3'],
    // —— 限流冷却 ——
    [/^· (.+) 还需 (\d+) 秒$/, '· $1 needs $2s'],
    [/^正在下载语言包… (\d+)%$/, 'Downloading language pack… $1%'],
    [/^· (.+) 还需 (\d+) 秒（第 (\d+) 次）$/, '· $1 needs $2s (attempt $3)'],
    [/^Google 返回 HTTP 429（出口 IP 被限流）$/, 'Google returned HTTP 429 (exit IP rate-limited)'],
    [/^Google 返回 HTTP 429（出口 IP 被限流）；该节点已进入冷却 (\d+)s$/, 'Google returned HTTP 429 (exit IP rate-limited); cooling down for $1s'],
    [/^；该节点已进入冷却 (\d+)s$/, '; cooling down for $1s'],
    [/^保存设置（(\d+) 项未保存）$/, 'Save settings ($1 unsaved)'],
    [/^已保存 (\d+) 项并生效$/, 'Saved $1 change(s) and applied'],
    [/^已保存 (\d+) 项（下次翻译生效）$/, 'Saved $1 change(s) — applies on next translation'],
    [/^已填入可用代理：(.+)（记得保存）$/, 'Filled in a working proxy: $1 (remember to save)'],
    // —— 内置引擎状态与管理（"前缀：详情"这类动态串）——
    // 仅本地模式：说明 + "当前选的是 X，它会被停用"（见 drawer.js / index.html 的 renderOfflineNote）
    [
      /^已开启：只允许"请求不出本机"的节点（内置引擎 \/ 本地大模型 \/ 本机 LibreTranslate \/ 仅用缓存），所有对外请求都会被拦下。例外：内置引擎首次要下载约 200 MB 语言包，那次下载会联网（只下模型本身，不发送任何要翻译的文本）。当前选的是 (.+)，它会被停用 —— 请改选一个本地节点。$/,
      'On: only providers whose requests never leave this machine are allowed; all outbound requests are blocked. Exception: the first built-in-engine language-pack download (~200 MB) goes over the network — the model only, never your text. The selected provider $1 is not local and will be disabled — please pick a local one.',
    ],
    [/^当前语言对 (\S+)：(.+)$/, 'Current pair $1: $2'],
    [/^本地翻译后端启动失败：(.*)$/, 'Failed to start the local translation backend: $1'],
    [/^上次错误：(.*)$/, 'Last error: $1'],
    [/^上次下载失败：(.*)$/, 'Last download failed: $1'],
    [/^启用失败：(.*)$/, 'Enable failed: $1'],
    [/^重置失败：(.*)$/, 'Reset failed: $1'],
    [/^扫描失败：(.*)$/, 'Scan failed: $1'],
    [/^删除失败：(.*)$/, 'Delete failed: $1'],
    [/^状态获取失败：(.*)$/, 'Failed to read status: $1'],
    [/^读取内置引擎状态失败：(.*)$/, 'Failed to read built-in engine status: $1'],
    [/^已重置：清掉 (\d+) 个模型实例，下次翻译会重新创建$/, 'Reset: cleared $1 model instance(s); they will be recreated on the next translation'],
    [/^合计占用 (.+)：(.+)$/, '$1 in total: $2'],
    [/^已清理 (\d+) 处，释放 (.+)。下次用内置引擎会自动装回来（没装语言包时约 200 MB，实测十几秒下完）。(.*)$/,
      'Cleaned up $1 location(s), freed $2. The next enable installs it again automatically (~200 MB and about ten seconds if it has never been installed).$3'],
    [/^已清理 (\d+) 处，释放 (.+)。（连随包自带的那份也一起删了。）(.*)$/,
      'Cleaned up $1 location(s), freed $2. (The bundled language pack was removed as well.)$3'],
    [/^已在资源管理器里打开：(.+)$/, 'Opened in File Explorer: $1'],
    [/^打开失败：(.+)（位置：(.+)）$/, 'Open failed: $1 (location: $2)'],
    [/^打开失败：(.*)$/, 'Open failed: $1'],
    [/^(.+) 的参数 · ⚠ 还没填密钥$/, '$1 — ⚠ no key yet'],
    [/^(.+) 的参数$/, '$1 — parameters'],
    [/^系统代理：(.+)$/, 'System proxy: $1'],
    [/^结果：(.+)$/, 'Result: $1'],
    [/^· 已接管 (\d+) 个原快捷方式$/, '· took over $1 original shortcut(s)'],
    [/^端口 (\d+)$/, 'Port $1'],
    [/^调试端口 (\d+)$/, 'Debug port $1'],
    [/^调试端口 (\d+) · 记忆 (\d+)$/, 'Debug port $1 · remembered $2'],
    [/^(\d[\d,]*)\s*条$/, '$1 entries'],
    [/^(\d[\d,]*)\s*段$/, '$1 segments'],
    [/^(\d[\d,]*)\s*段（零请求）$/, '$1 segments (zero requests)'],
    [/^(\d[\d,]*)\s*段（累计 (\d[\d,]*) 段）$/, '$1 segments ($2 total)'],
    [/^(\d[\d,]*)\s*条 \/ ([\d,-]+)\s*条$/, '$1 / $2 entries'],
    [/^共 (\d+) 个可用$/, '$1 available'],
    [/^共 (\d+) 条$/, '$1 entries'],
    [/^(\d[\d,]*) 条 · 命中 (\d+) 次$/, '$1 entries · $2 hits'],
    [/^译库 (\d+) 条 · 已命中 (\d+) 次 · 游戏分布：(.+) · 订阅 (\d+) 个$/, 'Library: $1 entries · $2 hits · games: $3 · $4 subscriptions'],
    [/^译库 (\d+) 条 · 已命中 (\d+) 次 · 游戏分布：(.+)$/, 'Library: $1 entries · $2 hits · games: $3'],
    [/^(\d[\d,]*) 条 · 命中 (\d+) 次 · 订阅 (\d+) 个$/, '$1 entries · $2 hits · $3 subscriptions'],
    [/^模式 (.+)$/, 'Mode $1'],
    [/^已扫描 (\d+) 次 · 候选 (\d+) 条$/, 'Scanned $1 times · $2 candidates'],
    [/^桌面快捷方式 (已创建|未创建) · 开机自启 (已开启|未开启)$/, 'Desktop shortcut $1 · autostart $2'],
    [/^· 订阅 (\d+) 个$/, '· $1 subscriptions'],
    [/^· 记忆 (\d+)$/, '· remembered $1'],
    [/^上次导入：\+(\d+) 条（跳过 (\d+)）$/, 'Last import: +$1 entries ($2 skipped)'],
    [/^已导出 (\d+) 条 → (.+)$/, 'Exported $1 entries → $2'],
    [/^导入完成：新增 (\d+) 条，跳过 (\d+)，共 (\d+) 条$/, 'Imported: +$1 entries, $2 skipped, $3 total'],
    [/^订阅更新：新增 (\d+) 条$/, 'Subscription updated: +$1 entries'],
    [/^已保存 (\d+) 个订阅，开始拉取…$/, 'Saved $1 subscriptions, fetching…'],
    [/^成功 (\d+)ms：(.+)$/, 'OK in $1ms: $2'],
    [/^请先填写 (.+) 并保存$/, 'Please fill in $1 and save first'],
    [/^把「(.+)」固定翻译成：$/, 'Always translate “$1” as:'],
    [/^把「(.+)」固定翻译成$/, 'Always translate “$1” as'],
    [/^删除自定义节点「(.+)」？$/, 'Delete the custom provider “$1”?'],
    [/^清空翻译缓存？（译库不受影响）$/, 'Clear the translation cache? (the library is not affected)'],
    [/^确定清空译库？（节点缓存不受影响）$/, 'Clear the library? (the provider cache is not affected)'],
    [/^已翻译 (\d+) 条$/, '$1 translated'],
    // 服务端返回的端口提示（英文界面下也译出来）
    [/^配置端口 (\d+) 附近连续 (\d+) 个端口都不可用（其中 (\d+) 个被系统保留），已改用系统分配的空闲端口 (\d+)$/,
      'Ports near the configured port $1 were all unavailable ($2 tried, $3 reserved by Windows); switched to the OS-assigned free port $4'],
    [/^配置端口 (\d+) 不可用（被占用 (\d+) 个 \/ 被系统保留 (\d+) 个），已改用 (\d+)$/,
      'Configured port $1 is unavailable ($2 in use, $3 reserved by Windows); switched to $4'],
    [/^沿用上次使用的调试端口 (\d+)（配置端口 (\d+) 不可用）$/,
      'Reusing the last working debug port $1 (configured port $2 is unavailable)'],
    [/^沿用 Gale 当前正在使用的调试端口 (\d+)（配置端口是 (\d+)）$/,
      'Reusing the debug port Gale is currently on: $1 (configured: $2)'],
    [/^沿用上次的调试端口 (\d+)（配置端口是 (\d+)）$/, 'Reusing the previous debug port $1 (configured: $2)'],
    [/^配置端口 (\d+) 已被其他程序占用，已自动改用 (\d+)$/, 'Configured port $1 is in use; switched to $2'],
    [/^配置端口 (\d+) 被 Windows 保留（常见于开启 Hyper-V \/ WSL \/ Docker），已自动改用 (\d+)$/,
      'Configured port $1 is reserved by Windows (usually Hyper-V / WSL / Docker); switched to $2'],
    [/^找不到可用端口，仍按 (\d+) 尝试$/, 'No free port found; still trying $1'],
    // 配置迁移提示
    [/^翻译节点 (.+) 已不可用，改为内置引擎$/, 'Provider $1 is no longer available; switched to the built-in engine'],
    [/^备用节点里移除了失效项：(.+)$/, 'Removed stale fallback providers: $1'],
    [/^停用列表里移除了已不存在的节点：(.+)$/, 'Removed no-longer-existing providers from the disabled list: $1'],
    [/^择优节点里移除了失效项：(.+)$/, 'Removed stale voting providers: $1'],
    [/^清除了已废弃的配置项：(.+)$/, 'Removed obsolete config keys: $1'],
  ];

  // ---------------------------------------------------------------- 属性词典
  const ATTRS = {
    '切换 中文 / 原文': 'Toggle translated / original',
    '展开/收起': 'Expand / collapse',
    '打开设置': 'Open settings',
    状态: 'Status',
    翻译源: 'Provider',
    关闭: 'Close',
    我的翻译接口: 'My translation API',
    'system / http://127.0.0.1:7892 / socks5://127.0.0.1:10808': 'system / http://127.0.0.1:7892 / socks5://127.0.0.1:10808',
    'D:\\path\\gale-lib-zh-CN-all.json 或 https://...': 'D:\\path\\gale-lib-zh-CN-all.json or https://...',
    'D:\\path\\gale-lib-zh-CN-all-1234.json 或 https://.../lib.json': 'D:\\path\\gale-lib-zh-CN-all-1234.json or https://.../lib.json',
    'tencent, youdao': 'tencent, youdao',
    'tencent, google': 'tencent, google',
    Valheim: 'Valheim',
    'zh-CN': 'zh-CN',
  };
  const ATTR_NAMES = ['placeholder', 'title', 'aria-label'];

  // ---------------------------------------------------------------- 查表
  function lookup(key) {
    if (!key) return null;
    if (Object.prototype.hasOwnProperty.call(EXACT, key)) return EXACT[key];
    for (const [re, rep] of RULES) {
      if (re.test(key)) return key.replace(re, rep);
    }
    // 末尾中文冒号：「已翻译：」→「Translated:」
    if (/：$/.test(key)) {
      const inner = lookup(key.slice(0, -1));
      if (inner != null) return inner + ':';
    }
    return null;
  }

  // ---------------------------------------------------------------- 应用 / 还原
  const originals = new WeakMap(); // Text -> 原中文
  const attrOriginals = new WeakMap(); // Element -> { attr: 原值 }
  const observers = new Map(); // root -> MutationObserver
  const observedRoots = new Set(); // 需要一起切换语言的根（含 Shadow DOM）
  let lang = 'zh-CN';
  let timer = null;

  const docOf = (root) => root.ownerDocument || (root.nodeType === 9 ? root : document);

  function walk(root, onText, onEl) {
    const doc = docOf(root);
    const w = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null);
    let n = root.nodeType === 3 ? root : w.nextNode();
    while (n) {
      if (n.nodeType === 3) onText(n);
      else if (n.nodeType === 1) onEl(n);
      n = w.nextNode();
    }
  }

  function apply(root = document) {
    if (lang !== 'en') return;
    walk(
      root,
      (node) => {
        const raw = node.nodeValue;
        if (!raw || !CJK.test(raw)) return;
        const key = raw.trim();
        const en = lookup(key);
        if (en == null) return;
        if (!originals.has(node)) originals.set(node, raw);
        const lead = raw.slice(0, raw.indexOf(key));
        const tail = raw.slice(raw.indexOf(key) + key.length);
        node.nodeValue = lead + en + tail;
      },
      (el) => {
        for (const a of ATTR_NAMES) {
          const v = el.getAttribute && el.getAttribute(a);
          if (!v || !CJK.test(v)) continue;
          const en = ATTRS[v.trim()] ?? lookup(v.trim());
          if (en == null) continue;
          let store = attrOriginals.get(el);
          if (!store) {
            store = {};
            attrOriginals.set(el, store);
          }
          if (!(a in store)) store[a] = v;
          el.setAttribute(a, en);
        }
      },
    );
  }

  function restore(root = document) {
    walk(
      root,
      (node) => {
        if (originals.has(node)) node.nodeValue = originals.get(node);
      },
      (el) => {
        const store = attrOriginals.get(el);
        if (!store) return;
        for (const [a, v] of Object.entries(store)) el.setAttribute(a, v);
      },
    );
  }

  function observe(root) {
    if (!root || observers.has(root)) return;
    const doc = docOf(root);
    if (!doc || typeof MutationObserver === 'undefined') return;
    observedRoots.add(root);
    const o = new MutationObserver(() => {
      if (lang !== 'en') return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        apply(root);
        try {
          o.takeRecords();
        } catch {}
      }, 120);
    });
    o.observe(root, { childList: true, subtree: true, characterData: true });
    observers.set(root, o);
  }

  /** 需要一起切换语言的根：显式传入的 root，或 document + 所有已观察的 Shadow DOM */
  function targets(root) {
    if (root) return [root];
    const set = new Set([document]);
    for (const r of observedRoots) set.add(r);
    return [...set];
  }

  function setLang(next, root) {
    const want = String(next || '').toLowerCase().startsWith('en') ? 'en' : 'zh-CN';
    if (want === lang) {
      if (want === 'en') for (const r of targets(root)) apply(r);
      return lang;
    }
    if (lang === 'en') for (const r of targets(root)) restore(r);
    lang = want;
    if (lang === 'en') for (const r of targets(root)) apply(r);
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('gale-ui-lang', lang);
    } catch {}
    return lang;
  }

  /** 供 JS 里拼接的原生对话框等使用 */
  function t(text) {
    if (lang !== 'en') return text;
    return lookup(String(text).trim()) ?? text;
  }

  window.GALE_I18N = {
    __installed: true,
    EXACT,
    RULES,
    ATTRS,
    apply,
    restore,
    observe,
    setLang,
    t,
    get lang() {
      return lang;
    },
    isEn: () => lang === 'en',
  };

  // ---------------------------------------------------------------- 界面公共资源
  // Trusted Types 安全的 innerHTML 写入。
  // 有些页面不允许直接写 innerHTML（Chrome/Edge 内部页、开启了
  // `require-trusted-types-for 'script'` 的应用），直接写会抛
  // "This document requires 'TrustedHTML' assignment"。
  // 这里优先走一个 Trusted Types policy；建不了就退回普通写法，
  // 两条路都失败时**返回 false 而不是抛异常** —— 让调用方降级，别把整个引擎炸掉。
  let ttPolicy = null;
  let ttTried = false;
  function setHTML(el, html) {
    if (!el) return false;
    if (!ttTried) {
      ttTried = true;
      try {
        if (window.trustedTypes && typeof window.trustedTypes.createPolicy === 'function') {
          ttPolicy = window.trustedTypes.createPolicy('gale-mod-translator', { createHTML: (s) => s });
        }
      } catch {
        ttPolicy = null; // 策略名不在白名单里（trusted-types 'none' 等）
      }
    }
    try {
      el.innerHTML = ttPolicy ? ttPolicy.createHTML(html) : html;
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- 主题（三处界面共用）
  // 单一事实源：悬浮条 / 抽屉 / 设置页都从这里取色值与字号。
  // 色板跟着 Gale 走（Tailwind：primary = slate、accent = green）：
  //   注入进 Gale 时按它自己的 <html class="dark"> 判断（**不能**用 prefers-color-scheme，
  //   Gale 的深浅色是它界面里的开关，跟系统偏好可以不一致）；
  //   设置页是独立页面，按系统偏好（亮/暗）走。
  // ui/index.html 的 <style> 里为"首屏不闪白"抄了一份同样的 token，
  // 由 tools/test-i18n.mjs 断言两份完全一致，改色请两边一起改。
  const THEME = {
    shared: {
      '--g-r': '12px',
      '--g-r-sm': '9px',
      '--g-r-xs': '7px',
      '--g-r-pill': '999px',
      '--g-font': '"Microsoft YaHei UI","Microsoft YaHei","Segoe UI",Inter,system-ui,-apple-system,sans-serif',
      '--g-mono': 'Consolas,"Cascadia Mono",monospace',
      '--g-fs': '14px', // 抽屉 / 悬浮条正文
      '--g-fs-sm': '12.5px', // 提示、副标题
      '--g-fs-xs': '11.5px', // 角标、最小号
      '--g-fs-lg': '15px', // 区块标题
      '--g-fs-xl': '17px', // 抽屉标题
    },
    dark: {
      '--g-bg': '#0f172a',
      '--g-bg-a': 'rgba(15,23,42,.72)',
      '--g-surface': '#1e293b',
      '--g-surface-a': 'rgba(30,41,59,.94)',
      '--g-surface-2': '#273449',
      '--g-line': '#334155',
      '--g-line-soft': '#243044',
      '--g-fg': '#f1f5f9',
      '--g-fg-2': '#cbd5e1',
      '--g-dim': '#94a3b8',
      '--g-acc': '#16a34a',
      '--g-acc-hi': '#22c55e',
      '--g-acc-soft': 'rgba(34,197,94,.16)',
      '--g-acc-fg': '#ffffff',
      '--g-ok': '#22c55e',
      '--g-warn': '#f59e0b',
      '--g-warn-bg': '#3b2a0d',
      '--g-err': '#ef4444',
      '--g-err-bg': '#3b1d1d',
      '--g-err-fg': '#fecaca',
      '--g-shadow': '0 12px 32px rgba(2,6,23,.55)',
      '--g-code-bg': '#0b1220',
    },
    light: {
      '--g-bg': '#f1f5f9',
      '--g-bg-a': 'rgba(241,245,249,.72)',
      '--g-surface': '#ffffff',
      '--g-surface-a': 'rgba(255,255,255,.96)',
      '--g-surface-2': '#f1f5f9',
      '--g-line': '#e2e8f0',
      '--g-line-soft': '#eef2f7',
      '--g-fg': '#0f172a',
      '--g-fg-2': '#334155',
      '--g-dim': '#64748b',
      '--g-acc': '#15803d',
      '--g-acc-hi': '#16a34a',
      '--g-acc-soft': 'rgba(21,128,61,.10)',
      '--g-acc-fg': '#ffffff',
      '--g-ok': '#15803d',
      '--g-warn': '#b45309',
      '--g-warn-bg': '#fef3c7',
      '--g-err': '#dc2626',
      '--g-err-bg': '#fee2e2',
      '--g-err-fg': '#7f1d1d',
      '--g-shadow': '0 12px 32px rgba(15,23,42,.16)',
      '--g-code-bg': '#f8fafc',
    },
  };

  function themeVars(mode) {
    const all = Object.assign({}, THEME.shared, THEME[mode] || THEME.dark);
    return Object.keys(all)
      .map((k) => `${k}:${all[k]}`)
      .join(';');
  }
  function themeCss(mode, sel = ':host') {
    return `${sel}{${themeVars(mode)}}`;
  }
  function browserMode() {
    try {
      return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch {
      return 'dark';
    }
  }
  // 注入进 Gale 时看 Gale 自己的深浅色开关；没标注就退回系统偏好。
  function galeMode() {
    try {
      const cl = document.documentElement.classList;
      if (cl.contains('dark')) return 'dark';
      if (cl.contains('light')) return 'light';
    } catch {}
    return browserMode();
  }

  window.GALE_UI = {
    setHTML,
    trustedTypesActive: () => !!ttPolicy,
    theme: { THEME, vars: themeVars, css: themeCss, galeMode, browserMode },
  };

  // 初始语言：注入场景从 __GALE_TR__.uiLang 读，设置页稍后由 config 覆盖
  const boot = window.__GALE_TR__ || {};
  const initial = boot.uiLang || boot.lang || (typeof localStorage !== 'undefined' && localStorage.getItem('gale-ui-lang')) || 'zh-CN';
  lang = String(initial).toLowerCase().startsWith('en') ? 'en' : 'zh-CN';
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem('gale-ui-lang', lang);
  } catch {}
})();
