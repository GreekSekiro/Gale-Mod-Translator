# 更新日志

## 0.1.0

> **关于版本号**：功能上是 1.4 的超集，但这是准备上传 GitHub 公开测试的整理版，
> 版本号重新起算为 **0.1.0**。下面全部是相对 1.4 的**新增/修复**。
> 0.1.0 尚未发布，改动仍在累积（⑦~⑪ 是上传前的最后一轮打磨，⑳ 是内置引擎的实测结论与界面修正，
> ㉑ 是内置引擎真正可用的实现：插件自带的无窗口 Edge 后端，
> ㉒ 是「删了语言包能不能下回来」的修复与「仅本地翻译（禁用联网）」开关，
> ㉓ 是发布用「自带语言包」（`data/edge-pack`）、没装 Edge 的场景，以及一轮界面文案订正，
> ㉔ 是 0.1.0 定稿：**删掉腾讯 / 有道 / Google 三个免密钥节点**、自带语言包也能删、「下载模型」改名「下载语言包」，
> ㉕ 是**把这三个节点加回来**（㉔ 的删除决定按实测风险权衡后撤销）以及一轮界面重构：
> 悬浮条 / 抽屉 / 设置页共用一套 slate + green 主题 token、字号加大、配色对齐 Gale），
> ㉖ 是内置引擎那排按钮的收口：「删除自带语言包」按钮撤掉（官方主包不带语言包，用不上）、
> 其功能并进「删除语言包」，另加常驻的「打开语言包位置」，
> ㉗ 是上传 GitHub 前的定稿：**项目更名为 Gale-Mod-Translator**、删掉本地排查脚本 `检查调试端口策略.cmd`、
> 首页 README 重写成带环境要求与安装说明的完整主页。

**① 模糊复用（只差版本号/标点的句子不再重复请求）**

- 新增「骨架」归一化：把版本号（`1.2` / `v1.2.3` / `1.2.3-beta`）统一成占位符，标点、大小写、空白归一，
  得到句子骨架；骨架相同即命中已有译文，**零网络请求**
- **版本号按序回填**：`Requires Jotunn v2.1.0 …` 的旧译文遇到 `v2.14.3` 的新句子时，会把新版本号填回译文；
  版本号个数对不上就放弃复用（宁可直接翻译，也不给错的版本号）
- 索引来自「节点缓存 + 公共译库」，按目标语言隔离、与翻译节点无关；骨架短于 8 字符不参与（避免「mods」这类误命中）
- 命中后立刻固化成精确缓存，下次直接精确命中
- 开关：设置页 / 页内抽屉「模糊复用」；计数见运行状态里的「模糊复用 N 段」
- 自测：`npm run test:fuzzy`（16 项断言，含端到端"模糊命中且请求数为 0"）

**② 稳定性 · 调试端口不可用时自动换端口**

- 新增 `core/ports.mjs`：**实际试绑**来判断端口能不能用（只看"有没有被占用"不够——
  Windows 上 Hyper-V / WSL / Docker 保留的端口段，`listen` 会直接 `EACCES`）
- 启动时的选择顺序：① 配置端口上已有调试端口在跑（含上次服务分配的临时端口）→ 沿用；
  ② 从配置端口向上试绑（默认 60 个）；③ 整段都不可用 → **让系统分配一个空闲端口**（系统绝不会分配到保留段）
- 启动 Gale 后**主动确认端口是否真的打开**（最多等 25 秒），没打开就写明原因与排查方向
- 换端口的原因会记在 `data/runtime.json`、`/api/status` 的 `cdpPortNote`、设置面板「运行状态」与页内抽屉里
- 启动器与 `tools/cdp-*.mjs` 全部改从 `data/runtime.json` 读实际端口（新增 `tools/cdp-port.mjs`），
  所以端口换了也不用改配置或环境变量
- 自测：`npm run test:ports`（14 项断言：试绑 / 跳过被占端口 / 四种决策路径 / 兜底端口可绑）

**③ 稳定性 · 注入脚本关键锚点自检**

- 注入引擎每次扫描记录：`.markdown`、`svelte-virtual-list-contents`、卡片容器是否命中，候选数，
  以及连续「页面上有英文、但候选为 0」的次数
- 判定降级：连续 ≥3 次候选为 0 且三个锚点一个都没命中，或启动 20 秒内从未命中任何锚点
- 降级时三重提示：悬浮条红点 + 「识别异常」角标（悬停看原因）、服务端 `/api/health` 与日志告警、
  设置页顶部红色横幅（含锚点命中情况）
- 新增 `window.__galeTrans.health()`，供设置页 / 抽屉 / 自检脚本读取

**④ 稳定性 · DOM 快照回放测试**

- `tools/snapshot.mjs`：从运行中的 Gale 抓 DOM 快照。抓之前会先调 `dispose()` 把译文还原成原文、移除悬浮条，
  所以夹具里存的是「Gale 的原始 DOM」，可复现
- `tools/replay-test.mjs`：用无头 Edge + 本地静态服务加载夹具，注入页面引擎（**dry 模式：不联网、不建悬浮条**），
  调 `dryRun()` 得到「哪些文本会被翻译 / 为什么没翻」，与 `test/expect/*.json` 比对；不一致会逐条列出差异
- 注入引擎新增 `dryRun()`：纯规则分类，不发任何请求
- 内置 3 个合成夹具（`browse` / `config` / `modpack`），覆盖：模组名保护、作者名保护、文件路径保护、
  标识符保护、代码块跳过、界面框架跳过、配置页放宽规则
- 一条命令：`npm run test:replay`；确认是新行为时用 `npm run replay:update` 刷新期望

**⑤ 页内抽屉设置（不再切浏览器）**

- 悬浮条 `⚙` 现在直接**在 Gale 页内展开 Shadow DOM 侧边抽屉**（连不上时才退回打开浏览器设置页）
- 抽屉内容：运行状态（端口 / 缓存 / 译库 / 模糊复用计数）、自检告警、翻译节点切换与测试、语言、
  翻译模式、行为开关（含模糊复用）、术语保护表与固定译法编辑、覆盖率体检（每条可「翻译它 / 指定译法 / 保护它」）、
  缓存与译库概况、重新注入并刷新
- 完整设置页仍然保留，抽屉底部有入口
- 抽屉挂在 Shadow DOM 里，所以不会被翻译引擎自己翻掉，也不会被页面的 MutationObserver 误判

**⑥ 测试与工程**

- 新增 `package.json`（**运行时依赖依然是零**，只加了 scripts）
- 新增 `tools/test-integration.mjs`：临时复制一份服务、用隔离配置启动（**不会动你的 `config.json`、不会启动 Gale**），
  再用无头 Edge 加载夹具、注入 `inject.js` + `drawer.js`，验证 API、跨域 CORS、抽屉开合，
  并断言**全程没有未捕获的 JS 异常**
- `npm test` 一条命令跑完四套：模糊复用单测（16）+ 端口与端口记忆单测（24）+ 回放测试（3 夹具）+ 集成冒烟（64），共 107 项断言
  （后续 ⑫~⑲ 又加了词典 / 限流 / 边界 / 内置引擎单测与更多集成断言，现在是**八套 / 309 项**）

**⑦ 节点精简：移除必应与 MyMemory**

- 这两个免费节点在国内基本不可用（必应的免费 token 端点被 Azure 区域限制挡掉、返回 404；
  MyMemory 匿名额度每天约 1000 词、用尽当天不可用），已从内置节点中移除
- 现在内置节点：腾讯交互翻译（默认）、有道、Google、DeepL、OpenAI 兼容大模型、LibreTranslate、仅用缓存
- **配置迁移**：老配置里指向已移除节点的残留（`provider` / `fallback` / `disabledSources` / `quality.voters`）
  以及废弃字段 `mymemoryEmail`，会在启动时自动清理，并在日志与界面里说明；`POST /api/config`
  也会返回 `migrationNotes`（迁移后会自动写回 `config.json`）
- 顺带修：「停用」某个节点后，它**不再被当作备用节点兜底使用**
  （此前 `disabledSources` 只影响节点列表，不影响兜底链）
- 择优模式若配置的节点不足 2 个（或被停用 / 已移除），会从当前可用节点自动补足，
  不再静默退化成单节点翻译

**⑧ 需要密钥的节点终于能填参数了**

- `providers.mjs` 里早就声明了 `fields`（DeepL API Key / OpenAI 兼容的接口地址 + Key + 模型 /
  LibreTranslate 实例地址 + Key），但设置页与抽屉都没渲染 —— 现在都补上了
- 选中节点后**自动展开它的参数输入框**：密钥用 `type=password`，带占位提示；保存后点「测试当前节点」验证
- 密钥没填时明确提示；点测试会先提醒「请先填写 XXX 并保存」

**⑨ 页内抽屉补齐设置项**

- 新增：节点参数（密钥）、备用节点、自定义节点增删改、择优细节（参与节点 / 译法一致性）、
  LLM 润色（开关 / 参数 / 测试）、对比译法、网络代理（跟随系统 / 自动检测）、译文后处理替换、
  译库导出 / 导入 / 订阅、系统集成（免启动器 / 开机自启）、最近日志
- 用可折叠分区组织，常用项默认展开；底部仍有「打开完整设置页」入口

**⑩ 悬浮条展开改为向左**

- 点 `⋯` 展开的节点下拉框与计数改为绝对定位在悬浮条**左侧**，不再往屏幕右边顶出去
- 悬浮条本身贴着屏幕左边缘时自动翻到右侧，避免反向溢出

**⑪ 端口记忆**

- 上次真正用上的调试端口记进 `data/ports.json`，下次启动**优先复用它**，不再每次乱换
- 候选顺序由 `portCandidates()` 决定：默认「上次成功的端口」优先；你把 `config.json` 里的
  `cdpPort` 改掉之后就以配置为准（避免「改了不生效」）
