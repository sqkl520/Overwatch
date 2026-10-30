// 按文件所在目录解析相对链接，找出真正断掉的
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const files = ['README.md', 'CLAUDE.md'];
function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.md')) files.push(p);
  }
}
walk('docs');

let bad = 0, checked = 0;
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  const dir = dirname(f);
  for (const m of text.matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
    const target = resolve(dir, m[1]);
    checked++;
    if (!existsSync(target)) {
      console.log(`死链  ${f}  →  ${m[1]}`);
      bad++;
    }
  }
}
console.log(`\n检查 ${checked} 个链接，${bad} 个断链`);
process.exit(bad ? 1 : 0);
