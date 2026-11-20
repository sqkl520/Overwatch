#!/usr/bin/env node
/**
 * check-links.mjs — 文档相对链接不悬空。CLI 外壳。
 *
 * 判据本体在 `scripts/link-check.mjs`（纯函数，有单测）；这里只负责「扫哪些文件、
 * 怎么打印、退出码」。抽出的理由与 `published-paths.mjs`（`DF-039`）相同：
 * 判据写在 CLI 脚本里就没有测试，而没有测试的判据守不住任何命题。
 *
 * 扫描范围**问 git**，不维护手写清单。`DF-040` 记的就是手写清单的失效方式：
 * 原先只扫 `README.md` / `CLAUDE.md` / `docs/`，根目录的 `CONTRIBUTING.md`、
 * `CONTRIBUTING-EN.md`、`SECURITY.md`、`SECURITY-EN.md` 一份都不在里面，
 * 而这份命令报「0 断链」、CLAUDE.md 与 CAPABILITIES.md 都把它当头号判据。
 *
 * 用法：node scripts/check-links.mjs [--json]
 * 退出码：0 = 0 断链；1 = 有断链。
 */
import { scanLinks, describeBroken } from './link-check.mjs';

const ROOT = process.cwd();
const json = process.argv.includes('--json');
const { checked, broken, files } = scanLinks({ root: ROOT });

if (json) {
  console.log(JSON.stringify({ files, checked, broken }, null, 2));
} else {
  for (const b of broken) console.log(describeBroken(b));
  console.log(`\n扫描 ${files} 份 .md，检查 ${checked} 个相对链接，${broken.length} 个断链`);
}
process.exit(broken.length ? 1 : 0);