- 设置页与页内抽屉都会显示「调试端口 / 记忆」

**⑫ 抽屉改为「改完再保存」，不再一改就刷新**

- 以前在抽屉里切换节点 / 改任何选项都会立刻 `reinject + reload`：页面一闪、抽屉被关掉，
  想连着改几项很难受。现在所有改动先记在抽屉本地，左下角按钮显示「保存设置（N 项未保存）」，
  旁边多一个「还原」（丢弃未保存的改动）
- 点「保存设置」才统一提交，提交后走**软应用**：重新拉页面侧配置 → 还原译文 → 重新扫描。
  **不刷新页面、抽屉不关、滚动位置不丢**
- 新增 `window.__galeTrans.softApply()` 与 `POST /api/apply`；完整设置页的「保存设置」也改走软应用
  （引擎没挂上时才退回刷新）
- 覆盖率体检里的「翻译它 / 指定译法 / 保护它」同样改成软应用，改完当场生效、不用刷新
- 切换节点时，参数框里填了但还没保存的内容会被记住（换回来还在）

**⑬ 插件界面支持中文 / English 切换**

- 设置页与页内抽屉右上角都加了语言下拉，选完立刻生效，并记进 `config.json`（`uiLang`），下次打开还是这个语言
- 新增 `core/i18n.js`：**不动 JS 里的显示逻辑**，只做「词典 + DOM 遍历」——
  静态文案精确匹配、动态文案（`已译 ${n} 段` 这类）走正则规则、`placeholder` / `title` 单独一张表；
  译文会记住原文，切回中文原样还原；页面重新渲染出新的中文节点时 MutationObserver 会自动再翻一遍
- 词典规模：精确词条 300+、动态规则 50+、属性 13，**界面文案覆盖率 100%**（有测试守着）
- 翻译节点名与说明由服务端按语言下发（`providers.mjs` 增加 `nameEn` / `noteEn` / 字段 `labelEn`），
  切英文后节点列表也是英文
- 悬浮条也跟着切换（`中文` / `原文` → `Translated` / `Original`、`识别异常` 角标、tooltip）
- 新增 `tools/test-i18n.mjs`：扫描全部界面文案断言 0 遗漏 + 抽查翻译结果

**⑭ 限流处理：不再被 Google 429 拖垮**

- 起因：Google 的免费 gtx 接口**按出口 IP 限流**，报 `HTTP 429` 后旧逻辑会**每个片段各重试两次**
  （重试又撞上 429），几十个片段就是上百次无用请求——既慢，又让限流更严重
- **快速失败 + 冷却**：识别到限流立刻放弃该节点（不再重试），并把它标记为「冷却中」——
  首次 1 分钟，之后 2 / 4 / 8 分钟翻倍，上限 10 分钟；冷却期内直接跳过它、自动改用备用节点
- **减少请求量**：Google 的多段短文本会**用换行拼成一次请求**（原来一段一次）；
  返回行数对不上或出现空行时**自动退回逐段**，宁可慢也不会把译文错位
- Google 的最小请求间隔 60ms → 400ms、并发 2 → 1，避免自己把自己打成 429
- 新增 `POST /api/rate-limit/clear`；`/api/status` 增加 `rateLimited`；
  设置页与抽屉的「运行状态」会显示「节点被限流，正在冷却：google 还需 N 秒」并带「解除冷却」按钮
- 新增 `tools/test-ratelimit.mjs`（35 项断言：冷却登记 / 限流识别 / 多段合并 / 合并失败退回 / 端到端切换备用节点）

**⑮ 修「滚动后不再自动翻译」+ 提示条挡住按钮**

- **根因：三个 bug 串在一起**，缺一个都不会出事：
  1. `boot()` 里的 `buildPill()` **没有 try/catch**。它一抛异常，后面的 `startObserver()` 与首次扫描
     就都不会执行 → 整个引擎废掉。表现是「整页都不翻译」，而且日志里只有一行 `注入失败`，极难定位
  2. CDP 选页面用的是 `/tauri\.localhost|^file:|^https?:/`，把浏览器**内部页**（`edge://`、`about:` 等）
     也当成了可注入页面
  3. 内部页强制开启 **Trusted Types**，`shadowRoot.innerHTML = ...` 直接抛
     `This document requires 'TrustedHTML' assignment`
  → 注入到内部页 → 抛异常 → 打断注入流程 → **真正的 Gale 页面反而没挂上引擎**
- **修法**：
  - `boot()` 把界面构建包进 try/catch，**UI 失败绝不拖垮翻译**；
    `startObserver` / `watchRoute` / 首扫提前到 UI 之后立刻执行（不再依赖 `refreshProviderSelect()` 的 then）
  - `cdp.mjs` 的 `_pickPage` 收紧为**只接受 `http(s):` / `file:` 内容页**，内部页一律不注入
  - 新增 `GALE_UI.setHTML()`（`core/i18n.js`）：优先用 Trusted Types policy 写 innerHTML，
    建不了 policy 就退回普通写法，**两条路都失败只返回 `false`、不抛异常**；
    悬浮条 / 搜索面板 / 抽屉都改走它，写不进去就优雅降级（跳过该 UI），翻译照常
- **抽屉提示条位置**：「已保存」提示原来贴在 `bottom:14px`，正好盖住底部那排按钮
  （保存设置 / 还原 / 重新注入）→ 改为按底部按钮栏的实际高度动态上移，不再遮挡
- 新增 `tools/test-scroll.mjs`（9 项断言）：用 mock 翻译接口跑真实链路 ——
  首屏翻译 → 追加新节点（模拟虚拟列表滚动渲染）→ 断言补翻 → 抽屉开 / 关后再各断言一次，
  并断言全程没有未捕获异常。这条测试正是它抓出了上面那串 bug

**⑯ 边界与对抗性体检：修掉 4 个真问题（含 1 个安全漏洞）**

新增 `tools/test-edge.mjs`（29 项断言），专打"平时不出事、一出事很难查"的地方：

- **【安全】本地服务的 CORS 写成了 `*`，还显式允许私有网络访问**。
  本地服务端口固定且可预测，浏览器允许网页向 `127.0.0.1` 发请求，所以这意味着
  **用户随便打开的任何网站**都能：读走整个译库（`/api/library/export`）、
  把翻译节点改成它自己的服务器（之后你翻的每一句话都过它一遍）、
  甚至给你装上开机自启（`/api/system/autostart`）。
  → 改为**只放行本机来源**：`127.0.0.1` / `localhost` / `tauri.localhost`，
  以及没有 `Origin` 的命令行工具；其余一律 403 并记日志。同时去掉 `ACAO: *`，改成回显具体来源 + `Vary: Origin`
- **译库把译文截断到 1000 字符**。长段落的译文从译库命中时是**半句话**，
  而且完全静默（比不翻还糟）→ 超长条目直接不收（而不是存截断版），上限提到 4000；
  源文同样限长，否则导出后在别人那边会算出不同的 key
- **导出译库时把"源文被截断"的缓存条目也导出了** → 别人导入后**永远命中不了**，白占体积
  → 缓存给长文本打 `tr` 标记，导出时跳过
- **术语占位符被机翻吃掉时，`[[0]]` 标记会漏到界面上** → 不论术语是否还原成功，
  都先清掉残留标记（原来在"还原失败"分支里反而保留了带标记的原文）

顺带把 `/api/compare` 的错误返回统一成 `{ok:false,error}`（原来只返回 `{error}`，与其它接口不一致）。

**⑰ 内置引擎：用浏览器自带的本地模型翻译（完全离线）**

针对"不想联网 / 不想配密钥 / 不想碰免费接口条款"的场景，加了第 8 个节点**内置引擎**：
用 Edge / Chrome 138+ 的 **Translator API**（语言包在本机运行），翻译过程不出本机。

- 先做了可行性实测，拿到三条决定性结论：
  1. **语言包没下载过时 `Translator.create()` 要求"用户激活"**（`NotAllowedError`）
     → 所以做成"用户点一下启用"；服务端通过 CDP 调用时带 `userGesture`，设置页也能触发
  2. 首次下载约 **197.5 MB / 50~75 秒**（实测），之后 `create()` 只要 10 毫秒级、
     每句约 **17 毫秒**、600 字长文 193 毫秒
  3. **语言包随浏览器 profile 持久化**（优雅退出保住；硬杀进程会丢）
     → 所以有"启用一次，之后一直可用"的 UX
- 架构：模型跑在页面里，Node 侧只能转发 —— 新增 `setLocalTranslator()` 钩子，
  服务端通过 CDP 调 `window.__galeTrans.localTranslate()`。
  这样**缓存 / 译库 / 术语占位符 / 择优 / 润色全都能复用**，不用另起一套
- 语言码映射：`zh-CN`→`zh`、`zh-TW`→`zh-Hant`（该 API 只认这两个中文码）；源语言 `auto` 按 `en` 处理
- 串行处理（API 本身就是顺序的），并发固定为 1
- 界面：选中「内置引擎」后自动显示状态与「启用内置引擎」按钮；
  语言包一就绪**立刻清掉失败退避并重新扫描**（否则用户还要再等 20 秒）
- **下载进度可视化**（本轮新增）：进度条 + 已下载量 + 下载速度 + 已用时间 + 预计剩余。
  为了做这个先探测了 `downloadprogress` 事件，结论是**它只给 0~1 的百分比**（`total` 恒为 1，拿不到字节数），
  所以「已下载量 / 速度」是按语言包体积（实测 197.5 MB）换算的**估算值**，界面上标了「约」并带 tooltip 说明。
  另外：还没收到进度事件时用**不确定态**的滑动条（不假装知道百分比）；
  下载期间轮询从 2 秒收紧到 **700 毫秒**（实测下载可能只要十几秒，2 秒轮询会让进度条几乎不动）
