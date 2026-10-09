// 通过 CDP 连接 Gale 的 WebView2，注入页面脚本并在重载/重开后自动重挂
const DEFAULT_PORT = 9223;

export class CdpBridge {
  constructor({
    port = DEFAULT_PORT,
    servicePort = 0,
    onLog = () => {},
    onAttach = null,
    // 自定义"该连哪个页面"的判定。Edge worker 用它挑自己的翻译页；
    // 不传就用下面的默认逻辑（只认 Gale 的内容页）。
    pickPage = null,
    pageLabel = 'Gale 页面目标',
  } = {}) {
    this.port = port;
    this.servicePort = servicePort; // 插件自己的服务端口：绝不注入到自己的设置页
    this.onLog = onLog;
    this.onAttach = onAttach;
    this.pickPage = typeof pickPage === 'function' ? pickPage : null;
    this.pageLabel = pageLabel;
    this.ws = null;
    this.targetId = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stopped = false;
    this.attached = false;
    this.lastError = null;
    this.injectPrelude = '';
    this.injectScript = '';
    this._timer = null;
  }

  log(msg) {
    this.onLog(msg);
  }

  async _fetchTargets() {
    const res = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  start() {
    this.stopped = false;
    this._loop();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this._timer);
    try {
      this.ws?.close();
    } catch {}
  }

  /** 挑出该注入的页面：只接受真正的内容页（http / https / file），
   *  并且**排除插件自己的设置页**。
   *  为什么必须收紧：浏览器内部页（about: / devtools: / edge: / chrome:）强制开启
   *  Trusted Types，往里注入会直接抛 `This document requires 'TrustedHTML' assignment`；
   *  而那个异常会打断注入流程，导致真正的 Gale 页面反而没挂上引擎（表现为"整页不翻译"）。 */
  _pickPage(targets) {
    const pages = (targets || []).filter((t) => t.type === 'page' && /^(https?|file):/i.test(t.url || ''));
    const isGale = (u) => /tauri\.localhost|^file:/i.test(u);
    const isOwn = (u) => {
      if (!this.servicePort) return false;
      return new RegExp(`^https?://(127\\.0\\.0\\.1|localhost|\\[::1\\]):${this.servicePort}(/|$|\\?)`, 'i').test(u);
    };
    return pages.find((t) => isGale(t.url)) || pages.find((t) => !isOwn(t.url)) || null;
  }

  async _loop() {
    if (this.stopped) return;
    try {
      if (!this.ws || this.ws.readyState !== 1) {
        const targets = await this._fetchTargets();
        const page = this.pickPage ? this.pickPage(targets) : this._pickPage(targets);
        if (!page) throw new Error(`未找到 ${this.pageLabel}`);
        if (this.targetId !== page.id) {
          this.targetId = page.id;
          this.attached = false;
        }
        await this._connect(page.webSocketDebuggerUrl);
      }
    } catch (e) {
      this.lastError = e.message;
      if (!this._warned || Date.now() - this._warned > 30000) {
        this._warned = Date.now();
        this.log(`等待 Gale 调试端口 ${this.port} … (${e.message})`);
      }
    }
    this._timer = setTimeout(() => this._loop(), this.attached ? 3000 : 2000);
    this._timer.unref?.();
  }

  _connect(url) {
    return new Promise((resolve) => {
      let settled = false;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.addEventListener('open', async () => {
        this.log('已连接 Gale WebView2');
        try {
          await this.send('Runtime.enable');
          await this.send('Page.enable');
          await this.inject();
          this.attached = true;
          this.lastError = null; // 连上了就把上次的失败信息清掉，否则界面会一直显示「· fetch failed」
          this.onAttach?.();
        } catch (e) {
          this.log('注入失败: ' + e.message);
        }
        settled = true;
        resolve();
      });
      ws.addEventListener('message', (ev) => this._onMessage(ev));
      ws.addEventListener('close', () => {
        if (this.attached) this.log('与 Gale 的连接断开，稍后重连');
        this.attached = false;
        this.ws = null;
        for (const [, p] of this.pending) p.reject(new Error('连接已关闭'));
        this.pending.clear();
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      ws.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    });
  }

  _onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  }

  send(method, params = {}, timeout = 20000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error('WebSocket 未连接'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeout);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  setInjection(prelude, script) {
    this.injectPrelude = prelude;
    this.injectScript = script;
  }

  async inject() {
    if (!this.injectScript) return;
    // ⚠️ `Page.addScriptToEvaluateOnNewDocument` 是**累加**的：注册几次，之后每次导航就执行几遍。
    // 以前没记录 identifier、也从不移除，所以每重连一次就多堆一份 ——
    // 结果是页内脚本被执行 N 遍（悬浮条/抽屉被反复拆建，抽屉会被"重建"成空白）。
    // 这里先移除上一次注册的脚本，保证同一时刻只有一份。
    if (this._scriptId) {
      try {
        await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this._scriptId });
      } catch {}
      this._scriptId = null;
    }
    const r = await this.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `${this.injectPrelude}\n${this.injectScript}`,
    });
    this._scriptId = r?.identifier || null;
    // 对当前已加载的文档立即执行一次
    await this.evaluate(`${this.injectPrelude}\n${this.injectScript}\n//# sourceURL=gale-mod-translator-inject.js`);
  }

  /** 在当前页面上下文执行 JS，返回 JSON 结果。
   *  userGesture 默认打开：有些 Web API（如浏览器的内置翻译模型）要求"用户激活"才能用，
   *  而注入脚本是在 document-start 跑的、拿不到真实手势。 */
  async evaluate(expression, { awaitPromise = true, userGesture = true, timeout = 20000 } = {}) {
    const r = await this.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise,
        returnByValue: true,
        userGesture,
      },
      timeout,
    );
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || d.text || '页面脚本异常');
    }
    return r.result?.value;
  }

  get status() {
    return {
      port: this.port,
      connected: !!this.ws && this.ws.readyState === 1,
      attached: this.attached,
      targetId: this.targetId,
      lastError: this.lastError,
    };
  }
}
