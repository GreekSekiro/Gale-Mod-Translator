// 解析当前 Gale 的调试端口：环境变量 GALE_CDP_PORT > data/runtime.json > 9223
// （服务端在端口被占用时会自动换端口，并把实际端口写进 runtime.json，工具都从这里读）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function cdpPort() {
  if (process.env.GALE_CDP_PORT) return Number(process.env.GALE_CDP_PORT);
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'runtime.json'), 'utf8'));
    if (j.cdpPort) return Number(j.cdpPort);
  } catch {}
  return 9223;
}

export function servicePort() {
  if (process.env.GALE_SERVICE_PORT) return Number(process.env.GALE_SERVICE_PORT);
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'runtime.json'), 'utf8'));
    if (j.port) return Number(j.port);
  } catch {}
  return 8799;
}

export { ROOT };