- 新增 `tools/test-builtin.mjs`（24 项断言，端到端真实下载语言包）；
  它**不在 `npm test` 里**（首次要下 200MB），用 `npm run test:builtin` 单独跑

**⑱ 移除三个官方 API 节点（腾讯云 TMT / 有道智云 / Google Cloud）**

上一版加的这三个节点在实测后判断为**收益不足**：有 DeepSeek（OpenAI 兼容节点）一个 Key 就覆盖了
「正规计费、术语最准」的需求，再维护三套各家签名算法属于净负担。于是整段移除：

- 删掉 `providers.mjs` 里约 267 行实现（TC3-HMAC-SHA256 签名、有道 v3 签名、Google Cloud 批量）
  与对应的 `crypto` 导入、语言码映射分支、并发配置、节点注册项
- 删掉 `tools/test-official-api.mjs`（59 项）与 `package.json` 里的 `test:official`
- 七个密钥字段（`tencentCloud*` / `youdaoApp*` / `googleCloud*`）加入 `REMOVED_CONFIG_KEYS`，
  这样**填过密钥的旧配置升级后会被自动清理**，不留悬空字段
- 需要密钥的节点现在只剩 **OpenAI 兼容（推荐 DeepSeek）/ DeepL / LibreTranslate** 三个

**⑲ 内置引擎置顶 + 管理能力 + 本地大模型节点（用户实测反馈后的一轮）**

**置顶并设为默认**

- `PROVIDERS` 注册顺序把 `builtin` 放到第一位（列表顺序即注册顺序），新装默认 `provider: 'builtin'`，
  `fallback` 设为 `['tencent','youdao']` —— 语言包还没下载时自动兜底，**开箱依然能看到中文**

**内置引擎管理能力**（设置页 + 页内抽屉都有）

- 「重置引擎」：丢掉页面里的模型实例（`localReset()`），下次翻译重新创建，**不删磁盘文件**。
  模型状态异常时不用重启 Gale
- 「查看语言包占用」/「删除语言包」：`GET /api/local-engine/pack` 在几个已知 profile 根目录下
  **有边界地**扫描 `EdgeTranslateKitLanguagePack` 并统计占用（限制深度与访问量，不做全盘遍历）；
  `POST .../pack/delete` 删除并返回释放空间。破坏性操作三重防护：必须 `confirm: true`、
  **Gale 运行中直接拒绝**（文件被占用）、界面用**按钮上的两步确认**
  （不用原生 `confirm` —— WebView2 / Tauri 里不一定被宿主处理，可能静默返回 false）
- 新增「重新检测」按钮

**新增：本地大模型节点（Ollama / LM Studio）**

- 新增 `local-llm` 节点：和 `openai` 走同一套协议，但**不需要密钥、地址默认指向本机**
  （`http://127.0.0.1:11434/v1`，模型默认 `qwen2.5:7b`），且**强制不走代理**（本地地址走代理反而连不上）
- 把 OpenAI 兼容的请求逻辑抽成共享函数 `openAiCompatibleTranslate()`，两个节点复用

**修复**

- **内置引擎状态被误报成「未下载」，而且「启用」按钮被藏掉**（用户实测反馈）：
  `/api/local-engine` 以前把「还没连上 Gale」和「浏览器不支持」都返回成 `supported: false`，
  界面据此把「启用内置引擎」按钮 `display:none` —— 用户看到的就是"显示未下载、又没法下载"，完全查不出原因。
  现在服务端用 `bridgeDown` 明确区分，界面按真实原因分档提示（未连接 / 不支持 / 未下载 / 下载中 / 就绪），
  **按钮始终保留**；未连接时每 2 秒自动重试（Gale 一起来就自愈）。
  另外把 `lastError` 与当前语言对的原始可用性都摆到界面上，失败原因不用猜
- **状态判断写死了 `en>zh`**：目标语言改成繁体（`zh-Hant`）时会误报「未下载」。
  改成按**当前配置的语言对**判断（`localStatus(source, target)` → `ready` / `wantKey`）
- **抽屉脚本被重复注入，会把用户正开着的抽屉拆成空白**（排查上一条时挖出来的真 bug）：
  两个原因叠加 —— ① `Page.addScriptToEvaluateOnNewDocument` 是**累加**的，
  代码注册后从不移除，每重连一次就多堆一份；② `inject.js` 的 `boot()` 里有一行会顺手删掉
  `#gale-drawer-host`。于是"重新注入"= 抽屉被删 + 重建 → 正开着的那份没了。
  修法：`cdp.mjs` 记录 `identifier` 并先移除上一份；`drawer.js` 加**基于代码指纹的幂等守卫**
  （同一份代码重复注入直接跳过，代码变了才重建），重建时保留「原来开着就继续开着」；
  `inject.js` 不再越权删抽屉宿主
- **`localTimer.__ms = ms` 给数字加属性**：浏览器里 `setInterval` 返回的是**数字**，
  严格模式下赋值会抛 `TypeError`，直接把抽屉的首次渲染打断（集成测试抓到的）
- **测试会顺带启动 Gale**：原来的集成测试为验证"新装默认节点"起了一个全新服务，
  而默认 `autoLaunchGale: true` —— 实测真的把 Gale 拉起来了。
  改成把默认配置抽成 `core/defaults.mjs` 直接断言，无副作用

**修复**

- **引擎会注入到插件自己的设置页**（写 i18n 测试时抓到的真 bug）：CDP 选页面用的是
  `/tauri\.localhost|^file:|^https?:/`，把 `http://127.0.0.1:8799/`（插件自己的设置页）也当成了 Gale 页面。
  后果很隐蔽：i18n 把标题 `使用说明` 翻成 `Usage` 之后，引擎又把 `Usage` 当成 Gale 的英文内容、
  按固定译法翻回了 `使用方法`。修法两层保险：
  ① `cdp.mjs` 选页面时优先 `tauri.localhost` / `file:`，并**排除插件自己服务端口上的页面**；
  ② `inject.js` 启动时自检「页面是否与 API 同源」，同源就直接不注入。
  并补了回归断言（集成测试断言设置页的 `window.__galeTrans` / `window.__galeDrawer` 都是 `undefined`）
- **调试端口落在 Windows 保留段时，原逻辑等于没救**：扫完 20 个端口全失败后又会退回配置端口，
  而那个端口恰好就是开不起来的那个。实测本机 `9223~9322` 整段被保留（`netsh int ipv4 show
  excludedportrange protocol=tcp` 可查），导致 Gale 的 `--remote-debugging-port=9223` 开不起来、
  外挂挂不上、悬浮条不出现。现在改为实际试绑 + 兜底到系统分配端口，并在界面与日志里说明原因。
- 启动 Gale 后不再"启动完就完事"，会等最多 25 秒确认调试端口真的打开；没打开就明确告警（这是"悬浮条不出现"的头号原因）
- 页内抽屉在 `document-start` 注入时 `document.body` 还不存在，导致 `appendChild` 抛
  `TypeError: Cannot read properties of null`（集成测试抓到的真 bug）→ 改为等 DOM 就绪再建 UI
- 悬浮条的 `⚙` 与 `#gale-drawer-host` 一起纳入 MutationObserver 忽略列表，避免抽屉自身触发无谓重扫
- 「停用」的节点不再出现在备用（兜底）链里；`quality.voters` 里失效/停用的 id 会被跳过并自动补足
- 删除 4 个只服务于必应 / MyMemory 的一次性探测脚本（`tools/test-bing.mjs`、`tools/test-providers*.mjs`），
  并从 `tools/test-proxy.mjs` 里去掉必应相关用例

**⑳ 内置引擎：查清「在 Gale 里为什么永远用不了」，并修掉 4 个界面 / 接口缺陷**

- **结论：这是环境限制，不是插件的 bug。** Gale 用的是 **WebView2**，它**不提供** Chromium / Edge 那层
  端侧翻译模型（Optimization Guide / TranslateKit）。实测（WebView2 运行时 = Edge **154.0.4258.62**）：
  `Translator` 对象存在、`availability()` 对**全部**语言对（`en>zh`、`en>zh-Hant`、`en>ja`、`en>es`、
  `en>fr`、`en>de`、`ja>en`、`zh>en`）都返回 `unavailable`，`Translator.create()` **1 毫秒内**抛
  `NotSupportedError: Unable to create translator for the given source and target language.`，
  `downloadprogress` **一次都不触发** —— 语言包根本不会开始下载。**改 JS 无解。**
- 已排除的原因（都实测过）：硬件门槛（16 GB 内存 / 16 线程 / 磁盘余量充足）、内置 AI 被整体封禁
  （同一页面里 `LanguageDetector`、`Summarizer` 都可用）、Edge 版本过低（154 远高于 138）
- 机制性证据：Edge 浏览器 profile 里有 `EdgeOptimizationGuideModelsManifest`、`EdgeOnDeviceSpeechModel`
  等模型清单目录，而 Gale 的 WebView2 profile（`%LOCALAPPDATA%\com.kesomannen.gale\EBWebView`）里**从来没有**
- 试过强制开启：给 Gale 注入
  `--enable-features=OptimizationGuideModelDownloading,OptimizationGuideOnDeviceModel,TranslationAPI,LanguageDetectorAPI`
  （已核对浏览器进程命令行，参数**确实到达**），结果与基线**一字不差** → 此路不通，不要再试
