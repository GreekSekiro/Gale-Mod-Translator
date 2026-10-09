// 代码指纹：把 core/ 下参与运行的脚本的「文件名 + 大小 + 修改时间」汇总成一个短哈希。
// 用途：启动器发现"后台服务还是旧代码"时自动把它重启掉。
// 否则会出现这种迷惑现象：改了代码 → 双击 start.cmd → 启动器看到 8799 上已有服务就跳过启动
// → 跑的还是旧代码 → 表现成"改了没用 / 功能不见了"。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const CORE = path.dirname(fileURLToPath(import.meta.url));

export function buildId() {
  try {
    const files = fs
      .readdirSync(CORE)
      .filter((f) => f.endsWith('.mjs') || f.endsWith('.js'))
      .sort()
      .map((f) => {
        const s = fs.statSync(path.join(CORE, f));
        return `${f}:${s.size}:${Math.round(s.mtimeMs)}`;
      })
      .join('|');
    return crypto.createHash('sha1').update(files).digest('hex').slice(0, 12);
  } catch {
    return 'dev';
  }
}
