import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

export const WORKSPACE_DIRNAME = 'shared_workspace';
export const TMP_DIRNAME = '.tmp';

const MARKER = `# shared_workspace

agent-session-proxy 的共享工作区。

网页上新建会话时，工作目录默认就是这里；qodercli 和 codex 的临时文件也写在这里的
\`.tmp/\` 下（子进程的 TMPDIR 指向它）。

想让 agent 在别的项目里干活，就在新建会话时改工作目录。
`;

/** Sibling of the repo, e.g. /path/to/Github/shared_workspace. */
export function defaultWorkspacePath() {
  return path.resolve(ROOT, '..', WORKSPACE_DIRNAME);
}

export function tmpDir(workspace) {
  return path.join(workspace, TMP_DIRNAME);
}

/**
 * Create the shared workspace (and its temp dir) if missing. Returns the
 * resolved absolute path. Failures are reported, not thrown, so a read-only
 * parent directory degrades to "use whatever cwd you were given" rather than
 * taking the whole proxy down at boot.
 */
export function ensureWorkspace(dir) {
  const workspace = path.resolve(dir);
  const tmp = tmpDir(workspace);
  const fresh = !existsSync(workspace);
  try {
    mkdirSync(tmp, { recursive: true });
    if (fresh) {
      writeFileSync(path.join(workspace, 'README.md'), MARKER);
    }
    return { workspace, tmp, ok: true, error: '' };
  } catch (err) {
    return { workspace, tmp, ok: false, error: err.message };
  }
}

/** TMPDIR for spawned CLIs, so their scratch files land in the workspace. */
export function workspaceEnv(env, tmp) {
  if (!tmp) return env;
  return { ...env, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
}
