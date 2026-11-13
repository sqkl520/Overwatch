#!/usr/bin/env node
/**
 * project-commands.mjs — 「这个项目该跑什么命令」的探测。
 *
 * 为什么需要它：`verify-claims.mjs` 的 `adviceFor()` 把测试命令写死成
 * `npm test（或本项目实际的测试命令）`。对 Node 项目是废话，对 Java/Maven 项目是**错的**——
 * 用户照着跑会得到 `npm ERR! ENOENT package.json`，然后合理地怀疑整个闸门是坏的。
 * 建议给错比不给更糟。
 *
 * 做法：只读、零依赖、有界。按仓库根的标志文件认出构建系统，再从中读出**真实**的
 * 测试/构建命令。认不出就返回 null —— 让调用方说「我不知道这个项目怎么跑测试」，
 * 而不是编一个。
 *
 * 边界（有意为之）：
 *   - 不执行任何东西，不装依赖，不联网。
 *   - 单个文件最多读 `MAX_READ_BYTES`，防止有人在仓库里放一个 100MB 的 pom.xml。
 *   - 只认**仓库根**的标志文件，不递归搜索 —— 递归会捡到 node_modules 里别人的配置。
 */

import { openSync, readSync, closeSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 单个标志文件最多读这么多字节。关键信息（scripts、artifactId）都在开头。 */
export const MAX_READ_BYTES = 256 * 1024;

/** 读一个文本文件，超过上限就**只读前一段**（不把整个文件读进内存）。读不到返回 null。 */
export function readCapped(path, maxBytes = MAX_READ_BYTES) {
  let fd;
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    const n = Math.min(maxBytes, st.size);
    const buf = Buffer.allocUnsafe(n);
    fd = openSync(path, 'r');
    const got = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, got).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/** 从 package.json 的 scripts 里挑出测试/构建命令。解析失败或没有可用脚本时返回 null。 */
export function pickNpmScripts(pkgText) {
  let pkg;
  try { pkg = JSON.parse(pkgText); } catch { return null; }
  const scripts = (pkg && pkg.scripts) || {};
  const keys = Object.keys(scripts);
  // 只认真正的测试脚本名。`npm test` 在没写 test 脚本时会退化成
  // 「Error: no test specified」却仍然 exit 0 —— 那是假绿灯，不能建议用户跑它。
  const testKey = ['test', 'test:unit', 'tests', 'check'].find((k) => keys.includes(k));
  const buildKey = ['build', 'compile', 'typecheck'].find((k) => keys.includes(k));
  if (!testKey && !buildKey) return null;
  return {
    test: testKey ? 'npm run ' + testKey : null,
    build: buildKey ? 'npm run ' + buildKey : null,
  };
}

/** 从 pom.xml 判断是不是 Maven 项目。 */
export function pickMaven(pomText) {
  if (!pomText || !/<project[\s>]/.test(pomText)) return null;
  // `clean verify` 比 `test` 更接近「这个项目认为的验收」，且是 Maven 惯例。
  return { test: 'mvn -q clean verify', build: 'mvn -q -DskipTests package' };
}

/** 从 build.gradle(.kts) 判断是不是 Gradle 项目。 */
export function pickGradle(text) {
  if (!text) return null;
  // Kotlin DSL 与 Groovy DSL 的根标志不同，但只要有 plugins/ 或 task 声明就当 Gradle。
  if (!/(?:^|\n)\s*(?:plugins\s*\{|apply\s+plugin|tasks?\.|dependencies\s*\{)/.test(text)) return null;
  return { test: 'gradle test', build: 'gradle build' };
}

/** 从 Cargo.toml 取测试命令。 */
export function pickCargo(text) {
  if (!text || !/\[package\]/.test(text)) return null;
  return { test: 'cargo test', build: 'cargo build' };
}

/** 从 go.mod 取测试命令。 */
export function pickGo(text) {
  if (!text || !/^module\s+\S+/m.test(text)) return null;
  return { test: 'go test ./...', build: 'go build ./...' };
}

/** 从 Python 项目的若干标志文件里取测试命令。 */
export function pickPython(files) {
  const f = files || {};
  const texts = [f.pyproject, f.setupCfg, f.pytestIni, f.requirements, f.setupPy];
  const looksPython = texts.some((t) => t !== null && t !== undefined);
  if (!looksPython) return null;
  const hasPytest = /\[tool\.pytest|\[pytest\]|pytest/m.test(texts.filter(Boolean).join('\n'));
  if (!hasPytest) return null; // 没有 pytest 就不猜 —— unittest 的发现规则各家不同。
  return { test: 'python -m pytest', build: null };
}

/** .NET 解决方案 / 项目文件。 */
export function pickDotnet(hasSln, hasCsproj) {
  if (!hasSln && !hasCsproj) return null;
  return { test: 'dotnet test', build: 'dotnet build' };
}

/**
 * 认项目类型，返回 `{ kind, test, build, source }`。
 *
 * `kind` 是给日志/可观测性用的标签。`source` 说明这些命令是从哪个文件读出来的 ——
 * 用户看到「请跑 mvn -q clean verify」时，要能自己核对这个建议的依据。
 * 认不出时 `kind: 'unknown'`、`test: null`。
 *
 * 顺序即优先级：一个仓库里同时有 package.json 和 pom.xml 时两者都可能存在
 * （前端 + 后端）。这里只给出**一个**主命令，宁缺毋滥 —— 硬闸每天要跑几十次，
 * 让它一次跑两套测试是在惩罚用户。
 */
export function detectProjectCommands(root) {
  const hasFile = (name) => {
    try { return statSync(join(root, name)).isFile(); } catch { return false; }
  };
  const read = (name) => (hasFile(name) ? readCapped(join(root, name)) : null);
  const wrapperOf = (...names) => names.some((n) => hasFile(n));

  if (hasFile('package.json')) {
    const picked = pickNpmScripts(read('package.json') || '');
    return {
      kind: 'node',
      test: picked ? picked.test : null,
      build: picked ? picked.build : null,
      source: 'package.json',
    };
  }

  if (hasFile('pom.xml')) {
    const picked = pickMaven(read('pom.xml'));
    if (picked) {
      const wrapper = wrapperOf('mvnw', 'mvnw.cmd');
      return {
        kind: 'maven',
        test: wrapper ? 'mvnw -q clean verify' : picked.test,
        build: wrapper ? 'mvnw -q -DskipTests package' : picked.build,
        source: 'pom.xml',
      };
    }
  }

  if (hasFile('build.gradle') || hasFile('build.gradle.kts')) {
    const src = hasFile('build.gradle.kts') ? 'build.gradle.kts' : 'build.gradle';
    const picked = pickGradle(read(src));
    if (picked) {
      const wrapper = wrapperOf('gradlew', 'gradlew.bat');
      return {
        kind: 'gradle',
        test: wrapper ? 'gradlew test' : picked.test,
        build: wrapper ? 'gradlew build' : picked.build,
        source: src,
      };
    }
  }

  if (hasFile('Cargo.toml')) {
    const picked = pickCargo(read('Cargo.toml'));
    if (picked) return { kind: 'cargo', ...picked, source: 'Cargo.toml' };
  }

  if (hasFile('go.mod')) {
    const picked = pickGo(read('go.mod'));
    if (picked) return { kind: 'go', ...picked, source: 'go.mod' };
  }

  const py = pickPython({
    pyproject: read('pyproject.toml'),
    setupCfg: read('setup.cfg'),
    pytestIni: read('pytest.ini'),
    requirements: read('requirements.txt'),
    setupPy: read('setup.py'),
  });
  if (py) return { kind: 'python', ...py, source: 'pyproject.toml / setup.cfg / pytest.ini' };

  let hasSln = false;
  try {
    hasSln = readdirSync(root).some((f) => f.toLowerCase().endsWith('.sln'));
  } catch { hasSln = false; }
  const ds = pickDotnet(hasSln, wrapperOf('Directory.Build.props', 'Directory.Build.targets'));
  if (ds) return { kind: 'dotnet', ...ds, source: hasSln ? '*.sln' : 'Directory.Build.props' };

  return { kind: 'unknown', test: null, build: null, source: null };
}

/**
 * 给定检测结果，生成「请跑什么」的一句话。用于 hook 的 reason 文案。
 *
 * 认不出项目类型时**不编命令**：直接说没认出来，并给出用户能自己补的办法。
 * 这是本模块存在的全部理由 —— 宁可少说，不要说错。
 */
export function commandHint(project) {
  const p = project || {};
  if (p.test) {
    return '请在本会话里运行 `' + p.test + '`（依据 ' + p.source + ' 的配置），把输出贴出来再结束';
  }
  if (!p.kind || p.kind === 'unknown') {
    return '我认不出这个项目用什么命令跑测试（根目录没有 package.json / pom.xml / build.gradle / Cargo.toml / go.mod）。'
      + '请运行你实际用的测试命令并贴出输出';
  }
  return '这个项目（' + p.kind + '）的配置里没有可用的测试命令，请运行你实际用的命令并贴出输出';
}
