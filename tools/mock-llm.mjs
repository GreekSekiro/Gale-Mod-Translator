// 测试用 mock「OpenAI 兼容」接口：验证 LLM 润色链路（请求 → 结果 → 回推页面）
import http from 'node:http';

const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    try {
      const j = JSON.parse(body || '{}');
      const userMsg = (j.messages || []).find((m) => m.role === 'user')?.content || '[]';
      const items = JSON.parse(userMsg);
      const list = Array.isArray(items) ? items : [items];
      const polished = list.map((it) => `【润色】${String(it?.zh ?? it ?? '').replace(/。$/, '')}`);
      res.writeHead(200, cors);
      res.end(
        JSON.stringify({
          id: 'mock',
          object: 'chat.completion',
          model: j.model || 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(polished) }, finish_reason: 'stop' }],
        }),
      );
    } catch (e) {
      res.writeHead(400, cors);
      res.end(JSON.stringify({ error: { message: e.message } }));
    }
  });
});
srv.listen(8902, '127.0.0.1', () => console.log('mock llm on 8902'));
