/**
 * state-dir.mjs —— 状态目录的唯一解析处。
 *
 * **为什么单独一个文件**：这个路径此前有四份实现（`watch.mjs` / `asked.mjs` /
 * `notify.mjs` / `install-watcher.mjs`），每一份都写着「与另一份保持一致」。
 * 靠注释保持一致的东西必然会漂移 —— 这个仓库为此付过账（`fmtDur` 两份、
 * 宽度表两份、`readTailRecords` 三种窗口）。
 *
 * 但 `install-watcher.mjs` 有正当理由不 import `watch.mjs`：安装脚本不该为了
 * 20 行路径逻辑把整个守护进程拖进来。所以共用的不是「抄一份」，是**这一个文件**——
 * 它零依赖、没有副作用，谁 import 都便宜。
 *
 * ## 改名迁移（2026-11-17：Overwatch → UntilDone）
 *
 * 状态目录里存着 `state.json`、观察日志、`asked-history.json`、见证文件。
 * `DF-020` 记着这个目录曾被整个清空过一次（5,348 行生产日志一起没了）。
 *
 * 如果改名后直接指向新目录，那台机器上的历史会**看起来消失了**：
 * 新目录不存在 → 被当成「首次运行」→ 静默重建 → 和真丢了表现完全一样。
 * 那正是这个仓库最反对的事（「读不到」不能显示成「没有」）。
 *
 * 所以规则是：**新目录存在就用新的；新目录不存在、旧目录存在，就继续用旧的。**
 * 不自动搬（搬一半失败会造出第三份真相），想迁移的人自己 `mv`。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** 目录名。改名时只改这两行，其余代码不需要知道新旧。 */
export const STATE_DIR_NAME = { win32: 'UntilDone', posix: 'untildone' };
/** 改名前的名字。只用于「新目录不存在时沿用旧目录」，不做别的。 */
export const LEGACY_DIR_NAME = { win32: 'Overwatch', posix: 'overwatch' };

/** 宿主状态根（`%LOCALAPPDATA%` / `$XDG_STATE_HOME`）。 */
export function stateRoot(env = process.env) {
  if (process.platform === 'win32') {
    return env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  }
  return env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
}

/**
 * 状态目录。
 *
 * @param {object} env
 * @param {object} [opts]
 * @param {string} [opts.sub]  子目录名（`notify` 用它）；给了就返回 `<stateDir>/<sub>`
 *
 * `OVERWATCH_STATE_DIR` 这个环境变量名**故意不改**：它出现在用户已有的脚本、
 * 测试、文档里，改名会让那些全部静默失效。名字是历史，功能不受影响。
 */
export function resolveStateDir(env = process.env, { sub = null } = {}) {
  const explicit = env.OVERWATCH_STATE_DIR;
  if (explicit) return sub ? join(explicit, sub) : explicit;

  const root = stateRoot(env);
  const next = join(root, STATE_DIR_NAME[process.platform === 'win32' ? 'win32' : 'posix']);
  const prev = join(root, LEGACY_DIR_NAME[process.platform === 'win32' ? 'win32' : 'posix']);

  // 新目录优先；它还没建过时，旧目录若在就沿用 —— 免得历史数据变成「首次运行」。
  let dir = next;
  try { if (!existsSync(next) && existsSync(prev)) dir = prev; } catch { /* 读不到就用新名 */ }
  return sub ? join(dir, sub) : dir;
}