- 反向对照（说明缺的确实只是 WebView2 这层）：用**真正的 Edge 154.0.4258.62**（`--headless=new` + 独立 profile）
  打开一个本地页面，`Translator.availability()` 返回 **`downloadable`**，
  `Translator.create({ sourceLanguage: 'en', targetLanguage: 'zh' })` **15 秒**下完语言包（131 次 `downloadprogress`，
  profile 涨到 437 MB），`translate()` 输出「敏捷的棕色狐狸跳过懒惰的狗。」→ 端侧翻译 API 本身没坏
- **修 ①：「语言包占用 / 删除」入口改为常驻。** 以前它藏在 `#localBox` 里、且只在「就绪 / 正在下载」时显示，
  而环境不支持时**永远不会就绪** → 删除入口 100% 够不到（就是反馈里的「缺乏引擎删除功能」）。
  更隐蔽的是服务端在 `unusable` 时会把 provider 自动切走，那样整个 `#localBox` 都隐藏，更够不到。
  现在这一行**移到内置引擎区块外面**（纯磁盘操作，本来就和"当前选哪个节点"无关），设置页与页内抽屉都改了
- **修 ②：如实说明「环境不提供端侧模型」，而不是「语言包还没下载」。** 以前 `unusable` 会掉进最后的 else，
  显示「还没下载：首次启用约需下载 200 MB」并**放开「启用」按钮** → 点了一点反应都没有、进度条永远 0%
  （就是反馈里的「无法正常下载引擎数据、不显示下载速度」）。现在遇到 `unusable` 直接写原因
  （`⛔ 当前运行环境不提供端侧翻译模型（Gale 用的 WebView2 就是如此）…`）并把「启用」置灰
- **修 ③：`POST /api/local-engine/prepare` 不再假报成功。** 以前是「发射后不管」，立即回
  `{ok:true,started:true}` —— 页面里 1 毫秒就抛错也照样报成功，抽屉永远停在「已开始下载，请稍候…」。
  现在先等最多 1.5 秒拿首个结果：立刻失败就回 `{ok:false,started:false,error}`（界面直接显示原因），
  真在下载（约 200 MB）才转后台
- 新增的界面文案补齐英文词条；README 如实写明这个限制，并把替代方案指向
  **LibreTranslate** 与**本地大模型（Ollama / LM Studio）**——那两个是插件自己发 HTTP 请求，不依赖浏览器
- 回归断言：`npm run test:integration` 新增「语言包入口常驻」与「环境不支持时启用按钮被禁用」两项，
  并放宽状态文案正则（原来只认 `语言包|连接到 Gale|不支持|正在`，新文案会被误判成失败）

**㉑ 内置引擎终于能用了：插件自带的无窗口 Edge 后端（完全离线、免密钥）**

- **结论升级：WebView2 那条路确实不通，但不必因此放弃离线翻译。** 既然端侧模型只在**真正的 Edge**
  里有（见 ⑳ 的反向对照），插件就**自己拉起一个无头 Edge** 来跑模型：用户不用额外安装任何东西，
  也不用改 Gale 的任何文件，语言包只下一次（约 200 MB）之后一直可用
- 新增 `core/edge-worker.mjs`（Node 侧进程/CDP 管理）与 `core/edge-worker-page.js`（worker 页面脚本，
  与页内那套 `window.__galeTrans` 同接口：`localStatus` / `localPrepare` / `localTranslate` / `localReset`）
  - 启动参数：`--headless=new --disable-gpu --no-first-run --no-default-browser-check --disable-extensions
    --remote-allow-origins=* --remote-debugging-port=0 --user-data-dir=<插件自己的 profile>`
  - **独立 profile**：`data/edge-profile`（已被 `.gitignore` 忽略）。不读也不动用户正在用的 Edge profile ——
    浏览记录 / Cookie / 登录态都不碰；调试端口只监听 `127.0.0.1`，页面只加载本机
    `http://127.0.0.1:<服务端口>/edge-worker`，不接受外部导航
  - `--remote-debugging-port=0` 让系统分配端口（本机 `9223~9322` 整段被 Windows 保留，写死端口会踩坑），
    端口从 `<profile>/DevToolsActivePort` 读回；进程按"命令行里带自己的 profile 路径"精确匹配，
    `stop.cmd` / `/api/shutdown` 会把整个 Edge 进程树一起收掉
  - **按需启动**：只在真的要翻译、要下语言包、或语言包已在磁盘上（启动即预热）时才拉起
- **后端选择（`localBackend()`）**：优先用 **Gale 页面自己**的 Translator（页面内核是真正的 Edge 时可用），
  否则用**插件自带的 Edge 后端**；两条都不行才如实写原因。`/api/local-engine` 会多回
  `backend: 'gale' | 'edge' | ''` 与 `worker: { available, running, attached, pid, port, profile, packInstalled, packPath, lastError }`
- **没挂上 Gale 时不许偷偷下 200 MB**：`bridgeDown` 的语义保持不变（"还没连上" != "浏览器不支持"），
  未挂载时 `prepare` / `reset` 直接报错、不拉起任何浏览器 —— `GET/POST /api/local-engine*` 的原有契约不变，
  `npm run test:integration` 里那 4 条断言正是守这个的
- 语言包管理跟着扩展：`查看语言包占用` 会同时列出 Gale 目录下那份**和** `data/edge-profile` 下那份；
  `删除语言包` 在删插件那份之前会先停掉无窗口 Edge（删 Gale 那份时 Gale 运行中仍然拒绝）
- **默认不再自动切换节点**：`core/defaults.mjs` 的 `autoSwitchFromBuiltin` 默认改为 `false`。
  内置引擎不可用时**不会**把待翻译文本悄悄改发给腾讯 / 有道（开源版默认不把用户内容发给第三方）
- 界面：就绪文案区分为「✅ …（由插件自带的 Edge 提供，无窗口后台运行）」；诊断行新增
  「本地翻译后端启动失败：…」；进度、速度、重置、占用、删除都复用原有 UI（两个后端同一套接口）
- 实测：语言包 **207,102,962 字节（197.5 MiB）约 15 秒**下完；
  `POST /api/test-provider { provider: 'builtin' }` **49 ms** 返回正确译文；
  `workerTranslate(['The bees are happy. Also, beware of the wolves at night.'])` → 「蜜蜂很开心。另外,晚上要提防狼。」
- 自测：新增 `npm run test:edgeworker`（**离线** 57 项契约自测：路径与常量、`localLang()` 映射、
  worker 未启动时的纯磁盘推断、worker 页面脚本接口、`server.mjs` 的接线正则，以及
  **`.gitignore` 必须忽略 `data/` 与 `test/.tmp/`**——否则 200 MB 语言包会被提交进仓库）
- 顺带修掉两个存量文案 bug：状态栏在已挂载时显示自相矛盾的「已挂载 + Gale 在运行但未挂载」；
  `core/providers.mjs` 里 builtin 节点的说明还写着"实测 Gale 的 WebView2 不提供，选它会翻译失败"
- 顺带修掉集成测试的 TEMP 泄漏：Windows 上 Edge 被 kill 之后子进程还占着 profile 目录，
  原来那句 `rmSync` 会**静默失败**，每跑一次 `npm test` 就在 TEMP 里留下一个 ~40 MB 的目录
  （实测连跑几轮攒了 341 MB）→ 改成先等进程真的退出、再带重试地删
- README 同步：内置引擎章节改为"插件自带 Edge 后端"、新增「为什么非要自己拉一个 Edge」把 WebView2
  的实测证据留作设计依据、测试清单变九套、常见问题新增「内置引擎会另外开一个浏览器？我怎么没看见？」

**㉒ 删掉语言包也能重新下回来 + 「仅本地翻译（禁用联网）」开关**

**① 修掉「内置引擎的语言包删掉之后再也下不回来」（用户实测反馈）**

- **根因（实测，不是猜测）**：只删 `data/edge-profile/EdgeTranslateKitLanguagePack` 时，
  Edge 的**组件登记**仍然认为装过（`Local State` + `component_crx_cache` 里那个 178.5 MB 的 CRX），
  于是新起的 worker 里 `Translator.availability()` 照样报 `available`，但
  `Translator.create()` 立刻抛 `Unable to create translator for the given source and target language.`，
  而且**永远不会重新下载** —— 用户看到的就是"删掉之后怎么点都没反应"
- 还查到第二种长相：**下载中断留下的空壳目录**（实测 `EdgeTranslateKitLanguagePack\en-zh` = 0 字节，
  但目录存在）→ 页面这次报的是 `downloadable`。所以"目录在不在"不足以判断好坏，
  还得看**体积像不像真的**（`PACK_REAL_MIN_BYTES = 5 MB`）
- 语言包识别改成**按名字模式**（`/TranslateKit.*LanguagePack$/i`，扫 profile 顶层、支持多个），
  并区分「整个语言包坏」与「某个语言对那份是空壳」（语言包是**按语言对**存在 `en-zh` 这种子目录里的）
- 新增 `wipeProfile()`：先 `stopWorker()`，再带重试地删掉**整个** `data/edge-profile` 并校验；
  这是**实测唯一**能让 Edge 重新下载的做法 —— 只删语言包目录是没用的（原因见上）
- `workerPrepare()` 变成**两层自愈**：① 状态里 `stalePack` 就先清 profile 再下（`preparing` 时不打断正在进行的下载）；
  ② 创建翻译器失败（`CORRUPT_RE`）且磁盘上没有完整语言包时同样清掉重来
- `workerStatus()`/`diskStatus()` 新增 `stalePack`：**页面说可用、磁盘上却没有完整语言包 = 页面在骗人**，
  这时如实回报「本地模型文件不完整（可能被删过或上次没下完）：点「启用内置引擎」会清掉旧数据重新下载」
- `POST /api/local-engine/pack/delete` 对 Edge 后端改成清空**整个 profile**（语言包 + Edge 组件缓存，
  实测约 437 MB），并如实回报 `freedBytes`；Gale 自己那份仍按目录删（Gale 运行中会拒绝）
