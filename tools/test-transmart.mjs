// 腾讯交互翻译 transmart 各 client_key 变体探测
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
const TXT = ['Adds loot drops, magic items, and enchanting to Valheim.', 'Fills the weapon and shields gap in vanilla Valheim.'];

async function tryPayload(name, header) {
  const t0 = Date.now();
  try {
    const r = await fetch('https://transmart.qq.com/api/imt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Referer: 'https://transmart.qq.com/zh-CN/index', Origin: 'https://transmart.qq.com' },
      body: JSON.stringify({
        header,
        type: 'plain',
        model_category: 'normal',
        source: { lang: 'en', text_list: TXT },
        target: { lang: 'zh' },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const t = await r.text();
    console.log(`[${r.status}] ${name} ${Date.now() - t0}ms -> ${t.slice(0, 260)}`);
  } catch (e) {
    console.log(`[ERR] ${name} -> ${e.message}`);
  }
}

await tryPayload('chrome-110.0.0.0', { fn: 'auto_translation', client_key: 'browser-chrome-110.0.0.0', user: 'web_user' });
await tryPayload('chrome-120.0.0.0', { fn: 'auto_translation', client_key: 'browser-chrome-120.0.0.0', user: 'web_user' });
await tryPayload('带 session', { fn: 'auto_translation', session: '', client_key: 'browser-chrome-110.0.0.0', user: 'web_user' });
await tryPayload('fn=text_translation', { fn: 'text_translation', client_key: 'browser-chrome-110.0.0.0', user: 'web_user' });
await tryPayload('无 user', { fn: 'auto_translation', client_key: 'browser-chrome-110.0.0.0' });
await tryPayload('transmart-web', { fn: 'auto_translation', client_key: 'transmart-web', user: 'web_user' });
