// 仅依赖 Node 内置模块的 HTTP(S) 客户端，支持 HTTP 代理（CONNECT 隧道）与 SOCKS5 代理。
// 之所以不用全局 fetch：Node 24 的 fetch 无法在运行时切换代理。
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';

// ------------------------------------------------------------------ 仅本地模式（禁网）
// 这个模块是**所有对外 HTTP 的唯一出口**（各个翻译节点、LLM 润色、代理检测、译库导入……），
// 所以把开关卡在这里，就等于卡住了所有可能外发的请求 —— 比在每个调用点分别判断可靠得多。
// 开关由 server.mjs 在读取/保存配置时同步过来（config.offlineOnly）。
let offlineOnly = false;
let offlineLogger = null;

export function setOfflineOnly(v) {
  offlineOnly = !!v;
}
export function isOfflineOnly() {
  return offlineOnly;
}
/** 拦截时的记录回调（server.mjs 传 logLine 进来，好让用户能在日志里看到"是被拦了"而不是"翻译坏了"） */
export function setOfflineLogger(fn) {
  offlineLogger = typeof fn === 'function' ? fn : null;
}
/** 回环地址（本地）：127.0.0.0/8、::1、localhost —— 这些不算"联网" */
export function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1' || /^127\./.test(h);
}
export function isLoopbackUrl(u) {
  try {
    return isLoopbackHost(new URL(String(u)).hostname);
  } catch {
    return false;
  }
}

class HttpsProxyAgent extends https.Agent {
  constructor(proxyUrl, options = {}) {
    super({ keepAlive: true, maxSockets: 8, ...options });
    const u = new URL(proxyUrl);
    this.proxyHost = u.hostname;
    this.proxyPort = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    this.proxyAuth = u.username
      ? 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || '')}`).toString('base64')
      : null;
  }

  createConnection(options, callback) {
    const targetHost = options.host;
    const targetPort = options.port || 443;
    const socket = net.connect(this.proxyPort, this.proxyHost);
    let header = '';
    const onData = (chunk) => {
      header += chunk.toString('latin1');
      const end = header.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.removeListener('data', onData);
      const statusLine = header.split('\r\n')[0];
      if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
        socket.destroy();
        return callback(new Error(`代理 CONNECT 失败: ${statusLine}`));
      }
      const rest = header.slice(end + 4);
      if (rest.length) socket.unshift(Buffer.from(rest, 'latin1'));
      const tlsSocket = tls.connect({ socket, servername: targetHost }, () => callback(null, tlsSocket));
      tlsSocket.once('error', (e) => callback(e));
    };
    socket.once('error', (e) => callback(new Error(`代理连接失败: ${e.message}`)));
    socket.on('data', onData);
    const lines = [
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
      `Host: ${targetHost}:${targetPort}`,
      'Proxy-Connection: keep-alive',
    ];
    if (this.proxyAuth) lines.push(`Proxy-Authorization: ${this.proxyAuth}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
  }
}

const agentCache = new Map();
function agentFor(proxy) {
  if (!proxy) return undefined;
  if (!agentCache.has(proxy)) {
    agentCache.set(proxy, /^socks/i.test(proxy) ? new Socks5Agent(proxy) : new HttpsProxyAgent(proxy));
  }
  return agentCache.get(proxy);
}

// ------------------------------------------------------------------ 系统代理 / SOCKS5
let _sysProxyCache = { at: 0, value: null, pac: null };
const execFileP = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 5000 }, (err, stdout) => resolve(err ? '' : String(stdout || ''))));

/** 读取 Windows 系统代理（IE/WinINET 设置）。返回如 http://127.0.0.1:7892，没有则 null。 */
export async function getSystemProxy() {
  if (Date.now() - _sysProxyCache.at < 10000) return _sysProxyCache.value;
  let value = null;
  let pac = null;
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const enabled = await execFileP('reg', ['query', key, '/v', 'ProxyEnable']);
    const pacOut = await execFileP('reg', ['query', key, '/v', 'AutoConfigURL']);
    const pm = pacOut.match(/AutoConfigURL\s+REG_SZ\s+(\S+)/);
    if (pm) pac = pm[1];
    if (/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enabled)) {
      const out = await execFileP('reg', ['query', key, '/v', 'ProxyServer']);
      const m = out.match(/ProxyServer\s+REG_SZ\s+(.+?)\s*$/m);
      if (m) value = m[1].trim();
    }
  } catch {}
  if (value && value.includes('=')) {
    // 形如 "http=127.0.0.1:7890;https=127.0.0.1:7890"
    const parts = Object.fromEntries(
      value
        .split(';')
        .map((s) => s.split('='))
        .filter((p) => p.length === 2),
    );
    value = parts.https || parts.http || null;
  }
  if (value && !/^[a-z]+:\/\//i.test(value)) value = 'http://' + value;
  _sysProxyCache = { at: Date.now(), value, pac };
  return value;
}

export async function getPacUrl() {
  await getSystemProxy();
  return _sysProxyCache.pac;
}

/** 把配置里的 proxy 字段解析成真正可用的代理地址。
 *  ''/'direct' -> 直连（null）；'system' -> 读系统代理；本地地址永远直连。 */
export async function resolveProxy(proxy, targetHost = '') {
  if (/^(127\.0\.0\.1|localhost|\[::1\]|::1)$/i.test(String(targetHost || ''))) return null; // 本机服务不绕代理
  const p = String(proxy || '').trim();
  if (!p || p.toLowerCase() === 'direct' || p.toLowerCase() === 'none') return null;
  if (p.toLowerCase() === 'system' || p.toLowerCase() === 'auto') return await getSystemProxy();
  return p;
}