- `GET /api/local-engine/pack` 增加 `workerProfile: { path, bytes, packBytes, packInstalled }`；
  「查看语言包占用」现在写明「插件自带的 Edge 数据目录 …：437.3 MB（其中语言包 197.5 MB）」
- 抽屉新增 `stalePack` 分支（⚠ 提示 + 只需点「启用内置引擎」），删除后的文案改成
  「已清理 N 处，释放 X MB。下次用内置引擎会自动重新下载。」
- 实测：`pack/delete` → `{ ok: true, freedBytes: 458623601 }` → `prepare` → 4s 12%（42.4 MB/s）→ 12s 100%
  → 16s 就绪 → `test-provider` 47 ms 出正确译文；「删除 → 重新启用」全流程可逆

**② 新增「仅本地翻译（禁用联网）」开关（开源场景下彻底规避第三方条款风险）**

- 新配置 `offlineOnly`（默认 `false`）：只允许**请求不出本机**的节点，其余全部停用
- **拦截做在唯一的对外 HTTP 出口上**（`core/net.mjs` 的 `request()`）：目标 host 不是
  `127.x` / `localhost` / `::1` 就直接抛 `仅本地模式已开启：已拦截对 <host> 的网络请求（POST https://…）`，
  并写一条 warn 日志。这样**不只是翻译节点** —— LLM 润色、代理检测、译库导入 URL 等等全都覆盖到了
- 新增 `isProviderLocal(id, cfg)` / `filterLocalProviders(ids, cfg)`：`builtin` 与 `cache-only` 恒为本地；
  `local-llm`（`localLlmBaseUrl`）、`libretranslate`（`libreUrl`）、自定义节点（各自的 `url`）
  **按地址是不是回环**判定（指向 `192.168.x.x` 的同样算远程、会被拦）；`tencent/youdao/google/deepl/openai` 恒为远程
- `core/server.mjs`：`loadConfig()` 与 `POST /api/config` 之后都同步网闸；`usableProviderIds()` /
  `activeChainIds()` 过滤非本地节点；`nodeDiagnostics()` 区分三种"没有可用节点"的告警；
  `/api/status` 多回 `offlineOnly` 与 `offlineBlocked`（界面据此置灰在线节点）
- `core/translate.mjs`：建链时同样过滤，空链错误改成
  「仅本地模式已开启，当前翻译节点不是本地节点（或本机没有任何可用的本地节点）」；
  润色在 `offlineOnly` 且其地址不是回环时直接不启用（免得刷一屏被拦的日志）
- 界面：页内抽屉与设置页的「翻译节点」上方都有这个勾选框 + 说明；
  在线节点在列表里**置灰并标注**（`[仅本地模式下已停用]` / `（仅本地模式下已停用）`），
  点它们不切换而是提示原因。说明里**如实交代唯一的例外**：内置引擎首次要下载约 200 MB 语言包，
  那次下载会联网（只下模型本身，不发送任何要翻译的文本）
- 服务日志会为那次下载单独记一条 warn，避免用户"开了禁网却在抓包里看到流量"而困惑
- `core/i18n.js` 同步词条（注意：`'仅本地翻译（禁用联网）'` 这类**全角括号的键必须加引号**，
  否则 `node --check` 直接报 `SyntaxError: Invalid or unexpected token`）
- 实测（`POST /api/config {offlineOnly:true}`）：点名腾讯 → 被拦并给出可读错误；`provider=tencent` 再
  `/api/translate` → 明确报"当前翻译节点不是本地节点"而不是发出去；内置引擎照常 1100 ms 出译文；
  配置往返 `offlineOnly` 落盘；关掉后在线节点恢复
- 自测：`test:edgeworker` 57 → **98 项**（新增「语言包自愈」与「仅本地模式」两节契约断言，
  含"语言包目录名不能加 `^` 锚定"这条踩过的坑）；`test:integration` 139 → **162 项**
  （新增一节：回环判定、网闸真拦得住、本机地址照样放行、节点过滤、配置往返）

**㉓ 发布时自带语言包 + 没装 Edge 的场景 + 一轮界面文案订正**

**① 自带语言包（seed）：发布包里直接带一份，用户点「启用内置引擎」秒装、不联网**

- 新增识别：`<项目根>/data/edge-pack/` 或 `<项目根>/edge-pack/` 里只要有语言包目录就算「自带了一份」
  （`seedProfileDir()` / `seedInfo()` → `{ ready, path, bytes, runtime }`）
- `adoptSeed()` 的三条铁律：**① 只在本机还没有完整语言包时才用**（绝不覆盖已经下好的那份）；
  **② 是复制不是移动**（自带那份留着，用户删了语言包还能再吃一次）；**③ 任何失败都退回正常下载**
  （复制完再校验一遍，不真就返回 `adopted:false` 并继续走下载）
- 触发点在 `launch()` 里：所以「启用内置引擎」、以及损坏后的自愈重建，都会先吃自带语言包；
  `workerPrepare` 的两层自愈因此也变成"不联网修复"
- **最小集合是二分法实测出来的**：语言包（197.5 MB）+ `EdgeLLMRuntime`（3.27 MB，`onnxruntime-genai.dll`）
  **缺一不可**；只带语言包时 Edge 会一直报 `downloadable`、`Translator.create()` 立刻抛
  `Unable to create translator for the given source and target language.` 并且**永不重下** ——
  这就是"精简版必须带运行时"的原因
- 反向确认：`component_crx_cache`（含那个 178.5 MB 的 CRX）、`Local State`、`Default`、`Last Version`
  移走都照样能翻 → 精简版不带它们（顺带也不会把导出者电脑上的 Edge 账号信息一起发出去）
- 实测（把 `data/edge-profile` 换成空目录后走真通路）：
  `已铺开自带语言包（200.8 MB，复制自 …\data\edge-pack），不用联网下载` →
  `prepare` **2277 ms** → `ready:true`、`pairs.en>zh=available` → 译文
  `["蜜蜂很高兴。","在夜间留意狼。"]`（对照：正常下载要十几秒且必须联网）
- 状态里多报 `seedRuntime` / `runtimeInstalled`；界面提示语收紧到 `seed.ready && seed.runtime`
  ——缺运行时的 seed 不会再骗用户"自带的那份会直接装好"
- 新增 `tools/export-edge-pack.mjs`：`node tools/export-edge-pack.mjs`（精简，约 201 MB）/
  `--full`（整份 profile，会带上登录状态，对外发布不推荐）/ `--out <目录>`；产物默认落 `data/edge-pack`；
  没找到 `EdgeLLMRuntime` 时告警并建议 `--full`

**② 照顾没装 Edge 的机器**

- `edgePath()` 支持环境变量 `GALE_TRANS_EDGE_PATH`（绿色版 / 非标准安装位置，或以后换别的 Chromium 做实验），
  仍按 `ProgramFiles(x86)` / `ProgramFiles` / `LOCALAPPDATA` 找标准安装
- 新增 `hasEdge()`；`GET /api/local-engine/pack` 多回 `seed` 与 `edge: { available, path }`
- `launch()` 的报错改成完整可操作文案：说明需要一个 **Edge 148+**、怎么用环境变量指定，
  并直接给出替代方案（「本地大模型（Ollama）」「本机 LibreTranslate」、或者到设置里换在线节点）
- `/api/local-engine` 在「后端连不上 **且** 本机没有 Edge」时给专门的 `noBrowser` 标记与原因文案；
  只是还没连上 Gale 时仍然报"还没连接"，不会被这条盖掉
- 结论保持一致：内置引擎不可用时**不会**自动把文本改发给腾讯 / 有道（`autoSwitchFromBuiltin` 默认关）

**③ 界面与管理文案订正（对着界面逐条核过一遍，33 处）**

- 三处「标题与内容不对应」改掉：`语言` → **「语言与网络」**、`翻译行为` → **「术语与译文处理」**、
  `译文质量` → **「译法比对与润色」**（抽屉与设置页同步，i18n 词条一起改）
- 「浏览器本地模型」这类说法统一成**「本机 Edge 的端侧模型」/「插件拉起的无窗口 Edge」**
  （`providers.mjs` 的节点名与说明、`inject.js` 的不可用原因、内置引擎区块、注释）
- 代理占位符写成真正接受的字面量 `system`（原来写的是界面按钮名「跟随系统代理」）；
  备用节点占位符 `youdao` → `tencent, youdao`（与默认 `fallback: ['tencent','youdao']` 一致）
- 「删除语言包」的两步确认与结果行重写：说明它清空的是**整个** Edge 数据目录（语言包在里面）、
  删完点「启用内置引擎」会自动装回来（有自带语言包时不用联网）、Gale 那份要先关 Gale；
  结果行改成「已清理 N 处，释放 X」（原来只提"语言包"，与"清的是整个 profile"对不上）
- 「查看语言包占用」现在报三段：Gale 那份、`data/edge-profile` 那份（**其中语言包 X MB**）、
  `data/edge-pack` 自带的那份；本机没装 Edge 时也会直接说明
- 补齐原兜底分支的 `stalePack`（语言包被删/没下完时不再说"还没下载"）；
  「恢复被停用的内置节点」→「恢复所有被停用的内置节点」；占位符清单补 `{{texts_count}}` 段数；
  最小翻译长度输入框统一成 `number`；保存提示不再说"会刷新页面"（实际是软应用）；
  「测试当前节点」的说明写明内置引擎首次要先下语言包
- `core/server.mjs` 的过时注释改掉（不再声称"不可用时会自动换 provider"）；
  腾讯节点的说明从"默认推荐"改成"**推荐备用**"；`localLlm` / `libretranslate` 的说明补上
  "地址不是回环时就不算本地节点、开仅本地模式会被停用"
