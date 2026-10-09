// 测试用 mock 翻译接口：验证自定义节点的模板、批量与取值路径
import http from 'node:http';

const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Content-Type': 'application/json' };
    try {
      const j = JSON.parse(body || '{}');
      const list = j.text || [];
      // 模拟一个 {"translations":[{"text":"..."}]} 的返回结构
      res.writeHead(200, cors);
      res.end(JSON.stringify({ translations: list.map((t) => ({ text: '【' + String(j.to || '') + '】' + t })) }));
    } catch (e) {
      res.writeHead(400, cors);
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});
srv.listen(8901, '127.0.0.1', () => console.log('mock translator on 8901'));
