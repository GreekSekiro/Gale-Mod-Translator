/* Gale 汉化外挂 · 页内设置抽屉
 * 由本地服务通过 CDP 注入，排在 i18n.js 与 inject.js 之后。
 * 目的：把设置从"浏览器另开一页"搬进 Gale 页内（Shadow DOM 侧边抽屉），
 *       形成"看到不顺手 → 当场改 → 立即生效"的闭环；完整设置页仍然保留。
 *
 * 两个关键设计：
 *   1) 改选项**不立即保存**：所有改动先写进本地 form，左下角「保存设置」统一提交，
 *      保存后做"软应用"（重新拉配置 + 还原译文 + 重新扫描），不刷新页面、抽屉不关。
 *   2) 界面支持中/英切换（词典来自 core/i18n.js，挂 Shadow DOM 一起翻）。
 */
(() => {
  const BOOT = window.__GALE_TR__ || {};
  if (BOOT.dry) return; // 离线回放自检模式：不建 UI

  const TR = window.__galeTrans;
  if (!TR) return;

  // ⚠️ 幂等守卫：同一份代码被重复注入时（addScriptToEvaluateOnNewDocument + 挂载后重新注入）
  // 直接跳过。否则第二次 boot 会把第一次建好的抽屉 **拆掉重建** ——
  // 如果用户此刻正开着抽屉，就会看到"抽屉还开着、内容却空了"。
  // 代码变了（build 不同）才重建，这样才能热更新。
  const prevDrawer = window.__galeDrawer;
  if (prevDrawer && prevDrawer.__installed && prevDrawer.__build === BOOT.build && BOOT.build) {
    window.__galeDrawerBootsSkipped = (window.__galeDrawerBootsSkipped || 0) + 1;
    return;
  }
  const API = (TR.api || BOOT.api || 'http://127.0.0.1:8799').replace(/\/+$/, '');
  const I18N = window.GALE_I18N;

  async function api(p, body) {
    const r = await fetch(API + p, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(p + ' HTTP ' + r.status);
    return r.json();
  }

  // 注意：本脚本由 Page.addScriptToEvaluateOnNewDocument 注入，执行时机是 document-start，
  // 那时 document.body 还不存在，必须等 DOM 就绪再建 UI。
  function boot() {
  if (!document.body) return;
  window.__galeDrawerBoots = (window.__galeDrawerBoots || 0) + 1;

  // 幂等：同一份代码已经装好、而且宿主还在页面上，就什么都别做。
  // 重复注入（addScriptToEvaluateOnNewDocument + 挂载后重新注入）会让 boot 跑两次，
  // 第二次会把第一次的抽屉拆掉重建 —— 用户正在看的话就是"抽屉还开着、内容却空了"。
  const alive = window.__galeDrawer;
  if (alive && alive.__installed && BOOT.build && alive.__build === BOOT.build && typeof alive.isAlive === 'function' && alive.isAlive()) {
    window.__galeDrawerBootsSkipped = (window.__galeDrawerBootsSkipped || 0) + 1;
    return;
  }

  // 重新注入时先拆掉旧抽屉，避免两份
  const prev = window.__galeDrawer;
  const prevWasOpen = !!(prev && typeof prev.isOpen === 'function' && prev.isOpen());
  if (prev && typeof prev.dispose === 'function') {
    try {
      prev.dispose();
    } catch {}
  }

  // 主题变量（与 core/i18n.js 的 THEME 同一套色板；详见那里的注释）。
  // 注入进 Gale 时只能看 <html class="dark"> —— Gale 的深浅色是它界面里的开关，与系统偏好无关。
  const FALLBACK_THEME =
    '--g-bg:#0f172a;--g-surface:#1e293b;--g-surface-a:rgba(30,41,59,.94);--g-surface-2:#273449;--g-line:#334155;' +
    '--g-fg:#f1f5f9;--g-fg-2:#cbd5e1;--g-dim:#94a3b8;--g-acc:#16a34a;--g-acc-hi:#22c55e;--g-acc-soft:rgba(34,197,94,.16);' +
    '--g-acc-fg:#fff;--g-ok:#22c55e;--g-warn:#f59e0b;--g-err:#ef4444;--g-shadow:0 12px 32px rgba(2,6,23,.55);' +
    '--g-code-bg:#0b1220;--g-r:12px;--g-r-sm:9px;--g-r-xs:7px;--g-r-pill:999px;' +
    '--g-font:"Microsoft YaHei UI","Microsoft YaHei","Segoe UI",Inter,system-ui,sans-serif;' +
    '--g-mono:Consolas,"Cascadia Mono",monospace;' +
    '--g-fs:14px;--g-fs-sm:12.5px;--g-fs-xs:11.5px;--g-fs-lg:15px;--g-fs-xl:17px';
  function themeVarsCss() {
    const T = window.GALE_UI && window.GALE_UI.theme;
    try {
      return T ? T.css(T.galeMode()) : `:host{${FALLBACK_THEME}}`;
    } catch {
      return `:host{${FALLBACK_THEME}}`;
    }
  }

  const host = document.createElement('div');
  host.id = 'gale-drawer-host';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
  const root = host.attachShadow({ mode: 'open' });
  const uiHTML = `
    <style id="themeVars">${themeVarsCss()}</style>
    <style>
      .host{position:absolute;inset:0;pointer-events:none;font:var(--g-fs)/1.6 var(--g-font);color:var(--g-fg)}
      .scrim{position:absolute;inset:0;background:rgba(2,6,23,.45);opacity:0;transition:opacity .18s;pointer-events:none}
      .panel{position:absolute;top:0;right:0;bottom:0;width:440px;max-width:94vw;background:var(--g-bg);color:var(--g-fg);
        border-left:1px solid var(--g-line);box-shadow:-12px 0 34px rgba(2,6,23,.5);display:flex;flex-direction:column;
        transform:translateX(103%);transition:transform .2s ease;pointer-events:none}
      .host.open .scrim{opacity:1;pointer-events:auto}
      .host.open .panel{transform:none;pointer-events:auto}
      header{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--g-line)}
      header h1{margin:0;font-size:var(--g-fs-xl);font-weight:600;flex:1;letter-spacing:.2px}
      header .ver{color:var(--g-dim);font-size:var(--g-fs-xs)}
      header select{width:auto;padding:4px 8px;font-size:var(--g-fs-sm)}
      .body{flex:1;overflow:auto;padding:14px 16px 20px;display:flex;flex-direction:column;gap:12px}
      section{border:1px solid var(--g-line);border-radius:var(--g-r);padding:12px 14px;background:var(--g-surface)}
      section > h2{margin:0 0 10px;font-size:var(--g-fs-lg);font-weight:600;display:flex;align-items:center;justify-content:space-between;gap:10px}
      details{border:1px solid var(--g-line);border-radius:var(--g-r);background:var(--g-surface);padding:0}
      details > summary{cursor:pointer;padding:12px 14px;font-size:var(--g-fs-lg);font-weight:600;list-style:none;display:flex;align-items:center;gap:8px}
      details > summary::-webkit-details-marker{display:none}
      details > summary::before{content:"▸";color:var(--g-dim);font-size:var(--g-fs-sm)}
      details[open] > summary::before{content:"▾"}
      details > .inner{padding:0 14px 14px}
      .hint{color:var(--g-dim);font-size:var(--g-fs-sm);line-height:1.6}
      label{display:block;color:var(--g-dim);font-size:var(--g-fs-sm);margin:8px 0 4px}
      select,input[type=text],input[type=password],input[type=number],textarea{width:100%;background:var(--g-bg);border:1px solid var(--g-line);color:var(--g-fg);
        border-radius:var(--g-r-sm);padding:7px 10px;font:13.5px/1.5 var(--g-font);box-sizing:border-box}
      select,input[type=text]:focus,input[type=password]:focus,input[type=number]:focus,textarea:focus{outline:none}
      input:focus,textarea:focus{border-color:var(--g-acc);box-shadow:0 0 0 3px var(--g-acc-soft)}
      textarea{min-height:76px;resize:vertical;font-family:var(--g-mono);font-size:var(--g-fs-sm)}
      button{background:var(--g-acc);color:var(--g-acc-fg);border:0;border-radius:var(--g-r-sm);padding:7px 13px;cursor:pointer;font:600 13.5px var(--g-font);transition:filter .15s}
      button:hover{filter:brightness(1.1)}
      button.ghost{background:transparent;border:1px solid var(--g-line);color:var(--g-fg-2);font-weight:500}
      button.ghost:hover{background:var(--g-acc-soft);color:var(--g-fg)}
      button.mini{padding:4px 10px;font-size:var(--g-fs-sm);border-radius:var(--g-r-xs);font-weight:500}
      button.danger{background:var(--g-err-bg);border:1px solid var(--g-err);color:var(--g-err-fg)}
      button.x{background:transparent;border:0;color:var(--g-dim);font-size:20px;line-height:1;padding:2px 8px}
      button.x:hover{color:var(--g-fg)}
      button.dirty{background:var(--g-warn);color:#fff;box-shadow:0 0 0 1px var(--g-warn) inset}
      .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      .kv{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;font-size:13.5px}
      .kv b{font-weight:600}
      .dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--g-ok);margin-right:6px;vertical-align:middle}
      .dot.err{background:var(--g-err)}
      .warnbox{border:1px solid var(--g-err);background:var(--g-err-bg);color:var(--g-err-fg);border-radius:var(--g-r-sm);padding:10px 12px;font-size:var(--g-fs-sm);line-height:1.6}
      .cov{display:flex;gap:8px;align-items:flex-start;margin-top:5px;font-size:var(--g-fs-sm)}
      .cov .t{flex:1;word-break:break-word}
      .src{display:flex;align-items:center;gap:10px;border:1px solid var(--g-line);border-radius:var(--g-r-sm);padding:8px 11px;margin-bottom:8px}
      .src.on{border-color:var(--g-acc);background:var(--g-acc-soft)}
      .src .body{flex:1;cursor:pointer;min-width:0}
      .src .n{font-size:13.5px;font-weight:600}
      .src .d{color:var(--g-dim);font-size:var(--g-fs-sm);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      pre{background:var(--g-code-bg);border:1px solid var(--g-line);border-radius:var(--g-r-sm);padding:10px;max-height:190px;overflow:auto;font-size:var(--g-fs-xs);white-space:pre-wrap;margin:0;font-family:var(--g-mono)}
      footer{border-top:1px solid var(--g-line);padding:12px 16px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
      footer .spacer{flex:1}
      .ok{color:var(--g-ok)}.bad{color:var(--g-err)}
      .bar{height:8px;border-radius:var(--g-r-pill);background:var(--g-line);overflow:hidden;margin-top:8px}
      .bar>i{display:block;height:100%;width:0;background:var(--g-acc-hi);transition:width .3s}
      .bar.indet>i{width:35%;animation:galeIndet 1.1s ease-in-out infinite}
      @keyframes galeIndet{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}
      .prog{color:var(--g-dim);font-size:var(--g-fs-sm);margin-top:5px}
    </style>
    <div class="host" id="host">
      <div class="scrim" id="scrim"></div>
      <aside class="panel">
        <header>
          <h1>Gale 汉化</h1>
          <span class="ver" id="ver"></span>
          <select id="uiLang" title="界面语言 / UI language">
            <option value="zh-CN">简体中文</option>
            <option value="en">English</option>
          </select>
          <button class="x" id="close" title="关闭">×</button>
        </header>
        <div class="body">

          <section>
            <h2><span>运行状态</span><button class="ghost mini" id="refresh">刷新</button></h2>
            <div class="kv" id="status"></div>
            <div class="warnbox" id="portNote" style="display:none;margin-top:8px"></div>
            <div class="warnbox" id="rateNote" style="display:none;margin-top:8px"></div>
            <div class="warnbox" id="nodeNote" style="display:none;margin-top:8px"></div>
          </section>

          <section id="selfCheckBox" style="display:none">
            <h2>注入自检</h2>
            <div class="warnbox" id="selfCheckMsg"></div>
          </section>

          <section>
            <h2>翻译节点</h2>
            <label style="margin:0;display:flex;align-items:center;gap:6px">
              <input type="checkbox" id="offlineOnly" style="width:auto" /> 仅本地翻译（禁用联网）
            </label>
            <div class="hint" id="offlineNote"></div>
            <select id="provider" style="margin-top:8px"></select>
            <div class="hint" id="providerNote"></div>
            <div id="srcFields" style="display:none;margin-top:8px;border-top:1px dashed var(--g-line);padding-top:8px">
              <label id="srcFieldsTitle"></label>
              <div id="srcFieldsGrid"></div>
            </div>
            <div id="localBox" style="display:none;margin-top:8px;border-top:1px dashed var(--g-line);padding-top:8px">
              <div class="hint" id="localState"></div>
              <div id="localProgWrap" style="display:none">
                <div class="bar" id="localBar"><i id="localBarFill"></i></div>
                <div class="prog" id="localProgText"></div>
              </div>
              <div class="hint" id="localDiag" style="display:none;margin-top:4px;opacity:.7"></div>
              <div class="row" style="margin-top:6px">
                <button class="mini" id="enableLocal">启用内置引擎</button>
                <button class="ghost mini" id="recheckLocal">下载语言包</button>
                <button class="ghost mini" id="resetLocal">重置引擎</button>
                <span class="hint" id="localOut"></span>
              </div>
            </div>
            <!-- 语言包管理**故意放在 #localBox 外面**：它是纯磁盘操作，跟"当前选的是哪个翻译节点"
                 和"内置引擎能不能用"都无关。以前它藏在 #localBox 里、而且只在"就绪/正在下载"时显示，
                 结果是环境根本不提供端侧模型时（Gale 用的 WebView2 就是），用户永远够不到"删除语言包"。
                 更糟的是服务端在 unusable 时会把 provider 自动切走，那样整个 #localBox 都会隐藏。 -->
            <div id="localPackRow" style="margin-top:8px;border-top:1px dashed var(--g-line);padding-top:8px">
              <div class="hint">内置引擎语言包（模型跑在插件拉起的无窗口 Edge 里，与当前所选翻译节点无关）：</div>
              <div class="hint" id="localPackInfo"></div>
              <div class="row" style="margin-top:4px">
                <button class="ghost mini" id="scanPack">查看语言包占用</button>
                <button class="ghost mini" id="openPack">打开语言包位置</button>
                <button class="ghost mini" id="delPack">删除语言包</button>
              </div>
            </div>
            <div class="row" style="margin-top:8px">
              <button class="ghost mini" id="testProvider">测试当前节点</button>
              <span class="hint" id="testOut"></span>
            </div>
            <label>失败时的备用节点（逗号分隔）</label>
            <input type="text" id="fallback" placeholder="tencent, youdao" />
          </section>

          <details id="customBox">
            <summary>自定义翻译节点</summary>
            <div class="inner">
              <div id="customList"></div>
              <div class="grid2">
                <div><label>名称</label><input type="text" id="cs_name" placeholder="我的翻译接口" /></div>
                <div><label>id（英文）</label><input type="text" id="cs_id" placeholder="my-api" /></div>
              </div>
              <label>请求地址</label><input type="text" id="cs_url" placeholder="https://api.example.com/translate" />
              <div class="grid2">
                <div><label>方法</label><select id="cs_method"><option>POST</option><option>GET</option></select></div>
                <div><label>响应取值路径</label><input type="text" id="cs_path" placeholder="translations[].text" /></div>
              </div>
              <label>请求头（JSON）</label>
              <textarea id="cs_headers">{"Content-Type":"application/json","Authorization":"Bearer {{key}}"}</textarea>
              <label>请求体模板</label>
              <textarea id="cs_body">{"text":{{texts_json}},"source":"{{source}}","target":"{{target}}"}</textarea>
              <div class="grid2">
                <div><label>API Key（可选）</label><input type="password" id="cs_key" /></div>
                <div><label>批量发送</label><select id="cs_batch"><option value="true">是</option><option value="false">否</option></select></div>
              </div>
              <div class="hint">占位符：<code>{{text}}</code> <code>{{texts_json}}</code> <code>{{texts_joined}}</code> <code>{{texts_count}}</code> <code>{{source}}</code> <code>{{target}}</code> <code>{{key}}</code></div>
              <div class="row" style="margin-top:8px"><button class="mini" id="saveCustom">添加节点</button><span class="hint" id="customOut"></span></div>
            </div>
          </details>

          <section>
            <h2>语言与质量</h2>
            <div class="grid2">
              <div><label>翻译成</label><select id="target"></select></div>
              <div><label>翻译模式</label>
                <select id="quality">
                  <option value="fast">快速（单节点）</option>
                  <option value="best">择优（多节点评分）</option>
                </select></div>
            </div>
            <div id="bestOpts" style="display:none">
              <label>参与择优的节点 id（逗号分隔，留空=自动取可用节点）</label>
              <input type="text" id="qVoters" placeholder="tencent, google" />
              <div><label>译法一致性（与已有相似译法保持一致）</label>
                <select id="qConsistency"><option value="true">开</option><option value="false">关</option></select></div>
            </div>
          </section>

          <details id="polishBox">
            <summary>LLM 润色（机翻先上屏，再自动替换）</summary>
            <div class="inner">
              <div class="grid2">
                <div><label>开关</label><select id="polishEnabled"><option value="false">关</option><option value="true">开</option></select></div>
                <div><label>最短润色长度</label><input type="number" id="polishMinLen" min="1" /></div>
                <div><label>每批段数</label><input type="number" id="polishBatch" min="1" max="20" /></div>
              </div>
              <div class="hint">复用「OpenAI 兼容」节点的接口地址 / Key / 模型；未配置时自动跳过。</div>
              <div class="row" style="margin-top:8px">
                <button class="ghost mini" id="testPolish">测试润色</button>
                <span class="hint" id="polishOut"></span>
              </div>
            </div>
          </details>

          <details id="compareBox">
            <summary>对比译法（同一段让所有节点各翻一遍并打分）</summary>
            <div class="inner">
              <input type="text" id="cmpText" value="Adds loot drops, magic items, and enchanting to Valheim." />
              <div class="row" style="margin-top:8px">
                <label style="margin:0;display:flex;align-items:center;gap:4px"><input type="checkbox" id="cmpVerify" style="width:auto" /> 回译校验</label>
                <button class="mini" id="btnCompare">对比</button>
                <span class="hint" id="cmpOut"></span>
              </div>
              <div id="cmpOutBox" style="margin-top:8px"></div>
            </div>
          </details>

          <section>
            <h2>翻译行为</h2>
            <div class="grid2">
              <div><label>翻译模组名</label><select id="translateNames"><option value="false">否</option><option value="true">是</option></select></div>
              <div><label>翻译配置页</label><select id="translateConfigPage"><option value="true">开</option><option value="false">关</option></select></div>
              <div><label>悬停显示原文</label><select id="hoverOriginal"><option value="true">是</option><option value="false">否</option></select></div>
              <div><label>中文搜索</label><select id="chineseSearch"><option value="true">开</option><option value="false">关</option></select></div>
              <div><label>模糊复用</label><select id="fuzzyReuse"><option value="true">开</option><option value="false">关</option></select></div>
              <div><label>最小翻译长度</label><input type="number" id="minLen" min="1" max="20" /></div>
            </div>
          </section>

          <section>
            <h2>网络代理</h2>
            <input type="text" id="proxy" placeholder="system / http://127.0.0.1:7892 / socks5://127.0.0.1:10808" />
            <div class="row" style="margin-top:8px">
              <button class="ghost mini" id="sysProxy">跟随系统代理</button>
              <button class="ghost mini" id="detectProxy">自动检测</button>
              <span class="hint" id="proxyOut"></span>
            </div>
            <div class="hint">只有 Google、以及你自己配的 DeepL / 大模型这类境外节点需要代理；腾讯、有道始终直连，本机服务（本地大模型、LibreTranslate）不要填。</div>
          </section>

          <section>
            <h2>术语与固定译法</h2>
            <label>术语保护表（每行一个；可写 <code>原文 = 译文</code> 强制指定译法）</label>
            <textarea id="glossary"></textarea>
            <label>固定译法（每行 <code>原文 = 译文</code>，整段完全匹配时直接采用、不调接口）</label>
            <textarea id="phraseMap"></textarea>
            <label>译文后处理替换（每行 <code>原文 = 译文</code>，用于纠正机翻惯用译名）</label>
            <textarea id="postReplace"></textarea>
          </section>

          <section>
            <h2><span>覆盖率体检</span><button class="ghost mini" id="health">体检当前页面</button></h2>
            <div class="hint">看当前页面哪些英文没翻、以及为什么没翻。每条可一键处理。</div>
            <div id="healthOut"></div>
          </section>

          <section>
            <h2>缓存与译库</h2>
            <div class="kv" id="libStats"></div>
            <div class="row" style="margin-top:8px">
              <button class="ghost mini" id="clearCache">清空翻译缓存</button>
              <span class="hint" id="cacheOut"></span>
            </div>
          </section>

          <details id="libBox">
            <summary>译库导出 / 导入 / 订阅</summary>
            <div class="inner">
              <div class="hint">译库是"与节点无关"的共享译文层：导出成文件发给朋友，对方导入后遇到相同内容直接出中文，零请求。</div>
              <div class="grid2" style="margin-top:8px">
                <div><label>导出：语言（留空=全部）</label><input type="text" id="libTarget" placeholder="zh-CN" /></div>
                <div><label>导出：游戏（留空=全部）</label><input type="text" id="libGame" placeholder="Valheim" /></div>
              </div>
              <div class="row" style="margin-top:8px">
                <button class="mini" id="libExport">导出译库文件</button>
                <span class="hint" id="libOut"></span>
              </div>
              <label>导入：本地文件路径或网址</label>
              <div class="row">
                <input type="text" id="libImportPath" style="flex:1" placeholder="D:\\path\\gale-lib-zh-CN-all.json 或 https://..." />
                <button class="ghost mini" id="libImport">导入</button>
              </div>
              <label>订阅（每行一个网址，保存后会全部拉取并合并）</label>
              <textarea id="libSubs" style="min-height:52px"></textarea>
              <div class="row" style="margin-top:8px">
                <button class="ghost mini" id="libSubsSave">保存并更新订阅</button>
                <button class="ghost mini" id="libClear">清空译库</button>
                <span class="hint" id="libSubOut"></span>
              </div>
            </div>
          </details>

          <details id="sysBox">
            <summary>系统集成（免启动器 / 开机自启）</summary>
            <div class="inner">
              <div class="hint">开启免启动器模式后，桌面会多一个「Gale 汉化」快捷方式：双击它即自动拉起服务与带调试端口的 Gale。</div>
              <div class="hint" id="sysState" style="margin-top:6px"></div>
              <div class="row" style="margin-top:8px">
                <button class="ghost mini" id="sysOn">开启免启动器模式</button>
                <button class="ghost mini" id="sysOff">还原</button>
                <button class="ghost mini" id="autoOn">开启开机自启</button>
                <button class="ghost mini" id="autoOff">关闭开机自启</button>
              </div>
            </div>
          </details>

          <details id="logBox">
            <summary>最近日志</summary>
            <div class="inner">
              <div class="row" style="margin-bottom:6px"><button class="ghost mini" id="loadLog">刷新日志</button><span class="hint" id="logOut"></span></div>
              <pre id="logPre">（点「刷新日志」加载）</pre>
            </div>
          </details>

        </div>
        <footer>
          <button class="mini" id="save">保存设置</button>
          <button class="ghost mini" id="discard" style="display:none">还原</button>
          <span class="spacer"></span>
          <button class="ghost mini" id="reinject">重新注入并刷新</button>
          <button class="ghost mini" id="openFull">打开完整设置页</button>
        </footer>
      </aside>
    </div>`;
  // Trusted Types 安全的写入：某些页面不允许直接写 shadowRoot.innerHTML。
  // 失败就跳过抽屉（悬浮条与翻译主流程不受影响）。
  const UI = window.GALE_UI;
  let htmlOk = false;
  if (UI && typeof UI.setHTML === 'function') htmlOk = UI.setHTML(root, uiHTML);
  else {
    try {
      root.innerHTML = uiHTML;
      htmlOk = true;
    } catch {}
  }
  if (!htmlOk) {
    console.warn('[Gale汉化] 无法写入抽屉界面（页面可能启用了 Trusted Types），已跳过抽屉');
    return;
  }
  (document.body || document.documentElement).appendChild(host);

  const $ = (id) => root.getElementById(id);

  // Gale 自己切深浅色（它把开关加在 <html class="dark"> 上）时只换变量，不重渲染。
  try {
    const themeEl = $('themeVars');
    const syncTheme = () => {
      const T = window.GALE_UI && window.GALE_UI.theme;
      if (T && themeEl) themeEl.textContent = T.css(T.galeMode());
    };
    new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  } catch {}
  const hostEl = $('host');
  let open = false;
  let timer = null;
  let cfg = {};        // 服务端已保存的配置
  let providers = [];
  let form = {};       // 界面上的值（可能未保存）
  let pfields = {};    // 当前节点的密钥字段
  let pfieldsAll = {}; // 各节点的密钥字段（切换节点时保留已填写但未保存的内容）
  let baseline = '';   // 已保存状态的快照（用于算"未保存几项"）
  let dirty = false;

  // ---------------------------------------------------------------- 语言
  function applyI18n() {
    if (!I18N) return;
    try {
      I18N.observe(root);
      I18N.apply(root);
    } catch {}
  }

  // ---------------------------------------------------------------- 通用工具
  const linesToGlossary = (txt) =>
    txt
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const m = s.split('=');
        return m.length > 1 ? { from: m[0].trim(), to: m.slice(1).join('=').trim() } : s;
      });
  const linesToRules = (txt) =>
    txt
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const m = s.split('=');
        return { from: (m[0] || '').trim(), to: m.slice(1).join('=').trim() };
      })
      .filter((r) => r.from);

  let flashTimer = null;
  function flash(msg, bad = false) {
    let el = $('flashOut');
    if (!el) {
      el = document.createElement('div');
      el.id = 'flashOut';
      // 贴在**底部按钮栏上方**，不要盖住「保存设置 / 还原 / 重新注入」
      const footerH = (root.querySelector('footer') || {}).offsetHeight || 52;
      el.style.cssText =
        `position:absolute;left:16px;right:16px;bottom:${footerH + 12}px;background:var(--g-surface);border:1px solid var(--g-line);color:var(--g-fg);` +
        'border-radius:var(--g-r-sm);padding:10px 12px;font-size:var(--g-fs-sm);pointer-events:none;z-index:5;box-shadow:var(--g-shadow)';
      root.querySelector('.panel').appendChild(el);
    }
    el.className = bad ? 'bad' : 'ok';
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      el.style.display = 'none';
    }, 4500);
    applyI18n();
  }

  /** 软应用：不刷新页面，抽屉不会关 */
  async function softApply() {
    try {
      if (typeof TR.softApply === 'function') {
        await TR.softApply();
        return true;
      }
      const r = await api('/api/apply', {});
      return !!r.ok;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- 未保存状态
  const snapStr = () => JSON.stringify({ f: form, p: pfields });

  function diffCount() {
    if (!dirty) return 0;
    const cur = JSON.parse(snapStr());
    const base = JSON.parse(baseline || '{"f":{},"p":{}}');
    let n = 0;
    for (const k of Object.keys(cur.f)) if (String(cur.f[k]) !== String(base.f?.[k] ?? '')) n++;
    for (const k of Object.keys(cur.p)) if (String(cur.p[k]) !== String(base.p?.[k] ?? '')) n++;
    return n;
  }

  function refreshSaveBtn() {
    const n = diffCount();
    const save = $('save');
    save.textContent = n ? `保存设置（${n} 项未保存）` : '保存设置';
    save.classList.toggle('dirty', n > 0);
    $('discard').style.display = n ? '' : 'none';
    applyI18n();
  }

  function markDirty() {
    dirty = true;
    refreshSaveBtn();
  }

  /** 把 form / pfields 写进控件 */
  function writeUI() {
    $('offlineOnly').checked = form.offlineOnly === 'true';
    renderOfflineNote();
    $('provider').value = form.provider;
    $('target').value = form.target;
    $('fallback').value = form.fallback;
    $('proxy').value = form.proxy;
    $('minLen').value = form.minLen;
    $('translateNames').value = form.translateNames;
    $('translateConfigPage').value = form.translateConfigPage;
    $('hoverOriginal').value = form.hoverOriginal;
    $('chineseSearch').value = form.chineseSearch;
    $('fuzzyReuse').value = form.fuzzyReuse;
    $('glossary').value = form.glossary;
    $('phraseMap').value = form.phraseMap;
    $('postReplace').value = form.postReplace;
    $('quality').value = form.qMode;
    $('bestOpts').style.display = form.qMode === 'best' ? '' : 'none';
    $('qVoters').value = form.qVoters;
    $('qConsistency').value = form.qConsistency;
    $('polishEnabled').value = form.polishEnabled;
    $('polishMinLen').value = form.polishMinLen;
    $('polishBatch').value = form.polishBatch;
    $('uiLang').value = cfg.uiLang === 'en' ? 'en' : 'zh-CN';
    renderFields();
  }

  /** 从服务端配置重建 form（keepEdits=true 时保留用户未保存的改动） */
  function buildFromCfg({ keepEdits = false } = {}) {
    const prev = keepEdits && dirty ? JSON.parse(snapStr()) : null;
    const q = cfg.quality || {};
    const po = cfg.polish || {};
    form = {
      provider: cfg.provider || 'builtin',
      offlineOnly: String(!!cfg.offlineOnly),
      target: cfg.target || 'zh-CN',
      fallback: (cfg.fallback || []).join(', '),
      proxy: cfg.proxy || '',
      minLen: String(cfg.minLen ?? 3),
      translateNames: String(!!cfg.translateNames),
      translateConfigPage: String(cfg.translateConfigPage !== false),
      hoverOriginal: String(cfg.hoverOriginal !== false),
      chineseSearch: String(cfg.chineseSearch !== false),
      fuzzyReuse: String(cfg.fuzzyReuse !== false),
      glossary: (cfg.glossary || []).map((g) => (typeof g === 'string' ? g : `${g.from} = ${g.to || ''}`)).join('\n'),
      phraseMap: Object.entries(cfg.phraseMap || {}).map(([k, v]) => `${k} = ${v}`).join('\n'),
      postReplace: (cfg.postReplace || []).map((r) => `${r.from} = ${r.to ?? ''}`).join('\n'),
      qMode: q.mode === 'best' ? 'best' : 'fast',
      qVoters: (q.voters || []).join(', '),
      qConsistency: String(q.consistency !== false),
      polishEnabled: String(!!po.enabled),
      polishMinLen: String(po.minLen ?? 10),
      polishBatch: String(po.batchSize ?? 8),
    };
    pfields = {};
    const p = providers.find((x) => x.id === form.provider);
    for (const f of (p && p.fields) || []) pfields[f.key] = String(cfg[f.key] ?? '');
    pfieldsAll = { [form.provider]: { ...pfields } };
    dirty = false;
    baseline = snapStr();
    if (prev) {
      form = { ...form, ...prev.f };
      pfields = { ...pfields, ...prev.p };
      dirty = true;
    }
    writeUI();
    refreshSaveBtn();
  }

  /** 切换节点时取回该节点的参数（优先用界面上已填、但还没保存的值） */
  function loadProviderFields(pid) {
    const saved = pfieldsAll[pid];
    if (saved) return { ...saved };
    const out = {};
    const p = providers.find((x) => x.id === pid);
    for (const f of (p && p.fields) || []) out[f.key] = String(cfg[f.key] ?? '');
    return out;
  }

  function collectPatch() {
    return {
      provider: form.provider,
      offlineOnly: form.offlineOnly === 'true',
      target: form.target,
      fallback: form.fallback.split(',').map((s) => s.trim()).filter(Boolean),
      proxy: form.proxy.trim(),
      minLen: Number(form.minLen) || 3,
      translateNames: form.translateNames === 'true',
      translateConfigPage: form.translateConfigPage === 'true',
      hoverOriginal: form.hoverOriginal === 'true',
      chineseSearch: form.chineseSearch === 'true',
      fuzzyReuse: form.fuzzyReuse === 'true',
      glossary: linesToGlossary(form.glossary),
      phraseMap: Object.fromEntries(linesToRules(form.phraseMap).map((r) => [r.from, r.to])),
      postReplace: linesToRules(form.postReplace),
      quality: {
        mode: form.qMode,
        voters: form.qVoters.split(',').map((s) => s.trim()).filter(Boolean),
        consistency: form.qConsistency === 'true',
      },
      polish: {
        enabled: form.polishEnabled === 'true',
        minLen: Number(form.polishMinLen) || 10,
        batchSize: Number(form.polishBatch) || 8,
      },
    };
  }

  // ---------------------------------------------------------------- 状态
  async function refreshStatus() {
    const s = await api('/api/status');
    const c = s.cdp || {};
    const ph = s.pageHealth;
    const okGale = c.connected && c.attached;
    $('ver').textContent = s.version ? 'v' + s.version : '';
    $('status').innerHTML =
      `<b>${okGale ? '<span class="dot"></span>已挂载' : '<span class="dot err"></span>未挂载'}</b><span class="hint">${okGale ? '页面脚本已注入' : (c.lastError || (s.galeRunning ? 'Gale 在运行但未挂载（需带调试端口启动）' : 'Gale 未运行'))}</span>` +
      `<b>服务</b><span class="hint">端口 ${s.servicePort}</span>` +
      `<b>调试端口</b><span class="hint">${s.cdpPort ?? '-'}${s.cdpPortRemembered ? `（记忆：${s.cdpPortRemembered}）` : ''}</span>` +
      `<b>当前节点</b><span class="hint">${providers.find((p) => p.id === s.provider)?.name || s.provider || '-'}</span>` +
      `<b>本页已译</b><span class="hint">${TR.state.stats.translated} 段（累计 ${s.stats?.items ?? 0} 段）</span>` +
      `<b>缓存 / 译库</b><span class="hint">${s.cache?.size ?? 0} 条 / ${s.library?.size ?? '-'} 条</span>` +
      `<b>模糊复用</b><span class="hint">${s.stats?.fuzzyHits ?? 0} 段（零请求）</span>`;

    const pn = $('portNote');
    pn.style.display = s.cdpPortNote ? '' : 'none';
    pn.textContent = s.cdpPortNote || '';

    // 节点可用性告警（内置引擎在 WebView2 里不可用 + 备用链为空 = 一句都翻不出来）
    const nn = $('nodeNote');
    if (nn) {
      nn.style.display = s.nodeWarning ? '' : 'none';
      nn.textContent = s.nodeWarning ? '⚠ ' + T('翻译节点不可用：') + s.nodeWarning : '';
    }

    // 节点被限流 → 冷却提示 + 一键解除
    const rl = s.rateLimited || [];
    const rn = $('rateNote');
    if (rl.length) {
      rn.style.display = '';
      rn.innerHTML =
        '<b>节点被限流，正在冷却：</b><br>' +
        rl
          .map(
            (x) =>
              `· ${x.id} 还需 ${Math.ceil(x.remainingMs / 1000)} 秒` + (x.strikes > 1 ? `（第 ${x.strikes} 次）` : ''),
          )
          .join('<br>') +
        '<div class="row" style="margin-top:6px"><button class="ghost mini" id="clearRate">解除冷却</button>' +
        '<span class="hint">冷却期间会自动改用备用节点</span></div>';
      const btn = $('clearRate');
      if (btn) {
        btn.onclick = async () => {
          try {
            await api('/api/rate-limit/clear', {});
            flash('已解除冷却');
          } catch (e) {
            flash('失败：' + e.message, true);
          }
          refreshStatus().catch(() => {});
        };
      }
    } else {
      rn.style.display = 'none';
    }

    const box = $('selfCheckBox');
    if (ph && ph.degraded) {
      box.style.display = '';
      $('selfCheckMsg').innerHTML =
        '<b>可能 Gale 前端结构已变化：</b><br>' +
        (ph.reasons || []).map((r) => '· ' + r).join('<br>') +
        `<br><span class="hint">已扫描 ${ph.scans ?? 0} 次 · 候选 ${ph.candidates ?? 0} 条。可点「体检当前页面」看细节。</span>`;
    } else {
      box.style.display = 'none';
    }
    applyI18n();
  }

  async function refreshLib() {
    try {
      const s = await api('/api/library/stats');
      $('libStats').innerHTML =
        `<b>译库</b><span class="hint">${s.size} 条 · 命中 ${s.hits} 次${s.subscriptions?.length ? ' · 订阅 ' + s.subscriptions.length + ' 个' : ''}</span>` +
        `<b>按语言</b><span class="hint">${Object.entries(s.byTarget || {}).map(([k, n]) => k + ' ' + n).join('、') || '—'}</span>`;
      if (s.subscriptions?.length && !$('libSubs').value) $('libSubs').value = s.subscriptions.join('\n');
      applyI18n();
    } catch {}
  }

  async function refreshSystem() {
    try {
      const s = await api('/api/system/status');
      // 拆成多个文本节点，这样中英切换时每段都能独立命中词典
      $('sysState').innerHTML =
        `<span>桌面快捷方式</span> <span>${s.userShortcut ? '已创建' : '未创建'}</span>` +
        `<span> · 开机自启</span> <span>${s.autostart ? '已开启' : '未开启'}</span>` +
        (s.hijackedCount ? `<span> · 已接管 ${s.hijackedCount} 个原快捷方式</span>` : '');
      applyI18n();
    } catch {}
  }

  // ---------------------------------------------------------------- 节点列表与参数
  function renderFields() {
    const p = providers.find((x) => x.id === form.provider);
    const fields = (p && p.fields) || [];
    const box = $('srcFields');
    const grid = $('srcFieldsGrid');
    if (!fields.length) {
      box.style.display = 'none';
      grid.innerHTML = '';
      return;
    }
    box.style.display = '';
    $('srcFieldsTitle').textContent = `${p.name} 的参数`;
    grid.innerHTML = '';
    for (const f of fields) {
      const wrap = document.createElement('div');
      const lab = document.createElement('label');
      lab.textContent = f.label;
      const inp = document.createElement('input');
      inp.type = f.type === 'password' ? 'password' : 'text';
      inp.dataset.key = f.key;
      inp.placeholder = f.placeholder || '';
      inp.value = pfields[f.key] ?? '';
      inp.autocomplete = 'off';
      inp.spellcheck = false;
      inp.oninput = () => {
        pfields[f.key] = inp.value;
        markDirty();
      };
      wrap.append(lab, inp);
      grid.appendChild(wrap);
    }
    const secret = fields.find((f) => f.type === 'password');
    $('fieldsOut') && ($('fieldsOut').textContent = '');
    if (secret && !pfields[secret.key]) $('srcFieldsTitle').textContent = `${p.name} 的参数 · ⚠ 还没填密钥`;
    applyI18n();
  }

  function renderProviderList() {
    const sel = $('provider');
    const off = form.offlineOnly === 'true';
    sel.innerHTML = '';
    for (const p of providers) {
      const o = document.createElement('option');
      o.value = p.id;
      // 仅本地模式开着的时候，把在线节点置灰并标注原因（列表照旧完整，用户看得见自己少了什么）
      const blocked = off && p.local === false;
      o.textContent = blocked ? p.name + '（仅本地模式下已停用）' : p.name;
      o.disabled = blocked;
      sel.appendChild(o);
    }
    sel.value = form.provider;
    const cur = providers.find((p) => p.id === form.provider);
    $('providerNote').textContent = cur?.note || '';
    renderOfflineNote();
    applyI18n();
    refreshLocalEngine().catch(() => {});
  }

  /** 「仅本地翻译」开关下面那行说明：说清现在会/不会把文本发到本机之外 */
  function renderOfflineNote() {
    const el = $('offlineNote');
    if (!el) return;
    const off = form.offlineOnly === 'true';
    if (!off) {
      el.textContent = '关闭时可以用在线节点（腾讯 / 有道 / Google / DeepL / 大模型），要翻译的文本会发到那些第三方服务器。';
      el.className = 'hint';
      return;
    }
    const cur = providers.find((p) => p.id === form.provider);
    const base =
      '已开启：只允许"请求不出本机"的节点（内置引擎 / 本地大模型 / 本机 LibreTranslate / 仅用缓存），所有对外请求都会被拦下。' +
      '例外：内置引擎首次要下载约 200 MB 语言包，那次下载会联网（只下模型本身，不发送任何要翻译的文本）。';
    if (cur && cur.local === false) {
      el.textContent = base + `当前选的是 ${cur.name}，它会被停用 —— 请改选一个本地节点。`;
      el.className = 'hint bad';
    } else {
      el.textContent = base;
      el.className = 'hint';
    }
  }

  // ---------------------------------------------------------------- 内置引擎（浏览器本地模型）
  let localTimer = null;
  let localTimerMs = 0;
  // 进度行的文案逐段取词，这样中/英文界面下都对（见 core/i18n.js）。
  // 故意用函数声明而不是 const 箭头：函数声明会提升，避免"先渲染后定义"时的 TDZ 崩溃。
  function T(s) {
    return I18N ? I18N.t(s) : s;
  }

  /** 字节 / 时长的可读格式。
   *  注意：内置引擎的进度是**估算值** —— Translator API 只给 0~1 的百分比（total 恒为 1），
   *  拿不到字节数，所以 MB 与速度是按语言包体积换算出来的（见 inject.js 的 LOCAL_PACK_BYTES）。 */
  function fmtBytes(n) {
    const v = Number(n) || 0;
    if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB';
    if (v >= 1024) return Math.round(v / 1024) + ' KB';
    return Math.round(v) + ' B';
  }
  function fmtSecs(ms) {
    const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    // ' 秒' / ' 分' 里的前导空格是给中文留的（英文译文会把它去掉，变成 3s / 1m 30s）
    if (s < 60) return s + T(' 秒');
    return Math.floor(s / 60) + T(' 分') + ' ' + (s % 60) + T(' 秒');
  }

  /** 渲染下载进度：进度条 + 已下载量 / 速度 / 已用时间 / 预计剩余 */
  function renderLocalProgress(pr) {
    const wrap = $('localProgWrap');
    const bar = $('localBar');
    const fill = $('localBarFill');
    const text = $('localProgText');
    if (!wrap || !bar || !fill || !text) return;
    if (!pr) {
      wrap.style.display = 'none';
      return;
    }
    wrap.style.display = '';
    const started = pr.hasProgress !== false; // false = 还没收到任何进度事件
    const pct = Math.max(0, Math.min(100, Math.round((pr.progress || 0) * 100)));
    // 还没开始有进度时用"不确定态"的滑动条，不假装知道百分比
    bar.classList.toggle('indet', !started);
    fill.style.width = started ? Math.max(1, pct) + '%' : '';
    const seg = [];
    if (started) {
      seg.push(`${T('约')} ${fmtBytes(pr.downloadedBytes)} / ${fmtBytes(pr.totalBytes)}`);
      if (pr.speedBps > 0) seg.push(`${T('约')} ${fmtBytes(pr.speedBps)}/s`);
      seg.push(`${T('已用')} ${fmtSecs(pr.elapsedMs)}`);
      if (pr.etaMs) seg.push(`${T('剩余约')} ${fmtSecs(pr.etaMs)}`);
    } else {
      seg.push(T('正在连接下载服务器'));
      seg.push(`${T('已用')} ${fmtSecs(pr.elapsedMs)}`);
    }
    text.textContent = seg.join(' · ');
    text.title = T('浏览器只给百分比进度，MB 与速度是按语言包体积（约 197.5 MB）换算的估算值');
  }

  function stopLocalTimer() {
    if (localTimer) {
      clearInterval(localTimer);
      localTimer = null;
    }
    localTimerMs = 0;
  }
  /** 统一的定时器管理：下载中用 700ms（下得快，2 秒会让进度条几乎不动），
   *  等 Gale 连上时用 2000ms（自愈重试，不用用户手点）。
   *  ⚠️ 间隔要单独存变量 —— 浏览器里 setInterval 返回的是**数字**，
   *  给数字加属性在严格模式下会抛 TypeError（这个坑被集成测试抓到过）。 */
  function startLocalTimer(ms) {
    if (localTimer && localTimerMs === ms) return;
    stopLocalTimer();
    localTimer = setInterval(() => refreshLocalEngine().catch(() => {}), ms);
    localTimerMs = ms;
  }

  /** 按状态决定按钮可不可用（不要因为"没连上"就把「启用」藏起来，那样用户没法下载） */
  function setLocalBtns({ enable, reset }) {
    const eb = $('enableLocal');
    const rb = $('resetLocal');
    if (eb) {
      eb.style.display = '';
      eb.disabled = !enable;
      eb.style.opacity = enable ? '' : '.5';
    }
    if (rb) {
      rb.style.display = '';
      rb.disabled = !reset;
      rb.style.opacity = reset ? '' : '.5';
    }
  }

  function showLocalDiag(text) {
    const d = $('localDiag');
    if (!d) return;
    d.style.display = text ? '' : 'none';
    d.textContent = text || '';
  }

  async function refreshLocalEngine() {
    const box = $('localBox');
    if (!box) return;
    if (form.provider !== 'builtin') {
      box.style.display = 'none';
      renderLocalProgress(null);
      stopLocalTimer();
      return;
    }
    box.style.display = '';
    try {
      // 抽屉里没有"源语言"这一项（只有设置页有），所以取已保存的配置
      const src = form.source || cfg.source || 'auto';
      const q = `?source=${encodeURIComponent(src)}&target=${encodeURIComponent(form.target || 'zh-CN')}`;
      const st = await api('/api/local-engine' + q);

      // ① 还没连上 Gale —— 这是最容易被误读成"未下载"的一种情况，必须说清楚并自动重试
      if (st.bridgeDown) {
        $('localState').textContent =
          st.galeRunning === false
            ? '⚠ 还没连接到 Gale：Gale 当前没有运行。启动 Gale 后这里会自动恢复。'
            : '⚠ 还没连接到 Gale 页面，正在自动重试…';
        showLocalDiag(st.reason || '');
        setLocalBtns({ enable: false, reset: false });
        renderLocalProgress(null);
        startLocalTimer(2000);
        applyI18n();
        return;
      }
      // ② 浏览器真的不支持
      if (!st.supported) {
        $('localState').textContent = '⚠ ' + (st.reason || '当前浏览器不支持内置引擎');
        showLocalDiag('');
        setLocalBtns({ enable: false, reset: false });
        renderLocalProgress(null);
        stopLocalTimer();
        applyI18n();
        return;
      }

      const pr = st.preparing || null;
      const pairsText = Object.entries(st.pairs || {})
        .map(([k, v]) => `${k}=${v}`)
        .join(' · ');
      // worker 没启动时后端只能靠磁盘推断，pairs 是空的 —— 别显示成"当前语言对 en>zh："后面空一片
      const pairLine = pairsText ? `当前语言对 ${st.wantKey}：${pairsText}` : '';
      const workerErr = st.worker && st.worker.lastError ? `本地翻译后端启动失败：${st.worker.lastError}` : '';

      // ③ 运行环境压根不提供端侧模型（Gale 用的 WebView2 就是如此；实测运行时 154.0.4258.62 下
      //    Translator.availability() 对**所有**语言对都返回 unavailable，create() 1ms 内抛
      //    NotSupportedError，连下载都不会开始）。这是**环境限制，不是"语言包还没下载"**。
      //    以前这种情况会掉进最后的 else，显示"还没下载：首次启用约需下载 200 MB"并放开
      //    「启用」按钮 —— 用户点了没有任何反应、进度条永远 0%，完全看不出原因。
      if (st.unusable) {
        $('localState').textContent =
          '⛔ ' + (st.reason || '当前运行环境不提供端侧翻译模型，内置引擎无法使用');
        $('localOut').textContent = '';
        setLocalBtns({ enable: false, reset: false });
        // 后端启动失败（比如无窗口 Edge 起不来）比"语言对状态"更值得说，优先摆出来
        showLocalDiag(workerErr || pairLine);
        renderLocalProgress(null);
        stopLocalTimer();
        applyI18n();
        return;
      }

      if (st.ready) {
        // 后端可能是 Gale 页面自己，也可能是插件拉起的无窗口 Edge（WebView2 不提供端侧模型时的正解）
        $('localState').textContent =
          st.backend === 'edge'
            ? '✅ 语言包已就绪：本地运行、不联网、不消耗任何额度（模型跑在插件拉起的无窗口 Edge 里，用的是系统安装的 Edge）'
            : '✅ 语言包已就绪：本地运行、不联网、不消耗任何额度';
        $('localOut').textContent = '';
        setLocalBtns({ enable: false, reset: true });
        showLocalDiag(pairLine);
        renderLocalProgress(null);
        stopLocalTimer();
      } else if (pr) {
        $('localState').textContent =
          pr.hasProgress === false ? '正在准备内置引擎（连接下载服务器）…' : `正在下载语言包… ${Math.round((pr.progress || 0) * 100)}%`;
        setLocalBtns({ enable: false, reset: false });
        showLocalDiag(st.lastError ? '上次错误：' + st.lastError : pairLine);
        renderLocalProgress(pr);
        startLocalTimer(700);
      } else if (st.stalePack) {
        // 语言包被删过 / 上次没下完：Edge 那边还认为装着（页面照样报 available），磁盘上却什么都没有。
        // 这种状态以前会显示"✅ 已就绪"，用户点翻译只得到一句泛化的失败 —— 现在如实报，并且
        // 点「启用内置引擎」会先清掉旧数据再重新下载（见 server/edge-worker 的自愈逻辑）。
        $('localState').textContent =
          '⚠ ' + (st.reason || '语言包文件不完整（可能被删过或上次没下完）：点「启用内置引擎」会清掉旧数据重新下载');
        setLocalBtns({ enable: true, reset: false });
        showLocalDiag(workerErr || pairLine);
        renderLocalProgress(null);
        stopLocalTimer();
      } else {
        $('localState').textContent = '语言包还没下载：首次启用约需下载 200 MB（一次性，之后一直可用）';
        setLocalBtns({ enable: true, reset: false });
        // 失败过就把原因摆出来，别让用户对着"未下载"猜
        showLocalDiag(
          workerErr
            ? workerErr
            : st.lastError
              ? '上次下载失败：' + st.lastError
              : pairLine,
        );
        renderLocalProgress(null);
        stopLocalTimer();
      }
      // 语言包行现在**常驻**（见 HTML 里的注释），这里不用再切显隐
      applyI18n();
    } catch (e) {
      $('localState').textContent = '状态获取失败：' + e.message;
      renderLocalProgress(null);
      applyI18n();
    }
  }

  /** 真正发起一次语言包下载（「启用内置引擎」和「下载语言包」共用同一条路） */
  async function startLocalDownload() {
    $('localOut').textContent = '已开始下载，请稍候…';
    $('localState').textContent = '正在准备内置引擎（连接下载服务器）…';
    renderLocalProgress({ progress: 0, hasProgress: false, elapsedMs: 0, speedBps: 0, etaMs: null });
    startLocalTimer(700);
    applyI18n();
    try {
      const r = await api('/api/local-engine/prepare', { source: form.source || cfg.source || 'auto', target: form.target || 'zh-CN' });
      if (r && r.ok === false) {
        // 服务端明确说没开始（比如 Gale 没连上），别让界面空转
        $('localOut').textContent = '启用失败：' + (r.error || '未知原因');
        stopLocalTimer();
        refreshLocalEngine().catch(() => {});
        applyI18n();
      }
    } catch (e) {
      $('localOut').textContent = '启用失败：' + e.message;
      stopLocalTimer();
      applyI18n();
    }
  }

  $('enableLocal').onclick = () => startLocalDownload();

  // 「下载语言包」：语言包没齐就真的去下（以前这里只做一次状态重读，用户按它没有任何反应，
  // 名字叫「重新检测」也让人不知道是干什么的）。已经就绪 / 正在下载时只如实汇报，不重复发起。
  $('recheckLocal').onclick = async () => {
    $('localOut').textContent = '';
    applyI18n();
    let st = null;
    try {
      st = await api('/api/local-engine');
    } catch (e) {
      $('localOut').textContent = '读取状态失败：' + e.message;
      return;
    }
    if (st && st.ready) {
      $('localOut').textContent = '语言包已就绪，不需要重新下载';
      refreshLocalEngine().catch(() => {});
      return;
    }
    if (st && st.preparing) {
      $('localOut').textContent = '语言包正在下载中，请稍候…';
      startLocalTimer(700);
      return;
    }
    if (st && st.unusable) {
      // 环境根本不支持（例如本机没有 Edge）：先说清原因，别让用户白等 200 MB
      $('localOut').textContent = '无法下载：' + (st.reason || '当前环境不提供端侧翻译模型');
      refreshLocalEngine().catch(() => {});
      applyI18n();
      return;
    }
    await startLocalDownload();
  };

  $('resetLocal').onclick = async () => {
    $('localOut').textContent = '正在重置…';
    applyI18n();
    try {
      const r = await api('/api/local-engine/reset', {});
      $('localOut').textContent = r.ok
        ? r.downloading
          ? '已重置（语言包还在下载，未打断）'
          : `已重置：清掉 ${r.cleared || 0} 个模型实例，下次翻译会重新创建`
        : '重置失败：' + (r.error || '未知原因');
      refreshLocalEngine().catch(() => {});
      applyI18n();
    } catch (e) {
      $('localOut').textContent = '重置失败：' + e.message;
      applyI18n();
    }
  };

  function fmtMB(bytes) {
    return (Number(bytes || 0) / 1048576).toFixed(1) + ' MB';
  }

  $('scanPack').onclick = async () => {
    $('localPackInfo').textContent = '正在扫描…';
    applyI18n();
    try {
      const r = await api('/api/local-engine/pack');
      // 插件自带 Edge 的那份要单独说：语言包只是这个 profile 的一部分，profile 里还有 Edge 自己的
      // 组件缓存（能长到几百 MB），而删除是整个 profile 一起删 —— 所以两个数都要摆出来。
      const wp = r.workerProfile || null;
      const seed = r.seed || null;
      const edge = r.edge || null;
      const parts = [];
      if (wp && wp.bytes > 0) {
        parts.push(
          `插件拉起的无窗口 Edge 数据目录 ${wp.path}：${fmtMB(wp.bytes)}` +
            (wp.packInstalled ? `（其中语言包 ${fmtMB(wp.packBytes)}）` : '（里面没有语言包）'),
        );
      }
      const others = (r.dirs || []).filter((d) => !wp || !String(d.path).toLowerCase().startsWith(String(wp.path).toLowerCase()));
      for (const d of others) parts.push(`${d.path}（${fmtMB(d.bytes)}）`);
      // 随包自带的那份不占 Edge 的 profile，但占磁盘；删掉只影响"以后重装不用下载"
      if (seed && seed.ready) {
        parts.push(
          `随包自带语言包 ${seed.path}：${fmtMB(seed.bytes)}` +
            (seed.runtime ? '（下次点「启用内置引擎」直接铺开，不用联网）' : '（缺少模型运行时 EdgeLLMRuntime，本次不能用来铺开）'),
        );
      }
      if (edge && edge.available === false) {
        parts.push('这台机器上没有找到 Microsoft Edge，内置引擎用不了（可以改用「本地大模型」或「本机 LibreTranslate」，或到设置里换个在线节点）');
      }
      if (!parts.length) {
        $('localPackInfo').textContent = '没有在磁盘上找到已下载的语言包（可能还没下载，或不在已知的 profile 目录里）。';
      } else {
        const total =
          (wp && wp.bytes > 0 ? wp.bytes : 0) + (seed && seed.ready ? seed.bytes || 0 : 0) + others.reduce((a, d) => a + d.bytes, 0);
        $('localPackInfo').textContent = `合计占用 ${fmtMB(total)}：` + parts.join('；');
      }
      applyI18n();
    } catch (e) {
      $('localPackInfo').textContent = '扫描失败：' + e.message;
      applyI18n();
    }
  };

  // 破坏性操作：**不用 window.confirm**（WebView2 / Tauri 里原生对话框不一定被宿主处理，
  // 有可能静默返回 false 或抛错），改成按钮上的两步确认。
  let delArmed = false;
  let delArmTimer = null;
  $('delPack').onclick = async () => {
    const btn = $('delPack');
    if (!delArmed) {
      delArmed = true;
      btn.textContent = '再点一次确认删除';
      btn.classList.add('bad');
      $('localPackInfo').textContent =
        '将清空插件拉起的无窗口 Edge 数据目录（语言包就在里面）。删完再点「启用内置引擎」会自动装回来：没装过的话约 200 MB、实测十几秒下完。如果磁盘上还有 Gale 自己那份语言包，也会一并删掉（那份需要先关掉 Gale）。想先看一眼位置、或者只删某一处，用旁边的「打开语言包位置」。此操作不可撤销。';
      applyI18n();
      clearTimeout(delArmTimer);
      delArmTimer = setTimeout(() => {
        delArmed = false;
        btn.textContent = '删除语言包';
        btn.classList.remove('bad');
        $('localPackInfo').textContent = '已取消。';
        applyI18n();
      }, 8000);
      return;
    }
    delArmed = false;
    clearTimeout(delArmTimer);
    btn.textContent = '删除语言包';
    btn.classList.remove('bad');
    $('localPackInfo').textContent = '正在删除…';
    applyI18n();
    try {
      const r = await api('/api/local-engine/pack/delete', { confirm: true, scope: 'all' });
      if (!r.ok) {
        $('localPackInfo').textContent = '删除失败：' + (r.error || '未知原因');
      } else if (!r.removed || !r.removed.length) {
        $('localPackInfo').textContent = r.note || '没有找到可删除的语言包。';
      } else {
        const tail = r.seedDeleted
          ? '（连随包自带的那份也一起删了。）'
          : '下次用内置引擎会自动装回来（没装语言包时约 200 MB，实测十几秒下完）。';
        $('localPackInfo').textContent = `已清理 ${r.removed.length} 处，释放 ${fmtMB(r.freedBytes)}。` + tail + (r.failed ? `（${r.failed} 处失败）` : '');
      }
      refreshLocalEngine().catch(() => {});
      applyI18n();
    } catch (e) {
      $('localPackInfo').textContent = '删除失败：' + e.message;
      applyI18n();
    }
  };

  // 「打开语言包位置」：纯磁盘操作 —— 在资源管理器里把语言包所在目录摊开，
  // 用户想自己看看/手动删都方便；不用关 Gale、也不影响已经装好的引擎。
  $('openPack').onclick = async () => {
    $('localPackInfo').textContent = '正在打开语言包所在目录…';
    applyI18n();
    try {
      const r = await api('/api/local-engine/pack/open', {});
      $('localPackInfo').textContent = r.ok
        ? `已在资源管理器里打开：${r.opened}`
        : `打开失败：${r.error || '未知原因'}（位置：${r.opened || '-'}）`;
    } catch (e) {
      $('localPackInfo').textContent = '打开失败：' + e.message;
    }
    applyI18n();
  };

  function renderCustomList() {
    const box = $('customList');
    const list = cfg.customSources || [];
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<div class="hint" style="margin-bottom:6px">（暂无自定义节点）</div>';
      applyI18n();
      return;
    }
    for (const s of list) {
      const d = document.createElement('div');
      d.className = 'src' + ('custom:' + s.id === form.provider ? ' on' : '');
      d.innerHTML = `<div class="body"><div class="n">${s.name || s.id}</div><div class="d">${s.url || ''}</div></div>`;
      d.querySelector('.body').onclick = () => {
        pfieldsAll[form.provider] = { ...pfields };
        form.provider = 'custom:' + s.id;
        pfields = loadProviderFields(form.provider);
        renderProviderList();
        writeUI();
        markDirty();
      };
      const edit = document.createElement('button');
      edit.className = 'ghost mini';
      edit.textContent = '编辑';
      edit.onclick = (e) => {
        e.stopPropagation();
        $('customBox').open = true;
        $('cs_name').value = s.name || '';
        $('cs_id').value = s.id || '';
        $('cs_url').value = s.url || '';
        $('cs_method').value = s.method || 'POST';
        $('cs_headers').value = s.headers || '';
        $('cs_body').value = s.body || '';
        $('cs_path').value = s.responsePath || '';
        $('cs_key').value = s.key || '';
        $('cs_batch').value = String(s.batch !== false);
        $('saveCustom').textContent = '保存修改';
        $('saveCustom').dataset.editing = s.id || '';
        applyI18n();
      };
      const del = document.createElement('button');
      del.className = 'danger mini';
      del.textContent = '删除';
      del.onclick = async (e) => {
        e.stopPropagation();
        const I = (s2) => (I18N ? I18N.t(s2) : s2);
        if (!confirm(I('删除自定义节点「') + (s.name || s.id) + I('」？'))) return;
        const next = (cfg.customSources || []).filter((x) => x.id !== s.id);
        const patch = { customSources: next };
        if (form.provider === 'custom:' + s.id) {
          patch.provider = 'builtin';
          form.provider = 'builtin';
        }
        await api('/api/config', patch);
        cfg = Object.assign(cfg, patch);
        await softApply();
        await refreshAll();
      };
      d.append(edit, del);
      box.appendChild(d);
    }
    applyI18n();
  }

  // ---------------------------------------------------------------- 体检
  const REASON_LABEL = {
    translated: '已翻译',
    untranslated: '未翻译',
    'mod-name': '模组名/作者名（保留）',
    identifier: '标识符/路径（保留）',
    'ui-chrome': '界面框架（跳过）',
    code: '代码块（跳过）',
    glossary: '术语表保护',
    phrase: '固定译法',
    forced: '你点名翻译',
    'too-short': '太短（跳过）',
    link: '链接文字（保留）',
    mojibake: '乱码文本（跳过）',
    pending: '翻译中',
    failed: '翻译失败（会自动重试）',
    unchanged: '机翻未改动',
  };

  function renderHealth(cov) {
    const box = $('healthOut');
    box.innerHTML = '';
    const rows = Object.entries(cov.counts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${REASON_LABEL[k] || k}：<b>${v}</b>`)
      .join(' · ');
    box.insertAdjacentHTML('beforeend', `<div class="hint" style="margin-top:6px">${rows}</div>`);
    const samples = [...new Set([...(cov.samples?.untranslated || []), ...(cov.samples?.unchanged || [])])];
    for (const text of samples) {
      const row = document.createElement('div');
      row.className = 'cov';
      const span = document.createElement('span');
      span.className = 't';
      span.textContent = text;
      const b1 = document.createElement('button');
      b1.className = 'mini';
      b1.textContent = '翻译它';
      b1.onclick = () =>
        applyPatch({ forceTranslate: [...new Set([...(cfg.forceTranslate || []), text])] }, '已加入强制翻译');
      const b2 = document.createElement('button');
      b2.className = 'ghost mini';
      b2.textContent = '指定译法';
      b2.onclick = () => {
        const I = (s) => (I18N ? I18N.t(s) : s);
        const val = prompt(I('把「') + text + I('」固定翻译成：'), '');
        if (val) applyPatch({ phraseMap: Object.assign({}, cfg.phraseMap || {}, { [text]: val }) }, '已加入固定译法');
      };
      const b3 = document.createElement('button');
      b3.className = 'ghost mini';
      b3.textContent = '保护它';
      b3.onclick = () =>
        applyPatch(
          { glossary: [...new Set([...(cfg.glossary || []).map((g) => (typeof g === 'string' ? g : g.from)), text])] },
          '已加入术语保护表',
        );
      row.append(span, b1, b2, b3);
      box.appendChild(row);
    }
    applyI18n();
  }

  /** 体检里的一键操作：先落盘未保存的改动，再应用这条补丁，然后软应用 */
  async function applyPatch(patch, msg) {
    try {
      if (diffCount()) {
        await api('/api/config', collectPatch());
        dirty = false;
      }
      const r = await api('/api/config', patch);
      cfg = Object.assign(cfg, r.config || patch);
      // 改了翻译节点（或仅本地模式）要让悬浮栏那份列表跟着变，否则它还能选已停用的节点
      if (TR && typeof TR.refreshConfig === 'function') TR.refreshConfig();
      await softApply();
      flash(msg);
      await refreshAll();
      $('health').click();
    } catch (e) {
      flash('失败：' + e.message, true);
    }
  }

  // ---------------------------------------------------------------- 全量刷新
  async function refreshAll({ keepEdits = true } = {}) {
    stats.refreshStarted++;
    try {
      const [cc, full, langs] = await Promise.all([api('/api/client-config'), api('/api/config'), api('/api/langs')]);
      providers = cc.providers || [];
      cfg = Object.assign({}, cc.config, full.config);

      const tl = $('target');
      tl.innerHTML = '';
      for (const l of langs.langs || []) {
        const o = document.createElement('option');
        o.value = l.code;
        o.textContent = `${l.name}（${l.code}）`;
        tl.appendChild(o);
      }
      if (![...tl.options].some((o) => o.value === cfg.target)) {
        const o = document.createElement('option');
        o.value = cfg.target || 'zh-CN';
        o.textContent = cfg.target || 'zh-CN';
        tl.appendChild(o);
      }

      buildFromCfg({ keepEdits });
      renderProviderList();
      renderCustomList();
      writeUI();

      await refreshStatus();
      await refreshLib();
      refreshSystem().catch(() => {});
      stats.refreshDone++;
    } catch (e) {
      stats.lastError = String((e && e.message) || e);
      throw e;
    }
  }

  // ---------------------------------------------------------------- 事件
  const on = (id, ev, fn) => {
    const el = $(id);
    if (el) el.addEventListener(ev, fn);
  };
  const bindForm = (id, key, read = (el) => el.value) =>
    on(id, 'change', (e) => {
      const prevProvider = form.provider;
      form[key] = read(e.target);
      if (key === 'provider') {
        if (prevProvider !== form.provider) {
          pfieldsAll[prevProvider] = { ...pfields };
          pfields = loadProviderFields(form.provider);
        }
        renderProviderList();
        writeUI();
      }
      if (key === 'qMode') $('bestOpts').style.display = form.qMode === 'best' ? '' : 'none';
      if (key === 'offlineOnly') renderProviderList();
      markDirty();
    });

  $('close').onclick = () => setOpen(false);
  $('scrim').onclick = () => setOpen(false);
  $('refresh').onclick = () => refreshAll().catch((e) => flash('刷新失败：' + e.message, true));

  on('uiLang', 'change', async (e) => {
    const lang = e.target.value;
    cfg.uiLang = lang;
    try {
      await api('/api/config', { uiLang: lang });
    } catch {}
    if (I18N) I18N.setLang(lang);
    applyI18n();
    refreshSaveBtn();
    // 节点名 / 说明是服务端按语言下发的，切完要重新拉一遍
    refreshAll({ keepEdits: true }).catch(() => {});
  });

  bindForm('provider', 'provider');
  // 「仅本地翻译」是**安全开关**，必须一勾就落盘并生效，不能等左下角「保存设置」：
  // 以前的写法是"勾完不保存就直接关掉 Gale / 关掉页面"，下次打开又变回未勾选，
  // 用户会以为这个开关没用（实际上配置里一直是 false）。这里改成立即保存 + 立即生效，
  // 并把这次改动同步进"已保存基线"，免得它一直被算作"1 项未保存"。
  on('offlineOnly', 'change', async (e) => {
    form.offlineOnly = String(!!e.target.checked);
    renderProviderList();
    const base = JSON.parse(baseline || '{"f":{},"p":{}}');
    base.f = { ...(base.f || {}), offlineOnly: form.offlineOnly };
    baseline = JSON.stringify(base);
    const on2 = form.offlineOnly === 'true';
    try {
      const r = await api('/api/config', { offlineOnly: on2 });
      cfg = Object.assign(cfg, r.config || {});
      // 悬浮栏的翻译节点列表跟着置灰 / 恢复（否则它还能选已停用的节点）
      if (TR && typeof TR.refreshConfig === 'function') TR.refreshConfig();
      await softApply();
      flash(on2 ? '已开启仅本地翻译并保存（在线节点已在悬浮栏与抽屉里停用）' : '已关闭仅本地翻译并保存');
    } catch (err) {
      flash('保存失败：' + err.message, true);
    }
    refreshSaveBtn();
  });
  bindForm('target', 'target');
  bindForm('fallback', 'fallback');
  bindForm('proxy', 'proxy');
  bindForm('minLen', 'minLen');
  bindForm('translateNames', 'translateNames');
  bindForm('translateConfigPage', 'translateConfigPage');
  bindForm('hoverOriginal', 'hoverOriginal');
  bindForm('chineseSearch', 'chineseSearch');
  bindForm('fuzzyReuse', 'fuzzyReuse');
  bindForm('quality', 'qMode');
  bindForm('qVoters', 'qVoters');
  bindForm('qConsistency', 'qConsistency');
  bindForm('polishEnabled', 'polishEnabled');
  bindForm('polishMinLen', 'polishMinLen');
  bindForm('polishBatch', 'polishBatch');
  for (const id of ['glossary', 'phraseMap', 'postReplace']) on(id, 'input', (e) => { form[id] = e.target.value; markDirty(); });

  $('save').onclick = async () => {
    const n = diffCount();
    if (!n) {
      flash('没有需要保存的更改');
      return;
    }
    $('save').textContent = '保存中…';
    try {
      const r = await api('/api/config', collectPatch());
      cfg = Object.assign(cfg, r.config || {});
      if (r.migrationNotes && r.migrationNotes.length) flash('配置已迁移：' + r.migrationNotes.join('；'));
      dirty = false;
      // 保存后同步悬浮栏的翻译源列表（仅本地模式下在线节点要立刻置灰 / 恢复）
      if (TR && typeof TR.refreshConfig === 'function') TR.refreshConfig();
      await refreshAll({ keepEdits: false });
      const applied = await softApply();
      flash(applied ? `已保存 ${n} 项并生效` : `已保存 ${n} 项（下次翻译生效）`);
    } catch (e) {
      flash('保存失败：' + e.message, true);
      refreshSaveBtn();
    }
  };

  $('discard').onclick = async () => {
    dirty = false;
    await refreshAll({ keepEdits: false });
    flash('已还原未保存的更改');
  };

  $('testProvider').onclick = async () => {
    const p = providers.find((x) => x.id === form.provider);
    const secret = ((p && p.fields) || []).find((f) => f.type === 'password');
    if (secret && !pfields[secret.key]) {
      $('testOut').textContent = `请先填写 ${secret.label} 并保存`;
      applyI18n();
      return;
    }
    $('testOut').textContent = '测试中…';
    try {
      // 测试用的是"当前填写的值"，所以先把未保存的改动落盘
      if (diffCount()) {
        const r = await api('/api/config', collectPatch());
        cfg = Object.assign(cfg, r.config || {});
        dirty = false;
        refreshSaveBtn();
      }
      const r = await api('/api/test-provider', { provider: form.provider });
      $('testOut').textContent = r.ok ? `成功 ${r.ms}ms：${r.results.join(' / ')}` : `失败：${r.error}`;
    } catch (e) {
      $('testOut').textContent = '失败：' + e.message;
    }
    applyI18n();
  };

  $('saveCustom').onclick = async () => {
    const id = $('cs_id').value.trim().replace(/\s+/g, '-');
    if (!$('cs_name').value.trim() || !id || !$('cs_url').value.trim()) {
      flash('名称、id、请求地址都要填', true);
      return;
    }
    const editing = $('saveCustom').dataset.editing;
    const item = {
      id,
      name: $('cs_name').value.trim(),
      url: $('cs_url').value.trim(),
      method: $('cs_method').value,
      headers: $('cs_headers').value,
      body: $('cs_body').value,
      responsePath: $('cs_path').value.trim(),
      key: $('cs_key').value,
      batch: $('cs_batch').value === 'true',
      enabled: true,
    };
    const list = (cfg.customSources || []).filter((x) => x.id !== (editing || id));
    list.push(item);
    delete $('saveCustom').dataset.editing;
    $('saveCustom').textContent = '添加节点';
    for (const f of ['cs_name', 'cs_id', 'cs_url', 'cs_path', 'cs_key']) $(f).value = '';
    try {
      const r = await api('/api/config', { customSources: list });
      cfg = Object.assign(cfg, r.config || {});
      await softApply();
      await refreshAll();
      flash('自定义节点已保存');
    } catch (e) {
      flash('保存失败：' + e.message, true);
    }
  };

  $('testPolish').onclick = async () => {
    $('polishOut').textContent = '测试中…';
    applyI18n();
    try {
      const r = await api('/api/polish/test', {});
      $('polishOut').textContent = r.ok ? '结果：' + r.result : '失败：' + r.error;
    } catch (e) {
      $('polishOut').textContent = '失败：' + e.message;
    }
    applyI18n();
  };

  $('btnCompare').onclick = async () => {
    const text = $('cmpText').value.trim();
    if (!text) return;
    $('cmpOut').textContent = '翻译中…';
    $('cmpOutBox').innerHTML = '';
    applyI18n();
    try {
      const r = await api('/api/compare', { text, verify: $('cmpVerify').checked });
      $('cmpOut').textContent = '';
      const rows = (r.results || [])
        .map(
          (x) =>
            `<div class="cov"><span class="t"><b>${x.score}</b> ${x.provider}<br>${x.dst}<br><span class="hint">${(x.reasons || []).join('；')}</span></span></div>`,
        )
        .join('');
      const fail = (r.failed || []).map((x) => `<div class="hint bad">✗ ${x.provider}：${x.error}</div>`).join('');
      $('cmpOutBox').innerHTML = rows + fail || '<div class="hint">没有可用节点</div>';
    } catch (e) {
      $('cmpOut').textContent = '失败：' + e.message;
    }
    applyI18n();
  };

  $('sysProxy').onclick = () => {
    form.proxy = 'system';
    writeUI();
    markDirty();
    flash('已设为跟随系统代理（记得点左下角「保存设置」）');
  };

  $('detectProxy').onclick = async () => {
    const out = $('proxyOut');
    out.textContent = '探测中…';
    applyI18n();
    try {
      const r = await api('/api/detect-proxy', {});
      const best = (r.candidates || []).find((c) => c.ok);
      const list = (r.candidates || []).map((c) => `${c.ok ? '✓' : '✗'} ${c.url}${c.ok ? ` ${c.ms}ms` : ' ' + c.error}`).join('<br>');
      out.innerHTML = `系统代理：${r.system || '未启用'}<br>${list || '未发现本地代理端口'}`;
      if (best) {
        form.proxy = best.url;
        writeUI();
        markDirty();
        flash('已填入可用代理：' + best.url + '（记得保存）');
      } else {
        flash('没有可用代理，请确认梯子已开启', true);
      }
    } catch (e) {
      out.textContent = '探测失败：' + e.message;
    }
    applyI18n();
  };

  $('health').onclick = async () => {
    const box = $('healthOut');
    box.innerHTML = '<div class="hint">体检中…</div>';
    applyI18n();
    try {
      const r = await api('/api/coverage');
      if (!r.ok) throw new Error(r.error || '体检失败');
      box.innerHTML = '';
      renderHealth(r.coverage);
      if (!box.children.length) box.innerHTML = '<div class="hint">没有发现问题。</div>';
    } catch (e) {
      box.innerHTML = '<div class="hint bad">失败：' + e.message + '</div>';
    }
    applyI18n();
  };

  $('clearCache').onclick = async () => {
    const I = (s) => (I18N ? I18N.t(s) : s);
    if (!confirm(I('清空翻译缓存？（译库不受影响）'))) return;
    try {
      await api('/api/cache/clear', {});
      $('cacheOut').textContent = '已清空';
      await refreshStatus();
      await refreshLib();
    } catch (e) {
      $('cacheOut').textContent = '失败：' + e.message;
    }
    applyI18n();
  };

  $('libExport').onclick = async () => {
    $('libOut').textContent = '导出中…';
    applyI18n();
    try {
      const r = await api('/api/library/export', {
        target: $('libTarget').value.trim(),
        game: $('libGame').value.trim(),
        includeCache: true,
      });
      $('libOut').textContent = r.ok ? `已导出 ${r.count} 条 → ${r.file}（${Math.round(r.bytes / 1024)} KB）` : '失败：' + r.error;
      await refreshLib();
    } catch (e) {
      $('libOut').textContent = '失败：' + e.message;
    }
    applyI18n();
  };

  $('libImport').onclick = async () => {
    const v = $('libImportPath').value.trim();
    if (!v) {
      flash('请填写文件路径或网址', true);
      return;
    }
    $('libSubOut').textContent = '导入中…';
    applyI18n();
    try {
      const r = await api('/api/library/import', v.startsWith('http') ? { url: v } : { path: v });
      $('libSubOut').textContent = r.ok ? `导入完成：新增 ${r.added} 条，跳过 ${r.skipped}，共 ${r.total} 条` : '导入失败：' + r.error;
      await refreshLib();
    } catch (e) {
      $('libSubOut').textContent = '导入失败：' + e.message;
    }
    applyI18n();
  };

  $('libSubsSave').onclick = async () => {
    const urls = $('libSubs').value.split('\n').map((s) => s.trim()).filter(Boolean);
    try {
      await api('/api/library/subscribe', { url: '', remove: true });
      for (const u of urls) await api('/api/library/subscribe', { url: u });
      $('libSubOut').textContent = `已保存 ${urls.length} 个订阅，开始拉取…`;
      for (const u of urls) {
        const r = await api('/api/library/import', { url: u });
        $('libSubOut').textContent = r.ok ? `订阅更新：新增 ${r.added} 条` : '订阅失败：' + r.error;
      }
      await refreshLib();
    } catch (e) {
      $('libSubOut').textContent = '订阅失败：' + e.message;
    }
    applyI18n();
  };

  $('libClear').onclick = async () => {
    const I = (s) => (I18N ? I18N.t(s) : s);
    if (!confirm(I('确定清空译库？（节点缓存不受影响）'))) return;
    try {
      await api('/api/library/clear', {});
      $('libSubOut').textContent = '译库已清空';
      await refreshLib();
      await refreshStatus();
    } catch (e) {
      $('libSubOut').textContent = '失败：' + e.message;
    }
    applyI18n();
  };

  const sysAction = async (path, body, label) => {
    try {
      const r = await api(path, body);
      flash(r.ok === false ? '失败：' + (r.error || '') : label + '完成', r.ok === false);
      await refreshSystem();
    } catch (e) {
      flash('失败：' + e.message, true);
    }
  };
  $('sysOn').onclick = () => sysAction('/api/system/shortcut', { enable: true }, '开启免启动器模式');
  $('sysOff').onclick = () => sysAction('/api/system/shortcut', { enable: false }, '还原');
  $('autoOn').onclick = () => sysAction('/api/system/autostart', { enable: true }, '开启开机自启');
  $('autoOff').onclick = () => sysAction('/api/system/autostart', { enable: false }, '关闭开机自启');

  $('loadLog').onclick = async () => {
    try {
      const s = await api('/api/status');
      $('logPre').textContent = (s.events || []).map((e) => `${new Date(e.t).toLocaleTimeString()} [${e.level}] ${e.msg}`).join('\n') || '（无）';
      $('logOut').textContent = `共 ${(s.events || []).length} 条`;
    } catch (e) {
      $('logPre').textContent = '加载失败：' + e.message;
    }
    applyI18n();
  };

  $('reinject').onclick = async () => {
    try {
      const r = await api('/api/reinject', { reload: true });
      flash(r.ok ? '已重新注入并刷新页面' : '注入失败：' + r.error);
    } catch (e) {
      flash('失败：' + e.message, true);
    }
  };

  $('openFull').onclick = async () => {
    try {
      await api('/api/open-settings');
    } catch {}
  };

  // 打开时也要把抽屉自身翻一遍（语言可能不是中文）
  applyI18n();

  let refreshErr = '';
  // 调试计数：排查"抽屉打开却空白"时用（谁调了、有没有跑完、boot 了几次）
  const stats = { setOpen: 0, refreshStarted: 0, refreshDone: 0, boots: window.__galeDrawerBoots };
  function setOpen(v) {
    stats.setOpen++;
    open = v;
    hostEl.classList.toggle('open', v);
    if (v) {
      refreshAll({ keepEdits: true }).catch((e) => {
        // 别静默吞掉：抽屉"打开却空白"时，这条信息是唯一的线索
        refreshErr = String((e && e.message) || e);
        try {
          console.error('[Gale汉化] 抽屉刷新失败:', e);
        } catch {}
        const st = $('status');
        if (st && !st.textContent) st.textContent = '刷新失败：' + refreshErr;
      });
      if (!timer) timer = setInterval(() => refreshStatus().catch(() => {}), 5000);
    } else if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  window.__galeDrawer = {
    __installed: true,
    __build: BOOT.build || '',
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    isOpen: () => open,
    isAlive: () => !!(host && host.isConnected),
    isDirty: () => diffCount() > 0,
    /**
     * 悬浮栏（inject.js）改了配置时调它：把改动并进抽屉的表单层，
     * 免得"悬浮栏里选了别的节点、抽屉里还显示 builtin"。
     * 这里**故意不调 refreshAll**：那会多一次网络往返，还可能把用户正在编辑的其他字段冲掉。
     */
    onConfigChanged: (patch = {}) => {
      try {
        cfg = Object.assign(cfg, patch);
        if ('provider' in patch) {
          form.provider = String(patch.provider || '');
          pfields = loadProviderFields(patch.provider);
        }
        if ('offlineOnly' in patch) form.offlineOnly = String(!!patch.offlineOnly);
        if ('fallback' in patch) form.fallback = Array.isArray(patch.fallback) ? patch.fallback.join(',') : String(patch.fallback || '');
        renderProviderList();
        writeUI();
        refreshStatus().catch(() => {});
      } catch (e) {
        refreshErr = String((e && e.message) || e);
      }
    },
    /** 调试用：重新拉一遍配置与状态（排查"抽屉空白"时很好使） */
    refresh: () => refreshAll({ keepEdits: true }),
    lastRefreshError: () => refreshErr,
    stats: () => ({ ...stats, skipped: window.__galeDrawerBootsSkipped || 0, hostConnected: !!(host && host.isConnected) }),
    dispose: () => {
      try {
        if (timer) clearInterval(timer);
        timer = null;
        host.remove();
        delete window.__galeDrawer;
      } catch {}
    },
  };

  // 重建（代码更新）时如果之前是开着的，保持打开并立刻刷新一遍，
  // 不要"因为重新注入就把用户正在看的抽屉关掉"。
  if (prevWasOpen) setOpen(true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