- README 同步：`内置引擎：完全离线的翻译` → 「本地模型翻译（首次需联网下约 200 MB 语言包）」、
  `✅ 完全离线` → `✅ 本地`、默认节点与备用节点的说法对齐默认配置、
  老一套「组策略注册表让 WebView2 可调试」的做法标注为**废弃且不要再用**（会拖慢 Gale 启动、
  可能把整台机器的 WebView2 变成可调试）、架构图补上"插件拉起的无窗口 Edge"这条后端
- `core/i18n.js` 词条逐条同步（含两条动态行正则：语言包占用合计、清理结果）；
  `tools/test-i18n.mjs` 加严到**58 项**并保持「界面文案 0 条遗漏」的断言

**④ 测试与文档**

- `test:edgeworker` 98 → **126 项**（新增自带语言包一节：两个导出目录的识别、
  `seedInfo()` 形状、`adoptSeed()` 的"先查运行时再动手"顺序、复制不移动、失败退回下载、
  没装 Edge 的替代方案文案、导出工具的精简规则）；
  `test:integration` 162 → **165 项**（`pack` 路由新增 `workerProfile` / `seed` / `edge` 三个字段）
- README：§一 加"可以自带一份语言包（`data/edge-pack`）怎么用/怎么删"、管理按钮表格重写、
  §五 目录结构补 `tools/export-edge-pack.mjs` 与 `data/edge-pack`、
  §七 新增两条 FAQ（**发布时怎么自带语言包**、**没装 Edge 怎么办**）、§六 测试项数与说明同步

**㉔ 0.1.0 定稿：删掉三个免密钥节点、自带语言包可删、打包**（**本条中"删掉三个节点"的部分已被 ㉕ 撤销**，
其余（自带语言包可删、改名、打包）继续有效）

- **删除内置的「腾讯交互翻译 / 有道翻译 / Google 翻译」三个节点**（决定是"完全规避风险"）：
  它们走的是**网页公开接口**、不是官方开放 API，条款、限流与稳定性都不可控。具体范围：
  - `core/providers.mjs` 里三段实现整段移除；`PROVIDERS` 注册表、`RATE_LIMIT`（去掉三条免费接口的间隔）、
    `CONCURRENCY`（只留 `builtin: 1`）、`mapLang()` 里对应的语言码分支一并清掉。
    现在内置节点只剩 `builtin / deepl / openai / local-llm / libretranslate / cache-only`
    （⑦ 里那份列表以本条为准：腾讯 / 有道 / Google 已不在其中）
  - **备用链默认改回空**（`core/defaults.mjs` 的 `fallback: []`）：不再"语言包没下好就自动兜底到腾讯 / 有道"，
    而是**界面写明原因、由你自己决定**（`autoSwitchFromBuiltin` 依旧默认关）
  - `core/server.mjs`：配置迁移时失效节点**回落到内置引擎**（原来回落腾讯）；代理连通性探测从 Google 换成
    `https://api.openai.com/v1/models`（200 / 401 都算通）；`REMOVED_CONFIG_KEYS` 里三家的密钥字段保留
    （老配置升级时清空，避免留下悬空字段）
  - `core/translate.mjs` 的反向翻译选点重写（`quality.voters → fallback → builtin → local-llm → libretranslate`），
    默认 provider 与代理提示条件同步；`core/inject.js` / `core/drawer.js` / `ui/index.html` 里
    "默认 youdao / 兜底 tencent" 的地方一律改成内置引擎
  - 代理说明改成"只有 DeepL / OpenAI 这类境外节点需要；本机服务不要填"；备用节点占位符 → `deepl, openai`
- **「下载模型」改名「下载语言包」**（11 处：两套界面按钮、提示文案、i18n 词条、导出工具、测试与文档）
- **自带语言包（`data/edge-pack`）也能删**：`core/edge-worker.mjs` 新增 `removeSeed()`，
  `POST /api/local-engine/pack/delete` 支持 `scope: 'seed' | 'all'`（返回体带 `scope` / `seedDeleted`）；
  界面不单独给按钮——「删除语言包」会把它一起清掉（详见下面 **㉖**）
- **打包**：`npm run package` 出 `dist/Gale-Mod-Translator-v0.1.0.zip`（主包不含语言包，`data/` 本就排除在外）
- **测试同步**：`test-ratelimit` 整体重写（36 项：用本机 mock 验证 OpenAI 兼容节点 3 段合并成 1 次请求、
  30 段切分成 12/12/6、429 时快速失败、冷却后按备用链切换）；`test-i18n` 61 项；`test-edge` 29 项；
  `test-integration` **175 项**（迁移夹具与"仅本地模式"断言改用 deepl / openai；新增自带语言包删除通路的
  API + 界面两步确认断言，隔离环境里现造一份假 seed 来验，删完断言 `data/edge-pack` 真的没了）；
  删掉 `tools/test-transmart.mjs`（腾讯专用探测工具），`tools/test-proxy.mjs` 改成只探 DeepL / OpenAI
- 文档：README §四 节点表按新节点集重写、§七 的 Google 429 FAQ 改成通用的"额度 / 频率受限"、
  §八 隐私一节改成"不再内置任何免密钥的网页抓取接口"；下面 §六 的测试项数同步

**㉕ 加回腾讯 / 有道 / Google + 悬浮条 / 抽屉 / 设置页界面重构**（本条**部分撤销 ㉔**）

- **加回三个免密钥节点**（㉔ 的删除决定按实测风险权衡后撤销）：`core/providers.mjs` 恢复
  `tencent` / `youdao` / `google` 三段实现与 `PROVIDERS` 注册表顺序
  （`builtin, tencent, youdao, google, deepl, openai, local-llm, libretranslate, cache-only`）、
  `RATE_LIMIT`（`tencent: 200, youdao: 1300, google: 400`）、`CONCURRENCY`（`google: 1, youdao: 1, tencent: 2, builtin: 1`）、
  `mapLang()` 的短码分支；腾讯的节点名改为「推荐备用」（默认节点仍是内置引擎）
- **引用面一起恢复**：`core/defaults.mjs` 的 `fallback: ['tencent', 'youdao']`；`core/server.mjs` 的代理探测回到
  `translate.googleapis.com`（HEAD 那套 200 判定）；`core/translate.mjs` 的代理提示条件回到 `/^google/`、
  `_backTranslate()` 候选表把三个免费节点放回最前面（`offlineOnly` 时仍然一个都不给）；
  两套界面的备用节点占位符 → `tencent, youdao`、择优节点占位符 → `tencent, google`、
  代理说明 → 「只有 Google、以及你自己配的 DeepL / 大模型这类境外节点需要代理；腾讯、有道始终直连，本机服务不要填」；
  `core/i18n.js` 同步词条并加回两条 Google 429 规则
- **有意保留 ㉔ 的两条**：失效 / 被删节点**仍回落到内置引擎**（不静默把用户文本改发给第三方）、
  `autoSwitchFromBuiltin` 仍默认关；`REMOVED_CONFIG_KEYS` 不动（那是更早移除的腾讯云 TMT / 有道智云 /
  Google Cloud **官方 API** 节点的密钥字段）
- **界面重构（一套主题 token，三处界面共用）**：`core/i18n.js` 新增 `THEME = { shared, dark, light }` +
  `themeVars()` / `themeCss()` / `galeMode()` / `browserMode()`，挂到 `window.GALE_UI.theme`；
  调色板对齐 Gale 自己的 Tailwind 调色板（中性 = **slate**、强调 = **green**）：
  暗色 `--g-bg:#0f172a`（Gale 的 primary-900）、`--g-surface:#1e293b`（primary-800）、`--g-line:#334155`、
  `--g-fg:#f1f5f9`、`--g-acc:#16a34a`；亮色 `--g-bg:#f1f5f9`、`--g-surface:#fff`、`--g-fg:#0f172a`、`--g-acc:#15803d`。
  字号整体加大（基准 14px、设置页 15px、label 12.5~13px）、圆角 `12/9px`、抽屉宽度 404 → **440px**
  - 注入进 Gale 的悬浮条 / 抽屉 / 搜索提示框：`<style id="themeVars">` 由 `GALE_UI.theme.css(galeMode())` 生成，
    **跟着 Gale 自己的 `<html class="dark">` 换肤**（不能用 `prefers-color-scheme`：Gale 在亮色系统上也会用暗色皮肤，
    实测本机 `matchMedia('(prefers-color-scheme: dark)')` 是 false 而 Gale 是暗色）；
    并用 `MutationObserver` 监听 `<html class` 变化，只重写那段 CSS 文本、不重渲染界面。i18n 缺失时回落到内置的 `FALLBACK_THEME`
  - 设置页 `ui/index.html` 的 `<style>` 里**字面写同一套 token**，由测试断言与 `THEME` **逐字一致**
    （单一事实源 + 防漂移）；设置页**固定用暗色**（Gale 默认就是暗色皮肤，两边像同一个软件），
    不再跟系统偏好变亮——`color-scheme:dark`（滚动条/表单控件也跟着变暗），
    亮色 token 仍留在 `THEME.light` 里给「Gale 切成亮色时注入的悬浮条/抽屉」用
  - 设置页**内容居中**：顶栏与内容区共用同一个 `max-width:1120px; margin:0 auto`
    （以前顶栏铺满整屏，宽屏下标题贴在屏幕最左边，看着像没对齐）；顶栏改为 sticky
  - **修掉设置页的横向溢出**（用户反馈"完整界面太偏右"）：`main` 从普通块改成 `display:grid` 之后，
    grid 轨道默认按 `min-content` 计算，而节点说明那行是 `white-space:nowrap`（带省略号），
    于是**最长的那条说明把整列撑到 1683px**——1280 视口下文档宽 1784px、多出 519px 横向滚动条，
    卡片一直顶到屏幕右边（实测 1280/1600/1920 三个宽度分别溢出 519 / 359 / 199px）。
    三处一起改：`main{grid-template-columns:minmax(0,1fr)}`（轨道锁死，不再被内容撑开）、
    卡片里的自适应栅格改成 `minmax(min(230px,100%),1fr)`（窄窗口也不溢出）、
    节点说明去掉 `nowrap`+省略号改为允许换行（长说明不再被切掉）。
    实测四个宽度横向溢出均为 **0**、`main` 左右留白对称（1280: 73/72，1920: 393/392）
  - 顺手修掉三处：悬浮条 z-index 从 2147483647 降到 2147483646、抽屉提到 2147483647
    （此前抽屉铺满右侧时会被悬浮条压住）；抽屉「当前节点」显示节点名而不是 `builtin` 这种 id；
    **连接成功后清掉 `cdp.lastError`**（此前重连成功也不会清，`/api/status` 一直挂着上次的
    `fetch failed`，抽屉状态行会把"已注入"写成失败，设置页"已连接 · fetch failed"——现在服务端连上就清空，
    两处界面也改成只在**未挂载**时才显示这条错误）
