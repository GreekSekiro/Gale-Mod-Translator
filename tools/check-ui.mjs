// 校验设置页：内联脚本语法 + $('id') 引用是否都存在
import fs from 'node:fs';
const file = process.argv[2] || 'ui/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) {
  console.log('未找到内联脚本');
  process.exit(1);
}
fs.writeFileSync('data/_ui_check.js', m[1]);
const ids = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((x) => x[1]));
const used = new Set([...m[1].matchAll(/\$\('([\w-]+)'\)/g)].map((x) => x[1]));
const missing = [...used].filter((u) => !ids.has(u));
console.log(`内联脚本 ${m[1].split('\n').length} 行；引用 id ${used.size} 个；缺失: ${missing.length ? missing.join(', ') : '无'}`);