/** SOCKS5 / SOCKS5h 代理（本地客户端如 Clash 的 socks 端口、v2rayN 的 10808 等） */
class Socks5Agent extends https.Agent {
  constructor(proxyUrl, options = {}) {
    super({ keepAlive: true, maxSockets: 8, ...options });
    const u = new URL(proxyUrl.replace(/^socks5h:/i, 'socks5:'));
    this.proxyHost = u.hostname;
    this.proxyPort = Number(u.port || 1080);
    this.user = u.username ? decodeURIComponent(u.username) : null;
    this.pass = u.password ? decodeURIComponent(u.password) : '';
  }

  createConnection(options, callback) {
    const targetHost = options.host;
    const targetPort = options.port || 443;
    const socket = net.connect(this.proxyPort, this.proxyHost);
    let buf = Buffer.alloc(0);
    let phase = 'greeting';
    let done = false;
    const fail = (e) => {
      if (done) return;
      done = true;
      socket.destroy();
      callback(e);
    };
    const sendConnect = () => {
      const host = Buffer.from(targetHost, 'utf8');
      const port = Buffer.alloc(2);
      port.writeUInt16BE(targetPort);
      socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, port]));
      phase = 'connect';
      buf = Buffer.alloc(0);
    };
    socket.once('error', (e) => fail(new Error(`SOCKS5 代理连接失败: ${e.message}`)));
    socket.once('connect', () => {
      socket.write(this.user ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
    });
    socket.on('data', (chunk) => {
      if (done) return;
      buf = Buffer.concat([buf, chunk]);

      if (phase === 'greeting') {
        if (buf.length < 2) return;
        if (buf[0] !== 5) return fail(new Error('SOCKS5 代理返回异常'));
        const method = buf[1];
        buf = buf.subarray(2);
        if (method === 0) return sendConnect();
        if (method === 2) {
          const u = Buffer.from(this.user || '', 'utf8');
          const p = Buffer.from(this.pass || '', 'utf8');
          socket.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
          phase = 'auth';
          return;
        }
        return fail(new Error('SOCKS5 代理要求不支持的认证方式'));
      }

      if (phase === 'auth') {
        if (buf.length < 2) return;
        if (buf[1] !== 0) return fail(new Error('SOCKS5 用户名/密码认证失败'));
        buf = buf.subarray(2);
        return sendConnect();
      }

      if (phase === 'connect') {
        if (buf.length < 4) return;
        if (buf[1] !== 0) return fail(new Error(`SOCKS5 连接目标失败，错误码 ${buf[1]}`));
        const atyp = buf[3];
        const need = atyp === 1 ? 10 : atyp === 4 ? 22 : 4 + buf[4] + 2;
        if (buf.length < need) return;
        const rest = buf.subarray(need);
        done = true;
        socket.removeAllListeners('data');
        if (rest.length) socket.unshift(rest);
        const tlsSocket = tls.connect({ socket, servername: targetHost }, () => callback(null, tlsSocket));
        tlsSocket.once('error', (e) => callback(e));
      }
    });
  }
}

/**
 * 发起一次 HTTP(S) 请求
 * @param {string} url
 * @param {{method?:string, headers?:object, body?:string|Buffer, timeout?:number, proxy?:string|null, maxRedirects?:number}} opts
 * @returns {Promise<{status:number, headers:object, text:string}>}
 */
export async function request(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeout = 20000,
    proxy = null,
    maxRedirects = 3,
  } = opts;

  // 「仅本地翻译」开着的时候，任何指向非回环地址的请求都在这里被拦下。
  // 报错要写清楚：用户看到的不该是"翻译失败"，而是"被仅本地模式拦住了"。
  const offlineHost = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  if (offlineOnly && offlineHost && !isLoopbackHost(offlineHost)) {
    const msg = `仅本地模式已开启：已拦截对 ${offlineHost} 的网络请求（${method} ${url}）`;
    if (offlineLogger) {
      try {
        offlineLogger(msg, 'warn');
      } catch {}
    }
    throw new Error(msg);
  }

  // 'system' -> 读取 Windows 系统代理；'' -> 直连；本地地址永远直连
  const proxyUrl = await resolveProxy(proxy, new URL(url).hostname);

  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      return reject(new Error('非法 URL: ' + url));
    }
    const mod = target.protocol === 'https:' ? https : http;
    const reqHeaders = {
      'Accept-Encoding': 'gzip, deflate',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0',
      ...headers,
    };
    if (body != null && reqHeaders['Content-Length'] == null) {
      reqHeaders['Content-Length'] = Buffer.byteLength(body);
    }
    const req = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method,
        headers: reqHeaders,
        agent: target.protocol === 'https:' ? agentFor(proxyUrl) : undefined,
        timeout,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return resolve(request(next, { ...opts, maxRedirects: maxRedirects - 1 }));
        }
        const chunks = [];
        let stream = res;
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }),
        );
        stream.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`请求超时(${timeout}ms): ${target.host}`)));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

export async function requestJson(url, opts = {}) {
  const r = await request(url, opts);
  try {
    return { ...r, json: JSON.parse(r.text) };
  } catch {
    throw new Error(`响应不是 JSON (HTTP ${r.status}): ${r.text.slice(0, 200)}`);
  }
}