- **测试**：`test-i18n` 61 → **83 项**（新增主题 token 断言：设置页 token 与 `THEME.dark` 逐字一致、
  不再跟系统偏好变亮、`color-scheme:dark`、顶栏与内容区共用居中容器、grid 轨道锁成 `minmax(0,1fr)`、
  节点说明允许换行、窄窗口不溢出的栅格写法）；`test:edgeworker` 126 → **129 项**
  （新增 3 条状态显示契约断言）；`test-integration` 三处断言同步
  （默认备用链 = `["tencent","youdao"]`、`filterLocalProviders` 入参加三个免费节点、`offlineOnly` 的
  `offlineBlocked` 扩到五个节点）
- **实测**（本机，服务重启后 `buildId=65517e6212ee`）：腾讯 `test-provider` 651 ms、真翻
  「节点探测腾讯…灯塔管理员在黎明时数出了37只海鸥。」；有道 2805 ms、真翻成功；
  **Google 直连超时**（`请求超时(8000ms): translate.googleapis.com`，本机没走代理）→
  该节点必须有代理才可用，README / 界面文案已如实写明；失败时该段保持英文并在 20 秒后重试，不会把原文当译文写入缓存
- 文档：README §四 节点表加回三行并如实写明"网页公开接口、条款与限流不可控"、代理段 / 备用节点默认 / 429 FAQ /
  §八 隐私 / §六 项数同步；ROADMAP 补本条

**㉖ 内置引擎按钮收口：撤掉「删除自带语言包」、加「打开语言包位置」**

- 起因：0.1.0 的官方发布包是**主包**（`data/` 一律不进包），用户机器上根本没有 `data/edge-pack`，
  所以那个「删除自带语言包」按钮点了只会说"没有找到"——**撤掉它**
- 删除功能并进「删除语言包」：`pack/delete` 的 `scope` 仍是 `'seed' | 'all'`（留给脚本/测试），
  界面统一发 `scope: 'all'` —— 能删的一起清（`data/edge-profile` 整个清空 + Gale 自己那份 + 自带那份），
  结果行按 `seedDeleted` 分两种说法（`（连随包自带的那份也一起删了。）` / `下次用内置引擎会自动装回来（没装语言包时约 200 MB，实测十几秒下完）。`）
- 新增常驻按钮**「打开语言包位置」**（设置页 `#btnOpenPack`、抽屉 `#openPack`）：
  `core/edge-worker.mjs` 新导出 `revealTarget()`，按
  `data/edge-profile/EdgeTranslateKitLanguagePack` → `data/edge-profile` → `data/edge-pack` → `data`
  挑第一个真实存在的目录；`POST /api/local-engine/pack/open` 用
  `spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' })` 打开它，返回 `{ ok, opened, seed }`，
  界面把实际打开的路径写在说明行里（「已在资源管理器里打开：…」/「打开失败：…（位置：…）」）。
  **只打开、不删任何东西**，给"想自己看一眼、只删某一处、或者备份"的场景兜底
- 顺手清掉的过时文案：`ui\index.html:616` 的 stalePack 兜底不再承诺"有随包自带语言包时不用联网"（主包不带它）
- 测试：`test:edgeworker` 129 → **140 项**（新增第十节 11 条：`revealTarget()` 导出与候选顺序、
  `pack/open` 路由与 `explorer.exe`、返回 `opened`、两套界面都没有 `delSeedPack`/`btnDelSeedPack`、
  都有 `openPack`/`btnOpenPack`、都调 `pack/open`、「删除语言包」仍走 `scope:'all'`、
  `scope:'all'` 那条路真的会调 `dropSeed()`、确认提示指向「打开语言包位置」、结果行不再提自带语言包）；
  `test-integration` 175 → **176 项**（原来那段"点两下真删掉"改成**只验界面这一链**：把 `fetch` 换成一针假响应，
  抓请求体验 `scope:'all'` 与 `confirm:true`、验说明行按 `seedDeleted` 选说法 —— 因为 `pack/delete` 的
  `scope:'all'` 会去扫**机器上真实存在的** Gale / Temp 语言包目录，测试里不该有这种副作用）；
  `test:i18n` 83 项（删掉 seed 删除的三条用例，
  补「打开语言包位置」「正在打开语言包所在目录…」「已在资源管理器里打开：…」「打开失败：…（位置：…）」）
- 文档：README §一 自带语言包那条改成"点「打开语言包位置」自己删目录"、管理按钮表删一行加一行、
  §七 FAQ 补"主包不带语言包、所以没有单独按钮"；ROADMAP 两条同步

**㉗ 定稿：项目更名为 Gale-Mod-Translator、删排查脚本、首页 README 重写**

- 起因：上传 GitHub 时定的正式名是 **Gale-Mod-Translator**（中文名「Gale 汉化外挂」保留），
  于是仓库名、发布包名、包标识、界面英文名统一改成它
- 更名范围（全是**标识**，运行时行为零变化）：
  - `package.json`：`name` → `gale-mod-translator`，`description` 也带上新名
  - `tools/package.mjs`：解压后的顶层目录 → `Gale-Mod-Translator`，
    产物 → `dist/Gale-Mod-Translator-v<版本>.zip`
  - `core/library.mjs`：译库文件的 `format` → `gale-mod-translator-library`（导入侧本来就不校验这个字段）
  - `core/i18n.js`：Trusted Types 策略名 → `gale-mod-translator`；
    英文界面里的插件名 `Gale Translator` → `Gale Mod Translator`
  - `core/cdp.mjs`：注入脚本的 `//# sourceURL` → `gale-mod-translator-inject.js`
- **删掉 `检查调试端口策略.cmd`**（作者本机的排查脚本，不适合随项目发布）。
  它要提醒的事改写成 README §八 里的两行手动命令：早期「组策略注册表」方案可能在
  `HKCU` / `HKLM\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments` 留下策略项，
  值名若被写成 `*`，会让**整台机器**的 WebView2 应用都变成可调试状态，且关掉 Gale 也不会解除
- **顺手修掉一个打包泄漏**：`tools\launch-gale.vbs`、`tools\service-hidden.vbs`、
  `接管原Gale快捷方式-需管理员.cmd` 这三个脚本是**运行时按本机情况生成**的（内容里带本机绝对路径，
  所以 `.gitignore` 早就忽略它们），但 `tools/package.mjs` 之前会照着磁盘把它们打进发布包 ——
  别人解开包就会拿到一份指向作者机器的脚本。现在打包脚本多一个 `GENERATED` 排除集，
  这三个文件永远不进包（需要时由 `core/system.mjs` 的 `ensureHelpers()` 重新生成）
- README 首页重写：一句话定位 + 徽章、**特性一览表**、**环境要求表**（系统 / Node.js / Gale / WebView2 /
  Edge / 磁盘 / 内存 / 权限 / 网络 / 端口，附本机实测版本号）、两种安装方式、首次运行会发生什么、
  更新与卸载、文档导航；目录树里的根目录名与压缩包名同步；文末新增「九、许可与致谢」
- **环境实测值**（写进 README，便于用户对照）：Windows 11 Pro（`10.0.26300`，AMD64）、
  Node `v24.21.0` / npm `11.19.0`、Edge 与 WebView2 Runtime 均为 `154.0.4258.62`、
  `data\edge-profile` 645.1 MB（其中语言包 197.5 MB）
- 版本号仍为 **0.1.0**（首次对外发布）

## 1.4

**① 多节点择优（译文质量评分）**

- 设置面板「译文质量」新增 **择优模式**：同一段文本让 2–4 个节点**并发翻译**，再用质量评分挑最好的那条
- 评分维度（`core/quality.mjs`）：
  - **目标语言是否成立**：中文占比过低（没翻干净）直接重罚
  - **专名/代码保留**：术语表里的词丢了要扣分（打分前会先还原术语占位符，避免误判）
  - **机翻痕迹**：4 字片段多样性过低（复读）、标点异常、残留英文词过多
  - **长度合理性**：译/原长度比明显异常
  - **译法一致性**：与已有相似译法（Jaccard ≥ 0.5）保持一致的加分
  - **回译校验**（可选）：把候选译文翻回英文与原文比词重合度，相似度越高越加分
- 择优只作用于**列表简介 / 详情摘要 / 标签**这类短文本；README 长正文仍走单节点，避免请求量翻几倍
- 新增「**对比译法**」工具：输入一段英文，让所有可用节点各翻一遍，同屏显示分数、译文与扣分原因
- 实测：列表页 8 段文本走择优，2 个节点并发，0 错误

**② LLM 润色（机翻先上屏，再自动替换）**

- 机翻结果**立即上屏**不阻塞，随后按批送给大模型润色；润色完成后通过 CDP **直接回推页面就地替换**，无需刷新
- 可配置开关、最短润色长度、每批段数；复用「OpenAI 兼容」节点的接口地址 / Key / 模型
- 有「测试润色」按钮；未配置 Key 时整条链路自动跳过，不影响正常翻译
- 实测：用本地 mock 大模型接口跑通「翻译 → 润色 → 回推」，页面文本被替换为润色版且计数正确（8 段 / 2 批）

**③ 公共译库共享**

- 新增**译库层**：与翻译节点无关的 `原文 → 译文` 共享库（`data/library.json`），
  查表顺序为 固定译法 → 节点缓存 → **译库** → 调用节点
- **导出**：打包成 `gale-lib-<语言>-<游戏>-<时间>.json`，可发朋友 / 传网盘 / 传 Gist；
  可选「限定游戏」「包含节点缓存里的历史译文」
- **导入**：支持本地文件、网址、以及对方**整个 `library.json`**（内部格式自动识别）；默认只补缺不覆盖
- **订阅**：填一个或多个网址，一键拉取合并，用于持续同步社区译库
- 浏览时**自动收集**：新翻译与缓存命中的内容都会带**游戏标签**进译库（游戏名从 Gale 顶部自动识别）
- 实测：导出 707 条（120 KB）→ 清空 → 导入 707 条；**清空节点缓存只留译库后重载页面，节点请求 0 次、译库命中 24 段，页面照样全中文**

**修复**

- 译库导入后若服务很快重启会丢失（合并是延迟落盘、退出时也没保存译库）→ 导入立刻落盘 + 退出时保存
- 择优模式下，若所有候选都与原文相同（纯专名），此前会被当成「失败」反复重试 → 现在按「机翻未改动」处理
- 译库导入接口现在同时认识导出包格式与本机 `library.json` 内部格式

## 1.3

**① 免启动器模式（不再必须用 start.cmd 开 Gale）**

- 设置面板新增「免启动器模式」：一键在桌面创建 **「Gale 汉化」** 快捷方式（带 Gale 图标），
  双击它就会自动拉起后台服务 + 带调试端口的 Gale，全程无窗口闪现
- 可开启**开机自启**：登录后服务在后台待命，之后无论你怎么启动 Gale 都能被接管
- 启动器新增 `--quiet` 模式与**失败兜底**：快捷方式模式下若服务起不来，仍会以普通方式打开 Gale，不会让你打不开 mod 管理器
- 原有快捷方式在 `公共桌面` 与 `开始菜单(ProgramData)`，改它们需要管理员权限；
  一键开启时会自动改用用户级快捷方式，并生成 `接管原Gale快捷方式-需管理员.cmd` 供你按需提权接管
- 一键「还原」：删除创建的快捷方式、把被接管的快捷方式写回 `gale.exe`

> 实测记录：WebView2 的**用户级策略注册表**（三个候选键名）无法让 Gale 无条件带调试参数，
> 机器级策略需要管理员权限，因此最终采用"快捷方式接管 + 服务常驻"这条无需提权的路线。

**② 中文搜索**

- 在 Gale 搜索框里**直接输入中文**：会弹出面板给出
  - **固定词表命中**（你填过的 `中文 = 英文` 直接反查）
  - **本地已见 mod**（英文名 + 中文简介，点击即用英文名搜索）
  - **建议英文关键词**（从已翻译语料反查，例如「种植」→ plant / crops / flora / farming）
- 页面会把你浏览过的 mod（名字 + 中英简介）自动收集到本地索引 `data/mod-index.json`；
  只有英文时还会查翻译缓存补上中文，所以没滚到的 mod 也能被中文搜到
- 可在设置面板关闭（「中文搜索」开关）

**③ 覆盖率体检 + 修一个真实缺陷**

- 修复：`BepInEx\config\Xxx.cfg` 这类**文件路径**因为含 `.` 被当成句子送去翻译
  （整合包页曾有 30 处）。现在路径/文件名/标识符在"句子判定"之前就被拦下
- 设置面板新增「覆盖率体检」：一键按 **已翻译 / 未翻译 / 模组名保留 / 标识符保留 / 界面框架 / 术语表 /
  机翻未改动 / 翻译失败** 等类别给出统计与样本
- 「**体检全部页面**」会自动逐个访问 `/ /browse /config /modpack /prefs` 收集数据，结束后回到原页面
- 每条样本可直接操作：**翻译它**（绕过启发式强制翻译）、**指定译法**（写进固定译法）、**保护它**（写进术语表）
- 实测五个页面：`/` `/browse` `/prefs` 未译 0；`/config` 未译 0（151 已译、6 条机翻未改动）；`/modpack` 30 条路径已正确识别为标识符

## 1.2

**代理配置大幅简化（修「挂了梯子但 Google 翻译无效」）**

- 「网络代理」新增三种写法：留空＝直连、`system`＝**跟随 Windows 系统代理**（梯子会自动改系统代理，端口变了也不用管）、
  `http://…` / `socks5://…`＝手工指定
- 新增 **SOCKS5 / SOCKS5h** 代理支持（Clash 的 socks 端口、v2rayN 的 10808 等），此前只支持 HTTP 隧道代理
- 设置面板新增两个按钮：**「跟随系统代理」** 与 **「自动检测」**——自动读系统代理、扫描常见本地代理端口（7890/7891/7892/7897/10808/10809…），
  并逐个实测能否连上 Google，可用的一键填入
- **按节点自动决定是否走代理**：Google / 必应强制走代理；腾讯 / 有道 / MyMemory 是国内服务，始终直连
  （此前代理是全局的，挂上代理后国内节点会变慢甚至失败，导致备用节点形同虚设）；本地地址（127.0.0.1）永不绕代理
- 节点失败时的提示更明确：没配代理却用 Google/必应时，会直接提示去点「自动检测」或「跟随系统代理」

> 说明：必应节点的免费 token 端点 `edge.microsoft.com/translate/auth` 目前对国内网络返回 404
> （Azure 区域限制，走代理也一样），因此必应节点在境内基本不可用，建议使用 Google / DeepL / DeepSeek。

## 1.1

**翻译节点可增删**

- 设置面板新增「翻译节点」管理：可**添加自定义翻译节点**（请求地址、方法、请求头、请求体模板、响应取值路径、API Key、是否批量）
- 自定义节点支持占位符 `{{text}}`、`{{texts_json}}`、`{{texts_joined}}`、`{{source}}`、`{{target}}`、`{{key}}`
- 响应取值支持路径表达式，如 `translations[].text`、`data[0].dst`；留空则自动识别常见结构
- 内置节点可**停用**（等价于删除），一键「恢复被停用的内置节点」；自定义节点可编辑或删除

**支持大多数语言**

- 目标语言与源语言不再写死中文，内置 35 种语言（简繁中文、英日韩、俄法德西葡意、波土乌捷荷、北欧诸语、希腊、匈罗、越泰印尼马来、印地孟加拉泰米尔、阿拉伯波斯希伯来、斯瓦希里、菲律宾…），也可手填语言代码
- 各节点按自己的规范自动映射语言码：腾讯 `zh`、有道 `zh-CHS/zh-CHT`、必应 `zh-Hans/zh-Hant`、DeepL `ZH/PT-BR`、大模型用语言名
- 术语保护表、固定译法、后处理替换、中英混排空格是中文专用，目标语言不是中文时自动跳过
- 缓存按「目标语言 + 节点」分开存放，切换语言不影响已有译文

**模组配置页翻译**

- 配置文件编辑页的**左侧模组名与配置分组标题**现在也会翻译（这些文本位于按钮内，1.0 被当成界面框架跳过了）
- 配置页使用独立规则：`Achievements`、`CheatFlags`、`Craft From Chests` 这类标题会翻译，
  而配置文件名与插件标识符（`Azumatt.AzuCraftyBoxes.yml`、`zenox.betterui`、`BetterUIMK_BetterUI`）仍然保持原样
- 可在设置里单独关闭该行为（「翻译模组配置页」）

**换电脑可用**

- 自动探测 Gale 安装位置：卸载注册表、桌面/开始菜单快捷方式、常见安装目录、各磁盘常见路径；设置面板也有「自动检测」按钮和手工路径输入
- 打包脚本 `tools/package.mjs`，发布包不含运行数据（缓存、日志、配置）

**其他修复**

- 启动器在服务已运行但 Gale 未启动时会正确拉起 Gale（1.0 会漏掉这种情况）
- 译文与原文相同的节点只请求一次，不再每次扫描重复请求
- 设置面板显示当前版本号

## 1.0
首个可用版本。

- 外挂式汉化：不修改 Gale 任何文件，通过 WebView2 调试端口 + CDP 注入页面脚本
- 翻译范围：搜索列表简介、详情页摘要、README、更新日志、依赖项、配置页右侧内容
- 保护规则：模组名、作者名、代码、文件路径、配置键名不翻译；乱码文本自动跳过
- 翻译源：腾讯交互翻译（默认）、有道、Google、必应、MyMemory、DeepL、OpenAI 兼容、LibreTranslate、仅用缓存
- 翻译源可切换，失败自动按备用链回退；请求限速与指数退避重试
- 磁盘缓存（重复内容零请求、可离线）、术语保护表、后处理替换、固定译法词典
- 中英混排自动加空格；悬浮控制条支持 中文/原文 无损切换、拖动并记忆位置
- 设置面板：状态、翻译源选择与测试、行为开关、术语与词典编辑、缓存管理、日志
- 一键启动/停止脚本，服务后台运行，零第三方依赖
